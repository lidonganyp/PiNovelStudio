/**
 * ChapterProxyReviewHandler — G7 真实代理初审生产调用入口（计划 §6.3 / §7 / Phase G7）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 / §7 / §12.2
 *         docs/remaining-development-dispatch-plan-20260715.md §0.2
 *
 * 用户阻断项 P1 修复（2026-07-17）：
 * - runRealChapterProxyReview 已实现并通过 mock 测试，但 runner/caller 仅存在于 dist-test
 * - 生产 dist 中不存在 runner/caller，也没有生产调用入口
 *
 * 用户阻断项 P0 修复（核验结论第二轮 2026-07-17）：
 * - P0-1 凭据外泄/SSRF：apiKey/apiBaseUrl/modelId 不再从 input 接收；生产网络配置只能从
 *   可信 env 读取（runner 内部从 NOVELOS_JUDGE_* env 加载 + validateJudgeEndpoint 校验）
 * - P0-2 artifact 身份错绑：顶层 workspaceId/chapterId/releaseId 必须与 packetInput 对应
 *   字段完全一致；不一致 → fail-closed status=error，不调用 runner、不创建 registry
 *
 * 本 handler 由 tools/workspace-manager-handler.ts import 进入生产闭包（dist/），
 * 不直接注册公开工具（保持 6 工具契约，与 finalization handler 同模式）。调用链：
 * 1. P0-2 身份三元组校验（顶层 workspaceId/chapterId/releaseId 与 packetInput 完全一致）
 * 2. P0 安全解析 workspacePath（resolveWorkspacePath，防目录穿越）
 * 3. 创建 chapterRegistry（章节代理审批 artifact 注册表）
 * 4. 调用 runRealChapterProxyReview（REQUIRES_AUTH 边界由 runner 内部守护；
 *    apiKey/apiBaseUrl/modelId 不再透传，runner 从 env 读取 + validateJudgeEndpoint 校验）
 * 5. 捕获 REQUIRES_AUTH 错误 -> status=error + error 包含 REQUIRES_AUTH
 * 6. 成功 -> status=ok + review 结果（finalStatus / artifact / canDeliverProxyDraft）
 *
 * 闭包自包含（仅依赖 governance sibling + utils/config + utils/fs）：
 * - governance runner/caller 已通过 review-surface-cli.ts prod-binding 进入 dist/
 * - utils/fs 的 resolveWorkspacePath 是纯本地路径校验（无外部依赖）
 * - 不直接调用真实模型（callerOverride 注入时使用 mock；否则由 runner 从 NOVELOS_JUDGE_*
 *   env 加载配置 + 内置 fetch 适配器，需独立授权卡）
 *
 * 边界（READY_LOCAL；真实 gpt5.6-sol 调用 REQUIRES_AUTH）：
 * - 不生成章节正文（章节生成唯一入口仍是 novel_generate_chapter）
 * - 不写正式 chapters/ 目录、不提交长期状态、不推进 frontier
 * - 仅写 chapter-proxy-approval registry（隔离目录 chapter-approvals/）
 * - 真实 gpt5.6-sol 调用需独立授权卡（authorizationCardPath），不与生产主路由共享 API key
 * - callerOverride 仅在测试代码中直接注入（不出现在 MCP 公共 schema；公共入口已删除）
 */

import { join } from "node:path";

import { getProjectRoot } from "../utils/config.js";
import { resolveWorkspacePath } from "../utils/fs.js";
import {
  runRealChapterProxyReview,
  type ChapterProxyReviewRunnerOptions,
  type RealChapterReviewOptions,
  type ChapterProxyReviewResult,
} from "../v2/governance/chapter-proxy-approval-runner.js";
import {
  createChapterProxyApprovalRegistry,
  type ChapterProxyApprovalRegistry,
} from "../v2/governance/chapter-proxy-approval-registry.js";
import type { ChapterApprovalPacketInput } from "../v2/governance/chapter-proxy-approval-packet-builder.js";
import type {
  RawChapterVerdict,
  RecommendedSource,
} from "../v2/governance/chapter-proxy-approval-types.js";
import type { ChapterProxyApprovalCaller } from "../v2/governance/chapter-proxy-approval-caller.js";

