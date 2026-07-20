/**
 * PairwiseLiteraryJudge — LLM 文学裁判（Phase 4，计划 §Phase 4 + §5）
 *
 * 对 raw 候选与 editorial 候选做匿名 A/B 比较，输出结构化 JudgeVerdict。
 *
 * 设计原则（计划 §5 裁判协议）：
 * - 匿名 A/B：候选匿名为 A/B，不暴露 raw/amplified 身份
 * - 顺序随机化：buildAnonymousMapping 用 seed 决定 A/B 标签
 * - 结构化 verdict：parseJudgeVerdict 解析 JSON
 * - span 强制：validateJudgeEvidence 校验所有负面判断带 span
 * - tie/uncertain：允许，默认保留 raw（decideSelection 处理）
 * - LLM 失败/parse 失败/证据无效 → 降级保留 raw，不硬选 amplified
 *
 * 本模块只做单轮裁判；反向复判与异构仲裁在 judge-arbitrator.ts。
 *
 * 替换关系（计划 §Phase 4）：
 * - 旧 CandidateComparator 用机械 11 维总分决定 winner → 降为证据收集器
 * - 本 judge 用 LLM 直接比较决定文学胜负，机械总分不再决定 winner
 */

import type {
  Candidate,
  ConstitutionSnapshot,
} from "./types.js";
import type { ChapterIntent } from "./chapter-intent-builder.js";
import type {
  AnonymousMapping,
  JudgeVerdict,
  SelectionDecision,
} from "./judge-types.js";
import {
  buildAnonymousMapping,
  resolveVerdictToCandidates,
  decideSelection,
} from "./judge-types.js";
import type {
  ModelGenerateFn,
  ModelGenerateInput,
} from "../adapters/legacy-model-route-adapter.js";
import { buildJudgePrompt, parseJudgeVerdict } from "./judge-prompt-builder.js";
import {
  validateJudgeEvidence,
  type EvidenceValidationResult,
} from "./judge-evidence-validator.js";

// ============================================================================
// 常量
// ============================================================================

/** 裁判 LLM 路由（model-routing.json v2_literary_judge） */
const DEFAULT_JUDGE_ROUTE = "v2_literary_judge";

/** 裁判 LLM 调用 bounded 超时（ms） */
const DEFAULT_JUDGE_TIMEOUT_MS = 180000;

// ============================================================================
// 输入/输出类型
// ============================================================================

export interface PairwiseJudgeInput {
  /** raw 候选（基线） */
  rawCandidate: Candidate;
  /** editorial 候选（机会驱动生成） */
  editorialCandidate: Candidate;
  /** 章节意图 */
  intent: ChapterIntent;
  /** 作品宪法快照（可空） */
  constitution: ConstitutionSnapshot | null;
  /** 模型调用函数 */
  modelGenerate: ModelGenerateFn;
  /** 随机种子（决定 A/B 顺序，可复现） */
  seed?: number;
  /**
   * 可选匿名映射覆盖。提供时直接使用该映射（用于反向复判的 swapOrder）；
   * 不提供时由 seed 派生 buildAnonymousMapping。
   */
  mapping?: AnonymousMapping;
  /** 路由名（默认 v2_literary_judge） */
  route?: string;
  /** 超时 ms */
  timeoutMs?: number;
}

export interface PairwiseJudgeResult {
  /** 裁判 verdict（LLM/parse 失败时为 null） */
  verdict: JudgeVerdict | null;
  /** 匿名映射 */
  mapping: AnonymousMapping;
  /** 证据校验结果（verdict 为 null 时为失败态） */
  evidenceValidation: EvidenceValidationResult;
  /** 反匿名后的 winner 候选 id（tie 或失败时为 null） */
  winnerCandidateId: string | null;
  /** 选择决策（基于 verdict + 证据 + raw fallback） */
  selection: SelectionDecision;
  /** 是否降级（LLM/parse/证据失败） */
  degraded: boolean;
  /** 降级原因 */
  degradeReason?: string;
}

// ============================================================================
// PairwiseLiteraryJudge 主类
// ============================================================================

