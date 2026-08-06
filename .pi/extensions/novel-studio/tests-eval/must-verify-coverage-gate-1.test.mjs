/**
 * MUST-VERIFY-COVERAGE-GATE-1: public contract and compatibility coverage.
 *
 * The real P0/P1/P2 and evidence matching behavior is covered in
 * must-verify-coverage-gate-2.test.mjs. This file keeps the original interface
 * contract and the explicit stub factory regression-tested.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MODULE_PATH = join(
  __dirname,
  "..",
  "dist-eval",
  "novelos",
  "agent",
  "must-verify-coverage-gate.js",
);

async function importModule() {
  return import(`file://${MODULE_PATH}`);
}

function makeInput(mustVerify = ["林默当前状态"]) {
  return {
    evidencePlan: {
      known: [],
      unknown: [],
      mustVerify,
      allowedTools: [],
      stopConditions: {
        maxStagnantRounds: 2,
        verifierHardErrorsCleared: true,
        modelDeclaresSufficient: true,
      },
    },
    trajectoryPath: "",
    inviolableFacts: [],
    contextCoveredFacts: [],
  };
}

describe("MUST-VERIFY-COVERAGE-GATE-1: module contract", () => {
  it("exports the risk, coverage, real-factory, and stub-factory APIs", async () => {
    const mod = await importModule();
    assert.equal(typeof mod.assessMustVerifyRisk, "function");
    assert.equal(typeof mod.checkMustVerifyCoverage, "function");
    assert.equal(typeof mod.createMustVerifyCoverageGate, "function");
    assert.equal(typeof mod.createStubCoverageGate, "function");
  });

  it("returns an empty classification for an empty mustVerify list", async () => {
    const mod = await importModule();
    assert.deepEqual(mod.assessMustVerifyRisk([], []), []);
  });

  it("returns the required fields for every classification", async () => {
    const mod = await importModule();
    const [result] = mod.assessMustVerifyRisk(["普通细节"], []);
    assert.equal(typeof result.item, "string");
    assert.ok(["P0", "P1", "P2"].includes(result.riskLevel));
    assert.equal(typeof result.reason, "string");
    assert.ok(result.reason.length > 0);
  });
});

describe("MUST-VERIFY-COVERAGE-GATE-1: real coverage contract", () => {
  it("passes with no mustVerify items", async () => {
    const mod = await importModule();
    const result = mod.checkMustVerifyCoverage(makeInput([]));
    assert.equal(result.passed, true);
    assert.equal(result.skippedReason, "no_must_verify");
  });

  it("does not block a P2-only item", async () => {
    const mod = await importModule();
    const result = mod.checkMustVerifyCoverage(makeInput(["验证一处普通细节"]));
    assert.equal(result.passed, true);
    assert.equal(result.skippedReason, "no_high_risk");
  });

  it("returns a failure envelope for uncovered high-risk facts", async () => {
    const mod = await importModule();
    const result = mod.checkMustVerifyCoverage(makeInput(["林默真实身份"]));
    assert.equal(result.passed, false);
    assert.equal(result.unverifiedHighRisk.length, 1);
    assert.equal(result.failureEnvelope?.stage, "must_verify_coverage_gate");
  });

  it("keeps the result shape stable on a passing result", async () => {
    const mod = await importModule();
    const result = mod.checkMustVerifyCoverage(makeInput([]));
    assert.ok("passed" in result);
    assert.ok("unverifiedHighRisk" in result);
    assert.ok("confirmedItems" in result);
    assert.ok("skippedReason" in result);
    assert.ok("failureEnvelope" in result);
  });
});

describe("MUST-VERIFY-COVERAGE-GATE-1: createStubCoverageGate", () => {
  it("retains explicit non-blocking compatibility behavior", async () => {
    const mod = await importModule();
    const gate = mod.createStubCoverageGate();
    const result = gate.checkAndBlock(makeInput());
    assert.equal(typeof gate.checkAndBlock, "function");
    assert.equal(result.passed, true);
    assert.equal(result.skippedReason, "stub_not_implemented");
    assert.deepEqual(result.unverifiedHighRisk, []);
    assert.deepEqual(result.confirmedItems, []);
    assert.equal(result.failureEnvelope, undefined);
  });
});
