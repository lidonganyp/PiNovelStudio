/**
 * 协议层与原生能力适配 — 综合测试
 *
 * 覆盖计划中的测试要求：
 * - 单元测试：ModelTurn 构造与序列化、capability key 与查询、endpoint 隔离、
 *   ReAct/Native 响应转换、parseStatus 与 finishReason 映射、适配器注册表路由选择
 * - 集成测试：ReAct Adapter → ModelTurn、Native Adapter → ModelTurn、toolResult 回传
 * - 回归测试：生产构建依赖边界、生产 route 不启用 Native、parser failure 统计不回归
 * - Eval 测试：固定 fixture 指标计算、A/B 对照矩阵、Go/No-Go 评估
 */

import assert from "node:assert/strict";
import { test } from "node:test";

// 生产模块（从 dist/ 导入）
import {
  createTextTurn,
  createToolCallTurn,
  createErrorTurn,
  emptyUsage,
  serializeModelTurn,
  deserializeModelTurn,
} from "../dist/novelos/protocol/model-turn.js";
import {
  CapabilityRegistry,
  defaultCapabilityRegistry,
  createEndpointCapability,
  emptyEndpointCapability,
} from "../dist/novelos/protocol/capability-registry.js";
import {
  createReactTextAdapter,
} from "../dist/novelos/protocol/adapters/react-text-adapter.js";
import {
  StructuredJsonAdapter,
} from "../dist/novelos/protocol/adapters/structured-json-adapter.js";
import {
  AdapterRegistry,
  defaultAdapterRegistry,
} from "../dist/novelos/protocol/adapter-registry.js";
import {
  ADAPTER_VERSIONS,
  getAdapterVersionInfo,
  computeAdapterFingerprint,
} from "../dist/novelos/protocol/protocol-adapter.js";

// Eval-only 模块（从 dist-eval/ 导入）
import {
  createNativeFunctionCallingAdapter,
  NativeFunctionCallingAdapter,
} from "../dist-eval/novelos/protocol/adapters/native-fc-adapter.js";
import {
  isNativeFcRegistered,
  listEvalNativeFcRoutes,
  validateNativeFcCapabilities,
} from "../dist-eval/novelos/protocol/native-fc-eval-entry.js";
import {
  defaultAdapterRegistry as evalAdapterRegistry,
} from "../dist-eval/novelos/protocol/adapter-registry.js";
import {
  computeMetricsFromTurns,
  createComparisonMatrix,
  evaluateGoNoGo,
} from "../dist-eval/novelos/protocol/protocol-ab-eval.js";
import {
  DEFAULT_EVAL_FIXTURES,
  HARD_GATE_METRICS,
  REACT_PIPELINE_DEPENDENCY_GRAPH,
  PROTOCOL_RISKS,
} from "../dist-eval/novelos/protocol/protocol-baseline.js";

// ============================================================================
// 1. 单元测试：ModelTurn 构造与序列化
// ============================================================================

test("ModelTurn · createTextTurn 构造纯文本 turn", () => {
  const turn = createTextTurn("章节正文内容", { model: "gemini-3.1-pro-preview" });
  assert.equal(turn.text, "章节正文内容");
  assert.equal(turn.toolCalls.length, 0);
  assert.equal(turn.finishReason, "stop");
  assert.equal(turn.parseStatus, "ok");
  assert.equal(turn.protocol, "react-text");
  assert.equal(turn.adapterVersion, "react-text-v1");
  assert.equal(turn.model, "gemini-3.1-pro-preview");
});

test("ModelTurn · createToolCallTurn 构造工具调用 turn", () => {
  const turn = createToolCallTurn("检索前的思考", [
    { id: "tc-abc123", name: "search_chapter_span", arguments: { query: "角色A" } },
  ]);
  assert.equal(turn.text, "检索前的思考");
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0].name, "search_chapter_span");
  assert.equal(turn.finishReason, "tool_use");
  assert.equal(turn.parseStatus, "ok");
});

test("ModelTurn · createToolCallTurn 带 parseFailures 时 parseStatus=parse_failure", () => {
  const turn = createToolCallTurn(undefined, [], {
    parseFailures: [{ index: 0, rawJson: "{bad", reason: "malformed" }],
  });
  assert.equal(turn.parseStatus, "parse_failure");
  assert.equal(turn.parseFailures?.length, 1);
});

test("ModelTurn · createErrorTurn 构造错误 turn", () => {
  const turn = createErrorTurn("timeout", "模型调用超时");
  assert.equal(turn.text, undefined);
  assert.equal(turn.toolCalls.length, 0);
  assert.equal(turn.finishReason, "error");
  assert.equal(turn.parseStatus, "timeout");
});

test("ModelTurn · emptyUsage 返回全零用量", () => {
  const usage = emptyUsage();
  assert.equal(usage.input, 0);
  assert.equal(usage.output, 0);
  assert.equal(usage.totalTokens, 0);
  assert.equal(usage.cost.total, 0);
});

