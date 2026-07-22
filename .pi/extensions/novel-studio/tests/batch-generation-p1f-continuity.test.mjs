/**
 * P1-F 验收测试 — 跨章钩子结构化传递
 *
 * 用户验收要求：
 *   "让第 N 章产生唯一事件/钩子，并断言它真实进入第 N+1 章的模型上下文"
 *
 * 本测试覆盖 P1-F 完整链路：
 *   1. 生产者：writeChapterContinuitySnapshot 从 reanchored stagedStateUpdate 提取
 *      带有 finalText span 证据的 openHooks / introducedCharacters / unresolvedTensions
 *   2. 消费者：buildChapterSeed → loadPreviousChapterTextContinuation 从快照加载
 *      上述字段并写入 ChapterSeed.previousChapterContinuation
 *   3. 端到端：第 N 章快照含唯一钩子 → 第 N+1 章 previousChapterContinuation.openHooks
 *      包含该钩子（证明进入下一章模型上下文）
 *   4. 回退：快照缺失时回退到仅正文尾部（openHooks 为空，不阻断）
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createBatchWorkspace,
  writeContinuitySnapshot,
  cleanupWorkspace,
  PROJECT_ROOT,
  EXT_ROOT,
} from "./batch-test-helpers.mjs";

// 加载编译后的生产模块（craft/ 在生产闭包内）
const { buildChapterSeed } = await import(
  pathToFileURL(join(EXT_ROOT, "dist", "craft", "chapter-seed-builder.js")).href
);
const {
  writeChapterContinuitySnapshot,
  loadChapterContinuitySnapshot,
} = await import(
  pathToFileURL(join(EXT_ROOT, "dist", "craft", "chapter-continuity-snapshot.js")).href
);

const UNIQUE_HOOK = "UNIQUE_HOOK_P1F_ACCEPTANCE_星辰之钥尚未现世";
const UNIQUE_CHARACTER = "叶尘";
const UNIQUE_TENSION = "传承觉醒引来暗处追踪者";

// ============================================================================
// 生产者测试：writeChapterContinuitySnapshot 提取逻辑
// ============================================================================

describe("P1-F 生产者：writeChapterContinuitySnapshot 从 reanchored 提取钩子", () => {
  const wsId = "batch-p1f-producer-test";
  let workspacePath;

  before(() => {
    workspacePath = createBatchWorkspace(wsId);
  });

  after(() => {
    cleanupWorkspace(wsId);
  });

  it("promise (open) + expectation (delayed) + character → 快照含全部字段", () => {
    // 模拟 reanchored stagedStateUpdate：additions 含带 finalText span 证据的 entries
    const finalText = "# 第1章\n\n叶尘接受了上古传承，但传承中提到的「星辰之钥」尚未现世。";
    const finalTextHash = "abc123def456";
    // 有 span 证据的 sourceRef
    const spanRef = `ch1#finalText:${finalTextHash}:10-25`;
    const spanRef2 = `ch1#finalText:${finalTextHash}:30-50`;
    // 无 span 证据的 sourceRef（应被过滤）
    const notFoundRef = `ch1#finalText:${finalTextHash}:not-found`;
    const conflictRef = `ch1#finalText:${finalTextHash}:semantic-conflict`;

    const reanchored = {
      additions: [
        // promise (open) → openHooks + unresolvedTensions
        { kind: "promise", sourceRef: spanRef, description: UNIQUE_HOOK, status: "open" },
        // promise (advancing) → openHooks only
        { kind: "promise", sourceRef: spanRef2, description: "传承已激活", status: "advancing" },
        // expectation (delayed) → openHooks + unresolvedTensions
        { kind: "expectation", sourceRef: spanRef, description: UNIQUE_TENSION, status: "delayed" },
        // character → introducedCharacters
        { kind: "character", sourceRef: spanRef, characterId: UNIQUE_CHARACTER },
        // promise (not-found) → 应被过滤
        { kind: "promise", sourceRef: notFoundRef, description: "应被过滤的钩子", status: "open" },
        // expectation (semantic-conflict) → 应被过滤
        { kind: "expectation", sourceRef: conflictRef, description: "应被过滤的张力", status: "delayed" },
      ],
    };

    writeChapterContinuitySnapshot(workspacePath, 1, finalText, reanchored, finalTextHash);

    // 读取快照验证
    const snapshot = loadChapterContinuitySnapshot(workspacePath, 1);
    assert.ok(snapshot, "快照应存在");
    assert.equal(snapshot.chapterNumber, 1);
    assert.equal(snapshot.finalTextHash, finalTextHash);

    // openHooks 应含 UNIQUE_HOOK 和 "传承已激活" 和 UNIQUE_TENSION，不含被过滤的
    assert.ok(
      snapshot.openHooks.includes(UNIQUE_HOOK),
      `openHooks 应含唯一钩子，实际: ${JSON.stringify(snapshot.openHooks)}`,
    );
    assert.ok(
      snapshot.openHooks.includes("传承已激活"),
      `openHooks 应含 advancing promise，实际: ${JSON.stringify(snapshot.openHooks)}`,
    );
    assert.ok(
      snapshot.openHooks.includes(UNIQUE_TENSION),
      `openHooks 应含 delayed expectation，实际: ${JSON.stringify(snapshot.openHooks)}`,
    );
    assert.ok(
      !snapshot.openHooks.includes("应被过滤的钩子"),
      "not-found sourceRef 的 entry 不应进入 openHooks",
    );
    assert.ok(
      !snapshot.openHooks.includes("应被过滤的张力"),
      "semantic-conflict sourceRef 的 entry 不应进入 openHooks",
    );

    // introducedCharacters 应含 UNIQUE_CHARACTER
    assert.ok(
      snapshot.introducedCharacters.includes(UNIQUE_CHARACTER),
      `introducedCharacters 应含 "叶尘"，实际: ${JSON.stringify(snapshot.introducedCharacters)}`,
    );

    // unresolvedTensions 应含 UNIQUE_HOOK (open promise) 和 UNIQUE_TENSION (delayed expectation)
    assert.ok(
      snapshot.unresolvedTensions.includes(UNIQUE_HOOK),
      `unresolvedTensions 应含 open promise 描述，实际: ${JSON.stringify(snapshot.unresolvedTensions)}`,
    );
    assert.ok(
      snapshot.unresolvedTensions.includes(UNIQUE_TENSION),
      `unresolvedTensions 应含 delayed expectation，实际: ${JSON.stringify(snapshot.unresolvedTensions)}`,
    );

    // sourceRefs 应含有 span 证据的 sourceRef
    assert.ok(
      snapshot.sourceRefs.includes(spanRef),
      `sourceRefs 应含 span sourceRef，实际: ${JSON.stringify(snapshot.sourceRefs)}`,
    );
    assert.ok(
      !snapshot.sourceRefs.includes(notFoundRef),
      "sourceRefs 不应含 not-found sourceRef",
    );
  });

  it("reanchored 为 null（无 stagedStateUpdate）→ 快照含空数组", () => {
    const finalText = "# 第2章\n\n这一章没有 stagedStateUpdate。";
    writeChapterContinuitySnapshot(workspacePath, 2, finalText, null, "hash0000001");

    const snapshot = loadChapterContinuitySnapshot(workspacePath, 2);
    assert.ok(snapshot, "快照应存在");
    assert.equal(snapshot.openHooks.length, 0, "无 stagedStateUpdate 时 openHooks 应为空");
    assert.equal(snapshot.introducedCharacters.length, 0, "无 stagedStateUpdate 时 introducedCharacters 应为空");
    assert.equal(snapshot.unresolvedTensions.length, 0, "无 stagedStateUpdate 时 unresolvedTensions 应为空");
    assert.ok(snapshot.lastEventSummary.length > 0, "lastEventSummary 应非空");
  });
});

// ============================================================================
// 消费者测试：buildChapterSeed 从快照加载前章承接
// ============================================================================

describe("P1-F 消费者：buildChapterSeed 从快照加载 previousChapterContinuation", () => {
  const wsId = "batch-p1f-consumer-test";
  let workspacePath;

  before(() => {
    workspacePath = createBatchWorkspace(wsId);
  });

  after(() => {
    cleanupWorkspace(wsId);
  });

  it("第 1 章快照含唯一钩子 → 第 2 章 previousChapterContinuation.openHooks 包含该钩子", () => {
    // 1. 模拟第 1 章已生成：写章节文件
    const chapter1Text = "# 第1章\n\n叶尘接受了上古传承，但传承中提到的「星辰之钥」尚未现世。传承觉醒的波动在暗处引起了注意。";
    writeFileSync(join(workspacePath, "chapters", "1.md"), chapter1Text, "utf-8");

    // 2. 写第 1 章连续性快照（含唯一钩子）—— 模拟 commitAndSave 的 P1-F 写入
    writeContinuitySnapshot(workspacePath, 1, chapter1Text, {
      openHooks: [UNIQUE_HOOK],
      introducedCharacters: [UNIQUE_CHARACTER],
      unresolvedTensions: [UNIQUE_TENSION],
    });

    // 3. 加载真实 ChapterSeedBuilder，为第 2 章构建 ChapterSeed
    const { seed, warnings } = buildChapterSeed({
      workspacePath,
      workspaceId: wsId,
      chapterId: "2",
      chapterNumber: 2,
    });

    // 4. 断言唯一钩子进入了第 2 章的 previousChapterContinuation.openHooks
    //    —— 这证明钩子进入了下一章模型上下文（ChapterSeed → ContextCompiler → 模型 prompt）
    assert.ok(seed.previousChapterContinuation, "第 2 章 seed 应有 previousChapterContinuation");
    assert.ok(
      seed.previousChapterContinuation.available,
      "前章承接应标记为 available",
    );

    assert.ok(
      seed.previousChapterContinuation.openHooks.includes(UNIQUE_HOOK),
      `第 2 章 openHooks 应含唯一钩子 "${UNIQUE_HOOK}"，实际: ${JSON.stringify(seed.previousChapterContinuation.openHooks)}`,
    );

    // 5. 断言 introducedCharacters 也被传递
    assert.ok(
      seed.previousChapterContinuation.introducedCharacters.includes(UNIQUE_CHARACTER),
      `第 2 章 introducedCharacters 应含 "${UNIQUE_CHARACTER}"，实际: ${JSON.stringify(seed.previousChapterContinuation.introducedCharacters)}`,
    );

    // 6. 断言 unresolvedTensions 也被传递
    assert.ok(
      seed.previousChapterContinuation.unresolvedTensions.includes(UNIQUE_TENSION),
      `第 2 章 unresolvedTensions 应含 "${UNIQUE_TENSION}"，实际: ${JSON.stringify(seed.previousChapterContinuation.unresolvedTensions)}`,
    );

    // 7. sourceIds 应包含快照路径（可追溯）
    assert.ok(
      seed.previousChapterContinuation.sourceIds?.some(s => s.includes("chapter-continuity")),
      `sourceIds 应含 chapter-continuity 路径，实际: ${JSON.stringify(seed.previousChapterContinuation.sourceIds)}`,
    );
  });

  it("快照缺失时回退到仅正文尾部（openHooks 为空，不阻断）", () => {
    // 写章节文件但不写快照
    const chapter1Text = "# 第1章\n\n叶尘接受了上古传承。";
    // 重置 workspace（清掉前一个 case 的快照）
    cleanupWorkspace(wsId);
    workspacePath = createBatchWorkspace(wsId);
    writeFileSync(join(workspacePath, "chapters", "1.md"), chapter1Text, "utf-8");

    const { seed } = buildChapterSeed({
      workspacePath,
      workspaceId: wsId,
      chapterId: "2",
      chapterNumber: 2,
    });

    assert.ok(
      seed.previousChapterContinuation?.available,
      "快照缺失时前章承接仍应可用（回退到正文尾部）",
    );
    assert.equal(
      seed.previousChapterContinuation.openHooks.length,
      0,
      "快照缺失时 openHooks 应为空（旧行为）",
    );
    assert.equal(
      seed.previousChapterContinuation.introducedCharacters.length,
      0,
      "快照缺失时 introducedCharacters 应为空（旧行为）",
    );
    assert.ok(
      seed.previousChapterContinuation.lastEventSummary?.length > 0,
      "快照缺失时仍应有 lastEventSummary（来自正文尾部）",
    );
  });

  it("第 1 章无前章承接（chapterNumber=1）→ available=false", () => {
    const { seed } = buildChapterSeed({
      workspacePath,
      workspaceId: wsId,
      chapterId: "1",
      chapterNumber: 1,
    });

    assert.ok(
      !seed.previousChapterContinuation?.available,
      "第 1 章不应有前章承接",
    );
  });
});

// ============================================================================
// 端到端：Mock 写快照 → buildChapterSeed 读快照
// ============================================================================

describe("P1-F 端到端：Mock 写快照 → buildChapterSeed 读快照", () => {
  const wsId = "batch-p1f-e2e-test";

  after(() => {
    cleanupWorkspace(wsId);
  });

  it("Mock 生成的第 1 章快照 → 第 2 章 buildChapterSeed 读到同一钩子", async () => {
    const workspacePath = createBatchWorkspace(wsId);

    // 1. 模拟第 1 章生成完成：用 writeContinuitySnapshot 写入唯一钩子
    //    （模拟 commitAndSave 调用 writeChapterContinuitySnapshot）
    const chapter1Text = "# 第1章\n\n叶尘接受传承，「星辰之钥」的线索浮现。";
    writeFileSync(join(workspacePath, "chapters", "1.md"), chapter1Text, "utf-8");
    writeContinuitySnapshot(workspacePath, 1, chapter1Text, {
      openHooks: [UNIQUE_HOOK],
      introducedCharacters: [UNIQUE_CHARACTER],
    });

    // 2. 读取快照验证 Mock 写入正确
    const snapshot = loadChapterContinuitySnapshot(workspacePath, 1);
    assert.ok(snapshot, "第 1 章快照应存在");
    assert.ok(
      snapshot.openHooks.includes(UNIQUE_HOOK),
      "快照 openHooks 应含唯一钩子",
    );

    // 3. 第 2 章构建 ChapterSeed（真实 buildChapterSeed）
    const { seed } = buildChapterSeed({
      workspacePath,
      workspaceId: wsId,
      chapterId: "2",
      chapterNumber: 2,
    });

    // 4. 断言唯一钩子从第 1 章快照传递到第 2 章 previousChapterContinuation
    assert.ok(
      seed.previousChapterContinuation.openHooks.includes(UNIQUE_HOOK),
      `第 2 章应从第 1 章快照继承唯一钩子，实际 openHooks: ${JSON.stringify(seed.previousChapterContinuation.openHooks)}`,
    );
    assert.ok(
      seed.previousChapterContinuation.introducedCharacters.includes(UNIQUE_CHARACTER),
      `第 2 章应从第 1 章快照继承 introducedCharacters，实际: ${JSON.stringify(seed.previousChapterContinuation.introducedCharacters)}`,
    );

    cleanupWorkspace(wsId);
  });
});
