/**
 * 外挂知识库第二阶段卡片蒸馏（离线、确定性、可审计）。
 *
 * 目标：把「蒸馏者阅读真实语料片段后抽象出的可迁移机制」落成结构化 Craft Pattern Card，
 * 并为每张卡生成可回溯的 provenance（语料文件 + 来源作品 + 片段坐标 + 片段 SHA-256）。
 *
 * 边界（本脚本刻意不做的事）：
 * - 不读取、不输出、不保存任何外部小说原文或摘录；片段只用于「定位校验 + 反抄袭比对」，
 *   校验完即丢弃，只保留哈希与坐标。
 * - 不改生产检索机制、准入阈值、fallback、topK；输出卡片字段与现有 schema 完全兼容，
 *   新增的 `provenance` 只是离线审计字段，生产加载器会忽略未知字段。
 * - 不自动生成卡片文本：rule / anti_pattern 等机制描述来自 drafts 文件（人工蒸馏产物），
 *   脚本只负责「证据是否真实存在 + 是否抄袭原文 + 输出是否确定性」。
 *
 * 结构：本脚本只负责「来源验证 + 权威资产生成」，**不再写运行池**。权威资产
 * `docs/external-kb/scene-cards-v2.json` 包含全部卡片（新卡 verified + 旧卡 unverified），
 * 由 `scripts/build-scene-card-pool.mjs` 从该资产确定性生成 `data/external-distilled/slices.json`。
 * 这样即使运行池被删除，也能从入库资产完整重建，不依赖旧池。
 *
 * 确定性保证：输入文件按路径排序、卡片按 id 排序、无时间戳；相同输入重复运行产生
 * 字节一致的资产 / provenance 文件，并可用于核对哈希。
 *
 * 用法：
 *   node scripts/distill-scene-cards.mjs --corpus <novelbag-v0 根目录> \
 *     [--drafts docs/external-kb/scene-card-drafts-v2.json] \
 *     [--legacy docs/external-kb/scene-card-legacy-v1.json] \
 *     [--asset docs/external-kb/scene-cards-v2.json] \
 *     [--provenance docs/external-kb/corpus-provenance.json]
 *
 * 退出码：0 = 成功；2 = 参数/证据/契约校验失败（不写任何输出）。
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

/** 反抄袭窗口：卡片文本与证据片段不得存在该长度的连续重合（去空白与标点后）。 */
const OVERLAP_WINDOW = 12;

const DEFAULT_PATHS = {
  drafts: join(REPO_ROOT, "docs", "external-kb", "scene-card-drafts-v2.json"),
  legacy: join(REPO_ROOT, "docs", "external-kb", "scene-card-legacy-v1.json"),
  asset: join(REPO_ROOT, "docs", "external-kb", "scene-cards-v2.json"),
  provenance: join(REPO_ROOT, "docs", "external-kb", "corpus-provenance.json"),
};

/** 卡片允许写出的字段白名单：显式构造，杜绝把任意草稿字段（尤其原文）带进产物。 */
const CARD_FIELD_ORDER = [
  "id",
  "scene_type",
  "chapter_phase",
  "emotion_target",
  "narrative_function",
  "style_tags",
  "scene_function",
  "beat",
  "pressure_type",
  "decision_tradeoff",
  "cost_type",
  "state_delta",
  "rule",
  "anti_pattern",
  "applicable_when",
  "avoid_when",
  "source",
  "confidence",
];

function parseArgs(argv) {
  const options = { corpus: null, ...DEFAULT_PATHS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if ((arg === "--corpus" || arg === "--drafts" || arg === "--legacy"
      || arg === "--asset" || arg === "--provenance") && next) {
      const key = arg.slice(2);
      options[key] = key === "corpus" ? next : resolve(next);
      index += 1;
    }
  }
  return options;
}

