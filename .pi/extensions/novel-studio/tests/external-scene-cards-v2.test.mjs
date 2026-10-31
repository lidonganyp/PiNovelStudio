/**
 * EXTERNAL-KB-2/3 — 结构化卡片权威资产（19 张）+ 运行池可从零重建。
 *
 * 验证六件事：
 * 1. 权威资产（docs/external-kb/scene-cards-v2.json，schemaVersion=3）结构完整：19 张卡、
 *    id 唯一、schema 字段齐全、不含原文/摘录字段，渲染为 P4 advisory 后 ≤520 字；
 * 2. 来源分层：verified 卡片带可回溯 provenance（坐标 / 语料文件 SHA-256 / 片段 SHA-256）；
 *    unverified 卡片不得携带 provenance，只能保留 provenanceStatus + provenanceNote；
 * 3. provenance 与 corpus-provenance.json 的语料文件指纹一致（仅 verified 卡片）；
 * 4. 准入逻辑未被放宽：每张卡用自身结构化标签构造检索键，仍能通过
 *    「≥2 个独立维度 + 至少一个主维度 + 结构化分数阈值」；
 * 5. **运行池可从零重建（不依赖旧池、不以 skip 代替验收）**：在临时空目录调用
 *    scripts/build-scene-card-pool.mjs 生成 19 张、连续两次字节一致，并与仓库内运行池
 *    （若存在）字节一致；
 * 6. 真实语料存在时，用坐标回读片段核对 excerptSha256，并做 12 字连续重合反抄袭检查；
 *    语料不在本机时只跳过「回读」这一步（资产结构与重建验收仍然必须通过）。
 *
 * 本测试不修改生产检索机制、阈值、fallback 或 topK，只校验数据与可回放性。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXTERNAL_SLICE_MAX_CHARS,
  EXTERNAL_KB_MIN_STRUCTURED_HITS,
  EXTERNAL_KB_STRUCTURAL_MIN_SCORE,
  retrieveExternalDistilledSlices,
  renderSliceAdvisory,
} from "../dist/v2/core/external-knowledge-base.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..", "..", "..");
const CARDS_PATH = join(REPO_ROOT, "docs", "external-kb", "scene-cards-v2.json");
const PROVENANCE_PATH = join(REPO_ROOT, "docs", "external-kb", "corpus-provenance.json");
const POOL_PATH = join(REPO_ROOT, "data", "external-distilled", "slices.json");
const POOL_SCRIPT_PATH = join(REPO_ROOT, "scripts", "build-scene-card-pool.mjs");

const EXPECTED_CARD_COUNT = 19;
const OVERLAP_WINDOW = 12;
const CARD_KEYS = [
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
const PROVENANCE_KEYS = [
  "corpusRoot",
  "sceneFile",
  "sceneFileSha256",
  "sceneType",
  "sourceWork",
  "startPos",
  "endPos",
  "excerptChars",
  "excerptSha256",
  "sampleId",
];
/** 离线审计字段：可进资产，但绝不进运行池。 */
const AUDIT_ONLY_KEYS = ["provenance", "provenanceStatus", "provenanceNote"];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** 去空白与标点后的 12 字连续重合检测（与离线蒸馏脚本口径一致）。 */
function hasPlagiarizedOverlap(cardText, excerptText) {
  const normalize = (text) => text.replace(/[\s\p{P}]+/gu, "");
  const card = normalize(cardText);
  const excerpt = normalize(excerptText);
  if (card.length < OVERLAP_WINDOW || excerpt.length < OVERLAP_WINDOW) return false;
  for (let index = 0; index + OVERLAP_WINDOW <= excerpt.length; index += 1) {
    if (card.includes(excerpt.slice(index, index + OVERLAP_WINDOW))) return true;
  }
  return false;
}

function cardProseText(card) {
  return [
    card.narrative_function ?? "",
    card.rule ?? "",
    card.anti_pattern ?? "",
    (card.style_tags ?? []).join(" "),
    (card.applicable_when ?? []).join(" "),
    (card.avoid_when ?? []).join(" "),
  ].join(" ");
}

/** 剥离审计字段，得到生产运行池形态的 slice。 */
function toRuntimeSlice(card) {
  const slice = {};
  for (const key of CARD_KEYS) slice[key] = card[key];
  return slice;
}

