/**
 * AUDIT-EVENT-TYPES — 统一生产事件契约（Phase 0 冻结）
 *
 * 唯一生产事件模型。新代码不得再新增旧版 FailureEnvelope / Trajectory
 * 字段作为事实来源。本模块只定义类型与枚举，不含 I/O。
 *
 * 设计原则：
 * - 只记录可验证的输入、动作、证据、系统决策和用户决策
 * - 不记录模型思维链，不把模型自述当事实
 * - evidenceLevel 区分 observed / confirmed / derived / unavailable
 */

/** Schema 版本；破坏性变更必须递增 */
export const AUDIT_EVENT_SCHEMA_VERSION = "1.0.0" as const;

// ============================================================================
// ID 规则
// ============================================================================

/**
 * - traceId：一次可审计轨迹（可跨 run，如恢复后同一轨迹）
 * - runId：一次生成运行
 * - eventId：单个事件（全局唯一）
 * - sequence：同一 run 内严格递增（从 1 开始）
 */
export type TraceId = string;
export type RunId = string;
export type EventId = string;

// ============================================================================
// 枚举
// ============================================================================

/** 事件发起方 */
export type AuditActor =
  | "system"
  | "orchestrator"
  | "tool_runtime"
  | "model"
  | "user"
  | "recovery"
  | "governance";

/**
 * 生产主链路阶段（与 unified pipeline 对齐，可扩展但不得随意发明）。
 * 未识别阶段写 "unknown" 并在 decisionReason 说明。
 */
export type AuditStage =
  | "run"
  | "preflight"
  | "context_compile"
  | "intent"
  | "agentic"
  | "model_turn"
  | "tool"
  | "candidate"
  | "gate"
  | "repair"
  | "style_optimization"
  | "fact_guard"
  | "story_preservation"
  | "proxy_approval"
  | "user_revision"
  | "final_recheck"
  | "chapter_save"
  | "state_commit"
  | "final_submission"
  | "recovery"
  | "unknown";

/** 事件状态 */
export type AuditEventStatus =
  | "started"
  | "completed"
  | "failed"
  | "denied"
  | "timeout"
  | "interrupted"
  | "recovered"
  | "blocked"
  | "skipped"
  | "unknown";

/**
 * 证据等级：
 * - observed：系统直接观测到的运行事实
 * - confirmed：经二次校验确认（hash 匹配、gate 通过等）
 * - derived：派生指标，不能替代事实
 * - unavailable：应有但缺失
 */
export type EvidenceLevel =
  | "observed"
  | "confirmed"
  | "derived"
  | "unavailable";

/**
 * 能力域（capability isolation）。
 * 工具授权事件必须带 capability。
 */
export type AuditCapability =
  | "chapter_generation"
  | "retrieval"
  | "verification"
  | "patch"
  | "style_optimization"
  | "governance"
  | "state_commit"
  | "chapter_save"
  | "model_route"
  | "unknown";

/** 生产失败分类（与 failure-types.ts 对齐，禁止 soft/hard 作为生产值） */
export type AuditFailureClass =
  | "preflight"
  | "recoverable"
  | "interrupted"
  | "blocked"
  | "fatal";

/**
 * 统一事件类型字典。
 * 生命周期 / 上下文 / 模型 / 工具 / 候选门禁 / 保存提交 / 用户决策 / 恢复。
 */
export type AuditEventType =
  // run lifecycle
  | "run_started"
  | "run_finished"
  | "run_failed"
  | "run_interrupted"
  | "run_recovered"
  // context
  | "context_compile_started"
  | "context_compiled"
  | "context_compile_failed"
  // model turn
  | "model_turn_started"
  | "model_turn_completed"
  | "model_turn_failed"
  // tool
  | "tool_call_requested"
  | "tool_call_authorized"
  | "tool_call_denied"
  | "tool_call_started"
  | "tool_result_received"
  | "tool_call_timeout"
  | "tool_call_interrupted"
  // candidate & gates
  | "candidate_created"
  | "candidate_derived"
  | "gate_evaluated"
  | "candidate_blocked"
  | "repair_started"
  | "repair_completed"
  | "retry_scheduled"
  // run aggregate lifecycle (P1 冻结；业务模块不得私自扩展字段)
  | "stage_started"
  | "retry_reserved"
  | "approval_requested"
  | "commit_started"
  | "commit_failed"
  | "evidence_revoked"
  | "state_recomputed"
  | "compensation_started"
  // save & commit
  | "chapter_save_attempted"
  | "chapter_saved"
  | "chapter_save_failed"
  | "state_commit_attempted"
  | "state_committed"
  | "state_commit_failed"
  | "final_submission"
  // user decisions
  | "user_accepted"
  | "user_modified"
  | "user_rejected"
  | "user_rollback"
  // failure / recovery
  | "failure_recorded"
  | "checkpoint_saved"
  | "checkpoint_resumed"
  // generic extension point（仅在字典未覆盖时使用，须在 payload.eventTypeHint 说明）
  | "custom";

// ============================================================================
// 引用与脱敏
// ============================================================================

