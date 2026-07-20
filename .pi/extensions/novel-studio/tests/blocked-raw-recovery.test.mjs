/**
 * blocked raw recovery — explicit, fail-closed recovery for a verified Claude raw.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createBlockedRawRecovery,
} from "../dist/v2/core/blocked-raw-recovery.js";
import {
  BLOCKED_CANDIDATE_EVIDENCE_SCHEMA_ID,
  computeRawSha256,
} from "../dist/v2/core/blocked-candidate-evidence.js";

function makeFixture(overrides = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), "blocked-raw-recovery-"));
  const workspaceId = "fuben";
  const chapterId = "1";
  const chapterNumber = 1;
  const tracesDir = join(projectRoot, "workspaces", workspaceId, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const storedText = "门外的提示框再次亮起。\n他看着那行字，终于按下确认。";
  const hash = computeRawSha256(storedText);
  const artifactPath = join(tracesDir, `${chapterId}-blocked-candidate-evidence.json`);
  const evidence = {
    schemaId: BLOCKED_CANDIDATE_EVIDENCE_SCHEMA_ID,
    workspaceId,
    chapterId,
    chapterNumber,
    blockedStage: "raw_fact_guard",
    blockedReason: "quoted UI callback false positive",
    severity: "hard",
    artifactPath,
    blocked: true,
    deliverable: false,
    rawSha256: hash,
    rawLength: storedText.length,
    storedText,
    storedSha256: hash,
    rawFinishReason: "end_turn",
    rawMaxTokens: 8192,
    rawModel: "claude-opus-4-6",
    modelVersion: "claude-opus-4-6",
    diagnosticSpans: [],
    redactionLog: [],
    createdAt: new Date().toISOString(),
    failureEnvelope: {
      stage: "raw_fact_guard",
      severity: "hard",
      reason: "quoted UI callback false positive",
      recoverable: false,
      degradedTo: "none",
    },
    ...overrides,
  };
  writeFileSync(artifactPath, JSON.stringify(evidence, null, 2), "utf-8");
  return {
    projectRoot,
    workspaceId,
    chapterId,
    chapterNumber,
    storedText,
    artifactPath,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}

test("explicit recovery returns frozen raw without a raw network call and preserves later generation calls", async () => {
  const fixture = makeFixture();
  try {
    const calls = [];
    const networkGenerate = async (input) => {
      calls.push(input.kind);
      return {
        text: "editorial response",
        model: "claude-opus-4-6",
        provider: "anthropic",
        route: input.route,
        durationMs: 12,
        finishReason: "end_turn",
        maxTokens: 8192,
      };
    };
    const recovery = createBlockedRawRecovery({
      ...fixture,
      generationModelGenerate: networkGenerate,
    });

    const raw = await recovery.generationModelGenerate({
      route: "v2_rawstage2",
      kind: "raw_chapter",
      systemPrompt: "system",
      userPrompt: "user",
    });
    const editorial = await recovery.generationModelGenerate({
      route: "v2_amplified",
      kind: "editorial_amplified",
      systemPrompt: "system",
      userPrompt: "user",
    });

    assert.equal(raw.text, fixture.storedText);
    assert.equal(raw.model, "claude-opus-4-6");
    assert.equal(raw.provider, "anthropic");
    assert.equal(raw.finishReason, "end_turn");
    assert.deepEqual(calls, ["editorial_amplified"]);
    assert.equal(editorial.text, "editorial response");
    assert.equal(recovery.provenance.recovered, true);
    assert.equal(recovery.provenance.storedSha256, computeRawSha256(fixture.storedText));
  } finally {
    fixture.cleanup();
  }
});

test("explicit Gemini recovery reuses only a frozen Gemini raw without a raw network call", async () => {
  const fixture = makeFixture({
    rawModel: "gemini-3.1-pro-preview",
    modelVersion: "gemini-3.1-pro-preview",
    rawFinishReason: "stop",
  });
  try {
    const calls = [];
    const recovery = createBlockedRawRecovery({
      ...fixture,
      writerModel: "gemini31",
      generationModelGenerate: async (input) => {
        calls.push(input.kind);
        return {
          text: "editorial response",
          model: "gemini-3.1-pro-preview",
          provider: "gemini31",
          route: input.route,
          durationMs: 12,
          finishReason: "stop",
        };
      },
    });

    const raw = await recovery.generationModelGenerate({
      route: "v2_rawstage2_gemini31",
      kind: "raw_chapter",
      systemPrompt: "system",
      userPrompt: "user",
    });

    assert.equal(raw.text, fixture.storedText);
    assert.equal(raw.model, "gemini-3.1-pro-preview");
    assert.equal(raw.provider, "gemini31");
    assert.deepEqual(calls, []);
  } finally {
    fixture.cleanup();
  }
});

test("Gemini recovery rejects a frozen Claude raw", () => {
  const fixture = makeFixture();
  try {
    assert.throws(
      () => createBlockedRawRecovery({
        ...fixture,
        writerModel: "gemini31",
        generationModelGenerate: async () => assert.fail("network must not be called"),
      }),
      /Gemini|gemini-3\.1/i,
    );
  } finally {
    fixture.cleanup();
  }
});

for (const [name, mutate, expected] of [
  ["hash mismatch", (e) => ({ ...e, storedSha256: "0".repeat(64) }), /hash|SHA/i],
  ["workspace mismatch", (e) => ({ ...e, workspaceId: "other" }), /workspace/i],
  ["chapter mismatch", (e) => ({ ...e, chapterId: "2" }), /chapter/i],
  ["chapter number mismatch", (e) => ({ ...e, chapterNumber: 2 }), /chapterNumber/i],
  ["truncated raw", (e) => ({ ...e, rawFinishReason: "max_tokens" }), /max_tokens|truncat/i],
  ["wrong model", (e) => ({ ...e, rawModel: "gpt-5.6-sol" }), /Claude 4\.6|claude-opus-4-6/i],
  ["wrong blocked stage", (e) => ({ ...e, blockedStage: "final_fact_recheck" }), /raw_fact_guard/i],
  ["redacted raw", (e) => ({ ...e, rawSha256: "1".repeat(64), redactionLog: ["secret redacted"] }), /redact|rawSha256/i],
  ["deliverable artifact", (e) => ({ ...e, deliverable: true }), /deliverable/i],
  ["wrong schema", (e) => ({ ...e, schemaId: "pinovel.blocked-candidate-evidence/v0" }), /schema/i],
]) {
  test(`recovery fails closed: ${name}`, () => {
    const fixture = makeFixture();
    try {
      const original = JSON.parse(requireRead(fixture.artifactPath));
      writeFileSync(fixture.artifactPath, JSON.stringify(mutate(original), null, 2), "utf-8");
      assert.throws(
        () => createBlockedRawRecovery({
          ...fixture,
          generationModelGenerate: async () => assert.fail("network must not be called during validation"),
        }),
        expected,
      );
    } finally {
      fixture.cleanup();
    }
  });
}

test("recovery fails closed when the artifact is missing", () => {
  const fixture = makeFixture();
  try {
    rmSync(fixture.artifactPath);
    assert.throws(
      () => createBlockedRawRecovery({
        ...fixture,
        generationModelGenerate: async () => assert.fail("network must not be called"),
      }),
      /missing|not found/i,
    );
  } finally {
    fixture.cleanup();
  }
});

function requireRead(path) {
  return globalThis.process.getBuiltinModule("node:fs").readFileSync(path, "utf-8");
}
