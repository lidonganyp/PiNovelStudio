/**
 * CONTROL-TYPES — 自主性分级与授权控制面协议类型。
 *
 * 真相源：delete/任务列表/项目计划20260812-2.md §3 / §4-P0
 *
 * 两层授权模型：
 * 1. ExecutionCapabilityPolicy（既有 CapabilityPolicy）— 编排器/系统是否具备执行能力
 * 2. ModelAutonomyPolicy — 模型当前是否可自主请求或触发该动作
 *
 * 本模块只定义稳定协议类型，不含策略实现。
 * 禁止用 CapabilityPolicy 单独表达模型自主性。
 */

// ============================================================================
// Actor / Autonomy / Action
// ============================================================================

/** 四类 actor：模型、编排器、用户、系统 */
export type ActorType = "model" | "orchestrator" | "user" | "system";

/**
 * 五级自主性（统一主链路内的授权元数据，不是 generationMode，也不是新链路）。
 *
 * - observe：只读、分析、诊断
 * - suggest：提出方案，不产生副作用
 * - bounded_execute：在工具白名单、预算和资源范围内自动执行
 * - checkpoint：生成可恢复待审稿，不进入正式作品和长期状态
 * - commit：改变正式章节、NarrativeState、生产基线或外部资源
 */
export type AutonomyLevel =
  | "observe"
  | "suggest"
  | "bounded_execute"
  | "checkpoint"
  | "commit";

/**
 * 统一动作目录名称。
 * 每个动作有唯一名称与默认自主性等级（见 action-catalog.ts）。
 */
export type ActionName =
  | "workspace.read"
  | "retrieval.execute"
  | "draft.generate"
  | "editorial.optimize"
  | "repair.suggest"
  | "checkpoint.save"
  | "chapter.save"
  | "state.commit"
  | "release.promote"
  | "baseline.replace";

/** 自主性等级排序（数值越大权限越高） */
export const AUTONOMY_LEVEL_RANK: Readonly<Record<AutonomyLevel, number>> = {
  observe: 0,
  suggest: 1,
  bounded_execute: 2,
  checkpoint: 3,
  commit: 4,
};

// ============================================================================
// Authorization request / decision
// ============================================================================

/** 授权请求作用域 */
export interface AuthorizationScope {
  workspaceId: string;
  chapterId?: string;
  taskId?: string;
  batchJobId?: string;
  resources?: string[];
}

/**
 * 每次授权请求至少包含的字段。
 * 模型输出字段（confirm/approved/userConfirmed）不得进入本结构的可信判定。
 */
export interface AuthorizationRequest {
  taskId: string;
  workspaceId: string;
  chapterId?: string;
  action: ActionName;
  requestedLevel: AutonomyLevel;
  actor: ActorType;
  scope: AuthorizationScope;
  resource?: string;
  artifactHash?: string;
  revision?: string;
  approvalId?: string;
  /** 调用方说明，仅用于审计 */
  reason?: string;
}

/** 授权决策结果 */
export type AuthorizationResultCode =
  | "allowed"
  | "denied"
  | "approval_required"
  | "approval_expired"
  | "artifact_hash_mismatch"
  | "stale_revision"
  | "scope_mismatch"
  | "actor_forbidden"
  | "capability_denied"
  | "unknown_action"
  | "already_consumed"
  | "pending_required"
  | "checks_incomplete";

/**
 * 每次决策至少返回的字段。
 * allowed=false 时必须有 blockReason；traceId 用于控制审计串联。
 */
export interface AuthorizationDecision {
  allowed: boolean;
  effectiveLevel: AutonomyLevel;
  requiresApproval: boolean;
  reason: string;
  blockReason?: AuthorizationResultCode;
  consumed: boolean;
  traceId: string;
  result: AuthorizationResultCode;
  /** 决策时间 ISO */
  timestamp: string;
}

// ============================================================================
// Control decision audit record
// ============================================================================

/**
 * 统一控制决策记录（P6）。
 * 不记录原始思维链、隐藏推理或不必要的完整 prompt。
 */
export interface ControlDecisionRecord {
  timestamp: string;
  taskId: string;
  workspaceId: string;
  chapterId?: string;
  actor: ActorType;
  action: ActionName;
  capability?: string;
  requestedLevel: AutonomyLevel;
  effectiveLevel: AutonomyLevel;
  scope: AuthorizationScope;
  resource?: string;
  allowed: boolean;
  consumed: boolean;
  approvalId?: string;
  artifactHash?: string;
  revision?: string;
  result: AuthorizationResultCode;
  blockReason?: AuthorizationResultCode;
  reason: string;
  traceId: string;
}

/** FailureEnvelope.gate 扩展值 */
export type AutonomyFailureGate =
  | "autonomy"
  | "approval"
  | "commit_authorization";

/** 模型禁止持有的 commit 级动作 */
export const MODEL_FORBIDDEN_ACTIONS: ReadonlySet<ActionName> = new Set([
  "chapter.save",
  "state.commit",
  "release.promote",
  "baseline.replace",
]);

/** 模型默认可达的最高自主性等级 */
export const MODEL_MAX_AUTONOMY_LEVEL: AutonomyLevel = "bounded_execute";
