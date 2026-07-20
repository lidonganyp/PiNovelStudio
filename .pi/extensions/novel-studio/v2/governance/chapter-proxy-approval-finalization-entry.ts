/**
 * ChapterProxyApprovalFinalizationEntry - 用户定稿真实调用链入口（G7-Finalization-Entry，计划 §12.2）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 / §12.2 / §12 line 585
 *
 * 本模块是 finalization 函数与统一编排器之间的真实接线层，补齐 prod-binding 缺失的
 * "实际调用"环节：
 * - accept_with_edits 接入统一编排器的 checkCandidateFactGuard（真实 FinalFactRecheck），
 *   不再依赖调用方手动注入 rerunFactGuard
 * - canCommit=true 后实际调用 commitAndSave（正文原子保存 + 状态派生 + FinalStateCommit）
 * - 每次定稿操作追加用户反馈到 feedback.jsonl（代理判断偏差 + editedTextDiff + rollback 结果）
 *
 * 调用链（计划 §12.2）：
 *   accept         -> acceptProxyDraft -> commitAndSave(draftText)
 *   accept_with_edits -> acceptProxyDraftWithEdits(checkCandidateFactGuard) -> commitAndSave(editedText)
 *   reject         -> rejectAndRegenerate（不 commitAndSave）
 *   rollback       -> rollbackCommittedChapter（不 commitAndSave）
 *   每次操作 -> recordProxyApprovalFeedback
 *
 * 事务顺序约束：
 * - accept/accept_with_edits 必须先 clear pending（acceptProxyDraft/acceptProxyDraftWithEdits 内部完成），
 *   后调用 commitAndSave（commitAndSave 内部 hasPendingProxyDraft 守护：pending 未清除时拒绝执行）。
 * - accept_with_edits 的 FactGuard 在 clear pending 之前运行（approvalId 校验 -> FactGuard -> clear -> commit）。
 *
 * 边界（READY_LOCAL）：
 * - 不调用模型（checkCandidateFactGuard 是本地 FactContinuityGuard，无 LLM 调用）
 * - stagedStateUpdate 优先使用调用方显式重派生结果，否则从 pending checkpoint 恢复
 * - 不推进 frontier（由 commitAndSave 内部 FinalStateCommit 负责）
 * - 闭包自包含（仅依赖 governance sibling + core/orchestrator sibling），可安全进入生产闭包
 */

import { join } from "node:path";
import { acceptProxyDraft, acceptProxyDraftWithEdits, rejectAndRegenerate, rollbackCommittedChapter, inspectAlternatives, type FinalizationResult, type FactGuardRerunFn } from "./chapter-proxy-approval-finalization.js";
import { loadProxyApprovedDraft, restorePendingSentinel } from "./chapter-proxy-approval-draft-checkpoint.js";
import { recordProxyApprovalFeedback, computeEditedTextDiff, type ProxyApprovalFeedbackRecord, type FeedbackAction } from "./chapter-proxy-approval-feedback-recorder.js";
import type { ChapterProxyApprovalArtifact } from "./chapter-proxy-approval-types.js";
import { createChapterProxyApprovalRegistry } from "./chapter-proxy-approval-registry.js";
import { checkCandidateFactGuard } from "../core/orchestrator-factguard.js";
import { commitAndSave } from "../core/orchestrator-commit-save.js";
import type { UnifiedOrchestratorInput } from "../core/orchestrator-types.js";
import type { StagedStateUpdate } from "../core/final-state-commit.js";
import {
  computeChapterCostSnapshotFromTrace,
  writeChapterCostSnapshot,
} from "./release-health-aggregator.js";

// ============================================================================
// 类型
// ============================================================================

/** 定稿动作（inspect 只读，不 commitAndSave / 不 feedback / 不 clear pending；rollback 是回滚已提交章节） */
export type FinalizationEntryAction = "accept" | "accept_with_edits" | "reject" | "rollback" | "inspect";

