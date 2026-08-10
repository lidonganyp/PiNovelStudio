/**
 * Phase 9 - Prompt Registry Hash Drift 检查 CLI（eval-only）
 *
 * CI 和生产发布门禁用：校验生产 Prompt、工具 schema、上下文、预算 hash
 * 是否与 registry 中 active 版本记录的 hash 一致。
 *
 * 发现漂移 -> exit code 1（hard block），不允许静默运行。
 *
 * 用法：
 *   cd .pi/extensions/novel-studio && npm run build:eval
 *   node scripts/prompt-registry-drift-check.mjs
 *
 * CI 集成：在 npm test 之前运行此脚本。
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_DIR = __dirname;
const EXT_ROOT = join(SCRIPT_DIR, "..");
const PROJECT_ROOT = join(EXT_ROOT, "..", "..", "..");

const REGISTRY_PATH = join(PROJECT_ROOT, "config", "prompt-registry.json");

console.log("[drift-check] Prompt Registry hash drift 检查启动");
console.log(`[drift-check] registry 路径: ${REGISTRY_PATH}`);

const driftMod = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "prompt-registry-drift-check.js")}`
);

const result = driftMod.runDriftCheck(REGISTRY_PATH);

console.log(`\n${result.summary}`);
console.log(`时间: ${result.timestamp}`);

if (result.checkedSlots.length > 0) {
  console.log("\n逐 slot 检查详情：");
  for (const slot of result.checkedSlots) {
    const status = slot.passed ? "✓ PASS" : "✗ FAIL";
    console.log(`  ${status} ${slot.slot} (${slot.versionId})`);
    for (const drift of slot.drifts) {
      const d = drift.drift ? "✗ DRIFT" : "✓ OK";
      console.log(`    ${d} ${drift.hashName}: expected=${drift.expected} actual=${drift.actual}`);
    }
  }
}

if (result.passed) {
  console.log("\n[drift-check] ✓ 全部通过，无 hash 漂移");
  process.exit(0);
} else {
  console.error("\n[drift-check] ✗ 存在 hash 漂移或 registry 损坏（fail-closed）");
  process.exit(1);
}
