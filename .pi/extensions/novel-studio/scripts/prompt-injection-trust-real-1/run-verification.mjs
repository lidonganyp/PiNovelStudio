#!/usr/bin/env node
/**
 * PROMPT-INJECTION-TRUST-ARCHITECTURE-1 — 真实 API 验收脚本（REQUIRES_AUTH）
 *
 * 验证两项此前未覆盖的真实生产证据：
 *   1. 非 stub 的真实 novel_generate_chapter replay（runUnifiedPipeline + 真实模型）
 *   2. batch 并发 + 异步模型/工具回调下的 ALS（AsyncLocalStorage）归属隔离
 *
 * 用法：
 *   node scripts/prompt-injection-trust-real-1/run-verification.mjs [--model-test-route=glm|doubao|gpt56|claude48|fable5|grok45]
 *   node scripts/prompt-injection-trust-real-1/run-verification.mjs --single   # 仅单次真实 replay（跳过并发）
 *
 * 模型选择：
 *   生产默认 writer 为 Gemini 3.1 Pro（本机不可达：fetch failed，见 check-model-providers）。
 *   本脚本默认 modelTestRoute=glm（glm-5.2，健康检查 2028ms OK），走真实网络模型调用，
 *   同时保留完整生产路径（ContextCompiler → audit session → ALS 包裹 → 真实模型 → 原子保存 + trace）。
 *
 * 边界：
 *   - PINOVEL_DEV_MODE=1 绕过发行治理门禁（非生产开发模式）
 *   - 不设 V2_FORCE_STUB，真实网络模型调用
 *   - 使用临时 workspace（REPO_ROOT/workspaces/{id}），finally 清理
 *   - 不硬编码任何密钥（.env 手动加载，仅补齐未设置的键）
 *
 * 退出码：
 *   0 = 无串写（trust 归属全部正确，或无可归属事件）
 *   1 = 检测到串写（trust 事件 runId 与所属 run 不一致）—— 核心安全属性违反
 *   2 = 脚本致命错误（真实模型不可达 / 导入失败）
 */

import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_DIR = __dirname; // <ext>/scripts/prompt-injection-trust-real-1
const EXT_ROOT = join(SCRIPT_DIR, "..", ".."); // <ext> = .pi/extensions/novel-studio
const REPO_ROOT = join(EXT_ROOT, "..", "..", ".."); // repo root
const REPORT_DIR = join(REPO_ROOT, "reports", "prompt-injection-trust-real-1");
const REPORT_PATH = join(REPORT_DIR, "verification-report.md");

// ── 1. 手动加载 .env（与 index.ts 口径一致：仅补齐未设置的键，不覆盖进程已有值）──
function loadEnv() {
  try {
    const raw = readFileSync(join(REPO_ROOT, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].trim();
      }
    }
  } catch {
    // .env 缺失时依赖已存在的 process.env
  }
}
loadEnv();

// ── 2. 环境开关 ──
process.env.PINOVEL_DEV_MODE = "1"; // 绕过发行治理门禁（非生产开发模式）
delete process.env.V2_FORCE_STUB; // 确保真实网络模型，非 stub
if (!process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS) {
  process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS = "120000"; // 单次请求 120s 上界
}

// ── 3. 解析参数 ──
const argv = process.argv.slice(2);
const VALID_MODELS = ["glm", "doubao", "gpt56", "claude48", "fable5", "grok45"];
function parseFlag(name) {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  if (hit === `--${name}`) return "true";
  return hit.split("=")[1];
}
const modelTestRoute = VALID_MODELS.includes(parseFlag("model-test-route")) ? parseFlag("model-test-route") : "glm";
const singleOnly = argv.includes("--single");

// ── 4. 动态 import 编译产物（真实生产入口；相对 specifier 避开 Windows 绝对路径 ESM 限制）──
const { runUnifiedPipeline } = await import(
  "../../dist/v2/core/unified-entry.js"
);

