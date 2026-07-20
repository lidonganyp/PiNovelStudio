/**
 * StrategyPolicyStore — 策略信誉存储（Phase 6，计划 §Phase 6）
 *
 * 按模型版本隔离存储每个编辑策略的 Thompson Sampling 信誉（Beta 分布 alpha/beta）。
 *
 * 设计原则（计划 §Phase 6）：
 * - 模型版本隔离：旧模型经验不限制新模型能力；新模型版本以弱先验起步，
 *   不继承旧模型的虚假高胜率
 * - candidate/active 准入隔离：未满足离线证据阈值的策略只收集证据，不参与在线采样
 * - dormant/retired 状态：已准入策略连续失败 → dormant；长期负收益 → retired
 * - 所有自动学习可解释、可撤销：每条更新写 evidence log，支持 revert
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

// ============================================================================
// 常量
// ============================================================================

const FILE_NAME = "strategy-policy.json";
const CURRENT_SCHEMA_VERSION = 2;

/** 弱先验：未观察策略的 Beta(1,1) = 均匀分布，保证探索 */
export const WEAK_PRIOR_ALPHA = 1;
export const WEAK_PRIOR_BETA = 1;

/** dormant 触发：连续失败次数阈值 */
export const DORMANT_CONSECUTIVE_LOSSES = 4;

/** retired 触发：总样本数达到下限且胜率低于阈值 */
export const RETIRE_MIN_SAMPLES = 8;
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
  /** 权重（用户反馈高权重，多重样本） */
  weight: number;
  /** 时间戳 */
  timestamp: string;
  /** 可选备注（如 user 编辑摘要） */
  note?: string;
}

