/**
 * CommitStaleGuard — 提交边界 stale 检测（CONCURRENCY-WAVE4）
 *
 * 目标（并发治理计划 §Wave 4 任务 3/4）：禁止过期上下文越过正式提交边界。
 * 生成开始时捕获基线（active releaseId + CreativeConstitution hash），提交时
 * 重新读取现状比对：
 *   - active production release pointer 变化 → stale_release（阻断）
 *   - CreativeConstitution（CORE-WRITING-PRINCIPLES.md + WORLDBUILDING-CANON.md）
 *     内容变化 → constitution_changed（阻断）
 *
 * 读取方式（生产闭包约束）：
 *   - release pointer 直接读 JSON（release-pointer-store 是 eval-only 模块，
 *     生产 commit 路径不得 import；此处只做只读比对，不切换指针）
 *   - constitutionHash 复用 production-release-gate 的 computeConstitutionHash
 *
 * fail-closed 语义：
 *   - pointer 文件不存在 → activeReleaseId=null（未接入 release 治理时跳过该项检测）
 *   - pointer 文件存在但损坏 → release_pointer_corrupt（阻断，不静默跳过）
 *   - constitution 文件不存在 → constitutionHash=""（两侧一致即通过）
 *
 * 锁不是事实源（Wave 3 原则）：本检测只判定"提交是否允许"，不推断已完成的
 * 提交；崩溃恢复由 Wave 5 的事件事实模型负责。
 *
 * CONCURRENCY-WAVE4
 */

import { existsSync, readFileSync } from "fs";
import { join } from "node:path";
import {
  computeConstitutionHash,
  resolveProductionEvolutionRoot,
} from "../governance/production-release-gate.js";
import { computeNarrativeStateRevision } from "./final-state-commit.js";

// ============================================================================
// 常量
// ============================================================================

/** active production pointer 默认目录（与 production-release-gate.resolveProductionEvolutionRoot 一致） */
function evolutionReleaseDir(projectRoot: string): string {
  return resolveProductionEvolutionRoot(projectRoot);
}

const POINTER_FILE_NAME = "active-production.json";

// ============================================================================
// 类型
// ============================================================================

/** 生成开始时捕获的环境基线 */
export interface GenerationBaseline {
  /** 当时 active production releaseId；未接入 release 治理为 null */
  activeReleaseId: string | null;
  /** Release selected by the successful G6 gate for this execution. */
  executionReleaseId: string | null;
  /** 当时 CreativeConstitution hash（无 constitution 文件为 ""） */
  constitutionHash: string;
  /**
   * 当时 narrative-state-store 磁盘内容 revision（CONCURRENCY-WAVE4）。
   * 捕获时未提供 workspaceId（旧调用方/测试直调）-> null，提交边界跳过该项检测。
   */
  narrativeStateRevision: string | null;
  capturedAt: string;
}

/** 提交时现状（与 GenerationBaseline 同构，便于 trace 对照） */
export interface CommitTimeEnvironment {
  activeReleaseId: string | null;
  constitutionHash: string;
  /** 提交时 narrative-state-store 磁盘内容 revision；未检测为 null */
  narrativeStateRevision: string | null;
  checkedAt: string;
}

export type CommitStaleResult =
  | { ok: true; baseline: GenerationBaseline; current: CommitTimeEnvironment }
  | {
      ok: false;
      code: "stale_release";
      reason: string;
      baseline: GenerationBaseline;
      current: CommitTimeEnvironment;
    }
  | {
      ok: false;
      code: "constitution_changed";
      reason: string;
      baseline: GenerationBaseline;
      current: CommitTimeEnvironment;
    }
  | {
      ok: false;
      code: "stale_state_revision";
      reason: string;
      baseline: GenerationBaseline;
      current: CommitTimeEnvironment;
    }
  | {
      ok: false;
      code: "release_pointer_corrupt";
      reason: string;
      baseline: GenerationBaseline;
      current: null;
    };

// ============================================================================
// 读取
// ============================================================================

/**
 * 读取当前 active production releaseId。
 * - pointer 不存在 → null（未接入 release 治理）
 * - pointer 损坏 → 抛错（调用方 fail-closed 阻断，不静默当作 null）
 */
