#!/usr/bin/env node
/**
 * NB-1 可靠章节切分 CLI
 *
 * 读取 NB-0 manifest，对每本 canonical 书解码原文 → 严格切分 → 写 JSONL（无 body）
 * + 回填 manifest + 写统计报告 + 写抽样摘要。
 *
 * 用法：
 *   node scripts/novelbench/split-chapters.mjs [--manifest FILE] [--out-dir DIR] [--sample-dir DIR] [--min-confidence 0.7]
 *
 * 默认：
 *   --manifest  data/novelbench/corpus-manifest.jsonl
 *   --out-dir   data/novelbench/chapter-splits/
 *   --sample-dir data/novelbench/reports/samples/
 *   --min-confidence 0.7
 *
 * 产物：
 *   <out-dir>/<bookId>.jsonl     每行一个 ChapterSplit JSON（无 body）
 *   <out-dir>/manifest-split.jsonl  回填 chapterCount/splitConfidence 后的 manifest
 *   reports/chapter-split-stats.md  统计报告
 *   <sample-dir>/<bookId>.md     首/中/末章摘要
 *
 * 规则：
 * - 永不改写/移动原始文件
 * - JSONL 不含正文，仅 offset + hash
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
    "out-dir": { type: "string" },
    "sample-dir": { type: "string" },
    "min-confidence": { type: "string", default: "0.7" },
    "corpus-root": { type: "string" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`NB-1 可靠章节切分 CLI

用法：
  node scripts/novelbench/split-chapters.mjs [options]

选项：
  --manifest <FILE>        输入 manifest 路径（默认 data/novelbench/corpus-manifest.jsonl）
  --out-dir <DIR>          切分输出目录（默认 data/novelbench/chapter-splits/）
  --sample-dir <DIR>       抽样摘要目录（默认 data/novelbench/reports/samples/）
  --min-confidence <NUM>   最低置信度阈值（默认 0.7）
  --corpus-root <DIR>      语料根目录（用于解析 sourcePath 为绝对路径）
  --help                   显示帮助
`);
  process.exit(0);
}

const manifestPath = resolve(PROJECT_ROOT, values.manifest || "data/novelbench/corpus-manifest.jsonl");
const outDir = resolve(PROJECT_ROOT, values["out-dir"] || "data/novelbench/chapter-splits/");
const sampleDir = resolve(PROJECT_ROOT, values["sample-dir"] || "data/novelbench/reports/samples/");
const minConfidence = parseFloat(values["min-confidence"] || "0.7");
const corpusRoot = values["corpus-root"] || process.env.NOVELBENCH_CORPUS_ROOT || "D:\\Download\\delete";

const novelbenchUrl = new URL(`file://${join(DIST_EVAL_ROOT, "novelbench", "index.js").replace(/\\/g, "/")}`).href;
const { splitChaptersStrict, sampleChapters } = await import(novelbenchUrl);
const { decodeNovelSourceBuffer } = await import(new URL(`file://${join(DIST_EVAL_ROOT, "eval", "replay-case-extractor.js").replace(/\\/g, "/")}`).href);

if (!existsSync(manifestPath)) {
  process.stderr.write(`错误：manifest 不存在：${manifestPath}\n请先运行 audit-corpora.mjs\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
mkdirSync(sampleDir, { recursive: true });

// 读 manifest
const manifestLines = readFileSync(manifestPath, "utf-8").split("\n").filter((l) => l.trim());
const entries = manifestLines.map((l) => JSON.parse(l));
const canonicalEntries = entries.filter((e) => e.status === "canonical");

process.stderr.write(`[NB-1] 切分 ${canonicalEntries.length} 本 canonical 书（阈值 ${minConfidence}）\n`);

const updatedEntries = [];
const stats = {
  total: canonicalEntries.length,
  split: 0,
  rejected: 0,
  lowConfidence: 0,
  totalChapters: 0,
  byRejectionReason: {},
};

for (const entry of canonicalEntries) {
  const sourcePath = resolve(corpusRoot, entry.sourcePath);
  if (!existsSync(sourcePath)) {
    process.stderr.write(`[NB-1] 跳过（源文件缺失）：${entry.sourcePath}\n`);
    updatedEntries.push(entry);
    continue;
  }

  const buffer = readFileSync(sourcePath);
  const decoded = decodeNovelSourceBuffer(new Uint8Array(buffer));
  const result = splitChaptersStrict(decoded.text);

  if (result.rejectionReason) {
    stats.rejected++;
    stats.byRejectionReason[result.rejectionReason] =
      (stats.byRejectionReason[result.rejectionReason] ?? 0) + 1;
    process.stderr.write(`[NB-1] 拒绝 ${entry.title}：${result.rejectionReason}\n`);
    updatedEntries.push({
      ...entry,
      chapterCount: 0,
      splitConfidence: 0,
      splitRejectionReason: result.rejectionReason,
    });
    continue;
  }

  if (result.splitConfidence < minConfidence) {
    stats.lowConfidence++;
    process.stderr.write(`[NB-1] 低置信 ${entry.title}：${result.splitConfidence.toFixed(2)} < ${minConfidence}\n`);
  }

  stats.split++;
  stats.totalChapters += result.chapters.length;

  // 写 JSONL（无 body）
  const splitPath = join(outDir, `${entry.bookId}.jsonl`);
  const splitContent = result.chapters.map((c) => JSON.stringify(c)).join("\n") + "\n";
  writeFileSync(splitPath, splitContent, "utf-8");

  // 写抽样摘要
  const samples = sampleChapters(decoded.text, result.chapters, 3);
  const samplePath = join(sampleDir, `${entry.bookId}.md`);
  const sampleContent = formatSampleMarkdown(entry, result, samples);
  writeFileSync(samplePath, sampleContent, "utf-8");

  updatedEntries.push({
    ...entry,
    chapterCount: result.chapters.length,
    averageChapterLength: result.chapters.length > 0
      ? Math.round(result.chapters.reduce((s, c) => s + c.characterCount, 0) / result.chapters.length)
      : undefined,
    splitConfidence: result.splitConfidence,
  });
}

// 写回填 manifest
const manifestOutPath = join(outDir, "manifest-split.jsonl");
writeFileSync(
  manifestOutPath,
  updatedEntries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  "utf-8",
);

// 写统计报告
const reportPath = join(dirname(outDir), "reports", "chapter-split-stats.md");
mkdirSync(dirname(reportPath), { recursive: true });
const report = formatStatsMarkdown(stats, minConfidence);
writeFileSync(reportPath, report, "utf-8");

process.stderr.write(`[NB-1] 完成：${stats.split} 切分 / ${stats.rejected} 拒绝 / ${stats.lowConfidence} 低置信 / ${stats.totalChapters} 章\n`);
process.stdout.write(report);

// ─────────────────────────────────────────────────────────────────────────────

function formatSampleMarkdown(entry, result, samples) {
  const lines = [];
  lines.push(`# ${entry.title} — 章节切分抽样`);
  lines.push("");
  lines.push(`- bookId: \`${entry.bookId}\``);
  lines.push(`- 章节数: ${result.chapters.length}`);
  lines.push(`- 置信度: ${result.splitConfidence.toFixed(3)}`);
  if (result.issues.length > 0) {
    lines.push(`- 问题: ${result.issues.length} 条`);
  }
  lines.push("");
  lines.push("## 抽样摘要（首/中/末）");
  lines.push("");
  for (const s of samples) {
    lines.push(`### 第${s.chapterNumber}章 ${s.heading}`);
    lines.push("```");
    lines.push(s.excerpt);
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

function formatStatsMarkdown(stats, minConfidence) {
  const lines = [];
  lines.push("# NovelBench 章节切分统计");
  lines.push("");
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push(`最低置信度阈值：${minConfidence}`);
  lines.push("");
  lines.push("## 总览");
  lines.push("");
  lines.push("| 指标 | 数量 |");
  lines.push("|------|------|");
  lines.push(`| canonical 书数 | ${stats.total} |`);
  lines.push(`| 成功切分 | ${stats.split} |`);
  lines.push(`| 拒绝 | ${stats.rejected} |`);
  lines.push(`| 低置信 | ${stats.lowConfidence} |`);
  lines.push(`| 总章节数 | ${stats.totalChapters} |`);
  lines.push("");

  if (Object.keys(stats.byRejectionReason).length > 0) {
    lines.push("## 拒绝原因分布");
    lines.push("");
    lines.push("| 原因 | 数量 |");
    lines.push("|------|------|");
    for (const [reason, count] of Object.entries(stats.byRejectionReason)) {
      lines.push(`| ${reason} | ${count} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
