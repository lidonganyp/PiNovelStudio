/**
 * methodology-diagnostic-advisory — advisory signals from reader feedback,
 * return chapter provenance, and chapter progression contracts.
 *
 * P1-5 修复（2026-07-21）：从 methodology-diagnostic-state.ts 拆出，消费 3 个新增数据源：
 * - reader-feedback.json：读者反馈（正/负/中），advisory 趋势信号
 * - return-chapter-provenance.json：回流章 provenance（rewrite/recap/reveal）
 * - chapter-progression-contracts.json：章节推进契约（expected/actual axes, review signals）
 *
 * 产出 advisory 信号给 post-raw judge（通过 MethodologyDiagnosticState.advisorySignals），
 * 不进入 raw prompt，不授权候选，不决定文学胜负。
 *
 * 设计原则（与 methodology-diagnostic-state.ts 一致）：
 * - advisory-only：只提供信号，不阻断生成，不决定文学胜负
 * - 保守策略：数据缺失时返回 emptyReason，不机器推断
 * - sourceRef 必须可追溯
 * - 失败不抛异常，返回 unavailable 状态
 */

import {
  finiteNumber,
  isDefined,
  isRecord,
  recordArray,
  stringValue,
  stringArray,
  uniqueStrings,
} from "./methodology-diagnostic-utils.js";
import { unavailableReason, type ReadJsonResult } from "./methodology-diagnostic-sources.js";

// ============================================================================
// 类型定义
// ============================================================================

export interface ReaderFeedbackEntry {
  feedbackId: string;
  chapterId: string;
  chapterNumber: number;
  feedbackType: "positive" | "negative" | "neutral" | "unknown";
  focusDimensions: string[];
  sourceRef: string;
}

export interface ReaderFeedbackSummary {
  status: "available" | "unavailable";
  totalCount: number;
  /** 最近 N 条反馈（按 chapterNumber 降序，limit 由 maxEntries 控制） */
  recentFeedbacks: ReaderFeedbackEntry[];
  /**
   * 趋势信号（advisory）：
   * - positive：最近 N 条中 positive 占多数
   * - negative：最近 N 条中 negative 占多数
   * - neutral：最近 N 条中 neutral 占多数
   * - mixed：无明显多数
   * - unknown：无数据
   */
  sentimentTrend: "positive" | "negative" | "neutral" | "mixed" | "unknown";
  sourceRefs: string[];
  emptyReason: string | null;
}

export interface ReturnChapterProvenanceEntry {
  entryId: string;
  chapterId: string;
  chapterNumber: number;
  returnType: "rewrite" | "recap" | "reveal" | "unknown";
  sourceChapterIds: string[];
  reason: string;
  sourceRef: string;
}

export interface ReturnChapterSummary {
  status: "available" | "unavailable";
  totalCount: number;
  recentEntries: ReturnChapterProvenanceEntry[];
  /** 当前章是否为回流章（advisory，根据 chapterNumber 匹配） */
  isCurrentChapterReturn: boolean;
  sourceRefs: string[];
  emptyReason: string | null;
}

export interface ProgressionContractSummary {
  status: "available" | "unavailable";
  /** 前一章 contract（chapterNumber - 1，用于跨章 delta 比较） */
  previousContract: {
    chapterNumber: number;
    expectedAxes: { plot: boolean; info: boolean; character: boolean; world: boolean; causal: boolean };
    actualAxes: { plot: boolean; info: boolean; character: boolean; world: boolean; causal: boolean };
    reviewSignals: Array<{ dimension: string; reason: string }>;
  } | null;
  /**
   * 历史未推进维度（advisory）：扫描所有历史 contract，找出 expected=true 但 actual=false
   * 的轴。如果某个轴在多个连续 contract 中都未推进，标记为 chronic gap。
   */
  chronicGapAxes: string[];
  sourceRefs: string[];
  emptyReason: string | null;
}

