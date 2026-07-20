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

// ============================================================================
// novel_generate_chapter — 统一主链路唯一入口
// ============================================================================

/**
 * 始终调用统一编排器：raw → editorial → judge → select → commit
 *
 * 生产入口不包含 __forceLegacyChain 检查（该标志仅由 legacy_test 工具设置）。
 * 失败由编排器内部降级（raw → hard block），不静默回退 legacy。
 */
export async function handleGenerateChapter(input: {
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  outline?: string;
  previousChapterSummary?: string;
  styleProfile?: string;
  recoverBlockedRaw?: boolean;
  /**
   * @deprecated 被 fullPipelinePreview 取代（旧短路径在 FactGuard 后直接返回 raw）。
   * 入口 normalize 为 fullPipelinePreview，等价于完整链路只读预览。
   */
  previewOnly?: boolean;
  /**
   * FULL-PIPELINE-PREVIEW-1：完整链路只读预览。
   * 执行完整 raw→editorial→judge→select 链路，但跳过所有副作用（不写章节、不提交状态、不写 trace）。
   */
  fullPipelinePreview?: boolean;
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
   * - undefined   → 走默认 Doubao 主路由。
   *
   * 仅影响本次生成，不污染全局配置。P26/P28 所有门禁照常执行。
   */
  modelTestRoute?: "doubao" | "glm" | "gpt" | "deepseek" | "claude";
  /**
   * P30 新增：StyleShaper 路由（保守默认 "claude"）。
   *
   * - "claude"（默认）→ Stage 5/8 StyleShaper 走 style_shaper 主路由（Claude）。
   * - "doubao"/"ernie"/"glm"/"gpt"/"deepseek"/"qwen" → 走 style_shaper_testing_<model> 测试路由。
   *
   * 建议先保守：Stage 2 用 Doubao、Stage 5 仍用 Claude，避免 Doubao StyleShaper 二次污染。
  /**
   * P31 新增（P39 扩展为 6 模型）：Stage 2.7 中文自然化 patch 开关。
   *
   * - "doubao"/"ernie"/"glm"/"gpt"/"deepseek"/"qwen" → Stage 2 初稿成功后、Stage 5 之前
   *              插入条件阶段 ChineseNaturalizer：只做受约束中文自然化 patch，
   *              不重写剧情；patch 必须通过 StructuralLockComparator +
   *              PatchQualityComparator 双重验收，被拒绝时保留 Claude 原段。
   * - undefined → 不启用 Stage 2.7（生产默认，保持 Claude 单模型链路）。
   *
   * 仅影响本次生成，不污染全局配置；不改 .env、不改生产主路由（默认 Doubao）。
  /**
   * P31 guard: fusion replay only. When true, Stage 2 must use Claude and
   * must fail with "Claude unavailable" if narrator_primary falls back.
   */
  /**
   * REAL-QUALITY-1-PREFLIGHT：随机种子（judge 匿名化 + Thompson Sampling 策略筛选可复现）。
   *
   * 传入使 editorial 候选生成可复现（seed=1 时 sample≈0.6271≥0.5，策略被选中→生成 editorial 候选）。
   * 未传时使用 Math.random（策略筛选 50% 概率）。
   */
  seed?: number;
}) {
  const {
    workspaceId, chapterId, chapterNumber,
    modelTestRoute,
    seed,
  } = input;

  // ============================================================================
  // 统一主链路 — 唯一生产路径（计划 §Phase 5/7）
  // novel_generate_chapter 始终调用统一编排器：raw → editorial → judge → select → commit
  // - 无 whitelist：所有 workspace/chapter 走统一入口
  // - 无 generationMode：不再有 legacy/v2 双模式
  // - 无 v2NotImplemented → legacy 回退：失败由编排器内部降级（raw → hard block）
  // - 无 PINOVEL_UNIFIED_PIPELINE 环境变量：生产路径无回滚分支
  // - 无 __forceLegacyChain 检查：生产入口始终走统一主链路
  // ============================================================================
  const _unifiedProjectRoot = (input as any)._projectRoot || getProjectRoot();
  try {
    const { runUnifiedPipeline } = await import("../v2/core/unified-entry.js");
    const _unifiedResult = await runUnifiedPipeline({
      workspaceId,
      chapterId,
      chapterNumber,
      projectRoot: _unifiedProjectRoot,
      modelTestRoute,
      recoverBlockedRaw: input.recoverBlockedRaw,
      previewOnly: input.previewOnly,
      fullPipelinePreview: input.fullPipelinePreview,
      // REAL-QUALITY-1-PREFLIGHT：seed 透传到统一编排器（judge 匿名化 + Thompson 可复现）
      seed,
      onUpdate: (input as any).__onUpdate,
    });
    return _unifiedResult as any;
  } catch (e: any) {
    // 统一主链路加载/执行失败：不静默回退 legacy，结构化阻断
    // （计划 §Phase 5：无 silent legacy fallback）
    // 编排器内部失败（raw 生成失败等）已在 orchestrator 内降级为 hard block，
    // 此处仅捕获 entry/orchestrator 层未预期异常。
    process.stderr.write(
      `[Unified] 主链路执行失败：${e?.message ?? e}\n`
    );
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
        severity: "fatal",
        reason: `统一主链路执行失败：${e?.message ?? e}`,
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
  action: "choice" | "edit" | "rating" | "status_override" | "revert";
  strategyId: string;
  modelVersion: string;
  sourceChapter?: string;
  opportunityType?: string;
  chosen?: "editorial" | "raw";
  deliveredSource?: "editorial" | "raw" | "fallback";
  modified?: boolean;
  editDistance?: number;
  rating?: number;
  candidateSource?: "editorial" | "raw";
  status?: "active" | "dormant" | "retired";
  reason?: string;
  note?: string;
}): Promise<any> {
  const projectRoot = (input as any)._projectRoot || getProjectRoot();
  const {
    loadStrategyPolicyStore,
    saveStrategyPolicyStore,
  } = await import("../v2/learning/strategy-policy-store.js");
  const { createUserFeedbackIngestor } = await import(
    "../v2/learning/user-feedback-ingestor.js"
  );

  const store = loadStrategyPolicyStore(input.workspaceId, projectRoot);
  const ingestor = createUserFeedbackIngestor();
  let result: any;

  // 公共上下文（choice/edit/rating 需要 sourceChapter + opportunityType）
  const context = {
    sourceChapter: input.sourceChapter ?? "",
    modelVersion: input.modelVersion,
    strategyId: input.strategyId,
    opportunityType: input.opportunityType ?? "",
  };

  switch (input.action) {
    case "choice": {
      if (!input.chosen) throw new Error("choice 操作需要 chosen 参数");
      if (!input.sourceChapter) throw new Error("choice 操作需要 sourceChapter 参数");
      result = ingestor.ingestChoice(store, {
        context,
        chosen: input.chosen,
        note: input.note,
      });
      break;
    }
    case "edit": {
      if (!input.sourceChapter) throw new Error("edit 操作需要 sourceChapter 参数");
      if (input.modified === undefined) throw new Error("edit 操作需要 modified 参数");
      if (!input.deliveredSource) throw new Error("edit 操作需要 deliveredSource 参数");
      result = ingestor.ingestEdit(store, {
        context,
        deliveredSource: input.deliveredSource,
        modified: input.modified,
        editDistance: input.editDistance,
        note: input.note,
      });
      break;
    }
    case "rating": {
      if (input.rating === undefined) throw new Error("rating 操作需要 rating 参数");
      if (!input.candidateSource) throw new Error("rating 操作需要 candidateSource 参数");
      if (!input.sourceChapter) throw new Error("rating 操作需要 sourceChapter 参数");
      result = ingestor.ingestRating(store, {
        context,
        rating: input.rating,
        candidateSource: input.candidateSource,
        note: input.note,
      });
      break;
    }
    case "status_override": {
      if (!input.status) throw new Error("status_override 操作需要 status 参数");
      if (!input.reason) throw new Error("status_override 操作需要 reason 参数");
      result = ingestor.applyStatusOverride(store, {
        strategyId: input.strategyId,
        modelVersion: input.modelVersion,
        status: input.status,
        reason: input.reason,
      });
      break;
    }
    case "revert": {
      result = ingestor.revertLastOutcome(store, input.strategyId, input.modelVersion);
      break;
    }
    default:
      throw new Error(`未知 action：${input.action}`);
  }

  // 保存更新后的策略信誉库（原子保存 tmp→rename）
  saveStrategyPolicyStore(store, input.workspaceId, projectRoot);

  return {
    status: "ok",
    workspaceId: input.workspaceId,
    action: input.action,
    strategyId: input.strategyId,
    modelVersion: input.modelVersion,
    result,
  };
}
