/** USER-REVISION-DELTA-1 acceptance tests. */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildRevisionPatternProposals,
  captureUserRevisionDelta,
  loadUserRevisionDelta,
  saveUserRevisionDelta,
} from "../dist-test/v2/core/user-revision-delta.js";

function makeInput(chapterId, annotations = []) {
  return {
    workspaceId: "xinmo",
    chapterId,
    selectedCandidateId: "candidate:editorial:1",
    systemSelectedText: "第一段原文。\n\n他感到一阵寒意。\n\n第三段原文。",
    userFinalText: "第一段修改。\n\n他察觉到一阵寒意。\n\n第三段原文。",
    annotations,
    capturedAt: "2026-07-19T00:00:00.000Z",
  };
}

test("USER-REVISION-DELTA-1 保存系统选定稿、用户最终稿和多个修改 span", () => {
  const artifact = captureUserRevisionDelta(makeInput("ch17"));
  assert.equal(artifact.systemSelectedText.includes("第一段原文"), true);
  assert.equal(artifact.userFinalText.includes("第一段修改"), true);
  assert.equal(artifact.modifiedSpans.length, 2);
  for (const span of artifact.modifiedSpans) {
    assert.ok(span.before.start >= 0 && span.before.end >= span.before.start);
    assert.ok(span.after.start >= 0 && span.after.end >= span.after.start);
    assert.equal(span.reason, "unclassified");
    assert.equal(span.qualityDimension, "unclassified");
    assert.equal(span.generalizable, false);
  }
});

test("USER-REVISION-DELTA-1 按 span 记录修改原因、质量维度和可泛化性", () => {
  const artifact = captureUserRevisionDelta(makeInput("ch17", [
    {
      spanIndex: 0,
      reason: "避免作者总结式说明",
      qualityDimension: "emotional_progression",
      generalizable: true,
    },
    {
      spanIndex: 1,
      reason: "减少感到式过滤词",
      qualityDimension: "native_chinese",
      generalizable: true,
    },
  ]));
  assert.equal(artifact.modifiedSpans[0].reason, "避免作者总结式说明");
  assert.equal(artifact.modifiedSpans[1].qualityDimension, "native_chinese");
  assert.equal(artifact.modifiedSpans[1].generalizable, true);
});

test("USER-REVISION-DELTA-1 原子落盘并可回读", () => {
  const root = mkdtempSync(join(tmpdir(), "pinovel-revision-delta-"));
  try {
    const artifact = captureUserRevisionDelta(makeInput("ch17"));
    const path = saveUserRevisionDelta(root, artifact);
    assert.equal(readFileSync(path, "utf8").includes("pinovel.user-revision-delta"), true);
    assert.deepEqual(loadUserRevisionDelta(path), artifact);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("USER-REVISION-DELTA-1 单章或未分类修改不得形成 Constitution proposal", () => {
  const artifact = captureUserRevisionDelta(makeInput("ch17"));
  assert.deepEqual(buildRevisionPatternProposals([artifact]), []);
});

test("USER-REVISION-DELTA-1 只有跨章节重复且标为可泛化的规律才形成提案", () => {
  const annotations = [
    {
      spanIndex: 1,
      reason: "减少感到式过滤词",
      qualityDimension: "native_chinese",
      generalizable: true,
    },
  ];
  const ch17 = captureUserRevisionDelta(makeInput("ch17", annotations));
  const ch18 = captureUserRevisionDelta({
    ...makeInput("ch18", annotations),
    systemSelectedText: "他感到空气骤然变冷。",
    userFinalText: "他察觉到空气骤然变冷。",
    annotations: [{ ...annotations[0], spanIndex: 0 }],
  });
  const proposals = buildRevisionPatternProposals([ch17, ch18]);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].qualityDimension, "native_chinese");
  assert.deepEqual(proposals[0].chapterIds, ["ch17", "ch18"]);
  assert.equal(proposals[0].status, "proposal_only");
});

