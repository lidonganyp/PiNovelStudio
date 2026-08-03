/**
 * STATE-PARTICIPATION-2 - raw-only save/commit control trace contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createUnifiedOrchestrator } from "../dist/v2/core/unified-orchestrator.js";
import { buildTrustedControlPlane } from "../dist/v2/core/control-plane.js";
import { TEST_STYLE_REFERENCES } from "./test-style-fingerprint.mjs";

const RAW_TEXT = [
  "林川推开门，走进没有开灯的房间。",
  "他摸到墙边的开关，听见苏婉在身后压低呼吸。",
  "暗流从地板缝隙涌出，他抓住苏婉的手臂，把她拖到门边。",
  "门外的脚步声忽然停住，黑暗里有人问：你们真的以为已经逃出去了吗？",
].join("\n");

function makeIntent() {
  return {
    chapterFunction: "推进核心冲突",
    readerExperience: ["紧张"],
    currentPressure: ["出口被封锁"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["林川", "苏婉"],
    inviolableFacts: [],
    sourceRefs: ["test"],
  };
}

function makeContext() {
  return {
    facts: [],
    characterStates: [{
      characterId: "林川", name: "林川", state: { role: "protagonist" }, sourceIds: ["test"],
    }],
    openLoops: [], worldRules: [], styleReferences: TEST_STYLE_REFERENCES, sourceMap: [],
    constitution: null, longTermState: null,
  };
}

function makeModel() {
  return async (input) => {
    if (input.kind === "raw_chapter") {
      return { text: RAW_TEXT, model: "stub-raw", route: input.route, durationMs: 1 };
    }
    if (input.kind === "editorial_amplified") {
      throw new Error("editorial disabled for raw-only control trace");
    }
    return {
      text: JSON.stringify({
        winner: "tie", confidence: "uncertain", decisiveReasons: [],
        factualRisks: [], regressionRisks: [], constitutionAlignment: "无",
      }),
      model: "stub-judge", route: input.route, durationMs: 1,
    };
  };
}

function makeInput(projectRoot, controlPlane) {
  return {
    workspaceId: "sp2-control",
    chapterId: "ch-control",
    chapterNumber: 1,
    projectRoot,
    intent: makeIntent(),
    context: makeContext(),
    constitution: null,
    characterNames: ["林川", "苏婉"],
    modelGenerate: makeModel(),
    controlPlane,
  };
}

function makeControlPlane(capabilityOverrides = {}) {
  return buildTrustedControlPlane({
    taskId: "STATE-PARTICIPATION-2",
    objective: "verify raw-only control trace",
    scope: ["raw-only"],
    allowedResources: ["test"],
    forbiddenResources: ["network"],
    generationLock: { route: "runtime", provider: "runtime", model: "runtime" },
    judgeLock: { route: "runtime", provider: "runtime", model: "runtime" },
    modelTransport: "local",
    enforceModelLocks: false,
    capabilityOverrides,
    source: "state-participation-2-test",
  });
}

test("SP2 control: raw-only 允许路径在 save/commit 前各记录一次 allow", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "sp2-control-allow-"));
  try {
    const result = await createUnifiedOrchestrator().orchestrate(
      makeInput(projectRoot, makeControlPlane()),
    );
    assert.equal(result.status, "ok");
    const decisions = result.stageResults.controlPlane.decisions;
    assert.equal(decisions.filter((d) => d.capability === "state.commit" && d.allowed).length, 1);
    assert.equal(decisions.filter((d) => d.capability === "chapter.save" && d.allowed).length, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

for (const capability of ["state.commit", "chapter.save"]) {
  test(`SP2 control: raw-only ${capability}=deny 在副作用前阻断`, async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), `sp2-control-deny-${capability.replace(".", "-")}-`));
    try {
      const result = await createUnifiedOrchestrator().orchestrate(
        makeInput(projectRoot, makeControlPlane({ [capability]: "deny" })),
      );
      assert.equal(result.status, "blocked");
      assert.equal(result.stateCommit, null);
      assert.equal(result.chapterFilePath, null);
      assert.equal(
        result.stageResults.controlPlane.denials.some((d) => d.capability === capability),
        true,
      );
      assert.equal(
        existsSync(join(projectRoot, "workspaces", "sp2-control", "chapters", "ch-control.md")),
        false,
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
}
