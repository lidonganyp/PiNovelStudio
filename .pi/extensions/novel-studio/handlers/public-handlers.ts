/**
 * 生产内核公开 handler — 6 个公开工具实现
 *
 * Step 2 逻辑隔离：这些 handler 是模块级函数（非闭包内），只依赖：
 * - getProjectRoot（from ../utils/config.js）
 * - craft/v2 外部模块
 * 不依赖任何 legacy Stage0-8 编排或闭包状态。
 *
 * 生产入口 index.ts import 这 6 个 handler 注册到 registerTools。
 * legacy Stage0-8 编排入口与 lab 工具已在 LEGACY-RUNTIME-REMOVAL-1 中删除，
 * 不再存在 legacy-index.ts / lab-entry / register-lab-tools 等文件。
 */

import { join } from "node:path";
import { getProjectRoot } from "../utils/config.js";
import { validateWorkspaceId } from "../utils/fs.js";
import { validateChapterId } from "../utils/chapter-path.js";
import { loadStrategyTraceContext } from "./strategy-feedback-trace-context.js";
import {
  appendPublicFeedbackLedgerObservation,
  appendPublicFeedbackLedgerRevoke,
  buildFeedbackEventId,
  recomputeStrategyReputationFromLedger,
  resolveFeedbackLineage,
} from "./strategy-feedback-lineage.js";
import {
  clearUnhealthyProviders,
  clearChapterTimeoutCounts,
} from "../api/fallback-manager.js";
import {
  preflightWorkspace,
  formatPreflightWorkspaceReport,
  type PreflightWorkspaceReport,
} from "../craft/workspace-preflight-checker.js";
import {
  createStoryOutlinePlanner,
  type StoryOutlinePlannerInput,
  type StoryOutlinePlannerResult,
} from "../craft/outline-planner.js";

// handleWorkspaceManager 已抽到独立模块 tools/workspace-manager-handler.ts（Phase 2b：
// 解除 workflow-tool-handlers.ts 顶部 architect/critic import 对生产闭包的拖累）
export { handleWorkspaceManager } from "../tools/workspace-manager-handler.js";

// BATCH-P0-01：批量章节生成入口 handler（与 handleWorkspaceManager 同模式，独立小模块 re-export）
// 不新增第二个正文生成工具；批量能力作为 novel_generate_chapter 的 mode="batch" 分支，
// 内部仍逐章调用 handleGenerateChapter（统一主链路）。
export { handleBatchGeneration } from "./batch-generation-handler.js";

// ============================================================================
// novel_generate_chapter — 统一主链路唯一入口
// ============================================================================

/**
 * 始终调用统一编排器：NovelOS Agentic → 作者风格优化 → 事实复检 → commit
 *
 * 生产入口不包含 __forceLegacyChain 检查（该标志仅由 legacy_test 工具设置）。
 * 生产路径不调用机器文学裁判，也不把 one-shot raw 作为交付稿；Agentic/风格阶段失败即结构化阻断。
 */
