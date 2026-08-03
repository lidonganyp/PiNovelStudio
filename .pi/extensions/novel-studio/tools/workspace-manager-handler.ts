/**
 * workspace-manager-handler - novel_workspace_manager 工具处理器
 *
 * 从 tools/workflow-tool-handlers.ts 抽出（Phase 2b：解除 architect/critic 对生产闭包的拖累）。
 * workflow-tool-handlers.ts 顶部 import createArchitectAgent/createCriticAgent，
 * 被 public-handlers.ts 经 handleWorkspaceManager 拖入生产 dist/。本模块只含 handleWorkspaceManager，
 * 不依赖 agents/architect 或 agents/critic，使二者退出生产闭包。
 *
 * 方案 A（G7 Finalization，2026-07-17）：通过 novel_workspace_manager action="proxy_finalization"
 * 暴露章节代理审批定稿子操作（accept/accept_with_edits/reject/rollback/inspect）。
 * 委托 handlers/chapter-proxy-finalization-handler.ts:handleChapterProxyFinalization，
 * 不注册第 7 个公开工具，保持 production-tool-registration.test.mjs 的 6 工具契约。
 *
 * 方案 A 续（G7 Review，2026-07-17，P1 阻断项修复）：通过 novel_workspace_manager
 * action="proxy_review" 暴露真实代理初审入口（runRealChapterProxyReview）。
 * 委托 handlers/chapter-proxy-review-handler.ts:handleChapterProxyReview，
 * 保持 6 工具契约。REQUIRES_AUTH 边界由 runner 内部守护（无授权卡 -> status=error）。
 */

import { createWorkspaceManager } from "../workspace/manager.js";
import {
  handleChapterProxyFinalization,
  type HandleChapterProxyFinalizationInput,
} from "../handlers/chapter-proxy-finalization-handler.js";
import {
  handleChapterProxyReview,
  type HandleChapterProxyReviewInput,
} from "../handlers/chapter-proxy-review-handler.js";
import {
  handleChapterAdvisory,
  type ChapterAdvisoryInput,
  type ChapterAdvisoryResult,
} from "../handlers/chapter-advisory-handler.js";
import type { FinalizationEntryResult } from "../v2/governance/chapter-proxy-approval-finalization-entry.js";
import type { IngestProxyApprovalFeedbackResult } from "../v2/governance/chapter-proxy-approval-feedback-ingestor.js";
import type { ReleaseHealthReport } from "../v2/governance/release-health-aggregator.js";
import type { ChapterProxyReviewResult } from "../v2/governance/chapter-proxy-approval-runner.js";

/** proxy_finalization 支持的子操作 */
const PROXY_FINALIZATION_ACTIONS = new Set([
  "accept",
  "accept_with_edits",
  "reject",
  "rollback",
  "inspect",
]);

