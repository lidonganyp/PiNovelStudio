/**
 * CONTEXT-RETRIEVAL-1 — active narrative state JIT working set。
 *
 * FUTURE-STATE-ISOLATION-1（2026-07-18）：
 *   检索前严格过滤 `sourceChapterNumber >= currentChapterNumber` 的状态条目，
 *   防止 ch17 上下文检索到 ch17/ch18/ch19 派生的状态（违反"状态只能在
 *   最终正文选定后提交"的不可变量）。无法解析章节号的条目默认不进入工作集，
 *   但记录到 `futureStateExcluded`，不静默忽略。
 *
 *   过滤覆盖五类状态：canon / character / promise / pattern / expectation。
 *   必需 promise 只存在于未来章节时，由 recall.missingRequiredIds 报告，
 *   不得回填到工作集。
 */

import type {
  CanonEntry,
  CharacterStateEntry,
  ExpectationEntry,
  PatternEntry,
  PromiseEntry,
} from "./final-state-commit.js";
// MEMORY-6：权威感知检索。对已附加 memory 信封的状态条目，按权威/认识状态
// 评估其是否可作为正式事实证据，并在评分中加权（旧条目无信封，行为不变）。
// PEA-1：pattern 等 advisory 类型不作为硬事实，但作为低权重 advisory 注入，
// 因此改用 isMemoryRetrievable 分层判定（正式事实严格把关，advisory 仅由生命周期/认识阻断）。
import { isMemoryRetrievable } from "./memory/memory-record.js";
// MEMORY-7 生产接线（2026-08-11）：TTL 到期过滤复用 memory-lifecycle 的分层判定。
// isMemoryRetrievable 只检查 lifecycleStatus 字段（expired/archived/conflicted），
// 不检查 expiresAt 是否已到期（TTL 时间判定）。working/diagnostic 等 DECAY_TYPES
// 若 expiresAt 已过但 lifecycleStatus 仍为 active，会被当作 advisory 注入——R7 缺口。
// tierForMemory 对 DECAY_TYPES 检查 expiresAt <= now，复用其判定补齐 TTL 到期过滤。
import { tierForMemory } from "./memory/memory-lifecycle.js";
// MEMORY-7 生产接线：回源能力暴露。parseSourceRef 判定唯一 sourceRef 是否可解析为
// 最终正文 span（ch{N}#finalText:{hash}[:{start}-{end}]），用于 report.traceable 审计：
// 每条检索条目能否从摘要/结构化状态回源原文。纯函数、无 I/O 副作用。
import { parseSourceRef } from "./memory/memory-compression.js";
// P4 M3 修复（2026-07-23）：type-only import，编译期擦除，无运行时耦合。
// OverdueAlertEntry 形状与 post-raw buildOverdueAlerts 对齐，供 pre-write 通道复用。
import type { OverdueAlertEntry } from "./methodology-diagnostic-derived.js";

export interface RetrievalState {
  canon: CanonEntry[];
  character: CharacterStateEntry[];
  promise: PromiseEntry[];
  pattern: PatternEntry[];
  /**
   * 读者期待状态（EXPECTATION-LEDGER-1，计划 §6.3）。
   * FUTURE-STATE-ISOLATION-1：与四类长期状态同样执行未来状态过滤。
   */
  expectation?: ExpectationEntry[];
}

export interface ContextRetrievalInput {
  chapterNumber: number;
  relevantCharacters: string[];
  selectedPromiseIds: string[];
  keywords: string[];
  state: RetrievalState;
  maxItems: number;
  /**
   * P3 H2 修复（2026-07-23）：必须纳入 workingSet 的条目 id 集合，不受 maxItems 约束。
   *
   * selectedPromiseIds 虽给必需 promise +120 加分，但仍受 itemLimit 约束——
   * 当 30+ 个更高分条目先填满 slot 时，必需 promise 会被挤出 workingSet，
   * 此前只在 recall.missingRequiredIds 中报告但不回填。forcedRecallIds 保证
   * 通过 FUTURE-STATE-ISOLATION-1 过滤（即存在于 eligible）的必需条目无论如何
   * 都被纳入 workingSet，并记入 report.forcedRecallAdded 供 trace 审计。
   *
   * force 通道只从 eligible（已过滤未来状态）中选取，不得绕过 future 过滤。
   * 条目匹配按 entry.id / promiseId / expectationId（kind 守卫）。
   */
  forcedRecallIds?: string[];
  /**
   * MEMORY-7 生产接线（2026-08-11）：当前时间戳，用于 TTL 到期过滤。
   * 默认取 Date.now()（向后兼容，不破坏现有调用）。测试可注入固定 now 验证
   * expiresAt 已过但 lifecycleStatus 仍为 active 的记忆被真正排除（R7）。
   */
  now?: number;
}

