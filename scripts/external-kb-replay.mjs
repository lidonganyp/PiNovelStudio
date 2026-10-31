/**
 * 外挂知识库离线回放（EXTERNAL-KB-REPLAY）
 *
 * 目的：不做真实模型生成，只度量「结构化检索」在真实章节描述下的可用性：
 *   空结果率、结构化键各维度可派生率、卡片机制覆盖率、准入失败原因，
 *   以及与旧字面 content 模式的对照（解释历史上为什么恒为零命中）。
 *
 * 数据来源（均为真实产物，按「作品 + 章节号」去重，避免同一章重复计数）：
 *   A. 作者显式章纲 workspaces/**\/series/ch*-outline-explicit.md（优先级最高）
 *   B. 生产 session 里的「作者章纲事件顺序」块 workspaces/*\/novelos-sessions/*\/trajectory-content.jsonl
 *   C. 知识池 data/external-distilled/slices.json（10 条结构化 Craft Pattern Card）
 *
 * 注意：两种来源都是 ChapterIntent 的离线代理，不等同生产构建出的同一对象；
 *      本报告只用于判断「是否需要进入第二阶段蒸馏」，不用于宣称文学质量提升。
 *
 * 用法：node scripts/external-kb-replay.mjs
 * 输出：reports/external-kb-replay/structured-replay.json + summary.md
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 回放脚本版本：脚本或统计口径变更时递增，配合卡池哈希用于复现核对。 */
const REPLAY_SCRIPT_VERSION = "external-kb-replay@1";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const distBase = join(repoRoot, ".pi", "extensions", "novel-studio", "dist", "v2", "core", "external-knowledge-base.js");
const kb = await import(pathToFileURL(distBase).href);

// ============================================================================
// 通用工具
// ============================================================================

function walkFiles(dir, matcher, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, matcher, out);
    else if (matcher(full)) out.push(full);
  }
  return out;
}

function readNovelName(workDir) {
  const configPath = join(workDir, "config.json");
  if (!existsSync(configPath)) return basename(workDir);
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    return config.novelName ?? basename(workDir);
  } catch {
    return basename(workDir);
  }
}

