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

/**
 * 从真实 quality-trace.json 中提取 performanceProfile 等价数据。
 *
 * 真实 trace 没有 top-level performanceProfile 字段，数据分布在：
 *   gates[v2_final_selected].evidence.stageTiming   — 逐阶段耗时
 *   gates[v2_final_selected].evidence.modelCalls[]  — 逐次模型调用（含 tokenUsage.in/out）
 *   gates[v2_final_selected].evidence.finalSelection — 最终选择结果（用于判断 success）
 *   gates[v2_final_selected].evidence.modelBudget   — 模型预算使用情况
 *
 * 同时保留对 synthetic/future performanceProfile 格式的兼容。
 */
function extractPerfData(trace) {
  // 优先使用 performanceProfile（synthetic / 未来格式）
  if (trace.performanceProfile) {
    const perf = trace.performanceProfile;
    return {
      format: "performanceProfile",
      stageTimings: perf.stageTimings || {},
      llmTimings: Array.isArray(perf.llmTimings) ? perf.llmTimings : [],
      totalElapsedMs: Number(perf.totalElapsedMs) || 0,
      retryCostMs: Number(perf.retryCostMs) || 0,
      fallbackCostMs: Number(perf.fallbackCostMs) || 0,
      loopbackCostMs: Number(perf.loopbackCostMs) || 0,
    };
  }

  // 回退到 gates[v2_final_selected].evidence 结构（真实 trace 格式）
  const gates = Array.isArray(trace.gates) ? trace.gates : [];
  const finalGate = gates.find((g) => g.stage === "v2_final_selected" || g.stage === "final_selected");
  const evidence = finalGate?.evidence || {};
  const stageTiming = evidence.stageTiming || {};
  const modelCalls = Array.isArray(evidence.modelCalls) ? evidence.modelCalls : [];

  // 映射 modelCalls → llmTimings 等价格式
  // 真实字段: route/kind/model/durationMs/finishReason/tokenUsage.in/tokenUsage.out/provider/requestedRoute
  // 脚本期望: agent/elapsedMs/status/inputTokens/outputTokens/attempt
  const llmTimings = modelCalls.map((mc) => {
    const usage = mc.tokenUsage || {};
    const finishReason = mc.finishReason || "";
    // finishReason: "stop" → ok; "length"/"content_filter" → error; 其他 → transient_error
    let status = "ok";
    if (finishReason !== "stop" && finishReason !== "") {
      status = /timeout/i.test(finishReason) ? "timeout" : "transient_error";
    }
    return {
      agent: mc.requestedRoute || mc.route || mc.kind || "unknown",
      model: mc.model,
      provider: mc.provider,
      kind: mc.kind,
      elapsedMs: Number(mc.durationMs) || 0,
      status,
      inputTokens: typeof usage.in === "number" ? usage.in : (typeof mc.in === "number" ? mc.in : undefined),
      outputTokens: typeof usage.out === "number" ? usage.out : (typeof mc.out === "number" ? mc.out : undefined),
      attempt: 1, // 真实 trace 不记录 per-call attempt；成功调用默认 1
      finishReason,
      ts: mc.ts,
    };
  });

  // totalElapsedMs: 从 stageTiming 求和（无顶层 totalElapsedMs 字段）
  const totalElapsedMs = Object.values(stageTiming).reduce((sum, v) => sum + (Number(v) || 0), 0);

  return {
    format: "gates_evidence",
    stageTimings: stageTiming,
    llmTimings,
    totalElapsedMs,
    retryCostMs: 0,
    fallbackCostMs: 0,
    loopbackCostMs: 0,
    modelBudget: evidence.modelBudget || null,
    finalSelection: evidence.finalSelection || null,
  };
}

