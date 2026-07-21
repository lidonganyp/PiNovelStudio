/**
 * MethodologyDiagnosticState read-only loader tests.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  createMethodologyDiagnosticStateLoader,
} from "../dist-test/v2/core/methodology-diagnostic-state.js";

function makeWorkspace() {
  return mkdtempSync(join(tmpdir(), "pinovel-methodology-state-"));
}

function writeJson(workspacePath, relativePath, value) {
  const path = join(workspacePath, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
  const oldTime = new Date("2025-01-02T03:04:05.000Z");
  utimesSync(path, oldTime, oldTime);
  return path;
}

function fingerprint(path) {
  const bytes = readFileSync(path);
  return {
    hash: createHash("sha256").update(bytes).digest("hex"),
    mtimeMs: statSync(path).mtimeMs,
    size: bytes.length,
  };
}

function populateWorkspace(workspacePath) {
  const paths = [];
  paths.push(writeJson(workspacePath, "config.json", {
    genre: "都市灵异",
    subGenres: ["规则怪谈", "悬疑"],
  }));
  paths.push(writeJson(workspacePath, "narrative-state-store.json", {
    schemaVersion: 1,
    expectation: [
      {
        kind: "expectation",
        id: "expectation:door",
        expectationId: "door",
        description: "门后的身份何时揭晓",
        status: "open",
        targetReaderExperience: "答案推进但保留更深问题",
        sourceChapter: "ch3",
        sourceRef: "ch3#finalText:aaaaaaaaaaaa:10-20",
      },
      {
        kind: "expectation",
        id: "expectation:future",
        expectationId: "future",
        description: "未来章节信息",
        status: "open",
        sourceChapter: "ch6",
        sourceRef: "ch6#finalText:bbbbbbbbbbbb:10-20",
      },
    ],
    promise: [{
      kind: "promise",
      id: "promise:blood-clock",
      promiseId: "blood-clock",
      description: "血钟规则仍未解释",
      currentHeat: 2,
      status: "advancing",
      sourceChapter: "ch4",
      sourceRef: "ch4#finalText:cccccccccccc:30-42",
    }],
    pattern: [{
      kind: "pattern",
      id: "pattern:repeated-corridor",
      patternType: "horror_template",
      description: "连续使用走廊脚步逼近",
      occurrenceCount: 2,
      sourceChapter: "ch4",
      sourceRef: "ch4#finalText:dddddddddddd:50-70",
    }],
  }));
  paths.push(writeJson(workspacePath, "series/narrative-state.json", {
    currentChapter: 4,
    readerExpectation: {
      unresolvedCount: 3,
      lastPayoffChapter: 2,
      lastPeakMoment: "血钟第一次响起",
      chaptersSinceLastPeak: 2,
    },
    horrorFatigue: {
      recentTechniques: ["unknown_rule", "countdown_pressure"],
      consecutiveSameTechnique: 1,
    },
    relationshipTemperature: {
      "林川|苏婉": {
        state: "cooling",
        lastInteractionChapter: 4,
        pendingTension: "林川隐瞒了血钟代价",
      },
      "未来角色|苏婉": {
        state: "unknown",
        lastInteractionChapter: 6,
        pendingTension: "未来关系信息",
      },
    },
    ensembleFocusHistory: [
      { chapter: 3, character: "林川", sourceRef: "ch3#finalText:aaaaaaaaaaaa:0-8" },
      { chapter: 6, character: "未来角色", sourceRef: "ch6#finalText:bbbbbbbbbbbb:0-8" },
    ],
  }));
  paths.push(writeJson(workspacePath, "series/fatigue-state.json", {
    recentPatterns: ["走廊脚步", "倒计时广播"],
    fatigueIndicators: {
      consecutiveSameType: 1,
      recentHookTypes: ["规则反转"],
      recentSceneTypes: ["封闭空间"],
      recentEmotionPeaks: ["规则揭晓"],
    },
    cooldownPeriods: { "走廊脚步": 2 },
  }));
  paths.push(writeJson(workspacePath, "series/world-items.json", {
    items: [
      {
        id: "world:blood-clock",
        name: "血钟",
        type: "RULE",
        summary: "摘要不应替代版本内容",
        fullDescription: "FULL_SECRET_DO_NOT_EXPOSE",
        status: "planned",
        earliestChapter: 4,
        optimalChapter: 5,
        latestChapter: 6,
        actualChapter: null,
        dependencies: { hard: ["world:old-hospital"], soft: [] },
        releaseStrategy: { forcedChapter: null },
        revealVersions: [
          {
            depth: "surface",
            content: "血钟响起时，走廊中的门牌会变化",
            chapter: 5,
            spoilerProtection: false,
            explainability: "active",
          },
          {
            depth: "deep",
            content: "SPOILER_CURRENT_DO_NOT_EXPOSE",
            chapter: 5,
            spoilerProtection: true,
            explainability: "passive",
          },
          {
            depth: "complete",
            content: "FUTURE_SECRET_DO_NOT_EXPOSE",
            chapter: 8,
            spoilerProtection: false,
            explainability: "active",
          },
        ],
      },
      {
        id: "world:future-villain",
        name: "未来反派真实身份",
        type: "PLOT_TWIST",
        fullDescription: "FUTURE_ITEM_FULL_SECRET",
        status: "planned",
        earliestChapter: 9,
        optimalChapter: 10,
        latestChapter: 12,
        actualChapter: null,
        dependencies: { hard: [], soft: [] },
        releaseStrategy: { forcedChapter: 10 },
        revealVersions: [{
          depth: "surface",
          content: "FUTURE_ITEM_SECRET",
          chapter: 10,
          spoilerProtection: false,
          explainability: "active",
        }],
      },
    ],
  }));
  paths.push(writeJson(workspacePath, "series/arc-registry.json", {
    arcs: [
      {
        arc_id: "arc-main",
        name: "血钟来源",
        arc_type: "primary",
        priority: "P0",
        status: "advancing",
        core_question: "谁制造了血钟？",
        chapter_opened: 1,
        expected_closure_window: { earliest: 8, optimal: 10, latest: 12 },
      },
      {
        arc_id: "arc-resolved",
        name: "已完成支线",
        arc_type: "secondary",
        priority: "P2",
        status: "resolved",
        core_question: "已经回答",
      },
      {
        arc_id: "arc-future",
        name: "未来才开启的弧线",
        arc_type: "secondary",
        priority: "P1",
        status: "open",
        core_question: "未来问题",
        chapter_opened: 7,
      },
    ],
    pending_foreshadows: [
      {
        id: "F-01",
        description: "血钟第三次响起会发生什么",
        level: "A",
        recalled: false,
        chapter_planted: 2,
        expected_recall_window: { earliest: 5, optimal: 7, latest: 9 },
      },
      {
        id: "F-future",
        description: "未来才埋下的伏笔",
        level: "B",
        recalled: false,
        chapter_planted: 7,
      },
    ],
  }));
  return paths;
}

test("MethodologyDiagnosticState: reads compact source-referenced prior state without modifying files", () => {
  const workspacePath = makeWorkspace();
  try {
    const paths = populateWorkspace(workspacePath);
    const before = new Map(paths.map((path) => [path, fingerprint(path)]));

    const result = createMethodologyDiagnosticStateLoader().load({
      workspacePath,
      chapterNumber: 5,
    });

    assert.equal(result.schemaVersion, "methodology-diagnostic-state-v1");
    assert.equal(result.advisoryOnly, true);
    assert.equal(result.declaredGenre.genre, "都市灵异");
    assert.deepEqual(result.declaredGenre.sourceRefs, ["config.json#genre", "config.json#subGenres"]);
    assert.deepEqual(result.serialState.expectations.map((entry) => entry.expectationId), ["door"]);
    assert.deepEqual(result.serialState.promises.map((entry) => entry.promiseId), ["blood-clock"]);
    assert.deepEqual(result.serialState.patterns.map((entry) => entry.patternId), ["pattern:repeated-corridor"]);
    assert.equal(result.ensemble.relationships[0].sourceRef, "series/narrative-state.json#relationshipTemperature:林川%7C苏婉");
    assert.deepEqual(result.ensemble.relationships.map((entry) => entry.relationshipId), ["林川|苏婉"]);
    assert.deepEqual(result.ensemble.focusHistory.map((entry) => entry.character), ["林川"]);
    assert.equal(result.closure.openArcs[0].sourceRef, "series/arc-registry.json#arcs:arc-main");
    assert.equal(result.closure.pendingForeshadows[0].sourceRef, "series/arc-registry.json#pending_foreshadows:F-01");
    assert.deepEqual(result.closure.openArcs.map((entry) => entry.arcId), ["arc-main"]);
    assert.deepEqual(result.closure.pendingForeshadows.map((entry) => entry.foreshadowId), ["F-01"]);

    for (const path of paths) {
      assert.deepEqual(fingerprint(path), before.get(path), `loader must not modify ${path}`);
    }
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("MethodologyDiagnosticState: refuses fatigue and ensemble snapshots that are not prior to the target chapter", () => {
  const workspacePath = makeWorkspace();
  try {
    populateWorkspace(workspacePath);
    writeJson(workspacePath, "series/narrative-state.json", {
      currentChapter: 5,
      readerExpectation: { unresolvedCount: 99 },
      relationshipTemperature: {
        "未来角色|苏婉": { state: "revealed", lastInteractionChapter: 5 },
      },
    });

    const result = createMethodologyDiagnosticStateLoader().load({
      workspacePath,
      chapterNumber: 5,
    });

    assert.deepEqual(result.serialState.fatigue.sourceRefs, []);
    assert.equal(result.serialState.fatigue.unresolvedExpectationCount, null);
    assert.equal(result.ensemble.status, "unavailable");
    assert.deepEqual(result.ensemble.relationships, []);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("MethodologyDiagnosticState: excludes future, spoiler, full-description and summary world content", () => {
  const workspacePath = makeWorkspace();
  try {
    populateWorkspace(workspacePath);

    const result = createMethodologyDiagnosticStateLoader().load({
      workspacePath,
      chapterNumber: 5,
    });

    assert.deepEqual(result.worldRevelation.items.map((item) => item.itemId), ["world:blood-clock"]);
    assert.deepEqual(result.worldRevelation.items[0].revealVersions, [{
      depth: "surface",
      content: "血钟响起时，走廊中的门牌会变化",
      chapter: 5,
      sourceRef: "series/world-items.json#items:world%3Ablood-clock:reveal:surface:ch5",
    }]);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /FULL_SECRET|SPOILER_CURRENT|FUTURE_SECRET|FUTURE_ITEM|摘要不应替代版本内容/);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("MethodologyDiagnosticState: reports every missing source explicitly and never throws", () => {
  const workspacePath = makeWorkspace();
  try {
    const result = createMethodologyDiagnosticStateLoader().load({
      workspacePath,
      chapterNumber: 1,
    });

    assert.equal(result.sources.length, 6);
    assert.ok(result.sources.every((source) => source.status === "missing"));
    assert.equal(result.declaredGenre.status, "unavailable");
    assert.equal(result.serialState.status, "unavailable");
    assert.equal(result.worldRevelation.status, "unavailable");
    assert.equal(result.ensemble.status, "unavailable");
    assert.equal(result.closure.status, "unavailable");
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("MethodologyDiagnosticState: marks malformed JSON and continues loading valid sources", () => {
  const workspacePath = makeWorkspace();
  try {
    writeJson(workspacePath, "config.json", { genre: "灵异" });
    const malformedPath = join(workspacePath, "series", "world-items.json");
    mkdirSync(dirname(malformedPath), { recursive: true });
    writeFileSync(malformedPath, "{not-json", "utf8");

    const result = createMethodologyDiagnosticStateLoader().load({
      workspacePath,
      chapterNumber: 3,
    });

    assert.equal(result.declaredGenre.genre, "灵异");
    assert.equal(
      result.sources.find((source) => source.sourceId === "world_items")?.status,
      "malformed",
    );
    assert.equal(result.worldRevelation.status, "unavailable");
    assert.match(result.worldRevelation.emptyReason, /malformed/);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// Step 2 derived advisory fields: overdue alerts, stagnation, fatigue
// severity, ensemble climax opportunity. All remain advisory-only.
// ============================================================================

test("MethodologyDiagnosticState: REM overdue alerts flag foreshadows past their latest recall window", () => {
  const workspacePath = makeWorkspace();
  try {
    populateWorkspace(workspacePath);
    // F-01 has expected_recall_window { earliest: 5, optimal: 7, latest: 9 }.
    // Loading at chapter 10 -> F-01 is red overdue (chapter 10 > latest 9).

    const result = createMethodologyDiagnosticStateLoader().load({
      workspacePath,
      chapterNumber: 10,
    });

    assert.ok(Array.isArray(result.serialState.overdueAlerts));
    const redAlert = result.serialState.overdueAlerts.find((a) => a.severity === "red");
    assert.ok(redAlert, "should have at least one red alert for F-01 past latest");
    assert.equal(redAlert.itemId, "F-01");
    assert.equal(redAlert.itemType, "foreshadow");
    assert.ok(redAlert.chaptersOverdue !== null && redAlert.chaptersOverdue > 0);
    assert.ok(redAlert.sourceRef.includes("F-01"));
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("MethodologyDiagnosticState: REM yellow alerts flag foreshadows approaching their latest window", () => {
  const workspacePath = makeWorkspace();
  try {
    populateWorkspace(workspacePath);
    // F-01 latest = 9. Loading at chapter 8 -> yellow (within 2 of latest).

    const result = createMethodologyDiagnosticStateLoader().load({
      workspacePath,
      chapterNumber: 8,
    });

    const yellowAlert = result.serialState.overdueAlerts.find(
      (a) => a.severity === "yellow" && a.itemId === "F-01",
    );
    assert.ok(yellowAlert, "F-01 should be yellow at chapter 8 (latest=9, within 2)");
    assert.equal(yellowAlert.chaptersOverdue, null);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("MethodologyDiagnosticState: stagnation detected when chaptersSinceLastPeak exceeds threshold", () => {
  const workspacePath = makeWorkspace();
  try {
    populateWorkspace(workspacePath);
    writeJson(workspacePath, "series/narrative-state.json", {
      currentChapter: 4,
      readerExpectation: {
        unresolvedCount: 3,
        lastPayoffChapter: 1,
        chaptersSinceLastPeak: 3,
      },
      horrorFatigue: { recentTechniques: [], consecutiveSameTechnique: 0 },
      relationshipTemperature: {},
      ensembleFocusHistory: [],
    });

    const result = createMethodologyDiagnosticStateLoader().load({
      workspacePath,
      chapterNumber: 5,
    });

    assert.ok(result.serialState.stagnation);
    assert.equal(result.serialState.stagnation.detected, true);
    assert.equal(result.serialState.stagnation.chaptersSinceLastPeak, 3);
    assert.ok(result.serialState.stagnation.sourceRefs.length > 0);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("MethodologyDiagnosticState: stagnation not detected when chaptersSinceLastPeak is below threshold", () => {
  const workspacePath = makeWorkspace();
  try {
    populateWorkspace(workspacePath);
    // Default workspace has chaptersSinceLastPeak: 2 (below threshold 3).

    const result = createMethodologyDiagnosticStateLoader().load({
      workspacePath,
      chapterNumber: 5,
    });

    assert.equal(result.serialState.stagnation.detected, false);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("MethodologyDiagnosticState: fatigue severity escalates to severe with 3+ consecutive repeats", () => {
  const workspacePath = makeWorkspace();
  try {
    populateWorkspace(workspacePath);
    writeJson(workspacePath, "series/fatigue-state.json", {
      recentPatterns: ["走廊脚步", "走廊脚步", "走廊脚步"],
      fatigueIndicators: {
        consecutiveSameType: 3,
        recentHookTypes: ["规则反转", "规则反转", "规则反转"],
        recentSceneTypes: ["封闭空间"],
        recentEmotionPeaks: ["规则揭晓"],
      },
      cooldownPeriods: {},
    });
    writeJson(workspacePath, "series/narrative-state.json", {
      currentChapter: 4,
      readerExpectation: { unresolvedCount: 5, chaptersSinceLastPeak: 1, lastPayoffChapter: 3 },
      horrorFatigue: {
        recentTechniques: ["unknown_rule", "unknown_rule", "unknown_rule"],
        consecutiveSameTechnique: 3,
      },
      relationshipTemperature: {},
      ensembleFocusHistory: [],
    });

    const result = createMethodologyDiagnosticStateLoader().load({
      workspacePath,
      chapterNumber: 5,
    });

    assert.equal(result.serialState.fatigue.severity, "severe");
    assert.ok(Array.isArray(result.serialState.fatigue.severitySignals));
    assert.ok(result.serialState.fatigue.severitySignals.length > 0);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("MethodologyDiagnosticState: fatigue severity is none when no repetition", () => {
  const workspacePath = makeWorkspace();
  try {
    populateWorkspace(workspacePath);
    writeJson(workspacePath, "series/fatigue-state.json", {
      recentPatterns: [],
      fatigueIndicators: {
        consecutiveSameType: 0,
        recentHookTypes: [],
        recentSceneTypes: [],
        recentEmotionPeaks: [],
      },
      cooldownPeriods: {},
    });
    writeJson(workspacePath, "series/narrative-state.json", {
      currentChapter: 4,
      readerExpectation: { unresolvedCount: 1, chaptersSinceLastPeak: 0, lastPayoffChapter: 4 },
      horrorFatigue: { recentTechniques: [], consecutiveSameTechnique: 0 },
      relationshipTemperature: {},
      ensembleFocusHistory: [],
    });

    const result = createMethodologyDiagnosticStateLoader().load({
      workspacePath,
      chapterNumber: 5,
    });

    assert.equal(result.serialState.fatigue.severity, "none");
    assert.deepEqual(result.serialState.fatigue.severitySignals, []);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("MethodologyDiagnosticState: ensemble climax opportunity detected when arcs and expectations converge", () => {
  const workspacePath = makeWorkspace();
  try {
    populateWorkspace(workspacePath);
    writeJson(workspacePath, "series/arc-registry.json", {
      arcs: [
        {
          arc_id: "arc-main",
          name: "血钟来源",
          arc_type: "primary",
          priority: "P0",
          status: "advancing",
          core_question: "谁制造了血钟？",
          chapter_opened: 1,
          expected_closure_window: { earliest: 8, optimal: 10, latest: 12 },
        },
        {
          arc_id: "arc-sub",
          name: "苏婉的秘密",
          arc_type: "secondary",
          priority: "P1",
          status: "advancing",
          core_question: "苏婉隐瞒了什么？",
          chapter_opened: 3,
          expected_closure_window: { earliest: 9, optimal: 11, latest: 13 },
        },
      ],
      pending_foreshadows: [],
    });
    writeJson(workspacePath, "narrative-state-store.json", {
      schemaVersion: 1,
      expectation: [
        {
          kind: "expectation",
          id: "expectation:door",
          expectationId: "door",
          description: "门后的身份何时揭晓",
          status: "escalated",
          targetReaderExperience: "答案推进",
          sourceChapter: "ch3",
          sourceRef: "ch3#finalText:aaaaaaaaaaaa:10-20",
        },
        {
          kind: "expectation",
          id: "expectation:cost",
          expectationId: "cost",
          description: "血钟代价",
          status: "escalated",
          targetReaderExperience: "代价揭示",
          sourceChapter: "ch4",
          sourceRef: "ch4#finalText:cccccccccccc:30-42",
        },
      ],
      promise: [],
      pattern: [],
    });

    const result = createMethodologyDiagnosticStateLoader().load({
      workspacePath,
      chapterNumber: 9,
    });

    assert.ok(result.ensemble.climaxOpportunity);
    assert.equal(result.ensemble.climaxOpportunity.detected, true);
    assert.ok(result.ensemble.climaxOpportunity.convergentArcs.length >= 2);
    assert.ok(result.ensemble.climaxOpportunity.criticalRelationships.length >= 1);
    assert.ok(result.ensemble.climaxOpportunity.convergentExpectations.length >= 2);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("MethodologyDiagnosticState: climax opportunity not detected without convergence", () => {
  const workspacePath = makeWorkspace();
  try {
    populateWorkspace(workspacePath);
    // Default: 1 arc with window, 1 relationship cooling, 0 escalated expectations.
    // Only 1 of 3 conditions met -> not detected.

    const result = createMethodologyDiagnosticStateLoader().load({
      workspacePath,
      chapterNumber: 5,
    });

    assert.equal(result.ensemble.climaxOpportunity.detected, false);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("MethodologyDiagnosticState: derived fields preserve advisory-only invariant", () => {
  const workspacePath = makeWorkspace();
  try {
    populateWorkspace(workspacePath);

    const result = createMethodologyDiagnosticStateLoader().load({
      workspacePath,
      chapterNumber: 10,
    });

    assert.equal(result.advisoryOnly, true);
    assert.equal(result.canEnterRawPrompt, false);
    assert.equal(result.canDirectlyAuthorizeCandidate, false);
    assert.ok(Array.isArray(result.serialState.overdueAlerts));
    assert.ok(result.serialState.stagnation);
    assert.ok(result.serialState.fatigue.severity);
    assert.ok(Array.isArray(result.serialState.fatigue.severitySignals));
    assert.ok(result.ensemble.climaxOpportunity);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("MethodologyDiagnosticState: production camelCase recall targets produce overdue alerts", () => {
  const workspacePath = makeWorkspace();
  try {
    writeJson(workspacePath, "config.json", { genre: "规则副本" });
    writeJson(workspacePath, "narrative-state-store.json", {
      schemaVersion: 1,
      expectation: [],
      promise: [],
      pattern: [],
    });
    writeJson(workspacePath, "series/narrative-state.json", {
      currentChapter: 20,
      readerExpectation: { chaptersSinceLastPeak: 1 },
    });
    writeJson(workspacePath, "series/arc-registry.json", {
      arcs: [],
      pending_foreshadows: [{
        id: "F-production",
        description: "生产格式伏笔",
        level: "A",
        openedChapter: 1,
        expectedRecallChapter: 20,
        status: "opened",
      }],
    });

    const result = createMethodologyDiagnosticStateLoader().load({
      workspacePath,
      chapterNumber: 21,
    });

    assert.deepEqual(result.closure.pendingForeshadows[0].expectedRecallWindow, {
      earliest: 20,
      optimal: 20,
      latest: 20,
    });
    assert.equal(
      result.serialState.overdueAlerts.some(
        (alert) => alert.itemId === "F-production" && alert.severity === "red",
      ),
      true,
    );
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("MethodologyDiagnosticState: multiple newly opened arcs do not imply consecutive stagnation", () => {
  const workspacePath = makeWorkspace();
  try {
    writeJson(workspacePath, "config.json", { genre: "都市悬疑" });
    writeJson(workspacePath, "narrative-state-store.json", {
      schemaVersion: 1,
      expectation: [],
      promise: [],
      pattern: [],
    });
    writeJson(workspacePath, "series/narrative-state.json", {
      currentChapter: 1,
      readerExpectation: { chaptersSinceLastPeak: 0 },
    });
    writeJson(workspacePath, "series/arc-registry.json", {
      arcs: [
        {
          id: "arc-a",
          name: "刚开启的主线",
          type: "primary",
          priority: "P0",
          status: "opened",
          coreQuestion: "问题 A",
          openedChapter: 1,
          expectedClosureChapter: 20,
        },
        {
          id: "arc-b",
          name: "刚开启的关系线",
          type: "relational",
          priority: "P1",
          status: "opened",
          coreQuestion: "问题 B",
          openedChapter: 1,
          expectedClosureChapter: 18,
        },
      ],
      pending_foreshadows: [],
    });

    const result = createMethodologyDiagnosticStateLoader().load({
      workspacePath,
      chapterNumber: 2,
    });

    assert.equal(result.serialState.stagnation.detected, false);
    assert.deepEqual(result.serialState.stagnation.stagnantArcIds, []);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("MethodologyDiagnosticState: canonical ArcRegistry chapter fields remain visible", () => {
  const workspacePath = makeWorkspace();
  try {
    writeJson(workspacePath, "config.json", { genre: "悬疑" });
    writeJson(workspacePath, "narrative-state-store.json", {
      schemaVersion: 1,
      expectation: [],
      promise: [],
      pattern: [],
    });
    writeJson(workspacePath, "series/narrative-state.json", {
      currentChapter: 4,
      readerExpectation: { chaptersSinceLastPeak: 1 },
    });
    writeJson(workspacePath, "series/arc-registry.json", {
      arcs: [{
        arc_id: "arc-canonical",
        name: "规范弧线",
        arc_type: "primary",
        priority: "P0",
        status: "in_progress",
        core_question: "规范字段能否读取？",
        chapter_opened: 1,
        expected_closure_window: {
          earliestChapter: 8,
          latestChapter: 12,
          hardDeadline: true,
        },
      }],
      pending_foreshadows: [{
        id: "F-canonical",
        description: "规范伏笔",
        level: "A",
        plantedChapter: 2,
        targetChapter: 6,
        recalled: false,
      }],
    });

    const result = createMethodologyDiagnosticStateLoader().load({
      workspacePath,
      chapterNumber: 5,
    });

    assert.deepEqual(result.closure.openArcs[0].expectedClosureWindow, {
      earliest: 8,
      latest: 12,
    });
    assert.equal(result.closure.pendingForeshadows[0].chapterPlanted, 2);
    assert.deepEqual(result.closure.pendingForeshadows[0].expectedRecallWindow, {
      earliest: 6,
      optimal: 6,
      latest: 6,
    });
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});
