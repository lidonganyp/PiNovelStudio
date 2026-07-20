/**
 * ChapterProxyApprovalFinalizationTrigger - 反馈摄入/健康归集生产触发时机（G7-Finalization-Trigger，计划 §12.2）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §12.2
 *        docs/remaining-development-dispatch-plan-20260715.md §0.2
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 触发时机设计文档（计划 §0.2 objective）
 * ════════════════════════════════════════════════════════════════════════════
 * 目标：使反馈摄入/健康归集的内部调用链从"可被 handler 调用"升级为"生产自动触发"。
 *
 * 生产事件 → 触发函数映射：
 *
 * 1. 用户定稿完成（accept / accept_with_edits / reject / rollback）
 *    -> triggerFinalizationWithFeedbackAndHealth（本模块）
 *    -> runFinalization（记录 feedback.jsonl + commitAndSave + FinalStateCommit）
 *    -> ingestProxyApprovalFeedbackToStrategy（提供 strategyContext 时；把 feedback 摄入 strategy-policy.json）
 *    -> aggregateReleaseHealth（始终；只读聚合 release 健康报告）
 *
 *    理由：用户定稿是产生新 feedback 记录的唯一生产事件。runFinalization 在
 *    commitAndSave 成功后追加 feedback 到 feedback.jsonl（P1 失败反馈污染防护：
 *    commitAndSave 失败时不记录 accept 成功反馈）。紧随其后的 ingest 才能消费
 *    到"已交付"的 feedback，避免把未交付结果摄入策略信誉存储。health 在 ingest
 *    之后运行，才能反映 ingest 刚写入的 strategy-policy.json 快照。
 *
 * 2. 章节交付 / 定时聚合（无新 feedback，只读快照）
 *    -> 直接调用 aggregateReleaseHealth（已通过 review-surface-cli 进入生产闭包）
 *
 *    理由：章节交付与定时聚合不产生新用户反馈，无需 ingest。aggregateReleaseHealth
 *    是只读幂等函数，可在任意生产事件后重复调用获取最新 release 健康快照，
 *    无副作用。故不为本路径新增包装函数（避免过度工程化）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 调用顺序保证（计划 §12.2）
 * ════════════════════════════════════════════════════════════════════════════
 * - runFinalization 必须先执行（记录 feedback 到 feedback.jsonl + commitAndSave）
 * - ingest 必须在 runFinalization 之后（才能看到新记录的 feedback）
 * - health 必须在 ingest 之后（才能反映 ingest 写入的 strategy-policy.json 快照）
 * - runFinalization 抛错时自然短路：控制流未到达 ingest/health，错误向上传播，不吞异常。
 *   ingest 未运行 -> strategy-policy.json 不被创建（可观测证据）。
 *
 * inspect 只读语义：
 * - inspect 不记录 feedback（runFinalization 内部：inspect 不调用 recordFinalizationFeedback）
 * - inspect 时 ingest 仍可被调用（消费历史 feedback），但不会摄入新记录 -> ingestedCount=0
 * - inspect 时 health 仍返回报告（只读快照，totalFeedbackRecords 反映历史）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 边界（READY_LOCAL，计划 §0.2 scope）
 * ════════════════════════════════════════════════════════════════════════════
 * - 不调用模型（runFinalization 的 checkCandidateFactGuard 是本地 FactContinuityGuard）
 * - 不生成章节正文（章节生成唯一入口仍是 novel_generate_chapter）
 * - 不修改统一编排器主流程（本模块是 finalization 调用链的触发封装，不接入 unified-orchestrator）
 * - 不新增公开工具（通过 review-surface-cli value import 进入生产闭包，不注册 MCP 工具）
 * - 不实际消费真实 gpt5.6-sol 授权预算（finalization 路径不调用 proxy-review runner）
 * - 闭包自包含（仅依赖 governance sibling），可安全进入生产闭包（dist/）与 dist-test 闭包
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 与 handleChapterProxyFinalization 的关系
 * ════════════════════════════════════════════════════════════════════════════
 * - handleChapterProxyFinalization（dist-test only）是方案 A 内部 handler，含 workspace 解析 +
 *   characterNames 加载 + 幂等键 + 显式确认 + revision 校验等生产入口治理逻辑。
 * - 本 trigger 模块是 finalization -> ingest -> health 调用链的纯触发封装，不含入口治理逻辑，
 *   供生产入口（CLI / handler / 未来统一编排器消费者）复用，避免每个消费者重复接线触发顺序。
 * - 本 trigger 不替代 handleChapterProxyFinalization；后者可内部委托本 trigger 实现触发顺序复用。
 * - 本 trigger 不进入统一编排器主流程（novel_generate_chapter 遇 pending 仅返回结构化阻断，
 *   绝不自动定稿）；定稿由用户显式触发。
 */

