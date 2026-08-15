/**
 * ChapterProxyApprovalExecutor — 章节代理审批完整编排（EVOLUTION-RELEASE-GOVERNANCE-G7）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 / Phase G7
 *
 * 接 1B/1C 编排模式，提供章节级完整编排：
 * - executeChapterProxyApproval：build packet → caller.call → construct artifact → registry write
 *
 * 编排步骤：
 * 1. 构造匿名映射（forward/reverse 顺序，候选 ID ↔ A/B 标签）
 * 2. 构建匿名审批包（不暴露候选身份）
 * 3. 计算 packet hash（用于 artifact.inputArtifactHash 双向绑定）
 * 4. 调用 caller.call(packet, mapping, opts) 获取 verdict
 * 5. 反查 recommendedSource（校验 caller 返回的 recommendedCandidateId 存在于候选列表）
 * 6. 构造完整 artifact（含 releaseId/workspaceId/chapterId/approvalId/decidedAt）
 * 7. 写入 registry（append-only；schema 校验由 registry 内部执行）
 * 8. 返回 finalStatus / artifact / canDeliverProxyDraft / blockReason
 *
 * 设计原则（计划 §6.3 / §7）：
 * - 代理不得直接提交长期状态或覆盖正式章节文件（本模块仅写 registry，不写 chapters/）
 * - finalStatus=PROXY_APPROVED 时 canDeliverProxyDraft=true，可产出代理审批稿 checkpoint
 * - finalStatus=HOLD_FOR_REGENERATION 时 canDeliverProxyDraft=false，不输出代理审批稿
 * - approvalId 全局唯一，append-only registry 拒绝覆盖
 * - 匿名映射 seed 由调用方提供（便于复现），默认 Date.now()
 *
 * 与 1B executeProxyApproval 的隔离：
 * - 不复用 release 级 executor；
 * - 章节级不判定 release 晋级，不处理 R3 自审批 / reviewer shopping（这些是 release 级治理）；
 * - 章节级不计算 releaseManifestHash（章节级 artifact 不与 release manifest 双向绑定）；
 * - 章节级只关注"产出可交付用户的代理审批稿"。
 *
 * 边界（READY_LOCAL；真实模型调用 REQUIRES_AUTH）：
 * - 不调用模型（caller 负责；stub caller 零网络调用）
 * - 不写章节文件、不提交长期状态、不推进 frontier
 * - 仅写 chapter-proxy-approval registry（append-only）
 */

import { randomUUID } from "node:crypto";

import {
  buildAnonymousChapterApprovalPacket,
  buildAnonymousMapping,
  computeChapterPacketHash,
  resolveRecommendedSource,
} from "./chapter-proxy-approval-packet-builder.js";
import type {
  ChapterApprovalPacketInput,
} from "./chapter-proxy-approval-packet-builder.js";
import type { ChapterProxyApprovalCaller } from "./chapter-proxy-approval-caller.js";
import type { ChapterProxyApprovalRegistry } from "./chapter-proxy-approval-registry.js";
import type {
  ChapterProxyApprovalArtifact,
  ChapterProxyApprovalStatus,
  RecommendedSource,
} from "./chapter-proxy-approval-types.js";
// G7-Checkpoint：代理审批稿 pending checkpoint（P0-3 审批闭环接通，2026-07-17）
// PROXY_APPROVED 路径在调用方提供 draftCheckpoint 时落盘 pending draft，
// 使 proxy_finalization 有生产上游自动生成的 pending 稿可消费。
// 计划 §6.3 line 117-122：FinalFactRecheck → ChapterProxyApproval → saveProxyApprovedDraft
// → UserRevisionOrAcceptance → FinalFactRecheck(user) → FinalStateCommit → AtomicChapterSave
import { saveProxyApprovedDraft } from "./chapter-proxy-approval-draft-checkpoint.js";
import type { StagedStateUpdate } from "../core/final-state-commit.js";

// ============================================================================
// 类型
// ============================================================================

