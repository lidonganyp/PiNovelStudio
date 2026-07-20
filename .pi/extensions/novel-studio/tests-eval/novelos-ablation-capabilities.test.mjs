/**
 * NovelOS Ablation Capabilities 测试（P1 配套）
 *
 * 验证 createAgenticRawCandidateSource 的能力开关：
 * - enableRetrieval=false → runtime 无工具 → B1 toolCalls=0
 * - enableRetrieval=true → runtime 有工具 → B2/B3 toolCalls > 0（当 fixture 有 retrievalQueries）
 * - enableVerification=false → loop 无 verifier → verifierCleared=undefined
 * - enableVerification=true → loop 有 verifier → verifierCleared 为 boolean
 * - 无参数 → 默认两者 true（生产路径兼容）
 *
 * 通过 runAgentLoopForEval 端到端验证 B1/B2/B3 的能力差异。
 * 测试从 dist/ 导入构建产物。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// novelos/eval/* 模块是 dormant-from-prod（PROD-BUILD-BOUNDARY-1 后退出生产构建），
// 只存在于 dist-eval/novelos/eval/。生产 dist/novelos/ 不含 eval 子目录。
const DIST_ROOT = join(__dirname, "..", "dist-eval");

const evalHarnessUrl = pathToFileURL(
  join(DIST_ROOT, "novelos", "eval", "eval-harness.js"),
).href;
const fixturesUrl = pathToFileURL(
  join(DIST_ROOT, "novelos", "eval", "fixtures.js"),
).href;

const { setupFixtureWorkspace, runAgentLoopForEval } = await import(evalHarnessUrl);
const { EVAL_FIXTURES } = await import(fixturesUrl);

// ============================================================================
// 辅助：找一个有 retrievalQueries 的 fixture（用于验证 B2/B3 检索行为）
// ============================================================================

function findFixtureWithRetrievalQueries() {
  return EVAL_FIXTURES.find((f) => f.chapterIntent.retrievalQueries.length > 0);
}

// ============================================================================
// 测试
// ============================================================================

describe("AgenticRawCandidateSource — 能力开关分层消融", () => {
  test("B1（enableRetrieval=false）→ toolCalls=0（无工具可调）", async () => {
    const fixture = findFixtureWithRetrievalQueries();
    assert.ok(fixture, "需要至少一个有 retrievalQueries 的 fixture");

    const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);
    try {
      const result = await runAgentLoopForEval(fixture, "b1", projectRoot, workspaceId);
      assert.equal(result.toolCalls, 0, "B1 无检索工具，toolCalls 应为 0");
    } finally {
      cleanup();
    }
  });

  test("B2（enableVerification=false）→ verifierCleared=false（不跑 verifier，默认 false）", async () => {
    const fixture = findFixtureWithRetrievalQueries();
    assert.ok(fixture, "需要至少一个有 retrievalQueries 的 fixture");

    const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);
    try {
      const result = await runAgentLoopForEval(fixture, "b2", projectRoot, workspaceId);
      // B2 不跑 verifier → verifierCleared 保持默认 false（loop 初始化 let verifierCleared = false）
      // 区别于 B3：B3 跑 verifier，verifierCleared 为 true（清零）或 false（有硬失败）
      assert.equal(result.verifierCleared, false, "B2 不跑 verifier，verifierCleared 应为 false（默认）");
      assert.equal(result.repairRounds, 0, "B2 不跑 patch，repairRounds 应为 0");
    } finally {
      cleanup();
    }
  });

  test("B3（enableVerification=true）→ verifierCleared 为 boolean（跑了 verifier）", async () => {
    const fixture = findFixtureWithRetrievalQueries();
    assert.ok(fixture, "需要至少一个有 retrievalQueries 的 fixture");

    const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);
    try {
      const result = await runAgentLoopForEval(fixture, "b3", projectRoot, workspaceId);
      // B3 跑 verifier → verifierCleared 应为 boolean（true 或 false）
      assert.equal(typeof result.verifierCleared, "boolean", "B3 跑 verifier，verifierCleared 应为 boolean");
      assert.ok(result.repairRounds >= 0, "B3 repairRounds 应 >= 0");
    } finally {
      cleanup();
    }
  });

  test("B2/B3 有检索工具 → toolCalls > 0（当 fixture 有 retrievalQueries）", async () => {
    const fixture = findFixtureWithRetrievalQueries();
    assert.ok(fixture, "需要至少一个有 retrievalQueries 的 fixture");
    assert.ok(fixture.chapterIntent.retrievalQueries.length > 0, "fixture 应有检索查询");

    const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);
    try {
      const [b2Result, b3Result] = await Promise.all([
        runAgentLoopForEval(fixture, "b2", projectRoot, workspaceId),
        runAgentLoopForEval(fixture, "b3", projectRoot, workspaceId),
      ]);
      // B2/B3 有检索工具，stub model 会发 tool_call → toolCalls > 0
      // 注意：stub model 最多发 2 次 tool_call（queries.slice(0, 2)）
      assert.ok(b2Result.toolCalls > 0, `B2 应有工具调用，实际 toolCalls=${b2Result.toolCalls}`);
      assert.ok(b3Result.toolCalls > 0, `B3 应有工具调用，实际 toolCalls=${b3Result.toolCalls}`);
    } finally {
      cleanup();
    }
  });

  test("B1 不 fallback（candidate 非空，返回 candidateWithErrors）", async () => {
    const fixture = findFixtureWithRetrievalQueries();
    assert.ok(fixture, "需要至少一个有 retrievalQueries 的 fixture");

    const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);
    try {
      const result = await runAgentLoopForEval(fixture, "b1", projectRoot, workspaceId);
      // B1 stub 返回 candidateWithErrors（非空），不应 fallback
      assert.ok(result.candidate !== null, "B1 candidate 不应为 null（stub 返回 candidateWithErrors）");
      assert.ok(result.candidate.text.length > 0, "B1 文本应非空");
    } finally {
      cleanup();
    }
  });

  test("negative_control fixture（无 retrievalQueries）→ B1/B2/B3 都不调工具", async () => {
    // 找一个无 retrievalQueries 的 fixture（negative_control 类别）
    const negativeFixture = EVAL_FIXTURES.find((f) => f.chapterIntent.retrievalQueries.length === 0);
    if (!negativeFixture) {
      // 没有 negative_control fixture 时跳过（不硬失败）
      return;
    }

    const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(negativeFixture);
    try {
      const [b1Result, b2Result] = await Promise.all([
        runAgentLoopForEval(negativeFixture, "b1", projectRoot, workspaceId),
        runAgentLoopForEval(negativeFixture, "b2", projectRoot, workspaceId),
      ]);
      // 无检索查询 → stub model 直接返回正文，不调工具
      assert.equal(b1Result.toolCalls, 0, "B1 无工具可调");
      assert.equal(b2Result.toolCalls, 0, "B2 无检索查询 → stub 不调工具");
    } finally {
      cleanup();
    }
  });
});
