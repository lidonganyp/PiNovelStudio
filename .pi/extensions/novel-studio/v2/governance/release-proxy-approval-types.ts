/**
 * ReleaseProxyApprovalTypes — 系统版本代理审批类型定义（EVOLUTION-RELEASE-GOVERNANCE-1B）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6 / Phase G4
 *
 * 定义 gpt5.6-sol 开发期 release 代理审批 artifact 的 schema 常量、verdict 枚举与类型。
 * 本模块只定义类型与常量，不含校验逻辑（校验在 release-proxy-approval-schema.ts）。
 *
 * 设计原则：
 * - schemaId 固定为 "pinovel.release-proxy-approval"，schemaVersion=1
 * - reviewerType 必须为 "validated_human_proxy"，永远不得为 "natural_person"
 * - reviewerModel 必须为 "gpt5.6-sol"（开发期 release 审批专用）
 * - R3 治理根变更禁止代理自审批（r3SelfApproval=true 即非法）
 * - finalVerdict 只允许 APPROVE_DEV / HOLD / REJECT / QUARANTINE
 *
 * 边界（READY_LOCAL；真实模型调用 REQUIRES_AUTH）：
 * - 不调用模型、不写文件、不依赖 eval 模块
 * - 仅定义类型与常量，可被 dist-test/ / dist/ / dist-eval/ 任意闭包消费
 * - 1B 阶段使用 stub caller（不调用真实 gpt5.6-sol）
 */

// ============================================================================
// Schema 常量
// ============================================================================

export const PROXY_APPROVAL_SCHEMA_ID = "pinovel.release-proxy-approval" as const;
export const PROXY_APPROVAL_SCHEMA_VERSION = 1 as const;

/** 审批包 schemaId（匿名 A/B 输入包，与 artifact 分离） */
export const PROXY_APPROVAL_PACKET_SCHEMA_ID = "pinovel.release-proxy-approval-packet" as const;
export const PROXY_APPROVAL_PACKET_SCHEMA_VERSION = 1 as const;

// ============================================================================
// Verdict 枚举
// ============================================================================

/**
 * 代理审批最终 verdict（计划 §6.2）：
 * - APPROVE_DEV：候选整体明确胜出且无 veto，可晋级 active_dev
 * - HOLD：证据不足 / 胜负不清 / 不同作品方向不一致 / 成本权衡不明确
 * - REJECT：候选整体退化
 * - QUARANTINE：数据污染 / 身份泄露 / provenance 不一致 / 协议违规
 *
 * slight / uncertain / 顺序敏感 / 评审轮冲突一律映射为 HOLD。
 */
export type ProxyApprovalVerdict = "APPROVE_DEV" | "HOLD" | "REJECT" | "QUARANTINE";

/**
 * 原始（未归一化）verdict 集合。包含模型可能输出的非正式 verdict，
 * 由 normalizeVerdict 映射到 ProxyApprovalVerdict。
 */
export type RawVerdict =
  | ProxyApprovalVerdict
  | "SLIGHT_WIN"
  | "uncertain"
  | "order_sensitive"
  | "conflict"
  | "maybe"
  | "unknown"
  | "";

// ============================================================================
// Reviewer 身份
// ============================================================================

/**
 * 审批者类型。gpt5.6-sol 必须记为 "validated_human_proxy"，永远不得为 "natural_person"。
 * 这条约束防止把模型审批伪装成自然人审批。
 */
export type ReviewerType = "validated_human_proxy";

/** 开发期 release 审批专用模型。 */
export const PROXY_APPROVAL_REVIEWER_MODEL = "gpt5.6-sol" as const;

// ============================================================================
// Approval Artifact
// ============================================================================

/**
 * ReleaseProxyApproval artifact。
 * 一个 artifact 表示一次 gpt5.6-sol 代理审批的完整可审计记录。
 * 写入后不可修改（registry append-only，同 approvalId 拒绝覆盖）。
 */
