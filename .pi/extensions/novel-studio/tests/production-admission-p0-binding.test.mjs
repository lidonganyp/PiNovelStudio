/**
 * Production-admission P0: public reject, evidence authority, metering split.
 * Source-level / local-gate only. Does not claim production complete.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { handleGenerateChapter } from "../dist/handlers/public-handlers.js";
import {
  evaluateEvidenceAuthorityBinding,
  evaluateEvidenceEligibility,
} from "../dist-test/v2/core/evidence-eligibility-gate.js";

const EXT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("生产入口拒绝 modelTestRoute / fullPipelinePreview / mock", async () => {
  for (const field of ["modelTestRoute", "fullPipelinePreview", "_mockGenerateChapter"]) {
    const value = field === "modelTestRoute" ? "glm" : true;
    await assert.rejects(
      () => handleGenerateChapter({
        workspaceId: "w",
        chapterId: "1",
        chapterNumber: 1,
        [field]: value,
      }),
      /实验字段在生产入口被拒绝/,
      field,
    );
  }
});

test("EvidenceRecord 资格闸要求 snapshot + 双 hash，禁止 diagnostic.id", () => {
  assert.equal(
    evaluateEvidenceEligibility({
      sourceChapter: "ch3",
      currentChapterNumber: 10,
      sourceRef: "finding-1",
      findingId: "finding-1",
      snapshotId: "snap",
      sourceContentHash: "src",
      evidenceExcerptHash: "ex",
    }).reason,
    "diagnostic_id_as_source_ref",
  );
  assert.equal(
    evaluateEvidenceAuthorityBinding({
      sourceRef: "ch3#canon:old",
      snapshotId: "snap",
      sourceContentHash: "src",
      evidenceExcerptHash: "ex",
    }).reason,
    "missing_lineage",
  );
  assert.equal(
    evaluateEvidenceAuthorityBinding({
      sourceRef: "ch3#canon:old",
      snapshotId: "snap",
      sourceContentHash: "src",
      evidenceExcerptHash: "ex",
      lineage: { runId: "run-1" },
    }).reason,
    "missing_lineage",
  );
  assert.equal(
    evaluateEvidenceAuthorityBinding({
      sourceRef: "ch3#canon:old",
      snapshotId: "snap",
      sourceContentHash: "src",
      evidenceExcerptHash: "ex",
      lineage: { sourceChapter: "ch3", chapterNumber: 3, runId: "run-1", candidateId: "cand-1" },
    }).decision,
    "eligible",
  );
});

test("modelCallLog 必须写入 retryIndex/cost；validator 不得记入 modelCalls", () => {
  const orch = readFileSync(join(EXT_ROOT, "v2/core/unified-orchestrator.ts"), "utf8");
  assert.match(orch, /retryIndex: successRetryIndex/);
  assert.match(orch, /retryIndex: failRetryIndex/);
  assert.match(orch, /cost: successCost/);
  const budget = readFileSync(join(EXT_ROOT, "novelos/agent/repair-budget.ts"), "utf8");
  assert.match(budget, /validatorRuns/);
  assert.match(budget, /modelCalls/);
  assert.ok(
    /modelCalls \/ validatorRuns 由 ModelCallMeter \/ ValidatorRunMeter 唯一计数/.test(budget),
    "repair-budget 必须把 validatorRuns 与 modelCalls 分开计数",
  );
});
