/**
 * 内部 API HMAC-SHA256：canonical =
 * `${timestamp}\\n${METHOD}\\n${path}\\n${sha256(body)}`。
 * 时间戳窗口 5 分钟，防重放。
 */
import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

/** 防重放窗口：5 分钟。 */
export const INTERNAL_HMAC_WINDOW_MS = 5 * 60 * 1000;

export interface InternalSignInput {
  secret: string;
  timestamp: string;
  method: string;
  path: string;
  body: string;
  nonce: string;
}

export type InternalVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'malformed' | 'expired' | 'mismatch' };

/** 对象键按字典序稳定序列化；null/undefined 视为空体。 */
export function stableStringify(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 计算请求 HMAC 签名（hex）。 */
export function signInternalRequest(input: InternalSignInput): string {
  const bodyHash = createHash('sha256')
    .update(input.body, 'utf8')
    .digest('hex');
  const canonical = `${input.timestamp}\n${input.nonce}\n${input.method.toUpperCase()}\n${input.path}\n${bodyHash}`;
  return createHmac('sha256', input.secret)
    .update(canonical, 'utf8')
    .digest('hex');
}

/** 校验签名与时间窗。 */
export function verifyInternalSignature(
  input: InternalSignInput & { signature: string; nowMs?: number },
): InternalVerifyResult {
  if (!/^\d+$/.test(input.timestamp) || !/^[A-Za-z0-9._~-]{16,128}$/.test(input.nonce) || !/^[0-9a-f]{64}$/i.test(input.signature)) {
    return { ok: false, reason: 'malformed' };
  }
  const timestampMs = Number(input.timestamp) * 1000;
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(timestampMs)) {
    return { ok: false, reason: 'malformed' };
  }
  if (Math.abs(nowMs - timestampMs) > INTERNAL_HMAC_WINDOW_MS) {
    return { ok: false, reason: 'expired' };
  }
  const expected = signInternalRequest(input);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(input.signature, 'hex');
  if (expectedBuf.length !== actualBuf.length) {
    return { ok: false, reason: 'mismatch' };
  }
  if (!timingSafeEqual(expectedBuf, actualBuf)) {
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true };
}
