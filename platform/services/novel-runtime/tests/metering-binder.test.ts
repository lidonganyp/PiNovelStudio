/**
 * 计费绑定器测试（platform 版）
 *
 * 验证 createMeteringBinder.invokeWithMetering 的核心契约：
 *   1. 正常调用：PiNovelStudio 返回 modelCalls，binder 逐条 settle（token 上报制），
 *      返回 metering 摘要（金额为分，来自 platform-api 权威响应）
 *   2. 请求字段：model = requestedRoute ?? route；internalStage 由 route 前缀映射
 *   3. tokenUsage="unknown"：按 0 token 上报但仍然 settle
 *   4. alreadySettled=true：计入 alreadySettledCount，金额不重复累计（actualChargeFen=0）
 *   5. budgetExhausted=true：中止后续 settle（P0-7）
 *   6. settle 抛错：记录到 settleErrors，不阻断交付（result 仍然返回）
 *   7. PiNovelStudio 未上报 modelCalls：返回空 metering
 *   8. tool.invoke 抛错：错误向上传播（无法结算）
 *   9. callId 幂等性：相同 (jobId, ts, idx) 生成相同 callId
 */

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createMeteringBinder } from "../src/metering-binder.js";
import type { BillingClient, BillingSettleRequest, BillingSettleResponse } from "../src/billing-client.js";

// 工具：构造假的 BillingClient，可控 settle 行为
function makeFakeBillingClient(opts: {
  response?: Partial<BillingSettleResponse>;
  throwOnCallIndex?: number; // 在第 N 次 settle 调用抛错
  responses?: Partial<BillingSettleResponse>[]; // 多次调用按序返回不同响应
}): { client: BillingClient; settleMock: ReturnType<typeof mock.fn> } {
  let callCount = 0;
  const settle = async (req: BillingSettleRequest): Promise<BillingSettleResponse> => {
    callCount++;
    if (opts.throwOnCallIndex !== undefined && callCount === opts.throwOnCallIndex) {
      throw new Error("simulated settle failure");
    }
    const resp = opts.responses?.[callCount - 1] ?? opts.response ?? {};
    return {
      jobId: resp.jobId ?? req.jobId,
      callId: resp.callId ?? req.callId,
      alreadySettled: resp.alreadySettled ?? false,
      actualChargeFen: resp.actualChargeFen ?? 50,
      settledAmountFen: resp.settledAmountFen ?? 50 * callCount,
      remainingBudgetFen: resp.remainingBudgetFen ?? 950,
      budgetExhausted: resp.budgetExhausted ?? false,
    };
  };
  const settleMock = mock.fn(settle);
  return {
    client: { settle: settleMock as unknown as BillingClient["settle"] },
    settleMock,
  };
}

// 工具：构造一个 PiNovelStudio 风格的工具返回结果
function makePiNovelResult(modelCalls: Array<{
  route: string;
  kind?: string;
  ts: number;
  durationMs?: number;
  tokenUsage?: { in: number; out: number } | "unknown";
  failed?: boolean;
  provider?: string;
  requestedRoute?: string;
}>) {
  return {
    status: "ok",
    text: "章节内容",
    stageResults: {
      modelCalls: modelCalls.map((c) => ({
        route: c.route,
        kind: c.kind ?? "generation",
        ts: c.ts,
        durationMs: c.durationMs ?? 1000,
        tokenUsage: c.tokenUsage ?? { in: 100, out: 50 },
        failed: c.failed ?? false,
        provider: c.provider ?? "gemini",
        requestedRoute: c.requestedRoute,
      })),
    },
  };
}