function pickField(text, labels) {
  for (const label of labels) {
    const re = new RegExp(`^(?:-\\s*)?\\*\\*${label}\\*\\*[：:]\\s*(.+)$`, "mu");
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

function collectLines(text, keywords, limit = 6) {
  const out = [];
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/^[-*#\s]+/u, "").trim();
    if (line.length < 6 || line.length > 120) continue;
    if (!keywords.some((k) => line.includes(k))) continue;
    out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

function splitEmotions(raw) {
  if (!raw) return [];
  return raw
    .split(/[→>、，,；;/|]+/u)
    .map((s) => s.replace(/[（(].*?[)）]/u, "").trim())
    .filter((s) => s.length >= 1 && s.length <= 8);
}

const PRESSURE_KEYWORDS = ["压力", "紧迫", "时限", "盯梢", "追杀", "限制", "威胁"];
const RESISTANCE_KEYWORDS = ["规则", "代价", "惩罚", "死亡", "风险", "陷阱", "冲突"];
const CHOICE_KEYWORDS = ["选择", "决定", "必须", "要么", "否则", "不得不"];
const DELTA_KEYWORDS = ["状态变化", "不可逆", "失去", "获得", "第一次"];
/** 系统从已保存前缀生成的章纲会把「本章功能」写成这条通用模板（作者手写章纲不会）。 */
const GENERATED_OUTLINE_MARKER = "推进本章冲突，并与全书大纲";

/**
 * 解析章纲的「事件 N：…」分段，取与生产 ChapterIntent 同名的字段。
 * 兼容两种真实格式：作者手写（`### 事件 N` + `**内容摘要**`）与
 * 系统从已保存前缀生成（`## 事件 N` + `内容摘要：` 后跟正文）。
 */
function parseOutlineEvents(text) {
  const out = [];
  const chunks = text.split(/\n(?:###|##)\s*事件\s*\d+[^\n]*\n/u).slice(1);
  for (const chunk of chunks) {
    const boldSummary = chunk.match(/\*\*内容摘要\*\*[：:]\s*([^\n]+)/u)?.[1]?.trim();
    const emotionArc = chunk.match(/\*\*情绪弧\*\*[：:]\s*([^\n]+)/u)?.[1]?.trim() ?? null;
    const stateChange = chunk.match(/\*\*状态变化\*\*[：:]\s*([^\n]+)/u)?.[1]?.trim() ?? null;
    const mustRaw = chunk.match(/\*\*必须包含\*\*[：:]\s*([^\n]+)/u)?.[1]?.trim() ?? null;
    const body = chunk.replace(/\s+/gu, " ").trim();
    const summary = boldSummary ?? (body.length > 400 ? body.slice(0, 400) : body);
    out.push({ summary, emotionArc, stateChange, mustInclude: stripMustIncludeTags(mustRaw) });
  }
  return out;
}

/** 「[anchor]xxx + [verbatim]yyy」→ ["xxx","yyy"]，去掉标记前缀，过短碎片丢弃。 */
function stripMustIncludeTags(raw) {
  if (!raw) return [];
  return raw
    .split(/\s*\+\s*/u)
    .map((part) => part.replace(/^\s*\[[^\]]+\]\s*/u, "").trim())
    .filter((part) => part.length >= 4);
}

/**
 * 显式章纲 → ChapterIntent 代理（高保真）。
 * 与生产 ChapterIntent 对齐到现有字段：chapterFunction / authorEventSummaries /
 * authorMustInclude / readerExperience / currentPressure / resistance /
 * meaningfulChoices / expectedIrreversibleChange。
 * 章末/钩子措辞归 endingTarget 语义，不计入 causalEndPressure，
 * 否则 beat 规则会因「每个章纲都写章末钩子」而一律判成 close（代理偏差）。
 */
function intentFromOutline(text) {
  const chapterFunction = pickField(text, ["本章功能", "章节功能"]) ?? "";
  const emotionRaw = pickField(text, ["目标情绪曲线", "目标情绪", "情绪曲线"]) ?? "";
  const events = parseOutlineEvents(text);
  const eventEmotions = events.flatMap((event) => splitEmotions(event.emotionArc));
  return {
    chapterFunction,
    authorEventSummaries: events.map((event) => event.summary).filter(Boolean),
    authorMustInclude: events.flatMap((event) => event.mustInclude),
    readerExperience: [...new Set([...splitEmotions(emotionRaw), ...eventEmotions])],
    currentPressure: collectLines(text, PRESSURE_KEYWORDS),
    resistance: collectLines(text, RESISTANCE_KEYWORDS),
    meaningfulChoices: collectLines(text, CHOICE_KEYWORDS),
    choicesAndCosts: [],
    expectedIrreversibleChange: [
      ...events.map((event) => event.stateChange).filter(Boolean),
      ...collectLines(text, DELTA_KEYWORDS),
    ],
    causalEndPressure: [],
    authorStateChanges: [],
  };
}

/**
 * 生产 session 的「作者章纲事件顺序」块 → ChapterIntent 代理（低保真）。
 * session 提示里没有「本章功能/冲突等级/情绪弧」等章节级字段，只能把整块事件文本
 * 塞进 chapterFunction；因此该来源标记为 low fidelity，不参与高保真结论。
 */
function intentFromSessionBlock(block) {
  return {
    chapterFunction: block.slice(0, 600),
    authorEventSummaries: [],
    authorMustInclude: [],
    readerExperience: [],
    currentPressure: collectLines(block, PRESSURE_KEYWORDS),
    resistance: collectLines(block, RESISTANCE_KEYWORDS),
    meaningfulChoices: collectLines(block, CHOICE_KEYWORDS),
    choicesAndCosts: [],
    expectedIrreversibleChange: collectLines(block, DELTA_KEYWORDS),
    causalEndPressure: [],
    authorStateChanges: [],
  };
}

// ============================================================================
// 采集候选（A 显式章纲 / B 生产 session 章纲块）
// ============================================================================

const candidates = [];

const OUTLINE_ROOTS = [join(repoRoot, "workspaces"), join(repoRoot, "platform", ".tmp"), join(repoRoot, "reports")];
for (const root of OUTLINE_ROOTS) {
  const files = walkFiles(root, (full) => /^ch\d+-outline-explicit\.md$/u.test(basename(full)));
  for (const file of files) {
    const seriesDir = dirname(file);
    const workDir = dirname(seriesDir);
    const chapterNumber = Number(basename(file).match(/ch(\d+)/u)?.[1] ?? 0);
    const text = readFileSync(file, "utf8");
    candidates.push({
      source: "outline",
      fidelity: text.includes(GENERATED_OUTLINE_MARKER) ? "generated" : "author",
      priority: 2,
      workDir,
      novelName: readNovelName(workDir),
      chapterNumber,
      file: file.slice(repoRoot.length + 1),
      rawText: text,
      intent: intentFromOutline(text),
    });
  }
}

const sessionRoots = OUTLINE_ROOTS.slice(0, 2);
for (const root of sessionRoots) {
  const sessionFiles = walkFiles(root, (full) => basename(full) === "trajectory-content.jsonl");
  for (const file of sessionFiles) {
    const workDir = dirname(dirname(dirname(file)));
    let chapterNumber = 0;
    let block = null;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/u)) {
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.type === "session_start") chapterNumber = Number(record.data?.chapterId ?? 0);
      if (!block && record.type === "message") {
        const content = typeof record.data?.content === "string"
          ? record.data.content
          : JSON.stringify(record.data ?? {});
        block = content.match(/作者章纲事件顺序：([\s\S]*?)(?=\n\s*本章角色|\n\s*字数软目标|\n【)/u)?.[1] ?? null;
      }
    }
    if (!block || !chapterNumber) continue;
    block = block.replace(/\s+/gu, " ").trim();
    if (block.length < 40) continue;
    candidates.push({
      source: "session",
      fidelity: "session",
      priority: 1,
      workDir,
      novelName: readNovelName(workDir),
      chapterNumber,
      file: file.slice(repoRoot.length + 1),
      rawText: block,
      intent: intentFromSessionBlock(block),
    });
  }
}

/** 按「作品 + 章节号」去重：同作品副本合并；显式章纲优先于 session 块。 */
const byChapter = new Map();
const contentHashes = new Map();
for (const candidate of candidates) {
  const key = `${candidate.novelName}|ch${candidate.chapterNumber}`;
  const contentHash = createHash("sha1").update(candidate.rawText).digest("hex");
  contentHashes.set(contentHash, (contentHashes.get(contentHash) ?? 0) + 1);
  const existing = byChapter.get(key);
  if (!existing) {
    byChapter.set(key, { ...candidate, copies: 1 });
    continue;
  }
  existing.copies += 1;
  if (candidate.priority > existing.priority) {
    existing.source = candidate.source;
    existing.fidelity = candidate.fidelity;
    existing.priority = candidate.priority;
    existing.file = candidate.file;
    existing.rawText = candidate.rawText;
    existing.intent = candidate.intent;
  }
}

// ============================================================================
// 检索回放
// ============================================================================

const loaded = kb.loadExternalDistilledSlices(repoRoot);
if (!loaded.ok) {
  console.error("加载知识池失败:", loaded.error);
  process.exit(1);
}
const slices = loaded.slices;
/**
 * 卡池哈希：`data/external-distilled/` 被 .gitignore 排除，只靠生成时间无法证明
 * 报告对应哪一版卡池；把 SHA-256 写进报告，才能让结论与数据版本绑定。
 */
const poolSha256 = createHash("sha256").update(readFileSync(loaded.path, "utf8")).digest("hex");
const poolBySceneFunction = new Map();
for (const slice of slices) {
  const fn = slice.scene_function ?? null;
  poolBySceneFunction.set(fn, (poolBySceneFunction.get(fn) ?? 0) + 1);
}

const rows = [];
for (const chapter of byChapter.values()) {
  const intent = chapter.intent;
  const key = kb.deriveStructuredRetrievalKey(intent);
  const common = {
    slices,
    query: kb.buildExternalKnowledgeQuery(intent),
    emotionTargets: intent.readerExperience,
    chapterPhase: kb.deriveChapterPhase({ chapterNumber: chapter.chapterNumber, chapterFunction: intent.chapterFunction }),
    topK: kb.EXTERNAL_KB_PRODUCTION_TOP_K,
  };
  const structured = kb.retrieveExternalDistilledSlices({ ...common, retrievalKey: key });
  const legacy = kb.retrieveExternalDistilledSlices({ ...common });
  rows.push({
    novelName: chapter.novelName,
    source: chapter.source,
    fidelity: chapter.fidelity,
    file: chapter.file,
    chapterNumber: chapter.chapterNumber,
    copies: chapter.copies,
    key,
    structured: {
      deliveredIds: structured.report.deliveredIds,
      selectionMode: structured.report.selectionMode,
      skippedReason: structured.report.skippedReason,
      droppedByStructuredAdmissionIds: structured.report.droppedByStructuredAdmissionIds,
      droppedByHardFilterIds: structured.report.droppedByHardFilterIds,
      droppedIds: structured.report.droppedIds,
      structuredHitsById: structured.report.structuredHitsById,
      marginGap: structured.report.marginGap,
      poolSize: structured.report.poolSize,
      afterHardFilter: structured.report.afterHardFilter,
      matchedDimensions: structured.items[0]?.matchedDimensions ?? [],
      score: structured.items[0]?.score ?? null,
    },
    legacyContentMode: {
      deliveredIds: legacy.report.deliveredIds,
      skippedReason: legacy.report.skippedReason,
      droppedByRelevanceIds: legacy.report.droppedByRelevanceIds,
    },
  });
}

// ============================================================================
// 汇总
// ============================================================================

/** 同一套指标作用在任意子集上，避免「总体 + 分层」两套口径漂移。 */
function metricsFor(list) {
  const chapters = list.length;
  const emptyRows = list.filter((r) => r.structured.deliveredIds.length === 0);
  const keyEmptyRows = list.filter((r) => r.structured.skippedReason === "structured_key_empty");
  const deliveredCardCounts = {};
  for (const r of list) {
    for (const id of r.structured.deliveredIds) deliveredCardCounts[id] = (deliveredCardCounts[id] ?? 0) + 1;
  }
  return {
    chapters,
    deliveredRate: Number(((chapters - emptyRows.length) / Math.max(chapters, 1)).toFixed(4)),
    emptyRate: Number((emptyRows.length / Math.max(chapters, 1)).toFixed(4)),
    emptyBecauseKeyEmpty: keyEmptyRows.length,
    emptyBecauseNoAdmission: emptyRows.length - keyEmptyRows.length,
    dimensionPopulated: {
      sceneFunction: list.filter((r) => r.key.sceneFunction).length,
      beat: list.filter((r) => r.key.beat).length,
      pressureType: list.filter((r) => r.key.pressureType).length,
      decisionTradeoff: list.filter((r) => r.key.decisionTradeoff).length,
      costType: list.filter((r) => r.key.costType.length > 0).length,
      stateDelta: list.filter((r) => r.key.stateDelta.length > 0).length,
    },
    sceneFunctionNull: list.filter((r) => !r.key.sceneFunction).length,
    primaryDimensionMissing: list.filter((r) => !r.key.sceneFunction && !r.key.beat).length,
    deliveredCardCounts,
    legacyZeroHit: list.filter((r) => r.legacyContentMode.deliveredIds.length === 0).length,
  };
}

const total = rows.length;
const overall = metricsFor(rows);
const byFidelity = {
  author: metricsFor(rows.filter((r) => r.fidelity === "author")),
  generated: metricsFor(rows.filter((r) => r.fidelity === "generated")),
  session: metricsFor(rows.filter((r) => r.fidelity === "session")),
};
const coverageGaps = rows
  .filter((r) => r.structured.deliveredIds.length === 0 && r.key.sceneFunction && !poolBySceneFunction.has(r.key.sceneFunction))
  .map((r) => ({ novelName: r.novelName, chapterNumber: r.chapterNumber, sceneFunction: r.key.sceneFunction }));
const sourceBreakdown = {};
for (const r of rows) {
  const bucket = (sourceBreakdown[r.source] ??= { chapters: 0, delivered: 0 });
  bucket.chapters += 1;
  if (r.structured.deliveredIds.length > 0) bucket.delivered += 1;
}

const poolByBeat = new Map();
for (const slice of slices) {
  const beat = slice.beat ?? null;
  poolByBeat.set(beat, (poolByBeat.get(beat) ?? 0) + 1);
}

const summary = {
  schemaVersion: 4,
  replayScriptVersion: REPLAY_SCRIPT_VERSION,
  generatedAt: new Date().toISOString(),
  intentProxy: "三层：author=作者手写章纲（本章功能+事件内容摘要/必须包含）；generated=系统从已保存前缀生成的章纲（本章功能为通用模板，事件正文可用）；session=生产 session 事件块（无章节级字段）；按 作品+章节号 去重（章纲优先）",
  poolPath: loaded.path,
  poolSha256,
  poolSize: slices.length,
  poolSceneFunctionCoverage: Object.fromEntries(poolBySceneFunction),
  poolBeatCoverage: Object.fromEntries(poolByBeat),
  candidateFiles: candidates.length,
  duplicateCollapsed: candidates.length - total,
  chapters: total,
  sourceBreakdown,
  structured: {
    ...overall,
    maxStructuredHits: Math.max(0, ...rows.map((r) => Math.max(0, ...Object.values(r.structured.structuredHitsById)) | 0)),
    coverageGapSceneFunctions: coverageGaps,
    marginGapValues: rows.map((r) => r.structured.marginGap).filter((v) => v !== null),
  },
  fidelityTiers: byFidelity,
  legacyContentMode: {
    zeroHitRate: Number((overall.legacyZeroHit / Math.max(total, 1)).toFixed(4)),
    zeroHitChapters: overall.legacyZeroHit,
  },
  rows,
};

const outDir = join(repoRoot, "reports", "external-kb-replay");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "structured-replay.json"), JSON.stringify(summary, null, 2), "utf8");

