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
  reason: "future_state" | "unparseable_chapter";
  /** 解析出的章节号（future_state 时为当前章或更大；unparseable 时为 null） */
  parsedChapter?: number | null;
}

export interface ContextRetrievalReport {
  requestedCharacters: string[];
  requestedPromiseIds: string[];
  keywords: string[];
  retrieved: Array<{ id: string; score: number; reason: string[]; sourceRef: string }>;
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
}

export interface ContextRetrievalResult {
  workingSet: RetrievalState;
  promptItems: Array<{ id: string; kind: string; summary: string; sourceRef: string }>;
  report: ContextRetrievalReport;
}

type AnyEntry = CanonEntry | CharacterStateEntry | PromiseEntry | PatternEntry | ExpectationEntry;
type AnyKind = "canon" | "character" | "promise" | "pattern" | "expectation";

export function retrieveNarrativeContext(input: ContextRetrievalInput): ContextRetrievalResult {
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
    eligible.push(entry);
  }

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
  for (const kind of ["canon", "pattern"] as const) {
    for (const item of passingScore.filter((candidate) => candidate.entry.kind === kind).slice(0, perKindFloor)) {
      selectedIdSet.add(item.entry.id);
    }
  }
  for (const item of passingScore) {
    if (selectedIdSet.size >= itemLimit) break;
    selectedIdSet.add(item.entry.id);
  }
  const selected = passingScore.filter((item) => selectedIdSet.has(item.entry.id));
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
    },
  };
}

function scoreEntry(entry: AnyEntry, input: ContextRetrievalInput): { entry: AnyEntry; score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
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
