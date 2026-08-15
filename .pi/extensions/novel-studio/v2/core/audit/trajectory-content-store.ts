/**
 * TRAJECTORY-CONTENT-STORE — NovelOS 轨迹明细独立内容库（P7 Stage C-3）
 *
 * 用户方向（三方分离）：
 *   1. 审计流 = 结构化元数据（trajectory_flushed 摘要：sessionId/entryCount/
 *      failureCount/outputPath，不含 message/tool 明细）
 *   2. 独立内容库 = 完整明细（完整轨迹条目 message/tool_event/checkpoint 等）
 *   3. legacy 文件 = 投影缓存（trajectory.jsonl 继续全量写，暂不删除，回放读点不变）
 *
 * 本模块在 projection 写路径下承载「第 2 方」：TrajectoryStore.flush 把完整轨迹
 * 原子写到 trajectory-content.jsonl，作为权威明细源；旧 trajectory.jsonl 降为投影缓存。
 *
 * 路径：{projectRoot}/workspaces/{workspaceId}/novelos-sessions/{sessionId}/trajectory-content.jsonl
 * 每行：{ schemaVersion: 1, type, timestamp, data }（与 trajectory.jsonl 同结构 + schemaVersion）
 *
 * 写入语义：原子写（临时文件 → rename），与 trajectory.jsonl 语义对齐；flush 幂等
 * （多次 flush 全量覆盖，不追加，避免重复条目）。写失败返回 false + lastWriteError 诊断，
 * 不抛（轨迹明细可补、正文污染不可逆；旧 trajectory.jsonl 仍承载完整明细回退）。
 * 只写、不读、不删。
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { injectSigkillFault } from "../sigkill-fault-injection.js";

/** 内容库单条轨迹明细输入（与 TrajectoryEntry 结构兼容，避免 import novelos 写模块） */
export interface TrajectoryContentEntryInput {
  type: string;
  timestamp: number;
  data: unknown;
}

export interface TrajectoryContentStoreOptions {
  projectRoot: string;
  workspaceId: string;
  sessionId: string;
}

export class TrajectoryContentStore {
  private readonly outputPath: string;
  private entryCount = 0;
  private lastWriteError: Error | null = null;

  constructor(options: TrajectoryContentStoreOptions) {
    this.outputPath = join(
      options.projectRoot,
      "workspaces",
      options.workspaceId,
      "novelos-sessions",
      options.sessionId,
      "trajectory-content.jsonl",
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
   * 原子写全部轨迹明细（临时文件 → rename），返回是否成功。
   *
   * 写失败不抛，通过 lastWriteError 暴露 + 返回 false 让调用方（TrajectoryStore）
   * 触发「完整明细仍进旧 trajectory.jsonl」的非静默降级，不丢 message/tool 明细。
   *
   * @returns true = 成功写入；false = 写入失败（完整明细未进内容库）。
   */
  writeAll(entries: ReadonlyArray<TrajectoryContentEntryInput>): boolean {
    const lines =
      entries
        .map((e) =>
          JSON.stringify({
            schemaVersion: 1,
            type: e.type,
            timestamp: e.timestamp,
            data: e.data,
          }),
        )
        .join("\n") + "\n";
    const dir = dirname(this.outputPath);
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const tmp = this.outputPath + ".tmp";
      writeFileSync(tmp, lines, "utf-8");
      // SIGKILL-FAULT-INJECTION：内容库原子写过程中（临时文件已写、rename 前）
      injectSigkillFault("during_content_store_write");
      renameSync(tmp, this.outputPath);
      this.entryCount = entries.length;
      this.lastWriteError = null;
      return true;
    } catch (err) {
      this.lastWriteError = err instanceof Error ? err : new Error(String(err));
      return false;
    }
  }
}

export function createTrajectoryContentStore(
  options: TrajectoryContentStoreOptions,
): TrajectoryContentStore {
  return new TrajectoryContentStore(options);
}
