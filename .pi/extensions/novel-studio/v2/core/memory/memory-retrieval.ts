/**
 * MEMORY-6 权威感知检索层（MEMORY-RETRIEVAL-1）
 *
 * 目标（任务文档 §十）：
 * - ContextCompiler 和叙事检索工具消费新的权威等级
 * - 默认优先返回 confirmed、author-declared 和 final-text evidence
 * - planned/hypothesis 默认不可作为事实证据
 * - 支持摘要结果继续回源
 * - 增加检索预算（maxItems / charLimit），防止加载完整历史正文
 *
 * 本模块纯函数、无副作用。输入为 MemoryRecord 数组 + 当前时间 + 预算。
 */

import type { MemoryRecord } from "./memory-record.js";
import { isFormalFactEvidence } from "./memory-record.js";
import { shouldDefaultRetrieve, tierForMemory } from "./memory-lifecycle.js";

// ============================================================================
// 权威排序权重（越高越优先）
// ============================================================================

const AUTHORITY_WEIGHT: Record<string, number> = {
  author_declaration: 100,
  final_text_explicit: 90,
  committed_state: 80,
  system_derived: 50,
  model_planned: 0,
  diagnostic_hypothesis: 0,
};

const EPISTEMIC_WEIGHT: Record<string, number> = {
  confirmed: 100,
  declared: 90,
  derived: 60,
  superseded: 10,
  planned: 0,
  hypothesis: 0,
  disputed: 0,
};

export interface MemoryRankItem {
  record: MemoryRecord;
  rankScore: number;
  usableAsFact: boolean;
  tier: string;
}

/**
 * 检索预算控制（§十"增加检索预算，防止加载完整历史正文"）。
 * 按权威/认识权重排序，取预算内条目；planned/hypothesis 默认排除。
 */
export function rankMemoryRecords(
  records: MemoryRecord[],
  now: number,
  budget: { maxItems: number; maxChars: number }
): { ranked: MemoryRankItem[]; excluded: Array<{ memoryId: string; reason: string }> } {
  const eligible: MemoryRankItem[] = [];
  const excluded: Array<{ memoryId: string; reason: string }> = [];

  for (const record of records) {
    // 默认检索过滤：过期/归档/冲突不参与
    if (!shouldDefaultRetrieve(record, now)) {
      excluded.push({
        memoryId: record.memoryId,
        reason: `lifecycleStatus=${record.lifecycleStatus} 或 tier=${tierForMemory(record, now)} 不参与默认检索`,
      });
      continue;
    }
    const factEvidence = isFormalFactEvidence(record);
    if (!factEvidence.usable) {
      excluded.push({ memoryId: record.memoryId, reason: factEvidence.reason ?? "非正式事实" });
      continue;
    }
    const score =
      (AUTHORITY_WEIGHT[record.authorityClass] ?? 0) +
      (EPISTEMIC_WEIGHT[record.epistemicStatus] ?? 0) +
      (record.confidence ?? 0) * 10;
    eligible.push({ record, rankScore: score, usableAsFact: true, tier: tierForMemory(record, now) });
  }

  eligible.sort((a, b) => b.rankScore - a.rankScore);

  // 应用 maxItems 预算
  const items = eligible.slice(0, Math.max(0, budget.maxItems));

  // 应用 maxChars 预算（按条目 payload 长度，从最高分开始累计）
  let charBudget = Math.max(0, budget.maxChars);
  const charBudgeted: MemoryRankItem[] = [];
  for (const item of items) {
    if (charBudget <= 0) break;
    const len = payloadCharLength(item.record);
    if (len > charBudget) continue; // 单条超预算：跳过，不阻断后续高分条目
    charBudgeted.push(item);
    charBudget -= len;
  }

  return { ranked: charBudgeted, excluded };
}

/** 估计 payload 的字符长度（用于预算控制） */
export function payloadCharLength(record: MemoryRecord): number {
  const data = record.payload.data as Record<string, unknown> | undefined;
  if (!data) return 0;
  let total = 0;
  for (const value of Object.values(data)) {
    if (typeof value === "string") total += value.length;
    else if (Array.isArray(value)) {
      for (const v of value) if (typeof v === "string") total += v.length;
    }
  }
  return total;
}

/**
 * 轻量检索结果（第一层，§十第一层）。
 * 只返回结构化事实/摘要 + 元数据，不加载完整原文。
 */
export interface LightweightMemoryResult {
  memoryId: string;
  memoryType: string;
  authorityClass: string;
  epistemicStatus: string;
  lifecycleStatus: string;
  sourceRef: string[];
  textHash: string[];
  confidence: number | null;
  hasConflict: boolean;
  /** 可继续追踪的 memoryId（用于回源） */
  traceable: boolean;
  /** 摘要/结构化值（轻量） */
  summary: string;
  payload: unknown;
}

/**
 * 把已排序的检索结果降级为轻量结果（第一层）。
 * 保证不加载完整历史正文，只返回元数据 + 轻量摘要。
 */
export function toLightweightResults(items: MemoryRankItem[]): LightweightMemoryResult[] {
  return items.map(({ record, usableAsFact }) => ({
    memoryId: record.memoryId,
    memoryType: record.memoryType,
    authorityClass: record.authorityClass,
    epistemicStatus: record.epistemicStatus,
    lifecycleStatus: record.lifecycleStatus,
    sourceRef: [...record.sourceRef],
    textHash: [...record.textHash],
    confidence: record.confidence,
    hasConflict: record.lifecycleStatus === "conflicted",
    traceable: usableAsFact && record.sourceRef.length > 0,
    summary: summaryOf(record),
    payload: record.payload.data,
  }));
}

function summaryOf(record: MemoryRecord): string {
  const data = record.payload.data as Record<string, unknown> | undefined;
  if (!data) return "";
  const value = data.value as string | undefined;
  if (value) return value;
  const description = data.description as string | undefined;
  if (description) return description;
  const content = data.content as string | undefined;
  if (content) return content;
  return "";
}

/**
 * 检索时把 conflict 状态明确标识（§十验收：冲突状态被明确标识，模型不能静默选边）。
 */
export function annotateConflicts(
  results: LightweightMemoryResult[],
  conflictingMemoryIds: Set<string>
): LightweightMemoryResult[] {
  return results.map((r) =>
    conflictingMemoryIds.has(r.memoryId)
      ? { ...r, hasConflict: true, lifecycleStatus: "conflicted" }
      : r
  );
}