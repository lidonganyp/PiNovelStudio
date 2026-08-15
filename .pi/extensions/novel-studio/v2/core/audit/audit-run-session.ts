/**
 * AUDIT-RUN-SESSION — Phase 3 主链路会话封装
 *
 * 职责：
 * - 持有 AuditEventStore
 * - 保证 run_started + 终止事件
 * - 将 FailureEnvelope 写成 failure_recorded
 * - 模型回合 / 工具授权与结果细事件（Phase 3 续）
 * - 把审计摘要挂到 stageResults（不替代旧 quality-trace）
 */

import { AuditEventStore } from "./audit-event-store.js";
import type {
  AuditCapability,
  AuditEvent,
  AuditEventType,
  AuditStage,
  EvidenceLevel,
} from "./audit-event-types.js";
import type { AuditEventRecorderInput } from "./audit-event-recorder.js";
import { diagnoseTraceCompleteness } from "./audit-event-validator.js";
import {
  buildProductionFailureEnvelope,
  productionFailureToAuditEvent,
  type UnifiedProductionFailureEnvelope,
} from "../failure-envelope.js";
import type { FailureClass } from "../failure-types.js";
import { mapLegacyFailureClass } from "../failure-types.js";
import { createEventId } from "./audit-event-ids.js";
import { computeContentHash } from "./content-hash.js";
import { installTrustAuditBridgeFromStore } from "../trust/trust-audit-bridge.js";
import {
  runWithTrustAuditContext,
  runWithTrustAuditContextAsync,
  type TrustAuditRunContext,
} from "../trust/trust-audit.js";
import {
  createRunAggregateRepository,
  projectCurrentRunState,
  writeRunProjections,
  type RunAggregate,
  type RunAggregateRepository,
} from "../run/index.js";

/**
 * 细事件写入接口（编排器 / NovelOS runtime 只依赖此窄接口）。
 * 写失败不得抛到业务主路径：方法内部吞错并记 writeError。
 */
export interface AuditEventSink {
  recordModelTurn(input: {
    phase: "started" | "completed" | "failed";
    kind?: string;
    requestedRoute?: string;
    actualProvider?: string;
    actualModel?: string;
    inputHash?: string;
    outputHash?: string;
    durationMs?: number;
    candidateId?: string;
    errorClass?: string;
    /** 关联 started 事件 id（completed/failed 时） */
    startedEventId?: string;
  }): string | null;

  recordToolEvent(input: {
    eventType:
      | "tool_call_requested"
      | "tool_call_authorized"
      | "tool_call_denied"
      | "tool_call_started"
      | "tool_result_received"
      | "tool_call_timeout"
      | "tool_call_interrupted";
    toolCallId: string;
    toolName?: string;
    capability?: AuditCapability;
    decisionReason?: string;
    durationMs?: number;
    inputHash?: string;
    outputHash?: string;
    evidenceLevel?: EvidenceLevel;
    payload?: Record<string, unknown>;
  }): string | null;

  /**
   * 正文保存 / 状态提交 / 最终提交。
   * 三者必须可独立审计，禁止互相伪装成功。
   */
  recordPersistenceEvent(input: {
    eventType:
      | "chapter_save_attempted"
      | "chapter_saved"
      | "chapter_save_failed"
      | "state_commit_attempted"
      | "state_committed"
      | "state_commit_failed"
      | "final_submission";
    decisionReason?: string;
    candidateId?: string;
    revision?: string;
    approvalId?: string;
    outputHash?: string;
    /** chapter save 结果（final_submission 时必填语义） */
    chapterSaveOk?: boolean;
    /** state commit 结果（final_submission 时必填语义） */
    stateCommitOk?: boolean;
    statusOverride?: import("./audit-event-types.js").AuditEventStatus;
    payload?: Record<string, unknown>;
  }): string | null;

  /**
   * 恢复 / 生命周期细事件（P3）。
   * checkpoint / resume / approval / commit_started 等。
   */
  recordLifecycleEvent?(input: {
    eventType:
      | "stage_started"
      | "retry_reserved"
      | "checkpoint_saved"
      | "checkpoint_resumed"
      | "approval_requested"
      | "commit_started"
      | "commit_failed"
      | "compensation_started"
      | "run_recovered";
    decisionReason?: string;
    candidateId?: string;
    revision?: string;
    approvalId?: string;
    outputHash?: string;
    payload?: Record<string, unknown>;
  }): string | null;

