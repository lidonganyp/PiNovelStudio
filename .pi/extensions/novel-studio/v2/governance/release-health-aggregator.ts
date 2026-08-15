/**
 * ReleaseHealthAggregator - release 健康报告归集（G7-Release-Health，计划 §12.2）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §12.2 line 587
 *
 * 只读聚合 release 健康状态：归集所有 chapter 的用户反馈记录 + 策略信誉快照，
 * 生成 release 健康报告。
 *
 * 报告内容：
 * - 总反馈记录数 + action 分桶（accept/accept_with_edits/reject/inspect/rollback）
 * - 代理判断偏差统计（aligned/misaligned/alignmentRate）
 * - 用户修改统计（editedApprovals/averageEditDistance/heavyEdits）
 * - FactGuard 通过率（仅 accept_with_edits 记录有 factGuardPassed 字段）
 * - rollback 统计
 * - 策略信誉快照（按 modelVersion/strategyId 列出 alpha/beta/sampleCount/winRate/status）
 *
 * 设计原则：
 * - 只读：不修改 feedback.jsonl / strategy-policy.json / 任何文件
 * - 无副作用：纯聚合函数，可重复调用
 * - 空 workspace 安全：无 feedback / 无 strategy-policy 时返回全零报告
 *   * alignmentRate = 0（不是 NaN）
 *   * averageEditDistance / passRate = null（明确表达"无数据"语义）
 * - 不调用模型
 *
 * 边界（READY_LOCAL）：
 * - 闭包自包含（仅依赖 governance sibling + learning sibling）
 * - 可安全进入生产闭包（dist/）与 dist-test 闭包
 */

import { join } from "node:path";

import {
  loadProxyApprovalFeedback,
  type ProxyApprovalFeedbackRecord,
  type FeedbackAction,
} from "./chapter-proxy-approval-feedback-recorder.js";
import {
  createChapterProxyApprovalRegistry,
} from "./chapter-proxy-approval-registry.js";
import type { ChapterProxyApprovalArtifact } from "./chapter-proxy-approval-types.js";
import {
  loadStrategyPolicyStore,
  type StrategyPolicyStore,
  type StrategyReputation,
  type StrategyStatus,
} from "../learning/strategy-policy-store.js";
import { HEAVY_EDIT_DISTANCE_THRESHOLD } from "../learning/user-feedback-ingestor.js";
import {
  type CostStats,
  readChapterCostStats,
  mergeCostStats,
} from "./chapter-cost-snapshot.js";

// ============================================================================
// 向后兼容 re-export：cost snapshot 功能已抽取到 chapter-cost-snapshot.ts
// 现有 import 路径（如 chapter-proxy-approval-finalization-entry.ts）无需修改。
// 仅 import 文件体内实际使用的符号（CostStats / readChapterCostStats / mergeCostStats）；
// 其余公开符号通过 re-export 直接透传，不需要本地 import 绑定。
// ============================================================================
export {
  type CostStats,
  type ChapterCostSnapshot,
  type TraceModelCall,
  CHAPTER_COST_SNAPSHOT_SCHEMA_ID,
  CHAPTER_COST_SNAPSHOT_SCHEMA_VERSION,
  writeChapterCostSnapshot,
  computeChapterCostSnapshotFromTrace,
} from "./chapter-cost-snapshot.js";

// ============================================================================
// 类型
// ============================================================================

/** action 分桶计数 */
export interface ActionBreakdown {
  accept: number;
  accept_with_edits: number;
  reject: number;
  inspect: number;
  rollback: number;
}

/** 代理判断偏差统计 */
export interface AlignmentStats {
  /** 代理推荐与用户决策一致的数量 */
  aligned: number;
  /** 代理推荐与用户决策不一致的数量 */
  misaligned: number;
  /** 一致率（aligned / (aligned + misaligned)）；无数据时为 0 */
  alignmentRate: number;
}

/** 用户修改统计（仅 accept_with_edits 记录） */
export interface EditStats {
  /** 用户修改的审批数（accept_with_edits） */
  editedApprovals: number;
  /** 平均修改幅度（editDistance）；无修改记录时为 null */
  averageEditDistance: number | null;
  /** 重度修改数量（editDistance >= HEAVY_EDIT_DISTANCE_THRESHOLD=0.3） */
  heavyEdits: number;
}

/** FactGuard 通过率统计（仅 accept_with_edits 记录有 factGuardPassed 字段） */
export interface FactGuardStats {
  /** FactGuard 重跑总次数 */
  total: number;
  /** 通过次数 */
  passed: number;
  /** 阻断次数 */
  blocked: number;
  /** 通过率；无数据时为 null */
  passRate: number | null;
}

