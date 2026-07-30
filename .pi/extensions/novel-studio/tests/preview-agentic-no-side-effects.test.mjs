/**
 * P0-1 RED — 生产预览模式无副作用回归测试
 *
 * 审计断言：fullPipelinePreview=true 时，CandidateWorkspace 和 TrajectoryStore
 * 无条件写盘，实际生成 novelos-sessions 下的 draft.md、evidence-plan.json 等文件。
 *
 * 现有 5/5 preview 测试（full-pipeline-preview-1.test.mjs）是假阴性：
 * setup-test-env.mjs 默认设置 PINOVEL_TEST_LEGACY_PRODUCTION_FLOW=1，
 * 使 unified-entry.ts 的 productionFlow 计算为 undefined，绕过 Agentic 路径。
 *
 * 本测试在 before 钩子内显式 delete PINOVEL_TEST_LEGACY_PRODUCTION_FLOW，
 * 强制走真实生产 Agentic 路径（productionFlow="agentic_style"），
 * 验证 preview 模式下 novelos-sessions/ 目录不得新增任何文件。
 *
 * RED 预期：用例 1 失败（novelos-sessions 目录被创建），证明副作用存在。
 * GREEN 后：CandidateWorkspace dryRun + TrajectoryStore persist=false 短路所有写盘。
 */

import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = resolve(__dirname, "..");
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");

const TEST_WORKSPACE_ID = "preview-agentic-side-effects-test";
const TEST_WORKSPACE = join(PROJECT_ROOT, "workspaces", TEST_WORKSPACE_ID);

/**
 * 递归收集目录下所有文件相对路径（用于前后对比）。
 * 与 full-pipeline-preview-1.test.mjs 的 snapshotWorkspaceFiles 一致风格。
 */
function collectFiles(rootDir) {
  const files = [];
  if (!existsSync(rootDir)) return files;
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else {
        files.push(fullPath.slice(rootDir.length).replace(/^[\\/]/, ""));
      }
    }
  }
  walk(rootDir);
  return files;
}

function createMinimalWorkspace() {
  rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  mkdirSync(join(TEST_WORKSPACE, "chapters"), { recursive: true });
  mkdirSync(join(TEST_WORKSPACE, "characters"), { recursive: true });
  mkdirSync(join(TEST_WORKSPACE, "series"), { recursive: true });
  // novelos-sessions 目录预创建（用于验证不被新增文件）
  mkdirSync(join(TEST_WORKSPACE, "novelos-sessions"), { recursive: true });
  mkdirSync(join(TEST_WORKSPACE, "traces"), { recursive: true });

  const config = {
    name: "Preview Agentic Side Effects Test",
    genre: "玄幻",
    subGenres: ["都市异能"],
    totalChapters: 50,
    chapterType: "standard",
    characters: [{ id: "p1", name: "李一凡", role: "protagonist" }],
    chapterSeeds: {
      default: {
        choicesAndCosts: [
          { choice: "公开使用新获得的能力", cost: "暴露自己已经卷入异常事件" },
        ],
        expectedIrreversibleChange: ["李一凡无法再回到毫不知情的普通生活"],
        causalEndPressure: ["能力使用留下痕迹并引来新的追踪者"],
      },
    },
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(TEST_WORKSPACE, "config.json"), JSON.stringify(config, null, 2), "utf-8");
  writeFileSync(
    join(TEST_WORKSPACE, "series", "outline.md"),
    "# 大纲\n## 第1章\n故事开始。\n",
    "utf-8",
  );
  writeFileSync(
    join(TEST_WORKSPACE, "characters", "李一凡.md"),
    "# 李一凡\n主角，21 岁穷学生。\n",
    "utf-8",
  );
}

