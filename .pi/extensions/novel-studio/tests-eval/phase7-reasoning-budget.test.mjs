/**
 * PHASE7-REASONING-BUDGET：推理预算 A/B/C 确定性测试（eval-only）
 *
 * 验证：
 * 1. riskScore -> low/medium/high 分档
 * 2. A/B/C 预算注入
 * 3. A 组与当前生产默认值完全一致
 * 4. C 组只存在于 eval，不进入生产 evidence-plan.ts
 * 5. runner 产出完整报告（JSON roundtrip + Markdown）
 * 6. stub 模式下三臂指标一致（预算不影响工具执行）
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：动态 import 编译后的 eval 模块
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_PATH = join(EXTENSION_ROOT, "dist-eval", "novelos", "eval", "reasoning-budget-config.js");
const GATE_PATH = join(EXTENSION_ROOT, "dist-eval", "novelos", "eval", "reasoning-budget-gate.js");
const RUNNER_PATH = join(EXTENSION_ROOT, "dist-eval", "novelos", "eval", "reasoning-budget-runner.js");

async function importConfig() {
  return import(`file://${CONFIG_PATH}`);
}
async function importGate() {
  return import(`file://${GATE_PATH}`);
}
async function importRunner() {
  return import(`file://${RUNNER_PATH}`);
}

// 生产 DEFAULT_BUDGET_CONFIG（从 dist/ 导入，验证 A 组一致性）
const PROD_BUDGET_PATH = join(EXTENSION_ROOT, "dist", "novelos", "runtime", "budget-policy.js");

// ─────────────────────────────────────────────────────────────────────────────
// 测试 1：riskScore 分档
// ─────────────────────────────────────────────────────────────────────────────

describe("PHASE7-REASONING-BUDGET-1：riskScore 分档", () => {
  it("空 mustVerify -> score=0, tier=low", async () => {
    const { computeRiskScore } = await importConfig();
    const result = computeRiskScore([]);
    assert.equal(result.score, 0);
    assert.equal(result.tier, "low");
    assert.equal(result.p0Count, 0);
    assert.equal(result.p1Count, 0);
    assert.equal(result.p2Count, 0);
  });

  it("P2 事实 -> score=1 per item, tier=low (score<=3)", async () => {
    const { computeRiskScore } = await importConfig();
    // 无 P0/P1 标记词的事实 -> P2
    const result = computeRiskScore(["某个普通事实", "另一个普通事实"]);
    assert.equal(result.p2Count, 2);
    assert.ok(result.score <= 3, `score=${result.score} 应 <= 3 (low)`);
    assert.equal(result.tier, "low");
  });

  it("P1 事实（含标记词如'状态'）-> score=2 per item", async () => {
    const { computeRiskScore } = await importConfig();
    // "状态" 是 P1 标记词
    const result = computeRiskScore(["角色状态变化"]);
    assert.ok(result.p1Count >= 1, `应至少有 1 个 P1`);
    assert.ok(result.score >= 2, `score=${result.score} 应 >= 2 (1个P1)`);
  });

  it("P0 事实（含标记词如'身份'）-> score=3 per item", async () => {
    const { computeRiskScore } = await importConfig();
    // "身份" 是 P0 标记词
    const result = computeRiskScore(["真实身份揭秘"]);
    assert.ok(result.p0Count >= 1, `应至少有 1 个 P0`);
    assert.ok(result.score >= 3, `score=${result.score} 应 >= 3 (1个P0)`);
  });

  it("多 P0 事实 -> tier=high (score>10)", async () => {
    const { computeRiskScore } = await importConfig();
    // 4 个 P0 事实 -> score = 4*3 = 12 > 10 -> high
    const result = computeRiskScore([
      "真实身份揭秘",
      "核心设定：功法",
      "境界突破",
      "封印解除",
    ]);
    assert.ok(result.p0Count >= 4, `应至少有 4 个 P0`);
    assert.ok(result.score > 10, `score=${result.score} 应 > 10 (high)`);
    assert.equal(result.tier, "high");
  });

  it("中等数量事实 -> tier=medium (3 < score <= 10)", async () => {
    const { computeRiskScore } = await importConfig();
    // 2 个 P1 + 1 个 P0 = 2*2 + 3 = 7 -> medium
    const result = computeRiskScore([
      "角色状态变化",   // P1
      "伤势恢复",       // P1
      "真实身份揭秘",   // P0
    ]);
    assert.ok(result.score > 3, `score=${result.score} 应 > 3`);
    assert.ok(result.score <= 10, `score=${result.score} 应 <= 10`);
    assert.equal(result.tier, "medium");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 2：A/B/C 预算注入
// ─────────────────────────────────────────────────────────────────────────────

describe("PHASE7-REASONING-BUDGET-2：A/B/C 预算注入", () => {
  it("A 组：与生产默认值完全一致", async () => {
    const { getBudgetA, verifyBudgetAMatchesProduction } = await importConfig();
    const { DEFAULT_BUDGET_CONFIG } = await import(`file://${PROD_BUDGET_PATH}`);

    const a = getBudgetA();
    assert.equal(a.arm, "A");
    assert.equal(a.tier, "fixed");
    assert.equal(a.budgetConfig.maxTurns, DEFAULT_BUDGET_CONFIG.maxTurns);
    assert.equal(a.budgetConfig.maxToolCalls, DEFAULT_BUDGET_CONFIG.maxToolCalls);
    assert.equal(a.budgetConfig.maxLatencyMs, DEFAULT_BUDGET_CONFIG.maxLatencyMs);
    assert.equal(a.budgetConfig.maxTokensIn, DEFAULT_BUDGET_CONFIG.maxTokensIn);
    assert.equal(a.budgetConfig.maxTokensOut, DEFAULT_BUDGET_CONFIG.maxTokensOut);
    assert.equal(a.retrievalDepth, 2);
    assert.equal(a.retrievalCallBudget, 4);
    assert.equal(a.maxRepairRounds, 2);
    assert.equal(a.maxStagnantRounds, 2);
    assert.equal(a.maxCoverageRetries, 1);

    // verifyBudgetAMatchesProduction 也应通过
    const check = verifyBudgetAMatchesProduction();
    assert.ok(check.matches, `A 组应与生产一致：${check.mismatches.join("; ")}`);
  });

  it("B 组：温和降低（maxTurns=7, depth=1, repair=1）", async () => {
    const { getBudgetB } = await importConfig();
    const b = getBudgetB();
    assert.equal(b.arm, "B");
    assert.equal(b.tier, "fixed");
    assert.equal(b.budgetConfig.maxTurns, 7);
    assert.equal(b.budgetConfig.maxToolCalls, 14);
    assert.equal(b.retrievalDepth, 1);
    assert.equal(b.retrievalCallBudget, 2);
    assert.equal(b.maxRepairRounds, 1);
    assert.equal(b.maxStagnantRounds, 1);
    assert.equal(b.maxCoverageRetries, 1);
  });

  it("C 组 low tier：降低预算（maxTurns=6, depth=1, repair=1）", async () => {
    const { getBudgetC, computeRiskScore } = await importConfig();
    const riskScore = computeRiskScore([]); // 空 -> score=0 -> low
    const c = getBudgetC(riskScore);
    assert.equal(c.arm, "C");
    assert.equal(c.tier, "low");
    assert.equal(c.budgetConfig.maxTurns, 6);
    assert.equal(c.budgetConfig.maxToolCalls, 10);
    assert.equal(c.retrievalDepth, 1);
    assert.equal(c.retrievalCallBudget, 2);
    assert.equal(c.maxRepairRounds, 1);
  });

  it("C 组 medium tier：当前默认（maxTurns=10, depth=2, repair=2）", async () => {
    const { getBudgetC, computeRiskScore } = await importConfig();
    const riskScore = computeRiskScore(["角色状态变化", "伤势恢复", "真实身份揭秘"]);
    assert.equal(riskScore.tier, "medium");
    const c = getBudgetC(riskScore);
    assert.equal(c.arm, "C");
    assert.equal(c.tier, "medium");
    assert.equal(c.budgetConfig.maxTurns, 10);
    assert.equal(c.budgetConfig.maxToolCalls, 20);
    assert.equal(c.retrievalDepth, 2);
    assert.equal(c.retrievalCallBudget, 4);
    assert.equal(c.maxRepairRounds, 2);
  });

  it("C 组 high tier：提升预算（maxTurns=14, depth=3, repair=3）", async () => {
    const { getBudgetC, computeRiskScore } = await importConfig();
    const riskScore = computeRiskScore([
      "真实身份揭秘", "核心设定：功法", "境界突破", "封印解除",
    ]);
    assert.equal(riskScore.tier, "high");
    const c = getBudgetC(riskScore);
    assert.equal(c.arm, "C");
    assert.equal(c.tier, "high");
    assert.equal(c.budgetConfig.maxTurns, 14);
    assert.equal(c.budgetConfig.maxToolCalls, 28);
    assert.equal(c.retrievalDepth, 3);
    assert.equal(c.retrievalCallBudget, 6);
    assert.equal(c.maxRepairRounds, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 3：C 组只存在于 eval，不进入生产
// ─────────────────────────────────────────────────────────────────────────────

describe("PHASE7-REASONING-BUDGET-3：C 组 eval-only 隔离", () => {
  it("reasoning-budget-config 不在 dist/（生产构建）中", async () => {
    const { existsSync } = await import("node:fs");
    const prodPath = join(EXTENSION_ROOT, "dist", "novelos", "eval", "reasoning-budget-config.js");
    assert.ok(!existsSync(prodPath), `reasoning-budget-config 不应在 dist/ 中：${prodPath}`);
  });

  it("reasoning-budget-runner 不在 dist/（生产构建）中", async () => {
    const { existsSync } = await import("node:fs");
    const prodPath = join(EXTENSION_ROOT, "dist", "novelos", "eval", "reasoning-budget-runner.js");
    assert.ok(!existsSync(prodPath), `reasoning-budget-runner 不应在 dist/ 中：${prodPath}`);
  });

  it("生产 evidence-plan.ts 不引用 reasoning-budget", async () => {
    const { readFileSync } = await import("node:fs");
    const prodPath = join(EXTENSION_ROOT, "dist", "novelos", "agent", "evidence-plan.js");
    const content = readFileSync(prodPath, "utf-8");
    assert.ok(
      !content.includes("reasoning-budget"),
      "生产 evidence-plan 不应引用 reasoning-budget 模块",
    );
    assert.ok(
      !content.includes("computeRiskScore"),
      "生产 evidence-plan 不应引用 computeRiskScore",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 4：runner 产出完整报告
// ─────────────────────────────────────────────────────────────────────────────

describe("PHASE7-REASONING-BUDGET-4：runner 报告完整性", () => {
  it("全量 7 场景跑通，含 riskScore 和三臂预算配置", async () => {
    const runner = await importRunner();
    const comparison = await runner.runReasoningBudgetAbcReplay();
    assert.equal(comparison.schema, "reasoning-budget-abc/v1");
    assert.equal(comparison.mode, "stub");
    assert.ok(comparison.scenarios.length >= 3, "应至少有 3 个场景");

    for (const s of comparison.scenarios) {
      assert.ok(s.riskScore, `场景 ${s.scenarioId} 应有 riskScore`);
      assert.ok(s.budgetA && s.budgetB && s.budgetC, `场景 ${s.scenarioId} 应有三臂预算`);
      assert.equal(s.budgetA.arm, "A");
      assert.equal(s.budgetB.arm, "B");
      assert.equal(s.budgetC.arm, "C");
      assert.ok(["low", "medium", "high"].includes(s.riskScore.tier), `场景 ${s.scenarioId} tier 应合法`);
    }
  });

  it("stub 模式下三臂指标一致（预算不影响工具执行）", async () => {
    const runner = await importRunner();
    const comparison = await runner.runReasoningBudgetAbcReplay();
    for (const s of comparison.scenarios) {
      assert.equal(s.metricsA.totalResultChars, s.metricsB.totalResultChars,
        `场景 ${s.scenarioId} A/B stub 结果应一致`);
      assert.equal(s.metricsB.totalResultChars, s.metricsC.totalResultChars,
        `场景 ${s.scenarioId} B/C stub 结果应一致`);
      assert.equal(s.metricsA.mustVerify.coverageRatio, s.metricsC.mustVerify.coverageRatio,
        `场景 ${s.scenarioId} A/C 覆盖率应一致`);
    }
  });

  it("JSON roundtrip + Markdown 关键章节", async () => {
    const runner = await importRunner();
    const comparison = await runner.runReasoningBudgetAbcReplay();
    const json = runner.formatReasoningBudgetJson(comparison);
    const parsed = JSON.parse(json);
    assert.equal(parsed.schema, "reasoning-budget-abc/v1");
    assert.ok(parsed.scenarios.length > 0);
    assert.ok(parsed.gateB);
    assert.ok(parsed.gateC);

    const md = runner.formatReasoningBudgetMarkdown(comparison);
    assert.ok(md.includes("Phase 7 推理预算 A/B/C 对比报告"), "应含标题");
    assert.ok(md.includes("三臂定义"), "应含三臂定义");
    assert.ok(md.includes("B 组门禁"), "应含 B 组门禁");
    assert.ok(md.includes("C 组门禁"), "应含 C 组门禁");
    assert.ok(md.includes("riskScore"), "应含 riskScore");
  });

  it("场景中存在 low/medium/high 至少一种 tier", async () => {
    const runner = await importRunner();
    const comparison = await runner.runReasoningBudgetAbcReplay();
    const tiers = new Set(comparison.scenarios.map((s) => s.riskScore.tier));
    assert.ok(tiers.size > 0, "应至少有 1 种 tier");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 5：门禁评估
// ─────────────────────────────────────────────────────────────────────────────

describe("PHASE7-REASONING-BUDGET-5：门禁评估", () => {
  it("B 组门禁结构完整", async () => {
    const runner = await importRunner();
    const comparison = await runner.runReasoningBudgetAbcReplay();
    const gate = comparison.gateB;
    assert.equal(typeof gate.coverageNotDegraded, "boolean");
    assert.equal(typeof gate.sourceRefNotDegraded, "boolean");
    assert.equal(typeof gate.failureNotWorse, "boolean");
    assert.equal(typeof gate.tokenCostReduced, "boolean");
    assert.equal(typeof gate.stopRateNotDegraded, "boolean");
    assert.equal(typeof gate.latencyNotWorse, "boolean");
    assert.equal(typeof gate.allPassed, "boolean");
    assert.ok(gate.details.coverageNotDegraded);
  });

  it("C 组门禁结构完整", async () => {
    const runner = await importRunner();
    const comparison = await runner.runReasoningBudgetAbcReplay();
    const gate = comparison.gateC;
    assert.equal(typeof gate.coverageNotDegraded, "boolean");
    assert.equal(typeof gate.sourceRefNotDegraded, "boolean");
    assert.equal(typeof gate.failureNotWorse, "boolean");
    assert.equal(typeof gate.lowRiskTokenReduced, "boolean");
    assert.equal(typeof gate.highRiskCoverageImproved, "boolean");
    assert.equal(typeof gate.stopRateNotDegraded, "boolean");
    assert.equal(typeof gate.tokenNotInflated, "boolean");
    assert.equal(typeof gate.allPassed, "boolean");
    assert.ok(gate.details.tokenNotInflated);
  });

  it("stub 模式下 B 组 tokenCostReduced=false（三臂 token 相同）", async () => {
    const runner = await importRunner();
    const comparison = await runner.runReasoningBudgetAbcReplay();
    // stub 模式下三臂 token 完全相同，B 组不可能下降
    assert.equal(comparison.gateB.tokenCostReduced, false,
      "stub 模式下 B 组 token 与 A 相同，tokenCostReduced 应为 false");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 6：真实 replay 路径 dry-run（模型驱动，零 API）
// ─────────────────────────────────────────────────────────────────────────────

describe("PHASE7-REASONING-BUDGET-6：真实 replay dry-run", () => {
  it("runReasoningBudgetAbcRealReplay 用 dry-run 模型跑通并产出 real 报告", async () => {
    const runner = await importRunner();
    const realRunner = await import(
      `file://${join(EXTENSION_ROOT, "dist-eval", "novelos", "eval", "tool-ab-real-runner.js")}`
    );
    const config = await importConfig();

    // 用单场景（含 high 风险 SC8）验证 high 档预算注入
    const baseline = await import(
      `file://${join(EXTENSION_ROOT, "dist-eval", "novelos", "eval", "tool-interface-baseline.js")}`
    );
    const highScenario = baseline.BASELINE_SCENARIOS.find((s) => s.id === "SC8-high-risk");
    assert.ok(highScenario, "baseline 应包含 SC8-high-risk 场景");
    const riskScore = config.computeRiskScore(
      highScenario.calls.flatMap((c) => c.mustVerify ?? []),
    );
    assert.equal(riskScore.tier, "high", "SC8 应为 high 档");

    const modelFn = realRunner.createDryRunModel(highScenario, "A");
    const comparison = await runner.runReasoningBudgetAbcRealReplay({
      modelFn,
      seeds: [0, 1, 2],
      scenarios: [highScenario],
    });

    assert.equal(comparison.schema, "reasoning-budget-abc-real/v1");
    assert.equal(comparison.mode, "real");
    assert.equal(comparison.toolSurface, "specialized-9");
    assert.deepEqual(comparison.seeds, [0, 1, 2]);
    assert.equal(comparison.scenarios.length, 1);
    const s = comparison.scenarios[0];
    assert.equal(s.riskScore.tier, "high");
    assert.equal(s.budgetC.tier, "high");
    assert.equal(s.budgetC.budgetConfig.maxTurns, 14, "C 组 high 档 maxTurns 应为 14");
    assert.equal(s.budgetC.retrievalDepth, 3, "C 组 high 档 depth 应为 3");
    // 三臂统一 9 专用工具（arm=A），只变 maxModelCalls
    assert.ok(s.metricsA.length === 3, "A 组应有 3 seed 指标");
    assert.ok(s.metricsB.length === 3, "B 组应有 3 seed 指标");
    assert.ok(s.metricsC.length === 3, "C 组应有 3 seed 指标");
    // dry-run 三臂 maxModelCalls 不同（A=10/B=7/C=14），但工具结果一致
    assert.ok(comparison.aggregation.A && comparison.aggregation.B && comparison.aggregation.C);
    assert.ok(comparison.gateB && comparison.gateC);
  });

  it("真实 replay 报告格式化（real JSON + real Markdown）", async () => {
    const runner = await importRunner();
    const realRunner = await import(
      `file://${join(EXTENSION_ROOT, "dist-eval", "novelos", "eval", "tool-ab-real-runner.js")}`
    );
    const baseline = await import(
      `file://${join(EXTENSION_ROOT, "dist-eval", "novelos", "eval", "tool-interface-baseline.js")}`
    );
    const scenario = baseline.BASELINE_SCENARIOS[0];
    const modelFn = realRunner.createDryRunModel(scenario, "A");
    const comparison = await runner.runReasoningBudgetAbcRealReplay({
      modelFn,
      seeds: [0],
      scenarios: [scenario],
    });

    const json = runner.formatReasoningBudgetRealJson(comparison);
    const parsed = JSON.parse(json);
    assert.equal(parsed.schema, "reasoning-budget-abc-real/v1");
    assert.equal(parsed.mode, "real");

    const md = runner.formatReasoningBudgetRealMarkdown(comparison);
    assert.ok(md.includes("真实模型对比报告"), "应含真实模型标题");
    assert.ok(md.includes("B 组门禁"), "应含 B 组门禁");
    assert.ok(md.includes("C 组门禁"), "应含 C 组门禁");
    assert.ok(md.includes("provenance"), "应含 provenance");
  });
});
