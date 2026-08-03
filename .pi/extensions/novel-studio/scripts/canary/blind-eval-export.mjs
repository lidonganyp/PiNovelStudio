/**
 * blind-eval-export — Phase 5B 盲评导出工具
 *
 * 从已有 canary 运行结果导出匿名化的 raw vs final 对照对，供人工盲评。
 *
 * 用法:
 *   node scripts/canary/blind-eval-export.mjs --run-dir reports/chapter-canary/canary-20260728-120000
 *   node scripts/canary/blind-eval-export.mjs --run-dir <...> --output blind-eval-pairs.json
 *
 * 也可用于导入评分结果，生成汇总报告:
 *   node scripts/canary/blind-eval-export.mjs --run-dir <...> --import-scores blind-scores.json --output blind-eval-summary.md
 *
 * 评分文件格式（每对一对象）:
 *   [{
 *     "pairId": "pair-001",
 *     "dimensions": [
 *       { "id": "factual_accuracy", "sampleAScore": 4, "sampleBScore": 5,
 *         "sampleAWinningSpans": ["..."], "sampleBLosingSpans": ["..."] },
 *       ...
 *     ],
 *     "notes": "..."
 *   }, ...]
 *
 * 报告不使用单一文学总分；按 5 维度独立统计 + 每对的胜出/失败 span 聚合。
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

import {
  buildBlindEvalPairs,
  BLIND_EVAL_DIMENSIONS,
} from "./canary-metrics.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// CLI
// ============================================================================

function parseArgs(argv) {
  const args = {
    runDir: null,
    output: null,
    importScores: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;
    const next = argv[i + 1];
    switch (tok) {
      case "--run-dir":
        args.runDir = next;
        i++;
        break;
      case "--output":
        args.output = next;
        i++;
        break;
      case "--import-scores":
        args.importScores = next;
        i++;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(`Phase 5B 盲评导出工具

用法:
  node scripts/canary/blind-eval-export.mjs --run-dir <path> [options]

选项:
  --run-dir <path>          canary 运行目录（包含 results.json）
  --output <path>           输出文件路径（默认: <run-dir>/blind-eval-pairs.json）
  --import-scores <path>    导入评分 JSON，生成汇总 markdown 报告
  --help, -h                显示本帮助

示例:
  # 导出盲评对照对
  node scripts/canary/blind-eval-export.mjs --run-dir reports/chapter-canary/canary-20260728-120000

  # 导入评分后生成汇总
  node scripts/canary/blind-eval-export.mjs --run-dir <...> --import-scores blind-scores.json --output blind-eval-summary.md
`);
}

// ============================================================================
// 主流程
// ============================================================================

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.runDir) {
    printHelp();
    process.exit(args.help ? 0 : 2);
  }

  const runDir = resolve(args.runDir);
  if (!existsSync(runDir)) {
    process.stderr.write(`[BlindEval] 运行目录不存在: ${runDir}\n`);
    process.exit(2);
  }

  const resultsPath = join(runDir, "results.json");
  if (!existsSync(resultsPath)) {
    process.stderr.write(`[BlindEval] results.json 不存在: ${resultsPath}\n`);
    process.exit(2);
  }

  /** @type {import("./canary-metrics.mjs").CanaryChapterResult[]} */
  const results = JSON.parse(readFileSync(resultsPath, "utf8"));
  console.log(`[BlindEval] 加载 ${results.length} 个章节结果`);

  // 导入评分模式
  if (args.importScores) {
    const scoresPath = resolve(args.importScores);
    if (!existsSync(scoresPath)) {
      process.stderr.write(`[BlindEval] 评分文件不存在: ${scoresPath}\n`);
      process.exit(2);
    }
    /** @type {Array<{ pairId: string, dimensions: any[], notes: string }>} */
    const scores = JSON.parse(readFileSync(scoresPath, "utf8"));
    const report = generateScoreSummary(results, scores);
    const outputPath = args.output || join(runDir, "blind-eval-summary.md");
    writeFileSync(outputPath, report, "utf8");
    console.log(`[BlindEval] 汇总报告已写入: ${outputPath}`);
    return;
  }

  // 默认模式：导出盲评对照对
  const pairs = buildBlindEvalPairs(results, { readFileSync });
  const outputPath = args.output || join(runDir, "blind-eval-pairs.json");
  writeFileSync(outputPath, JSON.stringify(pairs, null, 2), "utf8");
  console.log(`[BlindEval] 导出 ${pairs.length} 对盲评样本 → ${outputPath}`);
  console.log(`[BlindEval] 评分维度: ${BLIND_EVAL_DIMENSIONS.map((d) => d.id).join(", ")}`);
  console.log(`[BlindEval] 评分后用 --import-scores 生成汇总报告`);
}

// ============================================================================
// 评分汇总报告
// ============================================================================

/**
 * 生成评分汇总报告（markdown）。
 *
 * 报告章节：
 *   1. 元信息（参评对数 / 维度数）
 *   2. 每维度统计：A 均分 / B 均分 / 差值 / 置信区间（bootstrap）
 *   3. 每对详情：5 维度得分对比
 *   4. 胜出 span 聚合：高频胜出片段 top 20
 *
 * 注意：不输出"哪个样本更好"的结论性判断；只输出维度统计。
 * 文学评价权归用户（AGENTS.md §4）。
 *
 * @param {import("./canary-metrics.mjs").CanaryChapterResult[]} results
 * @param {Array<{ pairId: string, dimensions: any[], notes: string }>} scores
 * @returns {string}
 */
