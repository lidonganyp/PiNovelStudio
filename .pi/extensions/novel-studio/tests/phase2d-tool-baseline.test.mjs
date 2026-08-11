/**
 * Phase 0：工具基线盘点与观测测试
 *
 * 验收口径（用户 Phase 0 边界）：
 * - 每个叙事工具登记能力域 / 必填输入 / 默认返回数 / 最大返回数 / 预计 token /
 *   evidenceLevel / sourceRef 规则 / timeout / 全量返回风险 / 空与失败语义
 * - 记录工具可见性快照（systemAllowedTools / selectedTools / rejectedTools / visibleTools）
 * - 记录单次工具调用指标（latency / 字符数 / evidenceLevel / sourceRef / 空结果 / 超时 / 异常 / 重复 query）
 *
 * 测试策略：
 * 1. TOOL_CAPABILITIES 覆盖全部 9 个工具，字段完整且域在枚举内
 * 2. ToolCallMetricsTracer 纯函数：start/end 匹配、latency、sourceRef 提取、重复 query、snapshot 汇总
 * 3. 源码静态检查：candidate-source 接线 recordToolVisibility + attachToolMetricsTracer，
 *    trajectory-store 提供 tool_visibility / tool_call_metrics 条目类型
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TOOL_CAPABILITIES,
  listToolCapabilities,
} from "../dist-test/novelos/tools/tool-capability.js";
import {
  createToolVisibilitySnapshot,
  ToolCallMetricsTracer,
  attachToolMetricsTracer,
} from "../dist-test/novelos/trajectory/tool-metrics-tracer.js";
import { NARRATIVE_TOOL_NAMES } from "../dist-test/novelos/tools/narrative-tools.js";

const SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

// ============================================================================
// 1. 工具能力清单覆盖
// ============================================================================

const ALL_TOOLS = [...NARRATIVE_TOOL_NAMES];

test("Phase 0 · TOOL_CAPABILITIES 覆盖全部 9 个叙事工具", () => {
  for (const name of ALL_TOOLS) {
    assert.ok(TOOL_CAPABILITIES[name], `缺少能力登记：${name}`);
  }
  assert.equal(listToolCapabilities().length, ALL_TOOLS.length);
});

test("Phase 0 · 每个工具能力字段完整且在合法域内", () => {
  const domains = new Set([
    "canon", "character", "timeline", "promise", "pattern", "voice", "span", "evidence",
  ]);
  const evLevels = new Set([
    "confirmed_state", "exact_chapter_span", "confirmed", "inferred", "profile_only",
  ]);
  for (const cap of Object.values(TOOL_CAPABILITIES)) {
    assert.ok(cap.name, "name 必填");
    assert.ok(domains.has(cap.domain), `非法 domain：${cap.name}=${cap.domain}`);
    assert.ok(Array.isArray(cap.requiredInputs), `${cap.name} requiredInputs 应为数组`);
    assert.ok(Array.isArray(cap.optionalInputs), `${cap.name} optionalInputs 应为数组`);
    assert.equal(typeof cap.defaultReturnCount, "number", `${cap.name} defaultReturnCount`);
    assert.ok(cap.maxReturnCount === null || typeof cap.maxReturnCount === "number", `${cap.name} maxReturnCount`);
    assert.equal(typeof cap.estimatedResponseTokens, "number", `${cap.name} estimatedResponseTokens`);
    assert.ok(evLevels.has(cap.evidenceLevel), `非法 evidenceLevel：${cap.name}=${cap.evidenceLevel}`);
    assert.equal(typeof cap.sourceRefRule, "string", `${cap.name} sourceRefRule`);
    assert.equal(typeof cap.timeoutMs, "number", `${cap.name} timeoutMs`);
    assert.equal(typeof cap.canReturnFullData, "boolean", `${cap.name} canReturnFullData`);
    assert.equal(typeof cap.emptyResultSemantics, "string", `${cap.name} emptyResultSemantics`);
    assert.equal(typeof cap.failureSemantics, "string", `${cap.name} failureSemantics`);
  }
});

test("Phase 0 · 全量返回风险工具被正确标记（缺省参数可能返回宽结果）", () => {
  // query_character_state 未指定 characterId 时返回全部角色状态（有界上限 DEFAULT_LIST_LIMIT=50）
  assert.equal(TOOL_CAPABILITIES.query_character_state.canReturnFullData, false);
  assert.equal(TOOL_CAPABILITIES.query_character_state.maxReturnCount, 50);
  // search_narrative_evidence 有明确上限，不返回全量
  assert.equal(TOOL_CAPABILITIES.search_narrative_evidence.canReturnFullData, false);
  assert.ok(TOOL_CAPABILITIES.search_narrative_evidence.maxReturnCount > 0);
});

// ============================================================================
// 2. 可见性快照
// ============================================================================

test("Phase 0 · createToolVisibilitySnapshot 固化四视角且不共享引用", () => {
  const src = {
    systemAllowedTools: ["a", "b"],
    selectedTools: ["a"],
    rejectedTools: ["c"],
    visibleTools: ["a", "b"],
  };
  const snap = createToolVisibilitySnapshot(src);
  assert.deepEqual(snap.systemAllowedTools, ["a", "b"]);
  assert.deepEqual(snap.selectedTools, ["a"]);
  assert.deepEqual(snap.rejectedTools, ["c"]);
  assert.deepEqual(snap.visibleTools, ["a", "b"]);
  // 快照不共享引用（拷贝）
  src.visibleTools.push("x");
  assert.deepEqual(snap.visibleTools, ["a", "b"]);
});

// ============================================================================
// 3. 工具调用指标追踪器
// ============================================================================

function makeEndEvent(overrides) {
  return {
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "search_narrative_evidence",
    isError: false,
    result: {
      content: [
        { type: "text", text: "证据正文" },
        { type: "text", text: "补充" },
      ],
      details: {
        evidenceLevel: "confirmed",
        sourceRef: "ch3:span:12",
        rankedEvidences: [
          { sourceRef: "ch5:span:3" },
          { sourceRef: "ch3:span:12" },
        ],
      },
    },
    ...overrides,
  };
}

test("Phase 0 · tracer 按 toolCallId 匹配 start/end 计算 latency 与结果规模", () => {
  const tracer = new ToolCallMetricsTracer();
  tracer.start("call_1", "search_narrative_evidence", { query: "林默伤势" });
  const metrics = tracer.end("call_1", makeEndEvent({}));
  assert.equal(metrics.toolName, "search_narrative_evidence");
  assert.equal(metrics.resultChars, "证据正文补充".length);
  assert.equal(metrics.estimateTokens, Math.ceil("证据正文补充".length / 2));
  assert.equal(metrics.evidenceLevel, "confirmed");
  assert.equal(metrics.empty, false);
  assert.equal(metrics.isError, false);
  assert.equal(metrics.timeout, false);
});

test("Phase 0 · tracer 提取去重 sourceRef 列表", () => {
  const tracer = new ToolCallMetricsTracer();
  tracer.start("call_1", "search_narrative_evidence", { query: "x" });
  const metrics = tracer.end("call_1", makeEndEvent({}));
  // ch3:span:12 同时出现在主 sourceRef 与 rankedEvidences，去重后应为 2
  assert.deepEqual(metrics.sourceRefs.sort(), ["ch3:span:12", "ch5:span:3"].sort());
  assert.equal(metrics.sourceRefCount, 2);
});

test("Phase 0 · tracer 标记空结果与错误/超时", () => {
  const tracer = new ToolCallMetricsTracer();
  // 空结果
  tracer.start("call_1", "query_canon", {});
  const empty = tracer.end("call_1", makeEndEvent({
    result: { content: [], details: { evidenceLevel: "inferred", sourceRef: "canon:empty" } },
  }));
  assert.equal(empty.empty, true);
  assert.equal(empty.evidenceLevel, "inferred");

  // 错误 + 超时文本
  tracer.start("call_2", "search_narrative_evidence", { query: "y" });
  const err = tracer.end("call_2", makeEndEvent({
    isError: true,
    result: { content: [{ type: "text", text: "request timed out" }], details: {} },
  }));
  assert.equal(err.isError, true);
  assert.equal(err.timeout, true);
});

test("Phase 0 · tracer 检测同一 query 重复调用", () => {
  const tracer = new ToolCallMetricsTracer();
  for (let i = 0; i < 2; i++) {
    tracer.start(`call_${i}`, "search_narrative_evidence", { query: "重复查询" });
  }
  const first = tracer.end("call_0", makeEndEvent({ toolCallId: "call_0" }));
  const second = tracer.end("call_1", makeEndEvent({ toolCallId: "call_1" }));
  assert.equal(first.duplicateQuery, false);
  assert.equal(first.queryCount, 1);
  assert.equal(second.duplicateQuery, true);
  assert.equal(second.queryCount, 2);
});

test("Phase 0 · tracer snapshot 汇总统计", () => {
  const tracer = new ToolCallMetricsTracer();
  tracer.start("call_0", "search_narrative_evidence", { query: "q1" });
  tracer.end("call_0", makeEndEvent({ toolCallId: "call_0" }));
  tracer.start("call_1", "search_narrative_evidence", { query: "q1" });
  tracer.end("call_1", makeEndEvent({ toolCallId: "call_1", isError: true,
    result: { content: [{ type: "text", text: "timeout" }], details: {} } }));
  tracer.start("call_2", "query_canon", {});
  tracer.end("call_2", makeEndEvent({ toolCallId: "call_2", toolName: "query_canon",
    result: { content: [], details: { evidenceLevel: "inferred", sourceRef: "canon:empty" } } }));

  const s = tracer.snapshot();
  assert.equal(s.totalCalls, 3);
  assert.equal(s.callsByTool.search_narrative_evidence, 2);
  assert.equal(s.callsByTool.query_canon, 1);
  assert.equal(s.duplicateQueries, 1);
  assert.equal(s.timeouts, 1);
  assert.equal(s.errors, 1);
  assert.equal(s.emptyResults, 1);
});

test("Phase 0 · attachToolMetricsTracer 返回 unsubscribe 且写入 trajectory", () => {
  const tracer = new ToolCallMetricsTracer();
  const recorded = [];
  const fakeRuntime = {
    subscribe(fn) {
      this._fn = fn;
      return () => { this._fn = null; };
    },
    emit(ev) { this._fn?.(ev); },
  };
  const fakeTrajectory = {
    recordToolCallMetrics(m) { recorded.push(m); },
  };
  const unsubscribe = attachToolMetricsTracer({
    runtime: fakeRuntime,
    trajectory: fakeTrajectory,
    tracer,
  });

  fakeRuntime.emit(makeEndEvent({ toolCallId: "call_1", toolName: "search_narrative_evidence",
    result: { content: [{ type: "text", text: "证据" }], details: { evidenceLevel: "confirmed" } } }));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].toolName, "search_narrative_evidence");

  // unsubscribe 后不再写入
  unsubscribe();
  fakeRuntime.emit(makeEndEvent({ toolCallId: "call_2", toolName: "query_canon" }));
  assert.equal(recorded.length, 1);
});

// ============================================================================
// 4. 源码接线静态检查
// ============================================================================

test("Phase 0 · candidate-source 接线 recordToolVisibility + attachToolMetricsTracer", () => {
  const src = readFileSync(join(SOURCE_DIR, "novelos/agent/agentic-raw-candidate-source.ts"), "utf8");
  assert.match(src, /createToolVisibilitySnapshot/, "应调用 createToolVisibilitySnapshot");
  assert.match(src, /recordToolVisibility\(/, "应调用 recordToolVisibility");
  assert.match(src, /attachToolMetricsTracer\(/, "应调用 attachToolMetricsTracer");
  assert.match(src, /unsubscribeMetrics\(\)/, "loop 结束后应卸载 tracer");
});

test("Phase 0 · trajectory-store 提供 tool_visibility / tool_call_metrics 条目类型", () => {
  const src = readFileSync(join(SOURCE_DIR, "novelos/trajectory/trajectory-store.ts"), "utf8");
  assert.match(src, /"tool_visibility"/, "应含 tool_visibility 条目类型");
  assert.match(src, /"tool_call_metrics"/, "应含 tool_call_metrics 条目类型");
  assert.match(src, /recordToolVisibility\(/, "应提供 recordToolVisibility 方法");
  assert.match(src, /recordToolCallMetrics\(/, "应提供 recordToolCallMetrics 方法");
});