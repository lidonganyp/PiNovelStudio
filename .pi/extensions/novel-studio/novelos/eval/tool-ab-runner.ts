/**
 * NovelOS Phase 4 A/B — 工具接口对比 runner（eval-only）
 *
 * 对比 A 组（specialized-9-tools）与 B 组（typed facade query_narrative）。
 * 复用 tool-interface-baseline 的 runScenarioWithTools 与 BASELINE_SCENARIOS，
 * 保证两组在同一场景、同一 workspace、同一指标口径下比较。
 *
 * 设计：
 * - A 组 resolver：`(ss) => createNarrativeTools({ searchService: ss })`（9 专用工具）
 * - B 组 resolver：`(ss) => [createTypedFacadeTool({ searchService: ss })]`（1 facade）
 * - B 组场景调用：把 BASELINE_SCENARIOS 的 `{tool, args}` 映射为
 *   `{tool: "query_narrative", args: { intent, ...args }}`（经 TOOL_NAME_TO_INTENT）
 *   —— 两组都假设"模型选对工具/意图"（oracle selection），比较的是接口形态开销与证据保持。
 * - 门禁（不降级底线）：mustVerify 覆盖率 B>=A；sourceRef/evidenceLevel 完整率 B>=A；
 *   B 无失败行为退化；B 至少一项负担指标更优（工具面 9→1）。
 *
 * eval-only：只注册在 tsconfig.eval.json，不进入生产构建。
 */

import { createNarrativeTools } from "../tools/narrative-tools.js";
import { createTypedFacadeTool, TOOL_NAME_TO_INTENT, QUERY_NARRATIVE_NAME } from "./typed-facade-tool.js";
import {
  runScenarioWithTools,
  BASELINE_SCENARIOS,
  type BaselineScenario,
  type BaselineScenarioMetrics,
  type BaselineToolCall,
} from "./tool-interface-baseline.js";
import { VALID_EVIDENCE_LEVELS } from "./uncertainty-recall-metrics.js";

// ============================================================================
// 无效 sourceRef 分类（区分"预期无匹配"与"真实失败"）
// ============================================================================

/**
 * 无效 sourceRef 的分类标签。
 *
 * no_match / profile_only / empty 是**预期分类**（检索无匹配、风格档案降级、空结果），
 * 不是普通失败率。它们代表"本次调用未产生有效证据引用"，但属于工具在特定查询下的
 * 正常输出（如 low-risk 场景查询不存在的实体），不应被误判成失败。
 */
export type InvalidSourceRefCategory =
  | "no_match"       // ranked:no-match / no-match / :no-match
  | "profile_only"   // voice:profile_only:degraded / voice:*:degraded
  | "empty"          // character:empty / empty / :empty
  | "other";         // 其他无效形态（如空串）

/** 把无效 sourceRef 归类（符合 INVALID_REF_PATTERNS 语义） */
export function classifyInvalidSourceRef(ref: string | undefined): InvalidSourceRefCategory {
  if (typeof ref !== "string" || ref.length === 0) return "empty";
  if (/no-match/.test(ref) || /^no-match$/.test(ref)) return "no_match";
  if (/profile_only/.test(ref) || /:degraded$/.test(ref)) return "profile_only";
  if (/empty/.test(ref)) return "empty";
  return "other";
}

// ============================================================================
// 类型
// ============================================================================

/** 首次有效证据（evidenceLevel ∈ confirmed/confirmed_state/exact_chapter_span）节点 */
export interface FirstEvidencePoint {
  /** 0-based 工具调用序号 */
  callIndex: number;
  /** 首次有效证据所在工具名 */
  toolName: string;
  /** 到该调用（含）的累计耗时 ms */
  cumulativeLatencyMs: number;
}

/** 单场景 A/B 对比 */
export interface ToolAbScenarioMetrics {
  scenarioId: string;
  category: string;
  A: BaselineScenarioMetrics;
  B: BaselineScenarioMetrics;
  firstValidEvidence: {
    A: FirstEvidencePoint | null;
    B: FirstEvidencePoint | null;
  };
  /** 逐场景失败行为门禁：B 组失败行为（空结果/截断/错误/超时）不劣于 A 组（设计文档 §5.6/§7） */
  scenarioGate: ToolAbScenarioGate;
}

