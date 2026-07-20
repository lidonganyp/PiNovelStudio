/**
 * STRATEGY-EVIDENCE-1A: schema, model partition and append-only validation.
 *
 * This is a local-only contract test. It must not call a model or mutate the
 * runtime StrategyPolicyStore, so production selection probabilities stay
 * unchanged.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  STRATEGY_EVIDENCE_SCHEMA_ID,
  STRATEGY_EVIDENCE_SCHEMA_VERSION,
  compileStrategyEvidenceDataset,
  validateStrategyEvidenceAppend,
  validateStrategyEvidenceArtifact,
} from "../dist/v2/core/strategy-evidence-dataset.js";

function makeRecord(overrides = {}) {
  return {
    evidenceId: "ev-001",
    strategyId: "strategy-A",
    modelVersion: "glm-5.2",
    orchestratorRunId: "run-001",
    sourceChapter: "ch17",
    outcome: "win",
    source: "judge",
    weight: 1,
    timestamp: "2026-07-14T10:00:00.000Z",
    ...overrides,
  };
}

function makeArtifact(records, overrides = {}) {
  return {
    schemaId: STRATEGY_EVIDENCE_SCHEMA_ID,
    schemaVersion: STRATEGY_EVIDENCE_SCHEMA_VERSION,
    workspaceId: "xinmo",
    records,
    ...overrides,
  };
}

test("validates the frozen strategy evidence artifact schema", () => {
  const result = validateStrategyEvidenceArtifact(
    makeArtifact([makeRecord()])
  );

  assert.equal(result.ok, true);
  assert.equal(result.artifact.schemaId, "pinovel.strategy-evidence");
  assert.equal(result.artifact.schemaVersion, "v1");
});

test("rejects unknown schema versions without constructing a typed artifact", () => {
  const result = validateStrategyEvidenceArtifact(
    makeArtifact([makeRecord()], { schemaVersion: "v999" })
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unsupported_schema_version");
  assert.equal("artifact" in result, false);
});

test("rejects malformed records and non-finite weights", () => {
  const missingModel = makeRecord();
  delete missingModel.modelVersion;

  const missingModelResult = validateStrategyEvidenceArtifact(
    makeArtifact([missingModel])
  );
  assert.equal(missingModelResult.ok, false);
  assert.equal(missingModelResult.error.path, "records[0].modelVersion");

  const invalidWeightResult = validateStrategyEvidenceArtifact(
    makeArtifact([makeRecord({ weight: Number.NaN })])
  );
  assert.equal(invalidWeightResult.ok, false);
  assert.equal(invalidWeightResult.error.path, "records[0].weight");
});

test("same run and strategy remain independent across model partitions", () => {
  const result = compileStrategyEvidenceDataset([
    makeRecord({ evidenceId: "ev-glm", modelVersion: "glm-5.2" }),
    makeRecord({ evidenceId: "ev-doubao", modelVersion: "doubao-2.1" }),
  ]);

  assert.equal(result.effectiveCount, 2);
  assert.equal(result.partitions["glm-5.2"], 1);
  assert.equal(result.partitions["doubao-2.1"], 1);
});

test("human and eligible signals from different models cannot combine into promotion", () => {
  const result = compileStrategyEvidenceDataset([
    makeRecord({
      evidenceId: "ev-human",
      modelVersion: "glm-5.2",
      hasHumanVerdict: true,
      fromEligiblePair: false,
    }),
    makeRecord({
      evidenceId: "ev-eligible",
      modelVersion: "doubao-2.1",
      hasHumanVerdict: false,
      fromEligiblePair: true,
      orchestratorRunId: "run-002",
    }),
  ]);

  assert.equal(result.canPromote, false);
  assert.equal(result.partitionSummaries["glm-5.2"].canPromote, false);
  assert.equal(result.partitionSummaries["doubao-2.1"].canPromote, false);
});

test("append-only validation accepts an unchanged prefix plus valid new records", () => {
  const previous = makeArtifact([makeRecord()]);
  const next = makeArtifact([
    makeRecord(),
    makeRecord({
      evidenceId: "ev-002",
      orchestratorRunId: "run-002",
    }),
  ]);

  const result = validateStrategyEvidenceAppend(previous, next);
  assert.deepEqual(result, { ok: true, appendedCount: 1 });
});

test("append-only validation rejects mutation, deletion and reordering", () => {
  const first = makeRecord({ evidenceId: "ev-001", orchestratorRunId: "run-001" });
  const second = makeRecord({ evidenceId: "ev-002", orchestratorRunId: "run-002" });
  const previous = makeArtifact([first, second]);

  const mutated = validateStrategyEvidenceAppend(
    previous,
    makeArtifact([{ ...first, revoked: true }, second])
  );
  assert.equal(mutated.ok, false);
  assert.equal(mutated.error.code, "history_mutated");

  const deleted = validateStrategyEvidenceAppend(
    previous,
    makeArtifact([first])
  );
  assert.equal(deleted.ok, false);
  assert.equal(deleted.error.code, "history_truncated");

  const reordered = validateStrategyEvidenceAppend(
    previous,
    makeArtifact([second, first])
  );
  assert.equal(reordered.ok, false);
  assert.equal(reordered.error.code, "history_mutated");
});

test("append-only validation rejects duplicate evidence ids", () => {
  const previous = makeArtifact([makeRecord()]);
  const next = makeArtifact([
    makeRecord(),
    makeRecord({ orchestratorRunId: "run-002" }),
  ]);

  const result = validateStrategyEvidenceAppend(previous, next);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "duplicate_evidence_id");
});
