/**
 * NovelOS Evidence Plan（AGENTIC-EVIDENCE-MERGE-1）
 *
 * EvidencePlan 是系统安全计划，不是模型决策输出。
 * 系统建立安全边界（known / mustVerify / allowedTools / stopConditions / retrievalCallLimit），
 * Agentic 在 ReAct 循环内自主决定是否检索、检索什么、何时停止。
 *
 * 设计原则：
 * - createEvidencePlan 从 chapterIntent + seedContext 提取关键实体/术语作为 MustVerify
 * - AllowedTools 由系统从 intent 推断（不再由模型选择）
 * - retrievalCallLimit 是系统上限，不是模型必须消耗的配额
 * - 不做 LLM 意图分析（纯启发式提取）
 * - mustVerify、工具推断与 context 摘要逻辑由系统确定性生成
 *
 * 历史：Phase 2D 曾引入独立 EvidenceDecision 模型回合（novelos_evidence_decision），
 * 该回合已在 AGENTIC-EVIDENCE-MERGE-1 中物理删除。unknown / queries / needRetrieval /
 * retrievalDepth 等模型决策字段已移除，由系统风险预算 retrievalCallLimit 替代。
 */

import type { ChapterIntent } from "../../v2/core/chapter-intent-builder.js";
import type { CompiledContext } from "../../v2/core/types.js";
import { QUERY_NARRATIVE_PRODUCTION_NAME } from "../tools/narrative-tools.js";

// ============================================================================
// NarrativeToolMode（Phase 5 受控接入）
// ============================================================================

/**
 * Phase 5 受控接入：叙事工具暴露模式。
 *
 * - "standard"：默认生产。模型看到 9 个专用叙事工具（由 inferAllowedToolsFromIntent /
 *   allowedTools 收窄到子集）。
 * - "facade"：canary workspace 显式 opt-in。模型只看到 1 个统一入口
 *   query_narrative_production（按 intent 路由到 9 个底层专用工具）。
 *   这是 "guided facade vs 9 工具" 的受控对照，不推广为"任意单入口 facade 更优"。
 *
 * 仅当 workspace canary 授权解析为 facade 时启用；默认 standard 行为不变（非全量切换）。
 */
export type NarrativeToolMode = "standard" | "facade";

// ============================================================================
// StopConditions
// ============================================================================

export interface StopConditions {
  /** 连续多少轮无新增证据/diff/verifier 变化即停（默认 2） */
  maxStagnantRounds: number;
  /** verifier 硬错误清零且无高价值未验证项即停 */
  verifierHardErrorsCleared: boolean;
  /** 模型声明证据充分（stopReason="stop" 且无新 toolCall）即停 */
  modelDeclaresSufficient: boolean;
}

export const DEFAULT_STOP_CONDITIONS: StopConditions = {
  maxStagnantRounds: 2,
  verifierHardErrorsCleared: true,
  modelDeclaresSufficient: true,
};

// ============================================================================
// EvidencePlan
// ============================================================================

export interface EvidencePlan {
  /** 已知事实（从 seed context 派生，无需验证） */
  known: string[];
  /** 必须验证的关键点（优先检索目标） */
  mustVerify: string[];
  /** 系统授权的工具集（限定工具防无界遍历，不是模型选择结果） */
  allowedTools: string[];
  /** 停止条件 */
  stopConditions: StopConditions;
  /**
   * 系统检索调用上限（AGENTIC-EVIDENCE-MERGE-1）。
   *
   * 由确定性策略生成，不被不可验证的结构化模型输出降低（两档）：
   * - 无 mustVerify（上下文充分）-> 2
   * - 存在 mustVerify -> 4
   *
   * 这是系统上限，不是模型必须消耗的配额。Agentic 可以使用 0 到该上限之间的任意调用数。
   * runtime 的 beforeToolCall 在达到此上限后阻断后续检索工具调用。
   */
  retrievalCallLimit: number;
}

// ============================================================================
// EvidencePlan 工厂
// ============================================================================

