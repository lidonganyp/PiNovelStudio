/**
 * PromiseContextCompiler — 本章相关承诺状态编译（QUALITY-4，计划 §4.2 PromiseLedger）
 *
 * 目标：在 raw 生成前，从 ChapterIntent.selectedPromisesToAdvance + longTermState.promise
 * 编译出只含"本章相关承诺"的 compact block，让 raw prompt 能看到与本章真正相关的
 * PromiseLedger 条目，并在 stageResults 中证明它被选择、被消费、未污染长期状态。
 *
 * 核心不变量（QUALITY-4 任务书）：
 * - 只包含本章相关 Promise，不得把全量 PromiseLedger 灌进 raw prompt。
 * - selectedPromisesToAdvance 命中的 promise 优先；其他 state promise 默认不进入。
 * - 已 fulfilled / broken 的 promise 不得进入 advance/fulfill，只能 inspect 历史背景，
 *   且必须标明原因。
 * - expectedAction 仅允许 advance / fulfill / defer / inspect；不得凭空生成"承诺推进动作"。
 * - 没有证据时用 inspect 或 defer，不伪造。
 * - 本模块只做"生成前相关状态编译"，不提交长期状态，不更新 PromiseLedger。
 * - 不修改 finalText，不生成 candidate，不触发 StyleShaper/language patch，
 *   不是 hard gate，不阻断正文生成。
 *
 * 确定性本地编译：零 LLM 调用，纯结构化字段映射。
 */

import type { ChapterIntent } from "./chapter-intent-builder.js";
import type { LongTermStateSnapshot } from "./types.js";

// ============================================================================
// 数据契约
// ============================================================================

/**
 * expectedAction 仅允许这 4 个值。
 * - advance：本章推进该承诺（状态为 open/advancing/seed_only 时）
 * - fulfill：本章兑现该承诺（本最小闭环不自动判定 fulfill，保留枚举供后续增强）
 * - defer：本章暂不推进，仅记录存在（无明确证据时）
 * - inspect：仅作历史背景检视（已 fulfilled/broken，不得再 advance/fulfill）
 */
export type PromiseExpectedAction = "advance" | "fulfill" | "defer" | "inspect";

/**
 * 单条本章相关承诺的 compact 条目。
 * 每条至少包含 7 个必填字段（QUALITY-4 任务书要求）。
 */
export interface PromiseContextEntry {
  /** 承诺 id，对应 PromiseLedger 的 promiseId */
  promiseId: string;
  /** 承诺描述（来自 selectedPromisesToAdvance 或 state） */
  description: string;
  /**
   * 承诺状态：
   * - 来自 longTermState.promise 的原始 status（open/advancing/fulfilled/broken）
   * - "seed_only"：仅在 ChapterSeed/selectedPromisesToAdvance 中，尚未进入长期状态
   */
  status: string;
  /** 本章相关的原因（必须可解释，记录为何该承诺进入本章 context） */
  relevanceReason: string;
  /** 本章对该承诺的方向（仅 advance/fulfill/defer/inspect，不是具体改写指令） */
  expectedAction: PromiseExpectedAction;
  /** 来源引用，如 "chapter-intent:selectedPromisesToAdvance" 或叠加 "+ longTermState:promise" */
  sourceRef: string;
  /** 置信度 [0,1]：state 确认 0.7，seed_only 0.5 */
  confidence: number;
}

/**
 * 本章相关承诺状态编译结果。
 * 写入 stageResults.promiseContext 供 trace 审计。
 */
export interface PromiseContext {
  /** 本章相关承诺条目（只含 selectedPromisesToAdvance 命中项，非全量） */
  entries: PromiseContextEntry[];
  /** 来源汇总（去重），用于 fieldSourceRefs 风格追溯 */
  sourceRefs: string[];
  /** raw prompt 是否实际消费了该 compact block（空时 false） */
  consumedByRawPrompt: boolean;
  /** entries 为空时的原因（不得静默，必须写明） */
  emptyReason?: string;
}

/**
 * 编译输入：从 orchestrator 传入的 intent + longTermState 快照。
 */
export interface PromiseContextCompileInput {
  intent: ChapterIntent;
  /** CompiledContext.longTermState，无状态文件时为 null */
  longTermState?: LongTermStateSnapshot | null;
}

/**
 * 编译输出：PromiseContext + 格式化后的 prompt block（空时 null）。
 */
