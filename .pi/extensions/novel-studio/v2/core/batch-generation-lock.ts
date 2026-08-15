/**
 * BatchGenerationLock — workspace 级批量任务锁（Wave 1：原子租约协议）
 *
 * 防止两个批量任务同时推进同一作品的长期叙事状态。
 *
 * 存储：workspaces/{id}/batch-jobs/.lock
 *
 * CONCURRENCY-WAVE1（2026-08-15，并发治理计划）：
 * - 获取采用 open(path, 'wx') 原子独占创建，取代旧 existsSync → atomicSave
 *   的非原子模式；两个进程同时获取同一锁最多一个成功（文件系统保证）。
 * - 锁是带身份的租约：lockId / ownerRunId / ownerJobId / hostId / pid /
 *   acquiredAt / heartbeatAt / expiresAt。释放与续租必须 lockId + ownerJobId
 *   双绑定校验；仅凭 PID 或 jobId 不足以完成所有权判断。
 * - 接管（takeover）只允许两种情形：
 *   a) 租约已过期（租约过期 = 所有权终止，无论 PID 探测结果——持有方
 *      心跳失职即失去持有权）；
 *   b) 同主机上 owner PID 已确定退出（僵尸锁，租约永远不会续期）。
 *   跨主机（hostId 不同）无法探测 PID，只按租约时间判断。
 * - 接管本身是原子的：先把僵死锁 rename 到唯一 tombstone（只有一个 winner
 *   能成功 rename），再用 'wx' 创建新锁。
 * - 损坏锁 fail-closed：JSON 解析失败的锁无法确认所有权，拒绝获取并要求
 *   人工清理，不得静默覆盖。
 * - 续租/释放属于"读-改-写"复合操作，在短期 guard 文件（.lock.guard，
 *   'wx' 原子创建，5s 僵死接管）内执行，防止读到旧锁后覆盖新 owner 的锁。
 * - renewBatchLock 返回结构化结果；心跳失败不再被无限假装持锁。
 *
 * BATCH-P0-09 / CONCURRENCY-WAVE1
 */

import {
  existsSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
} from "fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { validateWorkspaceId, validateJobId } from "./batch-generation-job-store.js";
import { atomicSave } from "./orchestrator-commit-save.js";
import {
  atomicCreateExclusive,
  renameTakeover,
  withExclusiveGuard,
} from "./fs-atomic.js";

// ============================================================================
// 常量
// ============================================================================

const BATCH_JOBS_DIR = "batch-jobs";
const LOCK_FILE_NAME = ".lock";
const LOCK_GUARD_NAME = ".lock.guard";

/** 锁超时时间（毫秒）：30 分钟 */
export const LOCK_TIMEOUT_MS = 30 * 60 * 1000;

/** guard 僵死阈值（毫秒）：guard 持有超过该时长视为持 guard 进程已崩溃 */
const GUARD_STALE_MS = 5 * 1000;

/** guard 获取总预算（毫秒）：超时抛错（fail-closed，不无限自旋） */
const GUARD_ACQUIRE_BUDGET_MS = 2 * 1000;

// ============================================================================
// 类型
// ============================================================================

export interface BatchLockInfo {
  workspaceId: string;
  /** 本次锁实例唯一 ID（接管/释放/续租的所有权凭证） */
  lockId: string;
  /** 持有本次锁的 run 实例 ID（start/resume 各生成一个） */
  ownerRunId: string;
  /** 持有锁的 jobId */
  ownerJobId: string;
  /** 兼容旧字段：等价于 ownerJobId（旧读取方仍用 jobId） */
  jobId: string;
  /** 持有者主机名（跨主机 PID 探测不可信，只按租约时间判断） */
  hostId: string;
  /** 持有锁的进程 PID */
  pid: number;
  /** 获取时间 ISO timestamp */
  acquiredAt: string;
  /** 最近一次心跳时间 ISO timestamp */
  heartbeatAt: string;
  /** 过期时间 ISO timestamp（最近心跳 + 30min） */
  expiresAt: string;
  /** 接管来源 lockId（legacy 锁为 "legacy"，首发为 undefined） */
  tookOverFrom?: string;
  /** 接管原因（expired / zombie_owner_dead） */
  tookOverReason?: string;
}