/** workspace_manager 输入（合并 proxy_finalization + proxy_review 子操作参数） */
export interface HandleWorkspaceManagerInput {
  action: string;
  workspaceId?: string;
  // init 子操作参数
  novelName?: string;
  genre?: string;
  subGenres?: string[];
  styleProfile?: string;
  targetWordCount?: {
    perChapter: { min: number; max: number };
    total: number;
  };
  // proxy_finalization 子操作参数
  proxyAction?: string;
  chapterId?: string;
  chapterNumber?: number;
  approvalId?: string;
  editedText?: string;
  confirm?: boolean;
  revision?: string;
  idempotencyKey?: string;
  strategyContext?: {
    strategyId: string;
    modelVersion: string;
    opportunityType: string;
  };
  // ── proxy_review 子操作参数（仅 action="proxy_review" 时使用） ──
  /** release ID（授权卡覆盖范围校验用） */
  releaseId?: string;
  /** 授权卡 JSON 路径；未提供或文件不存在 -> status=error + REQUIRES_AUTH */
  authorizationCardPath?: string;
  /** 审批包输入（含 releaseId/workspaceId/chapterId/candidates） */
  packetInput?: HandleChapterProxyReviewInput["packetInput"];
  /** 正向顺序原始 verdict（未归一化） */
  forwardVerdict?: HandleChapterProxyReviewInput["forwardVerdict"];
  /** 反向顺序原始 verdict */
  reverseVerdict?: HandleChapterProxyReviewInput["reverseVerdict"];
  /** stub 推荐的候选 ID */
  recommendedCandidateId?: string;
  /** 推荐候选来源（raw/editorial/system_selected） */
  recommendedSource?: HandleChapterProxyReviewInput["recommendedSource"];
  /** 审批 prompt hash */
  promptHash?: string;
  /** 预算（forward+reverse=2 calls） */
  budget?: HandleChapterProxyReviewInput["budget"];
  /** reviewer 精确模型版本 */
  modelVersion?: string;
  /** 匿名映射种子 */
  anonymousSeed?: number;
  /** 胜出 span 引用 */
  winningSpans?: string[];
  /** 失分 span 引用 */
  losingSpans?: string[];
  /**
   * 可注入的 caller（仅测试用 mock；生产留 undefined 走 env 加载配置）。
   *
   * P0-1 修复（核验结论第二轮 2026-07-17）：
   * - apiKey/apiBaseUrl/modelId 已从此接口删除；生产网络配置只能从可信 env 读取
   * - runner 从 NOVELOS_JUDGE_BASE_URL 读取 endpoint 后调用 validateJudgeEndpoint 校验
   * - callerOverride 仅在测试代码中直接注入（不出现在 MCP 公共 schema；公共入口已删除）
   */
  callerOverride?: HandleChapterProxyReviewInput["callerOverride"];
  /** HOLD_FOR_REGENERATION 原因 */
  holdReason?: string;
  // ── advisory 子操作参数（仅 action="diagnostic"/"ingest_reader_feedback"/"record_return_chapter" 时使用） ──
  /** ingest_reader_feedback 用：反馈类型（positive/negative/neutral） */
  feedbackType?: ChapterAdvisoryInput["feedbackType"];
  /** ingest_reader_feedback 用：反馈正文 */
  feedbackText?: string;
  /** ingest_reader_feedback / record_return_chapter 用：来源引用（必须可追溯） */
  sourceRef?: string;
  /** ingest_reader_feedback 用：聚焦维度（可选） */
  focusDimensions?: string[];
  /** record_return_chapter 用：回流章类型（rewrite/recap/reveal） */
  returnType?: ChapterAdvisoryInput["returnType"];
  /** record_return_chapter 用：源章节 ID 列表（非空数组） */
  sourceChapterIds?: string[];
  /** record_return_chapter 用：回流章触发原因 */
  reason?: string;
  _projectRoot?: string;
  _commitAndSaveFn?: HandleChapterProxyFinalizationInput["_commitAndSaveFn"];
  /** 测试用：注入 chapterRegistry mock */
  _registryOverride?: HandleChapterProxyReviewInput["_registryOverride"];
}

