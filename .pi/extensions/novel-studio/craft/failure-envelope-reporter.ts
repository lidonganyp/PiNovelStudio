/**
 * PiNovelStudio — FailureEnvelope 报告器
 *
 * 治理方案 Phase 1：诊断统一化
 *
 * 提供：
 *  - emitFailureEnvelope：把 FailureEnvelope 写入 trace（appendExisting，累积）
 *  - withFailureReturn：构造带 failureEnvelope 字段的 return 对象
 *  - flushFailureEnvelopeToTraceFile：独立写入 trace 文件（用于早期阻断，recorder 尚未创建）
 *
 * 设计原则：
 *  - 不改变现有 return 的 status/stage/message 字段（向后兼容）
 *  - 只追加 failureEnvelope 字段，并把同一 envelope 写入 quality trace
 *  - trace 写入失败不阻断 return（trace 是诊断证据，不是门禁）
 */

import { createQualityTraceRecorder, type QualityTraceRecorder } from "./quality-trace-recorder.js";
import type { FailureEnvelope } from "./failure-envelope.js";

export interface FailureEnvelopeTraceSink {
  recordFailureEnvelope(envelope: FailureEnvelope, attemptHistory?: unknown): void;
  flush?(): string;
}

/**
 * 把 FailureEnvelope 写入 trace recorder（如果可用）。
 * 返回原 envelope，便于链式调用。
 */
export function emitFailureEnvelope(
  sink: FailureEnvelopeTraceSink | null | undefined,
  envelope: FailureEnvelope,
  attemptHistory?: Array<{
    attempt: number;
    strategy: string;
    reason: string;
    evidence?: unknown;
    outcome: "recovered" | "failed" | "exhausted";
  }>,
): FailureEnvelope {
  try {
    if (sink && typeof sink.recordFailureEnvelope === "function") {
      sink.recordFailureEnvelope(envelope, attemptHistory);
    }
  } catch {
    // trace 写入失败不阻断 return
  }
  return envelope;
}

/**
 * 独立写入 FailureEnvelope 到 trace 文件。
 *
 * 用于早期阻断点（Stage 0 前置检查）trace recorder 尚未创建的场景。
 * 内部创建 appendExisting recorder，写入后 flush。
 */
export function flushFailureEnvelopeToTraceFile(
  workspacePath: string,
  workspaceId: string,
  chapterId: string,
  envelope: FailureEnvelope,
  attemptHistory?: Array<{
    attempt: number;
    strategy: string;
    reason: string;
    evidence?: unknown;
    outcome: "recovered" | "failed" | "exhausted";
  }>,
): void {
  try {
    const recorder: QualityTraceRecorder = createQualityTraceRecorder({
      workspacePath,
      workspaceId,
      chapterId,
      appendExisting: true,
    });
    recorder.recordFailureEnvelope(envelope, attemptHistory);
    recorder.flush();
  } catch {
    // trace 写入失败不阻断 return
  }
}

/**
 * 构造带 failureEnvelope 字段的 return 对象。
 *
 * 不改变原有字段，只追加 failureEnvelope。
 * 用于 novel_generate_chapter 的所有阻断 return。
 */
export function withFailureReturn<T extends Record<string, unknown>>(
  baseReturn: T,
  envelope: FailureEnvelope,
): T & { failureEnvelope: FailureEnvelope } {
  return {
    ...baseReturn,
    failureEnvelope: envelope,
  };
}