  /**
   * 通用审计事件追加（P7 Stage A 双写）。
   * 供 craft/novelos 下游在不切换读路径、不改既有写路径的前提下追加
   * trace_persisted / failure_recorded / trajectory_flushed 等少量生命周期事件。
   * 写失败不抛，返回事件 id（失败返回 null）。
   */
  recordEvent?(input: AuditEventRecorderInput): string | null;

  /**
   * RUN-LIFECYCLE-P0 修复：提交门禁读取聚合状态。
   * commitAndSave 用此判断 approvalState / 已完成 commitIntent / foldError。
   * 未实现时 commitAndSave 回退到文件 sentinel（兼容旧 sink）。
   */
  getLifecycleGate?(): {
    approvalState: string;
    workflowState: string;
    commitIntent: {
      commitIntentId: string;
      status: "attempted" | "completed" | "failed";
      artifactHash: string;
      artifactRevision: string;
    } | null;
    artifactHash: string | null;
    artifactRevision: string | null;
    foldError: string | null;
  } | null;
}

export interface AuditRunSessionOptions {
  projectRoot: string;
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  /** false = 仅内存（preview / 测试可关盘） */
  persist?: boolean;
  runId?: string;
  traceId?: string;
}

export interface AuditStageResultsSummary {
  enabled: true;
  schemaVersion: string;
  traceId: string;
  runId: string;
  eventsPath: string | null;
  eventCount: number;
  sequence: number;
  runTerminal: boolean;
  lastEventType: string | null;
  completenessOk: boolean;
  completenessIssues: Array<{ code: string; message: string }>;
  writeError: string | null;
  persisted: boolean;
  /** P2/P3：RunAggregate 摘要（可由事件流重建） */
  runAggregate?: {
    workflowState: string;
    approvalState: string;
    terminalStatus: string;
    lastSequence: number;
    artifactRevision: string | null;
    artifactHash: string | null;
    approvalId: string | null;
    checkpointId: string | null;
    commitIntentId: string | null;
    foldError: string | null;
  };
}

export class AuditRunSession implements AuditEventSink {
  private readonly store: AuditEventStore;
  private readonly chapterId: string;
  private readonly chapterNumber: number;
  private readonly persist: boolean;
  private readonly projectRoot: string;
  private readonly workspaceId: string;
  private readonly aggregateRepo: RunAggregateRepository;
  private foldError: string | null = null;
  private started = false;
  private finalized = false;
  private writeError: string | null = null;
  private uninstallTrustBridge: (() => void) | null = null;

  constructor(options: AuditRunSessionOptions) {
    this.chapterId = options.chapterId;
    this.chapterNumber = options.chapterNumber;
    this.persist = options.persist ?? true;
    this.projectRoot = options.projectRoot;
    this.workspaceId = options.workspaceId;
    this.store = new AuditEventStore({
      projectRoot: options.projectRoot,
      workspaceId: options.workspaceId,
      runId: options.runId,
      traceId: options.traceId,
      persist: this.persist,
    });
    this.aggregateRepo = createRunAggregateRepository({
      projectRoot: options.projectRoot,
      workspaceId: options.workspaceId,
      chapterId: options.chapterId,
      runId: this.store.runId,
      traceId: this.store.traceId,
      persist: this.persist,
    });
    // 进程重启：store 可能已 bootstrap 历史事件 → 折叠恢复聚合
    const bootstrapped = this.store.getEntries();
    if (bootstrapped.length > 0) {
      const recovered = this.aggregateRepo.recoverFromEvents(bootstrapped);
      if (!recovered.ok && recovered.error) {
        this.foldError = recovered.error.message;
      }
      if (bootstrapped.some((e) => e.eventType === "run_started")) {
        this.started = true;
      }
      if (this.store.getSnapshot().runTerminal) {
        this.finalized = true;
      }
    }
  }

  /** 暴露 store 供信任桥/测试只读访问 */
  getEventStore(): AuditEventStore {
    return this.store;
  }

  /** P2：当前 RunAggregate 快照（事件折叠结果） */
  getRunAggregate(): RunAggregate {
    return this.aggregateRepo.getAggregate();
  }

  getAggregateRepository(): RunAggregateRepository {
    return this.aggregateRepo;
  }

