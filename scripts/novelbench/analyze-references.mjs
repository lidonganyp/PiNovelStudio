#!/usr/bin/env node
/**
 * NB-3 隐藏 Reference Analyzer CLI
 *
 * 读取 NB-2 dataset cases，对每个 case 调 ReferenceRegistry.resolve() 拿 reference body，
 * 再调 analyzeReference() 提取 12 类叙事资产，写入 reference-assets/{caseId}.json。
 *
 * 用法：
 *   node scripts/novelbench/analyze-references.mjs [options]
 *
 * 选项：
 *   --cases <FILE>     dataset cases JSONL 路径（默认 data/novelbench/datasets/continuation-cases.jsonl）
 *   --registry <FILE>  reference-registry.json 路径（默认 data/novelbench/datasets/reference-registry.json）
 *   --out <DIR>        reference-assets 输出目录（默认 data/novelbench/reference-assets/）
 *   --rounds 1|2       提取轮数（默认 1；2=双轮一致性检查）
 *   --limit N          只处理前 N 个 case（默认全部）
 *   --route <NAME>     模型路由（默认 reference_analyzer）
 *   --help             显示帮助
 *
 * 产物：
 *   <out>/<caseId>.json   每个文件含 ReferenceAsset（12 类资产 + consistency + provenance）
 *
 * 规则：
 * - evaluator-only：本 CLI 调 registry.resolve()，generator 路径不得调用
 * - reference-assets/ gitignored，不含 generator input
 * - 不调真实模型时（无 API key），createRoutedChatAPI 会失败退出
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
    cases: { type: "string" },
    registry: { type: "string" },
    out: { type: "string" },
    rounds: { type: "string", default: "1" },
    limit: { type: "string" },
    route: { type: "string", default: "reference_analyzer" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`NB-3 隐藏 Reference Analyzer CLI

用法：
  node scripts/novelbench/analyze-references.mjs [options]

选项：
  --cases <FILE>        dataset cases JSONL 路径（默认 data/novelbench/datasets/continuation-cases.jsonl）
  --registry <FILE>     reference-registry.json 路径（默认 data/novelbench/datasets/reference-registry.json）
  --out <DIR>           reference-assets 输出目录（默认 data/novelbench/reference-assets/）
  --rounds 1|2          提取轮数（默认 1；2=双轮一致性检查）
  --limit N             只处理前 N 个 case（默认全部）
  --route <NAME>        模型路由（默认 reference_analyzer）
  --help                显示帮助
`);
  process.exit(0);
}

const casesPath = resolve(
  PROJECT_ROOT,
  values.cases || "data/novelbench/datasets/continuation-cases.jsonl",
);
const registryPath = resolve(
  PROJECT_ROOT,
  values.registry || "data/novelbench/datasets/reference-registry.json",
);
const outDir = resolve(PROJECT_ROOT, values.out || "data/novelbench/reference-assets/");
const rounds = values.rounds === "2" ? 2 : 1;
const route = values.route || "reference_analyzer";
const limit = values.limit ? Number.parseInt(values.limit, 10) : undefined;

if (!Number.isInteger(rounds) || (rounds !== 1 && rounds !== 2)) {
  process.stderr.write(`错误：--rounds 只能为 1 或 2\n`);
  process.exit(1);
}
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
  process.stderr.write(`错误：--limit 必须为正整数\n`);
  process.exit(1);
}

const novelbenchUrl = new URL(
  `file://${join(DIST_EVAL_ROOT, "novelbench", "index.js").replace(/\\/g, "/")}`,
).href;
const { analyzeReference, ReferenceRegistry } = await import(novelbenchUrl);

if (!existsSync(casesPath)) {
  process.stderr.write(
    `错误：cases 文件不存在：${casesPath}\n请先运行 build-datasets.mjs\n`,
  );
  process.exit(1);
}
if (!existsSync(registryPath)) {
  process.stderr.write(
    `错误：registry 文件不存在：${registryPath}\n请先运行 build-datasets.mjs\n`,
  );
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

// 加载 registry
const registry = new ReferenceRegistry(registryPath);
registry.load();

// 读 cases JSONL
const caseLines = readFileSync(casesPath, "utf-8")
  .split("\n")
  .filter((l) => l.trim());
const cases = caseLines.map((l) => JSON.parse(l));

const effectiveCases = limit ? cases.slice(0, limit) : cases;

process.stderr.write(
  `[NB-3] ${effectiveCases.length} cases，rounds=${rounds}，route=${route}\n`,
);

const stats = {
  total: effectiveCases.length,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  failures: [],
};

for (const c of effectiveCases) {
  const referenceId = c.referenceLocator?.referenceId;
  const caseId = c.caseId;
  if (!referenceId || !caseId) {
    stats.skipped++;
    stats.failures.push(`${caseId || "?"}: 缺少 referenceId/caseId`);
    continue;
  }

  // evaluator-only：调 registry.resolve 拿 reference body
  const referenceBody = registry.resolve(referenceId);
  if (referenceBody === null) {
    stats.skipped++;
    stats.failures.push(`${caseId}: reference resolve 失败（hash 不匹配或记录缺失）`);
    continue;
  }

  try {
    const asset = await analyzeReference({
      referenceId,
      referenceBody,
      bodyHash: c.referenceLocator.bodyHash,
      rounds,
      route,
    });

    const outPath = join(outDir, `${caseId}.json`);
    writeFileSync(outPath, JSON.stringify(asset, null, 2) + "\n", "utf-8");
    stats.succeeded++;
    process.stderr.write(
      `[NB-3] ✓ ${caseId}: agreed=${asset.consistency.agreedFields} ` +
        `unknown=${asset.consistency.unknownFields} ` +
        `conflict=${asset.consistency.conflictedFields} ` +
        `invalidSpan=${asset.consistency.invalidSpanFields}\n`,
    );
  } catch (err) {
    stats.failed++;
    stats.failures.push(`${caseId}: ${err?.message || String(err)}`);
    process.stderr.write(`[NB-3] ✗ ${caseId}: ${err?.message || err}\n`);
  }
}

// 统计报告
process.stderr.write(
  `\n[NB-3] 完成：${stats.succeeded}/${stats.total} 成功，${stats.failed} 失败，${stats.skipped} 跳过\n`,
);
if (stats.failures.length > 0) {
  process.stderr.write(`[NB-3] 失败明细（前 10 条）：\n`);
  for (const f of stats.failures.slice(0, 10)) {
    process.stderr.write(`  - ${f}\n`);
  }
}

if (stats.failed > 0) {
  process.exit(1);
}
