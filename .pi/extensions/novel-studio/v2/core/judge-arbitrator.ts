/**
 * JudgeArbitrator — 裁判仲裁器（Phase 4，计划 §Phase 4 + §5）
 *
 * 条件反向复判 + 可选异构仲裁。
 *
 * 设计原则（计划 §Phase 4 退出条件）：
 * - 顺序交换冲突时保留 raw：反向复判与首轮冲突 → 不交付 amplified
 * - 任何 amplified 交付都有可审计胜因：两轮一致确认 amplified 胜出才交付
 * - 无证据负评失效：证据校验失败的 verdict 不用于选择 amplified
 *
 * 流程：
 * 1. 第一轮裁判（PairwiseLiteraryJudge.judge）
 * 2. 若首轮 selection.needsReverseReview=true：
 *    a. swapOrder(mapping) 交换 A/B 标签
 *    b. 第二轮裁判（同模型，用 swapped mapping）
 *    c. 比较两轮反匿名后的 winner：
 *       - 两轮一致确认 amplified 胜出 → 交付 amplified（可审计胜因：两轮一致）
 *       - 两轮一致判 raw 胜或 tie → 保留 raw
 *       - 两轮冲突（一轮 amplified，一轮 raw/tie）→ 进入仲裁或保留 raw
 * 3. 可选异构仲裁：两轮冲突时，用第二模型做第三轮裁判
 *    - 仲裁 winner 与某轮一致 → 采纳该轮决策
 *    - 仲裁 tie 或与两轮都不一致 → 保留 raw
 * 4. 首轮 clear 胜出且证据有效（needsReverseReview=false）→ 直接交付 amplified
 * 5. 首轮降级（LLM/parse 失败）→ 保留 raw
 *
 * 本模块不直接调用 LLM，通过 PairwiseLiteraryJudge 间接调用。
 */

import type { Candidate, ConstitutionSnapshot } from "./types.js";
import type { ChapterIntent } from "./chapter-intent-builder.js";
import type { SelectionDecision } from "./judge-types.js";
import { swapOrder } from "./judge-types.js";
import { computeFinalTextHash } from "./final-state-commit.js";
import type { ModelGenerateFn } from "../adapters/legacy-model-route-adapter.js";
import {
  PairwiseLiteraryJudge,
  createPairwiseLiteraryJudge,
  type PairwiseJudgeInput,
  type PairwiseJudgeResult,
} from "./pairwise-literary-judge.js";

// ============================================================================
// 输入/输出类型
// ============================================================================

export interface ArbitratorInput {
  /** raw 候选（基线） */
  rawCandidate: Candidate;
  /** editorial 候选（机会驱动生成） */
  editorialCandidate: Candidate;
  /** 章节意图 */
  intent: ChapterIntent;
  /** 作品宪法快照（可空） */
  constitution: ConstitutionSnapshot | null;
  /** 主裁判模型调用函数 */
  modelGenerate: ModelGenerateFn;
  /**
   * 可选异构仲裁模型。两轮冲突时用此模型做第三轮裁判。
   * 不提供则两轮冲突直接保留 raw。
   */
  arbitratorModelGenerate?: ModelGenerateFn;
  /** 随机种子（决定首轮 A/B 顺序，可复现） */
  seed?: number;
  /** 路由名（默认 v2_literary_judge） */
  route?: string;
  /** 超时 ms */
  timeoutMs?: number;
  /**
   * Internal evaluation override. Production/default behavior selects a valid
   * quality winner; false keeps the result advisory-only for review studies.
   */
  allowAutomaticLiterarySelection?: boolean;
}

export type QualitySelectionStatus =
  | "decisive_winner"
  | "comparison_inconclusive"
  | "judge_unavailable"
  | "advisory_only";

export interface ArbitratorRoundRecord {
  /** 轮次标识：first / reverse / arbitration */
  round: "first" | "reverse" | "arbitration";
  /** 该轮的裁判结果 */
  result: PairwiseJudgeResult;
  /** 反匿名后的 winner 候选 id（tie/降级为 null） */
  winnerCandidateId: string | null;
}