function fail(message) {
  console.error(`[distill-scene-cards] 失败：${message}`);
  process.exit(2);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function readJson(path, label) {
  if (!existsSync(path)) fail(`${label} 不存在：${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} 解析失败（${path}）：${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireNonEmptyString(value, field, cardId) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`卡片 ${cardId} 字段 ${field} 必须是非空字符串`);
  }
  return value.trim();
}

function requireArray(value, field, cardId, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) fail(`卡片 ${cardId} 字段 ${field} 必须是数组`);
    if (!allowEmpty && value.length === 0) fail(`卡片 ${cardId} 字段 ${field} 不得为空数组`);
  return value;
}

function optionalStringOrNull(value, field, cardId) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.trim()) {
    fail(`卡片 ${cardId} 字段 ${field} 必须是 null 或非空字符串`);
  }
  return value.trim();
}

/** 只保留中文字符、字母与数字，用于反抄袭比对。 */
function normalizeForOverlap(text) {
  return String(text).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
}

/** 返回卡片文本与片段文本的连续重合片段（长度 = OVERLAP_WINDOW），无重合返回 null。 */
function findOverlap(cardText, excerptText) {
  const cardNorm = normalizeForOverlap(cardText);
  const excerptNorm = normalizeForOverlap(excerptText);
  if (cardNorm.length < OVERLAP_WINDOW || excerptNorm.length < OVERLAP_WINDOW) return null;
  for (let index = 0; index + OVERLAP_WINDOW <= cardNorm.length; index += 1) {
    const fragment = cardNorm.slice(index, index + OVERLAP_WINDOW);
    if (excerptNorm.includes(fragment)) return fragment;
  }
  return null;
}

function collectCardText(card) {
  return [
    card.rule,
    card.anti_pattern,
    card.narrative_function,
    ...(card.applicable_when ?? []),
    ...(card.avoid_when ?? []),
    ...(card.emotion_target ?? []),
  ].filter(Boolean).join("");
}

function listSceneFiles(corpusRoot) {
  const scenesDir = join(corpusRoot, "scenes");
  if (!existsSync(scenesDir)) fail(`语料目录缺少 scenes/：${scenesDir}`);
  return readdirSync(scenesDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(scenesDir, name));
}

/** 建立片段索引：key = scene_type|source_work|start|end。 */
function buildCorpusIndex(corpusRoot) {
  const files = listSceneFiles(corpusRoot);
  const index = new Map();
  const fileEntries = [];
  for (const fullPath of files) {
    const buffer = readFileSync(fullPath);
    let parsed;
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch (error) {
      fail(`语料文件解析失败（${fullPath}）：${error instanceof Error ? error.message : String(error)}`);
    }
    const sceneFile = relative(corpusRoot, fullPath).replace(/\\/g, "/");
    let excerptCount = 0;
    const works = new Set();
    for (const pattern of parsed?.patterns ?? []) {
      const sceneType = String(pattern?.scene_type ?? "").trim();
      const sourceWork = String(pattern?.source_work ?? "").trim();
      if (sourceWork) works.add(sourceWork);
      for (const excerpt of pattern?.excerpts ?? []) {
        const start = Number(excerpt?.start_pos);
        const end = Number(excerpt?.end_pos);
        const text = typeof excerpt?.text === "string" ? excerpt.text : "";
        if (!sceneType || !sourceWork || !text || !Number.isFinite(start) || !Number.isFinite(end)) {
          continue;
        }
        excerptCount += 1;
        const key = `${sceneType}|${sourceWork}|${start}|${end}`;
        // 同一坐标在同类场景文件中唯一；若重复出现则保留首个并记录（确定性）。
        if (!index.has(key)) {
          index.set(key, { sceneFile, sceneType, sourceWork, start, end, text, wordCount: Number(excerpt?.word_count) || 0 });
        }
      }
    }
    fileEntries.push({
      sceneFile,
      bytes: buffer.length,
      sha256: sha256(buffer),
      excerptCount,
      works: [...works].sort(),
    });
  }
  return { index, fileEntries };
}

/** 从草稿构造「只含白名单字段」的验证卡片，并注入 provenance。 */
function buildVerifiedCard(draft, corpusRoot, corpusIndex) {
  const cardId = requireNonEmptyString(draft?.id, "id", "<unknown>");
  const evidence = draft?.evidence;
  if (!evidence || typeof evidence !== "object") fail(`卡片 ${cardId} 缺少 evidence 指针`);
  const sceneFile = requireNonEmptyString(evidence.scene_file, "evidence.scene_file", cardId);
  const sceneType = requireNonEmptyString(evidence.scene_type, "evidence.scene_type", cardId);
  const sourceWork = requireNonEmptyString(evidence.source_work, "evidence.source_work", cardId);
  const start = Number(evidence.start_pos);
  const end = Number(evidence.end_pos);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    fail(`卡片 ${cardId} 的 evidence 坐标无效：start=${evidence.start_pos} end=${evidence.end_pos}`);
  }

  const entry = corpusIndex.get(`${sceneType}|${sourceWork}|${start}|${end}`);
  if (!entry) {
    fail(`卡片 ${cardId} 的证据片段在语料中不存在：${sceneType}|${sourceWork}|${start}-${end}`);
  }
  if (entry.sceneFile !== sceneFile) {
    fail(`卡片 ${cardId} 声明的 scene_file=${sceneFile} 与实际所在文件 ${entry.sceneFile} 不一致`);
  }

  const overlap = findOverlap(collectCardText(draft), entry.text);
  if (overlap) {
    fail(`卡片 ${cardId} 与证据片段存在 ${OVERLAP_WINDOW} 字连续重合（「${overlap}」），疑似复述原文`);
  }

  const fileEntry = corpusFileSha(corpusRoot, entry.sceneFile);
  const card = {};
  for (const field of CARD_FIELD_ORDER) {
    switch (field) {
      case "id":
        card.id = cardId;
        break;
      case "rule":
      case "anti_pattern":
      case "narrative_function":
        card[field] = requireNonEmptyString(draft[field], field, cardId);
        break;
      case "chapter_phase":
        card.chapter_phase = requireNonEmptyString(draft.chapter_phase, "chapter_phase", cardId);
        break;
      case "scene_type":
        card.scene_type = sceneType;
        break;
      case "emotion_target":
      case "style_tags":
      case "cost_type":
      case "state_delta":
        card[field] = requireArray(draft[field], field, cardId);
        break;
      case "scene_function":
      case "beat":
        card[field] = requireNonEmptyString(draft[field], field, cardId);
        break;
      case "pressure_type":
      case "decision_tradeoff":
        card[field] = optionalStringOrNull(draft[field], field, cardId);
        break;
      case "applicable_when":
      case "avoid_when":
        card[field] = requireArray(draft[field], field, cardId, { allowEmpty: false });
        break;
      case "source":
        card.source = `${sourceWork} ${sceneFile}#${start}-${end}`;
        break;
      case "confidence":
        card.confidence = requireNonEmptyString(draft.confidence, "confidence", cardId);
        break;
      default:
        fail(`未处理的字段 ${field}`);
    }
  }

  card.provenanceStatus = "verified";
  card.provenance = {
    corpusRoot,
    sceneFile,
    sceneFileSha256: fileEntry.sha256,
    sceneType,
    sourceWork,
    startPos: start,
    endPos: end,
    excerptChars: entry.text.length,
    excerptSha256: sha256(Buffer.from(entry.text, "utf8")),
    sampleId: `${sceneType}:${sourceWork}:${start}-${end}`,
  };
  return card;
}

