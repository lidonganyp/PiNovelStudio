/**
 * Feedback Evidence Contracts — 用户反馈证据管道契约（USER-FEEDBACK-EVIDENCE-PIPELINE-1）
 *
 * 真相源：docs/user-feedback-evidence-pipeline-development-plan.md
 *
 * 本模块只定义规范化类型、常量与纯函数边界：
 * - 反馈不得直接充当奖励函数
 * - 反馈只影响下一次请求的策略采样概率
 * - 无法归因默认 neutral / quarantine
 * - 多策略协作默认按 strategyBundle 学习
 * - 文学负反馈不得自动 retired；退役必须离线复核 + 人工审批
 */

// ============================================================================
// Feedback levels
// ============================================================================

/** 七级反馈语义（计划 §5.2） */
export type FeedbackLevel =
  | "explicit_direct"
  | "explicit_edit"
  | "proxy_confirmed"
  | "implicit_accept"
  | "natural_language_unattributed"
  | "mechanical_signal"
  | "conflicted_or_revoked";

/** 归因置信度 */
export type AttributionConfidence = "high" | "medium" | "low" | "none";

/** 修改范围 */
export type EditScope = "token" | "sentence" | "paragraph" | "scene" | "chapter";

/**
 * 修改类型（计划 §5.3）。
 * fact / setting_completion / plot_direction 不直接惩罚文学策略。
 */
export type EditType =
  | "typo"
  | "language"
  | "voice"
  | "motivation"
  | "structure"
  | "fact"
  | "setting_completion"
  | "plot_direction";

/** 交付来源 */
export type DeliveredSource = "editorial" | "raw" | "fallback";

/** 证据 outcome */
export type FeedbackOutcome = "win" | "loss" | "tie" | "neutral";

/** 账本事件类型（追加式，永不改写观察） */
export type EvidenceLedgerEventType =
  | "observation"
  | "revoke"
  | "quarantine"
  | "pollute"
  | "resolve_conflict";

// ============================================================================
// Strategy exposure / lineage
// ============================================================================

/**
 * 策略暴露快照（计划 §5.1）。
 * 统一生成/编辑阶段在 trace 中记录，反馈必须能回溯到此快照。
 */
export interface StrategyExposure {
  exposureId: string;
  orchestratorRunId: string;
  sourceChapter: string;
  modelVersion: string;
  promptBundleId: string;
  candidateId: string;
  deliveredSource: DeliveredSource;
  strategyBundleId: string;
  strategyIds: string[];
  createdAt: string;
}

/** 反馈证据必须关联的血缘字段 */
export interface FeedbackLineage {
  orchestratorRunId: string;
  candidateId: string;
  strategyBundleId: string;
  /** 仅在单策略因果成立时填写 */
  strategyId?: string;
  modelVersion: string;
  promptBundleId: string;
  deliveredSource: DeliveredSource;
  exposureId: string;
  feedbackEventId: string;
  sourceChapter: string;
}

// ============================================================================
// Edit classification
// ============================================================================

export interface EditClassification {
  editScope: EditScope;
  editType: EditType;
  attributionConfidence: AttributionConfidence;
  /** 是否事实问题（不惩罚文学策略） */
  factIssue: boolean;
  /** 是否补设定（不惩罚文学策略） */
  settingCompletion: boolean;
  /** 是否保留了策略核心效果 */
  retainedCoreEffect: boolean;
  /** 真实独立用户决策数；单次修改恒为 1 */
  decisionCount: 1;
  /** 用于置信度统计的加权量，不等于样本数 */
  weightedEvidence: number;
}

// ============================================================================
// Feedback attribution decision
// ============================================================================

export interface FeedbackAttributionDecision {
  feedbackLevel: FeedbackLevel;
  outcome: FeedbackOutcome;
  /** 是否可写入文学策略信誉 */
  updatesLiteraryReputation: boolean;
  attributionConfidence: AttributionConfidence;
  decisionCount: number;
  weightedEvidence: number;
  /** 学习目标：bundle 优先；单策略仅在因果成立时 */
  learningTarget: "bundle" | "strategy" | "none";
  strategyBundleId?: string;
  strategyId?: string;
  reason: string;
  editClassification?: EditClassification;
}

// ============================================================================
// Ledger event / observation
// ============================================================================

