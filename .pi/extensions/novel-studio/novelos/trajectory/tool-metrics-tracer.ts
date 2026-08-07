/**
 * NovelOS 工具可见性与调用指标观测（Phase 0：工具基线盘点与观测）
 *
 * 目标：为"工具接口设计"的 Phase 0 建立可观测基线，回答：
 * - 模型能看到什么（visibleTools / systemAllowedTools / selectedTools / rejectedTools）
 * - 实际调用了什么（per-call latency / 返回字符数 / evidenceLevel / sourceRef 数量）
 * - 是否出现空结果 / 超时 / 异常 / 重复 query
 *
 * 设计：
 * - ToolVisibilitySnapshot：一次性可见性快照，由候选源在 decision round 后写入 trajectory。
 * - ToolCallMetricsTracer：订阅 runtime 事件流，按 toolCallId 匹配 tool_execution_start/end，
 *   计算每次调用的 latency / resultChars / estimateTokens / evidenceLevel / sourceRefs /
 *   empty / timeout / isError，并追踪重复 query（同一工具同一 query 多次调用）。
 * - attachToolMetricsTracer：把 tracer 挂到 runtime 并自动接线（返回 unsubscribe）。
 *
 * 本模块只做观测，不改变工具拓扑、不决定 winner、不触碰正文。
 * 所有指标确定性计算，可脱离模型单测。
 */

import type { AgentEvent } from "../adapters/pi-agent-core-adapter.js";
import type { NovelOSRuntime } from "../runtime/runtime.js";
import type { TrajectoryStore } from "./trajectory-store.js";
import type { EvidenceLevel } from "../tools/tool-protocol.js";

// ============================================================================
// 类型
// ============================================================================

/** 工具可见性快照（记录到 trajectory tool_visibility 条目） */
export interface ToolVisibilitySnapshot {
  /** 系统允许的能力边界（EvidenceDecision 前系统的 plan.allowedTools） */
  systemAllowedTools: string[];
  /** 模型在决策回合实际选择的工具（未过滤前） */
  selectedTools: string[];
  /** 模型请求但被系统拒绝的工具（不在 systemAllowedTools 内） */
  rejectedTools: string[];
  /** 最终注入 runtime 的可见工具名（模型能看到的 schema） */
  visibleTools: string[];
}

/** 单次工具调用指标（记录到 trajectory tool_call_metrics 条目） */
export interface ToolCallMetrics {
  toolName: string;
  toolCallId: string;
  /** 调用参数（query 等，用于重复检测与审计） */
  args: Record<string, unknown>;
  /** 调用耗时 ms */
  latencyMs: number;
  /** 返回文本总字符数 */
  resultChars: number;
  /** 估算 token（resultChars / 2，中文约 1.5-2 字/token） */
  estimateTokens: number;
  /** 主证据等级（从 result.details.evidenceLevel 提取） */
  evidenceLevel: EvidenceLevel | undefined;
  /** Phase 3：结果类型（从 result.details.resultKind 提取） */
  resultKind: string | undefined;
  /** Phase 3：本次返回的真实条目/span 数量 */
  returnedCount: number | undefined;
  /** Phase 3：结果是否被系统 limit 截断 */
  truncated: boolean | undefined;
  /** Phase 3：系统确定性生成的下一查询提示（无则 undefined） */
  nextQueryHint: string | undefined;
  /** 提取到的 sourceRef 列表（去重） */
  sourceRefs: string[];
  /** sourceRef 数量 */
  sourceRefCount: number;
  /** 空结果（无文本内容） */
  empty: boolean;
  /** 是否判定为超时（错误文本命中超时模式） */
  timeout: boolean;
  /** 是否为错误结果 */
  isError: boolean;
  /** 该 query 在本会话内是否重复（同工具同 query 第 2+ 次） */
  duplicateQuery: boolean;
  /** 该 query 在本会话内的累计出现次数 */
  queryCount: number;
}

/** 会话级工具观测汇总（供 baseline 诊断 / replay） */
export interface ToolObservationSummary {
  totalCalls: number;
  totalLatencyMs: number;
  emptyResults: number;
  timeouts: number;
  errors: number;
  duplicateQueries: number;
  /** 每个工具的总调用次数 */
  callsByTool: Record<string, number>;
  /** 已开始但未收到 end 的调用（异常中断/挂起） */
  inFlightCalls: number;
}

