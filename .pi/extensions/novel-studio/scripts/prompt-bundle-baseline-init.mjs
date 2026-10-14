/**
 * MODEL-PROMPT-EVOLUTION-1 — Registry Bundle Baseline 采集脚本（eval-only）
 *
 * REGISTRY-DRIFT-IDENTITY-1 / 审计 P1-2 整改：本脚本**只创建 draft 版本**，
 * 不做任何状态迁移、不切生产指针、不触碰旧 active 版本。
 *
 * - 身份按 slot 从 config/model-routing.json 解析（真实运行配置，不硬编码）
 * - systemPrompt / 实现文件按 slot 采集（采集器 per-slot 语义）
 * - 新版本以 draft 状态入册（evalReportPath/evalManifestId 留空）
 *
 * 晋级必须走独立命令 prompt-bundle-baseline-promote.mjs：
 *   校验真实评测证据（报告 bundleId 与版本身份绑定）+ 显式人工授权后，
 *   才执行 draft → eval → canary → active 与指针切换。
 * 禁止无证据自动晋级 active（审计 P1-2）。
 *
 * 用法：
 *   cd .pi/extensions/novel-studio && npm run build:eval
 *   node scripts/prompt-bundle-baseline-init.mjs
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
const ROUTING_PATH = join(PROJECT_ROOT, "config", "model-routing.json");

console.log("[baseline-init] Registry Bundle Baseline 采集（仅 draft，不晋级）");
console.log(`[baseline-init] registry 路径: ${REGISTRY_PATH}`);
console.log(`[baseline-init] model-routing 路径: ${ROUTING_PATH}`);

// ── 加载 .env ──
const envPath = join(PROJECT_ROOT, ".env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

// ── 导入模块 ──
const collector = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "prompt-bundle-fingerprint-collector.js")}`
);
const manifestMod = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "prompt-bundle-manifest.js")}`
);
const registryMod = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "prompt-registry.js")}`
);
const driftMod = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "prompt-registry-drift-check.js")}`
);

/** slot → 快照用的系统提示（与生产常量同源） */
const SLOT_PROMPTS = {
  novelos_agentic: registryMod.PRODUCTION_NOVELOS_PROMPT,
  style_optimizer: registryMod.PRODUCTION_STYLE_PROMPT,
  writer_adapter: registryMod.PRODUCTION_WRITER_PROMPT,
  retrieval_eval: registryMod.EVAL_BASELINE_RETRIEVAL_PROMPT,
};

const CAPTURE_REASON = "REGISTRY-DRIFT-IDENTITY-1 基线采集：按 model-routing 真实身份以 draft 入册（晋级需走 promote 命令）";

// ── 主逻辑 ──
let registry = registryMod.loadRegistry(REGISTRY_PATH);

console.log(`[baseline-init] 当前 ${registry.versions.length} 个版本`);

let created = 0;
const createdVersions = [];

for (const slot of Object.keys(SLOT_PROMPTS)) {
  // 身份按 slot 从 model-routing.json 解析（真实运行配置）
  const identity = driftMod.resolveSlotIdentityFromRouting(ROUTING_PATH, slot);
  if (!identity) {
    console.error(`[baseline-init] ✗ ${slot}：生产路由 ${driftMod.SLOT_PRODUCTION_ROUTES[slot]} 无法从 model-routing.json 解析（fail-closed，跳过）`);
    process.exitCode = 1;
    continue;
  }

  const versions = registryMod.getVersionsBySlot(registry, slot);
  if (versions.length === 0) {
    console.log(`[baseline-init] 跳过 ${slot}：无既有版本（本脚本只做重捕获，不做首次初始化）`);
    continue;
  }
  const nextVersion = Math.max(...versions.map((v) => v.version)) + 1;

  // 按 slot 采集 Bundle 指纹（systemPrompt 与实现文件 per-slot）
  const content = collector.collectProductionBundleFingerprint({
    workspaceRoot: EXT_ROOT,
    slot,
    identity: {
      modelVersion: identity.modelVersion,
      provider: identity.provider,
      route: identity.route,
      temperature: identity.temperature,
      maxTokens: identity.maxTokens,
    },
  });

  // 计算 manifest（draft 入册；bundleId 不受 status 影响）
  const manifest = manifestMod.computeBundleManifest(content, "draft");

  // 创建 draft 版本（不迁移状态、不切指针、不动旧 active）
  const version = registryMod.createProductionSnapshot(
    slot,
    nextVersion,
    `${slot} 基线（${identity.modelVersion} / ${identity.route}，采集待评测）`,
    identity.route,
    SLOT_PROMPTS[slot],
    content.profileId,
    manifest,
  );

  registry = registryMod.addVersion(registry, version);
  created++;
  createdVersions.push(version.versionId);

  console.log(`[baseline-init] ✓ ${slot} v${nextVersion}（draft）→ bundleId=${manifest.bundleId.slice(0, 16)}…`);
  console.log(`  route=${identity.route} model=${identity.modelVersion} provider=${identity.provider}`);
  console.log(`  temperature=${identity.temperature} maxTokens=${identity.maxTokens} profileId=${content.profileId}`);
  console.log(`  systemPromptHash=${manifest.systemPromptHash.slice(0, 16)}…`);
  console.log(`  userPromptRendererHash=${manifest.userPromptRendererHash.slice(0, 16)}…`);
}

// 写回 registry
registryMod.saveRegistry(registry, REGISTRY_PATH);

console.log(`\n[baseline-init] 完成：${created} 个 slot 已以 draft 入册（未晋级、未切指针）`);
console.log(`[baseline-init] registry 已更新: ${REGISTRY_PATH}`);
if (createdVersions.length > 0) {
  console.log(`[baseline-init] 新 draft 版本: ${createdVersions.join(", ")}`);
}
console.log("[baseline-init] 晋级流程（需真实评测证据 + 人工授权）:");
console.log("  node scripts/prompt-bundle-baseline-promote.mjs --slot <slot> --version <versionId> \\");
console.log("    --eval-report <报告路径> --eval-manifest <评测manifest id> \\");
console.log("    --approved-by <授权人> --approval-reason <授权理由>");
