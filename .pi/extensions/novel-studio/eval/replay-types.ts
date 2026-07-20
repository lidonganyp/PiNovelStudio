/**
 * Replay evaluation type contracts.
 *
 * These types model the external training-ground path. They intentionally keep
 * original prose outside case files; reference text is addressed by path + hash.
 */

import type { WorkspaceConfig } from "../utils/config.js";
import type { WorldItem } from "../dag/types.js";

export interface ReplaySourceSpan {
  startOffset: number;
  endOffset: number;
}

export interface ReplayCase {
  bookId: string;
  chapterNumber: number;
  chapterTitle: string;
  abstractOutline: string;
  characterState: string;
  worldState: string;
  keyEvents: string[];
  emotionalBeats: string[];
  conflictTarget: string;
  endingHook: string;
  originalChapterPath: string;
  originalHash: string;
  sourceSpan: ReplaySourceSpan;
}

export interface ReplayCaseExtractionOptions {
  bookId: string;
  sourcePath: string;
  maxCases?: number;
}

export interface ReplayCaseWriteResult {
  outputDir: string;
  files: string[];
}

export interface ReplayCharacterConfig {
  id: string;
  name: string;
  role: string;
  aliases?: string[];
}

export type ReplayWorkspaceConfig = WorkspaceConfig & {
  generatedFromReplay: true;
  replayCase: {
    bookId: string;
    chapterNumber: number;
    chapterTitle: string;
    originalChapterPath: string;
    originalHash: string;
  };
  characters: ReplayCharacterConfig[];
  generationPreflight: {
    enabled: boolean;
    allowUnregisteredCharacters: boolean;
    maxUnregisteredCharacters: number;
  };
};

export interface ReplayWorkspaceInput {
  workspaceId: string;
  config: ReplayWorkspaceConfig;
  outline: string;
  characterProfile: string;
  worldItems: WorldItem[];
  skeleton: Record<string, unknown>;
  narrativeState: Record<string, unknown>;
  unsettledDetails: unknown[];
}

export interface CreateReplayWorkspaceOptions {
  workspaceId: string;
  novelName: string;
  genre: string;
  subGenres?: string[];
  styleProfile?: string;
}

export interface ReplayInvokeCommand {
  toolName: "novel_generate_chapter";
  executable: string;
  args: string[];
  cwd: string;
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  mockAgent: boolean;
  resultPath: string;
  timeoutMs?: number;
}

export interface ReplayInvokeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  durationMs?: number;
}

export type ReplayInvokeGenerateChapter = (
  command: ReplayInvokeCommand
) => Promise<ReplayInvokeResult>;

export type ReplayGenerationFailureKind =
  | "upstream_rewrite_requested"
  | "human_review_required"
  | "stage8_repairable_warning"
  | "invoke_failed"
  | "generation_error"
  | "candidate_text_missing"
  | "quality_report_unavailable"
  | "replay_incomplete";

export interface ReplayGenerationFailure {
  kind: ReplayGenerationFailureKind;
  stage?: string;
  gate?: string;
  route?: string;
  status?: string;
  message?: string;
  issueTypes?: string[];
  blockingIssueTypes?: string[];
  repairableIssueTypes?: string[];
  shouldRequestUpstreamRewrite?: boolean;
  qualityReportPath?: string;
}

export interface RunReplayCasesOptions {
  projectRoot: string;
  cases: Array<string | ReplayCase>;
  runRoot?: string;
  runId?: string;
  mockAgent?: boolean;
  invokeTimeoutMs?: number;
  invokeGenerateChapter?: ReplayInvokeGenerateChapter;
  /**
   * P9 真实晋级证据：人工抽检 flag。
   * - false（默认）：仅生成 candidate-rules.json，不写入 validated-craft-rules.json
   * - true：当 deltaReport.canPromote 为 true 时，将 candidate rules 晋级写入
   *         data/runtime/validated-craft-rules.json
   * 可通过环境变量 PINOVEL_REPLAY_HUMAN_APPROVED=1 启用。
   */
  humanApproved?: boolean;
}

export interface ReplayGenerationReport {
  schemaVersion: number;
  bookId: string;
  runId: string;
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  case: ReplayCase;
  command: ReplayInvokeCommand;
  invocation: ReplayInvokeResult;
  result: Record<string, unknown>;
  failure?: ReplayGenerationFailure;
  metadata: {
    generatedBy: "novel_generate_chapter";
    candidate: {
      generationTool: "novel_generate_chapter";
      workspaceId: string;
      chapterId: string;
      resultPath: string;
      tracePath: string;
    };
    reference: {
      originalChapterPath: string;
      originalHash: string;
    };
  };
  createdAt: string;
}

export interface ReplayRunSummary {
  schemaVersion: number;
  bookId: string;
  runId: string;
  runPath: string;
  totalCases: number;
  completed: number;
  failed: number;
  failures: ReplayGenerationFailure[];
  failureBreakdown: Record<ReplayGenerationFailureKind, number>;
  reports: string[];
  createdAt: string;
  /** Cases that produced a generated-result.json (success or generation_error). Used as denominator for terminal-gate audits. */
  generatedCount?: number;
  /** Cases that failed before producing generate-result.json (true infra failures). Excluded from terminal-gate denominator. */
  invokeFailedCount?: number;
  /** Number of generated-result failures (denominator for terminal-gate coverage). */
  validDenominator?: number;
}
