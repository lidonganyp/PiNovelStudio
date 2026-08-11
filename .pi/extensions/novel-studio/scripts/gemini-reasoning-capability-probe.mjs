#!/usr/bin/env node
/**
 * GEMINI-REASONING-CAPABILITY-PROBE：验证 Gemini 3.1 Pro Preview OpenAI-compatible 端点
 * 是否接受并真正生效 reasoning effort / thinking budget 参数。
 *
 * 约束：
 *   - eval-only，不修改生产路由、不进入 novel_generate_chapter 路径
 *   - 直接调用 Gemini OpenAI-compatible 端点（/v1beta/openai/chat/completions）
 *   - 使用固定代表性 evidence_decision 风格 prompt
 *   - 多配置 × 多采样，记录 usage / latency / finish_reason / output hash
 *
 * 用法：
 *   node scripts/gemini-reasoning-capability-probe.mjs --samples 3
 *   node scripts/gemini-reasoning-capability-probe.mjs --samples 3 --output reports/reasoning-budget-baseline
 *
 * 选项：
 *   --samples <n>      每个配置的采样次数（默认 3）
 *   --output <dir>     报告输出目录（默认 reports/reasoning-budget-baseline）
 *   --configs <list>   逗号分隔的配置名（默认全部）
 *   --help             打印帮助
 *
 * ⚠️  本脚本发起真实 Gemini API 调用，产生真实费用。
 *     运行前必须获得用户对预估成本的确认。
 */
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── .env 加载（与 probe-gemini-health.mjs / index.ts 一致的手动解析）────────
// 探测脚本是独立进程，不经过 index.ts，必须自行加载 .env。
const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = resolve(__filename, "..");
const EXTENSION_ROOT = resolve(SCRIPT_DIR, "..");
const PROJECT_ROOT = resolve(EXTENSION_ROOT, "..", "..", "..");
const ENV_PATH = join(PROJECT_ROOT, ".env");
try {
  const envContent = readFileSync(ENV_PATH, "utf-8");
  for (const line of envContent.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {
  // .env 不存在时静默跳过（依赖环境变量已在外部设置）
}

const { values } = parseArgs({
  options: {
    "samples": { type: "string", default: "3" },
    "output": { type: "string" },
    "configs": { type: "string" },
    "help": { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`Gemini reasoning-control capability probe (eval-only)

用法：
  node scripts/gemini-reasoning-capability-probe.mjs --samples 3

选项：
  --samples <n>      每个配置的采样次数（默认 3）
  --output <dir>     报告输出目录
  --configs <list>   逗号分隔的配置名（默认全部）
  --help             打印帮助

⚠️ 本脚本发起真实 Gemini API 调用，产生真实费用。
`);
  process.exit(0);
}

const OUTPUT_DIR = values.output
  ? resolve(values.output)
  : join(PROJECT_ROOT, "reports", "reasoning-budget-baseline");

const SAMPLES = Math.max(1, parseInt(values.samples, 10) || 3);

// ── Gemini 端点解析 ──────────────────────────────────────────────────────
// 优先使用 GOOGLE_GEMINI_BASE_URL（第三方代理，OpenAI 兼容 /v1/chat/completions 路径），
// 与生产 fallback-manager.ts 的 getBaseUrl("google_gemini") 一致。
// 无代理时回退到 Google 官方 OpenAI 兼容端点 /v1beta/openai/chat/completions。
const GEMINI_PROXY_BASE = process.env.GOOGLE_GEMINI_BASE_URL;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-pro-preview";
const API_KEY = process.env.GEMINI_API_KEY;

let GEMINI_ENDPOINT;
if (GEMINI_PROXY_BASE) {
  // 代理走 OpenAI 标准路径 /v1/chat/completions
  const base = GEMINI_PROXY_BASE.replace(/\/+$/, "");
  GEMINI_ENDPOINT = `${base}/v1/chat/completions`;
} else {
  // Google 官方 OpenAI 兼容端点
  GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
}

if (!API_KEY) {
  console.error("GEMINI_API_KEY 环境变量未设置");
  process.exit(1);
}

// 超时控制：与生产 PINOVEL_MODEL_REQUEST_TIMEOUT_MS 一致，默认 300000ms
const REQUEST_TIMEOUT_MS = parseInt(process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS || "300000", 10);

function log(msg) {
  process.stderr.write(`[capability-probe] ${msg}\n`);
}

// ── 固定代表性 evidence_decision 风格 prompt ─────────────────────────────
// 模拟真实 evidence_decision 的结构化 JSON 输出任务，但不包含任何 workspace 私有内容。
const SYSTEM_PROMPT = [
  "你是证据检索规划助手。你只输出一份结构化 JSON 检索决策，",
  "不生成正文、不修改已知事实、不执行工具。输出必须是一个合法 JSON 对象。",
].join("\n");

const USER_PROMPT = [
  "## 本章意图",
  "本章需要推进主角进入新场景，验证前章留下的关键悬念，并引入一个次要角色的视角转变。",
  "",
  "## 已知事实（不可违背）",
  "- 主角当前位于过渡场景，与前章末尾的位置一致",
  "- 一个关键道具已在两章前出现，本章需要验证其状态",
  "- 次要角色的动机在前章已暗示但未明说",
  "- 世界观规则：特定能力有使用代价，不可无限制施展",
  "",
  "## 需要验证的事实",
  "1. 主角从当前位置到目标场景的路径是否合理",
  "2. 关键道具的状态是否与前章一致",
  "3. 次要角色是否能合理出现在目标场景",
  "4. 能力使用的代价是否符合世界观设定",
  "5. 时间线是否与前章末尾衔接",
  "",
  "## 可用工具",
  "- search_characters: 检索角色档案和状态",
  "- search_locations: 检索地点信息",
  "- search_timeline: 检索时间线事件",
  "- search_world_rules: 检索世界观规则",
  "- search_items: 检索道具信息",
  "",
  "## 输出格式",
  "输出一个 JSON 对象，包含以下字段：",
  '- "queries": 数组，每个元素包含 { "tool": "工具名", "query": "检索内容", "reason": "检索理由" }',
  '- "priority": "high" | "medium" | "low"，表示检索优先级',
  '- "notes": 字符串，补充说明',
  "",
  "请基于以上信息，规划本轮证据检索决策。",
].join("\n");

// ── 测试配置 ────────────────────────────────────────────────────────────
// 每个配置代表一种 reasoning control 参数组合。
// config.extra 是追加到请求 body 的字段（OpenAI-compatible 端点接受额外字段）。
const ALL_CONFIGS = {
  "baseline": {
    label: "无 reasoning control（当前生产行为）",
    extra: {},
  },
  "reasoning_effort_low": {
    label: "reasoning_effort=low（OpenAI 兼容映射 thinking_level=low）",
    extra: { reasoning_effort: "low" },
  },
  "reasoning_effort_medium": {
    label: "reasoning_effort=medium（Gemini 3.1 新增中档）",
    extra: { reasoning_effort: "medium" },
  },
  "reasoning_effort_high": {
    label: "reasoning_effort=high（Deep Think Mini）",
    extra: { reasoning_effort: "high" },
  },
  "thinking_budget_0": {
    label: "thinking_budget=0（禁用 thinking，Gemini 2.5 兼容参数）",
    extra: { thinking_budget: 0 },
  },
  "thinking_budget_1024": {
    label: "thinking_budget=1024（限制 thinking 到 1024 token）",
    extra: { thinking_budget: 1024 },
  },
  "reasoning_effort_low_maxtok_512": {
    label: "reasoning_effort=low + max_tokens=512（组合测试）",
    extra: { reasoning_effort: "low" },
    maxTokensOverride: 512,
  },
};

const configNames = values.configs
  ? values.configs.split(",").map((s) => s.trim()).filter(Boolean)
  : Object.keys(ALL_CONFIGS);

const configs = {};
for (const name of configNames) {
  if (ALL_CONFIGS[name]) {
    configs[name] = ALL_CONFIGS[name];
  } else {
    log(`未知配置: ${name}，跳过`);
  }
}

if (Object.keys(configs).length === 0) {
  console.error("无有效配置");
  process.exit(1);
}

const totalCalls = Object.keys(configs).length * SAMPLES;
log(`配置数: ${Object.keys(configs).length}, 每配置采样: ${SAMPLES}, 总调用: ${totalCalls}`);
log(`模型: ${GEMINI_MODEL}`);
log(`端点: ${GEMINI_ENDPOINT}`);
log(`预估成本: 见设计文档`);

// ── 单次调用 ────────────────────────────────────────────────────────────
async function callGemini(configName, config, sampleIndex) {
  const maxTokens = config.maxTokensOverride ?? 512; // 与生产 evidence_decision 一致
  const requestBody = {
    model: GEMINI_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: USER_PROMPT },
    ],
    max_tokens: maxTokens,
    temperature: 0.72, // 与 v2_rawstage2_gemini31 一致
    ...config.extra,
  };

  const startMs = Date.now();
  let response, error = null;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    response = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(requestBody),
      signal: ctrl.signal,
    });
  } catch (err) {
    error = err;
  } finally {
    clearTimeout(timeout);
  }

  const elapsedMs = Date.now() - startMs;

  if (error) {
    const errMsg = error.name === "AbortError" ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : error.message;
    return {
      config: configName,
      sample: sampleIndex,
      status: "network_error",
      error: errMsg,
      elapsedMs,
      requestBody: { ...requestBody, Authorization: "[redacted]" },
    };
  }

  if (!response.ok) {
    const errorBody = await response.text();
    return {
      config: configName,
      sample: sampleIndex,
      status: "http_error",
      httpStatus: response.status,
      error: errorBody.substring(0, 500),
      elapsedMs,
      requestBody: { ...requestBody, Authorization: "[redacted]" },
    };
  }

  const data = await response.json();
  const usage = data.usage || {};
  const message = data.choices?.[0]?.message || {};
  const content = message.content || "";
  const finishReason = data.choices?.[0]?.finish_reason || "";

  return {
    config: configName,
    sample: sampleIndex,
    status: "ok",
    elapsedMs,
    finishReason,
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      completion_tokens_details: usage.completion_tokens_details || null,
      prompt_tokens_details: usage.prompt_tokens_details || null,
    },
    outputHash: createHash("sha256").update(content).digest("hex"),
    outputLength: content.length,
    outputPreview: content.substring(0, 200),
    outputIsJson: (() => {
      try { JSON.parse(content); return true; } catch { return false; }
    })(),
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────────
log("\n=== 开始 capability probe ===\n");

