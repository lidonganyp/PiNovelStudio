/**
 * Phase 8 Stage P — Prompt-only A/B runner（eval-only）
 *
 * 对比两臂（见 docs/phase8-gemini-prompt-native-design.md §4）：
 * - P-A（基线）：通用 systemPrompt（REAL_SYSTEM_PROMPT_BASE / NOVELOS_SYSTEM_PROMPT）
 * - P-B（Gemini 专属）：Gemini 专属 systemPrompt（gemini-prompt-library.ts）
 *
 * 复用 runRealToolAbScenario：两臂统一 arm="A"（9 专用工具）、同 seed、同场景，
 * 只变化 systemPromptBase（经 runRealToolAbScenario 的 systemPromptBase 注入），
 * 使 Prompt 收益可独立归因。
 *
 * 两种模式：
 * - runPromptAbReplay：确定性 stub（createDryRunModel，零模型调用），验证 runner 框架。
 * - runPromptAbRealReplay：真实模型（经 modelFn 抽象注入，需授权后启用）。
 *
 * 授权边界：本模块不直接调用外部模型。模型侧经 modelFn 抽象注入；
 * 真实模型走 Gemini 生产 route narrator_primary（provider=gemini31, fallback=[]），
 * 需显式 PINOVEL_BENCHMARK_COST_PROFILE=gemini_validation 授权（fail-closed）。
 *
 * eval-only：只注册在 tsconfig.eval.json，不进入生产构建。
 */

import {
  runRealToolAbScenario,
  aggregateRealArm,
  REAL_SYSTEM_PROMPT_BASE,
  type RealToolAbScenarioMetrics,
  type RealToolAbArmAggregation,
  type ToolAbModelFn,
  type ModelCallProvenance,
  createDryRunModel,
} from "./tool-ab-real-runner.js";
import { GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE } from "./gemini-prompt-library.js";
import {
  evaluatePromptGate,
  type PromptArmAggregation,
  type PromptGate,
} from "./prompt-ab-gate.js";
import {
  BASELINE_SCENARIOS,
  type BaselineScenario,
} from "./tool-interface-baseline.js";

// ============================================================================
// 类型
// ============================================================================

/** P-A / P-B 两臂臂名 */
export type PromptArm = "A" | "B";

/** 单场景两臂结果（每臂持每 seed 独立指标） */
export interface PromptScenarioResult {
  scenarioId: string;
  category: string;
  metricsA: RealToolAbScenarioMetrics[];
  metricsB: RealToolAbScenarioMetrics[];
}

/** Stage P 完整对比报告（真实模式） */
export interface PromptAbComparison {
  schema: string;
  timestamp: string;
  phase: string;
  mode: "stub" | "real";
  /** 两臂 systemPrompt 说明（不改协议，只变 Prompt） */
  arms: {
    A: { label: string; base: string };
    B: { label: string; base: string };
  };
  seeds: number[];
  scenarios: PromptScenarioResult[];
  aggregation: { A: PromptArmAggregation; B: PromptArmAggregation };
  gate: PromptGate;
  /** 真实模型采样/路由 provenance（真实模式；stub 无） */
  provenance: { A: ModelCallProvenance | undefined; B: ModelCallProvenance | undefined };
  /** 批次编号（3 批 × 3 seed 的批次偏移用） */
  batch?: number;
}

// ============================================================================
// 辅助：把 RealToolAbArmAggregation 转成 PromptArmAggregation
// ============================================================================

function toPromptAggregation(agg: RealToolAbArmAggregation): PromptArmAggregation {
  return { ...agg, avgFirstEvidenceLatencyMs: agg.firstValidEvidenceLatencyMs };
}

// ============================================================================
// 主入口：确定性 stub replay（零模型调用）
// ============================================================================

/**
 * 运行 Stage P 确定性 stub replay（createDryRunModel，零模型调用）。
 *
 * 在 stub 模式下，两臂工具调用结果完全相同（dry-run 不尊重 Prompt 差异），
 * 但 systemPrompt 元数据会记录在报告中，供真实模型 replay 对比。
 *
 * @param options.scenarios 参与对比的场景（默认 BASELINE_SCENARIOS）
 * @param options.seeds 随机种子列表（默认 [0,1,2]）
 * @param options.batch 批次编号（3 批 × 3 seed 的批次偏移用）
 */
