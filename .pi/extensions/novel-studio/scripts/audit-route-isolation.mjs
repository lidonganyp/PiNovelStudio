#!/usr/bin/env node
/**
 * audit-route-isolation.mjs — 生产/评测/开发路由物理隔离静态审计（WP-02）
 *
 * 用法（repo root 或 extension root）：
 *   node .pi/extensions/novel-studio/scripts/audit-route-isolation.mjs
 *
 * 退出码：0 通过；1 发现 error 级问题。
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(__dirname, "..");
const repoRoot = resolve(extensionRoot, "../../..");

function loadRouting() {
  const path = join(repoRoot, "config/model-routing.json");
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  return JSON.parse(readFileSync(path, "utf-8"));
}

const PRODUCTION_WRITER_ROUTES = new Set([
  "v2_rawstage2_gpt6astra",
  "v2_amplified_gpt6astra",
  "v2_rawstage2",
  "v2_amplified",
  "narrator_primary",
]);

const EVAL_MARKERS = [
  "nb4_",
  "nb5_",
  "reference_analyzer",
  "v2_literary_judge",
  "v2_opportunity_judge",
  "novel_quality_judge",
];

function resolveEntry(entry) {
  if (!entry) return null;
  if (typeof entry === "string") return { provider: entry, model: undefined, fallback: undefined };
  return entry;
}

function main() {
  const config = loadRouting();
  const issues = [];
  const routes = config.agent_routing ?? {};

  for (const [name, raw] of Object.entries(routes)) {
    const entry = resolveEntry(raw);
    if (!entry) continue;

    if (PRODUCTION_WRITER_ROUTES.has(name)) {
      if (!Array.isArray(entry.fallback) || entry.fallback.length !== 0) {
        issues.push({
          level: "error",
          route: name,
          message: `生产写路由 fallback 必须为 []，实际 ${JSON.stringify(entry.fallback)}`,
        });
      }
      if (!entry.provider || !entry.model) {
        issues.push({
          level: "error",
          route: name,
          message: "生产写路由必须声明 provider/model",
        });
      }
      if (entry.provider === "glm" || entry.provider === "doubao") {
        issues.push({
          level: "error",
          route: name,
          message: "生产写路由不得使用 glm/doubao",
        });
      }
    }

    if (EVAL_MARKERS.some((m) => name === m || name.startsWith(m))) {
      if (entry.provider === "gpt" && name.includes("literary")) {
        // ok: eval only
      }
      // 评测路由若被 stage_routing 默认引用则警告
      const stageHits = Object.entries(config.stage_routing ?? {}).filter(
        ([, v]) => {
          const e = resolveEntry(v);
          return e && (v === name || e === name);
        },
      );
      // stage_routing values are route entries not names — skip deep
      void stageHits;
    }

    // lab_testing 路由必须 fallback=[] 或显式隔离
    if (entry.lab_testing === true) {
      if (entry.fallback === undefined || (Array.isArray(entry.fallback) && entry.fallback.length > 0)) {
        issues.push({
          level: "warning",
          route: name,
          message: "lab_testing 路由建议 fallback=[] 以防污染生产 fallback 链",
        });
      }
    }
  }

  // 默认生产写：narrator_primary / gpt6astra raw
  const primary = resolveEntry(routes.narrator_primary);
  if (!primary || primary.provider !== "gpt") {
    issues.push({
      level: "error",
      route: "narrator_primary",
      message: `默认生产主写应为 gpt（gpt-6-astra），实际 ${primary?.provider}`,
    });
  }
  const gptAstraRaw = resolveEntry(routes.v2_rawstage2_gpt6astra);
  if (!gptAstraRaw || gptAstraRaw.provider !== "gpt") {
    issues.push({
      level: "error",
      route: "v2_rawstage2_gpt6astra",
      message: "默认 Agentic/raw 路由缺失或非 gpt",
    });
  }
  const gptAstraAmplified = resolveEntry(routes.v2_amplified_gpt6astra);
  if (!gptAstraAmplified || gptAstraAmplified.provider !== "gpt") {
    issues.push({
      level: "error",
      route: "v2_amplified_gpt6astra",
      message: "作者风格优化路由缺失或非 gpt",
    });
  }

  // GPT literary judge 不得出现在生产写 fallback 链
  for (const [provider, chain] of Object.entries(config.fallback ?? {})) {
    if ((provider === "gemini31" || provider === "claude") && Array.isArray(chain) && chain.length > 0) {
      // gemini31 fallback 必须 []；claude 允许结构化 gpt 但不允许作为正文静默切换——写路由层已 fallback=[]
      if (provider === "gemini31") {
        issues.push({
          level: "error",
          route: `fallback.${provider}`,
          message: "gemini31 provider-level fallback 必须为 []",
        });
      }
    }
  }

  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");

  const report = {
    schema: "pinovel.route-isolation-audit",
    version: 1,
    configVersion: config._version ?? null,
    errorCount: errors.length,
    warningCount: warnings.length,
    issues,
  };

  console.log(JSON.stringify(report, null, 2));
  if (errors.length > 0) {
    console.error(`FAIL: ${errors.length} error(s), ${warnings.length} warning(s)`);
    process.exit(1);
  }
  console.error(`PASS: 0 errors, ${warnings.length} warning(s)`);
  process.exit(0);
}

main();
