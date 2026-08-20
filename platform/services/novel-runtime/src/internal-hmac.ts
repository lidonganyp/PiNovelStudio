/**
 * 内部 API HMAC-SHA256 签名（platform-api /internal/* 调用方侧实现）
 *
 * ⚠️ 对齐义务：本文件是 `platform/apps/api/src/modules/internal/hmac.ts`（HmacGuard 验签）
 * 的算法镜像，两侧必须逐字节一致，不得单独修改：
 *   canonical = `${timestamp}\n${nonce}\n${METHOD.toUpperCase()}\n${path}\n${sha256hex(body)}`
 *   signature = HMAC-SHA256(secret, canonical) hex
 * 验签侧（HmacGuard）对 parsed body 重新 stableStringify，因此本侧签名与 HTTP body
 * 均统一使用 stableStringify 序列化结果。
 * 时间戳窗口 5 分钟，防重放。
 */

import { createHash, createHmac, randomUUID } from "node:crypto";

/** 对象键按字典序稳定序列化；null/undefined 视为空体。与 platform-api 侧逐字节一致。 */
export function stableStringify(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 计算内部请求 HMAC 签名（hex）。 */
export function signInternalRequest(input: {
  secret: string;
  timestamp: string;
  method: string;
  path: string;
  body: string;
  nonce: string;
}): string {
  const bodyHash = createHash("sha256").update(input.body, "utf8").digest("hex");
  const canonical = `${input.timestamp}\n${input.nonce}\n${input.method.toUpperCase()}\n${input.path}\n${bodyHash}`;
  return createHmac("sha256", input.secret).update(canonical, "utf8").digest("hex");
}

/** 构造 platform-api internal 请求头（x-internal-timestamp / x-internal-signature）。 */
export function internalAuthHeaders(params: {
  secret: string;
  method: string;
  path: string;
  body: string;
  nowMs?: number;
}): Record<string, string> {
  const timestamp = String(Math.floor((params.nowMs ?? Date.now()) / 1000));
  const nonce = randomUUID();
  const signature = signInternalRequest({
    secret: params.secret,
    timestamp,
    method: params.method,
    path: params.path,
    body: params.body,
    nonce,
  });
  return {
    "x-internal-timestamp": timestamp,
    "x-internal-nonce": nonce,
    "x-internal-signature": signature,
  };
}