export function readActiveProductionReleaseId(projectRoot: string): string | null {
  const pointerPath = join(evolutionReleaseDir(projectRoot), POINTER_FILE_NAME);
  if (!existsSync(pointerPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pointerPath, "utf-8"));
  } catch (e) {
    throw new Error(
      `active-production pointer 损坏（${pointerPath}）：${(e as Error).message}；正式提交 fail-closed 阻断，请先修复或删除该文件`,
    );
  }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { releaseId?: unknown }).releaseId !== "string") {
    throw new Error(
      `active-production pointer 结构非法（${pointerPath}）：缺少 releaseId 字段；正式提交 fail-closed 阻断`,
    );
  }
  return (parsed as { releaseId: string }).releaseId;
}

// ============================================================================
// 捕获与检测
// ============================================================================

/**
 * 生成开始时捕获环境基线（ Preflight 之后、模型调用之前调用一次）。
 * @param workspaceId 可选：提供时同时捕获 narrative-state-store 磁盘 revision
 *   （提交边界做状态层 CAS 检测）；未提供 -> narrativeStateRevision=null（跳过该项）
 */
export function captureGenerationBaseline(
  projectRoot: string,
  workspaceId?: string,
  executionReleaseId?: string | null,
): GenerationBaseline {
  return {
    activeReleaseId: readActiveProductionReleaseId(projectRoot),
    executionReleaseId: executionReleaseId ?? null,
    constitutionHash: computeConstitutionHash(projectRoot),
    narrativeStateRevision: workspaceId
      ? computeNarrativeStateRevision(workspaceId, projectRoot)
      : null,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * 提交边界 stale 检测（commitAndSave 提交槽内、聚合门禁之后调用）。
 * 任一基线漂移 -> ok:false + 结构化 code；一致 -> ok:true。
 *
 * narrativeStateRevision 检测（CONCURRENCY-WAVE4）：baseline 携带 revision 且
 * 提供了 workspaceId 时，与磁盘当前 revision 比对，漂移 -> stale_state_revision。
 * baseline.narrativeStateRevision 为 null/undefined（旧基线/未提供 workspaceId）
 * -> 跳过该项（向后兼容）。此处是第一道防线（正文保存前、无副作用阻断）；
 * FinalStateCommit.commit 内的 baseStateRevision CAS 是第二道防线（覆盖所有
 * 状态提交路径，含 0c 门禁与 commit 之间的窗口）。
 */
export function checkCommitStale(
  baseline: GenerationBaseline,
  projectRoot: string,
  workspaceId?: string,
): CommitStaleResult {
  let current: CommitTimeEnvironment;
  try {
    current = {
      activeReleaseId: readActiveProductionReleaseId(projectRoot),
      constitutionHash: computeConstitutionHash(projectRoot),
      narrativeStateRevision: workspaceId
        ? computeNarrativeStateRevision(workspaceId, projectRoot)
        : null,
      checkedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      ok: false,
      code: "release_pointer_corrupt",
      reason: (e as Error).message,
      baseline,
      current: null,
    };
  }

  if (baseline.activeReleaseId !== current.activeReleaseId) {
    return {
      ok: false,
      code: "stale_release",
      reason:
        `生成期间 active production release 已切换：基线 ${baseline.activeReleaseId ?? "(无 active release)"} → ` +
        `当前 ${current.activeReleaseId ?? "(无 active release)"}；候选基于旧 release 上下文，` +
        `禁止提交（stale_release）。请基于当前 release 重新生成。`,
      baseline,
      current,
    };
  }

  if (baseline.constitutionHash !== current.constitutionHash) {
    return {
      ok: false,
      code: "constitution_changed",
      reason:
        `生成期间 CreativeConstitution 已修改（hash ${baseline.constitutionHash.slice(0, 16)}… → ` +
        `${current.constitutionHash.slice(0, 16)}…）；候选基于旧宪法上下文，` +
        `禁止提交（constitution_changed）。请基于当前宪法重新编译上下文后重新生成。`,
      baseline,
      current,
    };
  }

  // CONCURRENCY-WAVE4：状态层 CAS -- 仅在基线携带 revision 且本次提供了 workspaceId 时检测
  if (
    typeof baseline.narrativeStateRevision === "string" &&
    workspaceId &&
    current.narrativeStateRevision !== null &&
    baseline.narrativeStateRevision !== current.narrativeStateRevision
  ) {
    return {
      ok: false,
      code: "stale_state_revision",
      reason:
        `生成期间长期状态（narrative-state-store）已被其他提交更新：` +
        `基线 revision ${baseline.narrativeStateRevision} -> 当前 ${current.narrativeStateRevision}；` +
        `候选基于旧状态上下文，禁止提交（stale_state_revision）。请基于当前状态重新生成。`,
      baseline,
      current,
    };
  }

  return { ok: true, baseline, current };
}
