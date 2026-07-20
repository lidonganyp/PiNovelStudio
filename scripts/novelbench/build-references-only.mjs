#!/usr/bin/env node
/**
 * NB-3R 轻量级 Reference 注册脚本
 *
 * 仅注册 reference + 写最小化 cases JSONL，不写 generation-inputs / generator-bundles。
 * 用于 NB-3R Reference Analyzer 真实校准（≥100 章 GLM/Doubao 提取）。
 *
 * 与 build-datasets.mjs 的区别：
 * - 不读 prior 章正文、不构造 generationInput、不做 leakage audit、不写 .txt bundle
 * - 仅用 chapter-split 元数据（bodyHash + offsets）注册 reference
 * - hash 验证延后到 analyze-references.mjs 的 registry.resolve() 阶段
 * - 速度：286 本 < 10 秒（纯元数据处理，无源文件 I/O）
 *
 * 用法：
 *   node scripts/novelbench/build-references-only.mjs [options]
 *
 * 选项：
 *   --manifest <FILE>     manifest-split 路径（默认 data/novelbench/chapter-splits/manifest-split.jsonl）
 *   --splits-dir <DIR>    chapter-splits 目录（默认 data/novelbench/chapter-splits/）
 *   --out <DIR>           输出目录（默认 data/novelbench/datasets/）
 *   --mode <MODE>         continuation | realization（默认 continuation）
 *   --dataset-version <V> 数据集版本（默认 nb3r-v1）
 *   --corpus-root <DIR>   语料根目录（默认 $NOVELBENCH_CORPUS_ROOT 或 D:\Download\delete）
 *   --help                显示帮助
 *
 * 产物：
 *   <out>/<mode>-cases.jsonl              每行一个 case JSON（最小化，无 priorChapterRefs）
 *   <out>/reference-registry.json         reference 注册表（无正文，可提交）
 *
 * 规则：
 * - 永不改写/移动原始文件
 * - case JSON 不含正文，referenceLocator 仅 referenceId + bodyHash
 * - 不做 leakage audit（由 build-datasets.mjs 正式构建时做）
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(__filename, "..", "..", "..");
const EXTENSION_ROOT = join(PROJECT_ROOT, ".pi", "extensions", "novel-studio");
const DIST_EVAL_ROOT = join(EXTENSION_ROOT, "dist-eval");

const { values } = parseArgs({
  options: {
    manifest: { type: "string" },
    "splits-dir": { type: "string" },
    out: { type: "string" },
    mode: { type: "string", default: "continuation" },
    "dataset-version": { type: "string", default: "nb3r-v1" },
    "corpus-root": { type: "string" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`NB-3R 轻量级 Reference 注册脚本

用法：
  node scripts/novelbench/build-references-only.mjs [options]

选项：
  --manifest <FILE>        manifest-split 路径（默认 data/novelbench/chapter-splits/manifest-split.jsonl）
  --splits-dir <DIR>       chapter-splits 目录（默认 data/novelbench/chapter-splits/）
  --out <DIR>              输出目录（默认 data/novelbench/datasets/）
  --mode <MODE>            continuation | realization（默认 continuation）
  --dataset-version <V>    数据集版本（默认 nb3r-v1）
  --corpus-root <DIR>      语料根目录（默认 $NOVELBENCH_CORPUS_ROOT 或 D:\\Download\\delete）
  --help                   显示帮助

产物：
  <out>/<mode>-cases.jsonl           最小化 case JSON（无 priorChapterRefs / generationInputPath）
  <out>/reference-registry.json      reference 注册表（无正文，可提交）
`);
  process.exit(0);
}

const manifestPath = resolve(
  PROJECT_ROOT,
  values.manifest || "data/novelbench/chapter-splits/manifest-split.jsonl",
);
const splitsDir = resolve(
  PROJECT_ROOT,
  values["splits-dir"] || "data/novelbench/chapter-splits/",
);
const outDir = resolve(PROJECT_ROOT, values.out || "data/novelbench/datasets/");
const mode = values.mode || "continuation";
const datasetVersion = values["dataset-version"] || "nb3r-v1";
const corpusRoot =
  values["corpus-root"] || process.env.NOVELBENCH_CORPUS_ROOT || "D:\\Download\\delete";

if (!["continuation", "realization"].includes(mode)) {
  process.stderr.write(`错误：--mode 只能为 continuation 或 realization\n`);
  process.exit(1);
}

if (!existsSync(manifestPath)) {
  process.stderr.write(`错误：manifest 不存在：${manifestPath}\n请先运行 split-chapters.mjs\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const novelbenchUrl = new URL(
  `file://${join(DIST_EVAL_ROOT, "novelbench", "index.js").replace(/\\/g, "/")}`,
).href;
const { ReferenceRegistry } = await import(novelbenchUrl);

// 读 manifest
const manifestLines = readFileSync(manifestPath, "utf-8")
  .split("\n")
  .filter((l) => l.trim());
const manifest = manifestLines.map((l) => JSON.parse(l));
const canonicalEntries = manifest.filter((e) => e.status === "canonical");

process.stderr.write(
  `[NB-3R] ${canonicalEntries.length} 本 canonical 书，mode=${mode}，datasetVersion=${datasetVersion}\n`,
);

const registryPath = join(outDir, "reference-registry.json");
const registry = new ReferenceRegistry(registryPath);
registry.load();

const cases = [];
const stats = {
  total: canonicalEntries.length,
  registered: 0,
  skipped: 0,
  skippedReasons: [],
};

for (const entry of canonicalEntries) {
  const splitPath = join(splitsDir, `${entry.bookId}.jsonl`);
  if (!existsSync(splitPath)) {
    stats.skipped++;
    stats.skippedReasons.push(`${entry.bookId}: 无切分文件`);
    continue;
  }

  const splitLines = readFileSync(splitPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim());
  const bookSplits = splitLines.map((l) => JSON.parse(l));

  if (bookSplits.length < 2) {
    stats.skipped++;
    stats.skippedReasons.push(`${entry.bookId}: 章节数 <2`);
    continue;
  }

  // 目标章 = 最后一章
  const targetSplit = bookSplits[bookSplits.length - 1];

  // caseId = `${datasetVersion}-${bookId}-ch${targetChapter}`
  const caseId = `${datasetVersion}-${entry.bookId}-ch${targetSplit.chapterNumber}`;

  // 源文件绝对路径
  const sourceAbsPath = resolve(corpusRoot, entry.sourcePath);
  if (!existsSync(sourceAbsPath)) {
    stats.skipped++;
    stats.skippedReasons.push(`${entry.bookId}: 源文件缺失 ${entry.sourcePath}`);
    continue;
  }

  // 注册 reference（仅元数据，不读源文件）
  registry.register({
    referenceId: caseId,
    sourcePath: sourceAbsPath,
    bodyHash: targetSplit.bodyHash,
    startOffset: targetSplit.bodyStartOffset,
    endOffset: targetSplit.endOffset,
    encoding: undefined, // 让 resolve() 自动检测
  });
  stats.registered++;

  // 构造最小化 case（无 priorChapterRefs / generationInputPath / leakageAudit）
  const caseEntry = {
    datasetVersion,
    caseId,
    bookId: entry.bookId,
    authorId: entry.authorId,
    genre: entry.genre,
    mode,
    targetChapter: targetSplit.chapterNumber,
    referenceLocator: {
      referenceId: caseId,
      bodyHash: targetSplit.bodyHash,
    },
    splitConfidence: targetSplit.splitConfidence,
  };
  cases.push(caseEntry);
}

// 持久化 registry
registry.save();

// 写 cases JSONL
const casesPath = join(outDir, `${mode}-cases.jsonl`);
writeFileSync(
  casesPath,
  cases.map((c) => JSON.stringify(c)).join("\n") + "\n",
  "utf-8",
);

process.stderr.write(
  `\n[NB-3R] 完成：${stats.registered}/${stats.total} 注册，${stats.skipped} 跳过\n`,
);
process.stderr.write(`[NB-3R] cases JSONL: ${casesPath}（${cases.length} cases）\n`);
process.stderr.write(`[NB-3R] registry: ${registryPath}（${registry.list().length} records）\n`);

if (stats.skippedReasons.length > 0) {
  process.stderr.write(`[NB-3R] 跳过明细（前 10 条）：\n`);
  for (const r of stats.skippedReasons.slice(0, 10)) {
    process.stderr.write(`  - ${r}\n`);
  }
}
