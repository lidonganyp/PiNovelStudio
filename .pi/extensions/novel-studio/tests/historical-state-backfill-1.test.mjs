/** HISTORICAL-STATE-BACKFILL-1: accepted chapters seed the four long-term state classes. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { backfillAcceptedChapterState, selectAcceptedChapterReferences } from "../dist/v2/core/historical-state-backfill.js";
import { createContextCompiler } from "../dist/v2/core/context-compiler.js";
import { loadStateStore, saveStateStore } from "../dist/v2/core/final-state-commit.js";

function makeWorkspace() {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-history-backfill-"));
  const workspaceId = "history";
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(join(workspacePath, "chapters"), { recursive: true });
  mkdirSync(join(workspacePath, "characters"), { recursive: true });
  mkdirSync(join(workspacePath, "series"), { recursive: true });
  writeFileSync(join(workspacePath, "config.json"), JSON.stringify({
    genre: "都市悬疑",
    chapterProgress: { completed: 3 },
    characters: [
      { id: "lin-chuan", name: "林川", role: "protagonist" },
      { id: "xu-lan", name: "许岚", role: "supporting" },
    ],
  }), "utf8");
  writeFileSync(join(workspacePath, "characters", "lin-chuan.md"), "# 林川\n\n## 性格画像\n- 冷静，先验证再行动\n", "utf8");
  writeFileSync(join(workspacePath, "chapters", "chapter-01.md"), "林川在旧仓库发现一把刻着许岚名字的钥匙。门后传来三次敲击。", "utf8");
  writeFileSync(join(workspacePath, "chapters", "chapter-02.md"), [
    "许岚否认见过钥匙。林川没有追问，只把钥匙装进口袋。走廊尽头又响起三次敲击。",
    "",
    "---",
    "",
    "## 本章创作备注",
    "",
    "### 工艺亮点",
    "- 对白比例固定为测试值（不得进入正文上下文）",
  ].join("\n"), "utf8");
  writeFileSync(join(workspacePath, "chapters", "chapter-03.md"), "第三章属于当前目标章，不得提前迁移进第三章上下文。", "utf8");
  writeFileSync(join(workspacePath, "chapter-hooks-ledger.md"), [
    "| 编号 | 名称 | 埋入章 | 当前状态 |",
    "|---|---|---|---|",
    "| F-01 | 旧钥匙来源 | 第1章 | opened |",
  ].join("\n"), "utf8");
  return { projectRoot, workspaceId, workspacePath };
}

test("接受稿幂等迁移为 Canon/Character/Promise/Pattern 四类状态", () => {
  const ws = makeWorkspace();
  try {
    const first = backfillAcceptedChapterState({
      projectRoot: ws.projectRoot,
      workspaceId: ws.workspaceId,
      beforeChapterNumber: 3,
    });
    const store = loadStateStore(ws.workspaceId, ws.projectRoot);
    assert.equal(first.scannedChapters, 2);
    assert.equal(store.canon.length, 2);
    assert.ok(store.character.some((entry) => entry.characterId === "林川" && entry.sourceChapter === "ch1"));
    assert.ok(store.character.some((entry) => entry.characterId === "许岚" && entry.sourceChapter === "ch2"));
    assert.ok(store.character.some((entry) => entry.characterId === "林川" && entry.value.includes("旧仓库")));
    assert.ok(store.promise.some((entry) => entry.promiseId === "F-01" && entry.sourceChapter === "ch1"));
    assert.ok(store.pattern.some((entry) => entry.sourceChapter === "ch1"));
    assert.equal(store.canon.some((entry) => entry.sourceChapter === "ch3"), false);
    const ch1Text = readFileSync(join(ws.workspacePath, "chapters", "chapter-01.md"), "utf8");
    const ch1Hash = createHash("sha256").update(ch1Text).digest("hex").slice(0, 12);
    assert.match(store.canon.find((entry) => entry.sourceChapter === "ch1").sourceRef, new RegExp(`^ch1#finalText:${ch1Hash}:\\d+-\\d+$`));
    assert.ok(store.canon.every((entry) => /^ch\d+#finalText:[0-9a-f]{12}:\d+-\d+$/u.test(entry.sourceRef)));
    assert.ok(store.canon.every((entry) => !/本章创作备注|工艺亮点|对白比例/u.test(entry.fact)));

    const references = selectAcceptedChapterReferences({
      projectRoot: ws.projectRoot,
      workspaceId: ws.workspaceId,
      beforeChapterNumber: 3,
      relevantCharacters: ["林川", "许岚"],
      keywords: ["钥匙"],
      maxExamples: 2,
    });
    assert.ok(references.examples.every((entry) => !/本章创作备注|工艺亮点|对白比例/u.test(entry.text)));

    const counts = [store.canon.length, store.character.length, store.promise.length, store.pattern.length];
    const second = backfillAcceptedChapterState({
      projectRoot: ws.projectRoot,
      workspaceId: ws.workspaceId,
      beforeChapterNumber: 3,
    });
    const afterSecond = loadStateStore(ws.workspaceId, ws.projectRoot);
    assert.equal(second.addedEntries, 0);
    assert.deepEqual(
      [afterSecond.canon.length, afterSecond.character.length, afterSecond.promise.length, afterSecond.pattern.length],
      counts,
    );
  } finally {
    rmSync(ws.projectRoot, { recursive: true, force: true });
  }
});

test("ContextCompiler 在读取长期状态前自动回填目标章之前的接受稿", () => {
  const ws = makeWorkspace();
  try {
    const compiled = createContextCompiler().compile({
      projectRoot: ws.projectRoot,
      workspaceId: ws.workspaceId,
      chapterId: "3",
      chapterNumber: 3,
    });
    assert.ok(compiled.context.longTermState);
    assert.ok(compiled.context.longTermState.canon.some((entry) => entry.sourceChapter === "ch2"));
    assert.equal(compiled.context.longTermState.canon.some((entry) => entry.sourceChapter === "ch3"), false);
  } finally {
    rmSync(ws.projectRoot, { recursive: true, force: true });
  }
});

test("历史回填不得降低既有 lastCommittedChapter 水位", () => {
  const ws = makeWorkspace();
  try {
    const store = loadStateStore(ws.workspaceId, ws.projectRoot);
    store.lastCommittedChapter = "ch9";
    saveStateStore(store, ws.workspaceId, ws.projectRoot);

    backfillAcceptedChapterState({
      projectRoot: ws.projectRoot,
      workspaceId: ws.workspaceId,
      beforeChapterNumber: 3,
    });

    assert.equal(loadStateStore(ws.workspaceId, ws.projectRoot).lastCommittedChapter, "ch9");
  } finally {
    rmSync(ws.projectRoot, { recursive: true, force: true });
  }
});

test("历史回填升级自己生成的旧人物占位条目且不重复新增", () => {
  const ws = makeWorkspace();
  try {
    const store = loadStateStore(ws.workspaceId, ws.projectRoot);
    store.character.push({
      id: "character:accepted-participation:林川:ch1",
      kind: "character",
      characterId: "林川",
      field: "acceptedChapterParticipation",
      value: "第1章接受稿中在场",
      sourceChapter: "ch1",
      sourceRef: "chapters/chapter-01.md#accepted:legacy:0-2",
      confidence: 1,
      lastUpdated: "2026-01-01T00:00:00.000Z",
    });
    saveStateStore(store, ws.workspaceId, ws.projectRoot);

    const report = backfillAcceptedChapterState({
      projectRoot: ws.projectRoot,
      workspaceId: ws.workspaceId,
      beforeChapterNumber: 3,
    });
    const upgraded = loadStateStore(ws.workspaceId, ws.projectRoot).character
      .filter((entry) => entry.id === "character:accepted-participation:林川:ch1");

    assert.equal(upgraded.length, 1);
    assert.equal(report.updatedEntries, 1);
    assert.equal(upgraded[0].field, "acceptedChapterEvidence");
    assert.match(upgraded[0].value, /旧仓库/);
  } finally {
    rmSync(ws.projectRoot, { recursive: true, force: true });
  }
});
