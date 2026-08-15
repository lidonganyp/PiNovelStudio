/**
 * RECOVERY-CHECKPOINT — 中断/预算耗尽 checkpoint（P5）
 *
 * 规则：
 * - 中断期间不执行 chapter.save / state.commit
 * - resume 必须显式触发
 * - 可保存只读 blocked evidence
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";
import { randomBytes } from "node:crypto";
import type { RecoveryBudget, RecoveryCheckpoint, InterruptSource } from "./recovery-types.js";
import type { FailureClass } from "./failure-types.js";
import type { RecoveryAction } from "./recovery-types.js";

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

export function resolveRecoveryCheckpointDir(workspacePath: string): string {
  return join(workspacePath, "recovery-checkpoints");
}

function assertSafe(id: string, label: string): void {
  if (!id || !SAFE_ID_RE.test(id)) {
    throw new Error(`${label} 非法：${JSON.stringify(id)}`);
  }
}

function atomicWrite(path: string, content: string): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

export interface SaveRecoveryCheckpointInput {
  workspacePath: string;
  workspaceId: string;
  chapterId: string;
  taskId: string;
  stage: string;
  candidateId?: string;
  revision?: string;
  artifactHash?: string;
  completedWork?: string[];
  remainingWork?: string[];
  failureClass?: FailureClass;
  recoveryAction?: RecoveryAction;
  recoveryBudget: RecoveryBudget;
  interruptReason?: InterruptSource | string;
}

export function saveRecoveryCheckpoint(
  input: SaveRecoveryCheckpointInput,
): RecoveryCheckpoint {
  assertSafe(input.workspaceId, "workspaceId");
  assertSafe(input.chapterId, "chapterId");
  const dir = resolveRecoveryCheckpointDir(input.workspacePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const checkpointId = `rcp-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const cp: RecoveryCheckpoint = {
    checkpointId,
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    taskId: input.taskId,
    stage: input.stage,
    candidateId: input.candidateId,
    revision: input.revision,
    artifactHash: input.artifactHash,
    completedWork: input.completedWork ?? [],
    remainingWork: input.remainingWork ?? [],
    failureClass: input.failureClass,
    recoveryAction: input.recoveryAction,
    recoveryBudget: { ...input.recoveryBudget },
    interruptReason: input.interruptReason,
    createdAt: new Date().toISOString(),
    status: "open",
  };

  const path = join(dir, `${input.chapterId}.${checkpointId}.json`);
  const resolved = resolve(path);
  const rel = relative(dir, resolved);
  if (rel.startsWith("..")) {
    throw new Error("checkpoint 路径穿越");
  }
  atomicWrite(path, JSON.stringify(cp, null, 2));

  // 最新指针
  atomicWrite(
    join(dir, `${input.chapterId}.latest.json`),
    JSON.stringify({ checkpointId, path, createdAt: cp.createdAt }, null, 2),
  );
  return cp;
}

export function loadLatestRecoveryCheckpoint(
  workspacePath: string,
  chapterId: string,
): RecoveryCheckpoint | null {
  assertSafe(chapterId, "chapterId");
  const dir = resolveRecoveryCheckpointDir(workspacePath);
  const latestPath = join(dir, `${chapterId}.latest.json`);
  if (!existsSync(latestPath)) return null;
  try {
    const latest = JSON.parse(readFileSync(latestPath, "utf-8")) as {
      path?: string;
      checkpointId?: string;
    };
    if (!latest.path || !existsSync(latest.path)) return null;
    const raw = JSON.parse(readFileSync(latest.path, "utf-8")) as RecoveryCheckpoint;
    if (raw.status !== "open") return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * 显式 resume 前校验：
 * - checkpoint 存在且 open
 * - workspace/chapter 匹配
 * - 预算仍允许
 * 不自动提交、不清除 pending。
 */
export function validateResumeCheckpoint(input: {
  checkpoint: RecoveryCheckpoint;
  workspaceId: string;
  chapterId: string;
}): { ok: boolean; reason?: string } {
  if (input.checkpoint.status !== "open") {
    return { ok: false, reason: "checkpoint_not_open" };
  }
  if (input.checkpoint.workspaceId !== input.workspaceId) {
    return { ok: false, reason: "workspace_mismatch" };
  }
  if (input.checkpoint.chapterId !== input.chapterId) {
    return { ok: false, reason: "chapter_mismatch" };
  }
  return { ok: true };
}

export function markCheckpointResumed(
  workspacePath: string,
  checkpoint: RecoveryCheckpoint,
): RecoveryCheckpoint {
  const updated: RecoveryCheckpoint = {
    ...checkpoint,
    status: "resumed",
  };
  const dir = resolveRecoveryCheckpointDir(workspacePath);
  const path = join(dir, `${checkpoint.chapterId}.${checkpoint.checkpointId}.json`);
  if (existsSync(path)) {
    atomicWrite(path, JSON.stringify(updated, null, 2));
  }
  return updated;
}
