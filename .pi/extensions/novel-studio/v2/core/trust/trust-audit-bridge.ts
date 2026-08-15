/**
 * TRUST-AUDIT-BRIDGE — 将 TrustAuditEvent 写入统一 AuditEventStore
 * （PROMPT-INJECTION-TRUST-ARCHITECTURE-1 生产闭包 + 并发隔离）
 *
 * 规则：
 * - 每个 run 注册独立 sink（key=runId），禁止进程级单例覆盖
 * - sink 只接受本 run / 本 workspace 的事件，拒绝串写
 * - 无匹配 run 时写入 workspaces/{id}/traces/trust-audit/events.jsonl
 * - sink 失败不得阻断业务主路径
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AuditEvent } from "../audit/audit-event-types.js";
import type { AuditEventStore } from "../audit/audit-event-store.js";
import {
  emitTrustAuditEvent,
  getTrustAuditRunContext,
  registerTrustAuditSink,
  type TrustAuditEvent,
  type TrustAuditSink,
} from "./trust-audit.js";

export interface TrustAuditBridgeOptions {
  /** 活跃 run 的事件存储（优先） */
  store?: AuditEventStore | null;
  /** 显式 runId（无 store 时用于 registry key） */
  runId?: string;
  /** 绑定 workspace；事件 workspaceId 不匹配则拒绝写入本 store */
  workspaceId?: string;
  /** 绑定 chapter（可选，进一步过滤） */
  chapterId?: string;
  /** 无 store 时的落盘根 */
  projectRoot?: string;
  /**
   * RUN-LIFECYCLE：store.append 成功后必须同步折叠 RunAggregate。
   * 不传则只写事件流（会导致 sequence 与聚合漂移 → foldError 误阻断提交）。
   */
  onEventAppended?: (event: AuditEvent) => void;
}

function mapStatus(
  allowed: boolean,
  decisionType: TrustAuditEvent["decisionType"],
): "completed" | "denied" | "blocked" {
  if (allowed) return "completed";
  if (
    decisionType === "hard_gate_block" ||
    decisionType === "state_commit_rejection" ||
    decisionType === "approval_invalidation"
  ) {
    return "blocked";
  }
  return "denied";
}

function appendStandaloneJsonl(
  projectRoot: string,
  workspaceId: string,
  event: TrustAuditEvent,
): void {
  const path = join(
    projectRoot,
    "workspaces",
    workspaceId,
    "traces",
    "trust-audit",
    "events.jsonl",
  );
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
}

/**
 * 判断事件是否应写入本 bridge 绑定的 store。
 *
 * 并发隔离核心（2026-08-13 复核修复）：
 * 1. 事件自身标识优先：event.runId / workspaceId / chapterId 与 binding 冲突 → 拒绝
 * 2. ALS 上下文必须与 binding 一致
 * 3. ALS 与 event 同时存在时必须一致（防 ALS 内伪造异 run 标签）
 * 4. 无 ALS 时仅按 event 自带标识匹配；标识不足 → 拒绝写入 store
 */
export function shouldAcceptTrustEventForBridge(
  event: TrustAuditEvent,
  binding: {
    runId?: string;
    workspaceId?: string;
    chapterId?: string;
  },
): boolean {
  const ctx = getTrustAuditRunContext();

  // ── 事件自身标识硬过滤（无论 ALS 是否存在）──
  if (binding.runId && event.runId && event.runId !== binding.runId) {
    return false;
  }
  if (
    binding.workspaceId &&
    event.workspaceId &&
    event.workspaceId !== binding.workspaceId
  ) {
    return false;
  }
  if (
    binding.chapterId &&
    event.chapterId &&
    event.chapterId !== binding.chapterId
  ) {
    return false;
  }

  // ── ALS 存在：必须与 binding 一致，且不得与 event 标签冲突 ──
  if (ctx?.runId) {
    if (binding.runId && ctx.runId !== binding.runId) return false;
    if (
      binding.workspaceId &&
      ctx.workspaceId &&
      ctx.workspaceId !== binding.workspaceId
    ) {
      return false;
    }
    // ALS 与 event 标签冲突（在 A 上下文伪造 B 标签）→ 拒绝
    if (event.runId && event.runId !== ctx.runId) return false;
    if (
      event.workspaceId &&
      ctx.workspaceId &&
      event.workspaceId !== ctx.workspaceId
    ) {
      return false;
    }
    if (
      event.chapterId &&
      ctx.chapterId &&
      event.chapterId !== ctx.chapterId
    ) {
      return false;
    }
    // ALS 匹配 binding，且 event 未声明冲突标识 → 接受
    return true;
  }

  // ── 无 ALS：必须有 event 自带标识匹配 binding ──
  if (binding.runId) {
    // 有 binding.runId 时要求 event.runId 精确匹配（已在上方校验一致）
    if (!event.runId) return false;
    return event.runId === binding.runId;
  }

  if (binding.workspaceId) {
    if (!event.workspaceId) return false;
    return event.workspaceId === binding.workspaceId;
  }

  // binding 无 run/workspace：无法安全归属 → 拒绝
  return false;
}