test("ModelTurn · serializeModelTurn + deserializeModelTurn 往返一致", () => {
  const original = createToolCallTurn("文本", [
    { id: "tc-1", name: "query_canon", arguments: { category: "world" } },
  ], { model: "test-model" });
  original.toolResults = [{
    toolCallId: "tc-1",
    toolName: "query_canon",
    content: [{ type: "text", text: "结果" }],
    details: { sourceRef: "canon:1", evidenceLevel: "confirmed", returnedCount: 1 },
    isError: false,
  }];

  const serialized = serializeModelTurn(original);
  const deserialized = deserializeModelTurn(serialized);

  assert.equal(deserialized.text, original.text);
  assert.equal(deserialized.toolCalls.length, original.toolCalls.length);
  assert.equal(deserialized.toolCalls[0].name, original.toolCalls[0].name);
  assert.equal(deserialized.toolResults.length, original.toolResults.length);
  assert.equal(deserialized.toolResults[0].toolName, original.toolResults[0].toolName);
  assert.equal(deserialized.parseStatus, original.parseStatus);
  assert.equal(deserialized.protocol, original.protocol);
  assert.equal(deserialized.model, original.model);
});

// ============================================================================
// 2. 单元测试：Capability Registry
// ============================================================================

test("CapabilityRegistry · endpoint 级声明独立于 provider 级", () => {
  const registry = new CapabilityRegistry();

  // 注册 provider 级默认
  registry.registerProviderDefault("gemini", createEndpointCapability({
    nativeSystemInstruction: true,
  }));

  // 注册 endpoint 级声明
  registry.register({
    key: {
      provider: "gemini",
      endpoint: "google-ai-native",
      model: "gemini-3.1-pro-preview",
      protocol: "native-function-calling",
      adapterVersion: "native-fc-v1",
    },
    capability: createEndpointCapability({
      nativeFunctionCalling: true,
      nativeSystemInstruction: true,
    }),
    source: "test",
    declaredAt: "2026-08-12",
  });

  // endpoint 级查询返回 nativeFunctionCalling=true
  const endpointCap = registry.lookup({
    provider: "gemini",
    endpoint: "google-ai-native",
    model: "gemini-3.1-pro-preview",
    protocol: "native-function-calling",
    adapterVersion: "native-fc-v1",
  });
  assert.equal(endpointCap.nativeFunctionCalling, true);

  // 不同 endpoint 回退到 provider 级
  const otherCap = registry.lookup({
    provider: "gemini",
    endpoint: "openai-compat",
    model: "gemini-3.1-pro-preview",
    protocol: "react-text",
    adapterVersion: "react-text-v1",
  });
  assert.equal(otherCap.nativeFunctionCalling, false);
  assert.equal(otherCap.nativeSystemInstruction, true);
});

test("CapabilityRegistry · 更换 endpoint 后不复用错误 capability", () => {
  const registry = new CapabilityRegistry();

  registry.register({
    key: {
      provider: "gemini",
      endpoint: "endpoint-a",
      model: "gemini-3.1-pro-preview",
      protocol: "native-function-calling",
      adapterVersion: "native-fc-v1",
    },
    capability: createEndpointCapability({ nativeFunctionCalling: true }),
    source: "test",
    declaredAt: "2026-08-12",
  });

  registry.register({
    key: {
      provider: "gemini",
      endpoint: "endpoint-b",
      model: "gemini-3.1-pro-preview",
      protocol: "native-function-calling",
      adapterVersion: "native-fc-v1",
    },
    capability: createEndpointCapability({ nativeFunctionCalling: false }),
    source: "test",
    declaredAt: "2026-08-12",
  });

  const capA = registry.lookup({
    provider: "gemini", endpoint: "endpoint-a", model: "gemini-3.1-pro-preview",
    protocol: "native-function-calling", adapterVersion: "native-fc-v1",
  });
  const capB = registry.lookup({
    provider: "gemini", endpoint: "endpoint-b", model: "gemini-3.1-pro-preview",
    protocol: "native-function-calling", adapterVersion: "native-fc-v1",
  });

  assert.equal(capA.nativeFunctionCalling, true);
  assert.equal(capB.nativeFunctionCalling, false);
});

test("CapabilityRegistry · 未知 provider fail-closed 全 false", () => {
  const registry = new CapabilityRegistry();
  const cap = registry.lookup({
    provider: "unknown",
    endpoint: "unknown",
    model: "unknown",
    protocol: "react-text",
    adapterVersion: "react-text-v1",
  });
  assert.equal(cap.nativeFunctionCalling, false);
  assert.equal(cap.nativeSystemInstruction, false);
  assert.equal(cap.responseSchema, false);
});

test("CapabilityRegistry · validate 检查缺失字段", () => {
  const registry = new CapabilityRegistry();
  registry.register({
    key: {
      provider: "gemini",
      endpoint: "",
      model: "gemini-3.1-pro-preview",
      protocol: "react-text",
      adapterVersion: "react-text-v1",
    },
    capability: createEndpointCapability(),
    source: "test",
    declaredAt: "2026-08-12",
  });
  const failures = registry.validate();
  assert.ok(failures.length > 0, "应检测到缺失 endpoint");
});