export interface CreateEvidencePlanInput {
  /** 本章意图摘要 */
  chapterIntent: string;
  /** 种子上下文（CompiledContext 摘要或 ChapterSeed 文本） */
  seedContext: string;
  /**
   * Phase 2D：结构化 ChapterIntent。
   *
   * 若提供，优先从 intent 提取 mustVerify + 推断 allowedTools + 提取 known 摘要，
   * 不再使用字符串启发式。若不提供，回退到 M1 启发式（向后兼容）。
   */
  intent?: ChapterIntent;
  /**
   * Phase 2D：编译后的上下文。
   *
   * 与 intent 配合使用，从中提取已知摘要（known）。
   * 只注入摘要行（≤80字/条，≤12条），不注入全文，避免 prompt 过载。
   */
  compiledContext?: CompiledContext;
  /**
   * Phase 2D：前章悬置状态是否可用。
   *
   * 用于推断是否需要 search_chapter_span（章节原文片段检索）。
   * 来自 context.bridgeContext?.available。
   */
  bridgeContextAvailable?: boolean;
  /** 允许使用的工具名（默认全部 9 工具） */
  allowedTools?: string[];
  /**
   * Phase 5 受控接入：叙事工具暴露模式。
   *
   * - "facade"：allowedTools 默认收窄为 [query_narrative_production]（统一入口按 intent
   *   路由到 9 个底层专用工具）。仅 canary workspace 显式 opt-in 时设置。
   * - "standard" / 缺省：默认行为（intent 推断 or 全量 9 工具）。
   *
   * 注意：显式传入 allowedTools 时优先于 toolMode（调用方可精确控制）。
   */
  toolMode?: NarrativeToolMode;
  /** 停止条件覆盖 */
  stopConditions?: Partial<StopConditions>;
}

/** 默认允许的全部 9 工具（P0-1 新增 search_narrative_evidence） */
export const ALL_NARRATIVE_TOOLS = [
  "search_narrative_evidence",
  "search_chapter_span",
  "query_canon",
  "query_character_state",
  "query_timeline",
  "query_character_knowledge_boundary",
  "query_promise_ledger",
  "query_pattern_memory",
  "query_voice_evidence",
] as const;

/**
 * 从 chapterIntent + seedContext 提取关键实体/术语作为 MustVerify。
 *
 * M1 启发式：
 * - 提取 intent 中的引号内容、"关于"/"涉及"后的名词短语
 * - 提取 seed 中提到的人名/地名/能力名（简单中文分词）
 * - 去重，最多 8 项（防无界遍历）
 */
function extractMustVerifyItems(chapterIntent: string, seedContext: string): string[] {
  const items = new Set<string>();
  const explicitMustInclude = chapterIntent.match(/^作者章纲必须包含：(.+)$/mu)?.[1] ?? "";
  for (const item of explicitMustInclude.split(/[；;]/u)) {
    const normalized = item.trim();
    if (normalized) items.add(normalized);
  }
  if (items.size > 0) return [...items].slice(0, 8);

  // 从 intent 提取引号内容
  const quoteMatches = chapterIntent.matchAll(/[「」""''《》](.+?)[「」""''《》]/g);
  for (const m of quoteMatches) {
    const text = m[1].trim();
    if (text.length >= 2 && text.length <= 20) {
      items.add(text);
    }
  }

  // 从 intent/seed 提取"关于X"/"涉及X"后的短语
  const aboutMatches = (chapterIntent + " " + seedContext).matchAll(/(?:关于|涉及|查证|确认)([^\s，。、；：]{2,10})/g);
  for (const m of aboutMatches) {
    items.add(m[1].trim());
  }

  // 从 seed 提取中文人名/地名（简单启发式：2-4 字中文连续字符，前后有上下文标记）
  const nameMatches = seedContext.matchAll(/(?:角色|人物|地点|能力|设定)[：:]\s*([^\s，。、；：]{2,8})/g);
  for (const m of nameMatches) {
    items.add(m[1].trim());
  }

  // 去重 + 最多 8 项
  return [...items].slice(0, 8);
}

// ============================================================================
// Phase 2D：结构化 intent 驱动的提取函数
// ============================================================================

/**
 * Phase 2D：从结构化 ChapterIntent 提取 mustVerify 项。
 *
 * 替代 M1 的字符串启发式 extractMustVerifyItems。
 * 语义修正（2026-08-25，coverage gate 死锁修复）：
 * mustVerify 的语义是"写前必须已有 confirmed 证据的既有事实"，不是"本章要写的内容"。
 * P0/P1 mustVerify 项在 coverage gate（snapshotBound 生产模式）中要求 confirmedCoverage
 * 或检索轨迹证据；而本章待写内容在前文中不存在 confirmed 证据，system prompt 又允许
 * 模型在上下文足够时不调用任何工具，导致这类项永远无法确认，必然 hard block。
 * （例：章纲锚点"赵明远状态反常"含 P1 标记词"状态"，toolCalls=0 时 unverified 而阻断。）
 *
 * 只提取真正的前文约束事实：
 * 1. inviolableFacts（不可破坏的事实）- P0；createConstraintManifest 会将同字符串映射为
 *    IMMUTABLE_FACTS 槽 hard_constraint 条目（kind=hard_fact），可被 confirmedCoverage 覆盖
 * 2. factAndCharacterKnowledgeForbiddenZones（角色知识禁区）- P0；同理（kind=knowledge_boundary）
 *
 * 不再提取（属于本章正文产出义务，由 FactGuard / StoryPreservation / Completeness 校验）：
 * - authorMustInclude（作者章纲锚点，待写内容）
 * - selectedPromisesToAdvance（本章要推进的伏笔，待写内容）
 * - expectedIrreversibleChange（本章预期不可逆变化，待写内容）
 *
 * 去重，最多 8 项（与 extractMustVerifyItems 上限一致）。
 */