// ============================================================================
// 类型
// ============================================================================

/** handler 输入 */
export interface HandleChapterProxyReviewInput {
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  /** release ID（授权卡覆盖范围校验用） */
  releaseId: string;
  /**
   * 授权卡 JSON 路径；未提供或文件不存在 -> status=error + REQUIRES_AUTH
   * 真实 gpt5.6-sol 调用需独立授权卡，不与生产主路由共享 API key
   */
  authorizationCardPath?: string;
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
  /** 审批 prompt hash */
  promptHash: string;
  /** 预算（forward+reverse=2 calls） */
  budget: { maxCalls: number; timeoutMs: number };
  /** reviewer 精确模型版本（如 "gpt5.6-sol-2026-07"） */
  modelVersion?: string;
  /** 匿名映射种子（默认 Date.now()） */
  anonymousSeed?: number;
  /** 胜出 span 引用（可选） */
  winningSpans?: string[];
  /** 失分 span 引用 */
  losingSpans?: string[];
  /**
   * 可注入的 caller（仅测试用 mock；生产留 undefined 走 env 加载配置）。
   * 若提供，runner 直接使用该 caller，不创建新 caller。
   * 若未提供，runner 从 NOVELOS_JUDGE_* env 加载配置并创建真实 caller。
   *
   * P0-1 修复（核验结论第二轮 2026-07-17）：
   * - apiKey/apiBaseUrl/modelId 已从此接口删除；生产网络配置只能从可信 env 读取
   * - callerOverride 仅在测试代码中直接注入（不出现在 MCP 公共 schema；公共入口已删除）
   */
  callerOverride?: ChapterProxyApprovalCaller;
  /** HOLD_FOR_REGENERATION 原因；透传给 caller */
  holdReason?: string;
  /** 测试/内部用：覆盖 project root 解析 */
  _projectRoot?: string;
  /**
   * 测试/内部用：注入 chapterRegistry mock（避免创建真实 registry）。
   * 生产留 undefined，handler 自动创建真实 registry。
   */
  _registryOverride?: ChapterProxyApprovalRegistry;
}

/** handler 输出 */
export interface HandleChapterProxyReviewResult {
  status: "ok" | "error";
  workspaceId: string;
  chapterId: string;
  releaseId: string;
  /** status=error 时的错误信息（含 REQUIRES_AUTH 标识） */
  error?: string;
  /** 审批结果（status=ok 时存在） */
  review?: ChapterProxyReviewResult;
}

// ============================================================================
// handleChapterProxyReview — 真实代理初审生产入口
// ============================================================================

/**
 * 执行真实 gpt5.6-sol 章节代理审批（用户阻断项 P1 修复）。
 *
 * 调用链：
 * 0. P0-2 身份三元组校验：顶层 workspaceId/chapterId/releaseId 必须与 packetInput 完全一致
 *    （fail-closed：不一致 → status=error，不调用 runner、不创建 registry）
 * 1. workspacePath 安全解析（P0 防目录穿越）
 * 2. 创建 chapterRegistry（或使用 _registryOverride 注入）
 * 3. 调用 runRealChapterProxyReview（REQUIRES_AUTH 边界由 runner 守护；
 *    P0-1 修复：apiKey/apiBaseUrl/modelId 不再透传，runner 从 env 读取 + validateJudgeEndpoint 校验）
 * 4. 捕获 REQUIRES_AUTH 错误 -> status=error + error 包含 REQUIRES_AUTH
 * 5. 成功 -> status=ok + review 结果
 *
 * 不生成章节正文、不写 chapters/、不提交长期状态、不推进 frontier。
 * 仅写 chapter-proxy-approval registry（隔离目录 chapter-approvals/）。
 */
