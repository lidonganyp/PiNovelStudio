import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractEvents } from "../dist/v2/core/event-extractor.js";
import { compareEventLedgers } from "../dist/v2/core/event-ledger-comparator.js";
import { buildAuthorStyleUserPrompt } from "../dist/v2/core/author-style-optimizer.js";
import { extractExplicitWorldEntities, loadWorldKeyEntities } from "../dist/v2/core/unified-entry.js";
import { hasContinuationPrefixMismatch } from "../dist/v2/core/chapter-continuation.js";

function ledger(rawText, editorialText, entities) {
  const raw = extractEvents(rawText, entities, { entityCoverage: "full_entities" });
  const editorial = extractEvents(editorialText, entities, { entityCoverage: "full_entities" });
  return compareEventLedgers({
    rawEvents: raw.events,
    editorialEvents: editorial.events,
    rawCausalChains: raw.causalChains,
    editorialCausalChains: editorial.causalChains,
    knownEntities: entities,
    entityCoverage: "full_entities",
    rawText,
    editorialText,
  });
}

test("同义状态改写不会被判定为状态变化丢失", () => {
  const result = ledger("裂痕在石壁上出现。", "裂痕在石壁上浮现。", ["裂痕", "石壁"]);
  assert.equal(result.stateChangeLosses.length, 0, JSON.stringify(result.stateChangeLosses));
  assert.equal(result.preserved, true, result.reason);
});

test("真正删除状态变化仍然被阻断", () => {
  const result = ledger("叶尘得到传承。", "叶尘思考人生。", ["叶尘", "传承"]);
  assert.ok(result.stateChangeLosses.some((item) => item.afterState === "得到"));
  assert.equal(result.preserved, false);
});

test("未遂状态变化改写不触发状态丢失阻断", () => {
  const result = ledger("神像几乎快要消散了。", "神像残缺不全。", ["神像"]);
  assert.equal(result.stateChangeLosses.length, 0, JSON.stringify(result.stateChangeLosses));
  assert.equal(result.preserved, true, result.reason);
});

test("普通位移和取放动作的同义改写不触发单条关键动作阻断", () => {
  const moved = ledger("叶尘走进密室。", "叶尘踏入密室。", ["叶尘", "密室"]);
  const picked = ledger("叶尘拿起古籍。", "叶尘抄起古籍。", ["叶尘", "古籍"]);
  assert.equal(moved.preserved, true, moved.reason);
  assert.equal(picked.preserved, true, picked.reason);
});

test("交付和封印等不可逆动作仍然单条阻断", () => {
  const delivered = ledger("叶尘交出玉玺。", "叶尘查看玉玺。", ["叶尘", "玉玺"]);
  const sealed = ledger("叶尘封印魔物。", "叶尘观察魔物。", ["叶尘", "魔物"]);
  assert.equal(delivered.preserved, false);
  assert.equal(sealed.preserved, false);
});

test("风格重试提示包含丢失的状态变化证据", () => {
  const prompt = buildAuthorStyleUserPrompt(
    {
      sourceCandidate: { id: "raw", text: "叶尘得到传承。" },
      chapterNumber: 17,
      intent: { authorEventSummaries: [], authorMustInclude: [], authorStateChanges: [], causalRelations: [], endingTarget: [], relevantCharacters: [], inviolableFacts: [] },
      context: {},
      constitution: null,
      modelGenerate: async () => ({ text: "", model: "test" }),
      driftFeedback: {
        replacedEvents: [],
        stateChangeLosses: [{ subject: "叶尘", afterState: "得到", rawSentence: "叶尘得到传承。", reason: "状态变化缺失" }],
      },
    },
    { referenceIds: [], guidance: [] },
  );
  assert.match(prompt, /叶尘/);
  assert.match(prompt, /得到/);
  assert.match(prompt, /状态变化/);
});

test("平台扁平 worldKeyTerms 也能进入完整实体表", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "world-key-entities-"));
  const workspacePath = join(projectRoot, "workspaces", "p252");
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(join(workspacePath, "config.json"), JSON.stringify({ worldKeyTerms: ["玉玺", "禁星渊"] }), "utf8");
  assert.deepEqual(loadWorldKeyEntities("p252", projectRoot), ["玉玺", "禁星渊"]);
});

test("worldKeyTerms 为空时只从明确世界观实体分节回填", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "world-key-fallback-"));
  const workspacePath = join(projectRoot, "workspaces", "p252");
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(join(workspacePath, "config.json"), JSON.stringify({ worldKeyTerms: [] }), "utf8");
  writeFileSync(join(workspacePath, "WORLDBUILDING-CANON.md"), "## 道具\n- **魂玉**：压制毒素\n## 普通叙事\n这里不应被当成实体。", "utf8");
  assert.deepEqual(loadWorldKeyEntities("p252", projectRoot), ["魂玉"]);
  assert.deepEqual(extractExplicitWorldEntities("## 道具\n- **魂玉**：压制毒素"), ["魂玉"]);
});

test("续写前缀被模型改写时必须标记为不一致", () => {
  const prefix = "前十六章原文结尾，作者内容必须保留。";
  assert.equal(hasContinuationPrefixMismatch(prefix, `${prefix}\n\n新的续写。`), false);
  assert.equal(hasContinuationPrefixMismatch(prefix, "前十六章原文结尾，作者内容被改写。\n\n新的续写。"), true);
});
