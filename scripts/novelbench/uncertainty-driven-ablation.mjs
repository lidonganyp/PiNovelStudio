#!/usr/bin/env node
/**
 * 不确定性驱动检索决策 A/B 对照实验 CLI
 *
 * 第一轮最小实验：在 eval-only 路径比较 A 组（强制跨源检索）与 B 组（不确定性驱动检索）。
 * 不改生产链路：retrievalPromptOverride 生产路径全链路 undefined。
 *
 * 模式：
 * - --stub：离线 stub 模式（不调用真实 API），用于 CI 与框架验证
 * - 默认（无 --stub）：真实模式（REQUIRES_AUTH，需提供 API env）
 *
 * 用法：
 *   node scripts/novelbench/uncertainty-driven-ablation.mjs \
 *     --cases <path.json> \
 *     --output <dir> \
 *     [--route v2_rawstage2] \
 *     [--timeout 120000] \
 *     [--stub] \
 *     [--help]
 *
 * 必填参数：
 *   --cases <path.json>    ablation case set JSON 文件路径
 *   --output <dir>         结果输出目录
 *
 * 可选参数：
 *   --route <route>        模型路由名（默认 v2_rawstage2）
 *   --timeout <ms>         单臂超时 ms（默认 120000）
 *   --stub                 使用 stub 模式（不调用真实 API）
 *   --help                 显示本帮助
 *
 * 真实模式环境变量（REQUIRES_AUTH）：
 *   UNCERTAINTY_ABLATION_API_KEY    API Key
 *   UNCERTAINTY_ABLATION_BASE_URL   API Base URL
 *   UNCERTAINTY_ABLATION_MODEL      模型名（如 gemini-3.1-pro-preview）
 *
 * 退出码：
 *   0  实验完成（无论 passed 与否）
 *   1  实验运行失败（参数错误 / API 错误等）
 */

import { parseArgs } from "node:util";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(__filename, "..", "..", "..");
const EXT_ROOT = join(PROJECT_ROOT, ".pi", "extensions", "novel-studio");
const MODULE_PATH = join(EXT_ROOT, "dist-eval", "novelos", "eval", "uncertainty-driven-ablation.js");
const STATS_PATH = join(EXT_ROOT, "dist-eval", "novelos", "eval", "uncertainty-statistics.js");
const ADAPTER_PATH = join(EXT_ROOT, "dist-eval", "v2", "adapters", "legacy-model-route-adapter.js");