/**
 * FUTURE-STATE-ISOLATION-1：被排除的未来/不可解析状态记录。
 *
 * 每条记录必须带 sourceChapter 与 sourceRef，证明 trace 显示来源
 * （不静默忽略）。reason 区分 `future_state`（章节号 >= 当前章）与
 * `unparseable_chapter`（sourceChapter 无法解析为 chN 形式）。
 */
export interface FutureStateExcludedEntry {
  id: string;
  kind: "canon" | "character" | "promise" | "pattern" | "expectation";
  sourceChapter: string;
  sourceRef: string;
  reason: "future_state" | "unparseable_chapter" | "memory_not_formal_fact" | "memory_advisory_not_retrievable" | "memory_expired_ttl";
  /** 解析出的章节号（future_state 时为当前章或更大；unparseable 时为 null） */
  parsedChapter?: number | null;
}

export interface ContextRetrievalReport {
  requestedCharacters: string[];
  requestedPromiseIds: string[];
  keywords: string[];
  retrieved: Array<{ id: string; score: number; reason: string[]; sourceRef: string; traceable: boolean }>;
  dropped: Array<{ id: string; score: number; reason: string; sourceRef: string }>;
  recall: {
    requiredIds: string[];
    retrievedRequiredIds: string[];
    missingRequiredIds: string[];
  };
  /**
   * FUTURE-STATE-ISOLATION-1：被排除的未来/不可解析状态。
   * 检测到未来状态时不静默忽略，必须在此数组中记录来源。
   */
  futureStateExcluded: FutureStateExcludedEntry[];
  /**
   * P3 H2 修复：被 forcedRecallIds 强制纳入 workingSet 的条目 id 列表。
   * 这些条目绕过 itemLimit 但仍遵守 FUTURE-STATE-ISOLATION-1。
   * 仅供 trace 审计，不参与评分。空数组表示无强制纳入。
   */
  forcedRecallAdded: string[];
  /**
   * PEA-1：被 advisory 专用召回通道纳入 workingSet 的条目 id 列表。
   * PatternMemory 等 advisory 类型（system_derived/derived 降权后 score 恒 < 阈值 10）
   * 无法经 passingScore 进入工作集，但应作为低权重上下文注入。本通道用 itemLimit
   * 剩余名额补充召回，不挤占正式事实。仅供 trace 审计。
   */
  advisoryInjected: string[];
}

export interface ContextRetrievalResult {
  workingSet: RetrievalState;
  promptItems: Array<{ id: string; kind: string; summary: string; sourceRef: string }>;
  report: ContextRetrievalReport;
  /**
   * P4 M3 修复（2026-07-23）：pre-write overdue alerts，从 eligible（已过
   * FUTURE-STATE-ISOLATION-1）派生。低相关度（score<10）的 overdue 期待不在
   * workingSet，但仍逾期；writer 模型写前应被告知。由 deriveLongTermState
   * 读取到 LongTermStateSnapshot.overdueAlerts，再经 ChapterIntentInput.overdueAlerts
   * → ChapterIntent.overduePressure 暴露给 raw prompt。
   *
   * 与 post-raw buildOverdueAlerts 区别：此处只覆盖 ExpectationEntry
   * （PromiseEntry 无 overdueWindow 与 escalated/delayed 状态），且数据源是
   * eligible 而非 SerialDiagnosticState。
   */
  overdueAlerts: OverdueAlertEntry[];
}

type AnyEntry = CanonEntry | CharacterStateEntry | PromiseEntry | PatternEntry | ExpectationEntry;
type AnyKind = "canon" | "character" | "promise" | "pattern" | "expectation";

