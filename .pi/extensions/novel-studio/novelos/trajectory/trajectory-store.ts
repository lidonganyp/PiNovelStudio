/**
 * NovelOS Trajectory Store（OPT-8.11）
 *
 * 记录 messages、tool events、context decisions、checkpoints、outputs、failure envelope。
 * 原子写入 workspaces/{id}/novelos-sessions/{sessionId}/trajectory.jsonl。
 *
 * 设计原则：
 * - 完整回放「问题—工具—证据—修改—验证」链；
 * - 原子写入（临时文件 → rename），失败不污染既有产物；
 * - persist=false 时仅 in-memory（测试用）。
 */

import { mkdirSync, writeFileSync, existsSync, renameSync } from "fs";
import { join, dirname } from "path";
import type { AgentEvent, AgentMessage } from "../adapters/pi-agent-core-adapter.js";
import type { NovelSessionCheckpoint } from "../session/novel-session.js";
import type { BudgetSnapshot } from "../runtime/budget-policy.js";
// P7 Stage A 双写：flush 后向审计流追加 trajectory_flushed，不改读路径、不改既有写路径。
import type { AuditEventRecorder } from "../../v2/core/audit/audit-event-recorder.js";
// P7 Stage C-3：写路径开关 + 明细独立内容库（TrajectoryStore 降级为审计流/内容库投影）。
import { resolveTrajectoryWriteMode, type TrajectoryWriteMode } from "../../v2/core/audit/trajectory-write-mode.js";
import { createTrajectoryContentStore, type TrajectoryContentStore } from "../../v2/core/audit/trajectory-content-store.js";

/**
 * 失败信封（与编排器 FailureEnvelope 归一）。
 *
 * AUDIT-1：本类型为只读兼容形状。生产失败事实源为
 * v2/core/failure-envelope.ts + v2/core/audit AuditEvent(failure_recorded)。
 * 新写入应优先 failureClass；soft/hard 仅历史读取。
 */
export interface TrajectoryFailureEnvelope {
  stage: string;
  /**
   * 生产分类：preflight|recoverable|interrupted|blocked|fatal
   * soft/hard 仅历史兼容读取，新写入禁止 soft。
   */
  severity:
    | "preflight"
    | "recoverable"
    | "interrupted"
    | "blocked"
    | "fatal"
    | "soft" // legacy read-only
    | "hard"; // legacy read-only
  reason: string;
  evidence?: unknown;
  recoverable: boolean;
  /** 恢复计划；生产禁止 "fallback to one_shot_raw" */
  retryPlan?: string;
  userActionRequired?: boolean;
  failureClass?: "preflight" | "recoverable" | "interrupted" | "blocked" | "fatal";
  recoveryAction?: string;
  /** AUDIT-1 因果链（可选；新写入应填） */
  eventId?: string;
  parentEventId?: string | null;
  causedByEventId?: string | null;
  attempt?: number;
  maxAttempts?: number;
}

/** Trajectory 条目类型 */
export type TrajectoryEntryType =
  | "session_start"
  | "session_end"
  | "message"
  | "tool_event"
  | "checkpoint"
  | "output"
  | "failure"
  | "budget"
  | "evidence_plan"
  | "verifier_report"
  | "patch_proposal"
  | "repair_round"
  | "ranked_evidence"
  | "tool_visibility"
  | "tool_call_metrics";

/** Trajectory 条目（JSONL 一行） */
export interface TrajectoryEntry {
  type: TrajectoryEntryType;
  timestamp: number;
  data: unknown;
}

export interface TrajectoryStoreOptions {
  projectRoot: string;
  workspaceId: string;
  sessionId: string;
  /** 是否落盘（测试可关闭，默认 true） */
  persist?: boolean;
  /** P7 Stage A 双写：flush 后向审计流追加 trajectory_flushed。未注入时 no-op。 */
  auditSink?: AuditEventRecorder;
  /**
   * P7 Stage C-3：写路径模式。默认（未设置）由 resolveTrajectoryWriteMode() 解析，
   * 读环境变量 PINOVEL_TRAJECTORY_WRITE_MODE（"legacy" 强制回退，否则 projection）。
   * 本字段仅用于显式注入 / 测试。
   */
  writeMode?: TrajectoryWriteMode;
  /**
   * P7 Stage C-3：轨迹明细独立内容库。projection 模式下 flush 把完整轨迹
   * 原子写到 content store（而非仅 trajectory.jsonl）。未注入且 writeMode=projection
   * 时自动创建；legacy 模式下忽略。
   */
  contentStore?: TrajectoryContentStore;
}