function generateScoreSummary(results, scores) {
  const lines = [];
  lines.push(`# Phase 5B 盲评汇总报告`);
  lines.push("");
  lines.push(`> 参评对数: ${scores.length}`);
  lines.push(`> 评分维度: ${BLIND_EVAL_DIMENSIONS.length}`);
  lines.push(`> 生成时间: ${new Date().toISOString()}`);
  lines.push("");

  // 每维度统计
  lines.push(`## 1. 维度统计`);
  lines.push("");
  lines.push(`| 维度 | 样本 A 均分 | 样本 B 均分 | 差值 (A-B) | 95% CI | A 胜出对数 | B 胜出对数 | 平局 |`);
  lines.push(`|------|------------|------------|-----------|--------|-----------|-----------|------|`);

  for (const dim of BLIND_EVAL_DIMENSIONS) {
    const aScores = [];
    const bScores = [];
    let aWin = 0, bWin = 0, tie = 0;

    for (const s of scores) {
      const d = s.dimensions?.find((x) => x.id === dim.id);
      if (!d) continue;
      if (typeof d.sampleAScore === "number" && typeof d.sampleBScore === "number") {
        aScores.push(d.sampleAScore);
        bScores.push(d.sampleBScore);
        if (d.sampleAScore > d.sampleBScore) aWin++;
        else if (d.sampleBScore > d.sampleAScore) bWin++;
        else tie++;
      }
    }

    if (aScores.length === 0) {
      lines.push(`| ${dim.label} | N/A | N/A | N/A | N/A | 0 | 0 | 0 |`);
      continue;
    }

    const aMean = mean(aScores);
    const bMean = mean(bScores);
    const diff = aMean - bMean;
    const ci = bootstrapCI(aScores, bScores, 1000);
    lines.push(`| ${dim.label} | ${aMean.toFixed(2)} | ${bMean.toFixed(2)} | ${diff.toFixed(2)} | [${ci.lower.toFixed(2)}, ${ci.upper.toFixed(2)}] | ${aWin} | ${bWin} | ${tie} |`);
  }
  lines.push("");

  // 每对详情
  lines.push(`## 2. 每对详情`);
  lines.push("");
  lines.push(`| pairId | 事实 | 连贯 | 人物 | 文笔 | 钩子 | 备注 |`);
  lines.push(`|--------|------|------|------|------|------|------|`);
  for (const s of scores) {
    const cells = BLIND_EVAL_DIMENSIONS.map((dim) => {
      const d = s.dimensions?.find((x) => x.id === dim.id);
      if (!d || typeof d.sampleAScore !== "number" || typeof d.sampleBScore !== "number") return "-";
      return `${d.sampleAScore}/${d.sampleBScore}`;
    });
    const notes = (s.notes ?? "").replace(/\|/g, "\\|").slice(0, 50);
    lines.push(`| ${s.pairId} | ${cells.join(" | ")} | ${notes} |`);
  }
  lines.push("");

  // 胜出 span 聚合
  lines.push(`## 3. 胜出 span 聚合（Top 20）`);
  lines.push("");
  /** @type {Map<string, number>} */
  const spanFreq = new Map();
  for (const s of scores) {
    for (const d of s.dimensions ?? []) {
      for (const span of d.sampleAWinningSpans ?? []) {
        const key = span.slice(0, 60);
        spanFreq.set(key, (spanFreq.get(key) ?? 0) + 1);
      }
      for (const span of d.sampleBWinningSpans ?? []) {
        const key = span.slice(0, 60);
        spanFreq.set(key, (spanFreq.get(key) ?? 0) + 1);
      }
    }
  }
  const sortedSpans = [...spanFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  if (sortedSpans.length === 0) {
    lines.push(`_(无 span 数据)_`);
  } else {
    lines.push(`| span (前 60 字) | 出现次数 |`);
    lines.push(`|----------------|----------|`);
    for (const [span, freq] of sortedSpans) {
      const safe = span.replace(/\|/g, "\\|");
      lines.push(`| ${safe} | ${freq} |`);
    }
  }
  lines.push("");

  lines.push(`---`);
  lines.push(`_不输出"哪个样本更好"的结论性判断；文学评价权归用户（AGENTS.md §4）。_`);
  lines.push(`_报告由 scripts/canary/blind-eval-export.mjs 生成_`);

  return lines.join("\n");
}

// ============================================================================
// 统计辅助
// ============================================================================

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/**
 * Bootstrap 置信区间（差值 A-B 的 95% CI）。
 * 简化实现：1000 次重采样，取 2.5% / 97.5% 分位数。
 */
function bootstrapCI(aScores, bScores, iterations = 1000) {
  if (aScores.length === 0 || bScores.length === 0) {
    return { lower: 0, upper: 0 };
  }
  const n = Math.min(aScores.length, bScores.length);
  const diffs = [];
  for (let i = 0; i < iterations; i++) {
    let sumA = 0, sumB = 0;
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(Math.random() * n);
      sumA += aScores[idx];
      sumB += bScores[idx];
    }
    diffs.push(sumA / n - sumB / n);
  }
  diffs.sort((a, b) => a - b);
  const lower = diffs[Math.floor(iterations * 0.025)];
  const upper = diffs[Math.floor(iterations * 0.975)];
  return { lower, upper };
}

// ============================================================================
// 入口
// ============================================================================

main();