export interface AuditSourceRef {
  /** 来源类型 */
  kind:
    | "chapter"
    | "artifact"
    | "workspace_config"
    | "constitution"
    | "narrative_state"
    | "outline"
    | "seed"
    | "style_fingerprint"
    | "tool_result"
    | "candidate"
    | "other";
  /** 章节 / artifact / 配置键等标识 */
  id?: string;
  /** 内容 SHA-256（完整 hex） */
  contentHash?: string;
  /** 可选文本 span */
  span?: { start: number; end: number };
}

export interface AuditArtifactRef {
  /** artifacts/ 下相对路径或逻辑 id */
  artifactId: string;
  /** 内容类型 */
  kind:
    | "candidate_text"
    | "final_text"
    | "tool_result"
    | "blocked_evidence"
    | "prompt"
    | "context"
    | "review_package"
    | "other";
  /** 内容 SHA-256 */
  contentHash?: string;
  /** 字节大小（可选） */
  sizeBytes?: number;
}

export interface AuditRedaction {
  /** 是否已脱敏 */
  applied: boolean;
  /** 命中的脱敏规则 */
  rules?: Array<
    | "api_key"
    | "bearer_token"
    | "env_secret"
    | "think_block"
    | "system_prompt"
    | "unauthorized_tool_args"
    | "other"
  >;
  /** 脱敏字段路径 */
  fields?: string[];
}

// ============================================================================
// 统一事件信封
// ============================================================================

/**
 * 统一生产事件信封。
 * 所有生产事件必须具备 schemaVersion / traceId / runId / eventId /
 * sequence / timestamp / actor / stage / eventType / status / evidenceLevel。
 */
export interface AuditEvent {
  schemaVersion: typeof AUDIT_EVENT_SCHEMA_VERSION | string;
  traceId: TraceId;
  runId: RunId;
  eventId: EventId;
  /** 因果父事件；run_started 可为 null */
  parentEventId: EventId | null;
  /** 直接致因事件（重试指向失败、中断指向进行中调用等） */
  causedByEventId?: EventId | null;
  /** 同一 run 内严格递增，从 1 起 */
  sequence: number;
  /** Unix ms */
  timestamp: number;
  actor: AuditActor;
  stage: AuditStage;
  eventType: AuditEventType;
  status: AuditEventStatus;
  capability?: AuditCapability;
  requestedRoute?: string;
  actualProvider?: string;
  actualModel?: string;
  inputHash?: string;
  outputHash?: string;
  sourceRefs?: AuditSourceRef[];
  artifactRefs?: AuditArtifactRef[];
  decisionReason?: string;
  redaction?: AuditRedaction;
  /** 候选谱系 */
  candidateId?: string;
  parentCandidateId?: string;
  revision?: string;
  approvalId?: string;
  evidenceLevel: EvidenceLevel;
  durationMs?: number;
  /** 失败相关（failure_recorded / *_failed 事件） */
  failureClass?: AuditFailureClass;
  gate?: string;
  recoveryAction?: string;
  attempt?: number;
  maxAttempts?: number;
  userActionRequired?: string[] | boolean;
  /** 系统授权的修订动作（RepairAction 字面量；repair_started/repair_completed 事件） */
  action?: string;
  /** 修订/验证循环的结构化停止原因（RepairStopReason / AgentLoopStopReason 字面量） */
  stopReason?: string;
  /** 事件特有载荷；不得塞入完整正文或大型工具结果 */
  payload?: Record<string, unknown>;
}

// ============================================================================
// 空值与写入规则（文档性常量，供校验器引用）
// ============================================================================

/**
 * 字段空值规则：
 * - parentEventId：run_started 必须为 null；其余事件应有有效父事件
 * - causedByEventId：仅在因果明确时填写，否则省略（不要写假 id）
 * - inputHash/outputHash：有实际内容时必须写完整 SHA-256；无内容省略
 * - actualProvider/actualModel：仅在模型调用完成后写真实值
 * - evidenceLevel：派生统计写 derived，不得标 observed
 * - payload：禁止完整正文；大对象走 artifactRefs
 */
export const AUDIT_NULL_RULES = {
  parentEventIdOnRunStart: null,
  omitUnknownCausedBy: true,
  hashAlgorithm: "sha256",
  hashEncoding: "hex",
  hashContentEncoding: "utf-8",
  forbidFullTextInPayload: true,
} as const;

/** 每次运行必须具备的生命周期事件对 */
export const REQUIRED_RUN_TERMINAL_EVENTS: readonly AuditEventType[] = [
  "run_finished",
  "run_failed",
  "run_interrupted",
] as const;

export const RUN_START_EVENT: AuditEventType = "run_started";

// ============================================================================
// 禁止原始思维链（RRB-5.4 / T26）
// ============================================================================

/**
 * 原始思维链字段名黑名单。事件 payload 不得出现这些键（含嵌套一层）。
 * 模型内部推理只可决定动作，不可作为事实或授权写入 trace。
 */
export const REASONING_CHAIN_OF_THOUGHT_BANNED_FIELDS = [
  "reasoning_content",
  "thinking",
  "chain_of_thought",
  "chainOfThought",
  "internal_monologue",
  "internalMonologue",
  "hidden_reasoning",
  "hiddenReasoning",
  "cot",
  "model_internal_state",
  "modelInternalState",
] as const;
