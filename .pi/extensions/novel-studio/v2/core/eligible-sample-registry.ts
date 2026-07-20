/**
 * EligibleSampleRegistry — raw/editorial 样本注册表 + 匿名人工审阅协议（EDITORIAL-BENEFIT-1，计划 §6.4）
 *
 * 目标：建立可比较的 raw/editorial 样本注册表，从真实运行 artifact 中区分
 * no_editorial / factguard_block / story_preservation_block / editorial_win / judge_raw_win，
 * 只把"editorial 候选确实生成、通过 FactGuard 与故事保存门、并进入 judge 仲裁"的样本
 * 构造为 eligible pair，供后续 EDITORIAL-BENEFIT-2 收益消融与人工审阅使用。
 *
 * 核心不变量（EDITORIAL-BENEFIT-1 任务书）：
 * - 至少 3 个 eligible pair 才可进入收益验证（insufficient-data 保护）。
 * - 同一 run/raw provenance（pair 的 raw 与 editorial 必须来自同一次 orchestrate 运行）。
 * - 人工表单匿名（reviewer 身份匿名化；model 版本/路由不进入表单；judge verdict 不展示给 reviewer）。
 * - fallback 样本不冒充 editorial 增量（no_editorial / factguard_block / story_preservation_block 排除）。
 * - 重复样本去重（同 sampleId 保留首个）。
 * - 样本不足保持 insufficient-data，不推断正负收益。
 *
 * 边界（L0 工程闭环）：
 * - 只整理调用方传入的 artifact 数据，不重新生成章节。
 * - 不调用网络模型；不修改 finalText；不提交状态；不是 gate；不阻断正文生成。
 * - 不直接读文件系统（调用方负责加载 artifact，本模块只做数据转换与分类）。
 *
 * 与 generation-matrix-runner.ts 的关系：
 * - B4OutcomeType 已在 novelbench/generation-matrix-runner.ts 定义（含 editorial_win/judge_raw/
 *   judge_degraded/judge_conflict/judge_all_failed/no_editorial/factguard_block/
 *   story_preservation_block/budget_fallback/orchestrate_failed）。
 * - 本模块定义本地 EditorialOutcomeType 子集（只覆盖与 eligible pair 分类相关的 5 类），
 *   避免生产 v2/core 反向依赖 eval 基础设施（novelbench/）。
 * - 调用方负责把 B4OutcomeType 映射为本模块 EditorialOutcomeType（judge_degraded/judge_conflict/
 *   judge_all_failed/budget_fallback/orchestrate_failed 均不构造 eligible pair，进入 excluded）。
 */

import { createHash } from "node:crypto";

// ============================================================================
// 数据契约
// ============================================================================

/**
 * Editorial outcome 分类（本地子集，与 B4OutcomeType 保持语义一致但独立定义）。
 *
 * - editorial_win：editorial 候选胜出 judge，finalSource=editorial。
 * - judge_raw_win：editorial 候选存在并进入 judge，但 judge 选 raw，finalSource=raw。
 * - no_editorial：0 hypotheses / Thompson not admitted / 无候选生成。
 * - factguard_block：候选生成但全部被 FactGuard 拒绝。
 * - story_preservation_block：候选通过 FactGuard 但被故事保存门拒绝。
 *
 * 其他 B4OutcomeType（judge_degraded/judge_conflict/judge_all_failed/budget_fallback/
 * orchestrate_failed）由调用方映射为 other_failure 进入 excluded，不构造 eligible pair。
 */
export type EditorialOutcomeType =
  | "editorial_win"
  | "judge_raw_win"
  | "no_editorial"
  | "factguard_block"
  | "story_preservation_block"
  | "other_failure";

/**
 * 候选 provenance（raw 或 editorial）。
 * 来自 B4 artifacts 的 candidate 文件元数据。
 */
export interface CandidateProvenance {
  /** 候选 id（与 candidateId 一致） */
  candidateId: string;
  /** 候选类型 */
  candidateKind: "raw" | "editorial";
  /** 候选文本文件路径（用于审计追溯） */
  sourcePath: string;
  /** 候选文本 SHA-256（用于完整性校验） */
  sourceSha256: string;
  /** 所属 orchestrate 运行 id */
  orchestratorRunId: string;
  /** 所属 case id */
  caseId: string;
  /** 所属 B 层（B0-B4） */
  layer: string;
}

/**
 * 单次运行样本（调用方从 B4 artifacts 整理）。
 */
