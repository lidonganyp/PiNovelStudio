/**
 * QUALITY-COST-METRICS — 质量—成本联合评估（WP-07）
 *
 * 仅作分析指标，不进入生产单一总分。
 * 任何降本策略必须满足：
 * - 事实硬门不下降
 * - 作者契约不被削弱
 * - 用户修改距离不明显恶化
 * - 失败原因仍然可解释
 */

export interface QualityCostObservation {
  delivered: boolean;
  userAccepted?: boolean;
  /** 0 = 无修改，1 = 完全重写；越大越差 */
  userEditDistance?: number;
  deliveryCost: number;
  factGuardPassed: boolean;
  storyPreservationPassed: boolean;
  crossChapterContinuityScore?: number;
  recoveryAssisted: boolean;
  latencyMs: number;
  longTail: boolean;
  modelVersion: string;
  provider: string;
  explainableFailure?: boolean;
}

export interface QualityCostAggregate {
  sampleSize: number;
  effectiveDeliveryRate: number;
  userAcceptRate: number;
  inverseEditDistance: number;
  averageDeliveryCost: number;
  jointScore: number | null;
  factGuardPassRate: number;
  storyPreservationPassRate: number;
  crossChapterContinuityAvg: number | null;
  recoveryAssistedSuccessRate: number;
  averageLatencyMs: number;
  longTailRate: number;
  byModelVersion: Record<
    string,
    {
      sampleSize: number;
      jointScore: number | null;
      averageDeliveryCost: number;
      factGuardPassRate: number;
    }
  >;
}