export async function handleGenerateChapter(input: {
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  outline?: string;
  previousChapterSummary?: string;
  styleProfile?: string;
  /** Production writer selection. Undefined uses Gemini; neither writer is a silent fallback. */
  writerModel?: "claude" | "gemini31";
  /**
   * FULL-PIPELINE-PREVIEW-1：完整链路只读预览。
   * 执行统一主链路（NovelOS Agentic → 作者风格整章优化 → 事实复检），但跳过所有副作用
   * （不写章节、不提交状态、不写 trace）。Phase 1 整改后生产路径不含 judge/select。
   */
  fullPipelinePreview?: boolean;
  /** Per-candidate bounded model timeout in milliseconds. */
  candidateTimeoutMs?: number;
  /** Wall-clock budget for all model calls in one read-only preview. */
  previewTotalTimeoutMs?: number;
  /** Optional validated pre-prose scene solution card. */
  sceneSolution?: import("../v2/core/scene-solution-search.js").SceneSolutionCard | null;
  // P11新增：人工审阅点恢复支持
  reviewToken?: string;
  reviewDecision?: "confirm" | "reject";
  reviewFeedback?: string;
  /**
   * P30 新增（P39 扩展为 7 模型）：显式章节生成测试通道开关。
   *
   * - "doubao"    → narrator_testing（doubao-seed-2-1-pro-260628），强制 P26 收紧阈值
   * - "ernie"     → narrator_testing_ernie（ernie-5.1）
   * - "glm"       → narrator_testing_glm（glm-5.2）
   * - "gpt"       → narrator_testing_gpt（gpt-5.5）
   * - "deepseek"  → narrator_testing_deepseek（deepseek-v4-flash）
   * - "qwen"      → narrator_testing_qwen（qwen3.7-plus）
   * - "claude"    → narrator_testing_claude（显式 baseline）
   * - undefined   → 走默认 Gemini 3.1 Pro 主路由。
   *
   * 仅影响本次生成，不污染全局配置。P26/P28 所有门禁照常执行。
   */
  modelTestRoute?: "doubao" | "glm" | "gpt" | "deepseek" | "claude" | "gemini31" | "claude48";
  /**
   * REAL-QUALITY-1-PREFLIGHT：随机种子（judge 匿名化 + Thompson Sampling 策略筛选可复现）。
   *
   * 传入使 editorial 候选生成可复现（seed=1 时 sample≈0.6271≥0.5，策略被选中→生成 editorial 候选）。
   * 未传时使用 Math.random（策略筛选 50% 概率）。
   */
  seed?: number;
  /** 批量任务跨章延续的统一预算账本 */
  _priorBudgetLedger?: import("../v2/core/budget-types.js").BudgetLedger;
  /** 工具层 model_timeout 重试序号（0=首次，1=第一次重试） */
  _modelTimeoutRetryAttempt?: number;
}) {
  const {
    workspaceId, chapterId, chapterNumber,
    writerModel,
    modelTestRoute,
    seed,
  } = input;

  // 公开生产入口必须在任何文件读取、trace 写入或模型调用前校验路径组成部分。
  // 下游存在局部校验，但统一入口是唯一应当 fail-closed 的安全边界。
  validateWorkspaceId(workspaceId);
  validateChapterId(chapterId);

  // ============================================================================
  // EXPERIMENTAL-FIELDS-REJECT-1：拒绝实验字段与旧 raw/judge 分支
  // 生产入口拒绝以下字段（仅 eval/评测使用）：
  // - recoverBlockedRaw：旧 raw 恢复分支（raw 候选不经过编辑/风格优化后交付）
  // - boundedBestOf3：旧固定场景多候选评测（已退出生产主链路）
  // - qualityExperiment：eval-only 质量天花板样本（NovelBench B4 矩阵）
  // - previewOnly：已弃用
  // - modelTestRoute：eval-only 模型对比路由
  // - fullPipelinePreview：只读预览，不得走生产提交入口
  // - _mockGenerateChapter：测试替身，不得进入生产提交
  // 生产路径不含 PairwiseJudge / SelectionPolicy / EditorialOpportunityJudge。
  // ============================================================================
  const _rejectedExperimental: string[] = [];
  if ((input as any).recoverBlockedRaw !== undefined) {
    _rejectedExperimental.push("recoverBlockedRaw");
  }
  if ((input as any).boundedBestOf3 !== undefined) {
    _rejectedExperimental.push("boundedBestOf3");
  }
  if ((input as any).qualityExperiment !== undefined) {
    _rejectedExperimental.push("qualityExperiment");
  }
  if ((input as any).previewOnly !== undefined) {
    _rejectedExperimental.push("previewOnly");
  }
  if (modelTestRoute !== undefined) {
    _rejectedExperimental.push("modelTestRoute");
  }
  if (input.fullPipelinePreview !== undefined) {
    _rejectedExperimental.push("fullPipelinePreview");
  }
  if ((input as any)._mockGenerateChapter !== undefined) {
    _rejectedExperimental.push("_mockGenerateChapter");
  }
  if (_rejectedExperimental.length > 0) {
    throw new Error(
      `实验字段在生产入口被拒绝：${_rejectedExperimental.join(", ")}。` +
      `这些字段仅用于 eval/评测（NovelBench），生产路径不含 raw/judge 分支。` +
      `如需评测请使用 eval 入口；如需只读预览请直调 runUnifiedPipeline。`,
    );
  }

  // ============================================================================
  // 统一主链路 — 唯一生产路径（计划 §Phase 5/7）
  // novel_generate_chapter 始终调用统一编排器：Agentic → 风格优化 → 复检 → commit
  // - 无 whitelist：所有 workspace/chapter 走统一入口
  // - 无 generationMode：不再有 legacy/v2 双模式
  // - 无 v2NotImplemented → legacy 回退：失败由编排器内部降级（raw → hard block）
  // - 无 PINOVEL_UNIFIED_PIPELINE 环境变量：生产路径无回滚分支
  // - 无 __forceLegacyChain 检查：生产入口始终走统一主链路
  // ============================================================================
  const _unifiedProjectRoot = (input as any)._projectRoot || getProjectRoot();

  // ============================================================================
  // UNHEALTHY-CLEAR-1：每章独立生成，清除上一章残留的 provider unhealthy 标记
  // ============================================================================
  // 根因修复：fallback-manager 的 UNHEALTHY_PROVIDERS（permanent error）和
  // CHAPTER_TIMEOUT_UNHEALTHY（章级 timeout 累计阈值）是进程内全局 Set，一旦标记
  // 不会自动清除（原仅 NovelBench 评测运行时调用 clearUnhealthyProviders）。
  // 导致代理服务瞬时故障（如 403/429/quota）后，provider 被永久标记为 unhealthy，
  // 后续所有章节生成都被 unhealthy_skip（毫秒级立即失败），即使服务已恢复也无法调用。
  //
  // 语义合理性：每章独立生成，上一章的瞬时故障不应污染本章。如果 provider 真永久
  // 故障，单章内会自然失败（超时 × 重试），不需要跨章保护。
  clearUnhealthyProviders();
  clearChapterTimeoutCounts();

  try {
    const { runUnifiedPipeline } = await import("../v2/core/unified-entry.js");
    const _unifiedResult = await runUnifiedPipeline({
      workspaceId,
      chapterId,
      chapterNumber,
      projectRoot: _unifiedProjectRoot,
      writerModel,
      // EXPERIMENTAL-FIELDS-REJECT-1：实验字段已在入口 guard 拒绝，此处不再透传。
      // 旧 raw/judge 分支与 modelTestRoute / fullPipelinePreview / mock 不得进入生产提交。
      candidateTimeoutMs: input.candidateTimeoutMs,
      previewTotalTimeoutMs: input.previewTotalTimeoutMs,
      sceneSolution: input.sceneSolution,
      // REAL-QUALITY-1-PREFLIGHT：seed 透传到统一编排器（Thompson 策略筛选可复现；eval-only 路径同时复现 judge 匿名化）
      seed,
      onUpdate: (input as any).__onUpdate,
      _priorBudgetLedger: input._priorBudgetLedger,
      _modelTimeoutRetryAttempt: input._modelTimeoutRetryAttempt,
    });
    return _unifiedResult as any;
  } catch (e: any) {
    // 统一主链路加载/执行失败：不静默回退 legacy，结构化阻断
    // （计划 §Phase 5：无 silent legacy fallback）
    // 编排器内部失败（raw 生成失败等）已在 orchestrator 内降级为 hard block，
    // 此处仅捕获 entry/orchestrator 层未预期异常。
    // P1 修复（第三轮）：顶层异常也写 trace，避免 silent degrade（用户验收反例：
    // "顶层异常捕获也只返回 envelope，不写 trace"）。
    process.stderr.write(
      `[Unified] 主链路执行失败：${e?.message ?? e}\n`
    );
    const _topLevelFailureEnvelope = {
      stage: "unified_entry",
      gate: "unified_entry_exception",
      severity: "hard_block" as const,
      reason: `统一主链路执行失败：${e?.message ?? e}`,
      evidence: { error: e?.message ?? String(e), stack: e?.stack ?? null },
      recoverable: false,
    };
    try {
      // P7 Stage A：顶层异常也发射 failure_recorded（旧 quality-trace.json 继续写）。
      // 顶层异常通常发生在 runUnifiedPipeline 内部会话建立之前（import 失败 / 会话创建失败），
      // 故此处新建独立 AuditRunSession：start → 透传 sink → 终态，保证事件流完整且可审计。
      const { createAuditRunSession } = await import("../v2/core/audit/audit-run-session.js");
      const auditSession = createAuditRunSession({
        projectRoot: _unifiedProjectRoot,
        workspaceId,
        chapterId,
        chapterNumber,
        persist: true,
      });
      auditSession.start({ topLevelException: true });
      const { createLegacyTraceAdapter } = await import("../v2/adapters/legacy-trace-adapter.js");
      const traceAdapter = createLegacyTraceAdapter({
        workspacePath: join(_unifiedProjectRoot, "workspaces"),
        workspaceId,
        chapterId,
        auditSink: auditSession,
      });
      traceAdapter.record({
        stage: "unified_entry" as any,
        timestamp: new Date().toISOString(),
        error: {
          message: _topLevelFailureEnvelope.reason,
          code: "unified_entry",
          recoverable: false,
        },
        failureEnvelope: _topLevelFailureEnvelope,
        contextHash: "top-level-exception",
      });
      traceAdapter.flush();
      auditSession.finalizeInterrupted(
        `unified entry exception: ${e?.message ?? e}`,
        e
      );
    } catch (traceErr) {
      // trace 写入失败不阻断返回（与 unified-entry 一致的容错策略）
      process.stderr.write(
        `[Unified] 顶层异常 trace 持久化失败（不阻断返回）：${traceErr instanceof Error ? traceErr.message : String(traceErr)}\n`
      );
    }
    return {
      status: "error",
      workspaceId,
      chapterId,
      chapterNumber,
      stageResults: {
        unifiedPipeline: true,
        loadError: e?.message ?? String(e),
      },
      failureEnvelope: {
        stage: "unified_entry",
        gate: "unified_entry_exception",
        severity: "hard_block",
        reason: `统一主链路执行失败：${e?.message ?? e}`,
        evidence: { error: e?.message ?? String(e), stack: e?.stack ?? null },
        recoverable: false,
        degradedTo: "hard_block",
      },
    } as any;
  }
}