/** workspace_manager 输出（合并 proxy_finalization + proxy_review 结果） */
export interface HandleWorkspaceManagerResult {
  status: string;
  workspaces?: unknown;
  config?: unknown;
  chapters?: unknown;
  message?: string;
  error?: string;
  // proxy_finalization 委托结果（仅 action="proxy_finalization" 时存在）
  workspaceId?: string;
  chapterId?: string;
  approvalId?: string;
  action?: string;
  /** runFinalization 返回的 FinalizationEntryResult（含 finalization/commit/feedbackRecorded） */
  finalization?: FinalizationEntryResult;
  /** 反馈摄入结果（提供 strategyContext 时存在） */
  feedbackIngest?: IngestProxyApprovalFeedbackResult;
  /** release 健康报告 */
  releaseHealth?: ReleaseHealthReport;
  /** 幂等命中标记（true=同 idempotencyKey 已处理，本次未执行） */
  idempotent?: boolean;
  // ── proxy_review 委托结果（仅 action="proxy_review" 时存在） ──
  /** release ID（proxy_review 时存在） */
  releaseId?: string;
  /** runRealChapterProxyReview 返回的 ChapterProxyReviewResult（含 finalStatus/artifact/canDeliverProxyDraft） */
  review?: ChapterProxyReviewResult;
  // ── advisory 委托结果（仅 action="diagnostic"/"ingest_reader_feedback"/"record_return_chapter" 时存在） ──
  /** diagnostic 聚合结果 */
  diagnostic?: ChapterAdvisoryResult["diagnostic"];
  /** ingest_reader_feedback 写入的反馈条目 */
  feedbackEntry?: ChapterAdvisoryResult["feedbackEntry"];
  /** record_return_chapter 写入的 provenance 条目 */
  provenanceEntry?: ChapterAdvisoryResult["provenanceEntry"];
}

export async function handleWorkspaceManager(
  input: HandleWorkspaceManagerInput,
): Promise<HandleWorkspaceManagerResult> {
  try {
    // ── proxy_finalization: 委托 chapter-proxy-finalization-handler ──
    // 方案 A：通过现有 novel_workspace_manager 暴露定稿子操作，不注册第 7 个公开工具
    if (input.action === "proxy_finalization") {
      return await handleProxyFinalization(input);
    }

    // ── proxy_review: 委托 chapter-proxy-review-handler ──
    // 方案 A 续（P1 阻断项修复）：通过现有 novel_workspace_manager 暴露真实代理初审入口，
    // 不注册第 7 个公开工具。REQUIRES_AUTH 边界由 runner 内部守护（无授权卡 -> status=error）
    if (input.action === "proxy_review") {
      return await handleProxyReview(input);
    }

    // ── advisory 路径：委托 chapter-advisory-handler ──
    // APPENDIX-FG-1（2026-07-21）：通过现有 novel_workspace_manager 暴露
    // diagnostic / ingest_reader_feedback / record_return_chapter 三个 advisory 子操作，
    // 不注册第 7 个公开工具。advisory-only：不进入 raw prompt，不阻断生成，不决定文学胜负。
    if (
      input.action === "diagnostic" ||
      input.action === "ingest_reader_feedback" ||
      input.action === "record_return_chapter"
    ) {
      return await handleAdvisory(input);
    }

    const manager = await createWorkspaceManager();

    switch (input.action) {
      case "init": {
        if (!input.workspaceId || !input.novelName || !input.genre) {
          return {
            status: "error",
            message: "init 操作需要 workspaceId、novelName、genre",
          };
        }
        const config = await manager.init({
          workspaceId: input.workspaceId,
          novelName: input.novelName,
          genre: input.genre,
          subGenres: input.subGenres,
          styleProfile: input.styleProfile,
          targetWordCount: input.targetWordCount,
        });
        return {
          status: "success",
          config,
          message: `Workspace "${input.workspaceId}" 已创建`,
        };
      }

      case "list": {
        const workspaces = await manager.listWorkspaces();
        return {
          status: "success",
          workspaces,
        };
      }

      case "switch": {
        if (!input.workspaceId) {
          return {
            status: "error",
            message: "请提供 workspaceId",
          };
        }
        const config = await manager.switch(input.workspaceId);
        return {
          status: "success",
          config,
          message: `已切换到 Workspace "${input.workspaceId}"`,
        };
      }

      case "info": {
        if (!input.workspaceId) {
          return {
            status: "error",
            message: "请提供 workspaceId",
          };
        }
        const config = await manager.getWorkspace(input.workspaceId);
        if (!config) {
          return {
            status: "error",
            message: `Workspace "${input.workspaceId}" 不存在`,
          };
        }
        return {
          status: "success",
          config,
        };
      }

      case "chapters": {
        if (!input.workspaceId) {
          return {
            status: "error",
            message: "请提供 workspaceId",
          };
        }
        const chapters = await manager.getChapterList(input.workspaceId);
        return {
          status: "success",
          chapters,
        };
      }

      default:
        return {
          status: "error",
          message: `未知操作: ${input.action}`,
        };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      message: `Workspace 管理失败: ${errorMessage}`,
    };
  }
}

