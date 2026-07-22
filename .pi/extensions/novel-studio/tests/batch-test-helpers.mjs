/**
 * 批量章节生成测试共享 helpers。
 *
 * 提供：
 * - loadGenerateChapterTool：加载 dist/index.js，注册工具，返回 novel_generate_chapter 工具
 * - createBatchWorkspace：创建临时 workspace（config/characters/series/styles）
 * - createMockGenerateChapter：返回 mock 函数，模拟统一主链路写章节文件 + state store
 * - writeStateStoreEntry：向 narrative-state-store.json 追加 ch{N} 的 finalText-anchored entry
 * - cleanupWorkspace：删除临时 workspace
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = resolve(__dirname, "..");
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");

/**
 * 通过 fake PI 注册工具，返回 novel_generate_chapter 工具实例。
 */
export async function loadGenerateChapterTool() {
  const fakePi = {
    tools: new Map(),
    api: {
      registerTool(t) { fakePi.tools.set(t.name, t); },
      registerCommand() {},
      on() {},
    },
  };
  const novelStudioExtension = (await import(pathToFileURL(join(EXT_ROOT, "dist", "index.js")).href)).default;
  novelStudioExtension(fakePi.api);
  return fakePi.tools.get("novel_generate_chapter");
}

/**
 * 创建临时批量测试 workspace。
 * @param {string} workspaceId
 * @returns {string} workspacePath
 */
export function createBatchWorkspace(workspaceId) {
  const workspacePath = join(PROJECT_ROOT, "workspaces", workspaceId);
  rmSync(workspacePath, { recursive: true, force: true });
  mkdirSync(join(workspacePath, "chapters"), { recursive: true });
  mkdirSync(join(workspacePath, "characters"), { recursive: true });
  mkdirSync(join(workspacePath, "series"), { recursive: true });
  mkdirSync(join(workspacePath, "styles"), { recursive: true });
  mkdirSync(join(workspacePath, "traces"), { recursive: true });
  mkdirSync(join(workspacePath, "batch-jobs"), { recursive: true });

  const config = {
    name: `批量测试 ${workspaceId}`,
    genre: "玄幻",
    subGenres: ["东方玄幻"],
    totalChapters: 200,
    chapterType: "standard",
    styleProfile: "batch-test-author",
    serialFrequency: "daily",
    characters: [
      { id: "protagonist-1", name: "叶尘", role: "protagonist" },
    ],
    chapterSeeds: {
      default: {
        choicesAndCosts: [
          { choice: "公开接受传承", cost: "暴露自己已不再是普通少年" },
        ],
        expectedIrreversibleChange: ["叶尘接受传承后无法再维持原有身份"],
        causalEndPressure: ["传承被激活后引来追踪者"],
      },
    },
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(workspacePath, "config.json"), JSON.stringify(config, null, 2), "utf-8");

  writeFileSync(
    join(workspacePath, "series", "outline.md"),
    "# 大纲\n## 第1章\n故事开始。\n## 第2章\n传承觉醒。\n## 第3章\n追踪者来袭。\n",
    "utf-8",
  );

  writeFileSync(
    join(workspacePath, "characters", "叶尘.md"),
    "# 叶尘\n主角，废物少年，偶得传承。\n",
    "utf-8",
  );

  writeFileSync(
    join(workspacePath, "styles", "profile.json"),
    JSON.stringify({
      id: "batch-test-author",
      usagePolicy: { fullChapterOptimization: "required" },
      editorialGuidance: ["人物压力优先通过动作、停顿和环境变化呈现。"],
      characterVoiceGuidance: { 叶尘: ["少年感保留现实处境。"] },
    }, null, 2),
    "utf-8",
  );

  return workspacePath;
}

/**
 * 计算 SHA-256 前 12 位（与 workspace-preflight-checker.ts 一致）。
 */