export class PairwiseLiteraryJudge {
  async judge(input: PairwiseJudgeInput): Promise<PairwiseJudgeResult> {
    const {
      rawCandidate,
      editorialCandidate,
      intent,
      constitution,
      modelGenerate,
    } = input;

    // 1. 匿名化映射：优先使用传入的 mapping（反向复判用 swapOrder），
    //    否则由 seed 派生 buildAnonymousMapping
    const seed = input.seed ?? defaultSeed(rawCandidate.id, editorialCandidate.id);
    const mapping = input.mapping ?? buildAnonymousMapping(
      rawCandidate.id,
      editorialCandidate.id,
      seed
    );

    // 2. 按 mapping 渲染候选 A/B
    const { candidateAText, candidateBText } = renderCandidatesByMapping(
      rawCandidate,
      editorialCandidate,
      mapping
    );

    // 3. 构建 prompt
    const { systemPrompt, userPrompt } = buildJudgePrompt({
      candidateAText,
      candidateBText,
      mapping,
      intent,
      constitution,
    });

    // 4. 调用 LLM（bounded 超时）
    const route = input.route ?? DEFAULT_JUDGE_ROUTE;
    const timeoutMs = input.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
    const genInput: ModelGenerateInput = {
      route,
      systemPrompt,
      userPrompt,
      kind: "literary_judge",
      timeoutMs,
    };

    let llmText: string;
    try {
      const output = await modelGenerate(genInput);
      llmText = output.text ?? "";
    } catch (e: unknown) {
      // LLM 调用失败 → 降级保留 raw
      const msg = e instanceof Error ? e.message : String(e);
      return this.degrade(mapping, `LLM 调用失败：${msg}`);
    }

    if (!llmText.trim()) {
      return this.degrade(mapping, "LLM 返回空文本");
    }

    // 5. 解析 verdict
    const verdict = parseJudgeVerdict(llmText);
    if (!verdict) {
      return this.degrade(mapping, "LLM 输出 parse 失败或字段缺失");
    }

    // 6. 证据校验
    const evidenceValidation = validateJudgeEvidence(
      verdict,
      candidateAText,
      candidateBText
    );

    // 7. 反匿名化 + 选择决策
    const { winnerCandidateId } = resolveVerdictToCandidates(verdict, mapping);
    const selection = decideSelection(
      editorialCandidate.id,
      rawCandidate.id,
      winnerCandidateId,
      verdict,
      evidenceValidation.ok
    );

    return {
      verdict,
      mapping,
      evidenceValidation,
      winnerCandidateId,
      selection,
      degraded: false,
    };
  }

  /**
   * 构造降级结果：verdict=null，保留 raw。
   */
  private degrade(mapping: AnonymousMapping, reason: string): PairwiseJudgeResult {
    return {
      verdict: null,
      mapping,
      evidenceValidation: {
        ok: false,
        errors: [reason],
        missingSpanReasons: [],
        inconsistentWinnerReasons: [],
      },
      winnerCandidateId: null,
      selection: {
        selectedCandidateId: mapping.leftCandidateId, // raw 是 left（buildAnonymousMapping 第一参数）
        reason: `裁判降级：${reason}，保留 raw`,
        needsReverseReview: false,
      },
      degraded: true,
      degradeReason: reason,
    };
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 按 mapping 渲染候选 A/B 文本。
 * mapping.leftLabel 决定 raw 是 A 还是 B。
 */
function renderCandidatesByMapping(
  rawCandidate: Candidate,
  editorialCandidate: Candidate,
  mapping: AnonymousMapping
): { candidateAText: string; candidateBText: string } {
  // rawCandidate 是 leftCandidateId，editorial 是 rightCandidateId
  const rawText = rawCandidate.text;
  const editorialText = editorialCandidate.text;
  // mapping.leftLabel 是 raw 的标签
  if (mapping.leftLabel === "A") {
    return { candidateAText: rawText, candidateBText: editorialText };
  }
  return { candidateAText: editorialText, candidateBText: rawText };
}

/**
 * 默认 seed：从两个候选 id 派生稳定种子，保证可复现。
 */
function defaultSeed(leftId: string, rightId: string): number {
  let hash = 0;
  const str = `${leftId}|${rightId}`;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// ============================================================================
// 工厂函数
// ============================================================================

export function createPairwiseLiteraryJudge(): PairwiseLiteraryJudge {
  return new PairwiseLiteraryJudge();
}