// ============================================================================
// proxy_finalization 子操作委托
// ============================================================================

/**
 * 委托 handleChapterProxyFinalization 执行章节代理审批定稿子操作。
 *
 * 子操作（proxyAction）：
 * - accept：原样接受代理审批稿 -> commitAndSave(draftText)
 * - accept_with_edits：用户修改后接受 -> 重跑 FactGuard -> commitAndSave(editedText)
 * - reject：拒绝 -> 不 commitAndSave，clear pending
 * - rollback：回滚已提交章节 -> 备份 + 删除 chapters/{chapterId}.md
 * - inspect：只读查看候选信息
 *
 * 参数校验：
 * - workspaceId 必填
 * - proxyAction 必填且属于 5 种子操作之一（否则 status=error）
 * - chapterId / chapterNumber / approvalId 必填
 * - confirm / revision / idempotencyKey / strategyContext / editedText 透传
 */
async function handleProxyFinalization(
  input: HandleWorkspaceManagerInput,
): Promise<HandleWorkspaceManagerResult> {
  // 必填参数校验
  if (!input.workspaceId) {
    return {
      status: "error",
      error: "proxy_finalization 需要 workspaceId",
    };
  }
  if (!input.proxyAction) {
    return {
      status: "error",
      error: "proxy_finalization 需要 proxyAction（accept/accept_with_edits/reject/rollback/inspect）",
    };
  }
  if (!PROXY_FINALIZATION_ACTIONS.has(input.proxyAction)) {
    return {
      status: "error",
      error: `未知 proxyAction: ${input.proxyAction}（仅支持 accept/accept_with_edits/reject/rollback/inspect）`,
    };
  }
  if (!input.chapterId) {
    return {
      status: "error",
      error: "proxy_finalization 需要 chapterId",
    };
  }
  if (input.chapterNumber === undefined || typeof input.chapterNumber !== "number") {
    return {
      status: "error",
      error: "proxy_finalization 需要 chapterNumber（数字）",
    };
  }
  if (!input.approvalId) {
    return {
      status: "error",
      error: "proxy_finalization 需要 approvalId",
    };
  }

  // 委托 handleChapterProxyFinalization
  const finalizationResult = await handleChapterProxyFinalization({
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    chapterNumber: input.chapterNumber,
    approvalId: input.approvalId,
    action: input.proxyAction as HandleChapterProxyFinalizationInput["action"],
    editedText: input.editedText,
    confirm: input.confirm,
    revision: input.revision,
    idempotencyKey: input.idempotencyKey,
    strategyContext: input.strategyContext,
    _projectRoot: input._projectRoot,
    _commitAndSaveFn: input._commitAndSaveFn,
  });

  // 包装结果：workspace_manager 的 status 映射
  // - finalizationResult.status=ok/blocked/error -> 透传为顶层 status
  // - finalizationResult.finalization (FinalizationEntryResult) 放在 result.finalization 字段
  //   使 result.finalization.finalization.action / result.finalization.commit.ok 可直接访问
  // - workspaceId/chapterId/approvalId/action 透传到顶层（便于调用方直接读取）
  return {
    status: finalizationResult.status,
    workspaceId: finalizationResult.workspaceId,
    chapterId: finalizationResult.chapterId,
    approvalId: finalizationResult.approvalId,
    action: finalizationResult.action,
    finalization: finalizationResult.finalization,
    feedbackIngest: finalizationResult.feedbackIngest,
    releaseHealth: finalizationResult.releaseHealth,
    idempotent: finalizationResult.idempotent,
    error: finalizationResult.error,
  };
}