function runPoolBuilder(poolPath) {
  const result = spawnSync(
    process.execPath,
    [POOL_SCRIPT_PATH, "--asset", CARDS_PATH, "--pool", poolPath],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `运行池生成失败：${result.stderr || result.stdout}`);
  return readFileSync(poolPath);
}

test("scene-cards-v2：权威资产结构完整、无原文、advisory 有界", () => {
  assert.ok(existsSync(CARDS_PATH), `缺少卡片产物：${CARDS_PATH}`);
  const doc = readJson(CARDS_PATH);
  assert.equal(doc.schemaVersion, 3);
  assert.ok(Array.isArray(doc.cards) && doc.cards.length > 0, "cards 必须非空");
  assert.equal(doc.cards.length, EXPECTED_CARD_COUNT, `卡片数量应为 ${EXPECTED_CARD_COUNT}`);
  assert.ok(doc.cards.length <= 60, "第二阶段卡片规模不得超过 60");

  const ids = new Set();
  const sampleIds = new Set();
  const verification = { verified: 0, unverified: 0 };
  for (const card of doc.cards) {
    assert.equal(typeof card.id, "string");
    assert.ok(card.id.length > 0);
    assert.ok(!ids.has(card.id), `重复卡片 id：${card.id}`);
    ids.add(card.id);

    // 只允许白名单字段 + 离线审计字段：杜绝原文/摘录/近似原文被带进生产卡片。
    const extraKeys = Object.keys(card).filter(
      (key) => !CARD_KEYS.includes(key) && !AUDIT_ONLY_KEYS.includes(key),
    );
    assert.deepEqual(extraKeys, [], `${card.id} 含非白名单字段：${extraKeys.join(",")}`);
    for (const key of CARD_KEYS) {
      // 字段必须存在（可为 null 表示该维度不适用），不允许静默缺键。
      assert.ok(Object.hasOwn(card, key), `${card.id} 缺少字段 ${key}`);
    }

    // 机制描述是可迁移判断，不是原文复述。
    assert.ok(card.rule.length >= 10 && card.rule.length <= 200, `${card.id} rule 长度异常`);
    const rendered = renderSliceAdvisory(toRuntimeSlice(card));
    assert.ok(rendered.length <= EXTERNAL_SLICE_MAX_CHARS, `${card.id} advisory 超过 ${EXTERNAL_SLICE_MAX_CHARS}`);

    assert.ok(
      ["verified", "unverified"].includes(card.provenanceStatus),
      `${card.id} provenanceStatus 非法：${card.provenanceStatus}`,
    );
    verification[card.provenanceStatus] += 1;

    if (card.provenanceStatus === "unverified") {
      // 旧版卡片：不得伪造出处，只保留声明来源 + 明确标注。
      assert.ok(!Object.hasOwn(card, "provenance"), `${card.id} unverified 卡片不得携带 provenance`);
      assert.equal(typeof card.provenanceNote, "string");
      assert.ok(card.provenanceNote.length > 0, `${card.id} 缺少 provenanceNote`);
      assert.equal(typeof card.source, "string");
      assert.ok(card.source.length > 0, `${card.id} 缺少声明来源`);
      continue;
    }

    // verified 卡片：provenance 必填且自洽。
    assert.ok(card.provenance && typeof card.provenance === "object", `${card.id} 缺少 provenance`);
    for (const key of PROVENANCE_KEYS) {
      assert.ok(card.provenance[key] !== undefined && card.provenance[key] !== null, `${card.id} provenance 缺少 ${key}`);
    }
    const prov = card.provenance;
    assert.equal(
      prov.sampleId,
      `${prov.sceneType}:${prov.sourceWork}:${prov.startPos}-${prov.endPos}`,
      `${card.id} sampleId 与坐标不一致`,
    );
    assert.ok(prov.startPos < prov.endPos, `${card.id} 坐标区间非法`);
    assert.match(prov.excerptSha256, /^[0-9a-f]{64}$/u, `${card.id} excerptSha256 非法`);
    assert.match(prov.sceneFileSha256, /^[0-9a-f]{64}$/u, `${card.id} sceneFileSha256 非法`);
    assert.ok(
      card.source.includes(`${prov.sceneFile}#${prov.startPos}-${prov.endPos}`),
      `${card.id} source 无法回到语料坐标`,
    );
    assert.ok(!sampleIds.has(prov.sampleId), `不同卡片复用同一样本：${prov.sampleId}`);
    sampleIds.add(prov.sampleId);
  }

  assert.equal(verification.verified, doc.corpusVerification?.verifiedCount, "verified 计数与资产声明不一致");
  assert.equal(verification.unverified, doc.corpusVerification?.unverifiedCount, "unverified 计数与资产声明不一致");
});

