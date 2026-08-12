/**
 * Protocol A/B Eval Runner（Phase 5）
 *
 * 在固定 fixture 上对 ReAct 与 Native FC 进行 A/B 对比。
 *
 * 使用方式：
 *   # synthetic 模式（默认，零模型调用，框架演示）
 *   node --import ./tests/setup-test-env.mjs scripts/protocol-ab-eval-runner.mjs
 *
 *   # 真实模型模式（需要 Gemini API 配额，带号池重试）
 *   node --import ./tests/setup-test-env.mjs scripts/protocol-ab-eval-runner.mjs --real --replays=3
 *
 * 输出：
 *   - reports/protocol-ab-eval-report.json：完整 A/B 对照矩阵和 Go/No-Go 建议
 *   - reports/protocol-ab-eval-summary.md：人类可读的评估摘要
 *
 * 前置条件（--real 模式）：
 *   - V2_FORCE_STUB 未设置或为 0
 *   - Gemini API 号池配额可用（耗尽时自动重试 10 次，每次间隔 5s）
 *   - eval workspace 存在
 *
 * 固定变量（Stage N 不修改 Prompt）：
 *   - Prompt Bundle
 *   - 上下文内容
 *   - 工具定义
 *   - 工具白名单
 *   - 检索预算
 *   - 模型与 endpoint
 *   - timeout
 *   - retry
 *   - workspace 与章节输入
 *
 * 唯一变量：protocol / adapter
 *
 * 注意：
 *   - ReAct 臂在 --real 模式下用真实 Gemini 模型调用 + ReactTextAdapter 解析
 *   - Native 臂需要 provider 原生 FC API 支持；当前 text-only endpoint 不支持，
 *     --real 模式下 Native 臂标注为"阻塞：需要 provider 原生 FC API"
 *   - 多次 replay（--replays=N）用于稳定性验证，每个 fixture × 每个 arm × N 次
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeMetricsFromTurns,
  createComparisonMatrix,
  evaluateGoNoGo,
} from "../dist-eval/novelos/protocol/protocol-ab-eval.js";
import {
  DEFAULT_EVAL_FIXTURES,
  HARD_GATE_METRICS,
  PROTOCOL_RISKS,
  REACT_PIPELINE_DEPENDENCY_GRAPH,
} from "../dist-eval/novelos/protocol/protocol-baseline.js";
import {
  isNativeFcRegistered,
  listEvalNativeFcRoutes,
  validateNativeFcCapabilities,
} from "../dist-eval/novelos/protocol/native-fc-eval-entry.js";
import {
  defaultAdapterRegistry as evalAdapterRegistry,
} from "../dist-eval/novelos/protocol/adapter-registry.js";
import { createReactTextAdapter } from "../dist/novelos/protocol/adapters/react-text-adapter.js";
import {
  createTextTurn,
  createToolCallTurn,
  createErrorTurn,
  serializeModelTurn,
} from "../dist/novelos/protocol/model-turn.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(__dirname, "..", "reports");

// ============================================================================
// 0. 参数解析与常量
// ============================================================================

const REAL_MODE = process.argv.includes("--real");
const replaysArg = process.argv.find((a) => a.startsWith("--replays="));
const REPLAYS = replaysArg ? Math.max(1, parseInt(replaysArg.split("=")[1], 10)) : 3;

/** Gemini 号池重试配置（参考 prompt-evolution-eval.mjs） */
const MAX_RETRIES = 10;
const RETRY_WAIT_MS = 5000;

/** 真实模型调用路由（Gemini 3.1 Pro Preview） */
const REAL_ROUTE = "v2_rawstage2_gemini31";
const REAL_MAX_TOKENS = 2048;
const REAL_TEMPERATURE = 0.72;

// ============================================================================
// 1. 环境预检
// ============================================================================

function preflight() {
  const issues = [];

  if (!isNativeFcRegistered()) {
    issues.push("Native FC Adapter 未注册");
  }

  const evalRoutes = listEvalNativeFcRoutes();
  if (evalRoutes.length < 2) {
    issues.push(`Eval route 数量不足：${evalRoutes.length} < 2`);
  }

  const capFailures = validateNativeFcCapabilities();
  if (capFailures.length > 0) {
    issues.push(`能力验证失败：${capFailures.join("; ")}`);
  }

  return issues;
}

// ============================================================================
// 2. Gemini 号池重试机制（参考 prompt-evolution-eval.mjs）
// ============================================================================