  /** 提交门禁：供 commitAndSave 做 approval / commitIntent 幂等判断 */
  getLifecycleGate(): {
    approvalState: string;
    workflowState: string;
    commitIntent: {
      commitIntentId: string;
      status: "attempted" | "completed" | "failed";
      artifactHash: string;
      artifactRevision: string;
    } | null;
    artifactHash: string | null;
    artifactRevision: string | null;
    foldError: string | null;
  } {
    const agg = this.aggregateRepo.getAggregate();
    return {
      approvalState: agg.approvalState,
      workflowState: agg.workflowState,
      commitIntent: agg.commitIntent
        ? {
            commitIntentId: agg.commitIntent.commitIntentId,
            status: agg.commitIntent.status,
            artifactHash: agg.commitIntent.artifactHash,
            artifactRevision: agg.commitIntent.artifactRevision,
          }
        : null,
      artifactHash: agg.artifactHash,
      artifactRevision: agg.artifactRevision,
      foldError: this.foldError,
    };
  }

  /**
   * 事件已 append 后折叠到 RunAggregate。
   * 折叠失败只记 foldError，不抛（事件已是事实）。
   * SEQUENCE_GAP 时尝试从事件流全量重放自愈（兼容旁路 append 未 fold 的历史漂移）。
   */
  private foldAppended(event: AuditEvent): void {
    try {
      const result = this.aggregateRepo.applyAppendedEvent(event);
      if (!result.ok && result.error && !result.idempotentReplay) {
        if (result.error.code === "SEQUENCE_GAP") {
          const recovered = this.aggregateRepo.recoverFromEvents(
            this.store.getEntries(),
          );
          if (recovered.ok) {
            this.foldError = null;
            return;
          }
        }
        this.foldError = `${result.error.code}: ${result.error.message}`;
      } else if (result.ok) {
        // 成功 fold 清除历史可恢复错误
        if (this.foldError?.startsWith("SEQUENCE_GAP")) {
          this.foldError = null;
        }
      }
    } catch (err) {
      this.foldError = err instanceof Error ? err.message : String(err);
    }
  }

  get traceId(): string {
    return this.store.traceId;
  }

  get runId(): string {
    return this.store.runId;
  }

  get eventsPath(): string | null {
    return this.store.outputPath;
  }

  get isTerminal(): boolean {
    return this.store.getSnapshot().runTerminal;
  }

  getEntries(): AuditEvent[] {
    return this.store.getEntries();
  }

  /** 供测试注入：标记写盘失败而不抛（模拟 append 后 store 进入 write-error） */
  markWriteErrorForTest(message: string): void {
    this.writeError = message;
  }