export async function handleChapterProxyReview(
  input: HandleChapterProxyReviewInput,
): Promise<HandleChapterProxyReviewResult> {
  const projectRoot = input._projectRoot || getProjectRoot();

  const baseResult = {
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    releaseId: input.releaseId,
  };

  // ── 0. P0-2 artifact 身份三元组强制校验（fail-closed） ──────────────
  // 用户核验结论第二轮：顶层 workspaceId/chapterId/releaseId 必须与 packetInput 对应
  // 字段完全一致；不一致 → status=error，不调用 runner、不创建 registry。
  // 防止攻击者把另一 workspace/release/chapter 的 artifact 写入当前 workspace 注册表。
  // 必须在创建 chapterRegistry 之前执行（否则 packetInput 的身份可能污染 ws-target 路径）。
  if (
    input.workspaceId !== input.packetInput.workspaceId ||
    input.chapterId !== input.packetInput.chapterId ||
    input.releaseId !== input.packetInput.releaseId
  ) {
    return {
      ...baseResult,
      status: "error",
      error:
        `artifact 身份不一致：顶层 workspaceId=${input.workspaceId}/chapterId=${input.chapterId}/releaseId=${input.releaseId}` +
        ` 与 packetInput workspaceId=${input.packetInput.workspaceId}/chapterId=${input.packetInput.chapterId}/releaseId=${input.packetInput.releaseId}` +
        ` 必须完全一致（fail-closed：不得跨 workspace/release/chapter 写 artifact）`,
    };
  }

  // ── 1. workspaceId 安全解析（P0 路径越界防护） ──────────────────────
  let workspacePath: string;
  try {
    workspacePath = resolveWorkspacePath(
      join(projectRoot, "workspaces"),
      input.workspaceId,
    );
  } catch (e: unknown) {
    return {
      ...baseResult,
      status: "error",
      error: `workspaceId 安全校验失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // ── 2. 创建 chapterRegistry（或使用注入） ──────────────────────────
  // approvalsDir = {workspacePath}/chapter-approvals/（隔离目录，不污染 chapters/）
  const approvalsDir = join(workspacePath, "chapter-approvals");
  let chapterRegistry: ChapterProxyApprovalRegistry;
  try {
    chapterRegistry = input._registryOverride ?? createChapterProxyApprovalRegistry({ approvalsDir });
  } catch (e: unknown) {
    return {
      ...baseResult,
      status: "error",
      error: `chapterRegistry 创建失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // ── 3. 调用 runRealChapterProxyReview ──────────────────────────────
  // REQUIRES_AUTH 边界由 runner 内部守护：
  // - authorizationCardPath 未提供 / 文件不存在 -> throw REQUIRES_AUTH
  // - 授权卡过期 / 不覆盖 releaseId / 预算不足 -> throw REQUIRES_AUTH
  // - 无 callerOverride 且 NOVELOS_JUDGE_* env 缺失 -> throw API 配置缺失错误
  // - P0-1 修复：apiKey/apiBaseUrl/modelId 不再透传；runner 从 env 读取 + validateJudgeEndpoint 校验
  // handler 捕获后返回 status=error + error message（保留 REQUIRES_AUTH 标识便于调用方识别）
  const runnerOptions: ChapterProxyReviewRunnerOptions & RealChapterReviewOptions = {
    chapterRegistry,
    packetInput: input.packetInput,
    forwardVerdict: input.forwardVerdict,
    reverseVerdict: input.reverseVerdict,
    recommendedCandidateId: input.recommendedCandidateId,
    recommendedSource: input.recommendedSource,
    holdReason: input.holdReason,
    modelVersion: input.modelVersion,
    promptHash: input.promptHash,
    budget: input.budget,
    anonymousSeed: input.anonymousSeed,
    winningSpans: input.winningSpans,
    losingSpans: input.losingSpans,
    authorizationCardPath: input.authorizationCardPath,
    callerOverride: input.callerOverride,
  };

  try {
    const review = await runRealChapterProxyReview(runnerOptions);
    return {
      ...baseResult,
      status: "ok",
      review,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ...baseResult,
      status: "error",
      error: `chapter proxy review 执行失败：${msg}`,
    };
  }
}
