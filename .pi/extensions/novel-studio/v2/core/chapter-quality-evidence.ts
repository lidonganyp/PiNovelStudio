/**
 * ChapterQualityEvidence — 章节质量证据（QUALITY-3 最小闭环）
 *
 * 本文件只实现 structuralEvidence 相关类型/字段，不铺开全部 ChapterQualityEvidence。
 *
 * 设计原则（任务规格 QUALITY-3）：
 * - 不是质量总分，不是 gate，不自动改正文，不触发语言润色，不生成候选正文。
 * - 每条 evidence 只能提供 span、证据、置信度、读者影响和建议 owner。
 * - 证据不足时 human_review，禁止猜测"通过"。
 * - source span 缺失时 evidence 不得进入 satisfied。
 * - 不含 aggregateQualityScore / totalScore 等任何聚合总分字段。
 *
 * 复用资产（A-E 分类见历史任务清单，文档已删除）：
 * - A：TextSpan（v2/core/types.ts:295）直接复用，不新建 span 类型。
 * - B：ChapterIntent 字段作为 expectedRef 来源。
 * - C：judge-types.ts span 边界校验思路参考。
 * - E（禁止继承）：Diagnostic.suggestedRepair（rewrite kind）、DimensionScores 总分、
 *   HARD_BLOCK_PROVIDERS 白名单、配额/硬门权限。
 */

import type { TextSpan } from "./types.js";

// ============================================================================
// structuralEvidence 数据契约（最小集）
// ============================================================================

/**
 * 结构证据维度（QUALITY-3 最小覆盖 5 维）。
 *
 * 映射关系（D 类 legacy 概念借用，不直接复用 DAG 耦合的 extractor）：
 * - chapter_function_delivery ← StructuralLock.mustPreserveFacts（本章功能是否落地）
 * - goal_resistance_choice_result ← StructuralLock.requiredProtagonistActions
 *   （目标—阻力—选择—结果是否形成因果链）
 * - irreversible_change ← StructuralLock.mustPreserveFacts 中的状态变化子集
 * - five_axis_progression ← 情节/信息/角色/世界/因果五维 delta
 * - end_pressure_causality ← StructuralLock.sceneOutcome.requiredEffects
 *   （章末压力是否由本章结果自然推出）
 */
export type StructuralDimension =
  | "chapter_function_delivery"
  | "goal_resistance_choice_result"
  | "irreversible_change"
  | "five_axis_progression"
  | "end_pressure_causality";

/**
 * 结构证据状态。
 *
 * 语义：
 * - satisfied：有明确 sourceSpans 证明该维度被有效交付（确定性 scanner 极少给出此状态，
 *   通常需要 LLM 判断；本地 scanner 只在非常明确的字面证据下使用）。
 * - partial：有部分 span 证据，但不足以证明完整交付。
 * - contradicted：正文与 expectedRef 明确冲突（如预期推进 A 但正文明确否定 A）。
 * - risk：存在结构风险信号（如文字流畅但无推进、章末压力缺失）。
 * - not_applicable：expectedRef 缺失或该维度对本章不适用（如 chapterFunction 未指定）。
 * - human_review：证据不足，无法确定性判断，需人工或 LLM 复核。禁止猜测 satisfied。
 */
export type StructuralEvidenceStatus =
  | "satisfied"
  | "partial"
  | "contradicted"
  | "risk"
  | "not_applicable"
  | "human_review";

/**
 * 结构证据严重度（advisory only，无 hard/fatal）。
 *
 * 与 DiagnosticSeverity 区别：
 * - DiagnosticSeverity 有 fatal/hard，可触发 HARD_BLOCK_PROVIDERS 白名单整章重写。
 * - StructuralEvidenceSeverity 只有 info/review/risk，纯建议，无任何控制权。
 * - 结构风险不触发语言润色、原地覆盖或候选生成。
 */
export type StructuralEvidenceSeverity = "info" | "review" | "risk";

/**
 * 单条结构证据（11 个必填字段）。
 *
 * 不变量：
 * - status=satisfied 时 sourceSpans 必须非空（source span 缺失时不得 satisfied）。
 * - sourceSpans 的 start/end 必须在 [0, finalText.length] 范围内，end > start。
 * - confidence ∈ [0, 1]：本地确定性 scanner 通常 0.3-0.6，不假装高置信。
 * - recommendedOwner 只建议归属（如 "human_review" / "craft_judge"），不强制。
 * - recommendedAction 只描述建议动作类型，不包含具体改文指令。
 */
