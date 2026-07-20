/**
 * orchestrator-proxy-approval - 统一主链路"代理审批"相位（P0-3 审批闭环接通，2026-07-17）
 *
 * 真相源：docs/top-tier-chinese-novel-system-development-plan.md §3 line 117-122
 * 计划 §6.3：FinalFactRecheck → ChapterProxyApproval(gpt5.6-sol) → saveProxyApprovedDraft
 * → UserRevisionOrAcceptance → FinalFactRecheck(user) → FinalStateCommit → AtomicChapterSave
 *
 * 在 commitAndSave 前执行代理审批（opt-in）：
 * - enableProxyApproval=false（默认）→ no-op，直接进入 commitAndSave（保持向后兼容）
 * - enableProxyApproval=true + evalMode 非 undefined → 跳过（eval 不走 commit）
 * - enableProxyApproval=true + selectedSource="raw" → 跳过（无 editorial 候选可比较）
 * - enableProxyApproval=true + selectedSource="editorial" → 构造 packetInput，调用 runner
 *
 * 代理审批结果处理（fail-closed，核验结论第二轮 2026-07-17）：
 * - PROXY_APPROVED + draftSaved=true → hasPendingProxyDraft=true → commitAndSave 被守护阻止
 *   编排器返回 status="ok" 但 chapterFilePath=null（pending 状态，等用户 finalization）
 * - PROXY_APPROVED + draftSaved=false → shouldHardBlock=true（落盘失败，用户没有 pending draft
 *   可 review，不能继续 commitAndSave 绕过用户确认）
 * - HOLD_FOR_REGENERATION → shouldHardBlock=true（代理审批要求重新生成，不能交付当前正文）
 *
 * 本模块为纯函数集合，不持有实例状态。runner/executor/governance 模块负责实际审批逻辑。
 */

import { join } from "path";

import type { UnifiedOrchestratorInput } from "./orchestrator-types.js";
import type { Candidate } from "./types.js";
import type { ChapterApprovalPacketInput } from "../governance/chapter-proxy-approval-packet-builder.js";
import type { RecommendedSource } from "../governance/chapter-proxy-approval-types.js";
import {
  runStubChapterProxyReview,
  runRealChapterProxyReview,
} from "../governance/chapter-proxy-approval-runner.js";
import {
  createChapterProxyApprovalRegistry,
} from "../governance/chapter-proxy-approval-registry.js";

// ============================================================================
// 类型
// ============================================================================

/** 代理审批阶段结果 */
export interface ProxyApprovalOutcome {
  /** 是否执行了代理审批（false = 跳过） */
  ran: boolean;
  /** 跳过原因（ran=false 时给出） */
  skipReason?: string;
  /** 审批最终状态（PROXY_APPROVED / HOLD_FOR_REGENERATION） */
  finalStatus?: string;
  /** pending draft 是否成功落盘 */
  draftSaved?: boolean;
  /** pending draft 落盘失败原因 */
  draftError?: string;
  /** HOLD_FOR_REGENERATION 阻断原因 */
  blockReason?: string;
  /** 审批 artifact ID */
  approvalId?: string;
  /**
   * 是否应跳过 commitAndSave（pending 路径）。
   * - true：PROXY_APPROVED + draftSaved=true，pending sentinel 已落盘，commitAndSave 会被守护阻止
   * - false：其他情况（未执行审批 / HOLD_FOR_REGENERATION / 落盘失败）
   *
   * shouldSkipCommit=true 时编排器返回 status="ok" + chapterFilePath=null（等用户 finalization）。
   */
  shouldSkipCommit: boolean;
  /**
   * 是否应 hard block（fail-closed，核验结论第二轮 2026-07-17）。
   *
   * 计划 §6.3 line 117-122 完成定义："用户确认前不写正式章节"。
   * - true：HOLD_FOR_REGENERATION（代理审批要求重新生成，不能交付当前正文）
   *        或 PROXY_APPROVED + draftSaved=false（落盘失败，用户没有 pending draft 可 review，
   *        继续 commitAndSave 会绕过用户确认）
   *   → 编排器必须 this.hardBlock()，不写正式章节
   * - false：其他情况（未执行审批 / PROXY_APPROVED + draftSaved=true）
   *
   * shouldHardBlock=true 与 shouldSkipCommit=true 互斥。
   */
  shouldHardBlock: boolean;
  /** shouldHardBlock=true 时的阻断原因（写入 FailureEnvelope.reason） */
  hardBlockReason?: string;
}

