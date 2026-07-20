/**
 * ChapterProxyApprovalFeedbackIngestor - 用户反馈接入策略证据（G7-Feedback-Ingestor，计划 §12.2）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §12.2 line 587
 *
 * 把 chapter-approvals/feedback.jsonl 中的用户决策记录转化为 UserFeedbackIngestor
 * 能消费的 evidence，写入 strategy-policy.json。
 *
 * 反馈映射规则（计划 §12.2 §7.2）：
 * - accept + proxyRecommendedSource=editorial -> ingestChoice(chosen=editorial) -> win
 * - accept + proxyRecommendedSource=raw      -> ingestChoice(chosen=raw)      -> loss
 * - accept_with_edits                        -> ingestEdit(deliveredSource=editorial, modified=true, editDistance)
 * - reject                                   -> ingestChoice(chosen=raw)      -> loss
 * - rollback / inspect                        -> 跳过（post-hoc undo / 只读）
 *
 * editDistance 计算（计划 §7.2 §7.3）：
 * - editedTextDiff.lengthDelta / max(originalLength, 1) -> 0-1 区间的修改幅度
 * - >= 0.3 触发 HEAVY_EDIT_BONUS（额外 +1 权重，由 UserFeedbackIngestor 内部判定）
 *
 * 去重机制：
 * - alreadyIngestedApprovalIds 集合标识已摄入的 approvalId
 * - 同一 approvalId 只摄入一次（防止重复计数）
 * - 调用方持久化已摄入集合，下次调用传入跳过
 *
 * StrategyContext 解析（计划 §7.3）：
 * - feedback.jsonl 不携带 strategyId/modelVersion/opportunityType
 * - 调用方提供 contextResolver: (record) => StrategyContext | null
 *   * 返回 null -> 跳过（无策略上下文无法归因）
 *   * 返回 context -> 摄入 evidence
 * - 实际生产接线由调用方从 pending draft 元数据 / orchestratorInput 派生 context
 *
 * 边界（READY_LOCAL）：
 * - 闭包自包含（仅依赖 governance sibling + learning sibling）
 * - 不调用模型、不修改 feedback.jsonl、不修改 pending draft checkpoint
 * - 唯一副作用：写入 strategy-policy.json（通过 saveStrategyPolicyStore 原子保存）
 * - 可安全进入生产闭包（dist/）与 dist-test 闭包
 */

import {
  loadProxyApprovalFeedback,
  type ProxyApprovalFeedbackRecord,
} from "./chapter-proxy-approval-feedback-recorder.js";
import {
  UserFeedbackIngestor,
  createUserFeedbackIngestor,
} from "../learning/user-feedback-ingestor.js";
import {
  loadStrategyPolicyStore,
  saveStrategyPolicyStore,
  type StrategyPolicyStore,
} from "../learning/strategy-policy-store.js";
import type { StrategyContext, RecordedOutcome } from "../learning/strategy-outcome-recorder.js";

// ============================================================================
// 类型
// ============================================================================

/**
 * 策略上下文解析器：从反馈记录解析 StrategyContext。
 *
 * feedback.jsonl 不携带 strategyId/modelVersion 等字段（这些是编排器状态，
 * 不应在反馈记录中冗余存储）。调用方提供解析器：
 * - 生产接线：从 pending draft 元数据 / orchestratorInput 派生
 * - 测试场景：固定返回同一 context（fixedContextResolver）
 *
 * 返回 null 表示该记录无法归因到任何策略（应跳过，不摄入 evidence）。
 */
export type StrategyContextResolver = (
  record: ProxyApprovalFeedbackRecord,
) => StrategyContext | null;

/** 单条摄入选项 */
export interface IngestProxyApprovalFeedbackOptions {
  /** workspace 路径（workspaces/{workspaceId}） */
  workspacePath: string;
  /** workspace ID（用于 strategy-policy.json 路径解析） */
  workspaceId: string;
  /** project root（用于 strategy-policy.json 路径解析） */
  projectRoot: string;
  /** 策略上下文解析器 */
  contextResolver: StrategyContextResolver;
  /** 可选：已摄入的 approvalId 集合（去重；本次调用会追加新的 approvalId） */
  alreadyIngestedApprovalIds?: Set<string>;
  /** 可选：注入 store（测试用），未提供时从文件加载 */
  store?: StrategyPolicyStore;
  /** 可选：注入 ingestor（测试用），未提供时创建默认 */
  ingestor?: UserFeedbackIngestor;
  /** 可选：只摄入指定 chapterId 的反馈 */
  chapterId?: string;
}

