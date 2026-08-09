/**
 * Phase 6.2 逐类长期状态单因素消融 replay 脚本
 *
 * 变体（5 arm，单因素消融）：
 * - A：完整状态（基线）
 * - A-Canon：完整状态去除 CanonState
 * - A-Character：完整状态去除 CharacterState
 * - A-Promise：完整状态去除 PromiseLedger
 * - A-Pattern：完整状态去除 PatternMemory
 *
 * 每个消融 arm 只排除一类状态，其他参数与 A 组一致（maxItems 48, 摘要 160 字符）。
 * 门禁：消融 arm vs A 不降级（覆盖率/sourceRef/失败行为/停止率）。
 *
 * 用法：
 *   $env:PINOVEL_DISABLE_FALLBACK="1"
 *   node scripts/context-ab-ablation-replay.mjs --require-auth --batches=3
 *
 * 输出：
 *   {repo_root}/reports/phase6-context-ab/{mode}/ablation-comparison.json
 *   {repo_root}/reports/phase6-context-ab/{mode}/ablation-comparison.md
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_DIR = __dirname;
const EXT_ROOT = join(SCRIPT_DIR, "..");
const PROJECT_ROOT = join(EXT_ROOT, "..", "..", "..");

const DRY_RUN = process.argv.includes("--dry-run");
const REQUIRE_AUTH = process.argv.includes("--require-auth");
const batchesArg = process.argv.find((a) => a.startsWith("--batches="));
const BATCHES = batchesArg ? parseInt(batchesArg.split("=")[1], 10) : 3;

if (!DRY_RUN && !REQUIRE_AUTH) {
  console.error("[ablation] 非 dry-run 模式必须显式传 --require-auth");
  process.exit(1);
}
if (!DRY_RUN && process.env.PINOVEL_DISABLE_FALLBACK !== "1") {
  console.error("[ablation] 真实模型模式必须设置 PINOVEL_DISABLE_FALLBACK=1");
  process.exit(1);
}

const MODE_DIR = DRY_RUN ? "dry-run" : "real";
const REPORT_DIR = join(PROJECT_ROOT, "reports", "phase6-context-ab", MODE_DIR);

const MODEL_ROUTE = process.env.PINOVEL_TOOL_AB_ROUTE ?? "narrator_testing_glm";
const TEMPERATURE = 0.72;
const MAX_TOKENS = 2048;
const SEEDS = [0, 1, 2];

console.log("[ablation] 逐类单因素消融 replay 启动");
console.log(`[ablation] 模式=${DRY_RUN ? "dry-run" : "real"}, 批次数=${BATCHES}, seeds=${SEEDS.join(",")}`);

const runner = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "context-ab-runner.js")}`
);
const gateMod = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "context-ab-gate.js")}`
);
const { aggregate, evaluateGate } = gateMod;

const scenarios = runner.getContextAbScenarios();
const variants = [
  { label: "A", arm: "A" },
  { label: "A-Canon", arm: "A-Canon" },
  { label: "A-Character", arm: "A-Character" },
  { label: "A-Promise", arm: "A-Promise" },
  { label: "A-Pattern", arm: "A-Pattern" },
];

// ── modelFn 构建 ──
let modelFn;
if (DRY_RUN) {
  modelFn = (ctx) => {
    if (ctx.round < 2) {
      return Promise.resolve({
        kind: "tool_call",
        toolName: "search_narrative_evidence",
        arguments: { query: "stub-query" },
      });
    }
    return Promise.resolve({ kind: "final", text: "<done>" });
  };
} else {
  const realRunner = await import(
    `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "tool-ab-real-runner.js")}`
  );
  modelFn = await realRunner.createRealToolAbModelDecide({
    route: MODEL_ROUTE,
    maxTokens: MAX_TOKENS,
    timeoutMs: parseInt(process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS ?? "120000", 10),
    temperature: TEMPERATURE,
  });
}

// ── 单次场景运行 ──
async function runOne(scenario, seed, variant) {
  try {
    const m = await runner.runContextAbScenario({
      scenario, arm: variant.arm, seed, modelFn,
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
      contextBlockTokens: m.contextBlockTokens ?? 0,
      contextBlockChars: m.contextBlockChars ?? 0,
      contextItemCount: m.contextItemCount ?? 0,
      contextCanonTokens: m.contextTokenBreakdown?.canon ?? 0,
      contextCharacterTokens: m.contextTokenBreakdown?.character ?? 0,
      contextPromiseTokens: m.contextTokenBreakdown?.promise ?? 0,
      contextPatternTokens: m.contextTokenBreakdown?.pattern ?? 0,
      contextExpectationTokens: m.contextTokenBreakdown?.expectation ?? 0,
      contextPlannedTokens: m.contextTokenBreakdown?.planned ?? 0,
      firstValidEvidenceCall: m.firstValidEvidence?.callIndex ?? -1,
      provenance: m.provenance ?? null,
    };
  } catch (err) {
    return {
      coverage: 0, stopped: 0, sourceRefCompleteness: 0, totalResultChars: 0,
      totalCalls: 0, totalDuplicateQueries: 0, schemaTokenCost: 0, emptyResults: 0,
      truncatedResults: 0, errors: 1, timeouts: 0, parseErrors: 0,
      invalidToolSelections: 0, invalidIntents: 0,
      contextBlockTokens: 0, contextBlockChars: 0, contextItemCount: 0,
      contextCanonTokens: 0, contextCharacterTokens: 0, contextPromiseTokens: 0,
      contextPatternTokens: 0, contextExpectationTokens: 0, contextPlannedTokens: 0,
      firstValidEvidenceCall: -1, provenance: null,
    };
  }
}

// ── 消融门禁：每个消融 arm vs A 不降级 ──
function evaluateAblationGate(ablationAgg, aAgg, armLabel) {
  const coverageGteA = ablationAgg.avgCoverage >= aAgg.avgCoverage - 1e-9;
  const sourceRefGteA = ablationAgg.avgSourceRef >= aAgg.avgSourceRef - 1e-9;
  const failuresNotWorseThanA =
    ablationAgg.totalErrors <= aAgg.totalErrors &&
    ablationAgg.totalTimeouts <= aAgg.totalTimeouts &&
    ablationAgg.totalParseErrors <= aAgg.totalParseErrors &&
    ablationAgg.totalEmpty <= aAgg.totalEmpty &&
    ablationAgg.totalInvalidTool <= aAgg.totalInvalidTool &&
    ablationAgg.totalTruncated <= aAgg.totalTruncated &&
    ablationAgg.totalInvalidIntents <= aAgg.totalInvalidIntents;
  const stopRateNotDegraded = ablationAgg.stopRate >= aAgg.stopRate - 0.05;
  // delta（A - 消融 arm）：正值表示该类状态有正贡献
  const coverageDelta = aAgg.avgCoverage - ablationAgg.avgCoverage;
  const sourceRefDelta = aAgg.avgSourceRef - ablationAgg.avgSourceRef;
  const tokenDelta = aAgg.totalContextBlockTokens - ablationAgg.totalContextBlockTokens;
  const allPassed = coverageGteA && sourceRefGteA && failuresNotWorseThanA && stopRateNotDegraded;

  return {
    arm: armLabel,
    coverageGteA,
    sourceRefGteA,
    failuresNotWorseThanA,
    stopRateNotDegraded,
    allPassed,
    coverageDelta,
    sourceRefDelta,
    tokenDelta,
    // 该类状态的边际贡献：coverageDelta > 5% 表示有显著正贡献
    hasSignificantContribution: coverageDelta > 0.05,
  };
}

// ── 多批次执行 ──
const allBatchResults = [];
let globalProvenance = null;

let clearUnhealthyProviders = null;
let clearChapterTimeoutCounts = null;
if (!DRY_RUN) {
  const fm = await import(
    `file://${join(EXT_ROOT, "dist-eval", "api", "fallback-manager.js")}`
  );
  clearUnhealthyProviders = fm.clearUnhealthyProviders;
  clearChapterTimeoutCounts = fm.clearChapterTimeoutCounts;
}

for (let batch = 0; batch < BATCHES; batch++) {
  console.log(`\n[ablation] === 批次 ${batch + 1}/${BATCHES} ===`);
  if (clearUnhealthyProviders) clearUnhealthyProviders();
  if (clearChapterTimeoutCounts) clearChapterTimeoutCounts();

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
        console.log(
          `cov=${r.coverage.toFixed(3)}, stop=${r.stopped}, calls=${r.totalCalls}, ctxTokens=${r.contextBlockTokens}`,
        );
      }
    }
  }

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
const ablationArms = ["A-Canon", "A-Character", "A-Promise", "A-Pattern"];
const crossAblation = {};
for (const arm of ablationArms) {
  crossAblation[arm] = crossBatchAggregate(arm);
}

const ablationGates = ablationArms.map((arm) =>
  evaluateAblationGate(crossAblation[arm], crossA, arm),
);

// ── 生成 JSON ──
const report = {
  schema: "context-ab-ablation-comparison/v1",
  timestamp: new Date().toISOString(),
  mode: DRY_RUN ? "dry-run" : "real",
  batches: BATCHES,
  provenance: globalProvenance ?? (DRY_RUN ? { mode: "stub" } : {
    provider: "glm", model: "glm-5.2", route: MODEL_ROUTE, temperature: TEMPERATURE,
  }),
  config: {
    modelRoute: MODEL_ROUTE, temperature: TEMPERATURE, maxTokens: MAX_TOKENS,
    seeds: SEEDS, scenarios: scenarios.map((s) => s.id), batches: BATCHES,
  },
  crossBatchAggregation: { A: crossA, ...crossAblation },
  ablationGates,
  perBatch: allBatchResults.map((b) => ({
    batch: b.batch,
    aggregation: b.aggregation,
    gates: ablationArms.map((arm) => evaluateAblationGate(b.aggregation[arm], b.aggregation.A, arm)),
  })),
  note: "Phase 6.2: 逐类单因素消融。每个 arm 只排除一类状态，其他参数与 A 一致。",
};

mkdirSync(REPORT_DIR, { recursive: true });
writeFileSync(join(REPORT_DIR, "ablation-comparison.json"), JSON.stringify(report, null, 2));

// ── 生成 Markdown ──
const p = globalProvenance ?? {};
function fmt(v, d = 3) { return (typeof v === "number" ? v.toFixed(d) : String(v)); }
function pct(v) { return `${(v * 100).toFixed(0)}%`; }

const md = [
  "# Phase 6.2 逐类单因素消融 replay 报告",
  "",
  `**时间**：${report.timestamp}`,
  `**模式**：${report.mode} | **批次数**：${BATCHES}`,
  `**Provenance**：${DRY_RUN ? "stub" : `provider=${p.provider ?? "?"}, model=${p.model ?? "?"}, route=${p.route ?? "?"}`}`,
  `**场景**：${report.config.scenarios.join(", ")} | **Seeds**：${SEEDS.join(", ")}`,
  "",
  "## 消融变体",
  "",
  "- **A**：完整状态（基线）",
  "- **A-Canon**：去除 CanonState",
  "- **A-Character**：去除 CharacterState",
  "- **A-Promise**：去除 PromiseLedger",
  "- **A-Pattern**：去除 PatternMemory",
  "",
  "## 跨批次聚合对比",
  "",
  "| 指标 | A 完整 | A-Canon | A-Character | A-Promise | A-Pattern |",
  "|------|--------|---------|-------------|-----------|-----------|",
  `| 覆盖率 | ${fmt(crossA.avgCoverage)} | ${fmt(crossAblation["A-Canon"].avgCoverage)} | ${fmt(crossAblation["A-Character"].avgCoverage)} | ${fmt(crossAblation["A-Promise"].avgCoverage)} | ${fmt(crossAblation["A-Pattern"].avgCoverage)} |`,
  `| 停止率 | ${pct(crossA.stopRate)} | ${pct(crossAblation["A-Canon"].stopRate)} | ${pct(crossAblation["A-Character"].stopRate)} | ${pct(crossAblation["A-Promise"].stopRate)} | ${pct(crossAblation["A-Pattern"].stopRate)} |`,
  `| sourceRef | ${fmt(crossA.avgSourceRef)} | ${fmt(crossAblation["A-Canon"].avgSourceRef)} | ${fmt(crossAblation["A-Character"].avgSourceRef)} | ${fmt(crossAblation["A-Promise"].avgSourceRef)} | ${fmt(crossAblation["A-Pattern"].avgSourceRef)} |`,
  `| 空结果 | ${crossA.totalEmpty} | ${crossAblation["A-Canon"].totalEmpty} | ${crossAblation["A-Character"].totalEmpty} | ${crossAblation["A-Promise"].totalEmpty} | ${crossAblation["A-Pattern"].totalEmpty} |`,
  `| 非法工具 | ${crossA.totalInvalidTool} | ${crossAblation["A-Canon"].totalInvalidTool} | ${crossAblation["A-Character"].totalInvalidTool} | ${crossAblation["A-Promise"].totalInvalidTool} | ${crossAblation["A-Pattern"].totalInvalidTool} |`,
  `| 上下文 token | ${crossA.totalContextBlockTokens} | ${crossAblation["A-Canon"].totalContextBlockTokens} | ${crossAblation["A-Character"].totalContextBlockTokens} | ${crossAblation["A-Promise"].totalContextBlockTokens} | ${crossAblation["A-Pattern"].totalContextBlockTokens} |`,
  "",
  "## 消融门禁（各 arm vs A 不降级）",
  "",
  "| Arm | 覆盖率>=A | sourceRef>=A | 失败不劣于A | 停止率不降级 | 覆盖率 delta | 有显著贡献 | 门禁 |",
  "|-----|-----------|-------------|------------|-------------|-------------|-----------|------|",
];

for (const g of ablationGates) {
  md.push(`| ${g.arm} | ${g.coverageGteA ? "PASS" : "FAIL"} | ${g.sourceRefGteA ? "PASS" : "FAIL"} | ${g.failuresNotWorseThanA ? "PASS" : "FAIL"} | ${g.stopRateNotDegraded ? "PASS" : "FAIL"} | ${fmt(g.coverageDelta)} | ${g.hasSignificantContribution ? "是" : "否"} | ${g.allPassed ? "PASS" : "FAIL"} |`);
}

md.push("", "## 结论", "");
const significantArms = ablationGates.filter((g) => g.hasSignificantContribution);
if (significantArms.length > 0) {
  md.push(`有显著正贡献（覆盖率 delta > 5%）的状态类：${significantArms.map((g) => g.arm).join(", ")}`);
} else {
  md.push("无状态类的排除导致覆盖率显著下降（delta < 5%），各状态类的边际贡献不显著。");
}

writeFileSync(join(REPORT_DIR, "ablation-comparison.md"), md.join("\n"));

console.log(`\n[ablation] 报告已生成：`);
console.log(`  JSON: ${join(REPORT_DIR, "ablation-comparison.json")}`);
console.log(`  MD:   ${join(REPORT_DIR, "ablation-comparison.md")}`);
for (const g of ablationGates) {
  console.log(`[ablation] ${g.arm} 门禁：${g.allPassed ? "PASS" : "FAIL"} (delta=${fmt(g.coverageDelta)})`);
}
