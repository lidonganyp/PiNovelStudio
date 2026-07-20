/**
 * P1 阻断项修复 RED 测试：真实代理初审接入生产 dist（runner:221）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 / §12.2
 *
 * 用户阻断项 P1：
 *   runRealChapterProxyReview 已实现并通过 mock 测试，但 runner/caller 仅存在于
 *   dist-test，生产 dist 中不存在，也没有生产调用入口。
 *
 * 本测试覆盖生产接入（dist 闭包绑定 + handler 入口）：
 * 1. review-surface-cli 从 dist/ re-export runStubChapterProxyReview / runRealChapterProxyReview
 * 2. review-surface-cli 从 dist/ re-export caller 工厂（createStubChapterProxyApprovalCaller /
 *    createRealGpt56SolChapterProxyApprovalCaller / createOpenAIChatCompletionsFn）
 * 3. handleChapterProxyReview 从 dist/handlers 可导入（生产调用入口存在）
 * 4. handleChapterProxyReview 无 authorizationCardPath -> status=error + REQUIRES_AUTH
 *    （保留 REQUIRES_AUTH 边界；不 throw 让上层捕获）
 * 5. handleChapterProxyReview authorizationCardPath 文件不存在 -> status=error + REQUIRES_AUTH
 *
 * 边界（READY_LOCAL）：
 * - 不调用真实模型、不联网
 * - 不创建真实 caller（无 callerOverride + 无 env -> REQUIRES_AUTH 或 API 配置缺失）
 * - 验证生产闭包绑定与入口存在性，不验证完整审批流程（已由 dist-test 测试覆盖）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ============================================================================
// 1. review-surface-cli 从 dist/ re-export runner + caller（prod-binding）
// ============================================================================
// P1 阻断项核心：runner/caller 必须进入生产 dist 闭包，而非仅存在于 dist-test。
// 通过 review-surface-cli value import + re-export 拉入生产闭包（与 finalization /
// feedback-recorder / finalization-entry / finalization-trigger / feedback-ingestor /
// release-health-aggregator / registry 同模式）。
// ============================================================================

test("P1 prod-binding: review-surface-cli 从 dist/ re-export runStubChapterProxyReview / runRealChapterProxyReview", async () => {
  const surface = await import("../dist/v2/core/review-surface-cli.js");
  assert.equal(
    typeof surface.runStubChapterProxyReview,
    "function",
    "runStubChapterProxyReview 必须从 dist/v2/core/review-surface-cli.js re-export（生产闭包绑定）",
  );
  assert.equal(
    typeof surface.runRealChapterProxyReview,
    "function",
    "runRealChapterProxyReview 必须从 dist/v2/core/review-surface-cli.js re-export（生产闭包绑定）",
  );
});

test("P1 prod-binding: review-surface-cli 从 dist/ re-export caller 工厂", async () => {
  const surface = await import("../dist/v2/core/review-surface-cli.js");
  assert.equal(
    typeof surface.createStubChapterProxyApprovalCaller,
    "function",
    "createStubChapterProxyApprovalCaller 必须从 dist/v2/core/review-surface-cli.js re-export",
  );
  assert.equal(
    typeof surface.createRealGpt56SolChapterProxyApprovalCaller,
    "function",
    "createRealGpt56SolChapterProxyApprovalCaller 必须从 dist/v2/core/review-surface-cli.js re-export",
  );
  assert.equal(
    typeof surface.createOpenAIChatCompletionsFn,
    "function",
    "createOpenAIChatCompletionsFn 必须从 dist/v2/core/review-surface-cli.js re-export",
  );
})

// ============================================================================
// 2. handleChapterProxyReview 从 dist/handlers 可导入（生产调用入口存在）
// ============================================================================

test("P1 生产入口: handleChapterProxyReview 从 dist/handlers 可导入", async () => {
  const handlerMod = await import("../dist/handlers/chapter-proxy-review-handler.js");
  assert.equal(
    typeof handlerMod.handleChapterProxyReview,
    "function",
    "handleChapterProxyReview 必须从 dist/handlers/chapter-proxy-review-handler.js 导出（生产调用入口）",
  );
})

// ============================================================================
// 3. handleChapterProxyReview REQUIRES_AUTH 边界
// ============================================================================

test("P1 REQUIRES_AUTH: handleChapterProxyReview 无 authorizationCardPath -> status=error + REQUIRES_AUTH", async () => {
  const { handleChapterProxyReview } = await import("../dist/handlers/chapter-proxy-review-handler.js");
  const result = await handleChapterProxyReview({
    workspaceId: "ws-test",
    chapterId: "1",
    chapterNumber: 1,
    releaseId: "rel-001",
    // 故意不提供 authorizationCardPath
    packetInput: {
      releaseId: "rel-001",
      workspaceId: "ws-test",
      chapterId: "1",
      candidates: [],
      factGuardReport: { hardBlocked: false, warnings: [] },
      stateConsistency: { consistent: true },
      costProfile: { totalTokens: 0, latencyMs: 0 },
      systemJudgeConclusion: "",
      developerExpectation: "",
      budgetMaxCalls: 2,
      timeoutMs: 60000,
    },
    forwardVerdict: "PROXY_APPROVED",
    reverseVerdict: "PROXY_APPROVED",
    recommendedCandidateId: "cand-raw-001",
    recommendedSource: "raw",
    promptHash: "hash-001",
    budget: { maxCalls: 2, timeoutMs: 60000 },
  });
  assert.equal(result.status, "error", "无授权卡时必须 status=error");
  assert.ok(
    result.error && result.error.includes("REQUIRES_AUTH"),
    `error 必须包含 REQUIRES_AUTH：${result.error}`,
  );
});

test("P1 REQUIRES_AUTH: handleChapterProxyReview authorizationCardPath 文件不存在 -> status=error + REQUIRES_AUTH", async () => {
  const { handleChapterProxyReview } = await import("../dist/handlers/chapter-proxy-review-handler.js");
  const tmpRoot = mkdtempSync(join(tmpdir(), "p1-review-handler-"));
  try {
    const nonexistentCard = join(tmpRoot, "nonexistent-card.json");
    const result = await handleChapterProxyReview({
      workspaceId: "ws-test",
      chapterId: "1",
      chapterNumber: 1,
      releaseId: "rel-001",
      authorizationCardPath: nonexistentCard,
      packetInput: {
        releaseId: "rel-001",
        workspaceId: "ws-test",
        chapterId: "1",
        candidates: [],
        factGuardReport: { hardBlocked: false, warnings: [] },
        stateConsistency: { consistent: true },
        costProfile: { totalTokens: 0, latencyMs: 0 },
        systemJudgeConclusion: "",
        developerExpectation: "",
        budgetMaxCalls: 2,
        timeoutMs: 60000,
      },
      forwardVerdict: "PROXY_APPROVED",
      reverseVerdict: "PROXY_APPROVED",
      recommendedCandidateId: "cand-raw-001",
      recommendedSource: "raw",
      promptHash: "hash-001",
      budget: { maxCalls: 2, timeoutMs: 60000 },
    });
    assert.equal(result.status, "error", "授权卡文件不存在时必须 status=error");
    assert.ok(
      result.error && result.error.includes("REQUIRES_AUTH"),
      `error 必须包含 REQUIRES_AUTH：${result.error}`,
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
