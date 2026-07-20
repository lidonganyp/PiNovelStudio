#!/usr/bin/env node
/**
 * REFERENCE-CORPUS-ADAPTER-1：单书外部 reference 导入 CLI
 *
 * 接入外部 .txt 小说作为 evaluator-only reference，复用 NovelBench 现有基础设施：
 * - decodeNovelSourceBuffer：多编码自动检测（utf-8/gb18030/gbk/gb2312/big5/utf-16le/utf-16be）
 * - splitChaptersStrict：严格章节切分（无标题 fallback 禁止，<2 heading → 拒绝）
 * - ReferenceRegistry：referenceId → sourcePath + offsets + bodyHash（无 body，evaluator-only）
 *
 * 与 build-datasets.mjs / build-references-only.mjs 的区别：
 * - 直接读单本 .txt，不依赖 manifest-split.jsonl
 * - 不移动/不复制原文件（原始 .txt 不进入 outDir，不进入 Git）
 * - 使用 referenceId = bookId:physical:N 格式，彻底解决重复章号与多个 9999 番外覆盖问题
 * - 同时输出 book-manifest.json + chapters.jsonl + manifest-hash.sha256 三件套
 *
 * 用法：
 *   node scripts/novelbench/import-external-reference.mjs \
 *     --input <FILE> --book-id <ID> --out-dir <DIR> \
 *     [--title <TITLE>] [--author <AUTHOR>] [--genre <GENRE>] \
 *     [--register-registry <REGISTRY_PATH>]
 *
 * 产物：
 *   <out-dir>/book-manifest.json       书级元数据（bookId/sourcePath/fileHash/contentHash/encoding/...）
 *   <out-dir>/chapters.jsonl           每行一个章节记录（含 physicalChapterIndex，无 body）
 *   <out-dir>/manifest-hash.sha256     chapters.jsonl 的 SHA-256（确定性校验，不含 importedAt）
 *
 * 可选：
 *   --register-registry <PATH>         写入 ReferenceRegistry（referenceId = bookId:physical:N）
 *
 * 规则：
 * - 永不改写/移动原始 .txt；outDir 不含任何 .txt 副本
 * - chapters.jsonl 不含正文，仅 offset + hash + 元数据
 * - manifest-hash.sha256 = sha256(chapters.jsonl 字节内容)；同输入连续两次导入必一致
 * - generator 进程不读本 CLI 产物（产物仅 evaluator 可见；generator bundle 由 sanitizeForGenerator 单独构造）
 *
 * 授权边界：本 CLI 全程离线，不调用任何模型 API。
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(__filename, "..", "..", "..");
const EXTENSION_ROOT = join(PROJECT_ROOT, ".pi", "extensions", "novel-studio");
const DIST_EVAL_ROOT = join(EXTENSION_ROOT, "dist-eval");

// ─────────────────────────────────────────────────────────────────────────────
// CLI 参数解析
// ─────────────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    "book-id": { type: "string" },
    "out-dir": { type: "string" },
    title: { type: "string" },
    author: { type: "string" },
    genre: { type: "string" },
    "register-registry": { type: "string" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`REFERENCE-CORPUS-ADAPTER-1：单书外部 reference 导入 CLI

用法：
  node scripts/novelbench/import-external-reference.mjs \\
    --input <FILE> --book-id <ID> --out-dir <DIR> \\
    [--title <TITLE>] [--author <AUTHOR>] [--genre <GENRE>] \\
    [--register-registry <REGISTRY_PATH>]

必填参数：
  --input <FILE>            外部 .txt 小说文件路径（不移动/不复制）
  --book-id <ID>            书籍唯一 ID（用作 referenceId 前缀：bookId:physical:N）
  --out-dir <DIR>           产物输出目录

可选参数：
  --title <TITLE>                     书名
  --author <AUTHOR>                   作者
  --genre <GENRE>                     类型（如 玄幻/科幻/悬疑）
  --register-registry <PATH>          写入 ReferenceRegistry（evaluator-only）
  --help                              显示本帮助

产物：
  <out-dir>/book-manifest.json        书级元数据
  <out-dir>/chapters.jsonl            每行一个章节记录（无 body）
  <out-dir>/manifest-hash.sha256      chapters.jsonl 的 SHA-256（确定性校验）

规则：
  - 原始 .txt 不进入 outDir，不进入 Git
  - manifest-hash.sha256 = sha256(chapters.jsonl)；同输入必一致
  - referenceId = bookId:physical:N（0-based 物理序号，重复章号与 9999 番外不覆盖）
  - 全程离线，不调用任何模型 API
`);
  process.exit(0);
}

// 必填校验
const inputRaw = values.input;
const bookId = values["book-id"];
const outDirRaw = values["out-dir"];

if (!inputRaw || !bookId || !outDirRaw) {
  process.stderr.write(
    `错误：--input、--book-id、--out-dir 均为必填\n` +
      `使用 --help 查看完整用法\n`,
  );
  process.exit(1);
}

const inputPath = resolve(PROJECT_ROOT, inputRaw);
const outDir = resolve(PROJECT_ROOT, outDirRaw);

if (!existsSync(inputPath)) {
  process.stderr.write(`错误：输入文件不存在：${inputPath}\n`);
  process.exit(1);
}

if (!/^[a-zA-Z0-9_\-]+$/.test(bookId)) {
  process.stderr.write(
    `错误：--book-id 只能含字母/数字/下划线/连字符，实际：${bookId}\n`,
  );
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// 加载 NovelBench 模块（dist-eval，eval-only）
// ─────────────────────────────────────────────────────────────────────────────

const novelbenchUrl = new URL(
  `file://${join(DIST_EVAL_ROOT, "novelbench", "index.js").replace(/\\/g, "/")}`,
).href;
const { splitChaptersStrict, ReferenceRegistry } = await import(novelbenchUrl);

const replayExtractorUrl = new URL(
  `file://${join(DIST_EVAL_ROOT, "eval", "replay-case-extractor.js").replace(/\\/g, "/")}`,
).href;
const { decodeNovelSourceBuffer } = await import(replayExtractorUrl);

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 计算字符串的 SHA-256（hex）。
 * @param {string | Uint8Array} data
 */