// ============================================================================
// proxy_review 子操作委托
// ============================================================================

/**
 * 委托 handleChapterProxyReview 执行真实 gpt5.6-sol 章节代理初审。
 *
 * 必填参数校验（缺失 -> status=error）：
 * - workspaceId / chapterId / chapterNumber / releaseId
 * - packetInput（审批包输入，含 candidates）
 * - forwardVerdict / reverseVerdict（原始 verdict）
 * - recommendedCandidateId / recommendedSource / promptHash / budget
 *
 * 可选参数透传：
 * - authorizationCardPath：授权卡路径（缺失 -> runner 内部 throw REQUIRES_AUTH）
 * - modelVersion / anonymousSeed / winningSpans / losingSpans
 * - callerOverride / holdReason（apiKey/apiBaseUrl/modelId 已删除；生产网络配置只能从 env 读取）
 * - _projectRoot / _registryOverride（测试用）
 *
 * REQUIRES_AUTH 边界由 runner 内部守护（无授权卡 -> throw -> status=error）。
 * P0-1 修复：apiKey/apiBaseUrl/modelId 不再透传；runner 从 env 读取 + validateJudgeEndpoint 校验。
 * 不生成章节正文、不写 chapters/、不提交长期状态。
 */
async function handleProxyReview(
  input: HandleWorkspaceManagerInput,
): Promise<HandleWorkspaceManagerResult> {
  // ── 必填参数校验 ──────────────────────────────────────────────────
  if (!input.workspaceId) {
    return { status: "error", error: "proxy_review 需要 workspaceId" };
  }
  if (!input.chapterId) {
    return { status: "error", error: "proxy_review 需要 chapterId" };
  }
  if (input.chapterNumber === undefined || typeof input.chapterNumber !== "number") {
    return { status: "error", error: "proxy_review 需要 chapterNumber（数字）" };
  }
  if (!input.releaseId) {
    return { status: "error", error: "proxy_review 需要 releaseId" };
  }
  if (!input.packetInput) {
    return { status: "error", error: "proxy_review 需要 packetInput（审批包输入）" };
  }
  if (!input.forwardVerdict) {
    return { status: "error", error: "proxy_review 需要 forwardVerdict（正向 verdict）" };
  }
  if (!input.reverseVerdict) {
    return { status: "error", error: "proxy_review 需要 reverseVerdict（反向 verdict）" };
  }
  if (!input.recommendedCandidateId) {
    return { status: "error", error: "proxy_review 需要 recommendedCandidateId" };
  }
  if (!input.recommendedSource) {
    return { status: "error", error: "proxy_review 需要 recommendedSource" };
  }
  if (!input.promptHash) {
    return { status: "error", error: "proxy_review 需要 promptHash" };
  }
  if (!input.budget) {
    return { status: "error", error: "proxy_review 需要 budget（maxCalls + timeoutMs）" };
  }

  // ── 委托 handleChapterProxyReview ─────────────────────────────────
  // P0-1 修复：不透传 apiKey/apiBaseUrl/modelId；生产网络配置只能从 env 读取
  // （runner 内部从 NOVELOS_JUDGE_* env 加载 + validateJudgeEndpoint 校验 endpoint）
  const reviewResult = await handleChapterProxyReview({
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    chapterNumber: input.chapterNumber,
    releaseId: input.releaseId,
    authorizationCardPath: input.authorizationCardPath,
    packetInput: input.packetInput,
    forwardVerdict: input.forwardVerdict,
    reverseVerdict: input.reverseVerdict,
    recommendedCandidateId: input.recommendedCandidateId,
    recommendedSource: input.recommendedSource,
    promptHash: input.promptHash,
    budget: input.budget,
    modelVersion: input.modelVersion,
    anonymousSeed: input.anonymousSeed,
    winningSpans: input.winningSpans,
    losingSpans: input.losingSpans,
    callerOverride: input.callerOverride,
    holdReason: input.holdReason,
    _projectRoot: input._projectRoot,
    _registryOverride: input._registryOverride,
  });

  // ── 包装结果：workspace_manager 顶层字段映射 ──────────────────────
  // - reviewResult.status=ok/error -> 透传为顶层 status
  // - workspaceId/chapterId/releaseId 透传到顶层（便于调用方直接读取）
  // - review (ChapterProxyReviewResult) 放在 result.review 字段
  //   使 result.review.finalStatus / result.review.artifact / result.review.canDeliverProxyDraft 可直接访问
  return {
    status: reviewResult.status,
    workspaceId: reviewResult.workspaceId,
    chapterId: reviewResult.chapterId,
    releaseId: reviewResult.releaseId,
    review: reviewResult.review,
    error: reviewResult.error,
  };
}

