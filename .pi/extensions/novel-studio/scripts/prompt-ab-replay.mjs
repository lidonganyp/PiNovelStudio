/**
 * Phase 8 Stage P — Prompt-only A/B replay 脚本（eval-only）
 *
 * 对比两臂（见 docs/phase8-gemini-prompt-native-design.md §4）：
 * - P-A（基线）：通用 systemPrompt（REAL_SYSTEM_PROMPT_BASE）
 * - P-B（Gemini 专属）：Gemini 专属 systemPrompt（GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE）
 *
 * 复数场景：3 批 × 3 seed（seed 0-8），批次偏移 seed 起始值（batch b → seeds [b*3 .. b*3+2]）。
 * 固定维度：9 专用工具（arm=A）+ 完整上下文 + A 组预算 + Gemini 生产 route（narrator_primary, fallback=[]）。
 *
 * 用法：
 *   # dry-run（随机性 stub，零 API，验证框架）
 *   node scripts/prompt-ab-replay.mjs --dry-run
 *
 *   # 真实模型（Gemini 生产 route，需 gemini_validation 授权，fail-closed）
 *   $env:PINOVEL_BENCHMARK_COST_PROFILE="gemini_validation"
 *   node scripts/prompt-ab-replay.mjs --require-auth --batches=3
 *
 * 授权边界（fail-closed）：
 *   - 真实模式必须显式 --require-auth 且 PINOVEL_BENCHMARK_COST_PROFILE=gemini_validation。
 *   - 强制 route=narrator_primary（provider=gemini31, fallback=[]），不得改为 GPT/Claude/GLM。
 *   - 未授权时真实模式拒绝启动（不会静默降级到 stub 或其他 provider）。
 *
 * 输出：
 *   {repo_root}/reports/phase8-prompt-native/{dry-run,real}/prompt-ab-comparison.json
 *   {repo_root}/reports/phase8-prompt-native/{dry-run,real}/prompt-ab-comparison.md
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_DIR = __dirname;
const EXT_ROOT = join(SCRIPT_DIR, "..");
const PROJECT_ROOT = join(EXT_ROOT, "..", "..", "..");

// ── 加载项目根 .env（与扩展入口 index.ts 一致）：注入缺失的 API key/base_url ──
// 独立 CLI 不经过扩展入口，需手动解析 .env 注入 process.env（不覆盖已设置的环境变量）。
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

// ── 固定参数 ──
const GEMINI_ROUTE = "narrator_primary";
const TEMPERATURE = 0.72;
const MAX_TOKENS = 2048;
const SEEDS_PER_BATCH = 3;

// ── 参数解析 ──
const DRY_RUN = process.argv.includes("--dry-run");
const REQUIRE_AUTH = process.argv.includes("--require-auth");
const batchesArg = process.argv.find((a) => a.startsWith("--batches="));
const BATCHES = batchesArg ? parseInt(batchesArg.split("=")[1], 10) : 3;

if (!DRY_RUN && !REQUIRE_AUTH) {
  console.error("[prompt-ab] 非 dry-run 模式必须显式传 --require-auth");
  process.exit(1);
}
if (!DRY_RUN && process.env.PINOVEL_BENCHMARK_COST_PROFILE !== "gemini_validation") {
  console.error(
    "[prompt-ab] 真实模型模式必须设置 PINOVEL_BENCHMARK_COST_PROFILE=gemini_validation" +
    "（fail-closed：仅授权 Gemini 生产 route，禁止 GPT/Claude/GLM）",
  );
  process.exit(1);
}

// Phase 8.1 修复：real/dry-run 使用不同输出目录，禁止 dry-run 覆盖 real 产物
const MODE_DIR = DRY_RUN ? "dry-run" : "real";
const REPORT_DIR = join(PROJECT_ROOT, "reports", "phase8-prompt-native", MODE_DIR);

console.log("[prompt-ab] Phase 8 Stage P Prompt-only replay 启动");
console.log(
  `[prompt-ab] 模式=${DRY_RUN ? "dry-run(stub)" : "real(Gemini)"}, 批次=${BATCHES}, seed/batch=${SEEDS_PER_BATCH}, route=${GEMINI_ROUTE}`,
);
console.log("[prompt-ab] 两臂：P-A(通用 Prompt) vs P-B(Gemini 专属 Prompt)，固定 9 工具+完整上下文+A 组预算");

const runner = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "prompt-ab-runner.js")}`
);
const gateMod = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "prompt-ab-gate.js")}`
);
const { evaluatePromptGate } = gateMod;

// ── 每批 seed 偏移（batch b → seeds [b*3, b*3+1, b*3+2]）──
function seedsForBatch(batch) {
  const base = batch * SEEDS_PER_BATCH;
  return [base, base + 1, base + 2];
}

// ── 真实模型 modelFn（仅在 real 模式构建）──
let modelFn = null;
if (!DRY_RUN) {
  // gemini_validation profile 已在上方强制；route 固定为 narrator_primary（fallback=[]）。
  const realRunner = await import(
    `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "tool-ab-real-runner.js")}`
  );
  const { clearUnhealthyProviders, clearChapterTimeoutCounts } = await import(
    `file://${join(EXT_ROOT, "dist-eval", "api", "fallback-manager.js")}`
  );
  modelFn = {
    runner: realRunner,
    clearUnhealthyProviders,
    clearChapterTimeoutCounts,
    fn: await realRunner.createRealToolAbModelDecide({
      route: process.env.PINOVEL_TOOL_AB_ROUTE ?? GEMINI_ROUTE,
      maxTokens: MAX_TOKENS,
      timeoutMs: parseInt(process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS ?? "120000", 10),
      temperature: TEMPERATURE,
    }),
  };
}

// ── 多批次执行 ──
const perBatch = [];
let globalProvenance = null;

for (let batch = 0; batch < BATCHES; batch++) {
  const seeds = seedsForBatch(batch);
  console.log(`\n[prompt-ab] === 批次 ${batch + 1}/${BATCHES}（seeds ${seeds.join(",")}）===`);
  if (modelFn) {
    modelFn.clearUnhealthyProviders();
    modelFn.clearChapterTimeoutCounts();
  }

  const comparison = DRY_RUN
    ? await runner.runPromptAbReplay({ seeds, batch })
    : await runner.runPromptAbRealReplay({ modelFn: modelFn.fn, seeds, batch });

  if (!globalProvenance && comparison.provenance.A) globalProvenance = comparison.provenance.A;
  if (!globalProvenance && comparison.provenance.B) globalProvenance = comparison.provenance.B;

  perBatch.push(comparison);
  console.log(
    `[prompt-ab] 批次 ${batch + 1} 门禁：硬门=${comparison.gate.allHardPassed ? "PASS" : "FAIL"}, ` +
    `全部=${comparison.gate.allPassed ? "PASS" : "FAIL"}`,
  );
}

// ── 跨批次聚合（复用单批 runner 的门禁口径，跨批次展平）──
// 门禁以跨批次平铺的 A/B aggregation 为准（由各批 runner 的 aggregation 平均）
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
const crossGate = evaluatePromptGate(crossA, crossB);

// ── 生成 JSON ──
const report = {
  schema: "prompt-ab-replay/v1",
  timestamp: new Date().toISOString(),
  phase: "phase8-stage-p",
  mode: DRY_RUN ? "dry-run" : "real",
  batches: BATCHES,
  seedsPerBatch: SEEDS_PER_BATCH,
  route: GEMINI_ROUTE,
  temperature: TEMPERATURE,
  maxTokens: MAX_TOKENS,
  provenance: globalProvenance ?? (DRY_RUN ? { mode: "stub" } : {
    provider: "gemini31",
    model: "gemini-3.1-pro-preview",
    route: GEMINI_ROUTE,
    temperature: TEMPERATURE,
    fallbackDisabled: true,
  }),
  arms: {
    A: { label: "P-A（通用 Prompt）", base: "REAL_SYSTEM_PROMPT_BASE" },
    B: { label: "P-B（Gemini 专属 Prompt）", base: "GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE" },
  },
  crossBatchAggregation: { A: crossA, B: crossB },
  crossBatchGate: crossGate,
  perBatch: perBatch.map((c) => ({
    batch: c.batch,
    seeds: c.seeds,
    gate: c.gate,
    aggregation: c.aggregation,
  })),
  note: "Phase 8 Stage P: P-A(通用 Prompt) vs P-B(Gemini 专属 Prompt)。固定9专用工具+完整上下文+A组预算+Gemini生产route(fallback=[])。",
};

mkdirSync(REPORT_DIR, { recursive: true });
writeFileSync(join(REPORT_DIR, "prompt-ab-comparison.json"), JSON.stringify(report, null, 2));

// ── 生成 Markdown ──
const p = globalProvenance ?? {};
function fmt(v, d = 3) { return (typeof v === "number" ? v.toFixed(d) : String(v)); }
function pct(v) { return `${(v * 100).toFixed(0)}%`; }
function gtf(v) { return v ? "✓" : "✗"; }

const md = [
  "# Phase 8 Stage P — Prompt-only 对比报告",
  "",
  `**时间**：${report.timestamp}`,
  `**模式**：${report.mode === "dry-run" ? "确定性 stub（零模型调用）" : "真实模型（Gemini 生产 route，需授权）"}`,
  `**批次**：${BATCHES} | **seed/批**：${SEEDS_PER_BATCH}（seed 0-${BATCHES * SEEDS_PER_BATCH - 1}）`,
  `**route**：${GEMINI_ROUTE}（${p.provider ?? "?"}/${p.model ?? "?"}，fallback=[]）`,
  `**Provenance**：${DRY_RUN ? "stub" : `provider=${p.provider ?? "?"}, model=${p.model ?? "?"}, route=${p.route ?? "?"}, temp=${p.temperature ?? "?"}, fallbackDisabled=${p.fallbackDisabled ?? "?"}`}`,
  "",
  "> 两臂统一 9 专用工具 + 完整上下文 + A 组推理预算 + Gemini 生产 route（fallback=[]），",
  "> 只变化 systemPrompt（Prompt-only），使 Prompt 收益可独立归因。",
  "",
  "- **P-A（基线）**：通用 `REAL_SYSTEM_PROMPT_BASE`",
  "- **P-B（Gemini 专属）**：`GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE`",
  "",
  "## 跨批次聚合对比",
  "",
  "| 指标 | P-A（通用） | P-B（Gemini 专属） |",
  "|------|------|------|",
  `| 平均 mustVerify 覆盖率 | ${fmt(crossA.avgCoverageRatio)} | ${fmt(crossB.avgCoverageRatio)} |`,
  `| sourceRef 完整率 | ${fmt(crossA.sourceRefCompleteness)} | ${fmt(crossB.sourceRefCompleteness)} |`,
  `| 停止率 | ${pct(crossA.stopRate)} | ${pct(crossB.stopRate)} |`,
  `| 总调用 | ${crossA.totalCalls} | ${crossB.totalCalls} |`,
  `| 估算 token | ${crossA.totalEstimateTokens} | ${crossB.totalEstimateTokens} |`,
  `| 非法工具选择 | ${crossA.invalidToolSelections} | ${crossB.invalidToolSelections} |`,
  `| 解析失败 | ${crossA.parseErrors} | ${crossB.parseErrors} |`,
  `| 空结果 | ${crossA.emptyResults} | ${crossB.emptyResults} |`,
  `| 错误 | ${crossA.errors} | ${crossB.errors} |`,
  `| 超时 | ${crossA.timeouts} | ${crossB.timeouts} |`,
  `| 首证据延迟(ms) | ${crossA.avgFirstEvidenceLatencyMs === null ? "unmeasured" : fmt(crossA.avgFirstEvidenceLatencyMs, 0)} | ${crossB.avgFirstEvidenceLatencyMs === null ? "unmeasured" : fmt(crossB.avgFirstEvidenceLatencyMs, 0)} |`,
  "",
  "## 门禁结论（P-B 相对 P-A，跨批次）",
  "",
  "| 门禁 | 结论 | 详情 |",
  "|------|------|------|",
  `| mustVerify 覆盖率不降级 | ${gtf(crossGate.coverageNotDegraded)} | ${crossGate.details.coverageNotDegraded} |`,
  `| sourceRef 完整率不降级 | ${gtf(crossGate.sourceRefNotDegraded)} | ${crossGate.details.sourceRefNotDegraded} |`,
  `| 非法调用不恶化 | ${gtf(crossGate.invalidCallsNotWorsened)} | ${crossGate.details.invalidCallsNotWorsened} |`,
  `| 空结果不恶化 | ${gtf(crossGate.emptyResultsNotWorsened)} | ${crossGate.details.emptyResultsNotWorsened} |`,
  `| 停止率不降级 | ${gtf(crossGate.stopRateNotDegraded)} | ${crossGate.details.stopRateNotDegraded} |`,
  `| token 成本获益（加分项） | ${gtf(crossGate.tokenCostReduced)} | ${crossGate.details.tokenCostReduced} |`,
  `| 首证据延迟不恶化（加分项） | ${gtf(crossGate.latencyNotWorse)} | ${crossGate.details.latencyNotWorse} |`,
  "",
  `**硬门全部通过**：${crossGate.allHardPassed ? "是" : "否"}`,
  `**全部通过（含加分项）**：${crossGate.allPassed ? "是" : "否"}`,
  "",
  "## 各批次门禁",
  "",
  "| 批次 | seeds | 硬门 | 全部 |",
  "|------|-------|------|------|",
  ...perBatch.map((c) => {
    const seeds = seedsForBatch(c.batch);
    return `| ${c.batch + 1} | ${seeds.join(",")} | ${c.gate.allHardPassed ? "PASS" : "FAIL"} | ${c.gate.allPassed ? "PASS" : "FAIL"} |`;
  }),
  "",
  "> 稳定获益判定：≥2/3 批次硬门通过且跨批次方向一致，才进入 canary 候选设计；否则保持当前生产基线（漏洞保持通用 Prompt）。",
];

writeFileSync(join(REPORT_DIR, "prompt-ab-comparison.md"), md.join("\n"));

console.log(`\n[prompt-ab] 报告已生成：`);
console.log(`  JSON: ${join(REPORT_DIR, "prompt-ab-comparison.json")}`);
console.log(`  MD:   ${join(REPORT_DIR, "prompt-ab-comparison.md")}`);
console.log(`[prompt-ab] 跨批次硬门：${crossGate.allHardPassed ? "PASS" : "FAIL"}`);