export interface EligibleSample {
  /** 样本唯一 id（推荐 orchestratorRunId:rawCandidateId） */
  sampleId: string;
  /** 运行 provenance */
  runProvenance: {
    orchestratorRunId: string;
    caseId: string;
    layer: string;
    modelVersion: string;
    seed: number;
  };
  /** raw 候选 provenance（必填） */
  rawCandidate: CandidateProvenance;
  /** editorial 候选 provenance（no_editorial 时为 undefined） */
  editorialCandidate?: CandidateProvenance;
  /** outcome 分类 */
  outcomeType: EditorialOutcomeType;
  /** FactGuard 结果（每个候选一条） */
  factGuardResults?: Array<{
    candidateId: string;
    passed: boolean;
    reason?: string;
  }>;
  /** 故事保存门报告 */
  storyPreservationReport?: { passed: boolean; reason?: string };
  /** judge 仲裁结果（无候选时为 undefined） */
  judgeResult?: {
    winner: "raw" | "editorial" | "tie";
    anonymousMapping: Record<string, "raw" | "editorial">;
  };
  /** 最终选中的候选 id */
  selectedCandidateId: string;
  /** 最终交付来源 */
  finalSource: "raw" | "editorial";
  /** 是否 fallback（outcomeType !== editorial_win） */
  fallbacked: boolean;
}

/**
 * Eligible pair（只对 editorial_win / judge_raw_win 构造）。
 * 用于 EDITORIAL-BENEFIT-2 收益消融与人工审阅。
 */
export interface EligiblePair {
  /** pair id（与 sampleId 一致） */
  pairId: string;
  /** 样本 id */
  sampleId: string;
  /** raw 候选 provenance */
  rawCandidate: CandidateProvenance;
  /** editorial 候选 provenance */
  editorialCandidate: CandidateProvenance;
  /** outcome 分类（只允许 editorial_win 或 judge_raw_win） */
  outcomeType: "editorial_win" | "judge_raw_win";
  /** judge 胜出方 */
  judgeWinner: "raw" | "editorial" | "tie";
  /** 运行 provenance */
  runProvenance: EligibleSample["runProvenance"];
  /** 匿名人工审阅（提交前为 undefined） */
  humanVerdict?: AnonymousHumanVerdict;
}

/**
 * 被排除的样本（含原因，不静默丢弃）。
 */
export interface ExcludedSample {
  sampleId: string;
  outcomeType: EditorialOutcomeType;
  /** 排除原因（可读字符串） */
  reason: string;
}

/**
 * 匿名人工审阅 verdict。
 */
export interface AnonymousHumanVerdict {
  /** 匿名 reviewer id（anon-XXXXXXXX 格式，不可逆哈希） */
  reviewerAnonId: string;
  /** 偏好（raw/editorial/tie/undecided） */
  preference: "raw" | "editorial" | "tie" | "undecided";
  /** 胜出 span（来自候选正文） */
  winningSpans: string[];
  /** 落败 span（来自候选正文） */
  losingSpans: string[];
  /** 评审理由 */
  rationale: string;
  /** 提交时间（ISO 8601） */
  submittedAt: string;
}

/**
 * 人工审阅协议（匿名化规则 + 评审维度 + 提交规则）。
 */
export interface HumanReviewProtocol {
  /** 表单版本 */
  formVersion: string;
  /** 匿名化规则（防锚定） */
  anonymizationRules: string[];
  /** 评审维度 */
  reviewDimensions: string[];
  /** 提交规则 */
  submissionRules: string[];
}

/**
 * Registry 编译结果。
 */
export interface EligibleSampleRegistryResult {
  /** eligible pair 列表（只含 editorial_win / judge_raw_win） */
  eligiblePairs: EligiblePair[];
  /** 被排除的样本（含原因） */
  excludedSamples: ExcludedSample[];
  /** 总样本数（去重后） */
  totalCount: number;
  /** eligible pair 数 */
  eligibleCount: number;
  /** 样本不足（< 3 eligible pair） */
  insufficientData: boolean;
}

// ============================================================================
// 常量
// ============================================================================

/**
 * 进入收益验证所需的最小 eligible pair 数（任务书 acceptance）。
 */
const MIN_ELIGIBLE_PAIRS_FOR_BENEFIT_VERIFICATION = 3;