/** rollback 统计 */
export interface RollbackStats {
  /** 成功回滚的次数（rollbackResult.rolledBack=true） */
  rolledBack: number;
  /** 回滚失败的次数 */
  notRolledBack: number;
}

/** 策略信誉快照（按 modelVersion/strategyId 展平） */
export interface StrategyReputationSnapshot {
  modelVersion: string;
  strategyId: string;
  status: StrategyStatus;
  alpha: number;
  beta: number;
  sampleCount: number;
  /** 胜率：(alpha - WEAK_PRIOR_ALPHA=1) / sampleCount；sampleCount=0 时为 0 */
  winRate: number;
  consecutiveLosses: number;
  lastUpdated: string;
  /**
   * 该策略的 evidence 来源 chapter 列表（从 rep.evidence[].sourceChapter 派生）。
   *
   * P1-4 修复：用于按 release 关联的 chapter 集合过滤策略信誉，避免 workspace 全局
   * 策略信誉污染 per-release 健康判定（连续负收益 / eligibility）。
   *
   * 可选：旧调用方/测试未提供时为 undefined，filterStrategyReputationsByRelease 视为空集（过滤掉）。
   */
  sourceChapters?: string[];
}

/** Release 健康报告 */
export interface ReleaseHealthReport {
  /** 报告生成时间（ISO） */
  generatedAt: string;
  /** workspace ID */
  workspaceId: string;
  /** 总反馈记录数 */
  totalFeedbackRecords: number;
  /** action 分桶 */
  actionBreakdown: ActionBreakdown;
  /** 代理判断偏差统计 */
  alignmentStats: AlignmentStats;
  /** 用户修改统计 */
  editStats: EditStats;
  /** FactGuard 通过率统计 */
  factGuardStats: FactGuardStats;
  /** rollback 统计 */
  rollbackStats: RollbackStats;
  /** 策略信誉快照 */
  strategyReputations: StrategyReputationSnapshot[];
}

/** aggregateReleaseHealth 选项 */
export interface AggregateReleaseHealthOptions {
  /** workspace ID（用于 strategy-policy.json 路径解析） */
  workspaceId?: string;
  /** project root（用于 strategy-policy.json 路径解析） */
  projectRoot?: string;
  /** 可选：注入 store（测试用），未提供时从文件加载 */
  store?: StrategyPolicyStore;
}

// ============================================================================
// G8 新增：per-release 健康归集 + 成本统计
// ============================================================================

/** aggregateReleaseHealthByRelease 选项 */
export interface AggregateReleaseHealthByReleaseOptions {
  /** workspace ID（写入报告 workspaceId 字段，便于上游关联） */
  workspaceId?: string;
}

/** aggregateReleaseCostStats 选项（保留扩展点） */
export interface AggregateReleaseCostStatsOptions {
  // 暂无字段；保留以便后续按时间窗/章节范围筛选
}

// ============================================================================
// 常量
// ============================================================================

/** 弱先验 alpha（与 strategy-policy-store WEAK_PRIOR_ALPHA 一致） */
const WEAK_PRIOR_ALPHA = 1;

// ============================================================================
// 实现
// ============================================================================

/**
 * 计算 editDistance：|lengthDelta| / max(originalLength, 1)。
 *
 * 与 chapter-proxy-approval-feedback-ingestor.ts 中的计算保持一致，
 * 保证 release health 报告与 ingestor 写入的 evidence 权重语义对齐。
 */
function computeEditDistance(record: ProxyApprovalFeedbackRecord): number | null {
  const diff = record.editedTextDiff;
  if (!diff || diff.originalLength <= 0) {
    return null;
  }
  return Math.abs(diff.lengthDelta) / Math.max(diff.originalLength, 1);
}

/**
 * Feedback 统计中间结果（不含 strategy 信誉；strategy 是 workspace 级，单独注入）。
 *
 * 提取为共享 helper，供 aggregateReleaseHealth / aggregateReleaseHealthByRelease 复用，
 * 保证全量与按 release 过滤的统计口径完全一致。
 */
interface FeedbackStats {
  totalFeedbackRecords: number;
  actionBreakdown: ActionBreakdown;
  alignmentStats: AlignmentStats;
  editStats: EditStats;
  factGuardStats: FactGuardStats;
  rollbackStats: RollbackStats;
}

