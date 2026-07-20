/**
 * P0-4 FULL-PIPELINE-PREVIEW-1 — 完整链路只读预览模式（RED 测试先行）
 *
 * 任务卡（delete/任务列表/项目优化20260718.md P0-4）：
 *   - 新增 `fullPipelinePreview=true` 模式
 *   - 必须执行：Raw → FactGuard → EditorialOpportunity → EditorialCandidate 0-2
 *              → 中文校准候选 → PairwiseJudge → SelectionPolicy → SpanRepair
 *              → FinalFactRecheck
 *   - 必须跳过：正式章节保存 / NarrativeState commit / 用户正式接受 / 后置长期状态更新
 *   - 不允许复用现有"FactGuard 后直接返回"的 `previewOnly` 行为
 *
 * 验收：
 *   1. trace 包含 raw、opportunity、candidate、judge、selection
 *   2. 返回 raw 和所有候选，但明确标出最终选择
 *   3. 文件及状态哈希在运行前后完全一致
 *   4. 不允许复用现有"FactGuard 后直接返回"的 previewOnly 行为
 *
 * 本测试为 RED：当前实现下应失败（previewOnly 短路 + 无 fullPipelinePreview 字段 + 写盘未跳过）。
 * GREEN 实现后全部通过。
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
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = resolve(__dirname, "..");
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");

const TEST_WORKSPACE_ID = "full-pipeline-preview-test";
const TEST_WORKSPACE = join(PROJECT_ROOT, "workspaces", TEST_WORKSPACE_ID);

/**
 * 递归快照目录下所有文件（相对路径 -> sha256）。
 * 用于"运行前后文件哈希一致"校验。
 */
function snapshotWorkspaceFiles(rootDir) {
  const snapshots = {};
  if (!existsSync(rootDir)) return snapshots;
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const rel = fullPath.slice(rootDir.length).replace(/^[\\/]/, "");
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else {
        const content = readFileSync(fullPath);
        snapshots[rel] = createHash("sha256").update(content).digest("hex");
      }
    }
  }
  walk(rootDir);
  return snapshots;
}