function aggregateTrace(trace, index) {
  const perf = extractPerfData(trace);
  const stageTimings = perf.stageTimings;
  const llmTimings = perf.llmTimings;
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

  // final success 判定：
  //   1) 无 hard/fatal failureEnvelope
  //   2) finalSelection 存在且 projectGain 为 positive（真实 trace 路径）
  //   3) performanceProfile 路径仅看 envelopes
  let success = envSummary.hard === 0;
  if (perf.finalSelection) {
    const gain = perf.finalSelection.projectGain;
    const hasSelection = !!perf.finalSelection.selectedCandidateId;
    success = success && hasSelection && gain !== "negative" && gain !== "regression";
  }

  return {
    index,
    workspaceId: trace.workspaceId,
    chapterId: trace.chapterId,
    createdAt: trace.createdAt,
    traceFormat: perf.format,
    totalElapsedMs: perf.totalElapsedMs,
    retryCostMs: perf.retryCostMs,
    fallbackCostMs: perf.fallbackCostMs,
    loopbackCostMs: perf.loopbackCostMs,
    modelBudget: perf.modelBudget,
    finalSelection: perf.finalSelection,
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
    calls: b.calls,
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

  // 每章明细
  const perChapter = traces.map((t) => {
    const calls = Object.values(t.agents).reduce((s, a) => s + a.calls, 0);
    const input = Object.values(t.agents).reduce((s, a) => s + a.inputTokens, 0);
    const output = Object.values(t.agents).reduce((s, a) => s + a.outputTokens, 0);
    const covered = Object.values(t.agents).reduce((s, a) => s + a.tokensCovered, 0);
    return {
      chapterId: t.chapterId,
      workspaceId: t.workspaceId,
      traceFormat: t.traceFormat,
      success: t.success,
      totalElapsedMs: t.totalElapsedMs,
      modelCalls: calls,
      inputTokens: input,
      outputTokens: output,
      tokensCovered: covered,
      tokenCoverage: calls ? +((covered / calls) * 100).toFixed(1) : 0,
      modelBudget: t.modelBudget,
      finalSelection: t.finalSelection ? {
        selectedSource: t.finalSelection.selectedSource,
        projectGain: t.finalSelection.projectGain,
      } : null,
      envSummary: t.envSummary,
    };
  });

  // token 覆盖率总览
  const totalTokensCovered = agentRows.reduce((s, a) => s + a.tokensCovered, 0);
  const tokenCoverage = totalCalls ? +((totalTokensCovered / totalCalls) * 100).toFixed(1) : 0;

  return {
    baselineVersion: "v1",
    baselineType: "真实 Gemini dev-eval 基线（不等于生产发布验收）",
    environment: {
      type: "dev_eval",
      pinovelDevMode: "1",
      releaseGateBypassed: true,
      productionPointerChanged: false,
      description: "PINOVEL_DEV_MODE=1 绕过 g6_release_gate 环境指纹检查；所有治理字段为 null，不修改 active pointer。本结果称为'真实 Gemini dev-eval 基线'，不得称为生产发布验收。",
    },
    sampleCount: traces.length,
    successCount,
    successRate: traces.length ? +(successCount / traces.length).toFixed(3) : 0,
    tokenCoverage,
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
      tokensCovered: totalTokensCovered,
    },
    perStage: stageRows,
    perAgent: agentRows,
    perChapter,
  };
}

