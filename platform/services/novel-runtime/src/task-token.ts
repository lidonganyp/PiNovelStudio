/**
 * 短期任务令牌验证（R3 改造：签发方由 sub2api-backend 换为 platform-api）
 *
 * platform-api（jobs 模块）为每个生成任务签发短期内部令牌，包含：
 * userId / projectId / jobId / capabilities / maxCharge / issuedAt / expiresAt / nonce
 *
 * 要求：
 * - 使用 HMAC-SHA256 签名（与 platform-api 共享密钥 NOVEL_TASK_TOKEN_HMAC_KEY）
 * - Novel Runtime 不相信浏览器传入的用户身份
 * - 用户 ID、项目归属和余额只能由 platform-api 确定
 * - 令牌不能被用于通用模型调用（capabilities 限定）
 * - 过期、重放和篡改请求必须拒绝
 * - maxCharge 单位为分（整数，D5 决策：全程整数运算）
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jwtVerify, errors as joseErrors, type JWTPayload, SignJWT } from "jose";
import type { NovelRuntimeConfig } from "./config.js";

/** 任务令牌载荷 */
export interface TaskTokenPayload {
  /** 用户 ID（由 platform-api 确定） */
  userId: string;
  /** 项目 ID */
  projectId: string;
  /** 任务 ID */
  jobId: string;
  /** 允许的能力（如 ["novel.generate"]） */
  capabilities: string[];
  /** 最大消费上限（分，整数） */
  maxCharge: number;
  /** 签发时间（Unix 秒） */
  issuedAt: number;
  /** 过期时间（Unix 秒） */
  expiresAt: number;
  /** 防重放 nonce */
  nonce: string;
}

/** 任务令牌验证结果 */
export interface VerifiedTaskToken {
  payload: TaskTokenPayload;
  /** 原始令牌字符串（透传给 LLM 客户端） */
  rawToken: string;
}

/** 持久化 nonce 消费记录，避免 runtime 重启或多实例后令牌重放。 */
let claimedNonceFiles = new Set<string>();
let claimCount = 0;

function nonceFilePath(config: NovelRuntimeConfig, jobId: string, nonce: string): string {
  const digest = createHash("sha256").update(`${jobId}:${nonce}`).digest("hex");
  return join(config.tempWorkspaceRoot, ".task-token-nonces", `${digest}.claim`);
}

function pruneExpiredNonceFiles(directory: string, now: number): void {
  if (++claimCount % 100 !== 0 || !existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".claim")) continue;
    try {
      const expiresAt = Number(readFileSync(join(directory, name), "utf8"));
      if (Number.isSafeInteger(expiresAt) && expiresAt <= now) unlinkSync(join(directory, name));
    } catch { /* concurrent cleanup or a partial file is harmless */ }
  }
}

function claimNonce(config: NovelRuntimeConfig, jobId: string, nonce: string, expiresAt: number): void {
  const directory = join(config.tempWorkspaceRoot, ".task-token-nonces");
  mkdirSync(directory, { recursive: true });
  pruneExpiredNonceFiles(directory, Math.floor(Date.now() / 1000));
  const filePath = nonceFilePath(config, jobId, nonce);
  try {
    const fd = openSync(filePath, "wx");
    try { writeFileSync(fd, String(expiresAt), "utf8"); } finally { closeSync(fd); }
    claimedNonceFiles.add(filePath);
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === "EEXIST") {
      throw new TaskTokenError(
        `REPLAYED: nonce ${nonce} for job ${jobId} already used`,
        "REPLAYED",
      );
    }
    throw new TaskTokenError(
      "REPLAY_STORE_UNAVAILABLE: cannot persist task-token consumption",
      "REPLAY_STORE_UNAVAILABLE",
      503,
    );
  }
}

export class TaskTokenError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_TOKEN"
      | "EXPIRED"
      | "REPLAYED"
      | "MISSING_CAPABILITY"
      | "MAX_CHARGE_EXCEEDED"
      | "REPLAY_STORE_UNAVAILABLE",
    public readonly statusCode: number = 401,
  ) {
    super(message);
    this.name = "TaskTokenError";
  }
}

const TASK_TOKEN_AUDIENCE = "novel-runtime";
const TASK_TOKEN_ISSUER = "platform-api";

function joseKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * 验证任务令牌。
 * - 校验 HMAC 签名
 * - 校验过期
 * - 校验 nonce 未被使用（防重放）
 * - 校验 capabilities 包含所需能力
 * - 校验 maxCharge > 0
 */