function createMinimalWorkspace() {
  rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  mkdirSync(join(TEST_WORKSPACE, "chapters"), { recursive: true });
  mkdirSync(join(TEST_WORKSPACE, "characters"), { recursive: true });
  mkdirSync(join(TEST_WORKSPACE, "series"), { recursive: true });

  const config = {
    name: "Full Pipeline Preview Test",
    genre: "玄幻",
    subGenres: ["都市异能"],
    totalChapters: 50,
    chapterType: "standard",
    characters: [{ id: "p1", name: "李一凡", role: "protagonist" }],
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

describe("P0-4 FULL-PIPELINE-PREVIEW-1", () => {
  let originalStubFlag;

  before(() => {
    originalStubFlag = process.env.V2_FORCE_STUB;
    createMinimalWorkspace();
  });

  after(() => {
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
    if (originalStubFlag === undefined) {
      delete process.env.V2_FORCE_STUB;
    } else {
      process.env.V2_FORCE_STUB = originalStubFlag;
    }
  });

  beforeEach(() => {
    // stub 模型（无真实 API 调用）
    process.env.V2_FORCE_STUB = "1";
  });

  afterEach(() => {
    delete process.env.V2_FORCE_STUB;
  });

  // ─── 验收 4：不允许复用现有"FactGuard 后直接返回"的 previewOnly 行为 ───
  it("fullPipelinePreview=true 时 editorialOpportunity 必须执行（不复用 FactGuard 短路）", async () => {
    const { runUnifiedPipeline } = await import(
      pathToFileURL(join(EXT_ROOT, "dist", "v2", "core", "unified-entry.js")).href
    );

    const result = await runUnifiedPipeline({
      workspaceId: TEST_WORKSPACE_ID,
      chapterId: "preview-test-1",
      chapterNumber: 1,
      projectRoot: PROJECT_ROOT,
      fullPipelinePreview: true,
    });

    const stageResults = result.stageResults || {};

    // 关键断言：editorialOpportunity 必须存在，证明编排器没有在 FactGuard 后直接返回
    assert.ok(
      stageResults.editorialOpportunity,
      "fullPipelinePreview=true 时 editorialOpportunity 必须执行；" +
        "当前缺失，说明复用了旧的 previewOnly FactGuard 后直接返回短路",
    );

    // raw 阶段也必须存在
    assert.ok(
      stageResults.rawGeneration,
      "fullPipelinePreview=true 时 rawGeneration 必须执行",
    );

    // commitAndSave 必须明确跳过，且 reason 标识为 fullPipelinePreview
    assert.ok(
      stageResults.commitAndSave?.skipped === true,
      "commitAndSave 必须明确标记为 skipped",
    );
    assert.equal(
      stageResults.commitAndSave?.reason,
      "fullPipelinePreview",
      `commitAndSave.reason 必须为 "fullPipelinePreview"，实际: ${stageResults.commitAndSave?.reason}`,
    );
  });

  // ─── 验收 1：trace 包含 raw/opportunity/candidate/judge/selection ───
  it("fullPipelinePreview=true 时 trace 包含 raw/opportunity/candidate/judge/selection", async () => {
    const { runUnifiedPipeline } = await import(
      pathToFileURL(join(EXT_ROOT, "dist", "v2", "core", "unified-entry.js")).href
    );

    const result = await runUnifiedPipeline({
      workspaceId: TEST_WORKSPACE_ID,
      chapterId: "preview-test-2",
      chapterNumber: 2,
      projectRoot: PROJECT_ROOT,
      fullPipelinePreview: true,
      seed: 1, // REAL-QUALITY-1-PREFLIGHT：seed=1 时 sample≈0.6271，策略被选中→可能生成 editorial 候选
    });

    const stageResults = result.stageResults || {};

    // raw 阶段
    assert.ok(stageResults.rawGeneration, "trace 必须含 rawGeneration 阶段");

    // opportunity 阶段
    assert.ok(
      stageResults.editorialOpportunity,
      "trace 必须含 editorialOpportunity 阶段",
    );

    // candidate 阶段：editorialCandidateGeneration 字段或 candidates 数组（含 editorial_amplified）
    const hasCandidateStage =
      stageResults.editorialCandidateGeneration ||
      (result.candidates && result.candidates.some((c) => c.kind === "editorial_amplified"));
    assert.ok(
      hasCandidateStage,
      "trace 必须含 candidate 阶段（editorialCandidateGeneration 字段或 candidates 含 editorial_amplified）",
    );

    // judge 阶段：如有 editorial 候选，必须有 judgeArbitration
    const editorialCandidates = (result.candidates || []).filter(
      (c) => c.kind === "editorial_amplified",
    );
    if (editorialCandidates.length > 0) {
      assert.ok(
        stageResults.judgeArbitration,
        "有 editorial 候选时 trace 必须含 judgeArbitration 阶段",
      );
    }

    // selection 阶段
    assert.ok(
      stageResults.finalSelection,
      "trace 必须含 finalSelection 阶段",
    );
  });

  // ─── 验收 2：返回 raw 和所有候选，但明确标出最终选择 ───
  it("fullPipelinePreview=true 时返回 raw 文本、候选数组、最终选择标记、isPreviewRun=true", async () => {
    const { runUnifiedPipeline } = await import(
      pathToFileURL(join(EXT_ROOT, "dist", "v2", "core", "unified-entry.js")).href
    );

    const result = await runUnifiedPipeline({
      workspaceId: TEST_WORKSPACE_ID,
      chapterId: "preview-test-3",
      chapterNumber: 3,
      projectRoot: PROJECT_ROOT,
      fullPipelinePreview: true,
      seed: 1,
    });

    // 返回 raw 或 editorial 文本
    assert.ok(
      typeof result.text === "string" && result.text.length > 0,
      "必须返回非空 finalText（raw 或 selected editorial）",
    );

    // 返回候选数组（至少含 raw 候选；可能为空数组但字段必须存在）
    assert.ok(
      Array.isArray(result.candidates),
      "必须返回 candidates 数组（即便无 editorial 机会也应有 raw 候选或空数组）",
    );

    // 明确标出最终选择
    assert.ok(
      result.selectedSource === "raw" || result.selectedSource === "editorial",
      `selectedSource 必须为 "raw" 或 "editorial"，实际: ${result.selectedSource}`,
    );
    assert.ok(
      typeof result.selectedCandidateId === "string" && result.selectedCandidateId.length > 0,
      "必须返回非空 selectedCandidateId",
    );

    // 预览运行标记
    assert.equal(
      result.isPreviewRun,
      true,
      "必须设置 isPreviewRun=true 标记（区分正式生成与预览运行）",
    );
  });

  // ─── 验收 3：文件及状态哈希在运行前后完全一致 ───
  it("fullPipelinePreview=true 时文件及状态哈希在运行前后完全一致", async () => {
    const { runUnifiedPipeline } = await import(
      pathToFileURL(join(EXT_ROOT, "dist", "v2", "core", "unified-entry.js")).href
    );

    // 运行前快照
    const beforeSnapshot = snapshotWorkspaceFiles(TEST_WORKSPACE);

    await runUnifiedPipeline({
      workspaceId: TEST_WORKSPACE_ID,
      chapterId: "preview-test-4",
      chapterNumber: 4,
      projectRoot: PROJECT_ROOT,
      fullPipelinePreview: true,
      seed: 1,
    });

    // 运行后快照
    const afterSnapshot = snapshotWorkspaceFiles(TEST_WORKSPACE);

    // 不允许新增文件（trace/quality-evidence-report/strategy-policy.json/blocked-candidate-evidence.json 等）
    const newFiles = Object.keys(afterSnapshot).filter((p) => !beforeSnapshot[p]);
    assert.equal(
      newFiles.length,
      0,
      "运行后不应新增任何文件（trace/strategy-policy/quality-evidence/blocked-evidence 等都不能写）；" +
        `实际新增: ${newFiles.join(", ")}`,
    );

    // 不允许修改现有文件
    const modifiedFiles = Object.keys(afterSnapshot).filter(
      (p) => beforeSnapshot[p] && beforeSnapshot[p] !== afterSnapshot[p],
    );
    assert.equal(
      modifiedFiles.length,
      0,
      "运行后不应修改任何现有文件；" +
        `实际修改: ${modifiedFiles.join(", ")}`,
    );
  });

  // ─── 验收 4（细化）：previewOnly=true 旧字段必须等价于 fullPipelinePreview=true ───
  // 不允许再触发旧的"FactGuard 后直接返回"短路
  it("previewOnly=true 旧字段必须等价于 fullPipelinePreview=true（不再短路 FactGuard）", async () => {
    const { runUnifiedPipeline } = await import(
      pathToFileURL(join(EXT_ROOT, "dist", "v2", "core", "unified-entry.js")).href
    );

    const result = await runUnifiedPipeline({
      workspaceId: TEST_WORKSPACE_ID,
      chapterId: "preview-test-5",
      chapterNumber: 5,
      projectRoot: PROJECT_ROOT,
      previewOnly: true, // 旧字段
    });

    const stageResults = result.stageResults || {};

    // editorialOpportunity 必须存在，证明旧的 FactGuard 后直接返回短路已被移除
    assert.ok(
      stageResults.editorialOpportunity,
      "previewOnly=true 旧字段不应触发 FactGuard 后直接返回短路；" +
        "应等价于 fullPipelinePreview=true，运行完整链路",
    );

    // commitAndSave 也必须跳过（向后兼容）
    assert.ok(
      stageResults.commitAndSave?.skipped === true,
      "previewOnly=true 仍应跳过 commitAndSave（向后兼容）",
    );

    // isPreviewRun 也应设置
    assert.equal(
      result.isPreviewRun,
      true,
      "previewOnly=true 也应设置 isPreviewRun=true 标记",
    );
  });
});
