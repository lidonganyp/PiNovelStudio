#!/usr/bin/env node
/**
 * Eval 回放桥接脚本：子进程内调用 novel_generate_chapter（统一主链路唯一入口）。
 *
 * 由 eval/full-pipeline-replay-runner.ts 的 defaultFullPipelineInvoke spawn：
 *   node scripts/invoke-generate-chapter.mjs <workspaceId> <chapterId> <chapterNumber> [mock]
 *     --project-root=<scratchRoot> [--writer-model=<m>] [--model-test-route=<r>]
 *
 * 隔离契约：
 * - 工具加载自 dist/index.js（生产入口，传输解析链 F4-4 在 prod 闭包内）；
 * - --project-root 传入 scratchRoot 作为 _projectRoot（workspaces/{workspaceId}
 *   相对 scratchRoot 解析，与 createScratchWorkspace 布局一致）；
 * - 传输 env（V2_FORCE_STUB / PINOVEL_EVAL_RECORDED_RESULTS_PATH /
 *   PINOVEL_EVAL_SYNTHETIC_FAULTS_PATH / PINOVEL_EVAL_REPLAY_TRANSPORT）由
 *   runner 经 spawn env 注入本进程，unified-entry fail-closed 消费；
 * - "mock" 位置参数转 mockAgent:true（惰性遗留标志，实际隔离由传输 env 决定）。
 *
 * 退出码：工具返回 status==="ok" 且无 isError -> 0；否则 -> 1（证据见 stdout
 * 与 {scratchRoot}/workspaces/{ws}/chapters/chapter-{id}/generate-result.json）。
 */

import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = resolve(__dirname, "..");

function usageAndExit() {
  const usage = [
    "用法：node scripts/invoke-generate-chapter.mjs <workspaceId> <chapterId> <chapterNumber> [mock]",
    "      --project-root=<dir> [--writer-model=<m>] [--model-test-route=<r>] [--eval-layer=B0]",
  ].join("\n");
  console.error(usage);
  process.exit(2);
}

const positional = [];
let projectRoot = null;
let writerModel = null;
let modelTestRoute = null;
let evalLayer = null;
let mockAgent = false;

for (const arg of process.argv.slice(2)) {
  if (arg === "mock") {
    mockAgent = true;
  } else if (arg.startsWith("--project-root=")) {
    projectRoot = arg.slice("--project-root=".length);
  } else if (arg.startsWith("--writer-model=")) {
    writerModel = arg.slice("--writer-model=".length);
  } else if (arg.startsWith("--model-test-route=")) {
    modelTestRoute = arg.slice("--model-test-route=".length);
  } else if (arg.startsWith("--eval-layer=")) {
    evalLayer = arg.slice("--eval-layer=".length);
  } else if (arg.startsWith("--")) {
    console.error(`[invoke-generate-chapter] 未知参数：${arg}`);
    usageAndExit();
  } else {
    positional.push(arg);
  }
}

if (evalLayer && evalLayer !== "B0") {
  console.error(`[invoke-generate-chapter] 未知 --eval-layer=${evalLayer}（仅支持 B0）`);
  usageAndExit();
}

const [workspaceId, chapterId, chapterNumberArg] = positional;
const chapterNumber = Number(chapterNumberArg);
if (
  !workspaceId ||
  !chapterId ||
  !Number.isInteger(chapterNumber) ||
  chapterNumber <= 0 ||
  !projectRoot
) {
  console.error("[invoke-generate-chapter] 参数不完整或非法（workspaceId/chapterId/chapterNumber/projectRoot 均必填）");
  usageAndExit();
}

const fakePi = {
  tools: new Map(),
  api: {
    registerTool(t) {
      fakePi.tools.set(t.name, t);
    },
    registerCommand() {},
    on() {},
  },
};

const extension = (
  await import(pathToFileURL(join(EXT_ROOT, "dist", "index.js")).href)
).default;
extension(fakePi.api);

const tool = fakePi.tools.get("novel_generate_chapter");
if (!tool) {
  console.error("[invoke-generate-chapter] dist/index.js 未注册 novel_generate_chapter");
  process.exit(2);
}

if (evalLayer === "B0") {
  if (process.env.PINOVEL_EVAL_ONLY !== "1") {
    console.error("[invoke-generate-chapter] --eval-layer=B0 仅允许 PINOVEL_EVAL_ONLY=1");
    process.exit(2);
  }
  const rawMod = await import(
    pathToFileURL(join(EXT_ROOT, "dist-eval", "eval", "independent-raw-replay.js")).href
  );
  let rawOut;
  try {
    rawOut = await rawMod.runIndependentRawReplay({
      workspaceId,
      chapterId,
      chapterNumber,
      projectRoot,
      writerModel: writerModel === "claude" || writerModel === "gemini31" ? writerModel : undefined,
    });
  } catch (error) {
    console.error(`[invoke-generate-chapter] independent raw 失败：${String(error)}`);
    process.exit(1);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        toolName: "independent_raw_replay",
        workspaceId,
        chapterId,
        chapterNumber,
        projectRoot,
        isError: rawOut.result?.status !== "ok",
        details: rawOut.result,
        resultPath: rawOut.resultPath,
        tracePath: rawOut.tracePath,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(rawOut.result?.status === "ok" ? 0 : 1);
}

const params = {
  workspaceId,
  chapterId,
  chapterNumber,
  _projectRoot: projectRoot,
  ...(mockAgent ? { mockAgent: true } : {}),
  ...(writerModel ? { writerModel } : {}),
  ...(modelTestRoute ? { modelTestRoute } : {}),
};

let result;
try {
  result = await tool.execute(
    `eval-invoke-${chapterId}`,
    params,
    undefined,
    undefined,
    { cwd: projectRoot },
  );
} catch (error) {
  console.error(`[invoke-generate-chapter] 工具执行异常：${String(error)}`);
  process.exit(1);
}

const details = result?.details ?? result;
const isError =
  result?.isError === true ||
  (details &&
    typeof details === "object" &&
    "status" in details &&
    details.status !== "ok");

process.stdout.write(
  `${JSON.stringify(
    {
      toolName: "novel_generate_chapter",
      workspaceId,
      chapterId,
      chapterNumber,
      projectRoot,
      isError: isError === true,
      details,
    },
    null,
    2,
  )}\n`,
);

process.exit(isError ? 1 : 0);