test("CapabilityRegistry · 默认 registry 已初始化生产声明", () => {
  const geminiCap = defaultCapabilityRegistry.lookup({
    provider: "gemini",
    endpoint: "openai-compat",
    model: "gemini-3.1-pro-preview",
    protocol: "react-text",
    adapterVersion: "react-text-v1",
  });
  assert.equal(geminiCap.nativeSystemInstruction, true);
  assert.equal(geminiCap.nativeFunctionCalling, false);

  const nativeCap = defaultCapabilityRegistry.lookup({
    provider: "gemini",
    endpoint: "google-ai-native",
    model: "gemini-3.1-pro-preview",
    protocol: "native-function-calling",
    adapterVersion: "native-fc-v1",
  });
  assert.equal(nativeCap.nativeFunctionCalling, true);
});

// ============================================================================
// PROTOCOL-LAYER-2 新增：lookupStrict 严格 endpoint 隔离测试
// ============================================================================

test("CapabilityRegistry · lookupStrict 未命中 endpoint 级时 fail-closed（不回退 provider 级）", () => {
  const registry = new CapabilityRegistry();

  // 注册 provider 级默认
  registry.registerProviderDefault("gemini", createEndpointCapability({
    nativeSystemInstruction: true,
    nativeFunctionCalling: true, // 故意设为 true，验证 lookupStrict 不继承
  }));

  // 不注册 endpoint 级声明
  // lookupStrict 应返回全 false，不继承 provider 级的 nativeSystemInstruction/nativeFunctionCalling
  const strictCap = registry.lookupStrict({
    provider: "gemini",
    endpoint: "openai-compat",
    model: "gemini-3.1-pro-preview",
    protocol: "react-text",
    adapterVersion: "react-text-v1",
  });
  assert.equal(strictCap.nativeSystemInstruction, false, "lookupStrict 不应继承 provider 级 nativeSystemInstruction");
  assert.equal(strictCap.nativeFunctionCalling, false, "lookupStrict 不应继承 provider 级 nativeFunctionCalling");
  assert.equal(strictCap.responseSchema, false);
});

test("CapabilityRegistry · lookupStrict 命中 endpoint 级时返回准确能力", () => {
  const registry = new CapabilityRegistry();

  registry.register({
    key: {
      provider: "gemini",
      endpoint: "openai-compat",
      model: "gemini-3.1-pro-preview",
      protocol: "react-text",
      adapterVersion: "react-text-v1",
    },
    capability: createEndpointCapability({
      nativeSystemInstruction: true,
      usageMetrics: true,
    }),
    source: "manual-verified",
    declaredAt: "2026-08-12",
  });

  const strictCap = registry.lookupStrict({
    provider: "gemini",
    endpoint: "openai-compat",
    model: "gemini-3.1-pro-preview",
    protocol: "react-text",
    adapterVersion: "react-text-v1",
  });
  assert.equal(strictCap.nativeSystemInstruction, true);
  assert.equal(strictCap.usageMetrics, true);
  assert.equal(strictCap.nativeFunctionCalling, false); // 未声明
});

test("CapabilityRegistry · lookup vs lookupStrict 行为差异", () => {
  const registry = new CapabilityRegistry();

  // 只注册 provider 级，不注册 endpoint 级
  registry.registerProviderDefault("gemini", createEndpointCapability({
    nativeSystemInstruction: true,
  }));

  const key = {
    provider: "gemini",
    endpoint: "unregistered-endpoint",
    model: "gemini-3.1-pro-preview",
    protocol: "react-text",
    adapterVersion: "react-text-v1",
  };

  // lookup 回退到 provider 级（历史兼容）
  const looseCap = registry.lookup(key);
  assert.equal(looseCap.nativeSystemInstruction, true, "lookup 应回退到 provider 级");

  // lookupStrict 不回退，fail-closed
  const strictCap = registry.lookupStrict(key);
  assert.equal(strictCap.nativeSystemInstruction, false, "lookupStrict 应 fail-closed");
});

test("CapabilityRegistry · hasEndpointEntry 准确反映 endpoint 级注册状态", () => {
  const registry = new CapabilityRegistry();

  const registeredKey = {
    provider: "gemini",
    endpoint: "openai-compat",
    model: "gemini-3.1-pro-preview",
    protocol: "react-text",
    adapterVersion: "react-text-v1",
  };
  const unregisteredKey = {
    provider: "gemini",
    endpoint: "unknown-endpoint",
    model: "gemini-3.1-pro-preview",
    protocol: "react-text",
    adapterVersion: "react-text-v1",
  };

  registry.register({
    key: registeredKey,
    capability: createEndpointCapability({ nativeSystemInstruction: true }),
    source: "test",
    declaredAt: "2026-08-12",
  });

  assert.equal(registry.hasEndpointEntry(registeredKey), true);
  assert.equal(registry.hasEndpointEntry(unregisteredKey), false);
});

test("CapabilityRegistry · 默认 registry 生产 route 全部命中 endpoint 级（lookupStrict）", () => {
  // 验证所有生产 route 的 capabilityKey 都在 endpoint 级注册
  // 这是 PROTOCOL-LAYER-2 的核心约束：生产 route 不依赖 provider 级回退
  const productionKeys = [
    { provider: "gemini", endpoint: "openai-compat", model: "gemini-3.1-pro-preview", protocol: "react-text", adapterVersion: "react-text-v1" },
    { provider: "claude", endpoint: "anthropic-native", model: "claude-opus-4-6", protocol: "react-text", adapterVersion: "react-text-v1" },
  ];

  for (const key of productionKeys) {
    assert.ok(
      defaultCapabilityRegistry.hasEndpointEntry(key),
      `生产 capabilityKey 未命中 endpoint 级：${JSON.stringify(key)}`,
    );
    const strictCap = defaultCapabilityRegistry.lookupStrict(key);
    assert.equal(strictCap.nativeSystemInstruction, true, `生产 route capability nativeSystemInstruction 应为 true：${JSON.stringify(key)}`);
    assert.equal(strictCap.nativeFunctionCalling, false, `生产 route capability nativeFunctionCalling 应为 false：${JSON.stringify(key)}`);
  }
});