// ============================================================================
// novel_preflight_workspace — 生成前预检
// ============================================================================

/**
 * 纯本地预检，不调用外部模型。预检失败不进入模型生成。
 * 缺 series/outline.md 不得阻断（P22）。
 */
export async function handlePreflightWorkspace(input: {
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  skipSeedReadiness?: boolean;
}): Promise<{
  status: "passed" | "blocked";
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  report: PreflightWorkspaceReport;
  message: string;
}> {
  const { workspaceId, chapterId, chapterNumber, skipSeedReadiness } = input;
  validateWorkspaceId(workspaceId);
  validateChapterId(chapterId);
  const projectRoot = getProjectRoot();
  const workspacePath = join(projectRoot, "workspaces", workspaceId);

  let report: PreflightWorkspaceReport;
  try {
    report = preflightWorkspace({
      workspacePath,
      workspaceId,
      chapterId,
      chapterNumber,
      projectRoot,
      skipSeedReadiness,
    });
  } catch (e) {
    // 预检自身异常 → fail-closed，返回 blocked
    const fallbackReport: PreflightWorkspaceReport = {
      passed: false,
      blockingItems: [{
        check: "preflight_exception",
        reason: `预检执行异常：${String(e)}`,
        fixInstruction: `检查 workspace 目录结构与 config.json 完整性`,
        evidence: { error: String(e) },
      }],
      warnings: [],
      fixInstructions: [`检查 workspace 目录结构与 config.json 完整性`],
      checks: {},
      authorWorkflow: {
        advisoryOnly: true,
        canBlockGeneration: false,
        steps: [],
      },
      durationMs: 0,
    };
    return {
      status: "blocked",
      workspaceId,
      chapterId,
      chapterNumber,
      report: fallbackReport,
      message: formatPreflightWorkspaceReport(fallbackReport),
    };
  }

  return {
    status: report.passed ? "passed" : "blocked",
    workspaceId,
    chapterId,
    chapterNumber,
    report,
    message: formatPreflightWorkspaceReport(report),
  };
}

