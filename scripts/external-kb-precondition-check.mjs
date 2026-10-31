/**
 * 外挂知识库「必要前提三态核对」离线验收（EXTERNAL-KB-PRECONDITION-GATE）
 *
 * 目的：在不改检索算法、阈值、topK、fallback、意图派生与 prompt 的前提下，
 * 证明「交付前按作者写前契约核对卡片必要前提」能减少错误交付。
 *
 * 做法：
 *   1. 重新采集作者写前契约（显式章纲 / 生产 session 章纲块），与回放脚本同口径；
 *   2. 用冻结卡池重算结构化检索结果，并与 reports/external-kb-replay/structured-replay.json 对齐；
 *   3. 对每次实际交付的卡片，按 docs/external-kb/scene-card-preconditions.json 核对必要前提，
 *      三态判定：成立 / 明确不成立 / 信息不足；后两者不交付；
 *   4. 用 docs/external-kb/scene-card-counterexamples.json 的人工标签计算前后混淆矩阵。
 *
 * 只用契约文本与卡片前提概念组做确定性匹配：不用章节编号白名单、不用专名、不删卡、不改阈值。
 * 局限：概念组是人工编写的词面证据表，且作者已看过开发集案例，本报告只能算开发集结果，
 *       不能作为独立验证结论；有新增未参与调整的真实契约后必须另行复跑。
 *
 * 用法：node scripts/external-kb-precondition-check.mjs
 * 输出：reports/external-kb-precondition/expectation-gate.json + summary.md
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GATE_SCRIPT_VERSION = "external-kb-precondition-gate@1";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const distBase = join(repoRoot, ".pi", "extensions", "novel-studio", "dist", "v2", "core", "external-knowledge-base.js");
const kb = await import(pathToFileURL(distBase).href);

const preconditionPath = join(repoRoot, "docs", "external-kb", "scene-card-preconditions.json");
const assetPath = join(repoRoot, "docs", "external-kb", "scene-cards-v2.json");
const labelPath = join(repoRoot, "docs", "external-kb", "scene-card-counterexamples.json");
const replayPath = join(repoRoot, "reports", "external-kb-replay", "structured-replay.json");

// ============================================================================
// 契约采集（与 external-kb-replay.mjs 同口径，避免两套意图代理漂移）
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
    return JSON.parse(readFileSync(configPath, "utf8")).novelName ?? basename(workDir);
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
const GENERATED_OUTLINE_MARKER = "推进本章冲突，并与全书大纲";

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

function stripMustIncludeTags(raw) {
  if (!raw) return [];
  return raw
    .split(/\s*\+\s*/u)
    .map((part) => part.replace(/^\s*\[[^\]]+\]\s*/u, "").trim())
    .filter((part) => part.length >= 4);
}

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