// ============================================================================
// runProxyApprovalStage
// ============================================================================

/**
 * 执行代理审批阶段（opt-in，在 commitAndSave 前调用）。
 *
 * 调用时机：unified-orchestrator stage 6.6 finalTextCompleteness 通过后、stage 7 commitAndSave 前。
 *
 * 行为：
 * - enableProxyApproval=false / evalMode / selectedSource="raw" → 跳过（no-op）
 * - enableProxyApproval=true + selectedSource="editorial" → 构造 packetInput，调用 runner
 *
 * stub 模式（无 authorizationCardPath + 无 callerOverride）：
 * - 使用 runStubChapterProxyReview，forward/reverse verdict 预配置为 PROXY_APPROVED
 * - stub 总是批准系统选定稿（development/test 模式，不调用真实模型）
 *
 * real 模式（有 authorizationCardPath 或 callerOverride）：
 * - 使用 runRealChapterProxyReview（需授权卡或 mock caller）
 *
 * @returns ProxyApprovalOutcome.shouldSkipCommit=true 时编排器应跳过 commitAndSave
 */
export async function runProxyApprovalStage(
  input: UnifiedOrchestratorInput,
  rawCandidate: Candidate,
  selectedCandidateId: string,
  selectedSource: "raw" | "editorial",
  finalText: string,
  stageResults: Record<string, unknown>,
): Promise<ProxyApprovalOutcome> {
  // ── 0. 前置检查：opt-in / evalMode / selectedSource ──
  if (!input.enableProxyApproval) {
    return { ran: false, skipReason: "enableProxyApproval=false（默认）", shouldSkipCommit: false, shouldHardBlock: false };
  }
  if (input.evalMode) {
    return { ran: false, skipReason: `evalMode=${input.evalMode}（eval 不走 commit）`, shouldSkipCommit: false, shouldHardBlock: false };
  }
  if (!input.proxyApprovalOptions) {
    return { ran: false, skipReason: "enableProxyApproval=true 但 proxyApprovalOptions 未提供", shouldSkipCommit: false, shouldHardBlock: false };
  }
  // selectedSource="raw" 时无 editorial 候选可比较，跳过代理审批
  // （raw 是基线，系统选定 raw 意味着无 editorial 胜出，代理审批无可比较对象）
  if (selectedSource === "raw") {
    return { ran: false, skipReason: "selectedSource=raw（无 editorial 候选可比较）", shouldSkipCommit: false, shouldHardBlock: false };
  }

  const proxyOpts = input.proxyApprovalOptions;
  const workspacePath = join(input.projectRoot, "workspaces", input.workspaceId);
  const approvalsDir = join(workspacePath, "chapter-approvals");

  // ── 1. 构造 packetInput（raw + selected editorial 作为双候选） ──
  const packetInput: ChapterApprovalPacketInput = {
    releaseId: proxyOpts.releaseId,
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    candidates: [
      {
        candidateId: rawCandidate.id,
        candidateKind: "raw",
        text: rawCandidate.text,
        spans: [],
      },
      {
        candidateId: selectedCandidateId,
        candidateKind: "editorial",
        text: finalText,
        spans: [],
      },
    ],
    factGuardReport: stageResults.factGuard ?? null,
    stateConsistency: null,
    costProfile: null,
    budgetMaxCalls: proxyOpts.budget.maxCalls,
    timeoutMs: proxyOpts.budget.timeoutMs,
    fixedCase: input.workspaceId,
    fixedModel: proxyOpts.modelVersion,
    fixedSeed: input.seed ?? 0,
  };

  // ── 2. 获取/创建 registry ──
  const registry = proxyOpts._registryOverride
    ?? createChapterProxyApprovalRegistry({ approvalsDir });

  // ── 3. 构造 runner 公共选项 ──
  const draftCheckpoint = {
    workspacePath,
    finalText,
    ...(input.stagedStateUpdate
      ? { stagedStateUpdate: input.stagedStateUpdate }
      : {}),
  };
  const runnerCommon = {
    chapterRegistry: registry,
    draftCheckpoint,
    packetInput,
    recommendedCandidateId: selectedCandidateId,
    recommendedSource: "editorial" as RecommendedSource,
    promptHash: proxyOpts.promptHash,
    modelVersion: proxyOpts.modelVersion,
    budget: proxyOpts.budget,
    anonymousSeed: proxyOpts.anonymousSeed,
  };

  // ── 4. 调用 runner（stub 或 real） ──
  // real 模式：有 authorizationCardPath 或 callerOverride → runRealChapterProxyReview
  // stub 模式：无 authorizationCardPath 且无 callerOverride → runStubChapterProxyReview
  //   stub 预配置 forward/reverse verdict = PROXY_APPROVED（development/test 模式）
  let result;
  if (proxyOpts.authorizationCardPath || proxyOpts.callerOverride) {
    result = await runRealChapterProxyReview({
      ...runnerCommon,
      forwardVerdict: "PROXY_APPROVED",
      reverseVerdict: "PROXY_APPROVED",
      ...(proxyOpts.authorizationCardPath
        ? { authorizationCardPath: proxyOpts.authorizationCardPath }
        : {}),
      ...(proxyOpts.callerOverride ? { callerOverride: proxyOpts.callerOverride } : {}),
    });
  } else {
    // stub 模式：总是批准系统选定稿（不调用真实模型）
    result = await runStubChapterProxyReview({
      ...runnerCommon,
      forwardVerdict: "PROXY_APPROVED",
      reverseVerdict: "PROXY_APPROVED",
    });
  }

  // ── 5. 判定 shouldSkipCommit / shouldHardBlock（fail-closed）──
  // 计划 §6.3 line 117-122 完成定义："用户确认前不写正式章节"。
  //
  // 三种 outcome：
  // 1. PROXY_APPROVED + draftSaved=true → pending sentinel 已落盘
  //    → shouldSkipCommit=true（commitAndSave 会被 hasPendingProxyDraft 守护阻止）
  //    → shouldHardBlock=false（pending 路径正常，编排器返回 ok + chapterFilePath=null）
  // 2. HOLD_FOR_REGENERATION → 代理审批要求重新生成
  //    → shouldHardBlock=true（不能交付当前正文，必须 hard block）
  //    → shouldSkipCommit=false
  // 3. PROXY_APPROVED + draftSaved=false → 落盘失败，用户没有 pending draft 可 review
  //    → shouldHardBlock=true（不能继续 commitAndSave 绕过用户确认）
  //    → shouldSkipCommit=false
  const shouldSkipCommit =
    result.finalStatus === "PROXY_APPROVED" && result.draftSaved === true;

  let shouldHardBlock = false;
  let hardBlockReason: string | undefined;
  if (result.finalStatus === "HOLD_FOR_REGENERATION") {
    shouldHardBlock = true;
    hardBlockReason = `proxy_approval_hold_for_regeneration: ${
      result.blockReason ?? "代理审批要求重新生成"
    }`;
  } else if (
    result.finalStatus === "PROXY_APPROVED" &&
    result.draftSaved === false
  ) {
    shouldHardBlock = true;
    hardBlockReason = `proxy_approval_draft_save_failed: ${
      result.draftError ?? "pending draft 落盘失败，用户没有 pending draft 可 review"
    }`;
  }

  // ── 6. 记录 stageResults ──
  stageResults.proxyApproval = {
    ran: true,
    finalStatus: result.finalStatus,
    canDeliverProxyDraft: result.canDeliverProxyDraft,
    draftSaved: result.draftSaved,
    draftError: result.draftError,
    blockReason: result.blockReason,
    approvalId: result.artifact.approvalId,
    shouldSkipCommit,
    shouldHardBlock,
    hardBlockReason,
  };

  return {
    ran: true,
    finalStatus: result.finalStatus,
    draftSaved: result.draftSaved,
    draftError: result.draftError,
    blockReason: result.blockReason,
    approvalId: result.artifact.approvalId,
    shouldSkipCommit,
    shouldHardBlock,
    hardBlockReason,
  };
}