/** executeChapterProxyApproval 选项 */
export interface ExecuteChapterProxyApprovalOptions {
  /** 候选侧输入（含 releaseId/workspaceId/chapterId/candidates） */
  packetInput: ChapterApprovalPacketInput;
  /** 代理审批 caller（stub 或 real） */
  caller: ChapterProxyApprovalCaller;
  /** 章节代理审批 registry（append-only） */
  registry: ChapterProxyApprovalRegistry;
  /** 审批 prompt hash */
  promptHash: string;
  /** reviewer 精确模型版本（如 "gpt5.6-sol-2026-07"） */
  modelVersion: string;
  /** 预算（forward+reverse=2 calls） */
  budget: { maxCalls: number; timeoutMs: number };
  /** 匿名映射种子（默认 Date.now()） */
  anonymousSeed?: number;
  /**
   * P0-3 审批闭环接通（2026-07-17）：代理审批稿 pending checkpoint 落盘选项。
   *
   * 提供 draftCheckpoint 时，PROXY_APPROVED 路径在写完 artifact 后调用
   * saveProxyApprovedDraft 把 pending draft 落盘到
   * workspaces/{id}/chapter-approvals/{approvalId}.draft.md +
   * {chapterId}.pending.json sentinel。
   *
   * 落盘后 hasPendingProxyDraft 返回 true，commitAndSave 守护阻止正式章节提交，
   * 用户需通过 proxy_finalization accept 才能继续 commitAndSave。
   *
   * 不提供时（默认）：executor 行为零变化，只写 registry artifact，
   * 不调用 saveProxyApprovedDraft（保持向后兼容；现有测试不传此参数）。
   *
   * HOLD_FOR_REGENERATION 路径不调用 saveProxyApprovedDraft（无稿可交付）。
   */
  draftCheckpoint?: {
    /** workspace 根路径（workspaces/{workspaceId}） */
    workspacePath: string;
    /** 代理审批稿正文（来自编排器选定的 finalText） */
    finalText: string;
    /** 候选选定时的完整暂存状态 */
    stagedStateUpdate?: StagedStateUpdate;
  };
}

/** executeChapterProxyApproval 返回 */
export interface ExecuteChapterProxyApprovalResult {
  /** 归一化最终状态 */
  finalStatus: ChapterProxyApprovalStatus;
  /** 完整审批 artifact（已写入 registry） */
  artifact: ChapterProxyApprovalArtifact;
  /** 是否产出可交付的代理审批稿（PROXY_APPROVED=true, HOLD_FOR_REGENERATION=false） */
  canDeliverProxyDraft: boolean;
  /** 阻断原因（HOLD_FOR_REGENERATION 时给出） */
  blockReason?: string;
  /**
   * P0-3：pending draft 落盘结果。
   * - true：PROXY_APPROVED + draftCheckpoint 提供时成功落盘
   * - false：落盘失败（draftError 给出原因）；artifact 已写入 registry，但 pending sentinel 缺失
   * - undefined：未提供 draftCheckpoint 或 finalStatus !== PROXY_APPROVED（行为零变化）
   */
  draftSaved?: boolean;
  /** P0-3：pending draft 落盘失败原因（draftSaved=false 时存在） */
  draftError?: string;
}

// ============================================================================
// executeChapterProxyApproval
// ============================================================================

/**
 * 执行章节代理审批完整编排。
 *
 * 步骤见模块头注释。返回 finalStatus / artifact / canDeliverProxyDraft / blockReason。
 *
 * canDeliverProxyDraft 逻辑：
 * - finalStatus=PROXY_APPROVED → canDeliverProxyDraft=true，可产出代理审批稿 checkpoint
 * - finalStatus=HOLD_FOR_REGENERATION → canDeliverProxyDraft=false，要求重新生成
 *
 * 代理不得直接提交长期状态或覆盖正式章节文件。本函数仅写 registry（append-only artifact），
 * 代理审批稿 checkpoint 由后续切片（G7-Checkpoint）实现，落盘到 workspaces/{id}/chapter-approvals/，
 * 不写正式 chapters/ 目录。
 */