export function retrieveNarrativeContext(input: ContextRetrievalInput): ContextRetrievalResult {
  // MEMORY-7 生产接线：默认 now = Date.now()，测试可注入固定时间验证 TTL 到期过滤。
  const now = input.now ?? Date.now();
  // FUTURE-STATE-ISOLATION-1：聚合所有状态，先按 sourceChapter 严格过滤
  const allEntries: AnyEntry[] = [
    ...input.state.canon,
    ...input.state.character,
    ...input.state.promise,
    ...input.state.pattern,
    ...(input.state.expectation ?? []),
  ];

  const futureStateExcluded: FutureStateExcludedEntry[] = [];
  const eligible: AnyEntry[] = [];

  for (const entry of allEntries) {
    const kind = entry.kind as AnyKind;
    const parsed = parseChapterNumber(entry.sourceChapter);
    if (parsed === null) {
      // 无法解析章节号：默认不进入工作集，记录诊断（不静默）
      futureStateExcluded.push({
        id: entry.id,
        kind,
        sourceChapter: entry.sourceChapter,
        sourceRef: entry.sourceRef,
        reason: "unparseable_chapter",
        parsedChapter: null,
      });
      continue;
    }
    if (parsed >= input.chapterNumber) {
      // 未来状态（含当前章）：排除，记录来源
      futureStateExcluded.push({
        id: entry.id,
        kind,
        sourceChapter: entry.sourceChapter,
        sourceRef: entry.sourceRef,
        reason: "future_state",
        parsedChapter: parsed,
      });
      continue;
    }
    // MEMORY-6：对已有 memory 信封的条目做权威感知过滤。
    // 正式事实类型（canon/character/promise）严格把关；advisory 类型（pattern 等）
    // 由 isMemoryRetrievable 判定——不作为硬事实，但作为低权重 advisory 注入。
    // 旧条目（无信封）不受影响，保持既有行为。
    if (entry.memory) {
      const factCheck = isMemoryRetrievable(entry.memory);
      if (!factCheck.usable) {
        futureStateExcluded.push({
          id: entry.id,
          kind,
          sourceChapter: entry.sourceChapter,
          sourceRef: entry.sourceRef,
          reason: factCheck.advisory ? "memory_advisory_not_retrievable" : "memory_not_formal_fact",
          parsedChapter: parsed,
        });
        continue;
      }
      // MEMORY-7 生产接线：TTL 到期过滤（R7）。
      // isMemoryRetrievable 只检查 lifecycleStatus 字段，不判定 expiresAt 是否到期。
      // working/diagnostic 等 DECAY_TYPES 若 expiresAt < now 但 lifecycleStatus 仍 active，
      // 会被当作 advisory 注入——TTL 未真正生效。复用 tierForMemory 补齐到期判定，
      // 到期条目排除并记入 futureStateExcluded.reason=memory_expired_ttl，不静默忽略。
      if (tierForMemory(entry.memory, now) === "expired") {
        futureStateExcluded.push({
          id: entry.id,
          kind,
          sourceChapter: entry.sourceChapter,
          sourceRef: entry.sourceRef,
          reason: "memory_expired_ttl",
          parsedChapter: parsed,
        });
        continue;
      }
    }
    eligible.push(entry);
  }

  // P4 M3：从 eligible（已过 FUTURE-STATE-ISOLATION-1）派生 pre-write overdue alerts。
  // 只取 expectation kind（PromiseEntry 无 overdueWindow，buildOverdueAlerts 的
  // promise 分支在 RetrievalState 上恒为空）。
  const eligibleExpectations = eligible.filter(
    (entry): entry is ExpectationEntry => entry.kind === "expectation",
  );
  const overdueAlerts = computeOverdueAlertsFromRetrievalState(
    { canon: [], character: [], promise: [], pattern: [], expectation: eligibleExpectations },
    input.chapterNumber,
  );

  // 仅对 eligible 条目评分排序
  const scored = eligible
    .map((entry) => scoreEntry(entry, input))
    .sort((left, right) =>
      right.score - left.score
      || chapterNumber(right.entry.sourceChapter) - chapterNumber(left.entry.sourceChapter)
      || left.entry.id.localeCompare(right.entry.id)
    );
  const passingScore = scored.filter((item) => item.score >= 10);
  const itemLimit = Math.max(0, Math.floor(input.maxItems));
  const perKindFloor = Math.min(4, Math.floor(itemLimit / 4));
  const selectedIdSet = new Set<string>();

  // PEA-1 v2：advisory 专用召回通道（先于正式事实预留恒定名额）。
  //
  // 背景（P1-REPLAY-1 暴露）：原实现把 advisory 注入定位为"itemLimit 剩余名额"，
  // 只有当正式事实未占满 itemLimit 时才有空位。真实长篇（如 20 章）中 canon/
  // character 等正式事实数量远超 itemLimit，会先占满全部名额，导致 PatternMemory
  // 永远拿不到任何空位——P1 在真实场景下并未彻底解决。
  //
  // 修复：advisory 通道不再依赖"剩余名额"，而是像 forcedRecall 一样**预留**一个
  // 恒定预算（advisoryFloor = max(1, floor(itemLimit/8))）并优先注入。然后将
  // 正式事实的填充预算降为 (itemLimit - advisoryInjected.length)，保证正式事实
  // 始终有主体名额，同时 PatternMemory 恒定有少量低权重上下文名额。
  //
  // PatternMemory 等 advisory 类型（system_derived -20 / derived -10 降权后，无关键词
  // 命中时最高分 = recency 上限 20 - 30 = -10）分数恒低于 passingScore 阈值 10，
  // 无法经常规通道进入 workingSet，因此本通道是它们唯一的生产入口。
  const advisoryEntries = eligible.filter((entry) => isAdvisoryEntry(entry));
  const advisoryFloor = Math.min(advisoryEntries.length, Math.max(1, Math.floor(itemLimit / 8)));
  const advisoryInjected: string[] = [];
  // PEA-1 v3（P1-PRODUCTION-REPLAY-1）：advisory 通道优先注入**带 memory 信封**的
  // 正式 PatternMemory，无信封的派生 pattern（如 backfill 的 accepted-ending）仅作后备。
  //
  // P1-REPLAY-1 暴露：v2 预留预算后，advisory 通道仍按通用 scoreEntry 排序取前
  // advisoryFloor 个。而正式 PatternMemory（system_derived -20 / derived -10）降权后
  // score 恒为负，被 backfill 为每章生成的无信封 pattern（如 ch20 的 accepted-ending，
  // 无降权、recency 分高）挤到末尾，永远选不中——P1 在真实长篇中仍未彻底解决
  // （正式 PatternMemory 进不了生产工作集）。
  //
  // 修复：advisory 候选按"是否带 memory 信封"分层。优先注入带信封的正式 PatternMemory
  // （持久记忆资产），耗尽后再补无信封的派生 pattern。保证正式 PatternMemory 恒定
  // 有入口，同时不妨碍无信封派生 pattern 在名额富余时补充。
  const advisoryWithMemory = advisoryEntries.filter((entry) => entry.memory);
  const advisoryFallback = advisoryEntries.filter((entry) => !entry.memory);
  const injectAdvisory = (candidates: typeof advisoryEntries): void => {
    for (const item of scored) {
      if (advisoryInjected.length >= advisoryFloor) break;
      if (!candidates.some((candidate) => candidate.id === item.entry.id)) continue;
      if (!selectedIdSet.has(item.entry.id)) {
        selectedIdSet.add(item.entry.id);
        advisoryInjected.push(item.entry.id);
      }
    }
  };
  // 优先正式 PatternMemory（带 memory 信封），保证 P1 核心资产进入工作集。
  injectAdvisory(advisoryWithMemory);
  // 正式 PatternMemory 不足时，再补无信封的派生 pattern（backfill 等）。
  injectAdvisory(advisoryFallback);
  const formalBudget = Math.max(0, itemLimit - advisoryInjected.length);

  // 正式事实填充 remaining budget（canon/pattern perKindFloor + passingScore 全局），
  // 上限为 formalBudget。advisory 已预留名额，正式事实不会因注入而丢失。
  //
  // P1-PRODUCTION-REPLAY-1 修正：formalBudget 是"正式事实可新增"的数量上限，
  // 判断必须用独立的 formalAdded 计数，而不能用 selectedIdSet.size >= formalBudget——
  // 后者会把 advisory 已预留的名额也算入，导致正式事实少填、工作集总量不足
  // （future-state-isolation-1.test.mjs 期望 retrieved 填满 maxItems 时暴露）。
  let formalAdded = 0;
  for (const kind of ["canon", "pattern"] as const) {
    for (const item of passingScore
      .filter((candidate) => candidate.entry.kind === kind && !selectedIdSet.has(candidate.entry.id))
      .slice(0, perKindFloor)) {
      if (formalAdded >= formalBudget) break;
      selectedIdSet.add(item.entry.id);
      formalAdded++;
    }
  }
  for (const item of passingScore) {
    if (formalAdded >= formalBudget) break;
    if (selectedIdSet.has(item.entry.id)) continue;
    selectedIdSet.add(item.entry.id);
    formalAdded++;
  }

  // P3 H2：forcedRecallIds 强制通道——必需 promise 虽 +120 加分但可能被更高分
  // 条目挤出 itemLimit。此处把通过 FUTURE-STATE-ISOLATION-1（已存在于 eligible）
  // 的 forced 条目强制纳入 selectedIdSet，不受 itemLimit 约束。force 通道只从
  //  eligible 选取，未来条目已在上方被排除，不得绕过 future 过滤。
  const forcedIdSet = new Set(input.forcedRecallIds ?? []);
  const forcedEligible = forcedIdSet.size > 0
    ? eligible.filter((entry) => isForcedEntry(entry, forcedIdSet))
    : [];
  const forcedAdded: string[] = [];
  for (const entry of forcedEligible) {
    if (!selectedIdSet.has(entry.id)) {
      selectedIdSet.add(entry.id);
      forcedAdded.push(entry.id);
    }
  }

  // selected 包含 (a) passingScore 中被选中的，与 (b) 不在 passingScore（score<10）
  // 但被强制纳入的条目（score=0, reasons=["forced_recall"]），以及 (c) 被 advisory
  // 通道纳入的条目（score=0, reasons=["advisory_recall"]）。
  const forcedNotInPassing = forcedEligible.filter(
    (entry) => !passingScore.some((item) => item.entry.id === entry.id),
  );
  const advisoryNotInPassing = advisoryEntries.filter(
    (entry) => advisoryInjected.includes(entry.id)
      && !passingScore.some((item) => item.entry.id === entry.id),
  );
  const selected = [
    ...passingScore.filter((item) => selectedIdSet.has(item.entry.id)),
    ...forcedNotInPassing.map((entry) => ({ entry, score: 0, reasons: ["forced_recall"] })),
    ...advisoryNotInPassing.map((entry) => ({ entry, score: 0, reasons: ["advisory_recall"] })),
  ];
  const selectedIds = new Set(selected.map((item) => item.entry.id));

  // recall：必需 promise 的可达性（仅在 eligible 集合内检索）
  const requiredIds = input.selectedPromiseIds.map((id) => {
    const promise = eligible.find((entry) => entry.kind === "promise" && (entry.promiseId === id || entry.id === id));
    return promise?.id ?? id;
  });
  const retrievedRequiredIds = requiredIds.filter((id) => selectedIds.has(id));
  const missingRequiredIds = requiredIds.filter((id) => !selectedIds.has(id));

  const workingEntries = selected.map((item) => item.entry);

  return {
    workingSet: {
      canon: workingEntries.filter((entry): entry is CanonEntry => entry.kind === "canon"),
      character: workingEntries.filter((entry): entry is CharacterStateEntry => entry.kind === "character"),
      promise: workingEntries.filter((entry): entry is PromiseEntry => entry.kind === "promise"),
      pattern: workingEntries.filter((entry): entry is PatternEntry => entry.kind === "pattern"),
      expectation: workingEntries.filter((entry): entry is ExpectationEntry => entry.kind === "expectation"),
    },
    promptItems: selected.map(({ entry }) => ({
      id: entry.id,
      kind: entry.kind,
      summary: summarize(entry).slice(0, 160),
      sourceRef: entry.sourceRef,
    })),
    report: {
      requestedCharacters: [...input.relevantCharacters],
      requestedPromiseIds: [...input.selectedPromiseIds],
      keywords: [...input.keywords],
      retrieved: selected.map(({ entry, score, reasons }) => ({
        id: entry.id,
        score,
        reason: reasons,
        sourceRef: entry.sourceRef,
        // MEMORY-7 生产接线：回源能力审计。sourceRef 是否为可解析的最终正文 span
        // （ch{N}#finalText:{hash}[:{start}-{end}]）。true 表示该条目可从摘要/结构化
        // 状态回源原文；false 表示无法精确定位（fail-closed，不返回模糊片段）。
        traceable: entry.sourceRef ? parseSourceRef(entry.sourceRef) !== null : false,
      })),
      dropped: scored
        .filter((item) => !selectedIds.has(item.entry.id))
        .map(({ entry, score }) => ({
          id: entry.id,
          score,
          reason: score < 10 ? "below_relevance_threshold" : "below_top_k",
          sourceRef: entry.sourceRef,
        })),
      recall: {
        requiredIds,
        retrievedRequiredIds,
        missingRequiredIds,
      },
      futureStateExcluded,
      forcedRecallAdded: forcedAdded,
      advisoryInjected,
    },
    overdueAlerts,
  };
}

