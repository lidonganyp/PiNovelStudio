/**
 * DIFF-UTILS — 文本差异计算工具（REASONING-REPAIR-BOUNDARY-1 Wave 2B / RRB-2.3）
 *
 * 为候选谱系提供最小文本差异计算与 hash 能力。
 * 仅用于候选间 diff artifact 的生成与校验，不替代 patch merger 或 model prompt。
 */

import { createHash } from "node:crypto";

// ============================================================================
// 类型
// ============================================================================

/** 单行 diff 操作 */
export interface DiffLine {
  type: "same" | "add" | "remove";
  text: string;
}

/** 结构化 diff 结果 */
export interface TextDiff {
  lines: DiffLine[];
  /** 变更统计 */
  stats: { added: number; removed: number; unchanged: number };
}

/** 摘要型 diff（用于 manifest 存储，不存完整 patch） */
export interface DiffSummary {
  hash: string;
  addedLines: number;
  removedLines: number;
  unchangedLines: number;
  totalLines: number;
}

// ============================================================================
// 行级 diff（简化 Myers 算法）
// ============================================================================

/**
 * 计算两个文本的行级差异（简化 LCS 回溯）。
 * 返回结构化 diff 行序列。
 */
export function computeLineDiff(parentText: string, childText: string): TextDiff {
  const parentLines = parentText.split("\n");
  const childLines = childText.split("\n");

  const lcs = longestCommonSubsequence(parentLines, childLines);
  const diff = buildDiffFromLCS(parentLines, childLines, lcs);

  const stats = {
    added: 0,
    removed: 0,
    unchanged: 0,
  };
  for (const line of diff) {
    if (line.type === "add") stats.added += 1;
    else if (line.type === "remove") stats.removed += 1;
    else stats.unchanged += 1;
  }

  return { lines: diff, stats };
}

// ============================================================================
// Hash
// ============================================================================

/** 计算 diff 的 SHA-256 hash（用于 manifest.diffHash）。 */
export function hashDiff(diff: TextDiff): string {
  const payload = diff.lines.map((l) => `${l.type}:${l.text}`).join("\n");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** 计算 diff 摘要（不存储完整 diff 行序列）。 */
export function summarizeDiff(diff: TextDiff): DiffSummary {
  return {
    hash: hashDiff(diff),
    addedLines: diff.stats.added,
    removedLines: diff.stats.removed,
    unchangedLines: diff.stats.unchanged,
    totalLines: diff.lines.length,
  };
}

// ============================================================================
// 序列化
// ============================================================================

/** 将 diff 序列化为 JSON 行（用于 diff artifact 文件）。 */
export function serializeDiff(diff: TextDiff): string {
  return JSON.stringify(diff.lines.map((l) => [l.type, l.text]));
}

/** 从 JSON 解析 diff。 */
export function deserializeDiff(serialized: string): DiffLine[] {
  const raw = JSON.parse(serialized) as Array<[string, string]>;
  return raw.map(([type, text]) => ({ type: type as DiffLine["type"], text }));
}

// ============================================================================
// 内部：LCS + 回溯
// ============================================================================

/**
 * 计算最长公共子序列（LCS）长度矩阵。
 * 使用 O(n*m) 动态规划；输入为行数组。
 */
function longestCommonSubsequence(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  // dp[i][j] = LCS length of a[0..i-1] and b[0..j-1]
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯构建 LCS
  const result: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]);
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return result;
}

/** 从 parent、child 和 LCS 构建 diff 行序列。 */
function buildDiffFromLCS(
  parent: string[],
  child: string[],
  lcs: string[],
): DiffLine[] {
  const result: DiffLine[] = [];
  let pi = 0;
  let ci = 0;
  let li = 0;

  while (pi < parent.length || ci < child.length) {
    if (li < lcs.length && pi < parent.length && parent[pi] === lcs[li] && ci < child.length && child[ci] === lcs[li]) {
      // 公共行
      result.push({ type: "same", text: parent[pi] });
      pi += 1;
      ci += 1;
      li += 1;
    } else if (li < lcs.length && pi < parent.length && parent[pi] === lcs[li]) {
      // parent 在公共行，child 不在 → 添加行
      result.push({ type: "add", text: child[ci] });
      ci += 1;
    } else if (li < lcs.length && ci < child.length && child[ci] === lcs[li]) {
      // child 在公共行，parent 不在 → 删除行
      result.push({ type: "remove", text: parent[pi] });
      pi += 1;
    } else if (pi < parent.length && ci < child.length) {
      // 都不在公共行 → 替换（先删后加）
      result.push({ type: "remove", text: parent[pi] });
      result.push({ type: "add", text: child[ci] });
      pi += 1;
      ci += 1;
    } else if (pi < parent.length) {
      result.push({ type: "remove", text: parent[pi] });
      pi += 1;
    } else {
      result.push({ type: "add", text: child[ci] });
      ci += 1;
    }
  }

  return result;
}