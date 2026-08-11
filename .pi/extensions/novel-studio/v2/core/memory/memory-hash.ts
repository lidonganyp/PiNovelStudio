/**
 * MEMORY-HASH-1 — 共享正文 hash 工具（SHA-256 前 12 位十六进制）。
 *
 * 与 final-state-commit.computeFinalTextHash 保持一致，供 memory 子模块使用，
 * 避免 memory 子模块与 final-state-commit 产生双向运行时依赖。
 */

import { createHash } from "node:crypto";

export function computeSha12(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}
