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

/** 失败信封（与编排器 FailureEnvelope 归一） */
export interface TrajectoryFailureEnvelope {
  stage: string;
  severity: "preflight" | "soft" | "hard" | "fatal";
  reason: string;
  evidence?: unknown;
  recoverable: boolean;
  retryPlan?: string;
  userActionRequired?: boolean;
}

/** Trajectory 条目类型 */
export type TrajectoryEntryType =
  | "session_start"
  | "session_end"
  | "message"
  | "tool_event"
  | "context_decision"
  | "checkpoint"
  | "output"
  | "failure"
  | "budget"
  | "evidence_plan"
  | "verifier_report"
  | "patch_proposal"
  | "repair_round"
  | "ranked_evidence";

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
}

export class TrajectoryStore {
  private readonly entries: TrajectoryEntry[] = [];
  private readonly outputPath: string;
  private readonly persist: boolean;

  constructor(options: TrajectoryStoreOptions) {
    this.outputPath = join(
      options.projectRoot,
      "workspaces",
      options.workspaceId,
      "novelos-sessions",
      options.sessionId,
      "trajectory.jsonl",
    );
    this.persist = options.persist ?? true;
  }

  /** 落盘路径（供回放脚本读取） */
  getOutputPath(): string {
    return this.outputPath;
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

  recordContextDecision(decision: unknown): void {
    this.push("context_decision", decision);
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
    const content = this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const tmp = this.outputPath + ".tmp";
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, this.outputPath);
  }

  private push(type: TrajectoryEntryType, data: unknown): void {
    this.entries.push({ type, timestamp: Date.now(), data });
  }
}
