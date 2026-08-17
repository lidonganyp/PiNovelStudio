/**
 * CEG-6 / CEG-7 — Wave 5 分层对照门槛 + Wave 6 长篇 fixture / 故障注入。
 * 不调用真实模型；真实 A/B 由 scripts/ceg-wave5-layering-ab.mjs 单独跑。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { materializeCegLongformFixture } from "../dist-test/v2/core/ceg-wave6-longform-fixture.js";
import { scoreLayeringDeterministic } from "../dist-test/v2/core/ceg-wave5-metrics.js";
import { buildNarrativeEvidenceSnapshot, readFrozenChapterText } from "../dist-test/v2/core/narrative-evidence-snapshot.js";
import { NarrativeSearchService } from "../dist/novelos/agent/narrative-search-service.js";
import {
  buildRetrievalOutcome,
  createCegFailure,
} from "../dist-test/v2/core/evidence-governance-contracts.js";
import { evaluateEvidenceEligibility } from "../dist-test/v2/core/evidence-eligibility-gate.js";
import { renderContract, renderLayeredContract } from "../dist/v2/core/model-prompt-adapter.js";

function emptyContract(overrides = {}) {
  return {
    workIdentity: [],
    readerPromises: [],
    genrePromises: [],
    protagonistCoreConflict: [],
    thematicQuestions: [],
    forbiddenDrift: [],
    overallPlotDirection: [],
    chapterFunction: [],
    readerExperience: [],
    currentPressure: [],
    previousState: [],
    relevantCharacters: [],
    relevantCharacterStates: [],
    historicalContinuity: [],
    historicalCharacterState: [],
    recentPatternMemory: [],
    characterMotivations: [],
    focusCharacterGoals: [],
    resistance: [],
    choicesAndCosts: [],
    expectedIrreversibleChange: [],
    selectedPromisesToAdvance: [],
    selectedExpectationsToAdvance: [],
    causalEndPressure: [],
    eventSummaries: [],
    mustInclude: [],
    stateChanges: [],
    foreshadowing: [],
    causalRelations: [],
    endingTarget: [],
    inviolableFacts: [],
    stateConstraints: [],
    forbidReferenceLeakage: true,
    preserveEstablishedState: true,
    ...overrides,
  };
}

test("CEG-6.2: 平铺/分层共享同一硬事实，分层才声明权威层", () => {
  const contract = emptyContract({
    inviolableFacts: ["叶尘已死", "碎星剑已断"],
    historicalContinuity: ["ch1｜叶尘持剑"],
    chapterFunction: ["推进复仇"],
    forbiddenDrift: ["不得复活叶尘"],
  });
  const flat = renderContract(contract);
  const layered = renderLayeredContract(contract);
  const score = scoreLayeringDeterministic({
    inviolableFacts: contract.inviolableFacts,
    futureChapterMarkers: ["ch99", "第99章"],
    flatPrompt: flat,
    layeredPrompt: layered,
  });
  assert.equal(score.inviolableFactsPresentInBoth, true);
  assert.equal(score.futureLeakInPrompts, 0);
  assert.equal(score.layeredDeclaresAuthorityLayers, true);
  assert.equal(score.flatDeclaresAuthorityLayers, false);
  assert.ok(score.tokenEstimateLayered > 0);
});

test("CEG-7.1: 20/50/100 章 fixture 远章事实可回源，未来章不进 snapshot", () => {
  for (const chapters of [20, 50, 100]) {
    const root = mkdtempSync(join(tmpdir(), `ceg-lf-${chapters}-`));
    try {
      const fixture = materializeCegLongformFixture({
        projectRoot: root,
        workspaceId: `lf-${chapters}`,
        chapters,
      });
      const snapshot = buildNarrativeEvidenceSnapshot({
        workspaceId: fixture.workspaceId,
        projectRoot: root,
        chapterNumber: chapters + 1,
        prepareBackfill: false,
      });
      const far = snapshot.narrativeState.canon.find((e) => e.id === "canon:far:ch1");
      assert.ok(far, `${chapters} 章 fixture 必须含第1章远章事实`);
      assert.equal(far.sourceChapter, "ch1");
      assert.ok(snapshot.narrativeState.character.some((e) => e.field === "knowledgeBoundary"));
      assert.ok(snapshot.narrativeState.promise.some((e) => e.promiseId === "seal"));
      assert.ok(snapshot.narrativeState.pattern.some((e) => e.patternType === "hook_type"));
      assert.ok(snapshot.narrativeState.canon.some((e) => e.id === "canon:far:ch1:superseded"));
      assert.equal(
        snapshot.narrativeState.canon.some((e) => e.sourceChapter === `ch${chapters + 1}`),
        false,
        "未来章不得进入 snapshot",
      );
      const search = new NarrativeSearchService({
        projectRoot: root,
        workspaceId: fixture.workspaceId,
        sourceChapter: `ch${chapters}`,
        evidenceSnapshot: snapshot,
      });
      const hits = search.searchChapterSpan("远章锚点-封印核心", chapters, 10);
      assert.ok(hits.length > 0, `${chapters} 章必须能回源第1章正文`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("CEG-7.3: hash 不匹配 / 空结果 / 检索错误 / 预算耗尽可区分", () => {
  const root = mkdtempSync(join(tmpdir(), "ceg-fault-"));
  try {
    const fixture = materializeCegLongformFixture({
      projectRoot: root,
      workspaceId: "lf-fault",
      chapters: 20,
    });
    const snapshot = buildNarrativeEvidenceSnapshot({
      workspaceId: fixture.workspaceId,
      projectRoot: root,
      chapterNumber: 21,
      prepareBackfill: false,
    });
    const mutated = {
      ...snapshot,
      frozenChapterTexts: snapshot.frozenChapterTexts.map((ch) =>
        ch.chapterNumber === 1 ? { ...ch, text: "被篡改的正文" } : ch,
      ),
    };
    assert.throws(() => readFrozenChapterText(mutated, 1), /snapshot_hash_mismatch/);

    assert.equal(buildRetrievalOutcome({
      queryId: "q-empty", evidence: [], usedCalls: 1, remainingCalls: 1,
    }).status, "no_match");
    assert.equal(buildRetrievalOutcome({
      queryId: "q-err", evidence: [], error: "timeout", usedCalls: 1, remainingCalls: 0,
    }).status, "retrieval_error");
    assert.equal(buildRetrievalOutcome({
      queryId: "q-cut", evidence: [], truncated: true, usedCalls: 1, remainingCalls: 1,
    }).status, "truncated");

    const budget = createCegFailure("retrieval_budget_exhausted", "mustVerify 未覆盖且检索预算耗尽", {
      uncovered: ["封印核心主人"],
      usedCalls: 4,
      remainingCalls: 0,
    });
    assert.equal(budget.failureClass, "blocked");
    assert.equal(budget.gate, "retrieval_budget_exhausted");
    assert.equal(budget.recoverable, false);

    assert.equal(
      evaluateEvidenceEligibility({
        sourceChapter: "ch1",
        currentChapterNumber: 21,
        sourceRef: "ch1#conflict",
        lifecycleStatus: "conflicted",
      }).decision,
      "reject",
    );

    const search = new NarrativeSearchService({
      projectRoot: root,
      workspaceId: fixture.workspaceId,
      sourceChapter: "ch20",
      evidenceSnapshot: snapshot,
    });
    const before = search.queryCanon().map((e) => e.fact);
    writeFileSync(
      join(root, "workspaces", fixture.workspaceId, "narrative-state-store.json"),
      JSON.stringify({
        schemaVersion: 1,
        workspaceId: fixture.workspaceId,
        canon: [{
          id: "canon:injected",
          kind: "canon",
          fact: "并发注入的新事实",
          category: "entity",
          sourceChapter: "ch20",
          sourceRef: "ch20#injected",
          confidence: 1,
          lastUpdated: "2026-08-15T00:00:00.000Z",
        }],
        character: [],
        promise: [],
        pattern: [],
        lastCommittedChapter: "ch20",
        updatedAt: "2026-08-15T00:00:00.000Z",
      }),
      "utf8",
    );
    assert.deepEqual(search.queryCanon().map((e) => e.fact), before);
    assert.equal(search.queryCanon().some((e) => e.fact.includes("并发注入")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