/** 逐场景失败行为门禁：B 组失败行为不劣于 A 组（设计文档 §5.6） */
export interface ToolAbScenarioGate {
  scenarioId: string;
  emptyResultsNotWorsened: boolean;
  truncatedNotWorsened: boolean;
  errorsNotWorsened: boolean;
  timeoutsNotWorsened: boolean;
  allFailingNotWorsened: boolean;
  details: Record<string, string>;
}

/** 单组聚合指标 */
export interface ToolAbArmAggregation {
  toolSurface: number;
  totalCalls: number;
  totalDuplicateQueries: number;
  totalResultChars: number;
  totalEstimateTokens: number;
  totalEmptyResults: number;
  /** 结果被系统 limit 截断的调用数（设计文档 §5.6） */
  totalTruncatedResults: number;
  totalTimeouts: number;
  totalErrors: number;
  sourceRefsValid: number;
  sourceRefsInvalid: number;
  /** 无效 sourceRef 按分类计数（no_match / profile_only 是预期分类，非失败） */
  invalidSourceRefByCategory: Record<InvalidSourceRefCategory, number>;
  /** 有效证据引用率 = 有效 sourceRef / 总调用（含预期的 no_match/profile_only，非失败率） */
  sourceRefCompleteness: number;
  /** 场景平均 mustVerify 覆盖率 */
  avgCoverageRatio: number;
}

/** 门禁判定 */
export interface ToolAbGate {
  mustVerifyCoverageNotDegraded: boolean;
  sourceRefCompletenessNotDegraded: boolean;
  burdenReduced: boolean;
  failureNotDegraded: boolean;
  /** 空结果（emptyResults）不恶化（设计文档 §5.6） */
  emptyResultsNotWorsened: boolean;
  /** 结果截断（truncatedResults）不恶化（设计文档 §5.6） */
  truncatedNotWorsened: boolean;
  /** 逐场景失败行为门禁全部通过（每场景空结果/截断/错误/超时不恶化） */
  scenarioGatesPassed: boolean;
  allPassed: boolean;
  details: Record<string, string>;
}

/** 完整 A/B 对比报告 */
export interface ToolAbComparison {
  schema: string;
  timestamp: string;
  phase: string;
  scenarios: ToolAbScenarioMetrics[];
  aggregation: { A: ToolAbArmAggregation; B: ToolAbArmAggregation };
  gate: ToolAbGate;
}

// ============================================================================
// 辅助：B 组场景调用映射
// ============================================================================

/**
 * 把 BASELINE_SCENARIOS 的专用工具调用映射为 facade 调用。
 * 每个 call：`{tool: X, args, mustVerify}` → `{tool: "query_narrative", args: {intent, ...args}, mustVerify}`。
 * 意图由 TOOL_NAME_TO_INTENT 决定；args 原样透传给 facade（facade 会把 intent 之外的参数交给底层工具）。
 */
export function toFacadeToolCall(call: BaselineToolCall): BaselineToolCall {
  const intent = TOOL_NAME_TO_INTENT[call.tool];
  if (!intent) {
    throw new Error(`toFacadeToolCall: 工具 "${call.tool}" 没有对应 intent`);
  }
  return {
    tool: QUERY_NARRATIVE_NAME,
    args: { intent, ...call.args },
    ...(call.mustVerify ? { mustVerify: call.mustVerify } : {}),
  };
}

/** 把整个场景转换为 B 组 facade 场景 */
export function toFacadeScenario(scenario: BaselineScenario): BaselineScenario {
  return {
    ...scenario,
    id: `${scenario.id}::facade`,
    calls: scenario.calls.map(toFacadeToolCall),
  };
}

// ============================================================================
// 首次有效证据
// ============================================================================

/** 从场景 metrics 的调用序列计算首次有效证据节点（无则 null） */
function computeFirstValidEvidence(m: BaselineScenarioMetrics): FirstEvidencePoint | null {
  let cumulative = 0;
  for (let i = 0; i < m.calls.length; i++) {
    const c = m.calls[i];
    cumulative += c.latencyMs;
    if (c.evidenceLevel && VALID_EVIDENCE_LEVELS.has(c.evidenceLevel)) {
      return { callIndex: i, toolName: c.tool, cumulativeLatencyMs: cumulative };
    }
  }
  return null;
}

