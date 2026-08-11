#!/usr/bin/env node
/**
 * REASONING-BUDGET-BASELINE CLI：思考/推理预算研究 Phase 1 —— 建立统一主链路逐阶段模型使用基线
 *
 * 读取统一主链路章节生成产生的 quality-trace.json（含 P43 performanceProfile：
 * stageTimings 逐阶段耗时 + llmTimings 逐次模型调用 input/output token/耗时/状态/attempt，
 * 以及 failureEnvelopes 超时/失败），聚合出"逐阶段 + 逐模型调用"基线：
 *   - 模型调用次数、输入 token、输出 token、耗时、超时/FailureEnvelope、重试次数、最终成功率
 *
 * 固定当前 Gemini 路由、上下文注入与工具面，仅做度量，不改生产行为。
 *
 * 用法：
 *   node scripts/reasoning-budget-baseline.mjs [--trace <path1,path2,...>] [--output <dir>] [--dir <traces目录>]
 *   node scripts/reasoning-budget-baseline.mjs --synthetic   # 用内置 stub trace 验证框架（无真实数据）
 *
 * 选项：
 *   --trace <paths>  逗号分隔的 quality-trace.json 路径（默认空）
 *   --dir <path>     递归扫描该目录下 *-quality-trace.json（默认 <projectRoot>/reports/reasoning-budget-baseline/traces）
 *   --synthetic      内置一条代表性 stub trace 并聚合（验证框架，零真实数据）
 *   --output <dir>   报告输出目录（默认 <projectRoot>/reports/reasoning-budget-baseline）
 *   --help           打印帮助
 *
 * 产物：
 *   baseline.json    逐阶段/逐模型调用聚合基线
 *   baseline.md      人类可读基线报告
 */