/**
 * P4 M3 修复（2026-07-23）：从 RetrievalState 派生 pre-write overdue alerts。
 *
 * 与 post-raw buildOverdueAlerts 的差异：
 * - 数据源是 RetrievalState（来自 eligible，已过 FUTURE-STATE-ISOLATION-1）
 *   而非 SerialDiagnosticState；
 * - 只覆盖 ExpectationEntry（PromiseEntry 无 overdueWindow 与 escalated/delayed
 *   状态，buildOverdueAlerts 中的 promise 分支在 RetrievalState 上恒为空）；
 * - sourceRef 用 ExpectationEntry.sourceRef（单数）兜底 sourceRefs?.[0]，
 *   而非 SerialDiagnosticState.expectation.sourceRefs[0]。
 *
 * YELLOW_WINDOW=2 与 buildOverdueAlerts 对齐：red = chapter > latest；
 * yellow = chapter >= latest - 2 且 chapter <= latest。fulfilled 一律排除。
 */
export function computeOverdueAlertsFromRetrievalState(
  state: RetrievalState,
  chapterNumber: number,
): OverdueAlertEntry[] {
  const alerts: OverdueAlertEntry[] = [];
  const YELLOW_WINDOW = 2;
  for (const expectation of state.expectation ?? []) {
    if (expectation.status === "fulfilled") continue;
    const latest = expectation.overdueWindow?.latest ?? null;
    const sourceRef = expectation.sourceRef ?? expectation.sourceRefs?.[0] ?? "";
    if (latest !== null) {
      if (chapterNumber > latest) {
        alerts.push({
          itemId: expectation.expectationId,
          itemType: "expectation",
          severity: "red",
          description: expectation.description,
          expectedLatest: latest,
          chaptersOverdue: chapterNumber - latest,
          sourceRef,
        });
      } else if (chapterNumber >= latest - YELLOW_WINDOW) {
        alerts.push({
          itemId: expectation.expectationId,
          itemType: "expectation",
          severity: "yellow",
          description: expectation.description,
          expectedLatest: latest,
          chaptersOverdue: null,
          sourceRef,
        });
      }
    } else if (expectation.status === "escalated") {
      alerts.push({
        itemId: expectation.expectationId,
        itemType: "expectation",
        severity: "red",
        description: expectation.description,
        expectedLatest: null,
        chaptersOverdue: null,
        sourceRef,
      });
    } else if (expectation.status === "delayed") {
      alerts.push({
        itemId: expectation.expectationId,
        itemType: "expectation",
        severity: "yellow",
        description: expectation.description,
        expectedLatest: null,
        chaptersOverdue: null,
        sourceRef,
      });
    }
  }
  return alerts;
}