export type AcquireLockFailureCode =
  | "lock_held"          // 活跃锁：owner 存活且租约未过期
  | "corrupt_lock"       // 损坏锁：fail-closed，要求人工清理
  | "acquire_race";      // 极端竞态：保守拒绝，调用方可重试

export type AcquireLockResult =
  | { ok: true; lock: BatchLockInfo }
  | {
      ok: false;
      reason: string;
      code: AcquireLockFailureCode;
      existingLock?: BatchLockInfo;
    };

export type RenewLockResult =
  | { ok: true; lock: BatchLockInfo }
  | { ok: false; code: "lock_missing" | "corrupt_lock" | "not_owner" | "lock_taken_over"; reason: string };

export interface AcquireLockOptions {
  /** 调用方提供的 run 身份（handler 每次 start/resume 生成一个） */
  ownerRunId?: string;
}

// ============================================================================
// 底层原子原语（fs-atomic.ts 共享实现：atomicCreateExclusive / renameTakeover /
// withExclusiveGuard / syncSleepMs）
// ============================================================================

/** 本模块语义别名：锁 guard 使用共享默认参数（stale 5s / budget 2s） */
function withLockGuard<T>(guardPath: string, fn: () => T): T {
  return withExclusiveGuard(guardPath, fn, {
    staleMs: GUARD_STALE_MS,
    budgetMs: GUARD_ACQUIRE_BUDGET_MS,
  });
}

// ============================================================================
// 锁函数
// ============================================================================

/**
 * 返回锁文件路径。
 * workspaces/{workspaceId}/batch-jobs/.lock
 */
export function batchLockPath(workspaceId: string, projectRoot: string): string {
  validateWorkspaceId(workspaceId);
  return join(projectRoot, "workspaces", workspaceId, BATCH_JOBS_DIR, LOCK_FILE_NAME);
}

/**
 * 检查 PID 是否存活。
 * 使用 process.kill(pid, 0) 探测：不发送信号，只检查进程是否存在。
 * PID 复用防护：存活探测只用于接管判断的保守方向（存活→不接管），
 * 所有权操作（释放/续租）一律以 lockId + ownerJobId 为准，不受 PID 复用影响。
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type ReadLockOutcome =
  | { kind: "none" }        // 锁不存在
  | { kind: "corrupt" }     // 锁存在但损坏
  | { kind: "lock"; lock: BatchLockInfo };

/** 读取锁文件的原始结果（不吞损坏：损坏是 fail-closed 信号）。 */
function tryReadLockOutcome(lockPath: string): ReadLockOutcome {
  if (!existsSync(lockPath)) return { kind: "none" };
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.pid !== "number") {
      return { kind: "corrupt" };
    }
    // 兼容 legacy 锁（无 lockId/ownerJobId，只有 jobId）：字段补齐后按租约协议处理
    const legacy = parsed as Partial<BatchLockInfo>;
    const lock: BatchLockInfo = {
      workspaceId: legacy.workspaceId ?? "",
      lockId: typeof legacy.lockId === "string" ? legacy.lockId : "legacy",
      ownerRunId: typeof legacy.ownerRunId === "string" ? legacy.ownerRunId : "legacy",
      ownerJobId: typeof legacy.ownerJobId === "string" ? legacy.ownerJobId : String(legacy.jobId ?? ""),
      jobId: String(legacy.jobId ?? legacy.ownerJobId ?? ""),
      hostId: typeof legacy.hostId === "string" ? legacy.hostId : "unknown-host",
      pid: typeof legacy.pid === "number" ? legacy.pid : -1,
      acquiredAt: legacy.acquiredAt ?? new Date(0).toISOString(),
      heartbeatAt: legacy.heartbeatAt ?? legacy.acquiredAt ?? new Date(0).toISOString(),
      expiresAt: legacy.expiresAt ?? new Date(0).toISOString(),
    };
    return { kind: "lock", lock };
  } catch {
    return { kind: "corrupt" };
  }
}

