/**
 * EVOLUTION-RELEASE-GOVERNANCE-G7 — 用户反馈记录器测试（Slice C）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 / §12.2
 *
 * G7 Feedback Recorder 切片要求（计划 §12.2）：
 * - 保存用户修改 diff、代理判断偏差和状态回滚结果
 * - 真实用户反馈追加到策略证据与 release 健康报告
 *
 * 本测试覆盖：
 * 1. recordProxyApprovalFeedback：追加记录到 chapter-approvals/feedback.jsonl
 * 2. append-only：多条记录追加（不覆盖）
 * 3. loadProxyApprovalFeedback：读取所有反馈记录
 * 4. loadProxyApprovalFeedback：按 chapterId 过滤
 * 5. 目录穿越防护：恶意 chapterId / approvalId 拒绝
 * 6. 记录字段完整性（action/factGuardPassed/editedTextDiff/proxyJudgmentBias）
 * 7. feedback.jsonl 落盘到 chapter-approvals/（隔离，不写 chapters/）
 * 8. computeEditedTextDiff：计算原稿 vs 用户稿差异摘要
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  recordProxyApprovalFeedback,
  loadProxyApprovalFeedback,
  computeEditedTextDiff,
} from "../dist-test/v2/governance/chapter-proxy-approval-feedback-recorder.js";

// ============================================================================
// helpers
// ============================================================================

function makeTempWorkspace() {
  const projectRoot = mkdtempSync(join(tmpdir(), "g7-feedback-"));
  const workspaceId = "ws-test";
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  return { projectRoot, workspaceId, workspacePath };
}

function makeFeedback(overrides = {}) {
  return {
    timestamp: "2026-07-16T00:00:00.000Z",
    approvalId: "cpa-fb-001",
    chapterId: "1",
    workspaceId: "ws-test",
    action: "accept",
    proxyJudgmentBias: {
      proxyRecommendedSource: "raw",
      userAcceptedSource: "raw",
      aligned: true,
    },
    ...overrides,
  };
}

// ============================================================================
// 1. recordProxyApprovalFeedback：追加记录到 feedback.jsonl
// ============================================================================

test("recordProxyApprovalFeedback: 追加记录到 chapter-approvals/feedback.jsonl", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    const result = recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedback(),
    });

    assert.ok(result.feedbackFilePath);
    assert.match(result.feedbackFilePath, /chapter-approvals[\\/]feedback\.jsonl/);
    assert.equal(existsSync(result.feedbackFilePath), true);

    // 文件内容是一行 JSON
    const content = readFileSync(result.feedbackFilePath, "utf-8").trim();
    const record = JSON.parse(content);
    assert.equal(record.approvalId, "cpa-fb-001");
    assert.equal(record.action, "accept");
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. append-only：多条记录追加（不覆盖）
// ============================================================================

test("recordProxyApprovalFeedback: append-only，多条记录追加不覆盖", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedback({ approvalId: "cpa-fb-001", action: "accept" }),
    });
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedback({ approvalId: "cpa-fb-002", action: "reject" }),
    });

    const records = loadProxyApprovalFeedback(workspacePath);
    assert.equal(records.length, 2);
    assert.equal(records[0].approvalId, "cpa-fb-001");
    assert.equal(records[0].action, "accept");
    assert.equal(records[1].approvalId, "cpa-fb-002");
    assert.equal(records[1].action, "reject");
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. loadProxyApprovalFeedback：读取所有反馈记录
// ============================================================================

test("loadProxyApprovalFeedback: 无记录时返回空数组", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    const records = loadProxyApprovalFeedback(workspacePath);
    assert.deepEqual(records, []);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. loadProxyApprovalFeedback：按 chapterId 过滤
// ============================================================================

test("loadProxyApprovalFeedback: 按 chapterId 过滤记录", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedback({ approvalId: "fb-1", chapterId: "1" }),
    });
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedback({ approvalId: "fb-2", chapterId: "2" }),
    });
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedback({ approvalId: "fb-3", chapterId: "1" }),
    });

    const ch1Records = loadProxyApprovalFeedback(workspacePath, "1");
    assert.equal(ch1Records.length, 2);
    assert.ok(ch1Records.every((r) => r.chapterId === "1"));

    const ch2Records = loadProxyApprovalFeedback(workspacePath, "2");
    assert.equal(ch2Records.length, 1);
    assert.equal(ch2Records[0].approvalId, "fb-2");
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. 目录穿越防护
// ============================================================================

test("recordProxyApprovalFeedback: 恶意 chapterId 拒绝（目录穿越防护）", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    const maliciousIds = ["../escaped", "a/b", "a\\b", "a;b", "a b", "a.b", ""];
    for (const badId of maliciousIds) {
      assert.throws(
        () =>
          recordProxyApprovalFeedback({
            workspacePath,
            feedback: makeFeedback({ chapterId: badId }),
          }),
        /chapterId 含非法字符|目录穿越|illegal/i,
      );
    }
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 6. 记录字段完整性（accept_with_edits 场景）
// ============================================================================

test("recordProxyApprovalFeedback: accept_with_edits 记录含 factGuardPassed + editedTextDiff + proxyJudgmentBias", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    const result = recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedback({
        action: "accept_with_edits",
        factGuardPassed: true,
        editedTextDiff: {
          originalLength: 100,
          editedLength: 120,
          diffSummary: "added 20 chars",
        },
        proxyJudgmentBias: {
          proxyRecommendedSource: "editorial",
          userAcceptedSource: "raw",
          aligned: false,
        },
      }),
    });

    const records = loadProxyApprovalFeedback(workspacePath);
    assert.equal(records.length, 1);
    const r = records[0];
    assert.equal(r.action, "accept_with_edits");
    assert.equal(r.factGuardPassed, true);
    assert.equal(r.editedTextDiff.originalLength, 100);
    assert.equal(r.editedTextDiff.editedLength, 120);
    assert.equal(r.editedTextDiff.diffSummary, "added 20 chars");
    assert.equal(r.proxyJudgmentBias.proxyRecommendedSource, "editorial");
    assert.equal(r.proxyJudgmentBias.userAcceptedSource, "raw");
    assert.equal(r.proxyJudgmentBias.aligned, false);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 7. feedback.jsonl 落盘到 chapter-approvals/（隔离，不写 chapters/）
// ============================================================================

test("recordProxyApprovalFeedback: feedback.jsonl 落盘到 chapter-approvals/，不写 chapters/", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedback(),
    });

    const approvalsDir = join(workspacePath, "chapter-approvals");
    const chaptersDir = join(workspacePath, "chapters");
    assert.equal(existsSync(join(approvalsDir, "feedback.jsonl")), true);
    // chapters/ 不应被创建（反馈记录不写正文）
    assert.equal(existsSync(chaptersDir), false);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 8. computeEditedTextDiff：计算原稿 vs 用户稿差异摘要
// ============================================================================

test("computeEditedTextDiff: 相同文本返回 same=true, length_delta=0", () => {
  const text = "这是一段正文。";
  const diff = computeEditedTextDiff(text, text);
  assert.equal(diff.originalLength, text.length);
  assert.equal(diff.editedLength, text.length);
  assert.equal(diff.lengthDelta, 0);
  assert.equal(diff.same, true);
});

test("computeEditedTextDiff: 不同文本返回 same=false + 长度差", () => {
  const original = "这是原稿正文。";
  const edited = "这是用户修改后的较长正文。";
  const diff = computeEditedTextDiff(original, edited);
  assert.equal(diff.originalLength, original.length);
  assert.equal(diff.editedLength, edited.length);
  assert.equal(diff.lengthDelta, edited.length - original.length);
  assert.equal(diff.same, false);
  assert.ok(diff.diffSummary.length > 0, "diffSummary 应非空");
});

// ============================================================================
// 9. 损坏 feedback.jsonl 不静默返回 null（抛错）
// ============================================================================

test("loadProxyApprovalFeedback: 损坏 JSON 行抛错（不静默）", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    const approvalsDir = join(workspacePath, "chapter-approvals");
    mkdirSync(approvalsDir, { recursive: true });
    // 写入损坏的 JSON 行
    appendFileSync(join(approvalsDir, "feedback.jsonl"), "{ invalid json\n", "utf-8");

    assert.throws(() => loadProxyApprovalFeedback(workspacePath), /JSON|parse/i);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});
