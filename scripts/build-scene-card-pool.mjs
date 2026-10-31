/**
 * 从「可入库审计的权威资产」确定性生成运行卡池（离线、可复现、不依赖旧池）。
 *
 * 职责边界：
 * - 输入：docs/external-kb/scene-cards-v2.json（唯一权威资产，含全部卡片；
 *   verified 卡片带语料坐标与片段 SHA-256，unverified 卡片只保留旧版声明来源）。
 * - 输出：data/external-distilled/slices.json（生产加载器读取的运行池，被 .gitignore 忽略）。
 * - 生成是纯函数：按 id 排序、剔除离线审计字段（provenance / provenanceStatus / provenanceNote），
 *   相同资产重复运行产生字节一致的池文件。**不读取旧运行池**，因此运行池被删除后仍能完整重建。
 * - 来源验证与运行池生成分开：传 --corpus 才重新核验 verified 卡片的语料坐标与片段 SHA-256；
 *   不传时明确声明「未重新核验语料」，仍从已审计资产生成运行池。
 *
 * 用法：
 *   node scripts/build-scene-card-pool.mjs [--asset <资产路径>] [--pool <运行池路径>] [--corpus <novelbag-v0>]
 *
 * 退出码：0 = 成功；2 = 资产结构/来源校验失败（不写任何输出）。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

const DEFAULT_PATHS = {
  asset: join(REPO_ROOT, "docs", "external-kb", "scene-cards-v2.json"),
  pool: join(REPO_ROOT, "data", "external-distilled", "slices.json"),
};
const OVERLAP_WINDOW = 12;
/** 运行池允许写出的字段（与生产加载器 schema 一致；离线审计字段不得进入池）。 */
const RUNTIME_FIELD_ORDER = [
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
const AUDIT_ONLY_FIELDS = ["provenance", "provenanceStatus", "provenanceNote", "evidence"];

function parseArgs(argv) {
  const options = { corpus: null, ...DEFAULT_PATHS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if ((arg === "--asset" || arg === "--pool" || arg === "--corpus") && next) {
      const key = arg.slice(2);
      options[key] = key === "corpus" ? resolve(next) : resolve(next);
      index += 1;
    }
  }
  return options;
}

function fail(message) {
  console.error(`[build-scene-card-pool] 失败：${message}`);
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
  if (typeof value !== "string" || !value.trim()) fail(`卡片 ${cardId} 字段 ${field} 必须是非空字符串`);
  return value.trim();
}

function requireArray(value, field, cardId) {
  if (!Array.isArray(value)) fail(`卡片 ${cardId} 字段 ${field} 必须是数组`);
  return value;
}

/** 只保留中文字符、字母与数字，用于反抄袭比对。 */
function normalizeForOverlap(text) {
  return String(text).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
}

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

function cardProseText(card) {
  return [
    card.rule,
    card.anti_pattern,
    card.narrative_function,
    ...(card.applicable_when ?? []),
    ...(card.avoid_when ?? []),
    ...(card.emotion_target ?? []),
  ].filter(Boolean).join("");
}

/** 校验卡片字段并只输出运行池字段；审计字段一律丢弃。 */
function buildRuntimeSlice(card) {
  const cardId = requireNonEmptyString(card?.id, "id", "<unknown>");
  requireNonEmptyString(card?.scene_type, "scene_type", cardId);
  requireNonEmptyString(card?.rule, "rule", cardId);
  for (const field of ["emotion_target", "style_tags", "cost_type", "state_delta", "applicable_when", "avoid_when"]) {
    requireArray(card?.[field], field, cardId);
  }
  const slice = {};
  for (const field of RUNTIME_FIELD_ORDER) {
    slice[field] = card[field] ?? null;
  }
  slice.cost_type = card.cost_type ?? [];
  slice.state_delta = card.state_delta ?? [];
  slice.emotion_target = card.emotion_target ?? [];
  slice.style_tags = card.style_tags ?? [];
  slice.applicable_when = card.applicable_when ?? [];
  slice.avoid_when = card.avoid_when ?? [];
  return slice;
}

/** 用坐标回读语料，核对文件指纹、片段指纹与 12 字反抄袭。 */
function verifyAgainstCorpus(card, corpusRoot, fileCache) {
  const prov = card.provenance;
  if (!prov || typeof prov !== "object") fail(`verified 卡片 ${card.id} 缺少 provenance`);
  const filePath = join(corpusRoot, prov.sceneFile);
  if (!existsSync(filePath)) fail(`卡片 ${card.id} 语料文件不存在：${filePath}`);
  if (!fileCache.has(prov.sceneFile)) {
    fileCache.set(prov.sceneFile, {
      sha256: sha256(readFileSync(filePath)),
      doc: readJson(filePath, `语料文件 ${prov.sceneFile}`),
    });
  }
  const cached = fileCache.get(prov.sceneFile);
  if (cached.sha256 !== prov.sceneFileSha256) {
    fail(`卡片 ${card.id} 语料文件指纹与 provenance 不一致：${prov.sceneFile}`);
  }
  const located = (cached.doc.patterns ?? [])
    .flatMap((pattern) => (pattern.excerpts ?? []).map((excerpt) => ({ excerpt, sourceWork: pattern.source_work })))
    .find(({ excerpt }) => excerpt.start_pos === prov.startPos && excerpt.end_pos === prov.endPos);
  if (!located) fail(`卡片 ${card.id} 坐标在语料中不存在：${prov.sceneFile}#${prov.startPos}-${prov.endPos}`);
  if (located.sourceWork !== prov.sourceWork) fail(`卡片 ${card.id} 来源作品与语料不一致`);
  const excerptSha = sha256(Buffer.from(located.excerpt.text, "utf8"));
  if (excerptSha !== prov.excerptSha256) fail(`卡片 ${card.id} 片段指纹与语料不一致`);
  const overlap = findOverlap(cardProseText(card), located.excerpt.text);
  if (overlap) fail(`卡片 ${card.id} 与语料片段存在 ${OVERLAP_WINDOW} 字连续重合（「${overlap}」），疑似复述原文`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const asset = readJson(options.asset, "权威资产");
  if (asset?.schemaVersion !== 3) fail(`权威资产 schemaVersion 必须为 3，实际为 ${asset?.schemaVersion}`);
  if (!Array.isArray(asset.cards) || asset.cards.length === 0) fail("权威资产 cards 必须为非空数组");

  const ids = new Set();
  const verifiedCards = [];
  const unverifiedCards = [];
  for (const card of asset.cards) {
    const cardId = requireNonEmptyString(card?.id, "id", "<unknown>");
    if (ids.has(cardId)) fail(`权威资产存在重复卡片 id：${cardId}`);
    ids.add(cardId);
    const extra = Object.keys(card).filter(
      (key) => !RUNTIME_FIELD_ORDER.includes(key) && !AUDIT_ONLY_FIELDS.includes(key),
    );
    if (extra.length > 0) fail(`卡片 ${cardId} 含未知字段：${extra.join(",")}`);
    if (card.provenanceStatus === "verified") verifiedCards.push(card);
    else if (card.provenanceStatus === "unverified") unverifiedCards.push(card);
    else fail(`卡片 ${cardId} 必须标注 provenanceStatus=verified|unverified`);
  }

  let corpusReverified = false;
  if (options.corpus) {
    if (!existsSync(options.corpus)) fail(`语料根目录不存在：${options.corpus}`);
    const fileCache = new Map();
    for (const card of verifiedCards) verifyAgainstCorpus(card, options.corpus, fileCache);
    corpusReverified = true;
  }

  const slices = asset.cards
    .map((card) => buildRuntimeSlice(card))
    .sort((a, b) => a.id.localeCompare(b.id));

  mkdirSync(dirname(options.pool), { recursive: true });
  const tempPath = `${options.pool}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(slices, null, 2)}\n`, "utf8");
  renameSync(tempPath, options.pool);

  const summary = {
    assetPath: options.asset,
    assetSha256: sha256(readFileSync(options.asset)),
    poolPath: options.pool,
    poolSha256: sha256(readFileSync(options.pool)),
    cardCount: slices.length,
    verifiedCount: verifiedCards.length,
    unverifiedCount: unverifiedCards.length,
    corpusReverified,
    corpusRoot: corpusReverified ? options.corpus : null,
    verificationNote: corpusReverified
      ? "verified 卡片已重新核验语料文件/片段 SHA-256 与坐标；unverified 卡片仅保留旧版声明来源。"
      : "未重新核验语料：本次仅从已审计资产生成运行池；unverified 卡片不得据此宣称已核对出处。",
  };
  console.log(JSON.stringify(summary, null, 2));
}

main();