export interface FeedbackEvidenceObservation {
  eventType: "observation";
  evidenceId: string;
  feedbackLevel: FeedbackLevel;
  outcome: FeedbackOutcome;
  decisionCount: number;
  weightedEvidence: number;
  attributionConfidence: AttributionConfidence;
  lineage: FeedbackLineage;
  strategyBundleId: string;
  strategyIds: string[];
  /** 仅单策略因果成立时填写 */
  strategyId?: string;
  modelVersion: string;
  sourceChapter: string;
  source: "user" | "judge" | "proxy" | "mechanical";
  timestamp: string;
  note?: string;
  /** 事实/设定类问题标记（不进文学信誉） */
  nonLiteraryCategory?: "fact" | "setting_completion" | "plot_direction" | "context";
}

export interface FeedbackEvidenceMutationEvent {
  eventType: Exclude<EvidenceLedgerEventType, "observation">;
  eventId: string;
  /** 关联的原始 evidenceId */
  targetEvidenceId: string;
  reason: string;
  timestamp: string;
  resolution?: string;
}

export type FeedbackEvidenceLedgerEvent =
  | FeedbackEvidenceObservation
  | FeedbackEvidenceMutationEvent;

// ============================================================================
// Safety boundary constants
// ============================================================================

/** 同一用户/章节/工作区反馈上限（计划 Phase 5） */
export const MAX_FEEDBACK_EVENTS_PER_CHAPTER = 20;
export const MAX_FEEDBACK_EVENTS_PER_USER_PER_DAY = 50;
export const MAX_FEEDBACK_EVENTS_PER_WORKSPACE_PER_HOUR = 200;

/** 文学负反馈可触发的在线动作（不得含 retired） */
export type OnlineLiteraryFeedbackAction =
  | "observe"
  | "downweight_next_request"
  | "pause_exploration_suggestion";

/** 生产硬边界：反馈禁止修改的目标 */
export const FEEDBACK_FORBIDDEN_MUTATIONS = [
  "current_request_text",
  "chapter_final_text",
  "creative_constitution",
  "narrative_state",
  "fact_guard",
  "prompt_bundle",
  "model_routing",
  "hard_gate",
  "chapter_commit_status",
  "production_baseline",
  "security_boundary",
  "system_policy",
] as const;

export type FeedbackForbiddenMutation = (typeof FEEDBACK_FORBIDDEN_MUTATIONS)[number];

/**
 * 反馈信任分类（PROMPT-INJECTION-TRUST-ARCHITECTURE-1 Phase 5）。
 * 与 v2/core/trust/authority-matrix 对齐，避免学习层循环依赖时重复实现核心语义。
 */
export type FeedbackTrustCategory =
  | "literary_preference"
  | "context_correction"
  | "fact_correction"
  | "workflow_preference"
  | "security_sensitive_request";

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * 反馈时序不变量：反馈只能影响后续请求，不能改当前请求/正文。
 */
export function assertFeedbackAffectsNextRequestOnly(
  mutationTargets: readonly string[],
): { ok: true } | { ok: false; violations: string[] } {
  const violations = mutationTargets.filter((target) =>
    (FEEDBACK_FORBIDDEN_MUTATIONS as readonly string[]).includes(target),
  );
  if (violations.length > 0) {
    return { ok: false, violations };
  }
  return { ok: true };
}

/**
 * 分类用户反馈信任类别。
 * 安全敏感请求（关闭 FactGuard、绕过审批、改安全边界）必须拒绝。
 */
export function classifyUserFeedbackTrustCategory(
  text: string,
  hints?: {
    isFactCorrection?: boolean;
    isContextCorrection?: boolean;
    isWorkflowPreference?: boolean;
  },
): FeedbackTrustCategory {
  const normalized = (text ?? "").trim();
  if (!normalized) return "literary_preference";

  const securityPatterns = [
    /关闭\s*FactGuard/i,
    /disable\s*fact\s*guard/i,
    /跳过\s*审批/,
    /bypass\s*approval/i,
    /忽略\s*(系统|之前|以上)?\s*规则/,
    /ignore\s*(all\s*)?(previous|prior|system)\s*(rules|instructions)/i,
    /修改\s*安全\s*边界/,
    /改写\s*(系统|权限|路由)/,
    /override\s*(security|policy|routing)/i,
  ];
  for (const pattern of securityPatterns) {
    if (pattern.test(normalized)) return "security_sensitive_request";
  }

  if (hints?.isFactCorrection) return "fact_correction";
  if (hints?.isContextCorrection) return "context_correction";
  if (hints?.isWorkflowPreference) return "workflow_preference";
  if (/事实错误|设定冲突|时间线不对|人物已死|名字错了/.test(normalized)) {
    return "fact_correction";
  }
  if (/补充背景|上下文不足|漏了前章|需要重编上下文/.test(normalized)) {
    return "context_correction";
  }
  return "literary_preference";
}