/**
 * 旧版卡片：只有声明的来源作品/章节，没有可核验坐标。只校验字段完整性，
 * 不补造 evidence、不写 provenance，统一标 provenanceStatus=unverified。
 */
function buildLegacyCard(raw) {
  const cardId = requireNonEmptyString(raw?.id, "id", "<unknown>");
  if (raw?.provenanceStatus !== "unverified") {
    fail(`旧版卡片 ${cardId} 必须显式标注 provenanceStatus=unverified`);
  }
  if (raw?.provenance !== undefined) {
    fail(`旧版卡片 ${cardId} 不得携带 provenance（未重新核验的出处不得伪装成已验证）`);
  }
  const card = {};
  for (const field of CARD_FIELD_ORDER) {
    switch (field) {
      case "id":
        card.id = cardId;
        break;
      case "rule":
      case "anti_pattern":
      case "narrative_function":
        card[field] = requireNonEmptyString(raw[field], field, cardId);
        break;
      case "chapter_phase":
        card.chapter_phase = requireNonEmptyString(raw.chapter_phase, "chapter_phase", cardId);
        break;
      case "scene_type":
        card.scene_type = requireNonEmptyString(raw.scene_type, "scene_type", cardId);
        break;
      case "emotion_target":
      case "style_tags":
      case "cost_type":
      case "state_delta":
        card[field] = requireArray(raw[field], field, cardId);
        break;
      case "scene_function":
      case "beat":
        card[field] = requireNonEmptyString(raw[field], field, cardId);
        break;
      case "pressure_type":
      case "decision_tradeoff":
        card[field] = optionalStringOrNull(raw[field], field, cardId);
        break;
      case "applicable_when":
      case "avoid_when":
        card[field] = requireArray(raw[field], field, cardId, { allowEmpty: false });
        break;
      case "source":
        card.source = requireNonEmptyString(raw.source, "source", cardId);
        break;
      case "confidence":
        card.confidence = requireNonEmptyString(raw.confidence, "confidence", cardId);
        break;
      default:
        fail(`未处理的字段 ${field}`);
    }
  }
  card.provenanceStatus = "unverified";
  card.provenanceNote = requireNonEmptyString(raw.provenanceNote, "provenanceNote", cardId);
  return card;
}

function corpusFileSha(corpusRoot, sceneFile) {
  const fullPath = join(corpusRoot, sceneFile);
  return { sha256: sha256(readFileSync(fullPath)) };
}