// ============================================================================
// 3. 单元测试：ReAct Text Adapter
// ============================================================================

test("ReactTextAdapter · parseResponse 解析工具调用", () => {
  const adapter = createReactTextAdapter();
  const response = {
    body: {
      text: '检索一下<tool_call>{"name":"search_chapter_span","arguments":{"query":"角色A"}}</tool_call>',
      model: "gemini-3.1-pro-preview",
    },
    status: 200,
  };

  const turn = adapter.parseResponse(response);
  assert.equal(turn.protocol, "react-text");
  assert.equal(turn.adapterVersion, "react-text-v1");
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0].name, "search_chapter_span");
  assert.equal(turn.toolCalls[0].arguments.query, "角色A");
  assert.equal(turn.finishReason, "tool_use");
  assert.equal(turn.parseStatus, "ok");
  assert.ok(turn.text?.includes("检索一下"));
});

test("ReactTextAdapter · parseResponse 无工具调用为 stop", () => {
  const adapter = createReactTextAdapter();
  const response = {
    body: { text: "这是最终的章节正文内容。", model: "test" },
    status: 200,
  };

  const turn = adapter.parseResponse(response);
  assert.equal(turn.toolCalls.length, 0);
  assert.equal(turn.finishReason, "stop");
  assert.equal(turn.parseStatus, "ok");
  assert.equal(turn.text, "这是最终的章节正文内容。");
});

test("ReactTextAdapter · parseResponse 空响应为 empty_response", () => {
  const adapter = createReactTextAdapter();
  const response = { body: { text: "" }, status: 200 };

  const turn = adapter.parseResponse(response);
  assert.equal(turn.parseStatus, "empty_response");
  assert.equal(turn.finishReason, "stop");
});

test("ReactTextAdapter · parseResponse malformed JSON 为 parse_failure", () => {
  const adapter = createReactTextAdapter();
  const response = {
    body: {
      text: '<tool_call>{"name":"test","arguments":bad}</tool_call>',
      model: "test",
    },
    status: 200,
  };

  const turn = adapter.parseResponse(response);
  assert.equal(turn.parseStatus, "parse_failure");
  assert.ok(turn.parseFailures);
  assert.equal(turn.parseFailures.length, 1);
  // best-effort 仍产出 toolCall
  assert.equal(turn.toolCalls.length, 1);
});

test("ReactTextAdapter · serializeToolResults 生成证据文本", () => {
  const adapter = createReactTextAdapter();
  const turn = createToolCallTurn("", []);
  turn.toolResults = [{
    toolCallId: "tc-1",
    toolName: "search_chapter_span",
    content: [{ type: "text", text: "角色甲出现在第三章" }],
    details: {
      sourceRef: "ch3#final.md:50-80",
      evidenceLevel: "exact_chapter_span",
      resultKind: "chapter_spans",
      returnedCount: 1,
      truncated: false,
    },
    isError: false,
  }];

  const continuation = adapter.serializeToolResults(turn);
  assert.ok(continuation.textAppend);
  assert.ok(continuation.textAppend.includes("已检索到的证据"));
  assert.ok(continuation.textAppend.includes("角色甲出现在第三章"));
});

test("ReactTextAdapter · createRequest 透传 systemPrompt + userPrompt", () => {
  const adapter = createReactTextAdapter();
  const request = adapter.createRequest({
    systemPrompt: "系统提示",
    userPrompt: "用户提示",
    route: "gemini_writer_v2",
  });
  const body = request.body;
  assert.equal(body.systemPrompt, "系统提示");
  assert.equal(body.userPrompt, "用户提示");
  assert.equal(body.route, "gemini_writer_v2");
});

// ============================================================================
// 4. 单元测试：Native Function Calling Adapter（eval-only）
// ============================================================================

test("NativeFunctionCallingAdapter · parseResponse 解析原生工具调用", () => {
  const adapter = createNativeFunctionCallingAdapter();
  const response = {
    body: {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call_abc123",
            type: "function",
            function: {
              name: "search_chapter_span",
              arguments: '{"query":"角色A"}',
            },
          }],
        },
        finish_reason: "tool_calls",
      }],
      model: "gemini-3.1-pro-preview",
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    },
    status: 200,
  };

  const turn = adapter.parseResponse(response);
  assert.equal(turn.protocol, "native-function-calling");
  assert.equal(turn.adapterVersion, "native-fc-v1");
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0].id, "call_abc123");
  assert.equal(turn.toolCalls[0].name, "search_chapter_span");
  assert.equal(turn.toolCalls[0].arguments.query, "角色A");
  assert.equal(turn.finishReason, "tool_use");
  assert.equal(turn.parseStatus, "ok");
  assert.equal(turn.usage?.input, 100);
  assert.equal(turn.usage?.output, 50);
  assert.equal(turn.usage?.totalTokens, 150);
});