describe("platform metering-binder", () => {
  const jobCtx = { jobId: "job-1", userId: "42", projectId: "proj-1" };

  test("正常调用：单次 modelCall，settle 成功，返回 metering 摘要", async () => {
    const { client, settleMock } = makeFakeBillingClient({
      response: { actualChargeFen: 50, settledAmountFen: 50, remainingBudgetFen: 950 },
    });
    const binder = createMeteringBinder({ billingClient: client });

    const tool = {
      name: "novel_generate_chapter",
      invoke: async () => makePiNovelResult([
        { route: "v2_rawstage2_gemini31", ts: 1700000000000, provider: "gemini" },
      ]),
    };

    const { result, metering } = await binder.invokeWithMetering(tool, {}, jobCtx);

    assert.equal(metering.modelCallCount, 1);
    assert.equal(metering.settledCount, 1);
    assert.equal(metering.alreadySettledCount, 0);
    assert.equal(metering.totalSettledAmountFen, 50);
    assert.equal(metering.remainingBudgetFen, 950);
    assert.equal(metering.budgetExhausted, false);
    assert.equal(metering.settleErrors.length, 0);
    assert.equal(settleMock.mock.callCount(), 1);

    // 请求字段：token 上报制（无金额字段），model = requestedRoute ?? route
    const req = settleMock.mock.calls[0].arguments[0] as BillingSettleRequest;
    assert.equal(req.jobId, "job-1");
    assert.equal(req.internalStage, "agentic_raw");
    assert.equal(req.model, "v2_rawstage2_gemini31");
    assert.equal(req.tokensIn, 100);
    assert.equal(req.tokensOut, 50);
    // 请求体不含金额（权威金额由 platform-api 计算）
    assert.equal("actualCharge" in req, false);
    // result 原样返回
    assert.deepEqual((result as { status: string }).status, "ok");
  });

  test("多次 modelCall：按 ts 排序逐条 settle，累计 totalSettledAmountFen", async () => {
    const { client, settleMock } = makeFakeBillingClient({
      responses: [
        { actualChargeFen: 30, remainingBudgetFen: 970 },
        { actualChargeFen: 70, remainingBudgetFen: 900 },
      ],
    });
    const binder = createMeteringBinder({ billingClient: client });

    const tool = {
      name: "novel_generate_chapter",
      invoke: async () => makePiNovelResult([
        { route: "v2_amplified_gemini31", ts: 1700000002000 }, // 后发生
        { route: "v2_rawstage2_gemini31", ts: 1700000001000 }, // 先发生
      ]),
    };

    const { metering } = await binder.invokeWithMetering(tool, {}, jobCtx);

    assert.equal(metering.modelCallCount, 2);
    assert.equal(metering.settledCount, 2);
    assert.equal(metering.totalSettledAmountFen, 100);
    assert.equal(metering.remainingBudgetFen, 900);

    // ts 序：第一次 settle 是较早的调用
    const firstReq = settleMock.mock.calls[0].arguments[0] as BillingSettleRequest;
    const secondReq = settleMock.mock.calls[1].arguments[0] as BillingSettleRequest;
    assert.equal(firstReq.internalStage, "agentic_raw");
    assert.equal(secondReq.internalStage, "style_optimizer");

    // callId 幂等：{jobId}-{ts}-{idx}
    assert.equal(firstReq.callId, "job-1-1700000001000-0");
    assert.equal(secondReq.callId, "job-1-1700000002000-1");
  });

  test('tokenUsage="unknown"：按 0 token 上报但仍然 settle', async () => {
    const { client, settleMock } = makeFakeBillingClient({});
    const binder = createMeteringBinder({ billingClient: client });

    const tool = {
      name: "novel_generate_chapter",
      invoke: async () => makePiNovelResult([
        { route: "v2_rawstage2_gemini31", ts: 1700000000000, tokenUsage: "unknown" },
      ]),
    };

    const { metering } = await binder.invokeWithMetering(tool, {}, jobCtx);
    assert.equal(metering.settledCount, 1);
    const req = settleMock.mock.calls[0].arguments[0] as BillingSettleRequest;
    assert.equal(req.tokensIn, 0);
    assert.equal(req.tokensOut, 0);
  });

  test("alreadySettled=true：计入幂等命中，actualChargeFen=0 不重复累计", async () => {
    const { client } = makeFakeBillingClient({
      response: { alreadySettled: true, actualChargeFen: 0, settledAmountFen: 50 },
    });
    const binder = createMeteringBinder({ billingClient: client });

    const tool = {
      name: "novel_generate_chapter",
      invoke: async () => makePiNovelResult([
        { route: "v2_rawstage2_gemini31", ts: 1700000000000 },
      ]),
    };

    const { metering } = await binder.invokeWithMetering(tool, {}, jobCtx);
    assert.equal(metering.settledCount, 1);
    assert.equal(metering.alreadySettledCount, 1);
    assert.equal(metering.totalSettledAmountFen, 0);
  });

  test("budgetExhausted=true：拒绝成功交付并中止后续 settle（P0-7）", async () => {
    const { client, settleMock } = makeFakeBillingClient({
      responses: [
        { actualChargeFen: 50, remainingBudgetFen: 0, budgetExhausted: true },
        { actualChargeFen: 30 }, // 不应被调用
      ],
    });
    const binder = createMeteringBinder({ billingClient: client });

    const tool = {
      name: "novel_generate_chapter",
      invoke: async () => makePiNovelResult([
        { route: "v2_rawstage2_gemini31", ts: 1700000001000 },
        { route: "v2_amplified_gemini31", ts: 1700000002000 },
        { route: "v2_amplified_gemini31", ts: 1700000003000 },
      ]),
    };

    await assert.rejects(
      () => binder.invokeWithMetering(tool, {}, jobCtx),
      /billing budget exhausted/,
    );
    // 中止：只 settle 了第一次
    assert.equal(settleMock.mock.callCount(), 1);
  });

  test("settle 抛错：拒绝成功交付并保留已完成的结算", async () => {
    const { client, settleMock } = makeFakeBillingClient({
      throwOnCallIndex: 1,
      response: { actualChargeFen: 30 },
    });
    const binder = createMeteringBinder({ billingClient: client });

    const tool = {
      name: "novel_generate_chapter",
      invoke: async () => makePiNovelResult([
        { route: "v2_rawstage2_gemini31", ts: 1700000001000 },
        { route: "v2_amplified_gemini31", ts: 1700000002000 },
      ]),
    };

    await assert.rejects(
      () => binder.invokeWithMetering(tool, {}, jobCtx),
      /billing settlement failed/,
    );

    // 第一次抛错被记录，第二次继续 settle，最终拒绝成功交付
    assert.equal(settleMock.mock.callCount(), 2);
  });

  test("PiNovelStudio 未上报 modelCalls：返回空 metering", async () => {
    const { client, settleMock } = makeFakeBillingClient({});
    const binder = createMeteringBinder({ billingClient: client });

    const tool = {
      name: "novel_strategy_policy_view",
      invoke: async () => ({ status: "ok", stageResults: {} }),
    };

    const { metering } = await binder.invokeWithMetering(tool, {}, jobCtx);
    assert.equal(metering.modelCallCount, 0);
    assert.equal(settleMock.mock.callCount(), 0);
  });

  test("tool.invoke 抛错：错误向上传播（无法结算）", async () => {
    const { client, settleMock } = makeFakeBillingClient({});
    const binder = createMeteringBinder({ billingClient: client });

    const tool = {
      name: "novel_generate_chapter",
      invoke: async () => {
        throw new Error("unified pipeline blocked");
      },
    };

    await assert.rejects(
      () => binder.invokeWithMetering(tool, {}, jobCtx),
      /unified pipeline blocked/,
    );
    assert.equal(settleMock.mock.callCount(), 0);
  });

  test("requestedRoute 优先作为 model 键", async () => {
    const { client, settleMock } = makeFakeBillingClient({});
    const binder = createMeteringBinder({ billingClient: client });

    const tool = {
      name: "novel_generate_chapter",
      invoke: async () => makePiNovelResult([
        {
          route: "v2_rawstage2_gemini31",
          requestedRoute: "gemini_writer_v2",
          ts: 1700000000000,
        },
      ]),
    };

    await binder.invokeWithMetering(tool, {}, jobCtx);
    const req = settleMock.mock.calls[0].arguments[0] as BillingSettleRequest;
    assert.equal(req.model, "gemini_writer_v2");
  });

  test("callId 幂等性：相同 (jobId, ts, idx) 生成相同 callId", async () => {
    const { client, settleMock } = makeFakeBillingClient({});
    const binder = createMeteringBinder({ billingClient: client });

    const tool = {
      name: "novel_generate_chapter",
      invoke: async () => makePiNovelResult([
        { route: "v2_rawstage2_gemini31", ts: 1700000000000 },
      ]),
    };

    await binder.invokeWithMetering(tool, {}, jobCtx);
    await binder.invokeWithMetering(tool, {}, jobCtx);

    const req1 = settleMock.mock.calls[0].arguments[0] as BillingSettleRequest;
    const req2 = settleMock.mock.calls[1].arguments[0] as BillingSettleRequest;
    assert.equal(req1.callId, req2.callId);
  });

  test("novel_generate_chapter rejects an otherwise deliverable result without modelCalls", async () => {
    const { client, settleMock } = makeFakeBillingClient({});
    const binder = createMeteringBinder({ billingClient: client });

    const tool = {
      name: "novel_generate_chapter",
      invoke: async () => ({ status: "ok", text: "chapter", stageResults: {} }),
    };

    await assert.rejects(
      () => binder.invokeWithMetering(tool, {}, jobCtx),
      /modelCalls.*missing|metering.*chapter/i,
    );
    assert.equal(settleMock.mock.callCount(), 0);
  });
});
