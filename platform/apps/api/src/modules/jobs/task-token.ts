/**
 * 任务令牌签发：claim 结构与 novel-runtime verifyTaskToken 对齐。
 */
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { env } from '../../config/env';

const TASK_TOKEN_AUDIENCE = 'novel-runtime';
const TASK_TOKEN_ISSUER = 'platform-api';

/** 签发短期任务令牌（默认 5 分钟）。maxCharge 单位：分。 */
export async function signTaskToken(input: {
  userId: number;
  projectId: number;
  jobId: string;
  maxCharge: bigint;
  capabilities?: string[];
}): Promise<string> {
  if (input.maxCharge <= 0n || input.maxCharge > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('MAX_CHARGE must be a positive safe integer for JWT encoding');
  }
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    project_id: String(input.projectId),
    job_id: input.jobId,
    capabilities: input.capabilities ?? ['novel.generate'],
    max_charge: Number(input.maxCharge),
    nonce: randomUUID(),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(String(input.userId))
    .setIssuer(TASK_TOKEN_ISSUER)
    .setAudience(TASK_TOKEN_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(new TextEncoder().encode(env.NOVEL_TASK_TOKEN_HMAC_KEY));
}