export interface PromiseContextCompileResult {
  promiseContext: PromiseContext;
  /** 格式化后的"本章相关承诺状态"prompt 区块；entries 为空时返回 null（不加入 prompt） */
  promptBlock: string | null;
}

// ============================================================================
// 常量
// ============================================================================

/** state 中表示承诺仍在推进的状态（可被 advance） */
const ADVANCABLE_STATUSES = new Set(["open", "advancing"]);
/** state 中表示承诺已终结的状态（不得 advance/fulfill，只能 inspect） */
const TERMINAL_STATUSES = new Set(["fulfilled", "broken"]);

/** state 确认承诺时的置信度 */
const CONFIDENCE_STATE_CONFIRMED = 0.7;
/** 仅 seed/intent 选中、state 未确认时的置信度 */
const CONFIDENCE_SEED_ONLY = 0.5;

// ============================================================================
// 核心编译逻辑
// ============================================================================

/**
 * 编译本章相关承诺状态。
 *
 * 相关性规则（保守）：
 * 1. selectedPromisesToAdvance 命中的 promise 优先，且是唯一进入 entries 的来源。
 *    （INTENT-1 已用 stateFulfilledPromiseIds 排除 fallback 重选 fulfilled；
 *     本编译器再防御性检查：若 selectedPromisesToAdvance 中混入 state 已 fulfilled
 *     的 promiseId，降级为 inspect，不 advance。）
 * 2. 不把 longTermState.promise 中未命中的 promise 灌入 entries（禁止全量灌入）。
 * 3. status 为 fulfilled/broken → expectedAction=inspect，relevanceReason 标明历史背景。
 * 4. status 为 open/advancing/seed_only → expectedAction=advance。
 * 5. selectedPromisesToAdvance 为空 → entries 为空 + emptyReason，不伪造。
 *
 * 不调用 LLM，不修改 finalText，不提交状态，不是 gate。
 */
export function compilePromiseContext(
  input: PromiseContextCompileInput
): PromiseContextCompileResult {
  const { intent, longTermState } = input;
  const selected = intent.selectedPromisesToAdvance ?? [];

  // 构建 state promise 索引：promiseId → state entry
  const statePromiseMap = new Map<string, LongTermStateSnapshot["promise"][number]>();
  if (longTermState?.promise) {
    for (const p of longTermState.promise) {
      if (p.promiseId) {
        statePromiseMap.set(p.promiseId, p);
      }
    }
  }

  const entries: PromiseContextEntry[] = [];
  const sourceRefSet = new Set<string>();

  for (const sel of selected) {
    const stateEntry = statePromiseMap.get(sel.promiseId);
    const entry = buildEntry(sel.promiseId, sel.description, stateEntry);
    entries.push(entry);
    // 拆分 sourceRef 多个来源分别加入 sourceRefSet
    for (const ref of entry.sourceRef.split(" + ")) {
      sourceRefSet.add(ref);
    }
  }

  // 空状态处理：不得静默
  if (entries.length === 0) {
    const emptyReason = deriveEmptyReason(selected.length, longTermState);
    const promiseContext: PromiseContext = {
      entries: [],
      sourceRefs: [],
      consumedByRawPrompt: false,
      emptyReason,
    };
    return { promiseContext, promptBlock: null };
  }

  const promiseContext: PromiseContext = {
    entries,
    sourceRefs: Array.from(sourceRefSet),
    consumedByRawPrompt: true, // 将在 buildRawPrompt 中实际消费
  };

  const promptBlock = formatPromiseContextPromptBlock(promiseContext);
  return { promiseContext, promptBlock };
}

/**
 * 构建单条 PromiseContextEntry。
 * 防御性检查：即使 selectedPromisesToAdvance 混入 fulfilled（INTENT-1 已排除，
 * 但本编译器独立防御），也降级为 inspect。
 */
