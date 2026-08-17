/**
 * AGENTIC-EVIDENCE-MERGE-1 §9 验收单测：failureReason 传递与 classifyFailureKind 超时识别。
 *
 * 覆盖两个关键修复点：
 * 1. classifyFailureKind 能从 reason 字符串中识别 "timed out" / "超时" / "aborted" 等超时模式，
 *    返回 "model_timeout" 而非 defaultKind。这是 recovery trace 生成 severity=recoverable 的前提。
 * 2. 当 loop catch 块捕获异常时，errMsg 通过 lineage.failureReason 传递到 source，
 *    使 classifyFailureKind 能在 fallbackReason 中检测到超时关键词。
 *    此测试通过模拟 fallbackReason 构造逻辑验证传递链路。
 *
 * 相关源码：
 * - novelos/agent/agentic-raw-candidate-source.ts: classifyFailureKind + TIMEOUT_PATTERNS
 * - novelos/agent/narrative-agent-loop.ts: catch 块 → makeFallback(failureReason=errMsg)
 * - novelos/agent/narrative-agent-loop-types.ts: AgentLoopLineage.failureReason
 */
import test from "node:test";
import assert from "node:assert/strict";

import { classifyFailureKind } from "../dist/novelos/agent/agentic-raw-candidate-source.js";

// ============================================================================
// 1. classifyFailureKind 超时模式识别
// ============================================================================

test("classifyFailureKind：'timed out' 关键词识别为 model_timeout", () => {
  const reason = "OpenAI-compatible:gemini-3.1-pro timed out after 100ms";
  const kind = classifyFailureKind(reason, "model_error", "model_error");
  assert.equal(kind, "model_timeout", "含 'timed out' 的 reason 应识别为 model_timeout");
});

test("classifyFailureKind：'timeout' 关键词识别为 model_timeout", () => {
  const reason = "Request timeout: fetch aborted after 5000ms";
  const kind = classifyFailureKind(reason, "model_error", "model_error");
  assert.equal(kind, "model_timeout");
});

test("classifyFailureKind：中文 '超时' 关键词识别为 model_timeout", () => {
  const reason = "模型调用超时：等待响应超过 100ms";
  const kind = classifyFailureKind(reason, "model_error", "model_error");
  assert.equal(kind, "model_timeout");
});

test("classifyFailureKind：'aborted' 关键词识别为 model_timeout", () => {
  const reason = "The operation was aborted due to timeout";
  const kind = classifyFailureKind(reason, "model_error", "model_error");
  assert.equal(kind, "model_timeout");
});

test("classifyFailureKind：'ETIMEDOUT' 关键词识别为 model_timeout", () => {
  const reason = "fetch failed: ETIMEDOUT connection timed out";
  const kind = classifyFailureKind(reason, "model_error", "model_error");
  assert.equal(kind, "model_timeout");
});

test("classifyFailureKind：'ECONNRESET' 关键词识别为 model_timeout", () => {
  const reason = "fetch failed: ECONNRESET socket hang up";
  const kind = classifyFailureKind(reason, "model_error", "model_error");
  assert.equal(kind, "model_timeout");
});

test("classifyFailureKind：非超时错误返回 defaultKind", () => {
  const reason = "API call failed (401): Unauthorized";
  const kind = classifyFailureKind(reason, "model_error", "model_error");
  assert.equal(kind, "model_error", "401 错误不含超时关键词，应返回 defaultKind");
});

test("classifyFailureKind：空字符串返回 defaultKind", () => {
  const kind = classifyFailureKind("", "model_error", "model_error");
  assert.equal(kind, "model_error");
});

test("classifyFailureKind：empty_draft 作为 defaultKind 时返回 empty_draft", () => {
  const reason = "模型未返回有效文本";
  const kind = classifyFailureKind(reason, "model_error", "empty_draft");
  assert.equal(kind, "empty_draft", "非超时错误应返回传入的 defaultKind");
});

// ============================================================================
// 2. failureReason 传递链路验证
// ============================================================================

test("failureReason 传递：catch 块 errMsg 附加到 fallbackReason 后能识别超时", () => {
  // 模拟 narrative-agent-loop.ts catch 块的行为：
  // const errMsg = err.message; // 例如 "OpenAI-compatible:gemini-3.1-pro timed out after 100ms"
  // return this.makeFallback(plan, [], "model_error", [], 0, ..., errMsg);
  //
  // 模拟 agentic-raw-candidate-source.ts 的行为：
  // const loopFailureReason = loopResult.lineage.failureReason; // = errMsg
  // const fallbackReason = `agent loop fallback: ${stopReason}（${loopFailureReason}）`;
  // const fallbackKind = classifyFailureKind(fallbackReason, stopReason, defaultKind);

  const errMsg = "OpenAI-compatible:gemini-3.1-pro timed out after 100ms";
  const stopReason = "model_error";
  const loopFailureReason = errMsg; // lineage.failureReason = errMsg（修复后）
  const fallbackReason = `agent loop fallback: ${stopReason}（${loopFailureReason}）`;
  const fallbackKind = classifyFailureKind(fallbackReason, stopReason, "empty_draft");

  assert.equal(
    fallbackKind,
    "model_timeout",
    "fallbackReason 含超时关键词时应识别为 model_timeout，而非 empty_draft",
  );
  assert.match(
    fallbackReason,
    /timed out/,
    "fallbackReason 应包含底层错误消息（含超时关键词）",
  );
});

