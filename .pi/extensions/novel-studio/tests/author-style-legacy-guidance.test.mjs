/**
 * Regression coverage for shared legacy style fingerprints.
 *
 * Shared profiles predate the explicit editorialGuidance field, but still
 * contain qualitative writing guidance that must reach the author-style
 * optimizer. Numeric observations remain diagnostic and must not be injected
 * as mechanical quotas.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { collectAuthorStyleGuidance } from "../dist/v2/core/author-style-optimizer.js";

test("legacy style fingerprint yields qualitative guidance without metric quotas", () => {
  const context = {
    styleReferences: [{
      id: "style:legacy",
      kind: "fingerprint",
      content: JSON.stringify({
        id: "legacy",
        sentence: {
          avgLength: 22,
          signaturePatterns: ["短句优先，情绪通过动作呈现"],
        },
        narrative: {
          povStyle: "第三人称限制视角",
          expositionStyle: "规则与档案逐层揭示",
        },
        emotion: {
          baseline: "克制压抑",
          escalationPattern: "线索汇聚后冷爆发",
        },
        imagery: {
          visualStyle: "冷调、低饱和、档案质感",
        },
        rhythm: {
          paragraphRhythm: "中节奏，信息密度高，段落短",
        },
        lexicon: {
          signaturePhrases: ["规则错位"],
          avoidWords: ["非常", "十分"],
        },
      }),
      sourceIds: ["styles/profiles/legacy.json"],
    }],
  };

  const result = collectAuthorStyleGuidance(context, []);

  assert.deepEqual(result.referenceIds, ["style:legacy"]);
  assert.ok(result.guidance.length > 0, "legacy profile must be consumable");
  assert.ok(result.guidance.some((item) => item.includes("短句优先")));
  assert.ok(result.guidance.some((item) => item.includes("规则与档案逐层揭示")));
  assert.ok(result.guidance.some((item) => item.includes("规则错位")));
  assert.ok(!result.guidance.some((item) => item.includes("avgLength")));
  assert.ok(!result.guidance.some((item) => item.includes("22")));
});
