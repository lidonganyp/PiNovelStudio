/**
 * NB-2：按书分区
 *
 * 核心原则（任务要求）：
 * - 同一本书不得跨集合（train / validation / test）
 * - 作者级泛化集必须隔离同一作者全部作品
 * - 分区确定性：相同输入 → 相同分区（sha256 哈希决定）
 *
 * 策略：
 * - 按 authorId 分组（无 authorId 按 bookId 独立成组）
 * - 每组用 sha256(groupKey) % 100 决定落入哪个集合
 * - 同作者全作品进同集合；同 bookId 永不跨集合
 *
 * 本模块为 eval-only，由 tsconfig.eval.json 编译到 dist-eval/，不进 dist/。
 */

import { createHash } from "node:crypto";
import type { PartitionResult } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// 公开 API
// ─────────────────────────────────────────────────────────────────────────────

export interface PartitionRatios {
  /** train 比例（0-1） */
  train: number;
  /** validation 比例（0-1） */
  validation: number;
  /** test 比例（0-1，= 1 - train - validation） */
  test: number;
}

/** 分区输入条目 */
export interface PartitionEntry {
  bookId: string;
  authorId?: string;
}

/**
 * 按书确定性分区。同作者全作品隔离进同集合，同 bookId 永不跨集合。
 *
 * @param entries 书籍条目（bookId + 可选 authorId）
 * @param ratios 分区比例（train + validation + test 应 = 1）
 * @returns PartitionResult（每集合的 bookId 数组）
 */
export function partitionByBook(
  entries: PartitionEntry[],
  ratios: PartitionRatios,
): PartitionResult {
  const trainBound = Math.round(ratios.train * 100);
  const valBound = trainBound + Math.round(ratios.validation * 100);

  // 按 groupKey（authorId 或 bookId）分组
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    const groupKey = entry.authorId ?? entry.bookId;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey)!.push(entry.bookId);
  }

  const result: PartitionResult = {
    train: [],
    validation: [],
    test: [],
  };

  // 按 groupKey 排序保证确定性输出顺序
  const sortedKeys = [...groups.keys()].sort();

  for (const groupKey of sortedKeys) {
    const bookIds = groups.get(groupKey)!;
    const bucket = hashToBucket(groupKey, trainBound, valBound);
    result[bucket].push(...bookIds);
  }

  // 每集合内排序保证确定性
  result.train.sort();
  result.validation.sort();
  result.test.sort();

  return result;
}

/** 判断 bookId 属于哪个集合 */
export function findSplit(
  partition: PartitionResult,
  bookId: string,
): "train" | "validation" | "test" | null {
  if (partition.train.includes(bookId)) return "train";
  if (partition.validation.includes(bookId)) return "validation";
  if (partition.test.includes(bookId)) return "test";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部实现
// ─────────────────────────────────────────────────────────────────────────────

/** sha256(groupKey) % 100 → 落入 [0,train)/[train,val)/[val,100) 区间 */
function hashToBucket(
  groupKey: string,
  trainBound: number,
  valBound: number,
): "train" | "validation" | "test" {
  const hash = createHash("sha256").update(groupKey, "utf-8").digest();
  // 取前 4 字节为 uint32
  const num = hash.readUInt32BE(0);
  const bucket = num % 100;

  if (bucket < trainBound) return "train";
  if (bucket < valBound) return "validation";
  return "test";
}
