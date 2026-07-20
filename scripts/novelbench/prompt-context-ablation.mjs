#!/usr/bin/env node
/**
 * PROMPT-CONTEXT-ABLATION-1 CLI：上下文块消融实验
 *
 * 任务卡 §6 PROMPT-CONTEXT-ABLATION-1。
 *
 * 模式：
 * - --stub：离线 stub 模式（不调用真实 API），用于 CI 与框架验证
 * - 默认（无 --stub）：真实模式（REQUIRES_AUTH，需提供 raw model + judge model env）
 *
 * 用法：
 *   node scripts/novelbench/prompt-context-ablation.mjs \
 *     --case-set <path.json> \
 *     --samples-per-case 2 \
 *     --output <output.json> \
 *     [--stub] \
 *     [--judge-pairs "A0,A4;A1,A4;A2,A4;A3,A4"] \
 *     [--help]
 *
 * 必填参数：
 *   --case-set <path.json>         ablation case set JSON 文件路径
 *
 * 可选参数：
 *   --samples-per-case <N>         每个 case 每个实验臂的独立采样数（默认 2）
 *   --output <path.json>           结果输出 JSON 文件路径（不传则输出到 stdout）
 *   --stub                         使用 stub 模式（不调用真实 API）
 *   --judge-pairs <"A0,A4;A1,A4">  自定义 judge pair 列表（默认 A0-A3 vs A4）
 *   --help                         显示本帮助
 *
 * 授权边界：
 * - --stub 模式完全离线，不调用任何 API
 * - 默认模式属于 REQUIRES_AUTH（任务卡 §10），需提供：
 *   - raw model env：PROMPT_ABLATION_RAW_API_KEY / PROMPT_ABLATION_RAW_BASE_URL / PROMPT_ABLATION_RAW_MODEL
 *   - judge model env：NOVELOS_JUDGE_API_KEY / NOVELOS_JUDGE_BASE_URL / NOVELOS_JUDGE_MODEL
 */

import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(__filename, "..", "..", "..");
const EXT_ROOT = join(PROJECT_ROOT, ".pi", "extensions", "novel-studio");
const MODULE_PATH = join(EXT_ROOT, "dist-eval", "novelos", "eval", "prompt-context-ablation.js");

const { values } = parseArgs({
  options: {
    "case-set": { type: "string" },
    "samples-per-case": { type: "string", default: "2" },
    "output": { type: "string" },
    "stub": { type: "boolean", default: false },
    "judge-pairs": { type: "string" },
    "help": { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`PROMPT-CONTEXT-ABLATION-1 CLI：上下文块消融实验

用法：
  node scripts/novelbench/prompt-context-ablation.mjs \\
    --case-set <path.json> \\
    --samples-per-case 2 \\
    --output <output.json> \\
    [--stub] \\
    [--judge-pairs "A0,A4;A1,A4;A2,A4;A3,A4"] \\
    [--help]

必填参数：
  --case-set <path.json>         ablation case set JSON 文件路径

可选参数：
  --samples-per-case <N>         每个 case 每个实验臂的独立采样数（默认 2）
  --output <path.json>           结果输出 JSON 文件路径（不传则输出到 stdout）
  --stub                         使用 stub 模式（不调用真实 API）
  --judge-pairs <"A0,A4;A1,A4">  自定义 judge pair 列表（默认 A0-A3 vs A4）
  --help                         显示本帮助

模式说明：
  --stub     离线 stub 模式，不调用任何 API（用于 CI 与框架验证）
  默认       真实模式（REQUIRES_AUTH），需提供 raw model + judge model env：
             - PROMPT_ABLATION_RAW_API_KEY / PROMPT_ABLATION_RAW_BASE_URL / PROMPT_ABLATION_RAW_MODEL
             - NOVELOS_JUDGE_API_KEY / NOVELOS_JUDGE_BASE_URL / NOVELOS_JUDGE_MODEL

退出码：
  0  实验完成（无论 passed 与否）
  1  实验运行失败（参数错误 / API 错误等）
`);
  process.exit(0);
}

if (!values["case-set"]) {
  process.stderr.write("错误：缺少必填参数 --case-set\n");
  process.exit(1);
}

const caseSetPath = resolve(values["case-set"]);
const samplesPerCase = parseInt(values["samples-per-case"] ?? "2", 10);
const outputPath = values.output ? resolve(values.output) : null;
const isStub = values.stub;

// 解析 judge-pairs
let judgePairs;
if (values["judge-pairs"]) {
  judgePairs = values["judge-pairs"].split(";").map((pair) => {
    const [left, right] = pair.split(",").map((s) => s.trim());
    if (!left || !right) {
      throw new Error(`非法 judge-pairs 格式：${pair}（应为 left,right）`);
    }
    return [left, right];
  });
}

// ── 动态 import 模块 ──────────────────────────────────────────────────────

const mod = await import(`file://${MODULE_PATH}`);

const caseSet = await mod.loadAblationCaseSet(caseSetPath);

process.stderr.write(`[PROMPT-CONTEXT-ABLATION-1] 加载 case set：${caseSet.cases.length} cases\n`);
process.stderr.write(`[PROMPT-CONTEXT-ABLATION-1] samplesPerCasePerArm：${samplesPerCase}\n`);
process.stderr.write(`[PROMPT-CONTEXT-ABLATION-1] 模式：${isStub ? "stub（离线）" : "real（REQUIRES_AUTH）"}\n`);

let result;

if (isStub) {
  result = await mod.runPromptContextAblationStub({
    caseSet,
    samplesPerCasePerArm: samplesPerCase,
    judgePairs,
  });
} else {
  // 真实模式：从 env 加载配置
  const rawApiKey = process.env.PROMPT_ABLATION_RAW_API_KEY;
  const rawBaseUrl = process.env.PROMPT_ABLATION_RAW_BASE_URL;
  const rawModel = process.env.PROMPT_ABLATION_RAW_MODEL;
  if (!rawApiKey || !rawBaseUrl || !rawModel) {
    process.stderr.write(
      "错误：真实模式需要 PROMPT_ABLATION_RAW_API_KEY / PROMPT_ABLATION_RAW_BASE_URL / PROMPT_ABLATION_RAW_MODEL\n",
    );
    process.exit(1);
  }

  const { loadJudgeModelConfigFromEnv, runPromptContextAblationReal } = mod;
  const judgeConfig = loadJudgeModelConfigFromEnv();
  result = await runPromptContextAblationReal({
    caseSet,
    samplesPerCasePerArm: samplesPerCase,
    judgePairs,
    controlVariables: {
      modelRoute: "v2_rawstage2",
      provider: "anthropic",
      modelVersion: rawModel,
      maxTokens: 4096,
      timeoutMs: 60_000,
    },
    judgeConfig,
    rawModelConfig: {
      apiKey: rawApiKey,
      baseUrl: rawBaseUrl,
      model: rawModel,
      timeoutMs: 60_000,
    },
  });
}

// 输出 markdown 报告到 stderr
const md = mod.formatPromptContextAblationResultAsMarkdown(result);
process.stderr.write("\n" + md + "\n");

// 输出 JSON 结果到 stdout 或文件
const jsonStr = JSON.stringify(result, null, 2);
if (outputPath) {
  writeFileSync(outputPath, jsonStr, "utf-8");
  process.stderr.write(`[PROMPT-CONTEXT-ABLATION-1] 结果已写入：${outputPath}\n`);
} else {
  process.stdout.write(jsonStr + "\n");
}

process.exit(0);
