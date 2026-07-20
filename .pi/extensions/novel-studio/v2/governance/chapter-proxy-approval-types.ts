/**
 * ChapterProxyApprovalTypes — 正式章节代理审批类型定义（EVOLUTION-RELEASE-GOVERNANCE-G7）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 / §7 / Phase G7
 *
 * 定义 gpt5.6-sol 在正式使用阶段对单章候选执行匿名代理审批的 artifact schema 常量、
 * verdict 枚举与类型。本模块只定义类型与常量，不含校验逻辑（校验在
 * chapter-proxy-approval-schema.ts）。
 *
 * 与 ReleaseProxyApproval（1B）的隔离原则：
 * - 必须使用独立 schemaId（"pinovel.chapter-proxy-approval"），不复用 release 级 schemaId；
 * - verdict 枚举为 PROXY_APPROVED | HOLD_FOR_REGENERATION，不复用 release 级
 *   APPROVE_DEV/HOLD/REJECT/QUARANTINE（章节级不判定 release 晋级，只产出代理审批稿）；
 * - 禁止用单章胜负直接证明系统版本晋级，也禁止用 release 审批替代逐章内容审批。
 *
 * 设计原则（计划 §6.3）：
 * - reviewerType 必须为 "validated_human_proxy"，永远不得为 "natural_person"；
 * - reviewerModel 必须为 "gpt5.6-sol"（与 release 审批共用同一代理模型）；
 * - 匿名映射必须同时记录 forward/reverse 顺序，便于反向复判一致性校验；
 * - finalStatus 为 PROXY_APPROVED 时必须 forward/reverse 一致；
 * - 代理不得直接提交长期状态或覆盖正式章节文件（本模块仅定义 artifact，不写章节）。
 *
 * 边界（READY_LOCAL；真实模型调用 REQUIRES_AUTH）：
 * - 不调用模型、不写文件、不依赖 eval 模块
 * - 仅定义类型与常量，可被 dist-test/ / dist/ / dist-eval/ 任意闭包消费
 * - G7 阶段使用 stub caller（不调用真实 gpt5.6-sol）
 */

// ============================================================================
// Schema 常量
// ============================================================================

/**
 * ChapterProxyApproval schemaId。
 * 必须与 ReleaseProxyApproval 的 "pinovel.release-proxy-approval" 不同，
 * 防止章节级审批 artifact 与 release 级审批 artifact 互相覆盖或误用。
 */
export const CHAPTER_PROXY_APPROVAL_SCHEMA_ID = "pinovel.chapter-proxy-approval" as const;

export const CHAPTER_PROXY_APPROVAL_SCHEMA_VERSION = 1 as const;

// ============================================================================
// Verdict / Status 枚举
// ============================================================================

/**
 * 章节代理审批最终状态（计划 §6.3）：
 * - PROXY_APPROVED：候选明确胜出，输出一份 proxy_approved_draft 提交给用户定稿；
 * - HOLD_FOR_REGENERATION：结论不清、顺序敏感或所有候选有明显问题，
 *   不得把多个候选直接转交用户评选，要求重新生成。
 *
 * 与 release 审批 verdict（APPROVE_DEV/HOLD/REJECT/QUARANTINE）刻意不同：
 * 章节级不判定系统版本是否晋级，只产出可交付用户的代理审批稿。
 */
export type ChapterProxyApprovalStatus = "PROXY_APPROVED" | "HOLD_FOR_REGENERATION";

/**
 * 原始（未归一化）verdict 集合。包含模型可能输出的非正式 verdict，
 * 由 normalizeChapterVerdict 映射为 ChapterProxyApprovalStatus。
 *
 * slight/uncertain/顺序敏感/冲突 一律映射为 HOLD_FOR_REGENERATION（保守）。
 */
export type RawChapterVerdict =
  | ChapterProxyApprovalStatus
  | "slight_win"
  | "uncertain"
  | "order_sensitive"
  | "conflict"
  | "maybe"
  | "unknown"
  | "reject"
  | "";

// ============================================================================
// Reviewer 身份
// ============================================================================

/**
 * 审批者类型。gpt5.6-sol 必须记为 "validated_human_proxy"，永远不得为 "natural_person"。
 * 这条约束防止把模型审批伪装成自然人审批。
 */
export type ChapterReviewerType = "validated_human_proxy";

/** 章节代理审批专用模型（与 release 审批共用同一 gpt5.6-sol）。 */
export const CHAPTER_PROXY_APPROVAL_REVIEWER_MODEL = "gpt5.6-sol" as const;

// ============================================================================
// 推荐候选来源
// ============================================================================

/**
 * recommendedCandidateId 的来源类型：
 * - "raw"：raw 候选胜出（代理审批稿可以是 raw，但必须记录原因）；
 * - "editorial"：editorial 候选胜出；
 * - "system_selected"：系统选定稿（仅在 raw/其他 eligible 候选都未明确胜出时使用）。
 */
export type RecommendedSource = "raw" | "editorial" | "system_selected";

