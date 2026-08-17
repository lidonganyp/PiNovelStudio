/**
 * CEG-1.1~1.5 / CEG-4.5 — 冻结快照、单一读取源、内容 hash。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildNarrativeEvidenceSnapshot } from "../dist-test/v2/core/narrative-evidence-snapshot.js";
import { NarrativeSearchService } from "../dist/novelos/agent/narrative-search-service.js";
import { deriveContextHashFromCompiled, deriveLegacyQuantityContextHash } from "../dist/v2/adapters/legacy-trace-adapter.js";
import { isLegacyQuantityContextHash } from "../dist-test/v2/core/evidence-governance-contracts.js";
import { buildHistoricalContext } from "../dist/v2/core/model-prompt-adapter.js";
import { retrieveNarrativeContext } from "../dist/v2/core/context-retrieval.js";

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

test("CEG-1.1: snapshot 使用正式 store，内容变化后 knowledgeSnapshotHash 变化", () => {
  const root = mkdtempSync(join(tmpdir(), "ceg-w1-snap-"));
  const workspaceId = "ceg-w1";
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
      events: [{ eventId: "evt-legacy-alive", summary: "legacy文件：叶尘还活着", characters: ["叶尘"] }],
    });
    const first = buildNarrativeEvidenceSnapshot({
      workspaceId,
      projectRoot: root,
      chapterNumber: 11,
      prepareBackfill: false,
    });
    assert.match(first.knowledgeSnapshotHash, /^[0-9a-f]{64}$/);
    assert.equal(first.narrativeState.canon[0].fact.includes("身死"), true);
    writeJson(join(ws, "narrative-state-store.json"), {
      schemaVersion: 1,
      workspaceId,
      canon: [makeCanon("canon:official:yechen", "正式store：叶尘已复活", "ch10")],
      character: [],
      promise: [],
      pattern: [],
      lastCommittedChapter: "ch10",
      updatedAt: "2026-08-15T00:00:00.000Z",
    });
    const second = buildNarrativeEvidenceSnapshot({
      workspaceId,
      projectRoot: root,
      chapterNumber: 11,
      prepareBackfill: false,
    });
    assert.notEqual(first.knowledgeSnapshotHash, second.knowledgeSnapshotHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CEG-1.4/G1: SearchService 不再从 legacy 文件给出第二套真相", () => {
  const root = mkdtempSync(join(tmpdir(), "ceg-w1-truth-"));
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
      events: [{ eventId: "evt-legacy-alive", summary: "legacy文件：叶尘还活着并离开青鱼嘴", characters: ["叶尘"] }],
    });
    const snapshot = buildNarrativeEvidenceSnapshot({
      workspaceId,
      projectRoot: root,
      chapterNumber: 11,
      prepareBackfill: false,
    });
    const officialFacts = snapshot.narrativeState.canon.map((e) => e.fact);
    const search = new NarrativeSearchService({
      projectRoot: root,
      workspaceId,
      sourceChapter: "ch10",
      evidenceSnapshot: snapshot,
    });
    const dynamicFacts = search.queryCanon().map((e) => e.fact);
    assert.deepEqual(dynamicFacts, officialFacts);
    assert.equal(dynamicFacts.some((fact) => fact.includes("还活着")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CEG-1.5/G4: 同一 SearchService 实例冻结历史正文", () => {
  const root = mkdtempSync(join(tmpdir(), "ceg-w1-live-"));
  const workspaceId = "ceg-live-mutate";
  const chapterDir = join(root, "workspaces", workspaceId, "chapters", "chapter-1");
  try {
    mkdirSync(chapterDir, { recursive: true });
    writeFileSync(join(chapterDir, "final.md"), "冻结正文：碎星剑在叶尘手里。", "utf8");
    const snapshot = buildNarrativeEvidenceSnapshot({
      workspaceId,
      projectRoot: root,
      chapterNumber: 2,
      prepareBackfill: false,
    });
    const search = new NarrativeSearchService({
      projectRoot: root,
      workspaceId,
      sourceChapter: "ch1",
      evidenceSnapshot: snapshot,
    });
    const before = search.searchChapterSpan("碎星剑");
    assert.ok(before.length > 0);
    writeFileSync(join(chapterDir, "final.md"), "改写后正文：碎星剑已碎，只剩剑柄。", "utf8");
    const after = search.searchChapterSpan("碎星剑");
    assert.deepEqual(after.map((span) => span.excerpt), before.map((span) => span.excerpt));
    assert.equal(after.some((span) => span.excerpt.includes("已碎")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CEG-4.5: 生产 contextHash 是内容 hash，不再写数量签名", () => {
  const counts = {
    facts: [{ id: "f1", content: "叶尘持有碎星剑" }],
    openLoops: [{ id: "l1", description: "血玉来历未揭" }],
    characterStates: [{ characterId: "c1", value: "筑基" }],
    worldRules: [{ id: "w1", description: "宗门不可私斗" }],
    styleReferences: [{ id: "s1" }],
  };
  const changed = {
    ...counts,
    facts: [{ id: "f1", content: "碎星剑已断，叶尘改持尘心诀" }],
  };
  const before = deriveContextHashFromCompiled(counts);
  const after = deriveContextHashFromCompiled(changed);
  assert.equal(isLegacyQuantityContextHash(before), false);
  assert.notEqual(before, after);
  assert.equal(deriveLegacyQuantityContextHash(counts), "f1-l1-c1-w1-s1");
});

test("CEG-3.4: renderer 截断必须留下 dropReason", () => {
  const canon = [];
  for (let chapter = 1; chapter <= 8; chapter += 1) {
    canon.push(makeCanon(`canon:old:${chapter}`, `第${chapter}章硬事实：封印核心规则-${chapter}`, `ch${chapter}`));
  }
  const retrieval = retrieveNarrativeContext({
    chapterNumber: 20,
    relevantCharacters: [],
    selectedPromiseIds: [],
    keywords: ["硬事实"],
    state: { canon, character: [], promise: [], pattern: [] },
    maxItems: 24,
  });
  const rendered = buildHistoricalContext({
    context: { longTermState: { canon: retrieval.workingSet.canon, character: [], promise: [], pattern: [] } },
    intent: { relevantCharacters: [], focusCharacterGoals: [] },
  });
  const renderedText = (rendered.historicalContinuity ?? []).join("\n");
  const missingSelected = retrieval.workingSet.canon.filter((entry) => !renderedText.includes(entry.fact));
  const droppedIds = new Set(rendered.rendererDrops.map((drop) => drop.evidenceId));
  for (const entry of missingSelected) {
    assert.equal(droppedIds.has(entry.id), true, `${entry.id} 丢失但没有 dropReason`);
  }
});
