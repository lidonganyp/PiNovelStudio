/**
 * P0/P1 round 8 regressions found during the production-readiness audit.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { checkEditorialStoryPreservation } from "../dist/v2/core/editorial-story-preservation-gate.js";
import {
  reanchorStagedStateToFinalText,
  validateSemanticSupport,
} from "../dist/v2/core/final-state-commit.js";

function makeRealmEntry(characterId = "叶尘") {
  return {
    id: `character:${characterId}:realm`,
    kind: "character",
    characterId,
    field: "realm",
    value: "筑基期",
    sourceChapter: "ch5",
    sourceRef: "ch5#seed:intent",
    confidence: 0.8,
    lastUpdated: new Date().toISOString(),
  };
}

describe("P0/P1 第八轮：生产路径残余问题", () => {
  it("单角色默认主体不应把自然动作改写误报为 editorial-only", () => {
    const report = checkEditorialStoryPreservation({
      rawText: "灵气从玉简中涌出，顺着他的经脉蔓延，封印开始松动。",
      editorialText: "灵气从玉简里涌出来，顺着经脉蔓延。封印松动了。",
      knownEntities: ["叶尘"],
      entityCoverage: "characters_only",
    });

    assert.equal(
      report.preserved,
      true,
      `自然动作改写不应阻断故事保持：${JSON.stringify(report.replacedEvents)}`,
    );
    assert.equal(
      report.replacedEvents.some(
        (event) => event.rawSentence === "" && event.editorialSentence.includes("涌出来"),
      ),
      false,
      "不应把涌出→涌出来标记为 editorial-only 关键事件",
    );
  });

  it("已有实体也不能在 editorial 中凭空新增关键事件", () => {
    const report = checkEditorialStoryPreservation({
      rawText: "叶尘攻击林默。",
      editorialText: "叶尘攻击林默。林默杀死叶尘。",
      knownEntities: ["叶尘", "林默"],
      entityCoverage: "full_entities",
    });

    assert.equal(report.preserved, false);
    assert.ok(
      report.replacedEvents.some(
        (event) =>
          event.rawSentence === "" &&
          event.editorialSentence.includes("杀死"),
      ),
      `应记录 editorial-only 关键事件：${JSON.stringify(report.replacedEvents)}`,
    );
  });

  it("多角色前句的境界代词必须歧义即拒绝，不受角色数组顺序影响", () => {
    const entry = makeRealmEntry();
    const finalText = "林默向叶尘解释。他已是筑基期。";
    const realmStart = finalText.indexOf("筑基期");
    const span = {
      start: realmStart,
      end: realmStart + "筑基期".length,
      excerpt: "筑基期",
    };

    for (const characterNames of [
      ["叶尘", "林默"],
      ["林默", "叶尘"],
    ]) {
      const result = validateSemanticSupport(
        entry,
        finalText,
        span,
        characterNames,
      );
      assert.equal(
        result.supported,
        false,
        `角色顺序 ${JSON.stringify(characterNames)} 不应提交境界：${result.reason}`,
      );

      const reanchored = reanchorStagedStateToFinalText(
        { additions: [entry], invalidations: [], sourceChapter: "ch5" },
        finalText,
        5,
        characterNames,
      );
      const reanchoredEntry = reanchored.additions[0];
      assert.ok(reanchoredEntry.sourceRef.includes("semantic-conflict"));
      assert.ok(reanchoredEntry.confidence < 0.5);
    }
  });

  it("两条 Story Preservation 重试路径继续传递 aliasToCanonical", () => {
    const source = readFileSync(
      new URL("../v2/core/unified-orchestrator.ts", import.meta.url),
      "utf8",
    );
    const firstRetryStart = source.indexOf("stage4b_retryStoryPreservation");
    const driftRetryStart = source.indexOf("stage4b_retryStoryPreservationDrift");
    assert.ok(firstRetryStart >= 0);
    assert.ok(driftRetryStart > firstRetryStart);

    const firstRetryBlock = source.slice(firstRetryStart, driftRetryStart);
    const driftRetryBlock = source.slice(driftRetryStart, driftRetryStart + 1500);
    assert.match(firstRetryBlock, /aliasToCanonical:\s*input\.aliasToCanonical/);
    assert.match(driftRetryBlock, /aliasToCanonical:\s*input\.aliasToCanonical/);
  });

  it("editorial-only 反向检测不应把 canonical/alias 改写误判为新增事件", () => {
    const aliasToCanonical = new Map([
      ["叶尘", "叶尘"],
      ["小尘", "叶尘"],
    ]);
    const report = checkEditorialStoryPreservation({
      rawText: "小尘看着远方。",
      editorialText: "叶尘看着远方。叶尘走开。",
      knownEntities: ["叶尘", "小尘"],
      entityCoverage: "full_entities",
      aliasToCanonical,
    });

    assert.equal(
      report.preserved,
      true,
      `canonical/alias 改写不应被 editorial-only 误报：${JSON.stringify(report.replacedEvents)}`,
    );
  });
});
