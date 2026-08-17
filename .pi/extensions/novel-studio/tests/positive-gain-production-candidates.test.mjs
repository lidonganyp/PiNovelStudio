/** Fixed scene-solution admission is retired from production. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  generatePositiveGainCandidates,
  POSITIVE_GAIN_PRODUCTION_ADMISSION,
} from "../dist-test/v2/core/positive-gain-candidate-generator.js";
import { createUnifiedOrchestrator } from "../dist/v2/core/unified-orchestrator.js";
import { TEST_STYLE_REFERENCES } from "./test-style-fingerprint.mjs";

const baseInput = {
  workspaceId: "xinmo",
  chapterId: "ch18",
  chapterNumber: 18,
  projectRoot: process.cwd(),
  intent: {
    chapterFunction: "推进当前冲突",
    readerExperience: [],
    currentPressure: [],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["李一凡"],
    inviolableFacts: ["门锁只能从室内打开"],
    sourceRefs: ["seed:ch18"],
  },
  context: {
    facts: [{ id: "fact:door", content: "门锁只能从室内打开", sourceIds: ["seed:ch18"], kind: "fact" }],
    characterStates: [],
    openLoops: [],
    worldRules: [],
    styleReferences: TEST_STYLE_REFERENCES,
    sourceMap: [],
    constitution: null,
    longTermState: null,
  },
  constitution: null,
  characterNames: ["李一凡"],
};

test("fixed scene admission metadata is historical only", () => {
  assert.equal(POSITIVE_GAIN_PRODUCTION_ADMISSION.strictAdmissionStatus, "retired_from_production");
  assert.equal(POSITIVE_GAIN_PRODUCTION_ADMISSION.deploymentPolicy, "historical_evidence_only_no_global_extrapolation");
});

test("retired scene generator performs no model calls and preserves raw", async () => {
  let calls = 0;
  const result = await generatePositiveGainCandidates({
    input: {
      ...baseInput,
      modelGenerate: async () => {
        calls += 1;
        return { text: "unexpected", model: "stub", route: "stub", durationMs: 1 };
      },
    },
    promptPatternResolution: { promptBlock: "", patternIds: [], trace: { libraryStatus: "missing", mode: "production", discovered: [], selected: [], dropped: [], errors: [] } },
    candidateLimit: 2,
  });

  assert.equal(calls, 0);
  assert.equal(result.status, "fallback_raw");
  assert.deepEqual(result.candidates, []);
  assert.equal(result.trace.failureReason, "global_scene_candidate_admission_retired");
  assert.equal(result.trace.rawBaselineMutated, false);
});

test("orchestrator preserves raw baseline in preview when the chapter has no span-supported opportunity", async () => {
  const orchestrator = createUnifiedOrchestrator();
  // 预算账本按 projectRoot 落盘：改用独立临时 projectRoot，避免共享 workspace "xinmo"
  // 的 budget-ledger.json 跨轮累积耗尽导致 blocked（测试隔离问题）。
  const projectRoot = mkdtempSync(join(tmpdir(), "positive-gain-"));
  try {
    const result = await orchestrator.orchestrate({
      ...baseInput,
      projectRoot,
      // PRODUCTION-ROLLOUT-AUDIT-1 P0-1d：raw 仅允许在 fullPipelinePreview（只读预览）
      // 下交付基线；生产路径（无 evalMode/fullPipelinePreview）已 fail-closed。
      // 本测试聚焦"退役场景生成器无 span 机会 → raw 基线"这一证据链路，故以预览模式运行。
      fullPipelinePreview: true,
      allowAutomaticLiterarySelection: false,
      modelGenerate: async (request) => {
        if (request.kind === "raw_chapter") {
          return { text: "完整 raw 正文。", model: "stub", route: request.route, durationMs: 1 };
        }
        return { text: JSON.stringify({ hypotheses: [], noOpReason: "无 span 机会" }), model: "stub", route: request.route, durationMs: 1 };
      },
    });

    assert.equal(result.selectedSource, "raw");
    assert.equal(result.text, "完整 raw 正文。");
    assert.equal(result.stageResults.positiveGainCandidates.status, "retired_from_production");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