export async function runPromptAbReplay(
  options: {
    scenarios?: BaselineScenario[];
    seeds?: number[];
    batch?: number;
    timestamp?: string;
  } = {},
): Promise<PromptAbComparison> {
  const seeds = options.seeds ?? [0, 1, 2];
  const scenarios = options.scenarios ?? BASELINE_SCENARIOS;

  const perScenario: PromptScenarioResult[] = [];
  for (const scenario of scenarios) {
    const metricsA: RealToolAbScenarioMetrics[] = [];
    const metricsB: RealToolAbScenarioMetrics[] = [];
    for (const seed of seeds) {
      const [mA, mB] = await Promise.all([
        runRealToolAbScenario({
          scenario,
          arm: "A",
          seed,
          modelFn: createDryRunModel(scenario, "A"),
          systemPromptBase: REAL_SYSTEM_PROMPT_BASE,
        }),
        runRealToolAbScenario({
          scenario,
          arm: "A",
          seed,
          modelFn: createDryRunModel(scenario, "A"),
          systemPromptBase: GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE,
        }),
      ]);
      metricsA.push(mA);
      metricsB.push(mB);
    }
    perScenario.push({ scenarioId: scenario.id, category: scenario.category, metricsA, metricsB });
  }

  const aggA = toPromptAggregation(aggregateRealArm(perScenario.flatMap((s) => s.metricsA)));
  const aggB = toPromptAggregation(aggregateRealArm(perScenario.flatMap((s) => s.metricsB)));

  return {
    schema: "prompt-ab/v1",
    timestamp: options.timestamp ?? new Date().toISOString(),
    phase: "phase8-stage-p",
    mode: "stub",
    arms: {
      A: { label: "P-A（通用 Prompt）", base: REAL_SYSTEM_PROMPT_BASE },
      B: { label: "P-B（Gemini 专属 Prompt）", base: GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE },
    },
    seeds,
    scenarios: perScenario,
    aggregation: { A: aggA, B: aggB },
    gate: evaluatePromptGate(aggA, aggB),
    provenance: { A: undefined, B: undefined },
    batch: options.batch,
  };
}

// ============================================================================
// 真实模型 replay（模型驱动）
// ============================================================================

/**
 * 运行 Stage P 真实模型 replay（模型驱动）。
 *
 * 复用 runRealToolAbScenario：两臂统一 arm="A"（9 专用工具），同 seed、同场景，
 * 只变化 systemPromptBase（P-A 通用 / P-B Gemini 专属），使 Prompt 收益可独立归因。
 *
 * 授权边界：本函数不直接调用外部模型。模型侧经 modelFn 抽象注入——
 * dry-run 用 createDryRunModel（确定性 stub，零 API），真实模型用
 * createRealToolAbModelDecide（Sub2API/Gemini narrator_primary，需
 * PINOVEL_BENCHMARK_COST_PROFILE=gemini_validation 授权，fallback=[]）。
 *
 * @param options.modelFn 模型决策函数（必填；dry-run 或真实模型）
 * @param options.seeds 随机种子列表（默认 [0,1,2]）
 * @param options.scenarios 参与对比的场景（默认全部 BASELINE_SCENARIOS）
 * @param options.batch 批次编号（3 批 × 3 seed 的批次偏移用）
 */
export async function runPromptAbRealReplay(options: {
  modelFn: ToolAbModelFn;
  seeds?: number[];
  scenarios?: BaselineScenario[];
  batch?: number;
  timestamp?: string;
}): Promise<PromptAbComparison> {
  const seeds = options.seeds ?? [0, 1, 2];
  const scenarios = options.scenarios ?? BASELINE_SCENARIOS;

  const perScenario: PromptScenarioResult[] = [];
  for (const scenario of scenarios) {
    const metricsA: RealToolAbScenarioMetrics[] = [];
    const metricsB: RealToolAbScenarioMetrics[] = [];
    for (const seed of seeds) {
      const [mA, mB] = await Promise.all([
        runRealToolAbScenario({
          scenario,
          arm: "A",
          seed,
          modelFn: options.modelFn,
          systemPromptBase: REAL_SYSTEM_PROMPT_BASE,
        }),
        runRealToolAbScenario({
          scenario,
          arm: "A",
          seed,
          modelFn: options.modelFn,
          systemPromptBase: GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE,
        }),
      ]);
      metricsA.push(mA);
      metricsB.push(mB);
    }
    perScenario.push({ scenarioId: scenario.id, category: scenario.category, metricsA, metricsB });
  }

  const aggA = toPromptAggregation(aggregateRealArm(perScenario.flatMap((s) => s.metricsA)));
  const aggB = toPromptAggregation(aggregateRealArm(perScenario.flatMap((s) => s.metricsB)));

  const provOf = (metrics: RealToolAbScenarioMetrics[]): ModelCallProvenance | undefined =>
    metrics.find((m) => m.provenance)?.provenance;

  return {
    schema: "prompt-ab-real/v1",
    timestamp: options.timestamp ?? new Date().toISOString(),
    phase: "phase8-stage-p",
    mode: "real",
    arms: {
      A: { label: "P-A（通用 Prompt）", base: REAL_SYSTEM_PROMPT_BASE },
      B: { label: "P-B（Gemini 专属 Prompt）", base: GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE },
    },
    seeds,
    scenarios: perScenario,
    aggregation: { A: aggA, B: aggB },
    gate: evaluatePromptGate(aggA, aggB),
    provenance: {
      A: provOf(perScenario.flatMap((s) => s.metricsA)),
      B: provOf(perScenario.flatMap((s) => s.metricsB)),
    },
    batch: options.batch,
  };
}

