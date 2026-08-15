/**
 * StrategyOutcomeRecorder — 策略结果记录器（Phase 6，计划 §Phase 6 §7.2 §7.3）
 *
 * 把"策略上下文 → 候选 → 裁判 → 最终选择 → 用户修改"链路归一成一条 evidence，
 * 写入 StrategyPolicyStore，驱动 Thompson Sampling 在线学习。
 *
 * 设计原则（计划 §Phase 6）：
 * - 所有自动学习可解释、可撤销：每条 evidence 带 sourceChapter/outcome/source/weight/timestamp
 * - 外部反馈等级（计划 §7.2，从高到低）决定 weight：
 *     1. 用户最终选择或明确评分（最高权重）
 *     2. 用户对最终正文的实际修改（高权重）
 *     3. 异构 LLM 双裁判一致
 *     4. 单 LLM 裁判明确胜出
 *     5. 机械风险指标（仅诊断，weight=0，不写入策略信誉）
 * - 禁止：自动修改系统 prompt、作品宪法核心字段、硬门禁和世界事实
 *
 * 胜负语义（计划 §7.3 在线学习）：
 * - win：最终选中 editorial(strategyId)，且裁判/用户认为其优于 raw
 * - loss：最终保留 raw（裁判判 raw 更优 / tie / 编辑层失败 / 用户改回 raw）
 * - tie：裁判 tie 且无用户信号（弱更新，不改变 consecutiveLosses）
 *
 * 一个策略一次章节生成只记录一条 evidence（避免重复计数）；
 * 用户后续修改通过 UserFeedbackIngestor 追加高权重 evidence。
 */

import type { StrategyPolicyStore, StrategyEvidence } from "./strategy-policy-store.js";
import {
  allowsSingleStrategyEvidence,
  buildStrategyBundleId,
} from "./feedback-evidence-contracts.js";

// ============================================================================
// 常量：外部反馈等级权重（计划 §7.2）
// ============================================================================

/** 单 LLM 裁判明确胜出（weight=1，基准） */
export const WEIGHT_JUDGE_SINGLE = 1;
/** 异构 LLM 双裁判一致（weight=2，高于单裁判） */
export const WEIGHT_JUDGE_DOUBLE_CONSENSUS = 2;
/** 用户对最终正文的实际修改（weight=3，高权重，counts as multiple samples） */
export const WEIGHT_USER_MODIFICATION = 3;
/** 用户最终选择或明确评分（weight=3，最高权重） */
export const WEIGHT_USER_EXPLICIT = 3;
/** 机械风险指标（weight=0，仅诊断，不写入策略信誉） */
export const WEIGHT_MECHANICAL = 0;

// ============================================================================
// 类型
// ============================================================================

/** 策略上下文：一次候选生成-裁判-选择链路的标识 */
export interface StrategyContext {
  /** 章节号（如 "ch17"） */
  sourceChapter: string;
  /** 当前模型版本键（由 ModelVersionMigration.detectModelVersion 派生） */
  modelVersion: string;
  /** 触发的策略 id（单策略因果时使用） */
  strategyId: string;
  /** 编辑机会类型（审计用） */
  opportunityType: string;
  /** bundle 级学习目标（多策略协作时优先） */
  strategyBundleId?: string;
  /** 共同作用的策略列表 */
  strategyIds?: string[];
  /** 候选/暴露血缘 */
  orchestratorRunId?: string;
  candidateId?: string;
  exposureId?: string;
  promptBundleId?: string;
  /** 是否允许拆单策略（消融/随机分流/明确单策略暴露） */
  allowSingleStrategySplit?: boolean;
}

/** 裁判结果（来自 Phase 4 JudgeArbitrator） */
export interface JudgeOutcome {
  /** 物理候选 id（editorial 候选） */
  editorialCandidateId: string;
  /** raw 候选 id */
  rawCandidateId: string;
  /** 最终选中的候选 id（null 表示 tie 后保留 raw） */
  selectedCandidateId: string | null;
  /** 裁判置信度 */
  confidence: "clear" | "slight" | "uncertain";
  /** 是否经过反向复判 */
  hadReverseReview: boolean;
  /** 反向复判是否与主裁判一致（异构双裁判一致信号） */
  reverseConsensus: boolean;
  /** 裁判是否判 tie */
  tie: boolean;
}

