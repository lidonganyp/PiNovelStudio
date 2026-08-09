/**
 * Phase 5.3.2 提示词消融实验脚本（多批次版）
 *
 * 在同一执行内运行 N 批次 × 3 种 B 组变体（B0 / B-old / B-new）+ A 基线，
 * 固定同一模型（GLM 5.2）、同一场景（SC2/SC5/SC7）、同一 seed 集（0/1/2）。
 *
 * 用法：
 *   $env:PINOVEL_DISABLE_FALLBACK="1"
 *   node scripts/facade-guidance-ablation.mjs --require-auth --batches 3
 *
 * 输出：
 *   {repo_root}/reports/phase5-3-envelope-real/ablation-comparison.json
 *   {repo_root}/reports/phase5-3-envelope-real/ablation-comparison.md
 *
 * 注意：旧的消融产物可能存在于 .pi/reports/phase5-3-envelope-real/（过期路径，勿引用）。
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_DIR = __dirname;
const EXT_ROOT = join(SCRIPT_DIR, "..");
const PROJECT_ROOT = join(EXT_ROOT, "..", "..", "..");
const REPORT_DIR = join(PROJECT_ROOT, "reports", "phase5-3-envelope-real");

// ── 参数解析 ──
const REQUIRE_AUTH = process.argv.includes("--require-auth");
if (!REQUIRE_AUTH) {
  console.error("[ablation] 必须显式传 --require-auth");
  process.exit(1);
}
if (process.env.PINOVEL_DISABLE_FALLBACK !== "1") {
  console.error("[ablation] 必须设置 PINOVEL_DISABLE_FALLBACK=1");
  process.exit(1);
}
const batchesArg = process.argv.find((a) => a.startsWith("--batches="));
const BATCHES = batchesArg ? parseInt(batchesArg.split("=")[1], 10) : 3;

const MODEL_ROUTE = process.env.PINOVEL_TOOL_AB_ROUTE ?? "narrator_testing_glm";
const TEMPERATURE = 0.72;
const MAX_TOKENS = 2048;
const SEEDS = [0, 1, 2];

console.log("[ablation] 提示词消融实验启动（多批次）");
console.log(`[ablation] REPORT_DIR=${REPORT_DIR}`);
console.log(`[ablation] 批次数=${BATCHES}, seeds=${SEEDS.join(",")}, 模型=${MODEL_ROUTE}`);
console.log("[ablation] 变体：A / B0(无引导) / B-old(旧版引导) / B-new(新版引导)");

const runner = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "tool-ab-real-runner.js")}`
);

const modelFn = await runner.createRealToolAbModelDecide({
  route: MODEL_ROUTE,
  maxTokens: MAX_TOKENS,
  timeoutMs: parseInt(process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS ?? "120000", 10),
  temperature: TEMPERATURE,
});

const scenarios = runner.getEnvelopeReplayScenarios();
const variants = [
  { label: "A", arm: "A", guidanceVariant: undefined },
  { label: "B0", arm: "B0", guidanceVariant: undefined },
  { label: "B-old", arm: "B", guidanceVariant: "old" },
  { label: "B-new", arm: "B", guidanceVariant: "new" },
];

// ── 单次场景运行 ──
async function runOne(scenario, seed, variant) {
  try {
    const m = await runner.runRealToolAbScenario({
      scenario, arm: variant.arm, seed, modelFn,
      guidanceVariant: variant.guidanceVariant,
    });
    const tc = m.totalCalls ?? 0;
    const sv = m.sourceRefsValid ?? 0;
    return {
      coverage: m.mustVerify?.coverageRatio ?? 0,
      stopped: m.stopped ? 1 : 0,
      sourceRefCompleteness: tc > 0 ? sv / tc : 0,
      totalResultChars: m.totalResultChars ?? 0,
      totalCalls: tc,
      totalDuplicateQueries: m.totalDuplicateQueries ?? 0,
      schemaTokenCost: m.schemaTokenCost ?? 0,
      emptyResults: m.emptyResults ?? 0,
      truncatedResults: m.truncatedResults ?? 0,
      errors: m.errors ?? 0,
      timeouts: m.timeouts ?? 0,
      parseErrors: m.parseErrors ?? 0,
      invalidToolSelections: m.invalidToolSelections ?? 0,
      invalidIntents: m.invalidIntents ?? 0,
      provenance: m.turns?.find((t) => t.decision?.provenance)?.decision?.provenance ?? null,
    };
  } catch (err) {
    return { coverage: 0, stopped: 0, sourceRefCompleteness: 0, totalResultChars: 0,
      totalCalls: 0, totalDuplicateQueries: 0, schemaTokenCost: 0, emptyResults: 0,
      truncatedResults: 0, errors: 1, timeouts: 0, parseErrors: 0,
      invalidToolSelections: 0, invalidIntents: 0, provenance: null };
  }
}

// ── 聚合 ──
function aggregate(entries) {
  const n = entries.length || 1;
  const s = (k) => entries.reduce((sum, r) => sum + (r[k] ?? 0), 0);
  return {
    avgCoverage: s("coverage") / n,
    stopRate: s("stopped") / n,
    avgSourceRef: s("sourceRefCompleteness") / n,
    totalChars: s("totalResultChars"),
    totalCalls: s("totalCalls"),
    totalEmpty: s("emptyResults"),
    totalErrors: s("errors"),
    totalTimeouts: s("timeouts"),
    totalParseErrors: s("parseErrors"),
    totalInvalidTool: s("invalidToolSelections"),
    totalInvalidIntents: s("invalidIntents"),
    totalTruncated: s("truncatedResults"),
    totalDuplicateQueries: s("totalDuplicateQueries"),
    schemaTokenCost: s("schemaTokenCost"),
    count: entries.length,
  };
}

// ── 完整引导门禁（覆盖率 + sourceRef + 停止率 + 字符 + 失败） ──
function evaluateGuidanceGate(bAgg, b0Agg, aAgg) {
  const coverageGteB0 = bAgg.avgCoverage >= b0Agg.avgCoverage - 1e-9;
  const sourceRefGteB0 = bAgg.avgSourceRef >= b0Agg.avgSourceRef - 1e-9;
  const stopRateNotDegraded = bAgg.stopRate >= b0Agg.stopRate - 0.05;
  const charsNotWorsened = bAgg.totalChars <= b0Agg.totalChars * 1.10; // 10% 余量
  const coverageGteA = bAgg.avgCoverage >= aAgg.avgCoverage - 1e-9;
  const sourceRefGteA = bAgg.avgSourceRef >= aAgg.avgSourceRef - 1e-9;
  const failuresNotWorseThanA =
    bAgg.totalErrors <= aAgg.totalErrors &&
    bAgg.totalEmpty <= aAgg.totalEmpty &&
    bAgg.totalTimeouts <= aAgg.totalTimeouts &&
    bAgg.totalParseErrors <= aAgg.totalParseErrors &&
    bAgg.totalInvalidTool <= aAgg.totalInvalidTool &&
    bAgg.totalInvalidIntents <= aAgg.totalInvalidIntents;
  const failuresNotWorseThanB0 =
    bAgg.totalErrors <= b0Agg.totalErrors &&
    bAgg.totalEmpty <= b0Agg.totalEmpty &&
    bAgg.totalTimeouts <= b0Agg.totalTimeouts &&
    bAgg.totalInvalidTool <= b0Agg.totalInvalidTool;
  const allPassed = coverageGteB0 && sourceRefGteB0 && stopRateNotDegraded &&
    charsNotWorsened && coverageGteA && sourceRefGteA &&
    failuresNotWorseThanA && failuresNotWorseThanB0;
  return {
    coverageGteB0, sourceRefGteB0, stopRateNotDegraded, charsNotWorsened,
    coverageGteA, sourceRefGteA, failuresNotWorseThanA, failuresNotWorseThanB0, allPassed,
  };
}

// ── 多批次执行 ──
const allBatchResults = [];
let globalProvenance = null;

for (let batch = 0; batch < BATCHES; batch++) {
  console.log(`\n[ablation] === 批次 ${batch + 1}/${BATCHES} ===`);
  const batchEntries = {};

  for (const v of variants) batchEntries[v.label] = [];

  for (const scenario of scenarios) {
    for (const seed of SEEDS) {
      for (const v of variants) {
        const label = `${scenario.id}:${v.label}:b${batch}:s${seed}`;
        process.stdout.write(`[ablation] ${label} ... `);
        const r = await runOne(scenario, seed, v);
        if (!globalProvenance && r.provenance) globalProvenance = r.provenance;
        r.scenarioId = scenario.id;
        r.seed = seed;
        r.batch = batch;
        r.variant = v.label;
        batchEntries[v.label].push(r);
        console.log(`cov=${r.coverage.toFixed(3)}, stop=${r.stopped}, ref=${r.sourceRefCompleteness.toFixed(3)}, calls=${r.totalCalls}, chars=${r.totalResultChars}, empty=${r.emptyResults}, invTool=${r.invalidToolSelections}`);
      }
    }
  }

  // 批次内聚合
  const batchAgg = {};
  for (const v of variants) batchAgg[v.label] = aggregate(batchEntries[v.label]);
  allBatchResults.push({ batch, aggregation: batchAgg, rawEntries: batchEntries });
}

// ── 跨批次聚合 ──
function crossBatchAggregate(variantLabel) {
  const allEntries = allBatchResults.flatMap((b) => b.rawEntries[variantLabel] ?? []);
  return aggregate(allEntries);
}

const crossA = crossBatchAggregate("A");
const crossB0 = crossBatchAggregate("B0");
const crossBold = crossBatchAggregate("B-old");
const crossBnew = crossBatchAggregate("B-new");

const gateBold = evaluateGuidanceGate(crossBold, crossB0, crossA);
const gateBnew = evaluateGuidanceGate(crossBnew, crossB0, crossA);

// ── 生成 JSON ──
const report = {
  schema: "facade-guidance-ablation/v2",
  timestamp: new Date().toISOString(),
  batches: BATCHES,
  provenance: globalProvenance ?? { provider: "glm", model: "glm-5.2", route: MODEL_ROUTE, temperature: TEMPERATURE, fallbackDisabled: true },
  config: { modelRoute: MODEL_ROUTE, temperature: TEMPERATURE, maxTokens: MAX_TOKENS, fallbackDisabled: true, seeds: SEEDS, scenarios: scenarios.map((s) => s.id), batches: BATCHES },
  crossBatchAggregation: { A: crossA, B0: crossB0, "B-old": crossBold, "B-new": crossBnew },
  guidanceGate: { "B-old": gateBold, "B-new": gateBnew },
  perBatch: allBatchResults.map((b) => ({
    batch: b.batch,
    aggregation: b.aggregation,
    gate: {
      "B-old": evaluateGuidanceGate(b.aggregation["B-old"], b.aggregation.B0, b.aggregation.A),
      "B-new": evaluateGuidanceGate(b.aggregation["B-new"], b.aggregation.B0, b.aggregation.A),
    },
  })),
  note: "旧路径 .pi/reports/phase5-3-envelope-real/ 下的产物为过期版本，请以本路径为准。",
};

mkdirSync(REPORT_DIR, { recursive: true });
writeFileSync(join(REPORT_DIR, "ablation-comparison.json"), JSON.stringify(report, null, 2));

// ── 生成 Markdown ──
const p = globalProvenance ?? {};
function fmt(v, d = 3) { return (typeof v === "number" ? v.toFixed(d) : String(v)); }
function pct(v) { return `${(v * 100).toFixed(0)}%`; }

const md = [
  "# Phase 5.3.2 提示词消融实验报告（多批次）",
  "",
  `**时间**：${report.timestamp}`,
  `**批次数**：${BATCHES}`,
  `**Provenance**：provider=${p.provider ?? "?"}, model=${p.model ?? "?"}, route=${p.route ?? "?"}, temp=${p.temperature ?? "?"}, fallbackDisabled=${p.fallbackDisabled ?? true}, seedApplied=${p.seedApplied ?? "?"}, seedSupported=${p.seedSupported ?? "?"}`,
  `**场景**：${report.config.scenarios.join(", ")} | **Seeds**：${SEEDS.join(", ")}`,
  "",
  "> 注意：旧路径 `.pi/reports/phase5-3-envelope-real/` 下的产物为过期版本，请以本路径为准。",
  "",
  "## 跨批次聚合对比",
  "",
  "| 指标 | A 基线 | B0 无引导 | B-old 旧版引导 | B-new 新版引导 |",
  "|------|--------|----------|---------------|---------------|",
  `| 平均覆盖率 | ${fmt(crossA.avgCoverage)} | ${fmt(crossB0.avgCoverage)} | ${fmt(crossBold.avgCoverage)} | ${fmt(crossBnew.avgCoverage)} |`,
  `| 停止率 | ${pct(crossA.stopRate)} | ${pct(crossB0.stopRate)} | ${pct(crossBold.stopRate)} | ${pct(crossBnew.stopRate)} |`,
  `| sourceRef 完整率 | ${fmt(crossA.avgSourceRef)} | ${fmt(crossB0.avgSourceRef)} | ${fmt(crossBold.avgSourceRef)} | ${fmt(crossBnew.avgSourceRef)} |`,
  `| 总字符 | ${crossA.totalChars} | ${crossB0.totalChars} | ${crossBold.totalChars} | ${crossBnew.totalChars} |`,
  `| 总调用数 | ${crossA.totalCalls} | ${crossB0.totalCalls} | ${crossBold.totalCalls} | ${crossBnew.totalCalls} |`,
  `| 空结果 | ${crossA.totalEmpty} | ${crossB0.totalEmpty} | ${crossBold.totalEmpty} | ${crossBnew.totalEmpty} |`,
  `| 错误 | ${crossA.totalErrors} | ${crossB0.totalErrors} | ${crossBold.totalErrors} | ${crossBnew.totalErrors} |`,
  `| 非法工具 | ${crossA.totalInvalidTool} | ${crossB0.totalInvalidTool} | ${crossBold.totalInvalidTool} | ${crossBnew.totalInvalidTool} |`,
  `| 超时 | ${crossA.totalTimeouts} | ${crossB0.totalTimeouts} | ${crossBold.totalTimeouts} | ${crossBnew.totalTimeouts} |`,
  `| 解析失败 | ${crossA.totalParseErrors} | ${crossB0.totalParseErrors} | ${crossBold.totalParseErrors} | ${crossBnew.totalParseErrors} |`,
  "",
  "## 完整引导门禁（跨批次）",
  "",
  "| 门禁项 | B-old vs B0/A | B-new vs B0/A |",
  "|--------|---------------|---------------|",
  `| 覆盖率 >= B0 | ${gateBold.coverageGteB0 ? "✅" : "❌"} | ${gateBnew.coverageGteB0 ? "✅" : "❌"} |`,
  `| sourceRef >= B0 | ${gateBold.sourceRefGteB0 ? "✅" : "❌"} | ${gateBnew.sourceRefGteB0 ? "✅" : "❌"} |`,
  `| 停止率不降(B0-5%) | ${gateBold.stopRateNotDegraded ? "✅" : "❌"} | ${gateBnew.stopRateNotDegraded ? "✅" : "❌"} |`,
  `| 字符不膨胀(≤B0×1.10) | ${gateBold.charsNotWorsened ? "✅" : "❌"} | ${gateBnew.charsNotWorsened ? "✅" : "❌"} |`,
  `| 覆盖率 >= A | ${gateBold.coverageGteA ? "✅" : "❌"} | ${gateBnew.coverageGteA ? "✅" : "❌"} |`,
  `| sourceRef >= A | ${gateBold.sourceRefGteA ? "✅" : "❌"} | ${gateBnew.sourceRefGteA ? "✅" : "❌"} |`,
  `| 失败不恶化(vs A) | ${gateBold.failuresNotWorseThanA ? "✅" : "❌"} | ${gateBnew.failuresNotWorseThanA ? "✅" : "❌"} |`,
  `| 失败不恶化(vs B0) | ${gateBold.failuresNotWorseThanB0 ? "✅" : "❌"} | ${gateBnew.failuresNotWorseThanB0 ? "✅" : "❌"} |`,
  `| **全部通过** | **${gateBold.allPassed ? "✅" : "❌"}** | **${gateBnew.allPassed ? "✅" : "❌"}** |`,
  "",
  "## 逐批次摘要",
  "",
  ...allBatchResults.flatMap((b) => {
    const gBold = evaluateGuidanceGate(b.aggregation["B-old"], b.aggregation.B0, b.aggregation.A);
    const gBnew = evaluateGuidanceGate(b.aggregation["B-new"], b.aggregation.B0, b.aggregation.A);
    return [
      `### 批次 ${b.batch + 1}`,
      "",
      "| 指标 | A | B0 | B-old | B-new |",
      "|------|---|----|-------|-------|",
      `| 覆盖率 | ${fmt(b.aggregation.A.avgCoverage)} | ${fmt(b.aggregation.B0.avgCoverage)} | ${fmt(b.aggregation["B-old"].avgCoverage)} | ${fmt(b.aggregation["B-new"].avgCoverage)} |`,
      `| 停止率 | ${pct(b.aggregation.A.stopRate)} | ${pct(b.aggregation.B0.stopRate)} | ${pct(b.aggregation["B-old"].stopRate)} | ${pct(b.aggregation["B-new"].stopRate)} |`,
      `| sourceRef | ${fmt(b.aggregation.A.avgSourceRef)} | ${fmt(b.aggregation.B0.avgSourceRef)} | ${fmt(b.aggregation["B-old"].avgSourceRef)} | ${fmt(b.aggregation["B-new"].avgSourceRef)} |`,
      `| 字符 | ${b.aggregation.A.totalChars} | ${b.aggregation.B0.totalChars} | ${b.aggregation["B-old"].totalChars} | ${b.aggregation["B-new"].totalChars} |`,
      `| 调用数 | ${b.aggregation.A.totalCalls} | ${b.aggregation.B0.totalCalls} | ${b.aggregation["B-old"].totalCalls} | ${b.aggregation["B-new"].totalCalls} |`,
      `| 空结果 | ${b.aggregation.A.totalEmpty} | ${b.aggregation.B0.totalEmpty} | ${b.aggregation["B-old"].totalEmpty} | ${b.aggregation["B-new"].totalEmpty} |`,
      `| 非法工具 | ${b.aggregation.A.totalInvalidTool} | ${b.aggregation.B0.totalInvalidTool} | ${b.aggregation["B-old"].totalInvalidTool} | ${b.aggregation["B-new"].totalInvalidTool} |`,
      `| B-old 全通过 | ${gBold.allPassed ? "✅" : "❌"} | | | |`,
      `| B-new 全通过 | ${gBnew.allPassed ? "✅" : "❌"} | | | |`,
      "",
    ];
  }),
].join("\n");

writeFileSync(join(REPORT_DIR, "ablation-comparison.md"), md);

console.log("\n[ablation] 多批次消融实验完成");
console.log(`[ablation] JSON：${join(REPORT_DIR, "ablation-comparison.json")}`);
console.log(`[ablation] Markdown：${join(REPORT_DIR, "ablation-comparison.md")}`);
console.log("\n[ablation] 跨批次聚合：");
console.log(`  A:     cov=${fmt(crossA.avgCoverage)}, stop=${pct(crossA.stopRate)}, ref=${fmt(crossA.avgSourceRef)}, chars=${crossA.totalChars}, empty=${crossA.totalEmpty}, invTool=${crossA.totalInvalidTool}`);
console.log(`  B0:    cov=${fmt(crossB0.avgCoverage)}, stop=${pct(crossB0.stopRate)}, ref=${fmt(crossB0.avgSourceRef)}, chars=${crossB0.totalChars}, empty=${crossB0.totalEmpty}, invTool=${crossB0.totalInvalidTool}`);
console.log(`  B-old: cov=${fmt(crossBold.avgCoverage)}, stop=${pct(crossBold.stopRate)}, ref=${fmt(crossBold.avgSourceRef)}, chars=${crossBold.totalChars}, empty=${crossBold.totalEmpty}, invTool=${crossBold.totalInvalidTool}`);
console.log(`  B-new: cov=${fmt(crossBnew.avgCoverage)}, stop=${pct(crossBnew.stopRate)}, ref=${fmt(crossBnew.avgSourceRef)}, chars=${crossBnew.totalChars}, empty=${crossBnew.totalEmpty}, invTool=${crossBnew.totalInvalidTool}`);
console.log(`\n[ablation] B-old 全部门禁通过: ${gateBold.allPassed ? "✅" : "❌"}`);
console.log(`[ablation] B-new 全部门禁通过: ${gateBnew.allPassed ? "✅" : "❌"}`);
