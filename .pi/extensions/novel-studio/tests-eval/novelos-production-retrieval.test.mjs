/**
 * NovelOS 生产 ranked retrieval 接线测试（P0-1）
 *
 * 验证评测器不再绕过工具协议直接调 searchRanked()，而是从 B2 agent loop 的
 * trajectory 中提取模型实际看到的 ranked_evidence 条目来证明检索增益。
 *
 * 核心断言：
 * - evalEndToEnd 返回 b2TrajectoryPath 且文件存在
 * - evalRetrieval 从 trajectory 提取 evidence → viaToolProtocol === true
 * - b2FactsFound > 0（trajectory 含 ranked_evidence 且覆盖预期事实）
 * - 反向测试：传 undefined trajectory → viaToolProtocol === false、b2FactsFound === 0
 * - 删除 trajectory 文件后 → viaToolProtocol === false（不回退到直接调 searchRanked）
 *
 * 测试从 dist/ 导入构建产物（与现有 novelos-*.test.mjs 一致）。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
// novelos/eval/* 模块是 dormant-from-prod（PROD-BUILD-BOUNDARY-1 后退出生产构建），
// 只存在于 dist-eval/novelos/eval/。生产 dist/novelos/ 不含 eval 子目录。
const DIST_ROOT = join(EXTENSION_ROOT, "dist-eval");

const evalHarnessUrl = pathToFileURL(
  join(DIST_ROOT, "novelos", "eval", "eval-harness.js"),
).href;
const fixturesUrl = pathToFileURL(
  join(DIST_ROOT, "novelos", "eval", "fixtures.js"),
).href;

const { setupFixtureWorkspace, evalRetrieval, evalEndToEnd } = await import(evalHarnessUrl);
const { EVAL_FIXTURES } = await import(fixturesUrl);

// ============================================================================
// 测试
// ============================================================================

describe("NovelOS 生产 ranked retrieval 接线（P0-1）", () => {
  test("evalEndToEnd 返回 b2TrajectoryPath 且文件存在（F1）", async () => {
    const fixture = EVAL_FIXTURES[0]; // F1-historical-fact
    const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);
    try {
      const e2eResult = await evalEndToEnd(fixture, projectRoot, workspaceId);
      assert.ok(
        typeof e2eResult.b2TrajectoryPath === "string",
        "b2TrajectoryPath 应为 string",
      );
      assert.ok(
        e2eResult.b2TrajectoryPath.length > 0,
        "b2TrajectoryPath 不应为空字符串",
      );
      assert.ok(
        existsSync(e2eResult.b2TrajectoryPath),
        `trajectory 文件应存在：${e2eResult.b2TrajectoryPath}`,
      );
    } finally {
      cleanup();
    }
  });

  test("evalRetrieval 从 trajectory 提取 evidence → viaToolProtocol === true", async () => {
    const fixture = EVAL_FIXTURES[0]; // F1-historical-fact
    const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);
    try {
      const e2eResult = await evalEndToEnd(fixture, projectRoot, workspaceId);
      const retrievalResult = evalRetrieval(
        fixture,
        projectRoot,
        workspaceId,
        e2eResult.b2TrajectoryPath,
      );
      assert.equal(
        retrievalResult.viaToolProtocol,
        true,
        "trajectory 含 ranked_evidence → viaToolProtocol 应为 true",
      );
      assert.ok(
        retrievalResult.b2FactsFound > 0,
        `b2FactsFound 应 > 0（trajectory 含覆盖预期事实的 ranked evidence），实际：${retrievalResult.b2FactsFound}`,
      );
    } finally {
      cleanup();
    }
  });

  test("传 undefined trajectory → viaToolProtocol === false、b2FactsFound === 0（不回退到直接调 searchRanked）", () => {
    const fixture = EVAL_FIXTURES[0]; // F1-historical-fact
    const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);
    try {
      const retrievalResult = evalRetrieval(fixture, projectRoot, workspaceId, undefined);
      assert.equal(
        retrievalResult.viaToolProtocol,
        false,
        "undefined trajectory → viaToolProtocol 应为 false",
      );
      assert.equal(
        retrievalResult.b2FactsFound,
        0,
        "undefined trajectory → b2FactsFound 应为 0（不回退到直接调 searchRanked）",
      );
    } finally {
      cleanup();
    }
  });

  test("删除 trajectory 文件后 → viaToolProtocol === false", async () => {
    const fixture = EVAL_FIXTURES[0]; // F1-historical-fact
    const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);
    try {
      const e2eResult = await evalEndToEnd(fixture, projectRoot, workspaceId);
      // 删除 trajectory 文件
      if (existsSync(e2eResult.b2TrajectoryPath)) {
        rmSync(e2eResult.b2TrajectoryPath, { force: true });
      }
      const retrievalResult = evalRetrieval(
        fixture,
        projectRoot,
        workspaceId,
        e2eResult.b2TrajectoryPath,
      );
      assert.equal(
        retrievalResult.viaToolProtocol,
        false,
        "trajectory 文件被删 → viaToolProtocol 应为 false",
      );
      assert.equal(
        retrievalResult.b2FactsFound,
        0,
        "trajectory 文件被删 → b2FactsFound 应为 0",
      );
    } finally {
      cleanup();
    }
  });

  test("runFullEval 集成：retrievalResults 中出现 viaToolProtocol === true 的 fixture", async () => {
    // 导入 runFullEval
    const { runFullEval } = await import(evalHarnessUrl);
    // 只跑 F1（有历史章节和 canon 事实，会触发检索）
    const report = await runFullEval([EVAL_FIXTURES[0]]);
    const f1Retrieval = report.retrievalResults.find((r) => r.fixtureId === "F1-historical-fact");
    assert.ok(f1Retrieval, "F1 retrieval 结果应存在");
    assert.equal(
      f1Retrieval.viaToolProtocol,
      true,
      "F1 通过 runFullEval 集成跑出来的 retrieval 应 viaToolProtocol === true（证明生产 agent loop trajectory 中有 ranked evidence）",
    );
  });
});
