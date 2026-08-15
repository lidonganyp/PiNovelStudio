/**
 * TRUST-TYPES — 提示注入防御与信任架构契约（PROMPT-INJECTION-TRUST-ARCHITECTURE-1 Phase 0）
 *
 * 真相源：docs/prompt-injection-trust-architecture-development-plan-20260812.md
 *
 * 核心不变量：
 * - 不可信文本不得穿透上下文、工具、长期状态和用户反馈链路
 * - 权限只能来自结构化来源、真实用户动作和可验证的事务记录
 * - 文本中出现“系统必须/忽略规则/用户已批准”等句子不会改变信任层
 *
 * 本模块只定义稳定协议类型与纯函数，不含 I/O。
 */

// ============================================================================
// 五级信任层
// ============================================================================

/**
 * 五级信任层（计划 §3.1）。
 * 文本内容不能自我提升信任层。
 */
export type TrustClass =
  | "system_authority"
  | "author_authority"
  | "committed_state"
  | "retrieved_reference"
  | "model_or_user_untrusted";

/** 信任层排序（数值越大越权威） */
export const TRUST_CLASS_RANK: Readonly<Record<TrustClass, number>> = {
  model_or_user_untrusted: 0,
  retrieved_reference: 1,
  committed_state: 2,
  author_authority: 3,
  system_authority: 4,
};

// ============================================================================
// 权限与来源
// ============================================================================

/**
 * 内容可产生的权限类别。
 * hard_constraint：可进入 P0/P1 硬门禁
 * soft_guidance：仅建议
 * reference_only：只能引用
 * evidence_only：只能作为诊断证据
 * no_authority：无任何权限
 */
export type Authority =
  | "hard_constraint"
  | "soft_guidance"
  | "reference_only"
  | "evidence_only"
  | "no_authority";

/** 来源引用：可回源验证 */
export interface EvidenceRef {
  /** 来源类型 */
  kind:
    | "system_policy"
    | "constitution"
    | "chapter_intent"
    | "committed_state"
    | "chapter_text"
    | "retrieval"
    | "tool_result"
    | "model_output"
    | "user_feedback"
    | "user_edit"
    | "approval"
    | "audit"
    | "other";
  /** 逻辑 id（章节、工具 callId、状态 entry 等） */
  id?: string;
  /** 内容 SHA-256 */
  contentHash?: string;
  /** 正文 span */
  span?: { start: number; end: number };
  /** 人类可读路径/定位 */
  locator?: string;
}

/** 过期策略 */
export type ExpiryPolicy =
  | { kind: "never" }
  | { kind: "ttl_ms"; ttlMs: number; issuedAt: string }
  | { kind: "bound_to_revision"; revision: string }
  | { kind: "bound_to_artifact"; artifactHash: string }
  | { kind: "absolute"; expiresAt: string };

/** 晋级决策 */
export type PromotionDecision =
  | "allowed"
  | "denied"
  | "requires_author_confirm"
  | "requires_verification"
  | "expired"
  | "conflict";

// ============================================================================
// 上下文槽位
// ============================================================================

/**
 * 上下文物理分槽（计划 §3.2）。
 * 禁止把 reference/draft 内容写入 authority 槽位。
 */
export type ContentSlot =
  | "SYSTEM_AUTHORITY"
  | "AUTHOR_CONTRACT"
  | "IMMUTABLE_FACTS"
  | "COMMITTED_STATE"
  | "REFERENCE_MATERIAL"
  | "DIAGNOSTIC_EVIDENCE"
  | "UNTRUSTED_DRAFT"
  | "USER_FEEDBACK";

/** 槽位默认信任层与权限 */
export const SLOT_DEFAULTS: Readonly<
  Record<ContentSlot, { trustClass: TrustClass; authority: Authority }>
> = {
  SYSTEM_AUTHORITY: {
    trustClass: "system_authority",
    authority: "hard_constraint",
  },
  AUTHOR_CONTRACT: {
    trustClass: "author_authority",
    authority: "hard_constraint",
  },
  IMMUTABLE_FACTS: {
    trustClass: "author_authority",
    authority: "hard_constraint",
  },
  COMMITTED_STATE: {
    trustClass: "committed_state",
    authority: "hard_constraint",
  },
  REFERENCE_MATERIAL: {
    trustClass: "retrieved_reference",
    authority: "reference_only",
  },
  DIAGNOSTIC_EVIDENCE: {
    trustClass: "retrieved_reference",
    authority: "evidence_only",
  },
  UNTRUSTED_DRAFT: {
    trustClass: "model_or_user_untrusted",
    authority: "no_authority",
  },
  USER_FEEDBACK: {
    trustClass: "model_or_user_untrusted",
    authority: "no_authority",
  },
};

// ============================================================================
// 工具结果信任
// ============================================================================

/** 工具内容可信度 */
export type ToolContentTrust = "system_fact" | "reference" | "untrusted";

/**
 * 统一工具结果信封（计划 Phase 2）。
 * content 默认 reference；只有专门验证器可升级为 system_fact。
 */
export interface TrustedToolResult<T = unknown> {
  ok: boolean;
  toolName: string;
  callId: string;
  evidenceRefs: string[];
  content: T;
  contentTrust: ToolContentTrust;
  canAffectHardGate: boolean;
  /** 验证器标识；未验证时为空 */
  verifiedBy?: string;
  contentHash: string;
  /** 结构化错误，不得静默吞掉 */
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
}