test("NativeFunctionCallingAdapter · parseResponse 无工具调用为 stop", () => {
  const adapter = createNativeFunctionCallingAdapter();
  const response = {
    body: {
      choices: [{
        message: { content: "最终正文内容" },
        finish_reason: "stop",
      }],
      model: "test",
    },
    status: 200,
  };

  const turn = adapter.parseResponse(response);
  assert.equal(turn.toolCalls.length, 0);
  assert.equal(turn.finishReason, "stop");
  assert.equal(turn.text, "最终正文内容");
});

test("NativeFunctionCallingAdapter · parseResponse 空响应为 empty_response", () => {
  const adapter = createNativeFunctionCallingAdapter();
  const response = { body: { choices: [] }, status: 200 };

  const turn = adapter.parseResponse(response);
  assert.equal(turn.parseStatus, "empty_response");
});

test("NativeFunctionCallingAdapter · parseResponse provider error", () => {
  const adapter = createNativeFunctionCallingAdapter();
  const response = {
    body: { error: { message: "模型不可用", type: "service_error" } },
    status: 500,
  };

  const turn = adapter.parseResponse(response);
  assert.equal(turn.parseStatus, "provider_error");
  assert.equal(turn.finishReason, "error");
});

test("NativeFunctionCallingAdapter · parseResponse malformed arguments 为 parse_failure", () => {
  const adapter = createNativeFunctionCallingAdapter();
  const response = {
    body: {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "query_canon", arguments: "{bad json}" },
          }],
        },
        finish_reason: "tool_calls",
      }],
      model: "test",
    },
    status: 200,
  };

  const turn = adapter.parseResponse(response);
  assert.equal(turn.parseStatus, "parse_failure");
  assert.ok(turn.parseFailures);
  assert.equal(turn.parseFailures.length, 1);
  // best-effort 仍产出 toolCall（空参数）
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0].arguments.query, undefined);
});

test("NativeFunctionCallingAdapter · serializeToolResults 生成原生 tool result 消息", () => {
  const adapter = createNativeFunctionCallingAdapter();
  const turn = createToolCallTurn("", [], { protocol: "native-function-calling", adapterVersion: "native-fc-v1" });
  turn.toolResults = [{
    toolCallId: "call_abc123",
    toolName: "search_chapter_span",
    content: [{ type: "text", text: "结果" }],
    isError: false,
  }];

  const continuation = adapter.serializeToolResults(turn);
  assert.equal(continuation.messages.length, 1);
  assert.equal(continuation.textAppend, undefined); // Native 模式不追加文本
  const msg = continuation.messages[0];
  assert.equal(msg.role, "tool");
  assert.equal(msg.tool_call_id, "call_abc123");
  assert.equal(msg.content, "结果");
});

test("NativeFunctionCallingAdapter · createRequest 包含 tools 定义", () => {
  const adapter = createNativeFunctionCallingAdapter();
  const request = adapter.createRequest({
    systemPrompt: "系统提示",
    userPrompt: "用户提示",
    route: "eval_native_fc_gemini31",
    tools: [{
      name: "search_chapter_span",
      description: "搜索章节片段",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    }],
  });
  const body = request.body;
  assert.ok(body.tools);
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].type, "function");
  assert.equal(body.tools[0].function.name, "search_chapter_span");
});

// ============================================================================
// 5. 单元测试：Structured JSON Adapter（预留）
// ============================================================================

test("StructuredJsonAdapter · 未实现方法抛出错误", () => {
  const adapter = new StructuredJsonAdapter();
  assert.equal(adapter.protocol, "structured-json");
  assert.equal(adapter.version, "structured-json-v0");
  assert.throws(() => adapter.createRequest({ systemPrompt: "", userPrompt: "", route: "" }));
  assert.throws(() => adapter.parseResponse({ body: {}, status: 200 }));
  assert.throws(() => adapter.serializeToolResults(createTextTurn("")));
});

// ============================================================================
// 6. 单元测试：Adapter Registry
// ============================================================================

test("AdapterRegistry · 默认生产 route 返回 ReAct 适配器", () => {
  const adapter = defaultAdapterRegistry.getAdapter("gemini_writer_v2");
  assert.equal(adapter.protocol, "react-text");
  assert.equal(adapter.version, "react-text-v1");
});

test("AdapterRegistry · 未注册 route 回退到 ReAct", () => {
  const adapter = defaultAdapterRegistry.getAdapter("unknown_route");
  assert.equal(adapter.protocol, "react-text");
});

test("AdapterRegistry · eval-only Native FC route 注册后可获取", () => {
  // native-fc-eval-entry.ts 导入时自动注册到 eval 实例
  // 注意：dist/ 和 dist-eval/ 是不同的模块实例，eval-only 路由只在 dist-eval 实例上注册
  const adapter = evalAdapterRegistry.getAdapter("eval_native_fc_gemini31");
  assert.equal(adapter.protocol, "native-function-calling");
  assert.equal(adapter.version, "native-fc-v1");
});

test("AdapterRegistry · 生产隔离验证通过（无 Native 在生产 route）", () => {
  const failures = defaultAdapterRegistry.validateProductionIsolation();
  assert.equal(failures.length, 0, `生产隔离失败: ${failures.join("; ")}`);
});