/** 原子写入（tmp → rename）：中断时不会留下半截 JSON。 */
function writeJsonAtomic(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

function countBy(items, keyFn) {
  const out = {};
  for (const item of items) {
    const key = keyFn(item) ?? "null";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** beat × scene_function 覆盖矩阵：只统计实际存在的组合。 */
function buildMatrix(cards) {
  const matrix = {};
  for (const card of cards) {
    const beat = card.beat ?? "null";
    const fn = card.scene_function ?? "null";
    matrix[beat] = matrix[beat] ?? {};
    matrix[beat][fn] = (matrix[beat][fn] ?? 0) + 1;
  }
  return matrix;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.corpus) {
    fail("必须显式传入 --corpus <novelbag-v0 根目录>（脚本不硬编码本机语料路径）");
  }
  const corpusRoot = resolve(options.corpus);
  if (!existsSync(corpusRoot)) fail(`语料根目录不存在：${corpusRoot}`);

  const drafts = readJson(options.drafts, "drafts");
  const draftCards = Array.isArray(drafts?.cards) ? drafts.cards : null;
  if (!draftCards || draftCards.length === 0) fail("drafts 文件中没有 cards 数组或为空");

  const { index, fileEntries } = buildCorpusIndex(corpusRoot);

  const verifiedCards = [];
  const seenIds = new Set();
  const seenSamples = new Set();
  for (const draft of draftCards) {
    const card = buildVerifiedCard(draft, corpusRoot, index);
    if (seenIds.has(card.id)) fail(`drafts 中存在重复卡片 id：${card.id}`);
    seenIds.add(card.id);
    if (seenSamples.has(card.provenance.sampleId)) {
      fail(`不同卡片指向同一样本（sampleId=${card.provenance.sampleId}）；请确认是否重复蒸馏`);
    }
    seenSamples.add(card.provenance.sampleId);
    verifiedCards.push(card);
  }
  verifiedCards.sort((a, b) => a.id.localeCompare(b.id));

  // 旧版卡片：只保留声明来源，未重新核验语料；不得补造出处。合并进同一份权威资产。
  const legacyDoc = readJson(options.legacy, "旧版卡片");
  const legacyRaw = Array.isArray(legacyDoc?.cards) ? legacyDoc.cards : null;
  if (!legacyRaw || legacyRaw.length === 0) fail("旧版卡片文件中没有 cards 数组或为空");
  const legacyCards = [];
  for (const raw of legacyRaw) {
    const card = buildLegacyCard(raw);
    if (seenIds.has(card.id)) fail(`新旧卡片存在重复 id：${card.id}`);
    seenIds.add(card.id);
    legacyCards.push(card);
  }

  const cards = [...verifiedCards, ...legacyCards].sort((a, b) => a.id.localeCompare(b.id));

  const provenance = {
    schemaVersion: 1,
    description: "novelbag-v0 外部语料的来源清单与指纹。仅记录路径、字节数与 SHA-256，不保存任何原文内容；语料本身不在仓库内，也不得提交。",
    corpusRoot,
    corpusRootNote: "本轮实际使用的本机语料绝对路径，仅用于审计定位；运行时不依赖该路径。",
    totals: {
      sceneFiles: fileEntries.length,
      sceneExcerpts: fileEntries.reduce((sum, entry) => sum + entry.excerptCount, 0),
      works: [...new Set(fileEntries.flatMap((entry) => entry.works))].sort(),
    },
    files: fileEntries,
  };

  const asset = {
    schemaVersion: 3,
    description: "外挂知识库结构化卡片的唯一权威资产（可入库审计）。verified 卡片带语料坐标与片段 SHA-256；unverified 卡片只保留旧版声明的来源作品与章节，未重新核验语料。不含任何外部小说原文或摘录。运行池由 scripts/build-scene-card-pool.mjs 从本文件确定性生成。",
    provenanceFile: relative(REPO_ROOT, options.provenance).replace(/\\/g, "/"),
    overlapWindow: OVERLAP_WINDOW,
    corpusVerification: {
      verifiedCount: verifiedCards.length,
      unverifiedCount: legacyCards.length,
      verifiedAgainstCorpusRoot: corpusRoot,
      unverifiedNote: "unverified 卡片未重新核验语料坐标，不得据此宣称已核对出处，也不得补造 evidence。",
    },
    cards,
  };

  writeJsonAtomic(options.asset, asset);
  writeJsonAtomic(options.provenance, provenance);

  const assetRaw = readFileSync(options.asset);
  const summary = {
    cardCount: cards.length,
    verifiedCount: verifiedCards.length,
    unverifiedCount: legacyCards.length,
    assetPath: options.asset,
    assetSha256: sha256(assetRaw),
    provenanceSha256: sha256(readFileSync(options.provenance)),
    beatCoverage: countBy(cards, (card) => card.beat),
    sceneFunctionCoverage: countBy(cards, (card) => card.scene_function),
    beatSceneFunctionMatrix: buildMatrix(cards),
    corpusFiles: fileEntries.length,
    corpusExcerpts: provenance.totals.sceneExcerpts,
    corpusWorks: provenance.totals.works,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main();