function scoreEntry(entry: AnyEntry, input: ContextRetrievalInput): { entry: AnyEntry; score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  // MEMORY-6：权威/认识状态加权。对已附加 memory 信封的条目，author_declaration /
  // final_text_explicit + confirmed 优先返回；system_derived 降权。旧条目（无信封）无加成。
  if (entry.memory) {
    if (entry.memory.authorityClass === "author_declaration") {
      score += 50;
      reasons.push("memory_author_declared");
    } else if (entry.memory.authorityClass === "final_text_explicit") {
      score += 40;
      reasons.push("memory_final_text");
    } else if (entry.memory.authorityClass === "committed_state") {
      score += 30;
      reasons.push("memory_committed");
    } else if (entry.memory.authorityClass === "system_derived") {
      score -= 20;
      reasons.push("memory_system_derived");
    }
    if (entry.memory.epistemicStatus === "confirmed") {
      score += 20;
      reasons.push("memory_confirmed");
    } else if (entry.memory.epistemicStatus === "derived") {
      score -= 10;
      reasons.push("memory_derived");
    }
  }
  const text = summarize(entry);
  if (entry.kind === "character" && input.relevantCharacters.includes(entry.characterId)) {
    score += 100;
    reasons.push("character_exact");
  }
  if (entry.kind === "promise" && input.selectedPromiseIds.some((id) => id === entry.promiseId || id === entry.id)) {
    score += 120;
    reasons.push("promise_required");
  }
  for (const keyword of input.keywords.filter(Boolean)) {
    if (!text.includes(keyword)) continue;
    score += 40;
    reasons.push(`keyword:${keyword}`);
  }
  const distance = Math.abs(input.chapterNumber - chapterNumber(entry.sourceChapter));
  score += Math.max(0, 20 - distance);
  if (distance <= 3) reasons.push("recent_chapter");
  if (entry.kind === "promise") score += Math.min(10, entry.currentHeat * 2);
  return { entry, score, reasons };
}

