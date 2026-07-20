/**
 * PiNovelStudio — PREFLIGHT-STATE-STORE-CONTINUITY-1
 *
 * 验证统一主链路下前章连续性预检的真相源迁移：
 *  - 旧链路用 series/skeleton.json（由 legacy state-observer 写入，统一主链路不写）
 *  - 新链路用 workspaces/{id}/narrative-state-store.json（由 FinalStateCommit 写入，
 *    每条 entry 含 sourceChapter=ch{N-1} + sourceRef=ch{N-1}#finalText:{hash}:{span}）
 *
 * 验收（用户原话）：
 *  - 当前章 N>1 时，只要存在同一 workspace 的前章 committed narrative-state-store，
 *    且 finalText/hash/sourceRef 有效，previous_skeleton_missing 不得 hard block。
 *  - state store 缺失、未提交、workspace 不匹配、sourceRef/hash 无效时仍 hard block。
 *  - 不自动生成或伪造 skeleton.json。
 *  - seedReadiness=100 仍需保留并写入 trace（本测试用 skipSeedReadiness 隔离连续性检查）。
 *
 * 覆盖场景：
 *  1. state-only        — 有效 state store + 无 skeleton → 不阻断（核心修复）
 *  2. skeleton-only     — 有效 skeleton + 无 state store → 不阻断（legacy 回退）
 *  3. both-missing      — 两者都无 → 阻断 previous_skeleton_missing
 *  4. stale-state       — state store 存在但无 ch{N-1} entry → 阻断 previous_state_store_invalid
 *  5. candidate-only    — state store 有 ch{N-1} entry 但 sourceRef=candidate:* → 阻断
 *  6. hash-mismatch     — state store hash 与 ch{N-1}.md 实际 hash 不符 → 阻断
 *  7. workspace-mismatch— state store workspaceId 与实际不符 → 阻断
 *  8. chapter-file-missing — state store 声称 ch{N-1} committed 但 chapters/{N-1}.md 缺失 → 阻断
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..");
const extRoot = resolve(repoRoot, ".pi", "extensions", "novel-studio");
const distRoot = join(extRoot, "dist-test");

// ─────────────────────────────────────────────────────────────────────────────
// 模块加载
// ─────────────────────────────────────────────────────────────────────────────

let preflightMod;

async function loadModules() {
  preflightMod = await import(
    pathToFileURL(join(distRoot, "craft", "workspace-preflight-checker.js")).href
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试 workspace 工具
// ─────────────────────────────────────────────────────────────────────────────

const testWorkspaceId = "test-preflight-state-continuity";
let testWorkspacePath;

function computeHash12(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

function setupBaseWorkspace() {
  testWorkspacePath = resolve(repoRoot, "workspaces", testWorkspaceId);
  if (existsSync(testWorkspacePath)) {
    rmSync(testWorkspacePath, { recursive: true, force: true });
  }
  const dirs = [
    testWorkspacePath,
    join(testWorkspacePath, "series"),
    join(testWorkspacePath, "characters"),
    join(testWorkspacePath, "chapters"),
    join(testWorkspacePath, "traces"),
  ];
  for (const d of dirs) mkdirSync(d, { recursive: true });

  const configData = {
    name: "状态连续性测试小说",
    genre: "玄幻",
    subGenres: ["重生"],
    characters: [
      { id: "protagonist", name: "林墨", role: "主角" },
      { id: "mentor", name: "老者", role: "导师" },
    ],
    totalChapters: 20,
    targetWordCount: { perChapter: { min: 2000, max: 3000 } },
  };
  writeFileSync(join(testWorkspacePath, "config.json"), JSON.stringify(configData, null, 2), "utf-8");
  writeFileSync(join(testWorkspacePath, "characters", "protagonist.md"), "# 林墨\n\n主角，重生者。\n", "utf-8");
  writeFileSync(join(testWorkspacePath, "characters", "mentor.md"), "# 老者\n\n神秘导师。\n", "utf-8");
}

function writePrevChapterFile(prevChapterNumber, text) {
  writeFileSync(join(testWorkspacePath, "chapters", `${prevChapterNumber}.md`), text, "utf-8");
}

function writeSkeleton(prevChapterNumber) {
  const skeleton = {
    chapterSkeletons: {
      [String(prevChapterNumber)]: {
        title: `第${prevChapterNumber}章`,
        facts: ["前章发生了某事"],
        stateChanges: [{ subject: "林墨", after: "心境提升", isReversible: true }],
        activeDilemmas: ["未解之谜"],
      },
    },
  };
  writeFileSync(join(testWorkspacePath, "series", "skeleton.json"), JSON.stringify(skeleton, null, 2), "utf-8");
}

function writeStateStore(stateStore) {
  writeFileSync(join(testWorkspacePath, "narrative-state-store.json"), JSON.stringify(stateStore, null, 2), "utf-8");
}

/** 构造一个有效的 ch{prevChapterNumber} committed state store，sourceRef hash 与 prevChapterText 匹配 */
function buildValidStateStore(prevChapterNumber, prevChapterText) {
  const hash = computeHash12(prevChapterText);
  const prevChapterId = `ch${prevChapterNumber}`;
  return {
    schemaVersion: 1,
    workspaceId: testWorkspaceId,
    canon: [],
    character: [
      {
        kind: "character",
        id: `character:林墨:${prevChapterId}`,
        sourceChapter: prevChapterId,
        sourceRef: `${prevChapterId}#finalText:${hash}:0-10`,
        confidence: 0.7,
        lastUpdated: "2026-07-15T19:57:41.523Z",
        characterId: "林墨",
        field: "participation",
        value: "present",
        version: 1,
        effectiveFrom: prevChapterId,
      },
    ],
    promise: [],
    pattern: [],
    expectation: [],
    lastCommittedChapter: prevChapterId,
    updatedAt: "2026-07-15T19:57:41.523Z",
  };
}