/**
 * 判断错误是否为 Gemini 号池配额耗尽。
 * 匹配 "exhausted" / "429" / "quota" / "RESOURCE_EXHAUSTED" 等关键词。
 */
function isQuotaExhaustedError(err) {
  const msg = String(err?.message ?? err);
  return msg.includes("exhausted")
    || msg.includes("429")
    || msg.includes("quota")
    || msg.includes("RESOURCE_EXHAUSTED")
    || msg.includes("All available accounts");
}

/**
 * 创建带号池重试的真实模型调用函数。
 *
 * Gemini API 号池耗尽时（403 All available accounts exhausted），
 * 等待 RETRY_WAIT_MS 后重试，最多 MAX_RETRIES 次。
 * 每次重试前清除 unhealthy provider 缓存，让号池自动恢复。
 *
 * @returns {Promise<{fn: Function, clearUnhealthyProviders: Function, clearChapterTimeoutCounts: Function}>}
 */
async function createRetryModelFn() {
  const { createLegacyModelGenerateFn } = await import(
    `file://${join(__dirname, "..", "dist-eval", "v2", "adapters", "legacy-model-route-adapter.js")}`
  );
  const { clearUnhealthyProviders, clearChapterTimeoutCounts } = await import(
    `file://${join(__dirname, "..", "dist-eval", "api", "fallback-manager.js")}`
  );

  const baseFn = createLegacyModelGenerateFn();

  const retryFn = async (input) => {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await baseFn(input);
      } catch (err) {
        if (isQuotaExhaustedError(err) && attempt < MAX_RETRIES) {
          console.log(`[protocol-eval] Gemini 号池配额耗尽（尝试 ${attempt}/${MAX_RETRIES}），等待 ${RETRY_WAIT_MS / 1000}s 后重试…`);
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

// ============================================================================
// 3. 真实模型调用（ReAct 臂）
// ============================================================================

/**
 * 在真实模型上运行单个 fixture 的 ReAct 臂。
 *
 * 调用真实 Gemini 模型获取 text 输出，用 ReactTextAdapter.parseResponse 解析为 ModelTurn。
 * 单轮调用：发送 systemPrompt + userPrompt，获取模型响应，解析为 ModelTurn。
 *
 * 注意：这是简化的单轮评估，不执行多轮工具调用循环。
 * 目的是获取真实 token/latency/parseFailure 指标，验证 ReAct 协议在真实模型上的工作状态。
 *
 * @param {object} modelFnWrapper - createRetryModelFn 返回的包装对象
 * @param {object} fixture - EvalFixture
 * @param {number} replayIndex - replay 序号（0-based）
 * @returns {Promise<object>} ProtocolRunResult
 */
async function runRealReActArm(modelFnWrapper, fixture, replayIndex) {
  const adapter = createReactTextAdapter();
  const systemPrompt = "你是检索驱动的叙事证据决策代理。请根据检索计划与可见工具，自主决定调用哪个工具收集证据；证据充分后只需输出终止标记 <done> 即可，无需生成章节正文。";
  const userPrompt = `【Fixture ${fixture.id} · Replay ${replayIndex + 1}】\n` +
    `章节：第${fixture.chapterNumber}章 ${fixture.chapterTitle}\n` +
    `可用工具：${fixture.allowedTools.join(", ")}\n` +
    `检索预算：maxTurns=${fixture.budget.maxTurns}, maxToolCalls=${fixture.budget.maxToolCalls}\n\n` +
    `请开始检索决策。如需调用工具，使用 <tool_call>{"name":"工具名","arguments":{...}}</tool_call> 格式。`;

  const startTime = Date.now();
  let output;
  try {
    output = await modelFnWrapper.fn({
      route: REAL_ROUTE,
      systemPrompt,
      userPrompt,
      kind: "protocol_ab_react",
      maxTokens: REAL_MAX_TOKENS,
      timeoutMs: fixture.timeoutMs,
      temperature: REAL_TEMPERATURE,
      seed: replayIndex * 1000 + 42,
    });
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    return {
      fixtureId: fixture.id,
      replayIndex,
      arm: "react",
      protocol: "react-text",
      adapterVersion: "react-text-v1",
      turns: [],
      metrics: computeMetricsFromTurns([], { allowedToolNames: new Set(fixture.allowedTools), traceComplete: false }),
      failure: {
        stage: "model_call",
        reason: isQuotaExhaustedError(err) ? "gemini_quota_exhausted_after_retries" : "model_call_error",
        evidence: String(err?.message ?? err).slice(0, 500),
      },
      timestamp: new Date().toISOString(),
      latencyMs,
    };
  }
  const latencyMs = Date.now() - startTime;

  // 用 ReactTextAdapter 解析响应为 ModelTurn
  const turn = adapter.parseResponse({
    body: {
      text: output.text,
      model: output.model,
      usage: typeof output.tokenUsage === "object" && output.tokenUsage !== "unknown"
        ? { input: output.tokenUsage.in, output: output.tokenUsage.out }
        : undefined,
    },
    status: 200,
  });

  const turns = [turn];
  const metrics = computeMetricsFromTurns(turns, {
    allowedToolNames: new Set(fixture.allowedTools),
    totalLatencyMs: latencyMs,
    traceComplete: true,
  });

  return {
    fixtureId: fixture.id,
    replayIndex,
    arm: "react",
    protocol: "react-text",
    adapterVersion: "react-text-v1",
    turns,
    metrics,
    modelUsed: output.model,
    providerUsed: output.provider,
    tokenUsage: output.tokenUsage,
    timestamp: new Date().toISOString(),
    latencyMs,
  };
}

/**
 * Native 臂在 --real 模式下的占位结果。
 *
 * 当前 text-only endpoint 不支持 provider 原生 FC API，
 * Native 臂标注为"阻塞：需要 provider 原生 FC API 支持"。
 *
 * 后续当 provider 原生 FC API 可用时，替换此函数为真正的 Native FC 调用。
 */
function createNativeArmBlockedResult(fixture, replayIndex) {
  return {
    fixtureId: fixture.id,
    replayIndex,
    arm: "native",
    protocol: "native-function-calling",
    adapterVersion: "native-fc-v1",
    turns: [],
    metrics: computeMetricsFromTurns([], { allowedToolNames: new Set(fixture.allowedTools), traceComplete: false }),
    failure: {
      stage: "native_fc_api_unavailable",
      reason: "当前 text-only endpoint 不支持 provider 原生 FC API；Native 臂真实评估阻塞",
      evidence: "需要 provider 原生 FC API 支持（如 Gemini/OpenAI 原生 function calling），当前 ModelGenerateFn 只支持 text-only 调用",
    },
    timestamp: new Date().toISOString(),
    latencyMs: 0,
  };
}

// ============================================================================
// 4. 指标计算（从 ModelTurn 序列）
// ============================================================================

function computeMetricsForFixture(turns, fixture) {
  const allowedToolNames = new Set(fixture.allowedTools);
  return computeMetricsFromTurns(turns, {
    allowedToolNames,
    traceComplete: true,
  });
}

// ============================================================================
// 5. 多次 replay 聚合
// ============================================================================

/**
 * 将多次 replay 的结果聚合为单个 fixture 级别结果。
 *
 * 聚合策略：
 * - metrics：取所有成功 replay 的平均值（token/latency/callCounts 累加后取均）
 * - failure：如果所有 replay 都失败，记录 failure；部分失败记录 partial_failure
 * - turns：合并所有 replay 的 turns（供 trace 分析）
 *
 * @param {Array} replayResults - 同一 fixture × arm 的多次 replay 结果
 * @returns {object} 聚合后的 ProtocolRunResult
 */
function aggregateReplayResults(replayResults) {
  if (replayResults.length === 0) {
    return null;
  }

  const successful = replayResults.filter((r) => !r.failure);
  const failed = replayResults.filter((r) => r.failure);

  if (successful.length === 0) {
    // 所有 replay 都失败
    return {
      ...replayResults[0],
      metrics: replayResults[0].metrics,
      failure: {
        stage: "all_replays_failed",
        reason: `所有 ${replayResults.length} 次 replay 均失败`,
        evidence: failed.map((f) => `${f.replayIndex + 1}: ${f.failure?.reason}`).join("; "),
      },
      replayCount: replayResults.length,
      successCount: 0,
      allReplays: replayResults,
    };
  }

  // 聚合成功 replay 的 metrics
  const aggMetrics = {
    illegalToolCallRate: avg(successful.map((r) => r.metrics.illegalToolCallRate)),
    parserFailureRate: avg(successful.map((r) => r.metrics.parserFailureRate)),
    schemaErrorRate: avg(successful.map((r) => r.metrics.schemaErrorRate)),
    unauthorizedCallRate: avg(successful.map((r) => r.metrics.unauthorizedCallRate)),
    mustVerifyCoverage: avg(successful.map((r) => r.metrics.mustVerifyCoverage)),
    sourceRefCompleteness: avg(successful.map((r) => r.metrics.sourceRefCompleteness)),
    prematureDoneRate: avg(successful.map((r) => r.metrics.prematureDoneRate)),
    firstEvidenceLatencyMs: avg(successful.map((r) => r.metrics.firstEvidenceLatencyMs)),
    tokenUsage: {
      input: avg(successful.map((r) => r.metrics.tokenUsage.input)),
      output: avg(successful.map((r) => r.metrics.tokenUsage.output)),
      total: avg(successful.map((r) => r.metrics.tokenUsage.total)),
    },
    latencyMs: avg(successful.map((r) => r.metrics.latencyMs)),
    callCounts: {
      modelCalls: avg(successful.map((r) => r.metrics.callCounts.modelCalls)),
      toolCalls: avg(successful.map((r) => r.metrics.callCounts.toolCalls)),
    },
    traceCompleteness: avg(successful.map((r) => r.metrics.traceCompleteness)),
  };

  const result = {
    ...successful[0],
    metrics: aggMetrics,
    replayCount: replayResults.length,
    successCount: successful.length,
    allReplays: replayResults,
  };

  if (failed.length > 0) {
    result.partialFailure = {
      failedCount: failed.length,
      failures: failed.map((f) => ({ replayIndex: f.replayIndex, reason: f.failure?.reason })),
    };
  }

  return result;
}

function avg(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// ============================================================================
// 6. 生成对照矩阵
// ============================================================================

function buildComparisonMatrix(reactResult, nativeResult) {
  if (reactResult.fixtureId !== nativeResult.fixtureId) {
    throw new Error(`fixture 不匹配：${reactResult.fixtureId} vs ${nativeResult.fixtureId}`);
  }
  return createComparisonMatrix(reactResult, nativeResult);
}

// ============================================================================
// 7. 生成 Go/No-Go 建议
// ============================================================================

function buildGoNoGo(comparisons, opts = {}) {
  return evaluateGoNoGo(comparisons, {
    replayStable: opts.replayStable ?? false,
    productionRouteRegistered: true, // 生产 route 已在 adapter-registry 中登记
    humanReviewPassed: false, // 需要人工复核
    releaseApproved: false, // 需要发布审批
  });
}

// ============================================================================
// 8. 报告生成
// ============================================================================

function generateJsonReport(reactResults, nativeResults, comparisons, goNoGo, preflightIssues, evalMeta) {
  return {
    timestamp: new Date().toISOString(),
    phase: "Phase 5: Native-only Eval 与协议收益评估",
    evaluationMode: evalMeta.mode,
    syntheticEvaluation: evalMeta.mode === "synthetic",
    realModelEvaluation: evalMeta.mode === "real",
    replays: evalMeta.replays,
    preflight: {
      issues: preflightIssues,
      passed: preflightIssues.length === 0,
    },
    fixtures: DEFAULT_EVAL_FIXTURES.map((f) => ({
      id: f.id,
      workspaceId: f.workspaceId,
      chapterNumber: f.chapterNumber,
      route: f.route,
      allowedToolsCount: f.allowedTools.length,
      budget: f.budget,
    })),
    hardGateMetrics: HARD_GATE_METRICS,
    reactResults: reactResults.map((r) => ({
      fixtureId: r.fixtureId,
      protocol: r.protocol,
      adapterVersion: r.adapterVersion,
      metrics: r.metrics,
      failure: r.failure,
      replayCount: r.replayCount,
      successCount: r.successCount,
      partialFailure: r.partialFailure,
      modelUsed: r.modelUsed,
      providerUsed: r.providerUsed,
      tokenUsage: r.tokenUsage,
      latencyMs: r.latencyMs,
    })),
    nativeResults: nativeResults.map((r) => ({
      fixtureId: r.fixtureId,
      protocol: r.protocol,
      adapterVersion: r.adapterVersion,
      metrics: r.metrics,
      failure: r.failure,
      replayCount: r.replayCount,
      successCount: r.successCount,
      partialFailure: r.partialFailure,
    })),
    comparisonMatrix: comparisons,
    goNoGo,
    risks: PROTOCOL_RISKS,
    pipelineDependencyGraph: REACT_PIPELINE_DEPENDENCY_GRAPH,
    nativeArmBlocked: evalMeta.nativeArmBlocked,
    blockedReason: evalMeta.nativeArmBlocked
      ? "当前 text-only endpoint 不支持 provider 原生 FC API；Native 臂真实评估阻塞"
      : null,
  };
}

function generateMarkdownReport(report) {
  const lines = [];
  lines.push("# Phase 5: Native-only Eval 与协议收益评估报告");
  lines.push("");
  lines.push(`**生成时间**: ${report.timestamp}`);
  lines.push(`**阶段**: ${report.phase}`);
  lines.push(`**评估模式**: ${report.evaluationMode === "real" ? "真实模型（Real）" : "合成数据（Synthetic）"}`);
  lines.push(`**Replay 次数**: ${report.replays}`);
  if (report.nativeArmBlocked) {
    lines.push(`**Native 臂状态**: ⛔ 阻塞（${report.blockedReason}）`);
  }
  lines.push("");

  // Preflight
  lines.push("## 1. 环境预检");
  lines.push("");
  if (report.preflight.passed) {
    lines.push("- ✅ 所有预检通过");
  } else {
    lines.push("- ❌ 预检失败：");
    for (const issue of report.preflight.issues) {
      lines.push(`  - ${issue}`);
    }
  }
  lines.push("");

  // Fixtures
  lines.push("## 2. 固定 Eval Fixture");
  lines.push("");
  lines.push("| Fixture ID | Workspace | 章节 | Route | 工具数 | maxTurns | maxToolCalls |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const f of report.fixtures) {
    lines.push(`| ${f.id} | ${f.workspaceId} | ch${f.chapterNumber} | ${f.route} | ${f.allowedToolsCount} | ${f.budget.maxTurns} | ${f.budget.maxToolCalls} |`);
  }
  lines.push("");

  // Hard Gate Metrics
  lines.push("## 3. 硬门指标（不得因成本或延迟下降而退化）");
  lines.push("");
  for (const metric of report.hardGateMetrics) {
    lines.push(`- ${metric}`);
  }
  lines.push("");

  // ReAct Results Detail
  lines.push("## 4. ReAct 臂运行结果");
  lines.push("");
  lines.push("| Fixture | 成功/总数 | Token(in/out) | Latency(ms) | Model | Parser Failure |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of report.reactResults) {
    const successRate = `${r.successCount ?? 1}/${r.replayCount ?? 1}`;
    const token = r.tokenUsage && typeof r.tokenUsage === "object"
      ? `${r.tokenUsage.in}/${r.tokenUsage.out}`
      : (r.metrics ? `${r.metrics.tokenUsage.input}/${r.metrics.tokenUsage.output}` : "N/A");
    const latency = r.latencyMs ?? r.metrics?.latencyMs ?? 0;
    lines.push(`| ${r.fixtureId} | ${successRate} | ${token} | ${Math.round(latency)} | ${r.modelUsed ?? "synthetic"} | ${r.metrics?.parserFailureRate ?? 0} |`);
  }
  lines.push("");

  // Comparison Matrix
  lines.push("## 5. ReAct vs Native 对照矩阵");
  lines.push("");
  if (report.nativeArmBlocked) {
    lines.push("> ⚠️ Native 臂真实评估阻塞，以下对照矩阵基于 Native 臂的空指标，不构成真实协议收益证据。");
    lines.push("");
  }
  for (const cmp of report.comparisonMatrix) {
    lines.push(`### Fixture: ${cmp.fixtureId}`);
    lines.push("");
    lines.push("#### 硬门退化项");
    if (cmp.hardGateRegressions.length === 0) {
      lines.push("- ✅ 无退化");
    } else {
      for (const r of cmp.hardGateRegressions) {
        lines.push(`- ❌ ${r}`);
      }
    }
    lines.push("");
    lines.push("#### 硬门改善项");
    if (cmp.hardGateImprovements.length === 0) {
      lines.push("- （无改善）");
    } else {
      for (const r of cmp.hardGateImprovements) {
        lines.push(`- ✅ ${r}`);
      }
    }
    lines.push("");
    lines.push("#### 软指标变化");
    lines.push("| 指标 | ReAct | Native | Delta |");
    lines.push("|---|---|---|---|");
    for (const s of cmp.softMetricChanges) {
      lines.push(`| ${s.metric} | ${s.reactValue} | ${s.nativeValue} | ${s.delta > 0 ? "+" : ""}${s.delta} |`);
    }
    lines.push("");
  }

  // Go/No-Go
  lines.push("## 6. Go/No-Go 建议");
  lines.push("");
  lines.push(`**建议**: ${report.goNoGo.go ? "✅ GO" : "⛔ NO-GO"}`);
  lines.push("");
  lines.push(`**推荐**: ${report.goNoGo.recommendation}`);
  lines.push("");
  lines.push("### 满足的条件");
  for (const c of report.goNoGo.satisfiedConditions) {
    lines.push(`- ✅ ${c}`);
  }
  lines.push("");
  lines.push("### 未满足的条件");
  for (const c of report.goNoGo.unsatisfiedConditions) {
    lines.push(`- ❌ ${c}`);
  }
  lines.push("");
  lines.push("### 证据摘要");
  lines.push("```");
  lines.push(report.goNoGo.evidenceSummary);
  lines.push("```");
  lines.push("");

  // Risks
  lines.push("## 7. 风险与控制措施");
  lines.push("");
  for (const r of report.risks) {
    lines.push(`### ${r.risk}`);
    lines.push(`- **控制**: ${r.control}`);
    lines.push("");
  }

  // Evaluation Mode Declaration
  lines.push("## 8. 评估模式声明");
  lines.push("");
  if (report.syntheticEvaluation) {
    lines.push("> ⚠️ **本次评估使用合成数据（Synthetic），不构成真实协议收益证据。**");
    lines.push("> ");
    lines.push("> 合成数据仅验证评估框架能正确计算指标和生成报告，不代表 ReAct 或 Native 协议在真实模型上的实际表现。");
    lines.push("> 真实评估需要 Gemini API 号池配额恢复后使用 `--real` 模式运行。");
  } else if (report.realModelEvaluation) {
    lines.push("> ✅ **本次评估使用真实模型（Gemini）。**");
    lines.push("> ");
    lines.push("> ReAct 臂通过真实 Gemini API 调用获取数据，token/latency 为真实值。");
    if (report.nativeArmBlocked) {
      lines.push("> Native 臂因 provider 原生 FC API 不可用而阻塞，不构成完整的 ReAct vs Native 真实 A/B 证据。");
    }
  }
  lines.push("");

  return lines.join("\n");
}

// ============================================================================
// 9. Synthetic 评估（保留原有逻辑作为 fallback）
// ============================================================================

function runSyntheticReActArm(fixture) {
  const syntheticTurns = [
    createToolCallTurn("检索前思考", [
      { id: "tc-1", name: "search_chapter_span", arguments: { query: "角色状态" } },
    ], { model: "gemini-3.1-pro-preview" }),
    createTextTurn("基于证据的正文内容", { model: "gemini-3.1-pro-preview" }),
  ];
  syntheticTurns[0].toolResults = [{
    toolCallId: "tc-1",
    toolName: "search_chapter_span",
    content: [{ type: "text", text: "检索结果" }],
    details: { sourceRef: "ch1#final.md:10-30", evidenceLevel: "exact_chapter_span", resultKind: "chapter_spans", returnedCount: 1, truncated: false },
    isError: false,
  }];
  return {
    fixtureId: fixture.id,
    arm: "react",
    protocol: "react-text",
    adapterVersion: "react-text-v1",
    turns: syntheticTurns,
    metrics: computeMetricsForFixture(syntheticTurns, fixture),
    timestamp: new Date().toISOString(),
  };
}

function runSyntheticNativeArm(fixture) {
  const syntheticTurns = [
    createToolCallTurn("检索前思考", [
      { id: "call_1", name: "search_chapter_span", arguments: { query: "角色状态" } },
    ], { protocol: "native-function-calling", adapterVersion: "native-fc-v1", model: "gemini-3.1-pro-preview" }),
    createTextTurn("基于证据的正文内容", { protocol: "native-function-calling", adapterVersion: "native-fc-v1", model: "gemini-3.1-pro-preview" }),
  ];
  syntheticTurns[0].toolResults = [{
    toolCallId: "call_1",
    toolName: "search_chapter_span",
    content: [{ type: "text", text: "检索结果" }],
    details: { sourceRef: "ch1#final.md:10-30", evidenceLevel: "exact_chapter_span", resultKind: "chapter_spans", returnedCount: 1, truncated: false },
    isError: false,
  }];
  return {
    fixtureId: fixture.id,
    arm: "native",
    protocol: "native-function-calling",
    adapterVersion: "native-fc-v1",
    turns: syntheticTurns,
    metrics: computeMetricsForFixture(syntheticTurns, fixture),
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================
// 10. 主入口
// ============================================================================

async function main() {
  console.log("=== Phase 5: Protocol A/B Eval Runner ===");
  console.log(`模式: ${REAL_MODE ? "真实模型（--real）" : "合成数据（synthetic）"}`);
  console.log(`Replay 次数: ${REPLAYS}`);
  console.log(`号池重试: 最多 ${MAX_RETRIES} 次，间隔 ${RETRY_WAIT_MS / 1000}s`);
  console.log("");

  // Preflight
  const preflightIssues = preflight();
  if (preflightIssues.length > 0) {
    console.log("⚠️  预检发现问题：");
    for (const issue of preflightIssues) {
      console.log(`  - ${issue}`);
    }
    console.log("");
  } else {
    console.log("✅ 预检通过");
    console.log("");
  }

  let reactResults = [];
  let nativeResults = [];
  let evalMeta = {
    mode: REAL_MODE ? "real" : "synthetic",
    replays: REPLAYS,
    nativeArmBlocked: false,
  };

  if (REAL_MODE) {
    // ==========================================================================
    // 真实模型模式
    // ==========================================================================
    console.log("ℹ️  启动真实模型模式（Gemini API 号池重试已启用）");
    console.log("");

    const isStub = process.env.V2_FORCE_STUB === "1";
    if (isStub) {
      console.log("⚠️  V2_FORCE_STUB=1：即使 --real 模式也使用 stub，降级为 synthetic");
      console.log("");
      evalMeta.mode = "synthetic";
      for (const fixture of DEFAULT_EVAL_FIXTURES) {
        reactResults.push(runSyntheticReActArm(fixture));
        nativeResults.push(runSyntheticNativeArm(fixture));
      }
    } else {
      // 创建带重试的真实模型调用函数
      let modelFnWrapper;
      try {
        modelFnWrapper = await createRetryModelFn();
        console.log("✅ 真实模型调用函数已创建（带号池重试）");
        console.log("");
      } catch (err) {
        console.log(`❌ 创建真实模型调用函数失败：${String(err?.message ?? err).slice(0, 200)}`);
        console.log("降级为 synthetic 模式");
        console.log("");
        evalMeta.mode = "synthetic";
        for (const fixture of DEFAULT_EVAL_FIXTURES) {
          reactResults.push(runSyntheticReActArm(fixture));
          nativeResults.push(runSyntheticNativeArm(fixture));
        }
      }

      if (modelFnWrapper) {
        // 运行 ReAct 臂（真实模型）
        console.log("=== 运行 ReAct 臂（真实 Gemini 模型）===");
        for (const fixture of DEFAULT_EVAL_FIXTURES) {
          console.log(`\n[ReAct] Fixture: ${fixture.id}`);
          const replayResults = [];
          for (let replayIdx = 0; replayIdx < REPLAYS; replayIdx++) {
            console.log(`  [ReAct] Replay ${replayIdx + 1}/${REPLAYS}…`);
            modelFnWrapper.clearUnhealthyProviders();
            modelFnWrapper.clearChapterTimeoutCounts();
            const result = await runRealReActArm(modelFnWrapper, fixture, replayIdx);
            replayResults.push(result);
            if (result.failure) {
              console.log(`    ❌ 失败: ${result.failure.reason}`);
            } else {
              console.log(`    ✅ 成功: model=${result.modelUsed}, latency=${result.latencyMs}ms, tokens=${typeof result.tokenUsage === "object" ? `${result.tokenUsage.in}/${result.tokenUsage.out}` : "unknown"}`);
            }
          }
          const aggregated = aggregateReplayResults(replayResults);
          reactResults.push(aggregated);
        }
        console.log("");

        // Native 臂：当前 text-only endpoint 不支持原生 FC API
        console.log("=== Native 臂状态 ===");
        console.log("⛔ 阻塞：当前 text-only endpoint 不支持 provider 原生 FC API");
        console.log("   Native 臂需要 provider 原生 function calling API 支持");
        console.log("   当前 ModelGenerateFn 只支持 text-only 调用");
        console.log("");
        evalMeta.nativeArmBlocked = true;

        for (const fixture of DEFAULT_EVAL_FIXTURES) {
          const nativeReplayResults = [];
          for (let replayIdx = 0; replayIdx < REPLAYS; replayIdx++) {
            nativeReplayResults.push(createNativeArmBlockedResult(fixture, replayIdx));
          }
          nativeResults.push(aggregateReplayResults(nativeReplayResults));
        }
      }
    }
  } else {
    // ==========================================================================
    // Synthetic 模式（默认）
    // ==========================================================================
    console.log("ℹ️  使用 synthetic 评估结果（框架演示，非真实模型评估）");
    console.log("   使用 --real 参数启用真实模型评估");
    console.log("");

    for (const fixture of DEFAULT_EVAL_FIXTURES) {
      // synthetic 模式下也模拟多次 replay（使用相同数据）
      const reactReplays = [];
      const nativeReplays = [];
      for (let i = 0; i < REPLAYS; i++) {
        reactReplays.push({ ...runSyntheticReActArm(fixture), replayIndex: i });
        nativeReplays.push({ ...runSyntheticNativeArm(fixture), replayIndex: i });
      }
      reactResults.push(aggregateReplayResults(reactReplays));
      nativeResults.push(aggregateReplayResults(nativeReplays));
    }
  }

  // 生成对照矩阵
  const comparisons = [];
  for (let i = 0; i < reactResults.length; i++) {
    comparisons.push(buildComparisonMatrix(reactResults[i], nativeResults[i]));
  }

  // 判断 replay 稳定性（真实模式下：所有 fixture 的 ReAct 臂成功率 ≥ 85%）
  let replayStable = false;
  if (evalMeta.mode === "real" && !evalMeta.nativeArmBlocked) {
    const allReactSuccess = reactResults.every((r) => (r.successCount ?? 0) / (r.replayCount ?? 1) >= 0.85);
    const allNativeSuccess = nativeResults.every((r) => (r.successCount ?? 0) / (r.replayCount ?? 1) >= 0.85);
    replayStable = allReactSuccess && allNativeSuccess;
  } else if (evalMeta.mode === "real" && evalMeta.nativeArmBlocked) {
    // Native 臂阻塞时，只看 ReAct 臂稳定性
    replayStable = reactResults.every((r) => (r.successCount ?? 0) / (r.replayCount ?? 1) >= 0.85);
  }

  // 生成 Go/No-Go 建议
  const goNoGo = buildGoNoGo(comparisons, { replayStable });

  // 生成报告
  const report = generateJsonReport(reactResults, nativeResults, comparisons, goNoGo, preflightIssues, evalMeta);

  // 写入报告
  mkdirSync(REPORTS_DIR, { recursive: true });
  const jsonPath = join(REPORTS_DIR, "protocol-ab-eval-report.json");
  const mdPath = join(REPORTS_DIR, "protocol-ab-eval-summary.md");

  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  writeFileSync(mdPath, generateMarkdownReport(report), "utf-8");

  console.log(`✅ JSON 报告: ${jsonPath}`);
  console.log(`✅ Markdown 报告: ${mdPath}`);
  console.log("");
  console.log("=== Go/No-Go 摘要 ===");
  console.log(`评估模式: ${evalMeta.mode}`);
  console.log(`Native 臂阻塞: ${evalMeta.nativeArmBlocked ? "是" : "否"}`);
  console.log(`Replay 稳定: ${replayStable ? "是" : "否"}`);
  console.log(`建议: ${goNoGo.go ? "GO" : "NO-GO"}`);
  console.log(`推荐: ${goNoGo.recommendation}`);
  console.log(`满足条件: ${goNoGo.satisfiedConditions.length}`);
  console.log(`未满足条件: ${goNoGo.unsatisfiedConditions.length}`);
  console.log("");

  if (!goNoGo.go) {
    console.log("⚠️  未满足条件：");
    for (const c of goNoGo.unsatisfiedConditions) {
      console.log(`  - ${c}`);
    }
  }

  // 真实模式下输出 ReAct 臂摘要
  if (evalMeta.mode === "real") {
    console.log("");
    console.log("=== ReAct 臂真实评估摘要 ===");
    for (const r of reactResults) {
      const successRate = `${r.successCount ?? 0}/${r.replayCount ?? 0}`;
      console.log(`  ${r.fixtureId}: 成功率 ${successRate}, token=${typeof r.tokenUsage === "object" ? `${r.tokenUsage.in}/${r.tokenUsage.out}` : "N/A"}, latency=${Math.round(r.latencyMs ?? 0)}ms`);
    }
  }
}

main().catch((err) => {
  console.error("❌ 评估脚本执行失败：", err);
  process.exit(1);
});
