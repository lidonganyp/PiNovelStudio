/**
 * MODEL-ROUTING-GOVERNANCE — WP-01..WP-07 最小路由与成本 Eval（WP-06）
 *
 * 覆盖：
 * - 路由正确性（默认 Gemini / 显式 Claude / 无静默切换 / GPT&GLM 不进生产）
 * - 配置一致性（temperature/maxTokens/timeout/bundle）
 * - 预算与恢复（上限阻断 / 正常与恢复分离 / 失败计成本）
 * - 质量保护（FactGuard 不可绕过语义 / 模型版本隔离 / 降本护栏）
 *
 * 禁止真实模型调用。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(__dirname, "..");
const require = createRequire(import.meta.url);

// 直接从 dist 加载（需先 build）；若未 build 则用 ts 编译产物路径回退说明
function loadDist(rel) {
  const path = resolve(extensionRoot, "dist", rel);
  try {
    return require(path);
  } catch (err) {
    // ESM-only dist may not load via require; use dynamic import in async tests
    return { __needsImport: true, path, err };
  }
}

async function importDist(rel) {
  const url = `file://${resolve(extensionRoot, "dist", rel).replace(/\\/g, "/")}`;
  return import(url);
}

describe("WP-01 路由契约与运行锁", () => {
  test("默认生产路由使用 Gemini", async () => {
    const mod = await importDist("v2/core/run-routing-context.js");
    const { getGeminiWriterModel } = await importDist("utils/config.js");
    const ctx = mod.resolveRunRouting({});
    assert.equal(ctx.provider, "gemini31");
    // WRITER-ENV-UNIFY-1：模型身份由 .env GEMINI_MODEL 解析，测试断言读有效配置。
    assert.equal(ctx.model, getGeminiWriterModel());
    assert.equal(ctx.generationRoute, "v2_rawstage2_gemini31");
    assert.equal(ctx.editorialRoute, "v2_amplified_gemini31");
    assert.equal(ctx.routeClass, "production");
    assert.equal(ctx.fallbackPolicy, "none");
    assert.equal(ctx.explicitWriterSelection, false);
  });

  test("writerModel=claude 使用 Claude 且可追溯显式选择", async () => {
    const mod = await importDist("v2/core/run-routing-context.js");
    const ctx = mod.resolveRunRouting({ writerModel: "claude" });
    assert.equal(ctx.provider, "claude");
    assert.equal(ctx.model, "claude-opus-4-6");
    assert.equal(ctx.generationRoute, "v2_rawstage2");
    assert.equal(ctx.explicitWriterSelection, true);
    assert.equal(ctx.writerModel, "claude");
  });

  test("Gemini 锁下 Claude provider 调用被阻断（无静默切换）", async () => {
    const mod = await importDist("v2/core/run-routing-context.js");
    const ctx = mod.resolveRunRouting({});
    const result = mod.assertModelCallMatchesLock({
      routing: ctx,
      stage: "agenticGeneration",
      route: "v2_rawstage2_gemini31",
      provider: "claude",
      model: "claude-opus-4-6",
      role: "generation",
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("provider")));
  });

  test("单次运行锁参数不一致时不匹配", async () => {
    const mod = await importDist("v2/core/run-routing-context.js");
    const ctx = mod.resolveRunRouting({
      promptBundleHash: "bundle:abc",
      contextHash: "context:xyz",
    });
    const result = mod.assertModelCallMatchesLock({
      routing: ctx,
      stage: "style",
      route: ctx.editorialRoute,
      provider: ctx.provider,
      model: ctx.model,
      promptBundleHash: "bundle:other",
      role: "editorial",
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("promptBundleHash")));
  });

  test("writerModel 与 modelTestRoute 互斥", async () => {
    const mod = await importDist("v2/core/run-routing-context.js");
    assert.throws(
      () => mod.resolveRunRouting({ writerModel: "claude", modelTestRoute: "glm" }),
      /不能同时设置/,
    );
  });
});

describe("WP-02 生产/评测隔离", () => {
  test("GPT 文学评测路由 productionEligible=false", async () => {
    const mod = await importDist("v2/core/route-catalog.js");
    const lit = mod.classifyRoute("v2_literary_judge");
    assert.equal(lit.routeClass, "evaluation");
    assert.equal(lit.productionEligible, false);
    const opp = mod.classifyRoute("v2_opportunity_judge");
    assert.equal(opp.productionEligible, false);
  });

  test("GLM/Doubao lab 路由不得 productionEligible", async () => {
    const mod = await importDist("v2/core/route-catalog.js");
    for (const route of ["nb4_generate_glm", "nb4_generate_doubao", "narrator_testing_glm"]) {
      const meta = mod.classifyRoute(route);
      assert.equal(meta.productionEligible, false, route);
    }
  });

  test("生产调用方不得使用评测路由", async () => {
    const mod = await importDist("v2/core/route-catalog.js");
    const r = mod.assertProductionCallerIsolation("v2_literary_judge", "novel_generate_chapter");
    assert.equal(r.ok, false);
  });

  test("route catalog 配置校验：生产写路由 fallback none", async () => {
    const mod = await importDist("v2/core/route-catalog.js");
    const issues = mod.validateRouteCatalog();
    const errors = issues.filter((i) => i.level === "error");
    assert.equal(errors.length, 0, JSON.stringify(errors, null, 2));
  });

  test("模型版本隔离键区分新旧模型", async () => {
    const mod = await importDist("v2/core/route-catalog.js");
    assert.equal(
      mod.isSameModelVersionBucket(
        { provider: "gemini31", modelVersion: "gemini-3.1-pro" },
        { provider: "gemini31", modelVersion: "gemini-3.1-pro" },
      ),
      true,
    );
    assert.equal(
      mod.isSameModelVersionBucket(
        { provider: "gemini31", modelVersion: "gemini-3.1-pro" },
        { provider: "claude", modelVersion: "claude-opus-4-6" },
      ),
      false,
    );
  });
});

describe("WP-03 分层预算", () => {
  test("超过模型调用上限不再预扣成功", async () => {
    const mod = await importDist("v2/core/layered-budget.js");
    let b = mod.createLayeredBudget({
      normal: {
        ...mod.DEFAULT_LAYERED_BUDGET.normal,
        maxModelCalls: 1,
      },
    });
    const r1 = mod.reserveLayeredBudget(b, {
      stage: "agenticGeneration",
      budgetType: "normal",
      modelCalls: 1,
    });
    assert.equal(r1.ok, true);
    const r2 = mod.reserveLayeredBudget(r1.budget, {
      stage: "agenticGeneration",
      budgetType: "normal",
      modelCalls: 1,
    });
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, "normal_model_calls_exhausted");
  });

  test("正常预算与恢复预算互不挤占", async () => {
    const mod = await importDist("v2/core/layered-budget.js");
    let b = mod.createLayeredBudget({
      normal: { ...mod.DEFAULT_LAYERED_BUDGET.normal, maxModelCalls: 1, usedModelCalls: 1 },
      recovery: { ...mod.DEFAULT_LAYERED_BUDGET.recovery, maxModelCalls: 2 },
    });
    const normalFail = mod.reserveLayeredBudget(b, {
      stage: "authorStyleOptimization",
      budgetType: "normal",
      modelCalls: 1,
    });
    assert.equal(normalFail.ok, false);
    const recoveryOk = mod.reserveLayeredBudget(b, {
      stage: "authorStyleOptimization",
      budgetType: "recovery",
      modelCalls: 1,
      stageAttempts: 1,
      totalAttempts: 1,
    });
    assert.equal(recoveryOk.ok, true);
    assert.equal(recoveryOk.budget.normal.usedModelCalls, 1);
    assert.equal(recoveryOk.budget.recovery.usedModelCalls, 1);
  });

  test("失败调用结算仍计入成本", async () => {
    const mod = await importDist("v2/core/layered-budget.js");
    let b = mod.createLayeredBudget();
    const reserved = {
      stage: "agenticGeneration",
      budgetType: "normal",
      modelCalls: 1,
      inputTokens: 10,
      outputTokens: 0,
      latencyMs: 100,
    };
    const r = mod.reserveLayeredBudget(b, reserved);
    assert.equal(r.ok, true);
    const settled = mod.settleLayeredBudget(r.budget, reserved, {
      stage: "agenticGeneration",
      budgetType: "normal",
      modelCalls: 1,
      inputTokens: 100,
      outputTokens: 0,
      latencyMs: 500,
      failed: true,
    });
    assert.ok(settled.normal.usedInputTokens >= 100);
    assert.ok(settled.normal.usedLatencyMs >= 500);
    const breakdown = mod.computeChapterCostBreakdown(settled);
    assert.equal(breakdown.successDeliveryCost.modelCalls, settled.normal.usedModelCalls);
  });

  test("超过总延迟 UX 预算进入 exhausted", async () => {
    const mod = await importDist("v2/core/layered-budget.js");
    const b = mod.createLayeredBudget({
      ux: {
        ...mod.DEFAULT_LAYERED_BUDGET.ux,
        maxTotalWaitMs: 1000,
      },
    });
    const r = mod.reserveLayeredBudget(b, {
      stage: "other",
      budgetType: "normal",
      modelCalls: 1,
      latencyMs: 1500,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "ux_total_wait_exhausted");
  });
});

describe("WP-04 失败策略矩阵", () => {
  test("FactGuard 失败不得自动重试通过", async () => {
    const mod = await importDist("v2/core/failure-strategy-matrix.js");
    const d = mod.decideFailureStrategy({
      failureType: "factguard_failed",
      stage: "finalFactRecheck",
      gate: "fact_guard",
      reason: "事实冲突",
      attempt: 0,
    });
    assert.equal(d.rule.autoRetry, false);
    assert.equal(d.decision.nextLifecycleState, "blocked");
    assert.ok(d.rule.prohibited.includes("downgrade_to_warning"));
    assert.equal(d.silentDegradeForbidden, true);
  });

  test("风格优化失败耗尽后 hard block 且禁止 silent raw", async () => {
    const mod = await importDist("v2/core/failure-strategy-matrix.js");
    const d = mod.decideFailureStrategy({
      failureType: "style_optimization_failed",
      stage: "authorStyleOptimization",
      gate: "style",
      reason: "empty style output",
      attempt: 1,
    });
    assert.equal(d.rule.failureClass, "blocked");
    assert.ok(d.rule.prohibited.includes("silent_deliver_raw"));
    assert.equal(d.attemptHistory.length, 1);
  });

  test("未授权跨模型切换 hard block", async () => {
    const mod = await importDist("v2/core/failure-strategy-matrix.js");
    const r = mod.assertNoCrossModelDisguise({
      lockedProvider: "gemini31",
      actualProvider: "claude",
      authorizedCrossModel: false,
    });
    assert.equal(r.ok, false);
    assert.equal(r.failureType, "unauthorized_cross_model_switch");
  });

  test("schema 错误只映射 retry_gate 语义", async () => {
    const mod = await importDist("v2/core/failure-strategy-matrix.js");
    const rule = mod.getFailureStrategyRule("schema_error");
    assert.equal(rule.recoveryAction, "retry_gate");
    assert.ok(rule.prohibited.includes("rewrite_prose_for_parser"));
  });
});

describe("WP-05 Trace/成本/延迟观测", () => {
  test("延迟分位不是只输出平均", async () => {
    const mod = await importDist("v2/core/model-call-observability.js");
    const stats = mod.computeLatencyStats([10, 20, 30, 40, 100, 200, 1000]);
    assert.ok(stats.p50 > 0);
    assert.ok(stats.p90 >= stats.p50);
    assert.ok(stats.p95 >= stats.p90);
    assert.ok(stats.p99 >= stats.p95);
    assert.ok(stats.avg > 0);
  });

  test("失败调用进入成本统计", async () => {
    const mod = await importDist("v2/core/model-call-observability.js");
    const calls = [
      {
        runId: "r1",
        stage: "agentic",
        route: "v2_rawstage2_gemini31",
        provider: "gemini31",
        model: "gemini-3.1-pro",
        modelVersion: "gemini-3.1-pro",
        promptBundleHash: "b",
        contextHash: "c",
        temperature: 0.7,
        maxTokens: 8192,
        timeout: 300000,
        inputTokens: 100,
        outputTokens: 0,
        durationMs: 50,
        waitMs: 0,
        retryIndex: 0,
        budgetType: "normal",
        failed: true,
        failureType: "network_timeout",
      },
    ];
    const report = mod.buildCostReport(calls);
    assert.equal(report.totalCalls, 1);
    assert.equal(report.failedCalls, 1);
    assert.equal(report.failureTypeDistribution.network_timeout, 1);
    assert.ok(report.totalCost >= 0);
  });

  test("路由稳定性报告检测漂移", async () => {
    const mod = await importDist("v2/core/model-call-observability.js");
    const report = mod.buildRoutingStabilityReport({
      runId: "r1",
      expectedProvider: "gemini31",
      expectedModel: "gemini-3.1-pro",
      calls: [
        {
          runId: "r1",
          stage: "g",
          route: "v2_rawstage2_gemini31",
          provider: "claude",
          model: "claude-opus-4-6",
          modelVersion: "x",
          promptBundleHash: "b",
          contextHash: "c",
          temperature: 0,
          maxTokens: 1,
          timeout: 1,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 1,
          waitMs: 0,
          retryIndex: 0,
          budgetType: "normal",
        },
      ],
    });
    assert.equal(report.stable, false);
    assert.equal(report.unauthorizedCrossModelCount, 1);
  });

  test("无 timeout 的调用被 assertAllCallsHaveTraceCost 标记", async () => {
    const mod = await importDist("v2/core/model-call-observability.js");
    const r = mod.assertAllCallsHaveTraceCost([
      {
        runId: "r",
        stage: "s",
        route: "v2_rawstage2_gemini31",
        provider: "gemini31",
        model: "m",
        modelVersion: "m",
        promptBundleHash: "b",
        contextHash: "c",
        temperature: 0,
        maxTokens: 1,
        timeout: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 1,
        waitMs: 0,
        retryIndex: 0,
        budgetType: "normal",
        cost: 0.1,
      },
    ]);
    assert.equal(r.ok, false);
  });
});

describe("WP-07 质量-成本联合指标", () => {
  test("联合分数为分析指标且可计算", async () => {
    const mod = await importDist("v2/core/quality-cost-metrics.js");
    const score = mod.computeJointQualityCostScore({
      effectiveDeliveryRate: 1,
      userAcceptRate: 0.8,
      inverseEditDistance: 0.9,
      averageDeliveryCost: 2,
    });
    assert.ok(score !== null);
    assert.ok(Math.abs(score - (1 * 0.8 * 0.9) / 2) < 1e-9);
  });

  test("降本导致 FactGuard 下降时护栏拒绝", async () => {
    const mod = await importDist("v2/core/quality-cost-metrics.js");
    const baseline = mod.aggregateQualityCostObservations([
      {
        delivered: true,
        userAccepted: true,
        userEditDistance: 0.1,
        deliveryCost: 10,
        factGuardPassed: true,
        storyPreservationPassed: true,
        recoveryAssisted: false,
        latencyMs: 1000,
        longTail: false,
        modelVersion: "gemini-3.1-pro",
        provider: "gemini31",
      },
    ]);
    const candidate = mod.aggregateQualityCostObservations([
      {
        delivered: true,
        userAccepted: true,
        userEditDistance: 0.1,
        deliveryCost: 5,
        factGuardPassed: false,
        storyPreservationPassed: true,
        recoveryAssisted: false,
        latencyMs: 800,
        longTail: false,
        modelVersion: "cheap-model",
        provider: "glm",
      },
    ]);
    const guard = mod.evaluateCostReductionGuard({ baseline, candidate });
    assert.equal(guard.allowed, false);
    assert.ok(guard.reasons.some((r) => r.includes("FactGuard")));
  });

  test("新旧模型统计不得混入同一信誉桶", async () => {
    const mod = await importDist("v2/core/quality-cost-metrics.js");
    const mixed = [
      {
        delivered: true,
        deliveryCost: 1,
        factGuardPassed: true,
        storyPreservationPassed: true,
        recoveryAssisted: false,
        latencyMs: 1,
        longTail: false,
        modelVersion: "v1",
        provider: "gemini31",
      },
      {
        delivered: true,
        deliveryCost: 1,
        factGuardPassed: true,
        storyPreservationPassed: true,
        recoveryAssisted: false,
        latencyMs: 1,
        longTail: false,
        modelVersion: "v2",
        provider: "gemini31",
      },
    ];
    const purity = mod.assertSingleModelVersionBucket(mixed);
    assert.equal(purity.ok, false);
    const agg = mod.aggregateQualityCostObservations(mixed);
    assert.equal(Object.keys(agg.byModelVersion).length, 2);
  });

  test("成本下降但修改距离恶化时不得宣称质量提升", async () => {
    const mod = await importDist("v2/core/quality-cost-metrics.js");
    const baseline = mod.aggregateQualityCostObservations([
      {
        delivered: true,
        userAccepted: true,
        userEditDistance: 0.1,
        deliveryCost: 10,
        factGuardPassed: true,
        storyPreservationPassed: true,
        recoveryAssisted: false,
        latencyMs: 1,
        longTail: false,
        modelVersion: "v1",
        provider: "gemini31",
      },
    ]);
    const candidate = mod.aggregateQualityCostObservations([
      {
        delivered: true,
        userAccepted: true,
        userEditDistance: 0.5,
        deliveryCost: 3,
        factGuardPassed: true,
        storyPreservationPassed: true,
        recoveryAssisted: false,
        latencyMs: 1,
        longTail: false,
        modelVersion: "v1",
        provider: "gemini31",
      },
    ]);
    const guard = mod.evaluateCostReductionGuard({ baseline, candidate });
    assert.equal(guard.allowed, false);
  });
});

describe("配置层：默认生产路由契约快照", () => {
  test("config 默认写路由 fallback=[]（Gemini 默认 + Claude 显式；Solov 渠道已删除）", () => {
    const config = require(resolve(extensionRoot, "../../../config/model-routing.json"));
    for (const name of [
      "v2_rawstage2_gemini31",
      "v2_amplified_gemini31",
      "v2_rawstage2",
      "v2_amplified",
      "narrator_primary",
    ]) {
      const entry = config.agent_routing[name];
      assert.ok(entry, name);
      assert.deepEqual(entry.fallback, [], name);
    }
    // WRITER-ENV-UNIFY-1：Solov 互备渠道按版本收敛原则物理删除
    for (const removed of [
      "v2_rawstage2_gemini31_solov",
      "v2_amplified_gemini31_solov",
    ]) {
      assert.equal(config.agent_routing[removed], undefined, removed);
    }
    assert.equal(config.agent_routing.narrator_primary.provider, "gemini31");
    // 模型身份由 .env GEMINI_MODEL 解析，路由 JSON 只保留稳定占位符
    assert.equal(config.agent_routing.narrator_primary.model, "${GEMINI_MODEL}");
    // GEMINI38-FLASH-PRODUCTION-RESTORE-1：gpt-6-astra 生产写路由已物理删除。
    for (const stale of [
      "v2_rawstage2_gpt6astra",
      "v2_amplified_gpt6astra",
    ]) {
      assert.equal(config.agent_routing[stale], undefined, stale);
    }
  });
});
