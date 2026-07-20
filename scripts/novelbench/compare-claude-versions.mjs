#!/usr/bin/env node
/** Real, read-only Claude Opus 4.6 vs 4.8 chapter comparison. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertWorkspaceUnchanged,
  buildFailedComparison,
  buildPairAggregateReport,
  createComparisonWorkspace,
  createStrictJudgeGenerate,
  removeComparisonWorkspace,
  snapshotWorkspace,
  withHardTimeout,
} from "./compare-writers-lib.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "../..");
const extensionRoot = join(projectRoot, ".pi", "extensions", "novel-studio");
const distIndex = join(extensionRoot, "dist", "index.js");
const comparisonModule = join(extensionRoot, "dist-eval", "novelbench", "writer-model-comparison.js");
for (const path of [distIndex, comparisonModule]) {
  if (!existsSync(path)) throw new Error(`missing compiled artifact: ${path}; run npm run build first`);
}

process.env.PROJECT_ROOT = projectRoot;
process.env.PINOVEL_DEV_MODE ??= "1";
const samples = Number(process.argv.find((arg) => arg.startsWith("--samples="))?.split("=")[1] ?? 1);
if (!Number.isInteger(samples) || samples < 1 || samples > 3) {
  throw new Error("--samples must be an integer between 1 and 3");
}
const requestedSceneId = process.argv.find((arg) => arg.startsWith("--scene="))?.split("=")[1] ?? null;
const candidateTimeoutMs = Number(
  process.argv.find((arg) => arg.startsWith("--candidate-timeout-ms="))?.split("=")[1] ?? 600_000,
);
if (!Number.isInteger(candidateTimeoutMs) || candidateTimeoutMs < 30_000 || candidateTimeoutMs > 600_000) {
  throw new Error("--candidate-timeout-ms must be an integer between 30000 and 600000");
}

const scenes = [
  {
    id: "suspense-investigation",
    title: "封闭楼层的回声",
    genre: "悬疑",
    subGenres: ["都市异常"],
    protagonist: { id: "lin-mo", name: "林默", profile: "异常调查员，克制、警觉，坚持用可观察行动验证判断。" },
    supporting: { id: "xu-lan", name: "许岚", profile: "现场联络员，说话简短，知道部分规则。" },
    immutableFacts: ["安全门从内部反锁", "异常只能复述听过的话", "许岚不知道林默昨夜见过谁"],
    outline: "林默验证门后模仿许岚的声音，试探必须产生一条规则，并让危险从猜测变成双方确认。",
    choice: "说出一段答案相反的虚假记忆试探门后的声音",
    cost: "异常会知道林默已经识破它",
    irreversibleChange: "双方确认彼此已被发现",
    endingPressure: "真正的许岚出现，门后的声音仍在要求开门",
    protagonistCoreConflict: "林默必须在不轻信他人的同时依赖他人的证词",
    thematicQuestions: ["记忆能否证明身份"],
    aestheticDirection: ["克制", "具体", "让规则通过行动显现"],
  },
  {
    id: "relationship-cost",
    title: "失约后的同盟",
    genre: "都市",
    subGenres: ["情感", "职场"],
    protagonist: { id: "chen-zhou", name: "陈舟", profile: "调查记者，习惯用事实保护自己，不擅长承认亏欠。" },
    supporting: { id: "su-wan", name: "苏晚", profile: "摄影师，不接受空泛道歉，保管着唯一底片。" },
    immutableFacts: ["陈舟三年前为保护消息源失约", "苏晚不知道真实原因", "底片只剩一份"],
    outline: "两人在停业照相馆重逢，关系变化必须通过一次具体且有代价的交换完成。",
    choice: "陈舟交出可能暴露旧消息源的采访记录换取底片",
    cost: "他可能永远失去消息源的信任",
    irreversibleChange: "苏晚确认陈舟曾替她决定应承受什么",
    endingPressure: "底片中出现不该在现场的第三个人",
    protagonistCoreConflict: "陈舟用隐瞒保护别人，却因此剥夺别人选择的权利",
    thematicQuestions: ["迟到的真相能否修复选择"],
    aestheticDirection: ["含蓄", "具体", "对白有潜台词"],
  },
  {
    id: "action-decision-cost",
    title: "封锁线内的抉择",
    genre: "科幻",
    subGenres: ["灾难", "动作"],
    protagonist: { id: "lu-yao", name: "陆遥", profile: "救援队长，判断迅速，必须同时对队员和平民负责。" },
    supporting: { id: "gao-ning", name: "高宁", profile: "结构工程师，反对没有计算依据的英雄主义。" },
    immutableFacts: ["氧气只能支撑十二分钟", "泄压会永久淹没设备舱", "设备舱保存唯一污染样本"],
    outline: "余震后出口被卡死，行动必须清楚表现空间、资源和队伍分工。",
    choice: "陆遥下令手动泄压打开逃生通道",
    cost: "失去污染样本并由自己留下完成阀门操作",
    irreversibleChange: "设备舱被淹没且证据无法恢复",
    endingPressure: "通道打开后氧气消耗仍在上升，队伍里多了一个呼吸源",
    protagonistCoreConflict: "陆遥必须在救人和保存未来救援证据之间选择",
    thematicQuestions: ["领导者如何承担不可兼得的选择"],
    aestheticDirection: ["动作清晰", "空间可辨", "不用短句堆砌紧张"],
  },
];
const selectedScenes = requestedSceneId === null
  ? scenes
  : scenes.filter((scene) => scene.id === requestedSceneId);
if (selectedScenes.length === 0) {
  throw new Error(`unknown --scene value: ${requestedSceneId}`);
}

const configModule = await import(pathToFileURL(join(extensionRoot, "dist", "utils", "config.js")).href);
configModule.reloadProjectEnv(false);
const reusedClaudeCredentials = configureScopedClaude48Credentials(process.env);
process.stdout.write(`Claude 4.8 eval credentials: ${reusedClaudeCredentials ? "scoped Claude 4.6 endpoint reuse" : "isolated CLAUDE48 env"}\n`);

const extension = await import(pathToFileURL(distIndex).href);
const { compareClaudeVersions } = await import(pathToFileURL(comparisonModule).href);
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

const runId = `claude48-vs-claude46-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const comparisons = [];
for (const scene of selectedScenes) {
  const workspace = createComparisonWorkspace({ projectRoot, runId, scene });
  const previewSummaries = {};
  try {
    const before = snapshotWorkspace(workspace.workspacePath);
    for (let sampleIndex = 1; sampleIndex <= samples; sampleIndex += 1) {
      try {
        const comparison = await compareClaudeVersions({
          workspaceId: workspace.workspaceId,
          chapterId: "1",
          chapterNumber: 1,
          seed: 90 + sampleIndex,
          strategy: "raw",
          sampleIndex,
          candidateTimeoutMs,
          previewTotalTimeoutMs: candidateTimeoutMs,
          runPreview: async (input) => {
            const writer = input.modelTestRoute === "claude48" ? "claude48" : "claude";
            const startedAt = Date.now();
            process.stdout.write(`${scene.id}/${sampleIndex}/${writer}: preview started\n`);
            const result = await withHardTimeout(chapterTool.execute(
              `claude-version-${writer}-${Date.now()}`,
              input,
              undefined,
              undefined,
              { cwd: projectRoot, ui: { notify() {} } },
            ), candidateTimeoutMs + 20_000, `${scene.id}/${sampleIndex}/${writer} preview`);
            if (result?.isError && !result?.details) throw new Error(`novel_generate_chapter failed for ${writer}`);
            previewSummaries[writer] = summarizePreview(result.details);
            process.stdout.write(`${scene.id}/${sampleIndex}/${writer}: preview finished in ${Date.now() - startedAt}ms\n`);
            return result.details;
          },
          judgeModelGenerate,
        });
        comparisons.push({ sceneId: scene.id, ...comparison });
        process.stdout.write(`${scene.id}/${sampleIndex}: ${comparison.winner ?? "inconclusive"}\n`);
      } catch (error) {
        comparisons.push({
          ...buildFailedComparison({
            sceneId: scene.id,
            workspaceId: workspace.workspaceId,
            chapterId: "1",
            chapterNumber: 1,
            error,
            previewSummaries,
          }),
          strategy: "raw",
          sampleIndex,
        });
        process.stdout.write(`${scene.id}/${sampleIndex}: preview_failed\n`);
      }
    }
    assertWorkspaceUnchanged(before, snapshotWorkspace(workspace.workspacePath));
  } finally {
    removeComparisonWorkspace({ projectRoot, workspacePath: workspace.workspacePath });
  }
}

const report = buildPairAggregateReport({
  runId,
  pairId: "claude48-vs-claude46",
  baselineId: "claude",
  challengerId: "claude48",
  comparisons,
});
const reportDir = join(projectRoot, "reports", "model-comparison", "claude48-vs-claude46", runId);
mkdirSync(reportDir, { recursive: true });
const reportPath = join(reportDir, "comparison-report.json");
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`Sanitized report: ${reportPath}\n`);
process.stdout.write(`Recommended default: ${report.admission.recommendedDefault}\n`);

function summarizePreview(output) {
  const envelope = output?.failureEnvelope && typeof output.failureEnvelope === "object"
    ? output.failureEnvelope
    : {};
  return {
    status: output?.status ?? "unknown",
    stage: envelope.stage ?? null,
    gate: envelope.gate ?? null,
    reason: envelope.reason ?? output?.stageResults?.loadError ?? null,
    modelCalls: Array.isArray(output?.stageResults?.modelCalls) ? output.stageResults.modelCalls : [],
  };
}

function configureScopedClaude48Credentials(env) {
  let reused = false;
  for (const [target, source] of [
    ["CLAUDE48_BASE_URL", "CLAUDE_BASE_URL"],
    ["CLAUDE48_API_KEY", "CLAUDE_API_KEY"],
  ]) {
    if (!env[target] && env[source]) {
      env[target] = env[source];
      reused = true;
    }
  }
  env.CLAUDE48_MODEL = "claude-opus-4-8";
  for (const key of ["CLAUDE48_BASE_URL", "CLAUDE48_API_KEY"]) {
    if (!env[key]) throw new Error(`${key} is required for the Claude 4.8 comparison`);
  }
  return reused;
}
