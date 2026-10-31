/**
 * PiNovelStudio — 章节生成公开结果摘要（EXPERT-GROUP-R15）
 *
 * 用途：把 `novel_generate_chapter` 的真实公开返回形状归一成专家可消费的摘要。
 * 只读、纯函数，不修改结果、不重命名字段、不把失败“修复”为成功。
 *
 * 公开契约（真相源 v2/core/unified-entry.ts / craft/failure-envelope.ts）：
 *  - 成功状态是 `status: "ok"`（不是 success）
 *  - 章节文件与 trace 路径位于 `stageResults.chapterFilePath` / `stageResults.tracePath`
 *  - 失败信封是顶层单数 `failureEnvelope`（不是 failureEnvelopes）
 *  - 公开 severity 只有 preflight / recoverable / hard_block
 *  - `isPreviewRun=true` 表示只读预览，未写章节文件、未提交状态
 */

export interface ChapterGenerationPublicResultLike {
  status?: string | null;
  text?: string | null;
  isPreviewRun?: boolean;
  failureEnvelope?: unknown;
  stageResults?: Record<string, unknown> | null;
  selectedSource?: string | null;
}

export interface DeliveryArtifacts {
  chapterFileExists?: boolean;
  chapterFileChars?: number;
}

export interface DeliverySummary {
  deliverable: boolean;
  status: string | null;
  chapterFilePath: string | null;
  tracePath: string | null;
  failureEnvelope: unknown;
  stateCommit: unknown;
  isPreviewRun: boolean;
  selectedSource: string | null;
  blockingReasons: string[];
  warnings: string[];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * 归一化并判定“能否作为正式交付”。
 * 缺少任何关键证据都判不可交付，并逐条列出原因（不做二选一猜测）。
 */
export function summarizeChapterGenerationResult(
  result: ChapterGenerationPublicResultLike,
  artifacts: DeliveryArtifacts = {},
): DeliverySummary {
  const stageResults = result.stageResults ?? {};
  const status = readString(result.status);
  const chapterFilePath = readString(stageResults.chapterFilePath);
  const tracePath = readString(stageResults.tracePath);
  const stateCommit = stageResults.stateCommit ?? null;
  const isPreviewRun = result.isPreviewRun === true;
  const selectedSource = readString(result.selectedSource);
  const text = typeof result.text === "string" ? result.text : "";
  const failureEnvelope = result.failureEnvelope ?? null;

  const blockingReasons: string[] = [];
  const warnings: string[] = [];

  if (status !== "ok") {
    blockingReasons.push(status === "blocked" ? "status_blocked" : "status_not_ok");
  }
  if (isPreviewRun) {
    blockingReasons.push("preview_run_not_deliverable");
  }
  if (text.trim().length === 0) {
    blockingReasons.push("empty_text");
  }
  if (!chapterFilePath) {
    blockingReasons.push("chapter_file_path_missing");
  }
  if (!tracePath) {
    blockingReasons.push("trace_path_missing");
  }
  if (stateCommit === null && !isPreviewRun) {
    blockingReasons.push("state_commit_unconfirmed");
  }
  if (failureEnvelope !== null) {
    blockingReasons.push("unexpected_failure_envelope");
  }
  if (artifacts.chapterFileExists === false) {
    blockingReasons.push("chapter_file_missing_on_disk");
  }
  if (typeof artifacts.chapterFileChars === "number" && artifacts.chapterFileChars <= 0) {
    blockingReasons.push("chapter_file_empty_on_disk");
  }
  if (status === "ok" && selectedSource === null) {
    warnings.push("selected_source_missing");
  }
  if (status === "blocked" && text.trim().length > 0) {
    warnings.push("blocked_candidate_text_must_not_be_copied_into_chapters");
  }

  return {
    deliverable: blockingReasons.length === 0,
    status,
    chapterFilePath,
    tracePath,
    failureEnvelope,
    stateCommit,
    isPreviewRun,
    selectedSource,
    blockingReasons,
    warnings,
  };
}

/** 公开 FailureEnvelope 的严重度取值（内部 hard/fatal 不得直接对外使用）。 */
export const PUBLIC_FAILURE_SEVERITIES = ["preflight", "recoverable", "hard_block"] as const;

export function isPublicFailureSeverity(value: unknown): value is (typeof PUBLIC_FAILURE_SEVERITIES)[number] {
  return typeof value === "string" && (PUBLIC_FAILURE_SEVERITIES as readonly string[]).includes(value);
}
