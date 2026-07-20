/**
 * ExpectationContextCompiler — 本章相关读者期待状态编译（EXPECTATION-LEDGER-1，计划 §6.3）
 *
 * 目标：在 raw 生成前，从 ChapterIntent.selectedExpectationsToAdvance + longTermState.expectation
 * 编译出只含"本章相关读者期待"的 compact block，让 raw prompt 能看到与本章真正相关的
 * ExpectationLedger 条目（带目标读者体验、当前状态与延期理由），并在 stageResults 中
 * 证明它被选择、被消费、未污染长期状态。
 *
 * 核心不变量（EXPECTATION-LEDGER-1 任务书）：
 * - 期待有 source chapter/span、目标读者体验、当前状态和延期理由。
 * - 未胜出候选不更新期待状态（final-only，由 FinalStateCommit 保证）。
 * - fulfilled 期待不重新选入 advance/fulfill，只能 inspect 历史背景。
 * - 无期待时不伪造，写 emptyReason 不静默。
 * - 不用固定"每N章兑现"硬门；不阻断正文生成。
 * - expectedAction 仅允许 advance / escalate / inspect / defer；不得凭空生成推进动作。
 * - 本模块只做"生成前相关状态编译"，不提交长期状态，不更新 ExpectationLedger。
 * - 不修改 finalText，不生成 candidate，不触发 StyleShaper/language patch，
 *   不是 hard gate，不阻断正文生成。
 *
 * 确定性本地编译：零 LLM 调用，纯结构化字段映射。
 *
 * 与 PromiseContextCompiler 的区别：
 * - 期待关注"读者体验目标"（targetReaderExperience），承诺关注"伏笔兑现"。
 * - 期待状态包含 escalated（升级施压）与 delayed（延期蓄势），承诺无这两种状态。
 * - expectedAction 新增 escalate：当 state 标记 escalated 时，本章应升级施压而非简单推进。
 */

import type { ChapterIntent } from "./chapter-intent-builder.js";
import type { LongTermStateSnapshot } from "./types.js";

// ============================================================================
// 数据契约
// ============================================================================

/**
 * expectedAction 仅允许这 4 个值。
 * - advance：本章推进该期待（状态为 open/advanced/delayed/seed_only 时）
 * - escalate：本章升级该期待的施压强度（状态为 escalated 时）
 * - defer：本章暂不推进，仅记录存在（无明确证据时）
 * - inspect：仅作历史背景检视（已 fulfilled，不得再 advance/escalate）
 */
export type ExpectationExpectedAction = "advance" | "escalate" | "defer" | "inspect";

/**
 * 单条本章相关读者期待的 compact 条目。
 */
export interface ExpectationContextEntry {
  /** 期待 id，对应 ExpectationLedger 的 expectationId */
  expectationId: string;
  /** 期待描述（来自 selectedExpectationsToAdvance 或 state） */
  description: string;
  /**
   * 期待状态：
   * - 来自 longTermState.expectation 的原始 status（open/advanced/fulfilled/delayed/escalated）
   * - "seed_only"：仅在 ChapterSeed/selectedExpectationsToAdvance 中，尚未进入长期状态
   */
  status: string;
  /** 目标读者体验（期待兑现时读者应获得的体验，来自 state 或 seed） */
  targetReaderExperience?: string;
  /** 延期理由（status=delayed 时来自 state；其他状态为 undefined） */
  delayReason?: string;
  /** 本章相关的原因（必须可解释，记录为何该期待进入本章 context） */
  relevanceReason: string;
  /** 本章对该期待的方向（仅 advance/escalate/defer/inspect，不是具体改写指令） */
  expectedAction: ExpectationExpectedAction;
  /** 来源引用，如 "chapter-intent:selectedExpectationsToAdvance" 或叠加 "+ longTermState:expectation" */
  sourceRef: string;
  /** 置信度 [0,1]：state 确认 0.7，seed_only 0.5 */
  confidence: number;
}

/**
 * 本章相关读者期待状态编译结果。
 * 写入 stageResults.expectationContext 供 trace 审计。
 */
