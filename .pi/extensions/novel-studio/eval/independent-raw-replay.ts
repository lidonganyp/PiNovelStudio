/**
 * Independent raw replay — 四臂矩阵 raw_direct 产品入口。
 *
 * 只允许 PINOVEL_EVAL_ONLY=1。通过 runUnifiedPipeline(evalMode=B0)
 * 做一次裸写（无 Agentic、无作者风格优化），并写出 generate-result.json
 * 与 quality-trace，供 FullPipelineReplayRunner 归档为 ReplayRunManifest。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runUnifiedPipeline } from "../v2/core/unified-entry.js";
import { createLegacyModelGenerateFn } from "../v2/adapters/legacy-model-route-adapter.js";
import type { ModelGenerateFn } from "../v2/adapters/legacy-model-route-adapter.js";
import type { ChapterIntent } from "../v2/core/chapter-intent-builder.js";
import type { CompiledContext } from "../v2/core/types.js";
import type { V2Output } from "../v2/core/types.js";

export interface IndependentRawReplayInput {
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  projectRoot: string;
  modelGenerate?: ModelGenerateFn;
  writerModel?: "claude" | "gemini31";
}

export interface IndependentRawReplayOutput {
  result: V2Output;
  resultPath: string;
  tracePath: string;
}

function emptyIntent(): ChapterIntent {
  return {
    chapterFunction: "",
    readerExperience: [],
    currentPressure: [],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: [],
    inviolableFacts: [],
    sourceRefs: [],
  };
}

function emptyContext(): CompiledContext {
  return {
    facts: [],
    characterStates: [],
    openLoops: [],
    worldRules: [],
    styleReferences: [],
    sourceMap: [],
    constitution: null,
    longTermState: null,
  };
}

function extractModelCalls(result: V2Output): unknown[] {
  const stage = result.stageResults ?? {};
  const fromStage = Array.isArray(stage.modelCalls) ? stage.modelCalls : [];
  if (fromStage.length > 0) return fromStage;
  const gates = Array.isArray(stage.gates) ? stage.gates : [];
  const collected: unknown[] = [];
  for (const gate of gates) {
    if (!gate || typeof gate !== "object") continue;
    const evidence = (gate as { evidence?: { modelCalls?: unknown } }).evidence;
    if (evidence && Array.isArray(evidence.modelCalls)) {
      collected.push(...evidence.modelCalls);
    }
  }
  return collected;
}

export async function runIndependentRawReplay(
  input: IndependentRawReplayInput,
): Promise<IndependentRawReplayOutput> {
  if (process.env.PINOVEL_EVAL_ONLY !== "1") {
    throw new Error("runIndependentRawReplay 仅允许 PINOVEL_EVAL_ONLY=1");
  }
  const modelGenerate = input.modelGenerate ?? createLegacyModelGenerateFn();
  const result = await runUnifiedPipeline({
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    chapterNumber: input.chapterNumber,
    projectRoot: input.projectRoot,
    writerModel: input.writerModel,
    evalMode: "B0",
    evalPrefix: "independent-raw",
    evalIntent: emptyIntent(),
    evalContext: emptyContext(),
    evalModelGenerate: modelGenerate,
    evalPromptProfile: "generic_writer_v1",
  });

  const chapterDir = join(
    input.projectRoot,
    "workspaces",
    input.workspaceId,
    "chapters",
    `chapter-${input.chapterId}`,
  );
  const tracesDir = join(input.projectRoot, "workspaces", input.workspaceId, "traces");
  mkdirSync(chapterDir, { recursive: true });
  mkdirSync(tracesDir, { recursive: true });
  const resultPath = join(chapterDir, "generate-result.json");
  const tracePath = join(tracesDir, `${input.chapterId}-quality-trace.json`);
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
  writeFileSync(
    tracePath,
    `${JSON.stringify(
      {
        schemaId: "pinovel.independent-raw-quality-trace",
        matrixArm: "raw_direct",
        evalMode: "B0",
        gates: [
          {
            stage: "v2_final_selected",
            evidence: {
              modelCalls: extractModelCalls(result),
            },
          },
        ],
        recoveryAttempts: [],
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  return { result, resultPath, tracePath };
}
