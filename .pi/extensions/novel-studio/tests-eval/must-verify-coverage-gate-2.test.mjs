/**
 * MUST-VERIFY-COVERAGE-GATE-2: real risk classification and evidence coverage.
 *
 * This slice is intentionally eval-only. It proves the gate contract before
 * wiring the gate into the production Agent loop.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

const makePlan = (mustVerify) => ({
  known: [],
  unknown: [],
  mustVerify,
  allowedTools: ["query_canon"],
  stopConditions: {
    maxStagnantRounds: 2,
    verifierHardErrorsCleared: true,
    modelDeclaresSufficient: true,
  },
});

const makeInput = (overrides = {}) => ({
  evidencePlan: makePlan(["林默当前伤势"]),
  trajectoryPath: "",
  inviolableFacts: [],
  contextCoveredFacts: [],
  ...overrides,
});

async function importModule() {
  return import(`file://${MODULE_PATH}`);
}

function withTrajectory(records, fn) {
  const dir = mkdtempSync(join(tmpdir(), "pinovel-must-verify-"));
  const filePath = join(dir, "trajectory.jsonl");
  writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join("\n"), "utf8");
  try {
    return fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("MUST-VERIFY-COVERAGE-GATE-2: real risk classification", () => {
  it("classifies immutable identity, state/location, and ordinary detail as P0/P1/P2", async () => {
    const mod = await importModule();
    const result = mod.assessMustVerifyRisk(
      ["林默真实身份", "林默当前位置", "验证一处普通细节"],
      ["林默的身份不可改变"],
    );

    assert.deepEqual(result.map((item) => item.riskLevel), ["P0", "P1", "P2"]);
    assert.ok(result.every((item) => item.reason.length > 0));
  });
});

describe("MUST-VERIFY-COVERAGE-GATE-2: real coverage gate", () => {
  it("passes without work when mustVerify is empty", async () => {
    const mod = await importModule();
    const result = mod.checkMustVerifyCoverage(
      makeInput({ evidencePlan: makePlan([]) }),
    );

    assert.equal(result.passed, true);
    assert.equal(result.skippedReason, "no_must_verify");
  });

  it("passes a high-risk item covered by compiled context", async () => {
    const mod = await importModule();
    const result = mod.checkMustVerifyCoverage(
      makeInput({ contextCoveredFacts: ["林默当前伤势已经稳定"] }),
    );

    assert.equal(result.passed, true);
    assert.equal(result.skippedReason, "context_covered");
    assert.deepEqual(result.unverifiedHighRisk, []);
    assert.equal(result.confirmedItems.length, 1);
    assert.match(result.confirmedItems[0].matchedEvidence, /^context:/);
  });

  it("passes a high-risk item with confirmed trajectory evidence", async () => {
    const mod = await importModule();
    withTrajectory(
      [
        {
          type: "tool_result",
          data: {
            details: {
              sourceRef: "canon:character:lin-mo",
              evidenceLevel: "confirmed",
            },
            content: [{ type: "text", text: "林默当前伤势已经稳定" }],
          },
        },
      ],
      (trajectoryPath) => {
        const result = mod.checkMustVerifyCoverage(
          makeInput({ trajectoryPath }),
        );
        assert.equal(result.passed, true);
        assert.equal(result.confirmedItems[0].matchedEvidence, "canon:character:lin-mo");
        assert.equal(result.failureEnvelope, undefined);
      },
    );
  });

  it("passes when confirmed evidence is persisted as ranked_evidence", async () => {
    const mod = await importModule();
    withTrajectory(
      [
        {
          type: "ranked_evidence",
          data: {
            query: "lin-mo injury",
            evidences: [
              {
                sourceRef: "character:lin-mo:leftArmStatus",
                evidenceLevel: "confirmed_state",
                excerpt: `${makeInput().evidencePlan.mustVerify[0]}已经稳定`,
              },
            ],
          },
        },
      ],
      (trajectoryPath) => {
        const result = mod.checkMustVerifyCoverage(
          makeInput({ trajectoryPath }),
        );
        assert.equal(result.passed, true);
        assert.equal(
          result.confirmedItems[0].matchedEvidence,
          "character:lin-mo:leftArmStatus",
        );
      },
    );
  });

  it("blocks an uncovered P0/P1 item with a recoverable failure envelope", async () => {
    const mod = await importModule();
    const result = mod.checkMustVerifyCoverage(
      makeInput({
        evidencePlan: makePlan(["林默真实身份", "林默当前位置"]),
      }),
    );

    assert.equal(result.passed, false);
    assert.equal(result.unverifiedHighRisk.length, 2);
    assert.equal(result.failureEnvelope?.stage, "must_verify_coverage_gate");
    assert.equal(result.failureEnvelope?.gate, "unverified_high_risk_facts");
    assert.equal(result.failureEnvelope?.recoverable, true);
  });

  it("does not block a P2-only item", async () => {
    const mod = await importModule();
    const result = mod.checkMustVerifyCoverage(
      makeInput({ evidencePlan: makePlan(["验证一处普通细节"]) }),
    );

    assert.equal(result.passed, true);
    assert.equal(result.skippedReason, "no_high_risk");
  });

  it("fails closed when the trajectory is missing or malformed", async () => {
    const mod = await importModule();
    const missing = mod.checkMustVerifyCoverage(
      makeInput({ trajectoryPath: "D:/missing/trajectory.jsonl" }),
    );
    assert.equal(missing.passed, false);

    withTrajectory([{}], (trajectoryPath) => {
      writeFileSync(trajectoryPath, "not-json\n", "utf8");
      const malformed = mod.checkMustVerifyCoverage(
        makeInput({ trajectoryPath }),
      );
      assert.equal(malformed.passed, false);
    });
  });

  it("exposes a non-stub factory for later production wiring", async () => {
    const mod = await importModule();
    const gate = mod.createMustVerifyCoverageGate();
    assert.equal(typeof gate.checkAndBlock, "function");
    assert.equal(gate.checkAndBlock(makeInput()).passed, false);
  });
});