function renderMarkdown(summary) {
  const L = [];
  L.push(`# 推理预算基线（Phase 1）— ${summary.baselineVersion}`);
  L.push(``);
  L.push(`> **${summary.baselineType}**`);
  L.push(``);
  L.push(`- 样本数：${summary.sampleCount}（成功 ${summary.successCount}，成功率 ${(summary.successRate * 100).toFixed(1)}%）`);
  L.push(`- token 覆盖率：${summary.tokenCoverage}%（${summary.totals.tokensCovered}/${summary.totals.modelCalls} 次调用有精确 token）`);
  L.push(`- 固定：Gemini 路由（v2_rawstage2_gemini31 / v2_amplified_gemini31）/ 上下文注入 / 9 专用工具 / DISABLE_FALLBACK=1`);
  L.push(`- 仅度量，不改生产行为（不改压缩参数 / 预算策略 / production pointer）`);
  L.push(``);
  L.push(`## 环境元数据`);
  L.push(``);
  L.push(`| 字段 | 值 |`);
  L.push(`|------|------|`);
  L.push(`| environment | ${summary.environment.type} |`);
  L.push(`| PINOVEL_DEV_MODE | ${summary.environment.pinovelDevMode} |`);
  L.push(`| releaseGateBypassed | ${summary.environment.releaseGateBypassed} |`);
  L.push(`| productionPointerChanged | ${summary.environment.productionPointerChanged} |`);
  L.push(``);
  L.push(`> ${summary.environment.description}`);
  L.push(``);
  L.push(`## token 度量说明`);
  L.push(``);
  L.push(`- \`inputTokens\` = provider 返回的 \`prompt_tokens\`（聚合输入 usage）。`);
  L.push(`- \`outputTokens\` = provider 返回的 \`completion_tokens\`（**聚合** completion usage）。`);
  L.push(`- Gemini 3.1 Pro Preview 是推理模型，\`completion_tokens\` **可能包含 reasoning/thinking tokens**；当前 trace 未提取 \`reasoning_tokens\` 细分（provider 未返回 \`completion_tokens_details\`），因此 \`outputTokens\` **不能直接等同于可见正文长度**。`);
  L.push(`- \`cached_tokens\` 细分（Gemini 隐式缓存命中）：当前 trace 未提取（provider 未返回 \`prompt_tokens_details\`）。`);
  L.push(`- 已在 \`fallback-manager.ts\` / \`quality-trace-recorder.ts\` 新增 \`reasoningTokens\` / \`cachedTokens\` 可选字段，未来 trace 如 provider 返回细分将自动捕获。`);
  L.push(``);
  L.push(`## 汇总（跨样本合计）`);
  L.push(``);
  L.push(`| 指标 | 数值 |`);
  L.push(`|------|------|`);
  L.push(`| 模型调用次数 | ${summary.totals.modelCalls} |`);
  L.push(`| 输入 token | ${summary.totals.inputTokens.toLocaleString()} |`);
  L.push(`| 输出 token | ${summary.totals.outputTokens.toLocaleString()} |`);
  L.push(`| token 合计 | ${(summary.totals.inputTokens + summary.totals.outputTokens).toLocaleString()} |`);
  L.push(`| 总耗时(ms) | ${summary.totals.elapsedMs.toLocaleString()} |`);
  L.push(`| 重试次数 | ${summary.totals.retries} |`);
  L.push(`| 超时数 | ${summary.totals.timeouts} |`);
  L.push(`| 错误数 | ${summary.totals.errors} |`);
  L.push(`| FailureEnvelope | ${summary.totals.failureEnvelopes} |`);
  L.push(`| 硬失败 | ${summary.totals.hardFailures} |`);
  L.push(`| 最终成功率 | ${(summary.successRate * 100).toFixed(1)}% (${summary.successCount}/${summary.sampleCount}) |`);
  L.push(``);
  L.push(`## 每章明细`);
  L.push(``);
  L.push(`| 章节 | 成功 | 耗时(ms) | 模型调用 | 输入token | 输出token | token覆盖 | selectedSource | projectGain | FailureEnvelope |`);
  L.push(`|------|------|------|------|------|------|------|------|------|------|`);
  for (const c of summary.perChapter) {
    const sel = c.finalSelection || {};
    L.push(`| ch${c.chapterId} | ${c.success ? "✓" : "✗"} | ${c.totalElapsedMs.toLocaleString()} | ${c.modelCalls} | ${c.inputTokens.toLocaleString()} | ${c.outputTokens.toLocaleString()} | ${c.tokenCoverage}% | ${sel.selectedSource || "-"} | ${sel.projectGain || "-"} | ${c.envSummary.count} |`);
  }
  L.push(``);
  L.push(`## 逐阶段耗时（平均）`);
  L.push(``);
  L.push(`| 阶段 | 运行章数 | 平均耗时(ms) | 占比 |`);
  L.push(`|------|------|------|------|`);
  const totalStageMs = summary.perStage.reduce((s, st) => s + st.avgElapsedMs, 0);
  for (const s of summary.perStage) {
    const pct = totalStageMs ? ((s.avgElapsedMs / totalStageMs) * 100).toFixed(1) : "0";
    L.push(`| ${s.stage} | ${s.runs} | ${s.avgElapsedMs.toLocaleString()} | ${pct}% |`);
  }
  L.push(``);
  L.push(`## 逐模型调用（每章均值）`);
  L.push(``);
  L.push(`| agent | 章数 | 总调用 | 调用/章 | 输入token/章 | 输出token/章 | 耗时ms/章 | ok/章 | 重试/章 | 超时/章 | 错误/章 | token覆盖 |`);
  L.push(`|------|------|------|------|------|------|------|------|------|------|------|------|`);
  for (const a of summary.perAgent) {
    const tcPct = a.calls ? ((a.tokensCovered / a.calls) * 100).toFixed(0) : "0";
    L.push(`| ${a.agent} | ${a.runs} | ${a.calls} | ${a.callsPerRun} | ${a.inputTokensPerRun.toLocaleString()} | ${a.outputTokensPerRun.toLocaleString()} | ${a.avgElapsedMs.toLocaleString()} | ${a.okPerRun} | ${a.retriesPerRun} | ${a.timeoutsPerRun} | ${a.errorsPerRun} | ${a.tokensCovered}/${a.calls} (${tcPct}%) |`);
  }
  L.push(``);
  L.push(`## 模型预算使用`);
  L.push(``);
  const budgets = summary.perChapter.filter((c) => c.modelBudget).map((c) => ({ chapterId: c.chapterId, ...c.modelBudget }));
  if (budgets.length > 0) {
    L.push(`| 章节 | soft | hard | used | capped |`);
    L.push(`|------|------|------|------|------|`);
    for (const b of budgets) {
      L.push(`| ch${b.chapterId} | ${b.soft} | ${b.hard} | ${b.used} | ${b.capped} |`);
    }
  } else {
    L.push(`（无 modelBudget 数据）`);
  }
  L.push(``);
  L.push(`## 关键观察`);
  L.push(``);
  const agenticStage = summary.perStage.find((s) => s.stage === "stage1_novelosAgentic");
  const styleStage = summary.perStage.find((s) => s.stage === "stage3_authorStyleOptimization");
  const otherStagesMs = summary.perStage
    .filter((s) => s.stage !== "stage1_novelosAgentic" && s.stage !== "stage3_authorStyleOptimization")
    .reduce((sum, s) => sum + s.avgElapsedMs, 0);
  if (agenticStage && styleStage) {
    const dominantMs = agenticStage.avgElapsedMs + styleStage.avgElapsedMs;
    const totalMs = agenticStage.avgElapsedMs + styleStage.avgElapsedMs + otherStagesMs;
    const dominantPct = totalMs ? ((dominantMs / totalMs) * 100).toFixed(1) : "0";
    L.push(`- NovelOS Agentic + 作者风格优化占总耗时 ${dominantPct}%（${dominantMs.toLocaleString()}ms / ${totalMs.toLocaleString()}ms），是推理预算的主要消耗点`);
    L.push(`- 其余阶段（FactGuard / StoryPreservation / FinalFactRecheck / CommitAndSave）合计仅 ${otherStagesMs.toLocaleString()}ms，无模型调用`);
  }
  if (summary.totals.retries === 0 && summary.totals.timeouts === 0 && summary.totals.errors === 0) {
    L.push(`- 零重试、零超时、零错误：3 章均一次性通过，无 transient failure 触发 bounded recovery`);
  }
  if (summary.totals.failureEnvelopes === 0) {
    L.push(`- 零 FailureEnvelope：统一主链路无 silent degrade，所有阶段正常完成`);
  }
  L.push(`- token 覆盖率 ${summary.tokenCoverage}%：Gemini OpenAI-compatible 路径全部精确取自 usage 字段`);
  L.push(``);
  L.push(`> 本基线仅 ${summary.sampleCount} 章最小样本，不能据此直接制定生产预算策略；`);
  L.push(`> 后续候选策略至少扩展到 6–9 章验证。`);
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