/** 最终选择结果（来自 Phase 5 SelectionPolicy） */
export interface SelectionOutcome {
  /** 最终交付的候选 id */
  deliveredCandidateId: string;
  /** 交付来源：editorial / raw / fallback */
  deliveredSource: "editorial" | "raw" | "fallback";
  /** 是否因编辑/裁判失败回退 raw */
  fellBackToRaw: boolean;
}

/** 记录请求 */
export interface OutcomeRecordRequest {
  context: StrategyContext;
  judge?: JudgeOutcome;
  selection: SelectionOutcome;
  /** 可选：用户后续修改信号（通常由 UserFeedbackIngestor 异步追加，这里允许同步记录） */
  userSignal?: UserSignal;
  /** 可选备注 */
  note?: string;
}

/** 用户信号（计划 §7.2 等级 1-2） */
export interface UserSignal {
  /** 用户是否明确选择 editorial（等级 1） */
  explicitChoice?: "editorial" | "raw";
  /** 用户是否对最终正文做了实际修改（等级 2） */
  modifiedFinalText: boolean;
  /** 修改幅度（0-1，可选；用于细化权重） */
  editDistance?: number;
}

export interface RecordedOutcome {
  strategyId: string;
  modelVersion: string;
  outcome: "win" | "loss" | "tie";
  weight: number;
  source: "judge" | "user";
  evidence: StrategyEvidence;
  /** 是否实际写入策略信誉（weight=0 的机械信号不写入） */
  recorded: boolean;
  /** 未写入原因（recorded=false 时） */
  reason?: string;
  /** bundle 学习目标（多策略时） */
  strategyBundleId?: string;
  /** 实际写入的信誉键（bundleId 或 strategyId） */
  reputationKey?: string;
  decisionCount?: number;
}

// ============================================================================
// StrategyOutcomeRecorder
// ============================================================================

