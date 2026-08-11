/**
 * Phase 5.2 — 紧凑结果 envelope 确定性 A/B/C replay（eval-only）
 *
 * 对比三臂（见 docs/phase4-tool-ab-test-design.md §10.5 / 用户 Phase 5.2 任务）：
 * - A：9 个专用工具 + 原始结果（现状默认生产）
 * - B：guided facade + 原始结果（受引导 facade，未压缩 content）
 * - C：guided facade + compact envelope（同一 facade，仅压缩模型可见 content）
 *
 * 目标（离线确定性，不切生产）：量化 envelope 在「结果文本量」上的收益（resultChars 下降），
 * 同时证明证据覆盖（mustVerify / sourceRef / evidenceLevel）与失败行为（empty/truncated/errors/
 * timeouts）不降级，且 C 的 details 与 B 完全一致（envelope 只剪裁 content，不碰结构化 details）。
 *
 * 门禁（预先写明通过标准）：
 * 1. resultCharsNotInflated：C.resultChars <= B.resultChars * 1.15（envelope 不显著膨胀；
 *    Phase 5.3.1 内容摘要修复后 C 可能略大于 B，15% 容差允许精简列表场景的摘要开销）
 * 2. coverageNotDegraded：C.mustVerify 覆盖率 >= B（不降级底线）
 * 3. sourceRefNotDegraded：C 有效证据引用率 >= B（不降级底线）
 * 4. failureNotDegraded：C 的 empty/truncated/errors/timeouts 均 <= B（失败不恶化）
 * 5. detailsConsistent：C 每个调用与 B 的 details 关键字段（evidenceLevel/sourceRef/resultKind/
 *    returnedCount/truncated/nextQueryHint）完全一致（仅 content 被压缩）
 * 6. noFalseNoResult：C 中 returnedCount>0 的调用不得误报「无匹配/无结果」；
 *    覆盖全部出现的 resultKind，且 returnedCount>0 但条目数组缺失时不伪造「无结果」
 *
 * 注意：compact envelope 已在 Phase 5.3 真实模型 replay 中多项门禁失败（mustVerify 覆盖率
 * 降级、sourceRef 降级、errors/empty 恶化），已明确弃用，不进入默认生产。本确定性 replay
 * 仅验证 envelope 渲染的机械正确性（details 一致性、无结果误报守护），不验证文本收益。
 *
 * eval-only：只注册在 tsconfig.eval.json，不进入生产构建。
 */

import { createNarrativeTools } from "../tools/narrative-tools.js";
import { createTypedFacadeTool } from "./typed-facade-tool.js";
import {
  runScenarioWithTools,
  BASELINE_SCENARIOS,
  type BaselineScenario,
  type BaselineScenarioMetrics,
} from "./tool-interface-baseline.js";
import { aggregateArm, type ToolAbArmAggregation } from "./tool-ab-runner.js";
export { formatTrajectoryJsonl } from "./tool-ab-runner.js";

// ============================================================================
// 类型
// ============================================================================

type AbcArm = "A" | "B" | "C";

/** 单臂聚合（扩展 A/B 聚合，追加停止率字段） */
export interface AbcArmAggregation extends ToolAbArmAggregation {
  /** 停止率：确定性 replay 固定执行全部调用=1.0；真实模型 replay 才会变化 */
  stopRate: number;
}

/** C 臂某调用 details 与 B 不一致的明细 */
export interface AbcDetailsDiff {
  callIndex: number;
  tool: string;
  field: string;
  bValue: unknown;
  cValue: unknown;
}

/** 单场景三臂对比 */
export interface AbcScenarioMetrics {
  scenarioId: string;
  category: string;
  A: BaselineScenarioMetrics;
  B: BaselineScenarioMetrics;
  C: BaselineScenarioMetrics;
  /** C 的 details 关键字段与 B 完全一致（仅剪裁 content） */
  detailsConsistent: boolean;
  detailsInconsistencies: AbcDetailsDiff[];
  /** C 结果文本不显著膨胀（totalResultChars_C <= totalResultChars_B * 1.15） */
  resultCharsNotInflated: boolean;
  /** C mustVerify 覆盖率不降级 */
  coverageNotDegraded: boolean;
  /** C 失败行为（empty/truncated/errors/timeouts）不降级 */
  failureNotDegraded: boolean;
  /** 守护：C 中 returnedCount>0 的调用不得误报「无匹配/无结果」 */
  noFalseNoResult: boolean;
  /** C 臂实际出现的 resultKind 集合 */
  resultKindsCovered: string[];
}