/**
 * 默认人工审阅协议（匿名化 + 评审维度 + 提交规则）。
 *
 * 设计原则：
 * - reviewer 身份匿名化（不可逆哈希），防锚定与人际压力。
 * - raw/editorial 标签在表单中替换为 A/B（随机化），防位置偏置。
 * - model 版本/路由不进入表单，防"模型崇拜"偏差。
 * - judge verdict 不展示给 reviewer，防锚定裁判结论。
 * - reviewer 必须给出 winning/losing spans，防"都好/都差"规避选择。
 * - 提交后不可修改，防基于他人结论调整。
 */
export const DEFAULT_HUMAN_REVIEW_PROTOCOL: HumanReviewProtocol = {
  formVersion: "anon-v1",
  anonymizationRules: [
    "reviewer 身份替换为 anon-XXXXXXXX（不可逆 SHA-256 哈希前 8 位），不保留原身份",
    "raw/editorial 标签在表单中替换为 A/B（随机化映射），reviewer 不知哪个是 raw/editorial",
    "model 版本与路由不进入表单（防'模型崇拜'偏差）",
    "judge verdict 不展示给 reviewer（防锚定裁判结论）",
  ],
  reviewDimensions: [
    "文学性（语言/节奏/张力）",
    "事实准确（与既有 canon/状态一致）",
    "连续性（与前章/本章 intent 一致）",
    "情绪落点（是否达成 readerExperience 目标）",
    "整体偏好",
  ],
  submissionRules: [
    "reviewer 必须给出 winning spans 与 losing spans（不可空泛评论）",
    "reviewer 不得使用'都好'/'都差'规避选择（tie 需明确理由）",
    "提交后不可修改（防基于他人结论调整）",
  ],
};

// ============================================================================
// 核心编译逻辑
// ============================================================================

/**
 * 编译 EligibleSampleRegistry。
 *
 * 编译规则：
 * 1. 去重：同 sampleId 保留首个。
 * 2. 分类：
 *    a. editorial_win / judge_raw_win → 进入 eligible pair 构造（需通过 provenance/结构校验）
 *    b. no_editorial / factguard_block / story_preservation_block / other_failure → excluded
 * 3. eligible pair 构造校验：
 *    a. raw 与 editorial candidate 均存在
 *    b. selectedCandidateId 匹配 raw 或 editorial
 *    c. finalSource 与 selectedCandidateId 一致
 *    d. raw 与 editorial provenance 同 runId/caseId/layer
 *    任一失败 → excluded（附原因）
 * 4. insufficient-data：< 3 eligible pair 时 insufficientData=true
 *
 * 不调用 LLM；不修改 finalText；不提交状态；不是 gate。
 */
export function compileEligibleSampleRegistry(
  samples: ReadonlyArray<EligibleSample>
): EligibleSampleRegistryResult {
  const seenSampleIds = new Set<string>();
  const eligiblePairs: EligiblePair[] = [];
  const excludedSamples: ExcludedSample[] = [];

  for (const sample of samples) {
    // 1. 去重
    if (seenSampleIds.has(sample.sampleId)) continue;
    seenSampleIds.add(sample.sampleId);

    // 2. 分类：非 eligible outcome 直接进 excluded
    if (sample.outcomeType !== "editorial_win" && sample.outcomeType !== "judge_raw_win") {
      excludedSamples.push({
        sampleId: sample.sampleId,
        outcomeType: sample.outcomeType,
        reason: deriveExclusionReason(sample),
      });
      continue;
    }

    // 3. eligible pair 构造校验
    const validation = validateEligibleSample(sample);
    if (!validation.ok) {
      excludedSamples.push({
        sampleId: sample.sampleId,
        outcomeType: sample.outcomeType,
        reason: validation.reason,
      });
      continue;
    }

    // 4. 构造 eligible pair
    const pair: EligiblePair = {
      pairId: sample.sampleId,
      sampleId: sample.sampleId,
      rawCandidate: sample.rawCandidate,
      editorialCandidate: sample.editorialCandidate!,
      outcomeType: sample.outcomeType,
      judgeWinner: sample.judgeResult?.winner ?? "tie",
      runProvenance: sample.runProvenance,
    };
    eligiblePairs.push(pair);
  }

  const totalCount = eligiblePairs.length + excludedSamples.length;
  const eligibleCount = eligiblePairs.length;
  const insufficientData = eligibleCount < MIN_ELIGIBLE_PAIRS_FOR_BENEFIT_VERIFICATION;

  return {
    eligiblePairs,
    excludedSamples,
    totalCount,
    eligibleCount,
    insufficientData,
  };
}

