/**
 * MODEL-PROMPT-EVOLUTION-1 — Registry Bundle Baseline 晋级脚本（eval-only）
 *
 * REGISTRY-DRIFT-IDENTITY-1 / 审计 P1-2 整改：baseline-init 只采集 draft；
 * 晋级（draft → eval → canary → active + 指针切换）必须经本命令，且要求：
 *
 * 1. 真实评测证据：--eval-report 指向存在的 JSON 报告文件，报告中 bundleId
 *    必须与版本 bundleManifest.bundleId 一致（证据与版本身份绑定，防张冠李戴）
 * 2. 显式人工授权：--approved-by（授权人）与 --approval-reason（授权理由）非空，
 *    授权信息写入每次状态转换的 reason（审计可追溯）
 *
 * 任一校验失败 → fail-closed 阻断，registry 不被修改。
 * 禁止无证据自动晋级 active（审计 P1-2）。
 *
 * 用法：
 *   cd .pi/extensions/novel-studio && npm run build:eval
 *   node scripts/prompt-bundle-baseline-promote.mjs \
 *     --slot novelos_agentic --version novelos_agentic-v4 \
 *     --eval-report reports/xxx-eval-report.json \
 *     --eval-manifest <评测manifest id> \
 *     --approved-by <授权人> --approval-reason <授权理由>
 *
 * eval-only：只注册在 tsconfig.eval.json，不进入生产构建。
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_DIR = __dirname;
const EXT_ROOT = join(SCRIPT_DIR, "..");
const PROJECT_ROOT = join(EXT_ROOT, "..", "..", "..");

// --registry 可选覆盖（默认真实 registry；测试/演练用隔离副本）
const argRegistryIdx = process.argv.indexOf("--registry");
const REGISTRY_PATH = argRegistryIdx !== -1 && process.argv[argRegistryIdx + 1]
  ? process.argv[argRegistryIdx + 1]
  : join(PROJECT_ROOT, "config", "prompt-registry.json");

// ── 参数解析 ──
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      args[key.slice(2)] = "";
      continue;
    }
    args[key.slice(2)] = value;
    i++;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

function requireArg(name) {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    console.error(`[baseline-promote] ✗ 缺少必填参数：--${name}`);
    process.exit(1);
  }
  return value.trim();
}

const SLOT = requireArg("slot");
const VERSION_ID = requireArg("version");
const EVAL_REPORT = requireArg("eval-report");
const EVAL_MANIFEST = requireArg("eval-manifest");
const APPROVED_BY = requireArg("approved-by");
const APPROVAL_REASON = requireArg("approval-reason");

console.log("[baseline-promote] Registry Bundle Baseline 晋级（证据校验 + 人工授权）");
console.log(`[baseline-promote] slot=${SLOT} version=${VERSION_ID}`);
console.log(`[baseline-promote] evalReport=${EVAL_REPORT}`);
console.log(`[baseline-promote] evalManifest=${EVAL_MANIFEST}`);
console.log(`[baseline-promote] approvedBy=${APPROVED_BY}`);

// ── 导入模块 ──
const registryMod = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "prompt-registry.js")}`
);

const VALID_SLOTS = ["novelos_agentic", "style_optimizer", "writer_adapter", "retrieval_eval"];
if (!VALID_SLOTS.includes(SLOT)) {
  console.error(`[baseline-promote] ✗ 非法 slot：${SLOT}（合法值：${VALID_SLOTS.join(", ")}）`);
  process.exit(1);
}

// ── 校验 1：版本存在、slot 匹配、状态为 draft、有 bundleManifest ──
const registry = registryMod.loadRegistry(REGISTRY_PATH);
const version = registry.versions.find((v) => v.versionId === VERSION_ID);
if (!version) {
  console.error(`[baseline-promote] ✗ 版本不存在：${VERSION_ID}`);
  process.exit(1);
}
if (version.slot !== SLOT) {
  console.error(`[baseline-promote] ✗ slot 不匹配：版本属于 ${version.slot}，传入 ${SLOT}`);
  process.exit(1);
}
if (version.status !== "draft") {
  console.error(`[baseline-promote] ✗ 只能晋级 draft 版本（当前状态：${version.status}）；held/rejected 版本请重新采集`);
  process.exit(1);
}
if (!version.bundleManifest) {
  console.error(`[baseline-promote] ✗ 版本无 bundleManifest（身份不完整，不能晋级）`);
  process.exit(1);
}

// ── 校验 2：评测报告存在且 JSON 可解析 ──
if (!existsSync(EVAL_REPORT)) {
  console.error(`[baseline-promote] ✗ 评测报告不存在：${EVAL_REPORT}`);
  process.exit(1);
}
let report;
try {
  report = JSON.parse(readFileSync(EVAL_REPORT, "utf-8"));
} catch (err) {
  console.error(`[baseline-promote] ✗ 评测报告 JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// ── 校验 3：报告 bundleId 与版本 bundleManifest.bundleId 一致（身份绑定）──
const expectedBundleId = version.bundleManifest.bundleId;
const reportBundleIds = new Set();
if (typeof report.bundleId === "string") reportBundleIds.add(report.bundleId);
if (Array.isArray(report.bundleIds)) {
  for (const id of report.bundleIds) {
    if (typeof id === "string") reportBundleIds.add(id);
  }
}
if (reportBundleIds.size === 0) {
  console.error(`[baseline-promote] ✗ 评测报告不含 bundleId/bundleIds 字段（无法绑定版本身份，fail-closed）`);
  process.exit(1);
}
if (!reportBundleIds.has(expectedBundleId)) {
  console.error(`[baseline-promote] ✗ 评测报告 bundleId 与版本不一致（证据不属于该版本）：`);
  console.error(`  报告: ${Array.from(reportBundleIds).join(", ")}`);
  console.error(`  版本: ${expectedBundleId}`);
  process.exit(1);
}

console.log(`[baseline-promote] ✓ 证据身份绑定通过（bundleId=${expectedBundleId.slice(0, 16)}…）`);
console.log(`[baseline-promote] ✓ 人工授权：${APPROVED_BY}（${APPROVAL_REASON}）`);

// ── 执行晋级：绑定证据 → draft → eval → canary → active → 旧 active held → 指针 ──
const PROMOTE_PREFIX = `REGISTRY-IDENTITY-PROMOTE-1 人工授权晋级（授权人=${APPROVED_BY}；理由=${APPROVAL_REASON}；证据=${EVAL_REPORT}）`;

let promoted = {
  ...version,
  evalReportPath: EVAL_REPORT,
  evalManifestId: EVAL_MANIFEST,
};
promoted = registryMod.transitionStatus(promoted, "eval", `${PROMOTE_PREFIX}：登记评测证据，进入评测`, "manual");
promoted = registryMod.transitionStatus(promoted, "canary", `${PROMOTE_PREFIX}：评测证据通过，进入金丝雀`, "manual");
promoted = registryMod.transitionStatus(promoted, "active", `${PROMOTE_PREFIX}：人工确认晋级生产基线`, "manual");

let nextRegistry = registryMod.updateVersion(registry, promoted);
console.log(`[baseline-promote] ✓ ${VERSION_ID}: draft → eval → canary → active（授权转换已记录）`);

// 旧 active 版本迁移到 held（版本收敛：单一 active 基线）
const previousActive = registryMod.getActiveVersion(registry, SLOT);
if (previousActive && previousActive.versionId !== VERSION_ID) {
  const heldVersion = registryMod.transitionStatus(
    previousActive,
    "held",
    `${PROMOTE_PREFIX}：被 ${VERSION_ID} 取代，按版本收敛原则退出 active`,
    "manual",
  );
  nextRegistry = registryMod.updateVersion(nextRegistry, heldVersion);
  console.log(`[baseline-promote] ✓ 旧基线 ${previousActive.versionId} → held`);
}

// 切换生产指针
nextRegistry = registryMod.setProductionPointer(nextRegistry, SLOT, VERSION_ID);
console.log(`[baseline-promote] ✓ 生产指针 → ${VERSION_ID}`);

// 写回 registry
registryMod.saveRegistry(nextRegistry, REGISTRY_PATH);
console.log(`\n[baseline-promote] 完成：${SLOT} 生产基线 = ${VERSION_ID}`);
console.log(`[baseline-promote] registry 已更新: ${REGISTRY_PATH}`);
console.log("[baseline-promote] 下一步运行 drift check 验证基线: node scripts/prompt-registry-drift-check.mjs");