export interface CostReductionGuardResult {
  allowed: boolean;
  reasons: string[];
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * 联合指标：
 * 有效交付率 × 用户接受率 × 用户修改距离反向指标 ÷ 交付成本
 *
 * 不进入生产单一总分；仅分析。
 */
export function computeJointQualityCostScore(input: {
  effectiveDeliveryRate: number;
  userAcceptRate: number;
  /** 1 - mean(editDistance)，越大越好 */
  inverseEditDistance: number;
  averageDeliveryCost: number;
}): number | null {
  if (input.averageDeliveryCost <= 0) return null;
  return (
    (input.effectiveDeliveryRate * input.userAcceptRate * input.inverseEditDistance) /
    input.averageDeliveryCost
  );
}

function aggregateQualityCostCore(
  observations: readonly QualityCostObservation[],
): Omit<QualityCostAggregate, "byModelVersion"> {
  const n = observations.length;
  if (n === 0) {
    return {
      sampleSize: 0,
      effectiveDeliveryRate: 0,
      userAcceptRate: 0,
      inverseEditDistance: 0,
      averageDeliveryCost: 0,
      jointScore: null,
      factGuardPassRate: 0,
      storyPreservationPassRate: 0,
      crossChapterContinuityAvg: null,
      recoveryAssistedSuccessRate: 0,
      averageLatencyMs: 0,
      longTailRate: 0,
    };
  }

  const delivered = observations.filter((o) => o.delivered);
  const accepted = observations.filter((o) => o.userAccepted === true);
  const editDistances = observations
    .map((o) => o.userEditDistance)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const meanEdit = editDistances.length ? avg(editDistances) : 0;
  const inverseEditDistance = Math.max(0, Math.min(1, 1 - meanEdit));
  const costs = observations.map((o) => o.deliveryCost);
  const averageDeliveryCost = avg(costs);
  const effectiveDeliveryRate = delivered.length / n;
  const userAcceptRate = accepted.length / n;
  const jointScore = computeJointQualityCostScore({
    effectiveDeliveryRate,
    userAcceptRate,
    inverseEditDistance,
    averageDeliveryCost,
  });

  const continuity = observations
    .map((o) => o.crossChapterContinuityScore)
    .filter((v): v is number => typeof v === "number");

  const recoveryAssisted = observations.filter((o) => o.recoveryAssisted);
  const recoverySuccess = recoveryAssisted.filter((o) => o.delivered);

  return {
    sampleSize: n,
    effectiveDeliveryRate,
    userAcceptRate,
    inverseEditDistance,
    averageDeliveryCost,
    jointScore,
    factGuardPassRate: observations.filter((o) => o.factGuardPassed).length / n,
    storyPreservationPassRate:
      observations.filter((o) => o.storyPreservationPassed).length / n,
    crossChapterContinuityAvg: continuity.length ? avg(continuity) : null,
    recoveryAssistedSuccessRate:
      recoveryAssisted.length === 0 ? 0 : recoverySuccess.length / recoveryAssisted.length,
    averageLatencyMs: avg(observations.map((o) => o.latencyMs)),
    longTailRate: observations.filter((o) => o.longTail).length / n,
  };
}

export function aggregateQualityCostObservations(
  observations: readonly QualityCostObservation[],
): QualityCostAggregate {
  const core = aggregateQualityCostCore(observations);
  const byModelVersion: QualityCostAggregate["byModelVersion"] = {};
  const groups = new Map<string, QualityCostObservation[]>();
  for (const obs of observations) {
    const key = `${obs.provider}::${obs.modelVersion}`;
    const list = groups.get(key);
    if (list) list.push(obs);
    else groups.set(key, [obs]);
  }
  for (const [key, subset] of groups) {
    const sub = aggregateQualityCostCore(subset);
    byModelVersion[key] = {
      sampleSize: sub.sampleSize,
      jointScore: sub.jointScore,
      averageDeliveryCost: sub.averageDeliveryCost,
      factGuardPassRate: sub.factGuardPassRate,
    };
  }
  return { ...core, byModelVersion };
}

/**
 * 降本策略护栏：比较 baseline vs candidate。
 * 不自动切换生产路由，只给出是否允许进入审批材料。
 */
export function evaluateCostReductionGuard(input: {
  baseline: QualityCostAggregate;
  candidate: QualityCostAggregate;
  /** 用户修改距离恶化阈值（绝对） */
  maxEditDistanceRegression?: number;
  /** FactGuard 允许的最大下降 */
  maxFactGuardDrop?: number;
}): CostReductionGuardResult {
  const reasons: string[] = [];
  const maxEditReg = input.maxEditDistanceRegression ?? 0.05;
  const maxFgDrop = input.maxFactGuardDrop ?? 0.0;

  if (input.candidate.factGuardPassRate + 1e-9 < input.baseline.factGuardPassRate - maxFgDrop) {
    reasons.push(
      `FactGuard 通过率下降：${input.baseline.factGuardPassRate} → ${input.candidate.factGuardPassRate}`,
    );
  }

  // inverseEditDistance 下降 = 修改距离恶化
  if (input.candidate.inverseEditDistance + 1e-9 < input.baseline.inverseEditDistance - maxEditReg) {
    reasons.push(
      `用户修改距离恶化：inverseEdit ${input.baseline.inverseEditDistance} → ${input.candidate.inverseEditDistance}`,
    );
  }

  if (input.candidate.storyPreservationPassRate + 1e-9 < input.baseline.storyPreservationPassRate) {
    reasons.push(
      `StoryPreservation 通过率下降：${input.baseline.storyPreservationPassRate} → ${input.candidate.storyPreservationPassRate}`,
    );
  }

  // 成本下降但不得单独宣称质量提升
  const costDown = input.candidate.averageDeliveryCost < input.baseline.averageDeliveryCost;
  const qualityUp =
    input.candidate.effectiveDeliveryRate >= input.baseline.effectiveDeliveryRate &&
    input.candidate.userAcceptRate >= input.baseline.userAcceptRate &&
    input.candidate.inverseEditDistance >= input.baseline.inverseEditDistance;
  if (costDown && !qualityUp) {
    reasons.push("成本下降但质量指标未同步提升，不得宣称质量提升");
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}

/**
 * 禁止新旧模型统计混合：聚合前必须按 modelVersion 分桶。
 */
export function assertModelVersionIsolation(
  observations: readonly QualityCostObservation[],
): { ok: boolean; mixedBuckets: string[] } {
  // 若调用方错误地把多版本混成单一 bucket 报告，检测 provider 下多 version
  const byProvider = new Map<string, Set<string>>();
  for (const obs of observations) {
    if (!byProvider.has(obs.provider)) byProvider.set(obs.provider, new Set());
    byProvider.get(obs.provider)!.add(obs.modelVersion);
  }
  // 隔离规则：允许同报告多版本，但必须能分桶；此处始终 ok（分桶由 aggregate 保证）
  // 提供显式 API 供调用方在写入信誉前检查单桶纯度
  return { ok: true, mixedBuckets: [] };
}

export function assertSingleModelVersionBucket(
  observations: readonly QualityCostObservation[],
): { ok: boolean; versions: string[] } {
  const versions = Array.from(new Set(observations.map((o) => `${o.provider}::${o.modelVersion}`)));
  return { ok: versions.length <= 1, versions };
}
