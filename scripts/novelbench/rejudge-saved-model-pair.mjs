#!/usr/bin/env node
/** Rejudge a saved human-review pair without regenerating chapter prose. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createStrictJudgeGenerate,
  resolveReaderJudge,
  withHardTimeout,
} from "./compare-writers-lib.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "../..");
const extensionRoot = join(projectRoot, ".pi", "extensions", "novel-studio");
const defaultArtifact = join(
  projectRoot,
  "reports",
  "model-comparison",
  "human-review",
  "gemini31-vs-claude46-human-review-2026-07-20T07-53-43-068Z",
  "gemini-vs-claude.md",
);
const artifactPath = resolve(
  process.argv.find((arg) => arg.startsWith("--artifact="))?.slice("--artifact=".length)
    ?? defaultArtifact,
);
if (!existsSync(artifactPath)) throw new Error(`saved comparison artifact not found: ${artifactPath}`);
const readerJudge = resolveReaderJudge(process.argv.slice(2));

process.env.PROJECT_ROOT = projectRoot;
process.env.PINOVEL_DEV_MODE ??= "1";
const source = readFileSync(artifactPath, "utf8");
const geminiText = extractSection(source, "## Gemini 3.1 Pro", "\n\n---");
const claudeText = extractSection(source, "## Claude Opus 4.6", null);

const { createJudgeArbitrator } = await import(pathToFileURL(join(
  extensionRoot, "dist-eval", "v2", "core", "judge-arbitrator.js",
)).href);
const configModule = await import(pathToFileURL(join(
  extensionRoot, "dist-eval", "utils", "config.js",
)).href);
configModule.reloadProjectEnv(false);
const judgeModelGenerate = readerJudge.strictSchema
  ? await createGptJudgeGenerate()
  : await createRoutedReaderJudgeGenerate(readerJudge);

const previousClearSkip = process.env.PINOVEL_JUDGE_CLEAR_SKIP;
process.env.PINOVEL_JUDGE_CLEAR_SKIP = "0";
let result;
try {
  result = await withHardTimeout(createJudgeArbitrator().arbitrate({
    rawCandidate: candidate("candidate-claude", claudeText, "claude-opus-4-6"),
    editorialCandidate: candidate("candidate-gemini31", geminiText, "gemini-3.1-pro-preview"),
    intent: {
      chapterFunction: "验证门后模仿者的能力边界，并把危险从猜测推进为确认敌意",
      readerExperience: ["中文原生语感", "小说语感", "场景沉浸", "悬念推进"],
      inviolableFacts: [
        "安全门从内部反锁",
        "异常无法知道从未被说出的记忆",
        "许岚不知道林默昨夜见过谁",
      ],
      protagonistAction: "林默使用虚假记忆主动试探门后的声音",
      protagonistChoice: "暴露自己已经识破模仿者",
      choiceCost: "模仿者确认林默已识破它",
      newInformation: "异常无法知道未被说出的记忆",
      irreversibleChange: "林默与门后异常确认敌意",
      endingPressure: "真正的许岚出现，门后的声音仍在要求开门",
    },
    constitution: null,
    modelGenerate: judgeModelGenerate,
    seed: 18,
    route: readerJudge.route,
    timeoutMs: 180_000,
  }), 560_000, "saved pair rejudge");
} finally {
  if (previousClearSkip === undefined) delete process.env.PINOVEL_JUDGE_CLEAR_SKIP;
  else process.env.PINOVEL_JUDGE_CLEAR_SKIP = previousClearSkip;
}

const outputPath = join(
  dirname(artifactPath),
  readerJudge.id === "gpt56"
    ? "judge-detail-reader-priority.json"
    : `judge-detail-reader-priority-${readerJudge.id}.json`,
);
writeFileSync(outputPath, `${JSON.stringify({
  schemaVersion: 1,
  sourceArtifact: artifactPath,
  readerJudge,
  humanGoldWinner: "candidate-gemini31",
  judgeWinner: result.finalSelectedCandidateId,
  alignedWithHumanGold: result.finalSelectedCandidateId === "candidate-gemini31",
  result,
}, null, 2)}\n`, "utf8");
process.stdout.write(`Rejudge result: ${outputPath}\n`);
process.stdout.write(`Judge winner: ${result.finalSelectedCandidateId ?? "none"}\n`);
process.stdout.write(`Aligned with human gold: ${result.finalSelectedCandidateId === "candidate-gemini31"}\n`);

async function createGptJudgeGenerate() {
  const judgeAdapter = await import(pathToFileURL(join(
    extensionRoot, "dist-eval", "novelos", "eval", "judge-model-adapter.js",
  )).href);
  return createStrictJudgeGenerate({
    config: judgeAdapter.loadJudgeModelConfigFromEnv(),
    callJudgeModel: judgeAdapter.callJudgeModel,
    maxRetries: Number(process.env.PINOVEL_WRITER_JUDGE_MAX_RETRIES ?? 2),
  });
}

async function createRoutedReaderJudgeGenerate(judge) {
  const modelAdapter = await import(pathToFileURL(join(
    extensionRoot, "dist-eval", "v2", "adapters", "legacy-model-route-adapter.js",
  )).href);
  const generate = modelAdapter.createLegacyModelGenerateFn();
  return async (input) => {
    const output = await generate({
      ...input,
      route: judge.route,
      requestedRoute: judge.route,
      maxTokens: 4096,
    });
    if (output.model !== judge.model || output.provider !== judge.provider) {
      throw new Error(
        `reader judge provenance mismatch: expected ${judge.provider}/${judge.model}, got ${output.provider}/${output.model}`,
      );
    }
    return output;
  };
}

function extractSection(markdown, heading, endingMarker) {
  const start = markdown.indexOf(`${heading}\n\n`);
  if (start < 0) throw new Error(`missing section: ${heading}`);
  const contentStart = start + heading.length + 2;
  const end = endingMarker === null ? markdown.length : markdown.indexOf(endingMarker, contentStart);
  if (end < 0) throw new Error(`missing ending marker for section: ${heading}`);
  const text = markdown.slice(contentStart, end).trim();
  if (!text) throw new Error(`empty section: ${heading}`);
  return text;
}

function candidate(id, text, model) {
  return {
    id,
    kind: "context_enhanced",
    text,
    model,
    route: "saved_human_review",
    contextHash: "saved-human-review-same-context",
    generatedAt: "2026-07-20T07:53:43.068Z",
    durationMs: 0,
    promptProfile: {
      type: "editorial",
      tokensIn: 0,
      containsDialogueRatio: false,
      containsParagraphLengthConstraint: false,
      containsControlChecklist: false,
      containsMechanicalMetric: false,
      contractIds: [],
    },
  };
}
