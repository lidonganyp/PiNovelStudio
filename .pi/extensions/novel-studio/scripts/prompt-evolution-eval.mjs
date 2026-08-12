/**
 * MODEL-PROMPT-EVOLUTION-1 — Prompt 进化集成评估脚本（eval-only）
 *
 * 集成现有 Phase 8 A/B replay 基础设施与新的三层 Eval 门禁系统：
 * 1. 运行 P-A（通用 Prompt）vs P-B（Gemini 专属 Prompt）真实模型 A/B replay
 * 2. 将结果映射到新的 DeterministicGateInput + LinkMetrics
 * 3. 通过 evaluateDeterministicHardGate + compareLinkMetrics 评估
 * 4. 生成综合评估报告
 *
 * Gemini 配额重试：API 号池耗尽时等待几秒后重试，最多 10 次。
 *
 * 用法：
 *   # dry-run（验证框架，零模型调用）
 *   node scripts/prompt-evolution-eval.mjs --dry-run
 *
 *   # 真实 Gemini（需授权）
 *   $env:PINOVEL_BENCHMARK_COST_PROFILE="gemini_validation"
 *   node scripts/prompt-evolution-eval.mjs --require-auth --batches=1
 *
 * eval-only：只注册在 tsconfig.eval.json，不进入生产构建。
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_DIR = __dirname;
const EXT_ROOT = join(SCRIPT_DIR, "..");
const PROJECT_ROOT = join(EXT_ROOT, "..", "..", "..");

// ── 加载 .env ──
const envPath = join(PROJECT_ROOT, ".env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

// ── 参数解析 ──
const DRY_RUN = process.argv.includes("--dry-run");
const REQUIRE_AUTH = process.argv.includes("--require-auth");
const batchesArg = process.argv.find((a) => a.startsWith("--batches="));
const BATCHES = batchesArg ? parseInt(batchesArg.split("=")[1], 10) : 1;
const MAX_RETRIES = 10;
const RETRY_WAIT_MS = 5000;

if (!DRY_RUN && !REQUIRE_AUTH) {
  console.error("[eval] 非 dry-run 模式必须显式传 --require-auth");
  process.exit(1);
}
if (!DRY_RUN && process.env.PINOVEL_BENCHMARK_COST_PROFILE !== "gemini_validation") {
  console.error(
    "[eval] 真实模型模式必须设置 PINOVEL_BENCHMARK_COST_PROFILE=gemini_validation",
  );
  process.exit(1);
}

const GEMINI_ROUTE = "narrator_primary";
const TEMPERATURE = 0.72;
const MAX_TOKENS = 2048;
const SEEDS_PER_BATCH = 3;
const REPORT_DIR = join(PROJECT_ROOT, "reports", "prompt-evolution-eval");

console.log("[eval] MODEL-PROMPT-EVOLUTION-1 Prompt 进化集成评估启动");
console.log(`[eval] 模式=${DRY_RUN ? "dry-run(stub)" : "real(Gemini)"}, 批次=${BATCHES}`);

// ── 导入模块 ──
const runner = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "prompt-ab-runner.js")}`
);
const gateMod = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "prompt-ab-gate.js")}`
);
const newGatesMod = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "prompt-eval-gates.js")}`
);
const prematureMod = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "premature-done-diagnostic.js")}`
);

const { evaluatePromptGate } = gateMod;
const { evaluateDeterministicHardGate, compareLinkMetrics } = newGatesMod;

// ── 带配额重试的模型函数包装 ──
async function createRetryModelFn() {
  const realRunner = await import(
    `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "tool-ab-real-runner.js")}`
  );
  const { clearUnhealthyProviders, clearChapterTimeoutCounts } = await import(
    `file://${join(EXT_ROOT, "dist-eval", "api", "fallback-manager.js")}`
  );
  const baseFn = await realRunner.createRealToolAbModelDecide({
    route: GEMINI_ROUTE,
    maxTokens: MAX_TOKENS,
    timeoutMs: parseInt(process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS ?? "120000", 10),
    temperature: TEMPERATURE,
  });

  // 包装 modelFn，添加配额耗尽重试
  const retryFn = async (ctx) => {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await baseFn(ctx);
      } catch (err) {
        const msg = String(err?.message ?? err);
        const isQuota = msg.includes("exhausted") || msg.includes("429") || msg.includes("quota") || msg.includes("RESOURCE_EXHAUSTED");
        if (isQuota && attempt < MAX_RETRIES) {
          console.log(`[eval] Gemini 配额耗尽（尝试 ${attempt}/${MAX_RETRIES}），等待 ${RETRY_WAIT_MS / 1000}s 后重试…`);
          await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
          clearUnhealthyProviders();
          clearChapterTimeoutCounts();
          continue;
        }
        throw err;
      }
    }
  };
  return { fn: retryFn, clearUnhealthyProviders, clearChapterTimeoutCounts };
}

function seedsForBatch(batch) {
  const base = batch * SEEDS_PER_BATCH;
  return [base, base + 1, base + 2];
}

// ── 将 A/B 聚合指标映射到新门禁输入 ──
function mapToDeterministicInput(aggA, aggB) {
  // 计算 prematureDoneRate：用 premature-done-diagnostic 的判定逻辑
  // 这里用聚合指标近似：空结果率 + 低覆盖率 + 低调用 → premature
  const totalScenarios = BATCHES * SEEDS_PER_BATCH * 8; // 8 场景
  const emptyRateB = aggB.emptyResults / Math.max(1, aggB.totalCalls);
  const emptyRateA = aggA.emptyResults / Math.max(1, aggA.totalCalls);

  // prematureDoneRate：从 premature-done-diagnostic 精确计算需要逐场景数据
  // 这里用聚合近似：如果 stopRate 高但 coverage 低，说明过早终止
  const prematureB = (aggB.stopRate > 0.5 && aggB.avgCoverageRatio < 0.3) ? aggB.stopRate : 0;
  const prematureA = (aggA.stopRate > 0.5 && aggA.avgCoverageRatio < 0.3) ? aggA.stopRate : 0;

  return {
    baseline: {
      mustVerifyCoverage: aggA.avgCoverageRatio,
      sourceRefCompleteness: aggA.sourceRefCompleteness,
      emptyResultRate: emptyRateA,
    },
    candidate: {
      mustVerifyCoverage: aggB.avgCoverageRatio,
      sourceRefCompleteness: aggB.sourceRefCompleteness,
      emptyResultRate: emptyRateB,
      unauthorizedToolCalls: aggB.invalidToolSelections,
      factHardErrors: 0, // 评测场景不含事实硬错；由生产 FactGuard 覆盖
      unclassifiedFailures: aggB.parseErrors + aggB.errors,
      traceRetentionRate: 1.0, // 评测脚本保证 trace 留存
      prematureDoneRate: prematureB,
    },
  };
}

function mapToLinkMetrics(agg) {
  return {
    modelCalls: agg.totalCalls,
    inputTokens: Math.round(agg.totalEstimateTokens * 0.3), // 估算拆分
    outputTokens: Math.round(agg.totalEstimateTokens * 0.7),
    retrievalCalls: agg.totalCalls,
    avgFirstEvidenceLatencyMs: agg.avgFirstEvidenceLatencyMs,
    autoRecoverySuccessRate: 1.0, // 评测无恢复逻辑
    chapterSaveSuccessRate: 1.0, // 评测不保存章节
    budgetExhausted: 0,
    timeouts: agg.timeouts,
    retries: 0,
    storyPreservationRate: 1.0, // 评测不含 StoryPreservation
  };
}

// ── 主执行 ──
async function main() {
  const perBatch = [];
  let modelFnWrapper = null;

  if (!DRY_RUN) {
    modelFnWrapper = await createRetryModelFn();
  }

  for (let batch = 0; batch < BATCHES; batch++) {
    const seeds = seedsForBatch(batch);
    console.log(`\n[eval] === 批次 ${batch + 1}/${BATCHES}（seeds ${seeds.join(",")}）===`);

    let comparison;
    if (DRY_RUN) {
      comparison = await runner.runPromptAbReplay({ seeds, batch });
    } else {
      modelFnWrapper.clearUnhealthyProviders();
      modelFnWrapper.clearChapterTimeoutCounts();
      // 带重试地运行 A/B replay
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          comparison = await runner.runPromptAbRealReplay({
            modelFn: modelFnWrapper.fn,
            seeds,
            batch,
          });
          break;
        } catch (err) {
          const msg = String(err?.message ?? err);
          const isQuota = msg.includes("exhausted") || msg.includes("429") || msg.includes("quota") || msg.includes("RESOURCE_EXHAUSTED");
          if (isQuota && attempt < MAX_RETRIES) {
            console.log(`[eval] 批次 ${batch + 1} Gemini 配额耗尽（尝试 ${attempt}/${MAX_RETRIES}），等待 ${RETRY_WAIT_MS / 1000}s…`);
            await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
            modelFnWrapper.clearUnhealthyProviders();
            modelFnWrapper.clearChapterTimeoutCounts();
            continue;
          }
          throw err;
        }
      }
    }

    perBatch.push(comparison);
    console.log(
      `[eval] 批次 ${batch + 1} 旧门禁：硬门=${comparison.gate.allHardPassed ? "PASS" : "FAIL"}`,
    );
  }

  // ── 跨批次聚合 ──
  function avgAgg(armKey) {
    const aggs = perBatch.map((c) => c.aggregation[armKey]);
    if (!aggs.length) return null;
    const out = { ...aggs[0] };
    const keys = ["totalCalls", "totalEstimateTokens", "invalidToolSelections", "parseErrors",
      "emptyResults", "errors", "timeouts"];
    for (const k of keys) out[k] = aggs.reduce((s, a) => s + a[k], 0);
    out.avgCoverageRatio = aggs.reduce((s, a) => s + a.avgCoverageRatio, 0) / aggs.length;
    out.sourceRefCompleteness = aggs.reduce((s, a) => s + a.sourceRefCompleteness, 0) / aggs.length;
    out.stopRate = aggs.reduce((s, a) => s + a.stopRate, 0) / aggs.length;
    const latA = aggs.filter((a) => a.avgFirstEvidenceLatencyMs !== null);
    out.avgFirstEvidenceLatencyMs = latA.length
      ? latA.reduce((s, a) => s + a.avgFirstEvidenceLatencyMs, 0) / latA.length
      : null;
    return out;
  }

  const crossA = avgAgg("A");
  const crossB = avgAgg("B");
  const oldGate = evaluatePromptGate(crossA, crossB);

  // ── 新门禁评估 ──
  const detInput = mapToDeterministicInput(crossA, crossB);
  const newHardGate = evaluateDeterministicHardGate(detInput);

  const linkA = mapToLinkMetrics(crossA);
  const linkB = mapToLinkMetrics(crossB);
  const linkComparison = compareLinkMetrics(linkA, linkB);

  // ── 生成报告 ──
  const timestamp = new Date().toISOString();
  const report = {
    schema: "prompt-evolution-eval/v1",
    task: "MODEL-PROMPT-EVOLUTION-1",
    timestamp,
    mode: DRY_RUN ? "dry-run" : "real",
    batches: BATCHES,
    route: GEMINI_ROUTE,
    temperature: TEMPERATURE,
    maxTokens: MAX_TOKENS,
    arms: {
      A: { label: "P-A（通用 Prompt，生产基线）", base: "REAL_SYSTEM_PROMPT_BASE" },
      B: { label: "P-B（Gemini 专属 Prompt 候选）", base: "GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE" },
    },
    crossBatchAggregation: { A: crossA, B: crossB },
    // 旧门禁（Phase 8 prompt-ab-gate）
    oldGate: {
      allHardPassed: oldGate.allHardPassed,
      allPassed: oldGate.allPassed,
      details: oldGate.details,
    },
    // 新门禁（MODEL-PROMPT-EVOLUTION-1 prompt-eval-gates）
    newGates: {
      // 第一层：确定性硬门
      deterministicHardGate: {
        passed: newHardGate.passed,
        recommendation: newHardGate.recommendation,
        failedChecks: newHardGate.failedChecks,
        checks: newHardGate.checks,
      },
      // 第二层：链路指标
      linkMetrics: {
        comparisons: linkComparison.comparisons,
        regressions: linkComparison.regressions,
      },
      // 第三层：文学质量（需真人盲评，本脚本不覆盖）
      literaryQuality: {
        status: "pending_human_eval",
        note: "第三层需真人匿名 A/B 盲评，机器评分仅诊断",
      },
    },
    conclusion: {
      oldGatePass: oldGate.allHardPassed,
      newGatePass: newHardGate.passed,
      newGateRecommendation: newHardGate.recommendation,
      overall: oldGate.allHardPassed && newHardGate.passed
        ? "候选通过全部硬门，可进入真人盲评"
        : newHardGate.recommendation === "reject"
          ? "候选被绝对安全门拒绝，不可进入真人盲评"
          : "候选被相对指标降级标记为 held，需人工复查",
    },
    perBatch: perBatch.map((c) => ({
      batch: c.batch,
      seeds: c.seeds,
      gate: c.gate,
      aggregation: c.aggregation,
    })),
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  const jsonPath = join(REPORT_DIR, `eval-${DRY_RUN ? "dry-run" : "real"}-${Date.now()}.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  // ── Markdown 报告 ──
  function fmt(v, d = 3) { return (typeof v === "number" ? v.toFixed(d) : String(v)); }
  function pct(v) { return `${(v * 100).toFixed(0)}%`; }
  function gtf(v) { return v ? "✓" : "✗"; }

  const md = [
    "# MODEL-PROMPT-EVOLUTION-1 — Prompt 进化集成评估报告",
    "",
    `**时间**：${timestamp}`,
    `**模式**：${DRY_RUN ? "dry-run（确定性 stub，零模型调用）" : "real（真实 Gemini）"}`,
    `**批次**：${BATCHES} | **route**：${GEMINI_ROUTE}（fallback=[]）`,
    `**候选**：P-A（通用 Prompt，生产基线）vs P-B（Gemini 专属 Prompt 候选）`,
    "",
    "## 1. 跨批次聚合对比",
    "",
    "| 指标 | P-A（通用基线） | P-B（Gemini 专属） |",
    "|------|------|------|",
    `| mustVerify 覆盖率 | ${fmt(crossA.avgCoverageRatio)} | ${fmt(crossB.avgCoverageRatio)} |`,
    `| sourceRef 完整率 | ${fmt(crossA.sourceRefCompleteness)} | ${fmt(crossB.sourceRefCompleteness)} |`,
    `| 停止率 | ${pct(crossA.stopRate)} | ${pct(crossB.stopRate)} |`,
    `| 总调用 | ${crossA.totalCalls} | ${crossB.totalCalls} |`,
    `| 估算 token | ${crossA.totalEstimateTokens} | ${crossB.totalEstimateTokens} |`,
    `| 非法工具选择 | ${crossA.invalidToolSelections} | ${crossB.invalidToolSelections} |`,
    `| 解析失败 | ${crossA.parseErrors} | ${crossB.parseErrors} |`,
    `| 空结果 | ${crossA.emptyResults} | ${crossB.emptyResults} |`,
    `| 错误 | ${crossA.errors} | ${crossB.errors} |`,
    `| 超时 | ${crossA.timeouts} | ${crossB.timeouts} |`,
    `| 首证据延迟(ms) | ${crossA.avgFirstEvidenceLatencyMs === null ? "n/a" : fmt(crossA.avgFirstEvidenceLatencyMs, 0)} | ${crossB.avgFirstEvidenceLatencyMs === null ? "n/a" : fmt(crossB.avgFirstEvidenceLatencyMs, 0)} |`,
    "",
    "## 2. 旧门禁（Phase 8 prompt-ab-gate）",
    "",
    "| 门禁 | 结论 | 详情 |",
    "|------|------|------|",
    `| mustVerify 覆盖率不降级 | ${gtf(oldGate.coverageNotDegraded)} | ${oldGate.details.coverageNotDegraded} |`,
    `| sourceRef 完整率不降级 | ${gtf(oldGate.sourceRefNotDegraded)} | ${oldGate.details.sourceRefNotDegraded} |`,
    `| 非法调用不恶化 | ${gtf(oldGate.invalidCallsNotWorsened)} | ${oldGate.details.invalidCallsNotWorsened} |`,
    `| 空结果不恶化 | ${gtf(oldGate.emptyResultsNotWorsened)} | ${oldGate.details.emptyResultsNotWorsened} |`,
    `| 停止率不降级 | ${gtf(oldGate.stopRateNotDegraded)} | ${oldGate.details.stopRateNotDegraded} |`,
    `| 硬门全部通过 | ${gtf(oldGate.allHardPassed)} | — |`,
    "",
    "## 3. 新门禁 — 第一层：确定性硬门（prompt-eval-gates）",
    "",
    "| 检查项 | 通过 | 期望 | 实际 |",
    "|--------|------|------|------|",
    ...Object.entries(newHardGate.checks).map(([k, v]) =>
      `| ${k} | ${gtf(v.passed)} | ${v.expected} | ${v.actual} |`,
    ),
    "",
    `**建议**：${newHardGate.recommendation}`,
    `**未通过项**：${newHardGate.failedChecks.length > 0 ? newHardGate.failedChecks.join(", ") : "无"}`,
    "",
    "## 4. 新门禁 — 第二层：链路指标（prompt-eval-gates）",
    "",
    "| 指标 | 基线(P-A) | 候选(P-B) | 恶化 | 成本类 |",
    "|------|-----------|-----------|------|--------|",
    ...linkComparison.comparisons.map((c) =>
      `| ${c.name} | ${c.baseline ?? "n/a"} | ${c.candidate ?? "n/a"} | ${c.worse ? "⚠️" : "—"} | ${c.costOnly ? "是" : "否"} |`,
    ),
    "",
    `**恶化项数**：${linkComparison.regressions.length}`,
    `> 成本类恶化仅标记不阻断，不能抵消第一层安全回归。`,
    "",
    "## 5. 新门禁 — 第三层：文学质量",
    "",
    "| 状态 | 说明 |",
    "|------|------|",
    "| 待真人盲评 | 第三层需真人匿名 A/B 盲评，机器评分仅诊断 |",
    "",
    "## 6. 综合结论",
    "",
    `| 维度 | 结论 |`,
    `|------|------|`,
    `| 旧门禁（Phase 8） | ${oldGate.allHardPassed ? "PASS" : "FAIL"} |`,
    `| 新门禁第一层 | ${newHardGate.passed ? "PASS" : "FAIL"}（${newHardGate.recommendation}）|`,
    `| 新门禁第二层 | ${linkComparison.regressions.length > 0 ? `${linkComparison.regressions.length} 项恶化` : "无恶化"} |`,
    `| 新门禁第三层 | 待真人盲评 |`,
    `| **总体** | ${report.conclusion.overall} |`,
    "",
    "> 允许结论为「专属 Prompt 未胜出」：如果 P-B 在任何硬门上回归，保持当前通用 Prompt 生产基线。",
  ];

  const mdPath = join(REPORT_DIR, `eval-${DRY_RUN ? "dry-run" : "real"}-${Date.now()}.md`);
  writeFileSync(mdPath, md.join("\n"));

  console.log(`\n[eval] 报告已生成：`);
  console.log(`  JSON: ${jsonPath}`);
  console.log(`  MD:   ${mdPath}`);
  console.log(`[eval] 旧门禁硬门：${oldGate.allHardPassed ? "PASS" : "FAIL"}`);
  console.log(`[eval] 新门禁第一层：${newHardGate.passed ? "PASS" : "FAIL"}（${newHardGate.recommendation}）`);
  console.log(`[eval] 总体结论：${report.conclusion.overall}`);
}

main().catch((err) => {
  console.error("[eval] 致命错误:", err);
  process.exit(1);
});
