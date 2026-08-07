/**
 * NovelOS Phase 4.2 — 真实模型 A/B runner（eval-only）
 *
 * 对比 A 组（specialized-9-tools）与 B 组（typed facade query_narrative）在
 * **模型自主决策**（非 oracle 驱动）下的行为与负担差异。
 *
 * 与 Phase 4.1（tool-ab-runner.ts 确定性 oracle replay）的区别：
 * - Phase 4.1：scene.calls 直接指定工具名，runner 直接驱动工具 execute（oracle selection）。
 * - Phase 4.2：模型通过 `ToolAbModelFn` 自主决定调用哪个工具/意图；runner 只负责
 *   **注入工具面 + 校验模型决策 + 路由 + 执行 + 记录指标**。不再用 oracle intent。
 *
 * 记录模型实际行为：
 * - 工具选择（selectedTool，是否落在可见工具集内 → invalidToolSelections）
 * - facade intent 是否正确（B 组 intent 是否 ∈ QUERY_NARRATIVE_INTENTS → invalidIntents）
 * - 参数解析/路由失败（parseErrors）
 * - 首次有效证据调用（firstValidEvidence 序号 + 累计耗时）
 * - schema token 成本（注入可见工具 schema 的估算 token）
 * - 重复查询按"语义操作身份"统计（intent 优先，回退 toolName + query）
 *
 * 授权边界：本模块不直接调用外部模型。模型侧通过 `ToolAbModelFn` 抽象注入；
 * dry-run 用 `createDryRunModel`（确定性 stub，零 API），真实模型用
 * `createRealModelDecide`（包装真实 model generate + tool_call 解析，需授权后启用）。
 *
 * eval-only：只注册在 tsconfig.eval.json，不进入生产构建。
 */

import { createNarrativeTools } from "../tools/narrative-tools.js";
import {
  createTypedFacadeTool,
  QUERY_NARRATIVE_NAME,
  QUERY_NARRATIVE_INTENTS,
  TOOL_NAME_TO_INTENT,
  INTENT_TO_TOOL,
} from "./typed-facade-tool.js";
import {
  setupBaselineWorkspace,
  collectConfirmedEvidences,
  BASELINE_SCENARIOS,
  type BaselineScenario,
} from "./tool-interface-baseline.js";
import type { ConfirmedEvidence } from "./uncertainty-recall-metrics.js";
import { createNarrativeSearchService } from "../agent/narrative-search-service.js";
import {
  computeMustVerifyCoverage,
  isValidSourceRef,
  VALID_EVIDENCE_LEVELS,
} from "./uncertainty-recall-metrics.js";
import { classifyInvalidSourceRef, type InvalidSourceRefCategory } from "./tool-ab-runner.js";
import type { ToolProtocol } from "../tools/tool-protocol.js";

// ============================================================================
// 模型决策抽象
// ============================================================================

/** 模型决策：调用工具 或 生成最终正文 */
export type ToolAbModelDecision =
  | { kind: "tool_call"; toolName: string; intent?: string; arguments: Record<string, unknown> }
  | { kind: "final"; text: string };

/** 模型函数上下文 */
export interface ToolAbModelFnCtx {
  /** 检索执行计划 + 上下文 prompt（含 mustVerify 项） */
  prompt: string;
  /** 模型可见工具名（A=9 专用，B=query_narrative） */
  visibleTools: string[];
  /** 已发生的回合观测（供模型参考） */
  history: RealToolAbTurn[];
  /** 当前回合号（0-based） */
  round: number;
  /** 随机种子（真实模型采样用；dry-run 固定） */
  seed: number;
}

/** 模型函数：给定上下文返回一次决策 */
export type ToolAbModelFn = (ctx: ToolAbModelFnCtx) => Promise<ToolAbModelDecision>;

// ============================================================================
// 回合观测
// ============================================================================

/** 单回合（模型决策 → 校验 → 路由 → 执行）观测 */
export interface RealToolAbTurn {
  round: number;
  decision: ToolAbModelDecision;
  /** 模型实际选择的工具名（决策里的 toolName） */
  selectedTool: string | null;
  /** 模型填写的 facade intent（仅 B 组） */
  intent: string | null;
  /** intent 是否合法（B 组 ∈ QUERY_NARRATIVE_INTENTS） */
  intentValid: boolean;
  /** intent 路由到的底层工具名（B 组合法 intent 映射；A 组 = selectedTool） */
  routedTool: string | null;
  /** 路由是否成功（工具可见 + intent 合法 + 工具存在） */
  routedOk: boolean;
  /** 参数解析/路由失败原因（无则 null） */
  parseError: string | null;
  latencyMs: number;
  resultChars: number;
  estimateTokens: number;
  evidenceLevel: string | undefined;
  sourceRef: string | undefined;
  sourceRefValid: boolean;
  sourceRefInvalidCategory: InvalidSourceRefCategory | null;
  empty: boolean;
  timeout: boolean;
  isError: boolean;
  /** 按语义操作身份判定的重复查询 */
  duplicateQuery: boolean;
  /** 是否为本场景首次有效证据回合 */
  firstValidEvidence: boolean;
}

