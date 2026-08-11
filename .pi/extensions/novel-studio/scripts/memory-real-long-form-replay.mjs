/**
 * MEMORY-7 真实长程连续生成 replay（REAL-QUALITY-6）
 *
 * 目标（docs/memory-layer-baseline.md §4.3）：建立真实 20/50/100 章连续生产 replay，
 * 验证长期记忆在真实模型连续生成中不持续失真。与 memory-long-form-replay.mjs（确定性
 * 模拟）的区别：本脚本调用 runUnifiedPipeline 经真实模型（默认 Gemini 3.1 Pro Preview）
 * 连续生成章节，逐章保存正文 + FinalStateCommit，window 边界对 narrative-state-store.json
 * 做 MEMORY-7 硬事实零漂移验证。
 *
 * 设计（基于用户授权：先 20 章试点 + 脚本内置 seed 剧情）：
 * - 脚手架完整 workspace（config.json + CORE-WRITING-PRINCIPLES + WORLDBUILDING-CANON
 *   + styles/profile + characters + series/outline），内置确定性剧情基准（叶尘/林婉儿/苏影，
 *   碎星剑、道侣、苏影陨落），作为 CanonState 的 ground truth。
 * - 逐章调用 runUnifiedPipeline（真实模型；replay 属实验验证，PINOVEL_DEV_MODE=1 绕过
 *   生产交付门禁，不交付正式生产正文）。
 * - 每个 window 边界读取 narrative-state-store.json，验证硬事实零漂移与 MEMORY-7 指标。
 *
 * 用法：
 *   node scripts/memory-real-long-form-replay.mjs --max-chapters=1   # 单章 smoke
 *   node scripts/memory-real-long-form-replay.mjs --max-chapters=20  # 20 章试点
 *   node scripts/memory-real-long-form-replay.mjs --windows=20,50,100
 *
 * 输出：
 *   {repo_root}/reports/memory-real-long-form/memory-real-long-form-replay.json / .md
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = join(__dirname, "..");
const PROJECT_ROOT = join(EXT_ROOT, "..", "..", "..");

// ── 参数解析 ──
const maxArg = process.argv.find((a) => a.startsWith("--max-chapters="));
const MAX_CHAPTERS = maxArg ? parseInt(maxArg.split("=")[1], 10) : 20;
const windowsArg = process.argv.find((a) => a.startsWith("--windows="));
const WINDOWS = windowsArg
  ? windowsArg.split("=")[1].split(",").map((s) => parseInt(s.trim(), 10))
  : [20, 50, 100];

const WORKSPACE_ID = "memory-real-replay";
const WS_ROOT = join(EXT_ROOT, "workspaces", WORKSPACE_ID);
const REPORT_DIR = join(PROJECT_ROOT, "reports", "memory-real-long-form");

// ── 确定性剧情基准（ground truth；与 memory-long-form-replay.mjs 同口径） ──
const GENRE = "仙侠世界";
const CHARACTERS = ["叶尘", "林婉儿", "苏影"];

// ============================================================================
// Workspace 脚手架
// ============================================================================

function scaffoldWorkspace() {
  rmSync(WS_ROOT, { recursive: true, force: true });
  mkdirSync(join(WS_ROOT, "chapters"), { recursive: true });
  mkdirSync(join(WS_ROOT, "characters"), { recursive: true });
  mkdirSync(join(WS_ROOT, "series"), { recursive: true });
  mkdirSync(join(WS_ROOT, "styles"), { recursive: true });
  mkdirSync(join(WS_ROOT, "worldbuilding"), { recursive: true });

  const config = {
    name: "MEMORY-7 真实长程连续生成 replay",
    genre: "仙侠",
    subGenres: ["东方玄幻"],
    totalChapters: 100,
    chapterType: "standard",
    styleProfile: "memory-real-replay-author",
    serialFrequency: "daily",
    characters: CHARACTERS.map((name, i) => ({
      id: `char-${i + 1}`,
      name,
      role: i === 0 ? "protagonist" : "supporting",
    })),
    worldKeyTerms: {
      factions: ["青云宗", "魔渊"],
      places: ["青云山", "落霞谷"],
      currencies: ["碎星剑"],
      professions: ["剑修", "炼丹师"],
      specialAbilities: ["尘心诀", "御剑术"],
      levels: ["练气（初期/中期/巅峰）", "筑基（初期/中期/巅峰）"],
    },
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
    chapterSeeds: {
      default: {
        choicesAndCosts: [
          { choice: "接受传承", cost: "暴露身份" },
        ],
        expectedIrreversibleChange: ["叶尘接受传承后无法维持普通身份"],
        causalEndPressure: ["传承激活引来追踪者"],
      },
    },
    targetWordCount: {
      perChapter: { min: 1500, max: 2500 },
      total: 150000,
    },
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(WS_ROOT, "config.json"), JSON.stringify(config, null, 2), "utf-8");
  writeFileSync(
    join(WS_ROOT, "series", "outline.md"),
    [
      "# 大纲",
      "",
      "## 世界观",
      `这个世界是${GENRE}。主角团成员：叶尘、林婉儿、苏影。`,
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
      id: "memory-real-replay-author",
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
// 状态读取与硬事实验证
// ============================================================================

function computeSha12(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

function loadNarrativeState() {
  const path = join(WS_ROOT, "narrative-state-store.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

/**
 * 从 narrative-state-store 提取当前有效 Canon 事实（按 memoryType=canon / kind=canon）。
 * 返回 key → value 映射。
 */
