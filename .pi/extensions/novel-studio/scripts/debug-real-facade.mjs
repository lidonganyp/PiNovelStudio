#!/usr/bin/env node
/**
 * DEBUG-REAL-FACADE：诊断真实模型对 B 组 facade 的原始输出。
 * 直接调用 createRealModelDecide，打印收到的 system prompt 与模型原始输出。
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const EXT_ROOT = resolve(dirname(__filename), "..");
const DIST = join(EXT_ROOT, "dist-eval");

process.env.PINOVEL_PROJECT_ROOT = resolve(EXT_ROOT, "..", "..", "..", "..");
process.env.PINOVEL_DISABLE_FALLBACK = "1";
process.env.PINOVEL_BENCHMARK_COST_PROFILE = "package_screening";

const runner = await import(pathToFileURL(join(DIST, "novelos", "eval", "tool-ab-real-runner.js")).href);
const adapter = await import(pathToFileURL(join(DIST, "v2", "adapters", "legacy-model-route-adapter.js")).href);
const injector = await import(pathToFileURL(join(DIST, "novelos", "adapters", "tool-schema-injector.js")).href);
const narrTools = await import(pathToFileURL(join(DIST, "novelos", "tools", "narrative-tools.js")).href);
const facadeMod = await import(pathToFileURL(join(DIST, "novelos", "eval", "typed-facade-tool.js")).href);

const modelFn = adapter.createLegacyModelGenerateFn();

// 构造 B 组 facade 注入后的 systemPrompt
const searchService = { stub: true };
const facadeTool = facadeMod.createTypedFacadeTool({ searchService });
const injectedSystem = injector.injectToolSchemas(
  "你是检索驱动的叙事证据决策代理。请根据检索计划与可见工具，自主决定调用哪个工具收集证据，证据充分后输出最终正文。",
  [facadeTool],
  new Set([facadeMod.QUERY_NARRATIVE_NAME]),
);
process.stderr.write("[debug] ==== 注入后的 B 组 systemPrompt ====\n" + injectedSystem + "\n====\n");

const ctx = {
  prompt: "本章需要验证以下事实（mustVerify）：\n- 青鱼嘴水域有暗流",
  systemPrompt: injectedSystem,
  visibleTools: ["query_narrative"],
  history: [],
  round: 0,
  seed: 0,
};

process.stderr.write("[debug] 直接调用真实模型，打印原始输出（连续 3 次）...\n");
for (let i = 0; i < 3; i++) {
  const out = await modelFn({
    route: "narrator_testing_glm",
    systemPrompt: ctx.systemPrompt,
    userPrompt: ctx.prompt,
    kind: "tool_ab_real_decision",
    maxTokens: 2048,
    timeoutMs: 60000,
    temperature: 0.72,
    seed: i,
  });
  process.stderr.write(`[debug] 第 ${i + 1} 次原始输出 text:\n---\n${out.text}\n---\n`);
}
process.exit(0);