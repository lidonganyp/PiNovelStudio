/** Eval fixture snapshots must remain readable by production workspace readers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEvalFixture } from "../dist-eval/v2/core/eval-fixture-capture.js";
import { validateEvalFixtureV1 } from "../dist-eval/v2/core/eval-fixture-contract.js";
import { materializeWorkspace } from "../dist-eval/eval/full-pipeline-replay-runner.js";
import { createScratchWorkspace } from "../dist-eval/v2/core/eval-replay-isolation.js";
import { preflightWorkspace } from "../dist-eval/craft/workspace-preflight-checker.js";
import { loadCreativeConstitution } from "../dist-eval/v2/core/creative-constitution.js";
import { loadWorkspace, loadStyleProfile, loadChapterSeed } from "../dist-eval/v2/adapters/legacy-workspace-adapter.js";
import { resolveExistingChapterFile } from "../dist-eval/utils/chapter-path.js";

const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const marker = "\uFEFFfixture-input-21\r\n";

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value), "utf8");
}

function setup(context) {
  const root = mkdtempSync(join(tmpdir(), "eval-fixture-roundtrip-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const workspaceId = "fixture-source";
  const workspacePath = join(root, "workspaces", workspaceId);
  for (const folder of ["chapters", "characters", "series", "styles", "chapter-continuity"]) {
    mkdirSync(join(workspacePath, folder), { recursive: true });
  }
  writeJson(join(workspacePath, "config.json"), {
    genre: "玄幻", characters: [{ id: "fixture", name: "fixture", role: "主角" }],
    styleProfile: "shared", targetWordCount: { perChapter: { min: 2000, max: 3000 } },
  });
  writeFileSync(join(workspacePath, "characters", "fixture.md"), "# fixture\n", "utf8");
  const style = { id: "local", editorialGuidance: ["fixture-guidance"], usagePolicy: { fullChapterOptimization: "required" } };
  writeJson(join(workspacePath, "styles", "profile.json"), style);
  const constitution = {
    schemaVersion: 1, workIdentity: "fixture", readerPromise: ["fixture-promise"],
    genrePromises: [], protagonistCoreConflict: "fixture-conflict", thematicQuestions: [],
    aestheticDirection: [], forbiddenDrift: [], narrativePreferences: [], updatedAt: "2026-09-01T00:00:00.000Z",
  };
  writeJson(join(workspacePath, "creative-constitution.json"), constitution);
  writeFileSync(join(workspacePath, "chapters", "21.md"), marker, "utf8");
  const state = {
    schemaVersion: 1, workspaceId, lastCommittedChapter: "ch21", updatedAt: constitution.updatedAt,
    canon: [{ kind: "canon", id: "fixture-fact", sourceChapter: 21,
      sourceRef: { locator: `ch21#finalText:${hash(marker.trim().replace(/^\uFEFF/, "")).slice(0, 12)}:0-16` },
      value: "fixture-fact", confidence: 0.8 }],
    character: [], promise: [], pattern: [], expectation: [],
  };
  writeJson(join(workspacePath, "narrative-state-store.json"), state);
  const options = {
    projectRoot: root, workspaceId, chapterNumber: 22, chapterId: "chapter-022",
    chapterTitle: "fixture", replayMode: "candidate_like", archiveDir: join(root, "fixtures"),
    manifest: { releaseId: "rel-fixture", bundleId: "bundle-fixture", modelVersion: "gpt-6-astra",
      promptBundleHash: hash("prompt"), toolSchemaHash: hash("tools"), contextCompilerHash: hash("context") },
  };
  return { root, workspacePath, options, state, constitution, style };
}

test("capture/materialize preserves numeric chapters and committed facts for production preflight", (context) => {
  const input = setup(context);
  const originalState = readFileSync(join(input.workspacePath, "narrative-state-store.json"), "utf8");
  const result = captureEvalFixture(input.options);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const fixture = result.fixture;
  assert.deepEqual(fixture.workspace.narrativeStateStore, input.state);
  assert.deepEqual(fixture.workspace.creativeConstitution, input.constitution);
  assert.equal(fixture.workspace.historicalChapters.length, 1);
  assert.equal(fixture.workspace.historicalChapters[0].content, marker);
  assert.equal(fixture.workspace.historicalChapters[0].contentHash, hash(marker));
  const before = JSON.stringify(fixture);
  const lease = createScratchWorkspace({ projectRoot: input.root, fixture });
  assert.deepEqual(materializeWorkspace(lease, fixture).violations, []);
  const restored = JSON.parse(readFileSync(join(lease.workspacePath, "narrative-state-store.json"), "utf8"));
  assert.deepEqual(restored, { ...input.state, workspaceId: lease.workspaceId });
  assert.equal(existsSync(join(lease.workspacePath, "series", "narrative-state.json")), false);
  assert.equal(readFileSync(resolveExistingChapterFile(lease.workspacePath, "21").path, "utf8"), marker);
  assert.equal(existsSync(join(lease.workspacePath, "chapters", "chapter-chapter-021")), false);
  assert.deepEqual(loadCreativeConstitution(lease.workspaceId, lease.scratchRoot), input.constitution);
  const bundle = loadWorkspace(lease.workspaceId, lease.scratchRoot);
  assert.deepEqual(JSON.parse(loadStyleProfile(bundle, lease.scratchRoot).content), input.style);
  assert.ok(loadChapterSeed(bundle, 22, "22").seed);
  const preflight = preflightWorkspace({ workspacePath: lease.workspacePath, workspaceId: lease.workspaceId,
    chapterId: "22", chapterNumber: 22, projectRoot: lease.scratchRoot, skipSeedReadiness: true });
  assert.equal(preflight.blockingItems.some((item) => /previous_|style_profile/.test(item.check)), false,
    JSON.stringify(preflight.blockingItems));
  assert.equal(JSON.stringify(fixture), before);
  assert.equal(readFileSync(join(input.workspacePath, "narrative-state-store.json"), "utf8"), originalState);
  assert.equal(readFileSync(join(input.workspacePath, "chapters", "21.md"), "utf8"), marker);
});

test("capture selects one production chapter per number, ignoring sidecars and future chapters", (context) => {
  const input = setup(context);
  const chapters = join(input.workspacePath, "chapters");
  for (const [name, content] of Object.entries({
    "chapter-06.md": "padded", "chapter-6.md": "canonical", "6.md": "numeric",
    "chapter-006.json": "{}", "chapter-6.notes.md": "sidecar", "chapter-22.md": "target",
    "23.md": "future", "ch7.md": "ch-prefixed", "chapter-008.md": "padded3",
  })) writeFileSync(join(chapters, name), content, "utf8");
  const result = captureEvalFixture(input.options);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.fixture.workspace.historicalChapters.map((chapter) => chapter.chapterNumber), [6, 7, 8, 21]);
  assert.equal(result.fixture.workspace.historicalChapters[0].content, "canonical");
});

test("capture freezes shared style when workspace-local style is absent", (context) => {
  const input = setup(context);
  rmSync(join(input.workspacePath, "styles", "profile.json"));
  mkdirSync(join(input.root, "styles", "profiles"), { recursive: true });
  writeJson(join(input.root, "styles", "profiles", "shared.json"), { ...input.style, id: "shared" });
  const result = captureEvalFixture(input.options);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.fixture.workspace.styleProfile.id, "shared");
  const lease = createScratchWorkspace({ projectRoot: input.root, fixture: result.fixture });
  materializeWorkspace(lease, result.fixture);
  assert.equal(JSON.parse(loadStyleProfile(loadWorkspace(lease.workspaceId, lease.scratchRoot), lease.scratchRoot).content).id, "shared");
});

test("invalid or mismatched authoritative store cannot fall back to legacy state", (context) => {
  const input = setup(context);
  writeJson(join(input.workspacePath, "series", "narrative-state.json"), { legacy: true });
  for (const content of ["{", "null", JSON.stringify({ ...input.state, workspaceId: "other" })]) {
    writeFileSync(join(input.workspacePath, "narrative-state-store.json"), content, "utf8");
    const result = captureEvalFixture(input.options);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.field === "/workspace/narrativeStateStore"));
    assert.equal(existsSync(input.options.archiveDir), false);
  }
});

test("store and legacy projection stay separate; missing state is never synthesized", (context) => {
  const input = setup(context);
  const projection = { characters: { fixture: { location: "fixture-location" } } };
  writeJson(join(input.workspacePath, "series", "narrative-state.json"), projection);
  const result = captureEvalFixture(input.options);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.fixture.priorNarrativeState, projection);
  const lease = createScratchWorkspace({ projectRoot: input.root, fixture: result.fixture });
  materializeWorkspace(lease, result.fixture);
  assert.deepEqual(JSON.parse(readFileSync(join(lease.workspacePath, "series", "narrative-state.json"), "utf8")), projection);
  assert.deepEqual(JSON.parse(readFileSync(join(lease.workspacePath, "narrative-state-store.json"), "utf8")).canon, input.state.canon);
  const invalid = structuredClone(result.fixture);
  invalid.workspace.narrativeStateStore = [];
  assert.equal(validateEvalFixtureV1(invalid).valid, false);
});

test("continuity-only production workspace is capturable without inventing an old state", (context) => {
  const input = setup(context);
  rmSync(join(input.workspacePath, "narrative-state-store.json"));
  writeJson(join(input.workspacePath, "chapter-continuity", "21.json"), { finalTextHash: hash(marker.trim()).slice(0, 12) });
  const result = captureEvalFixture(input.options);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.fixture.priorNarrativeState, null);
  assert.equal(result.fixture.workspace.narrativeStateStore, undefined);
  const lease = createScratchWorkspace({ projectRoot: input.root, fixture: result.fixture });
  materializeWorkspace(lease, result.fixture);
  assert.equal(existsSync(join(lease.workspacePath, "narrative-state-store.json")), false);
});

test("dev_real_model retains historical content needed by production continuity checks", (context) => {
  const input = setup(context);
  const result = captureEvalFixture({ ...input.options, replayMode: "dev_real_model" });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.fixture.workspace.historicalChapters[0].content, marker);
});

test("supporting author inputs round-trip byte-for-byte and preserve seed dependencies", (context) => {
  const input = setup(context);
  const supportingFiles = {
    "WORLDBUILDING-CANON.md": "\uFEFFfixture-canon\r\n",
    "USER-REVISION-LEARNINGS.md": "fixture-feedback\n",
    "series/unsettled-details.json": JSON.stringify([{ id: "fixture-detail", chapterId: "20", status: "open", description: "fixture-detail" }]),
    "series/world-items.json": '{"items":[],"lastUpdated":"frozen"}',
    "series/ch22-outline-explicit.md": "fixture-direction\n",
  };
  for (const [relativePath, content] of Object.entries(supportingFiles)) {
    writeFileSync(join(input.workspacePath, relativePath), content, "utf8");
  }
  const result = captureEvalFixture(input.options);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.fixture.workspace.supportingFiles, supportingFiles);
  const lease = createScratchWorkspace({ projectRoot: input.root, fixture: result.fixture });
  materializeWorkspace(lease, result.fixture);
  for (const [relativePath, content] of Object.entries(supportingFiles)) {
    assert.equal(readFileSync(join(lease.workspacePath, relativePath), "utf8"), content);
  }
  const sourceSeed = loadChapterSeed(loadWorkspace(input.options.workspaceId, input.root), 22, "22").seed;
  const restoredSeed = loadChapterSeed(loadWorkspace(lease.workspaceId, lease.scratchRoot), 22, "22").seed;
  assert.deepEqual(restoredSeed.unsettledDetails, sourceSeed.unsettledDetails);
  assert.deepEqual(restoredSeed.candidateAnchors, sourceSeed.candidateAnchors);
  const unsafe = structuredClone(result.fixture);
  unsafe.workspace.supportingFiles = { "../escaped.txt": "fixture" };
  assert.equal(validateEvalFixtureV1(unsafe).valid, false);
  assert.equal(materializeWorkspace(lease, unsafe).violations.length, 1);
  assert.equal(existsSync(join(lease.workspacePath, "..", "escaped.txt")), false);
});