export interface AdvisorySignalsDiagnosticContext {
  status: "available" | "unavailable";
  readerFeedback: ReaderFeedbackSummary;
  returnChapter: ReturnChapterSummary;
  progressionContract: ProgressionContractSummary;
  sourceRefs: string[];
  emptyReason: string | null;
}

// ============================================================================
// 常量
// ============================================================================

/** 趋势判断的最小样本数（少于此数无法判断趋势） */
const SENTIMENT_MIN_SAMPLES = 3;
/** chronic gap 的最小连续未推进次数 */
const CHRONIC_GAP_THRESHOLD = 2;

// ============================================================================
// 主入口
// ============================================================================

/**
 * 从 3 个 advisory 数据源构建 advisory 信号上下文。
 *
 * 输入：3 个 ReadJsonResult（来自 methodology-diagnostic-sources.ts 的 readJsonSource）
 * 输出：AdvisorySignalsDiagnosticContext，嵌入 MethodologyDiagnosticState.advisorySignals
 *
 * 失败策略：
 * - 任一源 missing/malformed → 对应子上下文返回 unavailable + emptyReason
 * - 不抛异常，不阻断诊断层
 */
export function buildAdvisorySignals(
  readerFeedbackSource: ReadJsonResult,
  returnChapterSource: ReadJsonResult,
  progressionContractSource: ReadJsonResult,
  chapterNumber: number,
  maxEntries: number,
): AdvisorySignalsDiagnosticContext {
  const readerFeedback = buildReaderFeedbackSummary(readerFeedbackSource, chapterNumber, maxEntries);
  const returnChapter = buildReturnChapterSummary(returnChapterSource, chapterNumber, maxEntries);
  const progressionContract = buildProgressionContractSummary(
    progressionContractSource,
    chapterNumber,
  );

  const available = [readerFeedback, returnChapter, progressionContract].some(
    (s) => s.status === "available",
  );
  const sourceRefs = uniqueStrings([
    ...readerFeedback.sourceRefs,
    ...returnChapter.sourceRefs,
    ...progressionContract.sourceRefs,
  ]);

  return {
    status: available ? "available" : "unavailable",
    readerFeedback,
    returnChapter,
    progressionContract,
    sourceRefs,
    emptyReason: available ? null : "all_advisory_sources_missing",
  };
}

// ============================================================================
// Reader feedback summary
// ============================================================================

function buildReaderFeedbackSummary(
  source: ReadJsonResult,
  chapterNumber: number,
  maxEntries: number,
): ReaderFeedbackSummary {
  if (!source.value) {
    return {
      status: "unavailable",
      totalCount: 0,
      recentFeedbacks: [],
      sentimentTrend: "unknown",
      sourceRefs: [],
      emptyReason: unavailableReason(source, "reader_feedback_unavailable"),
    };
  }

  const feedbacks = recordArray(source.value.feedbacks)
    .map(parseReaderFeedback)
    .filter(isDefined)
    .filter((entry) => entry.chapterNumber < chapterNumber)
    .sort((a, b) => b.chapterNumber - a.chapterNumber)
    .slice(0, maxEntries);

  const totalCount = finiteNumber(source.value.feedbacks && Array.isArray(source.value.feedbacks) ? source.value.feedbacks.length : null) ?? 0;
  const sentimentTrend = computeSentimentTrend(feedbacks);
  const sourceRefs = uniqueStrings(
    feedbacks.map((entry) => entry.sourceRef),
  );

  return {
    status: "available",
    totalCount,
    recentFeedbacks: feedbacks,
    sentimentTrend,
    sourceRefs,
    emptyReason: feedbacks.length === 0 ? "no_prior_chapter_feedback" : null,
  };
}