function hash12(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

/**
 * 向 narrative-state-store.json 追加 ch{chapterNumber} 的 finalText-anchored entry。
 * 如果文件不存在则创建。
 */
export function writeStateStoreEntry(workspacePath, chapterNumber, chapterText) {
  const stateStorePath = join(workspacePath, "narrative-state-store.json");
  let store = { workspaceId: "", canon: [], character: [], promise: [], pattern: [], expectation: [] };
  if (existsSync(stateStorePath)) {
    try {
      store = JSON.parse(readFileSync(stateStorePath, "utf-8"));
      if (!store.canon) store.canon = [];
      if (!store.character) store.character = [];
      if (!store.promise) store.promise = [];
      if (!store.pattern) store.pattern = [];
      if (!store.expectation) store.expectation = [];
    } catch {
      // 覆盖损坏的 store
    }
  }

  const chapterId = `ch${chapterNumber}`;
  const hash = hash12(chapterText);
  const entry = {
    sourceChapter: chapterId,
    sourceRef: `${chapterId}#finalText:${hash}`,
    content: `第${chapterNumber}章状态提交`,
    timestamp: new Date().toISOString(),
  };
  store.canon.push(entry);
  store.workspaceId = store.workspaceId || "";

  writeFileSync(stateStorePath, JSON.stringify(store, null, 2), "utf-8");
}

/**
 * 创建 mock generateChapter 函数。
 *
 * 行为：
 * - 写 chapters/{N}.md 文件
 * - 写 narrative-state-store.json 的 ch{N} finalText-anchored entry
 * - 返回 {status: "ok", stageResults: {stateCommit: {ok: true}, modelCallCount: 1}}
 *
 * @param {object} options
 * @param {string} options.workspacePath
 * @param {number[]} options.failOnChapters - 失败的章节号列表
 * @param {boolean} options.skipStateStore - 不写 state store（模拟 FinalStateCommit 失败）
 * @param {boolean} options.skipChapterFile - 不写章节文件（模拟 AtomicSave 失败）
 * @returns {function} mock function with .calls array
 */
export function createMockGenerateChapter(options = {}) {
  const {
    workspacePath,
    failOnChapters = [],
    skipStateStore = false,
    skipChapterFile = false,
  } = options;

  const mock = async function mockGenerateChapter(input) {
    const { chapterNumber } = input;
    mock.calls.push({ ...input, timestamp: Date.now() });

    // 失败章节
    if (failOnChapters.includes(chapterNumber)) {
      return {
        status: "error",
        workspaceId: input.workspaceId,
        chapterId: String(chapterNumber),
        chapterNumber,
        failureEnvelope: {
          stage: "mock_chapter",
          severity: "error",
          reason: `mock failure on chapter ${chapterNumber}`,
          recoverable: false,
        },
        stageResults: {},
      };
    }

    // 成功：写章节文件
    const chapterText = `# 第${chapterNumber}章\n\n这是第${chapterNumber}章的正文内容。`;
    if (!skipChapterFile) {
      const chapterFile = join(workspacePath, "chapters", `${chapterNumber}.md`);
      writeFileSync(chapterFile, chapterText, "utf-8");
    }

    // 写 state store entry
    if (!skipStateStore) {
      writeStateStoreEntry(workspacePath, chapterNumber, chapterText);
    }

    return {
      status: "ok",
      workspaceId: input.workspaceId,
      chapterId: String(chapterNumber),
      chapterNumber,
      text: chapterText,
      stageResults: {
        stateCommit: { ok: !skipStateStore },
        stateCommitError: skipStateStore ? true : undefined,
        modelCallCount: 1,
        unifiedPipeline: true,
        productionFlow: { mode: "agentic_style_full_pipeline", machineJudgeCalled: false },
      },
    };
  };

  mock.calls = [];
  return mock;
}

/**
 * 删除临时 workspace。
 */
export function cleanupWorkspace(workspaceId) {
  const workspacePath = join(PROJECT_ROOT, "workspaces", workspaceId);
  rmSync(workspacePath, { recursive: true, force: true });
}

export { PROJECT_ROOT, EXT_ROOT };
