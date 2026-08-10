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

import { createNarrativeTools, NARRATIVE_TOOL_NAMES } from "../tools/narrative-tools.js";
import {
  createTypedFacadeTool,
  QUERY_NARRATIVE_NAME,
  QUERY_NARRATIVE_INTENTS,
  TOOL_NAME_TO_INTENT,
  INTENT_TO_TOOL,
  CHINESE_TO_INTENT_MAP,
  type QueryNarrativeIntent,
} from "./typed-facade-tool.js";
import { injectToolSchemas } from "../adapters/tool-schema-injector.js";
import { parseToolCallDirectives } from "../adapters/react-tool-call-parser.js";
import type { AgentTool } from "../adapters/pi-agent-core-adapter.js";
import type { ModelGenerateFn } from "../../v2/adapters/legacy-model-route-adapter.js";
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
  EVIDENCE_LEVEL_STRENGTH_ORDER,
} from "./uncertainty-recall-metrics.js";
import { classifyInvalidSourceRef, type InvalidSourceRefCategory } from "./tool-ab-runner.js";
import type { ToolProtocol } from "../tools/tool-protocol.js";

// ============================================================================
// 评测边界常量
// ============================================================================

/** 终止标记：模型证据充分时只需输出此标记，禁止生成章节正文（评测边界） */
export const REAL_DONE_MARKER = "<done>";

/** re-export：供测试引用有效证据等级集合做口径校验 */
export { VALID_EVIDENCE_LEVELS, EVIDENCE_LEVEL_STRENGTH_ORDER } from "./uncertainty-recall-metrics.js";

/**
 * 检索决策 system prompt 基底（runner 注入工具 schema 后发送给模型）。
 *
 * 铁律：评测链路不得要求模型生成章节正文。模型只负责「按检索计划决定调用哪个工具、
 * 收集证据」，证据充分后输出终止标记即可，正文由生产统一编排器产出。
 */
export const REAL_SYSTEM_PROMPT_BASE =
  "你是检索驱动的叙事证据决策代理。请根据检索计划与可见工具，自主决定调用哪个工具收集证据；" +
  `证据充分后只需输出终止标记 ${REAL_DONE_MARKER} 即可，无需生成章节正文。`;

// ============================================================================
// B-safe Phase 5.3.3 策略3：从 args 字段推断 facade intent
// ============================================================================

/**
 * B-safe Phase 5.3.3 策略3：当模型已正确调用 `query_narrative`（工具名合法）但 intent
 * 字段非法（缺失/拼写错误/中文变体未命中）时，从 args 中的其他字段反推最可能的 intent。
 *
 * 策略1/2 只覆盖"工具名非法"的情形（directTool 不存在时进入）；策略3 补充"工具名合法
 * 但 intent 非法"的覆盖缺口（directTool 存在但 intent 不在 QUERY_NARRATIVE_INTENTS 内）。
 *
 * 推断优先级（基于 typed-facade-tool.ts 的参数 schema，越靠前置信度越高）：
 *   1. `status` 字段 → `promise`（唯一判别，仅 promise_ledger 使用 status 枚举）
 *   2. `patternType` 字段 → `pattern`（唯一判别，仅 pattern_memory 使用 patternType 枚举）
 *   3. `category` 字段 → `canon`（唯一判别，仅 canon 使用 category 枚举）
 *   4. `query` + `maxChapters` → `chapter_span`（maxChapters 仅 chapter_span 暴露）
 *   5. `query`（无 maxChapters）→ `evidence`（中置信，事实核验优先，默认首选）
 *   6. `characterId`（无其他判别字段）→ `character_state`（低置信，三义性中优先级最高）
 *   7. 无任何判别字段 → `null`（推断失败，保留非法 intent，计入 invalidIntents）
 *
 * 设计权衡：策略3 是"错误恢复"而非"精确路由"。当 intent 非法时，路由到错误工具的
 * 风险已被 facade 抛错（当前行为）所包含；推断成功则纠正错误，是净收益。推断失败时
 * 返回 null（不强制路由），让非法 intent 保留并计入 invalidIntents，保持门禁可观测性。
 *
 * @param args 模型原始决策的 arguments（可能含 query/category/characterId/status/patternType/maxChapters 等）
 * @returns 推断出的合法 intent，或 null（推断失败）
 */
export function inferIntentFromArgs(args: Record<string, unknown>): QueryNarrativeIntent | null {
  // 1. 唯一判别字段（高置信）：枚举字段仅被一个底层工具使用
  if (typeof args.status === "string" && args.status.length > 0) return "promise";
  if (typeof args.patternType === "string" && args.patternType.length > 0) return "pattern";
  if (typeof args.category === "string" && args.category.length > 0) return "canon";

  // 2. query + maxChapters 组合（高置信）：maxChapters 仅 chapter_span 暴露
  const hasQuery = typeof args.query === "string" && (args.query as string).length > 0;
  const hasMaxChapters = typeof args.maxChapters === "number";
  if (hasQuery && hasMaxChapters) return "chapter_span";
  if (hasQuery) return "evidence"; // 中置信，默认首选（事实核验优先）

  // 3. characterId（低置信）：character_state / knowledge_boundary / voice 三义性，
  //    character_state 优先级最高（INTENT_USAGE 标"中优先级"，其余中/低）
  if (typeof args.characterId === "string" && args.characterId.length > 0) {
    return "character_state";
  }

  // 4. 无任何判别字段 → 推断失败（保留非法 intent，计入 invalidIntents）
  return null;
}

// ============================================================================
// 模型决策抽象
// ============================================================================

/** 模型决策：调用工具 或 输出终止标记（不生成正文） */
export type ToolAbModelDecision =
  | {
      kind: "tool_call";
      toolName: string;
      intent?: string;
      arguments: Record<string, unknown>;
      /** 工具指令 JSON 解析失败原因（malformed directive；有则视为解析失败） */
      parseError?: string;
      /** 本次模型调用的真实采样/路由 provenance（真实模型；dry-run 无） */
      provenance?: ModelCallProvenance;
    }
  | { kind: "final"; text: string; provenance?: ModelCallProvenance };

/** 真实模型调用的采样/路由证据（PHASE4-2-1-1 provenance） */
export interface ModelCallProvenance {
  /** 实际使用的 provider（如 glm / doubao） */
  provider?: string;
  /** 实际使用的模型名 */
  model?: string;
  /** 请求路由（requested route） */
  route?: string;
  /** 实际生效的采样温度 */
  temperature?: number;
  /** seed 是否被透传并写入请求体 */
  seedApplied?: boolean;
  /** seed 是否被 provider 协议支持（支持才可能生效） */
  seedSupported?: boolean;
  /** 输出上限 token */
  maxTokens?: number;
  /** fallback 是否被关闭 */
  fallbackDisabled?: boolean;
}

/** 模型函数上下文 */
export interface ToolAbModelFnCtx {
  /** 检索执行计划 + 上下文 prompt（含 mustVerify 项） */
  prompt: string;
  /**
   * 已注入可见工具 schema 的 system prompt（真实模型用；dry-run stub 忽略）。
   * 由 runner 按 arm 注入（A=9 专用工具，B=query_narrative facade），
   * 使单一真实模型 fn 可同时服务 A/B 两组。
   */
  systemPrompt: string;
  /** 模型可见工具名（A=9 专用，B=query_narrative） */
  visibleTools: string[];
  /** 已发生的回合观测（供模型参考，含工具结果文本） */
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
  /** 模型选择的工具名是否在可见工具集内（仅名字，不涉参数） */
  toolVisible: boolean;
  /** 模型填写的 facade intent（仅 B 组） */
  intent: string | null;
  /** intent 是否合法（B 组 ∈ QUERY_NARRATIVE_INTENTS） */
  intentValid: boolean;
  /** intent 路由到的底层工具名（B 组合法 intent 映射；A 组 = selectedTool） */
  routedTool: string | null;
  /** 路由是否成功（工具可见 + intent 合法 + 工具存在 + 无 directive 解析失败） */
  routedOk: boolean;
  /** 工具指令 JSON 解析失败原因（malformed directive；无则 null） */
  directiveParseError: string | null;
  /** 路由失败原因（工具不在可见集 / intent 非法；无则 null） */
  parseError: string | null;
  latencyMs: number;
  resultChars: number;
  estimateTokens: number;
  evidenceLevel: string | undefined;
  /**
   * 本回合工具返回的**全部**有效证据等级（去重，来自 details.rankedEvidences）。
   *
   * 修正评测口径（Phase 4.3 收口）：单次调用可能折叠多个证据等级（如 confirmed_state +
   * exact_chapter_span 同回合返回），仅用 evidenceLevel 首条会低估 B 组折叠能力，
   * 造成 evidenceLevelNotDegraded 门禁在 exact_chapter_span 上误判降级。
   * 聚合 evidenceLevelCounts 时以本集合为准；无 rankedEvidences 时回退为 [evidenceLevel]。
   */
  rankedEvidenceLevels: string[];
  sourceRef: string | undefined;
  sourceRefValid: boolean;
  sourceRefInvalidCategory: InvalidSourceRefCategory | null;
  empty: boolean;
  timeout: boolean;
  isError: boolean;
  /** 结果是否被系统 limit 截断（设计文档 §5.6，失败行为门禁项） */
  truncated: boolean;
  /** 按语义操作身份判定的重复查询 */
  duplicateQuery: boolean;
  /** 是否为本场景首次有效证据回合 */
  firstValidEvidence: boolean;
  /** B-safe Phase 5.3.3：非法工具名是否被协议层纠正为 query_narrative + intent */
  toolSelectionCorrected: boolean;
  /** B-safe Phase 5.3.3：空结果是否触发 bounded retry（查询简化重试，最多 1 次） */
  emptyResultRetried: boolean;
  /**
   * 本回合产出的文本。
   * - final 回合：终止标记（REAL_DONE_MARKER），不承载正文
   * - tool_call 回合：工具执行返回的文本内容（供真实模型下一回合决策连续性参考）
   */
  resultText: string;
  /** 本回合模型调用的真实采样/路由 provenance（真实模型；dry-run 无） */
  provenance?: ModelCallProvenance;
}

// ============================================================================
// 场景执行结果 + 聚合 + 门槛
// ============================================================================

/** 单场景单 arm 单 seed 执行结果 */
export type RealToolAbArm = "A" | "B" | "B0" | "C" | "B-safe";

/** 是否为 facade 形态 arm（B=受引导，B0=无引导，C=受引导+compact envelope，B-safe=无引导+协议纠正） */
export function isFacadeArm(arm: RealToolAbArm): arm is "B" | "B0" | "C" | "B-safe" {
  return arm === "B" || arm === "B0" || arm === "C" || arm === "B-safe";
}

/** 工具模式：A=9 专用工具，B/B0/C=facade 单入口 */
export type RealToolAbToolMode = "specialized" | "facade";

/** 渲染模式：A/B/B0=raw 原始 content，C=compact envelope（调用 renderCompactEnvelope 剪裁 content） */
export type RealToolAbRenderMode = "raw" | "compact_envelope";

/** 由 arm 推导工具模式 */
export function toolModeOfArm(arm: RealToolAbArm): RealToolAbToolMode {
  return arm === "A" ? "specialized" : "facade";
}

/** 由 arm 推导渲染模式 */
export function renderModeOfArm(arm: RealToolAbArm): RealToolAbRenderMode {
  return arm === "C" ? "compact_envelope" : "raw";
}

/** 单场景单 arm 单 seed 执行结果 */
export interface RealToolAbScenarioMetrics {
  scenarioId: string;
  category: string;
  arm: RealToolAbArm;
  seed: number;
  turns: RealToolAbTurn[];
  toolSurface: number;
  schemaTokenCost: number;
  totalCalls: number;
  totalDuplicateQueries: number;
  totalResultChars: number;
  totalEstimateTokens: number;
  invalidToolSelections: number;
  /** B-safe Phase 5.3.3：协议层纠正的非法工具选择数（不计入 invalidToolSelections） */
  correctedToolSelections: number;
  /** B-safe Phase 5.3.3：空结果触发 bounded retry 的回合数（不计入 emptyResults 失败） */
  emptyResultRetried: number;
  invalidIntents: number;
  parseErrors: number;
  firstValidEvidence: { callIndex: number; cumulativeLatencyMs: number } | null;
  emptyResults: number;
  /** 结果被系统 limit 截断的调用数（设计文档 §5.6） */
  truncatedResults: number;
  timeouts: number;
  errors: number;
  /** 本场景是否由模型主动输出终止标记收敛（true）或预算耗尽被迫终止（false） */
  stopped: boolean;
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
  /** 本场景真实模型调用的采样/路由 provenance（首个非空回合；dry-run 无） */
  provenance?: ModelCallProvenance;
  /** 本场景工具模式（A=specialized / B/B0/C=facade） */
  toolMode: RealToolAbToolMode;
  /** 本场景渲染模式（A/B/B0=raw / C=compact_envelope） */
  renderMode: RealToolAbRenderMode;
}

