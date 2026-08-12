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
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, copyFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = join(__dirname, "..");
const PROJECT_ROOT = join(EXT_ROOT, "..", "..", "..");

const maxArg = process.argv.find((a) => a.startsWith("--max-chapters="));
const MAX_CHAPTERS = maxArg ? parseInt(maxArg.split("=")[1], 10) : 9;
// 独立章节快照模式：每章从干净 workspace 重建并以第 1 章语义独立生成，
// 避免前章失败导致的零调用 preflight 级联污染 9 章对照（AGENTIC-EVIDENCE-MERGE-1 补验）。
const INDEPENDENT = process.argv.includes("--independent");

const WORKSPACE_ID = "agentic-evidence-merge-replay";
const WS_ROOT = join(EXT_ROOT, "workspaces", WORKSPACE_ID);
const REPORT_DIR = join(PROJECT_ROOT, "reports", "agentic-evidence-merge-real");
const TRACE_ARCHIVE_DIR = join(REPORT_DIR, "traces");

const GENRE = "仙侠世界";
const CHARACTERS = ["叶尘", "林婉儿", "苏影"];

// ============================================================================
// 多场景章节定义（9 章多样性，覆盖不同角色/伏笔/上下文密度/检索需求）
// ============================================================================

const CHAPTER_SCENARIOS = [
  {
    // Ch1: 标准开场，上下文充分
    title: "碎星剑觉醒",
    focusCharacter: "叶尘",
    intent: "叶尘在废弃矿洞中意外发现碎星剑，剑中封印残魂传授尘心诀。",
    theme: "机缘与觉醒",
    targetEmotions: ["震撼", "好奇"],
    extraFacts: ["碎星剑中封印着上古剑修残魂。", "尘心诀是碎星剑附带的心法。"],
    extraTerms: ["矿洞", "残魂"],
    sparseContext: false,
  },
  {
    // Ch2: 林婉儿视角，稀疏上下文（可能触发检索）
    title: "暗流涌动",
    focusCharacter: "林婉儿",
    intent: "林婉儿独自调查宗门秘闻，发现碎星剑与宗门历史的隐秘关联。",
    theme: "悬疑与调查",
    targetEmotions: ["悬疑", "紧张"],
    extraFacts: [],
    extraTerms: [],
    sparseContext: true,
  },
  {
    // Ch3: 苏影登场，新角色引入
    title: "神秘来客",
    focusCharacter: "苏影",
    intent: "苏影突然出现在叶尘面前，声称掌握碎星剑的秘密，身份不明。",
    theme: "未知与试探",
    targetEmotions: ["警惕", "好奇"],
    extraFacts: ["苏影来自海外修仙界。"],
    extraTerms: ["海外修仙界"],
    sparseContext: false,
  },
  {
    // Ch4: 修炼瓶颈，跨章引用
    title: "尘心诀的代价",
    focusCharacter: "叶尘",
    intent: "叶尘修炼尘心诀遇到瓶颈，回忆碎星剑残魂的教导，付出代价突破。",
    theme: "坚持与代价",
    targetEmotions: ["坚毅", "痛苦"],
    extraFacts: ["尘心诀修炼会引发经脉灼痛。", "碎星剑残魂名为星陨。"],
    extraTerms: ["经脉", "星陨"],
    sparseContext: false,
  },
  {
    // Ch5: 战斗章节，法宝对敌
    title: "青鱼嘴之战",
    focusCharacter: "叶尘",
    intent: "叶尘在青鱼嘴遭遇敌对修士，首次以碎星剑对敌，险胜。",
    theme: "战斗与成长",
    targetEmotions: ["激烈", "紧张"],
    extraFacts: ["青鱼嘴是宗门附近的险地。", "敌对修士使用的是冰魄飞剑。"],
    extraTerms: ["冰魄飞剑", "青鱼嘴"],
    sparseContext: false,
  },
  {
    // Ch6: 伏笔推进，林婉儿身份
    title: "面具之下",
    focusCharacter: "林婉儿",
    intent: "叶尘发现林婉儿真实身份是敌对宗门弟子，信任动摇但未决裂。",
    theme: "信任与背叛",
    targetEmotions: ["震惊", "纠结"],
    extraFacts: ["林婉儿是天机宗掌门之女。", "天机宗与叶尘所在宗门有世仇。"],
    extraTerms: ["天机宗", "世仇"],
    sparseContext: true,
  },
  {
    // Ch7: 苏影的秘密
    title: "海外来客的真相",
    focusCharacter: "苏影",
    intent: "苏影透露她来寻找碎星剑是为了解除家乡的封印，请求叶尘帮助。",
    theme: "理解与联盟",
    targetEmotions: ["理解", "责任感"],
    extraFacts: ["苏影家乡被上古封印笼罩。", "碎星剑是解除封印的关键之一。"],
    extraTerms: ["上古封印"],
    sparseContext: false,
  },
  {
    // Ch8: 多角色交汇
    title: "三方会盟",
    focusCharacter: "叶尘",
    intent: "叶尘、林婉儿、苏影在碎星剑残魂指引下结成同盟，约定共同目标。",
    theme: "团结与承诺",
    targetEmotions: ["坚定", "信任"],
    extraFacts: ["三方约定在月圆之夜共同行动。", "星陨残魂提供了封印位置线索。"],
    extraTerms: ["月圆之夜"],
    sparseContext: false,
  },
  {
    // Ch9: 高潮，所有元素汇聚
    title: "封印松动",
    focusCharacter: "叶尘",
    intent: "三方合力进攻封印，叶尘以碎星剑+尘心诀破阵，封印松动但未完全解除。",
    theme: "高潮与转折",
    targetEmotions: ["激昂", "悬念"],
    extraFacts: ["封印核心需要碎星剑与尘心诀同时催动。", "破阵时苏影负伤。"],
    extraTerms: ["破阵", "封印核心"],
    sparseContext: false,
  },
];