// ============================================================================
// 场景执行结果 + 聚合 + 门槛
// ============================================================================

/** 单场景单 arm 单 seed 执行结果 */
export interface RealToolAbScenarioMetrics {
  scenarioId: string;
  category: string;
  arm: "A" | "B";
  seed: number;
  turns: RealToolAbTurn[];
  toolSurface: number;
  schemaTokenCost: number;
  totalCalls: number;
  totalDuplicateQueries: number;
  totalResultChars: number;
  totalEstimateTokens: number;
  invalidToolSelections: number;
  invalidIntents: number;
  parseErrors: number;
  firstValidEvidence: { callIndex: number; cumulativeLatencyMs: number } | null;
  emptyResults: number;
  timeouts: number;
  errors: number;
  sourceRefsValid: number;
  sourceRefsInvalid: number;
  invalidSourceRefByCategory: Record<InvalidSourceRefCategory, number>;
  sourceRefCompleteness: number;
  mustVerify: {
    itemCount: number;
    coveredCount: number;
    coverageRatio: number;
    uncoveredItems: string[];
  };
}

/** 每场景 A/B 成对结果（每 arm 持有每个 seed 的独立 metrics，供 3-seed 聚合与逐 seed 展示） */
export interface RealToolAbPair {
  scenarioId: string;
  category: string;
  A: RealToolAbScenarioMetrics[];
  B: RealToolAbScenarioMetrics[];
}

/** 单 arm 跨场景聚合 */
export interface RealToolAbArmAggregation {
  toolSurface: number;
  schemaTokenCost: number;
  totalCalls: number;
  totalDuplicateQueries: number;
  totalResultChars: number;
  totalEstimateTokens: number;
  invalidToolSelections: number;
  invalidIntents: number;
  parseErrors: number;
  emptyResults: number;
  timeouts: number;
  errors: number;
  sourceRefsValid: number;
  sourceRefsInvalid: number;
  invalidSourceRefByCategory: Record<InvalidSourceRefCategory, number>;
  sourceRefCompleteness: number;
  avgCoverageRatio: number;
  firstValidEvidenceLatencyMs: number | null;
}

/** 门槛判定 */
export interface RealToolAbGate {
  mustVerifyCoverageNotDegraded: boolean;
  sourceRefCompletenessNotDegraded: boolean;
  invalidSourceRefNotWorsened: boolean;
  burdenImproved: boolean;
  improvedBurdenMetrics: string[];
  allPassed: boolean;
  details: Record<string, string>;
}

/** 完整真实模型 A/B 对比 */
export interface RealToolAbComparison {
  schema: string;
  timestamp: string;
  phase: string;
  mode: "dry-run" | "real";
  scenarios: RealToolAbPair[];
  aggregation: { A: RealToolAbArmAggregation; B: RealToolAbArmAggregation };
  gate: RealToolAbGate;
}

// ============================================================================
// schema token 成本估算
// ============================================================================

/**
 * 估算注入给定工具 schema 的 token 成本。
 *
 * 序列化每个工具的 name + description + parameters schema，按 ~2 字符/token 估算
 * （中文场景近似）。A 组 = 9 个专用工具 schema；B 组 = 1 个 facade schema。
 * 这是模型每回合都要在 system prompt 中重复支付的上下文成本，是真实负担指标。
 */
export function estimateToolSchemaTokens(tools: ToolProtocol[]): number {
  let total = 0;
  for (const t of tools) {
    let s = `${t.name} ${t.description ?? ""} `;
    try {
      s += JSON.stringify(t.parameters ?? {});
    } catch {
      /* 忽略序列化失败 */
    }
    total += Math.ceil(s.length / 2);
  }
  return total;
}

// ============================================================================
// 语义操作身份重复检测（intent 优先）
// ============================================================================

/** 语义操作身份重复检测器：intent（facade）优先，回退 toolName + query */
class SemanticDupTracker {
  private readonly counts = new Map<string, number>();

  /** 判断本次调用是否重复，并更新计数。返回 true 表示第 2+ 次同语义调用。 */
  check(toolName: string, args: Record<string, unknown>): boolean {
    const query = typeof args.query === "string" ? args.query : "";
    const scope =
      typeof args.intent === "string" && args.intent.length > 0 ? args.intent : toolName;
    const key = query ? `${scope}:${query}` : `${scope}:`;
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n > 1;
  }
}

// ============================================================================
// 构造检索执行计划 prompt
// ============================================================================

/** 从场景 calls 聚合 mustVerify 项，构造检索执行计划 prompt */
function buildRealPrompt(scenario: BaselineScenario): string {
  const plan = scenario.calls
    .flatMap((c) => c.mustVerify ?? [])
    .map((q) => `- ${q}`)
    .join("\n");
  return [
    "本章需要验证以下事实（mustVerify）：",
    plan.length > 0 ? plan : "（无强制验证项）",
    "",
    "请根据你可见的工具，检索所需证据后生成正文。",
  ].join("\n");
}

// ============================================================================
// dry-run 模型（确定性 stub，零 API）
// ============================================================================

