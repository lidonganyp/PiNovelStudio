#!/usr/bin/env node
/** Real, read-only writer and bounded-search chapter comparisons. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertWorkspaceUnchanged,
  aggregateBoundedBestOf3,
  buildAggregateReport,
  buildFailedComparison,
  comparisonErrorRequiresProcessRestart,
  completedComparisonKeys,
  createComparisonWorkspace,
  createStrictJudgeGenerate,
  removeComparisonWorkspace,
  prepareResumeComparisons,
  resolveComparisonPreviewTimeoutMs,
  resolveWriterComparisonMode,
  resolveSearchDepthWriter,
  loadComparisonCheckpoint,
  saveComparisonCheckpoint,
  snapshotWorkspace,
  summarizeBoundedBestOf3Preview,
  withHardTimeout,
} from "./compare-writers-lib.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "../..");
process.env.PROJECT_ROOT = projectRoot;
process.env.PINOVEL_DEV_MODE ??= "1";

const comparisonMode = resolveWriterComparisonMode(process.argv.slice(2));
const searchDepthWriter = resolveSearchDepthWriter(process.argv.slice(2));
const requestedWriterArgument = process.argv.find((arg) => arg.startsWith("--writer="));
if (comparisonMode !== "search_depth" && requestedWriterArgument) {
  throw new Error("--writer is only valid with --mode=search_depth");
}
const previewTotalTimeoutMs = resolveComparisonPreviewTimeoutMs(
  comparisonMode,
  process.env.PINOVEL_WRITER_COMPARE_TOTAL_TIMEOUT_MS,
);
const requestedRunId = process.argv.find((arg) => arg.startsWith("--run-id="))?.slice("--run-id=".length);
const resume = process.argv.includes("--resume");
if (resume && !requestedRunId) throw new Error("--resume requires --run-id=<existing-run-id>");
const runPrefix = comparisonMode === "production_final"
    ? "gemini-production-final-challenger"
  : comparisonMode === "search_depth"
    ? searchDepthWriter.reportGroup
    : "gemini31-vs-claude46";
const runId = requestedRunId || `${runPrefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const reportGroup = comparisonMode === "production_final"
  ? "gemini-production-final-challenger"
  : comparisonMode === "search_depth"
    ? searchDepthWriter.reportGroup
    : "gemini31-vs-claude46";
const reportDir = join(projectRoot, "reports", "model-comparison", reportGroup, runId);
const checkpointPath = join(reportDir, "comparison-report.partial.json");
const extensionRoot = join(projectRoot, ".pi", "extensions", "novel-studio");
const requiredBuilds = [
  join(extensionRoot, "dist", "index.js"),
  join(extensionRoot, "dist-eval", "novelbench", "writer-model-comparison.js"),
  join(extensionRoot, "dist-eval", "novelbench", "production-final-challenger.js"),
];
for (const path of requiredBuilds) {
  if (!existsSync(path)) throw new Error(`missing compiled artifact: ${path}; run npm run build first`);
}

const scenes = [
  {
    id: "suspense-investigation", title: "都市异常调查", genre: "悬疑", subGenres: ["都市异常"],
    protagonist: { id: "lin-mo", name: "林默", profile: "异常调查员，克制、警觉，不轻信未经验证的直觉。" },
    supporting: { id: "xu-lan", name: "许岚", profile: "现场联络员，说话简短，知道部分规则但不知道林默昨夜的行踪。" },
    immutableFacts: ["安全门从内部反锁", "异常无法知道从未被说出的记忆", "许岚不知道林默昨夜见过谁"],
    outline: "林默在封闭楼道里验证门后模仿许岚的声音。验证必须产生一条可用规则，并把危险从猜测变为双方确认。",
    choice: "用一段答案相反的虚假记忆试探门后的声音", cost: "模仿者会知道林默已经识破它",
    irreversibleChange: "林默与门后异常从互相隐藏变成确认敌意", endingPressure: "真正的许岚从楼梯口出现，而门后的声音仍在叫林默开门",
    protagonistCoreConflict: "林默必须在不信任他人的同时依赖他人", thematicQuestions: ["记忆能否证明身份"],
  },
  {
    id: "relationship-cost", title: "失约后的同盟", genre: "都市", subGenres: ["情感", "职场"],
    protagonist: { id: "chen-zhou", name: "陈舟", profile: "调查记者，习惯用事实保护自己，不擅长承认亏欠。" },
    supporting: { id: "su-wan", name: "苏晚", profile: "摄影师，判断直接，不接受空泛道歉，仍保留共同调查的底片。" },
    immutableFacts: ["陈舟三年前为保护消息源临时失约", "苏晚不知道失约的真实原因", "底片只剩一份且由苏晚保管"],
    outline: "两人在停业照相馆重逢。陈舟需要底片继续调查，但不能用解释抹去苏晚承担的后果；关系变化必须通过一次具体交换完成。",
    choice: "陈舟交出会暴露旧消息源的采访记录以换取底片", cost: "他失去独自控制调查风险的可能，也可能永远失去消息源信任",
    irreversibleChange: "苏晚知道失约并非轻视，却确认陈舟曾替她决定应承受什么", endingPressure: "底片显影后出现本不该在现场的第三个人",
    protagonistCoreConflict: "陈舟用隐瞒保护别人，却因此持续剥夺别人作选择的权利", thematicQuestions: ["迟到的真相能否修复被替代的选择"],
    aestheticDirection: ["含蓄", "具体", "对白有潜台词"],
  },
  {
    id: "action-decision-cost", title: "封锁线内的抉择", genre: "科幻", subGenres: ["灾难", "动作"],
    protagonist: { id: "lu-yao", name: "陆遥", profile: "救援队长，判断迅速，但必须对队员和平民同时负责。" },
    supporting: { id: "gao-ning", name: "高宁", profile: "结构工程师，反对没有计算依据的英雄主义，右腿受伤。" },
    immutableFacts: ["地下站剩余氧气只能支撑十二分钟", "手动泄压会永久淹没东侧设备舱", "设备舱保存着全城唯一的污染样本"],
    outline: "余震后出口被卡死。陆遥必须在时间压力下用可观察的结构变化判断方案，行动场面要清楚表现空间、资源和队伍分工。",
    choice: "陆遥下令手动泄压打开逃生通道", cost: "永久失去污染样本，并让自己留下完成最后一道阀门操作",
    irreversibleChange: "东侧设备舱被淹没，调查证据无法恢复", endingPressure: "通道打开后，计数器显示氧气消耗速度仍在上升，说明队伍里多了一个呼吸源",
    protagonistCoreConflict: "陆遥必须接受救人和保存未来救援证据无法同时完成", thematicQuestions: ["领导者应为不可兼得的选择承担什么"],
    aestheticDirection: ["动作清晰", "空间可辨", "紧张但不滥用短句"],
  },
];
const requestedScene = process.argv.find((arg) => arg.startsWith("--scene="))?.slice("--scene=".length);
const selectedScenes = requestedScene ? scenes.filter((scene) => scene.id === requestedScene) : scenes;
const requestedSamples = Number(process.argv.find((arg) => arg.startsWith("--samples="))?.slice("--samples=".length) ?? 1);
if (!Number.isInteger(requestedSamples) || requestedSamples < 1 || requestedSamples > 3) {
  throw new Error("--samples must be an integer between 1 and 3");
}
const requestedStrategyArgument = process.argv.find((arg) => arg.startsWith("--strategies="));
if ((comparisonMode === "production_final" || comparisonMode === "search_depth") && requestedStrategyArgument) {
  throw new Error(`--mode=${comparisonMode} does not accept --strategies`);
}
const requestedStrategies = comparisonMode === "production_final"
  ? ["production_final"]
  : comparisonMode === "search_depth"
    ? ["search_depth"]
  : (requestedStrategyArgument?.slice("--strategies=".length) ?? "raw")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
const allowedStrategies = new Set(["raw", "oracle_scene", "production_final", "search_depth"]);
if (requestedStrategies.length === 0 || requestedStrategies.some((strategy) => !allowedStrategies.has(strategy))) {
  throw new Error("--strategies must contain only raw,oracle_scene");
}
if (requestedScene && selectedScenes.length === 0) {
  throw new Error(`unknown comparison scene: ${requestedScene}`);
}
const expectedComparisonCount = selectedScenes.length * requestedStrategies.length * requestedSamples;

const extension = await import(pathToFileURL(requiredBuilds[0]).href);
process.stderr.write("[writer-compare] production extension imported\n");
const { compareWriterModels } = await import(pathToFileURL(requiredBuilds[1]).href);
const {
  aggregateProductionFinalChallenger,
  compareProductionFinalChallenger,
} = await import(pathToFileURL(requiredBuilds[2]).href);
process.stderr.write("[writer-compare] comparison module imported\n");
const modelAdapter = await import(pathToFileURL(
  join(extensionRoot, "dist-eval", "v2", "adapters", "legacy-model-route-adapter.js"),
).href);
const configModule = await import(pathToFileURL(
  join(extensionRoot, "dist-eval", "utils", "config.js"),
).href);
const judgeAdapter = await import(pathToFileURL(
  join(extensionRoot, "dist-eval", "novelos", "eval", "judge-model-adapter.js"),
).href);
process.stderr.write("[writer-compare] model adapters imported\n");

const registered = new Map();
extension.default({
  registerTool(tool) { registered.set(tool.name, tool); },
  registerCommand() {},
  on() {},
});
process.stderr.write("[writer-compare] public tools registered\n");
const chapterTool = registered.get("novel_generate_chapter");
if (!chapterTool) throw new Error("novel_generate_chapter was not registered");
await configModule.loadGlobalConfig();
const judgeModelGenerate = createStrictJudgeGenerate({
  config: judgeAdapter.loadJudgeModelConfigFromEnv(),
  callJudgeModel: judgeAdapter.callJudgeModel,
  maxRetries: Number(process.env.PINOVEL_WRITER_JUDGE_MAX_RETRIES ?? 2),
  onAttempt: (event) => {
    process.stderr.write(`[writer-compare] judge attempt=${event.attempt} status=${event.status} durationMs=${event.durationMs ?? 0} model=${event.model}\n`);
  },
});
const connectivityModelGenerate = modelAdapter.createLegacyModelGenerateFn();

const skipConnectivity = process.argv.includes("--skip-connectivity");
const connectivity = comparisonMode === "search_depth"
  ? { ok: true, skipped: true, reason: `search-depth mode uses ${searchDepthWriter.model} only` }
  : skipConnectivity
  ? { ok: true, skipped: true, reason: "explicitly skipped after a separately verified probe" }
  : await withHardTimeout(
      verifyGeminiConnectivity(connectivityModelGenerate),
      Number(process.env.PINOVEL_WRITER_CONNECTIVITY_TIMEOUT_MS ?? 120000),
      "gemini connectivity",
    );
process.stderr.write(`[writer-compare] connectivity ${connectivity.skipped ? "skipped" : "verified"}\n`);
const connectivityOnly = process.argv.includes("--connectivity-only");
const reportBuilder = comparisonMode === "production_final"
  ? buildProductionFinalReport
  : comparisonMode === "search_depth"
    ? buildSearchDepthReport
    : buildAggregateReport;
if (connectivityOnly) {
  process.stdout.write(`${JSON.stringify(connectivity)}\n`);
  process.exitCode = connectivity.ok ? 0 : 1;
} else {
  const resumedReport = resume
    ? loadComparisonCheckpoint({ checkpointPath, runId, expectedComparisonCount })
    : null;
  const comparisons = resumedReport ? prepareResumeComparisons(resumedReport.comparisons) : [];
  const completedKeys = completedComparisonKeys(comparisons);
  saveComparisonCheckpoint({
    checkpointPath,
    runId,
    comparisons,
    connectivity,
    expectedComparisonCount,
    complete: false,
    reportBuilder,
  });
  for (const scene of selectedScenes) {
    process.stderr.write(`[writer-compare] preparing scene ${scene.id}\n`);
    const workspace = createComparisonWorkspace({ projectRoot, runId, scene, replaceExisting: resume });
    const previewSummaries = {};
    try {
      const before = snapshotWorkspace(workspace.workspacePath);
      process.stderr.write(`[writer-compare] workspace snapshot ready for ${scene.id}\n`);
      for (const strategy of requestedStrategies) {
        for (let sampleIndex = 1; sampleIndex <= requestedSamples; sampleIndex += 1) {
      const comparisonId = `${scene.id}:${strategy}:${sampleIndex}`;
      if (completedKeys.has(comparisonId)) {
        process.stdout.write(`${comparisonId}: checkpoint_skip\n`);
        continue;
      }
      let restartAfterCheckpoint = null;
      try {
        for (const key of Object.keys(previewSummaries)) delete previewSummaries[key];
            const runPreview = async (input) => {
              const started = Date.now();
              const previewBefore = snapshotWorkspace(workspace.workspacePath);
              process.stdout.write(`${comparisonId}/${input.writerModel}: preview started\n`);
              const output = await withHardTimeout(
                invokeChapterPreview(chapterTool, input),
                previewTotalTimeoutMs,
                `${comparisonId}/${input.writerModel} preview`,
              );
              previewSummaries[`${strategy}:${sampleIndex}:${input.writerModel}`] = summarizePreview(output);
              assertWorkspaceUnchanged(previewBefore, snapshotWorkspace(workspace.workspacePath));
              process.stdout.write(`${comparisonId}/${input.writerModel}: preview finished in ${Date.now() - started}ms\n`);
              return output;
            };
            const sharedComparisonInput = {
              workspaceId: workspace.workspaceId,
              chapterId: "1",
              chapterNumber: 1,
              seed: 16 + sampleIndex,
              candidateTimeoutMs: Number(process.env.PINOVEL_WRITER_COMPARE_TIMEOUT_MS ?? 600000),
              previewTotalTimeoutMs,
              runPreview,
              judgeModelGenerate,
            };
            const comparison = comparisonMode === "production_final"
              ? await compareProductionFinalChallenger(sharedComparisonInput)
              : comparisonMode === "search_depth"
                ? summarizeBoundedBestOf3Preview(await runPreview({
                    workspaceId: workspace.workspaceId,
                    chapterId: "1",
                    chapterNumber: 1,
                    writerModel: searchDepthWriter.writerModel,
                    fullPipelinePreview: true,
                    boundedBestOf3: true,
                    seed: 16 + sampleIndex,
                    candidateTimeoutMs: sharedComparisonInput.candidateTimeoutMs,
                    previewTotalTimeoutMs,
                  }))
                : await compareWriterModels({
                  ...sharedComparisonInput,
                  strategy,
                  sampleIndex,
                  ...(strategy === "oracle_scene" ? { sceneSolution: buildSceneSolution(scene) } : {}),
                });
            comparisons.push({ sceneId: scene.id, strategy, sampleIndex, ...comparison });
            process.stdout.write(`${comparisonId}: ${comparisonMode === "search_depth"
              ? comparison.decisionReason
              : comparison.winner ?? "inconclusive"}\n`);
          } catch (error) {
            const retryRequired = comparisonErrorRequiresProcessRestart(error);
            comparisons.push({
              ...buildFailedComparison({
                sceneId: scene.id,
                workspaceId: workspace.workspaceId,
                chapterId: "1",
                chapterNumber: 1,
                error,
                previewSummaries,
              }),
              strategy,
              sampleIndex,
              ...(retryRequired ? { retryRequired: true } : {}),
            });
            process.stdout.write(`${comparisonId}: preview_failed\n`);
            if (retryRequired) {
              restartAfterCheckpoint = error;
            }
          }
          completedKeys.add(comparisonId);
          saveComparisonCheckpoint({
            checkpointPath,
            runId,
            comparisons,
            connectivity,
            expectedComparisonCount,
            complete: false,
            reportBuilder,
          });
          if (restartAfterCheckpoint) {
            throw new Error(
              `${comparisonId} timed out; resume in a fresh process with --resume to prevent stale preview contamination`,
              { cause: restartAfterCheckpoint },
            );
          }
        }
      }
      assertWorkspaceUnchanged(before, snapshotWorkspace(workspace.workspacePath));
    } finally {
      removeComparisonWorkspace({ projectRoot, workspacePath: workspace.workspacePath });
    }
  }
  const report = saveComparisonCheckpoint({
    checkpointPath,
    runId,
    comparisons,
    connectivity,
    expectedComparisonCount,
    complete: true,
    reportBuilder,
  });
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, "comparison-report.json");
  saveComparisonCheckpoint({
    checkpointPath: reportPath,
    runId,
    comparisons,
    connectivity,
    expectedComparisonCount,
    complete: true,
    reportBuilder,
  });
  process.stdout.write(`Sanitized report: ${reportPath}\n`);
  if (comparisonMode === "production_final") {
    process.stdout.write(`Scoped challenger admitted: ${report.challengerAdmission.anySceneAdmitted}\n`);
    process.stdout.write(`Production applied: ${report.productionApplied}\n`);
  } else if (comparisonMode === "search_depth") {
    process.stdout.write(`Second candidate wins: ${report.searchDepth.secondCandidateWins}/${report.searchDepth.controlledComparisons}\n`);
    process.stdout.write(`Repeated incremental gain: ${report.searchDepth.repeatedIncrementalGain}\n`);
    process.stdout.write(`Production applied: ${report.searchDepth.productionApplied}\n`);
  } else {
    process.stdout.write(`Gemini decisive win rate: ${report.admission.geminiWinRate ?? "n/a"}\n`);
    process.stdout.write(`Default remains: ${report.admission.currentDefault}\n`);
  }
}

function buildSearchDepthReport({ runId: currentRunId, comparisons, connectivity: currentConnectivity }) {
  const searchDepth = aggregateBoundedBestOf3(comparisons);
  return {
    schemaVersion: 1,
    runId: currentRunId,
    generatedAt: new Date().toISOString(),
    comparisonMode: "bounded_best_of_3",
    writer: searchDepthWriter,
    connectivity: currentConnectivity,
    comparisons,
    searchDepth,
    decision: searchDepth.repeatedIncrementalGain
      ? "A second distinct scene candidate shows repeated incremental selection gain; human and continuity gates remain required."
      : "No repeated incremental gain from the second scene candidate was established.",
  };
}

function buildProductionFinalReport({ runId: currentRunId, comparisons, connectivity: currentConnectivity }) {
  const challengerAdmission = aggregateProductionFinalChallenger(comparisons);
  return {
    schemaVersion: 1,
    runId: currentRunId,
    generatedAt: new Date().toISOString(),
    comparisonMode: "production_final_challenger",
    connectivity: currentConnectivity,
    comparisons,
    challengerAdmission,
    productionApplied: false,
    decision: challengerAdmission.anySceneAdmitted
      ? "Scoped Gemini challenger is eligible for reviewed production wiring."
      : "Do not wire Gemini challenger; no scene met the incremental admission gate.",
  };
}

async function invokeChapterPreview(tool, input) {
  const result = await tool.execute(
    `writer-compare-${input.writerModel}-${Date.now()}`,
    input,
    undefined,
    undefined,
    { cwd: projectRoot, ui: { notify() {} } },
  );
  if (result?.isError && !result?.details) {
    throw new Error(`novel_generate_chapter failed for ${input.writerModel}`);
  }
  return result.details;
}

async function verifyGeminiConnectivity(modelGenerate) {
  const output = await modelGenerate({
    route: "v2_rawstage2_gemini31",
    kind: "connectivity_check",
    systemPrompt: "Return only the exact ASCII token GEMINI_OK.",
    userPrompt: "Connectivity check. Return GEMINI_OK and nothing else.",
    timeoutMs: 120000,
  });
  if (output.provider !== "gemini31" || output.model !== "gemini-3.1-pro-preview") {
    throw new Error(`Gemini connectivity route mismatch: provider=${output.provider ?? "missing"}, model=${output.model}`);
  }
  return {
    ok: output.text.trim().length > 0,
    markerIncluded: output.text.includes("GEMINI_OK"),
    route: output.route,
    provider: output.provider,
    model: output.model,
    durationMs: output.durationMs,
    characterCount: output.text.length,
    responseHash: createHashText(output.text),
  };
}

function createHashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function buildSceneSolution(scene) {
  return {
    id: `${scene.id}-solution`,
    mode: scene.id === "relationship-cost" ? "relationship_cost" : "active_probe",
    surfaceGoal: scene.outline,
    trueDanger: scene.cost,
    knownFacts: [...scene.immutableFacts],
    unknowns: [scene.thematicQuestions[0]],
    activeTestAction: `主角先用可观察的行动验证：${scene.choice}`,
    alternatives: ["延后决定并继续收集证据", "让同伴承担决定"],
    choice: scene.choice,
    cost: scene.cost,
    newRuleOrInformation: scene.endingPressure,
    irreversibleChange: scene.irreversibleChange,
    stateKind: scene.id === "relationship-cost" ? "relationship" : "knowledge",
    endingPressure: scene.endingPressure,
    causalSource: scene.choice,
    nextChoice: scene.endingPressure,
    templateAvoidance: ["不用巧合解除代价", "不用作者总结代替场景后果"],
    sourceFactIds: [],
    openPromiseIds: [],
  };
}

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
