/**
 * PHASE4-TOOL-AB-REAL-DECIDE：真实模型决策注入单元测试（stub model，零 API）
 *
 * 验证 createRealModelDecide 的 prompt 组装与 ReAct 指令解析，不触发生成：
 * 1. 系统 prompt 透传 runner 注入的工具 schema（ctx.systemPrompt）
 * 2. 用户 prompt 回灌已发生回合的工具结果文本（决策连续性）
 * 3. 含 `<tool_call>` 指令 → 解析为 tool_call 决策（name/arguments）
 * 4. facade 场景 → 从 arguments 提取 intent
 * 5. 无指令的正文 → final 决策
 * 6. dry-run replay 的回合带 resultText（回归：真实模型决策连续性依据）
 *
 * 授权边界：全部使用 stub model（返回固定文本），零真实 API。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
const RUNNER_PATH = join(
  EXTENSION_ROOT,
  "dist-eval",
  "novelos",
  "eval",
  "tool-ab-real-runner.js",
);

async function importRunner() {
  return import(`file://${RUNNER_PATH}`);
}

/** 构造 ToolAbModelFnCtx（含一个工具回合 history，携带 resultText） */
function makeCtx(overrides = {}) {
  return {
    prompt: "本章需要验证以下事实（mustVerify）：\n- 青鱼嘴水域有暗流",
    systemPrompt: "SYS<!-- 工具调用约定 -->",
    visibleTools: ["query_canon", "search_narrative_evidence"],
    history: [
      {
        round: 0,
        decision: { kind: "tool_call", toolName: "query_canon", arguments: { category: "timeline" } },
        selectedTool: "query_canon",
        intent: null,
        intentValid: true,
        routedTool: "query_canon",
        routedOk: true,
        parseError: null,
        latencyMs: 5,
        resultChars: 20,
        estimateTokens: 10,
        evidenceLevel: "confirmed",
        sourceRef: "skeleton.json#e1",
        sourceRefValid: true,
        sourceRefInvalidCategory: null,
        empty: false,
        timeout: false,
        isError: false,
        duplicateQuery: false,
        firstValidEvidence: true,
        resultText: "青鱼嘴水域有暗流（来源：skeleton.json#e1）",
      },
    ],
    round: 1,
    seed: 0,
    ...overrides,
  };
}

/** 返回固定文本的 stub model fn，可捕获收到的 system/user prompt */
function stubModel(text) {
  const calls = [];
  const fn = async (input) => {
    calls.push(input);
    return {
      text,
      model: "glm-5.2",
      route: input.route,
      provider: "glm",
      durationMs: 1,
    };
  };
  fn.calls = calls;
  return fn;
}

describe("PHASE4-TOOL-AB-REAL-DECIDE-1：prompt 组装", () => {
  it("system prompt 透传注入的工具 schema，user prompt 回灌历史工具结果文本", async () => {
    const runner = await importRunner();
    const model = stubModel("青鱼嘴水域有暗流。");
    const decide = runner.createRealModelDecide({ modelFn: model, route: "narrator_testing_glm" });
    const decision = await decide(makeCtx());

    assert.equal(model.calls.length, 1, "真实模型应被调用一次");
    const input = model.calls[0];
    // system prompt 透传 runner 注入的 schema（含工具调用约定）
    assert.equal(input.systemPrompt, "SYS<!-- 工具调用约定 -->", "system prompt 应透传");
    // user prompt 回灌历史工具结果文本（决策连续性）
    assert.ok(
      input.userPrompt.includes("青鱼嘴水域有暗流（来源：skeleton.json#e1）"),
      "user prompt 应包含历史工具结果文本",
    );
    assert.ok(input.userPrompt.includes("query_canon"), "user prompt 应包含历史工具名");
    assert.ok(input.userPrompt.includes("青鱼嘴水域有暗流"), "user prompt 应包含 mustVerify 检索计划");
    // 路由与 kind 契约
    assert.equal(input.route, "narrator_testing_glm");
    assert.equal(input.kind, "tool_ab_real_decision");
    // 无指令 → final（评测边界：只返回终止标记，不生成正文）
    assert.equal(decision.kind, "final");
    assert.equal(decision.text, runner.REAL_DONE_MARKER, "final 应只返回终止标记，不生成正文");
  });
});