/** 每场景 A/B/B0/C 成对结果（每 arm 持有每个 seed 的独立 metrics，供 3-seed 聚合与逐 seed 展示） */
export interface RealToolAbPair {
  scenarioId: string;
  category: string;
  A: RealToolAbScenarioMetrics[];
  B: RealToolAbScenarioMetrics[];
  /** B0 无 INTENT_USAGE 引导的 facade（单入口收益 vs 描述引导收益解耦） */
  B0: RealToolAbScenarioMetrics[];
  /** C 受引导 facade + compact envelope（仅剪裁模型可见 content，details 与 B 一致） */
  C: RealToolAbScenarioMetrics[];
  /** 逐场景失败行为门禁（B vs A：empty/truncated/errors/timeouts/非法工具/解析失败不恶化） */
  scenarioGate: RealToolAbScenarioGate;
  /** 逐场景失败行为门禁（B0 vs A） */
  scenarioGateB0: RealToolAbScenarioGate;
  /** 逐场景失败行为门禁（C vs A：envelope facade 失败行为不劣于 9 专用工具） */
  scenarioGateC: RealToolAbScenarioGate;
}

/** 逐场景失败行为门禁：B 组失败行为不劣于 A 组（跨 seed 求和后逐项比较） */
export interface RealToolAbScenarioGate {
  scenarioId: string;
  emptyResultsNotWorsened: boolean;
  truncatedNotWorsened: boolean;
  errorsNotWorsened: boolean;
  timeoutsNotWorsened: boolean;
  invalidToolSelectionsNotWorsened: boolean;
  parseErrorsNotWorsened: boolean;
  allFailingNotWorsened: boolean;
  details: Record<string, string>;
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
  /** B-safe Phase 5.3.3：协议层纠正的非法工具选择数（聚合，不计入 invalidToolSelections） */
  correctedToolSelections: number;
  /** B-safe Phase 5.3.3：空结果触发 bounded retry 的回合数（聚合） */
  emptyResultRetried: number;
  invalidIntents: number;
  parseErrors: number;
  emptyResults: number;
  /** 结果被系统 limit 截断的调用数（设计文档 §5.6） */
  truncatedResults: number;
  timeouts: number;
  errors: number;
  sourceRefsValid: number;
  sourceRefsInvalid: number;
  invalidSourceRefByCategory: Record<InvalidSourceRefCategory, number>;
  /** 各有效 evidenceLevel 的命中级计数（逐项门禁依据） */
  evidenceLevelCounts: Record<string, number>;
  sourceRefCompleteness: number;
  avgCoverageRatio: number;
  firstValidEvidenceLatencyMs: number | null;
  /** 场景总数（停止率分母） */
  scenarioCount: number;
  /** 模型主动输出终止标记收敛的场景数 */
  stopCount: number;
  /** 停止率 = stopCount / scenarioCount（观察模型是否在证据充分后收敛而非预算耗尽） */
  stopRate: number;
  /** 本 arm 真实模型调用的采样/路由 provenance（真实模式；dry-run 无） */
  provenance?: ModelCallProvenance;
  /** 本 arm 工具模式（A=specialized / B/B0/C=facade） */
  toolMode?: RealToolAbToolMode;
  /** 本 arm 渲染模式（A/B/B0=raw / C=compact_envelope） */
  renderMode?: RealToolAbRenderMode;
  /** 本 arm 真实模型指纹：`provider:model:route`（来自首个非空 provenance；dry-run 无） */
  fingerprint?: string;
}

/** 门槛判定：逐项不降级 + 至少一项真实负担指标改善 */
export interface RealToolAbGate {
  mustVerifyCoverageNotDegraded: boolean;
  sourceRefCompletenessNotDegraded: boolean;
  /** 无效 sourceRef 总数不恶化（保留兼容） */
  invalidSourceRefNotWorsened: boolean;
  /** 无效 sourceRef 逐分类（no_match/profile_only/empty/other）均不恶化 */
  invalidSourceRefCategoriesNotWorsened: boolean;
  /** 有效 evidenceLevel 逐级命中不降级（confirmed 等各等级 B 不显著低于 A） */
  evidenceLevelNotDegraded: boolean;
  /** 失败（isError）不恶化 */
  errorsNotWorsened: boolean;
  /** 超时（timeout）不恶化 */
  timeoutsNotWorsened: boolean;
  /** 空结果（emptyResults）不恶化（设计文档 §5.6） */
  emptyResultsNotWorsened: boolean;
  /** 结果截断（truncatedResults）不恶化（设计文档 §5.6） */
  truncatedNotWorsened: boolean;
  /** 非法工具选择（invalidToolSelections）不恶化 */
  invalidToolSelectionsNotWorsened: boolean;
  /** 解析失败（parseErrors）不恶化 */
  parseErrorsNotWorsened: boolean;
  /** 逐场景失败行为门禁全部通过（每场景 empty/truncated/errors/timeouts/非法工具/解析失败不恶化） */
  scenarioGatesPassed: boolean;
  burdenImproved: boolean;
  improvedBurdenMetrics: string[];
  allPassed: boolean;
  details: Record<string, string>;
}

/**
 * Phase 5.3 预注册：单场景/单调用结果膨胀门槛（envelope C vs B）。
 *
 * 用户核查指出（Phase 5.2 结论）：聚合 resultChars 下降可能掩盖局部膨胀（如 SC2 C=281>B=270、
 * SC5 C=274>B=228）。真实模型 replay 前必须把「单场景/单调用不可明显变长」纳入门禁，
 * 不能只看聚合下降。这里预注册因子与缓冲，replay 时逐场景/逐调用校验。
 *
 * 语义：C 的字符数允许略高于 B（envelope 对精简列表/短 span 有少量摘要开销），但
 * 不得超过 `factor × B + buffer`。超过即判定该场景/调用「明显膨胀」，门禁失败。
 */
export const ENVELOPE_EXPANSION_FACTOR = 1.5;
export const ENVELOPE_EXPANSION_BUFFER = 1;

/** envelope 门禁（C vs B）：结果文本不膨胀 + 证据覆盖与失败不降级 */
export interface EnvelopeRealGate {
  /** 契约：C 总返回字符 < B（envelope 收益，聚合口径，允许不膨胀） */
  resultCharsNotWorsened: boolean;
  /** 单场景膨胀门槛：每个场景 C.totalResultChars <= B.totalResultChars × factor + buffer */
  noScenarioExpansion: boolean;
  /** 单调用膨胀门槛：每个场景 C 最大单回合字符 <= B 最大单回合字符 × factor + buffer */
  noSingleCallExpansion: boolean;
  /** C mustVerify 覆盖率不降级（>= B） */
  coverageNotDegraded: boolean;
  /** C 有效证据引用率不降级（>= B） */
  sourceRefNotDegraded: boolean;
  /** C 停止率不显著低于 B（模型是否仍能在证据充分后主动收敛） */
  stopRateNotDegraded: boolean;
  /** C 失败行为（errors/timeouts/empty/truncated/非法工具/解析失败）不恶化 */
  failureNotDegraded: boolean;
  allPassed: boolean;
  details: Record<string, string>;
}