export class StrategyOutcomeRecorder {
  /**
   * 把一次候选-裁判-选择链路记录为策略 evidence。
   *
   * 流程：
   * 1. 判定 outcome（win/loss/tie）：
   *    - 用户明确信号优先（explicitChoice / modifiedFinalText）
   *    - 无用户信号时按裁判结果：
   *      - tie → tie
   *      - selected=editorial 且 confidence=clear → win
   *      - selected=raw / fellBackToRaw / confidence!=clear → loss
   * 2. 判定 weight：
   *    - 用户明确选择 → WEIGHT_USER_EXPLICIT
   *    - 用户修改 → WEIGHT_USER_MODIFICATION
   *    - 双裁判一致 → WEIGHT_JUDGE_DOUBLE_CONSENSUS
   *    - 单裁判 → WEIGHT_JUDGE_SINGLE
   * 3. weight=0（机械信号）不写入策略信誉，只返回记录用于 trace
   * 4. 调用 StrategyPolicyStore.recordOutcome
   *
   * @returns 记录结果（含 evidence 与是否实际写入）
   */
  record(
    store: StrategyPolicyStore,
    request: OutcomeRecordRequest
  ): RecordedOutcome {
    const { context, judge, selection, userSignal, note } = request;

    // 无裁判无用户信号且未回退：无法判定，不记录（避免虚假样本）
    // 注：fellBackToRaw=true 是有效信号（编辑层失败 = 策略未产出可用候选 = loss）
    if (!judge && !userSignal && !selection.fellBackToRaw) {
      return {
        strategyId: context.strategyId,
        modelVersion: context.modelVersion,
        outcome: "tie",
        weight: 0,
        source: "judge",
        evidence: this.buildEvidence(context, "tie", 0, "judge", note),
        recorded: false,
        reason: "无裁判结果且无用户信号，不记录",
      };
    }

    // 编辑层失败回退 raw（无裁判）：策略未产出可用候选 → loss
    if (!judge && !userSignal && selection.fellBackToRaw) {
      const writeTarget = this.resolveReputationWriteTarget(context);
      const evidence = this.buildEvidence(
        context,
        "loss",
        WEIGHT_JUDGE_SINGLE,
        "judge",
        note ?? "编辑层失败回退 raw，策略未产出可用候选（loss）"
      );
      const evidenceWithBundle: StrategyEvidence = {
        ...evidence,
        strategyBundleId: writeTarget.strategyBundleId,
        decisionCount: 1,
        evidenceId: `outcome:${context.sourceChapter}:${writeTarget.reputationKey}:${Date.now()}`,
      };
      store.recordOutcome(
        writeTarget.reputationKey,
        context.modelVersion,
        evidenceWithBundle,
      );
      return {
        strategyId: context.strategyId,
        modelVersion: context.modelVersion,
        outcome: "loss",
        weight: WEIGHT_JUDGE_SINGLE,
        source: "judge",
        evidence: evidenceWithBundle,
        recorded: true,
        strategyBundleId: writeTarget.strategyBundleId,
        reputationKey: writeTarget.reputationKey,
        decisionCount: 1,
      };
    }

    // 判定 outcome 与 weight（用户信号优先）
    const determination = this.determineOutcome(context, judge, selection, userSignal);

    const evidence = this.buildEvidence(
      context,
      determination.outcome,
      determination.weight,
      determination.source,
      note ?? determination.note
    );

    // weight=0（机械信号 / raw 修改）不写入策略信誉
    if (determination.weight === 0) {
      return {
        strategyId: context.strategyId,
        modelVersion: context.modelVersion,
        outcome: determination.outcome,
        weight: 0,
        source: determination.source,
        evidence,
        recorded: false,
        reason: determination.note ?? "weight=0，仅诊断不写入策略信誉",
        strategyBundleId: this.resolveBundleId(context),
        reputationKey: undefined,
        decisionCount: 1,
      };
    }

    const writeTarget = this.resolveReputationWriteTarget(context);
    const evidenceWithBundle: StrategyEvidence = {
      ...evidence,
      strategyBundleId: writeTarget.strategyBundleId,
      decisionCount: 1,
      evidenceId:
        evidence.evidenceId ??
        `outcome:${context.sourceChapter}:${writeTarget.reputationKey}:${Date.now()}`,
    };

    store.recordOutcome(
      writeTarget.reputationKey,
      context.modelVersion,
      evidenceWithBundle,
    );

    return {
      strategyId: context.strategyId,
      modelVersion: context.modelVersion,
      outcome: determination.outcome,
      weight: determination.weight,
      source: determination.source,
      evidence: evidenceWithBundle,
      recorded: true,
      strategyBundleId: writeTarget.strategyBundleId,
      reputationKey: writeTarget.reputationKey,
      decisionCount: 1,
    };
  }

  /**
   * bundle 优先：多策略时默认写 bundle 信誉；单策略或授权拆分时写 strategyId。
   */
  private resolveReputationWriteTarget(context: StrategyContext): {
    reputationKey: string;
    strategyBundleId: string;
  } {
    const strategyIds =
      context.strategyIds && context.strategyIds.length > 0
        ? context.strategyIds
        : [context.strategyId];
    const strategyBundleId =
      context.strategyBundleId ?? buildStrategyBundleId(strategyIds);

    const singleOk = allowsSingleStrategyEvidence({
      strategyIds,
      explicitSingleStrategyExposure: context.allowSingleStrategySplit === true,
      ablationExperiment: context.allowSingleStrategySplit === true,
      randomSplit: context.allowSingleStrategySplit === true,
    });

    if (strategyIds.length > 1 && !singleOk) {
      return { reputationKey: strategyBundleId, strategyBundleId };
    }
    return {
      reputationKey: context.strategyId,
      strategyBundleId,
    };
  }

  private resolveBundleId(context: StrategyContext): string {
    const strategyIds =
      context.strategyIds && context.strategyIds.length > 0
        ? context.strategyIds
        : [context.strategyId];
    return context.strategyBundleId ?? buildStrategyBundleId(strategyIds);
  }

