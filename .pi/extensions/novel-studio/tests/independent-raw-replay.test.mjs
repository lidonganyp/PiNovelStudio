/**
 * Independent raw replay 产品入口：仅 PINOVEL_EVAL_ONLY 可跑 B0，
 * 并写出 generate-result + quality-trace。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const evalDist = join(process.cwd(), "dist-eval", "eval", "independent-raw-replay.js");
const runnerDist = join(process.cwd(), "dist-eval", "eval", "full-pipeline-replay-runner.js");

test("independent raw：无 PINOVEL_EVAL_ONLY → 拒绝", async () => {
  const prev = process.env.PINOVEL_EVAL_ONLY;
  delete process.env.PINOVEL_EVAL_ONLY;
  const { runIndependentRawReplay } = await import(`file://${evalDist}`);
  await assert.rejects(
    () =>
      runIndependentRawReplay({
        workspaceId: "ws",
        chapterId: "chapter-001",
        chapterNumber: 1,
        projectRoot: process.cwd(),
      }),
    /PINOVEL_EVAL_ONLY/,
  );
  if (prev === undefined) delete process.env.PINOVEL_EVAL_ONLY;
  else process.env.PINOVEL_EVAL_ONLY = prev;
});

test("independent raw：eval-only + stub generate 写出 result 与 raw_direct trace", async () => {
  const prev = process.env.PINOVEL_EVAL_ONLY;
  process.env.PINOVEL_EVAL_ONLY = "1";
  const root = mkdtempSync(join(tmpdir(), "independent-raw-"));
  try {
    const { runIndependentRawReplay } = await import(`file://${evalDist}`);
    const out = await runIndependentRawReplay({
      workspaceId: "eval-raw",
      chapterId: "chapter-001",
      chapterNumber: 1,
      projectRoot: root,
      modelGenerate: async () => ({
        text: "裸写正文",
        finishReason: "stop",
        route: "v2_rawstage2_gemini31",
        requestedRoute: "v2_rawstage2_gemini31",
        provider: "gemini31",
      }),
    });
    assert.ok(existsSync(out.resultPath));
    assert.ok(existsSync(out.tracePath));
    const trace = JSON.parse(readFileSync(out.tracePath, "utf-8"));
    assert.equal(trace.matrixArm, "raw_direct");
    assert.equal(trace.evalMode, "B0");
  } finally {
    if (prev === undefined) delete process.env.PINOVEL_EVAL_ONLY;
    else process.env.PINOVEL_EVAL_ONLY = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("evalMode=B0 + writerModel=gpt6astra 请求 v2_rawstage2_gpt6astra", async () => {
  const prev = process.env.PINOVEL_EVAL_ONLY;
  process.env.PINOVEL_EVAL_ONLY = "1";
  const requested = [];
  const root = mkdtempSync(join(tmpdir(), "independent-raw-b0-"));
  try {
    const { runUnifiedPipeline } = await import("../dist/v2/core/unified-entry.js");
    await runUnifiedPipeline({
      workspaceId: "eval-b0-route",
      chapterId: "chapter-001",
      chapterNumber: 1,
      projectRoot: root,
      writerModel: "gpt6astra",
      evalMode: "B0",
      evalPrefix: "independent-raw",
      evalIntent: {
        chapterFunction: "",
        readerExperience: [],
        currentPressure: [],
        meaningfulChoices: [],
        promisesToAdvance: [],
        possibleEndPressure: [],
        relevantCharacters: [],
        inviolableFacts: [],
        sourceRefs: [],
      },
      evalContext: {
        facts: [],
        characterStates: [],
        openLoops: [],
        worldRules: [],
        styleReferences: [],
        sourceMap: [],
        constitution: null,
        longTermState: null,
      },
      evalModelGenerate: async (input) => {
        requested.push(input.route);
        return { text: "裸写", finishReason: "stop", route: input.route, requestedRoute: input.route };
      },
      evalPromptProfile: "generic_writer_v1",
    });
    assert.ok(
      requested.includes("v2_rawstage2_gpt6astra"),
      `routes=${JSON.stringify(requested)}`,
    );
    assert.equal(requested.includes("v2_rawstage2"), false, `未锁路由仍请求 v2_rawstage2：${JSON.stringify(requested)}`);
  } finally {
    if (prev === undefined) delete process.env.PINOVEL_EVAL_ONLY;
    else process.env.PINOVEL_EVAL_ONLY = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner 归档 transportEvidence，不依赖被省略的 env", async () => {
  const { collectReplayTransportEvidence } = await import(`file://${runnerDist}`);
  const evidence = collectReplayTransportEvidence({
    args: ["--eval-layer=B0"],
    mockAgent: false,
    env: {
      PINOVEL_EVAL_ONLY: "1",
      V2_FORCE_STUB: "1",
      PINOVEL_EVAL_REPLAY_TRANSPORT: "stub",
      GEMINI_API_KEY: "secret-must-not-be-needed",
    },
  });
  assert.deepEqual(evidence, {
    transport: "stub",
    forceStub: true,
    evalOnly: true,
    mockAgent: false,
    evalLayer: "B0",
  });
});

test("trace 自写 matrixArm/evalMode/schemaId 不能单独定 independent_raw", async () => {
  const matrixDist = join(process.cwd(), "dist-eval", "v2", "core", "eval-replay-matrix.js");
  const { inferArmPipelineKind } = await import(`file://${matrixDist}`);
  const root = mkdtempSync(join(tmpdir(), "forged-raw-identity-"));
  try {
    const sampleDir = join(root, "samples", "fixture.forged");
    const tracesDir = join(sampleDir, "traces");
    mkdirSync(tracesDir, { recursive: true });
    writeFileSync(
      join(tracesDir, "chapter-001-quality-trace.json"),
      JSON.stringify({
        schemaId: "pinovel.independent-raw-quality-trace",
        matrixArm: "raw_direct",
        evalMode: "B0",
        gates: [{
          stage: "v2_final_selected",
          evidence: { modelCalls: [{ requestedRoute: "v2_rawstage2_gemini31" }] },
        }],
      }),
    );
    writeFileSync(
      join(sampleDir, "invocation.json"),
      JSON.stringify({
        command: { args: ["--project-root=scratch"], env: "(omitted)" },
        transportEvidence: { evalLayer: null, evalOnly: true, forceStub: false, mockAgent: false, transport: null },
      }),
    );
    assert.equal(
      inferArmPipelineKind({ replayMode: "production_like", runRoot: root }),
      "unknown",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("full-pipeline runner：matrixArm=raw_direct 时 invoke 带 --eval-layer=B0", async () => {
  const { resolveInvokeGenerateChapterScript } = await import(`file://${runnerDist}`);
  assert.match(resolveInvokeGenerateChapterScript(process.cwd()), /invoke-generate-chapter/);
  const source = readFileSync(
    join(process.cwd(), "eval", "full-pipeline-replay-runner.ts"),
    "utf-8",
  );
  assert.match(source, /matrixArm === "raw_direct"/);
  assert.match(source, /--eval-layer=B0/);
});
