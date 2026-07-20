#!/usr/bin/env node
/**
 * NB-2 防泄漏数据集构建 CLI
 *
 * 读取 NB-1 manifest-split + chapter-splits，构建 continuation/realization 数据集。
 *
 * 用法：
 *   node scripts/novelbench/build-datasets.mjs [options]
 *
 * 选项：
 *   --manifest <FILE>     manifest-split 路径（默认 data/novelbench/chapter-splits/manifest-split.jsonl）
 *   --splits-dir <DIR>    chapter-splits 目录（默认 data/novelbench/chapter-splits/）
 *   --out <DIR>           数据集输出目录（默认 data/novelbench/datasets/）
 *   --mode <MODE>         continuation | realization | both（默认 both）
 *   --ratios T:V:Ts       分区比例（默认 70:15:15）
 *   --registry <FILE>     reference-registry.json 路径
 *   --corpus-root <DIR>   语料根目录（默认 $NOVELBENCH_CORPUS_ROOT 或 D:\Download\delete）
 *   --dataset-version <V> 数据集版本（默认 nb2-v1）
 *   --help                显示帮助
 *
 * 产物：
 *   <out>/<mode>-cases.jsonl              每行一个 DatasetCase JSON（无正文）
 *   <out>/generation-inputs/<caseId>.txt  生成输入 bundle（gitignored）
 *   <out>/generator-bundles/<caseId>.json NB-2R 生成器隔离 bundle（sanitized，无 sourcePath）
 *   <out>/reference-registry.json         reference 注册表（无正文，可提交）
 *   reports/dataset-stats.md              统计报告
 *
 * 规则：
 * - 永不改写/移动原始文件
 * - case JSON 不含正文，referenceLocator 仅 referenceId + bodyHash
 * - generator 路径只调 registry.register，不调 resolve
 * - NB-2R：generator-bundles/<caseId>.json 严禁含 sourcePath/offset/referenceBody（生成器进程隔离）
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
    "splits-dir": { type: "string" },
    out: { type: "string" },
    mode: { type: "string", default: "both" },
    ratios: { type: "string", default: "70:15:15" },
    registry: { type: "string" },
    "corpus-root": { type: "string" },
    "dataset-version": { type: "string", default: "nb2-v1" },
    "no-generator-bundles": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`NB-2 防泄漏数据集构建 CLI

用法：
  node scripts/novelbench/build-datasets.mjs [options]

选项：
  --manifest <FILE>        manifest-split 路径（默认 data/novelbench/chapter-splits/manifest-split.jsonl）
  --splits-dir <DIR>       chapter-splits 目录（默认 data/novelbench/chapter-splits/）
  --out <DIR>              数据集输出目录（默认 data/novelbench/datasets/）
  --mode <MODE>            continuation | realization | both（默认 both）
  --ratios T:V:Ts          分区比例（默认 70:15:15）
  --registry <FILE>        reference-registry.json 路径
  --corpus-root <DIR>      语料根目录（默认 $NOVELBENCH_CORPUS_ROOT 或 D:\\Download\\delete）
  --dataset-version <V>    数据集版本（默认 nb2-v1）
  --no-generator-bundles   NB-2R：不写 generator-bundles/（默认写）
  --help                   显示帮助

产物：
  <out>/<mode>-cases.jsonl                evaluator-only（含 sourcePath 在 priorChapterRefs）
  <out>/generation-inputs/<caseId>.txt    生成输入 bundle（gitignored）
  <out>/generator-bundles/<caseId>.json   NB-2R 生成器隔离 bundle（sanitized，无 sourcePath）
  <out>/reference-registry.json           reference 注册表（无正文，可提交）
  reports/dataset-stats.md                统计报告
`);
  process.exit(0);
}

const manifestPath = resolve(PROJECT_ROOT, values.manifest || "data/novelbench/chapter-splits/manifest-split.jsonl");
const splitsDir = resolve(PROJECT_ROOT, values["splits-dir"] || "data/novelbench/chapter-splits/");
const outDir = resolve(PROJECT_ROOT, values.out || "data/novelbench/datasets/");
const mode = values.mode || "both";
const ratiosParts = (values.ratios || "70:15:15").split(":").map(Number);
const corpusRoot = values["corpus-root"] || process.env.NOVELBENCH_CORPUS_ROOT || "D:\\Download\\delete";
const datasetVersion = values["dataset-version"] || "nb2-v1";
const registryPath = resolve(PROJECT_ROOT, values.registry || "data/novelbench/datasets/reference-registry.json");

if (ratiosParts.length !== 3 || ratiosParts.some((n) => !Number.isFinite(n))) {
  process.stderr.write(`错误：--ratios 格式应为 T:V:Ts，如 70:15:15\n`);
  process.exit(1);
}
const ratiosSum = ratiosParts.reduce((a, b) => a + b, 0);
const ratios = {
  train: ratiosParts[0] / ratiosSum,
  validation: ratiosParts[1] / ratiosSum,
  test: ratiosParts[2] / ratiosSum,
};

const novelbenchUrl = new URL(`file://${join(DIST_EVAL_ROOT, "novelbench", "index.js").replace(/\\/g, "/")}`).href;
const {
  partitionByBook,
  buildDataset,
  ReferenceRegistry,
} = await import(novelbenchUrl);

if (!existsSync(manifestPath)) {
  process.stderr.write(`错误：manifest 不存在：${manifestPath}\n请先运行 audit-corpora.mjs + split-chapters.mjs\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

// 读 manifest
const manifestLines = readFileSync(manifestPath, "utf-8").split("\n").filter((l) => l.trim());
const manifest = manifestLines.map((l) => JSON.parse(l));
const canonicalEntries = manifest.filter((e) => e.status === "canonical");

process.stderr.write(`[NB-2] ${canonicalEntries.length} 本 canonical 书，模式 ${mode}，分区 ${ratiosParts.join(":")}\n`);

// 读每本书的 chapter splits
const splits = new Map();
for (const entry of canonicalEntries) {
  const splitPath = join(splitsDir, `${entry.bookId}.jsonl`);
  if (!existsSync(splitPath)) {
    process.stderr.write(`[NB-2] 跳过（无切分文件）：${entry.title}\n`);
    continue;
  }
  const splitLines = readFileSync(splitPath, "utf-8").split("\n").filter((l) => l.trim());
  splits.set(entry.bookId, splitLines.map((l) => JSON.parse(l)));
}

// 分区
const partition = partitionByBook(
  canonicalEntries.map((e) => ({ bookId: e.bookId, authorId: e.authorId })),
  ratios,
);

process.stderr.write(`[NB-2] 分区：train=${partition.train.length} validation=${partition.validation.length} test=${partition.test.length}\n`);

// reference registry
const registry = new ReferenceRegistry(registryPath);
registry.load();

// 确定要构建的模式
const modes = mode === "both" ? ["continuation", "realization"] : [mode];

const allStats = {
  totalCases: 0,
  byMode: {},
  leakageFailures: 0,
  skipped: 0,
  generatorBundles: 0,
};

const writeGeneratorBundles = !values["no-generator-bundles"];
const generatorBundleDir = writeGeneratorBundles ? join(outDir, "generator-bundles") : undefined;
if (writeGeneratorBundles) {
  mkdirSync(generatorBundleDir, { recursive: true });
}

for (const m of modes) {
  process.stderr.write(`[NB-2] 构建 ${m} 数据集...\n`);

  const generationInputDir = join(outDir, "generation-inputs");
  mkdirSync(generationInputDir, { recursive: true });

  const result = await buildDataset({
    datasetVersion,
    mode: m,
    partition,
    splits,
    manifest: canonicalEntries,
    corpusRoot,
    outputDir: generationInputDir,
    registry,
    datasetsRoot: outDir,
    generatorBundleDir,
  });

  // 写 case JSONL
  const casesPath = join(outDir, `${m}-cases.jsonl`);
  writeFileSync(
    casesPath,
    result.cases.map((c) => JSON.stringify(c)).join("\n") + "\n",
    "utf-8",
  );

  allStats.totalCases += result.cases.length;
  allStats.byMode[m] = {
    cases: result.cases.length,
    leakageFailures: result.leakageFailures,
    skipped: result.skipped.length,
    partition: result.partitionStats,
    generatorBundles: result.generatorBundlesWritten,
  };
  allStats.leakageFailures += result.leakageFailures;
  allStats.skipped += result.skipped.length;
  allStats.generatorBundles += result.generatorBundlesWritten;

  if (result.skipped.length > 0) {
    process.stderr.write(`[NB-2] ${m} 跳过 ${result.skipped.length} 本：\n`);
    for (const s of result.skipped.slice(0, 10)) {
      process.stderr.write(`  - ${s}\n`);
    }
  }
  process.stderr.write(`[NB-2] ${m} 完成：${result.cases.length} cases，${result.leakageFailures} leakage 失败，${result.generatorBundlesWritten} generator bundles\n`);
}

// 持久化 registry
registry.save();

// 写统计报告
const reportDir = join(dirname(outDir), "reports");
mkdirSync(reportDir, { recursive: true });
const reportPath = join(reportDir, "dataset-stats.md");
const report = formatStatsMarkdown(allStats, modes, ratios, datasetVersion);
writeFileSync(reportPath, report, "utf-8");

process.stderr.write(`[NB-2] 全部完成：${allStats.totalCases} cases，${allStats.leakageFailures} leakage 失败\n`);
process.stdout.write(report);

// ─────────────────────────────────────────────────────────────────────────────

function formatStatsMarkdown(allStats, modes, ratios, datasetVersion) {
  const lines = [];
  lines.push("# NovelBench 防泄漏数据集统计");
  lines.push("");
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push(`数据集版本：${datasetVersion}`);
  lines.push(`分区比例：train=${(ratios.train * 100).toFixed(0)}% validation=${(ratios.validation * 100).toFixed(0)}% test=${(ratios.test * 100).toFixed(0)}%`);
  lines.push("");
  lines.push("## 总览");
  lines.push("");
  lines.push("| 指标 | 数量 |");
  lines.push("|------|------|");
  lines.push(`| 总 cases | ${allStats.totalCases} |`);
  lines.push(`| generator bundles (NB-2R) | ${allStats.generatorBundles} |`);
  lines.push(`| leakage 失败 | ${allStats.leakageFailures} |`);
  lines.push(`| 跳过 | ${allStats.skipped} |`);
  lines.push("");

  for (const m of modes) {
    const s = allStats.byMode[m];
    if (!s) continue;
    lines.push(`## ${m} 模式`);
    lines.push("");
    lines.push("| 指标 | 数量 |");
    lines.push("|------|------|");
    lines.push(`| cases | ${s.cases} |`);
    lines.push(`| generator bundles (NB-2R) | ${s.generatorBundles} |`);
    lines.push(`| leakage 失败 | ${s.leakageFailures} |`);
    lines.push(`| 跳过 | ${s.skipped} |`);
    lines.push("");
    lines.push("### 分区分布");
    lines.push("");
    lines.push("| 集合 | 书数 |");
    lines.push("|------|------|");
    lines.push(`| train | ${s.partition.train} |`);
    lines.push(`| validation | ${s.partition.validation} |`);
    lines.push(`| test | ${s.partition.test} |`);
    lines.push("");
  }

  return lines.join("\n");
}