// ============================================================================
// 聚合
// ============================================================================

export function aggregateArm(scenarios: BaselineScenarioMetrics[]): ToolAbArmAggregation {
  const uniqueTools = new Set<string>();
  let totalCalls = 0;
  let totalDuplicateQueries = 0;
  let totalResultChars = 0;
  let totalEstimateTokens = 0;
  let totalEmptyResults = 0;
  let totalTruncatedResults = 0;
  let totalTimeouts = 0;
  let totalErrors = 0;
  let sourceRefsValid = 0;
  let sourceRefsInvalid = 0;
  const invalidByCategory: Record<InvalidSourceRefCategory, number> = {
    no_match: 0,
    profile_only: 0,
    empty: 0,
    other: 0,
  };
  let coverageSum = 0;

  for (const s of scenarios) {
    for (const t of s.visibleTools) uniqueTools.add(t);
    totalCalls += s.actualCalls;
    totalDuplicateQueries += s.duplicateQueries;
    totalResultChars += s.totalResultChars;
    totalEstimateTokens += s.calls.reduce((sum, c) => sum + (c.estimateTokens ?? 0), 0);
    totalEmptyResults += s.emptyResults;
    totalTruncatedResults += s.truncatedResults;
    totalTimeouts += s.timeouts;
    totalErrors += s.errors;
    sourceRefsValid += s.sourceRefsValid;
    sourceRefsInvalid += s.sourceRefsInvalid;
    // 无效 sourceRef 按分类统计（区分预期无匹配与真实失败）
    for (const c of s.calls) {
      if (!c.sourceRef) continue;
      if (c.sourceRefValid) continue;
      invalidByCategory[classifyInvalidSourceRef(c.sourceRef)] += 1;
    }
    coverageSum += s.mustVerify.coverageRatio;
  }

  // 有效证据引用率 = 有效 sourceRef / 总调用；
  // 分母含预期的 no_match / profile_only / empty（这些是"未产生有效引用"的预期分类，非失败率）
  const sourceRefCompleteness = totalCalls > 0 ? sourceRefsValid / totalCalls : 1;

  return {
    toolSurface: uniqueTools.size,
    totalCalls,
    totalDuplicateQueries,
    totalResultChars,
    totalEstimateTokens,
    totalEmptyResults,
    totalTruncatedResults,
    totalTimeouts,
    totalErrors,
    sourceRefsValid,
    sourceRefsInvalid,
    invalidSourceRefByCategory: invalidByCategory,
    sourceRefCompleteness,
    avgCoverageRatio: scenarios.length > 0 ? coverageSum / scenarios.length : 0,
  };
}

// ============================================================================
// 门禁
// ============================================================================