// ============================================================================
// Workspace 脚手架（与 memory-real-long-form-replay.mjs 同口径的确定性剧情基准）
// ============================================================================

function scaffoldWorkspace(ch) {
  const scenario = CHAPTER_SCENARIOS[(ch - 1) % CHAPTER_SCENARIOS.length] ?? CHAPTER_SCENARIOS[0];
  rmSync(WS_ROOT, { recursive: true, force: true });
  mkdirSync(join(WS_ROOT, "chapters"), { recursive: true });
  mkdirSync(join(WS_ROOT, "characters"), { recursive: true });
  mkdirSync(join(WS_ROOT, "series"), { recursive: true });
  mkdirSync(join(WS_ROOT, "styles"), { recursive: true });
  mkdirSync(join(WS_ROOT, "worldbuilding"), { recursive: true });

  // 基础不可违背事实（所有章节共有）
  const baseFacts = [
    `这个世界的背景是${GENRE}。`,
    "叶尘是主角团成员。",
    "林婉儿是主角团成员。",
    "苏影是主角团成员。",
    "宗门与门派是仙侠世界的主要势力组织。",
    "法宝（含神器、仙器、至宝、圣物、天器）是修士的重要对敌道具。",
    "心法、功法、秘法、秘术、禁术、上古功法、上古心法、神功是修士的修炼传承。",
    "封印、禁制、阵法是仙侠世界中常见的封禁与防御手段。",
  ];
  // 稀疏上下文章节：减少 immutableFacts（保留角色身份但移除世界规则条目）
  // 这会增加模型判断需要检索的概率（上下文不足以保证事实/因果关系正确）
  const immutableFacts = scenario.sparseContext
    ? baseFacts.slice(0, 4) // 只保留角色身份事实
    : [...baseFacts, ...scenario.extraFacts];

  const worldKeyTerms = ["碎星剑", "尘心诀", "青鱼嘴", ...scenario.extraTerms];

  const config = {
    name: `AGENTIC-EVIDENCE-MERGE-1 replay ch${ch}: ${scenario.title}`,
    genre: "仙侠",
    subGenres: ["东方玄幻"],
    totalChapters: MAX_CHAPTERS,
    chapterType: "standard",
    targetWordCount: { perChapter: { min: 1500, max: 2500 } },
    characters: CHARACTERS.map((name) => ({
      name,
      role: name === scenario.focusCharacter
        ? "主角"
        : name === "叶尘" ? "主角" : "主角团成员",
    })),
    worldKeyTerms,
    immutableFacts,
  };
  writeFileSync(join(WS_ROOT, "config.json"), JSON.stringify(config, null, 2), "utf-8");

  // 大纲按章节场景变化
  writeFileSync(
    join(WS_ROOT, "series", "outline.md"),
    [
      "# 大纲",
      "",
      `## 第${ch}章：${scenario.title}`,
      `焦点角色：${scenario.focusCharacter}`,
      `主题：${scenario.theme}`,
      `意图：${scenario.intent}`,
      `目标情绪：${scenario.targetEmotions.join("、")}`,
      "",
      "## 主线",
      "叶尘从废物少年崛起，获得碎星剑，与林婉儿、苏影结盟，最终解除上古封印。",
      "",
      "## 关键伏笔",
      "- 碎星剑：叶尘在前期获得的神兵，后续章节反复引用。",
      "- 尘心诀：叶尘承诺练成后为盟友复仇。",
      "- 林婉儿：真实身份未明，信任与背叛。",
      "- 苏影：来自海外修仙界，家乡被封印。",
      "",
    ].join("\n"),
    "utf-8",
  );

  // 角色档案按焦点角色丰富
  for (const name of CHARACTERS) {
    const isFocus = name === scenario.focusCharacter;
    const baseRole = name === "叶尘" ? "主角，废物少年，偶得传承，获得碎星剑。" : "主角团成员。";
    const detail = isFocus ? ` 焦点角色：${scenario.intent}` : "";
    writeFileSync(join(WS_ROOT, "characters", `${name}.md`), `# ${name}\n${baseRole}${detail}\n`, "utf-8");
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
      ...(scenario.sparseContext ? [] : scenario.extraFacts),
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
      "- 苏影：主角团成员，来自海外修仙界。",
      "",
      "## 当前章节焦点",
      `- 第${ch}章：${scenario.title}`,
      `- 焦点角色：${scenario.focusCharacter}`,
      `- 意图：${scenario.intent}`,
      ...(scenario.sparseContext ? ["- 注意：上下文稀疏，可能需要检索查证。"] : []),
      "",
    ].join("\n"),
    "utf-8",
  );

  return scenario;
}

