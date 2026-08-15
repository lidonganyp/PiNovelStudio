/**
 * SubmissionQueue — workspace 章节提交队列与资源级声明（Wave 3）
 *
 * 目标（并发治理计划 §3 / Wave 3）：把"生成生命周期互斥"改为"正式副作用互斥"。
 *
 * 资源分层（计划 §3）：
 * - readonly_compute：只读计算（Preflight/retrieval/Review Surface/离线 Eval）——
 *   高并发，不获取任何锁，只做声明登记；
 * - candidate_write：候选与诊断写入（candidate artifact / trace / checkpoint）——
 *   有限并发，写入绑定 runId+candidateId+artifactHash+baseRevision，不获取提交锁；
 * - chapter_commit：正式章节提交（FinalFactRecheck 之后的提交段）——
 *   同一 workspace 严格串行，跨进程互斥；
 * - release_governance：production pointer / release hold / strategy promotion——
 *   项目级串行（本波次先提供类型与声明登记，互斥由 governance 流程接入）。
 *
 * 跨进程互斥实现（同步，供 commitAndSave 等同步提交段使用）：
 * - workspaces/{id}/batch-jobs/.commit-lock：open('wx') 原子创建获取；
 * - 持有失败 → 读租约：未过期忙等（有界预算）；过期 → rename 原子接管；
 * - 损坏锁 → 按文件 mtime 视为租约起点，超龄才接管（不立即覆盖）；
 * - 等待预算耗尽 → 返回结构化 commit_slot_busy（fail-closed，不静默继续提交）；
 * - 释放走短期 guard（读-验-删复合操作），guard 获取失败宁可留锁等租约过期。
 *
 * 结构化 trace：workspaces/{id}/traces/submission-queue.jsonl（追加）。
 * 排队、获取、接管、超时、释放、资源声明都记录；trace 写入失败不阻断（advisory）。
 *
 * 锁不是事实源：提交成功与否以 commit receipt / 正文 revision / NarrativeState
 * revision 为准；锁丢失不能直接判定提交失败（Wave 5 恢复范畴）。
 *
 * CONCURRENCY-WAVE3
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { validateWorkspaceId } from "./batch-generation-job-store.js";
import { isPidAlive } from "./batch-generation-lock.js";
import {
  atomicCreateExclusive,
  renameTakeover,
  syncSleepMs,
  withExclusiveGuard,
} from "./fs-atomic.js";

// ============================================================================
// 常量
// ============================================================================

const BATCH_JOBS_DIR = "batch-jobs";
const COMMIT_LOCK_NAME = ".commit-lock";
const COMMIT_LOCK_GUARD_NAME = ".commit-lock.guard";
const TRACE_FILE_NAME = "submission-queue.jsonl";

/** 提交槽租约（毫秒）：默认 60s。提交段是毫秒~秒级文件事务，60s 足够覆盖； */
export function commitSlotLeaseMs(): number {
  const env = Number(process.env.PINOVEL_COMMIT_SLOT_LEASE_MS);
  return Number.isFinite(env) && env >= 5000 ? env : 60 * 1000;
}

/** 提交槽等待预算（毫秒）：默认 30s。超时返回 commit_slot_busy（fail-closed）。 */
export function commitSlotWaitMs(): number {
  const env = Number(process.env.PINOVEL_COMMIT_SLOT_WAIT_MS);
  return Number.isFinite(env) && env >= 0 ? env : 30 * 1000;
}

/** 忙等轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 25;

// ============================================================================
// 类型
// ============================================================================

/** 资源类型（计划 §3 资源分层） */
export type SubmissionResourceType =
  | "readonly_compute"
  | "candidate_write"
  | "chapter_commit"
  | "release_governance";

export interface CommitSlotOwner {
  /** 提交发起者描述（batch jobId / "single-chapter" / governance 流程名） */
  owner: string;
  /** 关联 run/chapter（审计字段） */
  chapterId?: string;
  runId?: string;
}