export interface StrategyReputation {
  strategyId: string;
  /** 模型版本键（由 ModelVersionMigration 派生） */
  modelVersion: string;
  /** Beta 分布参数：win 计数 + 先验 */
  alpha: number;
  /** Beta 分布参数：loss 计数 + 先验 */
  beta: number;
  /** 总样本数（不含先验） */
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
   */
  getReputation(strategyId: string, modelVersion: string): StrategyReputation {
    const partition = this.data.partitions[modelVersion];
    const existing = partition?.[strategyId];
    if (existing) return existing;
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
   */
  recordOutcome(
    strategyId: string,
    modelVersion: string,
    evidence: StrategyEvidence
  ): StrategyReputation {
    const rep = { ...this.getReputation(strategyId, modelVersion) };
    const w = evidence.weight;

    if (evidence.outcome === "win") {
      rep.alpha += w;
      rep.consecutiveLosses = 0;
    } else if (evidence.outcome === "loss") {
      rep.beta += w;
      rep.consecutiveLosses += 1;
    } else {
      // tie：弱更新，双方各加一半，不改变 consecutiveLosses
      rep.alpha += w * 0.5;
      rep.beta += w * 0.5;
    }
    rep.sampleCount += w;
    rep.evidence = [...rep.evidence, evidence].slice(-EVIDENCE_LOG_CAP);
    rep.lastUpdated = new Date().toISOString();

    // 状态转换
    this.applyStatusTransitions(rep);

    this.putReputation(rep);
    return rep;
  }

  /**
   * 撤销最近一条 evidence（可撤销原则）。
   * 返回撤销后的信誉；无 evidence 则不变。
   */
  revertLastOutcome(
    strategyId: string,
    modelVersion: string
  ): StrategyReputation {
    const rep = { ...this.getReputation(strategyId, modelVersion) };
    if (rep.evidence.length === 0) return rep;

    const last = rep.evidence[rep.evidence.length - 1];
    const w = last.weight;
    if (last.outcome === "win") {
      rep.alpha = Math.max(WEAK_PRIOR_ALPHA, rep.alpha - w);
      // 连续失败计数无法精确恢复，保守归零（撤销 win 不影响 loss 计数语义）
    } else if (last.outcome === "loss") {
      rep.beta = Math.max(WEAK_PRIOR_BETA, rep.beta - w);
      rep.consecutiveLosses = Math.max(0, rep.consecutiveLosses - 1);
    } else {
      rep.alpha = Math.max(WEAK_PRIOR_ALPHA, rep.alpha - w * 0.5);
      rep.beta = Math.max(WEAK_PRIOR_BETA, rep.beta - w * 0.5);
    }
    rep.sampleCount = Math.max(0, rep.sampleCount - w);
    rep.evidence = rep.evidence.slice(0, -1);
    rep.lastUpdated = new Date().toISOString();

    // 撤销后重新评估状态（可能从 dormant 回到 active）
    this.recomputeStatus(rep);
    this.putReputation(rep);
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

    // retired 不可逆（除非手动 setStatus）：长期负收益
    if (rep.status === "retired") return;

    // 连续失败 → dormant
    if (rep.consecutiveLosses >= DORMANT_CONSECUTIVE_LOSSES && rep.status === "active") {
      rep.status = "dormant";
      rep.statusChangedAt = new Date().toISOString();
      rep.statusReason = `连续 ${rep.consecutiveLosses} 次失败，自动 dormant`;
    }

    // 样本充足且胜率极低 → retired
    // 注：上方早返回已排除 retired，此处 status 只可能是 active/dormant
    if (rep.sampleCount >= RETIRE_MIN_SAMPLES) {
      const winRate = (rep.alpha - WEAK_PRIOR_ALPHA) / rep.sampleCount;
      if (winRate < RETIRE_MAX_WIN_RATE) {
        rep.status = "retired";
        rep.statusChangedAt = new Date().toISOString();
        rep.statusReason = `样本 ${rep.sampleCount}，胜率 ${winRate.toFixed(2)} < ${RETIRE_MAX_WIN_RATE}，自动 retired`;
      }
    }

    // dormant 策略在 win 后可回到 active（探索恢复）
    if (rep.status === "dormant" && rep.consecutiveLosses === 0) {
      rep.status = "active";
      rep.statusChangedAt = new Date().toISOString();
      rep.statusReason = "win 后从 dormant 恢复 active";
    }
  }

  private recomputeStatus(rep: StrategyReputation): void {
    if (rep.status === "candidate") return;

    // 撤销后重新评估：若不再满足 dormant/retired 条件则回 active
    if (rep.status === "retired") {
      // retired 撤销：检查是否仍满足 retired 条件
      if (rep.sampleCount < RETIRE_MIN_SAMPLES) {
        rep.status = "active";
        rep.statusChangedAt = new Date().toISOString();
        rep.statusReason = "撤销后样本不足，回 active";
      }
      return;
    }
    if (rep.status === "dormant") {
      if (rep.consecutiveLosses < DORMANT_CONSECUTIVE_LOSSES) {
        rep.status = "active";
        rep.statusChangedAt = new Date().toISOString();
        rep.statusReason = "撤销后连续失败计数下降，回 active";
      }
    }
  }

  /**
   * schema v1 没有 admission 语义，历史 active/dormant/retired 都不能被视为已准入。
   * 保留 alpha/beta/evidence 供离线评估，但统一迁移为 candidate，避免旧随机信誉
   * 在升级后继续过滤生产 opportunity hypothesis。
   */
  private migrateAdmissionSchema(initial: StrategyPolicyStoreData): StrategyPolicyStoreData {
    if (initial.schemaVersion >= CURRENT_SCHEMA_VERSION) return initial;

    const migratedAt = new Date().toISOString();
    const partitions: StrategyPolicyStoreData["partitions"] = {};
    for (const [modelVersion, strategies] of Object.entries(initial.partitions ?? {})) {
      partitions[modelVersion] = {};
      for (const [strategyId, rep] of Object.entries(strategies)) {
        const wasActive = rep.status === "active";
        partitions[modelVersion][strategyId] = {
          ...rep,
          status: wasActive ? "candidate" : rep.status,
          statusChangedAt: wasActive ? migratedAt : rep.statusChangedAt,
          statusReason: wasActive
            ? "schema v1 predates evidence admission; reset to candidate"
            : rep.statusReason,
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