function runPreflight(chapterNumber) {
  const { preflightWorkspace } = preflightMod;
  return preflightWorkspace({
    workspacePath: testWorkspacePath,
    workspaceId: testWorkspaceId,
    chapterId: String(chapterNumber),
    chapterNumber,
    skipSeedReadiness: true,
  });
}

function cleanupTestWorkspace() {
  if (existsSync(testWorkspacePath)) {
    rmSync(testWorkspacePath, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试用例
// ─────────────────────────────────────────────────────────────────────────────

describe("PREFLIGHT-STATE-STORE-CONTINUITY-1: 前章连续性预检（state store 真相源）", () => {
  before(async () => { await loadModules(); });
  after(() => { cleanupTestWorkspace(); });

  it("1. state-only: 有效 narrative-state-store + 无 skeleton → 不阻断 previous_skeleton_missing", () => {
    const chapterNumber = 3;
    const prevText = "前章正文内容，用于 hash 校验。这是第二章的最终正文。";
    setupBaseWorkspace();
    writePrevChapterFile(chapterNumber - 1, prevText);
    writeStateStore(buildValidStateStore(chapterNumber - 1, prevText));
    // 不写 skeleton.json

    const report = runPreflight(chapterNumber);

    const skelBlock = report.blockingItems.find(b => b.check === "previous_skeleton_missing");
    assert.equal(skelBlock, undefined, "有效 state store 时不应因缺 skeleton 阻断");
    const stateBlock = report.blockingItems.find(b => b.check === "previous_state_store_invalid");
    assert.equal(stateBlock, undefined, "有效 state store 时不应有 state_store_invalid 阻断");
    assert.equal(report.checks.previousSkeleton.passed, true, "previousSkeleton check 应通过");
    assert.equal(
      report.checks.previousSkeleton.detail.source,
      "state-store",
      "应记录连续性来源为 state-store",
    );
    cleanupTestWorkspace();
  });

  it("2. skeleton-only: 有效 skeleton + 无 state store → 不阻断（legacy 回退）", () => {
    const chapterNumber = 2;
    setupBaseWorkspace();
    writeSkeleton(chapterNumber - 1);
    // 不写 narrative-state-store.json

    const report = runPreflight(chapterNumber);

    const skelBlock = report.blockingItems.find(b => b.check === "previous_skeleton_missing");
    assert.equal(skelBlock, undefined, "有效 skeleton 时不应阻断");
    const stateBlock = report.blockingItems.find(b => b.check === "previous_state_store_invalid");
    assert.equal(stateBlock, undefined, "state store 缺失时应回退到 skeleton，不报 state_store_invalid");
    assert.equal(report.checks.previousSkeleton.passed, true);
    assert.equal(
      report.checks.previousSkeleton.detail.source,
      "skeleton-legacy",
      "应记录连续性来源为 skeleton-legacy 回退",
    );
    cleanupTestWorkspace();
  });

  it("3. both-missing: 无 skeleton + 无 state store → 阻断 previous_skeleton_missing", () => {
    const chapterNumber = 2;
    setupBaseWorkspace();
    // 不写 skeleton，不写 state store

    const report = runPreflight(chapterNumber);

    assert.equal(report.passed, false, "两者都缺失时应阻断");
    const skelBlock = report.blockingItems.find(b => b.check === "previous_skeleton_missing");
    assert.ok(skelBlock, "两者都缺失时应阻断 previous_skeleton_missing");
    assert.ok(
      skelBlock.fixInstruction.includes("narrative-state-store") || skelBlock.reason.includes("narrative-state-store"),
      "修复指令应提示生成前章以提交 narrative-state-store",
    );
    cleanupTestWorkspace();
  });

  it("4. stale-state: state store 存在但无 ch{N-1} entry（陈旧）→ 阻断 previous_state_store_invalid", () => {
    const chapterNumber = 3; // 生成 ch3，前章应为 ch2
    const prevText = "第二章正文。";
    setupBaseWorkspace();
    writePrevChapterFile(chapterNumber - 1, prevText);
    // state store 停在 ch1（陈旧），无 ch2 entry
    const ch1Text = "第一章正文。";
    const ch1Hash = computeHash12(ch1Text);
    writeStateStore({
      schemaVersion: 1,
      workspaceId: testWorkspaceId,
      canon: [],
      character: [
        {
          kind: "character",
          id: "character:林墨:ch1",
          sourceChapter: "ch1",
          sourceRef: `ch1#finalText:${ch1Hash}:0-5`,
          confidence: 0.7,
          lastUpdated: "2026-07-14T00:00:00.000Z",
          characterId: "林墨",
          field: "participation",
          value: "present",
          version: 1,
          effectiveFrom: "ch1",
        },
      ],
      promise: [],
      pattern: [],
      expectation: [],
      lastCommittedChapter: "ch1",
      updatedAt: "2026-07-14T00:00:00.000Z",
    });
    // 不写 skeleton

    const report = runPreflight(chapterNumber);

    assert.equal(report.passed, false, "陈旧 state store 应阻断");
    const stateBlock = report.blockingItems.find(b => b.check === "previous_state_store_invalid");
    assert.ok(stateBlock, "陈旧 state store 应阻断 previous_state_store_invalid（而非 previous_skeleton_missing）");
    assert.ok(
      stateBlock.reason.includes("stale") || stateBlock.reason.includes("ch2"),
      "阻断原因应说明陈旧（无 ch2 entry）",
    );
    // 不应回退到 skeleton 检查（state store 存在即权威，陈旧是真问题）
    const skelBlock = report.blockingItems.find(b => b.check === "previous_skeleton_missing");
    assert.equal(skelBlock, undefined, "state store 存在但陈旧时不应回退到 skeleton 阻断");
    cleanupTestWorkspace();
  });

  it("5. candidate-only-state: state store 有 ch{N-1} entry 但 sourceRef=candidate:* → 阻断", () => {
    const chapterNumber = 3;
    const prevText = "第二章正文，已落盘但状态未提交。";
    setupBaseWorkspace();
    writePrevChapterFile(chapterNumber - 1, prevText);
    // state store 有 ch2 entry 但 sourceRef 是 candidate:*（staged 未 reanchor 到 finalText）
    writeStateStore({
      schemaVersion: 1,
      workspaceId: testWorkspaceId,
      canon: [],
      character: [
        {
          kind: "character",
          id: "character:林墨:ch2",
          sourceChapter: "ch2",
          sourceRef: "candidate:amp-1",
          confidence: 0.5,
          lastUpdated: "2026-07-15T19:57:41.523Z",
          characterId: "林墨",
          field: "participation",
          value: "present",
          version: 1,
        },
      ],
      promise: [],
      pattern: [],
      expectation: [],
      lastCommittedChapter: "ch2",
      updatedAt: "2026-07-15T19:57:41.523Z",
    });
    // 不写 skeleton

    const report = runPreflight(chapterNumber);

    assert.equal(report.passed, false, "candidate-only state store 应阻断");
    const stateBlock = report.blockingItems.find(b => b.check === "previous_state_store_invalid");
    assert.ok(stateBlock, "candidate-only state store 应阻断 previous_state_store_invalid");
    assert.ok(
      stateBlock.reason.includes("candidate") || stateBlock.reason.includes("finalText"),
      "阻断原因应说明 sourceRef 未锚定 finalText",
    );
    cleanupTestWorkspace();
  });

  it("6. hash-mismatch: state store hash 与 ch{N-1}.md 实际 hash 不符 → 阻断", () => {
    const chapterNumber = 3;
    const prevText = "第二章真实正文内容。";
    setupBaseWorkspace();
    writePrevChapterFile(chapterNumber - 1, prevText);
    // 故意用错误 hash（与实际 ch2.md 不匹配）
    const wrongHash = "000000000000";
    writeStateStore({
      schemaVersion: 1,
      workspaceId: testWorkspaceId,
      canon: [],
      character: [
        {
          kind: "character",
          id: "character:林墨:ch2",
          sourceChapter: "ch2",
          sourceRef: `ch2#finalText:${wrongHash}:0-5`,
          confidence: 0.7,
          lastUpdated: "2026-07-15T19:57:41.523Z",
          characterId: "林墨",
          field: "participation",
          value: "present",
          version: 1,
          effectiveFrom: "ch2",
        },
      ],
      promise: [],
      pattern: [],
      expectation: [],
      lastCommittedChapter: "ch2",
      updatedAt: "2026-07-15T19:57:41.523Z",
    });
    // 不写 skeleton

    const report = runPreflight(chapterNumber);

    assert.equal(report.passed, false, "hash 不匹配应阻断");
    const stateBlock = report.blockingItems.find(b => b.check === "previous_state_store_invalid");
    assert.ok(stateBlock, "hash 不匹配应阻断 previous_state_store_invalid");
    assert.ok(
      stateBlock.reason.includes("hash") || stateBlock.reason.includes("mismatch"),
      "阻断原因应说明 hash 不匹配",
    );
    cleanupTestWorkspace();
  });

  it("7. workspace-mismatch: state store workspaceId 与实际不符 → 阻断", () => {
    const chapterNumber = 3;
    const prevText = "第二章正文内容。";
    setupBaseWorkspace();
    writePrevChapterFile(chapterNumber - 1, prevText);
    const hash = computeHash12(prevText);
    // workspaceId 不匹配
    writeStateStore({
      schemaVersion: 1,
      workspaceId: "another-workspace-id",
      canon: [],
      character: [
        {
          kind: "character",
          id: "character:林墨:ch2",
          sourceChapter: "ch2",
          sourceRef: `ch2#finalText:${hash}:0-5`,
          confidence: 0.7,
          lastUpdated: "2026-07-15T19:57:41.523Z",
          characterId: "林墨",
          field: "participation",
          value: "present",
          version: 1,
          effectiveFrom: "ch2",
        },
      ],
      promise: [],
      pattern: [],
      expectation: [],
      lastCommittedChapter: "ch2",
      updatedAt: "2026-07-15T19:57:41.523Z",
    });
    // 不写 skeleton

    const report = runPreflight(chapterNumber);

    assert.equal(report.passed, false, "workspaceId 不匹配应阻断");
    const stateBlock = report.blockingItems.find(b => b.check === "previous_state_store_invalid");
    assert.ok(stateBlock, "workspaceId 不匹配应阻断 previous_state_store_invalid");
    assert.ok(
      stateBlock.reason.includes("workspace") || stateBlock.reason.includes("mismatch"),
      "阻断原因应说明 workspace 不匹配",
    );
    cleanupTestWorkspace();
  });

  it("8. chapter-file-missing: state store 声称 ch{N-1} committed 但 chapters/{N-1}.md 缺失 → 阻断", () => {
    const chapterNumber = 3;
    const fakeText = "不存在的第二章正文。";
    setupBaseWorkspace();
    // 故意不写 chapters/2.md
    writeStateStore(buildValidStateStore(chapterNumber - 1, fakeText));
    // 不写 skeleton

    const report = runPreflight(chapterNumber);

    assert.equal(report.passed, false, "章节文件缺失应阻断");
    const stateBlock = report.blockingItems.find(b => b.check === "previous_state_store_invalid");
    assert.ok(stateBlock, "章节文件缺失应阻断 previous_state_store_invalid");
    assert.ok(
      stateBlock.reason.includes("chapter") || stateBlock.reason.includes("missing") || stateBlock.reason.includes("文件"),
      "阻断原因应说明章节文件缺失",
    );
    cleanupTestWorkspace();
  });

  it("9. 第1章不触发连续性检查（无前章）", () => {
    setupBaseWorkspace();
    // 不写 skeleton，不写 state store

    const report = runPreflight(1);

    const skelBlock = report.blockingItems.find(b => b.check === "previous_skeleton_missing");
    assert.equal(skelBlock, undefined, "第1章不应触发前章连续性检查");
    const stateBlock = report.blockingItems.find(b => b.check === "previous_state_store_invalid");
    assert.equal(stateBlock, undefined, "第1章不应触发 state store 校验");
    assert.equal(report.checks.previousSkeleton.passed, true);
    cleanupTestWorkspace();
  });

  it("10. state-store-parse-error: state store JSON 损坏 → 阻断（不回退 skeleton）", () => {
    const chapterNumber = 3;
    setupBaseWorkspace();
    writePrevChapterFile(chapterNumber - 1, "第二章正文。");
    // 写损坏的 JSON
    writeFileSync(
      join(testWorkspacePath, "narrative-state-store.json"),
      "{ invalid json ,, }",
      "utf-8",
    );
    // 不写 skeleton

    const report = runPreflight(chapterNumber);

    assert.equal(report.passed, false, "state store JSON 损坏应阻断");
    const stateBlock = report.blockingItems.find(b => b.check === "previous_state_store_invalid");
    assert.ok(stateBlock, "state store 解析失败应阻断 previous_state_store_invalid");
    cleanupTestWorkspace();
  });
});
