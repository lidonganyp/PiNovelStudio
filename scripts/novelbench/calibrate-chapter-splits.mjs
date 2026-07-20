#!/usr/bin/env node
/**
 * NB-1R 章节切分校准 CLI
 *
 * 从 manifest 中分层抽取 ≥30 本 canonical 书，对每本做独立 ground-truth 扫描 +
 * splitChaptersStrict 对比，输出校准标注（不含正文）+ 错误分布统计。
 *
 * 用法：
 *   node scripts/novelbench/calibrate-chapter-splits.mjs [--manifest FILE] [--count 30] [--corpus-root DIR]
 *
 * 默认：
 *   --manifest    data/novelbench/corpus-manifest.jsonl
 *   --count       30
 *   --corpus-root $NOVELBENCH_CORPUS_ROOT || D:\Download\delete
 *
 * 产物：
 *   data/novelbench/calibration/chapter-boundaries.json  全部书的边界标注
 *   data/novelbench/reports/calibration-stats.md         错误分布 + precision 统计
 *
 * 规则：
 * - 永不改写/移动原始文件
 * - 标注文件不含正文，仅 offset + heading 文本 + 标签
 * - 分层抽样覆盖类型 + 编码 + 章节数多样性
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(__filename, "..", "..", "..");
const EXTENSION_ROOT = join(PROJECT_ROOT, ".pi", "extensions", "novel-studio");
const DIST_EVAL_ROOT = join(EXTENSION_ROOT, "dist-eval");

const { values } = parseArgs({
  options: {
    manifest: { type: "string" },
    count: { type: "string", default: "30" },
    "corpus-root": { type: "string" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`NB-1R 章节切分校准 CLI

用法：
  node scripts/novelbench/calibrate-chapter-splits.mjs [options]

选项：
  --manifest <FILE>      manifest 路径（默认 data/novelbench/corpus-manifest.jsonl）
  --count <NUM>          抽样书数下限（默认 30）
  --corpus-root <DIR>    语料根目录（默认 $NOVELBENCH_CORPUS_ROOT || D:\\Download\\delete）
  --help                 显示帮助
`);
  process.exit(0);
}

const manifestPath = resolve(
  PROJECT_ROOT,
  values.manifest || "data/novelbench/corpus-manifest.jsonl",
);
const targetCount = parseInt(values.count || "30", 10);
const corpusRoot =
  values["corpus-root"] ||
  process.env.NOVELBENCH_CORPUS_ROOT ||
  "D:\\Download\\delete";

const novelbenchUrl = new URL(
  `file://${join(DIST_EVAL_ROOT, "novelbench", "index.js").replace(/\\/g, "/")}`,
).href;
const {
  calibrateChapterSplitting,
  aggregateCalibrationStats,
} = await import(novelbenchUrl);
const { decodeNovelSourceBuffer } = await import(
  new URL(
    `file://${join(DIST_EVAL_ROOT, "eval", "replay-case-extractor.js").replace(/\\/g, "/")}`,
  ).href
);

if (!existsSync(manifestPath)) {
  process.stderr.write(`错误：manifest 不存在：${manifestPath}\n请先运行 audit-corpora.mjs\n`);
  process.exit(1);
}

// 读 manifest
const manifestLines = readFileSync(manifestPath, "utf-8")
  .split("\n")
  .filter((l) => l.trim());
const allEntries = manifestLines.map((l) => JSON.parse(l));
const canonicalEntries = allEntries.filter((e) => e.status === "canonical");

process.stderr.write(
  `[NB-1R] manifest: ${canonicalEntries.length} canonical 书，目标抽样 ${targetCount}\n`,
);

// 分层抽样
const selected = stratifiedSample(canonicalEntries, targetCount);
process.stderr.write(`[NB-1R] 实际抽样 ${selected.length} 本\n`);

// 校准每本书
const results = [];
for (let i = 0; i < selected.length; i++) {
  const entry = selected[i];
  const sourcePath = resolve(corpusRoot, entry.sourcePath);
  if (!existsSync(sourcePath)) {
    process.stderr.write(`[NB-1R] 跳过（源文件缺失）：${entry.sourcePath}\n`);
    continue;
  }
  if ((i + 1) % 10 === 0 || i === 0) {
    process.stderr.write(`[NB-1R] 校准进度 ${i + 1}/${selected.length}\n`);
  }

  const buffer = readFileSync(sourcePath);
  const decoded = decodeNovelSourceBuffer(new Uint8Array(buffer));
  const result = calibrateChapterSplitting({
    bookId: entry.bookId,
    title: entry.title,
    genre: entry.genre,
    decodedText: decoded.text,
  });
  results.push(result);

  if (result.verdict !== "high_confidence") {
    process.stderr.write(
      `[NB-1R] ${result.verdict}: ${entry.title} (precision=${result.precision.toFixed(3)}, gt=${result.groundTruthCount}, splitter=${result.splitterCount})\n`,
    );
  }
}

// 聚合统计
const stats = aggregateCalibrationStats(results);

// 写校准标注 JSON（不含正文）
const calibrationDir = resolve(
  PROJECT_ROOT,
  "data/novelbench/calibration",
);
mkdirSync(calibrationDir, { recursive: true });
const calibrationPath = join(calibrationDir, "chapter-boundaries.json");
const calibrationOutput = {
  meta: {
    annotator: "nb-1r-programmatic-v1",
    method: "independent-line-based-ground-truth + splitChaptersStrict comparison",
    highConfidenceThreshold: 0.98,
    corpusRoot,
    totalBooks: results.length,
  },
  stats,
  books: results,
};
writeFileSync(calibrationPath, JSON.stringify(calibrationOutput, null, 2) + "\n", "utf-8");
process.stderr.write(`[NB-1R] 校准标注已写：${calibrationPath}\n`);

// 写统计报告
const reportDir = resolve(PROJECT_ROOT, "data/novelbench/reports");
mkdirSync(reportDir, { recursive: true });
const reportPath = join(reportDir, "calibration-stats.md");
writeFileSync(reportPath, formatStatsMarkdown(stats, results), "utf-8");
process.stderr.write(`[NB-1R] 统计报告已写：${reportPath}\n`);

process.stdout.write(formatStatsMarkdown(stats, results));

// ─────────────────────────────────────────────────────────────────────────────
// 分层抽样：覆盖类型 + 编码 + 章节数多样性
// ─────────────────────────────────────────────────────────────────────────────

function stratifiedSample(entries, target) {
  // 按类型分组
  const byGenre = new Map();
  for (const e of entries) {
    if (!byGenre.has(e.genre)) byGenre.set(e.genre, []);
    byGenre.get(e.genre).push(e);
  }

  // 每个类型按 chapterCount 排序，取首/中/末（覆盖少/中/多章节）
  const selected = [];
  const seen = new Set();

  // 第一轮：每类型取最多 3 本（首/中/末），优先覆盖所有类型
  for (const [genre, books] of byGenre) {
    const sorted = [...books].sort(
      (a, b) => (a.chapterCount ?? 0) - (b.chapterCount ?? 0),
    );
    const picks = pickFirstMidLast(sorted, 3);
    for (const p of picks) {
      if (!seen.has(p.bookId)) {
        selected.push(p);
        seen.add(p.bookId);
      }
    }
  }

  // 第二轮：补充编码多样性（优先选 gb18030 / utf-16be）
  const rareEncoding = entries.filter(
    (e) => e.encoding !== "utf-8" && !seen.has(e.bookId),
  );
  for (const e of rareEncoding.slice(0, 5)) {
    if (selected.length >= target) break;
    selected.push(e);
    seen.add(e.bookId);
  }

  // 第三轮：补充到目标数量（从剩余 canonical 中按 chapterCount 多样性补）
  if (selected.length < target) {
    const remaining = entries.filter((e) => !seen.has(e.bookId));
    remaining.sort((a, b) => (a.chapterCount ?? 0) - (b.chapterCount ?? 0));
    // 均匀采样
    const step = Math.max(1, Math.floor(remaining.length / (target - selected.length)));
    for (let i = 0; i < remaining.length && selected.length < target; i += step) {
      selected.push(remaining[i]);
      seen.add(remaining[i].bookId);
    }
  }

  return selected;
}

function pickFirstMidLast(arr, n) {
  if (arr.length <= n) return arr;
  const result = [];
  result.push(arr[0]); // 首（最少章节）
  if (n >= 3) result.push(arr[Math.floor(arr.length / 2)]); // 中
  result.push(arr[arr.length - 1]); // 末（最多章节）
  return result.slice(0, n);
}

// ─────────────────────────────────────────────────────────────────────────────
// 统计报告格式化
// ─────────────────────────────────────────────────────────────────────────────

function formatStatsMarkdown(stats, results) {
  const lines = [];
  lines.push("# NovelBench 章节切分校准统计（NB-1R）");
  lines.push("");
  lines.push(`- 审核方法：独立 line-based ground-truth 扫描 + splitChaptersStrict 对比`);
  lines.push(`- 审核批次：nb-1r-programmatic-v1`);
  lines.push(`- 高置信阈值：precision ≥ 0.98`);
  lines.push("");
  lines.push("## 总览");
  lines.push("");
  lines.push("| 指标 | 数量 |");
  lines.push("|------|------|");
  lines.push(`| 校准书数 | ${stats.totalBooks} |`);
  lines.push(`| high_confidence | ${stats.highConfidence} |`);
  lines.push(`| low_confidence | ${stats.lowConfidence} |`);
  lines.push(`| rejected | ${stats.rejected} |`);
  lines.push(`| ground-truth 总章节 | ${stats.totalGroundTruth} |`);
  lines.push(`| splitter 总章节 | ${stats.totalSplitter} |`);
  lines.push(`| TP（正确识别） | ${stats.totalTP} |`);
  lines.push(`| FP（误识别） | ${stats.totalFP} |`);
  lines.push(`| FN（漏识别） | ${stats.totalFN} |`);
  lines.push(`| 整体 precision | ${(stats.overallPrecision * 100).toFixed(2)}% |`);
  lines.push(`| 整体 recall | ${(stats.overallRecall * 100).toFixed(2)}% |`);
  lines.push("");

  lines.push("## 错误分布");
  lines.push("");
  lines.push("| 错误类别 | 数量 |");
  lines.push("|------|------|");
  const sortedErrors = Object.entries(stats.errorDistribution).sort(
    (a, b) => b[1] - a[1],
  );
  if (sortedErrors.length === 0) {
    lines.push("| （无错误） | 0 |");
  } else {
    for (const [cat, count] of sortedErrors) {
      lines.push(`| ${cat} | ${count} |`);
    }
  }
  lines.push("");

  // 非 high_confidence 书清单
  const problemBooks = results.filter((r) => r.verdict !== "high_confidence");
  if (problemBooks.length > 0) {
    lines.push("## 非 high_confidence 书清单");
    lines.push("");
    lines.push("| bookId | 标题 | 类型 | verdict | precision | recall | gt | splitter | 拒绝原因 |");
    lines.push("|--------|------|------|---------|-----------|--------|----|----------|----------|");
    for (const r of problemBooks) {
      lines.push(
        `| ${r.bookId} | ${r.title.replace(/\|/g, "\\|")} | ${r.genre} | ${r.verdict} | ${(r.precision * 100).toFixed(1)}% | ${(r.recall * 100).toFixed(1)}% | ${r.groundTruthCount} | ${r.splitterCount} | ${r.rejectionReason ?? "—"} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