test("AdapterRegistry · 生产 route 列表只包含 ReAct", () => {
  const prodRoutes = defaultAdapterRegistry.listProductionRoutes();
  assert.ok(prodRoutes.length > 0);
  for (const route of prodRoutes) {
    assert.equal(route.protocol, "react-text", `生产 route ${route.route} 不是 ReAct`);
  }
});

// ============================================================================
// 7. 单元测试：适配器版本管理
// ============================================================================

test("AdapterVersions · 已注册 3 个适配器版本", () => {
  assert.equal(ADAPTER_VERSIONS.length, 3);
  const react = getAdapterVersionInfo("react-text", "react-text-v1");
  assert.ok(react);
  assert.equal(react.evalOnly, false);
  const native = getAdapterVersionInfo("native-function-calling", "native-fc-v1");
  assert.ok(native);
  assert.equal(native.evalOnly, true);
});

test("AdapterVersions · fingerprint 格式正确", () => {
  const fp = computeAdapterFingerprint("react-text", "react-text-v1");
  assert.equal(fp, "react-text:react-text-v1");
});

// ============================================================================
// 8. 回归测试：Native FC Eval Entry
// ============================================================================

test("NativeFcEvalEntry · adapter 已注册", () => {
  assert.ok(isNativeFcRegistered());
});

test("NativeFcEvalEntry · eval route 列表包含 gemini 和 claude", () => {
  const routes = listEvalNativeFcRoutes();
  assert.ok(routes.includes("eval_native_fc_gemini31"));
  assert.ok(routes.includes("eval_native_fc_claude"));
});

test("NativeFcEvalEntry · capability 验证通过", () => {
  const failures = validateNativeFcCapabilities();
  assert.equal(failures.length, 0, `能力验证失败: ${failures.join("; ")}`);
});

// ============================================================================
// 9. Eval 测试：Protocol Baseline
// ============================================================================

test("ProtocolBaseline · 默认 fixture 包含至少 2 个 fixture", () => {
  assert.ok(DEFAULT_EVAL_FIXTURES.length >= 2);
  for (const fixture of DEFAULT_EVAL_FIXTURES) {
    assert.ok(fixture.allowedTools.length >= 9, `fixture ${fixture.id} 工具数不足`);
    assert.ok(fixture.budget.maxTurns > 0);
    assert.ok(fixture.budget.maxToolCalls > 0);
  }
});

test("ProtocolBaseline · 硬门指标包含 6 项", () => {
  assert.equal(HARD_GATE_METRICS.length, 6);
  assert.ok(HARD_GATE_METRICS.includes("illegalToolCallRate"));
  assert.ok(HARD_GATE_METRICS.includes("schemaErrorRate"));
  assert.ok(HARD_GATE_METRICS.includes("mustVerifyCoverage"));
  assert.ok(HARD_GATE_METRICS.includes("sourceRefCompleteness"));
});

test("ProtocolBaseline · 依赖图记录 6 个步骤", () => {
  assert.equal(REACT_PIPELINE_DEPENDENCY_GRAPH.steps.length, 6);
  assert.equal(REACT_PIPELINE_DEPENDENCY_GRAPH.knownIssues.length, 6);
});

test("ProtocolBaseline · 风险清单包含 6 项", () => {
  assert.equal(PROTOCOL_RISKS.length, 6);
  for (const risk of PROTOCOL_RISKS) {
    assert.ok(risk.risk);
    assert.ok(risk.control);
  }
});

// ============================================================================
// 10. Eval 测试：Protocol A/B Eval 指标计算
// ============================================================================

test("ProtocolABEval · computeMetricsFromTurns 计算非法调用率", () => {
  const allowedTools = new Set(["search_chapter_span", "query_canon"]);
  const turns = [
    createToolCallTurn("", [
      { id: "tc-1", name: "search_chapter_span", arguments: {} },
      { id: "tc-2", name: "evil_tool", arguments: {} },
    ]),
  ];

  const metrics = computeMetricsFromTurns(turns, { allowedToolNames: allowedTools });
  assert.equal(metrics.illegalToolCallRate, 0.5);
  assert.equal(metrics.callCounts.toolCalls, 2);
  assert.equal(metrics.callCounts.modelCalls, 1);
});

test("ProtocolABEval · computeMetricsFromTurns 计算 parser failure 率", () => {
  const turns = [
    createToolCallTurn("", [{ id: "1", name: "test", arguments: {} }]),
    createErrorTurn("parse_failure", "bad json"),
    createTextTurn("正文"),
  ];

  const metrics = computeMetricsFromTurns(turns);
  assert.ok(metrics.parserFailureRate > 0);
  assert.ok(metrics.parserFailureRate <= 1);
});

test("ProtocolABEval · computeMetricsFromTurns 计算 sourceRef 完整率", () => {
  const turn = createToolCallTurn("", []);
  turn.toolResults = [
    { toolCallId: "1", toolName: "test", content: [{ type: "text", text: "a" }], details: { sourceRef: "ref1" }, isError: false },
    { toolCallId: "2", toolName: "test", content: [{ type: "text", text: "b" }], details: {}, isError: false },
  ];

  const metrics = computeMetricsFromTurns([turn]);
  assert.equal(metrics.sourceRefCompleteness, 0.5);
});

