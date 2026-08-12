/**
 * MODEL-PROMPT-EVOLUTION-1 — Registry Bundle Baseline 初始化脚本（eval-only）
 *
 * 为 config/prompt-registry.json 中 4 个 active 版本计算完整 PromptBundleManifest
 * 并写入 bundleManifest 字段，建立 drift check 基线。
 *
 * 运行后，prompt-registry-drift-check.mjs 的 bundle 级检查将能对比基线，
 * 而不是报"无 bundle baseline"。
 *
 * 用法：
 *   cd .pi/extensions/novel-studio && npm run build:eval
 *   node scripts/prompt-bundle-baseline-init.mjs
 *
 * eval-only：只注册在 tsconfig.eval.json，不进入生产构建。
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_DIR = __dirname;
const EXT_ROOT = join(SCRIPT_DIR, "..");
const PROJECT_ROOT = join(EXT_ROOT, "..", "..", "..");
const REGISTRY_PATH = join(PROJECT_ROOT, "config", "prompt-registry.json");

console.log("[baseline-init] Registry Bundle Baseline 初始化");
console.log(`[baseline-init] registry 路径: ${REGISTRY_PATH}`);

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

// ── 生产身份映射 ──
// 4 个 active slot 对应的生产身份
const SLOT_IDENTITIES = {
  novelos_agentic: {
    modelVersion: "gemini-3.1-pro-preview",
    provider: "gemini",
    route: "novelos_agentic",
    temperature: 0.72,
    maxTokens: 2048,
    profileId: "gemini_writer_v2",
  },
  style_optimizer: {
    modelVersion: "gemini-3.1-pro-preview",
    provider: "gemini",
    route: "v2_amplified_gemini31",
    temperature: 0.72,
    maxTokens: 8192,
    profileId: "gemini_writer_v2",
  },
  writer_adapter: {
    modelVersion: "gemini-3.1-pro-preview",
    provider: "gemini",
    route: "v2_rawstage2_gemini31",
    temperature: 0.72,
    maxTokens: 8192,
    profileId: "gemini_writer_v2",
  },
  retrieval_eval: {
    modelVersion: "gemini-3.1-pro-preview",
    provider: "gemini",
    route: "narrator_primary",
    temperature: 0.72,
    maxTokens: 2048,
    profileId: "gemini_writer_v2",
  },
};

// ── 主逻辑 ──
const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));

console.log(`[baseline-init] 当前 ${registry.versions.length} 个版本`);

let updated = 0;
for (const version of registry.versions) {
  if (version.status !== "active") continue;

  const identity = SLOT_IDENTITIES[version.slot];
  if (!identity) {
    console.log(`[baseline-init] 跳过 ${version.slot}：无身份映射`);
    continue;
  }

  // 采集 Bundle 指纹
  const content = collector.collectProductionBundleFingerprint({
    workspaceRoot: EXT_ROOT,
    identity,
    profileId: identity.profileId,
  });

  // 计算 manifest
  const manifest = manifestMod.computeBundleManifest(content, "active");

  // 写入 version
  version.bundleManifest = manifest;
  updated++;

  console.log(`[baseline-init] ✓ ${version.slot} v${version.version} → bundleId=${manifest.bundleId.slice(0, 16)}…`);
  console.log(`  systemPromptHash=${manifest.systemPromptHash.slice(0, 16)}…`);
  console.log(`  toolSchemaHash=${manifest.toolSchemaHash.slice(0, 16)}…`);
  console.log(`  userPromptRendererHash=${manifest.userPromptRendererHash.slice(0, 16)}…`);
  console.log(`  outputParserHash=${manifest.outputParserHash.slice(0, 16)}…`);
}

// 写回 registry
writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n", "utf-8");

console.log(`\n[baseline-init] 完成：${updated} 个 active 版本已填充 bundleManifest`);
console.log(`[baseline-init] registry 已更新: ${REGISTRY_PATH}`);
console.log(`[baseline-init] 下一步运行 drift check 验证基线: node scripts/prompt-registry-drift-check.mjs`);
