/**
 * StrategyPolicyStore — 策略信誉物化缓存（Phase 6 + USER-FEEDBACK-EVIDENCE-PIPELINE-1）
 *
 * 按模型版本隔离存储每个编辑策略的 Thompson Sampling 信誉（Beta 分布 alpha/beta）。
 *
 * 设计原则：
 * - 模型版本隔离：旧模型经验不限制新模型能力；新模型版本以弱先验起步
 * - candidate/active 准入隔离：未满足离线证据阈值的策略只收集证据，不参与在线采样
 * - 文学负反馈不得自动 retired；在线最多 dormant / 降采样建议
 * - retired 只能由离线复核 + 人工 setStatus 产生
 * - evidence ledger 是真相源；本 store 是可重建的运行时物化层
 * - 撤销按 evidenceId 定点执行，并从有效证据重算；revertLastOutcome 仅兼容包装
 * - 禁止自动修改系统 prompt、作品宪法核心字段、硬门禁和世界事实
 *
 * 存储：workspaces/{id}/strategy-policy.json
 *   顶层按 modelVersion 分区，每个分区下按 strategyId 存 StrategyReputation
 *
 * Thompson Sampling：只对已准入 active 策略从 Beta(alpha, beta) 采样，取 top-K。
 *   candidate 策略保留弱先验并继续收集证据，但由静态 registry 驱动候选生成。
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { join, dirname } from "path";
import {
  MIN_ADMISSION_ELIGIBLE_DECISIONS,
  MIN_ADMISSION_HUMAN_VERDICTS,
} from "../core/strategy-evidence-dataset.js";
import { classifyPartitionMatch } from "./strategy-evidence-partition.js";
import type { RequestedPartitionIdentity } from "./strategy-evidence-partition.js";

// ============================================================================
// 常量
// ============================================================================

const FILE_NAME = "strategy-policy.json";
/** 当前物化 schema：v3 = 账本可重建 + 无自动 literary retired */
const CURRENT_SCHEMA_VERSION = 3;

/** 弱先验：未观察策略的 Beta(1,1) = 均匀分布，保证探索 */
export const WEAK_PRIOR_ALPHA = 1;
export const WEAK_PRIOR_BETA = 1;

/** dormant 触发：连续失败次数阈值（在线可暂停探索，不退役） */
export const DORMANT_CONSECUTIVE_LOSSES = 4;

/**
 * @deprecated 文学反馈不得自动 retired。
 * 保留常量供离线治理报告与历史测试对照；在线 applyStatusTransitions 不再使用。
 */
export const RETIRE_MIN_SAMPLES = 8;
/** @deprecated 见 RETIRE_MIN_SAMPLES */
export const RETIRE_MAX_WIN_RATE = 0.25;

/** evidence log 每策略上限（FIFO 截断，保留最近 N 条供审计） */
export const EVIDENCE_LOG_CAP = 50;

// 离线准入阈值常量（MIN_ADMISSION_ELIGIBLE_DECISIONS / MIN_ADMISSION_HUMAN_VERDICTS）
// 已迁移至 v2/core/strategy-evidence-dataset.ts 作为单一真相源，
// 供 compileAdmissionDecisions 与本模块 evaluateAdmission 共享。
// 下方 re-export 保留向后兼容（历史消费者可能从本模块导入）。
// 注意：使用本地绑定 re-export（不带 from），避免与上方 import 形成 TS2395/TS2440 合并冲突。
export {
  MIN_ADMISSION_ELIGIBLE_DECISIONS,
  MIN_ADMISSION_HUMAN_VERDICTS,
};

export type StrategyStatus = "candidate" | "active" | "dormant" | "retired";

// ============================================================================
// 类型
// ============================================================================

