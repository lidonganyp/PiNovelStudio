#!/usr/bin/env node
/** Generate one user-requested Gemini chapter preview through novel_generate_chapter. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertWorkspaceUnchanged,
  createComparisonWorkspace,
  extractVerifiedPreviewText,
  removeComparisonWorkspace,
  snapshotWorkspace,
  withHardTimeout,
} from "./compare-writers-lib.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "../..");
const extensionRoot = join(projectRoot, ".pi", "extensions", "novel-studio");
const distIndex = join(extensionRoot, "dist", "index.js");
if (!existsSync(distIndex)) throw new Error("missing dist/index.js; run npm run build first");

process.env.PROJECT_ROOT = projectRoot;
process.env.PINOVEL_DEV_MODE ??= "1";
const sampleIndex = Number(process.argv.find((arg) => arg.startsWith("--sample="))?.split("=")[1] ?? 1);
if (!Number.isInteger(sampleIndex) || sampleIndex < 1 || sampleIndex > 3) {
  throw new Error("--sample must be an integer between 1 and 3");
}

const scene = {
  id: "gemini-suspense-preview",
  title: "封闭楼层的回声",
  genre: "悬疑",
  subGenres: ["都市异常"],
  protagonist: {
    id: "lin-mo",
    name: "林默",
    profile: "异常调查员，克制、警觉，习惯用可验证行动排除错误判断。",
  },
  supporting: {
    id: "xu-lan",
    name: "许岚",
    profile: "现场联络员，说话简短，知道楼层安全规则，但不知道林默昨夜的经历。",
  },
  immutableFacts: [
    "安全门从内部反锁",
    "门后的异常只能复述听过的话",
    "许岚不知道林默昨夜见过谁",
  ],
  outline: "林默在封闭楼层验证门后模仿许岚的声音。试探必须产生一条可用规则，并让双方从互相隐瞒变成确认敌意。",
  choice: "林默说出一段答案相反的虚假记忆试探门后的声音",
  cost: "门后的存在会知道林默已经识破它",
  irreversibleChange: "林默和门后异常确认彼此已被发现",
  endingPressure: "真正的许岚从楼梯口出现，而门后的声音仍在要求林默开门",
  protagonistCoreConflict: "林默必须在不轻信他人的同时依赖他人的证词",
  thematicQuestions: ["记忆能否证明身份"],
  aestheticDirection: ["克制", "具体", "让规则通过行动显现"],
};

const extension = await import(pathToFileURL(distIndex).href);
const registered = new Map();
extension.default({
  registerTool(tool) { registered.set(tool.name, tool); },
  registerCommand() {},
  on() {},
});
const chapterTool = registered.get("novel_generate_chapter");
if (!chapterTool) throw new Error("novel_generate_chapter was not registered");

const runId = `gemini31-preview-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const workspace = createComparisonWorkspace({ projectRoot, runId, scene });
let extracted;
try {
  const before = snapshotWorkspace(workspace.workspacePath);
  const result = await withHardTimeout(chapterTool.execute(
    `gemini-preview-${Date.now()}`,
    {
      workspaceId: workspace.workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      writerModel: "gemini31",
      seed: 70 + sampleIndex,
      candidateTimeoutMs: 600_000,
      previewTotalTimeoutMs: 600_000,
      fullPipelinePreview: true,
      qualityExperiment: { arm: "raw", sampleIndex },
    },
    undefined,
    undefined,
    { cwd: projectRoot, ui: { notify() {} } },
  ), 620_000, "Gemini chapter preview");
  if (result?.isError && !result?.details) throw new Error("novel_generate_chapter returned an error");
  extracted = extractVerifiedPreviewText(result.details, {
    requestedRoute: "v2_rawstage2_gemini31",
    provider: "gemini31",
    model: "gemini-3.1-pro-preview",
  });
  assertWorkspaceUnchanged(before, snapshotWorkspace(workspace.workspacePath));
} finally {
  removeComparisonWorkspace({ projectRoot, workspacePath: workspace.workspacePath });
}

const outputDir = join(projectRoot, "reports", "model-previews", "gemini31", runId);
mkdirSync(outputDir, { recursive: true });
const previewPath = join(outputDir, "chapter-preview.md");
const metadataPath = join(outputDir, "metadata.json");
writeFileSync(previewPath, [
  "# Gemini 3.1 Pro 章节预览",
  "",
  "> 由 `novel_generate_chapter` 统一主链路生成；raw FactGuard 已通过；只读预览未提交章节或状态。",
  "",
  "## 正文",
  "",
  extracted.text,
  "",
].join("\n"), "utf8");
writeFileSync(metadataPath, `${JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sampleIndex,
  ...Object.fromEntries(Object.entries(extracted).filter(([key]) => key !== "text")),
}, null, 2)}\n`, "utf8");
process.stdout.write(`Preview: ${previewPath}\n`);
process.stdout.write(`Metadata: ${metadataPath}\n`);
process.stdout.write(`Characters: ${extracted.characterCount}; durationMs: ${extracted.durationMs}\n`);
