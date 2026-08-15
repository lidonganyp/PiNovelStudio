/**
 * fs-atomic — 跨进程文件原子原语（CONCURRENCY-WAVE1/2/3 共享底座）
 *
 * 提供三类原语，供批量锁（Wave 1）、BatchJobState CAS（Wave 2）、
 * 章节提交队列（Wave 3）复用：
 *
 * 1. atomicCreateExclusive(path, content)：open(path, 'wx') 原子独占创建。
 *    两个进程同时调用最多一个成功——这是所有"首次获取"类互斥的原子性基础。
 * 2. renameTakeover(path, tombstonePrefix)：把僵死资源 rename 到唯一 tombstone，
 *    只有唯一 winner 能成功 rename——这是所有"接管"类互斥的原子性基础。
 * 3. withExclusiveGuard(guardPath, fn)：短期互斥 guard，保护同一资源上的
 *    "读-改-写"复合操作（续租/释放/CAS 保存）。guard 用 'wx' 原子创建，
 *    持有超时视为持 guard 进程崩溃，可被 renameTakeover 接管。
 * 4. syncSleepMs：同步等待（Atomics.wait），用于同步代码内的自旋重试。
 *
 * 设计约束（并发治理计划 §1/§4/§8）：
 * - 禁止 exists → write 的非原子模式；
 * - 接管必须原子且可审计（tombstone 保留）；
 * - guard 获取必须有界预算，fail-closed 而非无限自旋。
 */

import {
  openSync,
  writeSync,
  closeSync,
  unlinkSync,
  renameSync,
  statSync,
  existsSync,
} from "fs";
import { randomUUID } from "node:crypto";

/** guard 默认僵死阈值（毫秒） */
export const DEFAULT_GUARD_STALE_MS = 5 * 1000;

/** guard 默认获取预算（毫秒）：超时抛错（fail-closed） */
export const DEFAULT_GUARD_BUDGET_MS = 2 * 1000;

/**
 * 原子独占创建：open(path, 'wx')。文件已存在返回 false，其他错误上抛。
 * 文件系统保证：两个进程同时调用，最多一个成功。
 */
export function atomicCreateExclusive(path: string, content: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, "wx");
    writeSync(fd, content, null, "utf-8");
    return true;
  } catch (e: any) {
    if (e?.code === "EEXIST") return false;
    throw e;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* fd 已关闭 */ }
    }
  }
}

/**
 * 同步 sleep（Atomics.wait）。锁/提交段是同步代码，需要同步等待做自旋重试。
 */
export function syncSleepMs(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/**
 * 原子接管：把目标资源 rename 到唯一 tombstone 路径。
 * 只有唯一 winner 能成功 rename（他方 ENOENT）。tombstone 保留供审计。
 * 返回 true=接管成功（目标已移除），false=他方抢先或目标不存在。
 */
export function renameTakeover(path: string, tombstonePrefix: string): boolean {
  const tombstonePath = `${tombstonePrefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}-${randomUUID().slice(0, 6)}`;
  try {
    renameSync(path, tombstonePath);
    return true;
  } catch {
    return false;
  }
}

export interface ExclusiveGuardOptions {
  /** guard 持有超过该时长视为持 guard 进程崩溃，可被接管。默认 5s */
  staleMs?: number;
  /** guard 获取总预算（毫秒），超时抛 Error（fail-closed）。默认 2s */
  budgetMs?: number;
}

/**
 * 短期互斥 guard：保护同一资源上的"读-改-写"复合操作。
 *
 * - guard 文件用 'wx' 原子创建；
 * - guard 被他人持有时检查 mtime：超过 staleMs 视为僵死 → renameTakeover 接管；
 * - 获取预算耗尽抛 Error（fail-closed，调用方决定结构化错误形态）。
 *
 * guard 内操作应为毫秒级文件读写；不得在 guard 内执行模型调用或长 IO。
 */
export function withExclusiveGuard<T>(
  guardPath: string,
  fn: () => T,
  options?: ExclusiveGuardOptions,
): T {
  const staleMs = options?.staleMs ?? DEFAULT_GUARD_STALE_MS;
  const budgetMs = options?.budgetMs ?? DEFAULT_GUARD_BUDGET_MS;
  const guardContent = JSON.stringify({
    pid: process.pid,
    at: new Date().toISOString(),
    guardId: randomUUID().slice(0, 8),
  });
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (atomicCreateExclusive(guardPath, guardContent)) {
      try {
        return fn();
      } finally {
        try { unlinkSync(guardPath); } catch { /* 已被接管，无害 */ }
      }
    }
    let st: { mtimeMs: number } | null = null;
    try {
      st = statSync(guardPath, { throwIfNoEntry: false }) ?? null;
    } catch {
      st = null;
    }
    if (st && Date.now() - st.mtimeMs > staleMs && existsSync(guardPath)) {
      renameTakeover(guardPath, `${guardPath}.stale`);
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`exclusive guard acquire timeout: ${guardPath}`);
    }
    syncSleepMs(10);
  }
}
