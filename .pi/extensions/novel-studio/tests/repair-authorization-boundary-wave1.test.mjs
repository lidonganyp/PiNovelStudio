/**
 * GREEN 测试：证据身份边界（REASONING-REPAIR-BOUNDARY-1 Wave 1A / RRB-1.1 + RRB-1.2）
 *
 * 锁定 Wave 1A 的期望行为（对应 RED 断言转绿后的精确行为锁）：
 *
 *   RRB-1.1 — EvidenceRecord 补齐非空 sourceContentHash + evidenceExcerptHash
 *   RRB-1.2 — guard finding 的 sourceRef 只作定位符，不再复用 finding 自身 id
 *
 * 与 repair-authorization-boundary-red.test.mjs 的 G1 结构断言互补：RED 断言“坏模式已移除”，
 * 本文件断言“好行为已落地”。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createNarrativeVerifierSuite } from "../dist/novelos/verification/narrative-verifier-suite.js";
import { canonToEvidenceRecord } from "../dist-test/v2/core/evidence-record-adapter.js";

function createContext(overrides = {}) {
  return {
    facts: [],
    characterStates: [],
    openLoops: [],
    worldRules: [],
    styleReferences: [],
    sourceMap: [],
    constitution: null,
    longTermState: null,
    ...overrides,
  };
}

test("RRB-1.1: EvidenceRecord 补齐非空 sourceContentHash + evidenceExcerptHash", () => {
  const record = canonToEvidenceRecord(
    {
      id: "canon:old",
      kind: "canon",
      fact: "碎星剑在叶尘手里",
      category: "entity",
      sourceChapter: "ch3",
      sourceRef: "ch3#canon:old",
      confidence: 1,
      lastUpdated: "2026-08-15T00:00:00.000Z",
    },
    "snap:test",
    10,
  );
  assert.ok(record, "应产出 EvidenceRecord");
  assert.ok(record.sourceContentHash.length > 0, "sourceContentHash 应非空");
  assert.ok(record.evidenceExcerptHash.length > 0, "evidenceExcerptHash 应非空");
  assert.notEqual(
    record.sourceContentHash,
    "",
    "sourceContentHash 不得回退为空串",
  );
});

test("RRB-1.2: guard finding 的 sourceRef 不再复用 finding 自身 id", () => {
  const verifier = createNarrativeVerifierSuite();
  const report = verifier.verify({
    text: "   \n   \n   ",
    context: createContext(),
    chapterIntent: "本章关于「林默」",
  });

  const guardFindings = report.findings.filter(
    (f) => f.source === "fact_continuity_guard",
  );
  assert.ok(guardFindings.length >= 1, "空文应产生 guard finding（format_error）");

  for (const f of guardFindings) {
    assert.notEqual(
      f.sourceRef,
      f.id,
      `guard finding 的 sourceRef 不应等于自身 id（定位符 ≠ identity）：${f.sourceRef}`,
    );
    assert.ok(
      typeof f.sourceRef === "string" && f.sourceRef.length > 0,
      `guard finding 的 sourceRef 应为非空定位符：${f.sourceRef}`,
    );
  }
});