export interface StrategyEvidence {
  /** 来源章节，如 "ch17" */
  sourceChapter: string;
  /** outcome: editorial 胜 / raw 胜 / tie */
  outcome: "win" | "loss" | "tie";
  /** 信号来源：judge 裁判 / user 用户修改反馈 */
  source: "judge" | "user";
  /**
   * 加权证据量（用于 alpha/beta 幅度）。
   * 不等于独立决策数；决策数见 decisionCount。
   */
  weight: number;
  /** 时间戳 */
  timestamp: string;
  /** 可选备注（如 user 编辑摘要） */
  note?: string;
  /** 证据唯一 ID（定点撤销 / 幂等） */
  evidenceId?: string;
  /** 真实独立用户决策数；缺省按 1 */
  decisionCount?: number;
  /** bundle 级学习目标 */
  strategyBundleId?: string;
  /** 反馈等级（审计） */
  feedbackLevel?: string;
  /** 归因置信度（审计） */
  attributionConfidence?: string;
  /** 是否已撤销（物化视图中标记；真相源在 ledger） */
  revoked?: boolean;
  /** DG-4：完整行为 bundleId（与 modelVersion/evalProtocolVersion 共同构成分区身份） */
  bundleId?: string;
  /** DG-4：评测协议版本 */
  evalProtocolVersion?: string;
}

export interface StrategyReputation {
  strategyId: string;
  /** 模型版本键（由 ModelVersionMigration 派生） */
  modelVersion: string;
  /** DG-4：完整行为 bundleId（证据分区四元组之一；旧物化条目缺省） */
  bundleId?: string;
  /** DG-4：评测协议版本（证据分区四元组之一；旧物化条目缺省） */
  evalProtocolVersion?: string;
  /** Beta 分布参数：win 计数 + 先验 */
  alpha: number;
  /** Beta 分布参数：loss 计数 + 先验 */
  beta: number;
  /**
   * 总独立决策数（decisionCount 累加，不含先验）。
   * 不再把 weight 直接当作 sampleCount。
   */
  sampleCount: number;
  /** 连续失败次数（用于 dormant 触发，win 时归零） */
  consecutiveLosses: number;
  status: StrategyStatus;
  /** 进入 dormant/retired 的时间，用于审计与可撤销 */
  statusChangedAt?: string;
  /** 状态变更原因 */
  statusReason?: string;
  /** evidence log（FIFO，最近 EVIDENCE_LOG_CAP 条） */
  evidence: StrategyEvidence[];
  lastUpdated: string;
  /** 加权证据总量（审计；不等于 sampleCount） */
  weightedEvidenceTotal?: number;
}

export interface StrategyPolicyStoreData {
  schemaVersion: number;
  workspaceId: string;
  /** 顶层按 modelVersion 分区 */
  partitions: Record<string, Record<string, StrategyReputation>>;
  updatedAt: string;
}

export interface StrategyAdmissionEvidenceSummary {
  eligibleDecisionCount: number;
  humanVerdictCount: number;
}

export interface StrategyAdmissionDecision {
  strategyId: string;
  modelVersion: string;
  recommendedStatus: "candidate" | "active";
  eligibleDecisionCount: number;
  humanVerdictCount: number;
  reason: string;
}

// ============================================================================
// StrategyPolicyStore
// ============================================================================

export class StrategyPolicyStore {
  private data: StrategyPolicyStoreData;