import {
  runFinalization,
  type FinalizationEntryAction,
  type FinalizationEntryResult,
} from "./chapter-proxy-approval-finalization-entry.js";
import {
  ingestProxyApprovalFeedbackToStrategy,
  type StrategyContextResolver,
  type IngestProxyApprovalFeedbackResult,
} from "./chapter-proxy-approval-feedback-ingestor.js";
import {
  aggregateReleaseHealth,
  type ReleaseHealthReport,
} from "./release-health-aggregator.js";
import type { ChapterProxyApprovalArtifact } from "./chapter-proxy-approval-types.js";
import type { StrategyContext } from "../learning/strategy-outcome-recorder.js";
import type { UnifiedOrchestratorInput } from "../core/orchestrator-types.js";
import type { commitAndSave } from "../core/orchestrator-commit-save.js";

// ============================================================================
// 类型
// ============================================================================

/**
 * 策略上下文（提供时触发 ingest）。
 *
 * feedback.jsonl 不携带 strategyId/modelVersion/opportunityType（这些是编排器状态，
 * 不在反馈记录中冗余存储）。调用方通过此字段提供，trigger 内部派生
 * StrategyContextResolver（sourceChapter 从 chapterNumber 派生为 ch{N}）。
 *
 * 未提供时跳过 ingest（但仍返回 health 报告）。
 */
export interface TriggerStrategyContext {
  strategyId: string;
  modelVersion: string;
  opportunityType: string;
}

/**
 * 触发时机入口选项。
 *
 * runFinalization 输入字段透传（workspacePath/chapterId/approvalId/action/editedText/
 * orchestratorInput/proxyRecommendedSource/approvalArtifact/commitAndSaveFn）；
 * ingest 输入字段（workspaceId/projectRoot/chapterNumber/strategyContext）由本触发器消费。
 */
export interface FinalizationTriggerOptions {
  // ── runFinalization 透传字段 ──────────────────────────────────────────
  /** workspace 路径（workspaces/{workspaceId}） */
  workspacePath: string;
  /** 章节 ID */
  chapterId: string;
  /** 审批 ID（与 ChapterProxyApprovalArtifact.approvalId 一致） */
  approvalId: string;
  /** 定稿动作（accept/accept_with_edits/reject/rollback/inspect） */
  action: FinalizationEntryAction;
  /** accept_with_edits 时用户修改后的正文（其他 action 忽略） */
  editedText?: string;
  /** 统一编排器输入（供 checkCandidateFactGuard + commitAndSave 使用） */
  orchestratorInput: UnifiedOrchestratorInput;
  /** 代理推荐的候选来源（未提供时从 pending draft 的 selectedSource 读取） */
  proxyRecommendedSource?: string;
  /** inspect 动作所需的审批 artifact（仅 action="inspect" 时必填） */
  approvalArtifact?: ChapterProxyApprovalArtifact;
  /** 可选 commitAndSave 注入（依赖注入，主要供测试 mock 失败场景使用） */
  commitAndSaveFn?: typeof commitAndSave;

  // ── ingest + health 字段 ──────────────────────────────────────────────
  /** workspace ID（用于 strategy-policy.json 路径解析） */
  workspaceId: string;
  /** project root（用于 strategy-policy.json 路径解析） */
  projectRoot: string;
  /** 章节序号（派生 sourceChapter=ch{N}） */
  chapterNumber: number;
  /**
   * 策略上下文（提供时调用 ingestProxyApprovalFeedbackToStrategy 接入策略证据）。
   * 未提供时跳过 ingest（但仍返回 health 报告）。
   */
  strategyContext?: TriggerStrategyContext;
}

/**
 * 触发时机入口结果。
 */
export interface FinalizationTriggerResult {
  /** runFinalization 结果（定稿操作 + commitAndSave + feedback 记录） */
  finalization: FinalizationEntryResult;
  /**
   * ingest 结果（提供 strategyContext 时存在；否则 undefined）。
   * 即使 inspect（不记录 feedback）也会调用 ingest（消费历史 feedback），
   * 此时 ingestedCount=0。
   */
  feedbackIngest?: IngestProxyApprovalFeedbackResult;
  /** release 健康报告（始终存在；只读聚合） */
  releaseHealth: ReleaseHealthReport;
}