function buildEntry(
  promiseId: string,
  description: string,
  stateEntry: LongTermStateSnapshot["promise"][number] | undefined
): PromiseContextEntry {
  if (stateEntry) {
    const status = stateEntry.status;
    if (TERMINAL_STATUSES.has(status)) {
      // fulfilled/broken → 仅作历史背景，inspect
      return {
        promiseId,
        description: description || stateEntry.description,
        status,
        relevanceReason: `本章 selectedPromisesToAdvance 命中，但长期状态标记为 ${status}，仅作历史背景检视，不再 advance/fulfill`,
        expectedAction: "inspect",
        sourceRef: "chapter-intent:selectedPromisesToAdvance + longTermState:promise",
        confidence: CONFIDENCE_STATE_CONFIRMED,
      };
    }
    if (ADVANCABLE_STATUSES.has(status)) {
      // open/advancing → 本章推进
      return {
        promiseId,
        description: description || stateEntry.description,
        status,
        relevanceReason: "本章 selectedPromisesToAdvance 命中，长期状态确认仍在推进中",
        expectedAction: "advance",
        sourceRef: "chapter-intent:selectedPromisesToAdvance + longTermState:promise",
        confidence: CONFIDENCE_STATE_CONFIRMED,
      };
    }
    // 未知 status（非标准枚举）→ 保守 inspect，不 advance
    return {
      promiseId,
      description: description || stateEntry.description,
      status,
      relevanceReason: `本章 selectedPromisesToAdvance 命中，长期状态 status=${status} 非标准枚举，保守 inspect`,
      expectedAction: "inspect",
      sourceRef: "chapter-intent:selectedPromisesToAdvance + longTermState:promise",
      confidence: CONFIDENCE_STATE_CONFIRMED,
    };
  }

  // state 中未找到 → seed_only（仅在 seed/intent 中，尚未进入长期状态）
  return {
    promiseId,
    description,
    status: "seed_only",
    relevanceReason: "本章 selectedPromisesToAdvance 命中，长期状态中暂无记录（seed 意图，待正文落地后由 FinalStateCommit 确认）",
    expectedAction: "advance",
    sourceRef: "chapter-intent:selectedPromisesToAdvance",
    confidence: CONFIDENCE_SEED_ONLY,
  };
}

/**
 * 推导空状态原因（不得静默）。
 */
function deriveEmptyReason(
  selectedCount: number,
  longTermState: LongTermStateSnapshot | null | undefined
): string {
  if (selectedCount === 0) {
    if (!longTermState || !longTermState.promise || longTermState.promise.length === 0) {
      return "无 selectedPromisesToAdvance 且无 longTermState.promise，本章无可用承诺状态";
    }
    return "selectedPromisesToAdvance 为空：本章未选中任何承诺，不灌入全量 PromiseLedger（保守相关性规则）";
  }
  // 理论上不会到达（selected 非空时 entries 非空），防御性兜底
  return "selectedPromisesToAdvance 非空但编译后 entries 为空（异常状态，请检查 status 枚举）";
}

// ============================================================================
// Prompt block 格式化
// ============================================================================

/**
 * 把 PromiseContext 格式化为 raw prompt 的"本章相关承诺状态"区块。
 *
 * 格式（确定性，无 LLM）：
 * ```
 * 本章相关承诺状态（只含本章选中承诺，非全量 PromiseLedger）：
 * - p1——暗流的秘密【状态：advancing｜本章方向：advance】本章 selectedPromisesToAdvance 命中，长期状态确认仍在推进中
 * - p2——老周的真实身份【状态：open｜本章方向：advance】...
 * ```
 *
 * entries 为空时返回 null（不加入 prompt，空原因只写 stageResults）。
 * 不含 aggregateQualityScore / totalScore / 对白比例 / 段落长度 / 固定冲突数等机械指标。
 */
export function formatPromiseContextPromptBlock(context: PromiseContext): string | null {
  if (context.entries.length === 0) {
    return null;
  }
  const lines = context.entries.map((e) => {
    return `- ${e.promiseId}——${e.description}【状态：${e.status}｜本章方向：${e.expectedAction}】${e.relevanceReason}`;
  });
  return `本章相关承诺状态（只含本章选中承诺，非全量 PromiseLedger）：\n${lines.join("\n")}`;
}

// ============================================================================
// Skipped 构造（用于 hardBlock / 异常路径，保证 stageResults 不静默）
// ============================================================================

/**
 * 构造 skipped PromiseContext（用于 hardBlock / raw 生成失败路径）。
 * 与 QUALITY-3 skippedChapterQualityEvidence 同模式：失败路径写 reason，不静默。
 */
export function skippedPromiseContext(reason: string): PromiseContext {
  return {
    entries: [],
    sourceRefs: [],
    consumedByRawPrompt: false,
    emptyReason: `skipped: ${reason}`,
  };
}