/** 单条摄入结果 */
export interface IngestProxyApprovalFeedbackResult {
  /** 实际摄入的记录数 */
  ingestedCount: number;
  /** 跳过的记录数 */
  skippedCount: number;
  /** 已摄入的 approvalId 集合（包含传入的 + 本次新增的） */
  ingestedApprovalIds: string[];
  /** 跳过原因（按 approvalId 索引） */
  skippedReasons: Array<{ approvalId: string; reason: SkipReason }>;
  /** 每条记录的 ingest 结果（仅 ingested 的） */
  outcomes: RecordedOutcome[];
  /** 持久化后的策略信誉存储（已 save 到 strategy-policy.json） */
  store: StrategyPolicyStore;
}

/** 跳过原因 */
export type SkipReason =
  | "already_ingested"
  | "no_strategy_context"
  | "unsupported_action";

/** 批量摄入选项（与单条相同，但消费整个 feedback.jsonl） */
export interface IngestAllProxyApprovalFeedbackOptions
  extends IngestProxyApprovalFeedbackOptions {}

/** 批量摄入结果（与单条相同） */
export type IngestAllProxyApprovalFeedbackResult = IngestProxyApprovalFeedbackResult;

// ============================================================================
// 反馈 -> ingest 信号映射
// ============================================================================

/**
 * 把 ProxyApprovalFeedbackRecord 映射为 ingest 操作。
 *
 * 返回值约定：
 * - { kind: "choice", chosen, note } -> 调用 ingestChoice
 * - { kind: "edit", deliveredSource, modified, editDistance, note } -> 调用 ingestEdit
 * - { kind: "skip", reason } -> 跳过（rollback/inspect）
 *
 * 映射规则（计划 §12.2 §7.2）：
 * - accept + proxyRecommended=editorial -> choice(chosen=editorial) win
 * - accept + proxyRecommended=raw      -> choice(chosen=raw) loss
 * - accept_with_edits                  -> edit(deliveredSource=editorial, modified=true, editDistance)
 * - reject                             -> choice(chosen=raw) loss
 * - rollback / inspect                 -> skip
 */
function mapFeedbackToIngestSignal(record: ProxyApprovalFeedbackRecord):
  | {
      kind: "choice";
      chosen: "editorial" | "raw";
    }
  | {
      kind: "edit";
      deliveredSource: "editorial" | "raw" | "fallback";
      modified: boolean;
      editDistance?: number;
    }
  | {
      kind: "skip";
      reason: SkipReason;
    } {
  switch (record.action) {
    case "accept": {
      // accept: 用户接受代理审批稿。proxyJudgmentBias.proxyRecommendedSource 标识
      // 代理推荐的是 raw 还是 editorial；用户 accept = 用户采纳该推荐。
      // 对 editorial strategy 而言：
      //   - accept + proxyRecommended=editorial -> win
      //   - accept + proxyRecommended=raw      -> loss（用户与代理一致选 raw，等于拒绝 editorial）
      //
      // 不传 note：让 UserFeedbackIngestor 生成默认 note（含"用户明确选择 editorial/raw"）。
      // approvalId 已在 feedback.jsonl 中持久化；strategy-policy.json evidence 通过
      // sourceChapter + timestamp 与 feedback 记录关联，无需在 note 中冗余。
      const recommended = record.proxyJudgmentBias.proxyRecommendedSource;
      const chosen: "editorial" | "raw" =
        recommended === "raw" ? "raw" : "editorial";
      return {
        kind: "choice",
        chosen,
      };
    }
    case "accept_with_edits": {
      // 用户修改了 editorial 交付稿 -> loss（修改幅度反映否定强度）
      // 不传 note：让 UserFeedbackIngestor 生成默认 note（含"重度修改 editDistance=..."）。
      const diff = record.editedTextDiff;
      let editDistance: number | undefined;
      if (diff && diff.originalLength > 0) {
        // 修改幅度 = |lengthDelta| / max(originalLength, 1)
        // 使用绝对值：用户加字/删字都是修改（不区分方向）
        editDistance = Math.abs(diff.lengthDelta) / Math.max(diff.originalLength, 1);
      }
      return {
        kind: "edit",
        deliveredSource: "editorial",
        modified: true,
        editDistance,
      };
    }
    case "reject": {
      // 用户拒绝代理审批稿 -> 等于选择 raw -> loss
      return {
        kind: "choice",
        chosen: "raw",
      };
    }
    case "rollback": {
      // rollback 是事后撤销，不直接映射为 evidence（需要人工决策是否撤回之前的 evidence）
      return { kind: "skip", reason: "unsupported_action" };
    }
    case "inspect": {
      // inspect 是只读操作，不产生 evidence
      return { kind: "skip", reason: "unsupported_action" };
    }
    default: {
      return { kind: "skip", reason: "unsupported_action" };
    }
  }
}