// ============================================================================
// 辅助：样本校验
// ============================================================================

/**
 * 校验 eligible sample 是否可构造为 eligible pair。
 *
 * 校验项：
 * 1. editorialCandidate 必须存在
 * 2. selectedCandidateId 必须匹配 raw 或 editorial 的 candidateId
 * 3. finalSource 与 selectedCandidateId 一致（选 editorial → finalSource=editorial；选 raw → finalSource=raw）
 * 4. raw 与 editorial provenance 同 runId/caseId/layer
 */
function validateEligibleSample(sample: EligibleSample): { ok: true } | { ok: false; reason: string } {
  if (!sample.editorialCandidate) {
    return { ok: false, reason: "editorialCandidate 缺失（无法构造 win/loss pair）" };
  }

  const rawId = sample.rawCandidate.candidateId;
  const edId = sample.editorialCandidate.candidateId;
  const selectedId = sample.selectedCandidateId;

  if (selectedId !== rawId && selectedId !== edId) {
    return {
      ok: false,
      reason: `selectedCandidateId=${selectedId} 不匹配 raw(${rawId}) 或 editorial(${edId})`,
    };
  }

  // finalSource 与 selectedCandidateId 一致性
  const expectedSource = selectedId === edId ? "editorial" : "raw";
  if (sample.finalSource !== expectedSource) {
    return {
      ok: false,
      reason: `finalSource=${sample.finalSource} 与 selectedCandidateId=${selectedId}（期望 ${expectedSource}）不一致`,
    };
  }

  // provenance 一致性
  if (!validateEligiblePairProvenance(sample.rawCandidate, sample.editorialCandidate)) {
    return {
      ok: false,
      reason: `provenance 不一致：raw(runId=${sample.rawCandidate.orchestratorRunId}, case=${sample.rawCandidate.caseId}, layer=${sample.rawCandidate.layer}) ≠ editorial(runId=${sample.editorialCandidate.orchestratorRunId}, case=${sample.editorialCandidate.caseId}, layer=${sample.editorialCandidate.layer})`,
    };
  }

  return { ok: true };
}

/**
 * 校验 raw 与 editorial candidate provenance 是否来自同一运行。
 * 公开导出供调用方在构造 sample 前预检。
 */
export function validateEligiblePairProvenance(
  raw: CandidateProvenance,
  editorial: CandidateProvenance
): boolean {
  return (
    raw.orchestratorRunId === editorial.orchestratorRunId &&
    raw.caseId === editorial.caseId &&
    raw.layer === editorial.layer
  );
}

// ============================================================================
// 辅助：排除原因推导
// ============================================================================

/**
 * 推导非 eligible outcome 的排除原因。
 */
function deriveExclusionReason(sample: EligibleSample): string {
  switch (sample.outcomeType) {
    case "no_editorial":
      return "no_editorial：0 hypotheses 或 Thompson not admitted 或无候选生成，不计 win/loss pair";
    case "factguard_block":
      return "factguard_block：候选生成但被 FactGuard 拒绝，不计 win/loss pair";
    case "story_preservation_block":
      return "story_preservation_block：候选通过 FactGuard 但被故事保存门拒绝，不计 win/loss pair";
    case "other_failure":
      return "other_failure：judge 降级/冲突/全部失败/预算回退/orchestrate 失败，不计 win/loss pair";
    default:
      return `未知 outcomeType=${sample.outcomeType}`;
  }
}

// ============================================================================
// 辅助：reviewer 身份匿名化
// ============================================================================

/**
 * 把 reviewer 原始身份匿名化为 anon-XXXXXXXX 格式（不可逆 SHA-256 前 8 位）。
 *
 * - 空输入返回 "anon-unknown"（不抛异常）。
 * - 同输入同输出（确定性哈希）。
 * - 不同输入不同输出（SHA-256 雪崩）。
 * - 不含原身份（不可逆）。
 *
 * 用途：人工审阅表单中 reviewer 字段；防人际压力与锚定。
 */
export function anonymizeReviewerId(rawReviewerId: string | null | undefined): string {
  if (!rawReviewerId || rawReviewerId.length === 0) {
    return "anon-unknown";
  }
  const hash = createHash("sha256").update(rawReviewerId, "utf8").digest("hex");
  return `anon-${hash.slice(0, 8)}`;
}
