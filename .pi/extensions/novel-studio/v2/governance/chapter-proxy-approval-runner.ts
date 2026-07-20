/**
 * ChapterProxyApprovalRunner — 章节代理审批端到端 runner（EVOLUTION-RELEASE-GOVERNANCE-G7）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 / §7 / Phase G7
 *
 * 接 G7 caller + executor，提供端到端 runner：
 * - runStubChapterProxyReview：stub caller 端到端（READY_LOCAL，零网络调用）
 *   流程：构造 stub caller → executeChapterProxyApproval → 返回 finalStatus / artifact /
 *        canDeliverProxyDraft / blockReason
 * - runRealChapterProxyReview：真实 gpt5.6-sol caller（REQUIRES_AUTH，需独立授权卡）
 *   流程（切片3 实现）：加载授权卡 → assertCardAuthorizes(releaseId) → 创建 caller
 *   （callerOverride 优先；否则从 NOVELOS_JUDGE_* env 加载配置 + 内置 fetch 适配器）
 *   → executeChapterProxyApproval → 返回结果
 *
 * 设计原则：
 * - runner 不重新发明 executor 的审批逻辑，只做"创建 caller + 调用 executor"
 * - stub caller 永远 identity="stub"，零网络调用；真实 gpt5.6-sol 调用需独立授权卡
 * - forward≠reverse / slight/uncertain 等治理规则全部由 executor + caller 守护，runner 不重复实现
 * - 章节级 runner 不加载 release manifest（章节级 artifact 不与 manifest 双向绑定）
 *
 * 与 1C ProxyReviewRunner 的隔离：
 * - 不复用 release 级 runner；
 * - 章节级 runner 不需要 evolutionRegistry（不加载 manifest，不计算 releaseManifestHash）；
 * - 章节级 runner 直接接收 packetInput（含 releaseId/workspaceId/chapterId）；
 * - 章节级 runner 返回 ChapterProxyReviewResult（含 canDeliverProxyDraft，不含 canPromote）。
 *
 * 边界（READY_LOCAL；真实模型调用 REQUIRES_AUTH）：
 * - runStubChapterProxyReview 不调用模型、不联网
 * - runRealChapterProxyReview 无授权卡 / 文件不存在 / schema 非法 / 过期 / 不覆盖 releaseId /
 *   预算不足 → throw REQUIRES_AUTH 或授权卡校验失败
 * - 无 callerOverride 且无 NOVELOS_JUDGE_* env → throw API 配置缺失错误
 * - 不切换 active pointer，不接 novel_generate_chapter
 * - 不写正式 chapters/ 目录，不提交长期状态，不推进 frontier
 */

import { existsSync } from "node:fs";

import type { ChapterProxyApprovalRegistry } from "./chapter-proxy-approval-registry.js";
import type { StagedStateUpdate } from "../core/final-state-commit.js";
import type {
  ChapterApprovalPacketInput,
} from "./chapter-proxy-approval-packet-builder.js";
import type {
  RawChapterVerdict,
  RecommendedSource,
  ChapterProxyApprovalStatus,
  ChapterProxyApprovalArtifact,
} from "./chapter-proxy-approval-types.js";
import type {
  ChapterProxyApprovalCaller,
} from "./chapter-proxy-approval-caller.js";
import {
  createStubChapterProxyApprovalCaller,
  createRealGpt56SolCallerFromEnv,
} from "./chapter-proxy-approval-caller.js";
import {
  loadAuthorizationCardFromFile,
  assertCardAuthorizes,
} from "./authorization-card.js";
import {
  executeChapterProxyApproval,
} from "./chapter-proxy-approval-executor.js";

// ============================================================================
// 类型
// ============================================================================

