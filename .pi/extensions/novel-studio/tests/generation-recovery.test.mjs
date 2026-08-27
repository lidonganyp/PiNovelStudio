import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assessTargetLength,
  repairDuplicateFindings,
  resolveTargetWordRange,
  selectRecoverableDraft,
} from "../dist/v2/core/generation-recovery.js";

test("target length uses the same non-whitespace count as the saved chapter", () => {
  const result = assessTargetLength("第一句。\n第二句！", { min: 20, max: 30 });

  assert.equal(result.contentCharacters, 8);
  assert.equal(result.minimum, 20);
  assert.equal(result.maximum, 30);
  assert.equal(result.needsContinuation, true);
  assert.equal(result.remaining, 12);
});

test("an explicit request target overrides the workspace default", () => {
  assert.deepEqual(
    resolveTargetWordRange(
      { min: 2500, max: 2750 },
      { min: 3000, max: 5000 },
    ),
    { min: 2500, max: 2750 },
  );
  assert.deepEqual(
    resolveTargetWordRange(undefined, { min: 3000, max: 5000 }),
    { min: 3000, max: 5000 },
  );
});

test("duplicate recovery removes only the later repeated sentence", () => {
  const text = "他把木心放在石头上。又看了看四周。\n\n他把木心放在石头上。然后转身离开。";
  const firstStart = text.indexOf("他把木心放在石头上");
  const excerpt = text.slice(firstStart, firstStart + 10);
  const repaired = repairDuplicateFindings(text, [{
    source: "duplicate_scan",
    severity: "hard",
    evidence: `大段重复：\"${excerpt}...\"`,
    span: { start: firstStart, end: firstStart + excerpt.length },
  }]);

  assert.equal(repaired.changed, true);
  assert.equal(repaired.text, "他把木心放在石头上。又看了看四周。\n\n然后转身离开。");
  assert.equal(repaired.removed.length, 1);
});

test("duplicate recovery removes a repeated window that crosses sentence boundaries", () => {
  const text = "前文。第一句保留。\n\n第二句保留。\n\n第一句保留。\n\n第二句保留。\n\n新的结尾。";
  const firstStart = text.indexOf("第一句保留。\n\n第二句");
  const excerpt = text.slice(firstStart, firstStart + 10);
  const repaired = repairDuplicateFindings(text, [{
    source: "duplicate_scan",
    evidence: `大段重复：\"${excerpt}...\"`,
    span: { start: firstStart, end: firstStart + excerpt.length },
  }]);

  assert.equal(repaired.changed, true);
  assert.equal(repaired.text, "前文。第一句保留。\n\n第二句保留。\n\n新的结尾。");
});

test("duplicate recovery removes an appended compressed duplicate tail", () => {
  const source = [
    "落点偏了半米。\n\n不远处传来战术靴踩碎碎石的轻响。",
    "\n\n一凡？你刚才去哪儿了？信号断了整整三分钟。",
    "\n\n我来封路。李一凡站直身子，深吸了一口气，准备迎接新的战斗。",
  ].join("");
  const text = `${source}\n\n落点偏了半米。\n\n不远处传来战术靴踩碎碎石的轻响。\n\n一凡？你刚才去哪儿了？信号断了整整三分钟。\n\n我来封路。李一凡站直身子，深吸了一口气，准备迎接新的战斗。`;
  const firstStart = text.indexOf("。\n\n不远处传来战术靴踩碎碎石的轻响");
  const excerpt = text.slice(firstStart, firstStart + 24);
  const repaired = repairDuplicateFindings(text, [{
    source: "duplicate_scan",
    evidence: `大段重复：\"${excerpt}...\"`,
    span: { start: firstStart, end: firstStart + excerpt.length },
  }]);

  assert.equal(repaired.changed, true);
  assert.equal(repaired.text, source);
});

test("draft selection never returns an empty string when a readable candidate exists", () => {
  const result = selectRecoverableDraft([
    { source: "editorial", text: "" },
    { source: "agentic", text: "已有正文" },
  ]);

  assert.equal(result.state, "needs_review");
  assert.equal(result.text, "已有正文");
  assert.equal(result.source, "agentic");
});

test("draft selection reports empty only when every candidate is empty", () => {
  const result = selectRecoverableDraft([
    { source: "editorial", text: "  " },
    { source: "agentic", text: "" },
  ]);

  assert.equal(result.state, "empty");
  assert.equal(result.text, "");
  assert.equal(result.source, null);
});
