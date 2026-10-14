/**
 * Independent raw replay — 四臂矩阵 raw_direct 产品入口。
 *
 * 只允许 PINOVEL_EVAL_ONLY=1。通过 runUnifiedPipeline(evalMode=B0)
 * 做一次裸写（无 Agentic、无作者风格优化），并写出 generate-result.json
 * 与 quality-trace，供 FullPipelineReplayRunner 归档为 ReplayRunManifest。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

import { runUnifiedPipeline } from "../v2/core/unified-entry.js";
import { createLegacyModelGenerateFn } from "../v2/adapters/legacy-model-route-adapter.js";
import type { ModelGenerateFn, ModelGenerateInput, ModelGenerateOutput } from "../v2/adapters/legacy-model-route-adapter.js";
import type { ChapterIntent } from "../v2/core/chapter-intent-builder.js";
import type { CompiledContext } from "../v2/core/types.js";
import type { V2Output } from "../v2/core/types.js";
import { loadWorkspace, loadCharacterProfiles } from "../v2/adapters/legacy-workspace-adapter.js";
import { resolveExistingChapterFile } from "../utils/chapter-path.js";
import { resolveWorkspacePath } from "../utils/fs.js";
import { localizeLlmText } from "../utils/llm-language-guard.js";

export function buildIndependentRawInput(input: IndependentRawReplayInput): {
  prefix: string;
  sources: Array<{ path: string; sha256: string }>;
} {
  if (!Number.isInteger(input.chapterNumber) || input.chapterNumber < 1) {
    throw new Error("B0 chapterNumber 必须为正整数");
  }
  resolveWorkspacePath(join(input.projectRoot, "workspaces"), input.workspaceId);
  const bundle = loadWorkspace(input.workspaceId, input.projectRoot);
  const characters = loadCharacterProfiles(bundle);
  if (typeof bundle.config.genre !== "string" || !bundle.config.genre.trim() || characters.length === 0) {
    throw new Error("B0 缺少作品类型或角色基础资料");
  }
  const sources: Array<{ path: string; sha256: string }> = [];
  const readSource = (path: string): string => {
    const text = readFileSync(path, "utf-8");
    sources.push({ path: relative(bundle.workspacePath, path).replace(/\\/g, "/"), sha256: createHash("sha256").update(text).digest("hex") });
    return text;
  };
  readSource(join(bundle.workspacePath, "config.json"));
  const basicConfig = Object.fromEntries(
    ["novelName", "name", "genre", "subGenres", "tagline", "themeKeywords", "worldKeyTerms", "characters", "targetWordCount"]
      .filter((field) => bundle.config[field] !== undefined)
      .map((field) => [field, bundle.config[field]]),
  );
  const parts = [`本章任务：根据以下作者资料写第${input.chapterNumber}章。`, `作品基础资料：\n${JSON.stringify(basicConfig)}`];
  for (const character of characters) {
    parts.push(readSource(join(bundle.workspacePath, "characters", `${character.id}.md`)));
  }
  for (const file of ["CORE-WRITING-PRINCIPLES.md", "WORLDBUILDING-CANON.md", "series/outline.md", `series/ch${input.chapterNumber}-outline-explicit.md`]) {
    const path = join(bundle.workspacePath, file);
    if (existsSync(path)) parts.push(`${file}\n${readSource(path)}`);
  }
  if (input.chapterNumber > 1) {
    const previousPath = resolveExistingChapterFile(bundle.workspacePath, String(input.chapterNumber - 1));
    if (!previousPath) throw new Error("B0 缺少前章正文，无法进行同任务续写对照");
    parts.push(`前章正文：\n${readSource(previousPath.path)}`);
  }
  return { prefix: localizeLlmText(parts.join("\n\n")), sources };
}

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
  const rawInput = buildIndependentRawInput(input);
  const inputConsumption: Array<{ inputSha256: string; userPromptSha256: string; sourceCount: number; consumed: boolean }> = [];
  const modelGenerate = input.modelGenerate ?? createLegacyModelGenerateFn();
  const result = await runUnifiedPipeline({
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    chapterNumber: input.chapterNumber,
    projectRoot: input.projectRoot,
    writerModel: input.writerModel,
    evalMode: "B0",
    evalPrefix: rawInput.prefix,
    evalIntent: emptyIntent(),
    evalContext: emptyContext(),
    evalModelGenerate: async (request: ModelGenerateInput): Promise<ModelGenerateOutput> => {
      const consumed = request.userPrompt.includes(rawInput.prefix);
      if (!consumed) throw new Error("B0 作品输入未进入模型请求");
      inputConsumption.push({
        inputSha256: createHash("sha256").update(rawInput.prefix).digest("hex"),
        userPromptSha256: createHash("sha256").update(request.userPrompt).digest("hex"),
        sourceCount: rawInput.sources.length,
        consumed,
      });
      return modelGenerate(request);
    },
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
              inputSources: rawInput.sources,
              inputConsumption,
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
