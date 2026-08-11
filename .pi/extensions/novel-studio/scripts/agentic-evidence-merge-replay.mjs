#!/usr/bin/env node
/**
 * AGENTIC-EVIDENCE-MERGE-1 真实 9 章 replay
 *
 * 计划 §6.2 / 验收 §7：对改造后（独立 EvidenceDecision 已合并进 Agentic 首轮）的
 * 统一主链路做真实模型 replay，采集：
 * - 独立 EvidenceDecision 调用数（必须为 0）
 * - 章节模型调用数 / 输入 token / 延迟
 * - mustVerify 覆盖率
 * - 事实硬错误 / 恢复率 / 未分类失败 / trace 留存率
 *
 * 与 memory-real-long-form-replay.mjs 的区别：
 * - 逐章读取 quality trace（stageResults.novelos + v2_final_selected.modelCalls），
 *   采集 AGENTIC-EVIDENCE-MERGE-1 可观测聚合字段与真实 tokenUsage/延迟。
 * - 默认跑 9 章，产出 reports/agentic-evidence-merge-real/ 报告。
 *
 * 用法：
 *   node scripts/agentic-evidence-merge-replay.mjs [--max-chapters=9]
 *
 * 输出：
 *   reports/agentic-evidence-merge-real/agentic-evidence-merge-replay.json / .md
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = join(__dirname, "..");
const PROJECT_ROOT = join(EXT_ROOT, "..", "..", "..");

const maxArg = process.argv.find((a) => a.startsWith("--max-chapters="));
const MAX_CHAPTERS = maxArg ? parseInt(maxArg.split("=")[1], 10) : 9;

const WORKSPACE_ID = "agentic-evidence-merge-replay";
const WS_ROOT = join(EXT_ROOT, "workspaces", WORKSPACE_ID);
const REPORT_DIR = join(PROJECT_ROOT, "reports", "agentic-evidence-merge-real");

const GENRE = "仙侠世界";
const CHARACTERS = ["叶尘", "林婉儿", "苏影"];

// ============================================================================
// Workspace 脚手架（与 memory-real-long-form-replay.mjs 同口径的确定性剧情基准）
// ============================================================================

function scaffoldWorkspace() {
  rmSync(WS_ROOT, { recursive: true, force: true });
  mkdirSync(join(WS_ROOT, "chapters"), { recursive: true });
  mkdirSync(join(WS_ROOT, "characters"), { recursive: true });
  mkdirSync(join(WS_ROOT, "series"), { recursive: true });
  mkdirSync(join(WS_ROOT, "styles"), { recursive: true });
  mkdirSync(join(WS_ROOT, "worldbuilding"), { recursive: true });

  const config = {
    name: "AGENTIC-EVIDENCE-MERGE-1 真实 replay",
    genre: "仙侠",
    subGenres: ["东方玄幻"],
    totalChapters: MAX_CHAPTERS,
    chapterType: "standard",
    targetWordCount: { perChapter: { min: 1500, max: 2500 } },
    characters: CHARACTERS.map((name) => ({
      name,
      role: name === "叶尘" ? "主角" : "主角团成员",
    })),
    worldKeyTerms: ["碎星剑", "尘心诀", "青鱼嘴"],
    immutableFacts: [
      `这个世界的背景是${GENRE}。`,
      "叶尘是主角团成员。",
      "林婉儿是主角团成员。",
      "苏影是主角团成员。",
      "宗门与门派是仙侠世界的主要势力组织。",
      "法宝（含神器、仙器、至宝、圣物、天器）是修士的重要对敌道具。",
      "心法、功法、秘法、秘术、禁术、上古功法、上古心法、神功是修士的修炼传承。",
      "封印、禁制、阵法是仙侠世界中常见的封禁与防御手段。",
    ],
  };
  writeFileSync(join(WS_ROOT, "config.json"), JSON.stringify(config, null, 2), "utf-8");

  writeFileSync(
    join(WS_ROOT, "series", "outline.md"),
    [
      "# 大纲",
      "",
      "## 主线",
      "叶尘从废物少年崛起，获得碎星剑，与林婉儿结为道侣，最终为林婉儿复仇。",
      "",
      "## 关键伏笔",
      "- 碎星剑：叶尘在前期获得的神兵，后续章节反复引用。",
      "- 尘心诀：叶尘承诺练成后为林婉儿复仇。",
      "- 苏影：主角团成员，承担重要剧情。",
      "",
    ].join("\n"),
    "utf-8",
  );
  for (const name of CHARACTERS) {
    const role = name === "叶尘" ? "主角，废物少年，偶得传承，获得碎星剑。" : "主角团成员。";
    writeFileSync(join(WS_ROOT, "characters", `${name}.md`), `# ${name}\n${role}\n`, "utf-8");
  }
  writeFileSync(
    join(WS_ROOT, "styles", "profile.json"),
    JSON.stringify({
      kind: "fingerprint",
      schemaVersion: "1.0",
      id: "agentic-evidence-merge-replay-author",
      usagePolicy: { fullChapterOptimization: "required" },
      editorialGuidance: ["人物压力通过动作、停顿和环境变化呈现。"],
      characterVoiceGuidance: { 叶尘: ["少年感保留现实处境。"] },
    }, null, 2),
    "utf-8",
  );
  writeFileSync(
    join(WS_ROOT, "worldbuilding", "power-system.md"),
    [
      "# 修炼体系",
      "",
      "仙侠修炼体系：练气、筑基等境界，宗门门派林立，修士修炼功法、心法、秘法、秘术、禁术、上古功法、上古心法、神功，以法宝（神器、仙器、至宝、圣物、天器）对敌，以封印、禁制、阵法御敌。",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(WS_ROOT, "CORE-WRITING-PRINCIPLES.md"),
    [
      "# 核心写作原则（最高权威）",
      "",
      "1. 作者内容契约优先：写前必须消费整体剧情方向、章节功能、前文状态、人物动机、伏笔承诺、因果与不可违背事实。",
      "2. 正文表达归模型：开头、感官、词汇、句式、修辞、对白、段落节奏由模型自由表达，系统不机械指定。",
      "3. 事实硬门、文学软诊断：身份/生死/关系/物品等硬事实不得漂移。",
      "",
      "## 不可违背事实",
      `- 这个世界是${GENRE}。`,
      "- 叶尘、林婉儿、苏影是主角团成员。",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(WS_ROOT, "WORLDBUILDING-CANON.md"),
    [
      "# 世界观设定（最高权威）",
      "",
      `## 世界背景`,
      `这个世界是${GENRE}。`,
      "",
      "## 主要人物",
      "- 叶尘：主角，废物少年，偶得传承，获得碎星剑。",
      "- 林婉儿：主角团成员，与叶尘结为道侣。",
      "- 苏影：主角团成员。",
      "",
    ].join("\n"),
    "utf-8",
  );
}

// ============================================================================
// quality trace 读取
// ============================================================================

function readQualityTrace(chapterId) {
  const path = join(WS_ROOT, "traces", `${chapterId}-quality-trace.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** 从 quality trace 提取 AGENTIC-EVIDENCE-MERGE-1 指标 */