// ============================================================================
// 匿名映射
// ============================================================================

/**
 * 候选 ID 到匿名标签的双向映射。
 * - forward：正向顺序（A vs B）
 * - reverse：反向顺序（A/B 标签互换，对应同一对候选）
 * - seed：匿名标签分配随机种子，便于复现
 * - candidateKinds：候选 ID → kind 映射（raw/editorial/system_selected），
 *   供 real caller 反推 recommendedSource；不进入匿名 packet（packet 保持匿名）。
 *   schema 校验允许该字段缺失（向后兼容 stub caller 路径）。
 *
 * 反向顺序的 A/B 标签对应候选与正向相反，使 gpt5.6-sol 无法通过标签稳定推断候选身份。
 */
export interface AnonymousMapping {
  forward: { A: string; B: string };
  reverse: { A: string; B: string };
  seed: number;
  /** 候选 ID → kind 映射；real caller 用此反推 recommendedSource；不进入匿名 packet */
  candidateKinds?: { [candidateId: string]: RecommendedSource };
}

// ============================================================================
// Approval Artifact
// ============================================================================

/**
 * ChapterProxyApproval artifact。
 * 一个 artifact 表示一次 gpt5.6-sol 章节代理审批的完整可审计记录。
 * 写入后不可修改（registry append-only，同 approvalId 拒绝覆盖）。
 *
 * 计划 §6.3 至少记录：
 * - releaseId、workspace、chapterId、candidateIds；
 * - 匿名映射与正反顺序 verdict；
 * - recommendedCandidateId 和 recommendedSource；
 * - winning/losing spans、风险、rationale；
 * - reviewerModel/version、prompt hash、输入 artifact hash；
 * - status=PROXY_APPROVED | HOLD_FOR_REGENERATION。
 */
export interface ChapterProxyApprovalArtifact {
  schemaId: typeof CHAPTER_PROXY_APPROVAL_SCHEMA_ID;
  schemaVersion: typeof CHAPTER_PROXY_APPROVAL_SCHEMA_VERSION;
  /** 全局唯一审批 ID；同 approvalId 重复写入被 registry 拒绝 */
  approvalId: string;
  /** 关联的 release ID（用于 release 健康度归集） */
  releaseId: string;
  /** workspace ID */
  workspaceId: string;
  /** 章节 ID */
  chapterId: string;
  /** 参与匿名审批的候选 ID 列表（至少包含 raw 与系统选定稿） */
  candidateIds: string[];
  /** 候选 ID → 匿名标签双向映射（forward/reverse 顺序） */
  anonymousMapping: AnonymousMapping;
  /** 正向顺序 verdict（A vs B） */
  forwardVerdict: ChapterProxyApprovalStatus;
  /** 反向顺序 verdict（A/B 标签互换） */
  reverseVerdict: ChapterProxyApprovalStatus;
  /** 归一化最终状态；forward≠reverse 时必须为 HOLD_FOR_REGENERATION */
  finalStatus: ChapterProxyApprovalStatus;
  /** 代理推荐的候选 ID */
  recommendedCandidateId: string;
  /** 推荐候选来源（raw/editorial/system_selected） */
  recommendedSource: RecommendedSource;
  /** 候选胜出 span 引用（来自匿名审批包 spans，不暴露候选身份） */
  winningSpans: string[];
  /** 失分 span 引用 */
  losingSpans: string[];
  /** 风险声明 */
  risks: string[];
  /** 审批理由（gpt5.6-sol 输出） */
  rationale: string;
  /** 必须为 "validated_human_proxy"；"natural_person" 一律拒绝 */
  reviewerType: ChapterReviewerType;
  /** 必须为 "gpt5.6-sol" */
  reviewerModel: string;
  /** 精确模型版本（如 "gpt5.6-sol-2026-07"）；不得为空 */
  reviewerModelVersion: string;
  /** 审批 prompt hash */
  promptHash: string;
  /** 输入审批包 hash（匿名 A/B packet 的 hash） */
  inputArtifactHash: string;
  /** 决定时间戳；非行为字段，不参与 artifact hash */
  decidedAt: string;
  /** 实际消耗预算（forward + reverse = 2 calls） */
  budgetUsed: { calls: number; timeoutMs: number };
}

// ============================================================================
// 校验错误类型
// ============================================================================

export interface ChapterApprovalValidationError {
  code:
    | "unknown_schema"
    | "schema_version_mismatch"
    | "missing_field"
    | "invalid_field_value"
    | "empty_field"
    | "invalid_status"
    | "invalid_verdict"
    | "invalid_reviewer_type"
    | "invalid_reviewer_model"
    | "forward_reverse_mismatch"
    // G7-P0-ARTIFACT-INTEGRITY-1 安全校验
    | "proxy_approved_requires_both_approve"
    | "recommended_candidate_not_in_list"
    | "invalid_anonymous_mapping"
    | "anonymous_mapping_candidate_not_in_list"
    | "anonymous_mapping_not_reversed"
    | "not_object";
  path: string;
  message: string;
}
