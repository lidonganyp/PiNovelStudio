/**
 * Tool input contract harness tests.
 *
 * Covers HARNESS 套件 2（输入契约）：type / enum / required / items / nested properties，
 * 并确认未声明的运行时注入字段不会被误判。
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  renderToolInputViolations,
  validateToolInput,
} from "../dist/tools/tool-input-validation.js";
import { logHarnessEvent } from "../dist/utils/harness-logger.js";
import { getProjectRoot, setProjectRoot } from "../dist/utils/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = join(__dirname, "..");

/** 捕获 stderr 写入，用于断言日志不泄露正文。 */
function captureStderr(fn) {
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = function (chunk) {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

const SCHEMA = {
  type: "object",
  properties: {
    workspaceId: { type: "string" },
    chapterNumber: { type: "number" },
    action: { type: "string", enum: ["init", "switch"] },
    selectedStrategyIds: { type: "array", items: { type: "string" } },
    targetWordCount: {
      type: "object",
      properties: {
        min: { type: "number" },
        max: { type: "number" },
      },
      required: ["min", "max"],
    },
  },
  required: ["workspaceId"],
};

test("declared fields with the right shapes pass the contract", () => {
  assert.deepEqual(
    validateToolInput(SCHEMA, {
      workspaceId: "ws",
      chapterNumber: 3,
      action: "init",
      selectedStrategyIds: ["a", "b"],
      targetWordCount: { min: 1000, max: 1400 },
    }),
    { ok: true },
  );
});

test("undeclared runtime fields are allowed through", () => {
  assert.deepEqual(
    validateToolInput(SCHEMA, { workspaceId: "ws", _projectRoot: "/tmp/root", _mockGenerateChapter: {} }),
    { ok: true },
  );
});

test("missing required fields are reported", () => {
  const result = validateToolInput(SCHEMA, { chapterNumber: 3 });
  assert.equal(result.ok, false);
  const violation = result.violations.find((item) => item.keyword === "required");
  assert.equal(violation.path, "/workspaceId");
});

test("wrong primitive types and out-of-enum values are reported", () => {
  const result = validateToolInput(SCHEMA, { workspaceId: "ws", chapterNumber: "3", action: "delete" });
  assert.equal(result.ok, false);
  const keywords = result.violations.map((item) => `${item.path}:${item.keyword}`);
  assert.deepEqual(keywords, ["/chapterNumber:type", "/action:enum"]);
});

test("array element and nested object contracts are enforced", () => {
  const result = validateToolInput(SCHEMA, {
    workspaceId: "ws",
    selectedStrategyIds: ["a", 7],
    targetWordCount: { min: 1000 },
  });
  assert.equal(result.ok, false);
  const keywords = result.violations.map((item) => `${item.path}:${item.keyword}`);
  assert.deepEqual(keywords, ["/selectedStrategyIds/1:type", "/targetWordCount/max:required"]);
});

test("violations render as model-readable guidance without body text", () => {
  const result = validateToolInput(SCHEMA, { action: "delete" });
  assert.equal(result.ok, false);
  const rendered = renderToolInputViolations("novel_workspace_manager", result.violations);
  assert.match(rendered, /\/workspaceId：required/);
  assert.match(rendered, /\/action：enum/);
  assert.match(rendered, /重新调用/);
});

// =============================================================================
// R05：校验错误里的 actual 必须有界，正文不得经 violations / stderr 外泄
// =============================================================================

const SECRET_MARK = "正文标记绝不外泄";
const LONG_BODY = `第一章开头。${"这是一段不该出现在校验日志里的正文。".repeat(20)}${SECRET_MARK}结尾。`;

test("R05：误填进枚举字段的长正文只保留有界摘要", () => {
  const result = validateToolInput(SCHEMA, { workspaceId: "ws", action: LONG_BODY });
  assert.equal(result.ok, false);
  const violation = result.violations.find((item) => item.path === "/action");
  assert.equal(violation.keyword, "enum");
  assert.ok(violation.actual.length <= 96, `actual 超限: ${violation.actual.length}`);
  assert.ok(!violation.actual.includes(SECRET_MARK), "actual 不得回显正文尾部");
  assert.match(violation.actual, /string\(len=\d+/);
  assert.match(violation.expected, /init|switch/, "仍要保留期望枚举，便于定位");

  const rendered = renderToolInputViolations("novel_workspace_manager", result.violations);
  assert.match(rendered, /\/action：enum/);
  assert.ok(!rendered.includes(SECRET_MARK));
  assert.ok(rendered.length < 1200, `渲染文本应有界: ${rendered.length}`);
});

test("R05：换行正文被压平，嵌套值转为键摘要", () => {
  const multiline = `${"第一行\n第二行\n".repeat(10)}${"\n\n".repeat(12)}${SECRET_MARK}`;
  const multilineResult = validateToolInput(SCHEMA, { workspaceId: "ws", action: multiline });
  assert.equal(multilineResult.ok, false);
  const multilineViolation = multilineResult.violations[0];
  assert.ok(!multilineViolation.actual.includes("\n"), "actual 不得保留原始换行");
  assert.ok(!multilineViolation.actual.includes(SECRET_MARK));

  // 只有 enum（无 type）时，嵌套对象走摘要而非整串回显。
  const enumOnlySchema = { type: "object", properties: { mode: { enum: ["batch"] } } };
  const nestedInput = { mode: { prose: LONG_BODY, meta: { deep: LONG_BODY } } };
  const nestedResult = validateToolInput(enumOnlySchema, nestedInput);
  assert.equal(nestedResult.ok, false);
  const nestedViolation = nestedResult.violations[0];
  assert.equal(nestedViolation.keyword, "enum");
  assert.match(nestedViolation.actual, /object\(keys=prose,meta, keyCount=2\)/);
  assert.ok(!nestedViolation.actual.includes(SECRET_MARK));

  const stderr = captureStderr(() => {
    logHarnessEvent("warn", "tool_input_contract_violation", {
      stage: "tool",
      tool: "novel_workspace_manager",
      violations: [...multilineResult.violations, ...nestedResult.violations],
    });
  });
  assert.ok(!stderr.includes(SECRET_MARK), "stderr 不得出现正文");
  assert.ok(stderr.includes("tool_input_contract_violation"), "仍要保留事件定位信息");
});

test("R05：logger 对任意超长字符串统一限长（不只认正文键名）", () => {
  const longUnknown = `正文${"z".repeat(600)}`;
  const stderr = captureStderr(() => {
    logHarnessEvent("warn", "r05_logger_probe", { mode: longUnknown, note: "短字段保留" });
  });
  assert.match(stderr, /\[truncated:length=60\d/);
  assert.ok(!stderr.includes("z".repeat(600)));
  assert.ok(stderr.includes("短字段保留"), "短字段不应被截断");
});

test("R05：违规条数过多时渲染结果整体有界", () => {
  const manyRequired = {
    type: "object",
    properties: {},
    required: Array.from({ length: 20 }, (_, index) => `field${index}`),
  };
  const result = validateToolInput(manyRequired, {});
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 20);
  const rendered = renderToolInputViolations("novel_workspace_manager", result.violations);
  const detailLines = rendered.split("\n").filter((line) => line.startsWith("- /"));
  assert.equal(detailLines.length, 12, "最多展开 12 条");
  assert.match(rendered, /另有 8 条违规未展开/);
});

// =============================================================================
// R04：单章条件必填兜底（schema 的条件约束不进入运行期校验，由 handler 兜底）
// =============================================================================

const originalProjectRoot = getProjectRoot();

afterEach(() => {
  setProjectRoot(originalProjectRoot);
});

async function loadChapterTool(handlers) {
  const mod = await import(
    pathToFileURL(join(EXT_ROOT, "dist", "tools", "register-tools.js")).href
  );
  const tools = mod.registerTools(handlers);
  return tools.find((tool) => tool.name === "novel_generate_chapter");
}

function makeRecordingHandlers() {
  const calls = { generate: 0, batch: 0, batchInput: null };
  return {
    calls,
    handleGenerateChapter: async () => {
      calls.generate += 1;
      return { status: "ok" };
    },
    handleBatchGeneration: async (input) => {
      calls.batch += 1;
      calls.batchInput = input;
      return { status: "ok", mode: "batch", action: input.action };
    },
  };
}

async function invokeChapter(params, handlers) {
  const tool = await loadChapterTool(handlers);
  return tool.execute("r04-call", params, undefined, undefined, { cwd: EXT_ROOT });
}

test("R04：单章缺 chapterNumber 时返回 input_contract_violation 且不执行 handler", async () => {
  const handlers = makeRecordingHandlers();
  const result = await invokeChapter({ workspaceId: "ws", chapterId: "3" }, handlers);
  assert.equal(result.details.status, "input_contract_violation");
  assert.equal(handlers.calls.generate, 0);
  assert.equal(handlers.calls.batch, 0);
  const violation = result.details.violations.find((item) => item.path === "/chapterNumber");
  assert.equal(violation.keyword, "required");
  assert.match(result.content[0].text, /\/chapterNumber：required/);
});

test("R04：单章缺 chapterId / 路径穿越 ID 在进入文件快照前被阻断", async () => {
  for (const chapterId of [undefined, "", "  ", "../x", "a/b"]) {
    const handlers = makeRecordingHandlers();
    const params = chapterId === undefined
      ? { workspaceId: "ws", chapterNumber: 3 }
      : { workspaceId: "ws", chapterId, chapterNumber: 3 };
    const result = await invokeChapter(params, handlers);
    assert.equal(result.details.status, "input_contract_violation", `chapterId=${String(chapterId)}`);
    assert.equal(handlers.calls.generate, 0);
    const violation = result.details.violations.find((item) => item.path === "/chapterId");
    assert.ok(violation, `chapterId=${String(chapterId)} 必须报 /chapterId`);
  }
});

test("R04：非法章号（0 / 小数 / 负数）被阻断在 handler 之前", async () => {
  for (const chapterNumber of [0, 1.5, -2]) {
    const handlers = makeRecordingHandlers();
    const result = await invokeChapter({ workspaceId: "ws", chapterId: "3", chapterNumber }, handlers);
    assert.equal(result.details.status, "input_contract_violation", `chapterNumber=${chapterNumber}`);
    assert.equal(handlers.calls.generate, 0);
    const violation = result.details.violations.find((item) => item.path === "/chapterNumber");
    assert.equal(violation.keyword, "type");
  }
});

test("R04：batch resume/status/cancel 不被单章必填要求误伤", async () => {
  for (const action of ["resume", "status", "cancel"]) {
    const handlers = makeRecordingHandlers();
    const result = await invokeChapter(
      { mode: "batch", action, workspaceId: "ws", jobId: "job-1" },
      handlers,
    );
    assert.equal(result.details.status, "ok", `batch ${action} 应正常进入批量分支`);
    assert.equal(handlers.calls.batch, 1, `batch ${action} 必须调用批量处理器`);
    assert.equal(handlers.calls.generate, 0);
  }
});