// ============================================================================
// 单条摄入
// ============================================================================

/**
 * 摄入单条 ProxyApprovalFeedbackRecord 到策略信誉存储。
 *
 * 流程：
 * 1. 解析 StrategyContext（contextResolver）；无 context -> 跳过
 * 2. 映射反馈为 ingest 信号（accept/accept_with_edits/reject/rollback/inspect）
 * 3. 调用 UserFeedbackIngestor 对应方法，写入 store
 * 4. 持久化 store（saveStrategyPolicyStore 原子保存）
 *
 * 返回摄入结果（含 outcomes / ingestedApprovalIds / skippedReasons）。
 */
export function ingestProxyApprovalFeedbackToStrategy(
  options: IngestProxyApprovalFeedbackOptions,
): IngestProxyApprovalFeedbackResult {
  const {
    workspacePath,
    workspaceId,
    projectRoot,
    contextResolver,
    alreadyIngestedApprovalIds,
    chapterId,
  } = options;

  // 加载或注入 store
  const store = options.store ?? loadStrategyPolicyStore(workspaceId, projectRoot);
  const ingestor = options.ingestor ?? createUserFeedbackIngestor();

  // 复制传入的已摄入集合（不修改入参 Set）
  const ingestedApprovalIds = new Set<string>(alreadyIngestedApprovalIds ?? []);
  const skippedReasons: Array<{ approvalId: string; reason: SkipReason }> = [];
  const outcomes: RecordedOutcome[] = [];

  // 加载所有 feedback（可选按 chapterId 过滤）
  const records = loadProxyApprovalFeedback(workspacePath, chapterId);

  for (const record of records) {
    // 1. 去重检查
    if (ingestedApprovalIds.has(record.approvalId)) {
      skippedReasons.push({
        approvalId: record.approvalId,
        reason: "already_ingested",
      });
      continue;
    }

    // 2. 解析 strategy context
    const context = contextResolver(record);
    if (context === null) {
      skippedReasons.push({
        approvalId: record.approvalId,
        reason: "no_strategy_context",
      });
      continue;
    }

    // 3. 映射为 ingest 信号
    const signal = mapFeedbackToIngestSignal(record);
    if (signal.kind === "skip") {
      skippedReasons.push({
        approvalId: record.approvalId,
        reason: signal.reason,
      });
      continue;
    }

    // 4. 调用 ingestor 写入 store
    let outcome: RecordedOutcome;
    if (signal.kind === "choice") {
      outcome = ingestor.ingestChoice(store, {
        context,
        chosen: signal.chosen,
      });
    } else {
      // signal.kind === "edit"
      outcome = ingestor.ingestEdit(store, {
        context,
        deliveredSource: signal.deliveredSource,
        modified: signal.modified,
        editDistance: signal.editDistance,
      });
    }

    if (outcome.recorded) {
      outcomes.push(outcome);
      ingestedApprovalIds.add(record.approvalId);
    } else {
      // recorded=false 表示无明确信号（如 modified=false）；不计入 ingested，
      // 但也不视为 skip（这是 ingestor 的正常 tie 处理，不应污染 evidence log）
      // 实际上：accept_with_edits 总是 modified=true（用户明确提交了 editedText），
      // 所以这里只在异常情况下达到。为安全起见，记录为 unsupported_action。
      skippedReasons.push({
        approvalId: record.approvalId,
        reason: "unsupported_action",
      });
    }
  }

  // 5. 持久化 store（即使无新增 evidence 也保存，确保 schema 一致）
  saveStrategyPolicyStore(store, workspaceId, projectRoot);

  return {
    ingestedCount: outcomes.length,
    skippedCount: skippedReasons.length,
    ingestedApprovalIds: Array.from(ingestedApprovalIds),
    skippedReasons,
    outcomes,
    store,
  };
}

// ============================================================================
// 批量摄入（语义与单条相同；保留独立函数名便于调用方语义清晰）
// ============================================================================

/**
 * 批量摄入所有 feedback.jsonl 中的记录到策略信誉存储。
 *
 * 与 ingestProxyApprovalFeedbackToStrategy 同实现，函数名保留独立以表达
 * "消费整个 feedback.jsonl" 的语义（与单条按 chapterId 过滤的场景区分）。
 */
export function ingestAllProxyApprovalFeedback(
  options: IngestAllProxyApprovalFeedbackOptions,
): IngestAllProxyApprovalFeedbackResult {
  return ingestProxyApprovalFeedbackToStrategy(options);
}