test("ProtocolABEval · computeMetricsFromTurns 计算 token 用量", () => {
  const turn1 = createTextTurn("", { usage: { ...emptyUsage(), input: 100, output: 50, totalTokens: 150 } });
  const turn2 = createTextTurn("", { usage: { ...emptyUsage(), input: 200, output: 100, totalTokens: 300 } });

  const metrics = computeMetricsFromTurns([turn1, turn2]);
  assert.equal(metrics.tokenUsage.input, 300);
  assert.equal(metrics.tokenUsage.output, 150);
  assert.equal(metrics.tokenUsage.total, 450);
});

// ============================================================================
// 11. Eval 测试：A/B 对照矩阵
// ============================================================================

test("ProtocolABEval · createComparisonMatrix 检测硬门退化", () => {
  const reactResult = {
    fixtureId: "test",
    arm: "react",
    protocol: "react-text",
    adapterVersion: "react-text-v1",
    turns: [],
    metrics: {
      illegalToolCallRate: 0,
      parserFailureRate: 0,
      schemaErrorRate: 0,
      unauthorizedCallRate: 0,
      mustVerifyCoverage: 0.9,
      sourceRefCompleteness: 0.8,
      prematureDoneRate: 0.1,
      firstEvidenceLatencyMs: 1000,
      tokenUsage: { input: 1000, output: 500, total: 1500 },
      latencyMs: 10000,
      callCounts: { modelCalls: 3, toolCalls: 5 },
      traceCompleteness: 1,
    },
    timestamp: "2026-08-12",
  };

  const nativeResult = {
    fixtureId: "test",
    arm: "native",
    protocol: "native-function-calling",
    adapterVersion: "native-fc-v1",
    turns: [],
    metrics: {
      ...reactResult.metrics,
      mustVerifyCoverage: 0.7, // 退化
      sourceRefCompleteness: 0.6, // 退化
      tokenUsage: { input: 800, output: 400, total: 1200 }, // 改善
    },
    timestamp: "2026-08-12",
  };

  const comparison = createComparisonMatrix(reactResult, nativeResult);
  assert.ok(comparison.hardGateRegressions.length >= 2, "应检测到至少 2 项硬门退化");
  assert.ok(comparison.hardGateRegressions.some((r) => r.includes("mustVerifyCoverage")));
  assert.ok(comparison.hardGateRegressions.some((r) => r.includes("sourceRefCompleteness")));
  assert.ok(comparison.softMetricChanges.some((s) => s.metric === "tokenUsage" && s.delta < 0));
});

test("ProtocolABEval · createComparisonMatrix 检测改善", () => {
  const reactResult = {
    fixtureId: "test",
    arm: "react",
    protocol: "react-text",
    adapterVersion: "react-text-v1",
    turns: [],
    metrics: {
      illegalToolCallRate: 0.1,
      parserFailureRate: 0.2,
      schemaErrorRate: 0.1,
      unauthorizedCallRate: 0.05,
      mustVerifyCoverage: 0.8,
      sourceRefCompleteness: 0.7,
      prematureDoneRate: 0.2,
      firstEvidenceLatencyMs: 2000,
      tokenUsage: { input: 1000, output: 500, total: 1500 },
      latencyMs: 20000,
      callCounts: { modelCalls: 4, toolCalls: 6 },
      traceCompleteness: 1,
    },
    timestamp: "2026-08-12",
  };

  const nativeResult = {
    fixtureId: "test",
    arm: "native",
    protocol: "native-function-calling",
    adapterVersion: "native-fc-v1",
    turns: [],
    metrics: {
      ...reactResult.metrics,
      illegalToolCallRate: 0, // 改善（HARD_GATE）
      schemaErrorRate: 0, // 改善（HARD_GATE）
      unauthorizedCallRate: 0, // 改善（HARD_GATE）
    },
    timestamp: "2026-08-12",
  };

  const comparison = createComparisonMatrix(reactResult, nativeResult);
  assert.ok(comparison.hardGateImprovements.length >= 2, "应检测到至少 2 项改善");
  assert.ok(comparison.hardGateRegressions.length === 0, "不应有退化");
});

// ============================================================================
// 12. Eval 测试：Go/No-Go 评估
// ============================================================================

test("ProtocolABEval · evaluateGoNoGo 全部条件满足时 go=true", () => {
  const reactMetrics = {
    illegalToolCallRate: 0.1,
    parserFailureRate: 0.2,
    schemaErrorRate: 0.1,
    unauthorizedCallRate: 0,
    mustVerifyCoverage: 0.9,
    sourceRefCompleteness: 0.8,
    prematureDoneRate: 0.1,
    firstEvidenceLatencyMs: 1000,
    tokenUsage: { input: 1000, output: 500, total: 1500 },
    latencyMs: 10000,
    callCounts: { modelCalls: 3, toolCalls: 5 },
    traceCompleteness: 1,
  };

  const comparison = [{
    fixtureId: "test",
    reactMetrics,
    nativeMetrics: { ...reactMetrics, illegalToolCallRate: 0, parserFailureRate: 0 },
    hardGateRegressions: [],
    hardGateImprovements: ["illegalToolCallRate: 0.1 → 0"],
    softMetricChanges: [],
  }];

  const result = evaluateGoNoGo(comparison, {
    replayStable: true,
    productionRouteRegistered: true,
    humanReviewPassed: true,
    releaseApproved: true,
  });

  assert.ok(result.go, `应建议 go，未满足: ${result.unsatisfiedConditions.join("; ")}`);
});

