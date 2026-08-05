/**
 * 不确定性驱动检索决策 A/B 对照实验（第一轮最小实验）
 *
 * 实验目标：验证"不确定性驱动的检索决策"是否能在不增加事实硬伤的前提下
 * 减少无效检索，且文学质量不下降。
 *
 * A 组（baseline）：当前逻辑——强制跨源检索 prompt（retrievalPromptOverride 不传）
 * B 组（treatment）：不确定性驱动——retrievalPromptOverride 覆盖决策规则
 *
 * 控制变量：同 workspace、同 chapter、同 model、同 budget、同 timeout
 * 差异变量：retrievalPromptOverride 是否传入（A=undefined, B=决策规则文本）
 *
 * 指标（从 V2Output + stageResults + trajectory 提取）：
 * - 工具调用次数（toolCalls）
 * - 必需事实召回率（sourceRefs / mustVerify）
 * - 事实硬伤（FactGuard errors）
 * - 章节完整性（completeness gate）
 * - 生成延迟（durationMs）
 * - token 成本（modelCalls.tokenUsage 聚合，注意 unknown gap）
 *
 * 最低通过条件：
 * - B 组事实硬伤 ≤ A 组（FactGuard errors 不增加）
 * - B 组工具调用次数 < A 组（减少无效检索）
 * - B 组必需事实召回率 ≥ A 组（不漏关键事实）
 * - 人工盲测文学质量不下降（用户裁决）
 *
 * 不改生产链路：retrievalPromptOverride 生产路径全链路 undefined，行为不变。
 * eval-only 模块，需在 tsconfig.eval.json 注册。
 */

import { runUnifiedPipeline } from "../../v2/core/unified-entry.js";
import type { ChapterIntent } from "../../v2/core/chapter-intent-builder.js";
import type { CompiledContext, ContextFact, V2Output, WorldRuleFact } from "../../v2/core/types.js";
import type {
  ModelGenerateFn,
  ModelGenerateInput,
} from "../../v2/adapters/legacy-model-route-adapter.js";
import { resolveWriterPromptProfile } from "../../v2/core/model-prompt-adapter.js";
import { checkCandidateFactGuard } from "../../v2/core/orchestrator-factguard.js";
import type { UnifiedOrchestratorInput } from "../../v2/core/orchestrator-types.js";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import {
  extractConfirmedEvidenceFromTrajectory,
  computeMustVerifyCoverage,
  evaluateRecallCriterion,
  isValidSourceRef,
  type ConfirmedEvidence,
  type RecallCriterion,
} from "./uncertainty-recall-metrics.js";
import { join } from "node:path";

// ============================================================================
// B 组决策规则 prompt
// ============================================================================

/**
 * B 组的检索决策规则 prompt（替换 A 组的"请先使用跨源叙事证据检索工具查找..."）。
 *
 * 不暴露思维链，只改变决策规则：
 * - 上下文足够 → 直接输出正文，不调工具
 * - 缺少可能改变事实/人物状态/因果关系的信息 → 调最相关工具
 * - 不为"完成流程"做无必要检索
 */
export const UNCERTAINTY_DRIVEN_RETRIEVAL_PROMPT = [
  "检索决策规则：",
  "- 如果现有上下文已经足以保证事实、人物状态和因果关系正确，可以直接输出正文，不调用任何工具。",
  '- 如果缺少的信息可能改变上述三项之一（事实/人物状态/因果关系），先调用最相关的证据工具查证。',
  '- 不要为了"完成流程"而进行无必要检索。',
].join("\n");

// ============================================================================
// 类型定义
// ============================================================================

/** 简化 case 类型（不依赖 GeneratorCase，最小实验用） */
export interface AblationCase {
  caseId: string;
  genre: string;
  targetChapter: number;
  /** 前文（续写用） */
  prefix: string;
  /** 已知角色名（StoryPreservationGate 用） */
  characterNames?: string[];
  /**
   * 风险等级（驱动实验分组与报告标注）。
   * - low：低风险，上下文自包含，无需检索即可正确生成（第一轮 5 个 case 均为 low）
   * - high：高风险，存在必须验证的事实/状态/因果，不检索可能写错
   */
  riskLevel?: "low" | "high";
  /**
   * 作者章纲必须包含的内容（驱动 EvidencePlan.mustVerify 非空）。
   *
   * buildChapterIntentString 会把它转成"作者章纲必须包含：X；Y；Z"，
   * extractMustVerifyItems 路径 1 匹配此行并直接返回，使 mustVerify 非空。
   * 高风险 case 应在此声明"必须验证的事实"（如"确认林默伤势恢复情况"）。
   */
  authorMustInclude?: string[];
  /**
   * 不可破坏的事实（注入 ChapterIntent.inviolableFacts + FactGuard 授权）。
   * buildChapterIntentString 把它转成"不可破坏的事实：X；Y；Z"。
   */
  inviolableFacts?: string[];
  /**
   * 世界规则（注入 CompiledContext.worldRules + context.facts 授权 FactGuard）。
   * description 中的术语会被 FactGuard 视为已授权，避免通用术语误报。
   */
  worldRules?: Array<{
    id: string;
    description: string;
    type: string;
    affectedCharacters?: string[];
  }>;
  /**
   * 作品宪法快照（注入 CompiledContext.constitution，授权 FactGuard）。
   * 提供后 IMMUTABLE-FACTS-COMPILER-1 可从 constitution 提取授权的高影响设定。
   */
  constitution?: {
    workIdentity: string;
    readerPromise: string[];
    genrePromises: string[];
    protagonistCoreConflict: string;
    thematicQuestions: string[];
    aestheticDirection: string[];
    forbiddenDrift: string[];
    sourceIds: string[];
  };
}

