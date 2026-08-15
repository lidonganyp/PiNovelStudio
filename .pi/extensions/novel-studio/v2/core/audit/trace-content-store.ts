/**
 * TRACE-CONTENT-STORE — quality-trace 明细独立内容库（P7 Stage C-1）
 *
 * 用户方向（三方分离）：
 *   1. 审计流 = 结构化元数据（gate_evaluated 只带策展子集 strategyContext/
 *      modelCalls/releaseGovernance，禁止完整正文）
 *   2. 独立内容库 = 完整明细（完整 gate evidence，含候选正文/裁决证据等）
 *   3. legacy 文件 = 可重建子集的投影缓存
 *
 * 本模块在 projection 写路径下承载「第 2 方」：QualityTraceRecorder.recordGate
 * 把完整 evidence 追加写到 {chapterId}-content.jsonl，取代把完整 evidence 塞进
 * document.gates[]（否则旧文件仍承载完整正文，违反「明细迁独立内容库」）。
 *
 * 路径：{workspacePath}/{workspaceId}/traces/{chapterId}-content.jsonl（JSONL，一行一 gate）
 * 每行：{ schemaVersion: 1, stage, evidence }
 *
 * 写入语义：追加写 + fsync（与 audit-event-store.appendLine 对齐），崩溃丢尾可恢复。
 * 只写、不读、不删；读侧不依赖本库（读侧继续走投影 + 旧文件回退）。
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface TraceContentEntry {
  schemaVersion: 1;
  /** 门禁标识（如 v2_final_selected / author_style_optimization） */
  stage: string;
  /** 完整门禁证据（完整 V2TraceRecord / 候选正文 / 裁决证据等） */
  evidence: unknown;
}

export interface TraceContentStoreOptions {
  /** workspace 父目录（与 legacy QualityTraceRecorder.workspacePath 一致） */
  workspacePath: string;
  workspaceId: string;
  chapterId: string;
}

export class TraceContentStore {
  private readonly outputPath: string;
  private entryCount = 0;
  private lastWriteError: Error | null = null;

  constructor(options: TraceContentStoreOptions) {
    this.outputPath = join(
      options.workspacePath,
      options.workspaceId,
      "traces",
      `${options.chapterId}-content.jsonl`,
    );
  }

  getOutputPath(): string {
    return this.outputPath;
  }

  size(): number {
    return this.entryCount;
  }

  /** 最近一次写入错误（诊断用）；成功写入为 null。 */
  getLastWriteError(): Error | null {
    return this.lastWriteError;
  }

  /**
   * 追加一条完整门禁明细。
   *
   * 写失败不抛（trace 明细可补、正文污染不可逆；审计流仍保留可重建子集），
   * 但通过 lastWriteError 暴露 + 返回 false 让调用方（QualityTraceRecorder）
   * 触发「完整 evidence 回退进 document.gates」的非静默降级，不丢完整明细。
   *
   * @returns true = 成功写入；false = 写入失败（完整明细未进内容库）。
   */
  writeGate(stage: string, evidence: unknown): boolean {
    const entry: TraceContentEntry = { schemaVersion: 1, stage, evidence };
    const line = `${JSON.stringify(entry)}\n`;
    const dir = dirname(this.outputPath);
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const fd = openSync(this.outputPath, "a");
      try {
        writeSync(fd, line, null, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.entryCount++;
      return true;
    } catch (err) {
      this.lastWriteError = err instanceof Error ? err : new Error(String(err));
      return false;
    }
  }
}

export function createTraceContentStore(
  options: TraceContentStoreOptions,
): TraceContentStore {
  return new TraceContentStore(options);
}
