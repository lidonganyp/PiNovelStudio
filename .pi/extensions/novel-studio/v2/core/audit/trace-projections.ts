/**
 * TRACE-PROJECTIONS — AuditEvent 列表 → legacy 结构等价投影（P7 Stage B 只读侧）
 *
 * 目标：在「旧文件继续写 + 审计流追加事件」的双写过渡期结束后，让读侧能仅凭
 * 审计流重建 legacy 读视图，从而在不切写路径的前提下逐步收敛读路径。
 *
 * 本模块只做纯函数投影，不含 I/O、不含写路径、不 import craft/novelos 写模块。
 * 输入是已持久化（或捕获）的 AuditEvent 列表，输出 legacy 结构的「可重建子集」。
 *
 * 诚实边界（勿误报为全量等价）：
 * - 审计流携带 failure_recorded（§5.2 完整 FailureEnvelope）、gate_evaluated
 *   （策展读侧证据子集：strategyContext/modelCalls/releaseGovernance，不含完整正文）
 *   与 trajectory_flushed（counts 摘要），不含 events[]/patches[]/
 *   v2Summary/performanceProfile/repairObservations 等细节字段。
 * - 因此 `rebuildQualityTraceFromEvents` 可逐字段还原 failureEnvelopes[] 与
 *   gates[]（evidence 为策展子集，非完整 V2TraceRecord），其余字段以
 *   `unreconstructed` 显式标注缺位，不伪造、不回填空值冒充等价。
 * - `rebuildTrajectoryFromEvents` 只能还原 flush 摘要（sessionId/entryCount/
 *   failureCount/outputPath），细节轨迹（message/tool_event 等）留在 session 目录。
 */
import type { AuditEvent } from "./audit-event-types.js";

// ============================================================================
// 投影结果类型
// ============================================================================

/** 还原后的失败归因记录（对应 QualityTraceFailureEnvelopeRecord 的可重建子集） */
export interface RebuiltFailureEnvelopeRecord {
  /** 阶段标识 */
  stage: string;
  /** 门禁标识 */
  gate?: string;
  /** 严重程度 */
  severity: string;
  /** 人类可读阻断原因 */
  reason: string;
  /** 结构化证据 */
  evidence: unknown;
  /** 是否可自动恢复 */
  recoverable: boolean;
  /** 恢复计划（流中为 null 时保留 null） */
  retryPlan?: unknown | null;
  /** 需用户补输入的动作清单 */
  userActionRequired?: string[] | boolean | null;
  /**
   * 记录时间（ISO-8601）。审计事件不携带 legacy 的 recordedAt，此处从
   * event.timestamp（Unix ms）best-effort 还原；事件无 timestamp 时为 null。
   */
  recordedAt: string | null;
}

/**
 * 从 gate_evaluated 事件还原的门禁记录（对应 QualityTraceGateRecord 的可重建子集）。
 *
 * evidence 为策展后的读侧证据子集（strategyContext / modelCalls /
 * releaseGovernance），不含完整候选正文（候选/裁决正文留在旧文件，未入审计流）。
 * 因此 R1-R4 读侧（loadStrategyTraceContext / readChapterCostStats /
 * canary 提取）可据此重建所需的 strategyContext/modelCalls/releaseGovernance，
 * 但无法重建完整 V2TraceRecord（candidates/judgeEvidence/finalSelection 等）。
 */
export interface RebuiltQualityGateRecord {
  /** 门禁标识（如 "v2_final_selected" / "story_preservation"） */
  stage: string;
  /** 门禁状态 */
  status: string;
  passed: boolean;
  blocked: boolean;
  score: number | null;
  reason: string;
  issueTypes: string[];
  revisionHints: string[];
  /** 策展后的读侧证据子集（strategyContext / modelCalls / releaseGovernance） */
  evidence: Record<string, unknown>;
}

/**
 * QualityTraceDocument 的「可重建子集」。failureEnvelopes[] 逐字段等价，
 * gates[] 以策展读侧证据子集还原；其余字段缺位并以 unreconstructed 显式标注。
 */