function sha256(data) {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

// 1. 读原文件 → buffer
const buffer = readFileSync(inputPath);
const fileHash = createHash("sha256").update(buffer).digest("hex");
const size = buffer.length;

// 2. 多编码自动检测 → 解码后的文本
const decoded = decodeNovelSourceBuffer(new Uint8Array(buffer));
const text = decoded.text;
const encoding = decoded.encoding;
const encodingScore = decoded.score;
const contentHash = sha256(text);

process.stderr.write(
  `[RCA-1] 输入：${inputPath}\n` +
    `[RCA-1] 文件大小：${size} bytes，编码：${encoding}（score=${encodingScore.toFixed(3)}）\n` +
    `[RCA-1] fileHash=${fileHash}\n` +
    `[RCA-1] contentHash=${contentHash}\n`,
);

// 3. 严格章节切分
const splitResult = splitChaptersStrict(text);

if (splitResult.chapters.length === 0) {
  process.stderr.write(
    `[RCA-1] 错误：章节切分失败，rejectionReason=${splitResult.rejectionReason ?? "unknown"}\n`,
  );
  if (splitResult.issues.length > 0) {
    process.stderr.write(
      `[RCA-1] issues:\n${splitResult.issues.map((i) => `  - ${i}`).join("\n")}\n`,
    );
  }
  process.exit(2);
}

process.stderr.write(
  `[RCA-1] 切分：${splitResult.chapters.length} 章，splitConfidence=${splitResult.splitConfidence.toFixed(3)}\n`,
);

// 4. 构造 chapters.jsonl 内容（每行一个 ExternalChapterManifestEntry）
//    字段：bookId + physicalChapterIndex + 原 ChapterSplit 字段
const chapterRecords = splitResult.chapters.map((ch, idx) => ({
  bookId,
  physicalChapterIndex: idx,
  chapterNumber: ch.chapterNumber,
  heading: ch.heading,
  title: ch.title,
  startOffset: ch.startOffset,
  bodyStartOffset: ch.bodyStartOffset,
  endOffset: ch.endOffset,
  bodyHash: ch.bodyHash,
  characterCount: ch.characterCount,
  splitConfidence: ch.splitConfidence,
  issues: ch.issues,
}));

const chaptersJsonlContent =
  chapterRecords.map((r) => JSON.stringify(r)).join("\n") + "\n";

// 5. 构造 book-manifest.json
const bookManifest = {
  bookId,
  title: values.title ?? null,
  author: values.author ?? null,
  genre: values.genre ?? null,
  sourcePath: inputPath,
  fileHash,
  contentHash,
  size,
  encoding,
  encodingScore,
  chapterCount: chapterRecords.length,
  splitConfidence: splitResult.splitConfidence,
  issues: splitResult.issues,
  importedAt: new Date().toISOString(),
};

// 6. 计算 manifest-hash.sha256（基于 chapters.jsonl 字节内容；不含 importedAt）
const manifestHash = sha256(chaptersJsonlContent);

// 7. 写三个产物文件（不写任何 .txt）
writeFileSync(
  join(outDir, "book-manifest.json"),
  JSON.stringify(bookManifest, null, 2) + "\n",
  "utf-8",
);
writeFileSync(join(outDir, "chapters.jsonl"), chaptersJsonlContent, "utf-8");
writeFileSync(join(outDir, "manifest-hash.sha256"), manifestHash + "\n", "utf-8");

process.stderr.write(
  `[RCA-1] 产物：\n` +
    `  ${join(outDir, "book-manifest.json")}\n` +
    `  ${join(outDir, "chapters.jsonl")}（${chapterRecords.length} 行）\n` +
    `  ${join(outDir, "manifest-hash.sha256")}=${manifestHash}\n`,
);

// 8. 可选：注册到 ReferenceRegistry
const registryPath = values["register-registry"];
if (registryPath) {
  const registryAbsPath = resolve(PROJECT_ROOT, registryPath);
  const registry = new ReferenceRegistry(registryAbsPath);
  registry.load();

  let registered = 0;
  for (const ch of chapterRecords) {
    const referenceId = `${bookId}:physical:${ch.physicalChapterIndex}`;
    registry.register({
      referenceId,
      sourcePath: inputPath,
      bodyHash: ch.bodyHash,
      startOffset: ch.bodyStartOffset,
      endOffset: ch.endOffset,
      encoding,
    });
    registered++;
  }
  registry.save();

  process.stderr.write(
    `[RCA-1] 注册到 ReferenceRegistry：${registryAbsPath}（+${registered} 条，共 ${registry.list().length} 条）\n`,
  );
}

// 9. 输出汇总
process.stderr.write(
  `[RCA-1] 完成：bookId=${bookId}，${chapterRecords.length} 章，manifest-hash=${manifestHash.slice(0, 16)}...\n`,
);
