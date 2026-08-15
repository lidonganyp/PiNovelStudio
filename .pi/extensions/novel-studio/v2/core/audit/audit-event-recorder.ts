/**
 * AUDIT-EVENT-RECORDER — 窄叶子事件追加接口（P7 Stage A 双写）
 *
 * 职责：给 craft / novelos 等下游模块提供一个「只追加、不读、不改既有写路径」的
 * 审计事件追加口，用于在旧真相源继续写入的同时，追加极少数生命周期审计事件：
 *   - trace_persisted（quality-trace.json 落盘后）
 *   - failure_recorded（FailureEnvelope 归因落盘时）
 *   - trajectory_flushed（NovelOS trajectory.jsonl flush 后）
 *
 * 设计约束：
 * - 本模块只依赖 audit-event-types.ts（纯类型 + 字符串字面量联合），
 *   不拉入 audit-run-session / audit-event-store 的运行时依赖，
 *   从而避免 craft/novelos 把生产会话折叠逻辑带入 eval/test 编译目标。
 * - recordEvent 为可选、写失败不抛：下游默认 no-op（未注入 sink 时静默跳过），
 *   生产由 AuditRunSession 实现；测试可注入空实现或 null sink。
 */

import type {
  AuditEvent,
  AuditEventType,
  AuditStage,
  AuditEventStatus,
  AuditFailureClass,
  AuditCapability,
  EvidenceLevel,
} from "./audit-event-types.js";

/** 通用审计事件追加入参（映射到 AuditEventStore.append 的对应字段）。 */
export interface AuditEventRecorderInput {
  eventType: AuditEventType;
  eventId?: string;
  stage?: AuditStage;
  status?: AuditEventStatus;
  failureClass?: AuditFailureClass;
  gate?: string;
  recoveryAction?: string;
  attempt?: number;
  maxAttempts?: number;
  userActionRequired?: string[] | boolean;
  decisionReason?: string;
  causedByEventId?: string;
  evidenceLevel?: EvidenceLevel;
  capability?: AuditCapability;
  payload?: Record<string, unknown>;
}

/** 只追加、写失败不抛的最小审计事件接口（生产由 AuditRunSession 实现）。 */
export interface AuditEventRecorder {
  recordEvent?(input: AuditEventRecorderInput): string | null;
  /**
   * P7 Stage C-1：可选读取已累积的审计事件列表。
   * 供 QualityTraceRecorder 在 projection 写路径下物化投影缓存
   * （rebuildQualityTraceFromEvents 仅凭审计流重建 gates[] 策展子集）。
   * 未实现（undefined）时调用方回退为不物化，保持 legacy 行为。
   */
  getEntries?(): AuditEvent[];
}