/**
 * 创建 dry-run 模型函数：确定性地按场景 calls 顺序生成工具调用决策。
 *
 * - A 组：toolName = call.tool（专用工具名），arguments = call.args
 * - B 组：toolName = query_narrative，intent = TOOL_NAME_TO_INTENT[call.tool]，
 *   arguments = { intent, ...call.args }
 *
 * 所有 calls 结束后返回 final。该 stub 验证 runner 框架（注入/校验/路由/指标），
 * 不代表真实模型质量结论。
 */
export function createDryRunModel(scenario: BaselineScenario, arm: "A" | "B"): ToolAbModelFn {
  return async (ctx) => {
    if (ctx.round >= scenario.calls.length) {
      return { kind: "final", text: "（dry-run 生成正文）" };
    }
    const call = scenario.calls[ctx.round];
    if (arm === "A") {
      return { kind: "tool_call", toolName: call.tool, arguments: call.args };
    }
    // B 组：intent 由 TOOL_NAME_TO_INTENT 决定（stub 模拟模型理解 facade 语义）
    const intent = call.tool in TOOL_NAME_TO_INTENT ? TOOL_NAME_TO_INTENT[call.tool] : undefined;
    return {
      kind: "tool_call",
      toolName: QUERY_NARRATIVE_NAME,
      intent,
      arguments: { intent, ...call.args },
    };
  };
}

// ============================================================================
// 单场景单 arm 执行
// ============================================================================

/**
 * 运行一个场景的单个 arm（注入对应工具面，驱动 ToolAbModelFn 直至 final 或预算耗尽）。
 *
 * @param scenario 场景定义
 * @param arm A（9 专用工具）或 B（query_narrative facade）
 * @param seed 随机种子
 * @param modelFn 模型决策函数（dry-run stub 或真实模型）
 * @param maxModelCalls 模型工具调用预算（默认与场景 calls 数一致，dry-run 用）
 * @param timeoutMs 单次工具执行超时
 */
export async function runRealToolAbScenario(options: {
  scenario: BaselineScenario;
  arm: "A" | "B";
  seed: number;
  modelFn: ToolAbModelFn;
  maxModelCalls?: number;
  timeoutMs?: number;
}): Promise<RealToolAbScenarioMetrics> {
  const { scenario, arm, seed, modelFn } = options;
  const maxModelCalls = options.maxModelCalls ?? scenario.calls.length;
  const timeoutMs = options.timeoutMs ?? 15_000;

  const { projectRoot, workspaceId, cleanup } = setupBaselineWorkspace(scenario.workspace);
  const dupTracker = new SemanticDupTracker();
  const turns: RealToolAbTurn[] = [];
  const allConfirmed: ConfirmedEvidence[] = [];
  // 场景全部 calls 的 mustVerify 项（独立于模型 round 顺序，真实模型不会严格按 call 索引调用）
  const mustVerifyItems: string[] = scenario.calls.flatMap((c) => c.mustVerify ?? []);
  let firstValidFound = false;
  let schemaTokenCost = 0;
  let injectedToolCount = 0;

  try {
    const searchService = createNarrativeSearchService({
      projectRoot,
      workspaceId,
      sourceChapter: `ch${scenario.workspace.historicalChapters.length}`,
    });
    // 注入工具面：A=9 专用工具，B=query_narrative facade
    const tools: ToolProtocol[] =
      arm === "A"
        ? createNarrativeTools({ searchService })
        : [createTypedFacadeTool({ searchService })];
    const toolByName = new Map(tools.map((t) => [t.name, t]));
    const visibleTools = tools.map((t) => t.name).sort();
    schemaTokenCost = estimateToolSchemaTokens(tools);
    injectedToolCount = tools.length;

    const prompt = buildRealPrompt(scenario);

    for (let round = 0; round < maxModelCalls; round++) {
      const decision = await modelFn({
        prompt,
        visibleTools: [...visibleTools],
        history: [...turns],
        round,
        seed,
      });

      if (decision.kind === "final") {
        turns.push({
          round,
          decision,
          selectedTool: null,
          intent: null,
          intentValid: false,
          routedTool: null,
          routedOk: true,
          parseError: null,
          latencyMs: 0,
          resultChars: decision.text.length,
          estimateTokens: Math.ceil(decision.text.length / 2),
          evidenceLevel: undefined,
          sourceRef: undefined,
          sourceRefValid: false,
          sourceRefInvalidCategory: null,
          empty: false,
          timeout: false,
          isError: false,
          duplicateQuery: false,
          firstValidEvidence: false,
        });
        break;
      }

      const toolName = decision.toolName;
      const intent = decision.intent ?? null;
      const tool = toolByName.get(toolName);
      const toolCallId = `real-${scenario.id}-${arm}-${seed}-${round}`;
      const start = Date.now();
      let isError = false;
      let result: unknown = null;
      let parseError: string | null = null;
      let routedOk = tool !== undefined;

      // 校验：工具可见性 + B 组 intent 合法性
      if (!tool) {
        parseError = `工具 "${toolName}" 不在可见工具集内（可见：${visibleTools.join(", ")}）`;
        routedOk = false;
      } else if (
        arm === "B" &&
        (intent === null || !QUERY_NARRATIVE_INTENTS.includes(intent as (typeof QUERY_NARRATIVE_INTENTS)[number]))
      ) {
        parseError = `facade intent "${String(intent)}" 非法（应在 ${QUERY_NARRATIVE_INTENTS.join("|")} 内）`;
        routedOk = false;
      }

      // 执行（仅当路由成功）
      if (routedOk && tool) {
        try {
          result = await tool.execute(toolCallId, decision.arguments);
        } catch {
          isError = true;
          result = { content: [{ type: "text", text: "tool execution error" }], details: {} };
        }
      }

      const latencyMs = Date.now() - start;
      const resultText = extractResultText(result);
      const resultChars = resultText.length;
      const estimateTokens = Math.ceil(resultChars / 2);
      const details = (result as { details?: unknown } | undefined)?.details as
        | (Record<string, unknown> & { evidenceLevel?: string; sourceRef?: string })
        | undefined;
      const evidenceLevel = details?.evidenceLevel;
      const sourceRef = details?.sourceRef;
      const sourceRefValid = isValidSourceRef(sourceRef);
      const empty = resultChars === 0 && !isError;
      const timeout = isError && /timeout|超时|aborted|timed out/i.test(resultText);
      const duplicateQuery = dupTracker.check(toolName, decision.arguments);
      const isFirstValid = !firstValidFound && !!evidenceLevel && VALID_EVIDENCE_LEVELS.has(evidenceLevel);
      if (isFirstValid) firstValidFound = true;

      turns.push({
        round,
        decision,
        selectedTool: toolName,
        intent,
        intentValid: arm === "B" ? intent !== null && QUERY_NARRATIVE_INTENTS.includes(intent as (typeof QUERY_NARRATIVE_INTENTS)[number]) : true,
        routedTool: arm === "B" && intent ? (INTENT_TO_TOOL[intent as IntentKey] ?? null) : toolName,
        routedOk,
        parseError,
        latencyMs,
        resultChars,
        estimateTokens,
        evidenceLevel,
        sourceRef,
        sourceRefValid,
        sourceRefInvalidCategory: sourceRefValid ? null : classifyInvalidSourceRef(sourceRef),
        empty,
        timeout,
        isError,
        duplicateQuery,
        firstValidEvidence: isFirstValid,
      });

      if (routedOk && result) {
        const confirmed = collectConfirmedEvidences((result as { details?: unknown })?.details);
        allConfirmed.push(...confirmed);
      }
    }
  } finally {
    cleanup();
  }

  return summarizeRealScenario(
    scenario,
    arm,
    seed,
    turns,
    schemaTokenCost,
    mustVerifyItems,
    allConfirmed,
    injectedToolCount,
  );
}

