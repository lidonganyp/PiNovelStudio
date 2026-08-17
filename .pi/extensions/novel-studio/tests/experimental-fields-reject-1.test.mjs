/**
 * EXPERIMENTAL-FIELDS-REJECT-1
 *
 * 公开生产入口 novel_generate_chapter 的 handleGenerateChapter 拒绝旧 raw/judge 分支
 * 实验字段（recoverBlockedRaw / boundedBestOf3 / qualityExperiment / previewOnly）。
 *
 * 这些字段仅 eval/评测（NovelBench）使用；生产路径不含 PairwiseJudge /
 * SelectionPolicy / EditorialOpportunityJudge，raw 候选不经过编辑/风格优化后交付。
 * 如需评测请走 eval 入口；如需只读预览请使用 fullPipelinePreview。
 *
 * Source-level，无模型调用，无需真实 workspace：guard 在任何副作用（getProjectRoot /
 * clearUnhealthyProviders / runUnifiedPipeline）之前同步拒绝。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { handleGenerateChapter } from "../dist/handlers/public-handlers.js";

const REJECTED_FIELDS = [
  { field: "recoverBlockedRaw", value: true },
  { field: "boundedBestOf3", value: true },
  { field: "qualityExperiment", value: { arm: "raw", sampleIndex: 1 } },
  { field: "previewOnly", value: true },
  { field: "modelTestRoute", value: "glm" },
  { field: "fullPipelinePreview", value: true },
  { field: "_mockGenerateChapter", value: async () => ({}) },
];

test("公开生产入口拒绝旧 raw/judge 分支实验字段", async () => {
  for (const { field, value } of REJECTED_FIELDS) {
    await assert.rejects(
      () => handleGenerateChapter({
        workspaceId: "w",
        chapterId: "1",
        chapterNumber: 1,
        [field]: value,
      }),
      (err) => {
        const msg = String(err?.message ?? err);
        return /实验字段在生产入口被拒绝/.test(msg) && msg.includes(field);
      },
      `应拒绝实验字段 ${field}`,
    );
  }
});