export class TrajectoryStore {
  private readonly entries: TrajectoryEntry[] = [];
  private readonly outputPath: string;
  private readonly persist: boolean;
  private readonly sessionId: string;
  private readonly auditSink?: AuditEventRecorder;
  private readonly writeMode: TrajectoryWriteMode;
  private readonly contentStore?: TrajectoryContentStore;
  /** 发射侧去重：flush 写整数组，entryCount 单调不减，只在增长时追加事件。 */
  private lastFlushedEntryCount = -1;
  /** 发射侧去重：内容库写失败告警（trajectory_content_store_write_failed）只发射一次。 */
  private emittedContentStoreFailure = false;

  constructor(options: TrajectoryStoreOptions) {
    this.sessionId = options.sessionId;
    this.auditSink = options.auditSink;
    this.writeMode = options.writeMode ?? resolveTrajectoryWriteMode();
    this.outputPath = join(
      options.projectRoot,
      "workspaces",
      options.workspaceId,
      "novelos-sessions",
      options.sessionId,
      "trajectory.jsonl",
    );
    this.persist = options.persist ?? true;
    this.contentStore =
      options.contentStore ??
      (this.writeMode === "projection"
        ? createTrajectoryContentStore({
            projectRoot: options.projectRoot,
            workspaceId: options.workspaceId,
            sessionId: options.sessionId,
          })
        : undefined);
  }

  /** 落盘路径（legacy trajectory.jsonl；projection 模式下为可重建投影缓存） */
  getOutputPath(): string {
    return this.outputPath;
  }

  /**
   * 完整轨迹明细路径（P7 Stage D）。
   *
   * projection 模式下，完整明细（message/tool_event/ranked_evidence 等）只存在于
   * 独立内容库 trajectory-content.jsonl；legacy 模式下完整明细仍在 trajectory.jsonl。
   * 生产消费方（must-verify coverage gate）与 eval 回放读点一律读此路径，保证
   * 「旧 trajectory.jsonl 收敛为摘要投影缓存」后明细仍可读、不丢失。
   */
  getDetailOutputPath(): string {
    return this.writeMode === "projection" && this.contentStore
      ? this.contentStore.getOutputPath()
      : this.outputPath;
  }

  recordSessionStart(session: unknown): void {
    this.push("session_start", session);
  }

  recordSessionEnd(session: unknown): void {
    this.push("session_end", session);
  }

  recordMessage(message: AgentMessage): void {
    this.push("message", message);
  }

  recordToolEvent(event: AgentEvent): void {
    this.push("tool_event", event);
  }

  recordCheckpoint(checkpoint: NovelSessionCheckpoint): void {
    this.push("checkpoint", checkpoint);
  }

  recordOutput(output: unknown): void {
    this.push("output", output);
  }

  recordFailure(envelope: TrajectoryFailureEnvelope): void {
    this.push("failure", envelope);
  }

  recordBudget(snapshot: BudgetSnapshot): void {
    this.push("budget", snapshot);
  }

  recordEvidencePlan(plan: unknown): void {
    this.push("evidence_plan", plan);
  }

  /** 记录 verifier 验证报告（Task B.1） */
  recordVerifierReport(report: unknown): void {
    this.push("verifier_report", report);
  }

  /** 记录 patch proposal（Task B.1） */
  recordPatchProposal(proposal: unknown): void {
    this.push("patch_proposal", proposal);
  }

  /** 记录修复轮次信息（Task B.1） */
  recordRepairRound(round: unknown): void {
    this.push("repair_round", round);
  }

  /** 记录 ranked evidence（agent 通过 search_narrative_evidence 工具看到的排序证据，P0-1） */
  recordRankedEvidence(evidence: unknown): void {
    this.push("ranked_evidence", evidence);
  }

  /**
   * 记录本会话工具可见性快照（systemAllowedTools / visibleTools）。
   * 用于观测"模型能看到什么、系统允许什么、最终注入什么"三者是否一致。
   * AGENTIC-EVIDENCE-MERGE-1 后不再记录模型决策的 selectedTools / rejectedTools。
   */
  recordToolVisibility(visibility: unknown): void {
    this.push("tool_visibility", visibility);
  }

  /**
   * Phase 0：记录单次工具调用指标（latency / 字符数 / evidenceLevel / sourceRef / 空结果 / 超时 / 异常 / 重复 query）。
   */
  recordToolCallMetrics(metrics: unknown): void {
    this.push("tool_call_metrics", metrics);
  }

  getEntries(): TrajectoryEntry[] {
    return [...this.entries];
  }