// ============================================================================
// novel_plan_story_outline — 大纲规划
// ============================================================================

export async function handlePlanStoryOutline(input: StoryOutlinePlannerInput): Promise<StoryOutlinePlannerResult> {
  validateWorkspaceId(input.workspaceId);
  const projectRoot = (input as StoryOutlinePlannerInput & { _projectRoot?: string })._projectRoot || getProjectRoot();
  const planner = createStoryOutlinePlanner({ projectRoot });
  return planner.plan(input);
}

// ============================================================================
// P1-7: Phase 6 在线学习用户公开入口 handlers
// 计划 §Phase 6 退出条件：用户有公开入口查看或撤销学习结果。
// 动态 import 学习模块（A3 物理收敛后 v2 已并入本包 ./v2/learning/，无跨 workspace tsc）。
// ============================================================================

export async function handleStrategyPolicyView(input: {
  workspaceId: string;
  modelVersion?: string;
  strategyId?: string;
}): Promise<any> {
  validateWorkspaceId(input.workspaceId);
  const projectRoot = (input as any)._projectRoot || getProjectRoot();
  const { loadStrategyPolicyStore } = await import(
    "../v2/learning/strategy-policy-store.js"
  );
  const store = loadStrategyPolicyStore(input.workspaceId, projectRoot);
  const data = store.toJSON();

  // 按模型版本过滤
  let partitions = data.partitions;
  if (input.modelVersion) {
    partitions = { [input.modelVersion]: partitions[input.modelVersion] ?? {} };
  }

  // 展平为列表，按策略 id 过滤
  const reputations: any[] = [];
  for (const [mv, reps] of Object.entries(partitions as Record<string, Record<string, any>>)) {
    for (const [sid, rep] of Object.entries(reps)) {
      if (input.strategyId && sid !== input.strategyId) continue;
      reputations.push({ ...rep, modelVersion: mv });
    }
  }

  return {
    status: "ok",
    workspaceId: input.workspaceId,
    totalReputations: reputations.length,
    reputations: reputations.map((r) => ({
      strategyId: r.strategyId,
      modelVersion: r.modelVersion,
      alpha: r.alpha,
      beta: r.beta,
      sampleCount: r.sampleCount,
      consecutiveLosses: r.consecutiveLosses,
      status: r.status,
      statusChangedAt: r.statusChangedAt,
      statusReason: r.statusReason,
      lastUpdated: r.lastUpdated,
      evidenceCount: r.evidence?.length ?? 0,
      recentEvidence: r.evidence?.slice(-5) ?? [],
    })),
  };
}