/** 单臂指标 */
export interface ArmMetrics {
  arm: "A" | "B";
  caseId: string;
  success: boolean;
  textLength: number;
  durationMs: number;
  /** 工具调用次数（Agentic loop 内） */
  toolCalls: number;
  /** 收集的 confirmed sourceRefs 数（Step 1：与 confirmedEvidenceCount 同义，向后兼容） */
  sourceRefsCount: number;
  /** Step 1：confirmed 证据数（按 VALID_EVIDENCE_LEVELS 过滤） */
  confirmedEvidenceCount: number;
  /** Step 1：mustVerify 覆盖率（0-1；mustVerifyCount=0 时为 1） */
  mustVerifyCoverage: number;
  /** Step 1：未覆盖的 mustVerify 项 */
  uncoveredMustVerify: string[];
  /** EvidencePlan.mustVerify 数 */
  mustVerifyCount: number;
  /** FactGuard 硬错误数 */
  factGuardErrors: number;
  /** 章节完整性门禁是否通过 */
  completenessPassed: boolean;
  /** token 聚合（unknown gap 标注） */
  tokenIn: number | "unknown";
  tokenOut: number | "unknown";
  /** 最终交付来源（raw/editorial/null） */
  selectedSource: string | null;
  /** 无关证据比例（近似值：证据片段未在正文中出现的比例，0-1） */
  irrelevantEvidenceRatio: number;
  /** 失败原因（success=false 时） */
  failureReason?: string;
  /** 风险等级（low/high，用于报告中区分 case 难度） */
  riskLevel: "low" | "high";
}

/** 单臂结果 */
export interface ArmResult {
  arm: "A" | "B";
  caseId: string;
  v2Output: V2Output;
  metrics: ArmMetrics;
}

/** 单 case A/B 对比 */
export interface CaseComparison {
  caseId: string;
  armA: ArmResult;
  armB: ArmResult;
}

/** 实验结果 */
export interface AblationResult {
  runId: string;
  timestamp: string;
  cases: CaseComparison[];
  /** 聚合指标 */
  aggregate: {
    armA: AggregatedMetrics;
    armB: AggregatedMetrics;
  };
  /** 最低通过条件判定 */
  passCriteria: {
    factGuardNotWorse: boolean;
    toolCallsReduced: boolean;
    /** Step 1：三态（pass/fail/unmeasured），unmeasured 时不能声称通过 */
    recallNotWorse: RecallCriterion;
    /** recallNotWorse=unmeasured 时给出原因 */
    recallUnmeasuredReason?: string;
    overallPassed: boolean;
  };
}

export interface AggregatedMetrics {
  successCount: number;
  avgToolCalls: number;
  avgSourceRefs: number;
  avgFactGuardErrors: number;
  avgDurationMs: number;
  totalTokenIn: number | "unknown";
  totalTokenOut: number | "unknown";
  completenessPassRate: number;
  avgIrrelevantEvidenceRatio: number;
}

// ============================================================================
// 内部工具函数（重新实现，避免改 eval-pipeline-adapter.ts 的 exports）
// ============================================================================

