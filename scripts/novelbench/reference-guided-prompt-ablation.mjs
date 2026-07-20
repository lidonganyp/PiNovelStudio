#!/usr/bin/env node
/**
 * REFERENCE-GUIDED-PROMPT-ABLATION-1 CLI：reference 引导的 prompt 消融实验
 *
 * 任务卡 §6 REFERENCE-GUIDED-PROMPT-ABLATION-1。
 *
 * 双轨比较：
 * - 轨道 A：续写实现能力（前 1-3 章 → 模型续写 → 与真实下一章 reference-aware 评价）
 * - 轨道 B：注入词增益（同一 prefix → A1/A3/A4 三臂 prompt → 匿名比较）
 *
 * 模式：
 * - --stub：离线 stub 模式（不调用真实 API），用于 CI 与框架验证
 * - 默认（无 --stub）：真实模式（REQUIRES_AUTH，需提供 raw model + judge model env +
 *   reference source path + reference-registry）
 *
 * 用法：
 *   node scripts/novelbench/reference-guided-prompt-ablation.mjs \\
 *     --case-set <path.json> \\
 *     --reference-source <path.txt> \\
 *     --tracks A,B \\
 *     --samples-per-case 2 \\
 *     --output <output.json> \\
 *     [--stub] \\
 *     [--track-b-arms "A1,A3,A4"] \\
 *     [--judge-pairs "A1,A4;A3,A4"] \\
 *     [--help]
 *
 * 必填参数：
 *   --case-set <path.json>             reference-guided case set JSON 文件路径
 *
 * 可选参数：
 *   --reference-source <path.txt>      reference 源文件路径（仅 evaluator 使用）
 *                                      --stub 模式下若未提供则用 inline stub reference
 *   --tracks <"A,B">                   要运行的轨道（默认 "A,B"）
 *   --samples-per-case <N>             每个 case 每个实验臂的独立采样数（默认 2）
 *   --output <path.json>               结果输出 JSON 文件路径（不传则输出到 stdout）
 *   --stub                             使用 stub 模式（不调用真实 API）
 *   --track-b-arms <"A1,A3,A4">        Track B 实验臂（默认 A1,A3,A4）
 *   --judge-pairs <"A1,A4;A3,A4">      Track B 自定义 judge pair 列表
 *   --help                             显示本帮助
 *
 * 授权边界：
 * - --stub 模式完全离线，不调用任何 API
 * - 默认模式属于 REQUIRES_AUTH（任务卡 §10），需提供：
 *   - raw model env：REF_ABLATION_RAW_API_KEY / REF_ABLATION_RAW_BASE_URL / REF_ABLATION_RAW_MODEL
 *   - judge model env：NOVELOS_JUDGE_API_KEY / NOVELOS_JUDGE_BASE_URL / NOVELOS_JUDGE_MODEL
 *   - reference source path（--reference-source）：外部样板文件路径
 *
 * 架构边界：
 * - reference 正文只通过 resolveReference 回调传入 evaluator 路径
 * - generator prompt 通过 enforceGeneratorIsolation 守护
 * - 不直接 import reference-registry（避免 generator 路径访问 reference asset）
 */

import { parseArgs } from "node:util";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(__filename, "..", "..", "..");
const EXT_ROOT = join(PROJECT_ROOT, ".pi", "extensions", "novel-studio");
const MODULE_PATH = join(
  EXT_ROOT,
  "dist-eval",
  "novelos",
  "eval",
  "reference-guided-prompt-ablation.js",
);