// INTENT_TO_TOOL 已在文件顶部导入；此处仅定义 IntentKey 类型别名
type IntentKey = keyof typeof INTENT_TO_TOOL;

// ============================================================================
// 汇总
// ============================================================================

/** 从工具 result 提取文本内容 */
function extractResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type: string; text: string } =>
        !!c && typeof c === "object" && (c as { type?: string }).type === "text" && typeof (c as { text?: unknown }).text === "string",
    )
    .map((c) => c.text)
    .join("");
}

/** 把回合序列汇总为场景指标 */
function summarizeRealScenario(
  scenario: BaselineScenario,
  arm: "A" | "B",
  seed: number,
  turns: RealToolAbTurn[],
  schemaTokenCost: number,
  mustVerifyItems: string[],
  allConfirmed: ConfirmedEvidence[],
  injectedToolCount: number,
): RealToolAbScenarioMetrics {
  const toolSurface = injectedToolCount;
  let totalCalls = 0;
  let totalDuplicateQueries = 0;
  let totalResultChars = 0;
  let totalEstimateTokens = 0;
  let invalidToolSelections = 0;
  let invalidIntents = 0;
  let parseErrors = 0;
  let emptyResults = 0;
  let timeouts = 0;
  let errors = 0;
  let sourceRefsValid = 0;
  let sourceRefsInvalid = 0;
  let cumulativeLatency = 0;
  let firstValidEvidence: { callIndex: number; cumulativeLatencyMs: number } | null = null;
  const invalidByCategory: Record<InvalidSourceRefCategory, number> = {
    no_match: 0,
    profile_only: 0,
    empty: 0,
    other: 0,
  };

  for (const t of turns) {
    if (t.decision.kind === "final") continue;
    totalCalls++;
    totalDuplicateQueries += t.duplicateQuery ? 1 : 0;
    totalResultChars += t.resultChars;
    totalEstimateTokens += t.estimateTokens;
    if (t.selectedTool === null || !t.routedOk) invalidToolSelections++;
    if (t.intent !== null && !t.intentValid) invalidIntents++;
    if (t.parseError) parseErrors++;
    if (t.empty) emptyResults++;
    if (t.timeout) timeouts++;
    if (t.isError) errors++;
    if (t.sourceRefValid) sourceRefsValid++;
    else {
      sourceRefsInvalid++;
      if (t.sourceRefInvalidCategory) invalidByCategory[t.sourceRefInvalidCategory]++;
    }
    cumulativeLatency += t.latencyMs;
    if (t.firstValidEvidence) {
      firstValidEvidence = { callIndex: totalCalls - 1, cumulativeLatencyMs: cumulativeLatency };
    }
  }

  const coverage = computeMustVerifyCoverage(mustVerifyItems, allConfirmed);
  return {
    scenarioId: scenario.id,
    category: scenario.category,
    arm,
    seed,
    turns,
    toolSurface,
    schemaTokenCost,
    totalCalls,
    totalDuplicateQueries,
    totalResultChars,
    totalEstimateTokens,
    invalidToolSelections,
    invalidIntents,
    parseErrors,
    firstValidEvidence,
    emptyResults,
    timeouts,
    errors,
    sourceRefsValid,
    sourceRefsInvalid,
    invalidSourceRefByCategory: invalidByCategory,
    sourceRefCompleteness: totalCalls > 0 ? sourceRefsValid / totalCalls : 1,
    mustVerify: {
      itemCount: mustVerifyItems.length,
      coveredCount: mustVerifyItems.length - coverage.uncoveredItems.length,
      coverageRatio: coverage.coverageRatio,
      uncoveredItems: coverage.uncoveredItems,
    },
  };
}

