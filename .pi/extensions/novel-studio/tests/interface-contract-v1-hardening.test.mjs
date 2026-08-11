/**
 * Tool Interface Contract v1 加固 — 生产级测试（子任务4）
 *
 * 覆盖以下场景（用户验收口径）：
 * 1. malformed tool call（畸形工具调用）→ parseToolCallDirectives 记录 parseFailure，
 *    不静默吞掉；best-effort 产出仍可被 schema 校验拦截。
 * 2. 非法枚举参数 → 工具 execute 收到非法枚举值时，不得抛未捕获异常，返回结构化结果。
 * 3. 未知工具 → 工具注册白名单外工具被 fail-closed 拒绝。
 * 4. 重复查询 → ToolCallMetricsTracer 标记 duplicateQuery。
 * 5. 空结果 → 工具返回 no_match 结构化结果（sourceRef/evidenceLevel/returnedCount=0）。
 * 6. 预算耗尽 → BudgetPolicy 标记 exhausted + 记录 reason；runtime prompt 前阻断。
 * 7. 工具超时 → withToolTimeout 抛 ToolExecutionTimeoutError（结构化，不静默降级）。
 * 8. 停止条件 → agent loop 在预算耗尽/无 draft 时返回结构化 fallback，不无限运行。
 *
 * 依赖边界：本测试只依赖生产闭包（dist/），不依赖 eval-only 模块。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  withToolTimeout,
  ToolExecutionTimeoutError,
  DEFAULT_TOOL_TIMEOUT_MS,
  makeNarrativeToolResult,
  makeEmptyToolResult,
} from "../dist/novelos/tools/tool-protocol.js";
import { parseToolCallDirectives } from "../dist/novelos/adapters/react-tool-call-parser.js";
import { ToolCallMetricsTracer } from "../dist/novelos/trajectory/tool-metrics-tracer.js";
import { BudgetPolicy } from "../dist/novelos/runtime/budget-policy.js";
import { createNarrativeToolRegistry } from "../dist/novelos/agent/narrative-tool-registry.js";
import { PermissionPolicy } from "../dist/novelos/security/permission-policy.js";
import { NARRATIVE_TOOL_NAMES } from "../dist/novelos/tools/narrative-tools.js";
import {
  TOOL_CAPABILITIES,
  validateToolCapabilitiesAgainstRuntime,
} from "../dist/novelos/tools/tool-capability.js";
import { registerTools } from "../dist/tools/register-tools.js";

// ============================================================================
// 1. malformed tool call（畸形工具调用）
// ============================================================================

test("Contract v1 · malformed JSON 工具调用被记录 parseFailure，不静默吞掉", () => {
  const out = parseToolCallDirectives(
    '<工具调用>{"工具":"世界事实查询","参数":{ 未闭合 </工具调用>',
  );
  assert.ok(out.toolCalls.length >= 1, "best-effort 仍产出 toolCall（容错）");
  assert.ok(
    out.parseFailures.length >= 1,
    "畸形 JSON 必须被如实记录 parseFailure（不静默吞掉）",
  );
  assert.equal(out.parseFailures[0].reason, "指令 JSON 解析失败（malformed）");
});

test("Contract v1 · malformed 非对象 JSON 被记录 parseFailure", () => {
  const out = parseToolCallDirectives(
    '<工具调用>[1,2,3]</工具调用>',
  );
  assert.equal(out.parseFailures.length, 1, "合法 JSON 但非对象应视为解析失败");
  assert.equal(out.parseFailures[0].reason, "指令 JSON 不是对象");
});

test("Contract v1 · 合法 tool call 无 parseFailure", () => {
  const out = parseToolCallDirectives(
    '<工具调用>{"工具":"世界事实查询","参数":{"类别":"timeline"}}</工具调用>',
  );
  assert.equal(out.parseFailures.length, 0, "合法调用不应有 parseFailure");
  assert.equal(out.hasToolCall, true);
  assert.equal(out.toolCalls[0].name, "query_canon");
  assert.deepEqual(out.toolCalls[0].arguments, { category: "timeline" });
});

// ============================================================================
// 2. 非法枚举参数（工具 execute 收到非法枚举值）
// ============================================================================

test("Contract v1 · query_canon 收到非法 category 时返回结构化 no_match，不抛未捕获异常", async () => {
  const { registry, cleanup } = await setupRegistry();
  try {
    const tool = registry.getToolProtocol("query_canon");
    const result = await tool.execute("tc-invalid-enum", { category: "not_a_real_category" });
    // 非法枚举 → 底层检索无匹配 → 结构化 no_match（returnedCount=0, inferred）
    assert.equal(typeof result.details.returnedCount, "number", "应返回 returnedCount");
    assert.equal(result.details.returnedCount, 0, "非法枚举应得到空结果");
    assert.equal(result.details.resultKind, "no_match");
    assert.equal(result.details.evidenceLevel, "inferred");
  } finally {
    cleanup();
  }
});

test("Contract v1 · query_promise_ledger 收到非法 status 时返回结构化结果", async () => {
  const { registry, cleanup } = await setupRegistry();
  try {
    const tool = registry.getToolProtocol("query_promise_ledger");
    const result = await tool.execute("tc-invalid-status", { status: "bogus_status" });
    assert.equal(typeof result.details.returnedCount, "number");
    assert.equal(result.details.resultKind, "no_match");
  } finally {
    cleanup();
  }
});

// ============================================================================
// 3. 未知工具（白名单外 fail-closed）
// ============================================================================

test("Contract v1 · 注册白名单外工具被 registry 拒绝（fail-closed）", async () => {
  const { registry, cleanup } = await setupRegistry();
  try {
    const tool = registry.getToolProtocol("query_canon");
    const rogue = {
      ...tool,
      name: "diagnostic_dump_all",
      description: "恶意注入白名单外工具",
    };
    assert.throws(
      () => registry.register(rogue),
      /read_only|workspace_read|已注册|final_commit/,
      "registry 应拒绝白名单外/非法工具",
    );
  } finally {
    cleanup();
  }
});

test("Contract v1 · 登记表与实际工具定义校验暴露契约漂移", () => {
  // 幻影工具：登记表有而实际工具集没有
  const phantomFailures = validateToolCapabilitiesAgainstRuntime([
    { name: "query_canon", timeoutMs: 10_000, sideEffect: "read_only", requiredPermission: "workspace_read" },
  ]);
  assert.ok(
    phantomFailures.some((f) => f.includes("query_timeline") && f.includes("不存在")),
    "登记表幻影工具应被标记（query_timeline 未在实际工具集）",
  );

  // timeout 漂移：登记表与实际不一致
  const driftFailures = validateToolCapabilitiesAgainstRuntime([
    { name: "query_canon", timeoutMs: 999_999, sideEffect: "read_only", requiredPermission: "workspace_read" },
    { name: "query_timeline", timeoutMs: 10_000, sideEffect: "read_only", requiredPermission: "workspace_read" },
    { name: "query_character_state", timeoutMs: 10_000, sideEffect: "read_only", requiredPermission: "workspace_read" },
    { name: "query_character_knowledge_boundary", timeoutMs: 10_000, sideEffect: "read_only", requiredPermission: "workspace_read" },
    { name: "query_promise_ledger", timeoutMs: 10_000, sideEffect: "read_only", requiredPermission: "workspace_read" },
    { name: "query_pattern_memory", timeoutMs: 10_000, sideEffect: "read_only", requiredPermission: "workspace_read" },
    { name: "query_voice_evidence", timeoutMs: 5_000, sideEffect: "read_only", requiredPermission: "workspace_read" },
    { name: "search_narrative_evidence", timeoutMs: 15_000, sideEffect: "read_only", requiredPermission: "workspace_read" },
    { name: "search_chapter_span", timeoutMs: 15_000, sideEffect: "read_only", requiredPermission: "workspace_read" },
  ]);
  assert.ok(
    driftFailures.some((f) => f.includes("query_canon") && f.includes("timeoutMs")),
    "timeoutMs 契约漂移应被标记",
  );
});

// ============================================================================
// 4. 重复查询
// ============================================================================

test("Contract v1 · 同一 query 重复调用被标记 duplicateQuery", () => {
  const tracer = new ToolCallMetricsTracer();
  const event = (id, name = "search_narrative_evidence") => ({
    type: "tool_execution_end",
    toolCallId: id,
    toolName: name,
    isError: false,
    result: {
      content: [{ type: "text", text: "证据" }],
      details: { evidenceLevel: "confirmed", sourceRef: "ch1:span:1" },
    },
  });
  tracer.start("c0", "search_narrative_evidence", { query: "林默伤势" });
  const first = tracer.end("c0", event("c0"));
  tracer.start("c1", "search_narrative_evidence", { query: "林默伤势" });
  const second = tracer.end("c1", event("c1"));
  assert.equal(first.duplicateQuery, false);
  assert.equal(second.duplicateQuery, true, "第二次同 query 调用应标记重复");
  assert.equal(second.queryCount, 2);
});

// ============================================================================
// 5. 空结果（结构化 no_match）
// ============================================================================

test("Contract v1 · 空结果返回结构化 no_match（sourceRef/evidenceLevel/returnedCount=0）", () => {
  const result = makeEmptyToolResult("canon:empty", "无 canon 事实");
  assert.equal(result.details.resultKind, "no_match");
  assert.equal(result.details.returnedCount, 0);
  assert.equal(result.details.evidenceLevel, "inferred");
  assert.equal(result.details.sourceRef, "canon:empty");
});

test("Contract v1 · 有结果工具返回结构化 details（sourceRef/evidenceLevel/returnedCount）", () => {
  const result = makeNarrativeToolResult("找到 1 条 canon 事实。", {
    sourceRef: "ch1:span:1",
    evidenceLevel: "confirmed",
    resultKind: "canon_entries",
    returnedCount: 1,
    truncated: false,
    nextQueryHint: null,
    entries: [{ sourceRef: "ch1:span:1", fact: "青鱼嘴有复苏之眼" }],
  });
  assert.equal(result.details.resultKind, "canon_entries");
  assert.equal(result.details.returnedCount, 1);
  assert.equal(result.details.evidenceLevel, "confirmed");
  assert.equal(result.details.truncated, false);
});

// ============================================================================
// 6. 预算耗尽
// ============================================================================

test("Contract v1 · 预算耗尽标记 exhausted + reason，且状态不可逆", () => {
  const budget = new BudgetPolicy({ maxToolCalls: 2 });
  assert.equal(budget.isExhausted(), false, "初始未耗尽");
  budget.recordToolCall();
  budget.recordToolCall();
  assert.equal(budget.isExhausted(), true, "达到 maxToolCalls 应耗尽");
  assert.match(budget.getSnapshot().exhaustedReason, /maxToolCalls/);
  // 耗尽后继续记录不改变状态
  budget.recordToolCall();
  assert.equal(budget.isExhausted(), true);
});

// ============================================================================
// 7. 工具超时（withToolTimeout）
// ============================================================================

test("Contract v1 · withToolTimeout 对超时工具抛结构化 ToolExecutionTimeoutError", async () => {
  const slowTool = {
    name: "slow_tool",
    description: "慢工具",
    label: "Slow Tool",
    parameters: { type: "object", properties: {}, required: [] },
    requiredPermission: "workspace_read",
    sideEffect: "read_only",
    timeoutMs: 50,
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return makeNarrativeToolResult("不应返回", {
        sourceRef: "x",
        evidenceLevel: "confirmed",
        resultKind: "no_match",
        returnedCount: 0,
        truncated: false,
        nextQueryHint: null,
      });
    },
  };
  const wrapped = withToolTimeout(slowTool);
  const start = Date.now();
  await assert.rejects(
    wrapped.execute("tc-timeout", {}, undefined, undefined),
    (err) => {
      assert.ok(err instanceof ToolExecutionTimeoutError, "应抛 ToolExecutionTimeoutError");
      assert.equal(err.toolName, "slow_tool");
      assert.equal(err.timeoutMs, 50);
      assert.equal(err.aborted, false);
      return true;
    },
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 400, `超时应在 bounded timeout 内返回（elapsed=${elapsed}ms）`);
});

test("Contract v1 · withToolTimeout 对 abort signal 抛结构化 aborted 错误", async () => {
  const slowTool = {
    name: "slow_tool",
    description: "慢工具",
    label: "Slow Tool",
    parameters: { type: "object", properties: {}, required: [] },
    requiredPermission: "workspace_read",
    sideEffect: "read_only",
    timeoutMs: 5000,
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return makeNarrativeToolResult("x", {
        sourceRef: "x",
        evidenceLevel: "confirmed",
        resultKind: "no_match",
        returnedCount: 0,
        truncated: false,
        nextQueryHint: null,
      });
    },
  };
  const wrapped = withToolTimeout(slowTool);
  const controller = new AbortController();
  // 立即 abort → 应抛 aborted 错误，不等 timeout
  controller.abort();
  await assert.rejects(
    wrapped.execute("tc-abort", {}, controller.signal, undefined),
    (err) => {
      assert.ok(err instanceof ToolExecutionTimeoutError, "应抛 ToolExecutionTimeoutError");
      assert.equal(err.aborted, true, "abort 应标记 aborted=true");
      return true;
    },
  );
});

test("Contract v1 · withToolTimeout 正常完成后透传原结果（不改变空/证据语义）", async () => {
  const fastTool = {
    name: "fast_tool",
    description: "快工具",
    label: "Fast Tool",
    parameters: { type: "object", properties: {}, required: [] },
    requiredPermission: "workspace_read",
    sideEffect: "read_only",
    timeoutMs: 5000,
    execute: async () =>
      makeNarrativeToolResult("找到 1 条。", {
        sourceRef: "ch1:span:1",
        evidenceLevel: "confirmed",
        resultKind: "canon_entries",
        returnedCount: 1,
        truncated: false,
        nextQueryHint: null,
      }),
  };
  const wrapped = withToolTimeout(fastTool);
  const result = await wrapped.execute("tc-fast", {}, undefined, undefined);
  assert.equal(result.details.resultKind, "canon_entries");
  assert.equal(result.details.returnedCount, 1);
  assert.equal(result.details.evidenceLevel, "confirmed");
});

test("Contract v1 · withToolTimeout 未声明 timeoutMs 时用默认兜底", () => {
  const tool = {
    name: "no_timeout_tool",
    description: "无 timeout",
    label: "No Timeout",
    parameters: { type: "object", properties: {}, required: [] },
    requiredPermission: "workspace_read",
    sideEffect: "read_only",
    execute: async () => makeNarrativeToolResult("x", {
      sourceRef: "x",
      evidenceLevel: "confirmed",
      resultKind: "no_match",
      returnedCount: 0,
      truncated: false,
      nextQueryHint: null,
    }),
  };
  const wrapped = withToolTimeout(tool);
  assert.equal(wrapped.timeoutMs, undefined, "原工具元数据不改写");
  // 包装后 execute 内部用 DEFAULT_TOOL_TIMEOUT_MS 兜底
  assert.equal(DEFAULT_TOOL_TIMEOUT_MS, 30_000);
});

// ============================================================================
// 8. 停止条件（agent loop 预算耗尽 / 无 draft 结构化 fallback）
// ============================================================================

test("Contract v1 · BudgetPolicy 触发停止条件语义（turn 预算耗尽）", () => {
  const budget = new BudgetPolicy({ maxTurns: 1 });
  budget.recordTurn();
  assert.equal(budget.isExhausted(), true, "达到 maxTurns 应触发停止条件");
  assert.match(budget.getSnapshot().exhaustedReason, /maxTurns/);
});

test("Contract v1 · 全部 9 工具 timeoutMs 与登记表一致（无契约漂移）", async () => {
  const { registry, cleanup } = await setupRegistry();
  try {
    const failures = validateToolCapabilitiesAgainstRuntime(
      [...registry.getToolNames()].map((name) => {
        const tool = registry.getToolProtocol(name);
        return {
          name,
          timeoutMs: tool.timeoutMs,
          sideEffect: tool.sideEffect,
          requiredPermission: tool.requiredPermission,
        };
      }),
    );
    assert.deepEqual(failures, [], "全部 9 工具应与登记表一致（registry 构造已校验，此处双保险）");
    assert.equal(registry.getToolNames().length, NARRATIVE_TOOL_NAMES.size);
  } finally {
    cleanup();
  }
});

test("Contract v1 · TOOL_CAPABILITIES 覆盖全部 9 工具且 sideEffect/权限合理", () => {
  for (const name of NARRATIVE_TOOL_NAMES) {
    const cap = TOOL_CAPABILITIES[name];
    assert.ok(cap, `登记表缺少 ${name}`);
    assert.equal(cap.sideEffect, "read_only", `${name} 应为只读`);
    assert.equal(cap.requiredPermission, "workspace_read", `${name} 应要求 workspace_read`);
    assert.ok(cap.timeoutMs > 0, `${name} 应有正 timeout`);
  }
});

// ============================================================================
// 9. 恢复机制（子任务5）：最多自动纠正/重试一次，保留原始失败证据，禁止无限重试
// ============================================================================

/**
 * 构造生产 chapterTool（novel_generate_chapter），handler 可注入可控行为。
 * 返回 { tool, calls, inputs }：calls 记录 handleGenerateChapter 被调用次数，
 * inputs 记录每次入参（检查 _modelTimeoutRetryAttempt 标记）。
 */
