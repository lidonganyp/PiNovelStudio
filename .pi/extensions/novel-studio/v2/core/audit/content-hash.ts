/**
 * CONTENT-HASH — 统一 SHA-256 内容哈希（Phase 0/4）
 *
 * 规则：
 * - 算法固定 SHA-256
 * - 文本按 UTF-8 编码
 * - 完整 hex 用于事件 inputHash/outputHash/contentHash
 * - 短前缀仅用于显示，不得当作审计主键
 */

import { createHash } from "node:crypto";

export const CONTENT_HASH_ALGORITHM = "sha256" as const;

/** 完整 SHA-256 hex（64 字符） */
export function computeContentHash(content: string | Buffer): string {
  const hash = createHash("sha256");
  if (typeof content === "string") {
    hash.update(content, "utf8");
  } else {
    hash.update(content);
  }
  return hash.digest("hex");
}

/** 稳定 JSON 哈希：键排序后序列化再 hash，避免对象键序漂移 */
export function computeStableJsonHash(value: unknown): string {
  return computeContentHash(stableStringify(value));
}

/** 短显示用前缀（默认 12 位）；不得替代完整 hash 做一致性证明 */
export function shortHash(fullHash: string, length = 12): string {
  if (!fullHash) return "";
  return fullHash.slice(0, length);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    out[k] = sortKeys(obj[k]);
  }
  return out;
}

/** 校验 hex 是否像完整 SHA-256 */
export function isFullSha256Hex(value: string | undefined | null): boolean {
  if (!value || typeof value !== "string") return false;
  return /^[a-f0-9]{64}$/i.test(value);
}