function evaluateGate(
  A: ToolAbArmAggregation,
  B: ToolAbArmAggregation,
  scenarioGates: ToolAbScenarioGate[],
): ToolAbGate {
  const mustVerifyCoverageNotDegraded = B.avgCoverageRatio >= A.avgCoverageRatio - 1e-9;
  const sourceRefCompletenessNotDegraded = B.sourceRefCompleteness >= A.sourceRefCompleteness - 1e-9;
  // 负担更优：工具面至少显著减少（9→1）；其余负担指标记录但不强制要求（facade 纯透传，结果 token 与 A 相同）
  const burdenReduced = B.toolSurface < A.toolSurface;
  // 失败行为逐项不恶化（设计文档 §5.6/§7）：错误/超时/空结果/截断
  const errorsNotWorsened = B.totalErrors <= A.totalErrors;
  const timeoutsNotWorsened = B.totalTimeouts <= A.totalTimeouts;
  const emptyResultsNotWorsened = B.totalEmptyResults <= A.totalEmptyResults;
  const truncatedNotWorsened = B.totalTruncatedResults <= A.totalTruncatedResults;
  const failureNotDegraded =
    errorsNotWorsened && timeoutsNotWorsened && emptyResultsNotWorsened && truncatedNotWorsened;
  // 逐场景失败行为门禁：每个场景（A/B 直接执行面）失败行为均不恶化
  const scenarioGatesPassed = scenarioGates.every((sg) => sg.allFailingNotWorsened);

  return {
    mustVerifyCoverageNotDegraded,
    sourceRefCompletenessNotDegraded,
    burdenReduced,
    failureNotDegraded,
    emptyResultsNotWorsened,
    truncatedNotWorsened,
    scenarioGatesPassed,
    allPassed:
      mustVerifyCoverageNotDegraded &&
      sourceRefCompletenessNotDegraded &&
      burdenReduced &&
      failureNotDegraded &&
      scenarioGatesPassed,
    details: {
      mustVerifyCoverage: `B=${B.avgCoverageRatio.toFixed(3)} >= A=${A.avgCoverageRatio.toFixed(3)}`,
      sourceRefCompleteness: `B=${B.sourceRefCompleteness.toFixed(3)} >= A=${A.sourceRefCompleteness.toFixed(3)}`,
      burdenReduced: `B.toolSurface=${B.toolSurface} < A.toolSurface=${A.toolSurface}`,
      failureNotDegraded: `errors B=${B.totalErrors}<=A=${A.totalErrors}, timeouts B=${B.totalTimeouts}<=A=${A.totalTimeouts}, empty B=${B.totalEmptyResults}<=A=${A.totalEmptyResults}, truncated B=${B.totalTruncatedResults}<=A=${A.totalTruncatedResults}`,
      emptyResultsNotWorsened: `B=${B.totalEmptyResults} <= A=${A.totalEmptyResults}`,
      truncatedNotWorsened: `B=${B.totalTruncatedResults} <= A=${A.totalTruncatedResults}`,
      scenarioGates: scenarioGates
        .map((sg) => `${sg.scenarioId}:${sg.allFailingNotWorsened ? "PASS" : "FAIL"}`)
        .join("，"),
    },
  };
}

// ============================================================================
// 主入口
// ============================================================================

/** 逐场景失败行为门禁：B 组失败行为（空结果/截断/错误/超时）不劣于 A 组（设计文档 §5.6） */
function evaluateToolAbScenarioGate(
  scenarioId: string,
  A: BaselineScenarioMetrics,
  B: BaselineScenarioMetrics,
): ToolAbScenarioGate {
  const emptyResultsNotWorsened = B.emptyResults <= A.emptyResults;
  const truncatedNotWorsened = B.truncatedResults <= A.truncatedResults;
  const errorsNotWorsened = B.errors <= A.errors;
  const timeoutsNotWorsened = B.timeouts <= A.timeouts;
  const allFailingNotWorsened =
    emptyResultsNotWorsened && truncatedNotWorsened && errorsNotWorsened && timeoutsNotWorsened;

  return {
    scenarioId,
    emptyResultsNotWorsened,
    truncatedNotWorsened,
    errorsNotWorsened,
    timeoutsNotWorsened,
    allFailingNotWorsened,
    details: {
      emptyResults: `B=${B.emptyResults} <= A=${A.emptyResults}`,
      truncated: `B=${B.truncatedResults} <= A=${A.truncatedResults}`,
      errors: `B=${B.errors} <= A=${A.errors}`,
      timeouts: `B=${B.timeouts} <= A=${A.timeouts}`,
    },
  };
}

/**
 * 运行 A/B 确定性 replay（stub/直接驱动工具，零模型调用）。
 *
 * @param options.scenarios 参与对比的场景（默认 BASELINE_SCENARIOS）
 * @param options.timestamp 报告时间戳（默认 now）
 */