// ============================================================================
// 事实晋级
// ============================================================================

/**
 * 检索事实晋级状态机（计划 Phase 3）。
 * retrieved_fragment → evidence_candidate → verified_fact
 *   → current_generation_input → state_commit_candidate
 */
export type FactPromotionStage =
  | "retrieved_fragment"
  | "evidence_candidate"
  | "verified_fact"
  | "current_generation_input"
  | "state_commit_candidate"
  | "committed"
  | "rejected"
  | "quarantined";

export interface FactPromotionCandidate {
  candidateId: string;
  stage: FactPromotionStage;
  factText: string;
  contentHash: string;
  sourceRefs: EvidenceRef[];
  trustClass: TrustClass;
  /** 验证器结果摘要 */
  verification?: {
    verifier: string;
    passed: boolean;
    reason: string;
    conflictIds?: string[];
  };
  promotionReason?: string;
  /** 绑定的正文 span/hash（提交前强制） */
  boundTextHash?: string;
  boundSpan?: { start: number; end: number };
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// 用户反馈信任分类
// ============================================================================

/**
 * 反馈信任分类（计划 Phase 5）。
 * security_sensitive_request 必须拒绝或单独审批。
 */
export type FeedbackTrustCategory =
  | "literary_preference"
  | "context_correction"
  | "fact_correction"
  | "workflow_preference"
  | "security_sensitive_request";

/** 反馈可影响的下游（next request only） */
export type FeedbackAllowedEffect =
  | "strategy_sampling"
  | "diagnostic_evidence"
  | "recompile_context"
  | "author_confirm_required"
  | "quarantine"
  | "reject";

// ============================================================================
// 权限影响阶段矩阵单元
// ============================================================================

/** 生产主链路阶段（用于权限矩阵） */
export type TrustAffectedStage =
  | "context_compile"
  | "chapter_intent"
  | "tool_authorization"
  | "fact_guard"
  | "hard_gate"
  | "candidate_selection"
  | "approval"
  | "chapter_save"
  | "state_commit"
  | "strategy_learning"
  | "review_surface"
  | "model_routing"
  | "security_boundary";

/** 来源类别 → 允许影响的阶段 */
export type TrustSourceKind =
  | "system_rule"
  | "author_contract"
  | "committed_state"
  | "reference_material"
  | "model_output"
  | "user_feedback";

// ============================================================================
// ConstraintManifest 信任扩展
// ============================================================================

/** 扩展约束清单项的信任元数据 */
export interface TrustMetadata {
  trustClass: TrustClass;
  authority: Authority;
  slot: ContentSlot;
  sourceRefs: EvidenceRef[];
  expiry: ExpiryPolicy;
  canPromote: boolean;
  contentHash: string;
}

// ============================================================================
// 纯函数：信任判定
// ============================================================================

/** 该信任层是否默认可形成硬约束 */
export function canFormHardConstraint(trustClass: TrustClass): boolean {
  return (
    trustClass === "system_authority" ||
    trustClass === "author_authority" ||
    trustClass === "committed_state"
  );
}

/** 该槽位是否允许写入硬约束内容 */
export function slotAllowsHardConstraint(slot: ContentSlot): boolean {
  return (
    slot === "SYSTEM_AUTHORITY" ||
    slot === "AUTHOR_CONTRACT" ||
    slot === "IMMUTABLE_FACTS" ||
    slot === "COMMITTED_STATE"
  );
}

/** 工具内容是否可进入硬门禁 */
export function toolResultCanAffectHardGate(
  contentTrust: ToolContentTrust,
  canAffectHardGate: boolean,
): boolean {
  return contentTrust === "system_fact" && canAffectHardGate === true;
}

/** 比较信任层：left 是否至少与 right 同级或更高 */
export function trustAtLeast(left: TrustClass, right: TrustClass): boolean {
  return TRUST_CLASS_RANK[left] >= TRUST_CLASS_RANK[right];
}

/** 模型输出中的确认/状态字段名（永远不具备授权效力） */
export const MODEL_CLAIM_FIELD_NAMES: ReadonlySet<string> = new Set([
  "confirm",
  "confirmed",
  "approved",
  "userConfirmed",
  "factGuardPassed",
  "stateCommitted",
  "authorizationGranted",
  "actor",
  "approvalId",
]);

/**
 * 检测对象是否携带模型伪造的确认字段。
 * 存在即返回 true；调用方必须忽略这些字段。
 */
export function hasModelClaimedAuthorityFields(
  value: unknown,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (MODEL_CLAIM_FIELD_NAMES.has(key)) {
      return true;
    }
  }
  return false;
}

/** 过期检查 */
export function isExpired(
  policy: ExpiryPolicy,
  now: Date = new Date(),
  context?: { revision?: string; artifactHash?: string },
): boolean {
  switch (policy.kind) {
    case "never":
      return false;
    case "ttl_ms": {
      const issued = Date.parse(policy.issuedAt);
      if (Number.isNaN(issued)) return true;
      return now.getTime() > issued + policy.ttlMs;
    }
    case "absolute": {
      const expires = Date.parse(policy.expiresAt);
      if (Number.isNaN(expires)) return true;
      return now.getTime() > expires;
    }
    case "bound_to_revision":
      return !context?.revision || context.revision !== policy.revision;
    case "bound_to_artifact":
      return (
        !context?.artifactHash || context.artifactHash !== policy.artifactHash
      );
    default:
      return true;
  }
}