function tierLine(label, tier) {
  const cards = Object.keys(tier.deliveredCardCounts).length
    ? JSON.stringify(tier.deliveredCardCounts)
    : "（无）";
  return `- ${label}：${tier.chapters} 章，交付率 ${(tier.deliveredRate * 100).toFixed(1)}%（空结果 ${tier.emptyBecauseKeyEmpty} 键无法派生 / ${tier.emptyBecauseNoAdmission} 未达准入）；sceneFunction 未派生 ${tier.sceneFunctionNull}；键维度 ${JSON.stringify(tier.dimensionPopulated)}；交付卡片 ${cards}`;
}

const md = [
  "# 外挂知识库结构化检索离线回放",
  "",
  `- 生成时间：${summary.generatedAt}`,
  `- 回放脚本版本：${summary.replayScriptVersion}`,
  `- 意图代理：${summary.intentProxy}`,
  `- 知识池：${summary.poolPath}（${summary.poolSize} 条，SHA-256 \`${summary.poolSha256}\`）`,
  `- 卡池 scene_function 覆盖：${JSON.stringify(summary.poolSceneFunctionCoverage)}`,
  `- 卡池 beat 覆盖：${JSON.stringify(summary.poolBeatCoverage)}`,
  `- 章节样本：${total} 个不同章节（候选 ${candidates.length} 条，去重合并 ${candidates.length - total} 条）`,
  `- 来源构成：${JSON.stringify(sourceBreakdown)}`,
  "",
  "## 结构化检索（生产配置 topK=1）",
  "",
  `- 交付率：${(summary.structured.deliveredRate * 100).toFixed(1)}%（空结果 ${summary.structured.emptyRate * 100}%）`,
  `- 空结果原因：结构化键无法派生 ${summary.structured.emptyBecauseKeyEmpty}；无卡片达到准入 ${summary.structured.emptyBecauseNoAdmission}`,
  `- 主维度缺失章节：${summary.structured.primaryDimensionMissing}（sceneFunction 未派生 ${summary.structured.sceneFunctionNull}）`,
  "- 键维度可派生章节数：" + JSON.stringify(summary.structured.dimensionPopulated),
  "- 卡片交付次数：" + (Object.keys(summary.structured.deliveredCardCounts).length ? JSON.stringify(summary.structured.deliveredCardCounts) : "（无）"),
  "- 场景功能覆盖缺口：" + (coverageGaps.length ? JSON.stringify(coverageGaps) : "无"),
  "",
  "## 保真度分层（结论以 author 层为准；generated/session 只作敏感性观察）",
  "",
  tierLine("author（作者手写章纲）", byFidelity.author),
  tierLine("generated（系统生成章纲）", byFidelity.generated),
  tierLine("session（生产 session 事件块）", byFidelity.session),
  "",
  "## 旧字面 content 模式对照",
  "",
  `- 零命中章节：${overall.legacyZeroHit}/${total}（${(summary.legacyContentMode.zeroHitRate * 100).toFixed(1)}%）`,
  "",
  "## 逐章明细",
  "",
  "| 作品 | 来源 | 保真度 | 章 | sceneFunction | beat | pressureType | tradeoff | 交付 | marginGap |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.novelName} | ${r.source} | ${r.fidelity} | ${r.chapterNumber} | ${r.key.sceneFunction ?? "-"} | ${r.key.beat ?? "-"} | ${r.key.pressureType ?? "-"} | ${r.key.decisionTradeoff ?? "-"} | ${r.structured.deliveredIds.join(",") || "空"} | ${r.structured.marginGap ?? "-"} |`),
  "",
  "> 说明：三层都是 ChapterIntent 的离线代理，不等同生产构建出的同一对象。",
  "> author 层最接近生产意图；generated 的「本章功能」是通用模板、只有事件正文可用；",
  "> session 提示缺章节级字段（本章功能/冲突等级/情绪弧），只能整块文本代理。",
  "> 本报告只判断「是否需要第二阶段蒸馏」，不宣称文学质量提升。",
].join("\n");
writeFileSync(join(outDir, "summary.md"), md, "utf8");

