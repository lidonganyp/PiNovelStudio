#!/usr/bin/env node
/**
 * R34 model provider healthcheck.
 *
 * Pings each configured provider with a single short request and reports
 * status / latency / error code. Does NOT run replay or judge content
 * quality. Use before sampling to confirm providers are alive.
 *
 * Usage:
 *   node scripts/check-model-providers.mjs              # all providers
 *   node scripts/check-model-providers.mjs glm gpt      # subset
 *   node scripts/check-model-providers.mjs --timeout 8000
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ENV_PATH = resolve(ROOT, ".env");
const ROUTING_PATH = resolve(ROOT, "config/model-routing.json");

const argv = process.argv.slice(2);
let timeoutMs = 10000;
const requested = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--timeout") {
    timeoutMs = Number(argv[++i]) || 10000;
  } else if (!arg.startsWith("--")) {
    requested.push(arg.toLowerCase());
  }
}

function loadEnv() {
  const env = {};
  try {
    const raw = readFileSync(ENV_PATH, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  } catch {}
  return { ...process.env, ...env };
}

function loadRouting() {
  return JSON.parse(readFileSync(ROUTING_PATH, "utf8"));
}

async function pingOpenAICompat(baseUrl, apiKey, model) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 4,
        temperature: 0,
      }),
      signal: ctrl.signal,
    });
    const elapsed = Date.now() - start;
    if (!res.ok) {
      const body = await res.text();
      return { status: res.status === 401 || res.status === 403 ? "permanent_error" : "transient_error", latencyMs: elapsed, errorCode: res.status, errorMessage: body.substring(0, 200) };
    }
    return { status: "ok", latencyMs: elapsed };
  } catch (err) {
    return {
      status: err.name === "AbortError" ? "timeout" : "error",
      latencyMs: Date.now() - start,
      errorMessage: String(err).substring(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function pingAnthropic(baseUrl, apiKey, model) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 4,
      }),
      signal: ctrl.signal,
    });
    const elapsed = Date.now() - start;
    if (!res.ok) {
      const body = await res.text();
      return { status: res.status === 401 || res.status === 403 ? "permanent_error" : "transient_error", latencyMs: elapsed, errorCode: res.status, errorMessage: body.substring(0, 200) };
    }
    return { status: "ok", latencyMs: elapsed };
  } catch (err) {
    return {
      status: err.name === "AbortError" ? "timeout" : "error",
      latencyMs: Date.now() - start,
      errorMessage: String(err).substring(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const env = loadEnv();
  const routing = loadRouting();
  const results = [];

  for (const [providerKey, provider] of Object.entries(routing.providers)) {
    if (requested.length > 0 && !requested.includes(providerKey.toLowerCase())) continue;

    const apiKeyEnv = provider.api_key_env;
    const apiKey = env[apiKeyEnv];
    const baseUrl = env[`${providerKey.toUpperCase()}_BASE_URL`] || provider.base_url;
    const model = env[`${providerKey.toUpperCase()}_MODEL`] || provider.model;
    const protocol = provider.protocol || (providerKey === "claude" ? "anthropic" : "openai");

    if (!apiKey) {
      results.push({ provider: providerKey, model, status: "no_api_key", latencyMs: 0, timeoutMs });
      continue;
    }

    const probe = protocol === "anthropic" ? pingAnthropic : pingOpenAICompat;
    const r = await probe(baseUrl, apiKey, model);
    results.push({ provider: providerKey, model, timeoutMs, ...r });
  }

  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), timeoutMs, results }, null, 2));

  const bad = results.filter((r) => r.status !== "ok");
  if (bad.length > 0) {
    console.error(`[healthcheck] ${bad.length}/${results.length} provider(s) unhealthy`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[healthcheck] fatal:", err);
  process.exit(2);
});
