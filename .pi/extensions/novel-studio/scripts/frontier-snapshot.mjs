/**
 * FRONTIER-SNAPSHOT-1 CLI — 按 accepted frontier 截取干净工作区快照
 *
 * 用法：
 *   node scripts/frontier-snapshot.mjs --workspace <id> --through-chapter <N>
 *   node scripts/frontier-snapshot.mjs --workspace xinmo --through-chapter 16
 *
 * 输出：
 *   workspaces/<id>-snapshot-ch<N>/  — 快照目录（sibling，不在源 workspace 内部）
 *   workspaces/<id>-snapshot-ch<N>/frontier-manifest.json  — manifest（含 fileHashes/excludedContent）
 *
 * 阻断条件：
 *   - 源工作区不存在
 *   - 状态条目 sourceChapter 不可解析（无法按章节回溯，不猜测）
 *
 * 这是 eval/benchmarking 基础设施，不进入生产闭包。
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
const PROJECT_ROOT = resolve(EXTENSION_ROOT, "..", "..", "..");

// 解析参数
const args = process.argv.slice(2);
let workspaceId = null;
let throughChapter = null;
let outputDir = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--workspace" && i + 1 < args.length) {
    workspaceId = args[++i];
  } else if (args[i] === "--through-chapter" && i + 1 < args.length) {
    throughChapter = Number(args[++i]);
  } else if (args[i] === "--output-dir" && i + 1 < args.length) {
    outputDir = args[++i];
  } else if (args[i] === "--help" || args[i] === "-h") {
    printUsage();
    process.exit(0);
  } else {
    console.error(`未知参数：${args[i]}`);
    printUsage();
    process.exit(1);
  }
}

if (!workspaceId || !throughChapter || !Number.isFinite(throughChapter) || throughChapter < 1) {
  console.error("缺少必需参数：--workspace <id> --through-chapter <N>");
  printUsage();
  process.exit(1);
}

function printUsage() {
  console.error("用法：node scripts/frontier-snapshot.mjs --workspace <id> --through-chapter <N>");
  console.error("示例：node scripts/frontier-snapshot.mjs --workspace xinmo --through-chapter 16");
  console.error("可选：--output-dir <path>  覆盖默认输出目录");
}

const modulePath = join(EXTENSION_ROOT, "dist-eval", "v2", "core", "frontier-snapshot.js");
const mod = await import(`file://${modulePath.replace(/\\/g, "/")}`);

const result = await mod.createFrontierSnapshot({
  workspaceId,
  throughChapter,
  projectRoot: PROJECT_ROOT,
  ...(outputDir ? { outputDir } : {}),
});

if (result.blocked) {
  console.error(`✗ 阻断：${result.blockReason}`);
  console.error(`  源工作区 hash：${result.manifest.sourceWorkspaceHash}`);
  process.exit(2);
}

const m = result.manifest;
console.log(`✓ 快照已生成：${result.outputDir}`);
console.log(`  throughChapter: ${m.throughChapter}`);
console.log(`  sourceWorkspaceHash: ${m.sourceWorkspaceHash}`);
console.log(`  manifestHash:         ${m.manifestHash}`);
console.log(`  文件数：${m.fileHashes.length}`);
console.log(`  排除项：${m.excludedContent.length}`);
console.log(`  状态统计：canon=${m.stateStats.canon} character=${m.stateStats.character} promise=${m.stateStats.promise} pattern=${m.stateStats.pattern} expectation=${m.stateStats.expectation}`);
console.log(`  排除未来条目：${m.stateStats.excludedFutureEntries}`);
console.log(`  排除不可解析条目：${m.stateStats.excludedUnparseableEntries}`);