function parseReaderFeedback(value: Record<string, unknown>): ReaderFeedbackEntry | null {
  const feedbackId = stringValue(value.id) ?? stringValue(value.feedbackId);
  const chapterId = stringValue(value.chapterId);
  const chapterNumber = finiteNumber(value.chapterNumber);
  if (!feedbackId || !chapterId || chapterNumber === null) return null;
  const rawType = stringValue(value.feedbackType);
  const feedbackType: ReaderFeedbackEntry["feedbackType"] =
    rawType === "positive" || rawType === "negative" || rawType === "neutral"
      ? rawType
      : "unknown";
  const sourceRef = stringValue(value.sourceRef) ?? `series/reader-feedback.json#${feedbackId}`;
  return {
    feedbackId,
    chapterId,
    chapterNumber,
    feedbackType,
    focusDimensions: stringArray(value.focusDimensions, 8),
    sourceRef,
  };
}

function computeSentimentTrend(
  feedbacks: ReaderFeedbackEntry[],
): ReaderFeedbackSummary["sentimentTrend"] {
  if (feedbacks.length < SENTIMENT_MIN_SAMPLES) return "unknown";
  const counts = { positive: 0, negative: 0, neutral: 0, unknown: 0 };
  for (const f of feedbacks) {
    counts[f.feedbackType]++;
  }
  const max = Math.max(counts.positive, counts.negative, counts.neutral);
  const winners = [
    counts.positive === max && "positive",
    counts.negative === max && "negative",
    counts.neutral === max && "neutral",
  ].filter(Boolean) as string[];
  if (winners.length > 1) return "mixed";
  if (winners.length === 0) return "unknown";
  if (winners[0] === "unknown") return "unknown";
  return winners[0] as ReaderFeedbackSummary["sentimentTrend"];
}

// ============================================================================
// Return chapter summary
// ============================================================================

function buildReturnChapterSummary(
  source: ReadJsonResult,
  chapterNumber: number,
  maxEntries: number,
): ReturnChapterSummary {
  if (!source.value) {
    return {
      status: "unavailable",
      totalCount: 0,
      recentEntries: [],
      isCurrentChapterReturn: false,
      sourceRefs: [],
      emptyReason: unavailableReason(source, "return_chapter_provenance_unavailable"),
    };
  }

  const entries = recordArray(source.value.entries)
    .map(parseReturnChapterProvenance)
    .filter(isDefined)
    .filter((entry) => entry.chapterNumber <= chapterNumber)
    .sort((a, b) => b.chapterNumber - a.chapterNumber)
    .slice(0, maxEntries);

  const totalCount = finiteNumber(source.value.entries && Array.isArray(source.value.entries) ? source.value.entries.length : null) ?? 0;
  const isCurrentChapterReturn = entries.some((e) => e.chapterNumber === chapterNumber);
  const sourceRefs = uniqueStrings(entries.map((entry) => entry.sourceRef));

  return {
    status: "available",
    totalCount,
    recentEntries: entries,
    isCurrentChapterReturn,
    sourceRefs,
    emptyReason: entries.length === 0 ? "no_return_chapter_provenance" : null,
  };
}

function parseReturnChapterProvenance(
  value: Record<string, unknown>,
): ReturnChapterProvenanceEntry | null {
  const entryId = stringValue(value.id) ?? stringValue(value.entryId);
  const chapterId = stringValue(value.chapterId);
  const chapterNumber = finiteNumber(value.chapterNumber);
  if (!entryId || !chapterId || chapterNumber === null) return null;
  const rawType = stringValue(value.returnType);
  const returnType: ReturnChapterProvenanceEntry["returnType"] =
    rawType === "rewrite" || rawType === "recap" || rawType === "reveal"
      ? rawType
      : "unknown";
  const sourceChapterIds = stringArray(value.sourceChapterIds, 20);
  const reason = stringValue(value.reason) ?? "";
  const sourceRef = stringValue(value.sourceRef) ?? `series/return-chapter-provenance.json#${entryId}`;
  return {
    entryId,
    chapterId,
    chapterNumber,
    returnType,
    sourceChapterIds,
    reason,
    sourceRef,
  };
}

// ============================================================================
// Progression contract summary
// ============================================================================

