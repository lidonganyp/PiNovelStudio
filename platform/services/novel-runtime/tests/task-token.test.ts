/**
 * 任务令牌验证测试（plan §2 T2-2）
 *
 * 验证：
 * - 正常签发与验证
 * - 过期拒绝
 * - 重放拒绝
 * - 缺失 capability 拒绝
 * - maxCharge <= 0 拒绝
 * - 篡改签名拒绝
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  verifyTaskToken,
  signTaskTokenForTest,
  resetNonceStoreForTest,
  resetVolatileNonceStateForTest,
  TaskTokenError,
} from "../src/task-token.js";
import { makeConfigForTest } from "../src/config.js";

describe("T2-2 短期任务令牌", () => {
  const config = makeConfigForTest();

  beforeEach(() => {
    resetNonceStoreForTest();
  });

  test("正常签发与验证", async () => {
    const token = await signTaskTokenForTest(config, {
      userId: "user-1",
      projectId: "proj-1",
      jobId: "job-1",
      capabilities: ["novel.generate"],
      maxCharge: 10.0,
    });
    const verified = await verifyTaskToken(token, config, "novel.generate");
    assert.equal(verified.payload.userId, "user-1");
    assert.equal(verified.payload.projectId, "proj-1");
    assert.equal(verified.payload.jobId, "job-1");
    assert.deepEqual(verified.payload.capabilities, ["novel.generate"]);
    assert.equal(verified.payload.maxCharge, 10.0);
    assert.ok(verified.payload.nonce.length > 0);
  });

  test("过期拒绝", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signTaskTokenForTest(config, {
      userId: "user-2",
      projectId: "proj-2",
      jobId: "job-2",
      capabilities: ["novel.generate"],
      maxCharge: 5.0,
      issuedAt: now - 600,
      expiresAt: now - 100, // 已过期
    });
    await assert.rejects(
      verifyTaskToken(token, config, "novel.generate"),
      (err: unknown) => {
        assert.ok(err instanceof TaskTokenError);
        assert.equal(err.code, "EXPIRED");
        return true;
      },
    );
  });

  test("重放拒绝（同一 nonce 二次使用）", async () => {
    const token = await signTaskTokenForTest(config, {
      userId: "user-3",
      projectId: "proj-3",
      jobId: "job-3",
      capabilities: ["novel.generate"],
      maxCharge: 5.0,
      nonce: "fixed-nonce-1",
    });
    // 第一次成功
    await verifyTaskToken(token, config, "novel.generate");
    // 第二次重放拒绝
    await assert.rejects(
      verifyTaskToken(token, config, "novel.generate"),
      (err: unknown) => {
        assert.ok(err instanceof TaskTokenError);
        assert.equal(err.code, "REPLAYED");
        return true;
      },
    );
  });

  test("runtime restart cannot make a consumed token reusable", async () => {
    const token = await signTaskTokenForTest(config, {
      userId: "user-restart",
      projectId: "proj-restart",
      jobId: "job-restart",
      capabilities: ["novel.generate"],
      maxCharge: 5,
      nonce: "restart-persistent-nonce",
    });
    await verifyTaskToken(token, config, "novel.generate");
    resetVolatileNonceStateForTest();

    await assert.rejects(
      verifyTaskToken(token, config, "novel.generate"),
      (err: unknown) => {
        assert.ok(err instanceof TaskTokenError);
        assert.equal(err.code, "REPLAYED");
        return true;
      },
    );
  });

  test("same job and nonce cannot be reused with a different expiry", async () => {
    const first = await signTaskTokenForTest(config, {
      userId: "user-expiry-variant",
      projectId: "proj-expiry-variant",
      jobId: "job-expiry-variant",
      capabilities: ["novel.generate"],
      maxCharge: 5,
      nonce: "same-nonce",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    });
    const second = await signTaskTokenForTest(config, {
      userId: "user-expiry-variant",
      projectId: "proj-expiry-variant",
      jobId: "job-expiry-variant",
      capabilities: ["novel.generate"],
      maxCharge: 5,
      nonce: "same-nonce",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
    await verifyTaskToken(first, config, "novel.generate");
    await assert.rejects(
      verifyTaskToken(second, config, "novel.generate"),
      (err: unknown) => {
        assert.ok(err instanceof TaskTokenError);
        assert.equal(err.code, "REPLAYED");
        return true;
      },
    );
  });

  test("缺失 capability 拒绝", async () => {
    const token = await signTaskTokenForTest(config, {
      userId: "user-4",
      projectId: "proj-4",
      jobId: "job-4",
      capabilities: ["novel.access"], // 没有 novel.generate
      maxCharge: 5.0,
    });
    await assert.rejects(
      verifyTaskToken(token, config, "novel.generate"),
      (err: unknown) => {
        assert.ok(err instanceof TaskTokenError);
        assert.equal(err.code, "MISSING_CAPABILITY");
        assert.equal(err.statusCode, 403);
        return true;
      },
    );
  });

  test("maxCharge <= 0 拒绝", async () => {
    const token = await signTaskTokenForTest(config, {
      userId: "user-5",
      projectId: "proj-5",
      jobId: "job-5",
      capabilities: ["novel.generate"],
      maxCharge: 0,
    });
    await assert.rejects(
      verifyTaskToken(token, config, "novel.generate"),
      (err: unknown) => {
        assert.ok(err instanceof TaskTokenError);
        assert.equal(err.code, "MAX_CHARGE_EXCEEDED");
        return true;
      },
    );
  });

  test("non-integer maxCharge is rejected before any runtime work starts", async () => {
    const token = await signTaskTokenForTest(config, {
      userId: "user-fractional-charge",
      projectId: "proj-fractional-charge",
      jobId: "job-fractional-charge",
      capabilities: ["novel.generate"],
      maxCharge: 0.5,
    });
    await assert.rejects(
      verifyTaskToken(token, config, "novel.generate"),
      (err: unknown) => {
        assert.ok(err instanceof TaskTokenError);
        assert.equal(err.code, "MAX_CHARGE_EXCEEDED");
        return true;
      },
    );
  });

  test("篡改签名拒绝", async () => {
    const token = await signTaskTokenForTest(config, {
      userId: "user-6",
      projectId: "proj-6",
      jobId: "job-6",
      capabilities: ["novel.generate"],
      maxCharge: 5.0,
    });
    // 篡改签名最后 5 个字符
    const tampered = token.slice(0, -5) + "XXXXX";
    await assert.rejects(
      verifyTaskToken(tampered, config, "novel.generate"),
      (err: unknown) => {
        assert.ok(err instanceof TaskTokenError);
        assert.equal(err.code, "INVALID_TOKEN");
        return true;
      },
    );
  });

  test("不同 HMAC 密钥拒绝", async () => {
    const token = await signTaskTokenForTest(config, {
      userId: "user-7",
      projectId: "proj-7",
      jobId: "job-7",
      capabilities: ["novel.generate"],
      maxCharge: 5.0,
    });
    const wrongKeyConfig = makeConfigForTest({ novelTaskTokenHmacKey: "wrong-key" });
    await assert.rejects(
      verifyTaskToken(token, wrongKeyConfig, "novel.generate"),
      (err: unknown) => {
        assert.ok(err instanceof TaskTokenError);
        assert.equal(err.code, "INVALID_TOKEN");
        return true;
      },
    );
  });

  test("capability 映射：不同工具需要不同 capability", async () => {
    const token = await signTaskTokenForTest(config, {
      userId: "user-8",
      projectId: "proj-8",
      jobId: "job-8",
      capabilities: ["novel.feedback"], // 只有 feedback
      maxCharge: 5.0,
    });
    // feedback capability 通过
    const ok = await verifyTaskToken(token, config, "novel.feedback");
    assert.equal(ok.payload.userId, "user-8");
  });
});
