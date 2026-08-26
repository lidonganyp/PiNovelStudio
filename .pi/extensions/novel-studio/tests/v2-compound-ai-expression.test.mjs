/**
 * Regression coverage for the P57 compound AI-expression rules at the V2 owner boundary.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLanguageRiskLibrary } from "../dist/v2/core/language-risk-library.js";

describe("V2 compound AI-expression diagnostics", () => {
  it("flows through LanguageRiskLibrary with a span and soft severity", () => {
    const text = [
      "眉宇间沉得像压着一层化不开的铅块。",
      "眼底的轻慢少了两分。",
      "整个过程平静而顺利。",
      "水面下的回旋比表面看起来重得多。",
      "泛出一串串急促的气泡。",
      "他的心跳沉稳得近乎诡异。",
      "那不是战队配合能打出的伤害，那是绝对维度的瞬杀。",
      "苍老虚弱的气息比先前凝实了一分。",
    ].join("\n");
    const report = createLanguageRiskLibrary().scan(text);
    const entries = report.entries.filter((entry) => entry.riskId === "compound_ai_expression");

    assert.ok(entries.length >= 7, `expected compound entries, got ${JSON.stringify(report.entries)}`);
    for (const entry of entries) {
      assert.equal(entry.category, "naturalness");
      assert.ok(entry.span && entry.span.start >= 0 && entry.span.end > entry.span.start,
        `entry must carry a non-empty span: ${JSON.stringify(entry)}`);
      assert.ok(entry.severity === "info" || entry.severity === "review",
        `compound expression must remain a soft diagnostic: ${entry.severity}`);
      assert.notEqual(entry.severity, "critical");
      assert.match(entry.description, /compound_ai_expression/);
    }
  });
});