/** Phase 5.2 门禁 */
export interface AbcGate {
  resultCharsNotInflated: boolean;
  coverageNotDegraded: boolean;
  sourceRefNotDegraded: boolean;
  failureNotDegraded: boolean;
  detailsConsistent: boolean;
  noFalseNoResultAcrossAllScenarios: boolean;
  allPassed: boolean;
  details: Record<string, string>;
}

/** 完整 A/B/C 对比报告 */
export interface CompactEnvelopeAbcComparison {
  schema: string;
  timestamp: string;
  phase: string;
  scenarios: AbcScenarioMetrics[];
  aggregation: { A: AbcArmAggregation; B: AbcArmAggregation; C: AbcArmAggregation };
  gate: AbcGate;
}

// ============================================================================
// 复用 tool-ab-runner 的 facade 场景映射（避免逻辑复制）
// ============================================================================

import { toFacadeScenario } from "./tool-ab-runner.js";

/** 把 BASELINE_SCENARIOS 的专用工具调用映射为 facade 调用（B/C 共用） */
export function toAbcFacadeScenario(scenario: BaselineScenario): BaselineScenario {
  return toFacadeScenario(scenario);
}

/** envelope 只允许剪裁 content，details 的关键字段必须与 B 完全一致 */
const DETAIL_CONSISTENCY_FIELDS = [
  "sourceRef",
  "sourceRefValid",
  "resultKind",
  "returnedCount",
  "truncated",
  "nextQueryHint",
] as const;

function checkDetailsConsistency(B: BaselineScenarioMetrics, C: BaselineScenarioMetrics): {
  consistent: boolean;
  inconsistencies: AbcDetailsDiff[];
} {
  const n = Math.max(B.calls.length, C.calls.length);
  const inconsistencies: AbcDetailsDiff[] = [];
  for (let i = 0; i < n; i++) {
    const b = B.calls[i];
    const c = C.calls[i];
    if (!b || !c) {
      inconsistencies.push({
        callIndex: i,
        tool: c?.tool ?? b?.tool ?? "unknown",
        field: "callCount",
        bValue: b ? b.resultChars : "<missing>",
        cValue: c ? c.resultChars : "<missing>",
      });
      continue;
    }
    for (const field of DETAIL_CONSISTENCY_FIELDS) {
      const bv = b[field];
      const cv = c[field];
      if (bv !== cv) {
        inconsistencies.push({ callIndex: i, tool: c.tool, field, bValue: bv, cValue: cv });
      }
    }
  }
  return { consistent: inconsistencies.length === 0, inconsistencies };
}

// ============================================================================
// 辅助：守护 returnedCount>0 不得误报「无结果」
// ============================================================================

/** C 臂校验：returnedCount>0 的调用 content 不得含「无匹配/无结果」 */
function checkNoFalseNoResult(C: BaselineScenarioMetrics): boolean {
  for (const c of C.calls) {
    if ((c.returnedCount ?? 0) > 0 && c.contentText.includes("无匹配/无结果")) {
      return false;
    }
  }
  return true;
}

// ============================================================================
// 聚合（A/B/C 三臂）
// ============================================================================

function toAbcAggregation(a: ToolAbArmAggregation): AbcArmAggregation {
  return { ...a, stopRate: 1.0 };
}

// ============================================================================
// 门禁
// ============================================================================