export interface StructuralEvidence {
  /** 证据 id，格式 `structural:{dimension}:{index}` */
  id: string;
  /** 结构维度 */
  dimension: StructuralDimension;
  /** 证据状态 */
  status: StructuralEvidenceStatus;
  /**
   * 支撑该证据的正文 span 列表。
   * status=satisfied 时必须非空；status=human_review/not_applicable 时可为空。
   * span 的 start/end 基于 finalText 的字符偏移（与 TextSpan 一致）。
   */
  sourceSpans: TextSpan[];
  /**
   * 期望引用：从 ChapterIntent / Constitution / CompiledContext 派生的"本章应交付什么"。
   * 用于 trace 审计"我们期望验证什么"。可为空字符串（当 expectedRef 缺失时）。
   */
  expectedRef: string;
  /** 观察到的事实：scanner 在正文中实际找到的信号描述（不含改文建议）。 */
  observation: string;
  /** 读者影响：该结构状态对读者体验的潜在影响描述（advisory）。 */
  readerImpact: string;
  /** 严重度（advisory only，无控制权） */
  severity: StructuralEvidenceSeverity;
  /** 置信度 ∈ [0, 1]，本地确定性 scanner 通常较低 */
  confidence: number;
  /** 建议 owner：谁应该处理这条证据（advisory，不强制） */
  recommendedOwner: string;
  /** 建议动作类型描述（advisory，不含具体改文指令） */
  recommendedAction: string;
}

/**
 * 结构证据扫描结果。
 */
export interface StructuralEvidenceScanResult {
  /** 全部结构证据（按 dimension 顺序） */
  evidence: StructuralEvidence[];
  /** 被扫描的正文长度（finalText.length） */
  scannedTextLength: number;
  /** 被扫描的候选 id */
  scannedCandidateId: string;
  /** 是否跳过扫描（hardBlock/raw 生成失败路径） */
  skipped: boolean;
  /** 跳过原因（skipped=true 时必填） */
  skippedReason?: string;
}

/**
 * ChapterQualityEvidence 部分契约（QUALITY-3 只实现 structuralEvidence）。
 *
 * 后续任务可能扩展 languageEvidence / continuityEvidence / craftEvidence 等字段，
 * 但本任务只实现 structuralEvidence + structuralEvidenceMeta。
 *
 * 严格禁止：
 * - aggregateQualityScore / totalScore 等聚合总分字段；
 * - 任何触发改文/重写/候选生成的字段；
 * - 任何 gate/hard_block 权限字段。
 */
export interface ChapterQualityEvidence {
  structuralEvidence: StructuralEvidence[];
  structuralEvidenceMeta: {
    skipped: boolean;
    skippedReason?: string;
    scannedCandidateId: string;
    scannedTextLength: number;
    /** 扫描时间戳（ms），供 trace 审计 */
    scannedAt: number;
  };
}

// ============================================================================
// 不变量校验（供 scanner 自检 + 测试断言）
// ============================================================================

/**
 * 校验单条 StructuralEvidence 不变量。
 *
 * 规则：
 * - status=satisfied 时 sourceSpans 必须非空（source span 缺失时不得 satisfied）。
 * - sourceSpans 的 start/end 必须 >=0 且 end>start 且 end<=maxLen。
 * - confidence ∈ [0, 1]。
 * - severity 不得为 fatal/hard（本类型无此值，但防御性校验）。
 *
 * @returns 校验通过返回 null，失败返回错误描述。
 */
export function validateStructuralEvidence(
  e: StructuralEvidence,
  maxLen: number
): string | null {
  if (!e.id || !e.dimension || !e.status) {
    return `evidence 缺少必填字段 id/dimension/status`;
  }
  if (e.status === "satisfied" && e.sourceSpans.length === 0) {
    return `status=satisfied 但 sourceSpans 为空（source span 缺失时不得 satisfied）`;
  }
  for (const span of e.sourceSpans) {
    if (
      typeof span.start !== "number" ||
      typeof span.end !== "number" ||
      span.start < 0 ||
      span.end <= span.start ||
      span.end > maxLen
    ) {
      return `span 越界或非法：start=${span.start}, end=${span.end}, maxLen=${maxLen}`;
    }
  }
  if (typeof e.confidence !== "number" || e.confidence < 0 || e.confidence > 1) {
    return `confidence 越界：${e.confidence}`;
  }
  return null;
}

/**
 * 构造 skipped 扫描结果（hardBlock/raw 生成失败路径用）。
 */
export function skippedStructuralEvidenceScan(
  candidateId: string | "",
  reason: string
): StructuralEvidenceScanResult {
  return {
    evidence: [],
    scannedTextLength: 0,
    scannedCandidateId: candidateId,
    skipped: true,
    skippedReason: reason,
  };
}