/**
 * P3 H2：判断条目是否被 forcedRecallIds 命中。
 * 匹配 entry.id；promise 额外匹配 promiseId；expectation 额外匹配 expectationId。
 * kind 守卫保证类型窄化安全（AnyEntry 是联合类型，promiseId/expectationId 只在对应 kind 存在）。
 */
function isForcedEntry(entry: AnyEntry, forcedIdSet: Set<string>): boolean {
  if (forcedIdSet.has(entry.id)) return true;
  if (entry.kind === "promise") return forcedIdSet.has(entry.promiseId);
  if (entry.kind === "expectation") return forcedIdSet.has(entry.expectationId);
  return false;
}

/**
 * PEA-1：判断条目是否为 advisory 类型（PatternMemory 等非正式事实）。
 *
 * 正式事实类型（canon/character/promise/chapter_fact）作为权威上下文；pattern 等
 * advisory 类型不作为硬事实，但应作为低权重上下文注入。判定优先依据 memory 信封的
 * isMemoryRetrievable（advisory 标志），无信封的 pattern 条目也视为 advisory。
 */
function isAdvisoryEntry(entry: AnyEntry): boolean {
  if (entry.kind === "pattern") return true;
  if (entry.memory) {
    const check = isMemoryRetrievable(entry.memory);
    return check.advisory === true;
  }
  return false;
}