/** 定稿入口选项 */
export interface FinalizationEntryOptions {
  workspacePath: string;
  chapterId: string;
  approvalId: string;
  action: FinalizationEntryAction;
  /** accept_with_edits 时用户修改后的正文（其他 action 忽略） */
  editedText?: string;
  /** 统一编排器输入（供 checkCandidateFactGuard + commitAndSave 使用） */
  orchestratorInput: UnifiedOrchestratorInput;
  /**
   * 代理推荐的候选来源（raw/editorial/system_selected），用于反馈偏差追踪。
   * 未提供时从 pending draft 的 selectedSource 读取。
   */
  proxyRecommendedSource?: string;
  /**
   * inspect 动作所需的审批 artifact（仅 action="inspect" 时必填）。
   * 调用方从 registry 加载 ChapterProxyApprovalArtifact 后传入，
   * inspectAlternatives 从中提取候选摘要（candidateIds / winningSpans / risks 等）。
   */
  approvalArtifact?: ChapterProxyApprovalArtifact;
  /**
   * 可选 commitAndSave 注入（依赖注入，主要供测试 mock 失败场景使用）。
   * 未提供时使用真实 commitAndSave（orchestrator-commit-save.ts）。
   *
   * 验收 2：commitAndSave 失败时不得丢失 pending checkpoint——
   * 测试通过注入失败的 commitAndSaveFn 模拟 atomicSave/状态提交异常，
   * 验证 runFinalization 会调用 restorePendingSentinel 恢复 pending。
   */
  commitAndSaveFn?: typeof commitAndSave;
}

/** 定稿入口结果 */
export interface FinalizationEntryResult {
  /** 定稿操作结果 */
  finalization: FinalizationResult;
  /** commitAndSave 结果（仅 accept/accept_with_edits 且 canCommit=true 时存在） */
  commit?: {
    ok: boolean;
    error?: string;
    /**
     * 状态提交结果。
     * - committed/rejected：FinalStateCommit 提交/拒绝计数
     * - error：状态提交失败原因（正文已保存但状态未完整提交）；P1-2 修复：error 非空时不记录 accept 成功反馈
     */
    stateCommit: { committed: number; rejected: number; error?: string | null } | null;
  };
  /** 反馈记录结果（pending draft 存在时记录） */
  feedbackRecorded?: {
    feedbackFilePath: string;
  };
  /**
   * commitAndSave 失败后是否已恢复 pending sentinel（验收 2）。
   * - true：commitAndSave 失败，已通过 restorePendingSentinel 恢复 pending，用户可重试定稿
   * - false：commitAndSave 失败但恢复失败（draft 元数据丢失 / approvalId 不匹配）
   * - undefined：未触发恢复（commitAndSave 成功 / 未调用 commitAndSave）
   */
  pendingRestored?: boolean;
}

// ============================================================================
// 真实 FactGuard 适配器
// ============================================================================

/**
 * 将 checkCandidateFactGuard 适配为 FactGuardRerunFn（供 acceptProxyDraftWithEdits 使用）。
 *
 * 这是 prod-binding 缺失的关键接线：accept_with_edits 不再依赖调用方手动注入
 * rerunFactGuard，而是直接使用统一编排器的 checkCandidateFactGuard（真实 FinalFactRecheck）。
 */
function createRealFactGuardRerunFn(input: UnifiedOrchestratorInput): FactGuardRerunFn {
  return (text: string) => {
    const result = checkCandidateFactGuard(text, input);
    return { ok: result.ok, errors: result.errors };
  };
}

// ============================================================================
// 反馈记录
// ============================================================================

/**
 * 构建并追加用户反馈记录到 feedback.jsonl。
 *
 * 记录内容（计划 §12.2）：
 * - timestamp / approvalId / chapterId / workspaceId / action
 * - factGuardPassed + editedTextDiff（仅 accept_with_edits）
 * - proxyJudgmentBias（代理推荐 vs 用户决策是否一致）
 * - rollbackResult（仅 rollback）
 */