function buildProgressionContractSummary(
  source: ReadJsonResult,
  chapterNumber: number,
): ProgressionContractSummary {
  if (!source.value) {
    return {
      status: "unavailable",
      previousContract: null,
      chronicGapAxes: [],
      sourceRefs: [],
      emptyReason: unavailableReason(source, "progression_contract_unavailable"),
    };
  }

  const contracts = recordArray(source.value.contracts)
    .map(parseProgressionContract)
    .filter(isDefined)
    .filter((c) => c.chapterNumber < chapterNumber)
    .sort((a, b) => a.chapterNumber - b.chapterNumber);

  if (contracts.length === 0) {
    return {
      status: "available",
      previousContract: null,
      chronicGapAxes: [],
      sourceRefs: [`series/chapter-progression-contracts.json#root`],
      emptyReason: "no_prior_chapter_contract",
    };
  }

  // 前一章 contract（chapterNumber - 1，如有）
  const previousContract = contracts.find((c) => c.chapterNumber === chapterNumber - 1) ?? null;

  // chronic gap：扫描所有历史 contract，找出 expected=true 但 actual=false 的轴，
  // 如果连续 >= CHRONIC_GAP_THRESHOLD 个 contract 都未推进，标记为 chronic gap
  const chronicGapAxes = computeChronicGapAxes(contracts);

  const sourceRefs = uniqueStrings(
    contracts.map((c) => `series/chapter-progression-contracts.json#ch${c.chapterNumber}`),
  );

  return {
    status: "available",
    previousContract: previousContract
      ? {
          chapterNumber: previousContract.chapterNumber,
          expectedAxes: previousContract.expectedAxes,
          actualAxes: previousContract.actualAxes,
          reviewSignals: previousContract.reviewSignals,
        }
      : null,
    chronicGapAxes,
    sourceRefs,
    emptyReason: null,
  };
}

interface ParsedProgressionContract {
  chapterNumber: number;
  expectedAxes: { plot: boolean; info: boolean; character: boolean; world: boolean; causal: boolean };
  actualAxes: { plot: boolean; info: boolean; character: boolean; world: boolean; causal: boolean };
  reviewSignals: Array<{ dimension: string; reason: string }>;
}

function parseProgressionContract(value: Record<string, unknown>): ParsedProgressionContract | null {
  const chapterNumber = finiteNumber(value.chapterNumber);
  if (chapterNumber === null) return null;
  const expectedAxes = parseAxes(value.expectedAxes);
  const actualAxes = parseAxes(value.actualAxes);
  const reviewSignals = parseReviewSignals(value.reviewSignals);
  return { chapterNumber, expectedAxes, actualAxes, reviewSignals };
}

function parseAxes(value: unknown): ParsedProgressionContract["expectedAxes"] {
  if (!isRecord(value)) {
    return { plot: false, info: false, character: false, world: false, causal: false };
  }
  return {
    plot: value.plot === true,
    info: value.info === true,
    character: value.character === true,
    world: value.world === true,
    causal: value.causal === true,
  };
}

function parseReviewSignals(
  value: unknown,
): ParsedProgressionContract["reviewSignals"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((entry) => ({
      dimension: stringValue(entry.dimension) ?? "unknown",
      reason: stringValue(entry.reason) ?? "",
    }));
}

function computeChronicGapAxes(contracts: ParsedProgressionContract[]): string[] {
  const axisNames: Array<keyof ParsedProgressionContract["expectedAxes"]> = [
    "plot",
    "info",
    "character",
    "world",
    "causal",
  ];
  const chronicAxes: string[] = [];
  for (const axis of axisNames) {
    // 从最新 contract 向前扫描，统计连续 expected=true 且 actual=false 的次数
    let consecutiveGaps = 0;
    for (let i = contracts.length - 1; i >= 0; i--) {
      const c = contracts[i];
      if (c.expectedAxes[axis] && !c.actualAxes[axis]) {
        consecutiveGaps++;
      } else {
        break;
      }
    }
    if (consecutiveGaps >= CHRONIC_GAP_THRESHOLD) {
      chronicAxes.push(axis);
    }
  }
  return chronicAxes;
}
