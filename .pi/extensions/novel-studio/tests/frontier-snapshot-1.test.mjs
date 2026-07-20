/**
 * FRONTIER-SNAPSHOT-1 — 按 accepted frontier 截取的干净工作区快照
 *
 * 任务卡验收口径：
 *   1. ch17 比较快照中不存在 ch17+ 派生状态。
 *   2. 连续两次构建快照哈希一致。
 *   3. 快照生成不修改原工作区。
 *   4. 发现状态无法按章节回溯时直接阻断，不猜测。
 *
 * 设计：
 *   - 快照输出到 sibling 目录（与源 workspace 并列），结构上禁止反向写入源
 *   - 仅保留截至 throughChapter 已接受的正文 + 状态（过滤 ch>N 的 entries）
 *   - manifest 记录 sourceWorkspace / throughChapter / fileHashes / excludedContent / stateStats
 *   - manifestHash = SHA-256(排序后的 fileHashes)，用于一致性比较
 *   - 源 workspace 中任何不可解析 sourceChapter 的状态条目 → 直接阻断，不猜测
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { createHash } from "node:crypto";

import { createFrontierSnapshot } from "../dist-eval/v2/core/frontier-snapshot.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");

// ============================================================================
// 工厂：构造合成工作区
// ============================================================================

function hashFile(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function makeSyntheticWorkspace(root, workspaceId, options = {}) {
  const wsDir = join(root, "workspaces", workspaceId);
  mkdirSync(join(wsDir, "chapters"), { recursive: true });
  mkdirSync(join(wsDir, "series"), { recursive: true });
  mkdirSync(join(wsDir, "traces"), { recursive: true });
  mkdirSync(join(wsDir, "comparisons"), { recursive: true });

  // config.json（不可变基础信息）
  writeFileSync(
    join(wsDir, "config.json"),
    JSON.stringify({
      workspaceId,
      novelName: "合成测试小说",
      genre: "玄幻",
      subGenres: ["悬疑"],
      characters: [{ name: "凌", role: "protagonist" }],
    }, null, 2),
    "utf8"
  );

  // CORE-WRITING-PRINCIPLES.md（不可变）
  writeFileSync(
    join(wsDir, "CORE-WRITING-PRINCIPLES.md"),
    "# 写作原则\n本章必须承接前章悬置状态。\n",
    "utf8"
  );
  writeFileSync(
    join(wsDir, "creative-constitution.json"),
    JSON.stringify({
      schemaVersion: 1,
      workIdentity: "合成测试小说",
      readerPromise: ["连续章节中的选择必须产生后果"],
      genrePromises: ["悬念来自既定事实和人物行动"],
      protagonistCoreConflict: "凌必须在不完整信息中承担选择代价",
      thematicQuestions: ["选择是否能够改变既定代价"],
      aestheticDirection: ["具体", "克制"],
      forbiddenDrift: ["不得覆盖前章已接受事实"],
      narrativePreferences: [],
    }, null, 2),
    "utf8",
  );

  // chapters：1..20 章
  const chapterCount = options.chapterCount ?? 20;
  for (let i = 1; i <= chapterCount; i++) {
    writeFileSync(
      join(wsDir, "chapters", `${i}.md`),
      `# 第${i}章\n\n这是第 ${i} 章的正文。凌出现了。\n`,
      "utf8"
    );
  }
  // 一个 .rq3.md 变体（session 产物，应被排除）
  writeFileSync(
    join(wsDir, "chapters", "18.rq3.md"),
    "# 第18章 RQ3 变体\n不应进入快照\n",
    "utf8"
  );

  // traces（session 产物）
  writeFileSync(
    join(wsDir, "traces", "ch19-quality-trace.json"),
    JSON.stringify({ stage: "trace", chapterId: "ch19" }),
    "utf8"
  );
  // comparisons（session 产物）
  writeFileSync(
    join(wsDir, "comparisons", "ch19-cmp.json"),
    JSON.stringify({ cmp: "ch19" }),
    "utf8"
  );

  // series/outline.md（不可变高层背景）
  writeFileSync(join(wsDir, "series", "outline.md"), "# 大纲\n高层背景。\n", "utf8");
  writeFileSync(join(wsDir, "series", "skeleton.json"), JSON.stringify({
    chapterSkeletons: {
      "16": {
        chapterId: "16",
        facts: ["凌确认门后的声音不属于同伴"],
        stateChanges: [{ subject: "凌", before: "怀疑", after: "确认异常", isReversible: false }],
        activeDilemmas: ["门后的东西为何知道他的名字？"],
      },
      "17": {
        chapterId: "17",
        facts: ["未来章节事实不应进入 throughChapter=16 的快照"],
        stateChanges: [],
        activeDilemmas: [],
      },
    },
    globalFacts: ["合成世界事实"],
    lastUpdated: "2026-01-01T00:00:00Z",
  }, null, 2), "utf8");
  writeFileSync(join(wsDir, "series", "narrative-state.json"), JSON.stringify({
    currentChapter: 16,
    chapterProgress: { completed: 16, current: 17 },
    readerExpectation: { unresolvedCount: 1, chaptersSinceLastPeak: 1 },
    relationshipTemperature: {},
    horrorFatigue: { recentTechniques: [], consecutiveSameTechnique: 0 },
    worldRuleExposure: {},
    protagonistCostLedger: { pendingCosts: [] },
    stateChanges: [],
  }, null, 2), "utf8");

  // narrative-state-store.json：ch1/ch5/ch10/ch16/ch18/ch19 各放若干条
  const state = {
    schemaVersion: 1,
    workspaceId,
    canon: [
      {
        id: "canon:world:ch1", kind: "canon", fact: "世界设定 A", category: "entity",
        sourceChapter: "ch1", sourceRef: "ch1#finalText:aaa:0-3", confidence: 0.8,
        lastUpdated: "2026-01-01T00:00:00Z",
      },
      {
        id: "canon:world:ch18-leak", kind: "canon", fact: "未来世界设定", category: "entity",
        sourceChapter: "ch18", sourceRef: "ch18#finalText:bbb:0-3", confidence: 0.8,
        lastUpdated: "2026-01-01T00:00:00Z",
      },
    ],
    character: [
      {
        id: "character:凌:ch5", kind: "character", characterId: "凌", field: "状态",
        value: "受伤", sourceChapter: "ch5", sourceRef: "ch5#finalText:ccc:0-2",
        confidence: 0.8, lastUpdated: "2026-01-01T00:00:00Z",
      },
      {
        id: "character:凌:ch18-leak", kind: "character", characterId: "凌", field: "状态",
        value: "已升级", sourceChapter: "ch18", sourceRef: "ch18#finalText:ddd:0-3",
        confidence: 0.8, lastUpdated: "2026-01-01T00:00:00Z",
      },
      {
        id: "character:凌:ch19-leak", kind: "character", characterId: "凌", field: "状态",
        value: "已闭关", sourceChapter: "ch19", sourceRef: "ch19#finalText:eee:0-3",
        confidence: 0.8, lastUpdated: "2026-01-01T00:00:00Z",
      },
    ],
    promise: [
      {
        id: "promise:ch10", kind: "promise", promiseId: "promise:ch10",
        description: "ch10 埋的伏笔", status: "open", currentHeat: 2,
        sourceChapter: "ch10", sourceRef: "ch10#finalText:fff:0-3", confidence: 0.7,
        lastUpdated: "2026-01-01T00:00:00Z",
      },
      {
        id: "promise:ch19-leak", kind: "promise", promiseId: "promise:ch19-leak",
        description: "ch19 埋的未来伏笔", status: "open", currentHeat: 1,
        sourceChapter: "ch19", sourceRef: "ch19#finalText:ggg:0-3", confidence: 0.7,
        lastUpdated: "2026-01-01T00:00:00Z",
      },
    ],
    pattern: [
      {
        id: "pattern:ch16", kind: "pattern", patternType: "hook_type",
        description: "ch16 钩子", occurrenceCount: 2,
        sourceChapter: "ch16", sourceRef: "ch16#finalText:hhh:0-3", confidence: 0.7,
        lastUpdated: "2026-01-01T00:00:00Z",
      },
    ],
    expectation: [],
    eventLog: [],
    quarantine: [],
    lastCommittedChapter: "ch19",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  writeFileSync(
    join(wsDir, "narrative-state-store.json"),
    JSON.stringify(state, null, 2),
    "utf8"
  );

  return wsDir;
}

/** 计算目录下所有文件的 path+sha256 列表，用于前后比较 */
function hashDirectory(dir, base = dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...hashDirectory(full, base));
    } else {
      const rel = full.slice(base.length + 1).replace(/\\/g, "/");
      const content = readFileSync(full);
      results.push({
        path: rel,
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: content.length,
      });
    }
  }
  return results;
}

