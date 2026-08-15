/**
 * ContextualStrategySelector — 上下文策略选择器（Phase 6，计划 §Phase 6）
 *
 * 使用 Thompson Sampling 在线选择 0-2 个编辑策略。
 *
 * 设计原则（计划 §Phase 6）：
 * - Thompson Sampling：对每个 active 策略从 Beta(alpha, beta) 采样，取 top-K
 * - 0-2 个策略：不固定多候选；采样值低于阈值的不选（保留探索，但不强凑数）
 * - candidate/dormant/retired 策略不参与采样
 * - candidate 交回静态 registry，保留 opportunity hypothesis 与证据收集路径
 * - 可复现：传入 seed 使采样确定性
 *
 * 与旧 EditorialStrategyRegistry.pickStrategyForHypothesis 的区别：
 * - 旧逻辑：固定取 opportunityType 下第一个策略（无学习）
 * - 新逻辑：在候选策略集上 Thompson Sampling，根据历史胜负调整选择概率
 *
 * 退出条件（计划 §Phase 6）：策略会根据正常写作反馈调整调用概率。
 */

import type { StrategyPolicyStore, StrategyReputation } from "./strategy-policy-store.js";
import type { EditorialStrategyDef } from "../core/editorial-strategy-registry.js";
import { buildStrategyBundleId } from "./feedback-evidence-contracts.js";

// ============================================================================
// 常量
// ============================================================================

/** 最多选择 2 个策略（计划：0-2 候选） */
export const MAX_SELECTED = 2;

/** 采样值低于此阈值的策略不选（0.5 = 中性，低于则不优于随机） */
export const SELECTION_THRESHOLD = 0.5;

// ============================================================================
// 类型
// ============================================================================

export interface StrategySelection {
  /** 选中的策略定义（0-2 个） */
  selected: EditorialStrategyDef[];
  /** 未准入策略：不采样，由调用方按静态 registry 保留 hypothesis。 */
  staticFallback: EditorialStrategyDef[];
  /** 采样详情（供审计：每个候选策略的采样值） */
  samples: StrategySample[];
  /** 未选原因（供可解释性） */
  notes: string[];
  /**
   * 实际暴露快照（USER-FEEDBACK-EVIDENCE-PIPELINE-1）。
   * 记录真实被选中的策略集合与 bundle，供 trace / 反馈归因使用。
   * 注意：这是选择快照，不是采样全部结果。
   */
  exposureSnapshot: {
    strategyIds: string[];
    strategyBundleId: string;
    selectedCount: number;
  };
}

export interface StrategySample {
  strategyId: string;
  alpha: number;
  beta: number;
  sampled: number;
  status: string;
  selected: boolean;
}

export interface StrategySelectorInput {
  /** 候选策略集（由 EditorialStrategyRegistry 按 opportunityType 过滤后传入） */
  candidates: EditorialStrategyDef[];
  /** 当前模型版本键 */
  modelVersion: string;
  /** 策略信誉存储 */
  policyStore: StrategyPolicyStore;
  /** 随机种子（可复现；不传则随机） */
  seed?: number;
  /** 可选：覆盖最大选择数（默认 MAX_SELECTED） */
  maxSelected?: number;
  /** 可选：覆盖选择阈值（默认 SELECTION_THRESHOLD） */
  threshold?: number;
}

// ============================================================================
// ContextualStrategySelector
// ============================================================================