function recordFinalizationFeedback(
  options: FinalizationEntryOptions,
  finalization: FinalizationResult,
  pendingDraftFinalText: string | undefined,
  pendingDraftSelectedSource: string | undefined,
): { feedbackFilePath: string } | undefined {
  const { workspacePath, chapterId, approvalId, action, editedText, orchestratorInput, proxyRecommendedSource } = options;

  if (pendingDraftFinalText === undefined) {
    return undefined;
  }

  const proxySource = proxyRecommendedSource ?? pendingDraftSelectedSource ?? "unknown";
  const userAcceptedSource =
    action === "accept"
      ? proxySource
      : action === "accept_with_edits"
        ? "user_edited"
        : "rejected";

  const feedback: ProxyApprovalFeedbackRecord = {
    timestamp: new Date().toISOString(),
    approvalId,
    chapterId,
    workspaceId: orchestratorInput.workspaceId,
    action: action as FeedbackAction,
    proxyJudgmentBias: {
      proxyRecommendedSource: proxySource,
      userAcceptedSource,
      aligned: action === "accept",
    },
  };

  if (action === "accept_with_edits" && editedText !== undefined) {
    feedback.factGuardPassed = finalization.factGuardPassed;
    feedback.editedTextDiff = computeEditedTextDiff(pendingDraftFinalText, editedText);
  }

  if (action === "rollback" && finalization.rollbackResult) {
    feedback.rollbackResult = {
      rolledBack: finalization.rollbackResult.rolledBack,
      backupPath: finalization.rollbackResult.backupPath,
      narrativeStateRestoreRequired: finalization.rollbackResult.narrativeStateRestoreRequired,
    };
  }

  return recordProxyApprovalFeedback({ workspacePath, feedback });
}

// ============================================================================
// runFinalization - 定稿真实调用链入口
// ============================================================================

/**
 * 执行用户定稿操作，接入真实 FinalFactRecheck + 状态派生 + 最终提交 + 反馈归集。
 *
 * 调用链（计划 §12.2）：
 * - accept: acceptProxyDraft -> commitAndSave(draftText) -> feedback
 * - accept_with_edits: acceptProxyDraftWithEdits(checkCandidateFactGuard) -> commitAndSave(editedText) -> feedback
 * - reject: rejectAndRegenerate -> feedback（不 commitAndSave）
 * - rollback: rollbackCommittedChapter -> feedback（不 commitAndSave）
 * - inspect: inspectAlternatives（只读，不 commitAndSave / 不 feedback / 不 clear pending）
 *
 * 状态恢复（计划 §12.2）：优先使用调用方针对最终稿显式重派生的 stagedStateUpdate；
 * 未提供时恢复候选选定时写入 pending checkpoint 的完整 Canon/Character/Promise 暂存状态，
 * 由 commitAndSave 按最终正文重新锚定并追加 PatternMemory。旧 checkpoint 无状态字段时
 * 兼容注入空 update，仅保留 PatternMemory 派生能力。
 *
 * 事务顺序：accept/accept_with_edits 先 clear pending（finalization 函数内部），
 * 后 commitAndSave（commitAndSave 内部 hasPendingProxyDraft 守护确认 pending 已清除）。
 */