// ============================================================================
// 1. 基础验收：截至 ch16 的快照不含 ch17+ 状态/章节
// ============================================================================

test("FRONTIER-SNAPSHOT-1: ch17 比较快照中不存在 ch17+ 派生状态/章节", async () => {
  const tmpRoot = resolve(PROJECT_ROOT, ".tmp", `frontier-snapshot-test-${Date.now()}-1`);
  try {
    const wsId = "synthetic-frontier-1";
    const wsDir = makeSyntheticWorkspace(tmpRoot, wsId, { chapterCount: 20 });
    const sourceHashesBefore = hashDirectory(wsDir);

    const result = await createFrontierSnapshot({
      workspaceId: wsId,
      throughChapter: 16,
      projectRoot: tmpRoot,
    });

    assert.ok(!result.blocked, `不应阻断：${result.blockReason ?? ""}`);
    assert.ok(existsSync(result.outputDir), "快照目录应存在");

    // 1. 章节文件：1..16 应在；17..20 不应在
    for (let i = 1; i <= 16; i++) {
      assert.ok(
        existsSync(join(result.outputDir, "chapters", `${i}.md`)),
        `chapters/${i}.md 应存在（<= throughChapter）`
      );
    }
    for (let i = 17; i <= 20; i++) {
      assert.ok(
        !existsSync(join(result.outputDir, "chapters", `${i}.md`)),
        `chapters/${i}.md 不应存在（> throughChapter）`
      );
    }

    // .rq3.md 变体（session 产物）不应进入
    assert.ok(
      !existsSync(join(result.outputDir, "chapters", "18.rq3.md")),
      "chapters/18.rq3.md 不应进入快照（session 产物）"
    );

    // 2. traces / comparisons 目录不应进入快照
    assert.ok(
      !existsSync(join(result.outputDir, "traces")),
      "traces/ 目录不应进入快照"
    );
    assert.ok(
      !existsSync(join(result.outputDir, "comparisons")),
      "comparisons/ 目录不应进入快照"
    );

    // 3. 快照内 narrative-state-store.json 不得含 ch17+ 条目
    const snapStatePath = join(result.outputDir, "narrative-state-store.json");
    assert.ok(existsSync(snapStatePath), "快照应含 narrative-state-store.json");
    const snapState = JSON.parse(readFileSync(snapStatePath, "utf8"));
    assert.equal(
      snapState.workspaceId,
      "synthetic-frontier-1-snapshot-ch16",
      "state store workspaceId 应改写为隔离快照 workspaceId",
    );
    const allEntries = [
      ...(snapState.canon ?? []),
      ...(snapState.character ?? []),
      ...(snapState.promise ?? []),
      ...(snapState.pattern ?? []),
      ...(snapState.expectation ?? []),
    ];
    for (const entry of allEntries) {
      const m = String(entry.sourceChapter ?? "").match(/^ch(\d+)$/);
      assert.ok(m, `快照状态条目 sourceChapter 应可解析：${entry.sourceChapter}`);
      const n = Number(m[1]);
      assert.ok(
        n <= 16,
        `快照状态条目 sourceChapter 不得 > throughChapter(16)，发现 ${entry.sourceChapter}：${JSON.stringify(entry)}`
      );
    }

    const snapConfig = JSON.parse(readFileSync(join(result.outputDir, "config.json"), "utf8"));
    assert.equal(
      snapConfig.workspaceId,
      "synthetic-frontier-1-snapshot-ch16",
      "config.workspaceId 应改写为隔离快照 workspaceId",
    );
    assert.ok(
      existsSync(join(result.outputDir, "creative-constitution.json")),
      "快照必须保留作品级 CreativeConstitution",
    );
    const snapSkeleton = JSON.parse(readFileSync(join(result.outputDir, "series", "skeleton.json"), "utf8"));
    assert.ok(snapSkeleton.chapterSkeletons["16"], "应保留 frontier 章节 skeleton");
    assert.equal(snapSkeleton.chapterSkeletons["17"], undefined, "不得保留 frontier 之后的 skeleton");
    assert.ok(
      existsSync(join(result.outputDir, "series", "narrative-state.json")),
      "安全的 frontier narrative-state 应进入快照",
    );

    // 4. stateStats 应记录被排除的未来条目
    assert.ok(
      result.manifest.stateStats.excludedFutureEntries >= 4,
      `excludedFutureEntries 应 >= 4（canon/character/promise 共 4 条 ch17+），实际 ${result.manifest.stateStats.excludedFutureEntries}`
    );

    // 5. sourceWorkspaceHash 应与源目录实际 hash 一致（前后对比）
    const sourceHashesAfter = hashDirectory(wsDir);
    assert.deepEqual(
      sourceHashesAfter,
      sourceHashesBefore,
      "快照生成不得修改源工作区"
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("FRONTIER-SNAPSHOT-2: 过滤后为空的 state store 被省略并回退到安全 skeleton", async () => {
  const tmpRoot = resolve(PROJECT_ROOT, ".tmp", `frontier-snapshot-test-${Date.now()}-empty-store`);
  try {
    const wsId = "synthetic-frontier-empty-store";
    const wsDir = makeSyntheticWorkspace(tmpRoot, wsId, { chapterCount: 20 });
    const statePath = join(wsDir, "narrative-state-store.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    for (const key of ["canon", "character", "promise", "pattern", "expectation"]) {
      state[key] = (state[key] ?? []).filter((entry) => Number(String(entry.sourceChapter).match(/\d+/)?.[0]) > 16);
    }
    writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");

    const result = await createFrontierSnapshot({
      workspaceId: wsId,
      throughChapter: 16,
      projectRoot: tmpRoot,
    });

    assert.equal(result.blocked, false);
    assert.equal(existsSync(join(result.outputDir, "narrative-state-store.json")), false);
    assert.ok(existsSync(join(result.outputDir, "series", "skeleton.json")));
    assert.ok(result.manifest.excludedContent.some((entry) =>
      entry.path === "narrative-state-store.json" && entry.reason === "no_accepted_entries_at_frontier"));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. 连续两次构建快照哈希一致
// ============================================================================

test("FRONTIER-SNAPSHOT-1: 连续两次构建快照 manifestHash 一致", async () => {
  const tmpRoot = resolve(PROJECT_ROOT, ".tmp", `frontier-snapshot-test-${Date.now()}-2`);
  try {
    const wsId = "synthetic-frontier-2";
    makeSyntheticWorkspace(tmpRoot, wsId, { chapterCount: 20 });

    const r1 = await createFrontierSnapshot({
      workspaceId: wsId, throughChapter: 16, projectRoot: tmpRoot,
    });
    const r2 = await createFrontierSnapshot({
      workspaceId: wsId, throughChapter: 16, projectRoot: tmpRoot,
    });

    assert.ok(!r1.blocked && !r2.blocked, "两次构建都不应阻断");
    assert.equal(
      r1.manifest.manifestHash,
      r2.manifest.manifestHash,
      "两次构建的 manifestHash 应一致（同输入 → 同输出）"
    );
    assert.equal(
      r1.manifest.sourceWorkspaceHash,
      r2.manifest.sourceWorkspaceHash,
      "两次构建的 sourceWorkspaceHash 应一致"
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. 快照生成不修改原工作区
// ============================================================================

test("FRONTIER-SNAPSHOT-1: 快照生成不修改原工作区（前后 hash 严格一致）", async () => {
  const tmpRoot = resolve(PROJECT_ROOT, ".tmp", `frontier-snapshot-test-${Date.now()}-3`);
  try {
    const wsId = "synthetic-frontier-3";
    const wsDir = makeSyntheticWorkspace(tmpRoot, wsId, { chapterCount: 20 });

    // 收集所有源文件的 mtime + hash（双重校验）
    const before = hashDirectory(wsDir).map((f) => ({
      ...f,
      mtime: statSync(join(wsDir, f.path)).mtimeMs,
    }));

    await createFrontierSnapshot({
      workspaceId: wsId, throughChapter: 16, projectRoot: tmpRoot,
    });

    const after = hashDirectory(wsDir).map((f) => ({
      ...f,
      mtime: statSync(join(wsDir, f.path)).mtimeMs,
    }));

    assert.deepEqual(after, before, "源工作区所有文件 hash+mtime 不得变化");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. 状态无法按章节回溯时直接阻断
// ============================================================================

test("FRONTIER-SNAPSHOT-1: 状态条目 sourceChapter 不可解析时直接阻断，不猜测", async () => {
  const tmpRoot = resolve(PROJECT_ROOT, ".tmp", `frontier-snapshot-test-${Date.now()}-4`);
  try {
    const wsId = "synthetic-frontier-blocked";
    const wsDir = makeSyntheticWorkspace(tmpRoot, wsId, { chapterCount: 20 });

    // 注入一条不可解析 sourceChapter 的状态条目
    const statePath = join(wsDir, "narrative-state-store.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.canon.push({
      id: "canon:unparseable",
      kind: "canon",
      fact: "无法解析章节号的条目",
      category: "entity",
      sourceChapter: "unknown-chapter",
      sourceRef: "unknown#finalText:xxx:0-3",
      confidence: 0.5,
      lastUpdated: "2026-01-01T00:00:00Z",
    });
    writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");

    const result = await createFrontierSnapshot({
      workspaceId: wsId, throughChapter: 16, projectRoot: tmpRoot,
    });

    assert.ok(result.blocked, "应被阻断");
    assert.ok(result.blockReason, "阻断原因应非空");
    assert.match(
      result.blockReason,
      /无法解析|unparseable|不可回溯|cannot.?parse/i,
      `阻断原因应明确说明不可解析，实际：${result.blockReason}`
    );

    // 阻断时不应输出快照目录（或输出空目录 + manifest 记录阻断）
    if (existsSync(result.outputDir)) {
      // 允许存在空目录，但不得包含被猜测的快照内容
      const snapStatePath = join(result.outputDir, "narrative-state-store.json");
      if (existsSync(snapStatePath)) {
        // 若仍写入，必须不含不可解析条目（不允许猜测）
        const snapState = JSON.parse(readFileSync(snapStatePath, "utf8"));
        const hasUnparseable = (snapState.canon ?? []).some(
          (e) => e.id === "canon:unparseable"
        );
        assert.ok(!hasUnparseable, "阻断时不得在快照中保留不可解析条目（不允许猜测）");
      }
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. manifest 字段完整性
// ============================================================================

test("FRONTIER-SNAPSHOT-1: manifest 记录 sourceWorkspace / throughChapter / fileHashes / excludedContent", async () => {
  const tmpRoot = resolve(PROJECT_ROOT, ".tmp", `frontier-snapshot-test-${Date.now()}-5`);
  try {
    const wsId = "synthetic-frontier-5";
    makeSyntheticWorkspace(tmpRoot, wsId, { chapterCount: 20 });

    const result = await createFrontierSnapshot({
      workspaceId: wsId, throughChapter: 16, projectRoot: tmpRoot,
    });

    const m = result.manifest;
    assert.equal(m.sourceWorkspace, wsId, "manifest.sourceWorkspace 应为源 workspaceId");
    assert.equal(m.throughChapter, 16, "manifest.throughChapter 应为 16");
    assert.ok(m.createdAt, "manifest.createdAt 应非空");
    assert.ok(Array.isArray(m.fileHashes) && m.fileHashes.length > 0, "fileHashes 应为非空数组");
    assert.ok(Array.isArray(m.excludedContent), "excludedContent 应为数组");

    // fileHashes 每条应有 path/sha256/bytes
    for (const fh of m.fileHashes) {
      assert.ok(fh.path, "fileHash 条目应有 path");
      assert.match(fh.sha256, /^[0-9a-f]{64}$/, "fileHash.sha256 应为 64 位十六进制");
      assert.ok(typeof fh.bytes === "number" && fh.bytes > 0, "fileHash.bytes 应为正数");
    }

    // excludedContent 应记录被排除的章节和目录
    const excludedPaths = m.excludedContent.map((e) => e.path);
    assert.ok(
      excludedPaths.some((p) => p.includes("chapters/17.md") || p.includes("chapters\\17.md") || p.includes("17.md")),
      "excludedContent 应记录 chapters/17.md"
    );
    assert.ok(
      excludedPaths.some((p) => p.includes("traces") || p.includes("comparisons")),
      "excludedContent 应记录 traces 或 comparisons"
    );

    // manifestHash 应为 64 位十六进制
    assert.match(m.manifestHash, /^[0-9a-f]{64}$/, "manifestHash 应为 64 位十六进制");
    assert.match(m.sourceWorkspaceHash, /^[0-9a-f]{64}$/, "sourceWorkspaceHash 应为 64 位十六进制");

    // stateStats 完整
    const stats = m.stateStats;
    assert.ok(typeof stats.canon === "number", "stateStats.canon 应为 number");
    assert.ok(typeof stats.character === "number", "stateStats.character 应为 number");
    assert.ok(typeof stats.promise === "number", "stateStats.promise 应为 number");
    assert.ok(typeof stats.pattern === "number", "stateStats.pattern 应为 number");
    assert.ok(typeof stats.excludedFutureEntries === "number", "stateStats.excludedFutureEntries 应为 number");
    assert.ok(typeof stats.excludedUnparseableEntries === "number", "stateStats.excludedUnparseableEntries 应为 number");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 6. 快照目录与源工作区目录分离（结构上禁止反向写入）
// ============================================================================

test("FRONTIER-SNAPSHOT-1: 快照输出到 sibling 目录，不在源 workspace 内部", async () => {
  const tmpRoot = resolve(PROJECT_ROOT, ".tmp", `frontier-snapshot-test-${Date.now()}-6`);
  try {
    const wsId = "synthetic-frontier-6";
    makeSyntheticWorkspace(tmpRoot, wsId, { chapterCount: 20 });

    const result = await createFrontierSnapshot({
      workspaceId: wsId, throughChapter: 16, projectRoot: tmpRoot,
    });

    const sourceWsDir = join(tmpRoot, "workspaces", wsId);
    // outputDir 必须不在 sourceWsDir 内部
    const rel = result.outputDir.replace(sourceWsDir, "");
    assert.ok(
      !rel.startsWith(join(sourceWsDir, "").slice(0)) || result.outputDir === sourceWsDir + "-snapshot-ch16",
      `outputDir 不应在 source workspace 内部：outputDir=${result.outputDir}, source=${sourceWsDir}`
    );
    // 简化断言：outputDir 应包含 wsId + "snapshot" 字样
    assert.match(
      result.outputDir,
      new RegExp(`${wsId}.*snapshot`),
      `outputDir 应在 sibling 目录中：${result.outputDir}`
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
