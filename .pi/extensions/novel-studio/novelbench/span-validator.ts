/**
 * NB-3：Reference span 校验工具
 *
 * 核心原则（任务要求）：
 * - analyzer 输出必须引用 reference span，span 必须可回溯
 * - 本地校验 excerpt === referenceBody.slice(start, end)
 * - 校验失败的资产标 invalid_span，保留审计但不参与评价
 *
 * 本模块为 eval-only，由 tsconfig.eval.json 编译到 dist-eval/，不进 dist/。
 */

import type { TextSpan, AssetStatus, SpannedAssetBase } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// 公开 API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 校验 span 是否与 reference body 一致。
 *
 * 检查：
 * 1. start/end 是合法的非负整数
 * 2. start <= end
 * 3. end <= referenceBody.length
 * 4. excerpt === referenceBody.slice(start, end)
 *
 * @returns true 表示 span 完全匹配 reference body 的对应切片
 */
export function validateSpan(referenceBody: string, span: TextSpan): boolean {
  if (!span || typeof span.start !== "number" || typeof span.end !== "number") {
    return false;
  }
  if (!Number.isInteger(span.start) || !Number.isInteger(span.end)) {
    return false;
  }
  if (span.start < 0 || span.end < span.start) {
    return false;
  }
  if (span.end > referenceBody.length) {
    return false;
  }
  if (typeof span.excerpt !== "string") {
    return false;
  }
  return referenceBody.slice(span.start, span.end) === span.excerpt;
}

/**
 * 对资产数组执行 span 校验，把校验失败的标 invalid_span。
 *
 * 已是 unknown/conflict 状态的资产不降级为 invalid_span（保留原状态）。
 * 只把 extracted 状态但 span 校验失败的资产降级。
 *
 * @returns 新数组（不改原数组），invalid_span 资产的 status 改为 "invalid_span"
 */
export function markInvalidSpans<T extends SpannedAssetBase>(
  assets: readonly T[],
  referenceBody: string,
): T[] {
  return assets.map((asset) => {
    if (asset.status !== "extracted") {
      return asset;
    }
    if (validateSpan(referenceBody, asset.span)) {
      return asset;
    }
    return { ...asset, status: "invalid_span" as AssetStatus };
  });
}

/**
 * 对单个资产执行 span 校验（用于非数组资产，如 endingFunction）。
 *
 * 已是 unknown/conflict 状态的资产不降级。
 */
export function markInvalidSpan<T extends SpannedAssetBase>(
  asset: T,
  referenceBody: string,
): T {
  if (asset.status !== "extracted") {
    return asset;
  }
  if (validateSpan(referenceBody, asset.span)) {
    return asset;
  }
  return { ...asset, status: "invalid_span" as AssetStatus };
}

/**
 * 统计资产数组中各 status 的数量。
 */
export function countByStatus<T extends SpannedAssetBase>(
  assets: readonly T[],
): { extracted: number; unknown: number; conflict: number; invalid_span: number } {
  const counts = { extracted: 0, unknown: 0, conflict: 0, invalid_span: 0 };
  for (const a of assets) {
    counts[a.status]++;
  }
  return counts;
}