export async function handleStrategyFeedback(input: {
  workspaceId: string;
  /** 提供 naturalLanguageFeedback 时可省略（由编译器推断 action） */
  action?: "choice" | "edit" | "rating" | "status_override" | "revert";
  /** 提供 naturalLanguageFeedback 时可省略（由编译器推断 strategyId） */
  strategyId?: string;
  modelVersion?: string;
  sourceChapter?: string;
  opportunityType?: string;
  chosen?: "editorial" | "raw";
  deliveredSource?: "editorial" | "raw" | "fallback";
  modified?: boolean;
  editDistance?: number;
  /** Phase 4A：用户最终修改稿（与 deliveredText 对比自动计算 delta） */
  userFinalText?: string;
  /** Phase 4A：系统交付正文（与 userFinalText 对比自动计算 delta） */
  deliveredText?: string;
  /**
   * P1 修复（审阅包回填）：章节 ID（如 "17"）。
   *
   * 提供 userFinalText + deliveredText + chapterId 时，系统除了计算 delta 写入策略信誉库，
   * 还会调用 backfillAuthorStyleReviewPackage 把 delta 回填到 sidecar
   * workspaces/{id}/chapters/{chapterId}.review-package.json 的 userModificationDelta 字段。
   * 未提供 chapterId 时不执行回填（仅记录策略信誉）。
   */
  chapterId?: string;
  /** Phase 4D（P1-3）：自然语言反馈（规则驱动编译为结构化策略反馈） */
  naturalLanguageFeedback?: string;
  /** Phase 4D（P1-3）：本次生成选中的策略 id 列表（供编译器通用情感归因） */
  selectedStrategyIds?: string[];
  rating?: number;
  candidateSource?: "editorial" | "raw";
  status?: "active" | "dormant" | "retired";
  reason?: string;
  note?: string;
  /** USER-FEEDBACK-EVIDENCE-PIPELINE-1：可选完整血缘覆盖 / 幂等键 */
  feedbackEventId?: string;
  orchestratorRunId?: string;
  candidateId?: string;
  strategyBundleId?: string;
  exposureId?: string;
  promptBundleId?: string;
}): Promise<any> {
  validateWorkspaceId(input.workspaceId);
  if (input.chapterId !== undefined) validateChapterId(input.chapterId);
  const projectRoot = (input as any)._projectRoot || getProjectRoot();
  const traceContext = input.chapterId
    ? loadStrategyTraceContext(projectRoot, input.workspaceId, input.chapterId)
    : null;
  const modelVersion = input.modelVersion?.trim() || traceContext?.modelVersion;
  if (!modelVersion) {
    throw new Error("策略反馈需要 modelVersion；可直接提供，或传 chapterId 由成功 trace 推断");
  }
  const selectedStrategyIds = input.selectedStrategyIds?.length
    ? input.selectedStrategyIds
    : traceContext?.selectedStrategyIds ?? [];
  const sourceChapter = input.sourceChapter
    ?? traceContext?.sourceChapter
    ?? (input.chapterId ? (/^ch/i.test(input.chapterId) ? input.chapterId : `ch${input.chapterId}`) : undefined);
  const opportunityType = input.opportunityType ?? traceContext?.opportunityType ?? "author_style";
  const {
    loadStrategyPolicyStore,
    saveStrategyPolicyStore,
  } = await import("../v2/learning/strategy-policy-store.js");
  const { createUserFeedbackIngestor } = await import(
    "../v2/learning/user-feedback-ingestor.js"
  );
  const { computeUserModificationDelta } = await import(
    "../v2/learning/user-modification-delta.js"
  );

  // PROMPT-INJECTION-TRUST：公共反馈入口安全分类 + next-request-only 闸门
  const {
    classifyUserFeedbackTrustCategory,
    assertFeedbackCannotBypassSecurity,
    assertFeedbackAffectsNextRequestOnly,
  } = await import("../v2/learning/feedback-evidence-contracts.js");
  const { emitTrustAuditEvent } = await import("../v2/core/trust/trust-audit.js");
  const { installTrustAuditBridge } = await import(
    "../v2/core/trust/trust-audit-bridge.js"
  );
  const uninstallFeedbackTrustBridge = installTrustAuditBridge({
    projectRoot,
    workspaceId: input.workspaceId,
  });

  const feedbackTextForTrust =
    input.naturalLanguageFeedback?.trim() ||
    input.note?.trim() ||
    input.reason?.trim() ||
    "";
  const feedbackTrustCategory = classifyUserFeedbackTrustCategory(
    feedbackTextForTrust,
    {
      isFactCorrection: false,
      isContextCorrection: false,
      isWorkflowPreference: input.action === "status_override",
    },
  );
  const securityGate = assertFeedbackCannotBypassSecurity(feedbackTrustCategory, []);
  if (!securityGate.ok) {
    emitTrustAuditEvent({
      decisionType: "feedback_isolation",
      allowed: false,
      reason: securityGate.reason,
      workspaceId: input.workspaceId,
      chapterId: input.chapterId,
      evidence: {
        category: feedbackTrustCategory,
        textPreview: feedbackTextForTrust.slice(0, 120),
      },
    });
    uninstallFeedbackTrustBridge();
    return {
      ok: false,
      rejected: true,
      trustCategory: feedbackTrustCategory,
      reason: securityGate.reason,
      nextRequestOnly: true,
    };
  }
  // 显式禁止反馈改当前正文/硬门禁（契约断言）
  const mutationCheck = assertFeedbackAffectsNextRequestOnly([]);
  if (!mutationCheck.ok) {
    uninstallFeedbackTrustBridge();
    return {
      ok: false,
      rejected: true,
      reason: `反馈禁止修改：${mutationCheck.violations.join(", ")}`,
    };
  }
  emitTrustAuditEvent({
    decisionType: "feedback_isolation",
    allowed: true,
    reason: `反馈分类=${feedbackTrustCategory}，next-request-only`,
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    evidence: { category: feedbackTrustCategory },
  });

  const store = loadStrategyPolicyStore(input.workspaceId, projectRoot);
  const ingestor = createUserFeedbackIngestor();
  let result: any;
  type LineageAudit = {
    complete: boolean;
    reason: string;
    lineage: Record<string, unknown>;
    ledgerAppended?: number;
    ledgerError?: string;
  };
  const lineageAuditState: { value: LineageAudit | null } = { value: null };

  const resolveLineageForStrategy = (strategyId: string, actionLabel: string) => {
    const feedbackEventId = buildFeedbackEventId({
      workspaceId: input.workspaceId,
      strategyId,
      action: actionLabel,
      chapterId: input.chapterId,
      explicitId: input.feedbackEventId,
    });
    return resolveFeedbackLineage({
      workspaceId: input.workspaceId,
      strategyId,
      modelVersion,
      sourceChapter: sourceChapter ?? "",
      feedbackEventId,
      deliveredSource: input.deliveredSource ?? input.candidateSource ?? "editorial",
      selectedStrategyIds,
      orchestratorRunId: input.orchestratorRunId,
      candidateId: input.candidateId,
      strategyBundleId: input.strategyBundleId,
      exposureId: input.exposureId,
      promptBundleId: input.promptBundleId,
      traceContext,
    });
  };

  const persistLedgerFromResult = (
    strategyId: string,
    outcomeResult: {
      outcome?: "win" | "loss" | "tie";
      weight?: number;
      decisionCount?: number;
      recorded?: boolean;
      evidence?: { evidenceId?: string; note?: string };
      feedbackLevel?: string;
      attributionConfidence?: string;
      reason?: string;
    },
    lineageResolved: ReturnType<typeof resolveFeedbackLineage>,
    nonLiterary = false,
  ) => {
    const evidenceId =
      outcomeResult.evidence?.evidenceId ??
      lineageResolved.lineage.feedbackEventId ??
      buildFeedbackEventId({
        workspaceId: input.workspaceId,
        strategyId,
        action: input.action ?? "unknown",
        chapterId: input.chapterId,
      });
    const ledger = appendPublicFeedbackLedgerObservation({
      workspaceId: input.workspaceId,
      projectRoot,
      strategyId,
      modelVersion,
      sourceChapter: sourceChapter ?? "",
      outcome: outcomeResult.outcome ?? "tie",
      weight: outcomeResult.weight ?? 0,
      decisionCount: outcomeResult.decisionCount ?? 1,
      recorded: outcomeResult.recorded === true,
      evidenceId,
      feedbackLevel: outcomeResult.feedbackLevel,
      attributionConfidence: outcomeResult.attributionConfidence,
      note: outcomeResult.evidence?.note ?? outcomeResult.reason,
      lineage: lineageResolved.completeLineage ?? lineageResolved.lineage,
      nonLiterary,
    });
    lineageAuditState.value = {
      complete: lineageResolved.complete,
      reason: lineageResolved.reason,
      lineage: lineageResolved.lineage as Record<string, unknown>,
      ledgerAppended: ledger.appended,
      ledgerError: ledger.error,
    };
  };

  // Phase 4A：若调用方提供了 userFinalText + deliveredText，自动计算 userModificationDelta
  // 不再让 editDistance 由调用方手填（避免硬编码 null / 不一致）
  // P1 修复（审阅包回填）：delta 计算与 action 解耦——NL feedback 路径 inferredAction="edit"
  // 时同样需要 delta 供 sidecar 回填，故只要提供 userFinalText + deliveredText 就计算。
  let computedDelta: ReturnType<typeof computeUserModificationDelta> | null = null;
  if (
    input.userFinalText !== undefined
    && input.deliveredText !== undefined
  ) {
    computedDelta = computeUserModificationDelta(
      input.deliveredText,
      input.userFinalText,
    );
  }

  // ── P1-3 修复：自然语言反馈编译路径 ──────────────────────────────────
  // 当提供 naturalLanguageFeedback 且未提供 action 时，由 NaturalLanguageFeedbackCompiler
  // 规则驱动推断 strategyId + inferredAction，自动记录策略信誉 outcome。
  // 取代原 TODO(P4D)：编译器已实现，不再只标记接收。
  const hasNaturalLanguageFeedback =
    !!input.naturalLanguageFeedback && input.naturalLanguageFeedback.trim().length > 0;
  let compiledFeedback: import("../v2/learning/natural-language-feedback-compiler.js").CompiledFeedback | null = null;
  let naturalLanguageFeedbackAccepted = false;

  if (hasNaturalLanguageFeedback) {
    naturalLanguageFeedbackAccepted = true;
    const { compileNaturalLanguageFeedback } = await import(
      "../v2/learning/natural-language-feedback-compiler.js"
    );
    compiledFeedback = compileNaturalLanguageFeedback(
      input.naturalLanguageFeedback!,
      selectedStrategyIds,
    );

    // 仅当 action 未显式提供时，走编译器自动推断路径（避免与显式 action 双重记录）
    if (!input.action) {
      if (compiledFeedback.strategyId) {
        const compileContext = {
          sourceChapter: sourceChapter ?? "",
          modelVersion,
          strategyId: compiledFeedback.strategyId,
          opportunityType,
        };
        const lineageResolved = resolveLineageForStrategy(
          compiledFeedback.strategyId,
          compiledFeedback.inferredAction,
        );
        // 自然语言未归因 / 血缘不完整：只记 neutral，不污染文学信誉
        if (
          !lineageResolved.complete ||
          compiledFeedback.inferredAction === "rating"
        ) {
          result = {
            recorded: false,
            outcome: "tie",
            weight: 0,
            decisionCount: 1,
            feedbackLevel: lineageResolved.complete
              ? "implicit_accept"
              : "natural_language_unattributed",
            reason: lineageResolved.complete
              ? compiledFeedback.reason
              : `${compiledFeedback.reason}；${lineageResolved.reason}`,
            evidence: {
              evidenceId: lineageResolved.lineage.feedbackEventId,
              note: compiledFeedback.reason,
            },
          };
          persistLedgerFromResult(
            compiledFeedback.strategyId,
            result,
            lineageResolved,
            true,
          );
        } else {
          const feedbackEventId = String(lineageResolved.lineage.feedbackEventId);
          switch (compiledFeedback.inferredAction) {
            case "choice":
              result = ingestor.ingestChoice(store, {
                context: compileContext,
                chosen: "editorial",
                note: compiledFeedback.reason,
                lineage: lineageResolved.completeLineage,
                feedbackEventId,
              });
              break;
            case "edit":
              result = ingestor.ingestEdit(store, {
                context: compileContext,
                deliveredSource: "editorial",
                modified: true,
                editDistance: undefined,
                note: compiledFeedback.reason,
                lineage: lineageResolved.completeLineage,
                feedbackEventId,
              });
              break;
            default:
              result = {
                recorded: false,
                outcome: "tie",
                weight: 0,
                reason: compiledFeedback.reason,
              };
              break;
          }
          if (result) {
            persistLedgerFromResult(
              compiledFeedback.strategyId,
              result,
              lineageResolved,
            );
          }
          saveStrategyPolicyStore(store, input.workspaceId, projectRoot);
        }
      }
      // P1 修复（审阅包回填）：NL feedback 路径也回填 sidecar（若 chapterId + delta 可用）
      const nlBackfill = await backfillReviewPackageIfAvailable(input, projectRoot, computedDelta);
      // action 未提供且编译器无法映射（strategyId=null）→ 只标记接收，不记录 outcome
      uninstallFeedbackTrustBridge();
      return {
        status: "ok",
        workspaceId: input.workspaceId,
        action: compiledFeedback.inferredAction,
        strategyId: compiledFeedback.strategyId,
        modelVersion,
        trustCategory: feedbackTrustCategory,
        nextRequestOnly: true,
        result: result ?? { recorded: false, reason: compiledFeedback.reason },
        compiledFeedback,
        naturalLanguageFeedbackAccepted,
        userModificationDelta: computedDelta,
        reviewPackageBackfill: nlBackfill,
        lineageAudit: lineageAuditState.value,
      };
    }
    // action 显式提供 → 走下方 switch；compiledFeedback 作为可审计证据附在返回中
  }

  // 公共上下文（choice/edit/rating 需要 sourceChapter + opportunityType）
  // 显式 action 路径必须同时提供 strategyId（schema allOf 保证；此处防御性校验）
  if (input.action && !input.strategyId) {
    throw new Error(
      `显式 action="${input.action}" 需要 strategyId（若使用自然语言反馈编译路径，请省略 action）`,
    );
  }
  const context = {
    sourceChapter: sourceChapter ?? "",
    modelVersion,
    strategyId: input.strategyId!,
    opportunityType,
  };

  switch (input.action) {
    case "choice": {
      if (!input.chosen) throw new Error("choice 操作需要 chosen 参数");
      if (!sourceChapter) throw new Error("choice 操作需要 sourceChapter 参数（可由 chapterId 推断）");
      {
        const lineageResolved = resolveLineageForStrategy(input.strategyId!, "choice");
        if (!lineageResolved.complete) {
          result = {
            recorded: false,
            outcome: "tie",
            weight: 0,
            decisionCount: 1,
            feedbackLevel: "natural_language_unattributed",
            reason: lineageResolved.reason,
            evidence: {
              evidenceId: lineageResolved.lineage.feedbackEventId,
              note: lineageResolved.reason,
            },
          };
          persistLedgerFromResult(input.strategyId!, result, lineageResolved, true);
        } else {
          result = ingestor.ingestChoice(store, {
            context,
            chosen: input.chosen,
            note: input.note,
            lineage: lineageResolved.completeLineage,
            feedbackEventId: String(lineageResolved.lineage.feedbackEventId),
          });
          persistLedgerFromResult(input.strategyId!, result, lineageResolved);
        }
      }
      break;
    }
    case "edit": {
      if (!sourceChapter) throw new Error("edit 操作需要 sourceChapter 参数（可由 chapterId 推断）");
      if (!input.deliveredSource) throw new Error("edit 操作需要 deliveredSource 参数");
      // Phase 4A：优先使用 computedDelta（来自 userFinalText vs deliveredText）
      // 调用方未提供 userFinalText/deliveredText 时回退到原 modified/editDistance 参数
      let modified: boolean;
      let editDistance: number | undefined;
      let editNote = input.note;
      if (computedDelta) {
        modified = computedDelta.modified;
        editDistance = computedDelta.editDistance;
        // 把 delta 摘要追加到 note，供 evidence 审计
        const deltaSummary = `[userModificationDelta] ${computedDelta.reason}`;
        editNote = editNote ? `${editNote} | ${deltaSummary}` : deltaSummary;
      } else {
        if (input.modified === undefined) throw new Error("edit 操作需要 modified 参数（或提供 userFinalText + deliveredText）");
        modified = input.modified;
        editDistance = input.editDistance;
      }
      {
        const lineageResolved = resolveLineageForStrategy(input.strategyId!, "edit");
        if (!lineageResolved.complete) {
          result = {
            recorded: false,
            outcome: "tie",
            weight: 0,
            decisionCount: 1,
            feedbackLevel: "natural_language_unattributed",
            reason: lineageResolved.reason,
            evidence: {
              evidenceId: lineageResolved.lineage.feedbackEventId,
              note: lineageResolved.reason,
            },
          };
          persistLedgerFromResult(input.strategyId!, result, lineageResolved, true);
        } else {
          result = ingestor.ingestEdit(store, {
            context,
            deliveredSource: input.deliveredSource,
            modified,
            editDistance,
            note: editNote,
            delta: computedDelta ?? undefined,
            classification: computedDelta?.classification,
            lineage: lineageResolved.completeLineage,
            feedbackEventId: String(lineageResolved.lineage.feedbackEventId),
          });
          persistLedgerFromResult(
            input.strategyId!,
            result,
            lineageResolved,
            result?.attribution?.outcome === "neutral" &&
              (computedDelta?.factIssue === true ||
                computedDelta?.settingCompletion === true),
          );
        }
      }
      break;
    }
    case "rating": {
      if (input.rating === undefined) throw new Error("rating 操作需要 rating 参数");
      if (!input.candidateSource) throw new Error("rating 操作需要 candidateSource 参数");
      if (!sourceChapter) throw new Error("rating 操作需要 sourceChapter 参数（可由 chapterId 推断）");
      {
        const lineageResolved = resolveLineageForStrategy(input.strategyId!, "rating");
        if (!lineageResolved.complete) {
          result = {
            recorded: false,
            outcome: "tie",
            weight: 0,
            decisionCount: 1,
            feedbackLevel: "natural_language_unattributed",
            reason: lineageResolved.reason,
            evidence: {
              evidenceId: lineageResolved.lineage.feedbackEventId,
              note: lineageResolved.reason,
            },
          };
          persistLedgerFromResult(input.strategyId!, result, lineageResolved, true);
        } else {
          result = ingestor.ingestRating(store, {
            context,
            rating: input.rating,
            candidateSource: input.candidateSource,
            note: input.note,
            lineage: lineageResolved.completeLineage,
            feedbackEventId: String(lineageResolved.lineage.feedbackEventId),
          });
          persistLedgerFromResult(input.strategyId!, result, lineageResolved);
        }
      }
      break;
    }
    case "status_override": {
      if (!input.status) throw new Error("status_override 操作需要 status 参数");
      if (!input.reason) throw new Error("status_override 操作需要 reason 参数");
      result = ingestor.applyStatusOverride(store, {
        strategyId: input.strategyId!,
        modelVersion,
        status: input.status,
        reason: input.reason,
      });
      break;
    }
    case "revert": {
      // 优先 evidenceId 定点撤销；兼容 revertLastOutcome
      if (input.feedbackEventId) {
        result = ingestor.revertOutcomeByEvidenceId(
          store,
          input.strategyId!,
          modelVersion,
          input.feedbackEventId,
        );
      } else {
        result = ingestor.revertLastOutcome(store, input.strategyId!, modelVersion);
      }
      // P7 旧真相源清理：撤销写账本 revoke（不再只直写 strategy-policy.json）。
      // 以实际被撤销 evidence 的 store evidenceId 为目标，与观测写入时一致；
      // 未真正撤销（reverted=false 或 evidence 缺失）不落账本。
      if (result?.reverted === true && result?.evidence?.evidenceId) {
        appendPublicFeedbackLedgerRevoke({
          workspaceId: input.workspaceId,
          projectRoot,
          evidenceId: result.evidence.evidenceId,
          reason: input.reason ?? result.reason,
        });
        // P6：撤销后从账本统一重算被撤销策略的信誉（账本为唯一真相源，
        // strategy-policy.json 只是可重建投影）。失败不阻断——保留 store 就地突变结果。
        recomputeStrategyReputationFromLedger({
          workspaceId: input.workspaceId,
          projectRoot,
          store,
          strategyId: input.strategyId!,
          modelVersion,
        });
      }
      break;
    }
    default:
      throw new Error(`未知 action：${input.action}`);
  }

  // 保存更新后的策略信誉库（原子保存 tmp→rename）
  saveStrategyPolicyStore(store, input.workspaceId, projectRoot);

  // P1 修复（审阅包回填）：显式 action 路径也回填 sidecar（若 chapterId + delta 可用）
  const backfillResult = await backfillReviewPackageIfAvailable(input, projectRoot, computedDelta);

  // naturalLanguageFeedbackAccepted / compiledFeedback 已在上方 P1-3 编译路径初始化
  // 显式 action 路径下，若同时提供了 naturalLanguageFeedback，compiledFeedback 作为可审计证据返回

  uninstallFeedbackTrustBridge();
  return {
    status: "ok",
    workspaceId: input.workspaceId,
    action: input.action!,
    strategyId: input.strategyId!,
    modelVersion,
    trustCategory: feedbackTrustCategory,
    nextRequestOnly: true,
    traceContext: traceContext
      ? {
          tracePath: traceContext.tracePath,
          inferredModelVersion: !input.modelVersion,
          inferredSelectedStrategyIds: !input.selectedStrategyIds?.length,
          inferredSourceChapter: !input.sourceChapter,
          hasCompleteLineage: lineageAuditState.value?.complete ?? false,
        }
      : null,
    result,
    /** Phase 4A：返回 computedDelta 供调用方审计 */
    userModificationDelta: computedDelta,
    /** P1 修复（审阅包回填）：sidecar 回填结果（status/reason）供调用方审计 */
    reviewPackageBackfill: backfillResult,
    /** Phase 4D（P1-3）：自然语言反馈接收状态与编译结果（可审计） */
    naturalLanguageFeedbackAccepted,
    /** USER-FEEDBACK-EVIDENCE-PIPELINE-1：血缘与 ledger 审计 */
    lineageAudit: lineageAuditState.value,
    ...(compiledFeedback ? { compiledFeedback } : {}),
  };
}