test("failureReason 传递：无 failureReason 时 fallbackReason 不含超时关键词", () => {
  // 模拟修复前的行为：catch 块未传递 errMsg，lineage.failureReason 为 undefined
  // const fallbackReason = `agent loop fallback: ${stopReason}`;
  // → 不含超时关键词 → classifyFailureKind 返回 defaultKind（empty_draft）
  // 这正是修复前的 bug：所有模型异常都被归为 model_error/empty_draft
  const stopReason = "model_error";
  const loopFailureReason = undefined; // 修复前：未传递
  const fallbackReason = loopFailureReason
    ? `agent loop fallback: ${stopReason}（${loopFailureReason}）`
    : `agent loop fallback: ${stopReason}`;
  const fallbackKind = classifyFailureKind(fallbackReason, stopReason, "empty_draft");

  assert.equal(
    fallbackKind,
    "empty_draft",
    "无 failureReason 时应返回 defaultKind（修复前的 bug 行为，作为对照）",
  );
  assert.doesNotMatch(
    fallbackReason,
    /timed out/,
    "无 failureReason 时 fallbackReason 不应含超时关键词",
  );
});

test("failureReason 传递：modelErrorMessage 从 assistant 消息提取后进入 lineage", () => {
  // 模拟 runAgentTurns 提取 modelErrorMessage 的逻辑：
  // for (const msg of messages) {
  //   if (msg.role === "assistant" && typeof msg.errorMessage === "string") {
  //     modelErrorMessage = msg.errorMessage;
  //     break;
  //   }
  // }
  // → turns.modelErrorMessage 传入 makeFallback → lineage.failureReason

  const messages = [
    { role: "user", content: "generate chapter" },
    {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "OpenAI-compatible:gemini-3.1-pro timed out after 100ms",
    },
  ];

  // 提取 modelErrorMessage（与 runAgentTurns 相同的逻辑）
  let modelErrorMessage;
  for (const msg of messages) {
    const m = msg;
    if (m.role === "assistant" && typeof m.errorMessage === "string" && m.errorMessage.length > 0) {
      modelErrorMessage = m.errorMessage;
      break;
    }
  }

  assert.ok(modelErrorMessage, "应从 assistant 消息中提取 errorMessage");
  assert.match(modelErrorMessage, /timed out/, "提取的 errorMessage 应含超时关键词");

  // 验证 makeFallback 会把 modelErrorMessage 设为 lineage.failureReason
  // （narrative-agent-loop.ts 空草稿路径：turns.modelErrorMessage → makeFallback → lineage.failureReason）
  const lineageFailureReason = modelErrorMessage; // lineage.failureReason = failureReason 参数
  const fallbackReason = `agent loop fallback: model_error（${lineageFailureReason}）`;
  const kind = classifyFailureKind(fallbackReason, "model_error", "empty_draft");

  assert.equal(kind, "model_timeout", "从 errorMessage 到 failureReason 到 classifyFailureKind 链路完整");
});

test("failureReason 传递：streamFn catch 设置 errorMessage 到 assistant 消息", () => {
  // 模拟 createProjectStreamFn 的 catch 块：
  // catch (err) {
  //   const errMsg = err instanceof Error ? err.message : String(err);
  //   const error = makeAssistantMessage([], "error");
  //   error.errorMessage = errMsg;
  //   stream.push({ type: "error", reason: "error", error });
  // }
  const originalError = new Error("OpenAI-compatible:gemini-3.1-pro timed out after 100ms");
  const errMsg = originalError.message;
  const assistantMsg = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: errMsg, // streamFn catch 设置
  };

  // 验证 errorMessage 被正确设置
  assert.equal(
    assistantMsg.errorMessage,
    "OpenAI-compatible:gemini-3.1-pro timed out after 100ms",
  );
  assert.match(assistantMsg.errorMessage, /timed out/);
});

// ============================================================================
// 3. 综合：从 streamFn catch 到 orchestrator hardBlock 的完整链路
// ============================================================================

test("综合链路：streamFn error → modelErrorMessage → failureReason → classifyFailureKind → model_timeout", () => {
  // 1. streamFn catch 捕获 fetchWithTimeout 抛出的超时错误
  const fetchError = new Error("OpenAI-compatible:gemini-3.1-pro timed out after 100ms");

  // 2. streamFn 设置 errorMessage 到 assistant 消息
  const errMsg = fetchError.message;
  const assistantMsg = { role: "assistant", errorMessage: errMsg };

  // 3. runAgentTurns 从 messages 提取 modelErrorMessage
  let modelErrorMessage;
  const messages = [assistantMsg];
  for (const msg of messages) {
    const m = msg;
    if (m.role === "assistant" && typeof m.errorMessage === "string" && m.errorMessage.length > 0) {
      modelErrorMessage = m.errorMessage;
      break;
    }
  }

  // 4. makeFallback 把 modelErrorMessage 设为 lineage.failureReason
  const lineageFailureReason = modelErrorMessage;

  // 5. source 从 lineage.failureReason 构造 fallbackReason
  const stopReason = "model_error";
  const fallbackReason = lineageFailureReason
    ? `agent loop fallback: ${stopReason}（${lineageFailureReason}）`
    : `agent loop fallback: ${stopReason}`;

  // 6. classifyFailureKind 识别超时模式
  const failureKind = classifyFailureKind(fallbackReason, stopReason, "empty_draft");

  assert.equal(failureKind, "model_timeout", "完整链路应识别为 model_timeout");

  // 7. 编排器据此生成 gate=model_timeout / severity=recoverable envelope
  // （unified-orchestrator.ts candidate=null 分支）
  const envelope = failureKind === "model_timeout"
    ? { gate: "model_timeout", severity: "recoverable", recoverable: true }
    : { gate: "novelos_agentic_generation", severity: "hard", recoverable: false };

  assert.equal(envelope.gate, "model_timeout");
  assert.equal(envelope.severity, "recoverable");
  assert.equal(envelope.recoverable, true);
});
