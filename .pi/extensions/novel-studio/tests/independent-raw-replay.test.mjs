/**
 * Independent raw replay 产品入口：仅 PINOVEL_EVAL_ONLY 可跑 B0，
 * 并写出 generate-result + quality-trace。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
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
