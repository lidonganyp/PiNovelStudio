/**
 * 计费客户端测试（platform 版，契约对齐 platform-api internal.controller）
 *
 * 验证：
 * - settle 正常：POST /internal/billing/settlements，请求体 stableStringify（键字典序），
 *   携带 x-internal-timestamp / x-internal-signature HMAC 头
 * - settle 响应金额为「分」的字符串形式，解析为整数分
 * - settle 幂等命中：alreadySettled=true（200），不抛错
 * - 402 预占耗尽：返回 budgetExhausted=true，不抛错；403 鉴权拒绝必须抛错
 * - 5xx 自动重试，重试耗尽抛 SETTLE_FAILED
 * - 4xx（非 402）不重试，直接抛 SETTLE_FAILED
 * - 非法 JSON 响应抛 INVALID_RESPONSE
 * - finalize：POST /internal/billing/holds/:jobId/finalize {outcome}，返回 hold 状态
 * - PLATFORM_API_BASE_URL 缺失：fail closed 抛错
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher, type MockClient } from "undici";
import { createBillingClient, BillingClientError } from "../src/billing-client.js";
import { makeConfigForTest } from "../src/config.js";

describe("platform 计费客户端", () => {
  const config = makeConfigForTest({
    platformApiBaseUrl: "http://platform-api.local",
  });
  let mockAgent: MockAgent;
  let mockClient: MockClient;
  let previousDispatcher: unknown;

  const baseReq = {
    jobId: "job-1",
    callId: "call-1",
    internalStage: "agentic_raw",
    model: "v2_rawstage2_gemini31",
    tokensIn: 1000,
    tokensOut: 500,
  };

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    previousDispatcher = (globalThis as unknown as { __prevDispatcher?: unknown }).__prevDispatcher;
    setGlobalDispatcher(mockAgent);
    mockClient = mockAgent.get("http://platform-api.local");
  });

  afterEach(() => {
    mockAgent.assertNoPendingInterceptors();
  });

  test("settle 正常：HMAC 头 + stableStringify body + 分金额解析", async () => {
    mockClient
      .intercept({
        method: "POST",
        path: "/internal/billing/settlements",
      })
      .reply(200, {
        jobId: "job-1",
        callId: "call-1",
        alreadySettled: false,
        actualCharge: "123",
        settledAmount: "123",
        remainingBudget: "877",
      })
      .times(1);

    const client = createBillingClient(config, { maxRetries: 0, timeoutMs: 2000 });
    const resp = await client.settle(baseReq);

    assert.equal(resp.jobId, "job-1");
    assert.equal(resp.callId, "call-1");
    assert.equal(resp.alreadySettled, false);
    assert.equal(resp.actualChargeFen, 123);
    assert.equal(resp.settledAmountFen, 123);
    assert.equal(resp.remainingBudgetFen, 877);
    assert.equal(resp.budgetExhausted, false);
  });

  test("settle 请求头包含 x-internal-timestamp / x-internal-signature", async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";
    mockClient
      .intercept({
        method: "POST",
        path: "/internal/billing/settlements",
      })
      .reply((options) => {
        capturedHeaders = options.headers as Record<string, string>;
        capturedBody = typeof options.body === "string" ? options.body : String(options.body);
        return {
          statusCode: 200,
          data: {
            jobId: "job-1",
            callId: "call-1",
            alreadySettled: false,
            actualCharge: "0",
            settledAmount: "0",
            remainingBudget: "1000",
          },
        };
      })
      .times(1);

    const client = createBillingClient(config, { maxRetries: 0, timeoutMs: 2000 });
    await client.settle(baseReq);

    // HMAC 头存在且格式合法（时间戳数字 + 64 位 hex 签名）
    const ts = capturedHeaders["x-internal-timestamp"];
    const sig = capturedHeaders["x-internal-signature"];
    assert.ok(ts && /^\d+$/.test(ts), `timestamp header invalid: ${ts}`);
    assert.ok(sig && /^[0-9a-f]{64}$/.test(sig), `signature header invalid: ${sig}`);

    // body 为 stableStringify 输出：键按字典序（callId < internalStage < jobId < model < tokensIn < tokensOut）
    assert.equal(
      capturedBody,
      '{"callId":"call-1","internalStage":"agentic_raw","jobId":"job-1","model":"v2_rawstage2_gemini31","tokensIn":1000,"tokensOut":500}',
    );
  });

  test("settle 幂等命中：alreadySettled=true 不抛错", async () => {
    mockClient
      .intercept({ method: "POST", path: "/internal/billing/settlements" })
      .reply(200, {
        jobId: "job-1",
        callId: "call-1",
        alreadySettled: true,
        actualCharge: "0",
        settledAmount: "123",
        remainingBudget: "877",
      })
      .times(1);

    const client = createBillingClient(config, { maxRetries: 0, timeoutMs: 2000 });
    const resp = await client.settle(baseReq);
    assert.equal(resp.alreadySettled, true);
    assert.equal(resp.actualChargeFen, 0);
    assert.equal(resp.budgetExhausted, false);
  });

  test("settle 响应必须绑定当前 jobId/callId", async () => {
    mockClient
      .intercept({ method: "POST", path: "/internal/billing/settlements" })
      .reply(200, {
        jobId: "other-job",
        callId: "other-call",
        alreadySettled: false,
        actualCharge: "123",
        settledAmount: "123",
        remainingBudget: "877",
      })
      .times(1);

    const client = createBillingClient(config, { maxRetries: 0, timeoutMs: 2000 });
    await assert.rejects(
      () => client.settle(baseReq),
      (err: unknown) => err instanceof BillingClientError && err.code === "INVALID_RESPONSE",
    );
  });

  test("settle 402 预占耗尽：budgetExhausted=true，不抛错", async () => {
    mockClient
      .intercept({ method: "POST", path: "/internal/billing/settlements" })
      .reply(402, { message: "hold budget exhausted", reason: "reserved_budget_exhausted" })
      .times(1);

    const client = createBillingClient(config, { maxRetries: 0, timeoutMs: 2000 });
    const resp = await client.settle(baseReq);
    assert.equal(resp.budgetExhausted, true);
    assert.equal(resp.alreadySettled, false);
  });

  test("settle 403 鉴权拒绝：不得伪装成预算耗尽", async () => {
    mockClient
      .intercept({ method: "POST", path: "/internal/billing/settlements" })
      .reply(403, { message: "forbidden", reason: "internal_authorization_failed" })
      .times(1);

    const client = createBillingClient(config, { maxRetries: 0, timeoutMs: 2000 });
    await assert.rejects(
      () => client.settle(baseReq),
      (err: unknown) => {
        assert.ok(err instanceof BillingClientError);
        assert.equal(err.code, "SETTLE_FAILED");
        assert.equal(err.statusCode, 403);
        return true;
      },
    );
  });

  test("settle 5xx 重试耗尽抛 SETTLE_FAILED", async () => {
    mockClient
      .intercept({ method: "POST", path: "/internal/billing/settlements" })
      .reply(500, { message: "boom" })
      .times(3); // maxRetries=2 → 共 3 次尝试

    const client = createBillingClient(config, { maxRetries: 2, timeoutMs: 2000 });
    await assert.rejects(
      () => client.settle(baseReq),
      (err: unknown) => {
        assert.ok(err instanceof BillingClientError);
        assert.equal(err.code, "SETTLE_FAILED");
        assert.equal(err.statusCode, 500);
        return true;
      },
    );
  });

  test("settle 4xx（非 402）不重试直接抛", async () => {
    mockClient
      .intercept({ method: "POST", path: "/internal/billing/settlements" })
      .reply(400, { message: "bad dto" })
      .times(1);

    const client = createBillingClient(config, { maxRetries: 2, timeoutMs: 2000 });
    await assert.rejects(
      () => client.settle(baseReq),
      (err: unknown) => {
        assert.ok(err instanceof BillingClientError);
        assert.equal(err.code, "SETTLE_FAILED");
        return true;
      },
    );
  });

  test("settle 非 JSON 响应抛 INVALID_RESPONSE", async () => {
    mockClient
      .intercept({ method: "POST", path: "/internal/billing/settlements" })
      .reply(200, "not-json")
      .times(1);

    const client = createBillingClient(config, { maxRetries: 0, timeoutMs: 2000 });
    await assert.rejects(
      () => client.settle(baseReq),
      (err: unknown) => {
        assert.ok(err instanceof BillingClientError);
        assert.equal(err.code, "INVALID_RESPONSE");
        return true;
      },
    );
  });

  test("settle JSON 顶层不是对象时抛 INVALID_RESPONSE", async () => {
    mockClient
      .intercept({ method: "POST", path: "/internal/billing/settlements" })
      .reply(200, "null")
      .times(1);

    const client = createBillingClient(config, { maxRetries: 0, timeoutMs: 2000 });
    await assert.rejects(
      () => client.settle(baseReq),
      (err: unknown) => err instanceof BillingClientError && err.code === "INVALID_RESPONSE",
    );
  });

  test("settle 金额字段不是纯十进制整数时抛 INVALID_RESPONSE", async () => {
    mockClient
      .intercept({ method: "POST", path: "/internal/billing/settlements" })
      .reply(200, {
        jobId: "job-1",
        callId: "call-1",
        alreadySettled: false,
        actualCharge: "123oops",
        settledAmount: "123",
        remainingBudget: "877",
      })
      .times(1);

    const client = createBillingClient(config, { maxRetries: 0, timeoutMs: 2000 });
    await assert.rejects(
      () => client.settle(baseReq),
      (err: unknown) => err instanceof BillingClientError && err.code === "INVALID_RESPONSE",
    );
  });

  test("settle 金额字段超过安全整数范围时抛 INVALID_RESPONSE", async () => {
    mockClient
      .intercept({ method: "POST", path: "/internal/billing/settlements" })
      .reply(200, {
        jobId: "job-1",
        callId: "call-1",
        alreadySettled: false,
        actualCharge: "9007199254740992",
        settledAmount: "123",
        remainingBudget: "877",
      })
      .times(1);

    const client = createBillingClient(config, { maxRetries: 0, timeoutMs: 2000 });
    await assert.rejects(
      () => client.settle(baseReq),
      (err: unknown) => err instanceof BillingClientError && err.code === "INVALID_RESPONSE",
    );
  });

  test("finalize 正常：outcome=success 返回 hold 状态", async () => {
    mockClient
      .intercept({
        method: "POST",
        path: "/internal/billing/holds/job-1/finalize",
      })
      .reply(200, {
        jobId: "job-1",
        userId: 42,
        amount: "1000",
        settledAmount: "123",
        status: "settled",
        alreadyExisted: false,
        alreadyFinalized: false,
      })
      .times(1);

    const client = createBillingClient(config, { maxRetries: 0, timeoutMs: 2000 });
    const result = await client.finalize("job-1", "success");
    assert.equal(result.jobId, "job-1");
    assert.equal(result.userId, 42);
    assert.equal(result.amountFen, 1000);
    assert.equal(result.settledAmountFen, 123);
    assert.equal(result.status, "settled");
    assert.equal(result.alreadyFinalized, false);
  });

  test("finalize 幂等：alreadyFinalized=true 正常返回", async () => {
    mockClient
      .intercept({
        method: "POST",
        path: "/internal/billing/holds/job-1/finalize",
      })
      .reply(200, {
        jobId: "job-1",
        userId: 42,
        amount: "1000",
        settledAmount: "123",
        status: "settled",
        alreadyExisted: true,
        alreadyFinalized: true,
      })
      .times(1);

    const client = createBillingClient(config, { maxRetries: 0, timeoutMs: 2000 });
    const result = await client.finalize("job-1", "failure");
    assert.equal(result.alreadyFinalized, true);
    assert.equal(result.status, "settled");
  });

  test("finalize 响应必须绑定请求 jobId", async () => {
    mockClient
      .intercept({
        method: "POST",
        path: "/internal/billing/holds/job-1/finalize",
      })
      .reply(200, {
        jobId: "other-job",
        userId: 42,
        amount: "1000",
        settledAmount: "123",
        status: "released",
        alreadyFinalized: false,
      })
      .times(1);

    const client = createBillingClient(config, { maxRetries: 0, timeoutMs: 2000 });
    await assert.rejects(
      () => client.finalize("job-1", "failure"),
      (err: unknown) => err instanceof BillingClientError && err.code === "INVALID_RESPONSE",
    );
  });

  test("finalize 5xx 抛 FINALIZE_FAILED", async () => {
    mockClient
      .intercept({
        method: "POST",
        path: "/internal/billing/holds/job-1/finalize",
      })
      .reply(503, { message: "db down" })
      .times(3);

    const client = createBillingClient(config, { maxRetries: 2, timeoutMs: 2000 });
    await assert.rejects(
      () => client.finalize("job-1", "success"),
      (err: unknown) => {
        assert.ok(err instanceof BillingClientError);
        assert.equal(err.code, "FINALIZE_FAILED");
        return true;
      },
    );
  });

  test("PLATFORM_API_BASE_URL 缺失：fail closed", () => {
    assert.throws(
      () => createBillingClient(makeConfigForTest({ platformApiBaseUrl: "" })),
      (err: unknown) => {
        assert.ok(err instanceof BillingClientError);
        assert.equal(err.code, "SETTLE_FAILED");
        return true;
      },
    );
  });

  test('transport admission rejection is terminal and never retries as a provider outage', async () => {
    mockClient.intercept({method:'POST',path:'/internal/billing/transports/reserve'}).reply(409,{message:'budget exhausted'}).times(1);
    const client=createBillingClient(config,{maxRetries:2,timeoutMs:2000});
    await assert.rejects(()=>client.reserveTransport!({jobId:'job-1',callId:'denied',route:'v2_amplified_gemini31',model:'fixture',requestHash:'a'.repeat(64),inputTokenLimit:10,outputTokenLimit:10}),
      (err: unknown)=>err instanceof BillingClientError&&err.code==='BUDGET_EXHAUSTED');
  });
});