// ============================================================================
// quality trace 读取
// ============================================================================

function readQualityTrace(chapterId) {
  const path = join(WS_ROOT, "traces", `${chapterId}-quality-trace.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

/**
 * 归档当前 workspace 的全部 trace 文件到持久目录。
 * 在独立快照模式下，scaffoldWorkspace 会 rmSync 整个 workspace，
 * 如果不先归档，最终目录只保留最后一章的 trace（用户缺口 #2）。
 * 归档路径：reports/agentic-evidence-merge-real/traces/ch{N}-{原始文件名}
 */
function archiveChapterTrace(ch) {
  const traceDir = join(WS_ROOT, "traces");
  if (!existsSync(traceDir)) return 0;
  mkdirSync(TRACE_ARCHIVE_DIR, { recursive: true });
  let archived = 0;
  for (const file of readdirSync(traceDir)) {
    const src = join(traceDir, file);
    const dst = join(TRACE_ARCHIVE_DIR, `ch${ch}-${file}`);
    copyFileSync(src, dst);
    archived++;
  }
  return archived;
}

/** 从 quality trace 提取 AGENTIC-EVIDENCE-MERGE-1 指标（纯函数，供脚本与单测共用） */
export function extractTraceMetrics(trace) {
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

  // AGENTIC-EVIDENCE-MERGE-1 补验（P1）：返回全部 failureEnvelopes 与
  // hasRecoverableFailure 布尔，供恢复率统计遍历所有 envelope，
  // 而非仅检查最后一个 lastEnvelope（避免漏掉非最后一项的可恢复记录）。
  const failEnvelopes = Array.isArray(trace?.failureEnvelopes)
    ? trace.failureEnvelopes
    : [];
  const lastEnvelope = failEnvelopes[failEnvelopes.length - 1] ?? null;
  const hasRecoverableFailure = failEnvelopes.some(
    (e) => e?.recoverable === true || e?.severity === "recoverable",
  );

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
    hasRecoverableFailure,
    failureEnvelopes: failEnvelopes,
  };
}

// ============================================================================
// 阻断分类与恢复率（纯函数，AGENTIC-EVIDENCE-MERGE-1 补验 P1，供脚本与单测共用）
// ============================================================================

/**
 * 阻断分类（互斥）。三类相加 === 阻断章节总数。
 * - preflightCascade：stage === "preflight" 的级联阻断
 * - recoverableBlocks：非 preflight 的可恢复阻断
 * - hardBlocked：真正的 hard block（非 preflight、不可恢复）
 * 修复点：原实现 hardBlocked 把 preflight 级联也计入，报告相加出现重复计数。
 */
export function classifyBlocks(chapterResults) {
  const isNonOk = (r) => r && r.status !== "ok";
  const preflightCascade = chapterResults.filter(
    (r) => isNonOk(r) && r.failureStage === "preflight",
  ).length;
  const recoverableBlocks = chapterResults.filter(
    (r) => isNonOk(r) && r.recoverable === true && r.failureStage !== "preflight",
  ).length;
  const hardBlocked = chapterResults.filter(
    (r) => isNonOk(r) && !r.recoverable && r.failureStage !== "preflight",
  ).length;
  return { hardBlocked, preflightCascade, recoverableBlocks };
}

/**
 * 计算自动恢复率。
 * - 遍历 withTrace 每章的 trace 层 hasRecoverableFailure（覆盖全部 failureEnvelopes）
 *   与结果层 recoverable 标志，任何位置的可恢复失败都被计入，而非仅最后一个 envelope。
 * - 返回 totalRecoverable / recoveredAfterRetry / recoveryRate / recoveryRateNote。
 */
export function computeRecovery(withTrace) {
  const chaptersWithRecoverableFailure = withTrace.filter((r) => {
    return r.recoverable === true || r.traceMetrics?.hasRecoverableFailure === true;
  });
  const recoveredAfterRetry = chaptersWithRecoverableFailure.filter(
    (r) => r.status === "ok",
  ).length;
  const totalRecoverable = chaptersWithRecoverableFailure.length;
  const recoveryRate = totalRecoverable > 0
    ? Math.round((recoveredAfterRetry / totalRecoverable) * 1000) / 10
    : null;
  const recoveryRateNote = totalRecoverable === 0
    ? "N/A（本次无可恢复失败）"
    : `${recoveredAfterRetry}/${totalRecoverable} 恢复成功`;
  return { chaptersWithRecoverableFailure, totalRecoverable, recoveredAfterRetry, recoveryRate, recoveryRateNote };
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

  // 串行模式只 scaffold 一次；独立模式每章重建（带场景多样性）
  const initialScenario = scaffoldWorkspace(1);
  console.log(`[evidence-merge-replay] 已脚手架 workspace：${WS_ROOT}（independent=${INDEPENDENT}）`);
  console.log(`[evidence-merge-replay] ch1 场景：${initialScenario.title}（焦点：${initialScenario.focusCharacter}，稀疏上下文：${initialScenario.sparseContext}）`);

  const { runUnifiedPipeline } = await import("../dist/v2/core/unified-entry.js");

  const chapterResults = [];
  let okCount = 0;
  let blockedCount = 0;
  let uncategorizedFailures = 0;
  let traceRetained = 0;
  let evidenceDecisionTotal = 0;
  let zeroRetrievalOk = 0;
  let recoverableBlocked = 0;
  let totalArchivedTraces = 0;

  for (let ch = 1; ch <= MAX_CHAPTERS; ch++) {
    const chapterId = `ch${ch}`;
    const start = Date.now();
    let result;
    let threw = false;
    let scenario = CHAPTER_SCENARIOS[(ch - 1) % CHAPTER_SCENARIOS.length] ?? CHAPTER_SCENARIOS[0];

    // 独立快照模式：先归档上一章 trace，再重建多样化 workspace
    if (INDEPENDENT && ch > 1) {
      const archived = archiveChapterTrace(ch - 1);
      totalArchivedTraces += archived;
      scenario = scaffoldWorkspace(ch);
      console.log(`[evidence-merge-replay] ch${ch} 场景：${scenario.title}（焦点：${scenario.focusCharacter}，稀疏上下文：${scenario.sparseContext}）`);
    }
    try {
      result = await runUnifiedPipeline({
        workspaceId: WORKSPACE_ID,
        chapterId,
        // 独立快照模式：每章都是独立第 1 章（无前章依赖），但 workspace 场景不同
        chapterNumber: INDEPENDENT ? 1 : ch,
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
      scenario: scenario.title,
      focusCharacter: scenario.focusCharacter,
      sparseContext: scenario.sparseContext,
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

  // ── 归档最后一章 trace（独立模式下循环内只归档了 ch1~ch(N-1)） ──────────
  if (INDEPENDENT) {
    const archived = archiveChapterTrace(MAX_CHAPTERS);
    totalArchivedTraces += archived;
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

  // 自动恢复率：遍历全部 failureEnvelopes（computeRecovery 纯函数）
  const {
    totalRecoverable,
    recoveredAfterRetry,
    recoveryRate,
    recoveryRateNote,
  } = computeRecovery(withTrace);

  // 阻断分类（互斥，纯函数）
  const { hardBlocked, preflightCascade, recoverableBlocks } = classifyBlocks(chapterResults);

  const report = {
    schema: "agentic-evidence-merge-replay/v1",
    timestamp: new Date().toISOString(),
    mode: "real-model-generation",
    independentSnapshot: INDEPENDENT,
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
    archivedTraces: totalArchivedTraces,
    hardBlocked,
    preflightCascade,
    recoverableBlocks,
    totals: {
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      latencyMs: totalLatency,
      mustVerifyTotal: mvTotal,
      mustVerifyCovered: mvCovered,
      mustVerifyCoverageRate: mvTotal > 0 ? Math.round((mvCovered / mvTotal) * 1000) / 10 : null,
      factualErrorChapters: factualErrors,
      recoveryRate,
      recoveryRateNote,
      successRate: MAX_CHAPTERS > 0 ? Math.round((okCount / MAX_CHAPTERS) * 1000) / 10 : null,
      traceRetentionRate: MAX_CHAPTERS > 0 ? Math.round((traceRetained / MAX_CHAPTERS) * 1000) / 10 : null,
    },
    chapterResults,
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, "agentic-evidence-merge-replay.json"), JSON.stringify(report, null, 2));

  let md = `# AGENTIC-EVIDENCE-MERGE-1 真实 replay 报告\n\n`;
  md += `> **模式**：真实模型生成（${report.mode}）\n`;
  md += `> **独立章节快照**：${report.independentSnapshot ? "是（每章独立重建，避免级联污染）" : "否（串行依赖前章）"}\n`;
  md += `> **模型**：${report.model}\n`;
  md += `> **时间**：${report.timestamp}\n`;
  md += `> **章节数**：${report.totalChapters}\n\n`;
  md += `## 汇总\n\n`;
  md += `| 指标 | 值 |\n|---|---|\n`;
  md += `| 成功章节 | ${report.okCount} |\n`;
  md += `| 阻断章节 | ${report.blockedCount}（hard block ${hardBlocked} + preflight 级联 ${preflightCascade} + 可恢复 ${recoverableBlocks}） |\n`;
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
  md += `| 零检索成功章节 | ${report.zeroRetrievalOk} |\n`;
  md += `| 归档 trace 文件数 | ${report.archivedTraces}（持久保存到 ${TRACE_ARCHIVE_DIR}） |\n\n`;
  md += `## 逐章明细\n\n`;
  md += `| 章 | 场景 | 焦点角色 | 稀疏 | 状态 | firstAction | 检索 | mustVerify覆盖 | modelCalls | 输入token | 延迟(s) | 停止原因 |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of chapterResults) {
    const t = r.traceMetrics;
    md += `| ${r.chapter} | ${r.scenario ?? "-"} | ${r.focusCharacter ?? "-"} | ${r.sparseContext ? "是" : "否"} | ${r.status} | ${t?.firstAction ?? "-"} | ${t?.actualRetrievalCalls ?? "-"} | `;
    md += `${t ? `${t.mustVerifyCoveredCount}/${t.mustVerifyCount}` : "-"} | ${t?.totalModelCalls ?? "-"} | `;
    md += `${t?.tokensIn ?? "-"} | ${t ? (t.latencyMs / 1000).toFixed(1) : "-"} | ${t?.stopReason ?? "-"} |\n`;
  }
  writeFileSync(join(REPORT_DIR, "agentic-evidence-merge-replay.md"), md);

  console.log(`[evidence-merge-replay] 成功=${okCount} 阻断=${blockedCount}（hard=${hardBlocked} preflight=${preflightCascade} recoverable=${recoverableBlocks}）未分类=${uncategorizedFailures}`);
  console.log(`[evidence-merge-replay] EvidenceDecision 调用=${evidenceDecisionTotal} trace留存=${traceRetained}/${MAX_CHAPTERS} 归档trace=${totalArchivedTraces}`);
  console.log(`[evidence-merge-replay] 总输入token=${totalTokensIn} 总延迟=${(totalLatency / 1000).toFixed(1)}s`);
  console.log(`[evidence-merge-replay] 报告写到 ${join(REPORT_DIR, "agentic-evidence-merge-replay.json")} / .md`);
}

// 作为独立脚本运行时才执行 main()；被测试 import 时仅导出纯函数（不触发真实 replay）。
const isDirectRun =
  process.argv[1] &&
  (() => {
    try {
      return import.meta.url === pathToFileURL(process.argv[1]).href;
    } catch {
      return false;
    }
  })();

if (isDirectRun) {
  main().catch((err) => {
    console.error("[evidence-merge-replay] 主流程异常：", err);
    process.exit(1);
  });
}