export interface ExpectationContext {
  /** 本章相关期待条目（只含 selectedExpectationsToAdvance 命中项，非全量） */
  entries: ExpectationContextEntry[];
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
export interface ExpectationContextCompileInput {
  intent: ChapterIntent;
  /** CompiledContext.longTermState，无状态文件时为 null */
  longTermState?: LongTermStateSnapshot | null;
}

/**
 * 编译输出：ExpectationContext + 格式化后的 prompt block（空时 null）。
 */
export interface ExpectationContextCompileResult {
  expectationContext: ExpectationContext;
  /** 格式化后的"本章相关读者期待状态"prompt 区块；entries 为空时返回 null（不加入 prompt） */
  promptBlock: string | null;
}

// ============================================================================
// 常量
// ============================================================================

/** state 中表示期待仍在推进的状态（可被 advance） */
const ADVANCABLE_STATUSES = new Set(["open", "advanced", "delayed"]);
/** state 中表示期待已终结的状态（不得 advance/escalate，只能 inspect） */
const TERMINAL_STATUSES = new Set(["fulfilled"]);
/** state 中表示期待已升级施压的状态（本章应 escalate） */
const ESCALATED_STATUSES = new Set(["escalated"]);

/** state 确认期待时的置信度 */
const CONFIDENCE_STATE_CONFIRMED = 0.7;
/** 仅 seed/intent 选中、state 未确认时的置信度 */
const CONFIDENCE_SEED_ONLY = 0.5;
/** state 条目存在但缺少可追溯 evidence 时的保守置信度 */
const CONFIDENCE_STATE_UNVERIFIED = 0.35;

// ============================================================================
// 核心编译逻辑
// ============================================================================

/**
 * 编译本章相关读者期待状态。
 *
 * 相关性规则（保守）：
 * 1. selectedExpectationsToAdvance 命中的期待优先，且是唯一进入 entries 的来源。
 *    防御性检查：若 selectedExpectationsToAdvance 中混入 state 已 fulfilled 的期待，
 *    降级为 inspect，不 advance/escalate。
 * 2. 不把 longTermState.expectation 中未命中的期待灌入 entries（禁止全量灌入）。
 * 3. status 为 fulfilled → expectedAction=inspect，relevanceReason 标明历史背景。
 * 4. status 为 escalated → expectedAction=escalate，本章升级施压。
 * 5. status 为 delayed → expectedAction=advance（仍可推进），保留 delayReason。
 * 6. status 为 open/advanced/seed_only → expectedAction=advance。
 * 7. selectedExpectationsToAdvance 为空 → entries 为空 + emptyReason，不伪造。
 *
 * 不调用 LLM，不修改 finalText，不提交状态，不是 gate。
 */
export function compileExpectationContext(
  input: ExpectationContextCompileInput
): ExpectationContextCompileResult {
  const { intent, longTermState } = input;
  const selected = intent.selectedExpectationsToAdvance ?? [];

  // 构建 state expectation 索引：expectationId → state entry
  const stateExpectationMap = new Map<string, NonNullable<LongTermStateSnapshot["expectation"]>[number]>();
  if (longTermState?.expectation) {
    for (const e of longTermState.expectation) {
      if (e.expectationId) {
        stateExpectationMap.set(e.expectationId, e);
      }
    }
  }

  const entries: ExpectationContextEntry[] = [];
  const sourceRefSet = new Set<string>();

  for (const sel of selected) {
    const stateEntry = stateExpectationMap.get(sel.expectationId);
    const entry = buildEntry(sel, stateEntry);
    entries.push(entry);
    // 拆分 sourceRef 多个来源分别加入 sourceRefSet
    for (const ref of entry.sourceRef.split(" + ")) {
      sourceRefSet.add(ref);
    }
  }

  // 空状态处理：不得静默
  if (entries.length === 0) {
    const emptyReason = deriveEmptyReason(selected.length, longTermState);
    const expectationContext: ExpectationContext = {
      entries: [],
      sourceRefs: [],
      consumedByRawPrompt: false,
      emptyReason,
    };
    return { expectationContext, promptBlock: null };
  }

  const expectationContext: ExpectationContext = {
    entries,
    sourceRefs: Array.from(sourceRefSet),
    consumedByRawPrompt: true, // 将在 buildRawPrompt 中实际消费
  };

  const promptBlock = formatExpectationContextPromptBlock(expectationContext);
  return { expectationContext, promptBlock };
}

/**
 * 构建单条 ExpectationContextEntry。
 * 防御性检查：即使 selectedExpectationsToAdvance 混入 fulfilled，也降级为 inspect。
 */
function buildEntry(
  sel: { expectationId: string; description: string; targetReaderExperience?: string },
  stateEntry: NonNullable<LongTermStateSnapshot["expectation"]>[number] | undefined
): ExpectationContextEntry {
  const description = sel.description || stateEntry?.description || "";
  const targetReaderExperience = sel.targetReaderExperience ?? stateEntry?.targetReaderExperience;

  if (stateEntry) {
    const status = stateEntry.status;
    const stateEvidenceRef = getReliableFinalTextEvidenceRef(stateEntry);
    const sourceRef = stateEvidenceRef
      ? `chapter-intent:selectedExpectationsToAdvance + ${stateEvidenceRef}`
      : "chapter-intent:selectedExpectationsToAdvance + longTermState:expectation:unverified-source";
    const confidence = stateEvidenceRef
      ? CONFIDENCE_STATE_CONFIRMED
      : CONFIDENCE_STATE_UNVERIFIED;
    if (TERMINAL_STATUSES.has(status)) {
      // fulfilled → 仅作历史背景，inspect
      return {
        expectationId: sel.expectationId,
        description,
        status,
        targetReaderExperience,
        relevanceReason: `本章 selectedExpectationsToAdvance 命中，但长期状态标记为 ${status}（已兑现的历史背景），仅作历史背景检视，不再 advance/escalate`,
        expectedAction: "inspect",
        sourceRef,
        confidence,
      };
    }
    if (ESCALATED_STATUSES.has(status)) {
      if (!stateEvidenceRef) {
        return {
          expectationId: sel.expectationId,
          description,
          status,
          targetReaderExperience,
          relevanceReason: "长期状态标记为 escalated，但缺少可追溯 sourceRef，保守 defer，不自行升级期待",
          expectedAction: "defer",
          sourceRef,
          confidence,
        };
      }
      // escalated → 本章升级施压
      return {
        expectationId: sel.expectationId,
        description,
        status,
        targetReaderExperience,
        relevanceReason: "本章 selectedExpectationsToAdvance 命中，长期状态标记为 escalated，本章应升级施压强度",
        expectedAction: "escalate",
        sourceRef,
        confidence,
      };
    }
    if (ADVANCABLE_STATUSES.has(status)) {
      // open/advanced/delayed → 本章推进
      const delayReason = status === "delayed" && typeof stateEntry.delayReason === "string"
        ? stateEntry.delayReason.trim() || undefined
        : undefined;
      if (!stateEvidenceRef || (status === "delayed" && !delayReason)) {
        return {
          expectationId: sel.expectationId,
          description,
          status,
          targetReaderExperience,
          delayReason,
          relevanceReason: !stateEvidenceRef
            ? "长期期待缺少可追溯 sourceRef，保守 defer，不自行声称推进"
            : "delayed 期待缺失延期理由，保守 defer，不编造推进依据",
          expectedAction: "defer",
          sourceRef,
          confidence: CONFIDENCE_STATE_UNVERIFIED,
        };
      }
      return {
        expectationId: sel.expectationId,
        description,
        status,
        targetReaderExperience,
        delayReason,
        relevanceReason:
          status === "delayed"
            ? `本章 selectedExpectationsToAdvance 命中，长期状态标记为 delayed（延期蓄势），本章仍可推进`
            : "本章 selectedExpectationsToAdvance 命中，长期状态确认仍在推进中",
        expectedAction: "advance",
        sourceRef,
        confidence,
      };
    }
    // 未知 status（非标准枚举）→ 保守 inspect，不 advance
    return {
      expectationId: sel.expectationId,
      description,
      status,
      targetReaderExperience,
      relevanceReason: `本章 selectedExpectationsToAdvance 命中，长期状态 status=${status} 非标准枚举，保守 inspect`,
      expectedAction: "inspect",
      sourceRef,
      confidence,
    };
  }

  // state 中未找到 → seed_only（仅在 seed/intent 中，尚未进入长期状态）
  return {
    expectationId: sel.expectationId,
    description,
    status: "seed_only",
    targetReaderExperience,
    relevanceReason: "本章 selectedExpectationsToAdvance 命中，长期状态中暂无记录（seed 意图，待正文落地后由 FinalStateCommit 确认）",
    expectedAction: "advance",
    sourceRef: "chapter-intent:selectedExpectationsToAdvance",
    confidence: CONFIDENCE_SEED_ONLY,
  };
}

function getReliableFinalTextEvidenceRef(
  stateEntry: NonNullable<LongTermStateSnapshot["expectation"]>[number]
): string | undefined {
  if (typeof stateEntry.sourceRef !== "string" || typeof stateEntry.sourceChapter !== "string") {
    return undefined;
  }
  const sourceRef = stateEntry.sourceRef.trim();
  const match = sourceRef.match(/^(ch\d+)#finalText:([0-9a-f]{12}):(\d+)-(\d+)$/i);
  if (!match || match[1] !== stateEntry.sourceChapter) {
    return undefined;
  }
  const start = Number.parseInt(match[3], 10);
  const end = Number.parseInt(match[4], 10);
  return start < end ? sourceRef : undefined;
}

/**
 * 推导空状态原因（不得静默）。
 */
function deriveEmptyReason(
  selectedCount: number,
  longTermState: LongTermStateSnapshot | null | undefined
): string {
  if (selectedCount === 0) {
    if (!longTermState || !longTermState.expectation || longTermState.expectation.length === 0) {
      return "无 selectedExpectationsToAdvance 且无 longTermState.expectation，本章无可用读者期待状态";
    }
    return "selectedExpectationsToAdvance 为空：本章未选中任何期待，不灌入全量 ExpectationLedger（保守相关性规则）";
  }
  // 理论上不会到达（selected 非空时 entries 非空），防御性兜底
  return "selectedExpectationsToAdvance 非空但编译后 entries 为空（异常状态，请检查 status 枚举）";
}

// ============================================================================
// Prompt block 格式化
// ============================================================================

/**
 * 把 ExpectationContext 格式化为 raw prompt 的"本章相关读者期待状态"区块。
 *
 * 格式（确定性，无 LLM）：
 * ```
 * 本章相关读者期待状态（只含本章选中期待，非全量 ExpectationLedger）：
 * - exp-001——读者期待林川揭开暗流真相【状态：open｜本章方向：advance｜目标体验：悬念释放后的恍然】本章 selectedExpectationsToAdvance 命中，长期状态确认仍在推进中
 * ```
 *
 * entries 为空时返回 null（不加入 prompt，空原因只写 stageResults）。
 * 不含 aggregateQualityScore / totalScore / 固定兑现章数等机械指标。
 */
export function formatExpectationContextPromptBlock(context: ExpectationContext): string | null {
  if (context.entries.length === 0) {
    return null;
  }
  const lines = context.entries.map((e) => {
    const parts: string[] = [];
    parts.push(`状态：${e.status}`);
    parts.push(`本章方向：${e.expectedAction}`);
    if (e.targetReaderExperience) {
      parts.push(`目标体验：${e.targetReaderExperience}`);
    }
    if (e.delayReason) {
      parts.push(`延期理由：${e.delayReason}`);
    }
    return `- ${e.expectationId}——${e.description}【${parts.join("｜")}】${e.relevanceReason}`;
  });
  return `本章相关读者期待状态（只含本章选中期待，非全量 ExpectationLedger）：\n${lines.join("\n")}`;
}

// ============================================================================
// Skipped 构造（用于 hardBlock / 异常路径，保证 stageResults 不静默）
// ============================================================================

/**
 * 构造 skipped ExpectationContext（用于 hardBlock / raw 生成失败路径）。
 * 与 skippedPromiseContext 同模式：失败路径写 reason，不静默。
 */
export function skippedExpectationContext(reason: string): ExpectationContext {
  return {
    entries: [],
    sourceRefs: [],
    consumedByRawPrompt: false,
    emptyReason: `skipped: ${reason}`,
  };
}