function buildFullIntent(caseData: AblationCase): ChapterIntent {
  return {
    chapterFunction: "推进核心情节，让事件有实质进展",
    readerExperience: ["悬念", "张力", "章末钩子"],
    currentPressure: ["主角面临关键挑战", "事件即将升级"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: caseData.characterNames ?? [],
    // 高风险 case：注入不可破坏的事实 + 作者章纲必须包含
    inviolableFacts: caseData.inviolableFacts ?? [],
    // authorMustInclude 会被 buildChapterIntentString 转成"作者章纲必须包含：X；Y；Z"，
    // extractMustVerifyItems 路径 1 匹配此行使 EvidencePlan.mustVerify 非空。
    authorMustInclude: caseData.authorMustInclude,
    sourceRefs: [],
  };
}

function buildFullContext(caseData: AblationCase): CompiledContext {
  const worldRules: WorldRuleFact[] = [
    {
      id: "eval-genre",
      description: `类型：${caseData.genre}`,
      type: "genre",
      affectedCharacters: [],
      sourceIds: ["eval"],
    },
  ];
  // 高风险 case：注入 case 声明的 worldRules
  if (caseData.worldRules && caseData.worldRules.length > 0) {
    for (const wr of caseData.worldRules) {
      worldRules.push({
        id: wr.id,
        description: wr.description,
        type: wr.type,
        affectedCharacters: wr.affectedCharacters ?? [],
        // sourceIds 用 "world-canon" 使 IMMUTABLE-FACTS-COMPILER-1 正则匹配，授权高影响设定
        sourceIds: ["world-canon"],
      });
    }
  }
  // 把 worldRules 同时放入 context.facts（sourceIds=["world-canon"]），
  // 使 IMMUTABLE-FACTS-COMPILER-1 把其中的术语（心法/封印/宗门等）视为已授权，
  // 避免 post-hoc FactGuard 通用术语误报。
  const facts: ContextFact[] = worldRules
    .filter((wr) => wr.sourceIds.includes("world-canon"))
    .map((wr) => ({
      id: wr.id,
      content: wr.description,
      sourceIds: wr.sourceIds,
      kind: "fact",
    }));
  return {
    facts,
    characterStates: [],
    openLoops: [],
    worldRules,
    styleReferences: [],
    sourceMap: [],
    constitution: caseData.constitution ?? null,
    longTermState: null,
  };
}

function wrapModelGenerateWithRoute(
  modelGenerate: ModelGenerateFn,
  forcedRoute: string,
): ModelGenerateFn {
  return async (input: ModelGenerateInput) => {
    return modelGenerate({ ...input, route: forcedRoute });
  };
}

// ============================================================================
// Trajectory 解析（从 JSONL 提取 sourceRefs / mustVerify / evidence excerpts）
// ============================================================================

/** Trajectory JSONL 单行结构（与 trajectory-store.ts TrajectoryEntry 对齐） */
interface TrajectoryEntry {
  type: string;
  timestamp: number;
  data: unknown;
}

/**
 * 读取 trajectory JSONL 文件，解析为 TrajectoryEntry 数组。
 * 文件不存在或解析失败时返回空数组。
 */
function readTrajectory(trajectoryPath: string): TrajectoryEntry[] {
  if (!trajectoryPath || !existsSync(trajectoryPath)) {
    return [];
  }
  try {
    const content = readFileSync(trajectoryPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const entries: TrajectoryEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as TrajectoryEntry);
      } catch {
        // 跳过无法解析的行
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * 从 trajectory 提取 confirmed sourceRefs。
 *
 * 两个来源：
 * 1. ranked_evidence 条目的 data.evidences[].sourceRef（如果存在）
 * 2. tool_event 条目的 data.result.details.sourceRef（tool_execution_end）
 *
 * 工具返回的 sourceRef 可能是 "ranked:no-match" / "character:empty" 等无效值，
 * 这些代表"未找到证据"，过滤掉不计入有效 sourceRefs。
 */
function extractSourceRefsFromTrajectory(trajectoryPath: string): string[] {
  const entries = readTrajectory(trajectoryPath);
  const sourceRefs: string[] = [];
  const INVALID_REFS = new Set(["ranked:no-match", "character:empty", "empty", "no-match"]);
  for (const entry of entries) {
    // 来源 1：ranked_evidence 条目
    if (entry.type === "ranked_evidence") {
      const data = entry.data as { evidences?: Array<{ sourceRef?: string }> } | null;
      if (Array.isArray(data?.evidences)) {
        for (const ev of data.evidences) {
          if (typeof ev?.sourceRef === "string" && !INVALID_REFS.has(ev.sourceRef)) {
            sourceRefs.push(ev.sourceRef);
          }
        }
      }
    }
    // 来源 2：tool_execution_end 条目
    if (entry.type === "tool_event") {
      const data = entry.data as { type?: string; result?: { details?: { sourceRef?: string } } } | null;
      if (data?.type === "tool_execution_end") {
        const ref = data?.result?.details?.sourceRef;
        if (typeof ref === "string" && !INVALID_REFS.has(ref) && !ref.endsWith(":no-match") && !ref.endsWith(":empty")) {
          sourceRefs.push(ref);
        }
      }
    }
  }
  return sourceRefs;
}

/**
 * 从 trajectory 提取 EvidencePlan.mustVerify 的数量。
 *
 * 找 evidence_plan 条目，返回 data.mustVerify.length。
 * 无 evidence_plan 条目时返回 0。
 */
function extractMustVerifyFromTrajectory(trajectoryPath: string): number {
  const entries = readTrajectory(trajectoryPath);
  for (const entry of entries) {
    if (entry.type !== "evidence_plan") continue;
    const data = entry.data as { mustVerify?: unknown[] } | null;
    if (Array.isArray(data?.mustVerify)) {
      return data.mustVerify.length;
    }
  }
  return 0;
}

/**
 * 从 trajectory 提取证据片段（sourceRef + excerpt），用于无关证据比例计算。
 *
 * 两个来源：
 * 1. ranked_evidence 条目的 data.evidences[]（sourceRef + excerpt）
 * 2. tool_execution_end 条目的 data.result.content[].text（作为 excerpt）+ details.sourceRef
 *
 * 工具返回"未找到"的无效结果（sourceRef=no-match/empty）不计入。
 */
function extractEvidenceExcerptsFromTrajectory(
  trajectoryPath: string,
): Array<{ sourceRef: string; excerpt: string }> {
  const entries = readTrajectory(trajectoryPath);
  const excerpts: Array<{ sourceRef: string; excerpt: string }> = [];
  const INVALID_REFS = new Set(["ranked:no-match", "character:empty", "empty", "no-match"]);
  for (const entry of entries) {
    // 来源 1：ranked_evidence 条目
    if (entry.type === "ranked_evidence") {
      const data = entry.data as { evidences?: Array<{ sourceRef?: string; excerpt?: string }> } | null;
      if (Array.isArray(data?.evidences)) {
        for (const ev of data.evidences) {
          if (typeof ev?.sourceRef === "string" && typeof ev?.excerpt === "string" && !INVALID_REFS.has(ev.sourceRef)) {
            excerpts.push({ sourceRef: ev.sourceRef, excerpt: ev.excerpt });
          }
        }
      }
    }
    // 来源 2：tool_execution_end 条目
    if (entry.type === "tool_event") {
      const data = entry.data as {
        type?: string;
        result?: {
          details?: { sourceRef?: string };
          content?: Array<{ type?: string; text?: string }>;
        };
      } | null;
      if (data?.type === "tool_execution_end") {
        const ref = data?.result?.details?.sourceRef;
        if (typeof ref === "string" && !INVALID_REFS.has(ref) && !ref.endsWith(":no-match") && !ref.endsWith(":empty")) {
          // 从 content[].text 提取 excerpt
          const textParts = (data?.result?.content ?? [])
            .filter((c) => c?.type === "text" && typeof c.text === "string")
            .map((c) => c.text as string);
          const excerpt = textParts.join("\n");
          if (excerpt.length > 0) {
            excerpts.push({ sourceRef: ref, excerpt });
          }
        }
      }
    }
  }
  return excerpts;
}

// ============================================================================
// Post-hoc FactGuard（B2 跳过 FactGuard，用此函数测量事实硬伤，不阻断）
// ============================================================================

/**
 * 对 B2 交付正文跑 post-hoc FactGuard，返回硬错误数。
 *
 * B2 evalMode 跳过 FactGuard，但用户最低通过条件要求"B 组不能增加事实硬伤"。
 * 此函数仅用于测量，不阻断交付。构造最小 input 复用 checkCandidateFactGuard。
 *
 * @returns 硬错误数（ok=true 时为 0）；测量失败返回 -1（不计入比较）
 */
function runPostHocFactGuard(
  text: string,
  caseData: AblationCase,
  intent: ChapterIntent,
  context: CompiledContext,
): number {
  try {
    const minimalInput = {
      characterNames: caseData.characterNames ?? [],
      context,
      intent,
      chapterNumber: caseData.targetChapter,
      ontologyLevels: [],
      // 使用 case 提供的 constitution（IMMUTABLE-FACTS-COMPILER-1 从 input.constitution 读取，
      // 非 input.context.constitution）。null 时跳过 constitution 授权，但不阻断。
      constitution: caseData.constitution ?? null,
      projectRoot: process.cwd(),
      workspaceId: `ablation-${caseData.caseId}`,
    } as unknown as UnifiedOrchestratorInput;
    const result = checkCandidateFactGuard(text, minimalInput);
    return result.ok ? 0 : result.errors.length;
  } catch {
    return -1;
  }
}

// ============================================================================
// 无关证据比例（启发式近似）
// ============================================================================

/**
 * 计算无关证据比例（近似值）。
 *
 * 启发式：对每个证据片段（excerpt），检查是否在最终正文中有文本重叠
 * （substring match，连续 ≥ 8 字符）。无重叠的证据视为"无关"。
 *
 * @param evidenceExcerpts 从 trajectory 提取的证据片段
 * @param finalText 最终交付正文
 * @returns 无关证据比例（0-1），total=0 时返回 0
 */
export function computeIrrelevantEvidenceRatio(
  evidenceExcerpts: Array<{ sourceRef: string; excerpt: string }>,
  finalText: string,
): number {
  if (evidenceExcerpts.length === 0) return 0;
  // 中文 6 字符已足够具体（避免随机匹配常见短语），且能覆盖短证据片段
  const MIN_OVERLAP_LEN = 6;
  let irrelevantCount = 0;
  for (const ev of evidenceExcerpts) {
    const excerpt = ev.excerpt.trim();
    if (excerpt.length < MIN_OVERLAP_LEN) {
      // 太短的片段无法可靠判断，视为无关
      irrelevantCount++;
      continue;
    }
    // 滑动窗口检查 substring 重叠
    let found = false;
    for (let i = 0; i <= excerpt.length - MIN_OVERLAP_LEN; i++) {
      const sub = excerpt.slice(i, i + MIN_OVERLAP_LEN);
      if (finalText.includes(sub)) {
        found = true;
        break;
      }
    }
    if (!found) {
      irrelevantCount++;
    }
  }
  return irrelevantCount / evidenceExcerpts.length;
}

// ============================================================================
// 指标提取
// ============================================================================

/**
 * 从 V2Output 提取单臂指标。
 *
 * B2 evalMode 路径下，Agentic 指标写入 stageResults.evalAgentic（非 stageResults.novelos）。
 * 完整性写入 stageResults.finalTextCompleteness；selectedSource 写入 stageResults.finalSelection。
 * sourceRefs / mustVerifyCount / 证据片段从 trajectory JSONL 解析（orchestrator 未持久化到 stageResults）。
 * factGuardErrors 用 post-hoc FactGuard 测量（B2 跳过 FactGuard）。
 *
 * 已知 gap：tokenUsage 在很多路径为 "unknown"（orchestrator-types.ts:63 注释）。
 *
 * 导出供测试用 fixture V2Output 验证字段提取正确性。
 */
export function extractMetrics(
  arm: "A" | "B",
  caseId: string,
  result: V2Output,
  durationMs: number,
  trajectoryPath?: string,
  caseData?: AblationCase,
  intent?: ChapterIntent,
  context?: CompiledContext,
): ArmMetrics {
  const stageResults = (result.stageResults ?? {}) as Record<string, unknown>;
  const text = result.text ?? "";

  // 从 stageResults.evalAgentic 提取 Agentic 指标（B2 路径实际写入位置）
  const evalAgentic = (stageResults.evalAgentic ?? {}) as {
    toolCalls?: number;
    failureReason?: string | null;
    trajectoryPath?: string;
  };

  // 从 stageResults.finalTextCompleteness 提取完整性
  const finalTextCompleteness = (stageResults.finalTextCompleteness ?? {}) as {
    passed?: boolean;
  };

  // 从 stageResults.finalSelection 提取 selectedSource
  const finalSelection = (stageResults.finalSelection ?? {}) as {
    selectedSource?: string;
  };

  // 从 trajectory 解析 sourceRefs / 证据片段
  const actualTrajectoryPath = trajectoryPath ?? evalAgentic.trajectoryPath ?? "";
  // Step 1：用 extractConfirmedEvidenceFromTrajectory 替代旧的 extractSourceRefsFromTrajectory，
  // 只提取 evidenceLevel ∈ VALID_EVIDENCE_LEVELS 的 confirmed 证据（过滤 inferred/profile_only）。
  const confirmedEvidences: ConfirmedEvidence[] = extractConfirmedEvidenceFromTrajectory(actualTrajectoryPath);
  const evidenceExcerpts = extractEvidenceExcerptsFromTrajectory(actualTrajectoryPath);
  // sourceRefs 保留向后兼容（值 = confirmedEvidences 长度）
  const sourceRefs = confirmedEvidences.map((e) => e.sourceRef);

  // mustVerifyCount 只统计作者通过 authorMustInclude 声明的事实（实验指标语义）。
  // trajectory 里的 EvidencePlan.mustVerify 还包含系统从 seed 派生的角色名/地名
  // （extractMustVerifyItems 路径 2，生产 M1 启发式），这些不是"作者要求必须验证
  // 的事实"，不应作为召回率分母。
  // - 低风险 case（无 authorMustInclude）mustVerifyCount=0，不参与召回率比较
  //   （符合"低风险上下文自包含，无需检索"的实验预期）
  // - 高风险 case mustVerifyCount=authorMustInclude.length，正确测试必需事实召回
  // 注意：这是实验 harness 指标语义修复，不改生产 evidence-plan.ts 的提取逻辑。
  const mustVerifyCount = caseData?.authorMustInclude?.length ?? 0;

  // Step 1：按 mustVerify 项计算 confirmed 覆盖率（逐项匹配，而非总数比）
  const mustVerifyItems = caseData?.authorMustInclude ?? [];
  const coverage = computeMustVerifyCoverage(mustVerifyItems, confirmedEvidences);

  // post-hoc FactGuard（B2 跳过 FactGuard，用此测量事实硬伤）
  const factGuardErrors =
    caseData && intent && context
      ? runPostHocFactGuard(text, caseData, intent, context)
      : 0;

  // 无关证据比例（启发式近似）
  const irrelevantEvidenceRatio = computeIrrelevantEvidenceRatio(evidenceExcerpts, text);

  // 从 stageResults.modelCalls 聚合 token
  const modelCalls = (stageResults.modelCalls ?? []) as Array<{
    tokenUsage?: "unknown" | { in: number; out: number };
  }>;
  let tokenInSum = 0;
  let tokenOutSum = 0;
  let hasUnknown = false;
  for (const call of modelCalls) {
    if (call.tokenUsage === "unknown" || call.tokenUsage === undefined) {
      hasUnknown = true;
    } else {
      tokenInSum += call.tokenUsage.in;
      tokenOutSum += call.tokenUsage.out;
    }
  }
  // 如果所有调用都是 unknown，标记为 "unknown"；否则返回已知聚合值
  const tokenIn: number | "unknown" = hasUnknown && tokenInSum === 0 && tokenOutSum === 0
    ? "unknown"
    : tokenInSum;
  const tokenOut: number | "unknown" = hasUnknown && tokenInSum === 0 && tokenOutSum === 0
    ? "unknown"
    : tokenOutSum;

  const completenessPassed = finalTextCompleteness.passed ?? text.length > 0;
  const success = result.status === "ok" && text.length > 0;

  return {
    arm,
    caseId,
    success,
    textLength: text.length,
    durationMs,
    toolCalls: evalAgentic.toolCalls ?? 0,
    sourceRefsCount: sourceRefs.length,
    confirmedEvidenceCount: confirmedEvidences.length,
    mustVerifyCoverage: coverage.coverageRatio,
    uncoveredMustVerify: coverage.uncoveredItems,
    mustVerifyCount,
    factGuardErrors,
    completenessPassed,
    tokenIn,
    tokenOut,
    selectedSource: finalSelection.selectedSource ?? result.selectedSource ?? null,
    irrelevantEvidenceRatio,
    failureReason: success ? undefined : (evalAgentic.failureReason ?? "生成失败"),
    riskLevel: caseData?.riskLevel ?? "low",
  };
}

// ============================================================================
// runAblationArm：跑单臂
// ============================================================================

/**
 * 跑单臂（A 或 B）。
 *
 * A 组：retrievalPromptOverride=undefined（默认强制检索 prompt）
 * B 组：retrievalPromptOverride=UNCERTAINTY_DRIVEN_RETRIEVAL_PROMPT
 *
 * evalMode="B2"：启用 Agentic + 检索，不启用验证（A/B 差异只在检索决策规则）。
 */
export async function runAblationArm(
  arm: "A" | "B",
  caseData: AblationCase,
  modelGenerate: ModelGenerateFn,
  generateRoute: string,
  timeoutMs: number,
): Promise<ArmResult> {
  const retrievalPromptOverride =
    arm === "B" ? UNCERTAINTY_DRIVEN_RETRIEVAL_PROMPT : undefined;
  const start = Date.now();

  const intent = buildFullIntent(caseData);
  const context = buildFullContext(caseData);
  const wrappedModelGenerate = wrapModelGenerateWithRoute(modelGenerate, generateRoute);

  const result = await runUnifiedPipeline({
    workspaceId: `ablation-${caseData.caseId}-${arm}`,
    chapterId: `${caseData.caseId}-${arm}`,
    chapterNumber: caseData.targetChapter,
    projectRoot: process.cwd(),
    candidateTimeoutMs: timeoutMs,
    // Eval 参数
    evalMode: "B2",
    evalPrefix: caseData.prefix,
    evalIntent: intent,
    evalContext: context,
    evalModelGenerate: wrappedModelGenerate,
    evalCharacterNames: caseData.characterNames,
    evalPromptProfile: resolveWriterPromptProfile({ route: generateRoute }),
    // A/B 差异变量
    retrievalPromptOverride,
  });

  const durationMs = Date.now() - start;
  // 从 stageResults.evalAgentic 提取 trajectoryPath，连同 caseData/intent/context 传给 extractMetrics
  const stageResults = (result.stageResults ?? {}) as Record<string, unknown>;
  const evalAgentic = (stageResults.evalAgentic ?? {}) as { trajectoryPath?: string };
  const metrics = extractMetrics(
    arm,
    caseData.caseId,
    result,
    durationMs,
    evalAgentic.trajectoryPath,
    caseData,
    intent,
    context,
  );

  return { arm, caseId: caseData.caseId, v2Output: result, metrics };
}

// ============================================================================
// runAblation：对多 case 跑 A/B 对照
// ============================================================================

export interface RunAblationOptions {
  cases: AblationCase[];
  modelGenerate: ModelGenerateFn;
  generateRoute: string;
  timeoutMs: number;
  outputDir: string;
}

/**
 * 从 JSON 文件加载 case set。
 *
 * JSON 格式：
 * ```json
 * {
 *   "caseSetId": "...",
 *   "cases": [
 *     { "caseId": "...", "genre": "...", "targetChapter": 5, "prefix": "...", "characterNames": ["..."] }
 *   ]
 * }
 * ```
 */
export function loadAblationCases(caseSetPath: string): AblationCase[] {
  const content = readFileSync(caseSetPath, "utf-8");
  const data = JSON.parse(content) as { cases?: unknown };
  if (!Array.isArray(data.cases)) {
    throw new Error(`case set 文件 ${caseSetPath} 缺少 cases 数组`);
  }
  return data.cases.map((c, i) => {
    const cs = c as Partial<AblationCase>;
    if (typeof cs.caseId !== "string" || typeof cs.genre !== "string" ||
        typeof cs.targetChapter !== "number" || typeof cs.prefix !== "string") {
      throw new Error(`case set 第 ${i + 1} 个 case 缺少必填字段（caseId/genre/targetChapter/prefix）`);
    }
    return {
      caseId: cs.caseId,
      genre: cs.genre,
      targetChapter: cs.targetChapter,
      prefix: cs.prefix,
      characterNames: cs.characterNames,
      riskLevel: cs.riskLevel,
      authorMustInclude: cs.authorMustInclude,
      inviolableFacts: cs.inviolableFacts,
      worldRules: cs.worldRules,
      constitution: cs.constitution,
    };
  });
}

/**
 * 对每个 case 跑 A/B 两组，产出对比结果 + 报告 + 盲测包。
 *
 * 控制：同 modelGenerate、同 route、同 timeout，差异只在 retrievalPromptOverride。
 */
export async function runAblation(options: RunAblationOptions): Promise<AblationResult> {
  const runId = `run-${Date.now()}`;
  const timestamp = new Date().toISOString();
  const outputDir = options.outputDir;
  mkdirSync(outputDir, { recursive: true });

  const caseComparisons: CaseComparison[] = [];

  for (const caseData of options.cases) {
    console.log(`[ablation] case=${caseData.caseId} 跑 A 组...`);
    const armA = await runAblationArm(
      "A",
      caseData,
      options.modelGenerate,
      options.generateRoute,
      options.timeoutMs,
    );
    console.log(
      `[ablation] case=${caseData.caseId} A 组完成：success=${armA.metrics.success} toolCalls=${armA.metrics.toolCalls} duration=${armA.metrics.durationMs}ms`,
    );

    console.log(`[ablation] case=${caseData.caseId} 跑 B 组...`);
    const armB = await runAblationArm(
      "B",
      caseData,
      options.modelGenerate,
      options.generateRoute,
      options.timeoutMs,
    );
    console.log(
      `[ablation] case=${caseData.caseId} B 组完成：success=${armB.metrics.success} toolCalls=${armB.metrics.toolCalls} duration=${armB.metrics.durationMs}ms`,
    );

    caseComparisons.push({ caseId: caseData.caseId, armA, armB });

    // 保存每 case 的原始 V2Output
    const caseDir = join(outputDir, caseData.caseId);
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(
      join(caseDir, "arm-A-v2output.json"),
      JSON.stringify(armA.v2Output, null, 2),
      "utf-8",
    );
    writeFileSync(
      join(caseDir, "arm-B-v2output.json"),
      JSON.stringify(armB.v2Output, null, 2),
      "utf-8",
    );
    // 保存正文文本
    if (armA.v2Output.text) {
      writeFileSync(join(caseDir, "arm-A-text.md"), armA.v2Output.text, "utf-8");
    }
    if (armB.v2Output.text) {
      writeFileSync(join(caseDir, "arm-B-text.md"), armB.v2Output.text, "utf-8");
    }
  }

  // 聚合指标
  const aggregate = {
    armA: aggregateMetrics(caseComparisons.map((c) => c.armA.metrics)),
    armB: aggregateMetrics(caseComparisons.map((c) => c.armB.metrics)),
  };

  // 最低通过条件
  // Step 1：用 evaluateRecallCriterion 替代旧的 avgRecall 比较，支持三态
  const recallCriterion = evaluateRecallCriterion(
    caseComparisons.map((c) => c.armA.metrics),
    caseComparisons.map((c) => c.armB.metrics),
  );
  const passCriteria = {
    factGuardNotWorse: aggregate.armB.avgFactGuardErrors <= aggregate.armA.avgFactGuardErrors,
    toolCallsReduced: aggregate.armB.avgToolCalls < aggregate.armA.avgToolCalls,
    recallNotWorse: recallCriterion.value,
    recallUnmeasuredReason: recallCriterion.reason,
  };
  // Step 1：recallNotWorse=unmeasured 时 overallPassed=false（不能声称通过）
  const overallPassed =
    passCriteria.factGuardNotWorse &&
    passCriteria.toolCallsReduced &&
    passCriteria.recallNotWorse === "pass";

  const result: AblationResult = {
    runId,
    timestamp,
    cases: caseComparisons,
    aggregate,
    passCriteria: {
      ...passCriteria,
      overallPassed,
    },
  };

  // 产出对比报告
  const report = generateComparisonReport(result);
  writeFileSync(join(outputDir, "comparison-report.md"), report, "utf-8");

  // 产出匿名盲测包
  const blindPack = generateBlindPack(result);
  writeFileSync(join(outputDir, "blind-pack.json"), JSON.stringify(blindPack, null, 2), "utf-8");

  // 产出完整结果 JSON
  writeFileSync(join(outputDir, "ablation-result.json"), JSON.stringify(result, null, 2), "utf-8");

  console.log(`[ablation] 完成。报告：${join(outputDir, "comparison-report.md")}`);
  console.log(`[ablation] 最低通过条件：${overallPassed ? "PASS" : "FAIL"}`);

  return result;
}

// Step 1：旧 avgRecall 已移除，由 uncertainty-recall-metrics.ts 的 evaluateRecallCriterion 替代

export function aggregateMetrics(metrics: ArmMetrics[]): AggregatedMetrics {
  const n = metrics.length;
  const successCount = metrics.filter((m) => m.success).length;
  // Token 聚合：只有所有 case 都是 unknown 才返回 "unknown"；
  // 部分未知时累加已知值，让报告显示可用数据（而非被单个失败 case 污染为整体 unknown）。
  const knownTokenMetrics = metrics.filter((m) => m.tokenIn !== "unknown");
  const allUnknown = knownTokenMetrics.length === 0;
  const totalTokenIn: number | "unknown" = allUnknown
    ? "unknown"
    : knownTokenMetrics.reduce((s, m) => s + (m.tokenIn === "unknown" ? 0 : m.tokenIn), 0);
  const totalTokenOut: number | "unknown" = allUnknown
    ? "unknown"
    : knownTokenMetrics.reduce((s, m) => s + (m.tokenOut === "unknown" ? 0 : m.tokenOut), 0);

  return {
    successCount,
    avgToolCalls: metrics.reduce((s, m) => s + m.toolCalls, 0) / n,
    avgSourceRefs: metrics.reduce((s, m) => s + m.sourceRefsCount, 0) / n,
    avgFactGuardErrors: metrics.reduce((s, m) => s + Math.max(m.factGuardErrors, 0), 0) / n,
    avgDurationMs: metrics.reduce((s, m) => s + m.durationMs, 0) / n,
    totalTokenIn,
    totalTokenOut,
    completenessPassRate: metrics.filter((m) => m.completenessPassed).length / n,
    avgIrrelevantEvidenceRatio: metrics.reduce((s, m) => s + m.irrelevantEvidenceRatio, 0) / n,
  };
}

// ============================================================================
// 报告生成
// ============================================================================

function generateComparisonReport(result: AblationResult): string {
  const lines: string[] = [];
  lines.push("# 不确定性驱动检索决策 A/B 对照实验报告");
  lines.push("");
  lines.push(`**Run ID**：${result.runId}`);
  lines.push(`**时间**：${result.timestamp}`);
  lines.push(`**Case 数**：${result.cases.length}`);
  lines.push("");

  // 聚合指标对比表
  lines.push("## 聚合指标对比");
  lines.push("");
  lines.push("| 指标 | A 组（强制检索） | B 组（不确定性驱动） | 差异 |");
  lines.push("|------|-------------------|----------------------|------|");
  const a = result.aggregate.armA;
  const b = result.aggregate.armB;
  lines.push(
    `| 成功率 | ${a.successCount}/${result.cases.length} | ${b.successCount}/${result.cases.length} | ${b.successCount - a.successCount >= 0 ? "+" : ""}${b.successCount - a.successCount} |`,
  );
  lines.push(
    `| 平均工具调用次数 | ${a.avgToolCalls.toFixed(2)} | ${b.avgToolCalls.toFixed(2)} | ${b.avgToolCalls - a.avgToolCalls >= 0 ? "+" : ""}${(b.avgToolCalls - a.avgToolCalls).toFixed(2)} |`,
  );
  lines.push(
    `| 平均 sourceRefs 数 | ${a.avgSourceRefs.toFixed(2)} | ${b.avgSourceRefs.toFixed(2)} | ${b.avgSourceRefs - a.avgSourceRefs >= 0 ? "+" : ""}${(b.avgSourceRefs - a.avgSourceRefs).toFixed(2)} |`,
  );
  lines.push(
    `| 平均 FactGuard 硬错误 | ${a.avgFactGuardErrors.toFixed(2)} | ${b.avgFactGuardErrors.toFixed(2)} | ${b.avgFactGuardErrors - a.avgFactGuardErrors >= 0 ? "+" : ""}${(b.avgFactGuardErrors - a.avgFactGuardErrors).toFixed(2)} |`,
  );
  lines.push(
    `| 平均生成延迟 (ms) | ${a.avgDurationMs.toFixed(0)} | ${b.avgDurationMs.toFixed(0)} | ${b.avgDurationMs - a.avgDurationMs >= 0 ? "+" : ""}${(b.avgDurationMs - a.avgDurationMs).toFixed(0)} |`,
  );
  lines.push(
    `| 完整性通过率 | ${(a.completenessPassRate * 100).toFixed(1)}% | ${(b.completenessPassRate * 100).toFixed(1)}% | |`,
  );
  lines.push(
    `| 无关证据比例（近似） | ${(a.avgIrrelevantEvidenceRatio * 100).toFixed(1)}% | ${(b.avgIrrelevantEvidenceRatio * 100).toFixed(1)}% | ${b.avgIrrelevantEvidenceRatio - a.avgIrrelevantEvidenceRatio >= 0 ? "+" : ""}${((b.avgIrrelevantEvidenceRatio - a.avgIrrelevantEvidenceRatio) * 100).toFixed(1)}% |`,
  );
  lines.push(
    `| token 输入总量 | ${a.totalTokenIn} | ${b.totalTokenIn} | ${a.totalTokenIn === "unknown" || b.totalTokenIn === "unknown" ? "(部分 unknown)" : ""} |`,
  );
  lines.push(
    `| token 输出总量 | ${a.totalTokenOut} | ${b.totalTokenOut} | ${a.totalTokenOut === "unknown" || b.totalTokenOut === "unknown" ? "(部分 unknown)" : ""} |`,
  );
  lines.push("");

  // 每 case 明细
  lines.push("## 每 Case 明细");
  lines.push("");
  for (const c of result.cases) {
    lines.push(`### ${c.caseId}`);
    lines.push("");
    lines.push("| 指标 | A 组 | B 组 |");
    lines.push("|------|------|------|");
    lines.push(`| success | ${c.armA.metrics.success} | ${c.armB.metrics.success} |`);
    lines.push(`| textLength | ${c.armA.metrics.textLength} | ${c.armB.metrics.textLength} |`);
    lines.push(`| toolCalls | ${c.armA.metrics.toolCalls} | ${c.armB.metrics.toolCalls} |`);
    lines.push(`| sourceRefsCount | ${c.armA.metrics.sourceRefsCount} | ${c.armB.metrics.sourceRefsCount} |`);
    lines.push(`| mustVerifyCount | ${c.armA.metrics.mustVerifyCount} | ${c.armB.metrics.mustVerifyCount} |`);
    lines.push(`| factGuardErrors | ${c.armA.metrics.factGuardErrors} | ${c.armB.metrics.factGuardErrors} |`);
    lines.push(`| completenessPassed | ${c.armA.metrics.completenessPassed} | ${c.armB.metrics.completenessPassed} |`);
    lines.push(`| irrelevantEvidenceRatio | ${c.armA.metrics.irrelevantEvidenceRatio.toFixed(3)} | ${c.armB.metrics.irrelevantEvidenceRatio.toFixed(3)} |`);
    lines.push(`| durationMs | ${c.armA.metrics.durationMs} | ${c.armB.metrics.durationMs} |`);
    lines.push(`| tokenIn | ${c.armA.metrics.tokenIn} | ${c.armB.metrics.tokenIn} |`);
    lines.push(`| tokenOut | ${c.armA.metrics.tokenOut} | ${c.armB.metrics.tokenOut} |`);
    lines.push(`| selectedSource | ${c.armA.metrics.selectedSource} | ${c.armB.metrics.selectedSource} |`);
    if (c.armA.metrics.failureReason || c.armB.metrics.failureReason) {
      lines.push(`| failureReason | ${c.armA.metrics.failureReason ?? ""} | ${c.armB.metrics.failureReason ?? ""} |`);
    }
    lines.push("");
  }

  // 最低通过条件判定
  lines.push("## 最低通过条件判定");
  lines.push("");
  lines.push(`- B 组事实硬伤 ≤ A 组：${result.passCriteria.factGuardNotWorse ? "✓ PASS" : "✗ FAIL"}`);
  lines.push(`- B 组工具调用次数 < A 组：${result.passCriteria.toolCallsReduced ? "✓ PASS" : "✗ FAIL"}`);
  // Step 1：recallNotWorse 三态显示
  const recallDisplay = result.passCriteria.recallNotWorse === "pass"
    ? "✓ PASS"
    : result.passCriteria.recallNotWorse === "unmeasured"
      ? "? UNMEASURED（召回率未测量，需 Step 2 修复 fixture 后重跑）"
      : "✗ FAIL";
  lines.push(`- B 组必需事实召回率 ≥ A 组：${recallDisplay}`);
  if (result.passCriteria.recallUnmeasuredReason) {
    lines.push(`  - 原因：${result.passCriteria.recallUnmeasuredReason}`);
  }
  lines.push("");
  lines.push(`**总体判定**：${result.passCriteria.overallPassed ? "✓ PASS（可考虑更大规模 replay）" : "✗ FAIL（需调整后再实验）"}`);
  lines.push("");
  lines.push("> 注意：人工盲测的自然度和叙事完成度由用户通过 blind-pack.json 盲测后裁决。");
  lines.push("> token 成本指标存在 unknown gap（部分路径 tokenUsage 仍为 \"unknown\"），需后续修复透传。");

  return lines.join("\n");
}

// ============================================================================
// 盲测包生成
// ============================================================================

export interface BlindPackEntry {
  /** 匿名 ID（A/B 随机映射，不暴露 arm 身份） */
  anonymousId: string;
  caseId: string;
  text: string;
}

export interface BlindPack {
  runId: string;
  timestamp: string;
  /** 匿名映射（仅记录映射关系，盲测时不应查看） */
  mapping: Record<string, { caseId: string; arm: "A" | "B" }>;
  entries: BlindPackEntry[];
  instructions: string;
}

export function generateBlindPack(result: AblationResult): BlindPack {
  const entries: BlindPackEntry[] = [];
  const mapping: Record<string, { caseId: string; arm: "A" | "B" }> = {};

  for (const c of result.cases) {
    // 随机映射 A/B → X/Y（每 case 独立随机）
    const aIsX = Math.random() < 0.5;
    const xId = `X-${c.caseId}`;
    const yId = `Y-${c.caseId}`;

    if (aIsX) {
      mapping[xId] = { caseId: c.caseId, arm: "A" };
      mapping[yId] = { caseId: c.caseId, arm: "B" };
    } else {
      mapping[xId] = { caseId: c.caseId, arm: "B" };
      mapping[yId] = { caseId: c.caseId, arm: "A" };
    }

    entries.push({
      anonymousId: xId,
      caseId: c.caseId,
      text: aIsX ? c.armA.v2Output.text ?? "" : c.armB.v2Output.text ?? "",
    });
    entries.push({
      anonymousId: yId,
      caseId: c.caseId,
      text: aIsX ? c.armB.v2Output.text ?? "" : c.armA.v2Output.text ?? "",
    });
  }

  return {
    runId: result.runId,
    timestamp: result.timestamp,
    mapping,
    entries,
    instructions: [
      "盲测说明：",
      "1. 每个 case 有两个匿名文本（X 和 Y），分别来自 A 组（强制检索）和 B 组（不确定性驱动）。",
      "2. 请逐 case 阅读两个文本，从以下维度评分（1-5 分）：",
      "   - 自然度（中文表达是否自然、无 AI 腔）",
      "   - 叙事完成度（情节是否完整、是否有明显遗漏）",
      "   - 事实准确性（是否有事实硬伤、人物状态错误）",
      "3. 对每对 X/Y 选择「更优」或「平局」。",
      "4. 评分完成后，查看 mapping 确认 X/Y 对应的 A/B 身份。",
      "5. 最低通过条件：B 组文学质量不下降（B 组胜率 ≥ 40% 或平局为主）。",
    ].join("\n"),
  };
}
