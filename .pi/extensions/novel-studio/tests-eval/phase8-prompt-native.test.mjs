/**
 * Phase 8 Stage P — Prompt-only 确定性测试（纯本地，零模型调用）
 *
 * 覆盖（见 docs/phase8-gemini-prompt-native-design.md §4）：
 * 1. gemini-prompt-library：Gemini 专属 Prompt 非空、与通用基线不同、eval-only 语义
 * 2. prompt-ab-gate：门禁逻辑确定性（B 与 A 相同→硬门过/token 加分项false；B 更差→硬门挂）
 * 3. prompt-ab-runner：stub replay 框架确定性（零模型调用，schema/mode/arms/seeds/aggregation/gate）
 * 4. systemPromptOverride fail-closed：生产未授权禁止注入；显式授权后守卫放行
 *
 * import 自 dist-eval/（eval-only 模块）与 dist/（生产模块，验证 fail-closed）。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE,
  GEMINI_SYSTEM_PROMPT,
} from "../dist-eval/novelos/eval/gemini-prompt-library.js";
import {
  evaluatePromptGate,
} from "../dist-eval/novelos/eval/prompt-ab-gate.js";
import {
  runPromptAbReplay,
  formatPromptAbJson,
  formatPromptAbMarkdown,
} from "../dist-eval/novelos/eval/prompt-ab-runner.js";
import { REAL_SYSTEM_PROMPT_BASE } from "../dist-eval/novelos/eval/tool-ab-real-runner.js";
import { createAgenticRawCandidateSource } from "../dist/novelos/agent/agentic-raw-candidate-source.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. gemini-prompt-library：Gemini 专属 Prompt 定义
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 8 Stage P gemini-prompt-library", () => {
  test("检索决策 Prompt 非空且与通用基线不同", () => {
    assert.ok(GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE.length > 0);
    assert.ok(REAL_SYSTEM_PROMPT_BASE.length > 0);
    assert.notEqual(GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE, REAL_SYSTEM_PROMPT_BASE);
  });

  test("生成面 Prompt 非空且与检索面不同", () => {
    assert.ok(GEMINI_SYSTEM_PROMPT.length > 0);
    assert.notEqual(GEMINI_SYSTEM_PROMPT, GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE);
  });

  test("检索面 Prompt 强调合法 JSON 工具字面量与终止标记（P-B 语义锚点）", () => {
    assert.match(GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE, /<tool_call>/);
    assert.match(GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE, /<done>/);
    assert.match(GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE, /sourceRef/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. prompt-ab-gate：门禁确定性
// ─────────────────────────────────────────────────────────────────────────────

/** 构造最小 PromptArmAggregation */
function mkAgg(overrides = {}) {
  return {
    totalCalls: 10,
    totalEstimateTokens: 1000,
    avgCoverageRatio: 0.8,
    sourceRefCompleteness: 0.85,
    invalidToolSelections: 0,
    parseErrors: 0,
    emptyResults: 0,
    errors: 0,
    timeouts: 0,
    stopRate: 0.9,
    avgFirstEvidenceLatencyMs: 100,
    ...overrides,
  };
}

