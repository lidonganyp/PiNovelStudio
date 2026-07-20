/** QUALITY-EXPERIMENT-PREVIEW-1: isolated, read-only model ceiling samples. */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { runUnifiedPipeline } from "../dist/v2/core/unified-entry.js";

const projectRoot = resolve(import.meta.dirname, "..", "..", "..", "..");
const workspaceId = "quality-experiment-preview-test";
const workspaceRoot = join(projectRoot, "workspaces", workspaceId);

before(() => {
  mkdirSync(join(workspaceRoot, "characters"), { recursive: true });
  mkdirSync(join(workspaceRoot, "series"), { recursive: true });
  writeFileSync(join(workspaceRoot, "config.json"), JSON.stringify({
    name: "Quality experiment preview",
    genre: "suspense",
    characters: [{ id: "p1", name: "Lin", role: "protagonist" }],
    chapterSeeds: {
      "1": {
        choicesAndCosts: [{ choice: "test the locked door", cost: "reveal awareness" }],
        expectedIrreversibleChange: ["the adversary knows Lin is alert"],
        causalEndPressure: ["the test forces an immediate second choice"],
      },
    },
  }, null, 2), "utf8");
  writeFileSync(join(workspaceRoot, "characters", "Lin.md"), "# Lin\n\nA cautious investigator.\n", "utf8");
  writeFileSync(join(workspaceRoot, "series", "outline.md"), "# Story\n\nA locked-room investigation.\n", "utf8");
  process.env.V2_FORCE_STUB = "1";
  process.env.PINOVEL_DEV_MODE = "1";
});

after(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.V2_FORCE_STUB;
  delete process.env.PINOVEL_DEV_MODE;
});

test("raw quality experiment stops after raw FactGuard and records provenance", async () => {
  const result = await runUnifiedPipeline({
    workspaceId,
    chapterId: "1",
    chapterNumber: 1,
    projectRoot,
    fullPipelinePreview: true,
    qualityExperiment: { arm: "raw", sampleIndex: 2 },
  });

  assert.equal(result.status, "ok");
  assert.equal(result.isPreviewRun, true);
  assert.deepEqual(result.stageResults.qualityExperiment, {
    arm: "raw",
    sampleIndex: 2,
    isolated: true,
    sceneSolutionSource: "none",
  });
  assert.equal(result.stageResults.editorialOpportunity, undefined);
  assert.equal(result.stageResults.judgeArbitration, null);
  assert.deepEqual(result.stageResults.modelCalls.map((call) => call.kind), ["raw_chapter"]);
});

test("quality experiment rejects invalid arm inputs before generation", async () => {
  const sceneSolution = {
    id: "oracle-1",
    mode: "active_probe",
    surfaceGoal: "identify the voice",
    trueDanger: "the probe reveals Lin's location",
    knownFacts: ["the door is locked"],
    unknowns: ["who is speaking"],
    activeTestAction: "ask a false-memory question",
    alternatives: ["wait", "leave"],
    choice: "perform the probe",
    cost: "lose concealment",
    newRuleOrInformation: "the voice can repeat only heard memories",
    irreversibleChange: "both sides know they are detected",
    stateKind: "knowledge",
    endingPressure: "a second voice answers",
    causalSource: "the probe",
    nextChoice: "choose which voice to trust",
    templateAvoidance: ["no unexplained shadow"],
    sourceFactIds: [],
    openPromiseIds: [],
  };

  await assert.rejects(() => runUnifiedPipeline({
    workspaceId,
    chapterId: "1",
    chapterNumber: 1,
    projectRoot,
    fullPipelinePreview: true,
    sceneSolution,
    qualityExperiment: { arm: "raw", sampleIndex: 1 },
  }), /raw quality experiment must not include sceneSolution/);

  await assert.rejects(() => runUnifiedPipeline({
    workspaceId,
    chapterId: "1",
    chapterNumber: 1,
    projectRoot,
    fullPipelinePreview: true,
    qualityExperiment: { arm: "scene", sampleIndex: 1 },
  }), /scene quality experiment requires sceneSolution/);

  await assert.rejects(() => runUnifiedPipeline({
    workspaceId,
    chapterId: "1",
    chapterNumber: 1,
    projectRoot,
    fullPipelinePreview: true,
    qualityExperiment: { arm: "raw", sampleIndex: 4 },
  }), /sampleIndex must be an integer between 1 and 3/);
});