export function extractMustVerifyFromIntent(intent: ChapterIntent): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  const push = (s: string): void => {
    const trimmed = s.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      items.push(trimmed);
    }
  };

  for (const item of intent.inviolableFacts ?? []) push(item);
  for (const item of intent.factAndCharacterKnowledgeForbiddenZones ?? []) push(item);

  return items.slice(0, 8);
}

/**
 * Phase 2D：从 ChapterIntent 推断本章需要的工具集（无模型调用，纯启发式）。
 *
 * 推断规则（保守：宁可多包含，不可漏）：
 * - search_narrative_evidence + query_pattern_memory：始终包含（通用跨源检索 + 防重复模式）
 * - query_canon + query_character_knowledge_boundary：inviolableFacts 或 factAndCharacterKnowledgeForbiddenZones 非空
 * - query_character_state：focusCharacterGoals / resistance / choicesAndCosts 非空
 * - query_timeline：causalEndPressure 或 authorEventSummaries 非空
 * - query_promise_ledger + search_chapter_span：selectedPromisesToAdvance 非空
 * - search_chapter_span：bridgeContextAvailable=true
 * - query_voice_evidence：characterMotivations 非空
 */
export function inferAllowedToolsFromIntent(
  intent: ChapterIntent,
  bridgeContextAvailable?: boolean,
): string[] {
  const tools = new Set<string>(["search_narrative_evidence", "query_pattern_memory"]);

  if ((intent.inviolableFacts ?? []).length > 0 ||
      (intent.factAndCharacterKnowledgeForbiddenZones ?? []).length > 0) {
    tools.add("query_canon");
    tools.add("query_character_knowledge_boundary");
  }
  if ((intent.focusCharacterGoals ?? []).length > 0 ||
      (intent.resistance ?? []).length > 0 ||
      (intent.choicesAndCosts ?? []).length > 0) {
    tools.add("query_character_state");
  }
  if ((intent.causalEndPressure ?? []).length > 0 ||
      (intent.authorEventSummaries ?? []).length > 0) {
    tools.add("query_timeline");
  }
  if ((intent.selectedPromisesToAdvance ?? []).length > 0) {
    tools.add("query_promise_ledger");
    tools.add("search_chapter_span");
  }
  if (bridgeContextAvailable === true) {
    tools.add("search_chapter_span");
  }
  if ((intent.characterMotivations ?? []).length > 0) {
    tools.add("query_voice_evidence");
  }

  return [...tools];
}

/**
 * Phase 2D：从 CompiledContext 提取已知摘要（只注入摘要行，不注入全文）。
 *
 * 设计原则（对齐用户边界"只注入摘要"）：
 * - 只提取本章 intent 中相关实体的事实（不全量灌入所有 canon）
 * - 每条 known 摘要 ≤ 80 字（防 prompt 过载）
 * - 总数 ≤ 12 条（防无界遍历）
 * - 相关性判断基于 intent.relevantCharacters + inviolableFacts + selectedPromisesToAdvance
 */
export function extractKnownFromContext(
  intent: ChapterIntent,
  context: CompiledContext,
): string[] {
  const known: string[] = [];
  const relevantNames = new Set<string>(intent.relevantCharacters ?? []);
  const slice80 = (s: string): string => (s.length > 80 ? s.slice(0, 80) : s);

  // 1. 角色 state 摘要（只取本章相关角色）
  for (const state of context.characterStates) {
    if (relevantNames.has(state.name)) {
      const valueStr = typeof state.state === "string"
        ? state.state
        : JSON.stringify(state.state);
      known.push(slice80(`${state.name}：${valueStr}`));
    }
    if (known.length >= 12) break;
  }

  // 2. worldRules 摘要（只取与 inviolableFacts 有重叠的）
  if (known.length < 12) {
    const inviolable = intent.inviolableFacts ?? [];
    for (const rule of context.worldRules) {
      const overlap = inviolable.some(
        (fact) => fact.includes(rule.description) || rule.description.includes(fact),
      );
      if (overlap) known.push(slice80(`[规则]${rule.description}`));
      if (known.length >= 12) break;
    }
  }

  // 3. openLoops 摘要（只取 selectedPromisesToAdvance 中的）
  if (known.length < 12) {
    const selectedIds = new Set(
      (intent.selectedPromisesToAdvance ?? []).map((p) => p.promiseId),
    );
    for (const loop of context.openLoops) {
      if (selectedIds.has(loop.id)) {
        known.push(slice80(`[伏笔]${loop.description}`));
      }
      if (known.length >= 12) break;
    }
  }

  return known;
}

