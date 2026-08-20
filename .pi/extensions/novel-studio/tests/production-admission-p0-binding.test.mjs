/**
 * Production-admission P0: public reject, evidence authority, metering split.
 * Source-level / local-gate only. Does not claim production complete.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  handleGenerateChapter,
  handlePreflightWorkspace,
  handlePlanStoryOutline,
  handleStrategyPolicyView,
  handleStrategyFeedback,
} from "../dist/handlers/public-handlers.js";
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

test("PI wrapper rejects caller-supplied project roots outside the trusted runtime hand-off", async () => {
  const original = process.env.NOVEL_TEST_TOOLS;
  delete process.env.NOVEL_TEST_TOOLS;
  try {
    const { wrapLegacyTool } = await import("../dist/tools/legacy-tool-wrapper.js");
    let invoked = false;
    const tool = wrapLegacyTool({
      name: "novel_test_boundary",
      description: "boundary fixture",
      inputSchema: { type: "object", properties: {} },
      invoke: async () => {
        invoked = true;
        return { status: "ok" };
      },
    });
    const result = await tool.execute(
      "boundary-root",
      { _projectRoot: "C:/attacker/root" },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? "", /不得由调用方注入 _projectRoot/);
    assert.equal(invoked, false);
  } finally {
    if (original === undefined) delete process.env.NOVEL_TEST_TOOLS;
    else process.env.NOVEL_TEST_TOOLS = original;
  }
});

test("PI wrapper accepts the runtime-marked isolated project root", async () => {
  const original = process.env.NOVEL_TEST_TOOLS;
  delete process.env.NOVEL_TEST_TOOLS;
  try {
    const { wrapLegacyTool } = await import("../dist/tools/legacy-tool-wrapper.js");
    let capturedRoot;
    const tool = wrapLegacyTool({
      name: "novel_test_trusted_root",
      description: "boundary fixture",
      inputSchema: { type: "object", properties: {} },
      invoke: async (input) => {
        capturedRoot = input._projectRoot;
        return { status: "ok" };
      },
    });
    const result = await tool.execute(
      "trusted-root",
      { _projectRoot: "C:/runtime/isolation" },
      undefined,
      undefined,
      { __novelRuntimeTrustedRoot: true },
    );
    assert.equal(result.isError, undefined);
    assert.equal(capturedRoot, "C:/runtime/isolation");
  } finally {
    if (original === undefined) delete process.env.NOVEL_TEST_TOOLS;
    else process.env.NOVEL_TEST_TOOLS = original;
  }
});

test("production tool wrapper rejects proxy callerOverride even when schema omits it", async () => {
  const original = process.env.NOVEL_TEST_TOOLS;
  delete process.env.NOVEL_TEST_TOOLS;
  try {
    const { registerTools } = await import("../dist/tools/register-tools.js");
    let invoked = false;
    const tool = registerTools(new Proxy({}, {
      get: (_target, key) => key === "handleWorkspaceManager"
        ? async () => { invoked = true; return { status: "ok" }; }
        : async () => ({}),
    })).find((candidate) => candidate.name === "novel_workspace_manager");
    assert.ok(tool);
    const result = await tool.execute(
      "boundary-caller",
      { action: "proxy_review", workspaceId: "safe", callerOverride: { apiKey: "secret" } },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? "", /内部字段不得通过生产工具入口传入/);
    assert.equal(invoked, false);
  } finally {
    if (original === undefined) delete process.env.NOVEL_TEST_TOOLS;
    else process.env.NOVEL_TEST_TOOLS = original;
  }
});

test("生成入口拒绝 workspaceId/chapterId 路径穿越", async () => {
  for (const input of [
    { workspaceId: "..", chapterId: "1" },
    { workspaceId: "safe", chapterId: "../escape" },
  ]) {
    await assert.rejects(
      () => handleGenerateChapter({ ...input, chapterNumber: 1 }),
      /Invalid (workspaceId|chapterId)/,
      JSON.stringify(input),
    );
  }
});

test("其余公开 workspace 入口同样拒绝路径穿越", async () => {
  const cases = [
    () => handlePreflightWorkspace({ workspaceId: "..", chapterId: "1", chapterNumber: 1 }),
    () => handlePlanStoryOutline({ workspaceId: "../escape", idea: "test" }),
    () => handleStrategyPolicyView({ workspaceId: ".." }),
    () => handleStrategyFeedback({ workspaceId: "safe", chapterId: "../escape", modelVersion: "gemini31" }),
  ];
  for (const [index, invoke] of cases.entries()) {
    await assert.rejects(invoke, /Invalid (workspaceId|chapterId)/, `case ${index}`);
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