export class ContextualStrategySelector {
  /**
   * Thompson Sampling 选择 0-2 个策略。
   *
   * 流程：
   * 1. 对每个候选策略，从其信誉的 Beta(alpha, beta) 采样
   * 2. candidate 不采样并交回 staticFallback；dormant/retired 直接过滤
   * 3. 按采样值降序排序
   * 4. 取采样值 >= 阈值的前 K 个
   * 5. 已准入策略全部低于阈值且无 candidate fallback 时返回空
   */
  select(input: StrategySelectorInput): StrategySelection {
    const {
      candidates,
      modelVersion,
      policyStore,
      seed,
      maxSelected = MAX_SELECTED,
      threshold = SELECTION_THRESHOLD,
    } = input;

    const rng = createRng(seed);
    const samples: StrategySample[] = [];
    const notes: string[] = [];
    const staticFallback: EditorialStrategyDef[] = [];

    // 采样每个候选策略
    for (const strat of candidates) {
      const rep = policyStore.getReputation(strat.strategyId, modelVersion);

      if (rep.status === "candidate") {
        samples.push({
          strategyId: strat.strategyId,
          alpha: rep.alpha,
          beta: rep.beta,
          sampled: 0,
          status: rep.status,
          selected: false,
        });
        staticFallback.push(strat);
        notes.push(`${strat.strategyId} 尚未通过 evidence admission，跳过在线采样并使用静态 registry`);
        continue;
      }

      if (rep.status === "dormant" || rep.status === "retired") {
        samples.push({
          strategyId: strat.strategyId,
          alpha: rep.alpha,
          beta: rep.beta,
          sampled: 0,
          status: rep.status,
          selected: false,
        });
        notes.push(`${strat.strategyId} 状态为 ${rep.status}，跳过采样`);
        continue;
      }

      const sampled = sampleBeta(rep.alpha, rep.beta, rng);
      samples.push({
        strategyId: strat.strategyId,
        alpha: rep.alpha,
        beta: rep.beta,
        sampled,
        status: rep.status,
        selected: false, // 后续统一标记
      });
    }

    // 按采样值降序排序，取 top-K 且 >= 阈值
    const eligible = samples
      .filter((s) => s.status === "active" && s.sampled >= threshold)
      .sort((a, b) => b.sampled - a.sampled)
      .slice(0, maxSelected);

    // 标记选中
    const selectedIds = new Set(eligible.map((s) => s.strategyId));
    for (const s of samples) {
      if (selectedIds.has(s.strategyId)) {
        s.selected = true;
      }
    }

    // 构建选中策略定义列表（保持采样降序）
    const selected = eligible
      .map((s) => candidates.find((c) => c.strategyId === s.strategyId))
      .filter((c): c is EditorialStrategyDef => c !== undefined);

    if (selected.length === 0 && staticFallback.length === 0) {
      notes.push(
        `所有候选策略采样值 < ${threshold}（或无 active 候选），选择 0 个策略，交付 raw`
      );
    }

    // 实际暴露：优先 selected；若 selected 为空且存在 staticFallback，记录 fallback 暴露
    // （调用方可能仍按静态 registry 生成候选）。反馈归因应使用真实交付后的 exposure。
    const exposedIds =
      selected.length > 0
        ? selected.map((s) => s.strategyId)
        : [];
    const exposureSnapshot = {
      strategyIds: exposedIds,
      strategyBundleId: buildStrategyBundleId(exposedIds),
      selectedCount: exposedIds.length,
    };

    return { selected, staticFallback, samples, notes, exposureSnapshot };
  }
}

export function createContextualStrategySelector(): ContextualStrategySelector {
  return new ContextualStrategySelector();
}

// ============================================================================
// Beta 分布采样（Gamma 分布法）
// ============================================================================

/**
 * 从 Beta(alpha, beta) 采样。
 *
 * 使用 Gamma 分布法：Beta(a,b) = X/(X+Y)，X~Gamma(a,1), Y~Gamma(b,1)。
 * Gamma 采样用 Marsaglia-Tsang 方法。
 *
 * alpha/beta >= 1 时稳定；< 1 时（弱先验边界）仍可用但需特殊处理。
 * 弱先验 Beta(1,1) = 均匀分布，sampleBeta(1,1) = rng()。
 */
function sampleBeta(alpha: number, beta: number, rng: () => number): number {
  // 边界：alpha 或 beta 极小时退化为 rng（避免 Gamma 采样数值问题）
  if (alpha <= 0 || beta <= 0) return rng();
  if (alpha === 1 && beta === 1) return rng();

  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  const sum = x + y;
  if (sum === 0) return 0.5; // 数值退化兜底
  return Math.min(1, Math.max(0, x / sum));
}

/**
 * Gamma(shape, 1) 采样（Marsaglia-Tsang）。
 * shape >= 1 时使用标准方法；shape < 1 时用 boosting。
 */
function sampleGamma(shape: number, rng: () => number): number {
  if (shape < 1) {
    // boosting：Gamma(s) = Gamma(s+1) * U^(1/s)
    const u = rng();
    if (u <= 0) return 0;
    return sampleGamma(shape + 1, rng) * Math.pow(u, 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let x: number;
    let v: number;
    do {
      x = sampleNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * 标准正态分布采样（Box-Muller）。
 */
function sampleNormal(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ============================================================================
// 可复现随机数生成器（mulberry32）
// ============================================================================

function createRng(seed?: number): () => number {
  if (seed === undefined) {
    return Math.random;
  }
  let s = seed >>> 0;
  return function (): number {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