// ============================================================================
// advisory 子操作委托
// ============================================================================

/**
 * 委托 handleChapterAdvisory 执行附录 F/G 工作流 advisory 子操作。
 *
 * 子操作（action）：
 * - diagnostic：只读聚合查询 ClosureTracker scanCompleteness + ChapterProgressionContract
 *   + reader feedback 计数 + return chapter 计数。不修改任何文件。
 * - ingest_reader_feedback：摄入读者反馈到 series/reader-feedback.json（advisory 元数据）
 * - record_return_chapter：记录回流章 provenance 到 series/return-chapter-provenance.json（advisory 元数据）
 *
 * 必填参数校验（缺失 -> status=error）：
 * - workspaceId 必填
 * - ingest_reader_feedback：chapterId / chapterNumber / feedbackType / feedbackText / sourceRef
 * - record_return_chapter：chapterId / chapterNumber / returnType / reason / sourceRef / sourceChapterIds
 *
 * advisory-only 边界：
 * - 不进入 raw prompt，不阻断生成，不决定文学胜负
 * - diagnostic 是只读查询，不修改任何文件
 * - ingest_reader_feedback / record_return_chapter 只写入 series/*.json advisory 元数据，
 *   不修改 chapters/ 正文，不修改 narrative-state-store.json 长期状态
 */
async function handleAdvisory(
  input: HandleWorkspaceManagerInput,
): Promise<HandleWorkspaceManagerResult> {
  // 必填参数校验
  if (!input.workspaceId) {
    return { status: "error", error: "advisory 需要 workspaceId" };
  }
  if (
    input.action !== "diagnostic" &&
    input.action !== "ingest_reader_feedback" &&
    input.action !== "record_return_chapter"
  ) {
    return { status: "error", error: `未知 advisory action: ${input.action}` };
  }

  // 委托 handleChapterAdvisory
  const advisoryResult = await handleChapterAdvisory({
    action: input.action,
    workspaceId: input.workspaceId,
    chapterNumber: input.chapterNumber,
    feedbackType: input.feedbackType,
    feedbackText: input.feedbackText,
    sourceRef: input.sourceRef,
    focusDimensions: input.focusDimensions,
    chapterId: input.chapterId,
    returnType: input.returnType,
    sourceChapterIds: input.sourceChapterIds,
    reason: input.reason,
    _projectRoot: input._projectRoot,
  });

  // 包装结果：workspace_manager 顶层字段映射
  // - advisoryResult.status=success/error -> 透传为顶层 status
  // - diagnostic / feedbackEntry / provenanceEntry 放在对应字段
  // - error 透传到顶层（便于调用方直接读取）
  return {
    status: advisoryResult.status,
    diagnostic: advisoryResult.diagnostic,
    feedbackEntry: advisoryResult.feedbackEntry,
    provenanceEntry: advisoryResult.provenanceEntry,
    error: advisoryResult.error,
  };
}