// ============================================================================
// EvidencePlan 工厂
// ============================================================================

/**
 * 创建 EvidencePlan。
 *
 * Phase 2D（2026-08-06）三缺口修复：
 * - 优先使用结构化 ChapterIntent 提取 mustVerify / allowedTools / known
 * - 不传 intent 时回退到 M1 启发式（向后兼容旧调用方）
 * - known 只在 intent + compiledContext 同时提供时提取摘要行
 *
 * 缺口三修复：让 EvidencePlan 真正反映 intent 的结构化字段，
 * 而不是字符串启发式 + 全量工具集。
 */
export function createEvidencePlan(input: CreateEvidencePlanInput): EvidencePlan {
  // mustVerify：优先用结构化 intent 提取，回退到字符串启发式
  const mustVerify = input.intent
    ? extractMustVerifyFromIntent(input.intent)
    : extractMustVerifyItems(input.chapterIntent, input.seedContext);

  // allowedTools：Phase 5 facade 模式收窄为统一入口；否则优先用 intent 推断（缺口一：
  // 收窄工具集），回退到全量。
  // 显式传入 allowedTools 优先于 toolMode（调用方可精确控制）。
  const allowedTools = input.allowedTools
    ?? (input.toolMode === "facade"
      ? [QUERY_NARRATIVE_PRODUCTION_NAME]
      : (input.intent
        ? inferAllowedToolsFromIntent(input.intent, input.bridgeContextAvailable)
        : [...ALL_NARRATIVE_TOOLS]));

  // known：只在 intent + compiledContext 同时提供时提取摘要行（缺口三：注入已知摘要）
  // 不传时为空数组（M1 行为：seed context 已在 prompt 中，不单独标记 known）
  const known = input.intent && input.compiledContext
    ? extractKnownFromContext(input.intent, input.compiledContext)
    : [];

  const stopConditions = { ...DEFAULT_STOP_CONDITIONS, ...input.stopConditions };

  // AGENTIC-EVIDENCE-MERGE-1：系统风险预算（确定性，不依赖模型决策）。
  // 首版采用保守策略：mustVerify 非空 -> 4 次上限；为空 -> 2 次上限。
  // 后续可用真实 replay 数据调整三级风险分类。
  const retrievalCallLimit = mustVerify.length > 0 ? 4 : 2;

  return {
    known,
    mustVerify,
    allowedTools,
    stopConditions,
    retrievalCallLimit,
  };
}

// ============================================================================
// 进度追踪（用于停止条件 3：连续无进展）
// ============================================================================

export interface LoopProgress {
  /** 当前轮次 */
  round: number;
  /** 累计收集的 sourceRef 集合 */
  sourceRefs: Set<string>;
  /** 连续无新增证据的轮数 */
  stagnantRounds: number;
  /** 累计工具调用数 */
  toolCalls: number;
  /** 上一轮的 draft hash（检测 diff 变化） */
  lastDraftHash: string | null;
}

export function createLoopProgress(): LoopProgress {
  return {
    round: 0,
    sourceRefs: new Set(),
    stagnantRounds: 0,
    toolCalls: 0,
    lastDraftHash: null,
  };
}

/**
 * 评估一轮结束后的进度，更新 stagnantRounds。
 * 返回更新后的 progress（不可变副本，但 Set 共享引用）。
 */
export function updateProgress(
  progress: LoopProgress,
  newSourceRefs: string[],
  draftHash: string | null,
): LoopProgress {
  const beforeSize = progress.sourceRefs.size;
  for (const ref of newSourceRefs) {
    progress.sourceRefs.add(ref);
  }
  const hasNewEvidence = progress.sourceRefs.size > beforeSize;
  const hasDraftChange = draftHash !== null && draftHash !== progress.lastDraftHash;

  const stagnant = !hasNewEvidence && !hasDraftChange;
  return {
    round: progress.round + 1,
    sourceRefs: progress.sourceRefs,
    stagnantRounds: stagnant ? progress.stagnantRounds + 1 : 0,
    toolCalls: progress.toolCalls,
    lastDraftHash: draftHash ?? progress.lastDraftHash,
  };
}