  // --------------------------------------------------------------------------
  // 内部：outcome 与 weight 判定
  // --------------------------------------------------------------------------

  private determineOutcome(
    context: StrategyContext,
    judge: JudgeOutcome | undefined,
    selection: SelectionOutcome,
    userSignal: UserSignal | undefined
  ): {
    outcome: "win" | "loss" | "tie";
    weight: number;
    source: "judge" | "user";
    note?: string;
  } {
    // 用户明确信号优先（计划 §7.2 等级 1-2）
    if (userSignal) {
      // 等级 1：用户明确选择
      if (userSignal.explicitChoice) {
        const outcome: "win" | "loss" =
          userSignal.explicitChoice === "editorial" ? "win" : "loss";
        return {
          outcome,
          weight: WEIGHT_USER_EXPLICIT,
          source: "user",
          note: `用户明确选择 ${userSignal.explicitChoice}`,
        };
      }
      // 等级 2：用户实际修改最终正文
      if (userSignal.modifiedFinalText) {
        const deliveredEditorial = selection.deliveredSource === "editorial";
        if (!deliveredEditorial) {
          // USER-FEEDBACK-EVIDENCE-PIPELINE-1：raw/fallback 修改不计入策略信誉
          return {
            outcome: "tie",
            weight: 0,
            source: "user",
            note: "用户修改了 raw/fallback 交付稿（策略未参与交付），不计入策略信誉",
          };
        }
        return {
          outcome: "loss",
          weight: WEIGHT_USER_MODIFICATION,
          source: "user",
          note: "用户修改了 editorial 交付稿，视为对策略候选的否定",
        };
      }
    }

    // 无用户信号：按裁判结果（计划 §7.2 等级 3-4）
    if (!judge) {
      // 无裁判：tie（弱更新），weight=0 避免虚假样本
      return {
        outcome: "tie",
        weight: 0,
        source: "judge",
        note: "无裁判结果，weight=0 不写入策略信誉",
      };
    }

    // tie → tie（弱更新）
    if (judge.tie) {
      // 双裁判一致 tie（罕见）仍记为 tie，weight=1
      const weight = judge.reverseConsensus
        ? WEIGHT_JUDGE_DOUBLE_CONSENSUS
        : WEIGHT_JUDGE_SINGLE;
      return {
        outcome: "tie",
        weight,
        source: "judge",
        note: judge.reverseConsensus ? "双裁判一致 tie" : "单裁判 tie",
      };
    }

    // 明确胜负判定
    const editorialWon =
      judge.selectedCandidateId === judge.editorialCandidateId &&
      selection.deliveredSource === "editorial" &&
      !selection.fellBackToRaw;

    if (editorialWon) {
      // editorial 胜出
      const weight = judge.reverseConsensus
        ? WEIGHT_JUDGE_DOUBLE_CONSENSUS
        : WEIGHT_JUDGE_SINGLE;
      return {
        outcome: "win",
        weight,
        source: "judge",
        note: judge.reverseConsensus
          ? "双裁判一致判定 editorial 胜出"
          : `单裁判判定 editorial 胜出（confidence=${judge.confidence}）`,
      };
    }

    // raw 胜出 / 回退 raw / confidence 不足
    const weight = judge.reverseConsensus
      ? WEIGHT_JUDGE_DOUBLE_CONSENSUS
      : WEIGHT_JUDGE_SINGLE;
    return {
      outcome: "loss",
      weight,
      source: "judge",
      note: selection.fellBackToRaw
        ? `编辑/裁判失败回退 raw（loss）`
        : `裁判判定 raw 更优或 confidence=${judge.confidence} 不足，保留 raw（loss）`,
    };
  }

  private buildEvidence(
    context: StrategyContext,
    outcome: "win" | "loss" | "tie",
    weight: number,
    source: "judge" | "user",
    note?: string
  ): StrategyEvidence {
    return {
      sourceChapter: context.sourceChapter,
      outcome,
      source,
      weight,
      timestamp: new Date().toISOString(),
      note,
    };
  }
}

export function createStrategyOutcomeRecorder(): StrategyOutcomeRecorder {
  return new StrategyOutcomeRecorder();
}