// ============================================================================
// 聚合 + 门槛
// ============================================================================

function aggregateRealArm(metrics: RealToolAbScenarioMetrics[]): RealToolAbArmAggregation {
  const invalidByCategory: Record<InvalidSourceRefCategory, number> = {
    no_match: 0,
    profile_only: 0,
    empty: 0,
    other: 0,
  };
  const firstLatency: number[] = [];
  let avgCoverageSum = 0;

  for (const m of metrics) {
    for (const [k, v] of Object.entries(m.invalidSourceRefByCategory)) {
      invalidByCategory[k as InvalidSourceRefCategory] += v;
    }
    if (m.firstValidEvidence !== null) firstLatency.push(m.firstValidEvidence.cumulativeLatencyMs);
    avgCoverageSum += m.mustVerify.coverageRatio;
    void m.schemaTokenCost;
  }

  return {
    toolSurface: metrics[0]?.toolSurface ?? 0,
    schemaTokenCost: metrics[0]?.schemaTokenCost ?? 0,
    totalCalls: metrics.reduce((s, m) => s + m.totalCalls, 0),
    totalDuplicateQueries: metrics.reduce((s, m) => s + m.totalDuplicateQueries, 0),
    totalResultChars: metrics.reduce((s, m) => s + m.totalResultChars, 0),
    totalEstimateTokens: metrics.reduce((s, m) => s + m.totalEstimateTokens, 0),
    invalidToolSelections: metrics.reduce((s, m) => s + m.invalidToolSelections, 0),
    invalidIntents: metrics.reduce((s, m) => s + m.invalidIntents, 0),
    parseErrors: metrics.reduce((s, m) => s + m.parseErrors, 0),
    emptyResults: metrics.reduce((s, m) => s + m.emptyResults, 0),
    timeouts: metrics.reduce((s, m) => s + m.timeouts, 0),
    errors: metrics.reduce((s, m) => s + m.errors, 0),
    sourceRefsValid: metrics.reduce((s, m) => s + m.sourceRefsValid, 0),
    sourceRefsInvalid: metrics.reduce((s, m) => s + m.sourceRefsInvalid, 0),
    invalidSourceRefByCategory: invalidByCategory,
    sourceRefCompleteness:
      metrics.reduce((s, m) => s + m.sourceRefsValid, 0) /
      (metrics.reduce((s, m) => s + m.totalCalls, 0) || 1),
    avgCoverageRatio: metrics.length > 0 ? avgCoverageSum / metrics.length : 0,
    firstValidEvidenceLatencyMs:
      firstLatency.length > 0 ? firstLatency.reduce((a, b) => a + b, 0) / firstLatency.length : null,
  };
}