/**
 * 读取当前锁文件。无锁或损坏返回 null。
 * P0-FIX-2：供崩溃恢复判断使用。
 * 注意：损坏锁返回 null 与"无锁"不可区分是旧语义；需要区分时用
 * tryReadLockOutcome（内部使用）或检查 acquireBatchLock 的 corrupt_lock 错误码。
 */
export function readBatchLock(
  workspaceId: string,
  projectRoot: string,
): BatchLockInfo | null {
  const lockPath = batchLockPath(workspaceId, projectRoot);
  const outcome = tryReadLockOutcome(lockPath);
  return outcome.kind === "lock" ? outcome.lock : null;
}

/**
 * 判断锁租约是否仍然有效（未过期且 owner 可能存活）。
 * - 同主机：PID 存活且未过期 → 有效
 * - 跨主机：无法探测 PID，仅按租约时间判断
 * P0-FIX-2：供崩溃恢复判断使用。
 */
export function isLockAlive(lockInfo: BatchLockInfo): boolean {
  const expired = Date.now() > new Date(lockInfo.expiresAt).getTime();
  if (expired) return false;
  const sameHost = lockInfo.hostId === hostname();
  if (!sameHost) return true; // 跨主机不可探测 → 保守视为存活（等待租约过期）
  return isPidAlive(lockInfo.pid);
}

/**
 * 接管判定（供 acquire 使用）：
 * - 租约已过期 → 可接管（expired：租约过期 = 所有权终止）
 * - 同主机 owner PID 已退出 → 可接管（zombie_owner_dead：租约永不续期）
 * - 其余（PID 存活未过期 / 跨主机未过期）→ 不可接管
 */
function canTakeOver(lock: BatchLockInfo): { take: boolean; reason?: string } {
  const expired = Date.now() > new Date(lock.expiresAt).getTime();
  if (expired) return { take: true, reason: "expired" };
  const sameHost = lock.hostId === hostname();
  if (sameHost && !isPidAlive(lock.pid)) {
    return { take: true, reason: "zombie_owner_dead" };
  }
  return { take: false };
}

/**
 * 获取 workspace 级批量任务锁（CONCURRENCY-WAVE1：原子租约协议）。
 *
 * 流程（计划 §4.1）：
 *   1. 原子创建（'wx'）→ 成功即持有
 *   2. 失败 → 读取租约
 *      - 损坏 → fail-closed（corrupt_lock），要求人工清理
 *      - 活跃（owner 可存活且未过期）→ 拒绝（lock_held）
 *      - 可接管（过期 / 同主机 owner 已死）→ rename 僵死锁到 tombstone
 *        （原子，唯一 winner）→ 'wx' 创建新锁（记录 tookOverFrom）
 *
 * BATCH-P0-09：禁止两个任务同时推进同一作品。
 */