/**
 * 安装生产 TrustAudit sink（按 run 隔离注册）。
 * 返回卸载函数。
 */
export function installTrustAuditBridge(
  options: TrustAuditBridgeOptions = {},
): () => void {
  const runId = options.store?.runId ?? options.runId;
  const workspaceId = options.workspaceId;
  const chapterId = options.chapterId;
  const sinkKey =
    runId?.trim() ||
    `standalone:${workspaceId ?? "na"}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

  const binding = { runId, workspaceId, chapterId };

  const sink: TrustAuditSink = (event) => {
    if (!shouldAcceptTrustEventForBridge(event, binding)) {
      return;
    }

    const status = mapStatus(event.allowed, event.decisionType);
    const payload: Record<string, unknown> = {
      eventTypeHint: "trust_decision",
      trustSchema: event.schema,
      trustVersion: event.version,
      trustEventId: event.eventId,
      decisionType: event.decisionType,
      allowed: event.allowed,
      trustClass: event.trustClass ?? null,
      slot: event.slot ?? null,
      workspaceId: event.workspaceId ?? null,
      chapterId: event.chapterId ?? null,
      taskId: event.taskId ?? null,
      runId: event.runId ?? runId ?? null,
      hashes: event.hashes ?? null,
      evidence: event.evidence ?? null,
      trustTimestamp: event.timestamp,
    };

    // 1) 写入绑定的 AuditEventStore
    if (options.store) {
      try {
        const { event: appended } = options.store.append({
          actor: "system",
          stage: "gate",
          eventType: "custom",
          status,
          evidenceLevel: "observed",
          decisionReason: event.reason,
          capability: "governance",
          payload,
        });
        // 硬规则：每次 append 必须 fold，否则 RunAggregate.lastSequence 落后于事件流
        try {
          options.onEventAppended?.(appended);
        } catch {
          // fold 失败不得阻断 trust sink；由 session.foldError 暴露
        }
        return;
      } catch {
        // store 未 start / write-error 时降级 standalone
      }
    }

    // 2) 独立 JSONL
    const ws = event.workspaceId ?? workspaceId;
    const root = options.projectRoot;
    if (root && ws) {
      try {
        appendStandaloneJsonl(root, ws, event);
      } catch {
        // sink 失败不阻断
      }
    }
  };

  return registerTrustAuditSink(sinkKey, sink);
}

/**
 * 从 AuditEventStore 安装桥（生成 run 期间）。
 */
export function installTrustAuditBridgeFromStore(
  store: AuditEventStore,
  meta?: {
    projectRoot?: string;
    workspaceId?: string;
    chapterId?: string;
    onEventAppended?: (event: AuditEvent) => void;
  },
): () => void {
  return installTrustAuditBridge({
    store,
    runId: store.runId,
    projectRoot: meta?.projectRoot,
    workspaceId: meta?.workspaceId,
    chapterId: meta?.chapterId,
    onEventAppended: meta?.onEventAppended,
  });
}

/** 读取独立 trust-audit JSONL（测试/验收） */
export function readStandaloneTrustAuditEvents(
  projectRoot: string,
  workspaceId: string,
): TrustAuditEvent[] {
  const path = join(
    projectRoot,
    "workspaces",
    workspaceId,
    "traces",
    "trust-audit",
    "events.jsonl",
  );
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out: TrustAuditEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as TrustAuditEvent);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

/** 便捷：发事件并确保若已装桥则落盘 */
export function emitAndBridgeTrustDecision(
  input: Parameters<typeof emitTrustAuditEvent>[0],
): TrustAuditEvent {
  return emitTrustAuditEvent(input);
}