test("scene-cards-v2：verified 卡片指纹与语料清单一致", () => {
  assert.ok(existsSync(PROVENANCE_PATH), `缺少来源清单：${PROVENANCE_PATH}`);
  const provenanceDoc = readJson(PROVENANCE_PATH);
  assert.equal(provenanceDoc.schemaVersion, 1);
  assert.ok(Array.isArray(provenanceDoc.files) && provenanceDoc.files.length > 0);
  const fileByPath = new Map(provenanceDoc.files.map((entry) => [entry.sceneFile, entry]));
  for (const entry of provenanceDoc.files) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/u, `${entry.sceneFile} sha256 非法`);
    assert.ok(entry.bytes > 0);
    assert.ok(entry.excerptCount > 0);
  }
  const doc = readJson(CARDS_PATH);
  for (const card of doc.cards) {
    if (card.provenanceStatus !== "verified") continue;
    const entry = fileByPath.get(card.provenance.sceneFile);
    assert.ok(entry, `${card.id} 指向的语料文件不在来源清单：${card.provenance.sceneFile}`);
    assert.equal(entry.sha256, card.provenance.sceneFileSha256, `${card.id} 语料文件指纹不一致`);
  }
});

test("scene-cards-v2：结构化准入未被放宽（每张卡仍过 ≥2 维 + 主维度 + 阈值）", () => {
  const doc = readJson(CARDS_PATH);
  const slices = doc.cards.map((card) => toRuntimeSlice(card));
  for (const card of doc.cards) {
    const key = {
      sceneFunction: card.scene_function,
      beat: card.beat,
      pressureType: card.pressure_type ?? null,
      decisionTradeoff: card.decision_tradeoff ?? null,
      costType: card.cost_type ?? [],
      stateDelta: card.state_delta ?? [],
      readerEffect: card.emotion_target ?? [],
    };
    const query = [
      card.narrative_function,
      (card.style_tags ?? []).join(" "),
      (card.applicable_when ?? []).join(" "),
    ].join(" ");
    const selection = retrieveExternalDistilledSlices({
      slices,
      query,
      retrievalKey: key,
      topK: 1,
    });
    const hits = selection.report.structuredHitsById[card.id] ?? 0;
    assert.ok(hits >= EXTERNAL_KB_MIN_STRUCTURED_HITS, `${card.id} 仅 ${hits} 个独立维度命中`);
    assert.ok(
      !selection.report.droppedByHardFilterIds.includes(card.id),
      `${card.id} 被自身标签查询的 avoid_when 硬过滤`,
    );
    assert.equal(selection.report.retrievalKey?.sceneFunction, key.sceneFunction);
  }
  // 兜底：未命中任何维度的查询必须返回空，证明没有 fallback 放行。
  const emptySelection = retrieveExternalDistilledSlices({
    slices,
    query: doc.description ?? "",
    retrievalKey: {
      sceneFunction: null,
      beat: null,
      pressureType: null,
      decisionTradeoff: null,
      costType: [],
      stateDelta: [],
      readerEffect: [],
    },
    topK: 1,
  });
  assert.deepEqual(emptySelection.items, []);
  assert.equal(emptySelection.report.selectionMode, "none");
});