/**
 * 安全敏感或越权反馈：不得关闭 FactGuard / 改安全边界。
 */
export function assertFeedbackCannotBypassSecurity(
  category: FeedbackTrustCategory,
  mutationTargets: readonly string[] = [],
): { ok: true } | { ok: false; reason: string } {
  if (category === "security_sensitive_request") {
    return {
      ok: false,
      reason: "安全敏感反馈已拒绝：不能关闭 FactGuard 或修改安全边界",
    };
  }
  const nextOnly = assertFeedbackAffectsNextRequestOnly(mutationTargets);
  if (!nextOnly.ok) {
    return {
      ok: false,
      reason: `反馈试图修改禁止目标：${nextOnly.violations.join(", ")}`,
    };
  }
  return { ok: true };
}

/**
 * 文学反馈不得自动 retired。
 * 事实安全事故由独立熔断路径处理，不经本函数。
 */
export function literaryFeedbackAllowedOnlineActions(
  outcome: FeedbackOutcome,
): OnlineLiteraryFeedbackAction[] {
  if (outcome === "loss") {
    return ["observe", "downweight_next_request", "pause_exploration_suggestion"];
  }
  if (outcome === "win") {
    return ["observe"];
  }
  return ["observe"];
}

/**
 * 判断修改类型是否应惩罚文学策略。
 * fact / setting_completion / plot_direction → 否。
 */
export function isLiteraryStrategyPenaltyEdit(editType: EditType): boolean {
  return (
    editType === "voice" ||
    editType === "motivation" ||
    editType === "structure" ||
    editType === "language"
  );
}

/**
 * 判断 feedback level 是否默认可更新文学信誉。
 */
export function feedbackLevelUpdatesLiteraryReputation(
  level: FeedbackLevel,
): boolean {
  return (
    level === "explicit_direct" ||
    level === "explicit_edit" ||
    level === "proxy_confirmed"
  );
}

/**
 * 缺少完整血缘时，代理反馈不得按 proxy_confirmed 强更新。
 */
export function isCompleteLineage(lineage: Partial<FeedbackLineage> | null | undefined): boolean {
  if (!lineage) return false;
  return (
    typeof lineage.orchestratorRunId === "string" &&
    lineage.orchestratorRunId.trim().length > 0 &&
    typeof lineage.candidateId === "string" &&
    lineage.candidateId.trim().length > 0 &&
    typeof lineage.strategyBundleId === "string" &&
    lineage.strategyBundleId.trim().length > 0 &&
    typeof lineage.modelVersion === "string" &&
    lineage.modelVersion.trim().length > 0 &&
    typeof lineage.promptBundleId === "string" &&
    lineage.promptBundleId.trim().length > 0 &&
    typeof lineage.exposureId === "string" &&
    lineage.exposureId.trim().length > 0 &&
    typeof lineage.feedbackEventId === "string" &&
    lineage.feedbackEventId.trim().length > 0 &&
    typeof lineage.sourceChapter === "string" &&
    lineage.sourceChapter.trim().length > 0 &&
    (lineage.deliveredSource === "editorial" ||
      lineage.deliveredSource === "raw" ||
      lineage.deliveredSource === "fallback")
  );
}

/**
 * 生成策略 bundle id（确定性，便于测试与去重）。
 * 多策略时按排序后的 strategyIds 拼接；单策略时仍生成 bundle id。
 */
export function buildStrategyBundleId(strategyIds: readonly string[]): string {
  const normalized = [...new Set(strategyIds.filter((id) => typeof id === "string" && id.length > 0))]
    .map((id) => id.trim())
    .filter(Boolean)
    .sort();
  if (normalized.length === 0) return "bundle:empty";
  return `bundle:${normalized.join("+")}`;
}

/**
 * 是否允许写入单策略 evidence（计划 §Phase 3）。
 * 默认只有 bundle 内策略数 == 1，或显式单策略因果实验时允许。
 */
export function allowsSingleStrategyEvidence(input: {
  strategyIds: readonly string[];
  ablationExperiment?: boolean;
  randomSplit?: boolean;
  explicitSingleStrategyExposure?: boolean;
}): boolean {
  if (input.strategyIds.length <= 1) return true;
  return (
    input.ablationExperiment === true ||
    input.randomSplit === true ||
    input.explicitSingleStrategyExposure === true
  );
}
