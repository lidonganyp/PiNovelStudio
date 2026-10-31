/**
 * 内部 API HMAC 验签（runtime 侧）
 *
 * 与 platform-api `modules/internal/hmac.ts` 的 `verifyInternalSignature` 逐字节对齐：
 *   canonical = `${timestamp}\n${nonce}\n${METHOD.toUpperCase()}\n${path}\n${sha256hex(body)}`
 *   signature = HMAC-SHA256(secret, canonical) hex
 * 时间戳窗口 5 分钟，nonce 由调用方提供（runtime 侧不落库去重，窗口内防重放依赖
 * platform-api 的 nonce 表；runtime 只做签名与时间窗校验）。
 *
 * 本文件只复用 internal-hmac.ts 的 canonical 计算，不重复实现序列化规则。
 */

import { timingSafeEqual } from "node:crypto";
import { signInternalRequest, stableStringify } from "./internal-hmac.js";

/** 防重放窗口：5 分钟。 */
export const INTERNAL_HMAC_WINDOW_MS = 5 * 60 * 1000;

export interface InternalVerifyInput {
  secret: string;
  timestamp: string;
  method: string;
  /** 完整请求路径（含挂载前缀，例如 /internal/chapter-contract/approvals） */
  path: string;
  /** 已解析的请求体（内部用 stableStringify 规范化） */
  body: unknown;
  nonce: string;
  signature: string;
  nowMs?: number;
}

export type InternalVerifyResult =
  | { ok: true }
  | { ok: false; reason: "malformed" | "expired" | "mismatch" };

/** 校验内部请求签名与时间窗。 */
export function verifyInternalSignature(input: InternalVerifyInput): InternalVerifyResult {
  if (
    !/^\d+$/.test(input.timestamp) ||
    !/^[A-Za-z0-9._~-]{16,128}$/.test(input.nonce) ||
    !/^[0-9a-f]{64}$/i.test(input.signature)
  ) {
    return { ok: false, reason: "malformed" };
  }
  const timestampMs = Number(input.timestamp) * 1000;
  if (!Number.isFinite(timestampMs)) {
    return { ok: false, reason: "malformed" };
  }
  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs - timestampMs) > INTERNAL_HMAC_WINDOW_MS) {
    return { ok: false, reason: "expired" };
  }
  const expected = signInternalRequest({
    secret: input.secret,
    timestamp: input.timestamp,
    method: input.method,
    path: input.path,
    body: stableStringify(input.body),
    nonce: input.nonce,
  });
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(input.signature, "hex");
  if (expectedBuf.length !== actualBuf.length) {
    return { ok: false, reason: "mismatch" };
  }
  if (!timingSafeEqual(expectedBuf, actualBuf)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}