const { values } = parseArgs({
  options: {
    "case-set": { type: "string" },
    "reference-source": { type: "string" },
    "tracks": { type: "string", default: "A,B" },
    "samples-per-case": { type: "string", default: "2" },
    "output": { type: "string" },
    "stub": { type: "boolean", default: false },
    "track-b-arms": { type: "string", default: "A1,A3,A4" },
    "judge-pairs": { type: "string" },
    "help": { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`REFERENCE-GUIDED-PROMPT-ABLATION-1 CLI：reference 引导的 prompt 消融实验

双轨比较：
  轨道 A：续写实现能力（前 1-3 章 → 模型续写 → 与真实下一章 reference-aware 评价）
  轨道 B：注入词增益（同一 prefix → A1/A3/A4 三臂 prompt → 匿名比较）

用法：
  node scripts/novelbench/reference-guided-prompt-ablation.mjs \\
    --case-set <path.json> \\
    --reference-source <path.txt> \\
    --tracks A,B \\
    --samples-per-case 2 \\
    --output <output.json> \\
    [--stub] \\
    [--track-b-arms "A1,A3,A4"] \\
    [--judge-pairs "A1,A4;A3,A4"] \\
    [--help]

必填参数：
  --case-set <path.json>             reference-guided case set JSON 文件路径

可选参数：
  --reference-source <path.txt>      reference 源文件路径（仅 evaluator 使用）
                                      --stub 模式下若未提供则用 inline stub reference
  --tracks <"A,B">                   要运行的轨道（默认 "A,B"）
  --samples-per-case <N>             每个 case 每个实验臂的独立采样数（默认 2）
  --output <path.json>               结果输出 JSON 文件路径（不传则输出到 stdout）
  --stub                             使用 stub 模式（不调用真实 API）
  --track-b-arms <"A1,A3,A4">        Track B 实验臂（默认 A1,A3,A4）
  --judge-pairs <"A1,A4;A3,A4">      Track B 自定义 judge pair 列表
  --help                             显示本帮助

模式说明：
  --stub     离线 stub 模式，不调用任何 API（用于 CI 与框架验证）
  默认       真实模式（REQUIRES_AUTH），需提供 raw model + judge model env：
             - REF_ABLATION_RAW_API_KEY / REF_ABLATION_RAW_BASE_URL / REF_ABLATION_RAW_MODEL
             - NOVELOS_JUDGE_API_KEY / NOVELOS_JUDGE_BASE_URL / NOVELOS_JUDGE_MODEL
             - --reference-source <path.txt>（外部样板文件路径）

架构边界：
  - reference 正文只通过 resolveReference 回调传入 evaluator 路径
  - generator prompt 通过 enforceGeneratorIsolation 守护
  - 不直接 import reference-registry（避免 generator 路径访问 reference asset）

退出码：
  0  实验完成
  1  实验运行失败（参数错误 / API 错误等）
`);
  process.exit(0);
}

if (!values["case-set"]) {
  process.stderr.write("错误：缺少必填参数 --case-set\n");
  process.exit(1);
}

const caseSetPath = resolve(values["case-set"]);
const referenceSourcePath = values["reference-source"]
  ? resolve(values["reference-source"])
  : null;
const tracks = values.tracks.split(",").map((s) => s.trim()).filter(Boolean);
const samplesPerCase = parseInt(values["samples-per-case"] ?? "2", 10);
const outputPath = values.output ? resolve(values.output) : null;
const isStub = values.stub;
const trackBArms = values["track-b-arms"]
  ? values["track-b-arms"].split(",").map((s) => s.trim()).filter(Boolean)
  : ["A1", "A3", "A4"];

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

const caseSet = await mod.loadReferenceGuidedCaseSet(caseSetPath);

process.stderr.write(
  `[REFERENCE-GUIDED-PROMPT-ABLATION-1] 加载 case set：${caseSet.cases.length} cases\n`,
);
process.stderr.write(
  `[REFERENCE-GUIDED-PROMPT-ABLATION-1] tracks：${tracks.join(", ")}\n`,
);
process.stderr.write(
  `[REFERENCE-GUIDED-PROMPT-ABLATION-1] samplesPerCase：${samplesPerCase}\n`,
);
process.stderr.write(
  `[REFERENCE-GUIDED-PROMPT-ABLATION-1] 模式：${isStub ? "stub（离线）" : "real（REQUIRES_AUTH）"}\n`,
);

// ── 构造 resolveReference 回调 ────────────────────────────────────────────
//
// reference 正文只通过这个回调进入 evaluator 路径。
// 真实模式下需要 reference source 文件路径（外部样板）。
// stub 模式下若无 reference source，返回 inline stub reference 正文。

function makeInlineStubReference(referenceId) {
  return `第3章 规则初现\n\n主角走进昏暗的走廊，脚下的木板发出吱呀的声响。\n` +
    `走廊尽头有一扇虚掩的门，门缝里透出微弱的光。\n` +
    `他翻开笔记，上面只有一行字："看见它的人，必须在三秒内闭眼。"\n` +
    `身后传来叹息，冰冷的气息掠过他的后颈。`;
}

function makeResolveReference(caseSet, referenceSourcePath, isStub) {
  // 真实模式：从 reference source 文件读取，按 caseSet 中的 referenceId 切片
  // 简化：CLI 不维护 ReferenceRegistry，直接读整个 source 文件并按 hash 切片
  // 真实生产实现应在 dataset-builder 阶段注册 ReferenceRecord，这里只做简化读取

  if (isStub && !referenceSourcePath) {
    return (referenceId) => makeInlineStubReference(referenceId);
  }

  if (!referenceSourcePath) {
    process.stderr.write(
      "错误：非 stub 模式需要 --reference-source <path.txt>\n",
    );
    process.exit(1);
  }

  if (!existsSync(referenceSourcePath)) {
    process.stderr.write(
      `错误：reference source 文件不存在：${referenceSourcePath}\n`,
    );
    process.exit(1);
  }

  // 简化：读整个文件作为 reference（真实实现应按 referenceId 切片）
  // 这里使用 referenceId 的 hash 决定从哪个 offset 切片（伪切片，仅 CLI demo）
  const sourceBuffer = readFileSync(referenceSourcePath);
  // 尝试 UTF-8 解码（生产应使用 decodeNovelSourceBuffer）
  let sourceText;
  try {
    sourceText = sourceBuffer.toString("utf-8");
  } catch {
    sourceText = sourceBuffer.toString("latin1");
  }

  return (referenceId) => {
    // 简化：按 referenceId 的 hash 决定切片起点
    const hash = createHash("sha256").update(referenceId).digest("hex");
    const offset = parseInt(hash.slice(0, 8), 16) % Math.max(1, sourceText.length - 5000);
    const length = 3000; // 每章 ~3000 字
    return sourceText.slice(offset, offset + length).trim();
  };
}

const resolveReference = makeResolveReference(caseSet, referenceSourcePath, isStub);

let result;

if (isStub) {
  result = await mod.runReferenceGuidedAblationStub({
    caseSet,
    tracks,
    resolveReference,
    samplesPerCase,
    trackBArms,
    judgePairs,
  });
} else {
  // 真实模式：从 env 加载配置
  const rawApiKey = process.env.REF_ABLATION_RAW_API_KEY;
  const rawBaseUrl = process.env.REF_ABLATION_RAW_BASE_URL;
  const rawModel = process.env.REF_ABLATION_RAW_MODEL;
  if (!rawApiKey || !rawBaseUrl || !rawModel) {
    process.stderr.write(
      "错误：真实模式需要 REF_ABLATION_RAW_API_KEY / REF_ABLATION_RAW_BASE_URL / REF_ABLATION_RAW_MODEL\n",
    );
    process.exit(1);
  }

  const { loadJudgeModelConfigFromEnv, runReferenceGuidedAblationReal } = mod;
  const judgeConfig = loadJudgeModelConfigFromEnv();
  result = await runReferenceGuidedAblationReal({
    caseSet,
    tracks,
    resolveReference,
    samplesPerCase,
    trackBArms,
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
const md = mod.formatReferenceGuidedResultAsMarkdown(result);
process.stderr.write("\n" + md + "\n");

// 输出 JSON 结果到 stdout 或文件
const jsonStr = JSON.stringify(result, null, 2);
if (outputPath) {
  writeFileSync(outputPath, jsonStr, "utf-8");
  process.stderr.write(
    `[REFERENCE-GUIDED-PROMPT-ABLATION-1] 结果已写入：${outputPath}\n`,
  );
} else {
  process.stdout.write(jsonStr + "\n");
}

process.exit(0);