/**
 * 在已过滤的 feedback records 上计算所有统计分桶。
 *
 * 纯函数、无副作用、不读文件；调用方负责加载与过滤 records。
 * 空 records 安全：所有计数为 0，alignmentRate=0（不是 NaN），
 * averageEditDistance/passRate=null（明确表达"无数据"）。
 */
function computeFeedbackStats(records: ProxyApprovalFeedbackRecord[]): FeedbackStats {
  // action 分桶
  const actionBreakdown: ActionBreakdown = {
    accept: 0,
    accept_with_edits: 0,
    reject: 0,
    inspect: 0,
    rollback: 0,
  };
  for (const record of records) {
    const action = record.action as FeedbackAction;
    if (action in actionBreakdown) {
      actionBreakdown[action] += 1;
    }
  }

  // alignment 统计（inspect 是只读，不产生对齐信号；跳过）
  let aligned = 0;
  let misaligned = 0;
  for (const record of records) {
    if (record.action === "inspect") continue;
    if (record.proxyJudgmentBias.aligned) {
      aligned += 1;
    } else {
      misaligned += 1;
    }
  }
  const totalAlignment = aligned + misaligned;
  const alignmentRate = totalAlignment > 0 ? aligned / totalAlignment : 0;

  // edit 统计（仅 accept_with_edits 记录）
  let editedApprovals = 0;
  let editDistanceSum = 0;
  let editDistanceCount = 0;
  let heavyEdits = 0;
  for (const record of records) {
    if (record.action !== "accept_with_edits") continue;
    editedApprovals += 1;
    const editDistance = computeEditDistance(record);
    if (editDistance !== null) {
      editDistanceSum += editDistance;
      editDistanceCount += 1;
      if (editDistance >= HEAVY_EDIT_DISTANCE_THRESHOLD) {
        heavyEdits += 1;
      }
    }
  }
  const averageEditDistance =
    editDistanceCount > 0 ? editDistanceSum / editDistanceCount : null;

  // FactGuard 统计（仅 accept_with_edits 且有 factGuardPassed 字段）
  let fgTotal = 0;
  let fgPassed = 0;
  let fgBlocked = 0;
  for (const record of records) {
    if (record.action !== "accept_with_edits") continue;
    if (record.factGuardPassed === undefined) continue;
    fgTotal += 1;
    if (record.factGuardPassed) {
      fgPassed += 1;
    } else {
      fgBlocked += 1;
    }
  }
  const passRate = fgTotal > 0 ? fgPassed / fgTotal : null;

  // rollback 统计
  let rolledBack = 0;
  let notRolledBack = 0;
  for (const record of records) {
    if (record.action !== "rollback") continue;
    if (record.rollbackResult?.rolledBack === true) {
      rolledBack += 1;
    } else {
      notRolledBack += 1;
    }
  }

  return {
    totalFeedbackRecords: records.length,
    actionBreakdown,
    alignmentStats: {
      aligned,
      misaligned,
      alignmentRate,
    },
    editStats: {
      editedApprovals,
      averageEditDistance,
      heavyEdits,
    },
    factGuardStats: {
      total: fgTotal,
      passed: fgPassed,
      blocked: fgBlocked,
      passRate,
    },
    rollbackStats: {
      rolledBack,
      notRolledBack,
    },
  };
}

/**
 * 归集 release 健康报告（只读）。
 *
 * 数据来源：
 * 1. workspaces/{id}/chapter-approvals/feedback.jsonl（用户反馈记录）
 * 2. workspaces/{id}/strategy-policy.json（策略信誉存储快照）
 *
 * 不修改任何文件；可重复调用。
 */
