/**
 * 内部 API HMAC-SHA256 签名与 5 分钟防重放窗口单测。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  INTERNAL_HMAC_WINDOW_MS,
  signInternalRequest,
  stableStringify,
  verifyInternalSignature,
} from '../src/modules/internal/hmac';

const SECRET = 'test-internal-api-secret-0123456789ab';

describe('stableStringify', () => {
  it('对象键按字典序稳定序列化', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('空体序列化为空串', () => {
    expect(stableStringify(undefined)).toBe('');
    expect(stableStringify(null)).toBe('');
  });
});

describe('verifyInternalSignature', () => {
  it('正确签名通过', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = '{"jobId":"j1","amount":100}';
    const nonce = 'nonce-test-00000001';
    const signature = signInternalRequest({
      secret: SECRET,
      timestamp,
      method: 'POST',
      path: '/internal/billing/holds',
      body,
      nonce,
    });
    const result = verifyInternalSignature({
      secret: SECRET,
      timestamp,
      method: 'POST',
      path: '/internal/billing/holds',
      body,
      nonce,
      signature,
    });
    expect(result).toEqual({ ok: true });
  });

  it('错误密钥拒绝', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'nonce-test-00000002';
    const signature = signInternalRequest({
      secret: SECRET,
      timestamp,
      method: 'POST',
      path: '/internal/billing/holds',
      body: '',
      nonce,
    });
    const result = verifyInternalSignature({
      secret: 'wrong-secret-must-not-verify-hmac-xx',
      timestamp,
      method: 'POST',
      path: '/internal/billing/holds',
      body: '',
      nonce,
      signature,
    });
    expect(result).toMatchObject({ ok: false, reason: 'mismatch' });
  });

  it('超过 5 分钟窗口的时间戳拒绝', () => {
    const stale = String(
      Math.floor((Date.now() - INTERNAL_HMAC_WINDOW_MS - 1000) / 1000),
    );
    const nonce = 'nonce-test-00000003';
    const signature = signInternalRequest({
      secret: SECRET,
      timestamp: stale,
      method: 'GET',
      path: '/internal/models/credentials',
      body: '',
      nonce,
    });
    const result = verifyInternalSignature({
      secret: SECRET,
      timestamp: stale,
      method: 'GET',
      path: '/internal/models/credentials',
      body: '',
      nonce,
      signature,
    });
    expect(result).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('签名正文是 body 的 sha256，不是明文拼接', () => {
    const timestamp = '1710000000';
    const body = '{"a":1}';
    const nonce = 'nonce-test-00000004';
    const signature = signInternalRequest({
      secret: SECRET,
      timestamp,
      method: 'POST',
      path: '/internal/billing/settlements',
      body,
      nonce,
    });
    const digest = createHash('sha256').update(body, 'utf8').digest('hex');
    expect(signature).not.toContain(body);
    expect(
      verifyInternalSignature({
        secret: SECRET,
        timestamp,
        method: 'POST',
        path: '/internal/billing/settlements',
        body,
        nonce,
        signature,
        nowMs: Number(timestamp) * 1000,
      }),
    ).toEqual({ ok: true });
    expect(digest).toHaveLength(64);
  });
});