export interface ArbitratorResult {
  /** 最终选择决策 */
  selection: SelectionDecision;
  /** 首轮结果 */
  firstRound: PairwiseJudgeResult;
  /** 反向复判结果（未触发时为 null） */
  reverseRound: PairwiseJudgeResult | null;
  /** 异构仲裁结果（未触发时为 null） */
  arbitrationRound: PairwiseJudgeResult | null;
  /** 所有轮次记录（供 trace 审计） */
  rounds: ArbitratorRoundRecord[];
  /** 是否触发了反向复判 */
  reverseReviewed: boolean;
  /** 是否触发了异构仲裁 */
  arbitrationTriggered: boolean;
  /** 两轮是否冲突 */
  conflicted: boolean;
  /** 最终选中的候选 id（null 表示保留 raw） */
  finalSelectedCandidateId: string | null;
  /** 审计摘要：为什么选择/保留 */
  auditSummary: string;
  /** Distinguishes a quality winner from a raw safety fallback. */
  selectionStatus: QualitySelectionStatus;
}

// ============================================================================
// JudgeArbitrator 主类
// ============================================================================

export class JudgeArbitrator {
  private judge: PairwiseLiteraryJudge;

  /**
   * Step 4d：裁判结果缓存。key = rawTextHash:editorialTextHash:intentHash:constitutionHash:seed:route。
   * per-chapter 实例（createJudgeArbitrator 每章新建），章结束 GC，跨章不共享。
   * 缓存键覆盖所有影响裁判结果的输入：raw/editorial 正文、intent、constitution、seed、route。
   * 任一输入变化必 miss；structuredClone 深拷贝防调用方篡改。
   */
  private cache = new Map<string, ArbitratorResult>();

  constructor(judge?: PairwiseLiteraryJudge) {
    this.judge = judge ?? createPairwiseLiteraryJudge();
  }