interface CommitLockContent {
  lockId: string;
  owner: string;
  chapterId?: string;
  runId?: string;
  hostId: string;
  pid: number;
  acquiredAt: string;
  expiresAt: string;
}

export type CommitSlotHandle =
  | { ok: true; lockId: string; waitedMs: number; tookOverFrom?: string }
  | { ok: false; code: "commit_slot_busy"; reason: string; waitedMs: number };

// ============================================================================
// trace
// ============================================================================

function tracePath(workspaceId: string, projectRoot: string): string {
  return join(projectRoot, "workspaces", workspaceId, "traces", TRACE_FILE_NAME);
}

/** 追加一条结构化 trace 事件（advisory：失败不阻断提交）。 */
function recordTrace(
  workspaceId: string,
  projectRoot: string,
  event: Record<string, unknown>,
): void {
  try {
    const dir = join(projectRoot, "workspaces", workspaceId, "traces");
    if (!existsSync(dir)) {
      try { mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
    }
    appendFileSync(
      tracePath(workspaceId, projectRoot),
      JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n",
      "utf-8",
    );
  } catch {
    // trace 写入失败不阻断主链路（advisory）
  }
}

// ============================================================================
// 资源声明（Level 1 / Level 2 / Level 4 登记；chapter_commit 由提交槽实现）
// ============================================================================

/**
 * 声明资源类型：只读计算 / 候选写入 / release 治理入口调用，
 * 写入 submission-queue.jsonl 供并发审计。
 * 这些层级不获取提交锁——提交互斥只属于 chapter_commit。
 */
export function declareSubmissionResource(
  workspaceId: string,
  projectRoot: string,
  type: SubmissionResourceType,
  meta: Record<string, unknown>,
): void {
  try {
    validateWorkspaceId(workspaceId);
  } catch {
    return; // 非法 workspaceId：声明是 advisory，不阻断调用方
  }
  recordTrace(workspaceId, projectRoot, {
    event: "resource_declared",
    resourceType: type,
    hostId: hostname(),
    pid: process.pid,
    ...meta,
  });
}

// ============================================================================
// 章节提交槽（Level 3：同一 workspace 严格串行，跨进程互斥）
// ============================================================================

function commitLockPath(workspaceId: string, projectRoot: string): string {
  return join(projectRoot, "workspaces", workspaceId, BATCH_JOBS_DIR, COMMIT_LOCK_NAME);
}

function parseCommitLock(lockPath: string):
  | { kind: "none" }
  | { kind: "corrupt"; mtimeMs: number }
  | { kind: "lock"; lock: CommitLockContent } {
  if (!existsSync(lockPath)) return { kind: "none" };
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf-8")) as CommitLockContent;
    if (!parsed || typeof parsed !== "object" || typeof parsed.expiresAt !== "string") {
      const st = statSync(lockPath, { throwIfNoEntry: false });
      return { kind: "corrupt", mtimeMs: st?.mtimeMs ?? Date.now() };
    }
    return { kind: "lock", lock: parsed };
  } catch {
    const st = statSync(lockPath, { throwIfNoEntry: false });
    return { kind: "corrupt", mtimeMs: st?.mtimeMs ?? Date.now() };
  }
}

/**
 * 获取 workspace 章节提交槽（同步，跨进程原子）。
 *
 * 流程：
 *   'wx' 原子创建 → 成功持有
 *   失败 → 读租约：
 *     - 未过期 → 忙等（有界预算）
 *     - 已过期 → rename 原子接管（唯一 winner）→ 'wx' 创建
 *     - 损坏 → mtime 超过一个租约周期才接管（不立即覆盖无法确认所有权的文件）
 *   预算耗尽 → commit_slot_busy（fail-closed）
 */
