/** Realm transitions are staged only from explicit, ontology-backed irreversible changes. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildStagedStateUpdate } from "../dist/v2/core/unified-entry.js";
import { reanchorStagedStateToFinalText } from "../dist/v2/core/final-state-commit.js";

function makeSeed(expectedIrreversibleChange) {
  return {
    workspaceId: "realm-state-test",
    chapterId: "18",
    chapterNumber: 18,
    chapterFunction: "payoff",
    worldConstraint: { genre: "灵异", subGenres: [], immutableFacts: [] },
    characters: [{ name: "李一凡", role: "protagonist", aliases: [] }],
    previousChapterContinuation: { available: true, openHooks: [], unresolvedTensions: [], introducedCharacters: [] },
    currentPressure: { pendingForeshadowing: [] },
    unsettledDetails: [],
    candidateAnchors: [],
    highLevelDirection: { available: false, backgroundNotes: [], immutableFacts: [] },
    intent: {
      primary: "character",
      secondary: [],
      keywords: [],
      chapterTheme: "突破代价",
      targetEmotions: [],
      expectedIrreversibleChange,
      _source: "chapterSeed",
    },
    builtAt: new Date().toISOString(),
  };
}

test("explicit ontology-backed realm transition is staged and reanchored to final text", () => {
  const staged = buildStagedStateUpdate(
    makeSeed(["李一凡炼体进度正式迈入淬腑境初期"]),
    18,
    ["炼体（锻骨/淬腑/易筋/洗髓/金身）"],
  );
  const realm = staged.additions.find((entry) => entry.kind === "character" && entry.field === "realm");
  assert.ok(realm);
  assert.equal(realm.characterId, "李一凡");
  assert.equal(realm.value, "淬腑境初期");
  assert.equal(realm.id, "character:李一凡:realm");

  const reanchored = reanchorStagedStateToFinalText(
    staged,
    "李一凡缓缓睁开眼。淬腑境，初期。力量终于沉入脏腑。",
    18,
  );
  const committedRealm = reanchored.additions.find((entry) => entry.kind === "character" && entry.field === "realm");
  assert.ok(committedRealm);
  assert.match(committedRealm.sourceRef, /#finalText:[a-f0-9]+:\d+-\d+$/);
  assert.ok(committedRealm.confidence >= 0.7);
});

test("realm staging rejects unchanged or unknown levels", () => {
  const levels = ["炼体（锻骨/淬腑/易筋/洗髓/金身）"];
  const unchanged = buildStagedStateUpdate(makeSeed(["李一凡仍停留在淬腑境初期"]), 18, levels);
  const unknown = buildStagedStateUpdate(makeSeed(["李一凡正式迈入化神境"]), 18, levels);
  assert.equal(unchanged.additions.some((entry) => entry.kind === "character" && entry.field === "realm"), false);
  assert.equal(unknown.additions.some((entry) => entry.kind === "character" && entry.field === "realm"), false);
});