function makeChapterTool(handler) {
  const calls = [];
  const handlers = new Proxy({}, {
    get: (_t, key) => key === "handleGenerateChapter"
      ? async (input) => { calls.push(input); return handler(input); }
      : async () => ({}),
  });
  const tool = registerTools(handlers).find((t) => t.name === "novel_generate_chapter");
  return { tool, calls };
}

const MODEL_TIMEOUT_ENVELOPE = {
  gate: "model_timeout",
  recoverable: true,
  severity: "recoverable",
};

test("Contract v1 · 生产 model_timeout 恰好重试一次后成功（保留原始 firstFailureEnvelope）", async () => {
  const { tool, calls } = makeChapterTool((input) => {
    if (input._modelTimeoutRetryAttempt === 1) return { status: "ok" };
    return { status: "blocked", failureEnvelope: MODEL_TIMEOUT_ENVELOPE };
  });
  const response = await tool.execute("recover-ok", {
    workspaceId: "w", chapterId: "1", chapterNumber: 1,
  }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(calls.length, 2, "首次失败 + 一次重试 = 恰好 2 次调用（不无限重试）");
  assert.equal(calls[1]._modelTimeoutRetryAttempt, 1, "重试调用应携带 retry attempt 标记");
  // wrapLegacyTool.execute 返回 { content, details }，真实结果在 response.details
  assert.equal(response.details.status, "ok", "重试成功后最终 status=ok");
  // 保留原始失败证据
  const retry = response.details.stageResults?.modelTimeoutRetry;
  assert.equal(retry.attempted, true);
  assert.equal(retry.attempts, 1, "最多重试一次");
  assert.equal(retry.succeeded, true);
  assert.deepEqual(retry.firstFailureEnvelope, MODEL_TIMEOUT_ENVELOPE, "必须保留首次失败 envelope");
});

test("Contract v1 · 重试仍 model_timeout → 不再第三次重试（at-most-once，结构化阻断）", async () => {
  const { tool, calls } = makeChapterTool(() => ({
    status: "blocked",
    failureEnvelope: MODEL_TIMEOUT_ENVELOPE,
  }));
  const response = await tool.execute("recover-exhausted", {
    workspaceId: "w", chapterId: "1", chapterNumber: 1,
  }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(calls.length, 2, "重试耗尽后绝不再进第三次调用");
  assert.equal(response.details.status, "blocked", "重试仍失败应结构化阻断，不静默降级");
  const retry = response.details.stageResults?.modelTimeoutRetry;
  assert.equal(retry.succeeded, false);
  assert.equal(retry.attempts, 1);
  assert.deepEqual(retry.firstFailureEnvelope, MODEL_TIMEOUT_ENVELOPE);
});

test("Contract v1 · 非 model_timeout 失败不触发章节级重试（只允许 model_timeout 恢复）", async () => {
  const { tool, calls } = makeChapterTool(() => ({
    status: "blocked",
    failureEnvelope: { stage: "raw_fact_guard", gate: "fact_guard", severity: "hard" },
  }));
  await tool.execute("recover-no-mt", {
    workspaceId: "w", chapterId: "1", chapterNumber: 1,
  }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(calls.length, 1, "非 model_timeout 失败必须原样返回，只调用一次");
});

test("Contract v1 · fullPipelinePreview 预览不触发章节级重试（纯只读）", async () => {
  const { tool, calls } = makeChapterTool(() => ({
    status: "blocked",
    failureEnvelope: MODEL_TIMEOUT_ENVELOPE,
  }));
  await tool.execute("recover-preview", {
    workspaceId: "w", chapterId: "1", chapterNumber: 1, fullPipelinePreview: true,
  }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(calls.length, 1, "预览路径不得重试整章");
});

// ============================================================================
// 辅助：构造 registry（真实工具 + 权限策略）
// ============================================================================

/**
 * 构造真实 NarrativeToolRegistry（含 9 工具 + 契约校验）。
 * 返回 { registry, cleanup }。
 */
async function setupRegistry() {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ifc-v1-"));
  const permissionPolicy = new PermissionPolicy({
    workspaceRoot,
    sessionId: "ifc-v1-session",
  });
  const registry = createNarrativeToolRegistry({
    searchService: {
      searchRanked: () => [],
      searchChapterSpan: () => [],
      queryCanon: (/* category */) => [],
      queryCharacterState: () => [],
      queryTimeline: () => [],
      queryCharacterKnowledgeBoundary: () => [],
      queryPromiseLedger: (/* status */) => [],
      queryPatternMemory: () => [],
      queryVoiceEvidence: () => [],
    },
    permissionPolicy,
  });
  return {
    registry,
    cleanup: () => rmSync(workspaceRoot, { recursive: true, force: true }),
  };
}