function acquireCommitSlot(
  workspaceId: string,
  projectRoot: string,
  slotOwner: CommitSlotOwner,
  waitMs: number,
): CommitSlotHandle {
  const startedAt = Date.now();
  const lockPath = commitLockPath(workspaceId, projectRoot);
  const lockDir = join(projectRoot, "workspaces", workspaceId, BATCH_JOBS_DIR);
  if (!existsSync(lockDir)) {
    try { mkdirSync(lockDir, { recursive: true }); } catch { /* 已存在 */ }
  }
  const leaseMs = commitSlotLeaseMs();
  const deadline = startedAt + waitMs;
  let tookOverFrom: string | undefined;

  const mkContent = (): CommitLockContent => {
    const now = new Date();
    return {
      lockId: `cmt-${now.getTime().toString(36)}-${randomUUID().slice(0, 8)}`,
      owner: slotOwner.owner,
      ...(slotOwner.chapterId !== undefined ? { chapterId: slotOwner.chapterId } : {}),
      ...(slotOwner.runId !== undefined ? { runId: slotOwner.runId } : {}),
      hostId: hostname(),
      pid: process.pid,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    };
  };

  for (;;) {
    const content = mkContent();
    if (tookOverFrom !== undefined) {
      (content as CommitLockContent & { tookOverFrom?: string }).tookOverFrom = tookOverFrom;
    }
    if (atomicCreateExclusive(lockPath, JSON.stringify(content, null, 2))) {
      recordTrace(workspaceId, projectRoot, {
        event: "slot_acquired",
        chapterId: slotOwner.chapterId ?? null,
        owner: slotOwner.owner,
        lockId: content.lockId,
        waitedMs: Date.now() - startedAt,
        ...(tookOverFrom !== undefined ? { tookOverFrom } : {}),
      });
      return {
        ok: true,
        lockId: content.lockId,
        waitedMs: Date.now() - startedAt,
        ...(tookOverFrom !== undefined ? { tookOverFrom } : {}),
      };
    }

    const outcome = parseCommitLock(lockPath);
    if (outcome.kind === "none") {
      // 读取瞬间被释放 → 立即重试创建
      continue;
    }
    if (outcome.kind === "lock") {
      const expired = Date.now() > new Date(outcome.lock.expiresAt).getTime();
      // 僵死接管判定（与批量锁 zombie_owner_dead 同语义）：
      // 同主机且 owner PID 已退出 → 持有进程崩溃（如 SIGKILL），
      // 租约永不续期 → 可接管。跨主机不可探测 → 保守等待租约过期。
      const sameHost = outcome.lock.hostId === hostname();
      const zombieOwner = sameHost && !isPidAlive(outcome.lock.pid);
      if (expired || zombieOwner) {
        // 过期或僵死 → 原子接管（唯一 winner 才能 rename 成功）
        if (renameTakeover(lockPath, `${lockPath}.tombstone`)) {
          tookOverFrom = outcome.lock.lockId;
          recordTrace(workspaceId, projectRoot, {
            event: "slot_takeover",
            chapterId: slotOwner.chapterId ?? null,
            owner: slotOwner.owner,
            tookOverFrom: outcome.lock.lockId,
            previousOwner: outcome.lock.owner,
            reason: expired ? "expired" : "zombie_owner_dead",
          });
          continue;
        }
        // 他方抢先接管 → 回到循环重新竞争创建
        continue;
      }
    } else {
      // 损坏锁：mtime 超过一个租约周期才接管（期间视为被持有，忙等）
      if (Date.now() - outcome.mtimeMs > leaseMs) {
        if (renameTakeover(lockPath, `${lockPath}.tombstone`)) {
          tookOverFrom = "corrupt";
          recordTrace(workspaceId, projectRoot, {
            event: "slot_takeover",
            chapterId: slotOwner.chapterId ?? null,
            owner: slotOwner.owner,
            tookOverFrom: "corrupt",
            reason: "corrupt_stale",
          });
          continue;
        }
        continue;
      }
    }

    // 活跃锁（或未超龄损坏锁）→ 忙等
    if (Date.now() > deadline) {
      recordTrace(workspaceId, projectRoot, {
        event: "slot_busy_timeout",
        chapterId: slotOwner.chapterId ?? null,
        owner: slotOwner.owner,
        waitedMs: Date.now() - startedAt,
      });
      return {
        ok: false,
        code: "commit_slot_busy",
        reason: `workspace ${workspaceId} 章节提交槽等待 ${Date.now() - startedAt}ms 超时（当前持有者未释放、未过期）。fail-closed：不静默并行提交。`,
        waitedMs: Date.now() - startedAt,
      };
    }
    syncSleepMs(POLL_INTERVAL_MS);
  }
}