export interface RebuiltQualityTrace {
  schemaVersion: 1;
  workspaceId: string;
  chapterId: string;
  /** 生成起点（ISO-8601），取最早事件 timestamp；无则回退 options.createdAt 或 null */
  createdAt: string | null;
  /** 逐字段还原的失败归因（8 个 FailureEnvelope 核心字段逐字段等价，§5.2） */
  failureEnvelopes: RebuiltFailureEnvelopeRecord[];
  /** 从 gate_evaluated 事件还原的门禁记录（evidence 为策展读侧子集） */
  gates: RebuiltQualityGateRecord[];
  /** 无法从审计流重建的 legacy 字段清单（诚实声明，不伪造等价） */
  unreconstructed: ReadonlyArray<
    | "events"
    | "patches"
    | "v2Summary"
    | "strategyContext"
    | "performanceProfile"
    | "repairObservations"
    | "userPreferenceRules"
    | "chapterContract"
    | "attemptHistory"
  >;
}

/** 还原后的 trajectory flush 摘要（对应 trajectory_flushed 事件） */
export interface RebuiltTrajectoryFlush {
  sessionId: string;
  entryCount: number;
  failureCount: number;
  outputPath: string;
}

export interface RebuildQualityTraceOptions {
  workspaceId: string;
  chapterId: string;
  /** 生成起点回退值（ISO-8601）；事件 timestamp 可用时优先取事件时间 */
  createdAt?: string;
}

// ============================================================================
// 常量
// ============================================================================

/**
 * 无法从当前审计流重建的 legacy 字段（与 RebuiltQualityTrace.unreconstructed 一致）。
 * 注意：顶层 strategyContext 仍标记为 unreconstructed（无顶层事件携带它），
 * 但 gates[].evidence.strategyContext 已通过 gate_evaluated 事件重建，供 R1 读侧消费。
 */
const UNRECONSTRUCTED_QUALITY_TRACE_FIELDS: RebuiltQualityTrace["unreconstructed"] = [
  "events",
  "patches",
  "v2Summary",
  "strategyContext",
  "performanceProfile",
  "repairObservations",
  "userPreferenceRules",
  "chapterContract",
  "attemptHistory",
] as const;

// ============================================================================
// 投影实现
// ============================================================================

/**
 * 从 AuditEvent 列表逐字段还原 quality-trace 的 failureEnvelopes[]。
 *
 * 仅识别 payload.source === "quality_trace" 且 payload.envelope 为对象的
 * failure_recorded 事件（即 QualityTraceRecorder.emitFailureRecorded 发射的那类，
 * 区别于 recordFailure / finalizeInterrupted 的 failure_recorded，后者 payload
 * 携带 nextStep/completedWork/evidence 而非 envelope）。
 *
 * 逐字段等价契约（§5.2）：stage / gate / severity / reason / evidence /
 * recoverable / retryPlan / userActionRequired 八字段原样还原，不落空值。
 */
export function rebuildQualityTraceFromEvents(
  events: ReadonlyArray<AuditEvent>,
  options: RebuildQualityTraceOptions,
): RebuiltQualityTrace {
  const failureEnvelopes: RebuiltFailureEnvelopeRecord[] = [];
  const gates: RebuiltQualityGateRecord[] = [];
  let earliestTimestamp: number | null = null;

  for (const event of events) {
    if (typeof event.timestamp === "number") {
      earliestTimestamp =
        earliestTimestamp === null
          ? event.timestamp
          : Math.min(earliestTimestamp, event.timestamp);
    }

    if (event.eventType === "failure_recorded") {
      const payload = asRecord(event.payload);
      if (payload.source !== "quality_trace") continue;
      const envelope = asRecord(payload.envelope);
      if (!envelope) continue;

      failureEnvelopes.push({
        stage: typeof envelope.stage === "string" ? envelope.stage : "unknown",
        gate: typeof envelope.gate === "string" ? envelope.gate : undefined,
        severity: typeof envelope.severity === "string" ? envelope.severity : "unknown",
        reason: typeof envelope.reason === "string" ? envelope.reason : "",
        evidence: envelope.evidence ?? null,
        recoverable: envelope.recoverable === true,
        retryPlan: envelope.retryPlan ?? null,
        userActionRequired: normalizeUserActionRequired(envelope.userActionRequired),
        recordedAt:
          typeof event.timestamp === "number" ? new Date(event.timestamp).toISOString() : null,
      });
      continue;
    }

    if (event.eventType === "gate_evaluated") {
      gates.push(rebuildGateFromEvent(event));
      continue;
    }
  }

  return {
    schemaVersion: 1,
    workspaceId: options.workspaceId,
    chapterId: options.chapterId,
    createdAt:
      earliestTimestamp !== null
        ? new Date(earliestTimestamp).toISOString()
        : options.createdAt ?? null,
    failureEnvelopes,
    gates,
    unreconstructed: UNRECONSTRUCTED_QUALITY_TRACE_FIELDS,
  };
}