/** 门槛判定：mustVerify/sourceRef/无效分类不降级 + 至少一项真实负担指标改善 */
function evaluateRealGate(A: RealToolAbArmAggregation, B: RealToolAbArmAggregation): RealToolAbGate {
  const mustVerifyCoverageNotDegraded = B.avgCoverageRatio >= A.avgCoverageRatio - 1e-9;
  const sourceRefCompletenessNotDegraded = B.sourceRefCompleteness >= A.sourceRefCompleteness - 1e-9;
  const invalidTotalA =
    A.invalidSourceRefByCategory.no_match + A.invalidSourceRefByCategory.profile_only + A.invalidSourceRefByCategory.empty;
  const invalidTotalB =
    B.invalidSourceRefByCategory.no_match + B.invalidSourceRefByCategory.profile_only + B.invalidSourceRefByCategory.empty;
  const invalidSourceRefNotWorsened = invalidTotalB <= invalidTotalA;

  // 负担改善项（至少一项）：schema token / 非法工具选择 / 首证延迟 / 重复查询
  const improvedBurdenMetrics: string[] = [];
  if (B.schemaTokenCost < A.schemaTokenCost) improvedBurdenMetrics.push("schemaTokenCost");
  if (B.invalidToolSelections < A.invalidToolSelections) improvedBurdenMetrics.push("invalidToolSelections");
  if (B.invalidIntents < A.invalidIntents) improvedBurdenMetrics.push("invalidIntents");
  if (B.parseErrors < A.parseErrors) improvedBurdenMetrics.push("parseErrors");
  if (
    B.totalDuplicateQueries < A.totalDuplicateQueries &&
    A.totalDuplicateQueries > 0
  ) {
    improvedBurdenMetrics.push("duplicateQueries");
  }
  if (
    B.firstValidEvidenceLatencyMs !== null &&
    A.firstValidEvidenceLatencyMs !== null &&
    B.firstValidEvidenceLatencyMs < A.firstValidEvidenceLatencyMs
  ) {
    improvedBurdenMetrics.push("firstEvidenceLatency");
  }
  const burdenImproved = improvedBurdenMetrics.length > 0;

  return {
    mustVerifyCoverageNotDegraded,
    sourceRefCompletenessNotDegraded,
    invalidSourceRefNotWorsened,
    burdenImproved,
    improvedBurdenMetrics,
    allPassed:
      mustVerifyCoverageNotDegraded &&
      sourceRefCompletenessNotDegraded &&
      invalidSourceRefNotWorsened &&
      burdenImproved,
    details: {
      mustVerifyCoverage: `B=${B.avgCoverageRatio.toFixed(3)} >= A=${A.avgCoverageRatio.toFixed(3)}`,
      sourceRefCompleteness: `B=${B.sourceRefCompleteness.toFixed(3)} >= A=${A.sourceRefCompleteness.toFixed(3)}`,
      invalidSourceRef: `B=${invalidTotalB} <= A=${invalidTotalA}`,
      burdenImproved: `改善项：${improvedBurdenMetrics.join(", ") || "无"}`,
    },
  };
}

// ============================================================================
// 主入口：3 场景 × 3 seed × A/B 成对
// ============================================================================

/** 高信号场景 ID 子集（canon / mixed / low-risk） */
export const HIGH_SIGNAL_SCENARIO_IDS = ["SC1-canon-fact", "SC7-multi-tool-mixed", "SC6-low-risk-no-retrieval"];

/**
 * 运行真实模型 A/B replay（dry-run 或真实模型）。
 *
 * 默认使用 dry-run stub（零 API）。真实模型需显式传入 `modelFn`（经授权后）。
 * 3 高信号场景 × `seeds` 个 seed × A/B 成对。
 */
export async function runRealToolAbReplay(options: {
  modelFn?: ToolAbModelFn;
  seeds?: number[];
  scenarios?: BaselineScenario[];
  timestamp?: string;
} = {}): Promise<RealToolAbComparison> {
  const seeds = options.seeds ?? [0, 1, 2];
  const scenarioPool = options.scenarios ?? BASELINE_SCENARIOS;
  const scenarios = scenarioPool.filter((s) => HIGH_SIGNAL_SCENARIO_IDS.includes(s.id));
  const providedModelFn = options.modelFn;

  const pairs: RealToolAbPair[] = [];
  for (const scenario of scenarios) {
    const armMetrics: Record<"A" | "B", RealToolAbScenarioMetrics[]> = { A: [], B: [] };
    for (const seed of seeds) {
      for (const arm of ["A", "B"] as const) {
        const modelFn = providedModelFn ?? createDryRunModel(scenario, arm);
        const metrics = await runRealToolAbScenario({
          scenario,
          arm,
          seed,
          modelFn,
        });
        armMetrics[arm].push(metrics);
      }
    }
    pairs.push({
      scenarioId: scenario.id,
      category: scenario.category,
      A: armMetrics.A,
      B: armMetrics.B,
    });
  }

  // 跨全部场景 × 全部 seed 聚合（保证 3-seed 都参与门槛判定）
  const A = aggregateRealArm(pairs.flatMap((p) => p.A));
  const B = aggregateRealArm(pairs.flatMap((p) => p.B));
  const gate = evaluateRealGate(A, B);

  return {
    schema: "tool-ab-real-comparison/v1",
    timestamp: options.timestamp ?? new Date().toISOString(),
    phase: "phase4-tool-ab-real",
    mode: providedModelFn ? "real" : "dry-run",
    scenarios: pairs,
    aggregation: { A, B },
    gate,
  };
}

// ============================================================================
// 报告格式化
// ============================================================================

export function formatRealToolAbJson(comparison: RealToolAbComparison): string {
  return JSON.stringify(comparison, null, 2);
}

