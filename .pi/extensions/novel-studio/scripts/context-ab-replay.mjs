/**
 * Phase 6.2 PatternMemory 单因素消融 A/D_pm replay 脚本（走生产 buildHistoricalContext 注入路径）
 *
 * 目标：验证排除 PatternMemory 对模型工具选择和证据覆盖的影响（单因素消融）
 *   - A 组（完整）：生产默认注入参数（canon 4×2400、character 6×1800、pattern 4×1000）
 *   - D_pm 组（单因素消融）：保持 A 的 maxItems/摘要长度不变，只排除 PatternMemory
 *
 * 口径（Gemini 冻结基线，2026-08-11）：
 *   - route = v2_rawstage2_gemini31，provider = gemini31，model = gemini-3.1-pro-preview
 *   - temperature = 0.72，maxTokens = 2048，DISABLE_FALLBACK=1
 *   - 场景 = SC1/SC6/SC7（高信号集），seed 0/1/2，共 9 arm 样本
 *   - schemaTokenCost 与状态注入正交（工具 schema 成本），不作为本轮压缩收益
 *   - 压缩收益只度量 contextBlockTokens；质量底线是 mustVerify/sourceRef/empty/errors/timeouts/stopRate
 *   - 对照基线为 Context Replay A（§15.4），非 Tool Interface A（§15.1）
 *
 * 用法：
 *   # dry-run（验证框架，零 API）
 *   node scripts/context-ab-replay.mjs --dry-run
 *
 *   # 真实 Gemini 模型
 *   $env:PINOVEL_DISABLE_FALLBACK="1"
 *   node scripts/context-ab-replay.mjs --require-auth --batches=1 --seeds=0,1,2
 *
 * 输出：
 *   {repo_root}/reports/phase6-context-ab/real/context-ab-comparison.json
 *   {repo_root}/reports/phase6-context-ab/real/context-ab-comparison.md
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_DIR = __dirname;
const EXT_ROOT = join(SCRIPT_DIR, "..");
const PROJECT_ROOT = join(EXT_ROOT, "..", "..", "..");

// ── 参数解析 ──
const DRY_RUN = process.argv.includes("--dry-run");
const REQUIRE_AUTH = process.argv.includes("--require-auth");
const batchesArg = process.argv.find((a) => a.startsWith("--batches="));
const BATCHES = batchesArg ? parseInt(batchesArg.split("=")[1], 10) : 1;
const seedsArg = process.argv.find((a) => a.startsWith("--seeds="));
const SEEDS = seedsArg ? seedsArg.split("=")[1].split(",").map((s) => parseInt(s.trim(), 10)) : [0, 1, 2];
// 消融 arm 选择：D_pm（PatternMemory）/ D_mi（maxItems）/ D_sl（摘要长度）
const ablationArg = process.argv.find((a) => a.startsWith("--ablation="));
const ABLATION_ARM = ablationArg ? ablationArg.split("=")[1] : "D_pm";
const ABLATION_LABELS = {
  D_pm: "D_pm（排PatternMemory, 其余不变）",
  D_mi: "D_mi（减maxItems: canon 4→2, character 6→3, 其余不变）",
  D_sl: "D_sl（减摘要长度: canon 2400→1200, character 1800→900, 其余不变）",
  D_pm_sl: "D_pm+D_sl（组合: 排PatternMemory + 减摘要长度 canon 2400→1200, character 1800→900, maxItems 保持生产默认）",
};
const ABLATION_DESC = ABLATION_LABELS[ABLATION_ARM] ?? ABLATION_ARM;

if (!DRY_RUN && !REQUIRE_AUTH) {
  console.error("[context-ab] 非 dry-run 模式必须显式传 --require-auth");
  process.exit(1);
}
if (!DRY_RUN && process.env.PINOVEL_DISABLE_FALLBACK !== "1") {
  console.error("[context-ab] 真实模型模式必须设置 PINOVEL_DISABLE_FALLBACK=1");
  process.exit(1);
}

// Phase 6.1.1 修复：real/dry-run 使用不同输出目录，禁止 dry-run 覆盖 real 产物
// 不同消融 arm 使用不同子目录，避免覆盖
const MODE_DIR = DRY_RUN ? "dry-run" : "real";
const REPORT_SUBDIR = ABLATION_ARM === "D_pm" ? MODE_DIR : `${MODE_DIR}-${ABLATION_ARM}`;
const REPORT_DIR = join(PROJECT_ROOT, "reports", "phase6-context-ab", REPORT_SUBDIR);

// Gemini 冻结基线路由（唯一真相源为 config/model-routing.json v4.31.0）
const MODEL_ROUTE = process.env.PINOVEL_TOOL_AB_ROUTE ?? "v2_rawstage2_gemini31";
const PROVIDER = "gemini31";
const MODEL = "gemini-3.1-pro-preview";
const TEMPERATURE = 0.72;
const MAX_TOKENS = 2048;

console.log(`[context-ab] ${ABLATION_ARM} 单因素消融 A/${ABLATION_ARM} replay 启动（生产 buildHistoricalContext 注入路径）`);
console.log(`[context-ab] 模式=${DRY_RUN ? "dry-run" : "real"}, 批次数=${BATCHES}, seeds=${SEEDS.join(",")}`);
console.log(`[context-ab] 路由=${MODEL_ROUTE} (${PROVIDER}/${MODEL}), temp=${TEMPERATURE}, maxTokens=${MAX_TOKENS}`);
console.log(`[context-ab] 变体：A(完整) / ${ABLATION_DESC}`);

const runner = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "context-ab-runner.js")}`
);
// Phase 6.1.1 收口：从 gate 模块导入 aggregate/evaluateGate，消除同步漂移
const gateMod = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "context-ab-gate.js")}`
);
const { aggregate, evaluateGate } = gateMod;

// SC1/SC6/SC7 高信号场景（冻结基线口径）：从 tool-ab-real-runner 导入 getBaselineScenarios
const realBaseline = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "tool-ab-real-runner.js")}`
);
const scenarios = realBaseline.getBaselineScenarios();
if (scenarios.length === 0) {
  console.error("[context-ab] 未找到高信号场景（SC1/SC6/SC7）");
  process.exit(1);
}
const variants = [
  { label: "A", arm: "A" },
  { label: ABLATION_ARM, arm: ABLATION_ARM },
];

// ── modelFn 构建 ──
let modelFn;
if (DRY_RUN) {
  // Dry-run stub：按场景 calls 顺序输出工具调用，最后输出终止标记
  modelFn = (ctx) => {
    const round = ctx.round;
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
    const counts = m.injectionCounts ?? { canon: 0, character: 0, pattern: 0, total: 0 };
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
      // Phase 6 压缩指标（收益度量 = contextBlockTokens）
      contextBlockTokens: m.contextBlockTokens ?? 0,
      contextBlockChars: m.contextBlockChars ?? 0,
      contextItemCount: m.contextItemCount ?? 0,
      contextCanonTokens: counts.canon,
      contextCharacterTokens: counts.character,
      contextPromiseTokens: 0,
      contextPatternTokens: counts.pattern,
      contextExpectationTokens: 0,
      contextPlannedTokens: 0,
      firstValidEvidenceCall: m.firstValidEvidence?.callIndex ?? -1,
      provenance: m.provenance ?? null,
      // 各状态类别实际保留条目数（B 压缩对照）
      injectCanonCount: counts.canon,
      injectCharacterCount: counts.character,
      injectPatternCount: counts.pattern,
      injectTotalCount: counts.total,
      // 生产注入三段原始文本（trajectory 用）
      historicalContinuity: m.historicalContinuity ?? [],
      historicalCharacterState: m.historicalCharacterState ?? [],
      recentPatternMemory: m.recentPatternMemory ?? [],
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
      injectCanonCount: 0, injectCharacterCount: 0, injectPatternCount: 0, injectTotalCount: 0,
      historicalContinuity: [], historicalCharacterState: [], recentPatternMemory: [],
    };
  }
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
          `calls=${r.totalCalls}, ctxTokens=${r.contextBlockTokens}, ctxItems=${r.injectTotalCount}`,
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
const crossD = crossBatchAggregate(ABLATION_ARM);

// 单因素消融：D vs A，不使用 C 组；cAgg 传 crossD 使 cDelta 归零（无意义但不报错）
const gate = evaluateGate(crossD, crossD, crossA);

// ── 逐场景/逐 seed trajectory ──
function buildTrajectory() {
  const rows = [];
  for (const scenario of scenarios) {
    for (const seed of SEEDS) {
      const row = { scenarioId: scenario.id, seed };
      for (const v of variants) {
        const entries = allBatchResults.flatMap((b) =>
          (b.rawEntries[v.label] ?? []).filter(
            (r) => r.scenarioId === scenario.id && r.seed === seed,
          ),
        );
        const agg = aggregate(entries);
        row[v.label] = {
          coverage: +agg.avgCoverage.toFixed(3),
          stopRate: +agg.stopRate.toFixed(3),
          sourceRef: +agg.avgSourceRef.toFixed(3),
          empty: agg.totalEmpty,
          errors: agg.totalErrors,
          timeouts: agg.totalTimeouts,
          stopCount: agg.totalChars > 0 ? entries.filter((e) => e.stopped).length : 0,
          contextBlockTokens: agg.totalContextBlockTokens,
          canonCount: entries.reduce((s, e) => s + (e.injectCanonCount ?? 0), 0),
          characterCount: entries.reduce((s, e) => s + (e.injectCharacterCount ?? 0), 0),
          patternCount: entries.reduce((s, e) => s + (e.injectPatternCount ?? 0), 0),
          itemCount: +agg.avgContextItemCount.toFixed(1),
        };
      }
      rows.push(row);
    }
  }
  return rows;
}
const trajectory = buildTrajectory();

// ── 压缩比例（D vs A，按 contextBlockTokens 与条目数） ──
function compressionRatio() {
  const aTokens = crossA.totalContextBlockTokens;
  const dTokens = crossD.totalContextBlockTokens;
  const aItems = crossA.avgContextItemCount;
  const dItems = crossD.avgContextItemCount;
  return {
    tokenReductionPct: aTokens > 0 ? +((1 - dTokens / aTokens) * 100).toFixed(1) : 0,
    itemReductionPct: aItems > 0 ? +((1 - dItems / aItems) * 100).toFixed(1) : 0,
    aTokens,
    dTokens,
    aItems: +aItems.toFixed(1),
    dItems: +dItems.toFixed(1),
  };
}
const compression = compressionRatio();

// ── 生成 JSON ──
const report = {
  schema: "context-ab-comparison/v1",
  timestamp: new Date().toISOString(),
  mode: DRY_RUN ? "dry-run" : "real",
  batches: BATCHES,
  provenance: globalProvenance ?? (DRY_RUN ? { mode: "stub" } : {
    provider: PROVIDER,
    model: MODEL,
    route: MODEL_ROUTE,
    temperature: TEMPERATURE,
    fallbackDisabled: true,
  }),
  config: {
    modelRoute: MODEL_ROUTE,
    provider: PROVIDER,
    model: MODEL,
    temperature: TEMPERATURE,
    maxTokens: MAX_TOKENS,
    seeds: SEEDS,
    scenarios: scenarios.map((s) => s.id),
    batches: BATCHES,
    injectionPath: "production buildHistoricalContext (boundedEntries)",
    compressionParams: {
      A: { canon: "4×2400", character: "6×1800", pattern: "4×1000" },
      [ABLATION_ARM]: ABLATION_DESC,
    },
    note: `schemaTokenCost 与状态注入正交（工具 schema 成本），不作为压缩收益；收益只度量 contextBlockTokens。${ABLATION_ARM} 单因素消融：${ABLATION_DESC}。`,
  },
  crossBatchAggregation: { A: crossA, [ABLATION_ARM]: crossD },
  compressionRatio: compression,
  gate,
  trajectory,
  perBatch: allBatchResults.map((b) => ({
    batch: b.batch,
    aggregation: b.aggregation,
    gate: evaluateGate(b.aggregation[ABLATION_ARM] ?? b.aggregation[ABLATION_ARM], b.aggregation[ABLATION_ARM] ?? b.aggregation[ABLATION_ARM], b.aggregation.A),
  })),
  note: `Phase 6.2 单因素消融：A=完整长期状态(生产默认)/${ABLATION_ARM}=${ABLATION_DESC}。固定9专用工具，走生产 buildHistoricalContext 注入路径。`,
};

mkdirSync(REPORT_DIR, { recursive: true });
writeFileSync(join(REPORT_DIR, "context-ab-comparison.json"), JSON.stringify(report, null, 2));

// ── 生成 Markdown ──
const p = globalProvenance ?? {};
function fmt(v, d = 3) { return (typeof v === "number" ? v.toFixed(d) : String(v)); }
function pct(v) { return `${(v * 100).toFixed(0)}%`; }

const md = [
  `# Phase 6.2 ${ABLATION_ARM} 单因素消融 A/${ABLATION_ARM} replay 报告（生产 buildHistoricalContext 注入路径）`,
  "",
  `**时间**：${report.timestamp}`,
  `**模式**：${report.mode}`,
  `**批次数**：${BATCHES}`,
  `**Provenance**：${DRY_RUN ? "stub" : `provider=${p.provider ?? "?"}, model=${p.model ?? "?"}, route=${p.route ?? "?"}, temp=${p.temperature ?? "?"}`}`,
  `**场景**：${report.config.scenarios.join(", ")} | **Seeds**：${SEEDS.join(", ")}`,
  "",
  "## 两组定义",
  "",
  "- **A 组（完整）**：生产默认注入参数（canon 4×2400、character 6×1800、pattern 4×1000）",
  `- **${ABLATION_ARM} 组（单因素消融）**：${ABLATION_DESC}`,
  "",
  "> 注入路径：生产 `buildHistoricalContext`（boundedEntries 三段）。`schemaTokenCost` 与状态注入正交（工具 schema 成本），不作为压缩收益；收益只度量 `contextBlockTokens`。",
  "> 对照基线为 **Context Replay A**（§15.4），非 Tool Interface A（§15.1）。",
  "",
  "## 跨批次聚合对比",
  "",
  `| 指标 | A 完整 | ${ABLATION_ARM} 消融 |`,
  "|------|--------|---------------|",
  `| 平均覆盖率 | ${fmt(crossA.avgCoverage)} | ${fmt(crossD.avgCoverage)} |`,
  `| 停止率 | ${pct(crossA.stopRate)} | ${pct(crossD.stopRate)} |`,
  `| sourceRef 完整率 | ${fmt(crossA.avgSourceRef)} | ${fmt(crossD.avgSourceRef)} |`,
  `| 总调用数 | ${crossA.totalCalls} | ${crossD.totalCalls} |`,
  `| 空结果数 | ${crossA.totalEmpty} | ${crossD.totalEmpty} |`,
  `| 错误数 | ${crossA.totalErrors} | ${crossD.totalErrors} |`,
  `| 超时数 | ${crossA.totalTimeouts} | ${crossD.totalTimeouts} |`,
  `| 非法工具选择 | ${crossA.totalInvalidTool} | ${crossD.totalInvalidTool} |`,
  `| schemaTokenCost（诊断） | ${crossA.schemaTokenCost} | ${crossD.schemaTokenCost} |`,
  `| 上下文 token | ${crossA.totalContextBlockTokens} | ${crossD.totalContextBlockTokens} |`,
  `| 上下文条目数 | ${fmt(crossA.avgContextItemCount, 1)} | ${fmt(crossD.avgContextItemCount, 1)} |`,
  `| 首证据延迟 | ${fmt(crossA.avgFirstValidEvidenceCall, 1)} | ${fmt(crossD.avgFirstValidEvidenceCall, 1)} |`,
  "",
  `## 压缩比例（${ABLATION_ARM} vs A）`,
  "",
  `- **contextBlockTokens 下降**：${compression.tokenReductionPct}%`,
  `- **注入条目数下降**：${compression.itemReductionPct}%`,
  "",
  `## 每场景 trajectory（A/${ABLATION_ARM} × seed）`,
  "",
  "| 场景 | seed | 臂 | 覆盖 | 停止 | sourceRef | empty | errors | timeouts | ctxTokens | canon | char | pattern | items |",
  "|------|------|-----|-----|------|-----------|-------|--------|----------|-----------|-------|------|---------|-------|",
  ...trajectory.flatMap((row) =>
    ["A", ABLATION_ARM].map((v) => {
      const m = row[v];
      return `| ${row.scenarioId} | ${row.seed} | ${v} | ${fmt(m.coverage)} | ${pct(m.stopRate)} | ${fmt(m.sourceRef)} | ${m.empty} | ${m.errors} | ${m.timeouts} | ${m.contextBlockTokens} | ${m.canonCount} | ${m.characterCount} | ${m.patternCount} | ${m.itemCount} |`;
    }),
  ),
  "",
  `## ${ABLATION_ARM} 组门禁（单因素消融不降级）`,
  "",
  "| 门禁项 | 结果 | 说明 |",
  "|--------|------|------|",
  `| 覆盖率 >= A | ${gate.bGate.coverageGteA ? "PASS" : "FAIL"} | ${fmt(crossD.avgCoverage)} vs ${fmt(crossA.avgCoverage)} |`,
  `| sourceRef >= A | ${gate.bGate.sourceRefGteA ? "PASS" : "FAIL"} | ${fmt(crossD.avgSourceRef)} vs ${fmt(crossA.avgSourceRef)} |`,
  `| 失败不劣于 A | ${gate.bGate.failuresNotWorseThanA ? "PASS" : "FAIL"} | errors/timeouts/parse/empty/invTool/truncated/invIntents |`,
  `| 停止率不降级 | ${gate.bGate.stopRateNotDegraded ? "PASS" : "FAIL"} | ${pct(crossD.stopRate)} vs ${pct(crossA.stopRate)} |`,
  `| token 下降 >10% | ${gate.bGate.tokenReduced ? "PASS" : "FAIL"} | ${gate.bGate.tokenReductionPct}（contextBlockTokens） |`,
  `| 首证据不延迟 | ${gate.bGate.firstEvidenceNotDelayed ? "PASS" : "FAIL"} | ${fmt(crossD.avgFirstValidEvidenceCall, 1)} vs ${fmt(crossA.avgFirstValidEvidenceCall, 1)} |`,
  `| **整体门禁** | ${gate.bGate.allPassed ? "PASS" : "FAIL"} | |`,
  "",
  "## 结论",
  "",
  gate.bGate.allPassed
    ? `${ABLATION_ARM} 组（${ABLATION_DESC}）**通过**门禁：contextBlockTokens 下降且覆盖不降级。`
    : `${ABLATION_ARM} 组（${ABLATION_DESC}）**未通过**门禁。质量劣化，保持 A 基线。`,
];

writeFileSync(join(REPORT_DIR, "context-ab-comparison.md"), md.join("\n"));

console.log(`\n[context-ab] 报告已生成：`);
console.log(`  JSON: ${join(REPORT_DIR, "context-ab-comparison.json")}`);
console.log(`  MD:   ${join(REPORT_DIR, "context-ab-comparison.md")}`);
console.log(`[context-ab] ${ABLATION_ARM} 组门禁：${gate.bGate.allPassed ? "PASS" : "FAIL"}（token 下降 ${compression.tokenReductionPct}%）`);