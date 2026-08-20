/**
 * 任务令牌签发：claim 结构与 novel-runtime 契约对齐。
 */
import { describe, expect, it } from 'vitest';
import { jwtVerify } from 'jose';
import { env } from '../src/config/env';
import { signTaskToken } from '../src/modules/jobs/task-token';

describe('signTaskToken', () => {
  it('签发 platform-api 风格 claim', async () => {
    const token = await signTaskToken({
      userId: 42,
      projectId: 7,
      jobId: 'job-token-1',
      maxCharge: 500n,
    });
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(env.NOVEL_TASK_TOKEN_HMAC_KEY),
      { issuer: 'platform-api', audience: 'novel-runtime' },
    );
    expect(payload.sub).toBe('42');
    expect(payload.project_id).toBe('7');
    expect(payload.job_id).toBe('job-token-1');
    expect(payload.max_charge).toBe(500);
    expect(payload.capabilities).toEqual(['novel.generate']);
    expect(typeof payload.nonce).toBe('string');
  });

  it('拒绝无法无损编码为 JWT number 的超大预占金额', async () => {
    await expect(signTaskToken({
      userId: 42,
      projectId: 7,
      jobId: 'job-token-too-large',
      maxCharge: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    })).rejects.toThrow(/safe integer|MAX_CHARGE/i);
  });
});
