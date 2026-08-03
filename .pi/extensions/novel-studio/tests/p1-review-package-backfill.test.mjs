/**
 * P1 修复（审阅包回填）测试：sidecar 持久化与用户反馈回填
 *
 * 验证用户验收问题：
 * "用户反馈尚未自动回填生成审阅包 —— 修改差分和自然语言反馈工具已完成，
 *  但审阅包仍固定写入 userModificationDelta: null、positiveBenefitClaim: false"
 *
 * 验证点：
 * 1. persistAuthorStyleReviewPackage：生成时写入 sidecar（userModificationDelta=null 占位）
 * 2. backfillAuthorStyleReviewPackage：用户反馈时回填 delta（userModificationDelta 非 null）
 * 3. handleStrategyFeedback（显式 edit + userFinalText + deliveredText + chapterId）触发回填
 * 4. 回填后 positiveBenefitClaim 仍为 false（累积样本前不宣称正收益）
 * 5. 未提供 chapterId → skipped（不阻断反馈记录）
 * 6. sidecar 不存在 → not_found（章节未走统一主链路）
 * 7. 预览模式不写 sidecar（与 chapterFilePath=null 一致）
 *
 * 不调用真实模型，纯文件 I/O + 规则测试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  persistAuthorStyleReviewPackage,
  backfillAuthorStyleReviewPackage,
} from "../dist/v2/core/unified-orchestrator.js";
import { handleStrategyFeedback } from "../dist/handlers/public-handlers.js";
import { computeUserModificationDelta } from "../dist/v2/learning/user-modification-delta.js";

// ============================================================================
// 辅助函数
// ============================================================================

function makeTempProject() {
  const dir = mkdtempSync(join(tmpdir(), "p1-review-backfill-"));
  const workspaceId = "ws-review-backfill";
  const chaptersDir = join(dir, "workspaces", workspaceId, "chapters");
  mkdirSync(chaptersDir, { recursive: true });
  return { dir, workspaceId, chaptersDir };
}

function sidecarPath(dir, workspaceId, chapterId) {
  return join(
    dir,
    "workspaces",
    workspaceId,
    "chapters",
    `${chapterId}.review-package.json`,
  );
}

function makeSamplePackage(overrides = {}) {
  return {
    chapterNumber: 17,
    agenticCandidateId: "cand-agentic-17",
    styledCandidateId: "cand-styled-17",
    agenticText: "Agentic 初稿正文，林默走进房间。",
    styledText: "风格优化稿正文，林默缓步走入房间，目光扫过角落。",
    sourceRelation: "author_style_full_chapter",
    lengthDelta: 8,
    userModificationDelta: null,
    factRecheckResult: { ok: true, errors: [] },
    positiveBenefitClaim: false,
    positiveBenefitClaimReason:
      "在获得用户实际修改样本前，不宣称整章风格优化稳定优于 NovelOS Agentic 初稿",
    backfilledAt: null,
    ...overrides,
  };
}

// ============================================================================
// 1. persistAuthorStyleReviewPackage
// ============================================================================

describe("P1 审阅包回填：persistAuthorStyleReviewPackage", () => {
  it("生成时写入 sidecar，userModificationDelta=null 占位，戳记 persistedAt", () => {
    const { dir, workspaceId } = makeTempProject();
    try {
      const pkg = makeSamplePackage();
      const path = persistAuthorStyleReviewPackage(
        dir,
        workspaceId,
        "17",
        pkg,
      );
      assert.ok(path, "应返回 sidecar 路径");
      assert.ok(existsSync(path), "sidecar 文件应存在");

      const saved = JSON.parse(readFileSync(path, "utf-8"));
      assert.equal(saved.userModificationDelta, null, "占位 null");
      assert.equal(saved.positiveBenefitClaim, false, "正收益声明恒 false");
      assert.ok(saved.persistedAt, "应戳记 persistedAt（ISO）");
      assert.equal(saved.backfilledAt, null, "backfilledAt 初始 null");
      assert.equal(saved.factRecheckResult.ok, true, "事实复检结果保留");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("目录不存在时自动创建（atomicSave mkdir recursive）", () => {
    const dir = mkdtempSync(join(tmpdir(), "p1-nodir-"));
    const workspaceId = "ws-nodir";
    // 故意不创建 chapters/ 目录
    try {
      const path = persistAuthorStyleReviewPackage(
        dir,
        workspaceId,
        "3",
        makeSamplePackage({ chapterNumber: 3 }),
      );
      assert.ok(path);
      assert.ok(existsSync(path), "目录自动创建后文件应存在");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 2. backfillAuthorStyleReviewPackage
// ============================================================================

describe("P1 审阅包回填：backfillAuthorStyleReviewPackage", () => {
  it("用户反馈后回填 delta，userModificationDelta 非 null，backfilledAt 戳记", () => {
    const { dir, workspaceId } = makeTempProject();
    try {
      // 先持久化占位包
      persistAuthorStyleReviewPackage(dir, workspaceId, "17", makeSamplePackage());

      // 计算用户修改差分
      const delta = computeUserModificationDelta(
        "风格优化稿正文，林默缓步走入房间，目光扫过角落。",
        "风格优化稿正文，林默大步走进房间，眼神冷冷扫过角落。",
      );
      assert.ok(delta.modified, "应有修改");

      // 回填
      const result = backfillAuthorStyleReviewPackage({
        projectRoot: dir,
        workspaceId,
        chapterId: "17",
        delta,
      });
      assert.equal(result.status, "ok");
      assert.ok(result.reviewPackage, "应返回更新后的 package");
      assert.ok(result.filePath, "应返回文件路径");

      // 验证文件已更新
      const saved = JSON.parse(
        readFileSync(sidecarPath(dir, workspaceId, "17"), "utf-8"),
      );
      assert.notEqual(saved.userModificationDelta, null, "delta 已回填，非 null");
      assert.equal(saved.userModificationDelta.editDistance, delta.editDistance);
      assert.equal(saved.userModificationDelta.modified, true);
      assert.ok(saved.backfilledAt, "backfilledAt 应已戳记");
      assert.equal(saved.positiveBenefitClaim, false, "正收益声明仍 false");
      assert.ok(saved.persistedAt, "persistedAt 应保留");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sidecar 不存在 → not_found（章节未走统一主链路）", () => {
    const { dir, workspaceId } = makeTempProject();
    try {
      const delta = computeUserModificationDelta("a", "b");
      const result = backfillAuthorStyleReviewPackage({
        projectRoot: dir,
        workspaceId,
        chapterId: "999",
        delta,
      });
      assert.equal(result.status, "not_found");
      assert.ok(result.reason.includes("不存在"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 3. handleStrategyFeedback 端到端回填
// ============================================================================

describe("P1 审阅包回填：handleStrategyFeedback 端到端", () => {
  it("显式 edit + userFinalText + deliveredText + chapterId 触发 sidecar 回填", async () => {
    const { dir, workspaceId } = makeTempProject();
    try {
      // 模拟编排器先写 sidecar（生成时占位）
      persistAuthorStyleReviewPackage(dir, workspaceId, "17", makeSamplePackage());

      const delivered = "风格优化稿正文，林默缓步走入房间，目光扫过角落。";
      const userFinal = "风格优化稿正文，林默大步走进房间，眼神冷冷扫过角落。";

      const result = await handleStrategyFeedback({
        workspaceId,
        action: "edit",
        strategyId: "voice_emphasis",
        modelVersion: "gemini-3.1-pro-preview",
        sourceChapter: "ch17",
        opportunityType: "author_style",
        deliveredSource: "editorial",
        deliveredText: delivered,
        userFinalText: userFinal,
        chapterId: "17",
        _projectRoot: dir,
      });

      assert.equal(result.status, "ok");
      assert.ok(result.userModificationDelta, "应返回 computedDelta");
      assert.ok(result.userModificationDelta.modified);
      assert.ok(result.reviewPackageBackfill, "应返回回填结果");
      assert.equal(result.reviewPackageBackfill.status, "ok");

      // 验证 sidecar 已更新
      const saved = JSON.parse(
        readFileSync(sidecarPath(dir, workspaceId, "17"), "utf-8"),
      );
      assert.notEqual(saved.userModificationDelta, null, "delta 已回填");
      assert.ok(saved.backfilledAt, "backfilledAt 已戳记");
      assert.equal(saved.positiveBenefitClaim, false, "正收益声明仍 false");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("未提供 chapterId → skipped（不阻断反馈记录）", async () => {
    const { dir, workspaceId } = makeTempProject();
    try {
      const result = await handleStrategyFeedback({
        workspaceId,
        action: "edit",
        strategyId: "voice_emphasis",
        modelVersion: "gemini-3.1-pro-preview",
        sourceChapter: "ch17",
        opportunityType: "author_style",
        deliveredSource: "editorial",
        deliveredText: "原稿",
        userFinalText: "修改稿",
        // 故意不提供 chapterId
        _projectRoot: dir,
      });

      assert.equal(result.status, "ok");
      assert.ok(result.userModificationDelta, "delta 仍计算");
      assert.ok(result.reviewPackageBackfill, "应返回 skipped 状态");
      assert.equal(result.reviewPackageBackfill.status, "skipped");
      assert.ok(result.reviewPackageBackfill.reason.includes("chapterId"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("未提供 userFinalText/deliveredText → skipped（delta 未计算）", async () => {
    const { dir, workspaceId } = makeTempProject();
    try {
      const result = await handleStrategyFeedback({
        workspaceId,
        action: "edit",
        strategyId: "voice_emphasis",
        modelVersion: "gemini-3.1-pro-preview",
        sourceChapter: "ch17",
        opportunityType: "author_style",
        deliveredSource: "editorial",
        modified: true,
        chapterId: "17",
        // 故意不提供 userFinalText/deliveredText
        _projectRoot: dir,
      });

      assert.equal(result.status, "ok");
      assert.equal(result.reviewPackageBackfill.status, "skipped");
      assert.ok(result.reviewPackageBackfill.reason.includes("userModificationDelta"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chapterId 提供但 sidecar 不存在 → not_found", async () => {
    const { dir, workspaceId } = makeTempProject();
    try {
      const result = await handleStrategyFeedback({
        workspaceId,
        action: "edit",
        strategyId: "voice_emphasis",
        modelVersion: "gemini-3.1-pro-preview",
        sourceChapter: "ch18",
        opportunityType: "author_style",
        deliveredSource: "editorial",
        deliveredText: "原稿",
        userFinalText: "修改稿",
        chapterId: "18", // sidecar 不存在
        _projectRoot: dir,
      });

      assert.equal(result.status, "ok");
      assert.equal(result.reviewPackageBackfill.status, "not_found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