export async function verifyTaskToken(
  rawToken: string,
  config: NovelRuntimeConfig,
  requiredCapability: string,
): Promise<VerifiedTaskToken> {
  let payload: JWTPayload;
  try {
    const { payload: verified } = await jwtVerify(
      rawToken,
      joseKey(config.novelTaskTokenHmacKey),
      {
        algorithms: ["HS256"],
        issuer: TASK_TOKEN_ISSUER,
        audience: TASK_TOKEN_AUDIENCE,
      },
    );
    payload = verified;
  } catch (err: unknown) {
    // jose 在 token 有 exp claim 且已过期时抛 errors.JWTExpired；区分该错误码以便上层精确响应
    if (err instanceof joseErrors.JWTExpired) {
      throw new TaskTokenError(
        `EXPIRED: token has expired (${err.message})`,
        "EXPIRED",
      );
    }
    throw new TaskTokenError(
      `INVALID_TOKEN: ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_TOKEN",
    );
  }

  // 校验必需字段
  const userId = payload.sub;
  const projectId = payload["project_id"] as string | undefined;
  const jobId = payload["job_id"] as string | undefined;
  const capabilities = payload["capabilities"] as string[] | undefined;
  const maxCharge = payload["max_charge"] as number | undefined;
  const nonce = payload["nonce"] as string | undefined;
  const issuedAt = payload.iat;
  const expiresAt = payload.exp;

  if (!userId || !projectId || !jobId || !capabilities || !nonce) {
    throw new TaskTokenError(
      "INVALID_TOKEN: missing required claims (sub/project_id/job_id/capabilities/nonce)",
      "INVALID_TOKEN",
    );
  }
  if (typeof maxCharge !== "number" || !Number.isSafeInteger(maxCharge) || maxCharge <= 0) {
    throw new TaskTokenError(
      `MAX_CHARGE_EXCEEDED: maxCharge must be positive, got ${maxCharge}`,
      "MAX_CHARGE_EXCEEDED",
    );
  }
  const validatedMaxCharge = maxCharge;
  if (!Array.isArray(capabilities) || !capabilities.includes(requiredCapability)) {
    throw new TaskTokenError(
      `MISSING_CAPABILITY: token lacks required capability '${requiredCapability}'. ` +
        `Token capabilities: ${capabilities.join(", ")}`,
      "MISSING_CAPABILITY",
      403,
    );
  }
  if (expiresAt === undefined || expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new TaskTokenError(
      `EXPIRED: token expired at ${expiresAt}`,
      "EXPIRED",
    );
  }
  if (issuedAt === undefined) {
    throw new TaskTokenError(
      "INVALID_TOKEN: missing iat claim",
      "INVALID_TOKEN",
    );
  }

  claimNonce(config, jobId, nonce, expiresAt);

  return {
    rawToken,
    payload: {
      userId,
      projectId,
      jobId,
      capabilities,
      maxCharge: validatedMaxCharge,
      issuedAt: issuedAt,
      expiresAt: expiresAt,
      nonce,
    },
  };
}

/**
 * 仅供测试用：构造一个签名的任务令牌。
 * 生产环境令牌由 platform-api（jobs 模块）签发，novel-runtime 只验证。
 */
export async function signTaskTokenForTest(
  config: NovelRuntimeConfig,
  payload: Omit<TaskTokenPayload, "issuedAt" | "expiresAt" | "nonce"> & {
    issuedAt?: number;
    expiresAt?: number;
    nonce?: string;
  },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const iat = payload.issuedAt ?? now;
  const exp = payload.expiresAt ?? now + 300; // 默认 5 分钟
  const nonce = payload.nonce ?? `test-${now}-${Math.random().toString(36).slice(2)}`;

  return await new SignJWT({
    project_id: payload.projectId,
    job_id: payload.jobId,
    capabilities: payload.capabilities,
    max_charge: payload.maxCharge,
    nonce,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(payload.userId)
    .setIssuer(TASK_TOKEN_ISSUER)
    .setAudience(TASK_TOKEN_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(joseKey(config.novelTaskTokenHmacKey));
}

/** 仅供测试用：清空 nonce 集合 */
export function resetNonceStoreForTest(): void {
  for (const filePath of claimedNonceFiles) {
    try { unlinkSync(filePath); } catch { /* already removed */ }
  }
  claimedNonceFiles = new Set<string>();
  claimCount = 0;
}

/** Simulates a process restart without deleting the durable claim records. */
export function resetVolatileNonceStateForTest(): void {
  // The production implementation has no volatile replay state anymore.
}
