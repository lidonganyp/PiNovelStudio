/**
 * 批量章节生成测试共享 helpers。
 *
 * 提供：
 * - loadGenerateChapterTool：加载 dist/index.js，注册工具，返回 novel_generate_chapter 工具
 * - createBatchWorkspace：创建临时 workspace（config/characters/series/styles）
 * - createMockGenerateChapter：返回 mock 函数，模拟统一主链路写章节文件 + state store
 * - writeStateStoreEntry：向 narrative-state-store.json 追加 ch{N} 的 finalText-anchored entry
 * - writeContinuitySnapshot：写 chapter-continuity/{N}.json 快照（模拟 commitAndSave P1-F）
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

  // 批量编排测试的默认作者种子。自动章节契约拆分已退役，成功路径必须显式具备
  // ChapterSeedBuilder 实际消费的 ch{startChapter}-outline-explicit.md。
  writeFileSync(
    join(workspacePath, "series", "ch1-outline-explicit.md"),
    "# 第1章 作者测试种子\n\n## 事件 1：接受传承\n\n- **内容摘要**：叶尘在现实压力下选择接受传承，并因此暴露身份。\n- **参与角色**：叶尘\n- **本章功能**：setup\n- **章末目标**：追踪者察觉传承被激活\n",
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
  // P1-E：模拟真实 FinalStateCommit.commit() 设置 lastCommittedChapter
  store.lastCommittedChapter = chapterId;

  writeFileSync(stateStorePath, JSON.stringify(store, null, 2), "utf-8");
}

/**
 * 写 chapter-continuity/{N}.json 连续性快照（模拟 commitAndSave P1-F 的
 * writeChapterContinuitySnapshot 调用）。
 *
 * 默认快照含空 openHooks/introducedCharacters/unresolvedTensions（匹配旧行为）。
 * 测试可通过 snapshotOverride 注入特定钩子，用于验证跨章传递。
 *
 * @param {string} workspacePath
 * @param {number} chapterNumber
 * @param {string} chapterText - 用于计算 lastEventSummary 和 finalTextHash
 * @param {object} [snapshotOverride] - 覆盖默认空数组（如 { openHooks: ["X"] }）
 */
export function writeContinuitySnapshot(workspacePath, chapterNumber, chapterText, snapshotOverride) {
  const snapshotDir = join(workspacePath, "chapter-continuity");
  if (!existsSync(snapshotDir)) {
    mkdirSync(snapshotDir, { recursive: true });
  }
  const maxChars = 1200;
  let lastEventSummary = chapterText.length > maxChars
    ? chapterText.slice(-maxChars)
    : chapterText;
  if (chapterText.length > maxChars) {
    const paragraphBreak = lastEventSummary.indexOf("\n\n");
    if (paragraphBreak >= 0 && paragraphBreak < 320) {
      lastEventSummary = lastEventSummary.slice(paragraphBreak + 2);
    }
  }
  const snapshot = {
    chapterNumber,
    openHooks: snapshotOverride?.openHooks ?? [],
    introducedCharacters: snapshotOverride?.introducedCharacters ?? [],
    unresolvedTensions: snapshotOverride?.unresolvedTensions ?? [],
    lastEventSummary,
    finalTextHash: hash12(chapterText),
    sourceRefs: snapshotOverride?.sourceRefs ?? [],
    createdAt: new Date().toISOString(),
  };
  const snapshotPath = join(snapshotDir, `${chapterNumber}.json`);
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");
}

/**
 * 创建 mock generateChapter 函数。
 *
 * 行为：
 * - 写 chapters/{N}.md 文件
 * - 写 narrative-state-store.json 的 ch{N} finalText-anchored entry
 * - 写 chapter-continuity/{N}.json 连续性快照（模拟 commitAndSave P1-F）
 * - 返回 {status: "ok", stageResults: {stateCommit: {committed, rejected}, modelCallCount: 1}}
 *
 * @param {object} options
 * @param {string} options.workspacePath
 * @param {number[]} options.failOnChapters - 失败的章节号列表
 * @param {boolean} options.skipStateStore - 不写 state store（模拟 FinalStateCommit 失败）
 * @param {boolean} options.skipChapterFile - 不写章节文件（模拟 AtomicSave 失败）
 * @param {boolean} options.skipContinuitySnapshot - 不写连续性快照（模拟 P1-F 写入失败）
 * @param {Object.<number, object>} [options.chapterSnapshots] - 按章节号覆盖快照内容
 *   （如 { 1: { openHooks: ["UNIQUE_HOOK"] } }）；未覆盖的章节写空快照
 * @returns {function} mock function with .calls array
 */
export function createMockGenerateChapter(options = {}) {
  const {
    workspacePath,
    failOnChapters = [],
    skipStateStore = false,
    skipChapterFile = false,
    skipContinuitySnapshot = false,
    chapterSnapshots = {},
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

    // P1-F：写连续性快照（模拟 commitAndSave 的 writeChapterContinuitySnapshot 调用）
    if (!skipContinuitySnapshot) {
      writeContinuitySnapshot(
        workspacePath,
        chapterNumber,
        chapterText,
        chapterSnapshots[chapterNumber],
      );
    }

    return {
    status: "ok",
    workspaceId: input.workspaceId,
    chapterId: String(chapterNumber),
    chapterNumber,
    text: chapterText,
    stageResults: {
      // P1-E：与真实 commitAndSave 输出对齐——无 ok 字段，用 committed/rejected/error
      stateCommit: skipStateStore
        ? { error: "mock: state store not written", committed: 0, rejected: 0 }
        : { committed: 1, rejected: 0 },
      stateCommitError: skipStateStore ? true : undefined,
      // P1-F：连续性快照写入标记
      continuitySnapshot: skipContinuitySnapshot
        ? { ok: false, error: "mock: snapshot not written" }
        : { ok: true, advisoryCache: true },
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
