/**
 * Phase 6.1 上下文压缩 A/B/C replay 脚本
 *
 * 目标：验证长期状态注入对模型工具选择和证据覆盖的影响
 *   - A 组（完整）：完整 LongTermStateSnapshot，摘要 160 字符/条
 *   - B 组（压缩）：压缩快照，摘要 80 字符/条，排除 PatternMemory/Planned
 *   - C 组（无状态）：不注入长期状态（基线）
 *
 * 用法：
 *   # dry-run（验证框架，零 API）
 *   node scripts/context-ab-replay.mjs --dry-run
 *
 *   # 真实模型（需 GLM 授权）
 *   $env:PINOVEL_DISABLE_FALLBACK="1"
 *   node scripts/context-ab-replay.mjs --require-auth --batches=3
 *
 * 输出：
 *   {repo_root}/reports/phase6-context-ab/context-ab-comparison.json
 *   {repo_root}/reports/phase6-context-ab/context-ab-comparison.md
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_DIR = __dirname;
const EXT_ROOT = join(SCRIPT_DIR, "..");
const PROJECT_ROOT = join(EXT_ROOT, "..", "..", "..");
const REPORT_DIR = join(PROJECT_ROOT, "reports", "phase6-context-ab");

// ── 参数解析 ──
const DRY_RUN = process.argv.includes("--dry-run");
const REQUIRE_AUTH = process.argv.includes("--require-auth");
const batchesArg = process.argv.find((a) => a.startsWith("--batches="));
const BATCHES = batchesArg ? parseInt(batchesArg.split("=")[1], 10) : 3;

if (!DRY_RUN && !REQUIRE_AUTH) {
  console.error("[context-ab] 非 dry-run 模式必须显式传 --require-auth");
  process.exit(1);
}
if (!DRY_RUN && process.env.PINOVEL_DISABLE_FALLBACK !== "1") {
  console.error("[context-ab] 真实模型模式必须设置 PINOVEL_DISABLE_FALLBACK=1");
  process.exit(1);
}

const MODEL_ROUTE = process.env.PINOVEL_TOOL_AB_ROUTE ?? "narrator_testing_glm";
const TEMPERATURE = 0.72;
const MAX_TOKENS = 2048;
const SEEDS = [0, 1, 2];

console.log("[context-ab] 上下文压缩 A/B/C replay 启动");
console.log(`[context-ab] 模式=${DRY_RUN ? "dry-run" : "real"}, 批次数=${BATCHES}, seeds=${SEEDS.join(",")}`);
console.log(`[context-ab] 变体：A(完整) / B(压缩) / C(无状态)`);

const runner = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "context-ab-runner.js")}`
);

const scenarios = runner.getContextAbScenarios();
const variants = [
  { label: "A", arm: "A" },
  { label: "B", arm: "B" },
  { label: "C", arm: "C" },
];

// ── modelFn 构建 ──
let modelFn;
if (DRY_RUN) {
  // Dry-run stub：按场景 calls 顺序输出工具调用，最后输出终止标记
  modelFn = (ctx) => {
    const round = ctx.round;
    // 简单 stub：前几回合调用工具，最后输出终止标记
    if (round < 2) {
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
  const { clearUnhealthyProviders, clearChapterTimeoutCounts } = await import(
    `file://${join(EXT_ROOT, "dist-eval", "api", "fallback-manager.js")}`
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
      scenario,
      arm: variant.arm,
      seed,
      modelFn,
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
      // Phase 6 专属指标
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
    totalDuplicateQueries: s("totalDuplicateQueries"),
    schemaTokenCost: s("schemaTokenCost"),
    // Phase 6 专属聚合
    totalContextBlockTokens: s("contextBlockTokens"),
    avgContextBlockTokens: s("contextBlockTokens") / n,
    totalContextBlockChars: s("contextBlockChars"),
    avgContextItemCount: s("contextItemCount") / n,
    totalCanonTokens: s("contextCanonTokens"),
    totalCharacterTokens: s("contextCharacterTokens"),
    totalPromiseTokens: s("contextPromiseTokens"),
    totalPatternTokens: s("contextPatternTokens"),
    totalExpectationTokens: s("contextExpectationTokens"),
    totalPlannedTokens: s("contextPlannedTokens"),
    avgFirstValidEvidenceCall: s("firstValidEvidenceCall") / n,
    count: entries.length,
  };
}

// ── 门禁 ──
function evaluateGate(bAgg, cAgg, aAgg) {
  // B 组门禁（压缩不降级）
  const coverageGteA = bAgg.avgCoverage >= aAgg.avgCoverage - 1e-9;
  const sourceRefGteA = bAgg.avgSourceRef >= aAgg.avgSourceRef - 1e-9;
  const failuresNotWorseThanA =
    bAgg.totalErrors <= aAgg.totalErrors &&
    bAgg.totalTimeouts <= aAgg.totalTimeouts &&
    bAgg.totalParseErrors <= aAgg.totalParseErrors;
  const stopRateNotDegraded = bAgg.stopRate >= aAgg.stopRate - 0.05;
  // token 成本下降 > 10%
  const tokenReduction = aAgg.totalContextBlockTokens > 0
    ? 1 - (bAgg.totalContextBlockTokens / aAgg.totalContextBlockTokens)
    : 0;
  const tokenReduced = tokenReduction > 0.10;
  // 首证据延迟 <= A + 1
  const firstEvidenceNotDelayed = bAgg.avgFirstValidEvidenceCall <= aAgg.avgFirstValidEvidenceCall + 1;

  const allPassed = coverageGteA && sourceRefGteA && failuresNotWorseThanA &&
    stopRateNotDegraded && tokenReduced && firstEvidenceNotDelayed;

  // C 组 delta（记录不阻断）
  const cCoverageDelta = aAgg.avgCoverage - cAgg.avgCoverage;
  const cSourceRefDelta = aAgg.avgSourceRef - cAgg.avgSourceRef;
  const cTokenDelta = aAgg.totalContextBlockTokens - cAgg.totalContextBlockTokens;
  const cMarginalValueInsufficient = cCoverageDelta < 0.05;

  return {
    bGate: {
      coverageGteA,
      sourceRefGteA,
      failuresNotWorseThanA,
      stopRateNotDegraded,
      tokenReduced,
      tokenReductionPct: (tokenReduction * 100).toFixed(1) + "%",
      firstEvidenceNotDelayed,
      allPassed,
    },
    cDelta: {
      coverageDelta: cCoverageDelta,
      sourceRefDelta: cSourceRefDelta,
      tokenDelta: cTokenDelta,
      marginalValueInsufficient: cMarginalValueInsufficient,
    },
  };
}

// ── 多批次执行 ──
const allBatchResults = [];
let globalProvenance = null;

// 导入 clearUnhealthyProviders（真实模式）
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
  console.log(`\n[context-ab] === 批次 ${batch + 1}/${BATCHES} ===`);
  if (clearUnhealthyProviders) clearUnhealthyProviders();
  if (clearChapterTimeoutCounts) clearChapterTimeoutCounts();

  const batchEntries = {};
  for (const v of variants) batchEntries[v.label] = [];

  for (const scenario of scenarios) {
    for (const seed of SEEDS) {
      for (const v of variants) {
        const label = `${scenario.id}:${v.label}:b${batch}:s${seed}`;
        process.stdout.write(`[context-ab] ${label} ... `);
        const r = await runOne(scenario, seed, v);
        if (!globalProvenance && r.provenance) globalProvenance = r.provenance;
        r.scenarioId = scenario.id;
        r.seed = seed;
        r.batch = batch;
        r.variant = v.label;
        batchEntries[v.label].push(r);
        console.log(
          `cov=${r.coverage.toFixed(3)}, stop=${r.stopped}, ref=${r.sourceRefCompleteness.toFixed(3)}, ` +
          `calls=${r.totalCalls}, ctxTokens=${r.contextBlockTokens}, ctxItems=${r.contextItemCount}`,
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
const crossB = crossBatchAggregate("B");
const crossC = crossBatchAggregate("C");

const gate = evaluateGate(crossB, crossC, crossA);

// ── 生成 JSON ──
const report = {
  schema: "context-ab-comparison/v1",
  timestamp: new Date().toISOString(),
  mode: DRY_RUN ? "dry-run" : "real",
  batches: BATCHES,
  provenance: globalProvenance ?? (DRY_RUN ? { mode: "stub" } : {
    provider: "glm",
    model: "glm-5.2",
    route: MODEL_ROUTE,
    temperature: TEMPERATURE,
    fallbackDisabled: true,
  }),
  config: {
    modelRoute: MODEL_ROUTE,
    temperature: TEMPERATURE,
    maxTokens: MAX_TOKENS,
    seeds: SEEDS,
    scenarios: scenarios.map((s) => s.id),
    batches: BATCHES,
    compressionParams: {
      A: { summaryCharLimit: 160, maxItems: 48, injectPattern: true, injectExpectation: true, injectPlanned: true },
      B: { summaryCharLimit: 80, maxItems: 24, injectPattern: false, injectExpectation: true, injectPlanned: false },
      C: { summaryCharLimit: 0, maxItems: 0, injectPattern: false, injectExpectation: false, injectPlanned: false },
    },
  },
  crossBatchAggregation: { A: crossA, B: crossB, C: crossC },
  gate,
  perBatch: allBatchResults.map((b) => ({
    batch: b.batch,
    aggregation: b.aggregation,
    gate: evaluateGate(b.aggregation.B, b.aggregation.C, b.aggregation.A),
  })),
  note: "Phase 6.1: A=完整长期状态/B=压缩/C=无状态。固定9专用工具，只变化上下文注入量。",
};

mkdirSync(REPORT_DIR, { recursive: true });
writeFileSync(join(REPORT_DIR, "context-ab-comparison.json"), JSON.stringify(report, null, 2));

// ── 生成 Markdown ──
const p = globalProvenance ?? {};
function fmt(v, d = 3) { return (typeof v === "number" ? v.toFixed(d) : String(v)); }
function pct(v) { return `${(v * 100).toFixed(0)}%`; }

const md = [
  "# Phase 6.1 上下文压缩 A/B/C replay 报告",
  "",
  `**时间**：${report.timestamp}`,
  `**模式**：${report.mode}`,
  `**批次数**：${BATCHES}`,
  `**Provenance**：${DRY_RUN ? "stub" : `provider=${p.provider ?? "?"}, model=${p.model ?? "?"}, route=${p.route ?? "?"}, temp=${p.temperature ?? "?"}`}`,
  `**场景**：${report.config.scenarios.join(", ")} | **Seeds**：${SEEDS.join(", ")}`,
  "",
  "## 三组定义",
  "",
  "- **A 组（完整）**：完整 LongTermStateSnapshot，摘要 160 字符/条，maxItems 48，全部四类状态",
  "- **B 组（压缩）**：摘要 80 字符/条，maxItems 24，排除 PatternMemory/Planned",
  "- **C 组（无状态）**：不注入长期状态（基线）",
  "",
  "## 跨批次聚合对比",
  "",
  "| 指标 | A 完整 | B 压缩 | C 无状态 |",
  "|------|--------|--------|---------|",
  `| 平均覆盖率 | ${fmt(crossA.avgCoverage)} | ${fmt(crossB.avgCoverage)} | ${fmt(crossC.avgCoverage)} |`,
  `| 停止率 | ${pct(crossA.stopRate)} | ${pct(crossB.stopRate)} | ${pct(crossC.stopRate)} |`,
  `| sourceRef 完整率 | ${fmt(crossA.avgSourceRef)} | ${fmt(crossB.avgSourceRef)} | ${fmt(crossC.avgSourceRef)} |`,
  `| 总调用数 | ${crossA.totalCalls} | ${crossB.totalCalls} | ${crossC.totalCalls} |`,
  `| 空结果数 | ${crossA.totalEmpty} | ${crossB.totalEmpty} | ${crossC.totalEmpty} |`,
  `| 错误数 | ${crossA.totalErrors} | ${crossB.totalErrors} | ${crossC.totalErrors} |`,
  `| 非法工具选择 | ${crossA.totalInvalidTool} | ${crossB.totalInvalidTool} | ${crossC.totalInvalidTool} |`,
  `| 上下文 token | ${crossA.totalContextBlockTokens} | ${crossB.totalContextBlockTokens} | ${crossC.totalContextBlockTokens} |`,
  `| 上下文条目数 | ${fmt(crossA.avgContextItemCount, 1)} | ${fmt(crossB.avgContextItemCount, 1)} | ${fmt(crossC.avgContextItemCount, 1)} |`,
  `| 首证据延迟 | ${fmt(crossA.avgFirstValidEvidenceCall, 1)} | ${fmt(crossB.avgFirstValidEvidenceCall, 1)} | ${fmt(crossC.avgFirstValidEvidenceCall, 1)} |`,
  "",
  "### 逐类 token 明细（A 组）",
  "",
  "| 状态类 | token |",
  "|--------|-------|",
  `| CanonState | ${crossA.totalCanonTokens} |`,
  `| CharacterState | ${crossA.totalCharacterTokens} |`,
  `| PromiseLedger | ${crossA.totalPromiseTokens} |`,
  `| PatternMemory | ${crossA.totalPatternTokens} |`,
  `| Expectation | ${crossA.totalExpectationTokens} |`,
  `| Planned | ${crossA.totalPlannedTokens} |`,
  "",
  "## B 组门禁（压缩不降级）",
  "",
  "| 门禁项 | 结果 | 说明 |",
  "|--------|------|------|",
  `| 覆盖率 >= A | ${gate.bGate.coverageGteA ? "PASS" : "FAIL"} | ${fmt(crossB.avgCoverage)} vs ${fmt(crossA.avgCoverage)} |`,
  `| sourceRef >= A | ${gate.bGate.sourceRefGteA ? "PASS" : "FAIL"} | ${fmt(crossB.avgSourceRef)} vs ${fmt(crossA.avgSourceRef)} |`,
  `| 失败不劣于 A | ${gate.bGate.failuresNotWorseThanA ? "PASS" : "FAIL"} | errors/timeouts/parse |`,
  `| 停止率不降级 | ${gate.bGate.stopRateNotDegraded ? "PASS" : "FAIL"} | ${pct(crossB.stopRate)} vs ${pct(crossA.stopRate)} |`,
  `| token 下降 >10% | ${gate.bGate.tokenReduced ? "PASS" : "FAIL"} | ${gate.bGate.tokenReductionPct} |`,
  `| 首证据不延迟 | ${gate.bGate.firstEvidenceNotDelayed ? "PASS" : "FAIL"} | ${fmt(crossB.avgFirstValidEvidenceCall, 1)} vs ${fmt(crossA.avgFirstValidEvidenceCall, 1)} |`,
  `| **整体门禁** | ${gate.bGate.allPassed ? "PASS" : "FAIL"} | |`,
  "",
  "## C 组 delta（无状态基线，记录不阻断）",
  "",
  "| 指标 | A - C delta | 说明 |",
  "|------|------------|------|",
  `| 覆盖率 delta | ${fmt(gate.cDelta.coverageDelta)} | ${gate.cDelta.marginalValueInsufficient ? "<5% 边际价值不足" : ">=5% 有边际价值"} |`,
  `| sourceRef delta | ${fmt(gate.cDelta.sourceRefDelta)} | |`,
  `| token delta | ${gate.cDelta.tokenDelta} | 长期状态注入的 token 成本 |`,
  "",
  "## 结论",
  "",
  gate.bGate.allPassed
    ? "B 组压缩上下文**通过**门禁：token 显著下降且覆盖不降级。可作 Phase 6.2 生产 canary 候选。"
    : "B 组压缩上下文**未通过**门禁。需检查具体失败项。",
  "",
  gate.cDelta.marginalValueInsufficient
    ? "C 组 delta < 5%：长期状态注入边际价值不足，当前注入量可能过大。"
    : "C 组 delta >= 5%：长期状态注入有正收益，当前注入量合理。",
];

writeFileSync(join(REPORT_DIR, "context-ab-comparison.md"), md.join("\n"));

console.log(`\n[context-ab] 报告已生成：`);
console.log(`  JSON: ${join(REPORT_DIR, "context-ab-comparison.json")}`);
console.log(`  MD:   ${join(REPORT_DIR, "context-ab-comparison.md")}`);
console.log(`[context-ab] B 组门禁：${gate.bGate.allPassed ? "PASS" : "FAIL"}`);