// ============================================================================
// 辅助：构建 StrategyContextResolver
// ============================================================================

/**
 * 从调用方提供的 strategyContext 派生 StrategyContextResolver。
 *
 * feedback.jsonl 不携带 strategyId/modelVersion/opportunityType，
 * 调用方通过 strategyContext 提供；sourceChapter 从 chapterNumber 派生（ch{N}）。
 *
 * 返回的 resolver 对所有 feedback 记录返回同一 StrategyContext
 * （finalization 路径下，单次调用只产生一条 feedback 记录）。
 *
 * 与 handleChapterProxyFinalization.buildStrategyContextResolver 同实现，
 * 保证 trigger 与 handler 的策略上下文派生语义一致。
 */
function buildStrategyContextResolver(
  strategyContext: TriggerStrategyContext,
  chapterNumber: number,
): StrategyContextResolver {
  const sourceChapter = `ch${chapterNumber}`;
  return (): StrategyContext => ({
    sourceChapter,
    modelVersion: strategyContext.modelVersion,
    strategyId: strategyContext.strategyId,
    opportunityType: strategyContext.opportunityType,
  });
}

// ============================================================================
// triggerFinalizationWithFeedbackAndHealth - 生产触发时机入口
// ============================================================================

/**
 * 用户定稿完成 -> ingest（提供 strategyContext 时）-> health（始终）生产触发入口。
 *
 * 调用链（计划 §0.2 / §12.2）：
 *   runFinalization -> [strategyContext] ingestProxyApprovalFeedbackToStrategy -> aggregateReleaseHealth
 *
 * 调用顺序保证：
 * - runFinalization 先执行：记录 feedback.jsonl + commitAndSave + FinalStateCommit
 * - ingest 后执行：消费 runFinalization 新记录的 feedback，写入 strategy-policy.json
 * - health 最后执行：聚合 feedback.jsonl + strategy-policy.json 快照
 *
 * 错误传播：
 * - runFinalization 抛错时（如 inspect 无 approvalArtifact），控制流未到达 ingest/health，
 *   错误向上传播，不吞异常。ingest 未运行 -> strategy-policy.json 不被创建（可观测证据）。
 * - ingest/health 内部错误（如 strategy-policy.json 解析失败）由各自模块处理；
 *   ingest 不抛错（loadStrategyPolicyStore 容错），health 不抛错（纯只读聚合）。
 *
 * @param options 触发时机入口选项
 * @returns finalization + feedbackIngest? + releaseHealth
 * @throws 当 runFinalization 抛错时（如 inspect 无 approvalArtifact / accept_with_edits 无 editedText）
 */
export function triggerFinalizationWithFeedbackAndHealth(
  options: FinalizationTriggerOptions,
): FinalizationTriggerResult {
  const {
    workspacePath,
    chapterId,
    approvalId,
    action,
    editedText,
    orchestratorInput,
    proxyRecommendedSource,
    approvalArtifact,
    commitAndSaveFn,
    workspaceId,
    projectRoot,
    chapterNumber,
    strategyContext,
  } = options;

  // ── 1. runFinalization（记录 feedback + commitAndSave + FinalStateCommit） ──
  // 抛错时自然短路：控制流未到达 ingest/health，错误向上传播。
  const finalization = runFinalization({
    workspacePath,
    chapterId,
    approvalId,
    action,
    editedText,
    orchestratorInput,
    proxyRecommendedSource,
    approvalArtifact,
    commitAndSaveFn,
  });

  // ── 2. ingest（提供 strategyContext 时；消费 runFinalization 新记录的 feedback） ──
  // ingest 在 runFinalization 之后运行，才能看到新记录的 feedback。
  // 即使 inspect（不记录 feedback）也调用 ingest（消费历史 feedback），ingestedCount=0。
  let feedbackIngest: IngestProxyApprovalFeedbackResult | undefined;
  if (strategyContext) {
    const contextResolver = buildStrategyContextResolver(strategyContext, chapterNumber);
    feedbackIngest = ingestProxyApprovalFeedbackToStrategy({
      workspacePath,
      workspaceId,
      projectRoot,
      contextResolver,
    });
  }

  // ── 3. aggregateReleaseHealth（始终；只读聚合 release 健康报告） ──
  // health 在 ingest 之后运行，才能反映 ingest 刚写入的 strategy-policy.json 快照。
  const releaseHealth = aggregateReleaseHealth(workspacePath, {
    workspaceId,
    projectRoot,
  });

  return {
    finalization,
    feedbackIngest,
    releaseHealth,
  };
}