describe("PHASE4-TOOL-AB-REAL-DECIDE-2：ReAct 指令解析", () => {
  it("含 <tool_call> 指令 → tool_call 决策（解析 name/arguments）", async () => {
    const runner = await importRunner();
    const model = stubModel('<工具调用>{"工具":"query_canon","参数":{"category":"location"}}</工具调用>');
    const decide = runner.createRealModelDecide({ modelFn: model, route: "narrator_testing_glm" });
    const decision = await decide(makeCtx());

    assert.equal(decision.kind, "tool_call");
    assert.equal(decision.toolName, "query_canon");
    assert.deepEqual(decision.arguments, { category: "location" });
  });

  it("facade 场景：从 arguments 提取 intent", async () => {
    const runner = await importRunner();
    const model = stubModel('<工具调用>{"工具":"query_narrative","参数":{"intent":"canon","query":"血玉"}}</工具调用>');
    const decide = runner.createRealModelDecide({ modelFn: model, route: "narrator_testing_glm" });
    const decision = await decide(makeCtx());

    assert.equal(decision.kind, "tool_call");
    assert.equal(decision.toolName, "query_narrative");
    assert.equal(decision.intent, "canon", "应从 arguments 提取 intent");
    assert.deepEqual(decision.arguments, { intent: "canon", query: "血玉" });
  });

  it("facade 场景：模型输出中文意图标签会映射回英文协议值", async () => {
    const runner = await importRunner();
    // 模型经 schema 注入看到中文意图标签，输出中文；runner 应映射回英文路由。
    const model = stubModel('<工具调用>{"工具":"统一叙事查询","参数":{"意图":"世界事实查询","查询词":"血玉"}}</工具调用>');
    const decide = runner.createRealModelDecide({ modelFn: model, route: "narrator_testing_glm" });
    const decision = await decide(makeCtx());

    assert.equal(decision.kind, "tool_call");
    assert.equal(decision.toolName, "query_narrative", "中文工具名应解析回 query_narrative");
    assert.equal(decision.intent, "canon", "中文意图标签应映射回英文协议值 canon");
    // 中文参数名应映射回英文（查询词→query），且 intent 被写回英文协议值
    assert.deepEqual(decision.arguments, { intent: "canon", query: "血玉" });
  });

  it("无指令 → final 决策（只返回终止标记，不生成正文）", async () => {
    const runner = await importRunner();
    const model = stubModel("青鱼嘴水域有暗流，水下暗流涌动。");
    const decide = runner.createRealModelDecide({ modelFn: model, route: "narrator_testing_glm" });
    const decision = await decide(makeCtx());
    assert.equal(decision.kind, "final");
    assert.equal(decision.text, runner.REAL_DONE_MARKER, "final 应只返回终止标记，不生成正文");
  });
});

