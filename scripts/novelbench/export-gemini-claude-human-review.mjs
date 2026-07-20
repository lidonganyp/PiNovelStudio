#!/usr/bin/env node
/** Export one controlled Gemini/Claude pair for explicit human literary review. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertWorkspaceUnchanged,
  createComparisonWorkspace,
  createStrictJudgeGenerate,
  extractVerifiedPreviewText,
  removeComparisonWorkspace,
  snapshotWorkspace,
  withHardTimeout,
} from "./compare-writers-lib.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "../..");
const extensionRoot = join(projectRoot, ".pi", "extensions", "novel-studio");
const distIndex = join(extensionRoot, "dist", "index.js");
const comparisonModule = join(extensionRoot, "dist-eval", "novelbench", "writer-model-comparison.js");
const arbitratorModule = join(extensionRoot, "dist-eval", "v2", "core", "judge-arbitrator.js");
for (const path of [distIndex, comparisonModule, arbitratorModule]) {
  if (!existsSync(path)) throw new Error(`missing compiled artifact: ${path}; run npm run build first`);
}

process.env.PROJECT_ROOT = projectRoot;
process.env.PINOVEL_DEV_MODE ??= "1";
const scene = {
  id: "suspense-investigation-human-review",
  title: "都市异常调查",
  genre: "悬疑",
  subGenres: ["都市异常"],
  protagonist: { id: "lin-mo", name: "林默", profile: "异常调查员，克制、警觉，不轻信未经验证的直觉。" },
  supporting: { id: "xu-lan", name: "许岚", profile: "现场联络员，说话简短，知道部分规则但不知道林默昨夜的行踪。" },
  immutableFacts: ["安全门从内部反锁", "异常无法知道从未被说出的记忆", "许岚不知道林默昨夜见过谁"],
  outline: "林默在封闭楼道里验证门后模仿许岚的声音。验证必须产生一条可用规则，并把危险从猜测变为双方确认。",
  choice: "用一段答案相反的虚假记忆试探门后的声音",
  cost: "模仿者会知道林默已经识破它",
  irreversibleChange: "林默与门后异常从互相隐藏变成确认敌意",
  endingPressure: "真正的许岚从楼梯口出现，而门后的声音仍在叫林默开门",
  protagonistCoreConflict: "林默必须在不信任他人的同时依赖他人",
  thematicQuestions: ["记忆能否证明身份"],
  aestheticDirection: ["克制", "具体", "让规则通过行动显现"],
};

const extension = await import(pathToFileURL(distIndex).href);
const { compareWriterModels } = await import(pathToFileURL(comparisonModule).href);
const { createJudgeArbitrator } = await import(pathToFileURL(arbitratorModule).href);
const judgeAdapter = await import(pathToFileURL(join(
  extensionRoot, "dist-eval", "novelos", "eval", "judge-model-adapter.js",
)).href);
const registered = new Map();
extension.default({ registerTool(tool) { registered.set(tool.name, tool); }, registerCommand() {}, on() {} });
const chapterTool = registered.get("novel_generate_chapter");
if (!chapterTool) throw new Error("novel_generate_chapter was not registered");
const judgeModelGenerate = createStrictJudgeGenerate({
  config: judgeAdapter.loadJudgeModelConfigFromEnv(),
  callJudgeModel: judgeAdapter.callJudgeModel,
  maxRetries: Number(process.env.PINOVEL_WRITER_JUDGE_MAX_RETRIES ?? 2),
});

const runId = `gemini31-vs-claude46-human-review-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const workspace = createComparisonWorkspace({ projectRoot, runId, scene });
const previews = new Map();
let arbitration = null;
let comparison;
try {
  const before = snapshotWorkspace(workspace.workspacePath);
  comparison = await compareWriterModels({
    workspaceId: workspace.workspaceId,
    chapterId: "1",
    chapterNumber: 1,
    seed: 18,
    strategy: "raw",
    sampleIndex: 2,
    candidateTimeoutMs: 600_000,
    previewTotalTimeoutMs: 600_000,
    runPreview: async (input) => {
      const writer = input.writerModel;
      process.stdout.write(`${writer}: preview started\n`);
      const result = await withHardTimeout(chapterTool.execute(
        `human-review-${writer}-${Date.now()}`,
        input,
        undefined,
        undefined,
        { cwd: projectRoot, ui: { notify() {} } },
      ), 620_000, `${writer} preview`);
      if (result?.isError && !result?.details) throw new Error(`novel_generate_chapter failed for ${writer}`);
      previews.set(writer, result.details);
      process.stdout.write(`${writer}: preview finished\n`);
      return result.details;
    },
    judgeModelGenerate,
    arbitrate: async (input) => {
      arbitration = await createJudgeArbitrator().arbitrate(input);
      return arbitration;
    },
  });
  assertWorkspaceUnchanged(before, snapshotWorkspace(workspace.workspacePath));
} finally {
  removeComparisonWorkspace({ projectRoot, workspacePath: workspace.workspacePath });
}

const claude = extractVerifiedPreviewText(previews.get("claude"), {
  requestedRoute: "v2_rawstage2",
  provider: "claude",
  model: "claude-opus-4-6",
});
const gemini = extractVerifiedPreviewText(previews.get("gemini31"), {
  requestedRoute: "v2_rawstage2_gemini31",
  provider: "gemini31",
  model: "gemini-3.1-pro-preview",
});

const outputDir = join(projectRoot, "reports", "model-comparison", "human-review", runId);
mkdirSync(outputDir, { recursive: true });
const comparisonPath = join(outputDir, "gemini-vs-claude.md");
const judgePath = join(outputDir, "judge-detail.json");
writeFileSync(comparisonPath, [
  "# Gemini 3.1 Pro vs Claude Opus 4.6 人工对比",
  "",
  "> 同一 ChapterContract、同一编译上下文、raw 策略、seed=18；均由 `novel_generate_chapter` 生成并通过 FactGuard；只读预览未提交状态。",
  "",
  "## 自动裁判结果",
  "",
  `- 胜者：${comparison.winner ?? "无明确胜者"}`,
  `- 原因：${comparison.decisionReason}`,
  `- 正反一致：${comparison.reverseConsistent}`,
  `- Claude：${claude.characterCount} 字符，${claude.durationMs} ms`,
  `- Gemini：${gemini.characterCount} 字符，${gemini.durationMs} ms`,
  "",
  "## Gemini 3.1 Pro",
  "",
  gemini.text,
  "",
  "---",
  "",
  "## Claude Opus 4.6",
  "",
  claude.text,
  "",
].join("\n"), "utf8");
writeFileSync(judgePath, `${JSON.stringify({
  schemaVersion: 1,
  runId,
  comparison,
  arbitration,
  provenance: {
    claude: { ...claude, text: undefined },
    gemini31: { ...gemini, text: undefined },
  },
}, null, 2)}\n`, "utf8");
process.stdout.write(`Human review: ${comparisonPath}\n`);
process.stdout.write(`Judge detail: ${judgePath}\n`);