export async function runToolAbReplay(
  options: { scenarios?: BaselineScenario[]; timestamp?: string } = {},
): Promise<ToolAbComparison> {
  const scenarios = options.scenarios ?? BASELINE_SCENARIOS;

  const perScenario: ToolAbScenarioMetrics[] = [];
  for (const scenario of scenarios) {
    // A/B 并行执行（各自独立 workspace，互不干扰）
    const [metricsA, scenarioB] = await Promise.all([
      runScenarioWithTools(scenario, (searchService) => createNarrativeTools({ searchService })),
      runScenarioWithTools(toFacadeScenario(scenario), (searchService) => [
        createTypedFacadeTool({ searchService }),
      ]),
    ]);
    perScenario.push({
      scenarioId: scenario.id,
      category: scenario.category,
      A: metricsA,
      B: scenarioB,
      firstValidEvidence: {
        A: computeFirstValidEvidence(metricsA),
        B: computeFirstValidEvidence(scenarioB),
      },
      scenarioGate: evaluateToolAbScenarioGate(scenario.id, metricsA, scenarioB),
    });
  }

  const aggregation = {
    A: aggregateArm(perScenario.map((s) => s.A)),
    B: aggregateArm(perScenario.map((s) => s.B)),
  };
  const gate = evaluateGate(aggregation.A, aggregation.B, perScenario.map((s) => s.scenarioGate));

  return {
    schema: "tool-ab-comparison/v1",
    timestamp: options.timestamp ?? new Date().toISOString(),
    phase: "phase4-tool-ab",
    scenarios: perScenario,
    aggregation,
    gate,
  };
}

// ============================================================================
// 报告格式化
// ============================================================================

export function formatToolAbJson(comparison: ToolAbComparison): string {
  return JSON.stringify(comparison, null, 2);
}