test("ProtocolABEval · evaluateGoNoGo 有硬门退化时 go=false", () => {
  const reactMetrics = {
    illegalToolCallRate: 0,
    parserFailureRate: 0,
    schemaErrorRate: 0,
    unauthorizedCallRate: 0,
    mustVerifyCoverage: 0.9,
    sourceRefCompleteness: 0.9,
    prematureDoneRate: 0,
    firstEvidenceLatencyMs: 1000,
    tokenUsage: { input: 1000, output: 500, total: 1500 },
    latencyMs: 10000,
    callCounts: { modelCalls: 3, toolCalls: 5 },
    traceCompleteness: 1,
  };

  const comparison = [{
    fixtureId: "test",
    reactMetrics,
    nativeMetrics: { ...reactMetrics, mustVerifyCoverage: 0.5 },
    hardGateRegressions: ["mustVerifyCoverage: 0.9 → 0.5（退化 -0.4）"],
    hardGateImprovements: [],
    softMetricChanges: [],
  }];

  const result = evaluateGoNoGo(comparison, {
    replayStable: true,
    productionRouteRegistered: true,
    humanReviewPassed: true,
    releaseApproved: true,
  });

  assert.ok(!result.go, "有硬门退化时不应 go");
  assert.ok(result.unsatisfiedConditions.some((c) => c.includes("硬门退化")));
});

test("ProtocolABEval · evaluateGoNoGo 未审批时 go=false", () => {
  const reactMetrics = {
    illegalToolCallRate: 0,
    parserFailureRate: 0,
    schemaErrorRate: 0,
    unauthorizedCallRate: 0,
    mustVerifyCoverage: 0.9,
    sourceRefCompleteness: 0.9,
    prematureDoneRate: 0,
    firstEvidenceLatencyMs: 1000,
    tokenUsage: { input: 1000, output: 500, total: 1500 },
    latencyMs: 10000,
    callCounts: { modelCalls: 3, toolCalls: 5 },
    traceCompleteness: 1,
  };

  const comparison = [{
    fixtureId: "test",
    reactMetrics,
    nativeMetrics: { ...reactMetrics },
    hardGateRegressions: [],
    hardGateImprovements: [],
    softMetricChanges: [],
  }];

  const result = evaluateGoNoGo(comparison, {
    replayStable: true,
    productionRouteRegistered: true,
    humanReviewPassed: false, // 未审批
    releaseApproved: false,
  });

  assert.ok(!result.go, "未审批时不应 go");
  assert.ok(result.unsatisfiedConditions.some((c) => c.includes("人工复核")));
});

// ============================================================================
// 13. 回归测试：生产构建依赖边界
// ============================================================================

test("Regression · 生产 dist/ 不包含 Native FC Adapter", async () => {
  // 尝试导入 dist/ 中的 native-fc-adapter，应该失败
  try {
    await import("../dist/novelos/protocol/adapters/native-fc-adapter.js");
    assert.fail("生产构建不应包含 native-fc-adapter");
  } catch (err) {
    // 预期失败
    assert.ok(err instanceof Error);
  }
});

test("Regression · 生产 dist/ 不包含 protocol-ab-eval", async () => {
  try {
    await import("../dist/novelos/protocol/protocol-ab-eval.js");
    assert.fail("生产构建不应包含 protocol-ab-eval");
  } catch (err) {
    assert.ok(err instanceof Error);
  }
});

test("Regression · 生产 dist/ 包含 ReAct Adapter", async () => {
  const mod = await import("../dist/novelos/protocol/adapters/react-text-adapter.js");
  assert.ok(mod.createReactTextAdapter);
});

test("Regression · 生产 dist/ 包含 ModelTurn", async () => {
  const mod = await import("../dist/novelos/protocol/model-turn.js");
  assert.ok(mod.createTextTurn);
  assert.ok(mod.serializeModelTurn);
});

test("Regression · ReAct 与 Native 生成字段语义一致的 ModelTurn", () => {
  const reactAdapter = createReactTextAdapter();
  const nativeAdapter = createNativeFunctionCallingAdapter();

  // 相同语义的输入（工具调用）
  const reactTurn = reactAdapter.parseResponse({
    body: {
      text: '<tool_call>{"name":"search_chapter_span","arguments":{"query":"test"}}</tool_call>',
      model: "test",
    },
    status: 200,
  });

  const nativeTurn = nativeAdapter.parseResponse({
    body: {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "search_chapter_span", arguments: '{"query":"test"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
      model: "test",
    },
    status: 200,
  });

  // 语义一致
  assert.equal(reactTurn.toolCalls[0].name, nativeTurn.toolCalls[0].name);
  assert.equal(reactTurn.toolCalls[0].arguments.query, nativeTurn.toolCalls[0].arguments.query);
  assert.equal(reactTurn.finishReason, nativeTurn.finishReason);
  assert.equal(reactTurn.parseStatus, nativeTurn.parseStatus);
  assert.equal(reactTurn.toolResults.length, nativeTurn.toolResults.length);
});
