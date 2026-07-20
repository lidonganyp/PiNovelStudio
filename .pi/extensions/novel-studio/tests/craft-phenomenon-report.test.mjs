/** Methodology craft knowledge is post-raw evidence, never a prose-control checklist. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CRAFT_PHENOMENON_DOMAINS,
  buildCraftPhenomenonReport,
  skippedCraftPhenomenonReport,
  validateCraftPhenomenonReport,
} from "../dist/v2/core/craft-phenomenon-report.js";

const RAW = "林默问：你看见门里的人了吗？许岚没有回答。她把沾血的钥匙推到他面前。";

test("methodology report covers every craft domain without a literary score", () => {
  assert.deepEqual(CRAFT_PHENOMENON_DOMAINS, [
    "dialogue",
    "rhythm_and_climax",
    "expectation_and_serial",
    "genre_contract",
    "supporting_characters",
    "world_revelation",
    "ensemble",
    "ending_and_closure",
    "chapter_progression",
    "cross_chapter_health",
  ]);

  const report = buildCraftPhenomenonReport({
    rawText: RAW,
    rawCandidateId: "candidate:raw:17",
    observations: [{
      domain: "dialogue",
      status: "observed",
      phenomenon: "对话通过钥匙改变了双方的信息与权力位置",
      readerImpact: "对话承担事件推进，而不是问答搬运",
      evidenceExcerpt: "她把沾血的钥匙推到他面前",
      confidence: 0.8,
    }],
  });

  assert.equal(report.advisoryOnly, true);
  assert.equal(report.canDirectlyRewrite, false);
  assert.equal(report.canSelectWinner, false);
  assert.equal("score" in report, false);
  assert.equal("passed" in report, false);
  assert.equal(report.observations[0].sourceSpans[0].excerpt, "她把沾血的钥匙推到他面前");
  assert.equal(validateCraftPhenomenonReport(report), null);
});

test("observed and uncertain findings require a verbatim raw span", () => {
  const report = buildCraftPhenomenonReport({
    rawText: RAW,
    rawCandidateId: "candidate:raw:17",
    observations: [{
      domain: "dialogue",
      status: "observed",
      phenomenon: "不存在的判断",
      readerImpact: "不能授权候选",
      evidenceExcerpt: "正文里没有这一句",
      confidence: 0.9,
    }],
  });

  assert.deepEqual(report.observations, []);
  assert.match(report.rejectedObservations[0].reason, /原文中定位失败/);
});

test("not_applicable findings cannot smuggle spans or editing commands", () => {
  const report = buildCraftPhenomenonReport({
    rawText: RAW,
    rawCandidateId: "candidate:raw:17",
    observations: [{
      domain: "ensemble",
      status: "not_applicable",
      phenomenon: "本章不是群像场景",
      readerImpact: "无",
      evidenceExcerpt: "林默问",
      confidence: 1,
    }],
  });

  assert.deepEqual(report.observations, []);
  assert.match(report.rejectedObservations[0].reason, /not_applicable/);
});

test("skipped report is explicit and cannot authorize generation", () => {
  const report = skippedCraftPhenomenonReport("schema repair exhausted", "candidate:raw:17");
  assert.equal(report.status, "skipped");
  assert.equal(report.canTriggerEditorialOpportunity, false);
  assert.equal(report.observations.length, 0);
  assert.equal(validateCraftPhenomenonReport(report), null);
});