/** 完整真实模型 A/B/B0/C 对比 */
export interface RealToolAbComparison {
  schema: string;
  timestamp: string;
  phase: string;
  mode: "dry-run" | "real";
  scenarios: RealToolAbPair[];
  aggregation: {
    A: RealToolAbArmAggregation;
    B: RealToolAbArmAggregation;
    B0: RealToolAbArmAggregation;
    C: RealToolAbArmAggregation;
  };
  /** B vs A 门禁（受引导 facade vs 9 工具） */
  gate: RealToolAbGate;
  /** B0 vs A 门禁（无引导 facade vs 9 工具，隔离"单入口收益"） */
  gateB0: RealToolAbGate;
  /** C vs A 门禁（envelope facade vs 9 工具，隔离"compact envelope 形态"收益） */
  gateC: RealToolAbGate;
  /** envelope 门禁（C vs B）：结果文本不膨胀（含单场景/单调用）+ 证据覆盖与失败不降级 */
  envelopeGate: EnvelopeRealGate;
  /** 引导收益：B（受引导）与 B0（无引导）的负担/失败差异摘要 */
  guidanceDelta: {
    schemaTokenCost: { B: number; B0: number };
    invalidIntents: { B: number; B0: number };
    invalidToolSelections: { B: number; B0: number };
    totalCalls: { B: number; B0: number };
    totalDuplicateQueries: { B: number; B0: number };
    avgCoverageRatio: { B: number; B0: number };
    firstValidEvidenceLatencyMs: { B: number | null; B0: number | null };
    emptyResults: { B: number; B0: number };
    errors: { B: number; B0: number };
    stopRate: { B: number; B0: number };
  };
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

/**
 * 估算**实际注入后**的 system prompt 的 token 开销（按 ~2 字符/token 中文近似）。
 *
 * 与 estimateToolSchemaTokens（按原始工具 schema 估算）不同，这里度量的是
 * `injectToolSchemas` 产出的完整 system prompt（基座 + 调用约定 + 工具描述），
 * 是模型每回合真实支付的输入上下文成本。该成本需**按模型调用次数累计**（每回合
 * 模型都重新消费 system prompt），见 runRealToolAbScenario 的 schemaTokenCost 计算。
 */
export function estimateSystemPromptTokens(systemPrompt: string): number {
  return Math.ceil(systemPrompt.length / 2);
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
export function buildRealPrompt(scenario: BaselineScenario): string {
  const plan = scenario.calls
    .flatMap((c) => c.mustVerify ?? [])
    .map((q) => `- ${q}`)
    .join("\n");
  return [
    "本章需要验证以下事实（mustVerify）：",
    plan.length > 0 ? plan : "（无强制验证项）",
    "",
    "请根据你可见的工具检索所需证据；证据收集完成后只输出终止标记 " +
      `${REAL_DONE_MARKER}，禁止生成或输出任何章节正文。`,
  ].join("\n");
}

// ============================================================================
// dry-run 模型（确定性 stub，零 API）
// ============================================================================

/**
 * 创建 dry-run 模型函数：确定性地按场景 calls 顺序生成工具调用决策。
 *
 * - A 组：toolName = call.tool（专用工具名），arguments = call.args
 * - B / B0 组：toolName = query_narrative，intent = TOOL_NAME_TO_INTENT[call.tool]，
 *   arguments = { intent, ...call.args }
 *
 * 所有 calls 结束后返回 final。该 stub 验证 runner 框架（注入/校验/路由/指标），
 * 不代表真实模型质量结论。B 与 B0 在 dry-run 下路由行为一致（都是 facade 形态），
 * 区别仅在 injected schema 的 description 是否含 INTENT_USAGE 引导。
 */
export function createDryRunModel(scenario: BaselineScenario, arm: RealToolAbArm): ToolAbModelFn {
  return async (ctx) => {
    if (ctx.round >= scenario.calls.length) {
      return { kind: "final", text: REAL_DONE_MARKER };
    }
    const call = scenario.calls[ctx.round];
    if (arm === "A") {
      return { kind: "tool_call", toolName: call.tool, arguments: call.args };
    }
    // B / B0 / B-safe 组：intent 由 TOOL_NAME_TO_INTENT 决定（stub 模拟模型理解 facade 语义）。
    // B-safe 的协议纠正（非法工具名映射）与空结果 bounded retry 仅在真实模型犯错时触发，
    // dry-run stub 不犯错，故 B-safe dry-run 行为与 B0 一致（协议纠正路径不被 exercised）。
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
// 真实模型决策（ReAct text 指令，需授权后启用）
// ============================================================================

/** createRealModelDecide 选项 */
export interface RealModelDecideOptions {
  /** 真实模型调用函数（Sub2API/GLM/Doubao，经授权） */
  modelFn: ModelGenerateFn;
  /** 模型路由名（如 narrator_testing_glm） */
  route: string;
  /** 输出上限 token */
  maxTokens?: number;
  /** 单次调用超时 ms */
  timeoutMs?: number;
  /** 采样温度 */
  temperature?: number;
}

/**
 * 把真实模型调用包装成 ToolAbModelFn（ReAct text 指令协议）。
 *
 * 与 dry-run 一致地使用 `<tool_call>{...}</tool_call>` 文本指令：
 * - system prompt = runner 注入的可见工具 schema（ctx.systemPrompt）
 * - user prompt = 检索计划 + 已发生回合（含工具结果文本，供决策连续性）
 * - 模型输出经 parseToolCallDirectives 解析：
 *   - 含指令 → 返回 tool_call 决策（facade 时提取 intent）
 *   - 无指令 → 返回 final 正文
 *
 * 授权边界：本函数只包装模型调用，不触发生成；真实 API 由调用方经 modelFn 授权。
 */
export function createRealModelDecide(options: RealModelDecideOptions): ToolAbModelFn {
  return async (ctx): Promise<ToolAbModelDecision> => {
    const systemPrompt = ctx.systemPrompt || "你是检索驱动的叙事证据决策代理。";
    const userPrompt = buildRealUserPrompt(ctx);
    const out = await options.modelFn({
      route: options.route,
      systemPrompt,
      userPrompt,
      kind: "tool_ab_real_decision",
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs,
      temperature: options.temperature,
      seed: ctx.seed,
    });

    const parsed = parseToolCallDirectives(out.text);
    // 真实采样/路由 provenance：从模型输出透传（provider/model/route/effective temperature/seed 支持）。
    const provenance: ModelCallProvenance = {
      provider: out.provider,
      model: out.model,
      route: out.route,
      temperature: out.actuallyAppliedTemperature ?? options.temperature,
      maxTokens: out.maxTokens ?? options.maxTokens,
      seedApplied: out.seedApplied,
      seedSupported: out.seedSupported,
      fallbackDisabled: out.fallbackDisabled,
    };
    if (parsed.hasToolCall) {
      const call = parsed.toolCalls[0];
      const args = call.arguments;
      // facade 场景：从 arguments 提取 intent 供 runner 校验 + 路由。
      // 模型经 schema 注入看到的是中文意图标签，需映射回英文协议值，
      // 使 runner 的 QUERY_NARRATIVE_INTENTS 校验与底层 INTENT_TO_TOOL 路由成立。
      const rawIntent = typeof args.intent === "string" ? args.intent.trim() : undefined;
      const intent =
        rawIntent && CHINESE_TO_INTENT_MAP[rawIntent]
          ? CHINESE_TO_INTENT_MAP[rawIntent]
          : rawIntent;
      // 若工具指令 JSON 解析失败（malformed directive），把失败原因透传给 runner 记录 parseErrors。
      const parseError =
        parsed.parseFailures.length > 0
          ? `第 ${parsed.parseFailures[0].index + 1} 个工具调用指令 JSON 解析失败：` +
            `${parsed.parseFailures[0].rawJson.slice(0, 80) || "（无法定位指令内容）"}`
          : undefined;
      return {
        kind: "tool_call",
        toolName: call.name,
        intent,
        arguments: intent !== rawIntent ? { ...args, intent } : args,
        parseError,
        provenance,
      };
    }
    // 无工具指令 → 证据充分，只返回终止标记，不生成正文（评测边界）。
    return { kind: "final", text: REAL_DONE_MARKER, provenance };
  };
}

/**
 * 便捷工厂：用 legacy ModelGenerateFn 构造真实模型决策 fn。
 *
 * 动态 import legacy-model-route-adapter（经 Sub2API/GLM fallback 网关），
 * 默认路由 narrator_testing_glm（glm-5.2）。临时/批量测试须显式
 * PINOVEL_DISABLE_FALLBACK=1 且只允许 GLM/Doubao，禁止 fallback 到按量模型。
 */
export async function createRealToolAbModelDecide(options: {
  route?: string;
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
} = {}): Promise<ToolAbModelFn> {
  const { createLegacyModelGenerateFn } = await import(
    "../../v2/adapters/legacy-model-route-adapter.js"
  );
  const modelFn = createLegacyModelGenerateFn();
  return createRealModelDecide({
    modelFn,
    route: options.route ?? process.env.PINOVEL_TOOL_AB_ROUTE ?? "narrator_testing_glm",
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
    temperature: options.temperature,
  });
}

/**
 * 从 ctx 构建 user prompt：检索计划 + 已发生回合（模型决策 + 工具结果文本）。
 *
 * 真实模型是 text-only，看不到结构化 toolResult，必须把工具结果文本回灌到
 * user prompt，模型才能基于证据继续决策（决策连续性）。
 */
export function buildRealUserPrompt(ctx: ToolAbModelFnCtx): string {
  const lines: string[] = [ctx.prompt];
  for (const t of ctx.history) {
    lines.push(`-- 第 ${t.round + 1} 回合 --`);
    if (t.decision.kind === "final") {
      lines.push(`模型已输出终止标记（证据充分）。`);
      continue;
    }
    lines.push(`工具调用：${t.selectedTool ?? "?"}`);
    if (t.intent) lines.push(`intent：${t.intent}`);
    if (t.parseError) {
      lines.push(`结果：错误（${t.parseError}）`);
    } else if (t.resultText) {
      lines.push(`结果：\n${t.resultText}`);
    } else {
      lines.push(`结果：（空）`);
    }
  }
  return lines.join("\n");
}

// ============================================================================
// 单场景单 arm 执行
// ============================================================================

/**
 * 运行一个场景的单个 arm（注入对应工具面，驱动 ToolAbModelFn 直至 final 或预算耗尽）。
 *
 * @param scenario 场景定义
 * @param arm A（9 专用工具）/ B（受引导 facade）/ B0（无引导 facade）
 * @param seed 随机种子
 * @param modelFn 模型决策函数（dry-run stub 或真实模型）
 * @param maxModelCalls 模型工具调用预算（默认与场景 calls 数一致，dry-run 用）
 * @param timeoutMs 单次工具执行超时
 */
export async function runRealToolAbScenario(options: {
  scenario: BaselineScenario;
  arm: RealToolAbArm;
  seed: number;
  modelFn: ToolAbModelFn;
  maxModelCalls?: number;
  timeoutMs?: number;
  /** Phase 5.3.2 消融：显式指定引导变体（透传到 createTypedFacadeTool） */
  guidanceVariant?: "old" | "new";
  /**
   * Phase 8 Stage P（Prompt-only）eval 注入：覆盖检索决策 system prompt 基座。
   *
   * 默认 REAL_SYSTEM_PROMPT_BASE（通用基线）。Stage P 的 P-B 臂传
   * gemini-prompt-library.ts 的 GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE（Gemini 专属），
   * 与 P-A（通用）对比时，工具面/上下文/预算/模型 route 完全一致，只变化 systemPrompt，
   * 使 Prompt 收益可独立归因。未传则不改变现有行为。
   */
  systemPromptBase?: string;
}): Promise<RealToolAbScenarioMetrics> {
  const { scenario, arm, seed, modelFn } = options;
  const maxModelCalls = options.maxModelCalls ?? scenario.calls.length;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const facadeArm = isFacadeArm(arm);

  const { projectRoot, workspaceId, cleanup } = setupBaselineWorkspace(scenario.workspace);
  const dupTracker = new SemanticDupTracker();
  const turns: RealToolAbTurn[] = [];
  const allConfirmed: ConfirmedEvidence[] = [];
  // 场景全部 calls 的 mustVerify 项（独立于模型 round 顺序，真实模型不会严格按 call 索引调用）
  const mustVerifyItems: string[] = scenario.calls.flatMap((c) => c.mustVerify ?? []);
  let firstValidFound = false;
  let injectedToolCount = 0;
  // 修复3：schema token = 实际注入 systemPrompt 的估算 token；在 try 内赋值，try 外汇总使用。
  let systemPromptTokens = 0;

  try {
    const searchService = createNarrativeSearchService({
      projectRoot,
      workspaceId,
      sourceChapter: `ch${scenario.workspace.historicalChapters.length}`,
    });
    // 注入工具面：A=9 专用工具，B=受引导 facade，B0=无引导 facade（includeIntentGuidance=false），
    // C=受引导 facade + compact envelope（useCompactEnvelope=true，仅剪裁模型可见 content）。
    const tools: ToolProtocol[] =
      arm === "A"
        ? createNarrativeTools({ searchService })
        : [
            createTypedFacadeTool({
              searchService,
              includeIntentGuidance: arm === "B" || arm === "C",
              useCompactEnvelope: arm === "C",
              guidanceVariant: options.guidanceVariant,
            }),
          ];
    const toolByName = new Map(tools.map((t) => [t.name, t]));
    const visibleTools = tools.map((t) => t.name).sort();
    injectedToolCount = tools.length;

    // 按 arm 注入可见工具 schema 到 system prompt（A=9 专用工具，B/B0=facade）。
    // allowedToolNames 白名单 fail-closed：A 用叙事白名单，B/B0 用 facade 名。
    // 修复1：基座 prompt 只要求输出终止标记，不要求生成正文（评测边界）。
    // Phase 4.2.2：启用 decision-only 注入模式，去除注入器中的正文诱导
    // （"基于证据生成正文/证据充分时直接输出章节正文"），只允许输出终止标记。
    const systemPrompt = injectToolSchemas(
      options.systemPromptBase ?? REAL_SYSTEM_PROMPT_BASE,
      tools as unknown as AgentTool[],
      arm === "A" ? NARRATIVE_TOOL_NAMES : new Set([QUERY_NARRATIVE_NAME]),
      { decisionOnly: true, doneMarker: REAL_DONE_MARKER },
    );
    // 修复3：schema token 按「实际注入后的 system prompt」估算，并按模型调用次数累计。
    systemPromptTokens = estimateSystemPromptTokens(systemPrompt);

    const prompt = buildRealPrompt(scenario);

    for (let round = 0; round < maxModelCalls; round++) {
      // 修复4b：timeoutMs 真正包住模型决策调用（而非仅工具执行）。
      let decision: ToolAbModelDecision;
      const decisionStart = Date.now();
      try {
        decision = await withTimeout(
          modelFn({
            prompt,
            systemPrompt,
            visibleTools: [...visibleTools],
            history: [...turns],
            round,
            seed,
          }),
          timeoutMs,
          `模型决策第 ${round + 1} 回合`,
        );
      } catch (err) {
        // 模型决策超时：记录为 timeout 回合并终止本场景（模型卡死无法继续）。
        const msg = err instanceof Error ? err.message : String(err);
        turns.push({
          round,
          decision: { kind: "tool_call", toolName: "", arguments: {}, parseError: msg },
          selectedTool: null,
          toolVisible: false,
          intent: null,
          intentValid: false,
          routedTool: null,
          routedOk: false,
          directiveParseError: null,
          parseError: msg,
          latencyMs: Date.now() - decisionStart,
          resultChars: 0,
          estimateTokens: 0,
          evidenceLevel: undefined,
          rankedEvidenceLevels: [],
          sourceRef: undefined,
          sourceRefValid: false,
          sourceRefInvalidCategory: "empty",
          empty: true,
          timeout: true,
          isError: true,
          truncated: false,
          duplicateQuery: false,
          firstValidEvidence: false,
          toolSelectionCorrected: false,
          emptyResultRetried: false,
          resultText: msg,
        });
        break;
      }

      if (decision.kind === "final") {
        // 核对：final 只承载终止标记，不返回正文（评测边界）。
        turns.push({
          round,
          decision,
          selectedTool: null,
          toolVisible: false,
          intent: null,
          intentValid: false,
          routedTool: null,
          routedOk: true,
          directiveParseError: null,
          parseError: null,
          latencyMs: Date.now() - decisionStart,
          resultChars: decision.text.length,
          estimateTokens: Math.ceil(decision.text.length / 2),
          evidenceLevel: undefined,
          rankedEvidenceLevels: [],
          sourceRef: undefined,
          sourceRefValid: false,
          sourceRefInvalidCategory: null,
          empty: false,
          timeout: false,
          isError: false,
          truncated: false,
          duplicateQuery: false,
          firstValidEvidence: false,
          toolSelectionCorrected: false,
          emptyResultRetried: false,
          resultText: decision.text,
        });
        break;
      }

      const rawToolName = decision.toolName;
      const rawIntent = decision.intent ?? null;
      const directiveParseError = decision.parseError ?? null;
      const toolCallId = `real-${scenario.id}-${arm}-${seed}-${round}`;
      const start = Date.now();
      let isError = false;
      let result: unknown = null;

      // B-safe Phase 5.3.3：协议层纠正——非法工具名/非法 intent 自动映射到 query_narrative + 合法 intent
      // 三层纠正策略（互补覆盖"工具名非法"与"工具名合法但 intent 非法"两种情形）：
      //   1. 已知底层工具名（TOOL_NAME_TO_INTENT）：直接映射到对应 intent（工具名非法 → 合法）
      //   2. 未知工具名（幻觉/中文变体）：若参数中含合法 intent，用该 intent 路由到 query_narrative；
      //      否则不纠正（保留非法工具名，计入 invalidToolSelections）
      //   3. 工具名合法（query_narrative）但 intent 非法：先尝试中文变体转换，仍非法则从 args 字段推断
      //      （inferIntentFromArgs）；推断失败则保留非法 intent，计入 invalidIntents
      let toolName = rawToolName;
      let intent = rawIntent;
      let args = decision.arguments;
      let toolSelectionCorrected = false;
      // B-safe Phase 5.3.3：空结果 bounded retry（查询简化重试，最多 1 次）
      let emptyResultRetried = false;

      if (arm === "B-safe" && directiveParseError === null) {
        const directTool = toolByName.get(rawToolName);
        if (!directTool) {
          // 策略1：已知底层工具名映射
          const mappedIntent = TOOL_NAME_TO_INTENT[rawToolName];
          if (mappedIntent) {
            toolName = QUERY_NARRATIVE_NAME;
            intent = mappedIntent;
            args = { ...decision.arguments, intent: mappedIntent };
            toolSelectionCorrected = true;
          } else {
            // 策略2：未知工具名但参数含合法 intent → 用 intent 路由
            const argsIntent = typeof (decision.arguments as { intent?: unknown }).intent === "string"
              ? (decision.arguments as { intent: string }).intent
              : undefined;
            const protocolIntent = argsIntent && CHINESE_TO_INTENT_MAP[argsIntent]
              ? CHINESE_TO_INTENT_MAP[argsIntent]
              : argsIntent;
            if (protocolIntent && QUERY_NARRATIVE_INTENTS.includes(protocolIntent as (typeof QUERY_NARRATIVE_INTENTS)[number])) {
              toolName = QUERY_NARRATIVE_NAME;
              intent = protocolIntent;
              args = { ...decision.arguments, intent: protocolIntent };
              toolSelectionCorrected = true;
            }
          }
        } else {
          // 策略3：工具名合法（query_narrative）但 intent 非法 → 先尝试中文变体转换，仍非法则从 args 推断
          // 覆盖策略1/2 的缺口：directTool 存在时策略1/2 不进入，但 intent 可能非法
          const protocolIntent = rawIntent && CHINESE_TO_INTENT_MAP[rawIntent]
            ? CHINESE_TO_INTENT_MAP[rawIntent]
            : rawIntent;
          const isIntentValid = protocolIntent !== null &&
            QUERY_NARRATIVE_INTENTS.includes(protocolIntent as (typeof QUERY_NARRATIVE_INTENTS)[number]);
          if (!isIntentValid) {
            // intent 非法（非合法英文 intent，也非中文变体）→ 从 args 字段推断
            const inferredIntent = inferIntentFromArgs(decision.arguments);
            if (inferredIntent) {
              intent = inferredIntent;
              args = { ...decision.arguments, intent: inferredIntent };
              toolSelectionCorrected = true;
            }
            // 推断失败 → 保留非法 intent，计入 invalidIntents（保持门禁可观测性）
          } else if (protocolIntent !== rawIntent) {
            // intent 是中文变体，转换成功 → 用转换后的英文 intent
            intent = protocolIntent;
            args = { ...decision.arguments, intent: protocolIntent };
            toolSelectionCorrected = true;
          }
          // rawIntent 已是合法英文 intent → 不纠正
        }
      }

      const tool = toolByName.get(toolName);
      const toolVisible = tool !== undefined;
      let routedOk = toolVisible && directiveParseError === null;

      // 路由校验：工具可见性 + facade（B/B0/B-safe）intent 合法性。directive 解析失败时不进路由。
      let routeParseError: string | null = null;
      if (!toolVisible) {
        routeParseError = `工具 "${toolName}" 不在可见工具集内（可见：${visibleTools.join(", ")}）`;
        routedOk = false;
      } else if (
        facadeArm &&
        (intent === null || !QUERY_NARRATIVE_INTENTS.includes(intent as (typeof QUERY_NARRATIVE_INTENTS)[number]))
      ) {
        routeParseError = `facade intent "${String(intent)}" 非法（应在 ${QUERY_NARRATIVE_INTENTS.join("|")} 内）`;
        routedOk = false;
      }
      const parseError = directiveParseError ?? routeParseError;

      // 执行（仅当路由成功且 directive 解析成功）
      if (routedOk && tool) {
        try {
          result = await tool.execute(toolCallId, args);
        } catch {
          isError = true;
          result = { content: [{ type: "text", text: "tool execution error" }], details: {} };
        }
      }

      // B-safe Phase 5.3.3：空结果 bounded retry。
      // 仅对 query 类意图（evidence/chapter_span/voice）的"无命中"结果做一次简化重试：
      //   - 触发条件：结果文本为空，或 details.resultKind === "no_match"（工具对不匹配查询返回非空提示文本）。
      //   - 将原 query 缩短为前 4 个字符（拓宽子串匹配范围）。
      //   - 重试成功（非空且非 no_match）则覆盖 result；重试仍无命中则保留首次结果，emptyResultRetried 仍记 true。
      // 不对 category/characterId/status 等枚举参数做简化（无语义可拓）。
      if (
        arm === "B-safe" &&
        routedOk &&
        !isError &&
        intent !== null &&
        (intent === "evidence" || intent === "chapter_span" || intent === "voice") &&
        typeof (args as { query?: unknown }).query === "string"
      ) {
        const firstText = extractResultText(result);
        const firstDetails = (result as { details?: { resultKind?: string } } | undefined)?.details;
        const isNoMatch = firstText.length === 0 || firstDetails?.resultKind === "no_match";
        if (isNoMatch) {
          const originalQuery = (args as { query: string }).query;
          const simplifiedQuery = originalQuery.slice(0, Math.min(4, originalQuery.length));
          if (simplifiedQuery.length > 0 && simplifiedQuery !== originalQuery) {
            emptyResultRetried = true;
            const retryArgs = { ...args, query: simplifiedQuery };
            try {
              const retryResult = await tool!.execute(`${toolCallId}-retry`, retryArgs);
              const retryText = extractResultText(retryResult);
              const retryDetails = (retryResult as { details?: { resultKind?: string } } | undefined)?.details;
              const retryIsNoMatch = retryText.length === 0 || retryDetails?.resultKind === "no_match";
              // 重试有命中（非空且非 no_match）才覆盖；否则保留首次结果。
              if (!retryIsNoMatch) {
                result = retryResult;
              }
            } catch {
              // 重试失败：保留首次结果，不升级为 isError（首次执行本身未报错）。
            }
          }
        }
      }

      const latencyMs = Date.now() - start;
      const resultText = extractResultText(result);
      const resultChars = resultText.length;
      const estimateTokens = Math.ceil(resultChars / 2);
      const details = (result as { details?: unknown } | undefined)?.details as
        | (Record<string, unknown> & {
            evidenceLevel?: string;
            sourceRef?: string;
            truncated?: boolean;
            rankedEvidences?: Array<{ evidenceLevel?: string }>;
          })
        | undefined;
      const evidenceLevel = details?.evidenceLevel;
      const sourceRef = details?.sourceRef;
      const sourceRefValid = isValidSourceRef(sourceRef);
      const empty = resultChars === 0 && !isError;
      const truncated = !isError && details?.truncated === true;
      const timeout = isError && /timeout|超时|aborted|timed out/i.test(resultText);
      const duplicateQuery = dupTracker.check(toolName, decision.arguments);
      const isFirstValid = !firstValidFound && !!evidenceLevel && VALID_EVIDENCE_LEVELS.has(evidenceLevel);
      if (isFirstValid) firstValidFound = true;

      // 修正评测口径：收集本回合返回的**全部**有效证据等级（去重）。
      // 单次调用可能折叠多个等级（如 confirmed_state + exact_chapter_span 同回合返回）；
      // 用 rankedEvidences 完整列表，避免仅首条 evidenceLevel 低估 B 组折叠能力。
      const rankedEvidenceLevels = Array.from(
        new Set(
          (details?.rankedEvidences ?? [])
            .map((e) => e.evidenceLevel)
            .filter((lv): lv is string => !!lv && VALID_EVIDENCE_LEVELS.has(lv)),
        ),
      );
      if (rankedEvidenceLevels.length === 0 && evidenceLevel && VALID_EVIDENCE_LEVELS.has(evidenceLevel)) {
        rankedEvidenceLevels.push(evidenceLevel);
      }

      turns.push({
        round,
        decision,
        selectedTool: toolName,
        toolVisible,
        intent,
        intentValid: facadeArm ? intent !== null && QUERY_NARRATIVE_INTENTS.includes(intent as (typeof QUERY_NARRATIVE_INTENTS)[number]) : true,
        routedTool: facadeArm && intent ? (INTENT_TO_TOOL[intent as IntentKey] ?? null) : toolName,
        routedOk,
        directiveParseError,
        parseError,
        latencyMs,
        resultChars,
        estimateTokens,
        evidenceLevel,
        rankedEvidenceLevels,
        sourceRef,
        sourceRefValid,
        sourceRefInvalidCategory: sourceRefValid ? null : classifyInvalidSourceRef(sourceRef),
        empty,
        timeout,
        isError,
        truncated,
        duplicateQuery,
        firstValidEvidence: isFirstValid,
        toolSelectionCorrected,
        emptyResultRetried,
        resultText,
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
    systemPromptTokens,
    mustVerifyItems,
    allConfirmed,
    injectedToolCount,
  );
}

// INTENT_TO_TOOL 已在文件顶部导入；此处仅定义 IntentKey 类型别名
type IntentKey = keyof typeof INTENT_TO_TOOL;

/** 给 Promise 加超时：超时则 reject（供包住模型决策调用，防止无限等待） */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

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
  arm: RealToolAbArm,
  seed: number,
  turns: RealToolAbTurn[],
  systemPromptTokens: number,
  mustVerifyItems: string[],
  allConfirmed: ConfirmedEvidence[],
  injectedToolCount: number,
): RealToolAbScenarioMetrics {
  const toolSurface = injectedToolCount;
  // 修复3：schema token 成本 = 实际注入 system prompt 的 token × 模型调用次数。
  // 每个回合（含 final 终止回合）模型都重新消费 system prompt，故按 turns.length 累计。
  const schemaTokenCost = systemPromptTokens * turns.length;
  let totalCalls = 0;
  let totalDuplicateQueries = 0;
  let totalResultChars = 0;
  let totalEstimateTokens = 0;
  let invalidToolSelections = 0;
  let correctedToolSelections = 0;
  let emptyResultRetried = 0;
  let invalidIntents = 0;
  let parseErrors = 0;
  let emptyResults = 0;
  let truncatedResults = 0;
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
    // invalidToolSelections：选择的工具名不在可见集内（非法工具，不含 directive 解析失败）。
    // B-safe 协议纠正的回合不计入非法（toolSelectionCorrected=true）。
    if (t.selectedTool !== null && !t.toolVisible && !t.toolSelectionCorrected) invalidToolSelections++;
    if (t.toolSelectionCorrected) correctedToolSelections++;
    if (t.emptyResultRetried) emptyResultRetried++;
    if (t.intent !== null && !t.intentValid) invalidIntents++;
    // parseErrors：工具指令 JSON 解析失败（malformed directive；独立于路由错误）。
    if (t.directiveParseError !== null) parseErrors++;
    if (t.empty) emptyResults++;
    if (t.truncated) truncatedResults++;
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
    correctedToolSelections,
    emptyResultRetried,
    invalidIntents,
    parseErrors,
    firstValidEvidence,
    emptyResults,
    truncatedResults,
    timeouts,
    errors,
    // 停止率观测：模型是否主动输出终止标记收敛（last turn 为 final），而非预算耗尽/超时被迫终止。
    stopped: turns.length > 0 && turns[turns.length - 1].decision.kind === "final",
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
    // 首个携带 provenance 的回合的采样/路由证据（真实模型；dry-run 无）。
    // 模型 fn 返回的整个 decision（含 provenance）保存在 turn.decision 上。
    provenance: turns.find((t) => t.decision?.provenance)?.decision?.provenance,
    toolMode: toolModeOfArm(arm),
    renderMode: renderModeOfArm(arm),
  };
}

// ============================================================================
// 聚合 + 门槛
// ============================================================================

/** 从场景 metrics 推导真实模型指纹：`provider:model:route`（首个非空 provenance；dry-run 无） */
function fingerprintOf(metrics: RealToolAbScenarioMetrics[]): string | undefined {
  const p = metrics.find((m) => m.provenance)?.provenance;
  if (!p || (!p.provider && !p.model && !p.route)) return undefined;
  return [p.provider, p.model, p.route].filter(Boolean).join(":");
}

export function aggregateRealArm(metrics: RealToolAbScenarioMetrics[]): RealToolAbArmAggregation {
  const invalidByCategory: Record<InvalidSourceRefCategory, number> = {
    no_match: 0,
    profile_only: 0,
    empty: 0,
    other: 0,
  };
  const evidenceLevelCounts: Record<string, number> = {};
  const firstLatency: number[] = [];
  let avgCoverageSum = 0;
  let stopCount = 0;

  for (const m of metrics) {
    if (m.stopped) stopCount++;
    for (const [k, v] of Object.entries(m.invalidSourceRefByCategory)) {
      invalidByCategory[k as InvalidSourceRefCategory] += v;
    }
    // evidenceLevel 逐级聚合：按本回合返回的**全部**有效证据等级（去重，来自 rankedEvidenceLevels）。
    // 修正评测口径：单次调用可能折叠多个等级（如 confirmed_state + exact_chapter_span）。
    for (const t of m.turns) {
      if (t.decision.kind === "final") continue;
      for (const lv of t.rankedEvidenceLevels) {
        evidenceLevelCounts[lv] = (evidenceLevelCounts[lv] ?? 0) + 1;
      }
    }
    if (m.firstValidEvidence !== null) firstLatency.push(m.firstValidEvidence.cumulativeLatencyMs);
    avgCoverageSum += m.mustVerify.coverageRatio;
  }

  return {
    toolSurface: metrics[0]?.toolSurface ?? 0,
    schemaTokenCost: metrics.reduce((s, m) => s + m.schemaTokenCost, 0),
    totalCalls: metrics.reduce((s, m) => s + m.totalCalls, 0),
    totalDuplicateQueries: metrics.reduce((s, m) => s + m.totalDuplicateQueries, 0),
    totalResultChars: metrics.reduce((s, m) => s + m.totalResultChars, 0),
    totalEstimateTokens: metrics.reduce((s, m) => s + m.totalEstimateTokens, 0),
    invalidToolSelections: metrics.reduce((s, m) => s + m.invalidToolSelections, 0),
    correctedToolSelections: metrics.reduce((s, m) => s + m.correctedToolSelections, 0),
    emptyResultRetried: metrics.reduce((s, m) => s + m.emptyResultRetried, 0),
    invalidIntents: metrics.reduce((s, m) => s + m.invalidIntents, 0),
    parseErrors: metrics.reduce((s, m) => s + m.parseErrors, 0),
    emptyResults: metrics.reduce((s, m) => s + m.emptyResults, 0),
    truncatedResults: metrics.reduce((s, m) => s + m.truncatedResults, 0),
    timeouts: metrics.reduce((s, m) => s + m.timeouts, 0),
    errors: metrics.reduce((s, m) => s + m.errors, 0),
    sourceRefsValid: metrics.reduce((s, m) => s + m.sourceRefsValid, 0),
    sourceRefsInvalid: metrics.reduce((s, m) => s + m.sourceRefsInvalid, 0),
    invalidSourceRefByCategory: invalidByCategory,
    evidenceLevelCounts,
    sourceRefCompleteness:
      metrics.reduce((s, m) => s + m.sourceRefsValid, 0) /
      (metrics.reduce((s, m) => s + m.totalCalls, 0) || 1),
    avgCoverageRatio: metrics.length > 0 ? avgCoverageSum / metrics.length : 0,
    firstValidEvidenceLatencyMs:
      firstLatency.length > 0 ? firstLatency.reduce((a, b) => a + b, 0) / firstLatency.length : null,
    scenarioCount: metrics.length,
    stopCount,
    stopRate: metrics.length > 0 ? stopCount / metrics.length : 0,
    provenance: metrics.find((m) => m.provenance)?.provenance,
    toolMode: metrics[0]?.toolMode,
    renderMode: metrics[0]?.renderMode,
    fingerprint: fingerprintOf(metrics),
  };
}

/** 门槛判定：mustVerify/sourceRef/无效分类/错误/超时/空结果/截断/非法工具/解析失败逐项不降级 + 至少一项真实负担指标改善 */

/**
 * 有效 evidenceLevel 累计强度比较（一阶随机占优）。
 *
 * 沿 EVIDENCE_LEVEL_STRENGTH_ORDER（从强到弱）逐级累计命中数，要求 B 在每个累计阈值上的
 * 归一化累计命中率均不低于 A（容差 1e-9）。
 *
 * 口径修正意义：更强的等级可替代/补齐较弱的等级。例如 B 的 confirmed_state 命中率高于 A、
 * 但 exact_chapter_span 低于 A 时，累计到 confirmed_state 阈值 B 已不低于 A，故不被判为退化；
 * 反向（B 用更弱等级顶替更强等级，如 confirmed_state 缺口仅靠 exact_chapter_span 补足）会在
 * 更早的累计阈值上低于 A 而正确失败。
 */
export function evidenceLevelsCumulativeNonDegraded(
  countsA: Record<string, number>,
  callsA: number,
  countsB: Record<string, number>,
  callsB: number,
): boolean {
  const aCalls = callsA || 1;
  const bCalls = callsB || 1;
  let cumA = 0;
  let cumB = 0;
  for (const lv of EVIDENCE_LEVEL_STRENGTH_ORDER) {
    cumA += countsA[lv] ?? 0;
    cumB += countsB[lv] ?? 0;
    if (cumB / bCalls < cumA / aCalls - 1e-9) {
      return false;
    }
  }
  return true;
}

function evaluateRealGate(
  A: RealToolAbArmAggregation,
  B: RealToolAbArmAggregation,
  scenarioGates: RealToolAbScenarioGate[],
  labelB = "B",
): RealToolAbGate {
  const mustVerifyCoverageNotDegraded = B.avgCoverageRatio >= A.avgCoverageRatio - 1e-9;
  const sourceRefCompletenessNotDegraded = B.sourceRefCompleteness >= A.sourceRefCompleteness - 1e-9;

  // 无效 sourceRef 总数（4 分类口径）
  const categoryKeys: InvalidSourceRefCategory[] = ["no_match", "profile_only", "empty", "other"];
  const invalidTotalA = categoryKeys.reduce((s, k) => s + A.invalidSourceRefByCategory[k], 0);
  const invalidTotalB = categoryKeys.reduce((s, k) => s + B.invalidSourceRefByCategory[k], 0);
  const invalidSourceRefNotWorsened = invalidTotalB <= invalidTotalA;

  // 无效 sourceRef 逐分类均不恶化（不一致则门禁失败）
  const invalidSourceRefCategoriesNotWorsened = categoryKeys.every(
    (k) => B.invalidSourceRefByCategory[k] <= A.invalidSourceRefByCategory[k],
  );

  // 有效 evidenceLevel 累计强度不降级：按证据强度从强到弱累计命中数做一阶随机占优比较。
  // 修正评测口径（Phase 4.3 收口）：逐等级独立比较会把「更强的 confirmed_state 替代较弱的
  // exact_chapter_span」误判为退化。改用累计比较后，B 在每个累计阈值上的归一化累计命中数
  // 均不低于 A 才通过；反向（用更弱等级顶替更强等级）仍会正确失败。
  const evidenceLevelNotDegraded = evidenceLevelsCumulativeNonDegraded(
    A.evidenceLevelCounts,
    A.totalCalls,
    B.evidenceLevelCounts,
    B.totalCalls,
  );

  // 失败 / 超时 / 空结果 / 截断 / 非法工具 / 解析失败逐项不恶化（设计文档 §5.6）
  const errorsNotWorsened = B.errors <= A.errors;
  const timeoutsNotWorsened = B.timeouts <= A.timeouts;
  const emptyResultsNotWorsened = B.emptyResults <= A.emptyResults;
  const truncatedNotWorsened = B.truncatedResults <= A.truncatedResults;
  const invalidToolSelectionsNotWorsened = B.invalidToolSelections <= A.invalidToolSelections;
  const parseErrorsNotWorsened = B.parseErrors <= A.parseErrors;

  // 逐场景失败行为门禁：每个场景（A/B 跨 seed 求和）失败行为均不恶化
  const scenarioGatesPassed = scenarioGates.every((sg) => sg.allFailingNotWorsened);

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

  const aCalls = A.totalCalls || 1;
  const bCalls = B.totalCalls || 1;
  const detailLevels = EVIDENCE_LEVEL_STRENGTH_ORDER.length > 0
    ? EVIDENCE_LEVEL_STRENGTH_ORDER.map(
        (lv) => `${lv}:B=${((B.evidenceLevelCounts[lv] ?? 0) / bCalls).toFixed(3)}/A=${((A.evidenceLevelCounts[lv] ?? 0) / aCalls).toFixed(3)}`,
      ).join("，")
    : "（无有效证据等级命中）";
  const detailCats = categoryKeys
    .map((k) => `${k}:B=${B.invalidSourceRefByCategory[k]}/A=${A.invalidSourceRefByCategory[k]}`)
    .join("，");
  const detailScenarioGates = scenarioGates
    .map((sg) => `${sg.scenarioId}:${sg.allFailingNotWorsened ? "PASS" : "FAIL"}`)
    .join("，");

  return {
    mustVerifyCoverageNotDegraded,
    sourceRefCompletenessNotDegraded,
    invalidSourceRefNotWorsened,
    invalidSourceRefCategoriesNotWorsened,
    evidenceLevelNotDegraded,
    errorsNotWorsened,
    timeoutsNotWorsened,
    emptyResultsNotWorsened,
    truncatedNotWorsened,
    invalidToolSelectionsNotWorsened,
    parseErrorsNotWorsened,
    scenarioGatesPassed,
    burdenImproved,
    improvedBurdenMetrics,
    allPassed:
      mustVerifyCoverageNotDegraded &&
      sourceRefCompletenessNotDegraded &&
      invalidSourceRefNotWorsened &&
      invalidSourceRefCategoriesNotWorsened &&
      evidenceLevelNotDegraded &&
      errorsNotWorsened &&
      timeoutsNotWorsened &&
      emptyResultsNotWorsened &&
      truncatedNotWorsened &&
      invalidToolSelectionsNotWorsened &&
      parseErrorsNotWorsened &&
      scenarioGatesPassed &&
      burdenImproved,
    details: {
      mustVerifyCoverage: `${labelB}=${B.avgCoverageRatio.toFixed(3)} >= A=${A.avgCoverageRatio.toFixed(3)}`,
      sourceRefCompleteness: `${labelB}=${B.sourceRefCompleteness.toFixed(3)} >= A=${A.sourceRefCompleteness.toFixed(3)}`,
      invalidSourceRef: `${labelB}=${invalidTotalB} <= A=${invalidTotalA}`,
      invalidSourceRefCategories: detailCats,
      evidenceLevel: detailLevels,
      errors: `${labelB}=${B.errors} <= A=${A.errors}`,
      timeouts: `${labelB}=${B.timeouts} <= A=${A.timeouts}`,
      emptyResults: `${labelB}=${B.emptyResults} <= A=${A.emptyResults}`,
      truncated: `${labelB}=${B.truncatedResults} <= A=${A.truncatedResults}`,
      scenarioGates: detailScenarioGates,
      invalidToolSelections: `${labelB}=${B.invalidToolSelections} <= A=${A.invalidToolSelections}`,
      parseErrors: `${labelB}=${B.parseErrors} <= A=${A.parseErrors}`,
      burdenImproved: `改善项：${improvedBurdenMetrics.join(", ") || "无"}`,
    },
  };
}

/**
 * Phase 5.3 envelope 门禁（C vs B）。
 *
 * 用户核查指出（Phase 5.2 结论）：聚合 resultChars 下降可能掩盖局部膨胀（如 SC2、SC5）。
 * 真实模型 replay 前必须把「单场景/单调用结果不可明显变长」纳入门禁，不能只看聚合下降。
 * 这里同时校验：
 * - 聚合：C 总返回字符 <= B（envelope 收益，允许持平）；
 * - 单场景：每场景 C.totalResultChars <= B.totalResultChars × factor + buffer；
 * - 单调用：每场景 C 最大单回合字符 <= B 最大单回合字符 × factor + buffer；
 * - 证据覆盖：C mustVerify 覆盖率 >= B；
 * - 有效证据引用率：C sourceRefCompleteness >= B；
 * - 停止率：C 不显著低于 B（容差 5 个百分点，观察模型仍能在证据充分后主动收敛）；
 * - 失败行为：C errors/timeouts/empty/truncated/非法工具/解析失败均不高于 B。
 */
export function evaluateEnvelopeRealGate(
  B: RealToolAbArmAggregation,
  C: RealToolAbArmAggregation,
  pairs: RealToolAbPair[],
): EnvelopeRealGate {
  const resultCharsNotWorsened = C.totalResultChars <= B.totalResultChars;

  const f = ENVELOPE_EXPANSION_FACTOR;
  const buf = ENVELOPE_EXPANSION_BUFFER;
  let noScenarioExpansion = true;
  let noSingleCallExpansion = true;
  const scenarioDetail: string[] = [];
  const singleCallDetail: string[] = [];
  for (const p of pairs) {
    const bChars = p.B.reduce((s, m) => s + m.totalResultChars, 0);
    const cChars = p.C.reduce((s, m) => s + m.totalResultChars, 0);
    const bMaxCall = Math.max(0, ...p.B.flatMap((m) => m.turns.map((t) => t.resultChars)));
    const cMaxCall = Math.max(0, ...p.C.flatMap((m) => m.turns.map((t) => t.resultChars)));
    const sThreshold = bChars * f + buf;
    const cThreshold = bMaxCall * f + buf;
    const sOk = cChars <= sThreshold;
    const cOk = cMaxCall <= cThreshold;
    if (!sOk) noScenarioExpansion = false;
    if (!cOk) noSingleCallExpansion = false;
    scenarioDetail.push(
      `${p.scenarioId}: C=${cChars} <= B=${bChars}×${f}+${buf}=${sThreshold} ${sOk ? "PASS" : "FAIL"}`,
    );
    singleCallDetail.push(
      `${p.scenarioId}: C单调用max=${cMaxCall} <= B单调用max=${bMaxCall}×${f}+${buf}=${cThreshold} ${cOk ? "PASS" : "FAIL"}`,
    );
  }

  const coverageNotDegraded = C.avgCoverageRatio >= B.avgCoverageRatio - 1e-9;
  const sourceRefNotDegraded = C.sourceRefCompleteness >= B.sourceRefCompleteness - 1e-9;
  const stopRateNotDegraded = C.stopRate >= B.stopRate - 0.05;
  const failureNotDegraded =
    C.errors <= B.errors &&
    C.timeouts <= B.timeouts &&
    C.emptyResults <= B.emptyResults &&
    C.truncatedResults <= B.truncatedResults &&
    C.invalidToolSelections <= B.invalidToolSelections &&
    C.parseErrors <= B.parseErrors;

  const allPassed =
    resultCharsNotWorsened &&
    noScenarioExpansion &&
    noSingleCallExpansion &&
    coverageNotDegraded &&
    sourceRefNotDegraded &&
    stopRateNotDegraded &&
    failureNotDegraded;

  return {
    resultCharsNotWorsened,
    noScenarioExpansion,
    noSingleCallExpansion,
    coverageNotDegraded,
    sourceRefNotDegraded,
    stopRateNotDegraded,
    failureNotDegraded,
    allPassed,
    details: {
      resultChars: `C=${C.totalResultChars} <= B=${B.totalResultChars}`,
      scenarioExpansion: scenarioDetail.join("；"),
      singleCallExpansion: singleCallDetail.join("；"),
      coverage: `C=${C.avgCoverageRatio.toFixed(3)} >= B=${B.avgCoverageRatio.toFixed(3)}`,
      sourceRef: `C=${C.sourceRefCompleteness.toFixed(3)} >= B=${B.sourceRefCompleteness.toFixed(3)}`,
      stopRate: `C=${(C.stopRate * 100).toFixed(0)}% >= B=${(B.stopRate * 100).toFixed(0)}% − 5%`,
      failure:
        `errors(${C.errors}<=${B.errors});timeouts(${C.timeouts}<=${B.timeouts});` +
        `empty(${C.emptyResults}<=${B.emptyResults});truncated(${C.truncatedResults}<=${B.truncatedResults});` +
        `invalidTool(${C.invalidToolSelections}<=${B.invalidToolSelections});parseErrors(${C.parseErrors}<=${B.parseErrors})`,
    },
  };
}

// ============================================================================
// 主入口：3 场景 × 3 seed × A/B 成对
// ============================================================================

/** 高信号场景 ID 子集（canon / mixed / low-risk） */
export const HIGH_SIGNAL_SCENARIO_IDS = ["SC1-canon-fact", "SC7-multi-tool-mixed", "SC6-low-risk-no-retrieval"];

/**
 * Phase 5.3 envelope 真实 replay 目标场景：最能暴露 envelope 局部膨胀或信息损失。
 * SC2（character-state）、SC5（chapter-span）在 Phase 5.2 确定性 replay 中已出现
 * 单场景字符膨胀（C>B），SC7（multi-tool-mixed）覆盖多工具/多意图折叠路径。
 */
export const ENVELOPE_REPLAY_SCENARIO_IDS = [
  "SC2-character-state",
  "SC5-chapter-span",
  "SC7-multi-tool-mixed",
];

/** 返回基线高信号场景列表（供 CLI --scenario 过滤/定向诊断）。 */
export function getBaselineScenarios(): BaselineScenario[] {
  return BASELINE_SCENARIOS.filter((s) => HIGH_SIGNAL_SCENARIO_IDS.includes(s.id));
}

/** 返回全部基线场景（供 CLI --scenario 过滤任意场景，含 SC2/SC5）。 */
export function getAllBaselineScenarios(): BaselineScenario[] {
  return [...BASELINE_SCENARIOS];
}

/** 返回 Phase 5.3 envelope 真实 replay 目标场景（SC2/SC5/SC7）。 */
export function getEnvelopeReplayScenarios(): BaselineScenario[] {
  return BASELINE_SCENARIOS.filter((s) => ENVELOPE_REPLAY_SCENARIO_IDS.includes(s.id));
}

/** 逐场景失败行为门禁：A/B 各自跨 seed 求和后，逐项比较 empty/truncated/errors/timeouts/非法工具/解析失败不恶化 */
function evaluateScenarioGate(pair: {
  scenarioId: string;
  A: RealToolAbScenarioMetrics[];
  B: RealToolAbScenarioMetrics[];
}): RealToolAbScenarioGate {
  const sum = (list: RealToolAbScenarioMetrics[], k: keyof RealToolAbScenarioMetrics): number =>
    list.reduce((s, m) => s + (typeof m[k] === "number" ? (m[k] as number) : 0), 0);
  const sumA = (k: keyof RealToolAbScenarioMetrics) => sum(pair.A, k);
  const sumB = (k: keyof RealToolAbScenarioMetrics) => sum(pair.B, k);

  const emptyResultsNotWorsened = sumB("emptyResults") <= sumA("emptyResults");
  const truncatedNotWorsened = sumB("truncatedResults") <= sumA("truncatedResults");
  const errorsNotWorsened = sumB("errors") <= sumA("errors");
  const timeoutsNotWorsened = sumB("timeouts") <= sumA("timeouts");
  const invalidToolSelectionsNotWorsened = sumB("invalidToolSelections") <= sumA("invalidToolSelections");
  const parseErrorsNotWorsened = sumB("parseErrors") <= sumA("parseErrors");
  const allFailingNotWorsened =
    emptyResultsNotWorsened &&
    truncatedNotWorsened &&
    errorsNotWorsened &&
    timeoutsNotWorsened &&
    invalidToolSelectionsNotWorsened &&
    parseErrorsNotWorsened;

  return {
    scenarioId: pair.scenarioId,
    emptyResultsNotWorsened,
    truncatedNotWorsened,
    errorsNotWorsened,
    timeoutsNotWorsened,
    invalidToolSelectionsNotWorsened,
    parseErrorsNotWorsened,
    allFailingNotWorsened,
    details: {
      emptyResults: `B=${sumB("emptyResults")} <= A=${sumA("emptyResults")}`,
      truncated: `B=${sumB("truncatedResults")} <= A=${sumA("truncatedResults")}`,
      errors: `B=${sumB("errors")} <= A=${sumA("errors")}`,
      timeouts: `B=${sumB("timeouts")} <= A=${sumA("timeouts")}`,
      invalidToolSelections: `B=${sumB("invalidToolSelections")} <= A=${sumA("invalidToolSelections")}`,
      parseErrors: `B=${sumB("parseErrors")} <= A=${sumA("parseErrors")}`,
    },
  };
}

/**
 * 运行真实模型 A/B/B0/C replay（dry-run 或真实模型）。
 *
 * 默认使用 dry-run stub（零 API）。真实模型需显式传入 `modelFn`（经授权后）。
 * 场景默认取高信号集（SC1/SC6/SC7）；Phase 5.3 envelope replay 需显式传入
 * `getEnvelopeReplayScenarios()`（SC2/SC5/SC7）或经 `scenarios` 传入目标场景。
 * 每场景 × 每 seed × A/B/B0/C 四臂成对。
 */
export async function runRealToolAbReplay(options: {
  modelFn?: ToolAbModelFn;
  seeds?: number[];
  scenarios?: BaselineScenario[];
  timestamp?: string;
} = {}): Promise<RealToolAbComparison> {
  const seeds = options.seeds ?? [0, 1, 2];
  const scenarioPool = options.scenarios ?? BASELINE_SCENARIOS;
  // 显式传入 scenarios 时信任调用方（Phase 5.3 传 SC2/SC5/SC7）；否则过滤到高信号集。
  const scenarios = options.scenarios
    ? scenarioPool
    : scenarioPool.filter((s) => HIGH_SIGNAL_SCENARIO_IDS.includes(s.id));
  const providedModelFn = options.modelFn;

  const pairs: RealToolAbPair[] = [];
  for (const scenario of scenarios) {
    const armMetrics: Record<RealToolAbArm, RealToolAbScenarioMetrics[]> = {
      A: [],
      B: [],
      B0: [],
      C: [],
      "B-safe": [],
    };
    // B-safe 作为独立验证 arm（Phase 5.3.3），不参与主对比门禁；
    // 主对比循环只跑 A/B/B0/C，B-safe 由独立 replay 脚本驱动。
    for (const seed of seeds) {
      for (const arm of ["A", "B", "B0", "C"] as const) {
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
      B0: armMetrics.B0,
      C: armMetrics.C,
      scenarioGate: evaluateScenarioGate({
        scenarioId: scenario.id,
        A: armMetrics.A,
        B: armMetrics.B,
      }),
      scenarioGateB0: evaluateScenarioGate({
        scenarioId: scenario.id,
        A: armMetrics.A,
        B: armMetrics.B0,
      }),
      scenarioGateC: evaluateScenarioGate({
        scenarioId: scenario.id,
        A: armMetrics.A,
        B: armMetrics.C,
      }),
    });
  }

  // 跨全部场景 × 全部 seed 聚合（保证 3-seed 都参与门槛判定）
  const A = aggregateRealArm(pairs.flatMap((p) => p.A));
  const B = aggregateRealArm(pairs.flatMap((p) => p.B));
  const B0 = aggregateRealArm(pairs.flatMap((p) => p.B0));
  const C = aggregateRealArm(pairs.flatMap((p) => p.C));
  const gate = evaluateRealGate(A, B, pairs.map((p) => p.scenarioGate));
  const gateB0 = evaluateRealGate(A, B0, pairs.map((p) => p.scenarioGateB0));
  const gateC = evaluateRealGate(A, C, pairs.map((p) => p.scenarioGateC), "C");
  const envelopeGate = evaluateEnvelopeRealGate(B, C, pairs);

  return {
    schema: "tool-ab-real-comparison/v1",
    timestamp: options.timestamp ?? new Date().toISOString(),
    phase: providedModelFn ? "phase5-3-envelope-real" : "phase4-tool-ab-real",
    mode: providedModelFn ? "real" : "dry-run",
    scenarios: pairs,
    aggregation: { A, B, B0, C },
    gate,
    gateB0,
    gateC,
    envelopeGate,
    guidanceDelta: {
      schemaTokenCost: { B: B.schemaTokenCost, B0: B0.schemaTokenCost },
      invalidIntents: { B: B.invalidIntents, B0: B0.invalidIntents },
      invalidToolSelections: { B: B.invalidToolSelections, B0: B0.invalidToolSelections },
      totalCalls: { B: B.totalCalls, B0: B0.totalCalls },
      totalDuplicateQueries: { B: B.totalDuplicateQueries, B0: B0.totalDuplicateQueries },
      avgCoverageRatio: { B: B.avgCoverageRatio, B0: B0.avgCoverageRatio },
      firstValidEvidenceLatencyMs: {
        B: B.firstValidEvidenceLatencyMs,
        B0: B0.firstValidEvidenceLatencyMs,
      },
      emptyResults: { B: B.emptyResults, B0: B0.emptyResults },
      errors: { B: B.errors, B0: B0.errors },
      stopRate: { B: B.stopRate, B0: B0.stopRate },
    },
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
  lines.push("# NovelOS Phase 5.3 真实模型 A/B/B0/C 对比报告（specialized-9-tools vs typed facade vs compact envelope）");
  lines.push("");
  lines.push(`**schema**：${comparison.schema}`);
  lines.push(`**时间**：${comparison.timestamp}`);
  lines.push(`**阶段**：${comparison.phase}`);
  lines.push(`**模式**：${comparison.mode === "dry-run" ? "dry-run（确定性 stub，零 API）" : "real（真实模型，需授权）"}`);
  lines.push("");
  lines.push("> 四臂：A=9 专用工具（raw），B=受引导 facade（raw），B0=无引导 facade（raw），C=受引导 facade + compact envelope。");
  lines.push("> Phase 5.3 目标：验证真实模型对 compact envelope 的理解不下降（停止率/查询精度/事实覆盖），");
  lines.push("> 并把「单场景/单调用结果膨胀」纳入门禁（C vs B，见下方 envelope 门禁）。");
  lines.push("");

  // 真实模式：采样/路由 provenance（requested route / provider / model / effective sampling）
  if (comparison.mode === "real") {
    lines.push("## 采样与路由 provenance");
    lines.push("");
    lines.push("| 项目 | A 组（9 专用工具） | B 组（受引导 facade） | C 组（facade+compact envelope） |");
    lines.push("|------|------|------|------|");
    const prov = (arm: "A" | "B" | "C") => comparison.aggregation[arm].provenance;
    const pA = prov("A");
    const pB = prov("B");
    const pC = prov("C");
    const fp = (arm: "A" | "B" | "C") => comparison.aggregation[arm].fingerprint ?? "unmeasured";
    lines.push(`| fingerprint | ${fp("A")} | ${fp("B")} | ${fp("C")} |`);
    lines.push(`| requested route | ${pA?.route ?? "unmeasured"} | ${pB?.route ?? "unmeasured"} | ${pC?.route ?? "unmeasured"} |`);
    lines.push(`| actual provider | ${pA?.provider ?? "unmeasured"} | ${pB?.provider ?? "unmeasured"} | ${pC?.provider ?? "unmeasured"} |`);
    lines.push(`| actual model | ${pA?.model ?? "unmeasured"} | ${pB?.model ?? "unmeasured"} | ${pC?.model ?? "unmeasured"} |`);
    lines.push(`| effective temperature | ${pA?.temperature ?? "unmeasured"} | ${pB?.temperature ?? "unmeasured"} | ${pC?.temperature ?? "unmeasured"} |`);
    lines.push(`| seed 透传 | ${pA?.seedApplied ? "是" : "否"} | ${pB?.seedApplied ? "是" : "否"} | ${pC?.seedApplied ? "是" : "否"} |`);
    lines.push(`| seed 被支持 | ${pA?.seedSupported ? "是" : "否"} | ${pB?.seedSupported ? "是" : "否"} | ${pC?.seedSupported ? "是" : "否"} |`);
    lines.push(`| maxTokens | ${pA?.maxTokens ?? "unmeasured"} | ${pB?.maxTokens ?? "unmeasured"} | ${pC?.maxTokens ?? "unmeasured"} |`);
    lines.push(`| fallback 关闭 | ${pA?.fallbackDisabled ? "是" : "否"} | ${pB?.fallbackDisabled ? "是" : "否"} | ${pC?.fallbackDisabled ? "是" : "否"} |`);
    lines.push("");
    lines.push(`| 工具模式 | ${comparison.aggregation.A.toolMode ?? "n/a"} | ${comparison.aggregation.B.toolMode ?? "n/a"} | ${comparison.aggregation.C.toolMode ?? "n/a"} |`);
    lines.push(`| 渲染模式 | ${comparison.aggregation.A.renderMode ?? "n/a"} | ${comparison.aggregation.B.renderMode ?? "n/a"} | ${comparison.aggregation.C.renderMode ?? "n/a"} |`);
    lines.push("");
    const seedNote = pA?.seedSupported === false || pB?.seedSupported === false || pC?.seedSupported === false
      ? "> ⚠️ 当前 provider 协议不支持 seed：\"3 seed\"仅作标签，实际为非确定性配对实验，不能视为受控复现。"
      : "> seed 被 provider 支持并透传：3 seed 为受控复现采样。";
    lines.push(seedNote);
    lines.push("");
  }

  lines.push("## 门禁结论");
  lines.push("");
  lines.push("| 门禁 | 结论 | 详情 |");
  lines.push("|------|------|------|");
  lines.push(`| mustVerify 覆盖率不降级 | ${comparison.gate.mustVerifyCoverageNotDegraded ? "✓" : "✗"} | ${comparison.gate.details.mustVerifyCoverage} |`);
  lines.push(`| 有效证据引用率不降级 | ${comparison.gate.sourceRefCompletenessNotDegraded ? "✓" : "✗"} | ${comparison.gate.details.sourceRefCompleteness} |`);
  lines.push(`| 无效 sourceRef 总数不恶化 | ${comparison.gate.invalidSourceRefNotWorsened ? "✓" : "✗"} | ${comparison.gate.details.invalidSourceRef} |`);
  lines.push(`| 无效 sourceRef 分类不恶化 | ${comparison.gate.invalidSourceRefCategoriesNotWorsened ? "✓" : "✗"} | ${comparison.gate.details.invalidSourceRefCategories} |`);
  lines.push(`| evidenceLevel 命中率不降级 | ${comparison.gate.evidenceLevelNotDegraded ? "✓" : "✗"} | ${comparison.gate.details.evidenceLevel} |`);
  lines.push(`| 失败（errors）不恶化 | ${comparison.gate.errorsNotWorsened ? "✓" : "✗"} | ${comparison.gate.details.errors} |`);
  lines.push(`| 超时（timeouts）不恶化 | ${comparison.gate.timeoutsNotWorsened ? "✓" : "✗"} | ${comparison.gate.details.timeouts} |`);
  lines.push(`| 空结果（empty）不恶化 | ${comparison.gate.emptyResultsNotWorsened ? "✓" : "✗"} | ${comparison.gate.details.emptyResults} |`);
  lines.push(`| 结果截断（truncated）不恶化 | ${comparison.gate.truncatedNotWorsened ? "✓" : "✗"} | ${comparison.gate.details.truncated} |`);
  lines.push(`| 非法工具选择不恶化 | ${comparison.gate.invalidToolSelectionsNotWorsened ? "✓" : "✗"} | ${comparison.gate.details.invalidToolSelections} |`);
  lines.push(`| 解析失败不恶化 | ${comparison.gate.parseErrorsNotWorsened ? "✓" : "✗"} | ${comparison.gate.details.parseErrors} |`);
  lines.push(`| 逐场景失败门禁全通过 | ${comparison.gate.scenarioGatesPassed ? "✓" : "✗"} | ${comparison.gate.details.scenarioGates} |`);
  lines.push(`| 至少一项负担改善 | ${comparison.gate.burdenImproved ? "✓" : "✗"} | ${comparison.gate.details.burdenImproved} |`);
  lines.push("");
  lines.push(`**全部通过（B vs A）**：${comparison.gate.allPassed ? "是" : "否"}`);
  lines.push("");
  lines.push("## C 组门禁（compact envelope facade vs A：9 专用工具）");
  lines.push("");
  lines.push("| 门禁 | 结论 | 详情 |");
  lines.push("|------|------|------|");
  lines.push(`| mustVerify 覆盖率不降级 | ${comparison.gateC.mustVerifyCoverageNotDegraded ? "✓" : "✗"} | ${comparison.gateC.details.mustVerifyCoverage} |`);
  lines.push(`| 有效证据引用率不降级 | ${comparison.gateC.sourceRefCompletenessNotDegraded ? "✓" : "✗"} | ${comparison.gateC.details.sourceRefCompleteness} |`);
  lines.push(`| evidenceLevel 命中率不降级 | ${comparison.gateC.evidenceLevelNotDegraded ? "✓" : "✗"} | ${comparison.gateC.details.evidenceLevel} |`);
  lines.push(`| 失败（errors）不恶化 | ${comparison.gateC.errorsNotWorsened ? "✓" : "✗"} | ${comparison.gateC.details.errors} |`);
  lines.push(`| 空结果（empty）不恶化 | ${comparison.gateC.emptyResultsNotWorsened ? "✓" : "✗"} | ${comparison.gateC.details.emptyResults} |`);
  lines.push(`| 截断（truncated）不恶化 | ${comparison.gateC.truncatedNotWorsened ? "✓" : "✗"} | ${comparison.gateC.details.truncated} |`);
  lines.push(`| 非法工具选择不恶化 | ${comparison.gateC.invalidToolSelectionsNotWorsened ? "✓" : "✗"} | ${comparison.gateC.details.invalidToolSelections} |`);
  lines.push(`| 解析失败不恶化 | ${comparison.gateC.parseErrorsNotWorsened ? "✓" : "✗"} | ${comparison.gateC.details.parseErrors} |`);
  lines.push(`| 逐场景失败门禁全通过 | ${comparison.gateC.scenarioGatesPassed ? "✓" : "✗"} | ${comparison.gateC.details.scenarioGates} |`);
  lines.push(`| C 全部通过（vs A） | ${comparison.gateC.allPassed ? "✓" : "✗"} | |`);
  lines.push("");
  lines.push("## Envelope 门禁（C vs B：compact envelope 不膨胀 + 不降级）");
  lines.push("");
  lines.push(`> 预注册门槛：` +
    `单场景/单调用许可膨胀 = B × ${ENVELOPE_EXPANSION_FACTOR} + ${ENVELOPE_EXPANSION_BUFFER}（字符）。` +
    `聚合下降不得掩盖局部膨胀，故逐场景、逐单调用校验。`);
  lines.push("");
  lines.push("| 门禁 | 结论 | 详情 |");
  lines.push("|------|------|------|");
  lines.push(`| 聚合结果字符不膨胀（C≤B） | ${comparison.envelopeGate.resultCharsNotWorsened ? "✓" : "✗"} | ${comparison.envelopeGate.details.resultChars} |`);
  lines.push(`| 单场景无膨胀 | ${comparison.envelopeGate.noScenarioExpansion ? "✓" : "✗"} | ${comparison.envelopeGate.details.scenarioExpansion} |`);
  lines.push(`| 单调用无膨胀 | ${comparison.envelopeGate.noSingleCallExpansion ? "✓" : "✗"} | ${comparison.envelopeGate.details.singleCallExpansion} |`);
  lines.push(`| mustVerify 覆盖率不降级 | ${comparison.envelopeGate.coverageNotDegraded ? "✓" : "✗"} | ${comparison.envelopeGate.details.coverage} |`);
  lines.push(`| 有效证据引用率不降级 | ${comparison.envelopeGate.sourceRefNotDegraded ? "✓" : "✗"} | ${comparison.envelopeGate.details.sourceRef} |`);
  lines.push(`| 停止率不显著下降 | ${comparison.envelopeGate.stopRateNotDegraded ? "✓" : "✗"} | ${comparison.envelopeGate.details.stopRate} |`);
  lines.push(`| 失败行为不恶化 | ${comparison.envelopeGate.failureNotDegraded ? "✓" : "✗"} | ${comparison.envelopeGate.details.failure} |`);
  lines.push("");
  lines.push(`**Envelope 门禁全部通过**：${comparison.envelopeGate.allPassed ? "是" : "否"}`);
  lines.push("");
  lines.push("## 逐场景失败行为门禁");
  lines.push("");
  lines.push("| 场景 | empty | truncated | errors | timeouts | 非法工具 | 解析失败 | 通过 |");
  lines.push("|------|------|-----------|--------|----------|----------|----------|------|");
  for (const p of comparison.scenarios) {
    const g = p.scenarioGate;
    lines.push(`| ${g.scenarioId} | ${g.emptyResultsNotWorsened ? "✓" : "✗"} | ${g.truncatedNotWorsened ? "✓" : "✗"} | ${g.errorsNotWorsened ? "✓" : "✗"} | ${g.timeoutsNotWorsened ? "✓" : "✗"} | ${g.invalidToolSelectionsNotWorsened ? "✓" : "✗"} | ${g.parseErrorsNotWorsened ? "✓" : "✗"} | ${g.allFailingNotWorsened ? "✓" : "✗"} |`);
  }
  lines.push("");
  lines.push("## 聚合指标");
  lines.push("");
  lines.push("| 指标 | A 组（9 专用工具） | B 组（受引导 facade） | B0 组（无引导 facade） | C 组（facade+compact envelope） |");
  lines.push("|------|------|------|------|------|");
  const agg = comparison.aggregation;
  const fmtLatency = (v: number | null) => (v === null ? "unmeasured" : v.toFixed(0));
  lines.push(`| schema token 成本 | ${agg.A.schemaTokenCost} | ${agg.B.schemaTokenCost} | ${agg.B0.schemaTokenCost} | ${agg.C.schemaTokenCost} |`);
  lines.push(`| 可见工具数 | ${agg.A.toolSurface} | ${agg.B.toolSurface} | ${agg.B0.toolSurface} | ${agg.C.toolSurface} |`);
  lines.push(`| 总调用 | ${agg.A.totalCalls} | ${agg.B.totalCalls} | ${agg.B0.totalCalls} | ${agg.C.totalCalls} |`);
  lines.push(`| 重复查询 | ${agg.A.totalDuplicateQueries} | ${agg.B.totalDuplicateQueries} | ${agg.B0.totalDuplicateQueries} | ${agg.C.totalDuplicateQueries} |`);
  lines.push(`| 非法工具选择 | ${agg.A.invalidToolSelections} | ${agg.B.invalidToolSelections} | ${agg.B0.invalidToolSelections} | ${agg.C.invalidToolSelections} |`);
  lines.push(`| 非法 intent | ${agg.A.invalidIntents} | ${agg.B.invalidIntents} | ${agg.B0.invalidIntents} | ${agg.C.invalidIntents} |`);
  lines.push(`| 参数解析/路由失败 | ${agg.A.parseErrors} | ${agg.B.parseErrors} | ${agg.B0.parseErrors} | ${agg.C.parseErrors} |`);
  lines.push(`| 首次有效证据平均延迟(ms) | ${fmtLatency(agg.A.firstValidEvidenceLatencyMs)} | ${fmtLatency(agg.B.firstValidEvidenceLatencyMs)} | ${fmtLatency(agg.B0.firstValidEvidenceLatencyMs)} | ${fmtLatency(agg.C.firstValidEvidenceLatencyMs)} |`);
  lines.push(`| 总返回字符 | ${agg.A.totalResultChars} | ${agg.B.totalResultChars} | ${agg.B0.totalResultChars} | ${agg.C.totalResultChars} |`);
  lines.push(`| 估算 token | ${agg.A.totalEstimateTokens} | ${agg.B.totalEstimateTokens} | ${agg.B0.totalEstimateTokens} | ${agg.C.totalEstimateTokens} |`);
  lines.push(`| 空结果 | ${agg.A.emptyResults} | ${agg.B.emptyResults} | ${agg.B0.emptyResults} | ${agg.C.emptyResults} |`);
  lines.push(`| 结果截断 | ${agg.A.truncatedResults} | ${agg.B.truncatedResults} | ${agg.B0.truncatedResults} | ${agg.C.truncatedResults} |`);
  lines.push(`| 超时 | ${agg.A.timeouts} | ${agg.B.timeouts} | ${agg.B0.timeouts} | ${agg.C.timeouts} |`);
  lines.push(`| 失败 | ${agg.A.errors} | ${agg.B.errors} | ${agg.B0.errors} | ${agg.C.errors} |`);
  lines.push(`| 有效 sourceRef | ${agg.A.sourceRefsValid} | ${agg.B.sourceRefsValid} | ${agg.B0.sourceRefsValid} | ${agg.C.sourceRefsValid} |`);
  lines.push(`| 无效 sourceRef | ${agg.A.sourceRefsInvalid} | ${agg.B.sourceRefsInvalid} | ${agg.B0.sourceRefsInvalid} | ${agg.C.sourceRefsInvalid} |`);
  lines.push(`| 有效证据引用率 | ${agg.A.sourceRefCompleteness.toFixed(3)} | ${agg.B.sourceRefCompleteness.toFixed(3)} | ${agg.B0.sourceRefCompleteness.toFixed(3)} | ${agg.C.sourceRefCompleteness.toFixed(3)} |`);
  lines.push(`| 平均 mustVerify 覆盖率 | ${agg.A.avgCoverageRatio.toFixed(3)} | ${agg.B.avgCoverageRatio.toFixed(3)} | ${agg.B0.avgCoverageRatio.toFixed(3)} | ${agg.C.avgCoverageRatio.toFixed(3)} |`);
  lines.push(`| 停止率（主动收敛） | ${(agg.A.stopRate * 100).toFixed(0)}% (${agg.A.stopCount}/${agg.A.scenarioCount}) | ${(agg.B.stopRate * 100).toFixed(0)}% (${agg.B.stopCount}/${agg.B.scenarioCount}) | ${(agg.B0.stopRate * 100).toFixed(0)}% (${agg.B0.stopCount}/${agg.B0.scenarioCount}) | ${(agg.C.stopRate * 100).toFixed(0)}% (${agg.C.stopCount}/${agg.C.scenarioCount}) |`);
  lines.push(`| 工具模式 | ${agg.A.toolMode ?? "n/a"} | ${agg.B.toolMode ?? "n/a"} | ${agg.B0.toolMode ?? "n/a"} | ${agg.C.toolMode ?? "n/a"} |`);
  lines.push(`| 渲染模式 | ${agg.A.renderMode ?? "n/a"} | ${agg.B.renderMode ?? "n/a"} | ${agg.B0.renderMode ?? "n/a"} | ${agg.C.renderMode ?? "n/a"} |`);
  lines.push("");

  // B0 门禁（A vs B0）与 guidanceDelta（B vs B0：描述引导收益）
  lines.push("## B0 门禁（无引导 facade vs A）与描述引导收益（B vs B0）");
  lines.push("");
  lines.push("| B0 门禁 | 结论 | 详情 |");
  lines.push("|------|------|------|");
  lines.push(`| mustVerify 覆盖率不降级 | ${comparison.gateB0.mustVerifyCoverageNotDegraded ? "✓" : "✗"} | ${comparison.gateB0.details.mustVerifyCoverage} |`);
  lines.push(`| 有效证据引用率不降级 | ${comparison.gateB0.sourceRefCompletenessNotDegraded ? "✓" : "✗"} | ${comparison.gateB0.details.sourceRefCompleteness} |`);
  lines.push(`| evidenceLevel 命中率不降级 | ${comparison.gateB0.evidenceLevelNotDegraded ? "✓" : "✗"} | ${comparison.gateB0.details.evidenceLevel} |`);
  lines.push(`| 失败（errors）不恶化 | ${comparison.gateB0.errorsNotWorsened ? "✓" : "✗"} | ${comparison.gateB0.details.errors} |`);
  lines.push(`| 空结果（empty）不恶化 | ${comparison.gateB0.emptyResultsNotWorsened ? "✓" : "✗"} | ${comparison.gateB0.details.emptyResults} |`);
  lines.push(`| 截断（truncated）不恶化 | ${comparison.gateB0.truncatedNotWorsened ? "✓" : "✗"} | ${comparison.gateB0.details.truncated} |`);
  lines.push(`| 非法工具选择不恶化 | ${comparison.gateB0.invalidToolSelectionsNotWorsened ? "✓" : "✗"} | ${comparison.gateB0.details.invalidToolSelections} |`);
  lines.push(`| 解析失败不恶化 | ${comparison.gateB0.parseErrorsNotWorsened ? "✓" : "✗"} | ${comparison.gateB0.details.parseErrors} |`);
  lines.push(`| 逐场景失败门禁全通过 | ${comparison.gateB0.scenarioGatesPassed ? "✓" : "✗"} | ${comparison.gateB0.details.scenarioGates} |`);
  lines.push(`| B0 全部通过 | ${comparison.gateB0.allPassed ? "✓" : "✗"} | |`);
  lines.push("");

  const gd = comparison.guidanceDelta;
  lines.push("### 描述引导收益（guidanceDelta：B 受引导 vs B0 无引导）");
  lines.push("");
  lines.push("> 符号约定：B 相对 B0 的差异。**负值 = B 更优**（受引导减少无效调用/负担），逼近 0 = 引导无差异，单入口收益独立于引导。");
  lines.push("");
  lines.push("| 指标 | B（受引导） | B0（无引导） | B−B0 | 判断 |");
  lines.push("|------|------|------|------|------|");
  const deltaRow = (label: string, bVal: number, b0Val: number, lowerBetter = true) => {
    const d = bVal - b0Val;
    const verdict = lowerBetter
      ? (d < 0 ? "引导减少" : d > 0 ? "引导增加" : "无差异")
      : (d > 0 ? "引导提升" : d < 0 ? "引导降低" : "无差异");
    lines.push(`| ${label} | ${bVal} | ${b0Val} | ${d > 0 ? "+" : ""}${d} | ${verdict} |`);
  };
  deltaRow("schema token 成本", gd.schemaTokenCost.B, gd.schemaTokenCost.B0);
  deltaRow("非法 intent", gd.invalidIntents.B, gd.invalidIntents.B0);
  deltaRow("非法工具选择", gd.invalidToolSelections.B, gd.invalidToolSelections.B0);
  deltaRow("总调用", gd.totalCalls.B, gd.totalCalls.B0);
  deltaRow("重复查询", gd.totalDuplicateQueries.B, gd.totalDuplicateQueries.B0);
  deltaRow("空结果", gd.emptyResults.B, gd.emptyResults.B0);
  deltaRow("失败", gd.errors.B, gd.errors.B0);
  deltaRow("平均 mustVerify 覆盖率", gd.avgCoverageRatio.B, gd.avgCoverageRatio.B0, false);
  deltaRow("停止率（主动收敛）", gd.stopRate.B, gd.stopRate.B0, false);
  const bLat = gd.firstValidEvidenceLatencyMs.B;
  const b0Lat = gd.firstValidEvidenceLatencyMs.B0;
  lines.push(
    `| 首证据延迟(ms) | ${bLat === null ? "unmeasured" : bLat.toFixed(0)} | ${b0Lat === null ? "unmeasured" : b0Lat.toFixed(0)} | ` +
      `${bLat !== null && b0Lat !== null ? (bLat - b0Lat > 0 ? "+" : "") + (bLat - b0Lat).toFixed(0) : "n/a"} | ` +
      `${bLat !== null && b0Lat !== null && bLat < b0Lat ? "引导更快" : bLat !== null && b0Lat !== null && bLat > b0Lat ? "引导更慢" : "n/a"} |`,
  );
  lines.push("");
  lines.push("### 无效 sourceRef 分类明细（预期分类，非失败率）");
  lines.push("");
  lines.push("| 分类 | A 组 | B 组 | B0 组 | C 组 | 说明 |");
  lines.push("|------|------|------|------|------|------|");
  lines.push(`| no_match | ${agg.A.invalidSourceRefByCategory.no_match} | ${agg.B.invalidSourceRefByCategory.no_match} | ${agg.B0.invalidSourceRefByCategory.no_match} | ${agg.C.invalidSourceRefByCategory.no_match} | 检索无匹配，预期输出 |`);
  lines.push(`| profile_only | ${agg.A.invalidSourceRefByCategory.profile_only} | ${agg.B.invalidSourceRefByCategory.profile_only} | ${agg.B0.invalidSourceRefByCategory.profile_only} | ${agg.C.invalidSourceRefByCategory.profile_only} | 风格档案降级引用 |`);
  lines.push(`| empty | ${agg.A.invalidSourceRefByCategory.empty} | ${agg.B.invalidSourceRefByCategory.empty} | ${agg.B0.invalidSourceRefByCategory.empty} | ${agg.C.invalidSourceRefByCategory.empty} | 空结果/空引用 |`);
  lines.push(`| other | ${agg.A.invalidSourceRefByCategory.other} | ${agg.B.invalidSourceRefByCategory.other} | ${agg.B0.invalidSourceRefByCategory.other} | ${agg.C.invalidSourceRefByCategory.other} | 其他无效形态 |`);
  lines.push("");
  lines.push("> 有效证据引用率 = 有效 sourceRef / 总调用。分母含预期的 no_match / profile_only / empty 分类，");
  lines.push("> 它们代表\"本次调用未产生有效事实引用\"，是工具在特定查询下的正常输出，**不是普通失败率**。");
  lines.push("");
  lines.push("## 各场景详情");
  lines.push("");
  for (const p of comparison.scenarios) {
    lines.push(`### ${p.scenarioId}（${p.category}）`);
    lines.push("");
    lines.push("| seed | A 首证 | B 首证 | B0 首证 | C 首证 | A 覆盖 | B 覆盖 | B0 覆盖 | C 覆盖 | schema A/B/B0/C | 非法工具 A/B/C | 重复 A/B/C | 结果字符 B/C |");
    lines.push("|------|--------|--------|---------|--------|--------|--------|---------|--------|---------------|---------------|-----------|------------|");
    const n = Math.max(p.A.length, p.B.length, p.B0.length, p.C.length);
    for (let i = 0; i < n; i++) {
      const a = p.A[i];
      const b = p.B[i];
      const b0 = p.B0[i];
      const c = p.C[i];
      const aFirst = a?.firstValidEvidence ? `#${a.firstValidEvidence.callIndex}(${a.firstValidEvidence.cumulativeLatencyMs}ms)` : "无";
      const bFirst = b?.firstValidEvidence ? `#${b.firstValidEvidence.callIndex}(${b.firstValidEvidence.cumulativeLatencyMs}ms)` : "无";
      const b0First = b0?.firstValidEvidence ? `#${b0.firstValidEvidence.callIndex}(${b0.firstValidEvidence.cumulativeLatencyMs}ms)` : "无";
      const cFirst = c?.firstValidEvidence ? `#${c.firstValidEvidence.callIndex}(${c.firstValidEvidence.cumulativeLatencyMs}ms)` : "无";
      lines.push(
        `| ${i} | ${aFirst} | ${bFirst} | ${b0First} | ${cFirst} | ${a?.mustVerify.coverageRatio.toFixed(3)} | ${b?.mustVerify.coverageRatio.toFixed(3)} | ${b0?.mustVerify.coverageRatio.toFixed(3)} | ${c?.mustVerify.coverageRatio.toFixed(3)} | ${a?.schemaTokenCost}/${b?.schemaTokenCost}/${b0?.schemaTokenCost}/${c?.schemaTokenCost} | ${a?.invalidToolSelections}/${b?.invalidToolSelections}/${c?.invalidToolSelections} | ${a?.totalDuplicateQueries}/${b?.totalDuplicateQueries}/${c?.totalDuplicateQueries} | ${b?.totalResultChars}/${c?.totalResultChars} |`,
      );
    }
    const aAgg = aggregateRealArm(p.A);
    const bAgg = aggregateRealArm(p.B);
    const b0Agg = aggregateRealArm(p.B0);
    const cAgg = aggregateRealArm(p.C);
    lines.push("");
    lines.push(`- 场景聚合：A 平均覆盖=${aAgg.avgCoverageRatio.toFixed(3)}，B=${bAgg.avgCoverageRatio.toFixed(3)}，B0=${b0Agg.avgCoverageRatio.toFixed(3)}，C=${cAgg.avgCoverageRatio.toFixed(3)}；有效证据引用率 A=${aAgg.sourceRefCompleteness.toFixed(3)}，B=${bAgg.sourceRefCompleteness.toFixed(3)}，B0=${b0Agg.sourceRefCompleteness.toFixed(3)}，C=${cAgg.sourceRefCompleteness.toFixed(3)}`);
    lines.push(`- 场景总返回字符：B=${bAgg.totalResultChars}，C=${cAgg.totalResultChars}（envelope 单场景膨胀门槛见上方 envelope 门禁）`);
    lines.push(`- A 首证平均延迟=${aAgg.firstValidEvidenceLatencyMs === null ? "unmeasured" : aAgg.firstValidEvidenceLatencyMs.toFixed(0)}ms；B=${bAgg.firstValidEvidenceLatencyMs === null ? "unmeasured" : bAgg.firstValidEvidenceLatencyMs.toFixed(0)}ms；B0=${b0Agg.firstValidEvidenceLatencyMs === null ? "unmeasured" : b0Agg.firstValidEvidenceLatencyMs.toFixed(0)}ms；C=${cAgg.firstValidEvidenceLatencyMs === null ? "unmeasured" : cAgg.firstValidEvidenceLatencyMs.toFixed(0)}ms`);
    lines.push("");
  }
  lines.push("## 说明");
  lines.push("");
  lines.push("- 本报告记录**模型自主决策**（非 oracle）：模型通过可见工具 schema 决定调用哪个工具/意图。");
  lines.push(`- 当前模式为 **${comparison.mode === "dry-run" ? "dry-run" : "real"}**${comparison.mode === "dry-run" ? "：确定性 stub 模型，零 API 调用，仅验证 runner 框架" : "：真实模型 replay，需授权" }。`);
  lines.push(`- 场景：${comparison.scenarios.map((p) => p.scenarioId).join("，")} × ${comparison.aggregation.A.scenarioCount || 0} seed × A/B/B0/C 四臂成对。`);
  lines.push("- B 组 facade 为纯透传：检索/截断/nextQueryHint 由底层工具完成；B0 为无 INTENT_USAGE 引导的对照（解耦单入口收益与描述引导收益）；C 在 B 基础上剪裁模型可见 content 为 compact envelope（details 不变）。");
  lines.push("- Phase 5.3 关键：envelope 门禁逐场景/逐单调用校验「单场景/单调用结果膨胀」，聚合下降不得掩盖局部膨胀。");
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
    for (const arm of ["A", "B", "B0", "C"] as const) {
      const metricsArr = arm === "A" ? p.A : arm === "B" ? p.B : arm === "B0" ? p.B0 : p.C;
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
            toolMode: m.toolMode,
            renderMode: m.renderMode,
            fingerprint: m.provenance ? [m.provenance.provider, m.provenance.model, m.provenance.route].filter(Boolean).join(":") : undefined,
          },
        });
        m.turns.forEach((t, idx) => {
          // Phase 4.2.2：记录每回合实际 arguments/query 及结果摘要，解释 canon:empty 等降级。
          const args =
            t.decision.kind === "tool_call" ? t.decision.arguments : undefined;
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
              // 实际发送给底层工具的 arguments 与 query（b 组含 intent）
              arguments: args,
              query: typeof args?.query === "string" ? args.query : undefined,
              // 结果摘要：截取工具返回文本，解释为何 empty / 命中什么证据
              resultSummary: t.resultText ? t.resultText.slice(0, 200) : undefined,
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