const { values } = parseArgs({
  options: {
    "cases": { type: "string" },
    "output": { type: "string" },
    "route": { type: "string", default: "v2_rawstage2" },
    "timeout": { type: "string", default: "120000" },
    "seeds": { type: "string", default: "1" },
    "temperature": { type: "string", default: "0.72" },
    "stub": { type: "boolean", default: false },
    "help": { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`不确定性驱动检索决策 A/B 对照实验 CLI

用法：
  node scripts/novelbench/uncertainty-driven-ablation.mjs \\
    --cases <path.json> \\
    --output <dir> \\
    [--route v2_rawstage2] \\
    [--timeout 120000] \\
    [--seeds 1] \\
    [--temperature 0.72] \\
    [--stub] \\
    [--help]

必填参数：
  --cases <path.json>    ablation case set JSON 文件路径
  --output <dir>         结果输出目录

可选参数：
  --route <route>        模型路由名（默认 v2_rawstage2）
  --timeout <ms>         单臂超时 ms（默认 120000）
  --seeds <n>            多 seed 实验种子数（默认 1，单 seed 不写聚合报告）
  --temperature <f>      采样温度（默认 0.72，Step 3 起可固定以分离随机性）
  --stub                 使用 stub 模式（不调用真实 API）
  --help                 显示本帮助

模式说明：
  --stub     离线 stub 模式，不调用任何 API（用于 CI 与框架验证）
  默认       真实模式（REQUIRES_AUTH），需提供：
             UNCERTAINTY_ABLATION_API_KEY / UNCERTAINTY_ABLATION_BASE_URL / UNCERTAINTY_ABLATION_MODEL

退出码：
  0  实验完成（无论 passed 与否）
  1  实验运行失败（参数错误 / API 错误等）
`);
  process.exit(0);
}

if (!values.cases) {
  process.stderr.write("错误：缺少必填参数 --cases\n");
  process.exit(1);
}
if (!values.output) {
  process.stderr.write("错误：缺少必填参数 --output\n");
  process.exit(1);
}

const caseSetPath = resolve(values.cases);
const outputDir = resolve(values.output);
const route = values.route;
const timeoutMs = parseInt(values.timeout, 10);
const seeds = Math.max(1, parseInt(values.seeds, 10));
const temperature = parseFloat(values.temperature);
const isStub = values.stub;

if (!existsSync(caseSetPath)) {
  process.stderr.write(`错误：case set 文件不存在：${caseSetPath}\n`);
  process.exit(1);
}

// ── 动态 import 模块 ──────────────────────────────────────────────────────

const mod = await import(`file://${MODULE_PATH}`);

const cases = mod.loadAblationCases(caseSetPath);

process.stderr.write(`[uncertainty-ablation] 加载 case set：${cases.length} cases\n`);
process.stderr.write(`[uncertainty-ablation] 路由：${route}\n`);
process.stderr.write(`[uncertainty-ablation] 超时：${timeoutMs}ms\n`);
process.stderr.write(`[uncertainty-ablation] seeds：${seeds}\n`);
process.stderr.write(`[uncertainty-ablation] temperature：${temperature}\n`);
process.stderr.write(`[uncertainty-ablation] 模式：${isStub ? "stub（离线）" : "real（REQUIRES_AUTH）"}\n`);

mkdirSync(outputDir, { recursive: true });

let modelGenerate;

if (isStub) {
  // stub 模式：用 createStubModelGenerateFn
  process.env.V2_FORCE_STUB = "1";
  const adapter = await import(`file://${ADAPTER_PATH}`);
  modelGenerate = adapter.createStubModelGenerateFn();
} else {
  // 真实模式：从 env 构造 fetch-based modelGenerate
  // 自动从 .env 加载（回退到 GEMINI_* 配置，与第一轮实验保持一致）
  function loadEnvFile() {
    const envPath = join(PROJECT_ROOT, ".env");
    if (!existsSync(envPath)) return;
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  }
  loadEnvFile();

  // R2 起支持 GLM_* 回退，遵循项目硬约束"临时测试只用 GLM/Doubao"。
  // 优先级：UNCERTAINTY_ABLATION_* > GLM_* > GEMINI_*（GEMINI 保留为历史第一轮兼容）。
  const apiKey =
    process.env.UNCERTAINTY_ABLATION_API_KEY || process.env.GLM_API_KEY || process.env.GEMINI_API_KEY;
  const baseUrl =
    process.env.UNCERTAINTY_ABLATION_BASE_URL ||
    process.env.GLM_BASE_URL ||
    process.env.GOOGLE_GEMINI_BASE_URL;
  const modelName =
    process.env.UNCERTAINTY_ABLATION_MODEL || process.env.GLM_MODEL || process.env.GEMINI_MODEL;
  if (!apiKey || !baseUrl || !modelName) {
    process.stderr.write(
      "错误：真实模式需要 UNCERTAINTY_ABLATION_API_KEY / BASE_URL / MODEL（或 GLM_API_KEY / GLM_BASE_URL / GLM_MODEL 回退）\n",
    );
    process.exit(1);
  }
  process.stderr.write(`[uncertainty-ablation] API model: ${modelName}\n`);
  process.stderr.write(`[uncertainty-ablation] API base: ${baseUrl}\n`);

  // 构造最小 ModelGenerateFn（OpenAI 兼容格式）
  // 项目硬约束：502/503/429/网络错误重试 10 次，3 秒间隔；10 次失败后才返回超时
  // 诊断模式：通过 UNCERTAINTY_ABLATION_MAX_RETRIES env 覆盖（默认 10）
  const MAX_RETRIES = Number(process.env.UNCERTAINTY_ABLATION_MAX_RETRIES) || 10;
  const RETRY_INTERVAL_MS = 3000;
  // Cloudflare 网关超时（520/521/522/523/524）属于网络传输层错误，按项目硬约束重试。
  // xianxia-1 A 组失败根因：API 524 未在重试集合中，导致直接 hard block。
  const RETRYABLE_STATUS = new Set([429, 502, 503, 504, 520, 521, 522, 523, 524]);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 单次 HTTP 调用。返回 { ok, status, json, errText }。
   * 网络异常视为可重试。
   */
  async function singleCall(url, headers, bodyObj, perCallTimeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perCallTimeoutMs);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(bodyObj),
        signal: controller.signal,
      });
      if (resp.ok) {
        const json = await resp.json();
        return { ok: true, status: resp.status, json };
      }
      const errText = await resp.text().catch(() => "");
      return { ok: false, status: resp.status, errText };
    } catch (err) {
      // 网络异常 / abort / DNS 失败：视为可重试
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 0, errText: `network_error: ${msg}` };
    } finally {
      clearTimeout(timer);
    }
  }

  modelGenerate = async (input) => {
    const start = Date.now();
    // ModelGenerateInput 接口（legacy-model-route-adapter.ts:31-60）：
    // - systemPrompt: string（系统提示词）
    // - userPrompt: string（用户提示词，字符串，不是 messages 数组）
    // - kind: string（候选 kind）
    // - maxTokens?: number
    // - route: string
    // ReAct 桥接（pi-agent-core-adapter.ts:142-148）：调用方传 systemPrompt + userPrompt，
    // 不传 tools/toolChoice/messages。工具调用通过文本指令 <tool_call> 解析，非 native function calling。
    //
    // ModelGenerateOutput 接口（legacy-model-route-adapter.ts:62-95）：
    // 必填：text, model, route, durationMs
    // 可选：finishReason, maxTokens, provider, requestedRoute, tokenUsage
    // 无 toolCalls 字段（ReAct 文本指令由 adapter 解析）
    const systemPrompt = input.systemPrompt ?? "";
    const userPrompt = input.userPrompt ?? "";
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];
    const maxTokens = input.maxTokens ?? 8192;
    // Step 3：temperature/seed 从 input 读取（由 per-seed wrapper 注入），
    // input 未设置时回退到 CLI 参数 temperature（默认 0.72）。
    // seed 仅在 input.seed !== undefined 时传入（多 seed 实验分离生成随机性）。
    const effectiveTemperature = input.temperature ?? temperature;
    const body = {
      model: modelName,
      messages,
      max_tokens: maxTokens,
      temperature: effectiveTemperature,
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
    };

    // 诊断日志：记录请求结构（只第一次调用记录完整结构，避免刷屏）
    const bodyStr = JSON.stringify(body);
    const isFirstCall = !globalThis.__ablationLoggedFirstCall;
    if (isFirstCall) {
      globalThis.__ablationLoggedFirstCall = true;
      process.stderr.write(`\n[ablation-model] 首次请求诊断：\n`);
      process.stderr.write(`  body 大小: ${bodyStr.length} 字符\n`);
      process.stderr.write(`  messages 数: ${messages.length}\n`);
      process.stderr.write(`  max_tokens: ${body.max_tokens}\n`);
      process.stderr.write(`  system 长度: ${systemPrompt.length}\n`);
      process.stderr.write(`  user 长度: ${userPrompt.length}\n`);
      process.stderr.write(`  user 预览: ${userPrompt.slice(0, 100)}...\n`);
      // 保存完整请求到文件供分析
      const diagPath = join(outputDir, "_diagnostic-first-request.json");
      try {
        mkdirSync(dirname(diagPath), { recursive: true });
        writeFileSync(diagPath, bodyStr, "utf-8");
        process.stderr.write(`  完整请求已保存: ${diagPath}\n\n`);
      } catch (e) {
        process.stderr.write(`  (保存诊断文件失败: ${e.message})\n\n`);
      }
    }

    const url = baseUrl.endsWith("/chat/completions")
      ? baseUrl
      : `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    };
    const perCallTimeoutMs = Math.min(timeoutMs, 180000);

    let lastErrText = "";
    let lastStatus = 0;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const r = await singleCall(url, headers, body, perCallTimeoutMs);
      if (r.ok) {
        const choice = r.json.choices?.[0];
        return {
          text: choice?.message?.content ?? "",
          model: r.json.model ?? modelName,
          route: input.route,
          durationMs: Date.now() - start,
          provider: "custom",
          ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
          ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
          tokenUsage: r.json.usage
            ? { in: r.json.usage.prompt_tokens ?? 0, out: r.json.usage.completion_tokens ?? 0 }
            : "unknown",
        };
      }
      lastStatus = r.status;
      lastErrText = r.errText ?? "";
      const retryable = r.status === 0 || RETRYABLE_STATUS.has(r.status);
      if (!retryable) {
        throw new Error(`API ${r.status}: ${lastErrText.slice(0, 200)}`);
      }
      if (attempt < MAX_RETRIES) {
        process.stderr.write(
          `[ablation-model] 第 ${attempt}/${MAX_RETRIES} 次失败 (status=${r.status})，${RETRY_INTERVAL_MS}ms 后重试...\n`,
        );
        await sleep(RETRY_INTERVAL_MS);
      }
    }
    throw new Error(
      `接口调用超时：${MAX_RETRIES} 次重试后仍失败 (last_status=${lastStatus}, last_err=${lastErrText.slice(0, 120)})`,
    );
  };
}

// ── 运行实验 ──────────────────────────────────────────────────────────────
// 多 seed 支持（Step 3）：对每个 case 跑 N 个 seed。
// 每个 seed 注入 seed 值 + 固定 temperature，分离检索策略收益与生成随机性。
// 每个 seed 的结果保存到 outputDir/seed-{N}/，最终聚合报告保存到 outputDir/。
// 聚合统计使用 computeMultiSeedStatistics（Wilson 区间 + 符号检验 + meanStd）。

try {
  const statsMod = await import(`file://${STATS_PATH}`);
  const seedResults = [];
  for (let s = 1; s <= seeds; s++) {
    const seedDir = seeds > 1 ? join(outputDir, `seed-${s}`) : outputDir;
    mkdirSync(seedDir, { recursive: true });
    process.stderr.write(`\n[uncertainty-ablation] === Seed ${s}/${seeds} (temperature=${temperature}) ===\n`);
    // Step 3：per-seed wrapper 注入 seed + temperature 到 ModelGenerateInput。
    // baseModelGenerate（stub 或 real）从 input.temperature/input.seed 读取。
    // wrapModelGenerateWithRoute 在 runAblationArm 内部 spread ...input，保留这两个字段。
    const seedModelGenerate =
      (input) => modelGenerate({ ...input, temperature, seed: s });
    const result = await mod.runAblation({
      cases,
      modelGenerate: seedModelGenerate,
      generateRoute: route,
      timeoutMs,
      outputDir: seedDir,
    });
    seedResults.push({ seed: s, result, seedDir });
  }

  // 多 seed 聚合报告（Step 3：使用 computeMultiSeedStatistics）
  if (seeds > 1) {
    const multiStats = statsMod.computeMultiSeedStatistics(
      seedResults.map((sr) => sr.result),
    );
    const aggReportPath = join(outputDir, "multi-seed-report.md");
    const reportLines = [
      "# 多 seed 聚合报告",
      "",
      `**Seeds**：${seeds}`,
      `**Case 数**：${cases.length}`,
      `**Temperature**：${temperature}`,
      `**时间**：${new Date().toISOString()}`,
      "",
      "## 每 seed 通过条件",
      "",
      "| Seed | 成功率(A) | 成功率(B) | avgToolCalls(A) | avgToolCalls(B) | avgFactGuardErrors(A) | avgFactGuardErrors(B) | overallPassed |",
      "|------|----------|----------|-----------------|-----------------|----------------------|----------------------|---------------|",
    ];
    for (const sr of seedResults) {
      const a = sr.result.aggregate.armA;
      const b = sr.result.aggregate.armB;
      reportLines.push(
        `| ${sr.seed} | ${a.successCount}/${cases.length} | ${b.successCount}/${cases.length} | ${a.avgToolCalls.toFixed(2)} | ${b.avgToolCalls.toFixed(2)} | ${a.avgFactGuardErrors.toFixed(2)} | ${b.avgFactGuardErrors.toFixed(2)} | ${sr.result.passCriteria.overallPassed ? "PASS" : "FAIL"} |`,
      );
    }

    // Step 3：统计聚合（meanStd + Wilson + 符号检验）
    reportLines.push("", "## 跨 seed 统计聚合（computeMultiSeedStatistics）", "");
    reportLines.push(`- passRate（overallPassed）：${(multiStats.passRate * 100).toFixed(1)}%`);
    reportLines.push("");
    reportLines.push("### B 组胜率与置信区间");
    reportLines.push("");
    reportLines.push("| 指标 | bWinRate | Wilson 95% CI | 单侧符号检验 p | A 组 mean±std | B 组 mean±std |");
    reportLines.push("|------|----------|---------------|---------------|---------------|---------------|");
    const metricRows = [
      ["toolCalls", "avgToolCalls", "avgToolCalls"],
      ["factGuardErrors", "avgFactGuardErrors", "avgFactGuardErrors"],
      ["coverage", "avgCoverage", "avgCoverage"],
    ];
    for (const [key, aKey, bKey] of metricRows) {
      const winRate = multiStats.bWinRate[key];
      const ci = multiStats.wilsonInterval[key];
      const pVal = multiStats.signTestPValue[key];
      const msA = multiStats.meanStd[`${aKey}A`];
      const msB = multiStats.meanStd[`${bKey}B`];
      reportLines.push(
        `| ${key} | ${(winRate * 100).toFixed(1)}% | [${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}] | ${pVal.toFixed(4)} | ${msA.mean.toFixed(2)}±${msA.std.toFixed(2)} | ${msB.mean.toFixed(2)}±${msB.std.toFixed(2)} |`,
      );
    }
    reportLines.push("");
    reportLines.push("> toolCalls/factGuardErrors：B < A 为胜（越低越好）；coverage：B > A 为胜（越高越好）。");
    reportLines.push("> 单侧符号检验 H0: B 不优于 A；p<0.05 视为显著。Wilson 95% CI 不含 0.5 视为显著。");
    writeFileSync(aggReportPath, reportLines.join("\n") + "\n", "utf-8");
    process.stderr.write(`[uncertainty-ablation] 多 seed 聚合报告：${aggReportPath}\n`);

    // 保存原始统计 JSON
    const statsJsonPath = join(outputDir, "multi-seed-statistics.json");
    writeFileSync(statsJsonPath, JSON.stringify(multiStats, null, 2), "utf-8");
    process.stderr.write(`[uncertainty-ablation] 多 seed 统计 JSON：${statsJsonPath}\n`);
  }

  const lastResult = seedResults[seedResults.length - 1].result;
  process.stderr.write(`\n[uncertainty-ablation] 最低通过条件：${lastResult.passCriteria.overallPassed ? "PASS" : "FAIL"}\n`);
  const lastDir = seedResults[seedResults.length - 1].seedDir;
  process.stderr.write(`[uncertainty-ablation] 报告：${join(lastDir, "comparison-report.md")}\n`);
  process.stderr.write(`[uncertainty-ablation] 盲测包：${join(lastDir, "blind-pack.json")}\n`);

  process.exit(0);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[uncertainty-ablation] 实验运行失败：${msg}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(err.stack + "\n");
  }
  process.exit(1);
}
