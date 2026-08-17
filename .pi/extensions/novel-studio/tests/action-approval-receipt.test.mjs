/**
 * ACTION-APPROVAL-RECEIPT tests — 正式审批对象（计划 20260812-2 P2/P7）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createActionApprovalReceipt,
  validateActionApprovalReceipt,
  authorizeCommitAction,
  consumeApprovalReceipt,
  saveActionApprovalReceipt,
  loadActionApprovalReceipt,
  persistConsumedApprovalReceipt,
  computeArtifactHash,
  computeReceiptHash,
} from "../dist/v2/governance/action-approval-receipt.js";

const TEXT_A = "第一章正文。林川推开门。";
const TEXT_B = "第一章正文。林川关上门。";

function makeReceipt(overrides = {}) {
  return createActionApprovalReceipt({
    workspaceId: "ws-r1",
    chapterId: "1",
    action: "chapter.save",
    artifactHash: computeArtifactHash(TEXT_A),
    revision: "2026-08-12T00:00:00.000Z",
    actor: "user",
    taskId: "task-1",
    decision: "approve",
    ...overrides,
  });
}

test("审批对象使用稳定 canonical hash", () => {
  const fixed = {
    approvalId: "uar-stable-1",
    issuedAt: "2026-08-12T00:00:00.000Z",
    ttlMs: 24 * 60 * 60 * 1000,
  };
  const r1 = makeReceipt(fixed);
  const r2 = makeReceipt(fixed);
  assert.equal(r1.receiptHash, r2.receiptHash);
  assert.equal(validateActionApprovalReceipt(r1).length, 0);
  const base = {
    schemaId: r1.schemaId,
    schemaVersion: r1.schemaVersion,
    workspaceId: r1.workspaceId,
    chapterId: r1.chapterId,
    action: r1.action,
    kind: r1.kind,
    artifactHash: r1.artifactHash,
    revision: r1.revision,
    approvalId: r1.approvalId,
    actor: r1.actor,
    issuedAt: r1.issuedAt,
    expiresAt: r1.expiresAt,
    requiredChecks: r1.requiredChecks,
    scope: r1.scope,
    taskId: r1.taskId,
    decision: r1.decision,
    consumed: false,
  };
  assert.equal(computeReceiptHash(base), r1.receiptHash);
});

test("模型不能伪造 actor=user（create 拒绝 actor=model）", () => {
  assert.throws(
    () => makeReceipt({ actor: "model" }),
    /actor=model/,
  );
});

test("旧审批对象不能作用于新正文（artifact_hash_mismatch）", () => {
  const receipt = makeReceipt();
  const result = authorizeCommitAction({
    receipt,
    finalText: TEXT_B,
    workspaceId: "ws-r1",
    chapterId: "1",
    action: "chapter.save",
    revision: receipt.revision,
    completedChecks: [
      "fact_guard",
      "story_preservation",
      "completeness",
      "pending_bound",
    ],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.blockReason, "artifact_hash_mismatch");
});

test("跨 workspace/chapter 复用审批：scope_mismatch", () => {
  const receipt = makeReceipt();
  const crossWs = authorizeCommitAction({
    receipt,
    finalText: TEXT_A,
    workspaceId: "ws-other",
    chapterId: "1",
    action: "chapter.save",
    revision: receipt.revision,
    completedChecks: [
      "fact_guard",
      "story_preservation",
      "completeness",
      "pending_bound",
    ],
  });
  assert.equal(crossWs.allowed, false);
  assert.equal(crossWs.blockReason, "scope_mismatch");

  const crossCh = authorizeCommitAction({
    receipt,
    finalText: TEXT_A,
    workspaceId: "ws-r1",
    chapterId: "99",
    action: "chapter.save",
    revision: receipt.revision,
    completedChecks: [
      "fact_guard",
      "story_preservation",
      "completeness",
      "pending_bound",
    ],
  });
  assert.equal(crossCh.allowed, false);
  assert.equal(crossCh.blockReason, "scope_mismatch");
});

test("审批过期：approval_expired", () => {
  const receipt = makeReceipt({
    issuedAt: "2020-01-01T00:00:00.000Z",
    ttlMs: 1000,
  });
  const result = authorizeCommitAction({
    receipt,
    finalText: TEXT_A,
    workspaceId: "ws-r1",
    chapterId: "1",
    action: "chapter.save",
    revision: receipt.revision,
    now: new Date("2026-08-12T00:00:00.000Z"),
    completedChecks: [
      "fact_guard",
      "story_preservation",
      "completeness",
      "pending_bound",
    ],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.blockReason, "approval_expired");
});

test("审批到期边界：now === expiresAt 即过期", () => {
  const issuedAt = "2026-08-12T00:00:00.000Z";
  const ttlMs = 60_000;
  const receipt = makeReceipt({
    issuedAt,
    ttlMs,
    approvalId: "uar-boundary-1",
  });
  const expiresAt = new Date(Date.parse(issuedAt) + ttlMs);
  const atExpiry = authorizeCommitAction({
    receipt,
    finalText: TEXT_A,
    workspaceId: "ws-r1",
    chapterId: "1",
    action: "chapter.save",
    revision: receipt.revision,
    now: expiresAt,
    completedChecks: [
      "fact_guard",
      "story_preservation",
      "completeness",
      "pending_bound",
    ],
  });
  assert.equal(atExpiry.allowed, false);
  assert.equal(atExpiry.blockReason, "approval_expired");

  const beforeExpiry = authorizeCommitAction({
    receipt,
    finalText: TEXT_A,
    workspaceId: "ws-r1",
    chapterId: "1",
    action: "chapter.save",
    revision: receipt.revision,
    now: new Date(expiresAt.getTime() - 1),
    completedChecks: [
      "fact_guard",
      "story_preservation",
      "completeness",
      "pending_bound",
    ],
  });
  assert.equal(beforeExpiry.allowed, true);
});

test("pending 稿 revision 不匹配：stale_revision", () => {
  const receipt = makeReceipt();
  const result = authorizeCommitAction({
    receipt,
    finalText: TEXT_A,
    workspaceId: "ws-r1",
    chapterId: "1",
    action: "chapter.save",
    revision: "WRONG_REVISION",
    completedChecks: [
      "fact_guard",
      "story_preservation",
      "completeness",
      "pending_bound",
    ],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.blockReason, "stale_revision");
});

test("一次性消费：消费后再次授权 already_consumed", () => {
  const receipt = makeReceipt();
  const ok = authorizeCommitAction({
    receipt,
    finalText: TEXT_A,
    workspaceId: "ws-r1",
    chapterId: "1",
    action: "chapter.save",
    revision: receipt.revision,
    completedChecks: [
      "fact_guard",
      "story_preservation",
      "completeness",
      "pending_bound",
    ],
  });
  assert.equal(ok.allowed, true);
  const consumed = consumeApprovalReceipt(receipt);
  assert.equal(consumed.consumed, true);
  const again = authorizeCommitAction({
    receipt: consumed,
    finalText: TEXT_A,
    workspaceId: "ws-r1",
    chapterId: "1",
    action: "chapter.save",
    revision: receipt.revision,
    completedChecks: [
      "fact_guard",
      "story_preservation",
      "completeness",
      "pending_bound",
    ],
  });
  assert.equal(again.allowed, false);
  assert.equal(again.blockReason, "already_consumed");
});

test("reject 决策不得触发提交", () => {
  const receipt = makeReceipt({ decision: "reject" });
  const result = authorizeCommitAction({
    receipt,
    finalText: TEXT_A,
    workspaceId: "ws-r1",
    chapterId: "1",
    action: "chapter.save",
    revision: receipt.revision,
    completedChecks: [
      "fact_guard",
      "story_preservation",
      "completeness",
      "pending_bound",
    ],
  });
  assert.equal(result.allowed, false);
});

test("章节代理审批对象不能直接用于正式提交", () => {
  const receipt = makeReceipt({ kind: "chapter_proxy" });
  const result = authorizeCommitAction({
    receipt,
    finalText: TEXT_A,
    workspaceId: "ws-r1",
    chapterId: "1",
    action: "chapter.save",
    revision: receipt.revision,
    completedChecks: [
      "fact_guard",
      "story_preservation",
      "completeness",
      "pending_bound",
    ],
  });
  assert.equal(result.allowed, false);
});

test("append-only 落盘与加载", () => {
  const dir = mkdtempSync(join(tmpdir(), "uar-store-"));
  try {
    const receipt = makeReceipt({ approvalId: "uar-disk-1" });
    saveActionApprovalReceipt(dir, receipt);
    const loaded = loadActionApprovalReceipt(dir, "uar-disk-1");
    assert.equal(loaded.receiptHash, receipt.receiptHash);
    assert.throws(() => saveActionApprovalReceipt(dir, receipt), /append-only/);
    const consumed = consumeApprovalReceipt(loaded);
    persistConsumedApprovalReceipt(dir, consumed);
    const loaded2 = loadActionApprovalReceipt(dir, "uar-disk-1");
    assert.equal(loaded2.consumed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("模型伪造 confirm 且 receipt.actor=model 被拒（结构层）", () => {
  // create 已禁止 model；这里模拟损坏对象
  const receipt = makeReceipt();
  const forged = { ...receipt, actor: "model" };
  // hash 会失败或 actor 检查失败
  const result = authorizeCommitAction({
    receipt: forged,
    finalText: TEXT_A,
    workspaceId: "ws-r1",
    chapterId: "1",
    action: "chapter.save",
    revision: receipt.revision,
    modelClaimedConfirmation: true,
    completedChecks: [
      "fact_guard",
      "story_preservation",
      "completeness",
      "pending_bound",
    ],
  });
  assert.equal(result.allowed, false);
});