/** 构建可见性快照 */
export function createToolVisibilitySnapshot(parts: {
  systemAllowedTools: string[];
  selectedTools: string[];
  rejectedTools: string[];
  visibleTools: string[];
}): ToolVisibilitySnapshot {
  return {
    systemAllowedTools: [...parts.systemAllowedTools],
    selectedTools: [...parts.selectedTools],
    rejectedTools: [...parts.rejectedTools],
    visibleTools: [...parts.visibleTools],
  };
}

// ============================================================================
// 工具调用指标追踪器
// ============================================================================

/** 错误文本中超时模式（与 candidate-source 的 TIMEOUT_PATTERNS 对齐） */
const TIMEOUT_PATTERNS = [
  "timeout",
  "timed out",
  "超时",
  "aborted",
  "etimedout",
  "econnreset",
];

/** 从 result details 提取 sourceRef 列表（主 sourceRef + 数组型证据的 sourceRef） */
function collectSourceRefs(details: unknown): string[] {
  const refs = new Set<string>();
  if (!details || typeof details !== "object") return [];

  const d = details as Record<string, unknown>;

  const primary = d.sourceRef;
  if (typeof primary === "string" && primary.length > 0) refs.add(primary);

  // 数组型证据：rankedEvidences / spans / entries 等条目内含 sourceRef
  for (const key of ["rankedEvidences", "spans", "entries"]) {
    const arr = d[key];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (item && typeof item === "object") {
          const src = (item as Record<string, unknown>).sourceRef;
          if (typeof src === "string" && src.length > 0) refs.add(src);
        }
      }
    }
  }

  return [...refs];
}

/** 从 tool result 提取文本内容（拼接所有 text 块） */
function extractResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type: string; text: string } =>
        !!c && typeof c === "object"
        && (c as { type?: string }).type === "text"
        && typeof (c as { text?: unknown }).text === "string",
    )
    .map((c) => c.text)
    .join("");
}