  /**
   * 模型回合事件。返回 started 事件 id（phase=started）或 null。
   * 写失败不抛，避免污染生成主路径。
   */
  recordModelTurn(input: {
    phase: "started" | "completed" | "failed";
    kind?: string;
    requestedRoute?: string;
    actualProvider?: string;
    actualModel?: string;
    inputHash?: string;
    outputHash?: string;
    durationMs?: number;
    candidateId?: string;
    errorClass?: string;
    startedEventId?: string;
  }): string | null {
    if (this.finalized || this.isTerminal) return null;
    this.ensureStartedSafe();
    const eventType: AuditEventType =
      input.phase === "started"
        ? "model_turn_started"
        : input.phase === "completed"
          ? "model_turn_completed"
          : "model_turn_failed";
    try {
      const { event } = this.store.append({
        actor: "model",
        stage: "model_turn",
        eventType,
        status:
          input.phase === "started"
            ? "started"
            : input.phase === "completed"
              ? "completed"
              : "failed",
        evidenceLevel: "observed",
        capability: "model_route",
        requestedRoute: input.requestedRoute,
        actualProvider: input.actualProvider,
        actualModel: input.actualModel,
        inputHash: input.inputHash,
        outputHash: input.outputHash,
        durationMs: input.durationMs,
        candidateId: input.candidateId,
        parentEventId: input.startedEventId ?? undefined,
        causedByEventId: input.startedEventId ?? undefined,
        decisionReason: input.errorClass
          ? `model error: ${input.errorClass}`
          : undefined,
        payload: {
          kind: input.kind ?? null,
          errorClass: input.errorClass ?? null,
        },
      });
      this.foldAppended(event);
      return event.eventId;
    } catch (err) {
      this.writeError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  /**
   * 工具授权/结果事件。写失败不抛。
   */
  recordToolEvent(input: {
    eventType:
      | "tool_call_requested"
      | "tool_call_authorized"
      | "tool_call_denied"
      | "tool_call_started"
      | "tool_result_received"
      | "tool_call_timeout"
      | "tool_call_interrupted";
    toolCallId: string;
    toolName?: string;
    capability?: AuditCapability;
    decisionReason?: string;
    durationMs?: number;
    inputHash?: string;
    outputHash?: string;
    evidenceLevel?: EvidenceLevel;
    payload?: Record<string, unknown>;
  }): string | null {
    if (this.finalized || this.isTerminal) return null;
    this.ensureStartedSafe();
    const status =
      input.eventType === "tool_call_denied"
        ? ("denied" as const)
        : input.eventType === "tool_call_timeout"
          ? ("timeout" as const)
          : input.eventType === "tool_call_interrupted"
            ? ("interrupted" as const)
            : input.eventType === "tool_call_requested" ||
                input.eventType === "tool_call_started"
              ? ("started" as const)
              : ("completed" as const);
    try {
      const { event } = this.store.append({
        actor: "tool_runtime",
        stage: "tool" as AuditStage,
        eventType: input.eventType,
        status,
        evidenceLevel: input.evidenceLevel ?? "observed",
        capability: input.capability ?? "retrieval",
        decisionReason: input.decisionReason,
        durationMs: input.durationMs,
        inputHash: input.inputHash,
        outputHash: input.outputHash,
        payload: {
          toolCallId: input.toolCallId,
          toolName: input.toolName ?? null,
          ...(input.payload ?? {}),
        },
      });
      this.foldAppended(event);
      return event.eventId;
    } catch (err) {
      this.writeError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  /**
   * 正文保存 / 状态提交 / 最终提交。
   * final_submission 必须同时携带 chapterSaveOk 与 stateCommitOk，禁止互相伪装。
   */
  recordPersistenceEvent(input: {
    eventType:
      | "chapter_save_attempted"
      | "chapter_saved"
      | "chapter_save_failed"
      | "state_commit_attempted"
      | "state_committed"
      | "state_commit_failed"
      | "final_submission";
    decisionReason?: string;
    candidateId?: string;
    revision?: string;
    approvalId?: string;
    outputHash?: string;
    chapterSaveOk?: boolean;
    stateCommitOk?: boolean;
    /** 覆盖默认 status（如无 stagedStateUpdate 时 state 侧写 skipped） */
    statusOverride?: AuditEvent["status"];
    payload?: Record<string, unknown>;
  }): string | null {
    if (this.finalized || this.isTerminal) return null;
    this.ensureStartedSafe();

    const isChapter = input.eventType.startsWith("chapter_save");
    const isState = input.eventType.startsWith("state_commit");
    const isFinal = input.eventType === "final_submission";
    const stage: AuditStage = isChapter
      ? "chapter_save"
      : isState || isFinal
        ? "state_commit"
        : "unknown";
    const capability: AuditCapability = isChapter
      ? "chapter_save"
      : isState
        ? "state_commit"
        : "governance";
    const status =
      input.statusOverride ??
      (input.eventType.endsWith("_failed")
        ? ("failed" as const)
        : input.eventType.endsWith("_attempted")
          ? ("started" as const)
          : ("completed" as const));

    try {
      const { event } = this.store.append({
        actor: "orchestrator",
        stage,
        eventType: input.eventType,
        status,
        evidenceLevel: "observed",
        capability,
        decisionReason: input.decisionReason,
        candidateId: input.candidateId,
        revision: input.revision,
        approvalId: input.approvalId,
        outputHash: input.outputHash,
        payload: {
          chapterSaveOk:
            input.chapterSaveOk !== undefined ? input.chapterSaveOk : null,
          stateCommitOk:
            input.stateCommitOk !== undefined ? input.stateCommitOk : null,
          ...(input.payload ?? {}),
        },
      });
      this.foldAppended(event);
      return event.eventId;
    } catch (err) {
      this.writeError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  /**
   * 恢复 / 审批 / commit 生命周期事件（P3）。
   * 写失败不抛。
   */
  recordLifecycleEvent(input: {
    eventType:
      | "stage_started"
      | "retry_reserved"
      | "checkpoint_saved"
      | "checkpoint_resumed"
      | "approval_requested"
      | "commit_started"
      | "commit_failed"
      | "compensation_started"
      | "run_recovered";
    decisionReason?: string;
    candidateId?: string;
    revision?: string;
    approvalId?: string;
    outputHash?: string;
    payload?: Record<string, unknown>;
  }): string | null {
    if (this.finalized || this.isTerminal) return null;
    this.ensureStartedSafe();
    const status =
      input.eventType === "commit_failed"
        ? ("failed" as const)
        : input.eventType === "checkpoint_resumed" ||
            input.eventType === "run_recovered"
          ? ("recovered" as const)
          : input.eventType === "checkpoint_saved" ||
              input.eventType === "approval_requested" ||
              input.eventType === "stage_started" ||
              input.eventType === "retry_reserved" ||
              input.eventType === "commit_started" ||
              input.eventType === "compensation_started"
            ? ("started" as const)
            : ("completed" as const);
    const stage: AuditStage =
      input.eventType === "approval_requested"
        ? "proxy_approval"
        : input.eventType.startsWith("commit_")
          ? "final_submission"
          : input.eventType.startsWith("checkpoint_") ||
              input.eventType === "run_recovered" ||
              input.eventType === "compensation_started" ||
              input.eventType === "retry_reserved"
            ? "recovery"
            : "run";
    try {
      const { event } = this.store.append({
        actor:
          input.eventType === "approval_requested" ? "governance" : "recovery",
        stage,
        eventType: input.eventType,
        status,
        evidenceLevel: "observed",
        decisionReason: input.decisionReason,
        candidateId: input.candidateId,
        revision: input.revision,
        approvalId: input.approvalId,
        outputHash: input.outputHash,
        payload: input.payload ?? {},
      });
      this.foldAppended(event);
      return event.eventId;
    } catch (err) {
      this.writeError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  /** 写入 run_started（幂等：已 start 则跳过） */
  start(payload?: Record<string, unknown>): void {
    if (this.started) return;
    try {
      const { event } = this.store.startRun({
        chapterId: this.chapterId,
        chapterNumber: this.chapterNumber,
        ...payload,
      });
      this.foldAppended(event);
      this.started = true;
      // 生产闭包：按 runId 注册隔离 TrustAudit sink（禁止进程级单例覆盖）
      if (!this.uninstallTrustBridge) {
        this.uninstallTrustBridge = installTrustAuditBridgeFromStore(this.store, {
          projectRoot: this.projectRoot,
          workspaceId: this.workspaceId,
          chapterId: this.chapterId,
          // trust 旁路 append 必须 fold，否则 sequence 漂移误阻断 commitAndSave
          onEventAppended: (event) => this.foldAppended(event),
        });
      }
    } catch (err) {
      this.writeError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /**
   * 当前 run 的 TrustAudit ALS 上下文。
   * 编排器应在主路径使用 runInTrustContext / runInTrustContextAsync，
   * 保证并发 run 的 emitTrustAuditEvent 只写入本 session。
   */
  getTrustAuditContext(): TrustAuditRunContext {
    return {
      runId: this.runId,
      workspaceId: this.workspaceId,
      chapterId: this.chapterId,
      traceId: this.traceId,
      sinkKey: this.runId,
    };
  }

  /** 在本 run 的 TrustAudit 上下文中执行同步逻辑 */
  runInTrustContext<T>(fn: () => T): T {
    return runWithTrustAuditContext(this.getTrustAuditContext(), fn);
  }

  /** 在本 run 的 TrustAudit 上下文中执行异步逻辑 */
  runInTrustContextAsync<T>(fn: () => Promise<T>): Promise<T> {
    return runWithTrustAuditContextAsync(this.getTrustAuditContext(), fn);
  }

  /**
   * 信任决策 / 其它扩展事件写入 custom（eventTypeHint 在 payload）。
   * 写失败不抛。
   */
  recordCustomEvent(input: {
    decisionReason: string;
    status?: "completed" | "denied" | "blocked" | "failed";
    stage?: AuditStage;
    capability?: AuditCapability;
    payload?: Record<string, unknown>;
  }): string | null {
    if (this.finalized || this.isTerminal) return null;
    this.ensureStartedSafe();
    try {
      const { event } = this.store.append({
        actor: "system",
        stage: input.stage ?? "gate",
        eventType: "custom",
        status: input.status ?? "completed",
        evidenceLevel: "observed",
        capability: input.capability ?? "governance",
        decisionReason: input.decisionReason,
        payload: input.payload ?? {},
      });
      this.foldAppended(event);
      return event.eventId;
    } catch (err) {
      this.writeError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  /**
   * 通用审计事件追加（P7 Stage A 双写）。
   * 供 craft/novelos 下游追加 trace_persisted / failure_recorded /
   * trajectory_flushed 等少量生命周期事件，不改变读路径或既有写路径。
   * 写失败不抛；终态后（finalized/isTerminal）拒绝写入。
   */
  recordEvent(input: AuditEventRecorderInput): string | null {
    if (this.finalized || this.isTerminal) return null;
    this.ensureStartedSafe();
    // 幂等：多实例（多个 recorder/adaptor 共享同一 session）对同一 eventId 重放时
    // 静默返回既有事件，不触发 store.append 的 duplicate eventId 抛错，也不置 writeError。
    if (input.eventId) {
      const existing = this.store.getEntries().find((e) => e.eventId === input.eventId);
      if (existing) return existing.eventId;
    }
    try {
      const { event } = this.store.append({
        eventId: input.eventId,
        actor: "system",
        stage: input.stage ?? "gate",
        eventType: input.eventType,
        status: input.status ?? "completed",
        evidenceLevel: input.evidenceLevel ?? "observed",
        capability: input.capability ?? "governance",
        failureClass: input.failureClass,
        gate: input.gate,
        recoveryAction: input.recoveryAction,
        attempt: input.attempt,
        maxAttempts: input.maxAttempts,
        userActionRequired: input.userActionRequired,
        decisionReason: input.decisionReason,
        causedByEventId: input.causedByEventId,
        payload: input.payload ?? {},
      });
      this.foldAppended(event);
      return event.eventId;
    } catch (err) {
      this.writeError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  /** 结束 run 时卸载信任桥，避免跨 run 串写 */
  detachTrustBridge(): void {
    if (this.uninstallTrustBridge) {
      try {
        this.uninstallTrustBridge();
      } catch {
        // ignore
      }
      this.uninstallTrustBridge = null;
    }
  }

  /**
   * 记录结构化失败为 failure_recorded。
   * 接受生产信封或旧 craft 形状；统一经 buildProductionFailureEnvelope。
   */
  recordFailure(input: {
    stage: string;
    reason: string;
    gate?: string;
    severity?: string;
    failureClass?: FailureClass | string;
    evidence?: unknown;
    recoverable?: boolean;
    userActionRequired?: string[];
    attempt?: number;
    maxAttempts?: number;
    recoveryAction?: string;
  }): AuditEvent | null {
    this.ensureStarted();
    try {
      const built = buildProductionFailureEnvelope({
        stage: input.stage,
        reason: input.reason,
        gate: input.gate,
        failureClass: input.failureClass
          ? mapLegacyFailureClass(input.failureClass)
          : undefined,
        severity: input.severity,
        evidence: input.evidence,
        recoverable: input.recoverable,
        userActionRequired: input.userActionRequired,
        attempt: input.attempt,
        maxAttempts: input.maxAttempts,
        forceRecoveryAction: input.recoveryAction as
          | "user_fix"
          | "retry_gate"
          | "retry_stage"
          | "resume_checkpoint"
          | "regenerate_candidate"
          | "checkpoint"
          | "rollback"
          | "stop"
          | undefined,
        traceId: this.traceId,
        parentEventId: this.store.getSnapshot().lastEventId,
        causedByEventId: this.store.getSnapshot().lastEventId,
      });
      return this.appendFailureEnvelope(built);
    } catch (err) {
      this.writeError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  appendFailureEnvelope(env: UnifiedProductionFailureEnvelope): AuditEvent {
    this.ensureStarted();
    const draft = productionFailureToAuditEvent(env, {
      runId: this.runId,
      sequence: this.store.getSequence() + 1,
      parentEventId: this.store.getSnapshot().lastEventId,
      causedByEventId: env.causedByEventId ?? this.store.getSnapshot().lastEventId,
      traceId: this.traceId,
    });
    // 通过 store.append 分配 sequence / 校验
    const { event } = this.store.append({
      eventId: draft.eventId,
      actor: draft.actor,
      stage: draft.stage,
      eventType: "failure_recorded",
      status: "failed",
      evidenceLevel: "observed",
      failureClass: draft.failureClass,
      gate: draft.gate,
      recoveryAction: draft.recoveryAction,
      attempt: draft.attempt,
      maxAttempts: draft.maxAttempts,
      userActionRequired: draft.userActionRequired,
      decisionReason: draft.decisionReason,
      causedByEventId: draft.causedByEventId,
      payload: draft.payload,
    });
    this.foldAppended(event);
    return event;
  }

  /**
   * 根据 V2Output 写终止事件（幂等）。
   * - blocked / error → failure_recorded（若尚未有）+ run_failed
   * - ok → run_finished
   */
  finalizeFromV2Output(output: {
    status: "ok" | "error" | "blocked";
    failureEnvelope?: unknown;
    selectedCandidateId?: string;
    selectedSource?: string | null;
  }): void {
    if (this.finalized || this.isTerminal) {
      this.finalized = true;
      return;
    }
    this.ensureStarted();
    try {
      if (output.status === "ok") {
        const { event: fin } = this.store.finishRun("run_finished", {
          decisionReason: "pipeline completed",
          payload: {
            selectedCandidateId: output.selectedCandidateId ?? null,
            selectedSource: output.selectedSource ?? null,
          },
        });
        this.foldAppended(fin);
      } else {
        const fe = (output.failureEnvelope ?? {}) as Record<string, unknown>;
        // 若最近事件还不是 failure_recorded，补一条
        const entries = this.store.getEntries();
        const last = entries[entries.length - 1];
        if (!last || last.eventType !== "failure_recorded") {
          this.recordFailure({
            stage: String(fe.stage ?? "unknown"),
            reason: String(fe.reason ?? `pipeline ${output.status}`),
            gate: fe.gate ? String(fe.gate) : undefined,
            severity: fe.severity ? String(fe.severity) : undefined,
            failureClass: fe.failureClass
              ? String(fe.failureClass)
              : undefined,
            evidence: fe.evidence,
            recoverable: Boolean(fe.recoverable),
            userActionRequired: Array.isArray(fe.userActionRequired)
              ? (fe.userActionRequired as string[])
              : undefined,
            attempt: typeof fe.attempt === "number" ? fe.attempt : undefined,
            maxAttempts:
              typeof fe.maxAttempts === "number" ? fe.maxAttempts : undefined,
          });
        }
        const { event: fin } = this.store.finishRun("run_failed", {
          decisionReason: String(fe.reason ?? `status=${output.status}`),
          failureClass: fe.failureClass
            ? mapLegacyFailureClass(String(fe.failureClass))
            : fe.severity
              ? mapLegacyFailureClass(String(fe.severity))
              : "blocked",
          gate: fe.gate ? String(fe.gate) : undefined,
          payload: { status: output.status },
        });
        this.foldAppended(fin);
      }
      this.finalized = true;
      this.detachTrustBridge();
    } catch (err) {
      this.writeError = err instanceof Error ? err.message : String(err);
      // 终止事件失败必须暴露，不吞
      this.detachTrustBridge();
      throw err;
    }
  }

  /**
   * 直接写 run 终止事件（无 FailureEnvelope 时用）。
   * 代理审批 reject/inspect/rollback 等无正文提交路径。
   */
  finishRun(
    eventType: "run_finished" | "run_failed" | "run_interrupted",
    extra?: Parameters<AuditEventStore["finishRun"]>[1],
  ): void {
    if (this.finalized || this.isTerminal) {
      this.finalized = true;
      this.detachTrustBridge();
      return;
    }
    this.ensureStarted();
    try {
      const { event: fin } = this.store.finishRun(eventType, extra);
      this.foldAppended(fin);
      this.finalized = true;
      this.detachTrustBridge();
    } catch (err) {
      this.writeError = err instanceof Error ? err.message : String(err);
      this.detachTrustBridge();
      throw err;
    }
  }

  /** 未捕获异常 / 无结果退出 */
  finalizeInterrupted(reason: string, error?: unknown): void {
    if (this.finalized || this.isTerminal) {
      this.finalized = true;
      return;
    }
    this.ensureStarted();
    try {
      this.recordFailure({
        stage: "run",
        gate: "pipeline_exception",
        reason,
        failureClass: "fatal",
        severity: "fatal",
        evidence: {
          error:
            error instanceof Error
              ? { message: error.message, name: error.name }
              : error != null
                ? String(error)
                : null,
        },
        recoverable: false,
      });
      const { event: fin } = this.store.finishRun("run_interrupted", {
        decisionReason: reason,
        failureClass: "interrupted",
      });
      this.foldAppended(fin);
      this.finalized = true;
    } catch (err) {
      this.writeError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /** 挂到 V2Output.stageResults.auditRun */
  toStageResultsSummary(): AuditStageResultsSummary {
    const snap = this.store.getSnapshot();
    const entries = this.store.getEntries();
    const completeness = diagnoseTraceCompleteness(entries);
    const last = entries[entries.length - 1];
    const agg = this.aggregateRepo.getAggregate();
    const runState = projectCurrentRunState(agg);
    // 终态时尽力写投影（失败不阻断）
    if (snap.runTerminal && this.persist) {
      try {
        writeRunProjections({
          projectRoot: this.projectRoot,
          aggregate: agg,
          events: entries,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.foldError = this.foldError
          ? `${this.foldError}; projection: ${msg}`
          : `projection: ${msg}`;
      }
    }
    return {
      enabled: true,
      schemaVersion: last?.schemaVersion ?? "1.0.0",
      traceId: snap.traceId,
      runId: snap.runId,
      eventsPath: snap.outputPath,
      eventCount: snap.eventCount,
      sequence: snap.sequence,
      runTerminal: snap.runTerminal,
      lastEventType: last?.eventType ?? null,
      completenessOk: completeness.ok,
      completenessIssues: completeness.issues.map((i) => ({
        code: i.code,
        message: i.message,
      })),
      writeError: this.writeError ?? (this.store.getLastWriteError()?.message ?? null),
      // 仅当启用持久化、有目标路径、且无写盘错误时才标 true（避免“有 path 就算成功”的误报）
      persisted:
        this.persist &&
        snap.outputPath != null &&
        this.writeError == null &&
        this.store.getLastWriteError() == null,
      runAggregate: {
        workflowState: runState.workflowState,
        approvalState: runState.approvalState,
        terminalStatus: runState.terminalStatus,
        lastSequence: runState.lastSequence,
        artifactRevision: runState.artifactRevision,
        artifactHash: runState.artifactHash,
        approvalId: runState.approvalId,
        checkpointId: runState.checkpointId,
        commitIntentId: runState.commitIntentId,
        foldError: this.foldError,
      },
    };
  }

  /**
   * 包装输出：finalize + 注入 stageResults.auditRun。
   * audit 写入失败时仍返回业务结果，但 writeError 可见；
   * 若业务已成功而 audit 失败，在 stageResults 标记 auditWriteFailed。
   */
  attachToOutput<T extends {
    status: "ok" | "error" | "blocked";
    failureEnvelope?: unknown;
    selectedCandidateId?: string;
    selectedSource?: string | null;
    stageResults?: Record<string, unknown>;
  }>(output: T): T {
    let auditWriteFailed = false;
    try {
      this.finalizeFromV2Output(output);
    } catch {
      auditWriteFailed = true;
    }
    const summary = this.toStageResultsSummary();
    return {
      ...output,
      stageResults: {
        ...(output.stageResults ?? {}),
        auditRun: {
          ...summary,
          auditWriteFailed,
        },
      },
    };
  }

  private ensureStarted(): void {
    if (!this.started) {
      this.start();
    }
  }

  /** 细事件路径：start 失败只记 writeError，不抛 */
  private ensureStartedSafe(): void {
    if (this.started) return;
    try {
      this.start();
    } catch (err) {
      this.writeError = err instanceof Error ? err.message : String(err);
    }
  }
}

/** 可选：对短文本算 hash；超长/空则省略（避免把正文塞进事件） */
export function optionalContentHash(text: string | undefined | null, maxChars = 4000): string | undefined {
  if (!text || text.length === 0) return undefined;
  if (text.length > maxChars) {
    // 仍对真实内容 hash，不截断输入
    return computeContentHash(text);
  }
  return computeContentHash(text);
}

export { createEventId };

export function createAuditRunSession(
  options: AuditRunSessionOptions,
): AuditRunSession {
  return new AuditRunSession(options);
}
