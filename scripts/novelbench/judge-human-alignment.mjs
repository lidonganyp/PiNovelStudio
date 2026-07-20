#!/usr/bin/env node
/**
 * JUDGE-HUMAN-ALIGNMENT-1 CLI（任务卡 §5，P0）
 *
 * 用法：
 *   node judge-human-alignment.mjs --calibration-set <path> [--output <path>] [--stub]
 *   node judge-human-alignment.mjs --help
 *
 * 模式：
 *   --stub          离线 stub 模式，不调用真实 API（用 makeStubVerdict 生成 verdict）
 *   不加 --stub     真实模式，需要 NOVELOS_JUDGE_API_KEY / NOVELOS_JUDGE_BASE_URL / NOVELOS_JUDGE_MODEL env
 *
 * 参数：
 *   --calibration-set <path>   校准集 JSON 文件路径（必需）
 *   --output <path>             结果输出 JSON 文件路径（可选，不指定则输出到 stdout）
 *   --stub                      离线 stub 模式
 *   --help                      显示帮助
 */

import { parseArgs } from "node:util";
import { writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..", "..", ".pi", "extensions", "novel-studio");
const DIST_EVAL_ROOT = join(EXTENSION_ROOT, "dist-eval");

const moduleUrl = pathToFileURL(
  join(DIST_EVAL_ROOT, "novelos", "eval", "judge-human-alignment.js"),
).href;

const {
  runHumanAlignmentCalibration,
  runHumanAlignmentCalibrationStub,
  loadHumanAlignmentSet,
  formatHumanAlignmentResultAsMarkdown,
} = await import(moduleUrl);

const judgeAdapterUrl = pathToFileURL(
  join(DIST_EVAL_ROOT, "novelos", "eval", "judge-model-adapter.js"),
).href;
const { loadJudgeModelConfigFromEnv } = await import(judgeAdapterUrl);

function printHelp() {
  console.log(`
JUDGE-HUMAN-ALIGNMENT-1：judge 与用户选择一致性校准

用法：
  node judge-human-alignment.mjs --calibration-set <path> [options]

参数：
  --calibration-set <path>   校准集 JSON 文件路径（必需）
  --output <path>             结果输出 JSON 文件路径（可选，不指定则只输出 markdown 报告）
  --stub                      离线 stub 模式，不调用真实 API
  --help                      显示本帮助

模式说明：
  --stub      用 makeStubVerdict 生成 verdict，始终选 left 为 winner。
              适合 CI 验证、离线流程测试，不消耗 API 配额。
  不加 --stub  使用真实 judge 模型（gpt-5.6-sol），需要以下 env：
              NOVELOS_JUDGE_API_KEY、NOVELOS_JUDGE_BASE_URL、NOVELOS_JUDGE_MODEL

校准集格式：
  {
    "calibrationSet": [
      {
        "fixtureId": "F1-xxx",
        "pair": "L_vs_R",
        "sampleSource": "system_vs_user" | "accepted_vs_rejected" | "raw_vs_negative" | "reference_vs_weakened",
        "humanWinner": "left" | "right" | "tie",
        "humanConfidence": "clear" | "slight" | "uncertain",
        "leftText": "...",
        "rightText": "...",
        "context": { "workGoal": "...", "chapterIntent": "...", "priorFacts": [...] },
        "isBiasTest": false,
        "biasType": "explanation_over_emotion" | "short_sentence_as_literary" | "plot_similarity_over_text",
        "expectedBiasDirection": "left" | "right"
      }
    ]
  }

准入门槛（任务卡 §5）：
  - userChoiceAgreement ≥ 0.70
  - reverseConsistency ≥ 0.70
  - 不存在系统性反向偏差
  - 未达门槛前 Best-of-N 只能作为离线实验
`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      "calibration-set": { type: "string" },
      output: { type: "string" },
      stub: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  if (!values["calibration-set"]) {
    console.error("错误：缺少 --calibration-set 参数");
    console.error("使用 --help 查看用法");
    process.exit(2);
  }

  const calPath = values["calibration-set"];
  if (!existsSync(calPath)) {
    console.error(`错误：校准集文件不存在：${calPath}`);
    process.exit(2);
  }

  const calSet = await loadHumanAlignmentSet(calPath);

  let result;
  if (values.stub) {
    console.error(`[stub] 运行 ${calSet.calibrationSet.length} 个校准样本（离线模式）`);
    result = await runHumanAlignmentCalibrationStub(calSet.calibrationSet);
  } else {
    console.error(`[real] 运行 ${calSet.calibrationSet.length} 个校准样本（真实 API）`);
    const config = loadJudgeModelConfigFromEnv();
    result = await runHumanAlignmentCalibration(config, calSet.calibrationSet);
  }

  // 输出 markdown 报告到 stderr
  const md = formatHumanAlignmentResultAsMarkdown(result);
  console.error(md);

  // 输出 JSON 结果到指定文件或 stdout
  if (values.output) {
    writeFileSync(values.output, JSON.stringify(result, null, 2), "utf-8");
    console.error(`\n结果已写入：${values.output}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }

  // 退出码：passed=0, failed=1
  process.exit(result.passed ? 0 : 1);
}

main().catch((e) => {
  console.error(`致命错误：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
