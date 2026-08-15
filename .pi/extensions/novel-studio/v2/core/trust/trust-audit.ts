/**
 * TRUST-AUDIT — 信任决策审计事件
 * （PROMPT-INJECTION-TRUST-ARCHITECTURE-1 Phase 7 + 并发隔离修复）
 *
 * 为每次信任判断写入可串联的审计记录。
 * 不记录思维链；不把模型自述当事实。
 *
 * 并发隔离（2026-08-13）：
 * - 支持多 sink 注册表（按 runId 隔离），禁止进程级单例覆盖
 * - AsyncLocalStorage 绑定当前 run，emit 时自动附带 runId/workspaceId
 * - 旧 setTrustAuditSink 仍可用，但与 registry 并存且不再互斥覆盖
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import type { ContentSlot, TrustClass } from "./trust-types.js";

export type TrustAuditDecisionType =
  | "context_compile"
  | "source_promotion"
  | "source_rejection"
  | "tool_authorization"
  | "tool_denial"
  | "tool_result_consume"
  | "fact_verification"
  | "candidate_revision"
  | "approval_invalidation"
  | "state_commit"
  | "state_commit_rejection"
  | "feedback_isolation"
  | "review_degrade"
  | "model_claim_ignored"
  | "hard_gate_block";

export interface TrustAuditEvent {
  eventId: string;
  schema: "pinovel.trust-audit-event";
  version: "1.0";
  timestamp: string;
  decisionType: TrustAuditDecisionType;
  allowed: boolean;
  reason: string;
  trustClass?: TrustClass;
  slot?: ContentSlot;
  workspaceId?: string;
  chapterId?: string;
  taskId?: string;
  traceId?: string;
  /** 绑定的生产 run（并发隔离主键） */
  runId?: string;
  /** 相关 hash（artifact/context/content） */
  hashes?: Record<string, string>;
  /** 结构化证据（非正文） */
  evidence?: Record<string, unknown>;
}

export type TrustAuditSink = (event: TrustAuditEvent) => void;

/** 当前异步调用链上的 run 上下文 */
export interface TrustAuditRunContext {
  runId: string;
  workspaceId?: string;
  chapterId?: string;
  traceId?: string;
  /** registry 中的 sink key */
  sinkKey: string;
}

const globalEvents: TrustAuditEvent[] = [];
/** @deprecated 兼容旧单 sink；新代码用 registerTrustAuditSink */
let legacySink: TrustAuditSink | null = null;
/** 按 run/bridge 隔离的多 sink 注册表 */
const sinkRegistry = new Map<string, TrustAuditSink>();
const runContextStorage = new AsyncLocalStorage<TrustAuditRunContext>();

export function setTrustAuditSink(sink: TrustAuditSink | null): void {
  legacySink = sink;
}

/**
 * 注册隔离 sink（key 通常为 runId）。
 * 返回卸载函数；卸载只移除自身 key，不影响其它并发 run。
 */
export function registerTrustAuditSink(
  key: string,
  sink: TrustAuditSink,
): () => void {
  if (!key?.trim()) {
    throw new Error("registerTrustAuditSink: key 必填");
  }
  sinkRegistry.set(key, sink);
  return () => {
    if (sinkRegistry.get(key) === sink) {
      sinkRegistry.delete(key);
    }
  };
}

/** 当前注册的 sink 数量（测试/诊断） */
export function getTrustAuditSinkCount(): number {
  return sinkRegistry.size + (legacySink ? 1 : 0);
}

/** 列出 registry keys（测试） */
export function listTrustAuditSinkKeys(): string[] {
  return [...sinkRegistry.keys()];
}

/**
 * 在指定 run 上下文中执行（AsyncLocalStorage）。
 * 编排器应在生成主路径外包一层，确保并发 run 互不串写。
 */
export function runWithTrustAuditContext<T>(
  ctx: TrustAuditRunContext,
  fn: () => T,
): T {
  return runContextStorage.run(ctx, fn);
}

export async function runWithTrustAuditContextAsync<T>(
  ctx: TrustAuditRunContext,
  fn: () => Promise<T>,
): Promise<T> {
  return runContextStorage.run(ctx, fn);
}

export function getTrustAuditRunContext(): TrustAuditRunContext | undefined {
  return runContextStorage.getStore();
}

export function getTrustAuditEvents(): ReadonlyArray<TrustAuditEvent> {
  return globalEvents;
}

export function clearTrustAuditEvents(): void {
  globalEvents.length = 0;
}

function newEventId(): string {
  return `trust-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function deliverToSinks(event: TrustAuditEvent): void {
  const ctx = runContextStorage.getStore();

  // 1) ALS 精确绑定：只投递给当前 run 的 sink
  if (ctx?.sinkKey && sinkRegistry.has(ctx.sinkKey)) {
    try {
      sinkRegistry.get(ctx.sinkKey)!(event);
    } catch {
      // sink 失败不影响信任裁决
    }
    // ALS 命中后仍允许 legacy sink 观测（测试），但不强制
    if (legacySink) {
      try {
        legacySink(event);
      } catch {
        // ignore
      }
    }
    return;
  }

  // 2) 无 ALS：按 workspaceId 过滤后投递；多匹配时不猜测 store，由各 sink 自行拒绝
  for (const [key, sink] of sinkRegistry) {
    try {
      sink(event);
    } catch {
      // ignore per-sink
    }
    void key;
  }

  if (legacySink) {
    try {
      legacySink(event);
    } catch {
      // ignore
    }
  }
}

export function emitTrustAuditEvent(
  input: Omit<TrustAuditEvent, "eventId" | "schema" | "version" | "timestamp"> & {
    timestamp?: string;
  },
): TrustAuditEvent {
  const ctx = runContextStorage.getStore();
  const event: TrustAuditEvent = {
    eventId: newEventId(),
    schema: "pinovel.trust-audit-event",
    version: "1.0",
    timestamp: input.timestamp ?? new Date().toISOString(),
    decisionType: input.decisionType,
    allowed: input.allowed,
    reason: input.reason,
    trustClass: input.trustClass,
    slot: input.slot,
    workspaceId: input.workspaceId ?? ctx?.workspaceId,
    chapterId: input.chapterId ?? ctx?.chapterId,
    taskId: input.taskId,
    traceId: input.traceId ?? ctx?.traceId,
    runId: input.runId ?? ctx?.runId,
    hashes: input.hashes,
    evidence: input.evidence,
  };
  globalEvents.push(event);
  deliverToSinks(event);
  return event;
}

/** 稳定内容 hash，供审计 hashes 字段 */
export function trustContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 信任决策审计覆盖率（测试/仪表盘） */
export function computeTrustAuditCoverage(input: {
  expectedDecisionTypes: readonly TrustAuditDecisionType[];
  events?: ReadonlyArray<TrustAuditEvent>;
}): {
  coverage: number;
  missing: TrustAuditDecisionType[];
  present: TrustAuditDecisionType[];
} {
  const events = input.events ?? globalEvents;
  const presentSet = new Set(events.map((e) => e.decisionType));
  const present = input.expectedDecisionTypes.filter((t) => presentSet.has(t));
  const missing = input.expectedDecisionTypes.filter((t) => !presentSet.has(t));
  const coverage =
    input.expectedDecisionTypes.length === 0
      ? 1
      : present.length / input.expectedDecisionTypes.length;
  return { coverage, missing, present };
}