// ============================================================================
// P1 修复（审阅包回填）：sidecar 回填辅助
// ============================================================================

/**
 * 若提供了 chapterId 且 computedDelta 可用，调用 backfillAuthorStyleReviewPackage
 * 把用户修改差分回填到 sidecar review-package.json。
 *
 * 设计：
 * - chapterId 或 computedDelta 缺失 → 返回 skipped（不阻断反馈记录）
 * - sidecar 不存在 → 返回 not_found（章节可能未走统一主链路，或预览模式未持久化）
 * - 回填成功 → 返回 ok + 更新后的 package 路径
 * - 回填异常 → 返回 error（不阻断反馈记录，仅记录失败原因）
 *
 * 动态 import 编排器模块，避免 handlers → v2/core 的编译期硬依赖。
 */
async function backfillReviewPackageIfAvailable(
  input: { chapterId?: string; workspaceId: string },
  projectRoot: string,
  computedDelta: unknown,
): Promise<{
  status: "ok" | "not_found" | "error" | "skipped";
  reason: string;
  filePath?: string;
}> {
  if (!input.chapterId) {
    return { status: "skipped", reason: "未提供 chapterId，跳过 sidecar 回填" };
  }
  if (!computedDelta) {
    return { status: "skipped", reason: "未计算 userModificationDelta（需提供 userFinalText + deliveredText）" };
  }
  try {
    const { backfillAuthorStyleReviewPackage } = await import(
      "../v2/core/unified-orchestrator.js"
    );
    const result = backfillAuthorStyleReviewPackage({
      projectRoot,
      workspaceId: input.workspaceId,
      chapterId: input.chapterId,
      delta: computedDelta as import("../v2/learning/user-modification-delta.js").UserModificationDelta,
    });
    return {
      status: result.status,
      reason: result.reason,
      ...(result.filePath ? { filePath: result.filePath } : {}),
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "error", reason: `回填模块加载/执行失败：${msg}` };
  }
}
