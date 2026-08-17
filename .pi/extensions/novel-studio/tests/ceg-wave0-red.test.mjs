/**
 * CEG-0.3 — 缺口特征测试（当前生产行为，必须通过）。
 *
 * 本文件断言的是**当前缺口真实存在**，不是目标不变量。
 * 目标不变量见 `tests/ceg-wave0-red.probe.mjs`（不进 npm test，旧实现上稳定失败）。
 * Wave 1+ 修复后：删除或反转本文件断言，并把 probe 迁入正式测试。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { deriveContextHashFromCompiled } from "../dist/v2/adapters/legacy-trace-adapter.js";
import { loadStateStore } from "../dist/v2/core/final-state-commit.js";
import { retrieveNarrativeContext } from "../dist/v2/core/context-retrieval.js";
import { buildHistoricalContext } from "../dist/v2/core/model-prompt-adapter.js";
import { NarrativeSearchService } from "../dist/novelos/agent/narrative-search-service.js";
import { isLegacyQuantityContextHash } from "../dist-test/v2/core/evidence-governance-contracts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROBE_PATH = resolve(__dirname, "ceg-wave0-red.probe.mjs");

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

test("CEG-0.3: RED 探针文件已落地且不进入 npm test 通配", () => {
  assert.equal(existsSync(PROBE_PATH), true);
  assert.equal(PROBE_PATH.endsWith(".probe.mjs"), true);
});

test("CEG-0.3 缺口：正式 store 与 LegacyStateAdapter 在同一 workspace 给出不同事实", () => {
  const root = mkdtempSync(join(tmpdir(), "ceg-wave0-gap-truth-"));
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

    const officialFacts = loadStateStore(workspaceId, root).canon.map((entry) => entry.fact);
    const search = new NarrativeSearchService({
      projectRoot: root,
      workspaceId,
      sourceChapter: "ch10",
    });
    const dynamicFacts = search.queryCanon().map((entry) => entry.fact);

    assert.ok(officialFacts.some((fact) => fact.includes("身死")));
    assert.deepEqual(dynamicFacts, officialFacts);
    assert.equal(dynamicFacts.some((fact) => fact.includes("还活着")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CEG-0.3 缺口：deriveContextHashFromCompiled 是数量签名，内容变了 hash 不变", () => {
  const before = deriveContextHashFromCompiled({
    facts: [{ id: "f1", content: "叶尘持有碎星剑" }],
    openLoops: [{ id: "l1", description: "血玉来历未揭" }],
    characterStates: [{ characterId: "c1", value: "筑基" }],
    worldRules: [{ id: "w1", description: "宗门不可私斗" }],
    styleReferences: [{ id: "s1" }],
  });
  const after = deriveContextHashFromCompiled({
    facts: [{ id: "f1", content: "碎星剑已断，叶尘改持尘心诀" }],
    openLoops: [{ id: "l1", description: "血玉被证实是禁器" }],
    characterStates: [{ characterId: "c1", value: "金丹" }],
    worldRules: [{ id: "w1", description: "宗门允许生死战" }],
    styleReferences: [{ id: "s1" }],
  });
  assert.equal(isLegacyQuantityContextHash(before), false);
  assert.notEqual(before, after);
});

test("CEG-0.3 缺口：retrieveNarrativeContext 选中的旧章事实会被 buildHistoricalContext 静默截掉", () => {
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
  assert.ok(retrieval.workingSet.canon.length >= 6);

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

test("CEG-0.3 缺口：运行中改写 chapter final.md 后动态检索读到新正文", () => {
  const root = mkdtempSync(join(tmpdir(), "ceg-wave0-gap-live-"));
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
    assert.ok(before.some((span) => span.excerpt.includes("在叶尘手里")));

    writeFileSync(join(chapterDir, "final.md"), "改写后正文：碎星剑已碎，只剩剑柄。", "utf8");
    const after = search.searchChapterSpan("碎星剑");
    assert.equal(after.some((span) => span.excerpt.includes("已碎")), false);
    assert.deepEqual(
      after.map((span) => span.excerpt),
      before.map((span) => span.excerpt),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