describe("PHASE4-TOOL-AB-REAL-DECIDE-3：runner 回合 resultText 回归", () => {
  it("dry-run replay 的回合带 resultText（决策连续性依据）", async () => {
    const runner = await importRunner();
    const comparison = await runner.runRealToolAbReplay();
    for (const p of comparison.scenarios) {
      for (const arm of ["A", "B"]) {
        for (const m of arm === "A" ? p.A : p.B) {
          for (const t of m.turns) {
            assert.equal(typeof t.resultText, "string", `回合 ${t.round} 应有 resultText 字符串`);
            if (t.decision.kind === "final") {
              assert.ok(t.resultText.length > 0, "final 回合 resultText 应为终止标记");
            }
          }
        }
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DECIDE-4：malformed JSON 指令记录解析失败（fix 4a）
// ─────────────────────────────────────────────────────────────────────────────

describe("PHASE4-TOOL-AB-REAL-DECIDE-4：malformed JSON 指令记录解析失败", () => {
  it("parser 记录 parseFailures（不静默吞掉 malformed 指令）", async () => {
    const parser = await import(
      `file://${join(EXTENSION_ROOT, "dist-eval", "novelos", "adapters", "react-tool-call-parser.js")}`
    );
    // 未闭合 JSON：JSON.parse 抛错，应记录 1 条 parseFailures，同时仍产出 best-effort 调用
    const out = parser.parseToolCallDirectives('<工具调用>{"工具":"query_canon"</工具调用>');
    assert.equal(out.hasToolCall, true);
    assert.equal(out.parseFailures.length, 1, "malformed 指令应记录 1 条 parseFailures");
    assert.equal(out.parseFailures[0].index, 0);
    assert.ok(
      out.parseFailures[0].reason.includes("解析失败"),
      `reason 应含解析失败，实际=${out.parseFailures[0].reason}`,
    );
    assert.equal(out.toolCalls.length, 1, "容错解析仍应产出 best-effort 调用");
  });

  it("合法 JSON 指令不产生 parseFailures", async () => {
    const parser = await import(
      `file://${join(EXTENSION_ROOT, "dist-eval", "novelos", "adapters", "react-tool-call-parser.js")}`
    );
    const out = parser.parseToolCallDirectives(
      '<工具调用>{"工具":"query_canon","参数":{"category":"location"}}</工具调用>',
    );
    assert.equal(out.hasToolCall, true);
    assert.equal(out.parseFailures.length, 0, "合法 JSON 不应有解析失败");
    assert.equal(out.toolCalls[0].name, "query_canon");
  });

  it("createRealModelDecide 把 parseFailures 透传给决策 parseError", async () => {
    const runner = await importRunner();
    const model = stubModel('<工具调用>{"工具":"query_canon"</工具调用>');
    const decide = runner.createRealModelDecide({ modelFn: model, route: "narrator_testing_glm" });
    const decision = await decide(makeCtx());
    assert.equal(decision.kind, "tool_call");
    assert.ok(decision.parseError, "应透传 directive 解析失败");
    assert.ok(
      decision.parseError.includes("JSON") || decision.parseError.includes("解析失败"),
      `parseError 应含解析失败描述，实际=${decision.parseError}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DECIDE-5：模型决策超时被 timeoutMs 包住（fix 4b）
// ─────────────────────────────────────────────────────────────────────────────

describe("PHASE4-TOOL-AB-REAL-DECIDE-5：模型决策超时被 timeoutMs 包住", () => {
  it("永不返回的模型决策被超时并记录 timeout 回合", async () => {
    const runner = await importRunner();
    const baseline = await import(
      `file://${join(EXTENSION_ROOT, "dist-eval", "novelos", "eval", "tool-interface-baseline.js")}`
    );
    const scenario = baseline.BASELINE_SCENARIOS.find((s) => s.id === "SC1-canon-fact");
    assert.ok(scenario, "SC1-canon-fact 场景应存在");
    const neverResolve = async () => new Promise(() => {});
    const metrics = await runner.runRealToolAbScenario({
      scenario,
      arm: "A",
      seed: 0,
      modelFn: neverResolve,
      timeoutMs: 50,
    });
    assert.ok(metrics.timeouts >= 1, "应记录至少 1 次超时");
    assert.ok(metrics.errors >= 1, "超时应计入错误");
    assert.ok(metrics.turns.some((t) => t.timeout), "应有 timeout 回合");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DECIDE-6：正文诱导 prompt 边界（PHASE4-2-1-1 F1 回归）
// ─────────────────────────────────────────────────────────────────────────────

describe("PHASE4-TOOL-AB-REAL-DECIDE-6：正文诱导 prompt 边界", () => {
  it("buildRealPrompt 要求只输出终止标记，禁止生成正文", async () => {
    const runner = await importRunner();
    const baseline = await import(
      `file://${join(EXTENSION_ROOT, "dist-eval", "novelos", "eval", "tool-interface-baseline.js")}`
    );
    const scenario = baseline.BASELINE_SCENARIOS.find((s) => s.id === "SC1-canon-fact");
    assert.ok(scenario, "SC1-canon-fact 场景应存在");
    const prompt = runner.buildRealPrompt(scenario);
    // 必须包含终止标记；不得再诱导生成正文
    assert.ok(prompt.includes(runner.REAL_DONE_MARKER), "prompt 应包含 <done> 终止标记");
    assert.ok(!prompt.includes("生成正文"), "prompt 不得包含「生成正文」诱导");
    assert.ok(!/输出正文|生成.{0,6}正文/.test(prompt), "prompt 不得诱导输出正文");
  });

  it("真实模型 user prompt 走 buildRealPrompt（含终止标记、无正文诱导）", async () => {
    const runner = await importRunner();
    const baseline = await import(
      `file://${join(EXTENSION_ROOT, "dist-eval", "novelos", "eval", "tool-interface-baseline.js")}`
    );
    const scenario = baseline.BASELINE_SCENARIOS.find((s) => s.id === "SC1-canon-fact");
    assert.ok(scenario, "SC1-canon-fact 场景应存在");
    const model = stubModel("");
    const decide = runner.createRealModelDecide({ modelFn: model, route: "narrator_testing_glm" });
    // 用 runner 的 buildRealPrompt 构造 ctx.prompt，模拟真实主链路 prompt 来源
    const ctx = makeCtx({ prompt: runner.buildRealPrompt(scenario) });
    await decide(ctx);
    const input = model.calls[0];
    assert.ok(input.userPrompt.includes(runner.REAL_DONE_MARKER), "user prompt 应含终止标记");
    assert.ok(!input.userPrompt.includes("生成正文"), "user prompt 不得诱导生成正文");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DECIDE-7：真实模型采样/路由 provenance（PHASE4-2-1-1 F2/F3/F4）
// ─────────────────────────────────────────────────────────────────────────────

describe("PHASE4-TOOL-AB-REAL-DECIDE-7：采样/路由 provenance 贯通", () => {
  it("createRealModelDecide 从模型输出透传 provider/model/route/temperature/seed/fallback", async () => {
    const runner = await importRunner();
    const model = stubModel("");
    // 模拟真实 legacy 输出携带 provenance 字段
    model.impl = async (input) => ({
      text: "",
      model: "glm-5.2",
      route: "narrator_testing_glm",
      provider: "glm",
      durationMs: 1,
      maxTokens: 2048,
      actuallyAppliedTemperature: 0.72,
      seedApplied: true,
      seedSupported: true,
      fallbackDisabled: true,
    });
    const decide = runner.createRealModelDecide({
      modelFn: async (input) => model.impl(input),
      route: "narrator_testing_glm",
      temperature: 0.7,
      maxTokens: 2048,
    });
    const decision = await decide(makeCtx());
    assert.equal(decision.kind, "final");
    assert.equal(decision.provenance?.provider, "glm");
    assert.equal(decision.provenance?.model, "glm-5.2");
    assert.equal(decision.provenance?.route, "narrator_testing_glm");
    assert.equal(decision.provenance?.temperature, 0.72, "应透传实际生效温度");
    assert.equal(decision.provenance?.seedApplied, true);
    assert.equal(decision.provenance?.seedSupported, true);
    assert.equal(decision.provenance?.maxTokens, 2048);
    assert.equal(decision.provenance?.fallbackDisabled, true);
  });

  it("runRealToolAbReplay real 模式聚合携带 provenance，dry-run 不携带", async () => {
    const runner = await importRunner();
    const baseline = await import(
      `file://${join(EXTENSION_ROOT, "dist-eval", "novelos", "eval", "tool-interface-baseline.js")}`
    );
    const scenario = baseline.BASELINE_SCENARIOS.find((s) => s.id === "SC1-canon-fact");
    assert.ok(scenario, "SC1-canon-fact 场景应存在");
    // 真实模型 fn：返回 final + provenance
    const realFn = async () => ({
      kind: "final",
      text: runner.REAL_DONE_MARKER,
      provenance: {
        provider: "glm",
        model: "glm-5.2",
        route: "narrator_testing_glm",
        temperature: 0.72,
        seedApplied: true,
        seedSupported: true,
        maxTokens: 2048,
        fallbackDisabled: true,
      },
    });
    const realCmp = await runner.runRealToolAbReplay({ modelFn: realFn, seeds: [0] });
    assert.equal(realCmp.mode, "real", "传入 modelFn 应标记 real 模式");
    assert.equal(realCmp.aggregation.A.provenance?.provider, "glm");
    assert.equal(realCmp.aggregation.B.provenance?.provider, "glm");
    // Markdown provenance 区块应出现
    const md = runner.formatRealToolAbMarkdown(realCmp);
    assert.ok(md.includes("采样与路由 provenance"), "Markdown 应含 provenance 区块");
    assert.ok(md.includes("actual provider"), "Markdown 应含 actual provider");
    assert.ok(md.includes("seed 被支持"), "Markdown 应含 seed 支持状态");

    // dry-run 不带 provenance
    const dryCmp = await runner.runRealToolAbReplay();
    assert.equal(dryCmp.mode, "dry-run");
    assert.equal(dryCmp.aggregation.A.provenance, undefined, "dry-run 不应携带 provenance");
  });

  it("全部门禁字段在 Markdown 中展示（含 evidenceLevel/错误/超时/非法工具/解析失败）", async () => {
    const runner = await importRunner();
    const cmp = await runner.runRealToolAbReplay();
    const md = runner.formatRealToolAbMarkdown(cmp);
    for (const label of [
      "无效 sourceRef 分类不恶化",
      "evidenceLevel 命中率不降级",
      "失败（errors）不恶化",
      "超时（timeouts）不恶化",
      "非法工具选择不恶化",
      "解析失败不恶化",
    ]) {
      assert.ok(md.includes(label), `Markdown 应展示门禁字段「${label}」`);
    }
  });
});