/** 是否判定为超时错误文本 */
function isTimeoutText(text: string): boolean {
  const lower = text.toLowerCase();
  return TIMEOUT_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** 追踪器（确定性，可脱离模型单测） */
export class ToolCallMetricsTracer {
  private readonly pending = new Map<
    string,
    { toolName: string; args: Record<string, unknown>; startTs: number }
  >();
  private readonly calls: ToolCallMetrics[] = [];
  /** key = `${toolName}:${query}` → 累计出现次数 */
  private readonly queryCounts = new Map<string, number>();

  /** 记录一次工具调用开始 */
  start(toolCallId: string, toolName: string, args: unknown): void {
    const argObj =
      args && typeof args === "object"
        ? (args as Record<string, unknown>)
        : { _raw: args };
    this.pending.set(toolCallId, {
      toolName,
      args: argObj,
      startTs: Date.now(),
    });
  }

  /** 记录一次工具调用结束（缺失 start 时以 end 补齐，latency=0） */
  end(toolCallId: string, event: Extract<AgentEvent, { type: "tool_execution_end" }>): ToolCallMetrics {
    const started = this.pending.get(toolCallId);
    const toolName = event.toolName ?? started?.toolName ?? "unknown";
    const args = started?.args ?? {};
    const latencyMs =
      started !== undefined ? Math.max(0, Date.now() - started.startTs) : 0;
    if (started) this.pending.delete(toolCallId);

    const result = event.result;
    const resultText = extractResultText(result);
    const resultChars = resultText.length;
    const estimateTokens = Math.ceil(resultChars / 2);
    const details = (result as { details?: unknown } | undefined)?.details;
    const evidenceLevel =
      details && typeof details === "object"
        ? (details as { evidenceLevel?: EvidenceLevel }).evidenceLevel
        : undefined;
    const sourceRefs = collectSourceRefs(details);
    const resultKind =
      details && typeof details === "object"
        ? (details as { resultKind?: string }).resultKind
        : undefined;
    const returnedCount =
      details && typeof details === "object"
        ? (details as { returnedCount?: number }).returnedCount
        : undefined;
    const truncated =
      details && typeof details === "object"
        ? (details as { truncated?: boolean }).truncated
        : undefined;
    const nextQueryHint =
      details && typeof details === "object"
        ? (details as { nextQueryHint?: string | null }).nextQueryHint ?? undefined
        : undefined;
    const empty = resultChars === 0 && !event.isError;
    const timeout = event.isError && isTimeoutText(resultText);
    const isError = event.isError;

    const query = typeof args.query === "string" ? args.query : "";
    // 重复检测的语义查询身份：typed facade 场景所有调用工具名相同（query_narrative），
    // 若用 toolName 会导致不同结构化查询（canon/character_state/timeline 等）互相挤占 dupKey。
    // 因此优先用 intent（facade 的语义查询身份）作 scope；非 facade 调用无 intent，回退 toolName。
    const scope = typeof args.intent === "string" && args.intent.length > 0 ? args.intent : toolName;
    const dupKey = query ? `${scope}:${query}` : `${scope}:`;
    const queryCount = (this.queryCounts.get(dupKey) ?? 0) + 1;
    this.queryCounts.set(dupKey, queryCount);
    const duplicateQuery = queryCount > 1;

    const metrics: ToolCallMetrics = {
      toolName,
      toolCallId,
      args,
      latencyMs,
      resultChars,
      estimateTokens,
      evidenceLevel,
      sourceRefs,
      sourceRefCount: sourceRefs.length,
      resultKind,
      returnedCount,
      truncated,
      nextQueryHint,
      empty,
      timeout,
      isError,
      duplicateQuery,
      queryCount,
    };
    this.calls.push(metrics);
    return metrics;
  }

  /** 处理单个 AgentEvent（start/end）。end 事件返回本次指标，否则返回 undefined。 */
  handle(event: AgentEvent): ToolCallMetrics | undefined {
    switch (event.type) {
      case "tool_execution_start":
        this.start(event.toolCallId, event.toolName, event.args);
        return undefined;
      case "tool_execution_end":
        return this.end(event.toolCallId, event);
      default:
        return undefined;
    }
  }

  /** 已完成的调用列表 */
  getCalls(): ToolCallMetrics[] {
    return [...this.calls];
  }

  /** 会话级汇总 */
  snapshot(): ToolObservationSummary {
    const callsByTool: Record<string, number> = {};
    let totalLatencyMs = 0;
    let emptyResults = 0;
    let timeouts = 0;
    let errors = 0;
    let duplicateQueries = 0;
    for (const call of this.calls) {
      totalLatencyMs += call.latencyMs;
      callsByTool[call.toolName] = (callsByTool[call.toolName] ?? 0) + 1;
      if (call.empty) emptyResults++;
      if (call.timeout) timeouts++;
      if (call.isError) errors++;
      if (call.duplicateQuery) duplicateQueries++;
    }
    return {
      totalCalls: this.calls.length,
      totalLatencyMs,
      emptyResults,
      timeouts,
      errors,
      duplicateQueries,
      callsByTool,
      inFlightCalls: this.pending.size,
    };
  }
}

// ============================================================================
// 挂载辅助
// ============================================================================

/**
 * 把 ToolCallMetricsTracer 挂到 runtime 事件流，并自动把每次调用指标写入 trajectory。
 *
 * @returns unsubscribe 函数（挂在 source 清理时调用）
 */
export function attachToolMetricsTracer(options: {
  runtime: NovelOSRuntime;
  trajectory: TrajectoryStore;
  tracer?: ToolCallMetricsTracer;
}): () => void {
  const active = options.tracer ?? new ToolCallMetricsTracer();
  const unsubscribe = options.runtime.subscribe((event: AgentEvent) => {
    const metrics = active.handle(event);
    if (metrics) {
      options.trajectory.recordToolCallMetrics(metrics);
    }
  });
  return unsubscribe;
}

/** 生成 tool_visibility trace 条目的便捷函数 */
export function recordToolVisibility(
  trajectory: TrajectoryStore,
  snapshot: ToolVisibilitySnapshot,
): void {
  trajectory.recordToolVisibility(snapshot);
}