export function formatRealToolAbMarkdown(comparison: RealToolAbComparison): string {
  const lines: string[] = [];
  lines.push("# NovelOS Phase 4.2 真实模型 A/B 对比报告（specialized-9-tools vs typed facade）");
  lines.push("");
  lines.push(`**schema**：${comparison.schema}`);
  lines.push(`**时间**：${comparison.timestamp}`);
  lines.push(`**阶段**：${comparison.phase}`);
  lines.push(`**模式**：${comparison.mode === "dry-run" ? "dry-run（确定性 stub，零 API）" : "real（真实模型，需授权）"}`);
  lines.push("");
  lines.push("## 门禁结论");
  lines.push("");
  lines.push("| 门禁 | 结论 | 详情 |");
  lines.push("|------|------|------|");
  lines.push(`| mustVerify 覆盖率不降级 | ${comparison.gate.mustVerifyCoverageNotDegraded ? "✓" : "✗"} | ${comparison.gate.details.mustVerifyCoverage} |`);
  lines.push(`| 有效证据引用率不降级 | ${comparison.gate.sourceRefCompletenessNotDegraded ? "✓" : "✗"} | ${comparison.gate.details.sourceRefCompleteness} |`);
  lines.push(`| 无效 sourceRef 分类不恶化 | ${comparison.gate.invalidSourceRefNotWorsened ? "✓" : "✗"} | ${comparison.gate.details.invalidSourceRef} |`);
  lines.push(`| 至少一项负担改善 | ${comparison.gate.burdenImproved ? "✓" : "✗"} | ${comparison.gate.details.burdenImproved} |`);
  lines.push("");
  lines.push(`**全部通过**：${comparison.gate.allPassed ? "是" : "否"}`);
  lines.push("");
  lines.push("## 聚合指标");
  lines.push("");
  lines.push("| 指标 | A 组（9 专用工具） | B 组（typed facade） |");
  lines.push("|------|------|------|");
  const agg = comparison.aggregation;
  lines.push(`| schema token 成本 | ${agg.A.schemaTokenCost} | ${agg.B.schemaTokenCost} |`);
  lines.push(`| 可见工具数 | ${agg.A.toolSurface} | ${agg.B.toolSurface} |`);
  lines.push(`| 总调用 | ${agg.A.totalCalls} | ${agg.B.totalCalls} |`);
  lines.push(`| 重复查询 | ${agg.A.totalDuplicateQueries} | ${agg.B.totalDuplicateQueries} |`);
  lines.push(`| 非法工具选择 | ${agg.A.invalidToolSelections} | ${agg.B.invalidToolSelections} |`);
  lines.push(`| 非法 intent | ${agg.A.invalidIntents} | ${agg.B.invalidIntents} |`);
  lines.push(`| 参数解析/路由失败 | ${agg.A.parseErrors} | ${agg.B.parseErrors} |`);
  lines.push(`| 首次有效证据平均延迟(ms) | ${agg.A.firstValidEvidenceLatencyMs?.toFixed(0) ?? "unmeasured"} | ${agg.B.firstValidEvidenceLatencyMs?.toFixed(0) ?? "unmeasured"} |`);
  lines.push(`| 总返回字符 | ${agg.A.totalResultChars} | ${agg.B.totalResultChars} |`);
  lines.push(`| 估算 token | ${agg.A.totalEstimateTokens} | ${agg.B.totalEstimateTokens} |`);
  lines.push(`| 空结果 | ${agg.A.emptyResults} | ${agg.B.emptyResults} |`);
  lines.push(`| 超时 | ${agg.A.timeouts} | ${agg.B.timeouts} |`);
  lines.push(`| 失败 | ${agg.A.errors} | ${agg.B.errors} |`);
  lines.push(`| 有效 sourceRef | ${agg.A.sourceRefsValid} | ${agg.B.sourceRefsValid} |`);
  lines.push(`| 无效 sourceRef | ${agg.A.sourceRefsInvalid} | ${agg.B.sourceRefsInvalid} |`);
  lines.push(`| 有效证据引用率 | ${agg.A.sourceRefCompleteness.toFixed(3)} | ${agg.B.sourceRefCompleteness.toFixed(3)} |`);
  lines.push(`| 平均 mustVerify 覆盖率 | ${agg.A.avgCoverageRatio.toFixed(3)} | ${agg.B.avgCoverageRatio.toFixed(3)} |`);
  lines.push("");
  lines.push("### 无效 sourceRef 分类明细（预期分类，非失败率）");
  lines.push("");
  lines.push("| 分类 | A 组 | B 组 | 说明 |");
  lines.push("|------|------|------|------|");
  lines.push(`| no_match | ${agg.A.invalidSourceRefByCategory.no_match} | ${agg.B.invalidSourceRefByCategory.no_match} | 检索无匹配，预期输出 |`);
  lines.push(`| profile_only | ${agg.A.invalidSourceRefByCategory.profile_only} | ${agg.B.invalidSourceRefByCategory.profile_only} | 风格档案降级引用 |`);
  lines.push(`| empty | ${agg.A.invalidSourceRefByCategory.empty} | ${agg.B.invalidSourceRefByCategory.empty} | 空结果/空引用 |`);
  lines.push(`| other | ${agg.A.invalidSourceRefByCategory.other} | ${agg.B.invalidSourceRefByCategory.other} | 其他无效形态 |`);
  lines.push("");
  lines.push("> 有效证据引用率 = 有效 sourceRef / 总调用。分母含预期的 no_match / profile_only / empty 分类，");
  lines.push("> 它们代表\"本次调用未产生有效事实引用\"，是工具在特定查询下的正常输出，**不是普通失败率**。");
  lines.push("");
  lines.push("## 各场景详情");
  lines.push("");
  for (const p of comparison.scenarios) {
    lines.push(`### ${p.scenarioId}（${p.category}）`);
    lines.push("");
    lines.push("| seed | A 首证 | B 首证 | A 覆盖 | B 覆盖 | schema A/B | 非法工具 A/B | 重复 A/B |");
    lines.push("|------|--------|--------|--------|--------|-----------|-------------|----------|");
    const n = Math.max(p.A.length, p.B.length);
    for (let i = 0; i < n; i++) {
      const a = p.A[i];
      const b = p.B[i];
      const aFirst = a?.firstValidEvidence ? `#${a.firstValidEvidence.callIndex}(${a.firstValidEvidence.cumulativeLatencyMs}ms)` : "无";
      const bFirst = b?.firstValidEvidence ? `#${b.firstValidEvidence.callIndex}(${b.firstValidEvidence.cumulativeLatencyMs}ms)` : "无";
      lines.push(
        `| ${i} | ${aFirst} | ${bFirst} | ${a?.mustVerify.coverageRatio.toFixed(3)} | ${b?.mustVerify.coverageRatio.toFixed(3)} | ${a?.schemaTokenCost}/${b?.schemaTokenCost} | ${a?.invalidToolSelections}/${b?.invalidToolSelections} | ${a?.totalDuplicateQueries}/${b?.totalDuplicateQueries} |`,
      );
    }
    const aAgg = aggregateRealArm(p.A);
    const bAgg = aggregateRealArm(p.B);
    lines.push("");
    lines.push(`- 场景聚合：A 平均覆盖=${aAgg.avgCoverageRatio.toFixed(3)}，B=${bAgg.avgCoverageRatio.toFixed(3)}；有效证据引用率 A=${aAgg.sourceRefCompleteness.toFixed(3)}，B=${bAgg.sourceRefCompleteness.toFixed(3)}`);
    lines.push(`- A 首证平均延迟=${aAgg.firstValidEvidenceLatencyMs === null ? "unmeasured" : aAgg.firstValidEvidenceLatencyMs.toFixed(0)}ms；B=${bAgg.firstValidEvidenceLatencyMs === null ? "unmeasured" : bAgg.firstValidEvidenceLatencyMs.toFixed(0)}ms`);
    lines.push("");
  }
  lines.push("## 说明");
  lines.push("");
  lines.push("- 本报告记录**模型自主决策**（非 oracle）：模型通过可见工具 schema 决定调用哪个工具/意图。");
  lines.push(`- 当前模式为 **${comparison.mode === "dry-run" ? "dry-run" : "real"}**${comparison.mode === "dry-run" ? "：确定性 stub 模型，零 API 调用，仅验证 runner 框架" : "：真实模型 replay，需授权" }。`);
  lines.push("- 3 高信号场景（canon / mixed / low-risk）× 3 seed × A/B 成对。");
  lines.push("- B 组 facade 为纯透传：检索/截断/nextQueryHint 由底层工具完成。");
  lines.push("");
  return lines.join("\n");
}