/**
 * 从单条 gate_evaluated 事件还原门禁记录（evidence 为策展读侧子集）。
 *
 * gate 标识优先取 event.gate，缺失时回退 payload.gateStage；reason 优先取
 * payload.reason，缺失回退 event.decisionReason；status 取 event.status。
 * evidence 仅接受对象（策展子集），否则空对象。
 */
function rebuildGateFromEvent(event: AuditEvent): RebuiltQualityGateRecord {
  const payload = asRecord(event.payload);
  const evidence =
    payload.evidence !== null && typeof payload.evidence === "object"
      ? (payload.evidence as Record<string, unknown>)
      : {};

  return {
    stage:
      typeof event.gate === "string"
        ? event.gate
        : typeof payload.gateStage === "string"
          ? payload.gateStage
          : "unknown",
    status: typeof event.status === "string" ? event.status : "unknown",
    passed: payload.passed === true,
    blocked: payload.blocked === true,
    score: typeof payload.score === "number" ? payload.score : null,
    reason:
      typeof payload.reason === "string"
        ? payload.reason
        : typeof event.decisionReason === "string"
          ? event.decisionReason
          : "",
    issueTypes: Array.isArray(payload.issueTypes) ? payload.issueTypes.map(String) : [],
    revisionHints: Array.isArray(payload.revisionHints)
      ? payload.revisionHints.map(String)
      : [],
    evidence,
  };
}

/**
 * 从 AuditEvent 列表还原 trajectory flush 摘要。
 *
 * 仅识别 payload.eventTypeHint === "trajectory_flushed" 的 custom 事件
 * （TrajectoryStore.emitTrajectoryFlushed 发射）。同一 sessionId 可能因多次 flush
 * 产生多条（entryCount 单调递增），投影按 sessionId 去重保留 entryCount 最大者。
 */
export function rebuildTrajectoryFromEvents(
  events: ReadonlyArray<AuditEvent>,
): RebuiltTrajectoryFlush[] {
  const bySession = new Map<string, RebuiltTrajectoryFlush>();

  for (const event of events) {
    if (event.eventType !== "custom") continue;
    const payload = asRecord(event.payload);
    if (payload.eventTypeHint !== "trajectory_flushed") continue;

    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
    const entryCount = typeof payload.entryCount === "number" ? payload.entryCount : 0;
    const failureCount = typeof payload.failureCount === "number" ? payload.failureCount : 0;
    const outputPath = typeof payload.outputPath === "string" ? payload.outputPath : "";

    const existing = bySession.get(sessionId);
    if (!existing || entryCount > existing.entryCount) {
      bySession.set(sessionId, { sessionId, entryCount, failureCount, outputPath });
    }
  }

  return Array.from(bySession.values());
}

// ============================================================================
// helpers
// ============================================================================

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 归一化 userActionRequired（string[] | boolean | string | null | undefined → string[] | boolean | null | undefined） */
function normalizeUserActionRequired(
  value: unknown,
): string[] | boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && value.length > 0) return [value];
  return null;
}
