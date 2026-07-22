/**
 * NovelOS Evidence Plan（OPT-9.1）
 *
 * EvidencePlan schema：Known / Unknown / MustVerify / AllowedTools / StopConditions。
 * agent loop 每轮前评估 MustVerify 项，选择对应工具收集证据。
 *
 * M1 策略：
 * - createEvidencePlan 从 chapterIntent + seedContext 提取关键实体/术语作为 MustVerify
 * - AllowedTools 默认全部 8 工具（可由调用方收窄）
 * - StopConditions 默认：连续 2 轮无进展即停
 * - 不做 LLM 意图分析（M1 用启发式提取，Phase 后续增强）
 */

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
  /** 未知但可能需要的事实（模型可能需要检索） */
  unknown: string[];
  /** 必须验证的关键点（优先检索目标） */
  mustVerify: string[];
  /** 本轮允许使用的工具名（限定工具集防无界遍历） */
  allowedTools: string[];
  /** 停止条件 */
  stopConditions: StopConditions;
}

// ============================================================================
// EvidencePlan 工厂
// ============================================================================

export interface CreateEvidencePlanInput {
  /** 本章意图摘要 */
  chapterIntent: string;
  /** 种子上下文（CompiledContext 摘要或 ChapterSeed 文本） */
  seedContext: string;
  /** 允许使用的工具名（默认全部 8 工具） */
  allowedTools?: string[];
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

/**
 * 创建 EvidencePlan。
 */
export function createEvidencePlan(input: CreateEvidencePlanInput): EvidencePlan {
  const mustVerify = extractMustVerifyItems(input.chapterIntent, input.seedContext);
  const allowedTools = input.allowedTools ?? [...ALL_NARRATIVE_TOOLS];
  const stopConditions = { ...DEFAULT_STOP_CONDITIONS, ...input.stopConditions };

  return {
    known: [], // M1: seed context 已在 prompt 中，不单独标记 known
    unknown: [], // M1: 不预判未知，由 mustVerify 驱动检索
    mustVerify,
    allowedTools,
    stopConditions,
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