// ── 5. workspace fixture（与生产闭包11 / audit-run-pipeline-integration 一致）──
function makeWorkspace(workspaceId) {
  const wsPath = join(REPO_ROOT, "workspaces", workspaceId);
  mkdirSync(join(wsPath, "chapters"), { recursive: true });
  mkdirSync(join(wsPath, "characters"), { recursive: true });
  mkdirSync(join(wsPath, "series"), { recursive: true });
  mkdirSync(join(wsPath, "styles"), { recursive: true });
  writeFileSync(
    join(wsPath, "config.json"),
    JSON.stringify(
      {
        name: "Trust Real Replay",
        genre: "玄幻",
        subGenres: ["东方玄幻"],
        totalChapters: 10,
        chapterType: "standard",
        styleProfile: "trust-author",
        serialFrequency: "daily",
        characters: [{ id: "p1", name: "叶尘", role: "protagonist" }],
        chapterSeeds: {
          default: {
            choicesAndCosts: [{ choice: "接受传承", cost: "暴露身份" }],
            expectedIrreversibleChange: ["无法回到普通人身份"],
            causalEndPressure: ["追踪者逼近"],
          },
        },
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
  );
  writeFileSync(join(wsPath, "series", "outline.md"), "# 大纲\n## 第1章\n开始。\n", "utf-8");
  writeFileSync(join(wsPath, "characters", "叶尘.md"), "# 叶尘\n主角。\n", "utf-8");
  writeFileSync(
    join(wsPath, "styles", "profile.json"),
    JSON.stringify({
      id: "trust-author",
      kind: "fingerprint",
      usagePolicy: { fullChapterOptimization: "required" },
      editorialGuidance: ["动作优先。"],
    }),
    "utf-8",
  );
  return wsPath;
}

function cleanupWorkspace(workspaceId) {
  const wsPath = join(REPO_ROOT, "workspaces", workspaceId);
  try {
    rmSync(wsPath, { recursive: true, force: true });
  } catch {
    // 清理失败不阻断
  }
}

// ── 6. 单次真实 replay：跑 runUnifiedPipeline 并抽取 trust 归属证据 ──
async function runOne({ workspaceId, chapterId, chapterNumber }) {
  makeWorkspace(workspaceId);
  const output = await runUnifiedPipeline({
    workspaceId,
    chapterId,
    chapterNumber,
    projectRoot: REPO_ROOT,
    modelTestRoute,
  });

  const auditRun = output.stageResults?.auditRun;
  const modelCalls = Array.isArray(output.stageResults?.modelCalls)
    ? output.stageResults.modelCalls
    : [];

  let allEvents = [];
  let trustEvents = [];
  let eventsReadError = null;
  if (auditRun?.eventsPath && existsSync(auditRun.eventsPath)) {
    try {
      const lines = readFileSync(auditRun.eventsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      allEvents = lines.map((l) => JSON.parse(l));
      trustEvents = allEvents.filter(
        (e) => e.eventType === "custom" && e.payload?.eventTypeHint === "trust_decision",
      );
    } catch (err) {
      eventsReadError = err instanceof Error ? err.message : String(err);
    }
  }

  const runId = auditRun?.runId ?? null;
  const misattributed = trustEvents.filter(
    (e) => (e.payload?.runId ?? e.runId) !== runId,
  );
  const crossWorkspace = trustEvents.filter(
    (e) => e.payload?.workspaceId && e.payload.workspaceId !== workspaceId,
  );

  // 真实模型调用证据（成功路径 modelCalls 有 provider/model/durationMs；失败路径 requestedRoute/provider）
  const realCalls = modelCalls
    .map((c) => ({
      route: c?.requestedRoute ?? c?.route ?? null,
      provider: c?.provider ?? c?.usedProvider ?? null,
      model: c?.model ?? c?.usedModel ?? null,
      durationMs: c?.durationMs ?? c?.durationMs ?? null,
      ok: c?.error == null,
      error: c?.error ?? null,
    }));

  return {
    workspaceId,
    chapterId,
    status: output.status,
    textLength: output.text?.length ?? 0,
    failureEnvelope: output.failureEnvelope
      ? {
          stage: output.failureEnvelope.stage,
          gate: output.failureEnvelope.gate,
          severity: output.failureEnvelope.severity,
          reason: output.failureEnvelope.reason,
          recoverable: output.failureEnvelope.recoverable,
        }
      : null,
    runId,
    auditEnabled: auditRun?.enabled ?? false,
    eventsPath: auditRun?.eventsPath ?? null,
    eventsCount: allEvents.length,
    trustCount: trustEvents.length,
    misattributedCount: misattributed.length,
    crossWorkspaceCount: crossWorkspace.length,
    terminalEvent: allEvents.some((e) =>
      ["run_finished", "run_failed", "run_interrupted"].includes(e.eventType),
    ),
    startedEvent: allEvents.some((e) => e.eventType === "run_started"),
    eventsReadError,
    realCalls,
    trustDecisionTypes: trustEvents.map((e) => e.payload?.decisionType ?? null),
  };
}

// ── 7. 报告构建 ──
function buildReport({ mode, modelTestRoute, singleResult, concurrentResults }) {
  const lines = [];
  lines.push("# PROMPT-INJECTION-TRUST-REAL-1 验收报告（真实 API）");
  lines.push("");
  lines.push(`- 运行模式：\`${mode}\``);
  lines.push(`- modelTestRoute：\`${modelTestRoute}\``);
  lines.push(`- 生产 writer（Gemini 3.1 Pro）本机可达性：\`fetch failed\`（见 check-model-providers），故用 GLM 真实模型验证信任归属（归属机制与模型无关）`);
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push("");

  const fmtRun = (r) => {
    const seg = [];
    seg.push(`### ${r.workspaceId}/${r.chapterId}`);
    seg.push("");
    seg.push(`- status: \`${r.status}\``);
    seg.push(`- runId: \`${r.runId}\``);
    seg.push(`- auditEnabled: ${r.auditEnabled}`);
    seg.push(`- eventsPath: \`${r.eventsPath}\``);
    seg.push(`- eventsCount: ${r.eventsCount}`);
    seg.push(`- trustCount: ${r.trustCount}`);
    seg.push(`- startedEvent: ${r.startedEvent}`);
    seg.push(`- terminalEvent: ${r.terminalEvent}`);
    seg.push(`- misattributedCount: ${r.misattributedCount}`);
    seg.push(`- crossWorkspaceCount: ${r.crossWorkspaceCount}`);
    if (r.textLength > 0) seg.push(`- textLength: ${r.textLength}`);
    if (r.failureEnvelope) {
      seg.push(`- failureEnvelope: stage=${r.failureEnvelope.stage} gate=${r.failureEnvelope.gate} severity=${r.failureEnvelope.severity} recoverable=${r.failureEnvelope.recoverable}`);
      seg.push(`  - reason: ${r.failureEnvelope.reason}`);
    }
    if (r.trustDecisionTypes.length) {
      seg.push(`- trustDecisionTypes: ${r.trustDecisionTypes.join(", ")}`);
    }
    if (r.eventsReadError) seg.push(`- eventsReadError: ${r.eventsReadError}`);
    if (r.realCalls.length) {
      seg.push("- realCalls:");
      for (const c of r.realCalls) {
        seg.push(`  - route=${c.route} provider=${c.provider} model=${c.model} durationMs=${c.durationMs} ok=${c.ok}${c.error ? ` error=${c.error}` : ""}`);
      }
    } else {
      seg.push("- realCalls: （无 modelCalls 记录，说明可能未到达真实模型调用）");
    }
    seg.push("");
    return seg.join("\n");
  };

  lines.push("## 单次真实 replay");
  lines.push("");
  lines.push(fmtRun(singleResult));

  if (concurrentResults) {
    lines.push("## batch 并发（2 并发真实 replay）");
    lines.push("");
    lines.push(`- 两 run 是否同 runId：\`${concurrentResults[0].runId === concurrentResults[1].runId}\``);
    lines.push("");
    lines.push(fmtRun(concurrentResults[0]));
    lines.push(fmtRun(concurrentResults[1]));
    lines.push("### 并发隔离结论");
    lines.push("");
    const cross = concurrentResults.reduce((acc, r) => acc + r.misattributedCount + r.crossWorkspaceCount, 0);
    if (cross === 0) {
      lines.push("- ✅ 无串写：所有 trust 事件 runId/workspaceId 均归属自身 run。");
    } else {
      lines.push(`- ❌ 检测到 ${cross} 个串写事件（跨 run 或跨 workspace）。`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(`- 脚本：\`scripts/prompt-injection-trust-real-1/run-verification.mjs\``);
  return lines.join("\n");
}

// ── 8. 主入口 ──
async function main() {
  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });

  console.log(`[TRUST-REAL-1] modelTestRoute=${modelTestRoute} mode=${singleOnly ? "single" : "single+concurrent"}`);

  const created = new Set();
  let singleResult;
  let concurrentResults;

  try {
    // 单次真实 replay
    const singleWs = `ws-trust-real-1-${Date.now().toString(36)}`;
    created.add(singleWs);
    console.log(`[TRUST-REAL-1] 单次真实 replay: ${singleWs}/ch1`);
    singleResult = await runOne({
      workspaceId: singleWs,
      chapterId: "ch1",
      chapterNumber: 1,
    });
    console.log(
      `[TRUST-REAL-1] 单次结果: status=${singleResult.status} runId=${singleResult.runId} trustCount=${singleResult.trustCount} misattributed=${singleResult.misattributedCount} realCalls=${singleResult.realCalls.length}`,
    );

    if (!singleOnly) {
      // batch 并发：2 个独立 workspace/chapter 同时跑真实 pipeline
      const wsA = `ws-trust-real-a-${Date.now().toString(36)}`;
      const wsB = `ws-trust-real-b-${Date.now().toString(36)}`;
      created.add(wsA);
      created.add(wsB);
      console.log(`[TRUST-REAL-1] batch 并发: ${wsA}/ch1 与 ${wsB}/ch1 同时`);
      const [ra, rb] = await Promise.all([
        runOne({ workspaceId: wsA, chapterId: "ch1", chapterNumber: 1 }),
        runOne({ workspaceId: wsB, chapterId: "ch1", chapterNumber: 1 }),
      ]);
      concurrentResults = [ra, rb];
      console.log(
        `[TRUST-REAL-1] 并发结果: A(status=${ra.status}, trust=${ra.trustCount}, misattributed=${ra.misattributedCount}) B(status=${rb.status}, trust=${rb.trustCount}, misattributed=${rb.misattributedCount})`,
      );
    }
  } finally {
    for (const ws of created) cleanupWorkspace(ws);
  }

  const report = buildReport({
    mode: singleOnly ? "single" : "single+concurrent",
    modelTestRoute,
    singleResult,
    concurrentResults,
  });
  writeFileSync(REPORT_PATH, report, "utf-8");
  console.log(`[TRUST-REAL-1] 报告: ${REPORT_PATH}`);

  // 核心安全断言：任何 run 不得含异 run/异 workspace 的 trust 事件
  const totalMisattributed = (concurrentResults ?? [])
    .concat(singleResult)
    .reduce((acc, r) => acc + r.misattributedCount + r.crossWorkspaceCount, 0);
  if (totalMisattributed > 0) {
    console.error(`❌ 检测到串写：${totalMisattributed} 个 trust 事件归属错误`);
    process.exit(1);
  }

  console.log("[TRUST-REAL-1] ✅ 无串写（trust 归属隔离验证通过）");
  console.log(
    `[TRUST-REAL-1] 证据边界：${singleResult.trustCount} 个单次 trust 事件` +
      (concurrentResults ? ` + ${concurrentResults[0].trustCount}/${concurrentResults[1].trustCount} 个并发 trust 事件` : "") +
      "；若无 trust 事件，则本 run 未触发 trust 决策（仍需真实决策路径复验）。",
  );
}

main().catch((err) => {
  console.error("❌ 致命错误:", err);
  process.exit(2);
});
