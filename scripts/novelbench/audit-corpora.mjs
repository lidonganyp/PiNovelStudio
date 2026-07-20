#!/usr/bin/env node
/**
 * NB-0 语料审计 CLI
 *
 * 扫描本地小说语料库，生成不含正文的 corpus-manifest.jsonl + 统计报告。
 *
 * 用法：
 *   node scripts/novelbench/audit-corpora.mjs [--root DIR] [--out FILE] [--no-timestamp]
 *
 * 默认：
 *   --root  $NOVELBENCH_CORPUS_ROOT || D:\Download\delete
 *   --out   data/novelbench/corpus-manifest.jsonl
 *
 * 产物：
 *   <out>                              corpus-manifest.jsonl（每行一个 BookManifestEntry）
 *   data/novelbench/reports/corpus-audit-stats.md  统计仪表盘
 *
 * 规则：
 * - 永不改写/移动原始文件（auditCorpora 内部只读）
 * - Manifest 仅保存元数据 + 相对源路径，不保存正文
 * - 按 bookId 排序保证确定性（相同输入 → 相同 manifest，--no-timestamp 时 hash 稳定）
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(__filename, "..", "..", "..");
const EXTENSION_ROOT = join(PROJECT_ROOT, ".pi", "extensions", "novel-studio");
const DIST_EVAL_ROOT = join(EXTENSION_ROOT, "dist-eval");

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    out: { type: "string" },
    "no-timestamp": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`NB-0 语料审计 CLI

用法：
  node scripts/novelbench/audit-corpora.mjs [options]

选项：
  --root <DIR>        语料根目录（默认 $NOVELBENCH_CORPUS_ROOT || D:\\Download\\delete）
  --out <FILE>        manifest 输出路径（默认 data/novelbench/corpus-manifest.jsonl）
  --no-timestamp      使用稳定时间戳（测试/复现用，hash 可重复）
  --help              显示帮助
`);
  process.exit(0);
}

const root = values.root || process.env.NOVELBENCH_CORPUS_ROOT || "D:\\Download\\delete";
const outPath = resolve(PROJECT_ROOT, values.out || "data/novelbench/corpus-manifest.jsonl");
const recordTimestamp = !values["no-timestamp"];

const novelbenchUrl = new URL(`file://${join(DIST_EVAL_ROOT, "novelbench", "index.js").replace(/\\/g, "/")}`).href;
const { auditCorpora } = await import(novelbenchUrl);

if (!existsSync(root)) {
  process.stderr.write(`错误：语料根目录不存在：${root}\n`);
  process.exit(1);
}

process.stderr.write(`[NB-0] 扫描语料：${root}\n`);
process.stderr.write(`[NB-0] 输出 manifest：${outPath}\n`);
process.stderr.write(`[NB-0] 时间戳：${recordTimestamp ? "真实" : "稳定"}\n`);

const result = await auditCorpora({ root, recordTimestamp });

// 写 manifest.jsonl
mkdirSync(dirname(outPath), { recursive: true });
const manifestContent =
  result.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
writeFileSync(outPath, manifestContent, "utf-8");
process.stderr.write(`[NB-0] manifest 已写：${result.entries.length} 条\n`);

// 写统计报告
const reportDir = join(dirname(outPath), "reports");
mkdirSync(reportDir, { recursive: true });
const reportPath = join(reportDir, "corpus-audit-stats.md");
writeFileSync(reportPath, formatStatsMarkdown(result), "utf-8");
process.stderr.write(`[NB-0] 统计报告已写：${reportPath}\n`);

process.stdout.write(formatStatsMarkdown(result));

// ─────────────────────────────────────────────────────────────────────────────
// 统计报告格式化
// ─────────────────────────────────────────────────────────────────────────────

function formatStatsMarkdown(result) {
  const { stats } = result;
  const lines = [];
  lines.push("# NovelBench 语料审计统计");
  lines.push("");
  // NB-0R: 报告时间戳必须与 manifest 同源，保证 --no-timestamp 时报告也确定性。
  // 使用 entries[0].auditTimestamp（manifest 已按 bookId 排序，首条稳定），
  // 仅在空 manifest 时回退到当前时间。
  const ts = result.entries[0]?.auditTimestamp || new Date().toISOString();
  lines.push(`生成时间：${ts}`);
  lines.push(`语料根目录：\`${root}\``);
  lines.push("");
  lines.push("## 总览");
  lines.push("");
  lines.push("| 指标 | 数量 |");
  lines.push("|------|------|");
  lines.push(`| 总文件数 | ${stats.totalFiles} |`);
  lines.push(`| canonical | ${stats.canonical} |`);
  lines.push(`| duplicate | ${stats.duplicate} |`);
  lines.push(`| incomplete | ${stats.incomplete} |`);
  lines.push(`| mojibake | ${stats.mojibake} |`);
  lines.push(`| polluted | ${stats.polluted} |`);
  lines.push("");

  lines.push("## 按类型分布");
  lines.push("");
  lines.push("| 类型 | 数量 |");
  lines.push("|------|------|");
  for (const [genre, count] of Object.entries(stats.byGenre).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${genre} | ${count} |`);
  }
  lines.push("");

  lines.push("## 编码分布");
  lines.push("");
  lines.push("| 编码 | 数量 |");
  lines.push("|------|------|");
  for (const [encoding, count] of Object.entries(stats.encodingDistribution).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${encoding} | ${count} |`);
  }
  lines.push("");

  // 问题文件清单（前 50 条）
  const problemEntries = result.entries.filter(
    (e) => e.issues.length > 0 || e.status !== "canonical",
  );
  if (problemEntries.length > 0) {
    lines.push("## 问题文件清单（前 50 条）");
    lines.push("");
    lines.push("| bookId | 标题 | 状态 | 问题 |");
    lines.push("|--------|------|------|------|");
    for (const e of problemEntries.slice(0, 50)) {
      const issues = e.issues.join("；").replace(/\|/g, "\\|") || "—";
      lines.push(`| ${e.bookId} | ${e.title.replace(/\|/g, "\\|")} | ${e.status} | ${issues} |`);
    }
    if (problemEntries.length > 50) {
      lines.push(`| ... | 共 ${problemEntries.length} 条问题文件 | | |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
