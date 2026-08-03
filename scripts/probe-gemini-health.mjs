/**
 * Gemini API 健康探活脚本 v2（直连，不经过主链路）
 *
 * v2 修正：第三方代理通常用 OpenAI 协议 /v1/chat/completions 路径
 *          （v1 漏了 /v1/ 前缀，导致打到代理首页返回 HTML）
 *
 * 探活目标：
 *   - 第三方代理 /v1/chat/completions（OpenAI 兼容）
 *   - Google 官方 /v1beta/openai/chat/completions（OpenAI 兼容）
 */
import { readFileSync } from "node:fs";

const envContent = readFileSync(".env", "utf-8");
for (const line of envContent.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-pro-preview";
const PROXY_BASE = process.env.GOOGLE_GEMINI_BASE_URL;

console.log("=== Gemini API 健康探活 v2 ===");
console.log(`模型: ${MODEL}`);
console.log(`API Key: ${API_KEY.slice(0, 12)}...${API_KEY.slice(-4)}`);
console.log("");

// 候选路径：第三方代理常见的几种 OpenAI 兼容路径
const proxyCandidates = [
  `${PROXY_BASE}/v1/chat/completions`,
  `${PROXY_BASE}/chat/completions`,
];
const officialUrl = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

async function probe(label, url) {
  const payload = {
    model: MODEL,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 5,
    temperature: 0,
  };
  const start = Date.now();
  console.log(`[${label}] → POST ${url}`);
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 30_000);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(timeout);
    const dur = Date.now() - start;
    const text = await res.text();
    const isHtml = text.trimStart().startsWith("<!doctype") || text.trimStart().startsWith("<html");
    const isJson = text.trimStart().startsWith("{") || text.trimStart().startsWith("[");
    console.log(`[${label}] ← HTTP ${res.status} (${dur}ms) ${isHtml ? "[HTML]" : isJson ? "[JSON]" : "[?]"}`);
    console.log(`[${label}] 响应体前 600 字符:`);
    console.log(text.slice(0, 600));
    console.log("");
    return { status: res.status, dur, ok: res.ok && isJson, isJson, isHtml };
  } catch (err) {
    const dur = Date.now() - start;
    const name = err?.name || "Error";
    const msg = err?.message || String(err);
    console.log(`[${label}] ✗ 失败 (${dur}ms) — ${name}: ${msg}`);
    console.log("");
    return { status: 0, dur, ok: false, error: msg };
  }
}

function diagnose(r) {
  if (!r) return "未知";
  if (r.error) {
    if (r.error.includes("abort")) return "⏱ 30 秒超时（服务端无响应）";
    if (r.error.includes("fetch failed")) return "🌐 fetch failed（网络/DNS/TLS 层失败）";
    return `🌐 ${r.error}`;
  }
  if (r.isHtml) return `⚠️ HTTP ${r.status} 但返回 HTML（路径错误或代理只是网站）`;
  if (r.status === 200) return "✅ 服务可用（返回 JSON）";
  if (r.status === 401) return "🔒 401 Unauthorized（API Key 失效）";
  if (r.status === 403) return "🔒 403 Forbidden（Key 无权限）";
  if (r.status === 429) return "⚠️ 429 限流/配额耗尽";
  if (r.status >= 500) return `🔥 ${r.status} 服务端故障`;
  if (r.status === 400) return "⚠️ 400 Bad Request";
  return `⚠️ HTTP ${r.status}`;
}

console.log("─".repeat(70));
const results = [];
for (const url of proxyCandidates) {
  results.push({ label: `代理 ${url.replace(PROXY_BASE, "")}`, result: await probe("代理", url) });
}
console.log("─".repeat(70));
const officialResult = await probe("Google 官方", officialUrl);
console.log("─".repeat(70));

console.log("\n=== 综合判定 ===");
for (const r of results) {
  console.log(`${r.label}: ${diagnose(r.result)}`);
}
console.log(`Google 官方: ${diagnose(officialResult)}`);

console.log("\n=== 结论 ===");
const proxyOk = results.find((r) => r.result.ok);
if (proxyOk) {
  console.log(`✅ 第三方代理可用（路径 ${proxyOk.label}）——服务已恢复，可重新生成章节。`);
} else if (officialResult.ok) {
  console.log("⚠️ 第三方代理仍异常，Google 官方可用。建议临时改 .env 走官方。");
} else {
  console.log("🔥 所有渠道均不可用。");
  console.log("   详细原因看上方诊断；如持续故障，可临时切 writerModel=claude。");
}