  async arbitrate(input: ArbitratorInput): Promise<ArbitratorResult> {
    const {
      rawCandidate,
      editorialCandidate,
      intent,
      constitution,
      modelGenerate,
      arbitratorModelGenerate,
    } = input;
    const allowAutomaticLiterarySelection = input.allowAutomaticLiterarySelection !== false;

    // Step 4b：clear 胜出跳过复判显式化 + 可配置。默认 1=跳过（行为不变）；
    // PINOVEL_JUDGE_CLEAR_SKIP=0 时 clear 胜出也进入反向复判（A/B 评测用）。
    const SKIP_CLEAR = Number(process.env.PINOVEL_JUDGE_CLEAR_SKIP ?? 1) === 1;

    // JUDGE-CALIBRATION-1：editorial 明显比 raw 加长时的 clear 胜出强制反向复判。
    // fuben ch1：editorial 加长 25%（+1212 字）判 clear 直接采纳，但人工选 raw（pacing）。
    // 阈值：加长超 500 字 且 比例超 1.15。命中时不跳过复判，强制第二轮确认加长确有收益。
    const LENGTH_SKEPTICAL_ABS = Number(process.env.PINOVEL_JUDGE_LENGTH_SKEPTICAL_ABS ?? 500);
    const LENGTH_SKEPTICAL_RATIO = Number(process.env.PINOVEL_JUDGE_LENGTH_SKEPTICAL_RATIO ?? 1.15);

    // Step 4d：裁判结果缓存。缓存键覆盖所有影响裁判结果的输入，任一变化必 miss。
    // 修复：旧键仅含 contextHash+candidateHash+id/seed/route，漏掉 intent/constitution/raw 正文，
    // 改 ChapterIntent 后仍命中旧缓存返回旧 winner。现键含 raw 正文 + editorial 正文 + intent + constitution + seed + route。
    const rawTextHash = computeFinalTextHash(rawCandidate.text);
    const editorialTextHash = computeFinalTextHash(editorialCandidate.text);
    const intentHash = computeFinalTextHash(JSON.stringify(intent));
    const constitutionHash = constitution
      ? computeFinalTextHash(JSON.stringify(constitution))
      : "no-const";
    const cacheKey = `${rawTextHash}:${editorialTextHash}:${intentHash}:${constitutionHash}:${input.seed ?? 0}:${input.route ?? "v2_literary_judge"}:${allowAutomaticLiterarySelection ? 1 : 0}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return structuredClone(cached);

    const finish = (params: {
      selection: SelectionDecision;
      firstRound: PairwiseJudgeResult;
      reverseRound: PairwiseJudgeResult | null;
      arbitrationRound: PairwiseJudgeResult | null;
      rounds: ArbitratorRoundRecord[];
      reverseReviewed: boolean;
      arbitrationTriggered: boolean;
      conflicted: boolean;
      finalSelectedCandidateId: string | null;
      auditSummary: string;
    }): ArbitratorResult => {
      const gatedParams = !allowAutomaticLiterarySelection &&
        params.finalSelectedCandidateId !== rawCandidate.id
        ? {
            ...params,
            selection: {
              selectedCandidateId: rawCandidate.id,
              reason: "自然人人工对齐门未通过，AI 文学胜负仅作诊断，保留 raw",
              needsReverseReview: false,
            },
            finalSelectedCandidateId: rawCandidate.id,
            auditSummary: `${params.auditSummary}；人工对齐门未通过，候选仅供人工复核，保留 raw`,
          }
        : params;
      const selectionStatus: QualitySelectionStatus = !allowAutomaticLiterarySelection
        ? "advisory_only"
        : gatedParams.rounds.some((round) => round.result.degraded)
          ? "judge_unavailable"
          : gatedParams.conflicted
            || gatedParams.finalSelectedCandidateId === null
            || gatedParams.rounds.every((round) => round.winnerCandidateId === null)
            ? "comparison_inconclusive"
            : "decisive_winner";
      const r = this.buildResult({ ...gatedParams, selectionStatus });
      this.cache.set(cacheKey, r);
      return r;
    };

    const rounds: ArbitratorRoundRecord[] = [];

    // ---- 第一轮裁判 ----
    const firstInput: PairwiseJudgeInput = {
      rawCandidate,
      editorialCandidate,
      intent,
      constitution,
      modelGenerate,
      seed: input.seed,
      route: input.route,
      timeoutMs: input.timeoutMs,
    };
    const firstRound = await this.judge.judge(firstInput);
    rounds.push({
      round: "first",
      result: firstRound,
      winnerCandidateId: firstRound.winnerCandidateId,
    });

    // 首轮降级（LLM/parse 失败）→ 直接保留 raw，不反向复判
    if (firstRound.degraded) {
      return finish({
        selection: firstRound.selection,
        firstRound,
        reverseRound: null,
        arbitrationRound: null,
        rounds,
        reverseReviewed: false,
        arbitrationTriggered: false,
        conflicted: false,
        finalSelectedCandidateId: firstRound.selection.selectedCandidateId,
        auditSummary: `首轮裁判降级（${firstRound.degradeReason}），保留 raw，不反向复判`,
      });
    }

    // 首轮 clear 胜出且证据有效（needsReverseReview=false）→ 直接采纳（Step 4b：可配置）
    const editorialLen = editorialCandidate.text.length;
    const rawLen = rawCandidate.text.length;
    const lengthSkeptical =
      editorialLen - rawLen > LENGTH_SKEPTICAL_ABS
      && editorialLen / Math.max(1, rawLen) > LENGTH_SKEPTICAL_RATIO;
    if (!firstRound.selection.needsReverseReview && SKIP_CLEAR && !lengthSkeptical) {
      return finish({
        selection: firstRound.selection,
        firstRound,
        reverseRound: null,
        arbitrationRound: null,
        rounds,
        reverseReviewed: false,
        arbitrationTriggered: false,
        conflicted: false,
        finalSelectedCandidateId: firstRound.selection.selectedCandidateId,
        auditSummary: `首轮 clear 胜出，跳过反向复判（PINOVEL_JUDGE_CLEAR_SKIP=1）：${firstRound.selection.reason}`,
      });
    }

    // ---- 条件反向复判 ----
    const swappedMapping = swapOrder(firstRound.mapping);
    const reverseInput: PairwiseJudgeInput = {
      rawCandidate,
      editorialCandidate,
      intent,
      constitution,
      modelGenerate,
      mapping: swappedMapping, // 强制使用交换后的映射
      route: input.route,
      timeoutMs: input.timeoutMs,
    };
    const reverseRound = await this.judge.judge(reverseInput);
    rounds.push({
      round: "reverse",
      result: reverseRound,
      winnerCandidateId: reverseRound.winnerCandidateId,
    });

    // 比较两轮反匿名后的 winner
    const firstWinner = firstRound.winnerCandidateId;
    const reverseWinner = reverseRound.winnerCandidateId;
    const conflict = !winnersConsistent(firstWinner, reverseWinner);

    // 两轮一致 → 按一致性决策
    if (!conflict) {
      const selection = resolveConsistentSelection(
        firstWinner,
        rawCandidate.id,
        editorialCandidate.id,
        firstRound,
        reverseRound
      );
      return finish({
        selection,
        firstRound,
        reverseRound,
        arbitrationRound: null,
        rounds,
        reverseReviewed: true,
        arbitrationTriggered: false,
        conflicted: false,
        finalSelectedCandidateId: selection.selectedCandidateId,
        auditSummary: `两轮一致确认（首轮 winner=${firstWinner}，反向 winner=${reverseWinner}）：${selection.reason}`,
      });
    }

    // ---- 两轮冲突 → 可选异构仲裁 ----
    if (!arbitratorModelGenerate) {
      // 无仲裁器 → 保留 raw（计划退出条件：顺序交换冲突时保留 raw）
      const selection: SelectionDecision = {
        selectedCandidateId: rawCandidate.id,
        reason: `两轮冲突（首轮 winner=${firstWinner}，反向 winner=${reverseWinner}），无异构仲裁器，保留 raw`,
        needsReverseReview: false,
      };
      return finish({
        selection,
        firstRound,
        reverseRound,
        arbitrationRound: null,
        rounds,
        reverseReviewed: true,
        arbitrationTriggered: false,
        conflicted: true,
        finalSelectedCandidateId: rawCandidate.id,
        auditSummary: `两轮冲突且无仲裁器，保留 raw（首轮=${firstWinner}，反向=${reverseWinner}）`,
      });
    }

    // 异构仲裁：用第二模型做第三轮（用首轮映射，避免再引入新的顺序变量）
    const arbitrationInput: PairwiseJudgeInput = {
      rawCandidate,
      editorialCandidate,
      intent,
      constitution,
      modelGenerate: arbitratorModelGenerate,
      mapping: firstRound.mapping, // 用首轮映射，便于与首轮直接比较
      route: input.route,
      timeoutMs: input.timeoutMs,
    };
    const arbitrationRound = await this.judge.judge(arbitrationInput);
    rounds.push({
      round: "arbitration",
      result: arbitrationRound,
      winnerCandidateId: arbitrationRound.winnerCandidateId,
    });

    // 仲裁结果决策
    const arbWinner = arbitrationRound.winnerCandidateId;
    const selection = resolveArbitratedSelection(
      firstWinner,
      reverseWinner,
      arbWinner,
      rawCandidate.id,
      editorialCandidate.id,
      arbitrationRound
    );

    return finish({
      selection,
      firstRound,
      reverseRound,
      arbitrationRound,
      rounds,
      reverseReviewed: true,
      arbitrationTriggered: true,
      conflicted: true,
      finalSelectedCandidateId: selection.selectedCandidateId,
      auditSummary: `两轮冲突（首轮=${firstWinner}，反向=${reverseWinner}），异构仲裁 winner=${arbWinner}：${selection.reason}`,
    });
  }

  /**
   * 构造最终结果。
   */
  private buildResult(params: {
    selection: SelectionDecision;
    firstRound: PairwiseJudgeResult;
    reverseRound: PairwiseJudgeResult | null;
    arbitrationRound: PairwiseJudgeResult | null;
    rounds: ArbitratorRoundRecord[];
    reverseReviewed: boolean;
    arbitrationTriggered: boolean;
    conflicted: boolean;
    finalSelectedCandidateId: string | null;
    auditSummary: string;
    selectionStatus: QualitySelectionStatus;
  }): ArbitratorResult {
    return {
      selection: params.selection,
      firstRound: params.firstRound,
      reverseRound: params.reverseRound,
      arbitrationRound: params.arbitrationRound,
      rounds: params.rounds,
      reverseReviewed: params.reverseReviewed,
      arbitrationTriggered: params.arbitrationTriggered,
      conflicted: params.conflicted,
      finalSelectedCandidateId: params.finalSelectedCandidateId,
      auditSummary: params.auditSummary,
      selectionStatus: params.selectionStatus,
    };
  }
}

// ============================================================================
// 辅助函数：winner 一致性判定
// ============================================================================

/**
 * 判断两轮反匿名后的 winner 是否一致。
 *
 * 一致的定义（保守，倾向于保留 raw）：
 * - 两者都为 null（都 tie/降级）→ 一致（都判不清）
 * - 两者相等（同一候选胜出）→ 一致
 * - 其它 → 冲突
 *
 * 注意：null 与具体 id 不算一致（一轮 tie 一轮有 winner 视为冲突，保留 raw）。
 */
function winnersConsistent(w1: string | null, w2: string | null): boolean {
  if (w1 === null && w2 === null) return true;
  if (w1 === null || w2 === null) return false;
  return w1 === w2;
}

/**
 * 两轮一致时的选择决策。
 *
 * - 一致确认 amplified 胜出 → 交付 amplified（可审计胜因：两轮一致）
 * - 一致确认 raw 胜出 → 保留 raw
 * - 一致 tie（都 null）→ 保留 raw
 */
function resolveConsistentSelection(
  winnerId: string | null,
  rawId: string,
  editorialId: string,
  firstRound: PairwiseJudgeResult,
  _reverseRound: PairwiseJudgeResult
): SelectionDecision {
  if (winnerId === null) {
    return {
      selectedCandidateId: rawId,
      reason: `两轮均判 tie/不确定，保留 raw（首轮 confidence=${firstRound.verdict?.confidence ?? "N/A"}）`,
      needsReverseReview: false,
    };
  }
  if (winnerId === editorialId) {
    // 两轮一致确认 amplified 胜出
    // 仍需证据校验通过（首轮已校验，这里复核）
    const evidenceOk = firstRound.evidenceValidation.ok;
    if (!evidenceOk) {
      return {
        selectedCandidateId: rawId,
        reason: "两轮一致判 amplified 胜出，但证据校验未通过，保留 raw",
        needsReverseReview: false,
      };
    }
    return {
      selectedCandidateId: editorialId,
      reason: "两轮一致确认 amplified 胜出且证据有效，交付 amplified（可审计胜因：反向复判确认）",
      needsReverseReview: false,
    };
  }
  // 一致确认 raw 胜出
  return {
    selectedCandidateId: rawId,
    reason: "两轮一致判 raw 更优，保留 raw",
    needsReverseReview: false,
  };
}

/**
 * 异构仲裁后的选择决策。
 *
 * - 仲裁 winner 与首轮或反向某轮一致 → 采纳该轮决策
 * - 仲裁 tie/null 或与两轮都不一致 → 保留 raw
 */
function resolveArbitratedSelection(
  firstWinner: string | null,
  reverseWinner: string | null,
  arbWinner: string | null,
  rawId: string,
  editorialId: string,
  arbitrationRound: PairwiseJudgeResult
): SelectionDecision {
  // 仲裁降级 → 保留 raw
  if (arbitrationRound.degraded) {
    return {
      selectedCandidateId: rawId,
      reason: `异构仲裁降级（${arbitrationRound.degradeReason}），保留 raw`,
      needsReverseReview: false,
    };
  }

  // 仲裁 tie → 保留 raw
  if (arbWinner === null) {
    return {
      selectedCandidateId: rawId,
      reason: "异构仲裁判 tie，保留 raw",
      needsReverseReview: false,
    };
  }

  // 仲裁与某轮一致 → 采纳
  const agreesWithFirst = arbWinner === firstWinner;
  const agreesWithReverse = arbWinner === reverseWinner;

  if (agreesWithFirst || agreesWithReverse) {
    if (arbWinner === editorialId) {
      // 仲裁采纳 amplified：需证据校验通过
      if (!arbitrationRound.evidenceValidation.ok) {
        return {
          selectedCandidateId: rawId,
          reason: "异构仲裁判 amplified 胜出但证据校验未通过，保留 raw",
          needsReverseReview: false,
        };
      }
      return {
        selectedCandidateId: editorialId,
        reason: `异构仲裁（winner=${arbWinner}）与某轮一致，确认 amplified 胜出且证据有效，交付 amplified`,
        needsReverseReview: false,
      };
    }
    // 仲裁采纳 raw
    return {
      selectedCandidateId: rawId,
      reason: `异构仲裁（winner=${arbWinner}）与某轮一致，判 raw 更优，保留 raw`,
      needsReverseReview: false,
    };
  }

  // 仲裁与两轮都不一致 → 保留 raw
  return {
    selectedCandidateId: rawId,
    reason: `异构仲裁 winner=${arbWinner} 与首轮(${firstWinner})、反向(${reverseWinner})均不一致，保留 raw`,
    needsReverseReview: false,
  };
}

// ============================================================================
// 工厂函数
// ============================================================================

export function createJudgeArbitrator(judge?: PairwiseLiteraryJudge): JudgeArbitrator {
  return new JudgeArbitrator(judge);
}
