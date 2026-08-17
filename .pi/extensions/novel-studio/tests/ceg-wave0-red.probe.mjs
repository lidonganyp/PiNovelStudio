/**
 * CEG-0.3 RED 探针 — 目标不变量，当前生产实现上稳定失败。
 *
 * 不纳入 `npm test`（tests/*.test.mjs）。验证命令：
 *   node --import ./tests/setup-test-env.mjs --test --test-concurrency=1 tests/ceg-wave0-red.probe.mjs
 *
 * Wave 1+ 修复后把对应断言迁入正式 *.test.mjs 并删除本探针。
 * 不得为让本文件变绿而改生产排序/读取/裁剪。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deriveContextHashFromCompiled } from "../dist/v2/adapters/legacy-trace-adapter.js";
import { loadStateStore } from "../dist/v2/core/final-state-commit.js";
import { retrieveNarrativeContext } from "../dist/v2/core/context-retrieval.js";
import { buildHistoricalContext } from "../dist/v2/core/model-prompt-adapter.js";
import { NarrativeSearchService } from "../dist/novelos/agent/narrative-search-service.js";
import { isLegacyQuantityContextHash } from "../dist-test/v2/core/evidence-governance-contracts.js";

function makeCanon(id, fact, sourceChapter) {
  return {
    id,
    kind: "canon",
    fact,
    category: "entity",
    sourceChapter,
    sourceRef: `${sourceChapter}#${id}`,
    confidence: 1,
    lastUpdated: "2026-08-15T00:00:00.000Z",
  };
}

function writeJson(filePath, value) {
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

test("CEG-0.3 RED: 正式 store 与 legacy 文件冲突时静态/动态检索必须返回同一冻结事实", () => {
  const root = mkdtempSync(join(tmpdir(), "ceg-wave0-truth-"));
  const workspaceId = "ceg-split-truth";
  const ws = join(root, "workspaces", workspaceId);
  try {
    mkdirSync(ws, { recursive: true });
    writeJson(join(ws, "narrative-state-store.json"), {
      schemaVersion: 1,
      workspaceId,
      canon: [makeCanon("canon:official:yechen", "正式store：叶尘已在第10章身死", "ch10")],
      character: [],
      promise: [],
      pattern: [],
      lastCommittedChapter: "ch10",
      updatedAt: "2026-08-15T00:00:00.000Z",
    });
    writeJson(join(ws, "skeleton.json"), {
      chapterId: "ch10",
      events: [
        {
          eventId: "evt-legacy-alive",
          summary: "legacy文件：叶尘还活着并离开青鱼嘴",
          characters: ["叶尘"],
          location: "青鱼嘴",
        },
      ],
    });

    const official = loadStateStore(workspaceId, root);
    const search = new NarrativeSearchService({
      projectRoot: root,
      workspaceId,
      sourceChapter: "ch10",
    });
    const dynamicCanon = search.queryCanon();

    const officialFacts = official.canon.map((entry) => entry.fact).sort();
    const dynamicFacts = dynamicCanon.map((entry) => entry.fact).sort();

    assert.deepEqual(
      dynamicFacts,
      officialFacts,
      "同一 run 的动态检索必须消费正式 snapshot，不得再从 LegacyStateAdapter 给出第二套答案",
    );
    assert.equal(
      dynamicCanon.some((entry) => entry.fact.includes("还活着")),
      false,
      "生产检索路径不得把 legacy 文件冲突事实当作当前真相",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CEG-0.3 RED: 内容变化但条目数不变时生产 contextHash 必须变化", () => {
  const counts = {
    facts: [{ id: "f1", content: "叶尘持有碎星剑" }],
    openLoops: [{ id: "l1", description: "血玉来历未揭" }],
    characterStates: [{ characterId: "c1", value: "筑基" }],
    worldRules: [{ id: "w1", description: "宗门不可私斗" }],
    styleReferences: [{ id: "s1" }],
  };
  const changed = {
    facts: [{ id: "f1", content: "碎星剑已断，叶尘改持尘心诀" }],
    openLoops: [{ id: "l1", description: "血玉被证实是禁器" }],
    characterStates: [{ characterId: "c1", value: "金丹" }],
    worldRules: [{ id: "w1", description: "宗门允许生死战" }],
    styleReferences: [{ id: "s1" }],
  };

  const before = deriveContextHashFromCompiled(counts);
  const after = deriveContextHashFromCompiled(changed);

  assert.equal(
    isLegacyQuantityContextHash(before),
    false,
    `生产 trace 不得再写入数量签名，实际=${before}`,
  );
  assert.notEqual(before, after, "事实文本变化后 knowledge/context hash 必须变化");
});

test("CEG-0.3 RED: 选择后的二次截断必须留下 dropReason，不得 silently drop", () => {
  const canon = [];
  for (let chapter = 1; chapter <= 8; chapter += 1) {
    canon.push(makeCanon(
      `canon:old:${chapter}`,
      `第${chapter}章硬事实：封印核心规则-${chapter}`,
      `ch${chapter}`,
    ));
  }
  const retrieval = retrieveNarrativeContext({
    chapterNumber: 20,
    relevantCharacters: [],
    selectedPromiseIds: [],
    keywords: ["硬事实"],
    state: { canon, character: [], promise: [], pattern: [] },
    maxItems: 24,
  });
  const selectedIds = retrieval.workingSet.canon.map((entry) => entry.id);
  assert.ok(selectedIds.length >= 6, `预条件：检索应选中多条 canon，实际=${selectedIds.length}`);

  const rendered = buildHistoricalContext({
    context: {
      longTermState: {
        canon: retrieval.workingSet.canon,
        character: [],
        promise: [],
        pattern: [],
      },
    },
    intent: { relevantCharacters: [], focusCharacterGoals: [] },
  });
  const renderedText = (rendered.historicalContinuity ?? []).join("\n");
  const missingSelected = retrieval.workingSet.canon.filter((entry) => !renderedText.includes(entry.fact));
  const droppedIds = new Set((rendered.rendererDrops ?? []).map((drop) => drop.evidenceId));
  for (const entry of missingSelected) {
    assert.equal(droppedIds.has(entry.id), true, `${entry.id} 丢失但没有 renderer dropReason`);
  }
});

test("CEG-0.3 RED: 运行中改写历史正文不得改变当前 run 的检索结果", () => {
  const root = mkdtempSync(join(tmpdir(), "ceg-wave0-live-"));
  const workspaceId = "ceg-live-mutate";
  const chapterDir = join(root, "workspaces", workspaceId, "chapters", "chapter-1");
  try {
    mkdirSync(chapterDir, { recursive: true });
    writeFileSync(join(chapterDir, "final.md"), "冻结正文：碎星剑在叶尘手里。", "utf8");

    const search = new NarrativeSearchService({
      projectRoot: root,
      workspaceId,
      sourceChapter: "ch1",
    });
    const before = search.searchChapterSpan("碎星剑");
    assert.ok(before.length > 0, "预条件：冻结正文应能检索到碎星剑");
    assert.ok(before.some((span) => span.excerpt.includes("在叶尘手里")));

    writeFileSync(join(chapterDir, "final.md"), "改写后正文：碎星剑已碎，只剩剑柄。", "utf8");
    const after = search.searchChapterSpan("碎星剑");

    assert.deepEqual(
      after.map((span) => span.excerpt),
      before.map((span) => span.excerpt),
      "同一 run 必须继续使用冻结正文；live 文件改写不得改变动态检索",
    );
    assert.equal(
      after.some((span) => span.excerpt.includes("已碎")),
      false,
      "不得读到 run 开始后被改写的历史正文",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