/**
 * 释放章节提交槽（guard 内"读-验-删"；非己持有时幂等返回）。
 */
function releaseCommitSlot(
  workspaceId: string,
  projectRoot: string,
  lockId: string,
): void {
  const lockPath = commitLockPath(workspaceId, projectRoot);
  const guardPath = join(
    projectRoot, "workspaces", workspaceId, BATCH_JOBS_DIR, COMMIT_LOCK_GUARD_NAME,
  );
  try {
    withExclusiveGuard(guardPath, () => {
      const outcome = parseCommitLock(lockPath);
      if (outcome.kind !== "lock") return; // 无锁/损坏 → 幂等（损坏不删）
      if (outcome.lock.lockId !== lockId) return; // 已被接管 → 不是自己的槽
      try { unlinkSync(lockPath); } catch { /* 幂等 */ }
    });
  } catch {
    // guard 失败 → 留锁等租约过期（安全方向：宁可串行等待也不误删他人槽）
  }
}

export interface WithCommitSlotOptions {
  workspaceId: string;
  projectRoot: string;
  chapterId?: string;
  owner: string;
  runId?: string;
  /** 等待预算覆盖（默认 commitSlotWaitMs） */
  waitMs?: number;
}

export interface WithCommitSlotOutcome<T> {
  result: T;
  slot: CommitSlotHandle;
}

/**
 * 在 workspace 章节提交槽内执行提交段（Level 3：chapter_commit 资源）。
 *
 * - 同一 workspace 同一时刻最多一个进程在槽内执行（跨进程原子互斥）；
 * - 进程内天然串行（同步执行 + 忙等排队）；
 * - 不同 workspace 互不影响（锁按 workspace 隔离）；
 * - 槽获取失败返回结构化 commit_slot_busy（调用方 fail-closed，不静默提交）。
 *
 * fn 必须是同步的毫秒~秒级文件事务（如 commitAndSave 提交段）；
 * 禁止在槽内执行模型调用或长 IO。
 */
export function withChapterCommitSlot<T>(
  options: WithCommitSlotOptions,
  fn: () => T,
): WithCommitSlotOutcome<T> {
  const { workspaceId, projectRoot } = options;
  validateWorkspaceId(workspaceId);
  const slot = acquireCommitSlot(
    workspaceId,
    projectRoot,
    { owner: options.owner, chapterId: options.chapterId, runId: options.runId },
    options.waitMs ?? commitSlotWaitMs(),
  );
  if (!slot.ok) {
    // fail-closed：不执行 fn。调用方通过 slot.code 判定提交被拒。
    throw new CommitSlotBusyError(slot.reason, slot.waitedMs);
  }
  try {
    const result = fn();
    recordTrace(workspaceId, projectRoot, {
      event: "slot_released",
      chapterId: options.chapterId ?? null,
      owner: options.owner,
      lockId: slot.lockId,
      heldMs: Date.now() - (Date.now() - slot.waitedMs),
    });
    return { result, slot };
  } finally {
    releaseCommitSlot(workspaceId, projectRoot, slot.lockId);
  }
}

/** 提交槽忙错误（fail-closed）：调用方捕获后返回结构化失败，不得重试提交段本身。 */
export class CommitSlotBusyError extends Error {
  readonly code = "commit_slot_busy" as const;
  readonly waitedMs: number;
  constructor(reason: string, waitedMs: number) {
    super(reason);
    this.name = "CommitSlotBusyError";
    this.waitedMs = waitedMs;
  }
}