console.log(JSON.stringify({
  replayScriptVersion: REPLAY_SCRIPT_VERSION,
  poolSha256,
  candidateFiles: candidates.length,
  distinctChapters: total,
  sourceBreakdown,
  deliveredRate: summary.structured.deliveredRate,
  emptyBecauseKeyEmpty: summary.structured.emptyBecauseKeyEmpty,
  emptyBecauseNoAdmission: summary.structured.emptyBecauseNoAdmission,
  primaryDimensionMissing: summary.structured.primaryDimensionMissing,
  sceneFunctionNull: summary.structured.sceneFunctionNull,
  dimensionPopulated: summary.structured.dimensionPopulated,
  deliveredCardCounts: summary.structured.deliveredCardCounts,
  coverageGap: coverageGaps.length,
  legacyZeroHitRate: summary.legacyContentMode.zeroHitRate,
  fidelityTiers: {
    author: { chapters: byFidelity.author.chapters, deliveredRate: byFidelity.author.deliveredRate, sceneFunctionNull: byFidelity.author.sceneFunctionNull, dimensionPopulated: byFidelity.author.dimensionPopulated },
    generated: { chapters: byFidelity.generated.chapters, deliveredRate: byFidelity.generated.deliveredRate, sceneFunctionNull: byFidelity.generated.sceneFunctionNull, dimensionPopulated: byFidelity.generated.dimensionPopulated },
    session: { chapters: byFidelity.session.chapters, deliveredRate: byFidelity.session.deliveredRate, sceneFunctionNull: byFidelity.session.sceneFunctionNull, dimensionPopulated: byFidelity.session.dimensionPopulated },
  },
}, null, 2));
