/**
 * Budget Replay Matrix — BG 完整治理闭环验收
 *
 * 覆盖：token overage、recovery 耗尽、mandatory lock、Batch 不足、
 * 用户追加授权、长尾 wait checkpoint、release/expiry。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createBudgetLedger,
  reserveBudget,
  settleBudget,
  releaseBudget,
  expireReservations,
  admitBatchChapter,
  requestAdditionalBudget,
  applyUserExtension,
  evaluateBudgetDecision,
} from "../dist/v2/core/budget-ledger.js";
import { runBatchGeneration } from "../dist/v2/core/batch-generation-orchestrator.js";
import {
  BatchGenerationJobStore,
  saveBatchJobStore,
} from "../dist/v2/core/batch-generation-job-store.js";

test("token overage：输入 token 超限拒绝且不产生预约", () => {
  const ledger = createBudgetLedger({ hardBudget: { maxInputTokens: 100 } });
  const denied = reserveBudget(ledger, {
    stage: "agenticDraft",
    inputTokens: 101,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "hard_input_tokens_exceeded");
  assert.equal(Object.keys(denied.ledger.reservations).length, 0);
});

test("recovery 耗尽：超出 maxRecoveryModelCalls 拒绝", () => {
  let ledger = createBudgetLedger({ hardBudget: { maxRecoveryModelCalls: 1 } });
  const r1 = reserveBudget(ledger, {
    stage: "styleOptimization",
    budgetType: "recovery",
  });
  assert.equal(r1.ok, true);
  ledger = settleBudget(r1.ledger, r1.reservationId, {
    modelCalls: 1,
    inputTokens: 10,
    outputTokens: 10,
    latencyMs: 10,
    failed: true,
  });
  const r2 = reserveBudget(ledger, {
    stage: "styleOptimization",
    budgetType: "recovery",
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "recovery_exhausted");
});

test("mandatory reserve：探索不得吃掉必经阶段配额", () => {
  const ledger = createBudgetLedger({
    hardBudget: { maxModelCalls: 12, mandatoryReserveMin: 12 },
    mandatoryReserve: {
      agenticDraft: 4,
      styleOptimization: 3,
      storyPreservation: 2,
      finalFactRecheck: 2,
      completeness: 1,
    },
  });
  const denied = reserveBudget(ledger, { stage: "other", modelCalls: 1 });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "mandatory_reserve_depleted");

  const allowed = reserveBudget(ledger, { stage: "agenticDraft", modelCalls: 1 });
  assert.equal(allowed.ok, true);
});

test("用户追加授权后可继续 reserve", () => {
  let ledger = createBudgetLedger({ hardBudget: { maxModelCalls: 1 } });
  const r1 = reserveBudget(ledger, { stage: "agenticDraft" });
  ledger = settleBudget(r1.ledger, r1.reservationId, {
    modelCalls: 1,
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 1,
    failed: false,
  });
  const blocked = reserveBudget(ledger, { stage: "styleOptimization" });
  assert.equal(blocked.ok, false);

  const asked = requestAdditionalBudget(ledger, {
    reason: "need_more_calls",
    extraCalls: 2,
  });
  assert.equal(asked.action, "request_additional");

  ledger = applyUserExtension(asked.ledger, {
    extraCalls: 2,
    extraCost: 0,
    extraRecoveryCalls: 0,
    grantedBy: "user",
    reason: "author_granted",
    grantedAt: Date.now(),
  });
  const next = reserveBudget(ledger, { stage: "styleOptimization" });
  assert.equal(next.ok, true);
  assert.ok(ledger.userExtension);
});

test("no_progress 决策链请求追加预算", () => {
  const ledger = createBudgetLedger();
  const decided = evaluateBudgetDecision(ledger, { noProgress: true });
  assert.equal(decided.action, "request_additional");
  assert.equal(decided.reason, "no_progress");
  assert.equal(decided.ledger.decisions.at(-1)?.type, "budget_decision_made");
});

test("release / expiry 归还预扣调用", () => {
  const ledger = createBudgetLedger({ hardBudget: { maxModelCalls: 2 } });
  const reserved = reserveBudget(ledger, {
    stage: "agenticDraft",
    reservationId: "exp-1",
    expiresAt: Date.now() - 1,
  });
  assert.equal(reserved.ok, true);
  assert.equal(reserved.ledger.usage.totalModelCalls, 1);

  const expired = expireReservations(reserved.ledger, Date.now());
  assert.equal(expired.usage.totalModelCalls, 0);
  assert.equal(Object.keys(expired.reservations).length, 0);
  assert.ok(expired.decisions.some((d) => d.type === "budget_expired"));

  const live = reserveBudget(ledger, { stage: "agenticDraft", reservationId: "rel-1" });
  const released = releaseBudget(live.ledger, "rel-1");
  assert.equal(released.usage.totalModelCalls, 0);
  assert.ok(released.decisions.some((d) => d.type === "budget_released"));
});

test("长尾 wait 超限拒绝", () => {
  const ledger = createBudgetLedger({ hardBudget: { maxTotalWaitMs: 1000 } });
  const denied = reserveBudget(ledger, {
    stage: "agenticDraft",
    latencyMs: 1001,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "hard_wait_exceeded");
});

test("Batch 章节额度不足：admit 拒绝且不启动下一章", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "bg-batch-"));
  const workspaceId = "ws-budget-batch";
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(join(workspacePath, "chapters"), { recursive: true });
  mkdirSync(join(workspacePath, "batch-jobs"), { recursive: true });
  mkdirSync(join(workspacePath, "traces"), { recursive: true });
  try {
    const store = new BatchGenerationJobStore(workspaceId, {
      jobId: "batch-budget-1",
      startChapter: 1,
      endChapter: 2,
      frontier: 1,
      status: "running",
      chapters: [
        { chapterNumber: 1, chapterId: "1", status: "pending" },
        { chapterNumber: 2, chapterId: "2", status: "pending" },
      ],
      budgetLedger: createBudgetLedger({
        hardBudget: { maxBatchChapters: 1, maxModelCalls: 50, maxRecoveryModelCalls: 10 },
        usage: { batchChaptersUsed: 1 },
      }),
    });
    saveBatchJobStore(store.state, workspaceId, "batch-budget-1", projectRoot);

    let calls = 0;
    const { state } = await runBatchGeneration({
      state: store.state,
      projectRoot,
      mockGenerateChapter: async ({ chapterNumber }) => {
        calls += 1;
        const chapterFile = join(workspacePath, "chapters", `${chapterNumber}.md`);
        writeFileSync(chapterFile, `ch${chapterNumber}`, "utf-8");
        return {
          status: "ok",
          chapterFilePath: chapterFile,
          stageResults: { stateCommit: { skipped: true }, modelCallCount: 1 },
        };
      },
    });

    assert.equal(calls, 0, "预算不足时不得启动任何章节");
    assert.equal(state.frontier, 1);
    assert.equal(state.status, "paused");
    assert.equal(state.interruptReason, "budget_exhausted");
    assert.equal(state.checkpointChapter, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("admitBatchChapter 在额度用尽后拒绝", () => {
  let ledger = createBudgetLedger({
    hardBudget: { maxBatchChapters: 1, maxModelCalls: 50, maxRecoveryModelCalls: 6 },
  });
  const first = admitBatchChapter(ledger, { chapterNumber: 1 });
  assert.equal(first.ok, true);
  const retry = admitBatchChapter(first.ledger, { chapterNumber: 1 });
  assert.equal(retry.ok, true, "同一章 resume 不得再占一个 batch slot");
  assert.equal(retry.ledger.usage.batchChaptersUsed, 1);
  const second = admitBatchChapter(retry.ledger, { chapterNumber: 2 });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "batch_chapters_remaining_zero");
});
