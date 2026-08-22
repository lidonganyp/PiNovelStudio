/**
 * Platform runtime no longer materializes previous-chapter prose or
 * series/skeleton.json. Chapter 2+ must grow from chapter-continuity/{N-1}.json.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { buildChapterSeed } from "../dist-test/craft/chapter-seed-builder.js";
import { createSeedReadinessChecker } from "../dist-test/craft/seed-readiness-checker.js";
import { preflightWorkspace } from "../dist-test/craft/workspace-preflight-checker.js";

function hash12(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

function createSnapshotOnlyWorkspace() {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-snapshot-only-"));
  const workspaceId = "p128";
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  const previousText = "沈砚握紧铜哨：不要相信沈建国。";
  const hash = hash12(previousText);

  mkdirSync(join(workspacePath, "characters"), { recursive: true });
  mkdirSync(join(workspacePath, "series"), { recursive: true });
  mkdirSync(join(workspacePath, "chapters"), { recursive: true });
  mkdirSync(join(workspacePath, "styles"), { recursive: true });
  mkdirSync(join(workspacePath, "chapter-continuity"), { recursive: true });

  writeFileSync(join(workspacePath, "characters", "shen-yan.md"), "# 沈砚\n\n重生者。\n", "utf8");
  writeFileSync(join(workspacePath, "config.json"), JSON.stringify({
    novelName: "项目128",
    genre: "都市",
    subGenres: ["重生"],
    characters: [{ id: "shen-yan", name: "沈砚", role: "protagonist" }],
  }), "utf8");
  writeFileSync(join(workspacePath, "styles", "profile.json"), JSON.stringify({
    id: "p128-style",
    usagePolicy: { fullChapterOptimization: "required" },
    editorialGuidance: ["压力通过动作和停顿呈现。"],
    characterVoiceGuidance: { 沈砚: ["克制，不解释自己的判断。"] },
  }), "utf8");
  writeFileSync(join(workspacePath, "chapter-continuity", "1.json"), JSON.stringify({
    chapterNumber: 1,
    openHooks: ["不要相信沈建国"],
    introducedCharacters: ["沈砚"],
    unresolvedTensions: ["不要相信沈建国"],
    lastEventSummary: "沈砚握紧铜哨：不要相信沈建国。",
    finalTextHash: hash,
    sourceRefs: ["chapter-continuity/1.json"],
    createdAt: "2026-08-21T12:00:00.000Z",
  }), "utf8");
  writeFileSync(join(workspacePath, "narrative-state-store.json"), JSON.stringify({
    schemaVersion: 1,
    workspaceId,
    lastCommittedChapter: "ch1",
    canon: [{
      kind: "canon",
      id: "canon:whistle",
      sourceChapter: "ch1",
      sourceRef: `ch1#finalText:${hash}:0-12`,
      fact: "现实中出现了十五年前遗失的铜哨",
    }],
    character: [],
    promise: [{
      kind: "promise",
      id: "promise:dont-trust",
      sourceChapter: "ch1",
      sourceRef: `ch1#finalText:${hash}:0-12`,
      description: "不要相信沈建国",
      status: "open",
    }],
    pattern: [],
    expectation: [],
    updatedAt: "2026-08-21T12:00:00.000Z",
  }), "utf8");

  return { projectRoot, workspaceId, workspacePath, previousText };
}

test("snapshot-only previous continuation is available without skeleton or chapter file", () => {
  const workspace = createSnapshotOnlyWorkspace();
  try {
    const { seed } = buildChapterSeed({
      workspacePath: workspace.workspacePath,
      workspaceId: workspace.workspaceId,
      chapterId: "2",
      chapterNumber: 2,
    });

    assert.equal(seed.previousChapterContinuation.available, true);
    assert.match(seed.previousChapterContinuation.lastEventSummary ?? "", /不要相信沈建国/);
    assert.ok(seed.previousChapterContinuation.openHooks.includes("不要相信沈建国"));
    assert.ok(
      seed.previousChapterContinuation.sourceIds?.some((id) => id.includes("chapter-continuity/1.json")),
    );

    const readiness = createSeedReadinessChecker().check(seed);
    assert.equal(readiness.shouldBlockGeneration, false, JSON.stringify(readiness.blockingReasons));
    assert.equal(
      readiness.blockingReasons.some((reason) => reason.includes("skeleton.json")),
      false,
    );
  } finally {
    rmSync(workspace.projectRoot, { recursive: true, force: true });
  }
});

test("empty continuity snapshot is not treated as previous continuation", () => {
  const workspace = createSnapshotOnlyWorkspace();
  try {
    writeFileSync(join(workspace.workspacePath, "chapter-continuity", "1.json"), JSON.stringify({
      chapterNumber: 1,
      openHooks: [],
      introducedCharacters: [],
      unresolvedTensions: [],
    }), "utf8");

    const { seed } = buildChapterSeed({
      workspacePath: workspace.workspacePath,
      workspaceId: workspace.workspaceId,
      chapterId: "2",
      chapterNumber: 2,
    });

    assert.equal(seed.previousChapterContinuation.available, false);
    const readiness = createSeedReadinessChecker().check(seed);
    assert.equal(readiness.shouldBlockGeneration, true);
  } finally {
    rmSync(workspace.projectRoot, { recursive: true, force: true });
  }
});

test("preflight accepts chapter-continuity snapshot without previous chapter prose", () => {
  const workspace = createSnapshotOnlyWorkspace();
  try {
    const report = preflightWorkspace({
      workspacePath: workspace.workspacePath,
      workspaceId: workspace.workspaceId,
      chapterId: "2",
      chapterNumber: 2,
      projectRoot: workspace.projectRoot,
    });

    const seedBlock = report.blockingItems.find((item) => item.check === "seed_readiness");
    assert.equal(seedBlock, undefined, seedBlock?.fixInstruction ?? "seed_readiness should not block");
    assert.equal(report.passed, true, JSON.stringify(report.blockingItems, null, 2));
  } finally {
    rmSync(workspace.projectRoot, { recursive: true, force: true });
  }
});

test("preflight accepts continuity snapshot when state store and skeleton are both absent", () => {
  const workspace = createSnapshotOnlyWorkspace();
  try {
    rmSync(join(workspace.workspacePath, "narrative-state-store.json"), { force: true });
    const report = preflightWorkspace({
      workspacePath: workspace.workspacePath,
      workspaceId: workspace.workspaceId,
      chapterId: "2",
      chapterNumber: 2,
      projectRoot: workspace.projectRoot,
    });
    assert.equal(
      report.blockingItems.find((item) => item.check === "previous_skeleton_missing"),
      undefined,
    );
    assert.equal(report.passed, true, JSON.stringify(report.blockingItems, null, 2));
  } finally {
    rmSync(workspace.projectRoot, { recursive: true, force: true });
  }
});
