/**
 * 章节生成公开结果摘要测试（EXPERT-GROUP-R15）
 *
 * 锁定公开返回契约的真实形状：
 * - 成功状态是 `status: "ok"`（`success` 必须判不可交付）
 * - 路径位于 `stageResults.chapterFilePath` / `stageResults.tracePath`
 * - 失败信封是顶层单数 `failureEnvelope`
 * - 公开 severity 只有 preflight / recoverable / hard_block
 * - `isPreviewRun=true` 与未提交 `stateCommit` 都不可交付
 *
 * 依赖边界：只依赖 dist-test；纯函数，无 IO。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PUBLIC_FAILURE_SEVERITIES,
  isPublicFailureSeverity,
  summarizeChapterGenerationResult,
} from "../dist-test/novelos/experts/expert-result-summary.js";

const OK_RESULT = {
  status: "ok",
  text: "第 12 章正文……",
  isPreviewRun: false,
  failureEnvelope: null,
  selectedSource: "author_style_optimized",
  stageResults: {
    chapterFilePath: "workspaces/w01/chapters/ch012.md",
    tracePath: "workspaces/w01/traces/ch012-quality-trace.json",
    stateCommit: { committed: true, rejected: false },
  },
};

test("完整成功返回判可交付", () => {
  const summary = summarizeChapterGenerationResult(OK_RESULT, { chapterFileExists: true, chapterFileChars: 1200 });
  assert.equal(summary.deliverable, true);
  assert.deepEqual(summary.blockingReasons, []);
  assert.equal(summary.chapterFilePath, "workspaces/w01/chapters/ch012.md");
  assert.equal(summary.tracePath, "workspaces/w01/traces/ch012-quality-trace.json");
  assert.equal(summary.isPreviewRun, false);
});

test("status 写 success、路径写顶层、信封写复数都不可交付", () => {
  const wrong = {
    status: "success",
    text: "正文",
    chapterPath: "chapters/ch012.md",
    tracePath: "traces/ch012.json",
    failureEnvelopes: [{ gate: "fact_guard" }],
    stageResults: {},
  };
  const summary = summarizeChapterGenerationResult(wrong);
  assert.equal(summary.deliverable, false);
  assert.ok(summary.blockingReasons.includes("status_not_ok"));
  assert.ok(summary.blockingReasons.includes("chapter_file_path_missing"));
  assert.ok(summary.blockingReasons.includes("trace_path_missing"));
  assert.equal(summary.chapterFilePath, null);
});

test("预览运行与非 ok 状态：明确阻断原因", () => {
  const preview = summarizeChapterGenerationResult({ ...OK_RESULT, isPreviewRun: true });
  assert.equal(preview.deliverable, false);
  assert.ok(preview.blockingReasons.includes("preview_run_not_deliverable"));
  assert.ok(!preview.blockingReasons.includes("state_commit_unconfirmed"));

  const blocked = summarizeChapterGenerationResult({
    ...OK_RESULT,
    status: "blocked",
    failureEnvelope: { stage: "story_preservation", gate: "story_preservation", severity: "hard_block", reason: "实体覆盖率不足" },
  });
  assert.equal(blocked.deliverable, false);
  assert.ok(blocked.blockingReasons.includes("status_blocked"));
  assert.ok(blocked.blockingReasons.includes("unexpected_failure_envelope"));
  assert.ok(blocked.warnings.includes("blocked_candidate_text_must_not_be_copied_into_chapters"));
});

test("stateCommit 未提交、文件缺失/为空都不可交付", () => {
  const noCommit = summarizeChapterGenerationResult({ ...OK_RESULT, stageResults: { ...OK_RESULT.stageResults, stateCommit: null } });
  assert.ok(noCommit.blockingReasons.includes("state_commit_unconfirmed"));

  const missingFile = summarizeChapterGenerationResult(OK_RESULT, { chapterFileExists: false });
  assert.ok(missingFile.blockingReasons.includes("chapter_file_missing_on_disk"));

  const emptyFile = summarizeChapterGenerationResult(OK_RESULT, { chapterFileExists: true, chapterFileChars: 0 });
  assert.ok(emptyFile.blockingReasons.includes("chapter_file_empty_on_disk"));
});

test("公开 severity 只接受三值", () => {
  assert.deepEqual([...PUBLIC_FAILURE_SEVERITIES], ["preflight", "recoverable", "hard_block"]);
  assert.equal(isPublicFailureSeverity("hard_block"), true);
  assert.equal(isPublicFailureSeverity("preflight"), true);
  assert.equal(isPublicFailureSeverity("recoverable"), true);
  assert.equal(isPublicFailureSeverity("hard"), false);
  assert.equal(isPublicFailureSeverity("fatal"), false);
});
