/**
 * Independent raw replay 产品入口：仅 PINOVEL_EVAL_ONLY 可跑 B0，
 * 并写出 generate-result + quality-trace。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

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
    const workspace = join(root, "workspaces", "eval-raw");
    mkdirSync(join(workspace, "characters"), { recursive: true });
    mkdirSync(join(workspace, "series"), { recursive: true });
    writeFileSync(join(workspace, "config.json"), JSON.stringify({ novelName: "输入消费测试", genre: "都市", styleOverrides: { forbidden: "不应注入的风格规则" } }));
    writeFileSync(join(workspace, "characters", "person.md"), "# 测试角色\n角色基础资料标记");
    writeFileSync(join(workspace, "series", "outline.md"), "作者整体方向标记");
    const requests = [];
    const { runIndependentRawReplay } = await import(`file://${evalDist}`);
    const out = await runIndependentRawReplay({
      workspaceId: "eval-raw",
      chapterId: "chapter-001",
      chapterNumber: 1,
      projectRoot: root,
      modelGenerate: async (request) => {
        requests.push(request);
        return ({
        text: "裸写正文",
        finishReason: "stop",
        route: "v2_rawstage2_gemini31",
        requestedRoute: "v2_rawstage2_gemini31",
        provider: "gemini31",
        });
      },
    });
    assert.ok(existsSync(out.resultPath));
    assert.ok(existsSync(out.tracePath));
    const trace = JSON.parse(readFileSync(out.tracePath, "utf-8"));
    assert.equal(trace.matrixArm, "raw_direct");
    assert.equal(trace.evalMode, "B0");
    assert.equal(requests.length, 1);
    assert.match(requests[0].userPrompt, /输入消费测试/);
    assert.match(requests[0].userPrompt, /角色基础资料标记/);
    assert.match(requests[0].userPrompt, /作者整体方向标记/);
    assert.doesNotMatch(requests[0].userPrompt, /不应注入的风格规则/);
    assert.doesNotMatch(requests[0].route, /amplified|judge|agentic/);
    const evidence = trace.gates[0].evidence;
    assert.equal(evidence.inputConsumption[0].consumed, true);
    assert.equal(evidence.inputConsumption[0].userPromptSha256, createHash("sha256").update(requests[0].userPrompt).digest("hex"));
    assert.deepEqual(evidence.inputSources.map((source) => source.path), ["config.json", "characters/person.md", "series/outline.md"]);
    assert.equal(existsSync(join(workspace, "narrative-state-store.json")), false);
  } finally {
    if (prev === undefined) delete process.env.PINOVEL_EVAL_ONLY;
    else process.env.PINOVEL_EVAL_ONLY = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("B0 最小资料加载：缺失输入阻断；前章可读但不读取本章或未来正文", async () => {
  const { buildIndependentRawInput } = await import(`file://${evalDist}`);
  const root = mkdtempSync(join(tmpdir(), "independent-raw-input-"));
  const input = { projectRoot: root, workspaceId: "sample", chapterId: "2", chapterNumber: 2 };
  try {
    assert.throws(() => buildIndependentRawInput(input), /缺少作品类型或角色/);
    const workspace = join(root, "workspaces", "sample");
    mkdirSync(join(workspace, "characters"), { recursive: true });
    mkdirSync(join(workspace, "chapters"), { recursive: true });
    writeFileSync(join(workspace, "config.json"), JSON.stringify({ genre: "都市" }));
    writeFileSync(join(workspace, "characters", "person.md"), "# 测试角色");
    assert.throws(() => buildIndependentRawInput(input), /缺少前章/);
    writeFileSync(join(workspace, "chapters", "1.md"), "已接受前章输入标记");
    writeFileSync(join(workspace, "chapters", "2.md"), "当前答案泄漏标记");
    writeFileSync(join(workspace, "chapters", "3.md"), "未来答案泄漏标记");
    const loaded = buildIndependentRawInput(input);
    assert.match(loaded.prefix, /已接受前章输入标记/);
    assert.doesNotMatch(loaded.prefix, /答案泄漏标记/);
    assert.equal(loaded.sources.at(-1).sha256, createHash("sha256").update("已接受前章输入标记").digest("hex"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evalMode=B0 + writerModel=gemini31 请求 v2_rawstage2_gemini31", async () => {
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
      writerModel: "gemini31",
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
      requested.includes("v2_rawstage2_gemini31"),
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