const candidates = [];
const OUTLINE_ROOTS = [join(repoRoot, "workspaces"), join(repoRoot, "platform", ".tmp"), join(repoRoot, "reports")];
for (const root of OUTLINE_ROOTS) {
  for (const file of walkFiles(root, (full) => /^ch\d+-outline-explicit\.md$/u.test(basename(full)))) {
    const workDir = dirname(dirname(file));
    const chapterNumber = Number(basename(file).match(/ch(\d+)/u)?.[1] ?? 0);
    const text = readFileSync(file, "utf8");
    candidates.push({
      source: "outline",
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

for (const root of OUTLINE_ROOTS.slice(0, 2)) {
  for (const file of walkFiles(root, (full) => basename(full) === "trajectory-content.jsonl")) {
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

const byChapter = new Map();
for (const candidate of candidates) {
  const key = `${candidate.novelName}|ch${candidate.chapterNumber}`;
  const existing = byChapter.get(key);
  if (!existing || candidate.priority > existing.priority) byChapter.set(key, candidate);
}

// ============================================================================
// 卡池与前提表
// ============================================================================

const loaded = kb.loadExternalDistilledSlices(repoRoot);
if (!loaded.ok) {
  console.error("加载知识池失败:", loaded.error);
  process.exit(1);
}
const slices = loaded.slices;
const poolSha256 = createHash("sha256").update(readFileSync(loaded.path, "utf8")).digest("hex");
const assetSha256 = existsSync(assetPath)
  ? createHash("sha256").update(readFileSync(assetPath, "utf8")).digest("hex")
  : null;

const preconditionDoc = JSON.parse(readFileSync(preconditionPath, "utf8"));
const labelDoc = JSON.parse(readFileSync(labelPath, "utf8"));
if (preconditionDoc.frozenAssetSha256 && preconditionDoc.frozenAssetSha256 !== assetSha256) {
  console.error(`前提表绑定的卡资产哈希 ${preconditionDoc.frozenAssetSha256} 与当前资产 ${assetSha256} 不一致：卡资产未冻结或已被改动。`);
  process.exit(2);
}
if (preconditionDoc.frozenPoolSha256 !== poolSha256) {
  console.error(`前提表绑定的卡池哈希 ${preconditionDoc.frozenPoolSha256} 与当前运行池 ${poolSha256} 不一致：卡池未冻结或已被改动。`);
  process.exit(2);
}
if (labelDoc.frozenPoolSha256 !== poolSha256) {
  console.error(`反例集绑定的卡池哈希 ${labelDoc.frozenPoolSha256} 与当前运行池 ${poolSha256} 不一致。`);
  process.exit(2);
}

const preconditionsByCard = new Map(preconditionDoc.cards.map((entry) => [entry.cardId, entry.preconditions]));
for (const slice of slices) {
  if (!preconditionsByCard.has(slice.id)) {
    console.error(`卡池卡片 ${slice.id} 缺少必要前提定义，拒绝在缺少核对依据的情况下交付。`);
    process.exit(2);
  }
}

// ============================================================================
// 契约证据单元与作用域
// ============================================================================

function normalize(text) {
  return text.replace(/[\s\u3000]/gu, "").replace(/[「」『』“”"'`*#>_|~\-]/gu, "");
}

/** 归一化同时保留「归一化位置 → 原文位置」映射，用于以命中词为中心截取证据窗口。 */
function normalizeWithMap(text) {
  let out = "";
  const map = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (/[\s\u3000]/u.test(ch) || "「」『』“”\"'`*#>_|~-".includes(ch)) continue;
    out += ch;
    map.push(i);
  }
  return { out, map };
}

function snippetAround(unit, map, index, needleLength) {
  const start = Math.max(0, map[index] - 25);
  const end = Math.min(unit.length, map[index + needleLength - 1] + 26);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < unit.length ? "…" : "";
  return `${prefix}${unit.slice(start, end)}${suffix}`;
}

function unitsFromChapter(chapter) {
  if (chapter.source === "session") {
    return chapter.rawText.split(/[。！？；]/u).map((s) => s.trim()).filter((s) => s.length >= 2);
  }
  return chapter.rawText
    .split(/\r?\n/u)
    .map((line) => line.replace(/^[-*#\s>]+/u, "").trim())
    .filter((line) => line.length >= 2);
}

const ENDING_MARKER = /章末目标|章尾目标|章末|结尾|收束|最后一段/u;

/**
 * 章末作用域只取「章末字段本身」，不能把字段之后的整段正文纳入，
 * 否则中段物证会被误当成章末落点（p252 ch20 曾因此假阳性）。
 */
function scopedUnits(chapter, scope) {
  if (scope !== "ending") return unitsFromChapter(chapter);

  if (chapter.source === "session") {
    const units = unitsFromChapter(chapter);
    const tail = Math.max(2, Math.ceil(units.length * 0.3));
    return units.slice(-tail);
  }

  const rawLines = chapter.rawText.split(/\r?\n/u);
  const stripped = rawLines.map((line) => line.replace(/^[-*#\s>]+/u, "").trim());
  let markerIndex = -1;
  for (let i = stripped.length - 1; i >= 0; i -= 1) {
    if (ENDING_MARKER.test(stripped[i])) {
      markerIndex = i;
      break;
    }
  }

  if (markerIndex >= 0) {
    const head = stripped[markerIndex];
    const bodyAfterLabel = head.replace(/^[^：:]{0,12}[：:]/u, "").trim();
    if (bodyAfterLabel.length >= 6) return [head];
    const out = [head];
    for (let i = markerIndex + 1; i < rawLines.length && out.length < 5; i += 1) {
      if (/^\s*#/u.test(rawLines[i])) break;
      if (stripped[i].length >= 2) out.push(stripped[i]);
    }
    return out;
  }

  const units = unitsFromChapter(chapter);
  const tail = Math.max(2, Math.ceil(units.length * 0.2));
  return units.slice(-tail);
}

function findTerm(units, terms) {
  for (const term of terms) {
    const needle = normalize(term);
    if (!needle) continue;
    for (let i = 0; i < units.length; i += 1) {
      const mapped = normalizeWithMap(units[i]);
      const index = mapped.out.indexOf(needle);
      if (index >= 0) {
        return { term, unitIndex: i, snippet: snippetAround(units[i], mapped.map, index, needle.length) };
      }
    }
  }
  return null;
}

function evaluatePrecondition(chapter, precondition) {
  const units = scopedUnits(chapter, precondition.scope ?? "whole");
  const contradictions = (precondition.contradiction ?? [])
    .map((group) => findTerm(units, group))
    .filter(Boolean);
  if (contradictions.length > 0) {
    return {
      status: "violated",
      evidence: contradictions.map((hit) => ({ group: "contradiction", term: hit.term, snippet: hit.snippet })),
      missing: [],
    };
  }
  const groups = precondition.required ?? [];
  const hits = [];
  const missing = [];
  for (const group of groups) {
    const hit = findTerm(units, group);
    if (hit) hits.push({ group: group.join("|"), term: hit.term, snippet: hit.snippet });
    else missing.push(group.join("|"));
  }
  const status = missing.length === 0 ? "satisfied" : "insufficient";
  return { status, evidence: hits, missing };
}

function evaluateCard(chapter, cardId) {
  const specs = preconditionsByCard.get(cardId) ?? [];
  const details = specs.map((spec) => ({
    id: spec.id,
    statement: spec.statement,
    scope: spec.scope ?? "whole",
    ...evaluatePrecondition(chapter, spec),
  }));
  let status = "satisfied";
  if (details.some((d) => d.status === "violated")) status = "violated";
  else if (details.some((d) => d.status === "insufficient")) status = "insufficient";
  return { cardId, status, details };
}

const statusLabel = { satisfied: "成立", violated: "明确不成立", insufficient: "信息不足" };

// ============================================================================
// 回放 + 门禁
// ============================================================================

const rows = [];
for (const chapter of byChapter.values()) {
  const intent = chapter.intent;
  const key = kb.deriveStructuredRetrievalKey(intent);
  const retrieved = kb.retrieveExternalDistilledSlices({
    slices,
    query: kb.buildExternalKnowledgeQuery(intent),
    emotionTargets: intent.readerExperience,
    chapterPhase: kb.deriveChapterPhase({ chapterNumber: chapter.chapterNumber, chapterFunction: intent.chapterFunction }),
    retrievalKey: key,
    topK: kb.EXTERNAL_KB_PRODUCTION_TOP_K,
  });
  const delivered = retrieved.report.deliveredIds;
  const evaluations = delivered.map((id) => evaluateCard(chapter, id));
  const deliveredAfter = delivered.filter((id, index) => evaluations[index].status === "satisfied");
  const held = evaluations.filter((item) => item.status !== "satisfied");
  rows.push({
    novelName: chapter.novelName,
    chapterNumber: chapter.chapterNumber,
    source: chapter.source,
    fidelity: chapter.source === "outline" ? (chapter.rawText.includes(GENERATED_OUTLINE_MARKER) ? "generated" : "author") : "session",
    file: chapter.file,
    key,
    deliveredBefore: delivered,
    deliveredAfter,
    evaluations,
    held,
  });
}

// 与既有回放对齐：若卡池或采集口径漂移，本报告结论无效
if (existsSync(replayPath)) {
  const replay = JSON.parse(readFileSync(replayPath, "utf8"));
  const replayById = new Map(replay.rows.map((row) => [`${row.novelName}|ch${row.chapterNumber}`, row.structured.deliveredIds ?? []]));
  const mismatches = [];
  for (const row of rows) {
    const expected = replayById.get(`${row.novelName}|ch${row.chapterNumber}`);
    if (!expected) continue;
    const same = JSON.stringify(expected) === JSON.stringify(row.deliveredBefore);
    if (!same) mismatches.push({ chapter: `${row.novelName}|ch${row.chapterNumber}`, replay: expected, recomputed: row.deliveredBefore });
  }
    if (mismatches.length > 0) {
    console.error("与既有回放不一致，拒绝输出结论：", JSON.stringify(mismatches, null, 2));
    process.exit(3);
  }
}

// ============================================================================
// 与人工标签对照
// ============================================================================

const labelByKey = new Map(labelDoc.labels.map((item) => [`${item.novelName}|ch${item.chapterNumber}|${item.cardId}`, item]));

const caseRows = [];
for (const row of rows) {
  for (let i = 0; i < row.deliveredBefore.length; i += 1) {
    const cardId = row.deliveredBefore[i];
    const evaluation = row.evaluations[i];
    const labelEntry = labelByKey.get(`${row.novelName}|ch${row.chapterNumber}|${cardId}`);
    const gateDelivers = evaluation.status === "satisfied";
    const expectedDeliver = labelEntry ? labelEntry.label === "applicable" : null;
    let outcome = "unlabeled";
    if (expectedDeliver !== null) {
      if (gateDelivers && expectedDeliver) outcome = "true_positive";
      else if (gateDelivers && !expectedDeliver) outcome = "false_positive";
      else if (!gateDelivers && expectedDeliver) outcome = "false_negative";
      else outcome = "true_negative";
    }
    caseRows.push({
      novelName: row.novelName,
      chapterNumber: row.chapterNumber,
      cardId,
      label: labelEntry?.label ?? null,
      expectedDeliver,
      gateStatus: evaluation.status,
      gateStatusLabel: statusLabel[evaluation.status],
      gateDelivers,
      outcome,
      context: labelEntry?.note ?? null,
      preconditionDetails: evaluation.details,
    });
  }
}

const labeled = caseRows.filter((item) => item.label !== null);
const summary = {
  schemaVersion: 1,
  gateScriptVersion: GATE_SCRIPT_VERSION,
  generatedAt: new Date().toISOString(),
  poolPath: loaded.path,
  poolSha256,
  assetPath: preconditionDoc.frozenAssetPath ?? "docs/external-kb/scene-cards-v2.json",
  assetSha256,
  preconditionFile: "docs/external-kb/scene-card-preconditions.json",
  preconditionSha256: createHash("sha256").update(readFileSync(preconditionPath, "utf8")).digest("hex"),
  labelFile: "docs/external-kb/scene-card-counterexamples.json",
  labelSha256: createHash("sha256").update(readFileSync(labelPath, "utf8")).digest("hex"),
  chapters: rows.length,
  deliveriesBefore: caseRows.length,
  deliveriesAfter: caseRows.filter((item) => item.gateDelivers).length,
  labeledCases: labeled.length,
  confusion: {
    truePositive: labeled.filter((item) => item.outcome === "true_positive").length,
    falsePositive: labeled.filter((item) => item.outcome === "false_positive").length,
    falseNegative: labeled.filter((item) => item.outcome === "false_negative").length,
    trueNegative: labeled.filter((item) => item.outcome === "true_negative").length,
    unlabeled: caseRows.filter((item) => item.label === null).length,
  },
  wrongDeliveriesBefore: labeled.filter((item) => item.expectedDeliver === false).length,
  wrongDeliveriesAfter: labeled.filter((item) => item.expectedDeliver === false && item.gateDelivers).length,
  correctDeliveriesBefore: labeled.filter((item) => item.expectedDeliver === true).length,
  correctDeliveriesAfter: labeled.filter((item) => item.expectedDeliver === true && item.gateDelivers).length,
  gateStatusCounts: Object.fromEntries(
    ["satisfied", "violated", "insufficient"].map((status) => [status, caseRows.filter((item) => item.gateStatus === status).length]),
  ),
  chapterDeliveries: rows.map((row) => ({
    novelName: row.novelName,
    chapterNumber: row.chapterNumber,
    fidelity: row.fidelity,
    deliveredBefore: row.deliveredBefore,
    deliveredAfter: row.deliveredAfter,
  })),
  cases: caseRows,
};

const outDir = join(repoRoot, "reports", "external-kb-precondition");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "expectation-gate.json"), JSON.stringify(summary, null, 2), "utf8");

function caseLine(item) {
  const details = item.preconditionDetails
    .map((detail) => {
      const head = `${detail.id}（${statusLabel[detail.status]}）`;
      if (detail.status === "satisfied") {
        return `${head}：${detail.evidence.map((hit) => `「${hit.snippet}」`).join("；")}`;
      }
      if (detail.status === "violated") {
        return `${head}：反证「${detail.evidence.map((hit) => hit.snippet).join("；")}」`;
      }
      return `${head}：缺 ${detail.missing.join(" / ")}`;
    })
    .join("；");
  return `| ${item.novelName} | ${item.chapterNumber} | ${item.cardId} | ${item.label ?? "-"} | ${item.gateStatusLabel} | ${item.gateDelivers ? "交付" : "不交付"} | ${item.outcome} | ${details} |`;
}

const md = [
  "# 外挂知识库必要前提三态核对（离线门禁验收）",
  "",
  `- 生成时间：${summary.generatedAt}`,
  `- 门禁脚本版本：${summary.gateScriptVersion}`,
  `- 冻结卡资产：${summary.assetPath}（SHA-256 \`${summary.assetSha256}\`，19 张）`,
  `- 冻结卡池：${summary.poolPath.slice(repoRoot.length + 1)}（SHA-256 \`${summary.poolSha256}\`）`,
  `- 前提表：${summary.preconditionFile}（SHA-256 \`${summary.preconditionSha256}\`）`,
  `- 反例集：${summary.labelFile}（SHA-256 \`${summary.labelSha256}\`）`,
  "",
  "## 门禁规则（离线）",
  "",
  "- 对每张已交付卡片，仅用本章作者写前契约文本核对卡片必要前提；",
  "- 每条前提三态：成立 / 明确不成立 / 信息不足；",
  "- 只要任一前提不是「成立」，该卡不交付；",
  "- 不引入章节编号白名单、专名匹配、删卡或阈值调整。",
  "",
  "## 前后对比（开发集 11 次交付，标签来自 §10.8.3 人工审查）",
  "",
  `- 交付次数：${summary.deliveriesBefore} → ${summary.deliveriesAfter}`,
  `- 错误交付：${summary.wrongDeliveriesBefore} → ${summary.wrongDeliveriesAfter}`,
  `- 正确交付：${summary.correctDeliveriesBefore} → ${summary.correctDeliveriesAfter}`,
  `- 三态分布：${JSON.stringify(summary.gateStatusCounts)}`,
  `- 混淆矩阵：TP ${summary.confusion.truePositive} / FP ${summary.confusion.falsePositive} / FN ${summary.confusion.falseNegative} / TN ${summary.confusion.trueNegative} / 未标注 ${summary.confusion.unlabeled}`,
  "",
  "## 逐次交付审查",
  "",
  "| 作品 | 章 | 卡片 | 人工标签 | 门禁三态 | 门禁结果 | 对照结果 | 前提证据 / 缺失项 |",
  "|---|---|---|---|---|---|---|---|",
  ...caseRows.map(caseLine),
  "",
  "## 逐章交付变化",
  "",
  "| 作品 | 章 | 保真度 | 门禁前交付 | 门禁后交付 |",
  "|---|---|---|---|---|",
  ...rows.map((row) => `| ${row.novelName} | ${row.chapterNumber} | ${row.fidelity} | ${row.deliveredBefore.join(",") || "空"} | ${row.deliveredAfter.join(",") || "空"} |`),
  "",
  "## 局限（必须随结果一起读）",
  "",
  "- 前提表的概念组由人编写，作者在编写时已看过这 11 个案例，因此本结果只能算开发集结果；",
  "- 没有新增未参与调整的真实契约样本，不能宣称泛化能力；",
  "- 门禁是保守的：契约未明确支持的前提一律按「信息不足」拦下，会产生正确交付被误拦的情况（见 FN 计数）；",
  "- 本报告不回答「知识卡是否改善小说」，只回答「门禁能否减少错误交付」。",
].join("\n");
writeFileSync(join(outDir, "summary.md"), md, "utf8");

console.log(JSON.stringify({
  gateScriptVersion: GATE_SCRIPT_VERSION,
  assetSha256,
  poolSha256,
  chapters: summary.chapters,
  deliveriesBefore: summary.deliveriesBefore,
  deliveriesAfter: summary.deliveriesAfter,
  wrongDeliveriesBefore: summary.wrongDeliveriesBefore,
  wrongDeliveriesAfter: summary.wrongDeliveriesAfter,
  correctDeliveriesBefore: summary.correctDeliveriesBefore,
  correctDeliveriesAfter: summary.correctDeliveriesAfter,
  confusion: summary.confusion,
  gateStatusCounts: summary.gateStatusCounts,
}, null, 2));
