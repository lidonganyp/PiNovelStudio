/**
 * 跨系统契约测试：platform-api jobs 模块签发结构 → Novel Runtime 验证
 *
 * 背景：platform-api（NestJS）jobs 模块为每个生成任务签发短期任务令牌，
 * claim 结构为 snake_case 自定义字段 + 标准 JWT claim（sub/iss/aud/iat/exp）：
 *   sub=<userId> / iss=platform-api / aud=novel-runtime / iat / exp
 *   project_id / job_id / capabilities / max_charge（分，整数）/ nonce
 *
 * 本测试用 jose 构造与 platform-api 签发逻辑**完全相同 claim 结构**的令牌
 * （含字符串 aud、数值 iat/exp、snake_case 自定义 claim），交给 verifyTaskToken 验证，
 * 从而在 runtime 侧可执行地证明：platform-api 将要签发的令牌结构能被 Novel Runtime 接受。
 *
 * 这守护的是「两端的 claim 契约一致性」这一最容易出错的接缝；
 * platform-api 侧的对应测试在 apps/api 侧（jobs 模块签发测试）。
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import {
  verifyTaskToken,
  resetNonceStoreForTest,
} from "../src/task-token.js";
import { makeConfigForTest } from "../src/config.js";

describe("跨系统契约：platform-api claim 结构 → verifyTaskToken", () => {
  const config = makeConfigForTest();

  beforeEach(() => {
    resetNonceStoreForTest();
  });

  /**
   * 模拟 platform-api jobs 模块的签发：
   *   sub/iss/aud/iat/exp + project_id/job_id/capabilities/max_charge/nonce
   * 其中 aud 为字符串、iat/exp 为 Unix 数值、max_charge 为分（整数）。
   */
  async function signPlatformApiStyleToken(
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const base = {
      sub: "42",
      iss: "platform-api",
      aud: "novel-runtime",
      iat: now,
      exp: now + 300,
      project_id: "proj-1",
      job_id: "job-1",
      capabilities: ["novel.generate"],
      max_charge: 500, // 分（D5 决策：全程整数运算）
      nonce: `platform-${now}-${Math.random().toString(36).slice(2)}`,
      ...overrides,
    };
    // 构造载荷：仅含自定义 claim（标准 claim 由 setXxx 注入，与 NestJS jwtService.signAsync 行为等价）
    const { sub, iss, aud, iat, exp, ...custom } = base;
    void sub; void iss; void aud; void iat; void exp;
    const token = await new SignJWT(custom)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(String(base.sub))
      .setIssuer(String(base.iss))
      .setAudience(String(base.aud))
      .setIssuedAt(Number(base.iat))
      .setExpirationTime(Number(base.exp));
    return token.sign(new TextEncoder().encode(config.novelTaskTokenHmacKey));
  }

  test("platform-api 风格令牌（字符串 aud、分整数 max_charge）被接受", async () => {
    const token = await signPlatformApiStyleToken();
    const verified = await verifyTaskToken(token, config, "novel.generate");
    assert.equal(verified.payload.userId, "42");
    assert.equal(verified.payload.projectId, "proj-1");
    assert.equal(verified.payload.jobId, "job-1");
    assert.deepEqual(verified.payload.capabilities, ["novel.generate"]);
    assert.equal(verified.payload.maxCharge, 500);
    assert.ok(verified.payload.nonce.length > 0);
  });

  test("缺少 capabilities 被拒绝", async () => {
    const token = await signPlatformApiStyleToken({ capabilities: undefined });
    await assert.rejects(
      () => verifyTaskToken(token, config, "novel.generate"),
      (err: unknown) => {
        assert.match((err as Error).message, /INVALID_TOKEN|MISSING_CAPABILITY/);
        return true;
      },
    );
  });

  test("max_charge <= 0 被拒绝", async () => {
    const token = await signPlatformApiStyleToken({ max_charge: 0 });
    await assert.rejects(
      () => verifyTaskToken(token, config, "novel.generate"),
      /MAX_CHARGE_EXCEEDED/,
    );
  });

  test("缺少所需 capability 被拒绝（403）", async () => {
    const token = await signPlatformApiStyleToken({ capabilities: ["novel.access"] });
    await assert.rejects(
      () => verifyTaskToken(token, config, "novel.generate"),
      (err: unknown) => {
        assert.match((err as Error).message, /MISSING_CAPABILITY/);
        return true;
      },
    );
  });

  test("过期令牌被拒绝", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signPlatformApiStyleToken({ iat: now - 600, exp: now - 300 });
    await assert.rejects(
      () => verifyTaskToken(token, config, "novel.generate"),
      /EXPIRED/,
    );
  });

  test("nonce 重放被拒绝", async () => {
    const token = await signPlatformApiStyleToken({ nonce: "fixed-nonce-1" });
    const first = await verifyTaskToken(token, config, "novel.generate");
    assert.equal(first.payload.jobId, "job-1");
    // 同一令牌（同 nonce）二次使用 → 重放拒绝
    await assert.rejects(
      () => verifyTaskToken(token, config, "novel.generate"),
      /REPLAYED/,
    );
  });

  test("错误 issuer（旧 sub2api-backend）被拒绝", async () => {
    // 旧签发方的令牌不再有效——版本收敛：只保留 platform-api 一套签发
    const token = await signPlatformApiStyleToken({ iss: "sub2api-backend" });
    await assert.rejects(
      () => verifyTaskToken(token, config, "novel.generate"),
      /INVALID_TOKEN/,
    );
  });
});