// ============================================================================
// 报告格式化
// ============================================================================

export function formatPromptAbJson(comparison: PromptAbComparison): string {
  return JSON.stringify(comparison, null, 2);
}

export function formatPromptAbMarkdown(comparison: PromptAbComparison): string {
  const l: string[] = [];
  l.push("# Phase 8 Stage P — Prompt-only 对比报告");
  l.push("");
  l.push(`**schema**：${comparison.schema}`);
  l.push(`**时间**：${comparison.timestamp}`);
  l.push(`**阶段**：${comparison.phase}`);
  l.push(`**模式**：${comparison.mode === "stub" ? "确定性 stub，零模型调用" : "真实模型（需授权）"}`);
  l.push(`**seed**：${comparison.seeds.join(", ")}`);
  if (comparison.batch !== undefined) l.push(`**批次**：${comparison.batch}`);
  l.push("");
  l.push("> 两臂统一 9 专用工具 + 完整上下文 + A 组推理预算 + Gemini 生产 route（fallback=[]），");
  l.push("> 只变化 systemPrompt（Prompt-only），使 Prompt 收益可独立归因。");
  l.push("");
  l.push(`- **P-A**：${comparison.arms.A.label}`);
  l.push(`- **P-B**：${comparison.arms.B.label}`);
  l.push("");

  // 真实模式 provenance
  if (comparison.mode === "real") {
    l.push("## 采样与路由 provenance");
    l.push("");
    l.push("| 项目 | P-A | P-B |");
    l.push("|------|------|------|");
    const fmtProv = (p?: ModelCallProvenance) =>
      p
        ? `${[p.provider, p.model, p.route].filter(Boolean).join(":") ?? "n/a"} (temp=${p.temperature ?? "?"}, seed=${p.seedApplied ? "透传" : "否"}, fallback=${p.fallbackDisabled ? "关" : "开"})`
        : "unmeasured";
    l.push(`| fingerprint | ${fmtProv(comparison.provenance.A)} | ${fmtProv(comparison.provenance.B)} |`);
    l.push("");
    const seedNote =
      comparison.provenance.A?.seedSupported === false ||
      comparison.provenance.B?.seedSupported === false
        ? "> ⚠️ 当前 provider 协议不支持 seed：\"3 seed\"仅作标签，实际为非确定性配对实验。"
        : "> seed 被 provider 支持并透传：3 seed 为受控复现采样。";
    l.push(seedNote);
    l.push("");
  }

  // 门禁结论
  l.push("## 门禁结论（P-B 相对 P-A）");
  l.push("");
  l.push("| 门禁 | 结论 | 详情 |");
  l.push("|------|------|------|");
  l.push(`| mustVerify 覆盖率不降级 | ${comparison.gate.coverageNotDegraded ? "✓" : "✗"} | ${comparison.gate.details.coverageNotDegraded} |`);
  l.push(`| sourceRef 完整率不降级 | ${comparison.gate.sourceRefNotDegraded ? "✓" : "✗"} | ${comparison.gate.details.sourceRefNotDegraded} |`);
  l.push(`| 非法调用不恶化 | ${comparison.gate.invalidCallsNotWorsened ? "✓" : "✗"} | ${comparison.gate.details.invalidCallsNotWorsened} |`);
  l.push(`| 空结果不恶化 | ${comparison.gate.emptyResultsNotWorsened ? "✓" : "✗"} | ${comparison.gate.details.emptyResultsNotWorsened} |`);
  l.push(`| 停止率不降级 | ${comparison.gate.stopRateNotDegraded ? "✓" : "✗"} | ${comparison.gate.details.stopRateNotDegraded} |`);
  l.push(`| token 成本获益（加分项） | ${comparison.gate.tokenCostReduced ? "✓" : "—"} | ${comparison.gate.details.tokenCostReduced} |`);
  l.push(`| 首证据延迟不恶化（加分项） | ${comparison.gate.latencyNotWorse ? "✓" : "—"} | ${comparison.gate.details.latencyNotWorse} |`);
  l.push("");
  l.push(`**硬门全部通过**：${comparison.gate.allHardPassed ? "是" : "否"}`);
  l.push(`**全部通过（含加分项）**：${comparison.gate.allPassed ? "是" : "否"}`);
  l.push("");

  // 聚合指标
  l.push("## 聚合指标");
  l.push("");
  l.push("| 指标 | P-A（通用） | P-B（Gemini 专属） |");
  l.push("|------|------|------|");
  const agg = comparison.aggregation;
  const fmtLat = (v: number | null) => (v === null ? "unmeasured" : v.toFixed(0));
  l.push(`| 总调用 | ${agg.A.totalCalls} | ${agg.B.totalCalls} |`);
  l.push(`| 估算 token | ${agg.A.totalEstimateTokens} | ${agg.B.totalEstimateTokens} |`);
  l.push(`| 平均 mustVerify 覆盖率 | ${agg.A.avgCoverageRatio.toFixed(3)} | ${agg.B.avgCoverageRatio.toFixed(3)} |`);
  l.push(`| sourceRef 完整率 | ${agg.A.sourceRefCompleteness.toFixed(3)} | ${agg.B.sourceRefCompleteness.toFixed(3)} |`);
  l.push(`| 非法工具选择 | ${agg.A.invalidToolSelections} | ${agg.B.invalidToolSelections} |`);
  l.push(`| 解析失败 | ${agg.A.parseErrors} | ${agg.B.parseErrors} |`);
  l.push(`| 空结果 | ${agg.A.emptyResults} | ${agg.B.emptyResults} |`);
  l.push(`| 失败 | ${agg.A.errors} | ${agg.B.errors} |`);
  l.push(`| 超时 | ${agg.A.timeouts} | ${agg.B.timeouts} |`);
  l.push(`| 停止率 | ${(agg.A.stopRate * 100).toFixed(0)}% | ${(agg.B.stopRate * 100).toFixed(0)}% |`);
  l.push(`| 首证据延迟(ms) | ${fmtLat(agg.A.avgFirstEvidenceLatencyMs)} | ${fmtLat(agg.B.avgFirstEvidenceLatencyMs)} |`);
  l.push("");

  // 各场景详情
  l.push("## 各场景详情");
  l.push("");
  for (const s of comparison.scenarios) {
    l.push(`### ${s.scenarioId}（${s.category}）`);
    l.push("");
    l.push("| seed | A 覆盖 | B 覆盖 | A 调用 | B 调用 | A token | B token | A 停止 | B 停止 |");
    l.push("|------|--------|--------|--------|--------|---------|---------|--------|--------|");
    for (let i = 0; i < comparison.seeds.length; i++) {
      const a = s.metricsA[i];
      const b = s.metricsB[i];
      l.push(
        `| ${i} | ${a?.mustVerify.coverageRatio.toFixed(3)} | ${b?.mustVerify.coverageRatio.toFixed(3)} | ${a?.totalCalls} | ${b?.totalCalls} | ${a?.totalEstimateTokens} | ${b?.totalEstimateTokens} | ${a?.stopped} | ${b?.stopped} |`,
      );
    }
    l.push("");
  }

  l.push("## 说明");
  l.push("");
  l.push("- 本报告为**Prompt-only** 对比：两臂统一 9 专用工具 + 完整上下文 + A 组推理预算 + Gemini route，只变化 systemPrompt。");
  if (comparison.mode === "stub") {
    l.push("- 当前为**确定性 stub**（createDryRunModel）：零模型调用，两臂工具结果相同，仅验证 runner 框架与报告管线。");
  } else {
    l.push("- 当前为**真实模型 replay**：需 PINOVEL_BENCHMARK_COST_PROFILE=gemini_validation 授权（fail-closed），route=narrator_primary，fallback=[]。");
  }
  l.push("- 门禁强调失败行为与 sourceRef 优先；token 为加分项，避免仅为省 token 牺牲覆盖/召回。");
  l.push("");
  return l.join("\n");
}