describe("Phase 8 Stage P prompt-ab-gate", () => {
  test("B 与 A 完全一致 → 硬门全过，token 加分项 false（不含 token 不阻塞）", () => {
    const a = mkAgg();
    const b = mkAgg();
    const g = evaluatePromptGate(a, b);
    assert.equal(g.coverageNotDegraded, true);
    assert.equal(g.sourceRefNotDegraded, true);
    assert.equal(g.invalidCallsNotWorsened, true);
    assert.equal(g.emptyResultsNotWorsened, true);
    assert.equal(g.stopRateNotDegraded, true);
    assert.equal(g.allHardPassed, true);
    // token 未下降（B == A×1.0），加分项 false，但 allPassed 依赖它 → false
    assert.equal(g.tokenCostReduced, false);
    assert.equal(g.allPassed, false);
  });

  test("B 覆盖率低于 A 超过容差（0.05）→ 硬门挂", () => {
    const a = mkAgg({ avgCoverageRatio: 0.8 });
    const b = mkAgg({ avgCoverageRatio: 0.74 }); // 差 0.06 > 0.05
    const g = evaluatePromptGate(a, b);
    assert.equal(g.coverageNotDegraded, false);
    assert.equal(g.allHardPassed, false);
  });

  test("B 覆盖率等于 A−0.05（容差内）→ 硬门过", () => {
    const a = mkAgg({ avgCoverageRatio: 0.8 });
    const b = mkAgg({ avgCoverageRatio: 0.75 }); // 差 0.05 == 容差
    const g = evaluatePromptGate(a, b);
    assert.equal(g.coverageNotDegraded, true);
  });

  test("B sourceRef 完整率低于 A 超过容差 → 硬门挂", () => {
    const a = mkAgg({ sourceRefCompleteness: 0.85 });
    const b = mkAgg({ sourceRefCompleteness: 0.79 }); // 差 0.06 > 0.05
    const g = evaluatePromptGate(a, b);
    assert.equal(g.sourceRefNotDegraded, false);
    assert.equal(g.allHardPassed, false);
  });

  test("B 非法工具选择或解析失败高于 A → 硬门挂", () => {
    const a = mkAgg({ invalidToolSelections: 0, parseErrors: 0 });
    const b = mkAgg({ invalidToolSelections: 1, parseErrors: 0 });
    assert.equal(evaluatePromptGate(a, b).invalidCallsNotWorsened, false);
    const c = mkAgg({ invalidToolSelections: 0, parseErrors: 1 });
    assert.equal(evaluatePromptGate(a, c).invalidCallsNotWorsened, false);
  });

  test("B 空结果高于 A → 硬门挂", () => {
    const a = mkAgg({ emptyResults: 0 });
    const b = mkAgg({ emptyResults: 1 });
    assert.equal(evaluatePromptGate(a, b).emptyResultsNotWorsened, false);
  });

  test("B 停止率低于 A 超过容差（0.05）→ 硬门挂", () => {
    const a = mkAgg({ stopRate: 0.9 });
    const b = mkAgg({ stopRate: 0.84 }); // 差 0.06 > 0.05
    assert.equal(evaluatePromptGate(a, b).stopRateNotDegraded, false);
  });

  test("B token < A×0.9 → 加分项 true", () => {
    const a = mkAgg({ totalEstimateTokens: 1000 });
    const b = mkAgg({ totalEstimateTokens: 800 }); // 0.8 < 0.9
    const g = evaluatePromptGate(a, b);
    assert.equal(g.tokenCostReduced, true);
    assert.equal(g.allHardPassed, true);
    assert.equal(g.allPassed, true);
  });

  test("A 无有效证据（latency null）→ latency 加分项不阻塞", () => {
    const a = mkAgg({ avgFirstEvidenceLatencyMs: null });
    const b = mkAgg({ avgFirstEvidenceLatencyMs: null });
    const g = evaluatePromptGate(a, b);
    assert.equal(g.latencyNotWorse, true);
  });

  test("B 首证据延迟高于 A+1ms → latency 加分项 false", () => {
    const a = mkAgg({ avgFirstEvidenceLatencyMs: 100 });
    const b = mkAgg({ avgFirstEvidenceLatencyMs: 200 });
    assert.equal(evaluatePromptGate(a, b).latencyNotWorse, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. prompt-ab-runner：确定性 stub replay
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 8 Stage P prompt-ab-runner (stub)", () => {
  test("stub replay 框架确定性：schema/mode/phase/seeds/arms 正确", async () => {
    const r = await runPromptAbReplay({ seeds: [0, 1, 2], batch: 1 });
    assert.equal(r.schema, "prompt-ab/v1");
    assert.equal(r.mode, "stub");
    assert.equal(r.phase, "phase8-stage-p");
    assert.deepEqual(r.seeds, [0, 1, 2]);
    assert.equal(r.batch, 1);
    assert.match(r.arms.A.label, /P-A/);
    assert.match(r.arms.B.label, /P-B/);
    assert.equal(r.provenance.A, undefined);
    assert.equal(r.provenance.B, undefined);
  });

  test("stub replay：两臂统一 arm=A（9 专用工具），只变化 systemPrompt", async () => {
    const r = await runPromptAbReplay({ seeds: [0], batch: 2 });
    // arms.base 记录了两臂实际注入的 systemPrompt 基座
    assert.equal(r.arms.A.base, REAL_SYSTEM_PROMPT_BASE);
    assert.equal(r.arms.B.base, GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE);
    assert.notEqual(r.arms.A.base, r.arms.B.base);
  });

  test("stub replay：两臂指标一致 → 硬门全过，（dry-run 不尊重 Prompt 差异）", async () => {
    const r = await runPromptAbReplay({ seeds: [0, 1], batch: 3 });
    assert.equal(r.gate.allHardPassed, true);
    // dry-run 下两臂工具调用相同，token 相同 → 加分项 false
    assert.equal(r.gate.tokenCostReduced, false);
    assert.equal(r.aggregation.A.totalCalls, r.aggregation.B.totalCalls);
  });

  test("stub replay：每个 seed 都有两臂指标，场景数等于基线场景数", async () => {
    const r = await runPromptAbReplay({ seeds: [0, 1, 2], batch: 1 });
    assert.ok(r.scenarios.length > 0);
    for (const s of r.scenarios) {
      assert.equal(s.metricsA.length, 3);
      assert.equal(s.metricsB.length, 3);
      assert.ok(s.scenarioId.length > 0);
      assert.ok(s.category.length > 0);
    }
  });

  test("报告格式化：JSON 可解析，Markdown 含关键章节与门禁", async () => {
    const r = await runPromptAbReplay({ seeds: [0], batch: 1 });
    const json = formatPromptAbJson(r);
    const parsed = JSON.parse(json);
    assert.equal(parsed.schema, "prompt-ab/v1");
    const md = formatPromptAbMarkdown(r);
    assert.match(md, /# Phase 8 Stage P/);
    assert.match(md, /门禁结论/);
    assert.match(md, /P-A/);
    assert.match(md, /P-B/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. systemPromptOverride fail-closed（eval-only 注入守卫）
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 8 Stage P systemPromptOverride fail-closed", () => {
  test("默认工厂（未授权）传入 systemPromptOverride → 拒绝（fail-closed）", async () => {
    const src = createAgenticRawCandidateSource(); // 未传 permitSystemPromptOverride
    await assert.rejects(
      () => src.generate({ systemPromptOverride: "eval-only override" }),
      (err) => {
        assert.match(err.message, /systemPromptOverride 是 eval-only 覆盖字段/);
        assert.match(err.message, /fail-closed/);
        return true;
      },
    );
  });

  test("显式授权 permitSystemPromptOverride:true → 守卫放行（不抛 fail-closed 错误）", async () => {
    const src = createAgenticRawCandidateSource({ permitSystemPromptOverride: true });
    // 守卫通过后，generate 会因缺 modelGenerate/workspace 等上下文而抛其他错误，
    // 但绝不应抛 fail-closed 守卫错误。这验证授权开关确实放行了 override 注入。
    try {
      await src.generate({ systemPromptOverride: "eval-only override" });
      assert.fail("generate 应因缺上下文抛出，而非无异常返回");
    } catch (err) {
      assert.doesNotMatch(String(err.message), /systemPromptOverride 是 eval-only 覆盖字段/);
      assert.doesNotMatch(String(err.message), /fail-closed/);
    }
  });

  test("production 生产路径不传 override → 不触发守卫（行为不变）", async () => {
    const src = createAgenticRawCandidateSource();
    // 未传 systemPromptOverride，守卫不触发；会因缺上下文抛其他错误，但非 fail-closed。
    try {
      await src.generate({});
      assert.fail("generate 应因缺上下文抛出，而非无异常返回");
    } catch (err) {
      assert.doesNotMatch(String(err.message), /systemPromptOverride 是 eval-only 覆盖字段/);
    }
  });
});