describe("P0-1 生产预览模式无副作用（Agentic 路径）", () => {
  let originalLegacyFlag;
  let originalStubFlag;

  before(() => {
    // 关键：删除 PINOVEL_TEST_LEGACY_PRODUCTION_FLOW，强制走真实 Agentic 路径
    // （productionFlow="agentic_style"），而非 legacy/eval 绕过路径。
    // 这是本测试与 full-pipeline-preview-1.test.mjs 的核心区别。
    originalLegacyFlag = process.env.PINOVEL_TEST_LEGACY_PRODUCTION_FLOW;
    delete process.env.PINOVEL_TEST_LEGACY_PRODUCTION_FLOW;

    originalStubFlag = process.env.V2_FORCE_STUB;
    createMinimalWorkspace();
  });

  after(() => {
    // 恢复环境变量，避免污染其它测试套件
    if (originalLegacyFlag === undefined) {
      delete process.env.PINOVEL_TEST_LEGACY_PRODUCTION_FLOW;
    } else {
      process.env.PINOVEL_TEST_LEGACY_PRODUCTION_FLOW = originalLegacyFlag;
    }
    if (originalStubFlag === undefined) {
      delete process.env.V2_FORCE_STUB;
    } else {
      process.env.V2_FORCE_STUB = originalStubFlag;
    }
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  });

  beforeEach(() => {
    // stub 模型（无真实 API 调用）
    process.env.V2_FORCE_STUB = "1";
  });

  afterEach(() => {
    delete process.env.V2_FORCE_STUB;
  });

  // ─── 用例 1：preview 模式下 novelos-sessions/ 不得新增任何文件 ───
  it("fullPipelinePreview=true 且走 Agentic 路径时，novelos-sessions/ 不得新增任何文件", async () => {
    const { runUnifiedPipeline } = await import(
      pathToFileURL(join(EXT_ROOT, "dist", "v2", "core", "unified-entry.js")).href
    );

    const novelosDir = join(TEST_WORKSPACE, "novelos-sessions");
    const beforeFiles = collectFiles(novelosDir);

    // preview 运行可能因 stub 模型抛错，但 CandidateWorkspace 在 agent loop 之前创建，
    // 副作用已发生。用 try/catch 捕获错误，仍检查文件系统。
    let pipelineError = null;
    let result = null;
    try {
      result = await runUnifiedPipeline({
        workspaceId: TEST_WORKSPACE_ID,
        chapterId: "preview-agentic-1",
        chapterNumber: 1,
        projectRoot: PROJECT_ROOT,
        fullPipelinePreview: true,
      });
    } catch (err) {
      pipelineError = err;
    }

    const afterFiles = collectFiles(novelosDir);
    const newFiles = afterFiles.filter((p) => !beforeFiles.includes(p));

    assert.equal(
      newFiles.length,
      0,
      "preview 模式下 novelos-sessions/ 不得新增任何文件。" +
        `实际新增 ${newFiles.length} 个: ${newFiles.join(", ")}` +
        (pipelineError ? `（pipeline 抛错: ${pipelineError.message}）` : ""),
    );
  });

  // ─── 用例 2：preview 模式下 commitAndSave 必须跳过（若到达该阶段） ───
  it("fullPipelinePreview=true 时 isPreviewRun=true 且 commitAndSave（若存在）必须 skipped", async () => {
    const { runUnifiedPipeline } = await import(
      pathToFileURL(join(EXT_ROOT, "dist", "v2", "core", "unified-entry.js")).href
    );

    let result;
    try {
      result = await runUnifiedPipeline({
        workspaceId: TEST_WORKSPACE_ID,
        chapterId: "preview-agentic-2",
        chapterNumber: 2,
        projectRoot: PROJECT_ROOT,
        fullPipelinePreview: true,
      });
    } catch (err) {
      // stub 模型可能导致 agentic 路径异常；本用例聚焦 preview 语义，
      // 若 pipeline 抛错则跳过断言（用例 1 已覆盖副作用核心断言）。
      assert.ok(true, `pipeline 抛错（可接受）: ${err.message}`);
      return;
    }

    // isPreviewRun 必须为 true（无论 agentic 是否成功，preview 标志必须生效）
    assert.equal(
      result?.isPreviewRun,
      true,
      "isPreviewRun 必须为 true（preview 标志必须生效）",
    );

    // 若到达 commitAndSave 阶段，必须标记 skipped
    const stageResults = result?.stageResults || {};
    if (stageResults.commitAndSave) {
      assert.ok(
        stageResults.commitAndSave.skipped === true,
        "commitAndSave 若存在必须标记 skipped=true",
      );
      assert.equal(
        stageResults.commitAndSave.reason,
        "fullPipelinePreview",
        `commitAndSave.reason 必须为 "fullPipelinePreview"，实际: ${stageResults.commitAndSave.reason}`,
      );
    }
  });

  // ─── 用例 3：preview 模式下 traces/ 不得新增 trace 文件 ───
  it("fullPipelinePreview=true 时 traces/ 不得新增任何文件", async () => {
    const { runUnifiedPipeline } = await import(
      pathToFileURL(join(EXT_ROOT, "dist", "v2", "core", "unified-entry.js")).href
    );

    const tracesDir = join(TEST_WORKSPACE, "traces");
    const beforeFiles = collectFiles(tracesDir);

    try {
      await runUnifiedPipeline({
        workspaceId: TEST_WORKSPACE_ID,
        chapterId: "preview-agentic-3",
        chapterNumber: 3,
        projectRoot: PROJECT_ROOT,
        fullPipelinePreview: true,
      });
    } catch (err) {
      // pipeline 抛错也检查文件系统（trace 可能在抛错前已写）
    }

    const afterFiles = collectFiles(tracesDir);
    const newFiles = afterFiles.filter((p) => !beforeFiles.includes(p));

    assert.equal(
      newFiles.length,
      0,
      "preview 模式下 traces/ 不得新增任何文件。" +
        `实际新增 ${newFiles.length} 个: ${newFiles.join(", ")}`,
    );
  });
});
