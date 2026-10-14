/**
 * Phase 9 - Prompt Registry Hash Drift 检查 CLI（eval-only）
 *
 * CI 和生产发布门禁用：校验生产 Prompt、工具 schema、上下文、预算 hash
 * 是否与 registry 中 active 版本记录的 hash 一致。
 *
 * MODEL-PROMPT-EVOLUTION-1（t2）+ REGISTRY-DRIFT-IDENTITY-1：额外执行 bundle 级
 * 漂移检查——renderer/parser/termination/provider capability/模型版本/route/
 * profileId/temperature/maxTokens/bundleId 完整行为身份。身份按 slot 从
 * config/model-routing.json（真实运行配置）解析，不接受 CLI 身份覆盖（否则
 * 身份漂移无法被检出）。
 *
 * fail-closed：hash 漂移、bundle 漂移、缺 bundle baseline、未知路由均
 * exit code 1（hard block），不允许静默运行。
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
const ROUTING_PATH = join(PROJECT_ROOT, "config", "model-routing.json");

console.log("[drift-check] Prompt Registry hash drift 检查启动");
console.log(`[drift-check] registry 路径: ${REGISTRY_PATH}`);
console.log(`[drift-check] model-routing 路径: ${ROUTING_PATH}`);
console.log("[drift-check] bundle 身份按 slot 从 model-routing 解析（不接受 CLI 覆盖）");

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

// ── bundle 级漂移检查（t2 + REGISTRY-DRIFT-IDENTITY-1，fail-closed）──
// 语义：未知路由、缺 bundle baseline、组件 hash 漂移、身份漂移均失败。
// 不再把缺 baseline 降为成功——缺基线即未确认，必须阻断。
const bundleResult = driftMod.runBundleDriftCheck(REGISTRY_PATH, {
  workspaceRoot: EXT_ROOT,
  routingPath: ROUTING_PATH,
});
console.log(`\n${bundleResult.summary}`);
for (const s of bundleResult.checkedSlots) {
  if (s.unknownRoute) {
    console.log(`  ✗ FAIL ${s.slot}：未知生产路由（model-routing 缺 ${driftMod.SLOT_PRODUCTION_ROUTES[s.slot]}）`);
    continue;
  }
  if (!s.hasBaseline) {
    console.log(`  ✗ FAIL ${s.slot}：无 bundle baseline（未确认，fail-closed）`);
    continue;
  }
  const status = s.passed ? "✓ PASS" : "✗ FAIL";
  console.log(`  ${status} ${s.slot} (bundleId=${s.baselineBundleId.slice(0, 12)}…)`);
  for (const drift of s.drifts) {
    if (drift.drift) {
      console.log(`    ✗ DRIFT ${drift.component}: expected=${drift.expected} actual=${drift.actual}`);
    }
  }
  for (const drift of s.identityDrifts) {
    if (drift.drift) {
      console.log(`    ✗ IDENTITY-DRIFT ${drift.field}: expected=${drift.expected} actual=${drift.actual}`);
    }
  }
}

if (result.passed && bundleResult.passed) {
  console.log("\n[drift-check] ✓ 全部通过（hash 一致；bundle 身份与组件无漂移）");
  process.exit(0);
} else {
  console.error("\n[drift-check] ✗ 存在 hash 漂移 / bundle 漂移 / 缺基线 / 未知路由（fail-closed）");
  process.exit(1);
}