export function acquireBatchLock(
  workspaceId: string,
  jobId: string,
  projectRoot: string,
  options?: AcquireLockOptions,
): AcquireLockResult {
  validateWorkspaceId(workspaceId);
  validateJobId(jobId);
  const lockPath = batchLockPath(workspaceId, projectRoot);

  // 确保 batch-jobs 目录存在（open 'wx' 不会创建父目录）
  const lockDir = join(projectRoot, "workspaces", workspaceId, BATCH_JOBS_DIR);
  if (!existsSync(lockDir)) {
    try { mkdirSync(lockDir, { recursive: true }); } catch { /* 已存在 */ }
  }

  const now = new Date();
  const mkLock = (tookOverFrom?: string, tookOverReason?: string): BatchLockInfo => ({
    workspaceId,
    lockId: `lock-${now.getTime().toString(36)}-${randomUUID().slice(0, 8)}`,
    ownerRunId: options?.ownerRunId ?? `run-${randomUUID().slice(0, 8)}`,
    ownerJobId: jobId,
    jobId,
    hostId: hostname(),
    pid: process.pid,
    acquiredAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + LOCK_TIMEOUT_MS).toISOString(),
    ...(tookOverFrom !== undefined ? { tookOverFrom, tookOverReason } : {}),
  });

  // 1. 原子创建
  const first = mkLock();
  if (atomicCreateExclusive(lockPath, JSON.stringify(first, null, 2))) {
    return { ok: true, lock: first };
  }

  // 2. 读取现有租约
  let outcome = tryReadLockOutcome(lockPath);
  if (outcome.kind === "corrupt") {
    return {
      ok: false,
      code: "corrupt_lock",
      reason: `workspace ${workspaceId} 锁文件损坏（无法确认所有权）。fail-closed：请人工检查并删除 ${lockPath} 后重试，不得静默覆盖。`,
    };
  }
  if (outcome.kind === "none") {
    // 读取瞬间锁被释放 → 重试原子创建一次
    if (atomicCreateExclusive(lockPath, JSON.stringify(first, null, 2))) {
      return { ok: true, lock: first };
    }
    outcome = tryReadLockOutcome(lockPath);
    if (outcome.kind === "corrupt") {
      return {
        ok: false,
        code: "corrupt_lock",
        reason: `workspace ${workspaceId} 锁文件损坏（无法确认所有权）。fail-closed：请人工检查并删除 ${lockPath} 后重试。`,
      };
    }
    if (outcome.kind === "none") {
      return {
        ok: false,
        code: "acquire_race",
        reason: `workspace ${workspaceId} 锁在读取时消失且重建竞争失败（极端竞态）。请重试。`,
      };
    }
  }

  const existing = outcome.lock;

  // 3. 活跃锁 → 拒绝
  const takeover = canTakeOver(existing);
  if (!takeover.take) {
    return {
      ok: false,
      code: "lock_held",
      reason: `workspace ${workspaceId} 已有运行中的批量任务 ${existing.ownerJobId || existing.jobId}（pid=${existing.pid}, host=${existing.hostId}, expiresAt=${existing.expiresAt}）`,
      existingLock: existing,
    };
  }

  // 4. 原子接管：rename 僵死锁到唯一 tombstone（唯一 winner 才能成功）
  const tookOverFrom = existing.lockId;
  const renamed = renameTakeover(lockPath, `${lockPath}.tombstone`);
  const next = mkLock(tookOverFrom, takeover.reason);
  if (!renamed) {
    // 他方抢先接管 → 尝试原子创建（若他方尚未写入则我方获得）
    if (atomicCreateExclusive(lockPath, JSON.stringify(next, null, 2))) {
      return { ok: true, lock: next };
    }
    return {
      ok: false,
      code: "lock_held",
      reason: `workspace ${workspaceId} 僵死锁接管与他方竞争失败（新持有者已写入）。请重试。`,
      existingLock: next,
    };
  }
  // 5. 接管成功 → 创建新锁；此窗口内若他方抢先创建则拒绝（不覆盖）
  if (atomicCreateExclusive(lockPath, JSON.stringify(next, null, 2))) {
    return { ok: true, lock: next };
  }
  return {
    ok: false,
    code: "lock_held",
    reason: `workspace ${workspaceId} 接管后新锁创建与他方竞争失败。请重试。`,
  };
}

/**
 * 释放 workspace 级批量任务锁。
 *
 * CONCURRENCY-WAVE1：lockId + ownerJobId 双绑定校验（在 guard 内执行，
 * 防止"读到自己的旧锁 → 窗口内被接管 → unlink 删掉新 owner 的锁"）。
 * - lockId 未提供（legacy 调用兼容）：仅校验 ownerJobId；
 *   生产路径（handler）必须传 lockId。
 * - 锁不存在或非己持有时静默成功（幂等 + 安全）。
 */
