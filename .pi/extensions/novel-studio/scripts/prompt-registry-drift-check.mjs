/**
 * Phase 9 - Prompt Registry Hash Drift 检查 CLI（eval-only）
 *
 * CI 和生产发布门禁用：校验生产 Prompt、工具 schema、上下文、预算 hash
 * 是否与 registry 中 active 版本记录的 hash 一致。
 *
 * MODEL-PROMPT-EVOLUTION-1（t2）：额外执行 bundle 级漂移检查（renderer/parser/
 * termination/provider capability/模型版本等完整行为环境）。bundle 检查需要读取
 * 实现源码（workspaceRoot = 扩展根），身份可经 CLI 参数覆盖。
 *
 * 发现漂移 -> exit code 1（hard block），不允许静默运行。
 *
 * 用法：
 *   cd .pi/extensions/novel-studio && npm run build:eval
 *   node scripts/prompt-registry-drift-check.mjs
 *   node scripts/prompt-registry-drift-check.mjs --route gemini_writer_v2 --provider gemini --model-version gemini-3.1-pro-preview
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

// CLI 参数解析（默认 Gemini 生产身份）
function parseArgs(argv) {
  const args = { route: "gemini_writer_v2", provider: "gemini", modelVersion: "gemini-3.1-pro-preview", temperature: null, maxTokens: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--route") args.route = argv[++i];
    else if (a === "--provider") args.provider = argv[++i];
    else if (a === "--model-version") args.modelVersion = argv[++i];
    else if (a === "--temperature") args.temperature = Number(argv[++i]);
    else if (a === "--max-tokens") args.maxTokens = Number(argv[++i]);
  }
  return args;
}
const identity = parseArgs(process.argv.slice(2));

console.log("[drift-check] Prompt Registry hash drift 检查启动");
console.log(`[drift-check] registry 路径: ${REGISTRY_PATH}`);
console.log(`[drift-check] bundle 身份: route=${identity.route} provider=${identity.provider} modelVersion=${identity.modelVersion} temp=${identity.temperature ?? "default"}`);

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

// ── bundle 级漂移检查（t2）──
// 语义：仅当「存在 bundle 基线且发生真实漂移」才视为失败（hard block）。
// 无基线（未接入）为告警，不阻断——否则任何未 onboarding 的 registry 都无法通过验证。
const bundleResult = driftMod.runBundleDriftCheck(REGISTRY_PATH, {
  workspaceRoot: EXT_ROOT,
  route: identity.route,
  provider: identity.provider,
  modelVersion: identity.modelVersion,
  temperature: identity.temperature,
  maxTokens: identity.maxTokens,
});
const bundleRealDrift = bundleResult.checkedSlots.some(
  (s) => s.hasBaseline && !s.passed,
);
console.log(`\n${bundleResult.summary}`);
for (const s of bundleResult.checkedSlots) {
  if (s.hasBaseline) {
    const status = s.passed ? "✓ PASS" : "✗ FAIL";
    console.log(`  ${status} ${s.slot} (bundleId=${s.baselineBundleId.slice(0, 12)}…)`);
  } else {
    console.log(`  ⚠ ${s.slot}：无 bundle baseline（未接入，仅告警不阻断）`);
  }
}

if (result.passed && !bundleRealDrift) {
  console.log("\n[drift-check] ✓ 全部通过（hash 一致；bundle 无真实漂移）");
  process.exit(0);
} else {
  console.error("\n[drift-check] ✗ 存在 hash 漂移或 bundle 真实漂移（fail-closed）");
  process.exit(1);
}