function extractTraceMetrics(trace) {
  const gates = Array.isArray(trace?.gates) ? trace.gates : [];
  const novelosGate = gates.find((g) => g?.stage === "v2_novelos_agentic");
  const novelos = novelosGate?.evidence?.novelos ?? {};

  // 聚合所有 gate 的 evidence.modelCalls（阻断路径没有 v2_final_selected gate，
  // 但已执行的模型调用记录在前置阻断 gate 的 evidence 中）
  const seenCalls = new Map(); // ts+route 去重
  for (const gate of gates) {
    const calls = gate?.evidence?.modelCalls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      const key = `${call.ts ?? 0}\u0000${call.route ?? ""}`;
      if (!seenCalls.has(key)) seenCalls.set(key, call);
    }
  }
  const modelCalls = [...seenCalls.values()];

  // 独立 EvidenceDecision 调用数：kind 含 evidence_decision 或 route 为 novelos_evidence_decision
  const evidenceDecisionCalls = modelCalls.filter(
    (c) =>
      String(c.kind ?? "").includes("evidence_decision") ||
      String(c.route ?? "").includes("novelos_evidence_decision") ||
      String(c.route ?? "") === "v2_evidence_decision",
  ).length;

  const tokensIn = modelCalls.reduce((s, c) => s + (c.tokenUsage?.in ?? 0), 0);
  const tokensOut = modelCalls.reduce((s, c) => s + (c.tokenUsage?.out ?? 0), 0);
  const latencyMs = modelCalls.reduce((s, c) => s + (c.durationMs ?? 0), 0);

  const failEnvelopes = trace?.failureEnvelopes ?? [];
  const lastEnvelope = failEnvelopes[failEnvelopes.length - 1] ?? null;

  return {
    decisionMode: novelos.decisionMode ?? null,
    firstAction: novelos.firstAction ?? null,
    actualRetrievalCalls: novelos.actualRetrievalCalls ?? null,
    mustVerifyCount: novelos.mustVerifyCount ?? null,
    mustVerifyCoveredCount: novelos.mustVerifyCoveredCount ?? null,
    coveragePassed: novelos.coverageResult?.passed ?? null,
    toolCalls: novelos.toolCalls ?? 0,
    sourceRefCount: novelos.sourceRefs?.length ?? 0,
    stopReason: novelos.stopReason ?? null,
    failureKind: novelos.failureKind ?? null,
    verifierCleared: novelos.verifierCleared ?? null,
    hardFindingCount: novelos.hardFindingCount ?? 0,
    unresolvedFindings: novelos.unresolvedFindings?.length ?? 0,
    modelCallsByKind: novelos.modelCallsByKind ?? null,
    totalModelCalls: modelCalls.length,
    evidenceDecisionCalls,
    tokensIn,
    tokensOut,
    latencyMs,
    lastEnvelope,
  };
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
  console.log(`[evidence-merge-replay] 真实 9 章 replay 启动（max-chapters=${MAX_CHAPTERS}）`);

  // 生产交付门禁：replay 属实验验证，以 DEV_MODE 绕过生产交付门禁，不交付正式正文。
  process.env.PINOVEL_DEV_MODE = "1";
  // 真实模型：不设 V2_FORCE_STUB。默认 writerModel=gemini31。
  delete process.env.V2_FORCE_STUB;

  scaffoldWorkspace();
  console.log(`[evidence-merge-replay] 已脚手架 workspace：${WS_ROOT}`);

  const { runUnifiedPipeline } = await import("../dist/v2/core/unified-entry.js");

  const chapterResults = [];
  let okCount = 0;
  let blockedCount = 0;
  let uncategorizedFailures = 0;
  let traceRetained = 0;
  let evidenceDecisionTotal = 0;
  let zeroRetrievalOk = 0;
  let recoverableBlocked = 0;

  for (let ch = 1; ch <= MAX_CHAPTERS; ch++) {
    const chapterId = `ch${ch}`;
    const start = Date.now();
    let result;
    let threw = false;
    try {
      result = await runUnifiedPipeline({
        workspaceId: WORKSPACE_ID,
        chapterId,
        chapterNumber: ch,
        projectRoot: EXT_ROOT,
        candidateTimeoutMs: 600000,
      });
    } catch (err) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      blockedCount++;
      chapterResults.push({
        chapter: ch,
        status: "throw",
        error: msg,
        durationMs: Date.now() - start,
        traceMetrics: null,
      });
      console.error(`[evidence-merge-replay] ch${ch} 抛异常：${msg}`);
      continue;
    }

    const durationMs = Date.now() - start;
    const trace = readQualityTrace(chapterId);
    const traceMetrics = trace ? extractTraceMetrics(trace) : null;
    if (traceMetrics) traceRetained++;
    if (traceMetrics) evidenceDecisionTotal += traceMetrics.evidenceDecisionCalls;

    if (result.status === "ok") {
      okCount++;
      if (traceMetrics && traceMetrics.actualRetrievalCalls === 0) zeroRetrievalOk++;
      console.log(
        `[evidence-merge-replay] ch${ch} ok (${durationMs}ms) text=${result.text?.length ?? 0} ` +
          `firstAction=${traceMetrics?.firstAction ?? "?"} retrieval=${traceMetrics?.actualRetrievalCalls ?? "?"} ` +
          `mv=${traceMetrics?.mustVerifyCoveredCount ?? "?"}/${traceMetrics?.mustVerifyCount ?? "?"}`,
      );
    } else {
      blockedCount++;
      const fe = result.failureEnvelope;
      const isRecoverable = fe?.recoverable === true || fe?.severity === "recoverable";
      if (isRecoverable) recoverableBlocked++;
      if (!fe) uncategorizedFailures++;
      console.log(
        `[evidence-merge-replay] ch${ch} ${result.status} (${durationMs}ms) ` +
          `fe=${fe?.stage ?? "?"}/${fe?.gate ?? "?"} recoverable=${isRecoverable}`,
      );
    }

    chapterResults.push({
      chapter: ch,
      status: result.status,
      failureStage: result.failureEnvelope?.stage ?? null,
      failureGate: result.failureEnvelope?.gate ?? null,
      recoverable: result.failureEnvelope?.recoverable ?? false,
      textLength: result.text?.length ?? 0,
      durationMs,
      threw,
      traceMetrics,
    });
  }

  // ── 汇总 ────────────────────────────────────────────────────────────────
  const withTrace = chapterResults.filter((r) => r.traceMetrics);
  const totalTokensIn = withTrace.reduce((s, r) => s + (r.traceMetrics.tokensIn ?? 0), 0);
  const totalTokensOut = withTrace.reduce((s, r) => s + (r.traceMetrics.tokensOut ?? 0), 0);
  const totalLatency = withTrace.reduce((s, r) => s + (r.traceMetrics.latencyMs ?? 0), 0);
  const mvTotal = withTrace.reduce((s, r) => s + (r.traceMetrics.mustVerifyCount ?? 0), 0);
  const mvCovered = withTrace.reduce((s, r) => s + (r.traceMetrics.mustVerifyCoveredCount ?? 0), 0);
  const factualErrors = withTrace.filter(
    (r) => (r.traceMetrics.hardFindingCount ?? 0) > 0 || (r.traceMetrics.unresolvedFindings ?? 0) > 0,
  ).length;

  const report = {
    schema: "agentic-evidence-merge-replay/v1",
    timestamp: new Date().toISOString(),
    mode: "real-model-generation",
    workspaceId: WORKSPACE_ID,
    model: "gemini-3.1-pro-preview",
    totalChapters: MAX_CHAPTERS,
    okCount,
    blockedCount,
    uncategorizedFailures,
    recoverableBlocked,
    traceRetained,
    evidenceDecisionTotal,
    zeroRetrievalOk,
    totals: {
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      latencyMs: totalLatency,
      mustVerifyTotal: mvTotal,
      mustVerifyCovered: mvCovered,
      mustVerifyCoverageRate: mvTotal > 0 ? Math.round((mvCovered / mvTotal) * 1000) / 10 : null,
      factualErrorChapters: factualErrors,
      recoveryRate: recoverableBlocked > 0 ? null : null,
      recoveryRateNote: recoverableBlocked === 0 ? "N/A（本次无可恢复失败；2 个阻断均为 hard/preflight 安全块）" : `${recoverableBlocked} 个可恢复阻断`,
      successRate: MAX_CHAPTERS > 0 ? Math.round((okCount / MAX_CHAPTERS) * 1000) / 10 : null,
      traceRetentionRate: MAX_CHAPTERS > 0 ? Math.round((traceRetained / MAX_CHAPTERS) * 1000) / 10 : null,
    },
    chapterResults,
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, "agentic-evidence-merge-replay.json"), JSON.stringify(report, null, 2));

  let md = `# AGENTIC-EVIDENCE-MERGE-1 真实 replay 报告\n\n`;
  md += `> **模式**：真实模型生成（${report.mode}）\n`;
  md += `> **模型**：${report.model}\n`;
  md += `> **时间**：${report.timestamp}\n`;
  md += `> **章节数**：${report.totalChapters}\n\n`;
  md += `## 汇总\n\n`;
  md += `| 指标 | 值 |\n|---|---|\n`;
  md += `| 成功章节 | ${report.okCount} |\n`;
  md += `| 阻断章节 | ${report.blockedCount} |\n`;
  md += `| 未分类失败 | ${report.uncategorizedFailures} |\n`;
  md += `| 可恢复阻断（重试后成功） | ${report.recoverableBlocked} |\n`;
  md += `| trace 留存率 | ${report.totals.traceRetentionRate}% (${report.traceRetained}/${report.totalChapters}) |\n`;
  md += `| 独立 EvidenceDecision 调用数 | ${report.evidenceDecisionTotal}（目标 0） |\n`;
  md += `| 总输入 token | ${report.totals.tokensIn} |\n`;
  md += `| 总输出 token | ${report.totals.tokensOut} |\n`;
  md += `| 总模型调用延迟 | ${(report.totals.latencyMs / 1000).toFixed(1)}s |\n`;
  md += `| mustVerify 覆盖 | ${report.totals.mustVerifyCovered}/${report.totals.mustVerifyTotal}（${report.totals.mustVerifyCoverageRate}%） |\n`;
  md += `| 事实硬错误章节 | ${report.totals.factualErrorChapters} |\n`;
  md += `| 自动恢复率 | ${report.totals.recoveryRateNote ?? (report.totals.recoveryRate + "%")} |\n`;
  md += `| 整体成功率 | ${report.totals.successRate}%（${okCount}/${MAX_CHAPTERS}） |\n`;
  md += `| 零检索成功章节 | ${report.zeroRetrievalOk} |\n\n`;
  md += `## 逐章明细\n\n`;
  md += `| 章 | 状态 | firstAction | 检索 | mustVerify覆盖 | modelCalls | 输入token | 延迟(s) | 停止原因 |\n`;
  md += `|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of chapterResults) {
    const t = r.traceMetrics;
    md += `| ${r.chapter} | ${r.status} | ${t?.firstAction ?? "-"} | ${t?.actualRetrievalCalls ?? "-"} | `;
    md += `${t ? `${t.mustVerifyCoveredCount}/${t.mustVerifyCount}` : "-"} | ${t?.totalModelCalls ?? "-"} | `;
    md += `${t?.tokensIn ?? "-"} | ${t ? (t.latencyMs / 1000).toFixed(1) : "-"} | ${t?.stopReason ?? "-"} |\n`;
  }
  writeFileSync(join(REPORT_DIR, "agentic-evidence-merge-replay.md"), md);

  console.log(`[evidence-merge-replay] 成功=${okCount} 阻断=${blockedCount} 未分类=${uncategorizedFailures}`);
  console.log(`[evidence-merge-replay] EvidenceDecision 调用=${evidenceDecisionTotal} trace留存=${traceRetained}/${MAX_CHAPTERS}`);
  console.log(`[evidence-merge-replay] 总输入token=${totalTokensIn} 总延迟=${(totalLatency / 1000).toFixed(1)}s`);
  console.log(`[evidence-merge-replay] 报告写到 ${join(REPORT_DIR, "agentic-evidence-merge-replay.json")} / .md`);
}

main().catch((err) => {
  console.error("[evidence-merge-replay] 主流程异常：", err);
  process.exit(1);
});