function summarize(entry: AnyEntry): string {
  switch (entry.kind) {
    case "canon": return entry.fact;
    case "character": return `${entry.characterId}.${entry.field}=${entry.value}`;
    case "promise": return `${entry.promiseId}:${entry.description}:${entry.status}`;
    case "pattern": return `${entry.patternType}:${entry.description}`;
    case "expectation": return `${entry.expectationId}:${entry.description}:${entry.status}`;
  }
}

/**
 * 解析 sourceChapter 字符串为章节号。
 *
 * 仅接受 `chN` 形式（N 为正整数）。其他形式（"unknown"、"ch-recover"、"" 等）
 * 返回 null，调用方据此排除条目并记录诊断，不静默忽略。
 *
 * 注意：旧版 chapterNumber() 返回 0 兜底，会把所有不可解析条目当成 ch0；
 * FUTURE-STATE-ISOLATION-1 之后改为 null 显式区分。
 */
function parseChapterNumber(value: string | undefined | null): number | null {
  if (!value) return null;
  const match = value.match(/^ch(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * 评分时的距离计算 helper：仍接受宽松匹配（提取第一段数字），
 * 因为能进入评分阶段的条目都经过了 parseChapterNumber 严格过滤。
 */
function chapterNumber(value: string): number {
  const match = value.match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}