export function formatToolAbMarkdown(comparison: ToolAbComparison): string {
  const lines: string[] = [];
  lines.push("# NovelOS Phase 4 工具接口 A/B 对比报告（specialized-9-tools vs typed facade）");
  lines.push("");
  lines.push(`**schema**：${comparison.schema}`);
  lines.push(`**时间**：${comparison.timestamp}`);
  lines.push(`**阶段**：${comparison.phase}`);
  lines.push("");
  lines.push("## 门禁结论");
  lines.push("");
  lines.push("| 门禁 | 结论 | 详情 |");
  lines.push("|------|------|------|");
  lines.push(`| mustVerify 覆盖率不降级 | ${comparison.gate.mustVerifyCoverageNotDegraded ? "✓" : "✗"} | ${comparison.gate.details.mustVerifyCoverage} |`);
  lines.push(`| 有效证据引用率不降级 | ${comparison.gate.sourceRefCompletenessNotDegraded ? "✓" : "✗"} | ${comparison.gate.details.sourceRefCompleteness} |`);
  lines.push(`| 负担更优（工具面减少） | ${comparison.gate.burdenReduced ? "✓" : "✗"} | ${comparison.gate.details.burdenReduced} |`);
  lines.push(`| 失败行为不退化 | ${comparison.gate.failureNotDegraded ? "✓" : "✗"} | ${comparison.gate.details.failureNotDegraded} |`);
  lines.push(`| 空结果不恶化 | ${comparison.gate.emptyResultsNotWorsened ? "✓" : "✗"} | B=${comparison.gate.details.emptyResultsNotWorsened} |`);
  lines.push(`| 结果截断不恶化 | ${comparison.gate.truncatedNotWorsened ? "✓" : "✗"} | B=${comparison.gate.details.truncatedNotWorsened} |`);
  lines.push(`| 逐场景失败门禁全通过 | ${comparison.gate.scenarioGatesPassed ? "✓" : "✗"} | ${comparison.gate.details.scenarioGates} |`);
  lines.push("");
  lines.push(`**全部通过**：${comparison.gate.allPassed ? "是" : "否"}`);
  lines.push("");
  lines.push("## 逐场景失败行为门禁");
  lines.push("");
  lines.push("| 场景 | empty | truncated | errors | timeouts | 通过 |");
  lines.push("|------|-------|-----------|--------|----------|------|");
  for (const s of comparison.scenarios) {
    const g = s.scenarioGate;
    lines.push(`| ${g.scenarioId} | ${g.emptyResultsNotWorsened ? "✓" : "✗"} | ${g.truncatedNotWorsened ? "✓" : "✗"} | ${g.errorsNotWorsened ? "✓" : "✗"} | ${g.timeoutsNotWorsened ? "✓" : "✗"} | ${g.allFailingNotWorsened ? "✓" : "✗"} |`);
  }
  lines.push("");
  lines.push("## 聚合指标");
  lines.push("");
  lines.push("| 指标 | A 组（9 专用工具） | B 组（typed facade） |");
  lines.push("|------|------|------|");
  const agg = comparison.aggregation;
  lines.push(`| 可见工具数 | ${agg.A.toolSurface} | ${agg.B.toolSurface} |`);
  lines.push(`| 总调用 | ${agg.A.totalCalls} | ${agg.B.totalCalls} |`);
  lines.push(`| 重复查询 | ${agg.A.totalDuplicateQueries} | ${agg.B.totalDuplicateQueries} |`);
  lines.push(`| 总返回字符 | ${agg.A.totalResultChars} | ${agg.B.totalResultChars} |`);
  lines.push(`| 估算 token | ${agg.A.totalEstimateTokens} | ${agg.B.totalEstimateTokens} |`);
  lines.push(`| 空结果 | ${agg.A.totalEmptyResults} | ${agg.B.totalEmptyResults} |`);
  lines.push(`| 结果截断 | ${agg.A.totalTruncatedResults} | ${agg.B.totalTruncatedResults} |`);
  lines.push(`| 超时 | ${agg.A.totalTimeouts} | ${agg.B.totalTimeouts} |`);
  lines.push(`| 失败 | ${agg.A.totalErrors} | ${agg.B.totalErrors} |`);
  lines.push(`| 有效 sourceRef | ${agg.A.sourceRefsValid} | ${agg.B.sourceRefsValid} |`);
  lines.push(`| 无效 sourceRef | ${agg.A.sourceRefsInvalid} | ${agg.B.sourceRefsInvalid} |`);
  lines.push(`| 有效证据引用率 | ${agg.A.sourceRefCompleteness.toFixed(3)} | ${agg.B.sourceRefCompleteness.toFixed(3)} |`);
  lines.push(`| 平均 mustVerify 覆盖率 | ${agg.A.avgCoverageRatio.toFixed(3)} | ${agg.B.avgCoverageRatio.toFixed(3)} |`);
  lines.push("");
  lines.push("### 无效 sourceRef 分类明细（预期分类，非失败率）");
  lines.push("");
  lines.push("| 分类 | A 组 | B 组 | 说明 |");
  lines.push("|------|------|------|------|");
  lines.push(`| no_match | ${agg.A.invalidSourceRefByCategory.no_match} | ${agg.B.invalidSourceRefByCategory.no_match} | 检索无匹配（如 low-risk 查询不存在实体），预期输出 |`);
  lines.push(`| profile_only | ${agg.A.invalidSourceRefByCategory.profile_only} | ${agg.B.invalidSourceRefByCategory.profile_only} | 风格档案降级引用，非正文事实 |`);
  lines.push(`| empty | ${agg.A.invalidSourceRefByCategory.empty} | ${agg.B.invalidSourceRefByCategory.empty} | 空结果/空引用 |`);
  lines.push(`| other | ${agg.A.invalidSourceRefByCategory.other} | ${agg.B.invalidSourceRefByCategory.other} | 其他无效形态 |`);
  lines.push("");
  lines.push("> 有效证据引用率 = 有效 sourceRef / 总调用。分母包含上述预期的 no_match / profile_only / empty 分类，");
  lines.push("> 它们代表\"本次调用未产生有效事实引用\"，是工具在特定查询下的正常输出，**不是普通失败率**。");
  lines.push("");
  lines.push("## 各场景详情");
  lines.push("");
  for (const s of comparison.scenarios) {
    lines.push(`### ${s.scenarioId}（${s.category}）`);
    lines.push("");
    lines.push(`- 首次有效证据：A=${s.firstValidEvidence.A ? `调用#${s.firstValidEvidence.A.callIndex}(${s.firstValidEvidence.A.toolName}, 累计${s.firstValidEvidence.A.cumulativeLatencyMs}ms)` : "无"}；B=${s.firstValidEvidence.B ? `调用#${s.firstValidEvidence.B.callIndex}(${s.firstValidEvidence.B.toolName}, 累计${s.firstValidEvidence.B.cumulativeLatencyMs}ms)` : "无"}`);
    lines.push(`- mustVerify 覆盖率：A=${s.A.mustVerify.coverageRatio.toFixed(3)}，B=${s.B.mustVerify.coverageRatio.toFixed(3)}`);
    lines.push(`- sourceRef：A 有效=${s.A.sourceRefsValid}/无效=${s.A.sourceRefsInvalid}；B 有效=${s.B.sourceRefsValid}/无效=${s.B.sourceRefsInvalid}`);
    lines.push(`- 返回字符：A=${s.A.totalResultChars}，B=${s.B.totalResultChars}`);
    lines.push("");
    lines.push("| 对比项 | A 组 | B 组 |");
    lines.push("|--------|------|------|");
    lines.push(`| 可见工具 | ${s.A.visibleTools.join(", ")} | ${s.B.visibleTools.join(", ")} |`);
    lines.push(`| 实际调用 | ${s.A.actualCalls} | ${s.B.actualCalls} |`);
    lines.push(`| 重复查询 | ${s.A.duplicateQueries} | ${s.B.duplicateQueries} |`);
    lines.push(`| 空结果 | ${s.A.emptyResults} | ${s.B.emptyResults} |`);
    lines.push(`| 结果截断 | ${s.A.truncatedResults} | ${s.B.truncatedResults} |`);
    lines.push(`| 失败 | ${s.A.errors} | ${s.B.errors} |`);
    lines.push("");
  }
  lines.push("## 说明");
  lines.push("");
  lines.push("- 本报告为**工具执行面**确定性对比（直接驱动工具 execute），非真实模型 ReAct 轨迹。");
  lines.push("- A/B 两组都采用 oracle 工具/意图选择（场景调用直接命名），比较的是接口形态开销与证据保持。");
  lines.push("- B 组 facade 为**纯透传**：检索/截断/nextQueryHint 全部由底层工具完成，故结果字符与 evidence 与 A 组一致。");
  lines.push("- B 组仅当证据覆盖不下降且不劣化失败行为时，才进入生产迁移讨论（Phase 4.3 门）。");
  lines.push("");
  return lines.join("\n");
}

// ============================================================================
// trajectory 副本（持久化 trace 证据）
// ============================================================================

/**
 * 把 A/B 确定性 replay 的每场景工具调用指标序列化为 trajectory 条目
 * （tool_visibility + tool_call_metrics），满足"无真实模型也必须有持久化 trace 证据"。
 *
 * @param comparison runToolAbReplay 的结果
 * @returns 每场景每组的 trajectory 条目数组，键为 `${scenarioId}:${arm}`
 */
export function buildToolAbTrajectory(comparison: ToolAbComparison): Record<
  string,
  Array<{ type: string; timestamp: number; data: unknown }>
> {
  const out: Record<string, Array<{ type: string; timestamp: number; data: unknown }>> = {};
  const base = Date.now();
  for (const s of comparison.scenarios) {
    for (const arm of ["A", "B"] as const) {
      const key = `${s.scenarioId}:${arm}`;
      const entries: Array<{ type: string; timestamp: number; data: unknown }> = [];
      const m = arm === "A" ? s.A : s.B;
      // tool_visibility 快照
      entries.push({
        type: "tool_visibility",
        timestamp: base,
        data: {
          systemAllowedTools: m.visibleTools,
          visibleTools: m.visibleTools,
        },
      });
      // 按调用顺序写 tool_call_metrics
      m.calls.forEach((c, idx) => {
        entries.push({
          type: "tool_call_metrics",
          timestamp: base + idx,
          data: {
            toolName: c.tool,
            toolCallId: `${s.scenarioId}-${arm}-${idx}`,
            args: c.args,
            latencyMs: c.latencyMs,
            resultChars: c.resultChars,
            estimateTokens: c.estimateTokens,
            evidenceLevel: c.evidenceLevel ?? undefined,
            sourceRefs: c.sourceRef ? [c.sourceRef] : [],
            resultKind: c.resultKind ?? undefined,
            returnedCount: c.returnedCount ?? undefined,
            truncated: c.truncated ?? undefined,
            nextQueryHint: c.nextQueryHint ?? undefined,
            empty: c.empty,
            timeout: c.timeout,
            isError: c.isError,
            duplicateQuery: c.duplicateQuery,
          },
        });
      });
      out[key] = entries;
    }
  }
  return out;
}

/** 把 trajectory 条目写入 JSONL 副本 */
export function formatTrajectoryJsonl(
  entries: Array<{ type: string; timestamp: number; data: unknown }>,
): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}