export function runFinalization(options: FinalizationEntryOptions): FinalizationEntryResult {
  const { workspacePath, chapterId, approvalId, action, editedText, orchestratorInput } = options;

  // 加载 pending draft（供 commitAndSave 使用 draftText + 反馈 diff 计算）
  // inspect 是只读动作，不修改 pending，但加载 draft 无副作用（读 chapter-approvals/ 目录）。
  const pendingDraft = loadProxyApprovedDraft(workspacePath, approvalId);
  const pendingDraftFinalText = pendingDraft?.finalText;
  const pendingDraftSelectedSource = pendingDraft?.selectedSource;
  const pendingDraftCandidateId = pendingDraft?.candidateId;

  // 依赖注入：默认使用真实 commitAndSave；测试可注入 mock 模拟失败场景
  const commitFn = options.commitAndSaveFn ?? commitAndSave;

  // ── 从最终稿重建四类长期状态输入（计划 §12.2） ──
  // 显式重派生结果优先；否则恢复 pending checkpoint 中与候选绑定的暂存状态。
  // commitAndSave 会用用户最终稿重新锚定 Canon/Character/Promise，并扫描 PatternMemory。
  // 旧 checkpoint 没有 stagedStateUpdate 时保留空 update 兼容路径。
  const recoveredStateUpdate =
    orchestratorInput.stagedStateUpdate ?? pendingDraft?.stagedStateUpdate;
  const effectiveInput: UnifiedOrchestratorInput = {
    ...orchestratorInput,
    stagedStateUpdate:
      recoveredStateUpdate ??
      ({
        additions: [],
        invalidations: [],
        sourceChapter: `ch${orchestratorInput.chapterNumber}`,
      } satisfies StagedStateUpdate),
  };

  let finalization: FinalizationResult;
  let commit: FinalizationEntryResult["commit"];
  let pendingRestored: boolean | undefined;

  if (action === "accept") {
    // accept: 原样接受代理审批稿 -> clear pending -> commitAndSave(draftText)
    finalization = acceptProxyDraft({ workspacePath, chapterId, approvalId });

    if (finalization.canCommit && pendingDraftFinalText !== undefined) {
      const candidateId = pendingDraftCandidateId ?? "proxy-approved";
      commit = commitFn(effectiveInput, candidateId, pendingDraftFinalText, {});

      // 验收 2：commitAndSave 失败时恢复 pending sentinel，让用户可重试定稿
      // （finalization 已 clear pending，但 commitAndSave 失败意味着正文未保存/状态未提交，
      // 若不恢复 pending，用户将无法再次 accept/accept_with_edits。）
      if (!commit.ok) {
        const restoreResult = restorePendingSentinel(
          workspacePath,
          chapterId,
          approvalId,
          new Date().toISOString(),
        );
        pendingRestored = restoreResult.restored;
      }
    }
  } else if (action === "accept_with_edits") {
    if (editedText === undefined) {
      throw new Error("accept_with_edits 需要 editedText");
    }
    // accept_with_edits: 真实 FinalFactRecheck -> clear pending -> commitAndSave(editedText)
    finalization = acceptProxyDraftWithEdits({
      workspacePath,
      chapterId,
      approvalId,
      editedText,
      rerunFactGuard: createRealFactGuardRerunFn(orchestratorInput),
    });

    if (finalization.canCommit) {
      // 用户修改后的正文作为最终正文提交；candidateId 标记为 user-edited
      // effectiveInput 携带显式重派生或 checkpoint 恢复的 stagedStateUpdate。
      commit = commitFn(effectiveInput, "user-edited", editedText, {});

      // 验收 2：同 accept 路径，commitAndSave 失败时恢复 pending
      if (!commit.ok) {
        const restoreResult = restorePendingSentinel(
          workspacePath,
          chapterId,
          approvalId,
          new Date().toISOString(),
        );
        pendingRestored = restoreResult.restored;
      }
    }
  } else if (action === "reject") {
    // reject: clear pending（不 commitAndSave）
    finalization = rejectAndRegenerate({ workspacePath, chapterId, approvalId });
  } else if (action === "rollback") {
    // rollback: 回滚已提交章节 + 恢复叙事状态（不 commitAndSave）
    finalization = rollbackCommittedChapter({ workspacePath, chapterId });
  } else if (action === "inspect") {
    // 缺口一修复：inspect 入口统一（计划 §12.2 五种定稿操作）
    // inspect 是只读查看候选信息：不 commitAndSave / 不 clear pending / 不记录 feedback。
    // 调用方从 registry 加载 ChapterProxyApprovalArtifact 后通过 approvalArtifact 传入。
    if (!options.approvalArtifact) {
      throw new Error("inspect 动作需要 approvalArtifact（调用方从 registry 加载后传入）");
    }
    finalization = inspectAlternatives(options.approvalArtifact);
  } else {
    throw new Error(`不支持的定稿动作：${action satisfies never}`);
  }

  // 记录反馈（pending draft 存在时；inspect 只读，不记录反馈）
  // P1 失败反馈污染防护（计划 §12.2）：commitAndSave 失败时不记录 accept 成功反馈，
  // 避免后续 ingest 把"实际未交付"的 accept 当成 evidence 摄入策略信誉存储。
  // - accept/accept_with_edits：commit 必须存在且 ok=true 才记录反馈
  //   （canCommit=false/FactGuard 失败/commit 失败均不记录，避免污染策略信誉）
  //   P1-2 修复：commit.ok=true 但 stateCommit.error 非空时也不记录反馈
  //   （正文已保存但状态提交失败 → 章节未完整交付，不应摄入策略信誉）
  // - reject/rollback：不调用 commitAndSave，直接记录反馈
  // - inspect：只读，不记录反馈
  const shouldRecordFeedback =
    action === "reject" ||
    action === "rollback" ||
    ((action === "accept" || action === "accept_with_edits") &&
      commit?.ok === true &&
      !commit?.stateCommit?.error);
  const feedbackRecorded = shouldRecordFeedback
    ? recordFinalizationFeedback(
        options,
        finalization,
        pendingDraftFinalText,
        pendingDraftSelectedSource,
      )
    : undefined;

  // P1 修复（用户第三轮核验）：commit 成功后写入 chapter 成本快照
  // 避免历史成本跨 release 污染：同一 chapter 被新 release 重跑后 trace 被覆盖，
  // 旧 release 仍能从自己的快照读到 finalization 时的真实成本。
  // 仅在 commit.ok=true 且 stateCommit 无错时写入（章节未完整交付时不写快照）。
  // 快照写入失败不阻断 finalization（聚合时回退读 trace）。
  if (
    (action === "accept" || action === "accept_with_edits") &&
    commit?.ok === true &&
    !commit?.stateCommit?.error
  ) {
    writeCostSnapshotAfterCommit(options);
  }

  return { finalization, commit, feedbackRecorded, pendingRestored };
}