import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { values } = parseArgs({
  options: {
    "trace": { type: "string" },
    "dir": { type: "string" },
    "output": { type: "string" },
    "synthetic": { type: "boolean", default: false },
    "help": { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`REASONING-BUDGET-BASELINE CLI：建立统一主链路逐阶段模型使用基线

用法：
  node scripts/reasoning-budget-baseline.mjs [--trace <path1,path2,...>] [--output <dir>]
  node scripts/reasoning-budget-baseline.mjs --synthetic

选项：
  --trace <paths>   逗号分隔的 quality-trace.json 路径
  --dir <path>      递归扫描该目录下 *-quality-trace.json
  --synthetic       用内置 stub trace 验证框架（建议先跑这个）
  --output <dir>    报告输出目录

产物：
  baseline.json / baseline.md
`);
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = resolve(__filename, "..");
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..", "..", "..");
const OUTPUT_DIR = values.output
  ? resolve(values.output)
  : join(PROJECT_ROOT, "reports", "reasoning-budget-baseline");

function log(message) {
  process.stderr.write(`[reasoning-budget-baseline] ${message}\n`);
}

// ── synthetic stub trace：验证聚合框架 ─────────────────────────────────────
function buildSyntheticTrace(id) {
  // 模拟统一主链路一条代表性章节 trace：preflight 无模型调用，agentic 最重，
  // 风格优化 1 次，复检 1 次；含 1 次 transient retry、无 hard 失败。
  const created = new Date();
  const stageTimings = {
    preflight: 12,
    context_compiler: 45,
    chapter_intent: 30,
    stage1_novelosAgentic: 420000,
    agentic_fact_guard: 8,
    style_optimization: 180000,
    story_preservation: 6,
    final_fact_recheck: 15000,
    completeness: 5,
    final_state_commit: 10,
  };
  const llmTimings = [
    { timestamp: new Date(created.getTime() + 1000).toISOString(), agent: "novelos_agentic", provider: "gemini", model: "gemini-3.1-pro-preview", attempt: 1, elapsedMs: 180000, status: "ok", inputTokens: 12000, outputTokens: 3000 },
    { timestamp: new Date(created.getTime() + 181000).toISOString(), agent: "novelos_agentic", provider: "gemini", model: "gemini-3.1-pro-preview", attempt: 2, elapsedMs: 210000, status: "ok", inputTokens: 11000, outputTokens: 2800 },
    { timestamp: new Date(created.getTime() + 400000).toISOString(), agent: "author_style_optimizer", provider: "gemini", model: "gemini-3.1-pro-preview", attempt: 1, elapsedMs: 170000, status: "ok", inputTokens: 9000, outputTokens: 2600 },
    { timestamp: new Date(created.getTime() + 600000).toISOString(), agent: "final_fact_recheck", provider: "gemini", model: "gemini-3.1-pro-preview", attempt: 1, elapsedMs: 15000, status: "ok", inputTokens: 3000, outputTokens: 400 },
  ];
  return {
    schemaVersion: 1,
    workspaceId: "synthetic",
    chapterId: id,
    createdAt: created.toISOString(),
    events: [{
      eventId: "E1", eventName: "synthetic", sceneType: "general", selectedRuleIds: [], selectedFewshotIds: [],
      contractSummary: "", evaluation: { score: 0, passed: true, issueTypes: [] }, attempts: 1, model: "gemini-3.1-pro-preview",
    }],
    patches: [],
    gates: [],
    failureEnvelopes: [],
    performanceProfile: {
      totalElapsedMs: 620000,
      stageTimings,
      llmTimings,
      retryCostMs: 0,
      fallbackCostMs: 0,
      loopbackCostMs: 0,
      topSlowStages: [],
      topSlowModelCalls: [],
    },
    buildInfo: { buildTimestamp: "synthetic", gitHash: "synthetic", nodeVersion: process.version },
  };
}

// ── 聚合 ──────────────────────────────────────────────────────────────────
function aggregateTrace(trace, index) {
  const perf = trace.performanceProfile || {};
  const stageTimings = perf.stageTimings || {};
  const llmTimings = Array.isArray(perf.llmTimings) ? perf.llmTimings : [];
  const envelopes = Array.isArray(trace.failureEnvelopes) ? trace.failureEnvelopes : [];

  // 逐阶段耗时
  const stages = {};
  for (const [stage, elapsedMs] of Object.entries(stageTimings)) {
    stages[stage] = { elapsedMs: Number(elapsedMs) || 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, retries: 0, timeouts: 0, errors: 0, ok: 0 };
  }

  // 逐模型调用聚合（按 agent 归类；同时尽量映射到阶段名）
  const agents = {};
  for (const entry of llmTimings) {
    const agent = entry.agent || "unknown";
    const bucket = agents[agent] || (agents[agent] = { agent, calls: 0, inputTokens: 0, outputTokens: 0, elapsedMs: 0, ok: 0, retries: 0, timeouts: 0, errors: 0, tokensCovered: 0 });
    bucket.calls += 1;
    bucket.elapsedMs += Number(entry.elapsedMs) || 0;
    if (typeof entry.inputTokens === "number") { bucket.inputTokens += entry.inputTokens; bucket.tokensCovered += 1; }
    if (typeof entry.outputTokens === "number") { bucket.outputTokens += entry.outputTokens; }
    if (entry.status === "ok") bucket.ok += 1;
    else if (entry.status === "timeout") bucket.timeouts += 1;
    else if (entry.status === "transient_error" || entry.status === "permanent_error") bucket.errors += 1;
    if ((entry.attempt || 1) > 1 || entry.status !== "ok") bucket.retries += 1;
  }

  // FailureEnvelope 汇总
  const envSummary = { count: envelopes.length, timeouts: 0, hard: 0, recoverable: 0, preflight: 0, gates: {} };
  for (const e of envelopes) {
    const severity = e.severity || "unknown";
    if (severity === "preflight") envSummary.preflight += 1;
    else if (severity === "recoverable") envSummary.recoverable += 1;
    else if (severity === "hard" || severity === "hard_block" || severity === "fatal") envSummary.hard += 1;
    if (e.gate === "model_timeout" || /timeout/i.test(e.reason || "")) envSummary.timeouts += 1;
    const gate = e.gate || "unknown";
    envSummary.gates[gate] = (envSummary.gates[gate] || 0) + 1;
  }

  // final success：无 hard/fatal 失败阻断
  const success = envSummary.hard === 0;

  return {
    index,
    workspaceId: trace.workspaceId,
    chapterId: trace.chapterId,
    createdAt: trace.createdAt,
    totalElapsedMs: Number(perf.totalElapsedMs) || 0,
    retryCostMs: Number(perf.retryCostMs) || 0,
    fallbackCostMs: Number(perf.fallbackCostMs) || 0,
    loopbackCostMs: Number(perf.loopbackCostMs) || 0,
    stages,
    agents,
    envSummary,
    success,
  };
}

function aggregateAll(traces) {
  const byStage = {};
  const byAgent = {};
  let totalCalls = 0, totalInput = 0, totalOutput = 0, totalElapsed = 0;
  let totalRetries = 0, totalTimeouts = 0, totalErrors = 0, totalEnvelopes = 0, totalHard = 0;
  let successCount = 0;

  for (const t of traces) {
    if (t.success) successCount += 1;
    totalEnvelopes += t.envSummary.count;
    totalHard += t.envSummary.hard;
    totalElapsed += t.totalElapsedMs;
    for (const [stage, s] of Object.entries(t.stages)) {
      const bucket = byStage[stage] || (byStage[stage] = { stage, runs: 0, elapsedMs: 0, elapsedSum: 0 });
      bucket.runs += 1;
      bucket.elapsedSum += s.elapsedMs;
    }
    for (const [agent, a] of Object.entries(t.agents)) {
      const bucket = byAgent[agent] || (byAgent[agent] = { agent, runs: 0, calls: 0, inputTokens: 0, outputTokens: 0, elapsedMs: 0, ok: 0, retries: 0, timeouts: 0, errors: 0, tokensCovered: 0 });
      bucket.runs += 1;
      bucket.calls += a.calls;
      bucket.inputTokens += a.inputTokens;
      bucket.outputTokens += a.outputTokens;
      bucket.elapsedMs += a.elapsedMs;
      bucket.ok += a.ok;
      bucket.retries += a.retries;
      bucket.timeouts += a.timeouts;
      bucket.errors += a.errors;
      bucket.tokensCovered += a.tokensCovered;
    }
    totalCalls += Object.values(t.agents).reduce((s, a) => s + a.calls, 0);
    totalInput += Object.values(t.agents).reduce((s, a) => s + a.inputTokens, 0);
    totalOutput += Object.values(t.agents).reduce((s, a) => s + a.outputTokens, 0);
    totalRetries += Object.values(t.agents).reduce((s, a) => s + a.retries, 0);
    totalTimeouts += Object.values(t.agents).reduce((s, a) => s + a.timeouts, 0);
    totalErrors += Object.values(t.agents).reduce((s, a) => s + a.errors, 0);
  }

  // 阶段平均耗时
  const stageRows = Object.values(byStage).map((b) => ({
    stage: b.stage,
    runs: b.runs,
    avgElapsedMs: Math.round(b.elapsedSum / b.runs),
  })).sort((a, b2) => b2.avgElapsedMs - a.avgElapsedMs);

  const agentRows = Object.values(byAgent).map((b) => ({
    agent: b.agent,
    runs: b.runs,
    callsPerRun: +(b.calls / b.runs).toFixed(2),
    inputTokensPerRun: Math.round(b.inputTokens / b.runs),
    outputTokensPerRun: Math.round(b.outputTokens / b.runs),
    avgElapsedMs: Math.round(b.elapsedMs / b.runs),
    okPerRun: +(b.ok / b.runs).toFixed(2),
    retriesPerRun: +(b.retries / b.runs).toFixed(2),
    timeoutsPerRun: +(b.timeouts / b.runs).toFixed(2),
    errorsPerRun: +(b.errors / b.runs).toFixed(2),
    tokensCovered: b.tokensCovered,
  })).sort((a, b2) => b2.callsPerRun - a.callsPerRun);

  return {
    sampleCount: traces.length,
    successCount,
    successRate: traces.length ? +(successCount / traces.length).toFixed(3) : 0,
    totals: {
      modelCalls: totalCalls,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      elapsedMs: totalElapsed,
      retries: totalRetries,
      timeouts: totalTimeouts,
      errors: totalErrors,
      failureEnvelopes: totalEnvelopes,
      hardFailures: totalHard,
    },
    perStage: stageRows,
    perAgent: agentRows,
  };
}

function renderMarkdown(summary) {
  const L = [];
  L.push(`# 推理预算基线（Phase 1）`);
  L.push(``);
  L.push(`- 样本数：${summary.sampleCount}（成功 ${summary.successCount}，成功率 ${(summary.successRate * 100).toFixed(1)}%）`);
  L.push(`- 固定：Gemini 路由 / 上下文注入 / 工具面；仅度量，不改生产行为`);
  L.push(``);
  L.push(`## 汇总`);
  L.push(``);
  L.push(`| 指标 | 数值（跨样本合计） |`);
  L.push(`|------|------|`);
  L.push(`| 模型调用次数 | ${summary.totals.modelCalls} |`);
  L.push(`| 输入 token | ${summary.totals.inputTokens} |`);
  L.push(`| 输出 token | ${summary.totals.outputTokens} |`);
  L.push(`| 总耗时(ms) | ${summary.totals.elapsedMs} |`);
  L.push(`| 重试次数 | ${summary.totals.retries} |`);
  L.push(`| 超时数 | ${summary.totals.timeouts} |`);
  L.push(`| 错误数 | ${summary.totals.errors} |`);
  L.push(`| FailureEnvelope | ${summary.totals.failureEnvelopes} |`);
  L.push(`| 硬失败 | ${summary.totals.hardFailures} |`);
  L.push(`| 最终成功率 | ${(summary.successRate * 100).toFixed(1)}% (${summary.successCount}/${summary.sampleCount}) |`);
  L.push(``);
  L.push(`## 逐阶段耗时（平均）`);
  L.push(``);
  L.push(`| 阶段 | 运行章数 | 平均耗时(ms) |`);
  L.push(`|------|------|------|`);
  for (const s of summary.perStage) {
    L.push(`| ${s.stage} | ${s.runs} | ${s.avgElapsedMs} |`);
  }
  L.push(``);
  L.push(`## 逐模型调用（每章均值）`);
  L.push(``);
  L.push(`| agent | 章数 | 调用/章 | 输入token/章 | 输出token/章 | 耗时ms/章 | ok/章 | 重试/章 | 超时/章 | 错误/章 |`);
  L.push(`|------|------|------|------|------|------|------|------|------|------|`);
  for (const a of summary.perAgent) {
    L.push(`| ${a.agent} | ${a.runs} | ${a.callsPerRun} | ${a.inputTokensPerRun} | ${a.outputTokensPerRun} | ${a.avgElapsedMs} | ${a.okPerRun} | ${a.retriesPerRun} | ${a.timeoutsPerRun} | ${a.errorsPerRun} |`);
  }
  L.push(``);
  L.push(`> token 覆盖：仅 OpenAI-compatible 路径（Gemini 生产主路径）精确取自 usage；Claude streaming 路径无 usage，token 留空。`);
  return L.join("\n");
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const traces = [];
let traceSources = [];

if (values.synthetic) {
  log("使用 synthetic stub trace 验证框架（无真实数据）");
  traces.push(aggregateTrace(buildSyntheticTrace("stub-1"), 0));
  traceSources = ["synthetic-stub-1"];
} else {
  const paths = (values.trace || "").split(",").map((p) => p.trim()).filter(Boolean);
  if (paths.length === 0) {
    const scanDir = values.dir ? resolve(values.dir) : join(OUTPUT_DIR, "traces");
    log(`未指定 --trace，扫描目录：${scanDir}`);
    if (paths.length === 0) {
      log("未找到 trace 文件。请用 --trace 指定，或先用 --synthetic 验证框架。");
      process.exit(1);
    }
  }
  for (const p of paths) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8"));
      traces.push(aggregateTrace(raw, traces.length));
      traceSources.push(p);
    } catch (err) {
      log(`跳过无法解析的 trace ${p}: ${err.message}`);
    }
  }
}

if (traces.length === 0) {
  log("无有效 trace，退出。");
  process.exit(1);
}

const summary = aggregateAll(traces);
mkdirSync(OUTPUT_DIR, { recursive: true });
const jsonPath = join(OUTPUT_DIR, "baseline.json");
const mdPath = join(OUTPUT_DIR, "baseline.md");
writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
writeFileSync(mdPath, renderMarkdown(summary), "utf-8");

log(`样本数=${summary.sampleCount} 成功率=${summary.successRate}`);
log(`baseline.json -> ${jsonPath}`);
log(`baseline.md   -> ${mdPath}`);
log(`trace 来源：${traceSources.join(", ")}`);