export function releaseBatchLock(
  workspaceId: string,
  jobId: string,
  projectRoot: string,
  lockId?: string,
): void {
  validateWorkspaceId(workspaceId);
  validateJobId(jobId);
  const lockPath = batchLockPath(workspaceId, projectRoot);
  const guardPath = join(lockDirOf(lockPath), LOCK_GUARD_NAME);
  try {
    withLockGuard(guardPath, () => {
      const outcome = tryReadLockOutcome(lockPath);
      if (outcome.kind !== "lock") return; // 无锁/损坏 → 幂等返回（损坏锁不可确认所有权，不删）
      const existing = outcome.lock;
      if ((existing.ownerJobId || existing.jobId) !== jobId) return; // 不是自己的锁
      if (lockId !== undefined && existing.lockId !== lockId) return; // 锁已被接管 → 不是自己的锁
      try { unlinkSync(lockPath); } catch { /* 幂等 */ }
    });
  } catch {
    // guard 超时等基础设施错误 → 不删除（fail-closed：宁可留锁也不误删他人锁）
  }
}

/**
 * 续租 workspace 级批量任务锁。
 *
 * CONCURRENCY-WAVE1：返回结构化结果（旧版返回 void 并吞掉失败）。
 * - 心跳失败（锁丢失/被接管/损坏）→ { ok:false, code }，调用方不得继续假装持锁。
 * - 续租在 guard 内 CAS 校验 lockId 与 ownerJobId 后写入。
 *
 * P0-FIX-5：长任务（100+ 章）每章完成后调用，将 expiresAt 延长 LOCK_TIMEOUT_MS。
 */
export function renewBatchLock(
  workspaceId: string,
  jobId: string,
  projectRoot: string,
  lockId?: string,
): RenewLockResult {
  validateWorkspaceId(workspaceId);
  validateJobId(jobId);
  const lockPath = batchLockPath(workspaceId, projectRoot);
  const guardPath = join(lockDirOf(lockPath), LOCK_GUARD_NAME);
  try {
    return withLockGuard<RenewLockResult>(guardPath, () => {
      const outcome = tryReadLockOutcome(lockPath);
      if (outcome.kind === "none") {
        return { ok: false, code: "lock_missing", reason: `workspace ${workspaceId} 锁不存在（已被释放或接管）` };
      }
      if (outcome.kind === "corrupt") {
        return { ok: false, code: "corrupt_lock", reason: `workspace ${workspaceId} 锁文件损坏，无法续租` };
      }
      const existing = outcome.lock;
      if ((existing.ownerJobId || existing.jobId) !== jobId) {
        return { ok: false, code: "not_owner", reason: `workspace ${workspaceId} 锁属于其他任务（${existing.ownerJobId || existing.jobId}），不续租` };
      }
      if (lockId !== undefined && existing.lockId !== lockId) {
        return { ok: false, code: "lock_taken_over", reason: `workspace ${workspaceId} 锁已被接管（磁盘 lockId=${existing.lockId}，期望 ${lockId}），当前持有者已失去所有权` };
      }
      const renewed: BatchLockInfo = {
        ...existing,
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + LOCK_TIMEOUT_MS).toISOString(),
      };
      // guard 内写入：此时不可能有并发接管（接管也需要 guard 或 'wx' 创建）
      atomicSave(lockPath, JSON.stringify(renewed, null, 2));
      return { ok: true, lock: renewed };
    });
  } catch (e: any) {
    return { ok: false, code: "corrupt_lock", reason: `续租基础设施错误：${e?.message ?? String(e)}` };
  }
}

/** 从锁路径取目录（guard 与锁同目录）。 */
function lockDirOf(lockPath: string): string {
  const idx = Math.max(lockPath.lastIndexOf("/"), lockPath.lastIndexOf("\\"));
  return idx >= 0 ? lockPath.slice(0, idx) : ".";
}