  /** 原子写入（临时文件 → rename） */
  async flush(): Promise<void> {
    if (!this.persist || this.entries.length === 0) return;
    const dir = dirname(this.outputPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (this.writeMode === "projection") {
      // P7 Stage D：projection 模式把完整轨迹明细写入独立内容库（权威明细）；
      // 旧 trajectory.jsonl 最终收敛为可重建投影缓存（flush 摘要），不再承载完整明细。
      // 生产消费方（must-verify coverage gate）与 eval 回放读点改读 getDetailOutputPath()。
      const contentOk = this.contentStore?.writeAll(this.entries) ?? true;
      if (!contentOk) {
        // 内容库写失败 → 完整明细回退进旧 trajectory.jsonl（不丢 message/tool 明细）。
        this.emitContentStoreWriteFailed();
        this.writeFullLegacyFile();
      } else {
        this.writeSummaryProjectionCache();
      }
    } else {
      this.writeFullLegacyFile();
    }
    // P7 Stage A 双写：trajectory.jsonl 落盘后向审计流追加 trajectory_flushed。
    this.emitTrajectoryFlushed(this.entries.length);
  }

  /** 完整轨迹明细写旧 trajectory.jsonl（legacy 模式 / 内容库失败回退）。 */
  private writeFullLegacyFile(): void {
    const content = this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const tmp = this.outputPath + ".tmp";
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, this.outputPath);
  }

  /**
   * P7 Stage D：projection 模式下旧 trajectory.jsonl 收敛为可重建投影缓存。
   *
   * 缓存内容 == rebuildTrajectoryFromEvents 可重建的 flush 摘要（sessionId /
   * entryCount / failureCount / outputPath），与审计流 trajectory_flushed 事件
   * payload 一致；完整明细只在内容库 trajectory-content.jsonl。
   */
  private writeSummaryProjectionCache(): void {
    const summary = {
      schemaVersion: 1,
      type: "trajectory_flush_summary",
      sessionId: this.sessionId,
      entryCount: this.entries.length,
      failureCount: this.entries.filter((e) => e.type === "failure").length,
      outputPath: this.outputPath,
    };
    const tmp = this.outputPath + ".tmp";
    writeFileSync(tmp, `${JSON.stringify(summary)}\n`, "utf-8");
    renameSync(tmp, this.outputPath);
  }

  /**
   * P7 Stage A 双写：在 trajectory.jsonl 落盘后追加 trajectory_flushed 事件。
   * eventId 单调绑定 entryCount，重复 flush（同 entryCount）不重复发射；写失败不抛。
   */
  private emitTrajectoryFlushed(entryCount: number): void {
    if (!this.auditSink?.recordEvent) return;
    if (entryCount <= this.lastFlushedEntryCount) return;
    this.lastFlushedEntryCount = entryCount;
    try {
      this.auditSink.recordEvent({
        eventType: "custom",
        eventId: `trajectoryFlushed:${this.sessionId}:${entryCount}`,
        stage: "agentic",
        status: "completed",
        decisionReason: "NovelOS trajectory flushed",
        payload: {
          eventTypeHint: "trajectory_flushed",
          sessionId: this.sessionId,
          entryCount,
          failureCount: this.entries.filter((e) => e.type === "failure").length,
          outputPath: this.outputPath,
        },
      });
    } catch {
      // 审计事件追加失败不阻断 trajectory 写入主路径
    }
  }

  /**
   * P7 Stage C-3 双写：内容库写失败时发射非静默审计信号，避免「完整轨迹明细未进
   * 内容库」无迹可寻。完整明细已回退进旧 trajectory.jsonl（见 flush 的全量写），
   * 本事件仅作可观测告警（eventTypeHint=trajectory_content_store_write_failed）。
   * 发射侧去重：同一 session 只发射一次。
   */
  private emitContentStoreWriteFailed(): void {
    if (!this.auditSink?.recordEvent) return;
    if (this.emittedContentStoreFailure) return;
    this.emittedContentStoreFailure = true;
    try {
      this.auditSink.recordEvent({
        eventType: "custom",
        eventId: `trajectoryContentStoreWriteFailed:${this.sessionId}`,
        stage: "agentic",
        status: "failed",
        decisionReason: "trajectory 内容库写失败，完整明细已回退进旧 trajectory.jsonl",
        payload: {
          eventTypeHint: "trajectory_content_store_write_failed",
          sessionId: this.sessionId,
        },
      });
    } catch {
      // 审计事件追加失败不阻断 trajectory 写入主路径
    }
  }

  private push(type: TrajectoryEntryType, data: unknown): void {
    this.entries.push({ type, timestamp: Date.now(), data });
  }
}