function extractCanonFacts(state) {
  const canon = {};
  const entries = state?.canon ?? state?.canonState ?? [];
  for (const e of entries) {
    const key = e.key ?? e.id ?? e.payload?.data?.key ?? e.memoryId;
    const value = e.value ?? e.fact ?? e.payload?.data?.value;
    if (key && value !== undefined) canon[key] = value;
  }
  return canon;
}

/**
 * MEMORY-7 硬事实零漂移验证（window 边界）。
 * ground truth 为脚本内置的确定性剧情基准；验证 CanonState 中这些事实不变。
 */
function verifyWindow(state, windowEnd) {
  const issues = [];
  const canon = extractCanonFacts(state);

  const expects = [
    { key: "world_genre", contains: "仙侠", label: "世界观" },
    { key: "identity:叶尘", contains: "叶尘", label: "叶尘身份" },
    { key: "identity:林婉儿", contains: "林婉儿", label: "林婉儿身份" },
    { key: "identity:苏影", contains: "苏影", label: "苏影身份" },
  ];
  for (const exp of expects) {
    const found = Object.entries(canon).some(([k, v]) =>
      (k.includes(exp.key) || k.includes(exp.key.replace("identity:", "")))
      && String(v).includes(exp.label)
    );
    if (!found) {
      issues.push({ metric: "硬事实缺失/漂移", detail: `${exp.label} 在 ch${windowEnd} 应存在于 CanonState` });
    }
  }
  return issues;
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
  console.log(`[memory-real-replay] 真实长程连续生成 replay 启动`);
  console.log(`[memory-real-replay] 章节数=${MAX_CHAPTERS}, 窗口=${WINDOWS.join(",")}, workspace=${WORKSPACE_ID}`);

  // 生产交付门禁：replay 属实验验证，以 DEV_MODE 绕过生产交付门禁，不交付正式正文。
  process.env.PINOVEL_DEV_MODE = "1";
  // 真实模型：不设 V2_FORCE_STUB。默认 writerModel=gemini31（v2_rawstage2_gemini31 / v2_amplified_gemini31）。
  delete process.env.V2_FORCE_STUB;

  scaffoldWorkspace();
  console.log(`[memory-real-replay] 已脚手架 workspace：${WS_ROOT}`);

  const { runUnifiedPipeline } = await import("../dist/v2/core/unified-entry.js");

  const chapterResults = [];
  const windowReports = [];
  const sortedWindows = [...WINDOWS].filter((w) => w <= MAX_CHAPTERS).sort((a, b) => a - b);
  let windowIdx = 0;
  let allClean = true;
  let okCount = 0;
  let blockedCount = 0;

  for (let ch = 1; ch <= MAX_CHAPTERS; ch++) {
    const chapterId = `ch${ch}`;
    const start = Date.now();
    let result;
    try {
      result = await runUnifiedPipeline({
        workspaceId: WORKSPACE_ID,
        chapterId,
        chapterNumber: ch,
        projectRoot: EXT_ROOT,
        candidateTimeoutMs: 600000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      chapterResults.push({ chapter: ch, status: "throw", error: msg, durationMs: Date.now() - start });
      blockedCount++;
      console.error(`[memory-real-replay] ch${ch} 抛异常：${msg}`);
      continue;
    }

    const durationMs = Date.now() - start;
    if (result.status === "ok") {
      okCount++;
      console.log(`[memory-real-replay] ch${ch} ok (${durationMs}ms) text=${result.text?.length ?? 0} chars`);
    } else {
      blockedCount++;
      const fe = result.failureEnvelope;
      console.log(`[memory-real-replay] ch${ch} ${result.status} (${durationMs}ms) fe=${fe?.stage ?? "?"}/${fe?.gate ?? "?"}`);
    }
    chapterResults.push({
      chapter: ch,
      status: result.status,
      failureStage: result.failureEnvelope?.stage ?? null,
      failureGate: result.failureEnvelope?.gate ?? null,
      textLength: result.text?.length ?? 0,
      durationMs,
    });

    // window 边界：基于"当时状态快照"验证（此时尚未提交未来章节）
    if (windowIdx < sortedWindows.length && ch === sortedWindows[windowIdx]) {
      const state = loadNarrativeState();
      const issues = state ? verifyWindow(state, ch) : [{ metric: "状态缺失", detail: `ch${ch} 无 narrative-state-store.json` }];
      const clean = issues.length === 0;
      if (!clean) allClean = false;
      windowReports.push({ window: ch, clean, issueCount: issues.length, issues });
      windowIdx++;
    }
  }

  const finalState = loadNarrativeState();
  const report = {
    schema: "memory-real-long-form-replay/v1",
    timestamp: new Date().toISOString(),
    mode: "real-model-generation",
    workspaceId: WORKSPACE_ID,
    totalChapters: MAX_CHAPTERS,
    windows: sortedWindows,
    okCount,
    blockedCount,
    chapterResults,
    windowReports,
    finalCanonCount: finalState ? (finalState.canon?.length ?? 0) : 0,
    allClean,
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, "memory-real-long-form-replay.json"), JSON.stringify(report, null, 2));

  let md = `# MEMORY-7 真实长程连续生成 replay 报告\n\n`;
  md += `> **模式**：真实模型生成（${report.mode}）\n`;
  md += `> **时间**：${report.timestamp}\n`;
  md += `> **章节数**：${report.totalChapters}，窗口：${report.windows.join("/")} 章\n\n`;
  md += `## 汇总\n\n`;
  md += `| 指标 | 值 |\n|---|---|\n`;
  md += `| 成功章节 | ${report.okCount} |\n`;
  md += `| 阻断章节 | ${report.blockedCount} |\n`;
  md += `| 最终 Canon 条目数 | ${report.finalCanonCount} |\n`;
  md += `| 全部窗口通过 | ${report.allClean ? "是" : "否"} |\n\n`;
  md += `## 逐窗口验收\n\n`;
  for (const w of windowReports) {
    md += `### ${w.window} 章窗口\n\n`;
    md += `- 通过：${w.clean ? "✅" : "❌"}\n`;
    md += `- 问题数：${w.issueCount}\n`;
    if (w.issueCount > 0) {
      for (const issue of w.issues) md += `  - [${issue.metric}] ${issue.detail}\n`;
    }
    md += `\n`;
  }
  writeFileSync(join(REPORT_DIR, "memory-real-long-form-replay.md"), md);

  for (const w of windowReports) {
    console.log(`[memory-real-replay] ${w.window}章窗口: ${w.clean ? "通过" : `失败(${w.issueCount}问题)`}`);
  }
  console.log(`[memory-real-replay] 成功=${okCount} 阻断=${blockedCount} 全部窗口${allClean ? "通过" : "未通过"}`);
  console.log(`[memory-real-replay] 报告写到 ${join(REPORT_DIR, "memory-real-long-form-replay.json")} / .md`);
}

main().catch((err) => {
  console.error("[memory-real-replay] 主流程异常：", err);
  process.exit(1);
});