test("scene-cards-v2：运行池可从未入库资产在空目录确定性重建（不依赖旧池）", () => {
  assert.ok(existsSync(POOL_SCRIPT_PATH), `缺少运行池生成脚本：${POOL_SCRIPT_PATH}`);
  const doc = readJson(CARDS_PATH);
  const expectedIds = doc.cards.map((card) => card.id).sort();

  const workDir = mkdtempSync(join(tmpdir(), "scene-pool-rebuild-"));
  try {
    const poolA = join(workDir, "slices-a.json");
    const poolB = join(workDir, "slices-b.json");
    const bytesA = runPoolBuilder(poolA);
    const bytesB = runPoolBuilder(poolB);

    // 连续两次生成必须字节一致（确定性）。
    assert.equal(sha256(bytesA), sha256(bytesB), "两次空目录生成的运行池哈希不一致");

    const pool = JSON.parse(bytesA.toString("utf8"));
    assert.ok(Array.isArray(pool), "运行池必须是数组");
    assert.equal(pool.length, EXPECTED_CARD_COUNT, `运行池卡片数量应为 ${EXPECTED_CARD_COUNT}`);
    assert.deepEqual(
      pool.map((entry) => entry.id).sort(),
      expectedIds,
      "运行池 id 集合与权威资产不一致",
    );
    for (const entry of pool) {
      for (const auditKey of AUDIT_ONLY_KEYS) {
        assert.ok(!Object.hasOwn(entry, auditKey), `${entry.id} 运行池出现离线审计字段 ${auditKey}`);
      }
      assert.ok(!("text" in entry) && !("excerpt" in entry), `${entry.id} 运行池出现原文/摘录字段`);
    }

    // 与仓库内运行池（若存在）字节一致：证明「资产 → 池」是唯一生成路径。
    if (existsSync(POOL_PATH)) {
      assert.equal(
        sha256(bytesA),
        sha256(readFileSync(POOL_PATH)),
        "空目录重建的运行池与仓库内运行池字节不一致",
      );
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("scene-cards-v2：真实语料回读校验（仅 verified 卡片；语料缺失时只跳过回读）", (t) => {
  const provenanceDoc = readJson(PROVENANCE_PATH);
  const corpusRoot = provenanceDoc.corpusRoot;
  if (!corpusRoot || !existsSync(corpusRoot)) {
    t.skip(`本机无该语料目录，跳过坐标回读：${corpusRoot}`);
    return;
  }
  const doc = readJson(CARDS_PATH);
  const cache = new Map();
  for (const card of doc.cards) {
    if (card.provenanceStatus !== "verified") continue;
    const prov = card.provenance;
    const filePath = join(corpusRoot, prov.sceneFile);
    assert.ok(existsSync(filePath), `${card.id} 语料文件不存在：${filePath}`);
    if (!cache.has(prov.sceneFile)) {
      cache.set(prov.sceneFile, readJson(filePath));
    }
    assert.equal(
      sha256(readFileSync(filePath)),
      prov.sceneFileSha256,
      `${prov.sceneFile} 语料文件指纹与清单不一致`,
    );
    const scene = cache.get(prov.sceneFile);
    // source_work 挂在 pattern 上，不在单条 excerpt 上。
    const located = (scene.patterns ?? [])
      .flatMap((pattern) =>
        (pattern.excerpts ?? []).map((excerpt) => ({ excerpt, sourceWork: pattern.source_work })),
      )
      .find(
        ({ excerpt }) =>
          excerpt.start_pos === prov.startPos && excerpt.end_pos === prov.endPos,
      );
    assert.ok(located, `${card.id} 坐标在语料中不存在`);
    const excerpt = located.excerpt;
    assert.equal(located.sourceWork, prov.sourceWork, `${card.id} 来源作品与语料不一致`);
    assert.equal(
      sha256(Buffer.from(excerpt.text, "utf8")),
      prov.excerptSha256,
      `${card.id} 片段指纹与语料不一致`,
    );
    assert.equal(excerpt.text.length, prov.excerptChars, `${card.id} 片段长度与语料不一致`);
    assert.ok(
      !hasPlagiarizedOverlap(cardProseText(card), excerpt.text),
      `${card.id} 与语料片段存在 ${OVERLAP_WINDOW} 字连续重合（疑似抄录）`,
    );
  }
});

test("scene-cards-v2：准入阈值常量未被改动", () => {
  assert.equal(EXTERNAL_KB_MIN_STRUCTURED_HITS, 2);
  assert.equal(EXTERNAL_KB_STRUCTURAL_MIN_SCORE, 0.3);
  assert.equal(EXTERNAL_SLICE_MAX_CHARS, 520);
});