export interface ChapterProxyReviewRunnerOptions {
  /** 章节代理审批 artifact 注册表 */
  chapterRegistry: ChapterProxyApprovalRegistry;
  /**
   * P0-3 审批闭环接通（2026-07-17）：代理审批稿 pending checkpoint 落盘选项。
   *
   * 透传给 executeChapterProxyApproval.draftCheckpoint。
   * PROXY_APPROVED 路径在写完 artifact 后调用 saveProxyApprovedDraft 把 pending draft
   * 落盘到 workspaces/{id}/chapter-approvals/，使 proxy_finalization 有 pending 稿可消费。
   *
   * 不提供时：runner 行为零变化（executor 不调用 saveProxyApprovedDraft）。
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

/**
 * stub review 选项。packetInput 含 releaseId/workspaceId/chapterId，
 * 由调用方提供（章节级 runner 不加载 release manifest）。
 */
export interface StubChapterReviewOptions {
  /** 审批包输入（含 releaseId/workspaceId/chapterId/candidates） */
  packetInput: ChapterApprovalPacketInput;
  /** 正向顺序原始 verdict（未归一化） */
  forwardVerdict: RawChapterVerdict;
  /** 反向顺序原始 verdict */
  reverseVerdict: RawChapterVerdict;
  /** stub 推荐的候选 ID（必须存在于 packetInput.candidates） */
  recommendedCandidateId: string;
  /** 推荐候选来源（raw/editorial/system_selected） */
  recommendedSource: RecommendedSource;
  /** HOLD_FOR_REGENERATION 原因；透传给 stub caller */
  holdReason?: string;
  /** reviewer 精确模型版本（如 "gpt5.6-sol-2026-07"）；不得为空 */
  modelVersion?: string;
  /** 审批 prompt hash */
  promptHash: string;
  /** 预算（forward+reverse=2 calls） */
  budget: { maxCalls: number; timeoutMs: number };
  /** 匿名映射种子（默认 Date.now()） */
  anonymousSeed?: number;
  /** 胜出 span 引用（可选） */
  winningSpans?: string[];
  /** 失分 span 引用 */
  losingSpans?: string[];
}

/** 真实 gpt5.6-sol review 选项（需独立授权卡）。 */
export interface RealChapterReviewOptions extends StubChapterReviewOptions {
  /** 授权卡 JSON 路径；未提供或文件不存在 → throw REQUIRES_AUTH */
  authorizationCardPath?: string;
  /**
   * 可注入的 caller（仅测试用 mock；生产留 undefined 走 env 加载配置）。
   * 若提供，runner 直接使用该 caller，不创建新 caller。
   * 若未提供，runner 从 NOVELOS_JUDGE_* env 加载配置并创建真实 caller。
   *
   * P0-1 修复（核验结论第二轮 2026-07-17）：
   * - apiKey/apiBaseUrl/modelId 已从此接口删除；生产网络配置只能从可信 env 读取
   * - runner 调用 createRealGpt56SolCallerFromEnv 工厂，内部调用 validateJudgeEndpoint
   *   校验 endpoint（拒绝非 HTTPS / 回环 / 私网），防止把 NOVELOS_JUDGE_API_KEY 作为
   *   Bearer 发往调用方指定地址
   * - callerOverride 仅在测试代码中直接注入（不出现在 MCP 公共 schema；公共入口已删除）
   */
  callerOverride?: ChapterProxyApprovalCaller;
}

/** 章节代理审批结果 */
export interface ChapterProxyReviewResult {
  /** 归一化最终状态 */
  finalStatus: ChapterProxyApprovalStatus;
  /** 完整审批 artifact（已写入 registry） */
  artifact: ChapterProxyApprovalArtifact;
  /** 是否产出可交付的代理审批稿（PROXY_APPROVED=true, HOLD_FOR_REGENERATION=false） */
  canDeliverProxyDraft: boolean;
  /** 阻断原因（HOLD_FOR_REGENERATION 时给出） */
  blockReason?: string;
  /**
   * P0-3：pending draft 落盘结果（透传自 executor）。
   * - true：PROXY_APPROVED + draftCheckpoint 提供时成功落盘
   * - false：落盘失败（draftError 给出原因）
   * - undefined：未提供 draftCheckpoint 或 finalStatus !== PROXY_APPROVED
   */
  draftSaved?: boolean;
  /** P0-3：pending draft 落盘失败原因（draftSaved=false 时存在） */
  draftError?: string;
}

// ============================================================================
// runStubChapterProxyReview
// ============================================================================

/**
 * stub 章节代理审批端到端 runner（READY_LOCAL，零网络调用）。
 *
 * 步骤：
 * 1. 创建 stub caller = createStubChapterProxyApprovalCaller({ ... })
 * 2. 调用 executeChapterProxyApproval({ packetInput, caller, registry, promptHash, modelVersion, budget, anonymousSeed })
 * 3. 返回 result
 *
 * forward≠reverse / slight/uncertain 等治理规则由 executor + caller 守护。
 * 代理不得直接提交长期状态或覆盖正式章节文件（本函数仅写 registry）。
 */
export async function runStubChapterProxyReview(
  options: ChapterProxyReviewRunnerOptions & StubChapterReviewOptions,
): Promise<ChapterProxyReviewResult> {
  const {
    chapterRegistry,
    packetInput,
    forwardVerdict,
    reverseVerdict,
    recommendedCandidateId,
    recommendedSource,
    holdReason,
    modelVersion,
    promptHash,
    budget,
    anonymousSeed,
    winningSpans,
    losingSpans,
    draftCheckpoint,
  } = options;

  // 1. 创建 stub caller
  const caller = createStubChapterProxyApprovalCaller({
    forwardVerdict,
    reverseVerdict,
    recommendedCandidateId,
    recommendedSource,
    holdReason,
    modelVersion,
    winningSpans,
    losingSpans,
  });

  // 2. 调用 executor 完成完整编排
  //    P0-3：draftCheckpoint 透传给 executor，PROXY_APPROVED 时落盘 pending draft
  const result = await executeChapterProxyApproval({
    packetInput,
    caller,
    registry: chapterRegistry,
    promptHash,
    modelVersion: modelVersion ?? "",
    budget,
    anonymousSeed,
    ...(draftCheckpoint ? { draftCheckpoint } : {}),
  });

  return result;
}

// ============================================================================
// runRealChapterProxyReview
// ============================================================================

/**
 * 真实 gpt5.6-sol 章节代理审批 runner（REQUIRES_AUTH，切片3 实现）。
 *
 * 流程：
 * 1. 授权卡前置检查：未提供或文件不存在 → throw REQUIRES_AUTH
 * 2. 加载授权卡 + schema 校验：loadAuthorizationCardFromFile（schema 非法 → throw 授权卡校验失败）
 * 3. assertCardAuthorizes(card, releaseId)：过期 / 不覆盖 releaseId / 预算不足 → throw REQUIRES_AUTH
 * 4. 创建 caller：
 *    - callerOverride 优先（测试用 mock caller）
 *    - 否则从 NOVELOS_JUDGE_* env 加载配置 + 内置 fetch 适配器创建真实 caller
 *    - 无 callerOverride 且 env 缺失 → throw API 配置缺失错误
 * 5. 调用 executeChapterProxyApproval 完成完整编排
 *
 * 边界：真实 gpt5.6-sol 调用需独立授权卡，不与生产主路由共享 API key。
 * callerOverride 注入时使用 mock callChatCompletions（不触发真实网络）；
 * 无 callerOverride 时使用内置 fetch 适配器（生产路径，需真实 env 配置）。
 */
export async function runRealChapterProxyReview(
  options: ChapterProxyReviewRunnerOptions & RealChapterReviewOptions,
): Promise<ChapterProxyReviewResult> {
  const {
    chapterRegistry,
    packetInput,
    promptHash,
    budget,
    anonymousSeed,
    authorizationCardPath,
    callerOverride,
    modelVersion,
    draftCheckpoint,
  } = options;

  // 1. 授权卡前置检查：未提供或文件不存在 → REQUIRES_AUTH
  if (!authorizationCardPath || authorizationCardPath.length === 0) {
    throw new Error(
      "REQUIRES_AUTH: 真实 gpt5.6-sol 章节代理审批需独立授权卡（authorizationCardPath 未提供）",
    );
  }
  if (!existsSync(authorizationCardPath)) {
    throw new Error(
      `REQUIRES_AUTH: 真实 gpt5.6-sol 章节代理审批需独立授权卡（文件不存在：${authorizationCardPath}）`,
    );
  }

  // 2. 加载授权卡 + schema 校验（schema 非法 → throw 授权卡校验失败）
  const card = loadAuthorizationCardFromFile(authorizationCardPath);

  // 3. assertCardAuthorizes：过期 / 不覆盖 releaseId / 预算不足 → REQUIRES_AUTH
  assertCardAuthorizes(card, packetInput.releaseId);

  // 4. 创建 caller：callerOverride 优先（仅测试用 mock）；否则从 env 加载配置
  //    P0-1 修复（核验结论第二轮 2026-07-17）：
  //    - apiKey/apiBaseUrl/modelId 不再从 options 读取；生产网络配置只能从可信 env 读取
  //    - createRealGpt56SolCallerFromEnv 内部调用 validateJudgeEndpoint 校验 endpoint
  //      （拒绝非 HTTPS / 回环 / 私网），确保 SSRF 攻击面为零
  let caller: ChapterProxyApprovalCaller;
  if (callerOverride) {
    caller = callerOverride;
  } else {
    caller = createRealGpt56SolCallerFromEnv();
  }

  // 5. 调用 executor 完成完整编排
  //    modelVersion 优先级：options.modelVersion > card.modelVersion > ""
  //    P0-3：draftCheckpoint 透传给 executor，PROXY_APPROVED 时落盘 pending draft
  const effectiveModelVersion = modelVersion ?? card.modelVersion ?? "";
  const result = await executeChapterProxyApproval({
    packetInput,
    caller,
    registry: chapterRegistry,
    promptHash,
    modelVersion: effectiveModelVersion,
    budget,
    anonymousSeed,
    ...(draftCheckpoint ? { draftCheckpoint } : {}),
  });

  return result;
}