export async function executeChapterProxyApproval(
  options: ExecuteChapterProxyApprovalOptions,
): Promise<ExecuteChapterProxyApprovalResult> {
  const {
    packetInput,
    caller,
    registry,
    promptHash,
    modelVersion,
    budget,
    anonymousSeed,
  } = options;

  // 候选数量校验（G7-Runner 切片限定双候选）
  if (packetInput.candidates.length !== 2) {
    throw new Error(
      `executeChapterProxyApproval 要求恰好 2 个候选，实际 ${packetInput.candidates.length} 个（G7-Runner 切片限定双候选 A/B 复判）`,
    );
  }

  // 1. 构造匿名映射
  const seed = anonymousSeed ?? Date.now();
  const mapping = buildAnonymousMapping(packetInput.candidates, seed);

  // 2. 构建匿名审批包
  const packet = buildAnonymousChapterApprovalPacket(packetInput);

  // 3. 计算 packet hash（用于 artifact.inputArtifactHash 双向绑定）
  const inputArtifactHash = computeChapterPacketHash(packet);

  // 4. 调用 caller.call
  const callerResult = await caller.call(packet, mapping, {
    promptHash,
    modelVersion,
    budget,
  });

  // 5. 反查 recommendedSource（校验 caller 返回的 recommendedCandidateId 存在于候选列表）
  //    stub caller 在构造时配置 recommendedSource；real caller 需通过候选列表反查
  //    这里统一用 resolveRecommendedSource 校验，确保 recommendedCandidateId 合法
  const resolvedSource: RecommendedSource = resolveRecommendedSource(
    packetInput.candidates,
    callerResult.recommendedCandidateId,
  );
  // 如果 caller 返回的 recommendedSource 与反查结果不一致，使用反查结果（更权威）
  const recommendedSource: RecommendedSource =
    callerResult.recommendedSource === resolvedSource
      ? callerResult.recommendedSource
      : resolvedSource;

  // 6. 构造完整 artifact
  const approvalId = `cpa-${packetInput.releaseId}-${packetInput.chapterId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const artifact: ChapterProxyApprovalArtifact = {
    schemaId: "pinovel.chapter-proxy-approval" as const,
    schemaVersion: 1 as const,
    approvalId,
    releaseId: packetInput.releaseId,
    workspaceId: packetInput.workspaceId,
    chapterId: packetInput.chapterId,
    candidateIds: packetInput.candidates.map((c) => c.candidateId),
    anonymousMapping: mapping,
    forwardVerdict: callerResult.forwardVerdict,
    reverseVerdict: callerResult.reverseVerdict,
    finalStatus: callerResult.finalStatus,
    recommendedCandidateId: callerResult.recommendedCandidateId,
    recommendedSource,
    winningSpans: callerResult.winningSpans,
    losingSpans: callerResult.losingSpans,
    risks: callerResult.risks,
    rationale: callerResult.rationale,
    reviewerType: callerResult.reviewerType,
    reviewerModel: callerResult.reviewerModel,
    reviewerModelVersion: callerResult.reviewerModelVersion,
    promptHash: callerResult.promptHash,
    inputArtifactHash,
    decidedAt: new Date().toISOString(),
    budgetUsed: callerResult.budgetUsed,
  };

  // 7. 写入 registry（append-only；schema 校验由 registry 内部执行）
  registry.writeArtifact(artifact);

  // 8. 返回结果
  const canDeliverProxyDraft = artifact.finalStatus === "PROXY_APPROVED";
  const blockReason: string | undefined =
    artifact.finalStatus === "HOLD_FOR_REGENERATION"
      ? `finalStatus=HOLD_FOR_REGENERATION：${callerResult.rationale}`
      : undefined;

  // ── 7.5 P0-3 审批闭环接通（2026-07-17）：PROXY_APPROVED 时落盘 pending draft ──
  // 计划 §6.3 line 117-122：FinalFactRecheck → ChapterProxyApproval → saveProxyApprovedDraft
  // → UserRevisionOrAcceptance → FinalFactRecheck(user) → FinalStateCommit → AtomicChapterSave
  //
  // 仅当 finalStatus=PROXY_APPROVED 且调用方提供 draftCheckpoint 时调用 saveProxyApprovedDraft：
  // - 落盘到 workspaces/{id}/chapter-approvals/{approvalId}.draft.md +
  //   {chapterId}.pending.json sentinel
  // - hasPendingProxyDraft 返回 true → commitAndSave 守护阻止正式章节提交
  // - 用户需通过 proxy_finalization accept 才能继续 commitAndSave
  //
  // 不提供 draftCheckpoint 或 HOLD_FOR_REGENERATION 路径：跳过（draftSaved=undefined）
  //
  // 落盘失败不抛错（artifact 已写入 registry，不可回滚）：
  // - 返回 draftSaved=false + draftError，让调用方决定是否阻断
  // - 调用方（orchestrator-proxy-approval.ts runProxyApprovalStage）收到 draftSaved=false 时
  //   hard block（fail-closed，核验结论第二轮 2026-07-17）：
  //   用户没有 pending draft 可 review，继续 commitAndSave 会绕过用户确认，
  //   违反计划 §6.3 line 117-122 完成定义"用户确认前不写正式章节"。
  let draftSaved: boolean | undefined;
  let draftError: string | undefined;
  if (canDeliverProxyDraft && options.draftCheckpoint) {
    try {
      saveProxyApprovedDraft({
        workspacePath: options.draftCheckpoint.workspacePath,
        approvalId,
        chapterId: packetInput.chapterId,
        candidateId: callerResult.recommendedCandidateId,
        selectedSource: recommendedSource,
        finalText: options.draftCheckpoint.finalText,
        savedAt: artifact.decidedAt,
        revision: artifact.decidedAt,
        // artifactHash 由 saveProxyApprovedDraft 从 finalText 计算；
        // 与 RunAggregate / approval_requested 事件绑定同一 revision 语义
        ...(options.draftCheckpoint.stagedStateUpdate
          ? { stagedStateUpdate: options.draftCheckpoint.stagedStateUpdate }
          : {}),
      });
      draftSaved = true;
    } catch (e: unknown) {
      // 落盘失败：artifact 已写入 registry（不可回滚），pending sentinel 缺失
      // 返回 draftSaved=false + draftError，调用方可选择继续 commitAndSave 或 hard block
      draftSaved = false;
      draftError = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    finalStatus: artifact.finalStatus,
    artifact,
    canDeliverProxyDraft,
    blockReason,
    ...(draftSaved !== undefined ? { draftSaved } : {}),
    ...(draftError !== undefined ? { draftError } : {}),
  };
}
