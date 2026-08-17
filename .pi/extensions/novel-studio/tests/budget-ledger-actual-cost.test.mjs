/**
 * BUDGET-LEDGER actual cost（BG 下一阶段第 1 项）
 *
 * 真实 provider usage + 版本化价格表 + actualCost / overage。
 * 不改动已通过的 4 个基础 reserve/settle 场景；本文件只验收货币结算。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBudgetLedger,
  reserveBudget,
  settleBudget,
} from "../dist/v2/core/budget-ledger.js";
import {
  CURRENT_UNIT_PRICE_SCHEDULE_VERSION,
  computeActualCost,
  recomputeActualCost,
} from "../dist/v2/core/unit-price-schedule.js";

const GEMINI_TOKENS = { inputTokens: 120_000, outputTokens: 40_000 };

test("版本化价格表：同用量换版本可重算且结果不同", () => {
  const current = computeActualCost({
    provider: "gemini31",
    ...GEMINI_TOKENS,
  });
  assert.equal(current.unitPriceScheduleVersion, CURRENT_UNIT_PRICE_SCHEDULE_VERSION);
  assert.ok(current.actualCost > 0, "当前价格表必须给出正成本");

  const older = recomputeActualCost({
    provider: "gemini31",
    ...GEMINI_TOKENS,
    unitPriceScheduleVersion: "ups-2026-07-01",
  });
  assert.equal(older.unitPriceScheduleVersion, "ups-2026-07-01");
  assert.ok(older.actualCost > 0);
  assert.notEqual(
    current.actualCost,
    older.actualCost,
    "价格变化后重算必须得到不同 actualCost，证明版本可解释",
  );
});

test("settle 按 provider usage + 账本价格版本计算 actualCost，禁止调用方 cost:0 覆盖", () => {
  const expected = computeActualCost({
    provider: "gemini31",
    inputTokens: 1200,
    outputTokens: 800,
  });
  const ledger = createBudgetLedger();
  const reserved = reserveBudget(ledger, {
    stage: "agenticDraft",
    modelCalls: 1,
    provider: "gemini31",
  });
  assert.equal(reserved.ok, true);

  const settled = settleBudget(reserved.ledger, reserved.reservationId, {
    modelCalls: 1,
    inputTokens: 1200,
    outputTokens: 800,
    latencyMs: 1200,
    cost: 0,
    failed: false,
    provider: "gemini31",
  });

  assert.ok(settled.usage.totalCost > 0, "真实 token 结算后 totalCost 不得为 0");
  assert.equal(settled.usage.totalCost, expected.actualCost);
  assert.equal(settled.costSnapshots.length, 1);
  const snap = settled.costSnapshots[0];
  assert.equal(snap.actualCost, expected.actualCost);
  assert.equal(snap.unitPriceScheduleVersion, CURRENT_UNIT_PRICE_SCHEDULE_VERSION);
  assert.equal(snap.overage, 0);
  assert.equal(snap.provider, "gemini31");
  assert.equal(snap.cost, expected.actualCost);
});

test("超过 maxProviderCost 时记录 overage，后续 reserve 按费用阻断", () => {
  const expected = computeActualCost({
    provider: "claude",
    inputTokens: 200_000,
    outputTokens: 80_000,
  });
  assert.ok(expected.actualCost > 0.01, "测试用量必须超过紧缩后的费用上限");

  const ledger = createBudgetLedger({
    hardBudget: { maxProviderCost: 0.01 },
  });
  const reserved = reserveBudget(ledger, {
    stage: "styleOptimization",
    modelCalls: 1,
    provider: "claude",
  });
  assert.equal(reserved.ok, true);

  const settled = settleBudget(reserved.ledger, reserved.reservationId, {
    modelCalls: 1,
    inputTokens: 200_000,
    outputTokens: 80_000,
    latencyMs: 4000,
    provider: "claude",
    failed: false,
  });
  assert.equal(settled.usage.totalCost, expected.actualCost);
  assert.ok(settled.costSnapshots[0].overage > 0, "超支必须记录 overage");
  assert.equal(
    settled.costSnapshots[0].overage,
    Number((expected.actualCost - 0.01).toFixed(10)),
  );

  const next = reserveBudget(settled, {
    stage: "finalFactRecheck",
    modelCalls: 1,
    provider: "claude",
  });
  assert.equal(next.ok, false);
  assert.equal(next.reason, "hard_provider_cost_exceeded");
  assert.equal(Object.keys(next.ledger.reservations).length, 0);
});

test("tokenUsage unknown 时 actualCost=0，但仍记录价格表版本以便事后解释", () => {
  const ledger = createBudgetLedger();
  const reserved = reserveBudget(ledger, { stage: "agenticDraft", modelCalls: 1 });
  const settled = settleBudget(reserved.ledger, reserved.reservationId, {
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 800,
    failed: true,
    provider: "gemini31",
  });
  assert.equal(settled.usage.totalCost, 0);
  assert.equal(settled.costSnapshots[0].actualCost, 0);
  assert.equal(
    settled.costSnapshots[0].unitPriceScheduleVersion,
    CURRENT_UNIT_PRICE_SCHEDULE_VERSION,
  );
  assert.equal(settled.costSnapshots[0].overage, 0);
});