export interface ReleaseProxyApprovalArtifact {
  schemaId: typeof PROXY_APPROVAL_SCHEMA_ID;
  schemaVersion: typeof PROXY_APPROVAL_SCHEMA_VERSION;
  /** 全局唯一审批 ID；同 approvalId 重复写入被 registry 拒绝 */
  approvalId: string;
  /** 被审批的 release ID */
  releaseId: string;
  /** 被审批的 release manifest 规范化 hash；与审批 artifact 双向绑定 */
  releaseManifestHash: string;
  /** 必须为 "validated_human_proxy"；"natural_person" 一律拒绝 */
  reviewerType: ReviewerType;
  /** 必须为 "gpt5.6-sol" */
  reviewerModel: string;
  /** 精确模型版本（如 "gpt5.6-sol-2026-07"）；不得为空 */
  reviewerModelVersion: string;
  /** Actual transport used by the reviewer. Missing legacy values are never production-eligible. */
  reviewTransport?: "stub" | "network";
  /** 审批 prompt hash */
  promptHash: string;
  /** 输入审批包 hash（匿名 A/B packet 的 hash） */
  inputArtifactHash: string;
  /** 正向顺序 verdict（A=候选 B=当前） */
  forwardVerdict: ProxyApprovalVerdict;
  /** 反向顺序 verdict（A=当前 B=候选） */
  reverseVerdict: ProxyApprovalVerdict;
  /** 归一化最终 verdict；forward/reverse 不一致或 slight/uncertain 一律为 HOLD */
  finalVerdict: ProxyApprovalVerdict;
  /** 候选胜出 span 引用（来自审批包匿名 spans） */
  winningSpans: string[];
  /** 当前版本失分 span 引用 */
  losingSpans: string[];
  /** 风险声明 */
  risks: string[];
  /** 审批理由（gpt5.6-sol 输出） */
  rationale: string;
  /** 决定时间戳；非行为字段，不参与 artifact hash */
  decidedAt: string;
  /** 实际消耗预算（forward + reverse = 2 calls） */
  budgetUsed: { calls: number; timeoutMs: number };
  /** release 变更风险分级（R0-R3） */
  changeClass: "R0" | "R1" | "R2" | "R3";
  /**
   * R3 自审批标记。R3 治理根变更必须由用户审批，不得由代理自审批。
   * r3SelfApproval=true 即非法，validateApprovalArtifact 一律拒绝。
   */
  r3SelfApproval: boolean;
}

// ============================================================================
// 校验错误类型
// ============================================================================

export interface ApprovalValidationError {
  code:
    | "unknown_schema"
    | "schema_version_mismatch"
    | "missing_field"
    | "invalid_field_value"
    | "empty_field"
    | "invalid_verdict"
    | "invalid_reviewer_type"
    | "invalid_reviewer_model"
    | "r3_self_approval_forbidden"
    | "not_object";
  path: string;
  message: string;
}

// ============================================================================
// 匿名审批包类型（approval-packet-builder.ts 用）
// ============================================================================

/** 匿名 span：side 只允许 "A" 或 "B"，不暴露 candidate/current 身份 */
export interface AnonymousSpan {
  id: string;
  text: string;
  side: "A" | "B";
}

/** 正反顺序单侧包 */
export interface AnonymousPacketSide {
  labelA: "A";
  labelB: "B";
  textA: string;
  textB: string;
  spans: AnonymousSpan[];
}

/** 唯一变量声明：只记录是否存在，不暴露具体变量名/实现名称 */
export interface UniqueVariableDeclaration {
  hasUniqueVariable: boolean;
  /** 不暴露具体变量值；始终为 undefined */
  value?: undefined;
}

/** 审批包输入（候选侧数据，由调用方提供） */
export interface ApprovalPacketInput {
  releaseId: string;
  releaseManifestHash: string;
  changeClass: "R0" | "R1" | "R2" | "R3";
  /** 唯一变量名（实现名称）；只在 input 中存在，不会进入 packet */
  uniqueVariable: string;
  fixedCase: string;
  fixedModel: string;
  fixedSeed: number;
  budgetMaxCalls: number;
  timeoutMs: number;
  candidateText: string;
  currentApprovedText: string;
  rawBaselineText: string;
  factGuardReport: unknown;
  stateConsistency: unknown;
  costProfile: unknown;
  /** 生产 judge 结论；必须被匿名化，不进入 packet */
  systemJudgeConclusion?: string;
  /** 开发者预期；必须被匿名化，不进入 packet */
  developerExpectation?: string;
  candidateSpans: Array<{ id: string; text: string; side: "candidate" }>;
  currentSpans: Array<{ id: string; text: string; side: "current" }>;
}

/** 匿名审批包（gpt5.6-sol 输入） */
export interface AnonymousApprovalPacket {
  schemaId: typeof PROXY_APPROVAL_PACKET_SCHEMA_ID;
  schemaVersion: typeof PROXY_APPROVAL_PACKET_SCHEMA_VERSION;
  /** 正向顺序：A=候选 B=当前 */
  forward: AnonymousPacketSide;
  /** 反向顺序：A=当前 B=候选 */
  reverse: AnonymousPacketSide;
  rawBaseline: { text: string };
  fixedCase: string;
  fixedModel: string;
  fixedSeed: number;
  budgetMaxCalls: number;
  timeoutMs: number;
  factGuard: unknown;
  stateConsistency: unknown;
  costProfile: unknown;
  uniqueVariableDeclared: UniqueVariableDeclaration;
}