/**
 * 写入 chapter 成本快照 helper（P1 修复）。
 *
 * 流程：
 * 1. 从 registry 加载 approval artifact 获取 releaseId（artifact 含 releaseId 字段）
 * 2. 从 trace 文件计算 hash + costStats
 * 3. 调用 writeChapterCostSnapshot 落盘
 *
 * 任何步骤失败都不抛错（snapshot 写入失败时 aggregateReleaseCostStats 会回退读 trace，
 * 丧失 per-release 隔离能力但不破坏 finalization 主流程）。
 */
function writeCostSnapshotAfterCommit(options: FinalizationEntryOptions): void {
  try {
    const { workspacePath, chapterId, approvalId } = options;

    // 1. 从 registry 加载 approval artifact 获取 releaseId
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(workspacePath, "chapter-approvals"),
    });
    const artifact = registry.loadArtifact(approvalId);
    if (!artifact) return;
    const releaseId = artifact.releaseId;

    // 2. 从 trace 文件计算 hash + costStats
    const snapshotData = computeChapterCostSnapshotFromTrace(workspacePath, chapterId);
    if (!snapshotData) return;

    // 3. 写入快照
    writeChapterCostSnapshot(workspacePath, {
      approvalId,
      chapterId,
      releaseId,
      traceHash: snapshotData.traceHash,
      costStats: snapshotData.costStats,
    });
  } catch {
    // 快照写入失败不阻断 finalization
  }
}