export function aggregateReleaseHealth(
  workspacePath: string,
  options: AggregateReleaseHealthOptions = {},
): ReleaseHealthReport {
  const workspaceId = options.workspaceId ?? "";
  const projectRoot = options.projectRoot ?? "";

  // 1. 加载所有 feedback（不按 chapterId 过滤）
  const records = loadProxyApprovalFeedback(workspacePath);

  // 2. 加载 strategy-policy store 快照（不修改）
  const store =
    options.store ??
    (workspaceId && projectRoot
      ? loadStrategyPolicyStore(workspaceId, projectRoot)
      : null);

  // 3. 在 records 上计算统计分桶（共享 helper）
  const stats = computeFeedbackStats(records);

  // 4. 展平 strategy-policy store partitions 为快照列表
  const strategyReputations: StrategyReputationSnapshot[] = [];
  if (store) {
    const data = store.toJSON();
    for (const [modelVersion, strategies] of Object.entries(data.partitions ?? {})) {
      for (const [strategyId, rep] of Object.entries(strategies)) {
        strategyReputations.push(buildReputationSnapshot(modelVersion, strategyId, rep));
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    workspaceId,
    ...stats,
    strategyReputations,
  };
}

/**
 * 把单个 StrategyReputation 转为只读快照。
 *
 * 计算 winRate = (alpha - WEAK_PRIOR_ALPHA) / sampleCount：
 * - alpha 包含先验（弱先验 1）+ 实际 win 计数
 * - sampleCount 是实际样本数（不含先验）
 * - sampleCount=0 时 winRate=0（避免除零）
 *
 * P1-4 修复：从 rep.evidence[].sourceChapter 派生 sourceChapters，
 * 用于按 release 关联的 chapter 集合过滤策略信誉。
 */
function buildReputationSnapshot(
  modelVersion: string,
  strategyId: string,
  rep: StrategyReputation,
): StrategyReputationSnapshot {
  // USER-FEEDBACK-EVIDENCE-PIPELINE-1：
  // sampleCount = decisionCount 累加；胜率分母用 weightedEvidenceTotal（若有），
  // 否则回退 sampleCount，保持历史兼容。
  const weightDenom =
    typeof rep.weightedEvidenceTotal === "number" && rep.weightedEvidenceTotal > 0
      ? rep.weightedEvidenceTotal
      : rep.sampleCount;
  const winRate =
    weightDenom > 0 ? (rep.alpha - WEAK_PRIOR_ALPHA) / weightDenom : 0;
  return {
    modelVersion,
    strategyId,
    status: rep.status,
    alpha: rep.alpha,
    beta: rep.beta,
    sampleCount: rep.sampleCount,
    winRate,
    consecutiveLosses: rep.consecutiveLosses,
    lastUpdated: rep.lastUpdated,
    sourceChapters: Array.isArray(rep.evidence)
      ? rep.evidence.map((e) => e.sourceChapter)
      : [],
  };
}

// ============================================================================
// G8 新增：per-release 健康归集 + 成本统计
// ============================================================================

/**
 * 按 releaseId 过滤 feedback，归集该 release 的健康报告（只读）。
 *
 * 数据来源：
 * 1. workspaces/{id}/chapter-approvals/{approvalId}.json（通过 listArtifactsByRelease 反查 approvalId 集合）
 * 2. workspaces/{id}/chapter-approvals/feedback.jsonl（按 approvalId 集合过滤）
 *
 * 与 aggregateReleaseHealth 的区别：
 * - 只聚合归属该 releaseId 的 approval 对应的 feedback；
 * - strategy-policy 是 workspace 级而非 release 级，本函数不展平策略信誉（返回空数组）；
 *   如需策略信誉快照，调用方应单独调用 aggregateReleaseHealth 获取。
 *
 * 不修改任何文件；可重复调用；releaseId 无对应 approval 时返回全零报告。
 *
 * 真相源：.trae/documents/g8-health-monitoring-and-retirement-implementation.md §2.3
 */
export function aggregateReleaseHealthByRelease(
  workspacePath: string,
  releaseId: string,
  options: AggregateReleaseHealthByReleaseOptions = {},
): ReleaseHealthReport {
  const workspaceId = options.workspaceId ?? "";

  // 1. 通过 registry 反查该 release 的所有 approval artifact
  const registry = createChapterProxyApprovalRegistry({
    approvalsDir: join(workspacePath, "chapter-approvals"),
  });
  const artifacts = registry.listArtifactsByRelease(releaseId);

  // 2. 构造 approvalId 集合（用于 feedback 过滤）
  const approvalIdSet = new Set<string>();
  for (const artifact of artifacts) {
    approvalIdSet.add(artifact.approvalId);
  }

  // 3. 加载所有 feedback，按 approvalId 集合过滤
  const allRecords = loadProxyApprovalFeedback(workspacePath);
  const filteredRecords = approvalIdSet.size > 0
    ? allRecords.filter((record) => approvalIdSet.has(record.approvalId))
    : [];

  // 4. 在过滤后的 records 上计算统计分桶（共享 helper，口径与全量一致）
  const stats = computeFeedbackStats(filteredRecords);

  return {
    generatedAt: new Date().toISOString(),
    workspaceId,
    ...stats,
    // per-release 不展平 workspace 级策略信誉；调用方需要时单独调 aggregateReleaseHealth
    strategyReputations: [],
  };
}

/**
 * 从 trace 的 v2_final_selected gate.evidence.modelCalls 聚合 release 成本统计（只读）。
 *
 * 数据来源（P1 修复后双层读取）：
 * 1. 优先读 chapter-approvals/{approvalId}-cost-snapshot.json（finalization 时写入的固定快照）
 *    - 避免历史成本跨 release 污染：同一 chapter 被新 release 重跑后 trace 被覆盖，
 *      旧 release 仍能从自己的快照读到 finalization 时的真实成本。
 * 2. 快照缺失时回退读 traces/{chapterId}-quality-trace.json（gates[].stage === "v2_final_selected"）
 *    - 向后兼容：finalization 未接线或快照丢失时仍可工作。
 *
 * 去重规则：同一 chapter 在同一 release 下可能有多次 approval（reject 后重新 approve 等），
 * 取最新 approval 的快照/trace（listArtifactsByRelease 按写入顺序返回，后写覆盖先写）。
 *
 * 不修改任何文件；可重复调用；trace / snapshot 缺失时该 chapter 贡献 0。
 *
 * 真相源：
 * - .trae/documents/g8-health-monitoring-and-retirement-implementation.md §2.4
 * - 用户第三轮核验 P1 历史成本跨 release 污染（2026-07-17）
 */
export function aggregateReleaseCostStats(
  workspacePath: string,
  releaseId: string,
  _options: AggregateReleaseCostStatsOptions = {},
): CostStats {
  // 1. 通过 registry 反查该 release 的所有 approval artifact
  const registry = createChapterProxyApprovalRegistry({
    approvalsDir: join(workspacePath, "chapter-approvals"),
  });
  const artifacts = registry.listArtifactsByRelease(releaseId);

  // 2. 去重：同一 chapter 取最新 approval（listArtifactsByRelease 按写入顺序返回）
  //    保留原 dedup-by-chapterId 语义：每 chapter 只贡献一次成本，避免重复计数。
  const latestArtifactByChapter = new Map<string, ChapterProxyApprovalArtifact>();
  for (const artifact of artifacts) {
    latestArtifactByChapter.set(artifact.chapterId, artifact);
  }

  // 3. 收集每 chapter 的 CostStats（优先快照，回退 trace）
  const perChapterStats: CostStats[] = [];
  for (const artifact of latestArtifactByChapter.values()) {
    const stats = readChapterCostStats(workspacePath, artifact);
    if (stats !== null) {
      perChapterStats.push(stats);
    }
  }

  // 4. 合并所有 per-chapter CostStats
  return mergeCostStats(perChapterStats);
}

// ============================================================================
// P1-4 修复：按 release 过滤策略信誉
// ============================================================================

/**
 * 按 release 关联的 chapter 集合过滤策略信誉快照（P1-4 修复）。
 *
 * 数据来源：
 * 1. workspaces/{id}/chapter-approvals/（通过 listArtifactsByRelease 反查该 release 关联的 chapterId 集合）
 * 2. 策略快照的 sourceChapters 字段（从 rep.evidence[].sourceChapter 派生）
 *
 * 过滤规则：策略的 sourceChapters 与 release 的 chapterId 集合有交集时保留。
 * sourceChapters 为 undefined/空的策略被过滤掉（无 release-scoped evidence）。
 *
 * 不修改任何文件；可重复调用；release 无 approval artifact 时返回空数组。
 *
 * 真相源：用户第二轮核验 P1-4（2026-07-17）
 */
export function filterStrategyReputationsByRelease(
  snapshots: StrategyReputationSnapshot[],
  workspacePath: string,
  releaseId: string,
): StrategyReputationSnapshot[] {
  // 1. 通过 registry 反查该 release 的所有 approval artifact，收集 chapterId 集合
  const registry = createChapterProxyApprovalRegistry({
    approvalsDir: join(workspacePath, "chapter-approvals"),
  });
  const artifacts = registry.listArtifactsByRelease(releaseId);

  const chapterIdSet = new Set<string>();
  for (const artifact of artifacts) {
    chapterIdSet.add(artifact.chapterId);
  }

  if (chapterIdSet.size === 0) {
    return [];
  }

  // 2. 过滤：策略的 sourceChapters 与 chapterIdSet 有交集时保留
  return snapshots.filter((snapshot) => {
    const sourceChapters = snapshot.sourceChapters;
    if (!Array.isArray(sourceChapters) || sourceChapters.length === 0) {
      return false;
    }
    return sourceChapters.some((ch) => chapterIdSet.has(ch));
  });
}
