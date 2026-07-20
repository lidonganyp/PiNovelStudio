/** CEILING-REFERENCE-CASES-1 evaluator-only annotation tests. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CEILING_DIMENSION_IDS,
  buildReferenceQualityCase,
  validateReferenceQualityCase,
} from "../dist-eval/novelos/eval/ceiling-reference-cases.js";

const body = "主角握住钥匙，先观察门缝的光，再承担错过窗口的代价。";

function annotation() {
  return Object.fromEntries(CEILING_DIMENSION_IDS.map((id) => [id, {
    level: 4,
    evidence: [{ excerpt: body.slice(0, 12) }],
    rationale: "事件与选择形成因果。",
  }]));
}

test("CEILING-REFERENCE-CASES-1 可建立 5 类 evaluator-only 标注且不携带正文", () => {
  const kinds = ["opening_anomaly", "rule_reveal", "investigation", "character_conflict", "high_pressure_ending"];
  for (const [index, kind] of kinds.entries()) {
    const result = buildReferenceQualityCase({
      referenceId: `smsf:physical:${index}`,
      bodyHash: "a".repeat(64),
      kind,
      annotations: annotation(),
    });
    assert.equal(validateReferenceQualityCase(result).valid, true);
    assert.equal("body" in result, false);
    assert.equal("referenceText" in result, false);
    assert.equal(result.kind, kind);
  }
});

test("CEILING-REFERENCE-CASES-1 拒绝缺维度、非法等级、非法 span 和正文泄漏", () => {
  const base = buildReferenceQualityCase({
    referenceId: "smsf:physical:1",
    bodyHash: "b".repeat(64),
    kind: "investigation",
    annotations: annotation(),
  });
  const cases = [
    { ...base, annotations: { ...base.annotations, active_protagonist: undefined } },
    { ...base, annotations: { ...base.annotations, native_chinese: { ...base.annotations.native_chinese, level: 6 } } },
    { ...base, annotations: { ...base.annotations, rule_information_gain: { ...base.annotations.rule_information_gain, evidence: [{ excerpt: "" }] } } },
    { ...base, body },
  ];
  for (const value of cases) assert.equal(validateReferenceQualityCase(value).valid, false);
});