  constructor(workspaceId: string, initial?: StrategyPolicyStoreData) {
    if (initial) {
      this.data = this.migrateAdmissionSchema(initial);
    } else {
      this.data = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        workspaceId,
        partitions: {},
        updatedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * 获取某模型版本下某策略的信誉。不存在则返回弱先验实例（不写入）。
   *
   * DG-4：传入 partition（bundleId + evalProtocolVersion）时启用分区读取隔离——
   * 已存储条目若与请求分区不一致（legacy / mismatch），返回弱先验，
   * 保证新 Bundle 不继承旧 Bundle 策略信誉。
   */
  getReputation(
    strategyId: string,
    modelVersion: string,
    partition?: RequestedPartitionIdentity,
  ): StrategyReputation {
    const existing = this.data.partitions[modelVersion]?.[strategyId];
    if (existing) {
      if (partition && classifyPartitionMatch(existing, partition) !== "match") {
        // legacy / mismatch：新 bundle 不继承旧分区信誉（读取隔离）。
        return this.weakPrior(strategyId, modelVersion);
      }
      return existing;
    }
    return this.weakPrior(strategyId, modelVersion);
  }

  /** 弱先验实例（不写入）。 */
  private weakPrior(strategyId: string, modelVersion: string): StrategyReputation {
    return {
      strategyId,
      modelVersion,
      alpha: WEAK_PRIOR_ALPHA,
      beta: WEAK_PRIOR_BETA,
      sampleCount: 0,
      consecutiveLosses: 0,
      status: "candidate",
      evidence: [],
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * 离线评估某个 modelVersion + strategyId 是否满足 active 准入阈值。
   * 该方法是纯读操作；调用方必须显式 setStatus 才会改变生产状态。
   */
  evaluateAdmission(
    strategyId: string,
    modelVersion: string,
    evidence: StrategyAdmissionEvidenceSummary
  ): StrategyAdmissionDecision {
    const eligibleDecisionCount = Number.isInteger(evidence.eligibleDecisionCount)
      ? Math.max(0, evidence.eligibleDecisionCount)
      : 0;
    const humanVerdictCount = Number.isInteger(evidence.humanVerdictCount)
      ? Math.max(0, evidence.humanVerdictCount)
      : 0;

    if (eligibleDecisionCount < MIN_ADMISSION_ELIGIBLE_DECISIONS) {
      return {
        strategyId,
        modelVersion,
        recommendedStatus: "candidate",
        eligibleDecisionCount,
        humanVerdictCount,
        reason: `eligible decisions ${eligibleDecisionCount}/${MIN_ADMISSION_ELIGIBLE_DECISIONS}，保持 candidate`,
      };
    }
    if (humanVerdictCount < MIN_ADMISSION_HUMAN_VERDICTS) {
      return {
        strategyId,
        modelVersion,
        recommendedStatus: "candidate",
        eligibleDecisionCount,
        humanVerdictCount,
        reason: `human verdicts ${humanVerdictCount}/${MIN_ADMISSION_HUMAN_VERDICTS}，保持 candidate`,
      };
    }
    return {
      strategyId,
      modelVersion,
      recommendedStatus: "active",
      eligibleDecisionCount,
      humanVerdictCount,
      reason: `admission threshold satisfied: eligible=${eligibleDecisionCount}, human=${humanVerdictCount}`,
    };
  }

  /**
   * 写入/覆盖某策略信誉（由 OutcomeRecorder 调用）。
   */
  putReputation(rep: StrategyReputation): void {
    if (!this.data.partitions[rep.modelVersion]) {
      this.data.partitions[rep.modelVersion] = {};
    }
    this.data.partitions[rep.modelVersion][rep.strategyId] = rep;
    this.data.updatedAt = new Date().toISOString();
  }

  /**
   * 记录一条 evidence 并更新 alpha/beta/status。
   * win → alpha += weight；loss → beta += weight；tie → alpha += weight*0.5, beta += weight*0.5
   *
   * sampleCount 累加 decisionCount（默认 1），不再把 weight 当作样本数。
   * 同一 evidenceId 幂等：已存在则返回原信誉，不重复写入。
   */
  recordOutcome(
    strategyId: string,
    modelVersion: string,
    evidence: StrategyEvidence,
    partition?: RequestedPartitionIdentity,
  ): StrategyReputation {
    // DG-4：分区感知写入。
    // - mismatch：跨 Bundle / 跨 eval 协议污染 → 拒绝写入（抛错）。
    // - legacy：旧分区未捕获行为身份 → 不合并旧信誉，从弱先验重新起步（隔离）。
    const existing = this.data.partitions[modelVersion]?.[strategyId];
    if (partition && existing) {
      const classification = classifyPartitionMatch(existing, partition);
      if (classification === "mismatch") {
        throw new Error(
          `跨 Bundle 污染拒绝写入：strategyId=${strategyId}, modelVersion=${modelVersion}, ` +
            `stored bundleId=${existing.bundleId ?? "(缺失)"}, evalProtocolVersion=${existing.evalProtocolVersion ?? "(缺失)"} ` +
            `≠ requested bundleId=${partition.bundleId}, evalProtocolVersion=${partition.evalProtocolVersion}`,
        );
      }
    }
    const current = this.getReputation(strategyId, modelVersion, partition);

    // 幂等：同一 evidenceId 不重复写入
    if (
      evidence.evidenceId &&
      current.evidence.some((e) => e.evidenceId === evidence.evidenceId && !e.revoked)
    ) {
      return current;
    }

    const rep = {
      ...current,
      evidence: [...current.evidence],
      ...(partition
        ? { bundleId: partition.bundleId, evalProtocolVersion: partition.evalProtocolVersion }
        : {}),
    };
    const w = evidence.weight;
    const decisionCount =
      typeof evidence.decisionCount === "number" && evidence.decisionCount > 0
        ? evidence.decisionCount
        : 1;

    if (evidence.outcome === "win") {
      rep.alpha += w;
      rep.consecutiveLosses = 0;
    } else if (evidence.outcome === "loss") {
      rep.beta += w;
      rep.consecutiveLosses += decisionCount;
    } else {
      // tie：弱更新，双方各加一半，不改变 consecutiveLosses
      rep.alpha += w * 0.5;
      rep.beta += w * 0.5;
    }
    rep.sampleCount += decisionCount;
    rep.weightedEvidenceTotal = (rep.weightedEvidenceTotal ?? 0) + w;
    rep.evidence = [...rep.evidence, { ...evidence, decisionCount }].slice(
      -EVIDENCE_LOG_CAP,
    );
    rep.lastUpdated = new Date().toISOString();

    // 状态转换（文学反馈不得自动 retired）
    this.applyStatusTransitions(rep);

    this.putReputation(rep);
    return rep;
  }

  /**
   * 按 evidenceId 定点撤销，并从剩余有效 evidence 重算信誉。
   * 找不到 evidenceId 时返回 { reverted: false }。
   */
  revertOutcomeByEvidenceId(
    strategyId: string,
    modelVersion: string,
    evidenceId: string,
  ): { reverted: boolean; reputation: StrategyReputation; reason?: string } {
    const current = this.getReputation(strategyId, modelVersion);
    const target = current.evidence.find(
      (e) => e.evidenceId === evidenceId && !e.revoked,
    );
    if (!target) {
      return {
        reverted: false,
        reputation: current,
        reason: `evidenceId 不存在或已撤销: ${evidenceId}`,
      };
    }

    const remaining = current.evidence.map((e) =>
      e.evidenceId === evidenceId ? { ...e, revoked: true } : e,
    );
    const recomputed = this.recomputeFromEvidenceList(
      strategyId,
      modelVersion,
      remaining.filter((e) => !e.revoked),
      current.status,
      {
        statusChangedAt: current.statusChangedAt,
        statusReason: current.statusReason,
      },
    );
    // 保留已撤销标记供审计（截断前）
    recomputed.evidence = remaining.slice(-EVIDENCE_LOG_CAP);
    recomputed.lastUpdated = new Date().toISOString();
    this.recomputeStatus(recomputed);
    this.putReputation(recomputed);
    return { reverted: true, reputation: recomputed };
  }

  /**
   * @deprecated 兼容包装：撤销最近一条未撤销 evidence。
   * 新代码应使用 revertOutcomeByEvidenceId。
   */
  revertLastOutcome(
    strategyId: string,
    modelVersion: string
  ): StrategyReputation {
    const rep = this.getReputation(strategyId, modelVersion);
    if (rep.evidence.length === 0) return rep;

    // 找最近一条未撤销 evidence
    let lastIdx = -1;
    for (let i = rep.evidence.length - 1; i >= 0; i--) {
      if (!rep.evidence[i]!.revoked) {
        lastIdx = i;
        break;
      }
    }
    if (lastIdx < 0) return rep;

    const last = rep.evidence[lastIdx]!;
    if (last.evidenceId) {
      return this.revertOutcomeByEvidenceId(
        strategyId,
        modelVersion,
        last.evidenceId,
      ).reputation;
    }

    // 无 evidenceId 的历史条目：按列表重算（去掉最后一条有效）
    const remaining = rep.evidence.filter((_, idx) => idx !== lastIdx);
    const recomputed = this.recomputeFromEvidenceList(
      strategyId,
      modelVersion,
      remaining.filter((e) => !e.revoked),
      rep.status,
      {
        statusChangedAt: rep.statusChangedAt,
        statusReason: rep.statusReason,
      },
    );
    recomputed.evidence = remaining.slice(-EVIDENCE_LOG_CAP);
    recomputed.lastUpdated = new Date().toISOString();
    this.recomputeStatus(recomputed);
    this.putReputation(recomputed);
    return recomputed;
  }

  /**
   * 从有效 evidence 列表完整重算物化信誉（增量与重算对齐的核心）。
   */
  recomputeFromEvidenceList(
    strategyId: string,
    modelVersion: string,
    evidenceList: StrategyEvidence[],
    status: StrategyStatus = "candidate",
    statusMeta?: { statusChangedAt?: string; statusReason?: string },
  ): StrategyReputation {
    let alpha = WEAK_PRIOR_ALPHA;
    let beta = WEAK_PRIOR_BETA;
    let sampleCount = 0;
    let weightedEvidenceTotal = 0;
    let consecutiveLosses = 0;
    let lastUpdated = new Date().toISOString();

    for (const evidence of evidenceList) {
      if (evidence.revoked) continue;
      const w = evidence.weight;
      const decisionCount =
        typeof evidence.decisionCount === "number" && evidence.decisionCount > 0
          ? evidence.decisionCount
          : 1;
      weightedEvidenceTotal += w;
      sampleCount += decisionCount;

      if (evidence.outcome === "win") {
        alpha += w;
        consecutiveLosses = 0;
      } else if (evidence.outcome === "loss") {
        beta += w;
        consecutiveLosses += decisionCount;
      } else {
        alpha += w * 0.5;
        beta += w * 0.5;
      }
      if (evidence.timestamp > lastUpdated || sampleCount === decisionCount) {
        lastUpdated = evidence.timestamp;
      }
    }

    const rep: StrategyReputation = {
      strategyId,
      modelVersion,
      alpha,
      beta,
      sampleCount,
      consecutiveLosses,
      status,
      statusChangedAt: statusMeta?.statusChangedAt,
      statusReason: statusMeta?.statusReason,
      evidence: evidenceList.slice(-EVIDENCE_LOG_CAP),
      lastUpdated,
      weightedEvidenceTotal,
    };
    // 重算后只允许 dormant 观察，不自动 retired
    this.applyStatusTransitions(rep);
    return rep;
  }

  /**
   * 列出某模型版本下所有 active 策略（供 selector 采样）。
   */
  listActiveStrategies(modelVersion: string): StrategyReputation[] {
    const partition = this.data.partitions[modelVersion] ?? {};
    return Object.values(partition).filter((r) => r.status === "active");
  }

  /**
   * 列出所有已物化策略键（modelVersion + strategyId）。
   * 供投影重建识别「从有效证据集消失」的孤儿策略（如唯一证据被撤销）。
   */
  listAllStrategyKeys(): Array<{ modelVersion: string; strategyId: string }> {
    const keys: Array<{ modelVersion: string; strategyId: string }> = [];
    for (const [modelVersion, strategies] of Object.entries(this.data.partitions)) {
      for (const strategyId of Object.keys(strategies)) {
        keys.push({ modelVersion, strategyId });
      }
    }
    return keys;
  }

  /**
   * 手动设置策略状态（可解释、可撤销的人工干预）。
   */
  setStatus(
    strategyId: string,
    modelVersion: string,
    status: StrategyStatus,
    reason: string
  ): StrategyReputation {
    const rep = { ...this.getReputation(strategyId, modelVersion) };
    rep.status = status;
    rep.statusChangedAt = new Date().toISOString();
    rep.statusReason = reason;
    rep.lastUpdated = rep.statusChangedAt;
    this.putReputation(rep);
    return rep;
  }

  toJSON(): StrategyPolicyStoreData {
    return this.data;
  }

  // --------------------------------------------------------------------------
  // 状态转换逻辑
  // --------------------------------------------------------------------------

  private applyStatusTransitions(rep: StrategyReputation): void {
    // candidate 只积累证据；在离线准入显式转 active 前，在线 outcome 不得改变其状态。
    if (rep.status === "candidate") return;

    // retired 不可逆（除非手动 setStatus）；文学反馈不得自动进入 retired。
    if (rep.status === "retired") return;

    // 连续失败 → dormant（暂停探索建议；不退役）
    if (rep.consecutiveLosses >= DORMANT_CONSECUTIVE_LOSSES && rep.status === "active") {
      rep.status = "dormant";
      rep.statusChangedAt = new Date().toISOString();
      rep.statusReason = `连续 ${rep.consecutiveLosses} 次失败，自动 dormant（文学反馈不得自动 retired）`;
    }

    // USER-FEEDBACK-EVIDENCE-PIPELINE-1：删除自动 retired。
    // 长期低胜率只保留 dormant / 离线复核建议；retired 必须人工审批。

    // dormant 策略在 win 后可回到 active（探索恢复）
    if (rep.status === "dormant" && rep.consecutiveLosses === 0) {
      rep.status = "active";
      rep.statusChangedAt = new Date().toISOString();
      rep.statusReason = "win 后从 dormant 恢复 active";
    }
  }

  private recomputeStatus(rep: StrategyReputation): void {
    if (rep.status === "candidate") return;

    // retired 只能人工解除；撤销 evidence 不自动复活 retired。
    if (rep.status === "retired") return;

    if (rep.status === "dormant") {
      if (rep.consecutiveLosses < DORMANT_CONSECUTIVE_LOSSES) {
        rep.status = "active";
        rep.statusChangedAt = new Date().toISOString();
        rep.statusReason = "撤销后连续失败计数下降，回 active";
      }
    }
  }

  /**
   * schema 迁移：
   * - v1 → candidate 重置（admission 语义）
   * - v2 → v3：去掉自动 retired 语义标记；保留人工 retired
   * 保留 alpha/beta/evidence 供离线评估。
   */
  private migrateAdmissionSchema(initial: StrategyPolicyStoreData): StrategyPolicyStoreData {
    if (initial.schemaVersion >= CURRENT_SCHEMA_VERSION) return initial;

    const migratedAt = new Date().toISOString();
    const partitions: StrategyPolicyStoreData["partitions"] = {};
    for (const [modelVersion, strategies] of Object.entries(initial.partitions ?? {})) {
      partitions[modelVersion] = {};
      for (const [strategyId, rep] of Object.entries(strategies)) {
        let nextStatus = rep.status;
        let statusReason = rep.statusReason;
        let statusChangedAt = rep.statusChangedAt;

        if (initial.schemaVersion < 2 && rep.status === "active") {
          // v1 没有 admission 语义：历史 active 重置为 candidate
          nextStatus = "candidate";
          statusChangedAt = migratedAt;
          statusReason = "schema v1 predates evidence admission; reset to candidate";
        } else if (
          initial.schemaVersion < 3 &&
          rep.status === "retired" &&
          typeof rep.statusReason === "string" &&
          rep.statusReason.includes("自动 retired")
        ) {
          // v2 自动 retired → dormant（保留人工 retired）
          nextStatus = "dormant";
          statusChangedAt = migratedAt;
          statusReason =
            "schema v3: auto-retired from literary feedback demoted to dormant; retirement requires offline review + human approval";
        }

        partitions[modelVersion][strategyId] = {
          ...rep,
          status: nextStatus,
          statusChangedAt,
          statusReason,
          lastUpdated: migratedAt,
        };
      }
    }
    return {
      ...initial,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      partitions,
      updatedAt: migratedAt,
    };
  }
}

// ============================================================================
// 持久化
// ============================================================================

export function strategyPolicyPath(
  workspaceId: string,
  projectRoot: string
): string {
  return join(projectRoot, "workspaces", workspaceId, FILE_NAME);
}

export function loadStrategyPolicyStore(
  workspaceId: string,
  projectRoot: string
): StrategyPolicyStore {
  const path = strategyPolicyPath(workspaceId, projectRoot);
  if (!existsSync(path)) {
    return new StrategyPolicyStore(workspaceId);
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as StrategyPolicyStoreData;
    if (parsed.workspaceId !== workspaceId) {
      // workspace 不匹配：返回空 store，避免污染
      return new StrategyPolicyStore(workspaceId);
    }
    return new StrategyPolicyStore(workspaceId, parsed);
  } catch {
    return new StrategyPolicyStore(workspaceId);
  }
}

export function saveStrategyPolicyStore(
  store: StrategyPolicyStore,
  workspaceId: string,
  projectRoot: string
): void {
  const path = strategyPolicyPath(workspaceId, projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  const data = store.toJSON();
  // 原子保存：tmp → rename
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  // renameSync 会覆盖目标文件（Windows/Linux 均支持）
  renameSync(tmp, path);
}

export function createStrategyPolicyStore(
  workspaceId: string
): StrategyPolicyStore {
  return new StrategyPolicyStore(workspaceId);
}

// USER-FEEDBACK-EVIDENCE-PIPELINE-1：账本重算与晋级治理进入生产编译闭包
export {
  buildEffectiveObservations,
  recomputeStrategyReputation,
  recomputeAllStrategyReputations,
  materializeReputation,
  reputationsMatch,
} from "./strategy-reputation-recompute.js";
export type {
  EffectiveObservation,
  RecomputeScope,
  RecomputedReputation,
} from "./strategy-reputation-recompute.js";

export {
  buildPromotionRecommendation,
  applyPromotionWithApproval,
  singleFeedbackCanSwitchProductionBaseline,
} from "./strategy-promotion-governance.js";
export type {
  PromotionApprovalRecord,
  PromotionRecommendation,
  ApplyPromotionResult,
} from "./strategy-promotion-governance.js";

export {
  assertFeedbackAffectsNextRequestOnly,
  buildStrategyBundleId,
  allowsSingleStrategyEvidence,
  isCompleteLineage,
  literaryFeedbackAllowedOnlineActions,
  feedbackLevelUpdatesLiteraryReputation,
  isLiteraryStrategyPenaltyEdit,
  FEEDBACK_FORBIDDEN_MUTATIONS,
  MAX_FEEDBACK_EVENTS_PER_CHAPTER,
  MAX_FEEDBACK_EVENTS_PER_USER_PER_DAY,
  MAX_FEEDBACK_EVENTS_PER_WORKSPACE_PER_HOUR,
} from "./feedback-evidence-contracts.js";
export type {
  FeedbackLevel,
  AttributionConfidence,
  EditScope,
  EditType,
  StrategyExposure,
  FeedbackLineage,
  EditClassification,
  FeedbackAttributionDecision,
  FeedbackEvidenceObservation,
  FeedbackEvidenceLedgerEvent,
  OnlineLiteraryFeedbackAction,
} from "./feedback-evidence-contracts.js";

export {
  loadFeedbackEvidenceLedger,
  saveFeedbackEvidenceLedger,
  appendFeedbackEvidenceEvents,
  materializePolicyFromFeedbackLedger,
  observationFromRecordedOutcome,
  feedbackEvidenceLedgerPath,
  FEEDBACK_LEDGER_SCHEMA_ID,
  FEEDBACK_LEDGER_SCHEMA_VERSION,
} from "./feedback-evidence-ledger-store.js";
export type {
  FeedbackEvidenceLedgerArtifact,
} from "./feedback-evidence-ledger-store.js";