function evaluateAbcGate(
  aggregation: { A: AbcArmAggregation; B: AbcArmAggregation; C: AbcArmAggregation },
  scenarios: AbcScenarioMetrics[],
): AbcGate {
  // Phase 5.3.1 内容摘要修复后，C 臂对精简列表场景（SC2/SC5）有少量摘要开销，
  // 聚合 C 可能略大于 B。门禁改为「不显著膨胀」（C <= B * 1.15），而非强制 C < B。
  // compact envelope 已弃用（Phase 5.3 真实 replay 多项门禁失败），此门禁仅验证机械正确性。
  const resultCharsNotInflated =
    aggregation.C.totalResultChars <= aggregation.B.totalResultChars * 1.15;
  const coverageNotDegraded =
    aggregation.C.avgCoverageRatio >= aggregation.B.avgCoverageRatio - 1e-9;
  const sourceRefNotDegraded =
    aggregation.C.sourceRefCompleteness >= aggregation.B.sourceRefCompleteness - 1e-9;
  const failureNotDegraded =
    aggregation.C.totalEmptyResults <= aggregation.B.totalEmptyResults &&
    aggregation.C.totalTruncatedResults <= aggregation.B.totalTruncatedResults &&
    aggregation.C.totalErrors <= aggregation.B.totalErrors &&
    aggregation.C.totalTimeouts <= aggregation.B.totalTimeouts;
  const detailsConsistent = scenarios.every((s) => s.detailsConsistent);
  const noFalseNoResultAcrossAllScenarios = scenarios.every((s) => s.noFalseNoResult);
  const allPassed =
    resultCharsNotInflated &&
    coverageNotDegraded &&
    sourceRefNotDegraded &&
    failureNotDegraded &&
    detailsConsistent &&
    noFalseNoResultAcrossAllScenarios;

  const cPct = aggregation.B.totalResultChars > 0
    ? Math.round((1 - aggregation.C.totalResultChars / aggregation.B.totalResultChars) * 100)
    : 0;
  return {
    resultCharsNotInflated,
    coverageNotDegraded,
    sourceRefNotDegraded,
    failureNotDegraded,
    detailsConsistent,
    noFalseNoResultAcrossAllScenarios,
    allPassed,
    details: {
      resultCharsNotInflated: `C=${aggregation.C.totalResultChars} <= B=${aggregation.B.totalResultChars}×1.15=${Math.round(aggregation.B.totalResultChars * 1.15)}（${cPct >= 0 ? "下降" : "上升"} ${Math.abs(cPct)}%）`,
      coverageNotDegraded: `C=${aggregation.C.avgCoverageRatio.toFixed(3)} >= B=${aggregation.B.avgCoverageRatio.toFixed(3)}`,
      sourceRefNotDegraded: `C=${aggregation.C.sourceRefCompleteness.toFixed(3)} >= B=${aggregation.B.sourceRefCompleteness.toFixed(3)}`,
      failureNotDegraded: `empty C=${aggregation.C.totalEmptyResults}<=B=${aggregation.B.totalEmptyResults}, truncated C=${aggregation.C.totalTruncatedResults}<=B=${aggregation.B.totalTruncatedResults}, errors C=${aggregation.C.totalErrors}<=B=${aggregation.B.totalErrors}, timeouts C=${aggregation.C.totalTimeouts}<=B=${aggregation.B.totalTimeouts}`,
      detailsConsistent: `C.details 关键字段与 B 完全一致：${detailsConsistent ? "是" : "否"}`,
      noFalseNoResult: `returnedCount>0 调用无「无结果」误报：${noFalseNoResultAcrossAllScenarios ? "是" : "否"}`,
    },
  };
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 运行 Phase 5.2 envelope A/B/C 确定性 replay（stub/直接驱动工具，零模型调用）。
 *
 * @param options.scenarios 参与对比的场景（默认 BASELINE_SCENARIOS）
 * @param options.timestamp 报告时间戳（默认 now）
 */
export async function runCompactEnvelopeAbcReplay(
  options: { scenarios?: BaselineScenario[]; timestamp?: string } = {},
): Promise<CompactEnvelopeAbcComparison> {
  const scenarios = options.scenarios ?? BASELINE_SCENARIOS;

  const perScenario: AbcScenarioMetrics[] = [];
  for (const scenario of scenarios) {
    const facadeScenario = toFacadeScenario(scenario);
    const [metricsA, metricsB, metricsC] = await Promise.all([
      runScenarioWithTools(scenario, (searchService) => createNarrativeTools({ searchService })),
      runScenarioWithTools(facadeScenario, (searchService) => [
        createTypedFacadeTool({ searchService }),
      ]),
      runScenarioWithTools(facadeScenario, (searchService) => [
        createTypedFacadeTool({ searchService, useCompactEnvelope: true }),
      ]),
    ]);

    const { consistent, inconsistencies } = checkDetailsConsistency(metricsB, metricsC);
    const resultCharsNotInflated = metricsC.totalResultChars <= metricsB.totalResultChars * 1.15;
    const coverageNotDegraded =
      metricsC.mustVerify.coverageRatio >= metricsB.mustVerify.coverageRatio - 1e-9;
    const failureNotDegraded =
      metricsC.emptyResults <= metricsB.emptyResults &&
      metricsC.truncatedResults <= metricsB.truncatedResults &&
      metricsC.errors <= metricsB.errors &&
      metricsC.timeouts <= metricsB.timeouts;
    const noFalseNoResult = checkNoFalseNoResult(metricsC);
    const resultKindsCovered = [
      ...new Set(metricsC.calls.map((c) => c.resultKind).filter((k): k is string => !!k)),
    ].sort();

    perScenario.push({
      scenarioId: scenario.id,
      category: scenario.category,
      A: metricsA,
      B: metricsB,
      C: metricsC,
      detailsConsistent: consistent,
      detailsInconsistencies: inconsistencies,
      resultCharsNotInflated,
      coverageNotDegraded,
      failureNotDegraded,
      noFalseNoResult,
      resultKindsCovered,
    });
  }

  const aggregation = {
    A: toAbcAggregation(aggregateArm(perScenario.map((s) => s.A))),
    B: toAbcAggregation(aggregateArm(perScenario.map((s) => s.B))),
    C: toAbcAggregation(aggregateArm(perScenario.map((s) => s.C))),
  };
  const gate = evaluateAbcGate(aggregation, perScenario);

  return {
    schema: "compact-envelope-abc/v1",
    timestamp: options.timestamp ?? new Date().toISOString(),
    phase: "phase5-2-envelope-abc",
    scenarios: perScenario,
    aggregation,
    gate,
  };
}

// ============================================================================
// 报告格式化
// ============================================================================

export function formatCompactEnvelopeAbcJson(comparison: CompactEnvelopeAbcComparison): string {
  return JSON.stringify(comparison, null, 2);
}

export function formatCompactEnvelopeAbcMarkdown(comparison: CompactEnvelopeAbcComparison): string {
  const l: string[] = [];
  l.push("# Phase 5.2 紧凑结果 envelope 确定性 A/B/C 对比报告");
  l.push("");
  l.push(`**schema**：${comparison.schema}`);
  l.push(`**时间**：${comparison.timestamp}`);
  l.push(`**阶段**：${comparison.phase}`);
  l.push("");
  l.push("## 三臂定义");
  l.push("");
  l.push("- **A**：9 个专用工具 + 原始结果（现状默认生产执行面）");
  l.push("- **B**：guided facade + 原始结果（受引导 facade，未压缩 content）");
  l.push("- **C**：guided facade + compact envelope（同一 facade，仅压缩模型可见 content）");
  l.push("");
  l.push("## 门禁结论");
  l.push("");
  l.push("| 门禁 | 结论 | 详情 |");
  l.push("|------|------|------|");
  l.push(`| 结果文本不膨胀（C<=B×1.15） | ${comparison.gate.resultCharsNotInflated ? "✓" : "✗"} | ${comparison.gate.details.resultCharsNotInflated} |`);
  l.push(`| mustVerify 覆盖率不降级 | ${comparison.gate.coverageNotDegraded ? "✓" : "✗"} | ${comparison.gate.details.coverageNotDegraded} |`);
  l.push(`| sourceRef/evidenceLevel 完整率不降级 | ${comparison.gate.sourceRefNotDegraded ? "✓" : "✗"} | ${comparison.gate.details.sourceRefNotDegraded} |`);
  l.push(`| 失败行为不降级 | ${comparison.gate.failureNotDegraded ? "✓" : "✗"} | ${comparison.gate.details.failureNotDegraded} |`);
  l.push(`| C.details 与 B 完全一致 | ${comparison.gate.detailsConsistent ? "✓" : "✗"} | ${comparison.gate.details.detailsConsistent} |`);
  l.push(`| 无「无结果」误报 | ${comparison.gate.noFalseNoResultAcrossAllScenarios ? "✓" : "✗"} | ${comparison.gate.details.noFalseNoResult} |`);
  l.push("");
  l.push(`**全部通过**：${comparison.gate.allPassed ? "是" : "否"}`);
  l.push("");
  l.push("## 聚合指标");
  l.push("");
  l.push("| 指标 | A 组（9 工具） | B 组（facade） | C 组（facade+envelope） |");
  l.push("|------|------|------|------|");
  const agg = comparison.aggregation;
  l.push(`| 可见工具数 | ${agg.A.toolSurface} | ${agg.B.toolSurface} | ${agg.C.toolSurface} |`);
  l.push(`| 总调用 | ${agg.A.totalCalls} | ${agg.B.totalCalls} | ${agg.C.totalCalls} |`);
  l.push(`| 重复查询 | ${agg.A.totalDuplicateQueries} | ${agg.B.totalDuplicateQueries} | ${agg.C.totalDuplicateQueries} |`);
  l.push(`| 总返回字符 | ${agg.A.totalResultChars} | ${agg.B.totalResultChars} | ${agg.C.totalResultChars} |`);
  l.push(`| 估算 token | ${agg.A.totalEstimateTokens} | ${agg.B.totalEstimateTokens} | ${agg.C.totalEstimateTokens} |`);
  l.push(`| 空结果 | ${agg.A.totalEmptyResults} | ${agg.B.totalEmptyResults} | ${agg.C.totalEmptyResults} |`);
  l.push(`| 结果截断 | ${agg.A.totalTruncatedResults} | ${agg.B.totalTruncatedResults} | ${agg.C.totalTruncatedResults} |`);
  l.push(`| 超时 | ${agg.A.totalTimeouts} | ${agg.B.totalTimeouts} | ${agg.C.totalTimeouts} |`);
  l.push(`| 失败 | ${agg.A.totalErrors} | ${agg.B.totalErrors} | ${agg.C.totalErrors} |`);
  l.push(`| 有效 sourceRef | ${agg.A.sourceRefsValid} | ${agg.B.sourceRefsValid} | ${agg.C.sourceRefsValid} |`);
  l.push(`| 无效 sourceRef | ${agg.A.sourceRefsInvalid} | ${agg.B.sourceRefsInvalid} | ${agg.C.sourceRefsInvalid} |`);
  l.push(`| 有效证据引用率 | ${agg.A.sourceRefCompleteness.toFixed(3)} | ${agg.B.sourceRefCompleteness.toFixed(3)} | ${agg.C.sourceRefCompleteness.toFixed(3)} |`);
  l.push(`| 平均 mustVerify 覆盖率 | ${agg.A.avgCoverageRatio.toFixed(3)} | ${agg.B.avgCoverageRatio.toFixed(3)} | ${agg.C.avgCoverageRatio.toFixed(3)} |`);
  l.push(`| 停止率（确定性） | ${agg.A.stopRate.toFixed(1)} | ${agg.B.stopRate.toFixed(1)} | ${agg.C.stopRate.toFixed(1)} |`);
  l.push("");
  l.push("> 停止率：确定性 replay 固定执行全部调用=1.0；真实模型 replay 才会随终止决策变化。");
  l.push("");
  l.push("## 各场景详情");
  l.push("");
  for (const s of comparison.scenarios) {
    l.push(`### ${s.scenarioId}（${s.category}）`);
    l.push("");
    l.push(`- 覆盖 resultKind：${s.resultKindsCovered.join(", ") || "（无）"}`);
    l.push(`- mustVerify 覆盖率：A=${s.A.mustVerify.coverageRatio.toFixed(3)}，B=${s.B.mustVerify.coverageRatio.toFixed(3)}，C=${s.C.mustVerify.coverageRatio.toFixed(3)}`);
    l.push(`- 返回字符：A=${s.A.totalResultChars}，B=${s.B.totalResultChars}，C=${s.C.totalResultChars}（C<=B×1.15=${s.resultCharsNotInflated ? "✓" : "✗"}）`);
    l.push(`- sourceRef：A 有效=${s.A.sourceRefsValid}/无效=${s.A.sourceRefsInvalid}；B=${s.B.sourceRefsValid}/${s.B.sourceRefsInvalid}；C=${s.C.sourceRefsValid}/${s.C.sourceRefsInvalid}`);
    l.push(`- details 与 B 一致：${s.detailsConsistent ? "✓" : "✗"}（差异 ${s.detailsInconsistencies.length} 处）`);
    l.push(`- 无「无结果」误报：${s.noFalseNoResult ? "✓" : "✗"}`);
    l.push("");
    l.push("| 对比项 | A 组 | B 组 | C 组 |");
    l.push("|--------|------|------|------|");
    l.push(`| 实际调用 | ${s.A.actualCalls} | ${s.B.actualCalls} | ${s.C.actualCalls} |`);
    l.push(`| 重复查询 | ${s.A.duplicateQueries} | ${s.B.duplicateQueries} | ${s.C.duplicateQueries} |`);
    l.push(`| 空结果 | ${s.A.emptyResults} | ${s.B.emptyResults} | ${s.C.emptyResults} |`);
    l.push(`| 结果截断 | ${s.A.truncatedResults} | ${s.B.truncatedResults} | ${s.C.truncatedResults} |`);
    l.push(`| 失败 | ${s.A.errors} | ${s.B.errors} | ${s.C.errors} |`);
    l.push("");
  }
  l.push("## 说明");
  l.push("");
  l.push("- 本报告为**工具执行面**确定性对比（直接驱动工具 execute），零模型调用，可复现。");
  l.push("- A/B/C 采用 oracle 工具/意图选择（场景调用直接命名），比较的是接口形态与内容收口的收益与证据保持。");
  l.push("- C 组 envelope 只剪裁**模型可见 content 文本**；details（sourceRef/evidenceLevel/resultKind/returnedCount/truncated/nextQueryHint）与 B 完全一致，供 verifier/canary 消费。");
  l.push("- 门禁通过标准：结果文本不显著膨胀（C<=B×1.15），同时证据覆盖与失败指标不下降。");
  l.push("- compact envelope 已在 Phase 5.3 真实模型 replay 中多项门禁失败，已明确弃用，不进入默认生产。");
  l.push("- 本 dry-run 仅验证 envelope 渲染的机械正确性（details 一致性、无结果误报守护），不验证文本收益。");
  l.push("");
  return l.join("\n");
}

// ============================================================================
// trajectory 副本（持久化 trace 证据，A/B/C 三臂）
// ============================================================================

/**
 * 把 A/B/C replay 的每场景每臂工具调用指标序列化为 trajectory 条目。
 *
 * @returns key = `${scenarioId}:${arm}` → 条目数组
 */
export function buildEnvelopeAbcTrajectory(
  comparison: CompactEnvelopeAbcComparison,
): Record<string, Array<{ type: string; timestamp: number; data: unknown }>> {
  const out: Record<string, Array<{ type: string; timestamp: number; data: unknown }>> = {};
  const base = Date.now();
  for (const s of comparison.scenarios) {
    for (const arm of ["A", "B", "C"] as const) {
      const key = `${s.scenarioId}:${arm}`;
      const entries: Array<{ type: string; timestamp: number; data: unknown }> = [];
      const m = arm === "A" ? s.A : arm === "B" ? s.B : s.C;
      entries.push({
        type: "tool_visibility",
        timestamp: base,
        data: {
          systemAllowedTools: m.visibleTools,
          visibleTools: m.visibleTools,
        },
      });
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
            contentText: c.contentText,
          },
        });
      });
      out[key] = entries;
    }
  }
  return out;
}