const results = [];
for (const [configName, config] of Object.entries(configs)) {
  log(`\n--- 配置: ${configName} ---`);
  log(`  ${config.label}`);
  for (let i = 0; i < SAMPLES; i++) {
    log(`  采样 ${i + 1}/${SAMPLES}...`);
    const result = await callGemini(configName, config, i);
    results.push(result);
    if (result.status === "ok") {
      const u = result.usage;
      const reasoning = u.completion_tokens_details?.reasoning_tokens;
      const cached = u.prompt_tokens_details?.cached_tokens;
      log(`    ✓ 耗时=${result.elapsedMs}ms completion=${u.completion_tokens} reasoning=${reasoning ?? "N/A"} cached=${cached ?? "N/A"} json=${result.outputIsJson}`);
    } else {
      log(`    ✗ ${result.status}: ${result.error?.substring(0, 100)}`);
    }
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────────
const summary = {
  probeType: "gemini-reasoning-control-capability",
  evalOnly: true,
  model: GEMINI_MODEL,
  endpoint: GEMINI_ENDPOINT,
  systemPromptHash: createHash("sha256").update(SYSTEM_PROMPT).digest("hex"),
  userPromptHash: createHash("sha256").update(USER_PROMPT).digest("hex"),
  configuredMaxTokens: 512,
  configuredTemperature: 0.72,
  samplesPerConfig: SAMPLES,
  totalCalls,
  configs: Object.fromEntries(
    Object.entries(configs).map(([k, v]) => [k, { label: v.label, extra: v.extra, maxTokensOverride: v.maxTokensOverride ?? null }])
  ),
  results,
  aggregatedAt: new Date().toISOString(),
};

// 聚合每配置统计
const perConfig = {};
for (const r of results) {
  const bucket = perConfig[r.config] || (perConfig[r.config] = {
    config: r.config,
    ok: 0, errors: 0,
    completionTokens: [], reasoningTokens: [], cachedTokens: [],
    promptTokens: [], elapsedMs: [], jsonValid: 0,
  });
  if (r.status === "ok") {
    bucket.ok += 1;
    bucket.completionTokens.push(r.usage.completion_tokens ?? 0);
    bucket.reasoningTokens.push(r.usage.completion_tokens_details?.reasoning_tokens ?? 0);
    bucket.cachedTokens.push(r.usage.prompt_tokens_details?.cached_tokens ?? 0);
    bucket.promptTokens.push(r.usage.prompt_tokens ?? 0);
    bucket.elapsedMs.push(r.elapsedMs);
    if (r.outputIsJson) bucket.jsonValid += 1;
  } else {
    bucket.errors += 1;
  }
}

const avg = (arr) => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : 0;
const min = (arr) => arr.length ? Math.min(...arr) : 0;
const max = (arr) => arr.length ? Math.max(...arr) : 0;

summary.perConfig = Object.values(perConfig).map((b) => ({
  config: b.config,
  ok: b.ok,
  errors: b.errors,
  jsonValid: b.jsonValid,
  promptTokens: { avg: avg(b.promptTokens), min: min(b.promptTokens), max: max(b.promptTokens) },
  completionTokens: { avg: avg(b.completionTokens), min: min(b.completionTokens), max: max(b.completionTokens) },
  reasoningTokens: { avg: avg(b.reasoningTokens), min: min(b.reasoningTokens), max: max(b.reasoningTokens) },
  cachedTokens: { avg: avg(b.cachedTokens), min: min(b.cachedTokens), max: max(b.cachedTokens) },
  elapsedMs: { avg: avg(b.elapsedMs), min: min(b.elapsedMs), max: max(b.elapsedMs) },
}));

// 写入报告
mkdirSync(OUTPUT_DIR, { recursive: true });
const jsonPath = join(OUTPUT_DIR, "capability-probe.json");
writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");

// Markdown 摘要
const L = [];
L.push("# Gemini Reasoning-Control Capability Probe");
L.push("");
L.push("- **eval-only**：不修改生产路由、不进入 novel_generate_chapter 路径");
L.push(`- 模型: \`${GEMINI_MODEL}\``);
L.push(`- 端点: \`${GEMINI_ENDPOINT}\``);
L.push(`- 每配置采样: ${SAMPLES}，总调用: ${totalCalls}`);
L.push(`- 固定 max_tokens=512, temperature=0.72（与生产 evidence_decision 一致）`);
L.push("");
L.push("## 每配置汇总");
L.push("");
L.push("| 配置 | ok | json有效 | prompt avg | completion avg (min-max) | reasoning avg | cached avg | 延迟 avg (min-max) ms |");
L.push("|------|------|------|------|------|------|------|------|");
for (const c of summary.perConfig) {
  const ct = c.completionTokens;
  const el = c.elapsedMs;
  L.push(`| ${c.config} | ${c.ok}/${SAMPLES} | ${c.jsonValid}/${c.ok} | ${c.promptTokens.avg} | ${ct.avg} (${ct.min}-${ct.max}) | ${c.reasoningTokens.avg || "N/A"} | ${c.cachedTokens.avg || "N/A"} | ${el.avg} (${el.min}-${el.max}) |`);
}
L.push("");
L.push("## 关键判定");
L.push("");
// 自动判定：reasoning_effort 是否改变 completion_tokens / reasoning_tokens
const baseline = summary.perConfig.find((c) => c.config === "baseline");
if (baseline) {
  for (const c of summary.perConfig) {
    if (c.config === "baseline") continue;
    const compDelta = c.completionTokens.avg - baseline.completionTokens.avg;
    const reasonDelta = (c.reasoningTokens.avg || 0) - (baseline.reasoningTokens.avg || 0);
    const latencyDelta = c.elapsedMs.avg - baseline.elapsedMs.avg;
    L.push(`- **${c.config}** vs baseline: completion ${compDelta >= 0 ? "+" : ""}${compDelta}, reasoning ${reasonDelta >= 0 ? "+" : ""}${reasonDelta}, 延迟 ${latencyDelta >= 0 ? "+" : ""}${latencyDelta}ms`);
  }
}
L.push("");
L.push("> 判定标准：");
L.push("> 1. 参数被接受（非 http_error）且 JSON 输出有效 → 端点兼容该参数");
L.push("> 2. reasoning_tokens 或 completion_tokens 相对 baseline 有显著变化 → 参数真正生效");
L.push("> 3. JSON 输出有效性保持 → 参数不破坏结构化输出");

const mdPath = join(OUTPUT_DIR, "capability-probe.md");
writeFileSync(mdPath, L.join("\n"), "utf-8");

log(`\n=== 完成 ===`);
log(`报告: ${jsonPath}`);
log(`摘要: ${mdPath}`);