// ============================================================================
// trajectory 副本（持久化 trace 证据）
// ============================================================================

export function buildRealToolAbTrajectory(comparison: RealToolAbComparison): Record<
  string,
  Array<{ type: string; timestamp: number; data: unknown }>
> {
  const out: Record<string, Array<{ type: string; timestamp: number; data: unknown }>> = {};
  const base = Date.now();
  for (const p of comparison.scenarios) {
    for (const arm of ["A", "B"] as const) {
      const metricsArr = arm === "A" ? p.A : p.B;
      metricsArr.forEach((m, seedIdx) => {
        const key = `${p.scenarioId}:${arm}:${seedIdx}`;
        const entries: Array<{ type: string; timestamp: number; data: unknown }> = [];
        entries.push({
          type: "tool_visibility",
          timestamp: base,
          data: {
            systemAllowedTools: [m.toolSurface],
            selectedTools: m.turns.filter((t) => t.selectedTool).map((t) => t.selectedTool),
            rejectedTools: [],
            visibleTools: m.turns.filter((t) => t.selectedTool).map((t) => t.selectedTool),
          },
        });
        m.turns.forEach((t, idx) => {
          entries.push({
            type: "tool_call_metrics",
            timestamp: base + idx,
            data: {
              round: t.round,
              toolName: t.selectedTool ?? undefined,
              intent: t.intent ?? undefined,
              intentValid: t.intentValid,
              routedTool: t.routedTool ?? undefined,
              routedOk: t.routedOk,
              parseError: t.parseError ?? undefined,
              latencyMs: t.latencyMs,
              resultChars: t.resultChars,
              estimateTokens: t.estimateTokens,
              evidenceLevel: t.evidenceLevel ?? undefined,
              sourceRefs: t.sourceRef ? [t.sourceRef] : [],
              empty: t.empty,
              timeout: t.timeout,
              isError: t.isError,
              duplicateQuery: t.duplicateQuery,
              firstValidEvidence: t.firstValidEvidence,
              decisionKind: t.decision.kind,
            },
          });
        });
        out[key] = entries;
      });
    }
  }
  return out;
}

export function formatRealTrajectoryJsonl(
  entries: Array<{ type: string; timestamp: number; data: unknown }>,
): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}