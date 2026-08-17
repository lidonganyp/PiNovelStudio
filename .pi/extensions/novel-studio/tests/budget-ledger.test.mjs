/**
 * BUDGET-LEDGER tests（BG-01 统一预算账本）
 *
 * 覆盖 4 个最小验收场景：
 * 1. normal call：reserve → settle 成功，无双计数
 * 2. failure settlement：失败调用同样 settle，failedCalls 计数
 * 3. over-budget：硬上限拒绝，不发起模型调用
 * 4. concurrent reservation：并发 reserve 原子性（无超发、不突变输入账本）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBudgetLedger,
  reserveBudget,
  settleBudget,
  getBudgetLedger,
} from "../dist/v2/core/budget-ledger.js";

test("normal call：reserve → settle 成功结算且无双计数", () => {
  const ledger = createBudgetLedger();
  const reserved = reserveBudget(ledger, {
    stage: "agenticDraft",
    budgetType: "normal",
    modelCalls: 1,
  });
  assert.equal(reserved.ok, true);
  assert.ok(reserved.reservationId, "reserve 必须返回 reservationId 供 settle 使用");
  // reserve 预扣后剩余 = max - 1
  assert.equal(reserved.snapshot.remainingModelCalls, ledger.hardBudget.maxModelCalls - 1);

  const settled = settleBudget(reserved.ledger, reserved.reservationId, {
    modelCalls: 1,
    inputTokens: 1200,
    outputTokens: 800,
    latencyMs: 3500,
    cost: 0.01,
    failed: false,
  });
  // 预扣转实际：1 次调用只计 1 次（reserve 预扣 + settle 差额调整，不得双计数）
  assert.equal(settled.usage.totalModelCalls, 1);
  assert.equal(settled.usage.totalTokensInput, 1200);
  assert.equal(settled.usage.totalTokensOutput, 800);
  assert.equal(settled.usage.totalLatencyMs, 3500);
  assert.equal(settled.usage.totalCost, 0.01);
  assert.equal(settled.usage.failedCalls, 0);
  // 结算后预约清空，决策两条（created + settled），成本快照一条
  assert.equal(Object.keys(settled.reservations).length, 0);
  assert.equal(settled.decisions.length, 2);
  assert.equal(settled.costSnapshots.length, 1);
  assert.equal(settled.costSnapshots[0].stage, "agenticDraft");
});

test("failure settlement：失败调用结算计入 failedCalls", () => {
  const ledger = createBudgetLedger();
  const reserved = reserveBudget(ledger, {
    stage: "styleOptimization",
    budgetType: "recovery",
    modelCalls: 1,
  });
  assert.equal(reserved.ok, true);

  const settled = settleBudget(reserved.ledger, reserved.reservationId, {
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 900,
    cost: 0,
    failed: true,
  });
  assert.equal(settled.usage.totalModelCalls, 1);
  assert.equal(settled.usage.failedCalls, 1);
  assert.equal(settled.usage.totalLatencyMs, 900);
  assert.equal(Object.keys(settled.reservations).length, 0);
});

test("over-budget：硬上限超出时拒绝且不产生预约", () => {
  const ledger = createBudgetLedger({ hardBudget: { maxModelCalls: 2 } });
  const r1 = reserveBudget(ledger, { stage: "agenticDraft", modelCalls: 1 });
  const r2 = reserveBudget(r1.ledger, { stage: "styleOptimization", modelCalls: 1 });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r2.snapshot.remainingModelCalls, 0);
  assert.equal(r2.snapshot.exhausted, true);

  const r3 = reserveBudget(r2.ledger, { stage: "finalFactRecheck", modelCalls: 1 });
  assert.equal(r3.ok, false);
  assert.equal(r3.reason, "hard_model_calls_exceeded");
  // 拒绝时不新增预约（调用方不得发起模型调用）
  assert.equal(Object.keys(r3.ledger.reservations).length, 2);
});

test("concurrent reservation：并发 reserve 折叠无超发且不突变输入账本", async () => {
  // 场景 A：10 路并发到达的 reserve 请求，按生产 wrapModelFn 语义串行折叠
  // （reserve 是同步原子块，budgetLedgerState 串行推进，JS 单线程不交错），
  // 全部成功、用量准确、输入账本不被突变。
  const ledgerA = createBudgetLedger();
  const requestsA = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      Promise.resolve({
        stage: i % 2 === 0 ? "agenticDraft" : "styleOptimization",
        reservationId: `conc_${i}`,
      }),
    ),
  );
  let stateA = ledgerA;
  const resultsA = [];
  for (const req of requestsA) {
    const r = reserveBudget(stateA, { ...req, modelCalls: 1 });
    resultsA.push(r);
    stateA = r.ledger;
  }
  assert.ok(resultsA.every((r) => r.ok === true));
  assert.equal(stateA.usage.totalModelCalls, 10);
  assert.equal(Object.keys(stateA.reservations).length, 10);
  // 纯函数语义：输入账本不被任何一次 reserve 突变
  assert.equal(ledgerA.usage.totalModelCalls, 0);
  assert.equal(Object.keys(ledgerA.reservations).length, 0);

  // 场景 B：额度用尽后后续 reserve 被硬上限拒绝，无超发、不新增预约
  const ledgerB = createBudgetLedger({ hardBudget: { maxModelCalls: 3 } });
  let stateB = ledgerB;
  for (let i = 0; i < 3; i++) {
    const r = reserveBudget(stateB, {
      stage: "agenticDraft",
      modelCalls: 1,
      reservationId: `pre_${i}`,
    });
    assert.equal(r.ok, true);
    stateB = r.ledger;
  }
  assert.equal(stateB.usage.totalModelCalls, 3);
  const denied = reserveBudget(stateB, { stage: "agenticDraft", modelCalls: 1 });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "hard_model_calls_exceeded");
  assert.equal(Object.keys(denied.ledger.reservations).length, 3);

  // 结算末位预约后账本快照可读（exhausted 视图）
  const settledB = settleBudget(stateB, "pre_2", {
    modelCalls: 1,
    inputTokens: 100,
    outputTokens: 50,
    latencyMs: 1000,
    cost: 0,
    failed: false,
  });
  const view = getBudgetLedger(settledB);
  assert.equal(view.usage.totalModelCalls, 3);
  assert.equal(view.usage.totalTokensInput, 100);
  assert.equal(view.snapshot.remainingModelCalls, 0);
  assert.equal(view.snapshot.exhausted, true);
});
