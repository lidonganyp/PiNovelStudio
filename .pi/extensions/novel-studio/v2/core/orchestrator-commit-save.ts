/**
 * orchestrator-commit-save - 统一主链路"状态提交 + 原子保存"相位
 *
 * 从 unified-orchestrator.ts 抽出（行为保持重构 Step 2）。
 * 包含：commitAndSave（事务：先原子保存正文，后提交状态）、atomicSave、
 * extractPatternEntriesFromText（B2 PatternMemory）、chapterFilePath。
 *
 * 事务顺序（计划 §3 FinalStateCommit + AGENTS.md 状态维护事务边界）：
 * 1. 先原子保存正文（失败 = hard block，不污染状态）
 * 2. 后提交状态（失败 = hard block，并回滚刚保存的正文）
 *
 * 本模块为纯函数集合，不持有实例状态，不调用 UnifiedOrchestrator 的其他方法。
 */

import { writeFileSync, mkdirSync, renameSync, existsSync, readFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import type { UnifiedOrchestratorInput } from "./orchestrator-types.js";
import { injectSigkillFault } from "./sigkill-fault-injection.js";
import { checkCommitStale } from "./commit-stale-guard.js";
import type { GenerationBaseline } from "./commit-stale-guard.js";

/** 磁盘级 commitIntent 完成账本（幂等，进程重启仍有效） */
interface CommitIntentLedgerEntry {
  commitIntentId: string;
  artifactHash: string;
  status: "completed";
  completedAt: string;
  chapterId: string;
}

interface CommitIntentLedger {
  schemaVersion: 1;
  entries: Record<string, CommitIntentLedgerEntry>;
}

function commitIntentLedgerPath(workspacePath: string, chapterId: string): string {
  return join(workspacePath, "chapter-approvals", `${chapterId}.commit-intents.json`);
}

function loadCommitIntentLedger(
  workspacePath: string,
  chapterId: string,
): CommitIntentLedger {
  const path = commitIntentLedgerPath(workspacePath, chapterId);
  if (!existsSync(path)) {
    return { schemaVersion: 1, entries: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as CommitIntentLedger;
    if (!raw || typeof raw !== "object" || !raw.entries) {
      return { schemaVersion: 1, entries: {} };
    }
    return { schemaVersion: 1, entries: { ...raw.entries } };
  } catch {
    return { schemaVersion: 1, entries: {} };
  }
}

function markCommitIntentCompleted(
  workspacePath: string,
  chapterId: string,
  commitIntentId: string,
  artifactHash: string,
): void {
  const dir = join(workspacePath, "chapter-approvals");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = commitIntentLedgerPath(workspacePath, chapterId);
  const ledger = loadCommitIntentLedger(workspacePath, chapterId);
  const next: CommitIntentLedger = {
    schemaVersion: 1,
    entries: {
      ...ledger.entries,
      [commitIntentId]: {
        commitIntentId,
        artifactHash,
        status: "completed",
        completedAt: new Date().toISOString(),
        chapterId,
      },
    },
  };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf-8");
  renameSync(tmp, path);
}

function lookupCommitIntentOnDisk(
  workspacePath: string,
  chapterId: string,
  commitIntentId: string,
): CommitIntentLedgerEntry | null {
  const ledger = loadCommitIntentLedger(workspacePath, chapterId);
  const entry = ledger.entries[commitIntentId];
  if (!entry || entry.status !== "completed") return null;
  return entry;
}
import {
  createFinalStateCommit,
  loadStateStore,
  reanchorStagedStateToFinalText,
  computeFinalTextHash,
  type PatternEntry,
  type StagedStateUpdate,
  // CONCURRENCY-WAVE4：状态 revision CAS 失败异常（commit 落盘前抛出）
  StaleStateRevisionError,
} from "./final-state-commit.js";
import { createLanguageRiskLibrary } from "./language-risk-library.js";
import { bridgeStateToSeriesFiles } from "./narrative-state-bridge.js";
import { integrateClosureTracker } from "./closure-tracker-integration.js";
import { persistChapterProgressionContract } from "./chapter-progression-contract.js";
import { writeChapterContinuitySnapshot } from "../../craft/chapter-continuity-snapshot.js";
import type { StructuralEvidence, ChapterQualityEvidence } from "./chapter-quality-evidence.js";
// G7-Checkpoint + RUN-LIFECYCLE-P0：
// 审批守护双源 fail-closed：
// 1) RunAggregate.approvalState（权威，若 auditSink 提供 getLifecycleGate）
// 2) pending sentinel 文件投影（hasPendingProxyDraft）— 降级兼容/双保险
// 任一判定 pending/不可提交 → 拒绝写 chapters/ 与状态。
import { hasPendingProxyDraft } from "../governance/chapter-proxy-approval-draft-checkpoint.js";
// MEMORY-TRANSACTION-1：硬冲突阻断异常（FinalStateCommit.commit 在状态落盘前抛出）
import { MemoryHardConflictError } from "./memory/memory-lifecycle.js";
// CONCURRENCY-WAVE3：workspace 章节提交槽（同一 workspace 提交段跨进程串行）
import {
  withChapterCommitSlot,
  CommitSlotBusyError,
} from "./submission-queue.js";

function injectCommitFault(point: "after_chapter_save" | "state_commit"): void {
  if (process.env.PINOVEL_COMMIT_FAULT === point) {
    throw new Error(`[commit-fault] injected at ${point}`);
  }
}

export interface CommitAndSaveResult {
  ok: boolean;
  error?: string;
  stateCommit: { committed: number; rejected: number; error?: string | null } | null;
  /** 相同 commitIntentId 已完成时的幂等命中：无新写盘副作用 */
  idempotent?: boolean;
  commitIntentId?: string;
}

/**
 * 最终正文选定后：原子保存正文 + 提交状态（P0-4 事务一致性）。
 *
 * CONCURRENCY-WAVE3：正式提交段在 workspace 章节提交槽内串行执行
 * （同一 workspace 同一时刻最多一个提交者，跨进程原子互斥；槽获取
 * 超时 fail-closed 返回 commit_slot_busy，不静默并行提交）。
 *
 * 事务顺序（计划 §3 FinalStateCommit + AGENTS.md 状态维护事务边界）：
 * 1. 先原子保存正文（失败 = hard block，不污染状态）
 * 2. 后提交状态（失败 = hard block，并回滚刚保存的正文）
 *
 * 不再吞掉正文保存失败：正文是主产物，保存失败必须阻断。
 * 状态提交失败不假装成功：记录 error，回滚已保存的正文并返回 ok=false。
 *
 * RUN-LIFECYCLE-P0 修复：
 * - 相同 commitIntentId 若聚合已 completed → 直接幂等返回，不写正文/状态
 * - approvalState=pending|rejected|stale 时阻断（不依赖 sentinel 文件是否被删）
 * - foldError 时 fail-closed 阻断提交
 */
export function commitAndSave(
  input: UnifiedOrchestratorInput,
  selectedCandidateId: string,
  finalText: string,
  stageResults: Record<string, unknown>
): CommitAndSaveResult {
  const { workspaceId, projectRoot } = input;
  const audit = input.auditSink;
  const finalTextHashForSlot = computeFinalTextHash(finalText);
  try {
    const { result, slot } = withChapterCommitSlot(
      {
        workspaceId,
        projectRoot,
        chapterId: input.chapterId,
        owner: `commit:${input.chapterId}`,
      },
      () => commitAndSaveInner(input, selectedCandidateId, finalText, stageResults),
    );
    if (slot.ok) {
      stageResults.submissionQueue = {
        ok: true,
        lockId: slot.lockId,
        waitedMs: slot.waitedMs,
        ...(slot.tookOverFrom !== undefined ? { tookOverFrom: slot.tookOverFrom } : {}),
      };
    }
    return result;
  } catch (e) {
    if (e instanceof CommitSlotBusyError) {
      stageResults.submissionQueue = {
        ok: false,
        code: e.code,
        reason: e.message,
        waitedMs: e.waitedMs,
      };
      stageResults.atomicSave = {
        blocked: true,
        reason: "commit_slot_busy",
        chapterId: input.chapterId,
      };
      audit?.recordPersistenceEvent({
        eventType: "chapter_save_attempted",
        candidateId: selectedCandidateId,
        outputHash: finalTextHashForSlot,
        decisionReason: "commit slot busy (fail-closed)",
        payload: { reason: "commit_slot_busy", waitedMs: e.waitedMs, chapterId: input.chapterId },
      });
      audit?.recordPersistenceEvent({
        eventType: "final_submission",
        candidateId: selectedCandidateId,
        outputHash: finalTextHashForSlot,
        chapterSaveOk: false,
        stateCommitOk: false,
        decisionReason: "blocked: commit slot busy",
        payload: { reason: "commit_slot_busy", waitedMs: e.waitedMs, chapterId: input.chapterId },
      });
      return { ok: false, error: e.message, stateCommit: null };
    }
    throw e;
  }
}

/** 提交槽内的实际提交事务（commitAndSave 的原函数体）。 */
function commitAndSaveInner(
  input: UnifiedOrchestratorInput,
  selectedCandidateId: string,
  finalText: string,
  stageResults: Record<string, unknown>
): CommitAndSaveResult {
  const { workspaceId, projectRoot } = input;
  const audit = input.auditSink;
  const finalTextHash = computeFinalTextHash(finalText);
  /** 供 final_submission 区分 committed / skipped / failed，避免 no-op 被统计成真实提交 */
  let stateCommitOutcome: "committed" | "skipped" | "failed" = "skipped";

  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  const commitIntentId =
    typeof (stageResults as { commitIntentId?: unknown }).commitIntentId === "string"
      ? String((stageResults as { commitIntentId?: string }).commitIntentId)
      : `ci-${input.chapterId}-${finalTextHash.slice(0, 16)}`;
  const artifactRevision =
    typeof (stageResults as { artifactRevision?: unknown }).artifactRevision === "string"
      ? String((stageResults as { artifactRevision?: string }).artifactRevision)
      : finalTextHash.slice(0, 16);

  // ── 0a. 聚合门禁（权威，若可用）────────────────────────────────
  const gate = audit?.getLifecycleGate?.() ?? null;
  if (gate?.foldError) {
    const foldBlock = `audit_fold_error：事件折叠失败，正式提交被阻断（fail-closed）：${gate.foldError}`;
    stageResults.atomicSave = {
      blocked: true,
      reason: "audit_fold_error",
      foldError: gate.foldError,
      chapterId: input.chapterId,
    };
    audit?.recordPersistenceEvent({
      eventType: "chapter_save_attempted",
      candidateId: selectedCandidateId,
      outputHash: finalTextHash,
      decisionReason: "audit_fold_error gate",
      payload: { commitIntentId, foldError: gate.foldError },
    });
    audit?.recordPersistenceEvent({
      eventType: "chapter_save_failed",
      candidateId: selectedCandidateId,
      outputHash: finalTextHash,
      chapterSaveOk: false,
      stateCommitOk: false,
      decisionReason: foldBlock,
      payload: { reason: "audit_fold_error", commitIntentId },
    });
    audit?.recordPersistenceEvent({
      eventType: "final_submission",
      candidateId: selectedCandidateId,
      outputHash: finalTextHash,
      chapterSaveOk: false,
      stateCommitOk: false,
      decisionReason: "blocked: audit fold error",
      payload: { commitIntentId },
    });
    return {
      ok: false,
      error: foldBlock,
      stateCommit: null,
      commitIntentId,
    };
  }

  // 相同 commitIntentId 已完成 → 幂等返回，禁止第二次 chapter_saved / final_submission 副作用
  // 双源：RunAggregate.commitIntent + 磁盘 ledger（进程重启 / 无 getLifecycleGate 时仍有效）
  // 硬规则：仅当 artifactHash 一致才视为幂等重放；hash 不同 → ARTIFACT_HASH_MISMATCH（不覆盖正文）
  const diskEntry = lookupCommitIntentOnDisk(
    workspacePath,
    input.chapterId,
    commitIntentId,
  );
  const aggregateCompleted =
    gate?.commitIntent &&
    gate.commitIntent.commitIntentId === commitIntentId &&
    gate.commitIntent.status === "completed"
      ? gate.commitIntent
      : null;

  const completedHash =
    aggregateCompleted?.artifactHash ?? diskEntry?.artifactHash ?? null;
  const intentCompleted = aggregateCompleted != null || diskEntry != null;

  if (intentCompleted) {
    if (completedHash && completedHash !== finalTextHash) {
      const mismatch = `ARTIFACT_HASH_MISMATCH：commitIntentId=${commitIntentId} 已完成但正文 hash 不同（ledger=${completedHash} current=${finalTextHash}）；拒绝覆盖已提交正文`;
      stageResults.atomicSave = {
        blocked: true,
        reason: "artifact_hash_mismatch",
        commitIntentId,
        ledgerHash: completedHash,
        currentHash: finalTextHash,
      };
      audit?.recordPersistenceEvent({
        eventType: "chapter_save_attempted",
        candidateId: selectedCandidateId,
        outputHash: finalTextHash,
        decisionReason: "commitIntent hash mismatch",
        payload: { commitIntentId, ledgerHash: completedHash },
      });
      audit?.recordPersistenceEvent({
        eventType: "chapter_save_failed",
        candidateId: selectedCandidateId,
        outputHash: finalTextHash,
        chapterSaveOk: false,
        stateCommitOk: false,
        decisionReason: mismatch,
        payload: {
          reason: "artifact_hash_mismatch",
          commitIntentId,
          ledgerHash: completedHash,
        },
      });
      audit?.recordPersistenceEvent({
        eventType: "final_submission",
        candidateId: selectedCandidateId,
        outputHash: finalTextHash,
        chapterSaveOk: false,
        stateCommitOk: false,
        decisionReason: "blocked: commitIntent artifactHash mismatch",
        payload: { commitIntentId },
      });
      return {
        ok: false,
        error: mismatch,
        stateCommit: null,
        commitIntentId,
      };
    }
    stageResults.atomicSave = {
      idempotent: true,
      commitIntentId,
      contentHash: finalTextHash,
      reason: "duplicate_commit_intent",
      source: aggregateCompleted ? "aggregate" : "disk_ledger",
    };
    stageResults.stateCommit = {
      idempotent: true,
      commitIntentId,
      committed: 0,
      rejected: 0,
    };
    return {
      ok: true,
      stateCommit: { committed: 0, rejected: 0, error: null },
      idempotent: true,
      commitIntentId,
    };
  }

  // ── 0b. 审批守护：聚合 approvalState OR 文件 sentinel（双源 fail-closed）──
  const filePending = hasPendingProxyDraft(workspacePath, input.chapterId);
  const aggregateBlocksCommit =
    gate != null &&
    (gate.approvalState === "pending" ||
      gate.approvalState === "rejected" ||
      gate.approvalState === "stale");
  if (filePending || aggregateBlocksCommit) {
    const reason = filePending
      ? "pending_proxy_draft"
      : `approval_state_${gate?.approvalState ?? "unknown"}`;
    const pendingError = filePending
      ? `pending_proxy_draft：本章存在未确认的代理审批稿，FinalStateCommit 和正式章节保存被阻止（approvalId 见 chapter-approvals/${input.chapterId}.pending.json）`
      : `approval_state_block：RunAggregate.approvalState=${gate?.approvalState}，正式章节保存被阻止（不依赖 pending 文件是否存在）`;
    stageResults.atomicSave = {
      blocked: true,
      reason,
      chapterId: input.chapterId,
      filePending,
      approvalState: gate?.approvalState ?? null,
    };
    audit?.recordPersistenceEvent({
      eventType: "chapter_save_attempted",
      candidateId: selectedCandidateId,
      outputHash: finalTextHash,
      decisionReason: `${reason} gate`,
      payload: { commitIntentId, filePending, approvalState: gate?.approvalState ?? null },
    });
    audit?.recordPersistenceEvent({
      eventType: "chapter_save_failed",
      candidateId: selectedCandidateId,
      outputHash: finalTextHash,
      chapterSaveOk: false,
      stateCommitOk: false,
      decisionReason: pendingError,
      payload: { reason, commitIntentId },
    });
    audit?.recordPersistenceEvent({
      eventType: "final_submission",
      candidateId: selectedCandidateId,
      outputHash: finalTextHash,
      chapterSaveOk: false,
      stateCommitOk: false,
      decisionReason: `blocked: ${reason}`,
      payload: { commitIntentId },
    });
    return { ok: false, error: pendingError, stateCommit: null, commitIntentId };
  }

  // ── 0c. stale 环境守护（CONCURRENCY-WAVE4）───────────────────────
  // 生成开始捕获的基线（stageResults.generationBaseline）与提交时现状比对：
  // active production release 切换 → stale_release；CreativeConstitution 修改 →
  // constitution_changed；pointer 损坏 → release_pointer_corrupt。均 fail-closed 阻断。
  // 基线缺失（编排器未捕获，如旧调用方/单测直调）→ 跳过检测（不阻断既有路径）；
  // 捕获时已损坏的场景由 generationBaselineCaptureError 标记，此处显式阻断。
  const generationBaseline = (stageResults as { generationBaseline?: unknown }).generationBaseline;
  const baselineCaptureError = (stageResults as { generationBaselineCaptureError?: unknown })
    .generationBaselineCaptureError;
  if (baselineCaptureError) {
    const corruptBlock = `release_pointer_corrupt：生成开始时无法读取 active-production pointer（${String((baselineCaptureError as { reason?: unknown }).reason ?? "unknown")}）；正式提交 fail-closed 阻断`;
    stageResults.atomicSave = {
      blocked: true,
      reason: "release_pointer_corrupt",
      chapterId: input.chapterId,
    };
    audit?.recordPersistenceEvent({
      eventType: "chapter_save_attempted",
      candidateId: selectedCandidateId,
      outputHash: finalTextHash,
      decisionReason: "release_pointer_corrupt gate",
      payload: { commitIntentId, reason: "release_pointer_corrupt" },
    });
    audit?.recordPersistenceEvent({
      eventType: "chapter_save_failed",
      candidateId: selectedCandidateId,
      outputHash: finalTextHash,
      chapterSaveOk: false,
      stateCommitOk: false,
      decisionReason: corruptBlock,
      payload: { reason: "release_pointer_corrupt", commitIntentId },
    });
    audit?.recordPersistenceEvent({
      eventType: "final_submission",
      candidateId: selectedCandidateId,
      outputHash: finalTextHash,
      chapterSaveOk: false,
      stateCommitOk: false,
      decisionReason: "blocked: release pointer corrupt",
      payload: { commitIntentId },
    });
    return { ok: false, error: corruptBlock, stateCommit: null, commitIntentId };
  }
  if (generationBaseline && typeof generationBaseline === "object") {
    // CONCURRENCY-WAVE4：检测维度 = activeReleaseId + constitutionHash + narrativeStateRevision
    // （baseline 捕获时携带 workspaceId 才有第三项；旧格式 baseline 自动跳过）
    const stale = checkCommitStale(
      generationBaseline as GenerationBaseline,
      projectRoot,
      workspaceId,
    );
    if (!stale.ok) {
      stageResults.atomicSave = {
        blocked: true,
        reason: stale.code,
        chapterId: input.chapterId,
        baseline: stale.baseline,
        current: stale.current,
      };
      stageResults.commitStaleGuard = {
        ok: false,
        code: stale.code,
        baseline: stale.baseline,
        current: stale.current,
      };
      audit?.recordPersistenceEvent({
        eventType: "chapter_save_attempted",
        candidateId: selectedCandidateId,
        outputHash: finalTextHash,
        decisionReason: `${stale.code} gate`,
        payload: {
          commitIntentId,
          reason: stale.code,
          baselineReleaseId: stale.baseline.activeReleaseId,
          currentReleaseId: stale.current ? stale.current.activeReleaseId : null,
        },
      });
      audit?.recordPersistenceEvent({
        eventType: "chapter_save_failed",
        candidateId: selectedCandidateId,
        outputHash: finalTextHash,
        chapterSaveOk: false,
        stateCommitOk: false,
        decisionReason: stale.reason,
        payload: { reason: stale.code, commitIntentId },
      });
      audit?.recordPersistenceEvent({
        eventType: "final_submission",
        candidateId: selectedCandidateId,
        outputHash: finalTextHash,
        chapterSaveOk: false,
        stateCommitOk: false,
        decisionReason: `blocked: ${stale.code}`,
        payload: { commitIntentId },
      });
      return { ok: false, error: stale.reason, stateCommit: null, commitIntentId };
    }
    stageResults.commitStaleGuard = { ok: true, baseline: stale.baseline, current: stale.current };
  }

  // ── 1. 原子保存正文（主产物，失败 = hard block） ──────────────────
  const filePath = chapterFilePath(input);
  let previousChapterText: string | null = null;
  const chapterExisted = existsSync(filePath);
  // RUN-LIFECYCLE-P3/P5：提交意图事件（幂等键 commitIntentId，绑定 artifactHash）
  audit?.recordLifecycleEvent?.({
    eventType: "commit_started",
    decisionReason: "commitAndSave begin",
    candidateId: selectedCandidateId,
    revision: artifactRevision,
    outputHash: finalTextHash,
    payload: {
      commitIntentId,
      artifactHash: finalTextHash,
      artifactRevision,
      // 无先验 artifact 绑定时允许建立绑定（避免误伤无审批直提路径）
      allowRevisionBump: true,
      filePath,
      chapterExisted,
    },
  });
  // commit_started 折叠后若判定重复完成（竞态），再次检查
  const gateAfterStart = audit?.getLifecycleGate?.() ?? null;
  if (
    gateAfterStart?.commitIntent &&
    gateAfterStart.commitIntent.commitIntentId === commitIntentId &&
    gateAfterStart.commitIntent.status === "completed"
  ) {
    stageResults.atomicSave = {
      idempotent: true,
      commitIntentId,
      contentHash: finalTextHash,
      reason: "duplicate_commit_intent_after_start",
    };
    return {
      ok: true,
      stateCommit: { committed: 0, rejected: 0, error: null },
      idempotent: true,
      commitIntentId,
    };
  }
  if (gateAfterStart?.foldError) {
    const foldBlock = `audit_fold_error after commit_started：${gateAfterStart.foldError}`;
    stageResults.atomicSave = {
      blocked: true,
      reason: "audit_fold_error",
      foldError: gateAfterStart.foldError,
    };
    audit?.recordLifecycleEvent?.({
      eventType: "commit_failed",
      decisionReason: foldBlock,
      outputHash: finalTextHash,
      payload: { commitIntentId },
    });
    return { ok: false, error: foldBlock, stateCommit: null, commitIntentId };
  }
  audit?.recordPersistenceEvent({
    eventType: "chapter_save_attempted",
    candidateId: selectedCandidateId,
    outputHash: finalTextHash,
    payload: { filePath, chapterExisted, commitIntentId },
  });
  try {
    if (chapterExisted) {
      previousChapterText = readFileSync(filePath, "utf-8");
    }
    // SIGKILL-FAULT-INJECTION：正文保存前（chapter_save_attempted 已记、原子写前）
    injectSigkillFault("before_chapter_save");
    atomicSave(filePath, finalText);
    stageResults.atomicSave = { filePath, bytes: finalText.length, contentHash: finalTextHash };
    audit?.recordPersistenceEvent({
      eventType: "chapter_saved",
      candidateId: selectedCandidateId,
      outputHash: finalTextHash,
      chapterSaveOk: true,
      payload: { filePath, bytes: finalText.length },
    });
    // SIGKILL-FAULT-INJECTION：正文保存后（chapter_saved 已记、状态提交前）
    injectSigkillFault("after_chapter_save");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    stageResults.atomicSave = { error: msg, filePath };
    audit?.recordPersistenceEvent({
      eventType: "chapter_save_failed",
      candidateId: selectedCandidateId,
      outputHash: finalTextHash,
      chapterSaveOk: false,
      stateCommitOk: false,
      decisionReason: msg,
      payload: { filePath },
    });
    audit?.recordPersistenceEvent({
      eventType: "final_submission",
      candidateId: selectedCandidateId,
      outputHash: finalTextHash,
      chapterSaveOk: false,
      stateCommitOk: false,
      decisionReason: `chapter save failed: ${msg}`,
    });
    // 正文保存失败 -> 状态不提交（无污染），调用方 hard block
    return { ok: false, error: msg, stateCommit: null };
  }

  // ── 2. 状态提交（正文已保存，状态失败 = hard block + 正文回滚） ───
  // A2（计划 §4.2）：状态只根据最终正文提交。stagedStateUpdate 是从 ChapterSeed
  // 派生的"seed 意图"（sourceRef=seed:*），此处用 finalText 重锚定：
  //   - promise 描述关键词在 finalText 命中 -> sourceRef 指向真实 span，confidence 提升
  //   - 未命中 -> 降级为 open，不声称 advancing
  //   - 提交器用 finalText 校验 span 越界，越界 entry 被拒绝
  const rollbackChapter = (stateError: string): {
    ok: false;
    error: string;
    stateCommit: { committed: number; rejected: number; error: string };
  } => {
    let rolledBack = false;
    let rollbackMessage: string | null = null;
    try {
      if (chapterExisted && previousChapterText !== null) {
        atomicSave(filePath, previousChapterText);
      } else if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
      rolledBack = true;
      stageResults.atomicSave = {
        ...(stageResults.atomicSave as Record<string, unknown>),
        rolledBack: true,
        rollbackAction: chapterExisted ? "restored_previous" : "removed_new",
      };
    } catch (rollbackError: unknown) {
      rollbackMessage = rollbackError instanceof Error
        ? rollbackError.message
        : String(rollbackError);
      stageResults.atomicSave = {
        ...(stageResults.atomicSave as Record<string, unknown>),
        rolledBack: false,
        rollbackError: rollbackMessage,
      };
      stateCommitOutcome = "failed";
      audit?.recordPersistenceEvent({
        eventType: "state_commit_failed",
        candidateId: selectedCandidateId,
        outputHash: finalTextHash,
        chapterSaveOk: true,
        stateCommitOk: false,
        decisionReason: stateError,
        payload: {
          rolledBack: false,
          rollbackError: rollbackMessage,
          stateCommitOutcome: "failed",
        },
      });
      audit?.recordPersistenceEvent({
        eventType: "final_submission",
        candidateId: selectedCandidateId,
        outputHash: finalTextHash,
        // 正文曾保存成功但已尝试回滚失败：不得报“整体成功”
        chapterSaveOk: true,
        stateCommitOk: false,
        decisionReason: `state commit failed: ${stateError}; chapter rollback failed: ${rollbackMessage}`,
        payload: {
          rolledBack: false,
          rollbackError: rollbackMessage,
          stateCommitOutcome: "failed",
        },
      });
      return {
        ok: false,
        error: `state commit failed: ${stateError}; chapter rollback failed: ${rollbackMessage}`,
        stateCommit: { committed: 0, rejected: 0, error: stateError },
      };
    }
    stateCommitOutcome = "failed";
    audit?.recordPersistenceEvent({
      eventType: "state_commit_failed",
      candidateId: selectedCandidateId,
      outputHash: finalTextHash,
      chapterSaveOk: true,
      stateCommitOk: false,
      decisionReason: stateError,
      payload: {
        rolledBack,
        rollbackAction: chapterExisted ? "restored_previous" : "removed_new",
        stateCommitOutcome: "failed",
      },
    });
    audit?.recordPersistenceEvent({
      eventType: "final_submission",
      candidateId: selectedCandidateId,
      outputHash: finalTextHash,
      // 状态失败后正文已回滚：最终既未交付正文提交，也未提交状态
      chapterSaveOk: false,
      stateCommitOk: false,
      decisionReason: `state commit failed: ${stateError}`,
      payload: { rolledBack: true, stateCommitOutcome: "failed" },
    });
    return {
      ok: false,
      error: `state commit failed: ${stateError}`,
      stateCommit: { committed: 0, rejected: 0, error: stateError },
    };
  };

  try {
    injectCommitFault("after_chapter_save");
    injectCommitFault("state_commit");
  } catch (faultErr: unknown) {
    const faultMsg = faultErr instanceof Error ? faultErr.message : String(faultErr);
    return rollbackChapter(faultMsg);
  }

  let committed = 0;
  let rejected = 0;
  // reanchored 提升到外层作用域，供 STATE-BRIDGE-1 + CLOSURE-TRACKER-1 使用。
  // reanchor 把 seed:* sourceRef 重锚定为 finalText span，ClosureTracker 接入
  // 依据 reanchored sourceRef 判断 promise/expectation 是否在正文中实际兑现。
  let reanchoredForBridge: StagedStateUpdate | null = null;
  if (input.stagedStateUpdate) {
    // ── 2.5 P1 回滚支持：备份章节前叙事状态 ─────────────────────
    // 在状态提交前备份 narrative-state-store.json，供 rollbackCommittedChapter 恢复。
    // 备份到 chapter-approvals/{chapterId}.pre-commit-state-{timestamp}.json
    // （与 draft-checkpoint / finalization 共用 chapter-approvals/ 隔离目录）。
    //
    // P1#2（计划 §12.2 验收 3）：备份失败时阻断状态提交。
    // 若备份失败仍提交状态，rollbackCommittedChapter 会删除正文却无法恢复叙事状态
    // （无 pre-commit 备份），破坏"正文与状态一起回退"保证。
    // 因此：prior state store 存在但备份失败 -> 跳过状态提交（committed=0），
    //       state store 保持章节前状态，并回滚刚保存的正文。
    // 无 prior state store（skipped）不视为备份失败（无内容需备份/恢复）。
    let backupOk = true;
    let backupErrorMsg: string | null = null;
    try {
      const statePath = join(workspacePath, "narrative-state-store.json");
      if (existsSync(statePath)) {
        const backupDir = join(workspacePath, "chapter-approvals");
        if (!existsSync(backupDir)) {
          mkdirSync(backupDir, { recursive: true });
        }
        const timestamp = Date.now();
        const stateBackupPath = join(
          backupDir,
          `${input.chapterId}.pre-commit-state-${timestamp}.json`
        );
        const stateContent = readFileSync(statePath, "utf-8");
        atomicSave(stateBackupPath, stateContent);
        stageResults.stateBackup = {
          backupPath: stateBackupPath,
          chapterId: input.chapterId,
        };
      } else {
        stageResults.stateBackup = { skipped: "no_prior_state_store", chapterId: input.chapterId };
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      stageResults.stateBackup = { error: msg, chapterId: input.chapterId };
      // P1#2：备份失败（且 prior state 存在）-> 阻断状态提交
      backupOk = false;
      backupErrorMsg = msg;
    }

    if (!backupOk) {
      // 备份失败：跳过状态提交，state store 保持章节前状态，并回滚正文。
      stageResults.stateCommit = {
        blocked: "backup_failed",
        committed: 0,
        rejected: 0,
        error: backupErrorMsg ?? "pre-commit state backup failed",
        chapterId: input.chapterId,
      };
      audit?.recordPersistenceEvent({
        eventType: "state_commit_attempted",
        candidateId: selectedCandidateId,
        outputHash: finalTextHash,
        decisionReason: "pre-commit state backup",
        payload: { blocked: "backup_failed" },
      });
      return rollbackChapter(backupErrorMsg ?? "pre-commit state backup failed");
    } else {
      audit?.recordPersistenceEvent({
        eventType: "state_commit_attempted",
        candidateId: selectedCandidateId,
        outputHash: finalTextHash,
        payload: { hasStagedStateUpdate: true },
      });
      try {
        const reanchored = reanchorStagedStateToFinalText(
          input.stagedStateUpdate,
          finalText,
          input.chapterNumber,
          // P0 第六轮结构化绑定：传入本章角色名（含别名），启用境界主体归属的
          // 结构化判断（句中含其他角色但不含目标角色 → fail-closed），取代动词正则补丁。
          input.characterNames,
          // P0 第七轮 P1 修复：传入别名→规范名映射，启用境界主体绑定的 alias 规范化
          // （"小尘" → "叶尘"），与 Story Preservation Gate 共用同一映射来源。
          input.aliasToCanonical
        );
        // B2：PatternMemory - 从最终正文扫描语言风险，追加 pattern entries。
        // pattern 是正文派生状态（非 seed 派生），在 reanchor 后追加到 additions。
        const patternEntries = extractPatternEntriesFromText(
          finalText,
          input.characterNames,
          input.chapterNumber
        );
        if (patternEntries.length > 0) {
          reanchored.additions.push(...patternEntries);
        }
        // 保存 reanchored 给 STATE-BRIDGE-1 + CLOSURE-TRACKER-1 使用
        reanchoredForBridge = reanchored;
        const stateCommit = createFinalStateCommit();
        // CONCURRENCY-WAVE4：staged 绑定候选生成时的基础状态 revision（来自生成期
        // 捕获的 generationBaseline），FinalStateCommit.commit 落盘前与磁盘当前
        // revision 做 CAS 比对（第二道防线，覆盖 0c 门禁与 commit 之间的窗口）。
        const stagedBaseRevision = (generationBaseline as GenerationBaseline | undefined)
          ?.narrativeStateRevision;
        if (typeof stagedBaseRevision === "string") {
          reanchored.baseStateRevision = stagedBaseRevision;
        }
        stateCommit.stage(reanchored);
        const store = loadStateStore(workspaceId, projectRoot);
        // Phase 3D：传入原始 stagedStateUpdate 作为 plannedUpdate，
        // 让 FinalStateCommit 把 seed 派生的计划状态写入 store.planned 字段
        // （非权威，供下一章 Preflight 连续性参考）。
        // SIGKILL-FAULT-INJECTION：状态提交前（backup + state_commit_attempted 已记、commit 前）
        injectSigkillFault("before_state_commit");
        const result = stateCommit.commit(
          store,
          selectedCandidateId,
          finalText,
          workspaceId,
          projectRoot,
          input.stagedStateUpdate
        );
        committed = result.committed;
        rejected = result.rejected.length;
        stageResults.stateCommit = {
          committed,
          rejected,
          finalTextHash: result.finalTextHash,
          patternEntriesAdded: patternEntries.length,
          plannedPersisted: result.plannedPersisted,
          // MEMORY-TRANSACTION-1：MemoryCommitReceipt 写入 stageResults.stateCommit，
          // 供统一编排器 → 质量 trace 审计（真实内存返回值不再是唯一产物）。
          receipt: result.receipt ?? null,
        };
        stateCommitOutcome = "committed";
        audit?.recordPersistenceEvent({
          eventType: "state_committed",
          candidateId: selectedCandidateId,
          outputHash: result.finalTextHash ?? finalTextHash,
          chapterSaveOk: true,
          stateCommitOk: true,
          payload: {
            committed,
            rejected,
            patternEntriesAdded: patternEntries.length,
            plannedPersisted: result.plannedPersisted,
            stateCommitOutcome: "committed",
          },
        });
        // SIGKILL-FAULT-INJECTION：状态提交后（state_committed 已记、final_submission 前）
        injectSigkillFault("after_state_commit");
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        // MEMORY-TRANSACTION-1：硬冲突阻断 → 回滚正文并阻断交付，不静默覆盖。
        if (e instanceof MemoryHardConflictError) {
          stageResults.stateCommit = {
            blocked: "memory_hard_conflict",
            gate: e.envelope.gate,
            severity: e.envelope.severity,
            committed: 0,
            rejected: 0,
            error: e.envelope.reason,
            evidence: e.envelope.evidence,
            userActionRequired: e.envelope.userActionRequired,
          };
          return rollbackChapter(e.envelope.reason);
        }
        // CONCURRENCY-WAVE4：状态 revision CAS 失败 -> 回滚正文并阻断交付。
        if (e instanceof StaleStateRevisionError) {
          stageResults.stateCommit = {
            blocked: "stale_state_revision",
            baseStateRevision: e.baseStateRevision,
            currentStateRevision: e.currentStateRevision,
            committed: 0,
            rejected: 0,
            error: e.message,
          };
          return rollbackChapter(e.message);
        }
        // 其他状态提交失败：记录 error，回滚正文并阻断交付。
        stageResults.stateCommit = { error: msg, committed: 0, rejected: 0 };
        return rollbackChapter(msg);
      }
    }
  } else {
    stageResults.stateCommit = { skipped: "无 stagedStateUpdate" };
    stateCommitOutcome = "skipped";
    // 无 stagedStateUpdate：明确标记 status=skipped，避免与真实 state_committed 混淆
    audit?.recordPersistenceEvent({
      eventType: "state_commit_attempted",
      candidateId: selectedCandidateId,
      outputHash: finalTextHash,
      decisionReason: "no stagedStateUpdate (noop)",
      statusOverride: "skipped",
      chapterSaveOk: true,
      // stateCommitOk=true 仅表示“无失败”，真实结果看 stateCommitOutcome=skipped
      stateCommitOk: true,
      payload: {
        skipped: true,
        noop: true,
        stateCommitOutcome: "skipped",
      },
    });
  }

  // ── 3. STATE-BRIDGE-1 + CLOSURE-TRACKER-1：状态桥接 + ClosureTracker 接入 ──
  // P0-1 事务边界修复（STATE-BRIDGE-TXN-FIX）：
  // 桥接/closure/progression 是**可重建的 advisory cache**，不是权威状态。
  // 权威状态是 narrative-state-store.json（已在第 2 步由 FinalStateCommit 原子落盘）。
  // 桥接/closure/progression 写入 series/*-derived.json，与 FinalStateCommit 事务**独立**。
  //
  // 失败处理（advisory cache 失败不阻断主链路）：
  // - 桥接/closure/progression 失败 → warning + 写入 trace，返回 ok=true
  // - 这是**有意的设计**：state-store 已落盘，advisory cache 可从 state-store 重建
  // - 不会导致正文/state-store 不一致（state-store 已先落盘）
  // - 不会导致 arc-registry-derived.json 损坏（bridge 内部有 backup→write→rollback）
  //
  // 与 STEP-3 测试守护的关系：
  // - arc-registry.json（权威）只能由 final-state-commit.js 写入
  // - 桥接/closure 写入 arc-registry-derived.json（派生缓存），不违反 STEP-3 守护
  if (reanchoredForBridge) {
    try {
      const store = loadStateStore(input.workspaceId, input.projectRoot);
      const bridgeResult = bridgeStateToSeriesFiles(
        workspacePath,
        store,
        reanchoredForBridge,
        input.chapterNumber,
      );
      stageResults.stateBridge = {
        ok: bridgeResult.ok,
        error: bridgeResult.error,
        writtenPaths: bridgeResult.writtenPaths,
        // P0-1: 明确标记为 advisory cache，失败不阻断主链路
        advisoryCache: true,
        rebuildableFrom: "narrative-state-store.json",
      };

      // 桥接成功后接入 ClosureTracker（基于 reanchored stagedStateUpdate）。
      // reanchored 的 promise/expectation sourceRef 已重锚定为 finalText span
      // （非 seed:*），ClosureTracker 据此判断是否实际兑现并触发 arc/foreshadow 状态推进。
      const closureResult = integrateClosureTracker(
        workspacePath,
        reanchoredForBridge,
        input.chapterNumber,
      );
      stageResults.closureIntegration = {
        ok: closureResult.ok,
        error: closureResult.error,
        arcRegistryPath: closureResult.arcRegistryPath,
        arcUpdates: closureResult.arcUpdates,
        recalledForeshadowIds: closureResult.recalledForeshadowIds,
        skippedReason: closureResult.skippedReason,
        // completenessReport 是 advisory，写入 trace 供诊断层读取
        completenessReport: closureResult.completenessReport,
        // P0-1: 明确标记为 advisory cache
        advisoryCache: true,
        rebuildableFrom: "narrative-state-store.json",
      };

      // ── PROGRESSION-CONTRACT-1：持久化 ChapterProgressionContract ──
      // 从 stageResults.chapterQualityEvidence.structuralEvidence 派生实际推进轴，
      // 与 ChapterIntent.expectedAxes 对比生成复核信号，持久化到
      // series/chapter-progression-contracts.json 供下游诊断层读取跨章 delta。
      // P0-1: 失败不阻断主链路（advisory cache，可从 state-store + structuralEvidence 重建）。
      try {
        const qualityEvidence = stageResults.chapterQualityEvidence as
          | ChapterQualityEvidence
          | undefined;
        const structuralEvidence: StructuralEvidence[] =
          qualityEvidence?.structuralEvidence ?? [];
        // input.intent 是 ChapterIntentBuilder 输出（chapter-intent-builder.ChapterIntent），
        // 已含 chapterFunction / readerExperience / causalEndPressure 等字段。
        const intent = input.intent;
        const finalTextHash = computeFinalTextHash(finalText);

        const contractResult = persistChapterProgressionContract(
          workspacePath,
          input.workspaceId,
          input.chapterNumber,
          input.chapterId,
          intent,
          structuralEvidence,
          reanchoredForBridge,
          finalTextHash,
        );
        stageResults.progressionContract = {
          ok: contractResult.ok,
          error: contractResult.error,
          chapterNumber: input.chapterNumber,
          expectedAxes: contractResult.contract?.expectedAxes,
          actualAxes: contractResult.contract?.actualAxes,
          reviewSignals: contractResult.contract?.reviewSignals ?? [],
          // P0-1: 明确标记为 advisory cache
          advisoryCache: true,
          rebuildableFrom: "narrative-state-store.json + structuralEvidence",
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        stageResults.progressionContract = {
          ok: false,
          error: msg,
          advisoryCache: true,
          rebuildableFrom: "narrative-state-store.json + structuralEvidence",
        };
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // P0-1: 桥接失败不阻断主链路（state-store 已落盘，advisory cache 可重建）
      // 但必须在 trace 中留下明确证据，不能 silent degrade
      stageResults.stateBridge = {
        ok: false,
        error: msg,
        advisoryCache: true,
        rebuildableFrom: "narrative-state-store.json",
        warning: "bridge failed; advisory cache not written; rebuildable from state-store",
      };
    }
  }

  // ── 4. P1-F：写入章节连续性快照（advisory cache） ────────────────
  // 下一章 ChapterSeedBuilder.loadPreviousChapterTextContinuation 会读取该快照，
  // 把上一章实际产生的新事件/未结钩子/新登场角色结构化传入下一章模型上下文。
  // 失败不阻断主链路（advisory cache，可从 narrative-state-store.json 重建）。
  try {
    writeChapterContinuitySnapshot(
      workspacePath,
      input.chapterNumber,
      finalText,
      reanchoredForBridge,
      computeFinalTextHash(finalText),
    );
    stageResults.continuitySnapshot = {
      ok: true,
      advisoryCache: true,
      rebuildableFrom: "narrative-state-store.json",
      chapterNumber: input.chapterNumber,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    stageResults.continuitySnapshot = {
      ok: false,
      error: msg,
      advisoryCache: true,
      rebuildableFrom: "narrative-state-store.json",
      chapterNumber: input.chapterNumber,
    };
  }

  // 成功路径不会吞掉 stateCommit 异常；异常已在上方回滚并以 ok=false 返回。
  audit?.recordPersistenceEvent({
    eventType: "final_submission",
    candidateId: selectedCandidateId,
    outputHash: finalTextHash,
    chapterSaveOk: true,
    // skipped 时 stateCommitOk=true 表示无失败；统计请用 stateCommitOutcome
    stateCommitOk: true,
    decisionReason:
      stateCommitOutcome === "skipped"
        ? "chapter saved; state commit skipped (no stagedStateUpdate)"
        : "chapter saved and state committed",
    payload: {
      committed,
      rejected,
      filePath,
      stateCommitOutcome,
      commitIntentId,
    },
  });
  // 磁盘账本 + 独立 receipt：写入失败不得返回整体成功
  try {
    markCommitIntentCompleted(
      workspacePath,
      input.chapterId,
      commitIntentId,
      finalTextHash,
    );
    const nsPath = join(workspacePath, "narrative-state-store.json");
    let narrativeStateRevision = `ch${input.chapterNumber}`;
    if (existsSync(nsPath)) {
      try {
        const ns = JSON.parse(readFileSync(nsPath, "utf-8")) as { lastCommittedChapter?: string };
        if (ns.lastCommittedChapter) narrativeStateRevision = ns.lastCommittedChapter;
      } catch { /* 用章节号兜底 */ }
    }
    const receiptId =
      (stageResults.stateCommit as { receipt?: { receiptId?: string } } | undefined)?.receipt?.receiptId ??
      `receipt-${input.chapterId}-${finalTextHash}`;
    const receiptDir = join(workspacePath, "chapter-approvals");
    if (!existsSync(receiptDir)) mkdirSync(receiptDir, { recursive: true });
    const receiptPath = join(receiptDir, `${input.chapterId}.commit-receipt.json`);
    const receiptTmp = `${receiptPath}.tmp`;
    writeFileSync(receiptTmp, JSON.stringify({
      receiptId,
      commitIntentId,
      artifactHash: finalTextHash,
      chapterFileHash: finalTextHash,
      narrativeStateRevision,
      recordedAt: new Date().toISOString(),
    }, null, 2), "utf-8");
    renameSync(receiptTmp, receiptPath);
    stageResults.commitIntentLedger = { ok: true, commitIntentId };
    stageResults.commitReceipt = { ok: true, receiptId };
  } catch (ledgerErr: unknown) {
    const msg = ledgerErr instanceof Error ? ledgerErr.message : String(ledgerErr);
    stageResults.commitIntentLedger = { ok: false, error: msg, commitIntentId };
    return {
      ok: false,
      error: `commit_intent_ledger_failed：正文/状态可能已落盘，但 commit intent 或独立 receipt 未能写入（${msg}）`,
      stateCommit: { committed, rejected, error: msg },
      commitIntentId,
    };
  }
  stageResults.commitIntentId = commitIntentId;
  return {
    ok: true,
    stateCommit: { committed, rejected, error: null },
    commitIntentId,
  };
}

/**
 * 原子保存：写临时文件 -> rename。失败不覆盖原文件。
 */
export function atomicSave(filePath: string, text: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, text, "utf-8");
  renameSync(tmpPath, filePath);
}

/**
 * B2：从最终正文扫描语言风险，生成 PatternMemory entries。
 *
 * 使用 LanguageRiskLibrary（本地扫描，无 LLM 调用）检测正文中的语言风险模式，
 * 按 riskId 分组计数，每个唯一 riskId 生成一条 PatternEntry。
 *
 * patternType 映射：所有语言风险类别（ai_pattern / perception_erosion /
 * agency_dilution / naturalness）统一归为 "sentence_risk"，
 * 因为 PatternMemory 的 sentence_risk 类型正是追踪可重复的语言模式。
 *
 * sourceRef/sourceRefs 保留 scanner 返回的首个/全部正文 span。
 * 扫描失败返回空数组（pattern 是增强，不阻断状态提交）。
 */
export function extractPatternEntriesFromText(
  finalText: string,
  characterNames: string[],
  chapterNumber: number
): PatternEntry[] {
  try {
    const lib = createLanguageRiskLibrary();
    const report = lib.scan(finalText, characterNames);
    const sourceChapter = `ch${chapterNumber}`;
    const hash = computeFinalTextHash(finalText);
    const now = new Date().toISOString();

    // 按 riskId 分组，并保留 scanner 返回的全部有效 span。
    const grouped = new Map<string, { description: string; spans: Array<{ start: number; end: number }> }>();
    for (const entry of report.entries) {
      if (entry.span.start < 0 || entry.span.end <= entry.span.start || entry.span.end > finalText.length) {
        continue;
      }
      const existing = grouped.get(entry.riskId);
      if (existing) {
        existing.spans.push({ start: entry.span.start, end: entry.span.end });
      } else {
        grouped.set(entry.riskId, {
          description: entry.description,
          spans: [{ start: entry.span.start, end: entry.span.end }],
        });
      }
    }

    const entries: PatternEntry[] = [];
    for (const [riskId, { description, spans }] of grouped) {
      const sourceRefs = spans.map(
        (span) => `ch${chapterNumber}#finalText:${hash}:${span.start}-${span.end}`
      );
      entries.push({
        kind: "pattern",
        id: `pattern:${riskId}:ch${chapterNumber}`,
        sourceChapter,
        sourceRef: sourceRefs[0],
        sourceRefs,
        confidence: 0.8, // 正文扫描确认，置信度较高
        lastUpdated: now,
        patternType: "sentence_risk",
        description,
        occurrenceCount: spans.length,
      });
    }
    return entries;
  } catch {
    // 扫描失败不阻断状态提交（pattern 是增强）
    return [];
  }
}

export function chapterFilePath(input: UnifiedOrchestratorInput): string {
  return join(input.projectRoot, "workspaces", input.workspaceId, "chapters", `${input.chapterId}.md`);
}
