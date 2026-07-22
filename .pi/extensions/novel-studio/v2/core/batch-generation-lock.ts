/**
 * BatchGenerationLock — workspace 级批量任务锁
 *
 * 防止两个批量任务同时推进同一作品的长期叙事状态。
 *
 * 存储：workspaces/{id}/batch-jobs/.lock
 *
 * 锁僵死处理（双校验）：
 *   1. PID 存活（process.kill(pid, 0)）
 *   2. 30min 超时
 * PID 死亡或已超时 → 视为僵死锁，强制释放后重新获取。
 *
 * BATCH-P0-09
 */

import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "node:path";
import { atomicSave } from "./orchestrator-commit-save.js";

// ============================================================================
// 常量
// ============================================================================

const BATCH_JOBS_DIR = "batch-jobs";
const LOCK_FILE_NAME = ".lock";

/** 锁超时时间（毫秒）：30 分钟 */
export const LOCK_TIMEOUT_MS = 30 * 60 * 1000;

// ============================================================================
// 类型
// ============================================================================

export interface BatchLockInfo {
  workspaceId: string;
  jobId: string;
  /** 持有锁的进程 PID */
  pid: number;
  /** 获取时间 ISO timestamp */
  acquiredAt: string;
  /** 过期时间 ISO timestamp（acquiredAt + 30min） */
  expiresAt: string;
}

export type AcquireLockResult =
  | { ok: true }
  | { ok: false; reason: string; existingLock?: BatchLockInfo };

// ============================================================================
// 锁函数
// ============================================================================

/**
 * 返回锁文件路径。
 * workspaces/{workspaceId}/batch-jobs/.lock
 */
export function batchLockPath(workspaceId: string, projectRoot: string): string {
  return join(projectRoot, "workspaces", workspaceId, BATCH_JOBS_DIR, LOCK_FILE_NAME);
}

/**
 * 检查 PID 是否存活。
 * 使用 process.kill(pid, 0) 探测：不发送信号，只检查进程是否存在。
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取 workspace 级批量任务锁。
 *
 * - 锁不存在 → 获取成功
 * - 锁存在且 PID 存活 + 未超时 → 拒绝
 * - 锁存在但 PID 死亡或已超时 → 视为僵死锁，强制释放后重新获取
 *
 * BATCH-P0-09：禁止两个任务同时推进同一作品。
 */
export function acquireBatchLock(
  workspaceId: string,
  jobId: string,
  projectRoot: string,
): AcquireLockResult {
  const lockPath = batchLockPath(workspaceId, projectRoot);
  if (existsSync(lockPath)) {
    try {
      const existing = JSON.parse(readFileSync(lockPath, "utf-8")) as BatchLockInfo;
      const pidAlive = isPidAlive(existing.pid);
      const expired = Date.now() > new Date(existing.expiresAt).getTime();
      if (pidAlive && !expired) {
        return {
          ok: false,
          reason: `workspace ${workspaceId} 已有运行中的批量任务 ${existing.jobId}（pid=${existing.pid}）`,
          existingLock: existing,
        };
      }
      // 僵死锁（PID 死亡或已超时）→ 落到下方覆盖写入
    } catch {
      // 锁文件损坏 → 落到下方覆盖写入
    }
  }
  const now = new Date();
  const lockInfo: BatchLockInfo = {
    workspaceId,
    jobId,
    pid: process.pid,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + LOCK_TIMEOUT_MS).toISOString(),
  };
  atomicSave(lockPath, JSON.stringify(lockInfo, null, 2));
  return { ok: true };
}

/**
 * 释放 workspace 级批量任务锁。
 * 锁不存在时静默成功（幂等）。
 */
export function releaseBatchLock(workspaceId: string, projectRoot: string): void {
  const lockPath = batchLockPath(workspaceId, projectRoot);
  if (existsSync(lockPath)) {
    try {
      unlinkSync(lockPath);
    } catch {
      // 幂等：忽略释放失败
    }
  }
}
