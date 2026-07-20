/**
 * ModelVersionMigration — 模型版本隔离与先验衰减（Phase 6，计划 §Phase 6）
 *
 * 核心不变量（计划 §Phase 6 退出条件）：
 * - 新模型不会继承旧模型的虚假高胜率
 * - 策略信誉按模型版本分区存储
 *
 * 功能：
 * - detectModelVersion：从 model 标识派生稳定版本键（如 "doubao-seed-2.1-pro" →
 *   "doubao-seed-2.1-pro"）。版本键粒度为主模型名，不含 region/deployment 后缀，
 *   避免因部署 region 变化误判为新版本。
 * - isNewVersion：检测当前模型版本是否在策略库中无任何观察记录。
 * - initializeVersion：为新模型版本初始化弱先验分区（不继承旧版本数据）。
 * - decayPriors：可选的先验衰减——对长期未更新的旧版本分区，按衰减因子收缩
 *   alpha/beta（保留方向但降低权重），使新证据逐渐主导。默认关闭。
 *
 * 禁止：跨版本拷贝 alpha/beta（那会让旧模型虚假高胜率污染新模型）。
 */

import type { StrategyPolicyStore, StrategyReputation } from "./strategy-policy-store.js";
import { WEAK_PRIOR_ALPHA, WEAK_PRIOR_BETA } from "./strategy-policy-store.js";

// ============================================================================
// 常量
// ============================================================================

/** 衰减因子：每次衰减将 alpha/beta 向弱先验收缩 20% */
export const DEFAULT_DECAY_FACTOR = 0.2;

/** 触发衰减的空闲天数（分区 lastUpdated 超过此天数才衰减） */
export const DECAY_IDLE_DAYS = 30;

// ============================================================================
// 模型版本键派生
// ============================================================================

/**
 * 从模型标识派生稳定版本键。
 *
 * 规则：
 * - 取主模型名，去掉 region/deployment 后缀（如 "-260628"、":us-central1"）
 * - 小写化
 * - 例："doubao-seed-2-1-pro-260628" → "doubao-seed-2-1-pro"
 *       "gpt-5.5" → "gpt-5.5"
 *       "claude-opus-4.8" → "claude-opus-4.8"
 *
 * 这样同一主模型的不同部署不会被误判为新版本；而主模型升级（如 doubao → doubao-2）
 * 会产生新版本键，触发弱先验初始化。
 */
export function detectModelVersion(model: string | undefined | null): string {
  if (!model) return "unknown";
  let key = model.toLowerCase();
  // 去掉日期后缀（如 -260628）
  key = key.replace(/-\d{6}$/, "");
  // 去掉 deployment 后缀（如 :us-central1、@2024-01-01）
  key = key.replace(/[:@].*$/, "");
  return key;
}

// ============================================================================
// 版本隔离
// ============================================================================

export class ModelVersionMigration {
  /**
   * 检测模型版本是否在策略库中无任何观察记录（新版本）。
   */
  isNewVersion(store: StrategyPolicyStore, modelVersion: string): boolean {
    const active = store.listActiveStrategies(modelVersion);
    // 无 active 策略 = 该版本无观察记录（listActive 返回空）
    // 注意：listActive 过滤了 dormant/retired，新版本应无任何记录
    return active.length === 0 && !this.hasPartition(store, modelVersion);
  }

  /**
   * 检测该版本是否有任何分区数据（含 dormant/retired）。
   */
  hasPartition(store: StrategyPolicyStore, modelVersion: string): boolean {
    const data = store.toJSON();
    const partition = data.partitions[modelVersion];
    if (!partition) return false;
    return Object.keys(partition).length > 0;
  }

  /**
   * 为新模型版本初始化弱先验分区。
   *
   * 关键约束（计划 §Phase 6）：不继承旧版本的 alpha/beta。
   * 新版本从空分区起步，策略信誉按需在首次 recordOutcome 时以弱先验创建。
   * 此函数只在 store 中注册一个空分区标记，确保后续 isNewVersion 返回 false。
   *
   * 返回初始化说明（供审计）。
   */
  initializeVersion(
    store: StrategyPolicyStore,
    modelVersion: string,
    knownStrategyIds: string[]
  ): { modelVersion: string; inheritedFrom: null; strategyCount: number } {
    // 不拷贝旧版本数据；只为已知策略注册未准入弱先验条目。
    for (const strategyId of knownStrategyIds) {
      const rep = store.getReputation(strategyId, modelVersion);
      // getReputation 返回弱先验实例；显式 put 使其落盘
      store.putReputation({
        ...rep,
        alpha: WEAK_PRIOR_ALPHA,
        beta: WEAK_PRIOR_BETA,
        sampleCount: 0,
        status: "candidate",
      });
    }
    return {
      modelVersion,
      inheritedFrom: null, // 明确：不继承任何旧版本
      strategyCount: knownStrategyIds.length,
    };
  }

  /**
   * 先验衰减：对长期未更新的旧版本分区，按衰减因子向弱先验收缩。
   *
   * 衰减公式：alpha' = alpha + (WEAK_PRIOR_ALPHA - alpha) * factor
   *           beta'  = beta  + (WEAK_PRIOR_BETA  - beta)  * factor
   * 保留方向（alpha>beta 的策略仍偏 win），但降低旧证据权重，使新证据主导。
   *
   * @param currentModelVersion 当前活跃版本，不衰减
   * @param factor 衰减因子 0-1，越大收缩越快
   * @param idleDaysMs 触发衰减的空闲时长（毫秒）
   * @returns 衰减的版本列表（供审计）
   */
  decayPriors(
    store: StrategyPolicyStore,
    currentModelVersion: string,
    factor: number = DEFAULT_DECAY_FACTOR,
    idleDaysMs: number = DECAY_IDLE_DAYS * 24 * 60 * 60 * 1000
  ): string[] {
    const data = store.toJSON();
    const now = Date.now();
    const decayed: string[] = [];

    for (const version of Object.keys(data.partitions)) {
      if (version === currentModelVersion) continue;
      const partition = data.partitions[version];
      if (!partition) continue;

      // 取分区最新更新时间
      const updatedAt = Math.max(
        ...Object.values(partition).map((r) =>
          new Date(r.lastUpdated).getTime()
        )
      );
      if (now - updatedAt < idleDaysMs) continue;

      // 衰减该分区所有策略
      for (const strategyId of Object.keys(partition)) {
        const rep: StrategyReputation = partition[strategyId];
        rep.alpha = rep.alpha + (WEAK_PRIOR_ALPHA - rep.alpha) * factor;
        rep.beta = rep.beta + (WEAK_PRIOR_BETA - rep.beta) * factor;
        rep.lastUpdated = new Date().toISOString();
        store.putReputation(rep);
      }
      decayed.push(version);
    }
    return decayed;
  }
}

export function createModelVersionMigration(): ModelVersionMigration {
  return new ModelVersionMigration();
}
