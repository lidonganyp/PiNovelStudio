/**
 * 统一 A/B 回放矩阵与 pass@k / pass^k 计算器（离线回放与生产验收闭环 P3）
 *
 * 目标：将确定性安全回归、行为回归、能力评测和文学人工评测分开；
 * 每次 A/B 至少包含：当前唯一生产 baseline / candidate / raw-direct baseline /
 * recovery path。
 *
 * 指标规则（计划 §3 P3）：
 *  - 新能力使用 pass@3（k 次独立采样至少一次通过的无偏估计）；
 *  - 发布关键路径使用 pass^3（连续 k 次全部通过的观测率，要求 100%）；
 *  - 状态污染、生产指针修改、事实硬门违规必须按 0 次违规计算
 *    （零容忍指标：任一违规 → 矩阵 verdict=reject，与其他指标无关）；
 *  - 不使用单一总分自动选择文学 winner（文学偏好仅记录人工盲评结果，
 *    不参与机器 verdict）。
 *
 * 本地确定性，无 LLM 调用。
 */

// ============================================================================
// A/B 矩阵类型
// ============================================================================

export type MatrixArmId = "baseline" | "candidate" | "raw_direct" | "recovery";

export const MATRIX_ARM_IDS: ReadonlyArray<MatrixArmId> = [
  "baseline",
  "candidate",
  "raw_direct",
  "recovery",
];

/** 单臂（arm）统一指标。 */
export interface MatrixArmMetrics {
  armId: MatrixArmId;
  /** 绑定的 replay runId（证据追溯）。 */
  runId: string;
  /** 样本数（进入统计的样本）。 */
  sampleCount: number;
  /** 事实硬错误数（零容忍）。 */
  factHardErrors: number;
  /** 失败分类完整性：有归因的失败数 / 失败总数。 */
  failureClassificationCompleteness: number;
  /** coverage（0-1）。 */
  coverage: number;
  /** 完整性 completeness（0-1）。 */
  completeness: number;
  /** 连续性 continuity（0-1）。 */
  continuity: number;
  /** 用户编辑距离（越低越接近用户预期；人工/半自动测量）。 */
  userEditDistance: number | null;
  /** 模型调用次数总计。 */
  modelCalls: number;
  /** token 成本总计。 */
  tokenCost: number;
  /** 首次成功率（0-1）。 */
  firstAttemptSuccessRate: number;
  /** 自动恢复后成功率（0-1）。 */
  recoveredSuccessRate: number;
  /** P50 延迟（ms）。 */
  p50LatencyMs: number;
  /** P95 延迟（ms）。 */
  p95LatencyMs: number;
  /** 长尾失败数（超过 P95*2 或预算上限的失败）。 */
  longTailFailures: number;
  /** 逐样本通过布尔序列（pass@k / pass^k 输入）。 */
  perSamplePass: boolean[];
}

/** 零容忍违规（任一 > 0 → reject）。 */
export interface ZeroToleranceCounts {
  statePollution: number;
  productionPointerMutation: number;
  factHardGateViolation: number;
  duplicateSubmission: number;
}

export const EMPTY_ZERO_TOLERANCE: ZeroToleranceCounts = {
  statePollution: 0,
  productionPointerMutation: 0,
  factHardGateViolation: 0,
  duplicateSubmission: 0,
};

/** 人工盲评偏好记录（不参与机器 verdict，仅存档）。 */
export interface HumanBlindPreference {
  /** 盲评对数。 */
  pairs: number;
  /** baseline 被偏好次数。 */
  preferBaseline: number;
  /** candidate 被偏好次数。 */
  preferCandidate: number;
  /** 平局次数。 */
  ties: number;
  /** 评审人数量。 */
  reviewers: number;
}

export interface MatrixComparisonReport {
  schemaId: "pinovel.eval-replay-matrix";
  schemaVersion: 1;
  /** 比较的 release/bundle（candidate 身份）。 */
  candidateReleaseId: string;
  candidateBundleId: string;
  baselineReleaseId: string;
  createdAt: string;
  arms: MatrixArmMetrics[];
  zeroTolerance: ZeroToleranceCounts;
  /**
   * 机器 verdict：仅由确定性安全与状态指标决定。
   *  - reject：存在零容忍违规 / candidate 相对 baseline 出现不可接受退化；
   *  - pass：安全门槛全过（文学质量判断不在此列，归人工）。
   */
  verdict: "pass" | "reject";
  verdictReasons: string[];
  /** 能力 pass@3（candidate 新能力证据；null=样本不足）。 */
  candidatePassAt3: number | null;
  /** 发布关键回归 pass^3（candidate；要求 1.0）。 */
  candidatePassPow3: number | null;
  /** 人工盲评记录（可选；不参与 verdict）。 */
  humanBlindPreference?: HumanBlindPreference;
}

// ============================================================================
// pass@k（无偏估计）与 pass^k（连续全通过观测率）
// ============================================================================

/**
 * pass@k 无偏估计（Codex 论文标准公式）：
 * n 次独立采样中 c 次通过，
 *   pass@k = 1 - C(n-c, k) / C(n, k)。
 * n < k 或参数非法 → null（样本不足，不得宣称能力达标）。
 */
export function computePassAtK(perSamplePass: ReadonlyArray<boolean>, k: number): number | null {
  const n = perSamplePass.length;
  if (k <= 0 || n < k) {
    return null;
  }
  const c = perSamplePass.filter(Boolean).length;
  if (n === c) {
    return 1;
  }
  // 1 - C(n-c, k)/C(n, k) 的数值稳定形式：
  // product_{i=0..k-1} (n-c-i)/(n-i)
  let product = 1;
  for (let i = 0; i < k; i += 1) {
    product *= (n - c - i) / (n - i);
  }
  return Math.max(0, Math.min(1, 1 - product));
}

/**
 * pass^k 连续全通过观测率：把逐样本结果按顺序切分为长度 k 的连续组，
 * pass^k = 全通过组数 / 总组数。
 * n 不是 k 的整数倍 → 余数尾部样本单独成组，不足 k 的组按未通过计
 * （保守：发布关键路径不允许"凑样本"）。
 * n === 0 → null。
 */
export function computePassPowK(
  perSamplePass: ReadonlyArray<boolean>,
  k: number,
): number | null {
  const n = perSamplePass.length;
  if (n === 0 || k <= 0) {
    return null;
  }
  const groupCount = Math.ceil(n / k);
  let fullPassGroups = 0;
  for (let g = 0; g < groupCount; g += 1) {
    const start = g * k;
    const group = perSamplePass.slice(start, start + k);
    if (group.length === k && group.every(Boolean)) {
      fullPassGroups += 1;
    }
  }
  return fullPassGroups / groupCount;
}

// ============================================================================
// 延迟分位
// ============================================================================

export function percentile(sortedValues: ReadonlyArray<number>, p: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const sorted = [...sortedValues].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) {
    return sorted[low];
  }
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

// ============================================================================
// 矩阵比较
// ============================================================================

export interface CompareMatrixOptions {
  candidateReleaseId: string;
  candidateBundleId: string;
  baselineReleaseId: string;
  arms: MatrixArmMetrics[];
  zeroTolerance?: ZeroToleranceCounts;
  humanBlindPreference?: HumanBlindPreference;
  /**
   * 不可接受退化阈值（candidate 相对 baseline）：
   * firstAttemptSuccessRate / recoveredSuccessRate 允许的最大绝对下降。
   */
  maxSuccessRateRegression?: number;
  /** 长尾失败允许的最大绝对增量。 */
  maxLongTailIncrease?: number;
  /**
   * 能力指标最低阈值（每臂强制）：coverage / completeness / continuity。
   * 缺省取 DEFAULT_MIN_QUALITY_SCORE。设为更小值可放宽，但不得 > 1。
   * 能力门槛是发布强制条件（fail-closed），不允许通过 options 关闭。
   */
  minCoverage?: number;
  minCompleteness?: number;
  minContinuity?: number;
}

/** 能力指标默认最低阈值（coverage / completeness / continuity）。 */
export const DEFAULT_MIN_QUALITY_SCORE = 0.8;

/**
 * 生成统一 A/B 矩阵比较报告。
 *
 * verdict 规则（确定性，任一命中 → reject）：
 *  1. 零容忍违规（statePollution / productionPointerMutation /
 *     factHardGateViolation / duplicateSubmission）任一 > 0；
 *  2. 四臂不完整（baseline / candidate / raw_direct / recovery 缺一不可）；
 *  3. 任意臂 factHardErrors > 0（事实硬错零容忍）；
 *  4. 任意臂 failureClassificationCompleteness < 1（存在未分类失败）；
 *  5. 任意臂 coverage / completeness / continuity 低于最低阈值；
 *  6. candidate pass^3 !== 1（发布关键路径要求连续 3 次全通过；
 *     样本不足 → null 同样拒绝）；
 *  7. candidate 相对 baseline 的 firstAttemptSuccessRate /
 *     recoveredSuccessRate 下降超过阈值；
 *  8. candidate 长尾失败增量超过阈值。
 * 文学偏好（humanBlindPreference）只存档，不影响 verdict。
 * token / cost 为记录指标，不参与 verdict（成本非安全指标）。
 */
export function compareMatrixArms(options: CompareMatrixOptions): MatrixComparisonReport {
  const reasons: string[] = [];
  const zeroTolerance = options.zeroTolerance ?? EMPTY_ZERO_TOLERANCE;

  const candidate = options.arms.find((a) => a.armId === "candidate") ?? null;
  const baseline = options.arms.find((a) => a.armId === "baseline") ?? null;

  if (zeroTolerance.statePollution > 0) {
    reasons.push(`零容忍违规：正式状态污染 ${zeroTolerance.statePollution} 次`);
  }
  if (zeroTolerance.productionPointerMutation > 0) {
    reasons.push(`零容忍违规：production pointer 修改 ${zeroTolerance.productionPointerMutation} 次`);
  }
  if (zeroTolerance.factHardGateViolation > 0) {
    reasons.push(`零容忍违规：事实硬门违规 ${zeroTolerance.factHardGateViolation} 次`);
  }
  if (zeroTolerance.duplicateSubmission > 0) {
    reasons.push(`零容忍违规：重复提交 ${zeroTolerance.duplicateSubmission} 次`);
  }

  // -- 四臂完整性强制（EVAL-REPLAY-ACCEPTANCE-LOOP F2）-----------------------
  const completeness = validateMatrixArmCompleteness(options.arms);
  if (!completeness.complete) {
    reasons.push(
      `矩阵四臂不完整：缺少 ${completeness.missing.join(" / ")}（每次 A/B 必须包含 baseline / candidate / raw_direct / recovery）`,
    );
  }

  // -- 逐臂零容忍与能力门槛（F2：关键指标进入拒绝逻辑）-----------------------
  const minCoverage = options.minCoverage ?? DEFAULT_MIN_QUALITY_SCORE;
  const minCompleteness = options.minCompleteness ?? DEFAULT_MIN_QUALITY_SCORE;
  const minContinuity = options.minContinuity ?? DEFAULT_MIN_QUALITY_SCORE;
  for (const arm of options.arms) {
    if (arm.factHardErrors > 0) {
      reasons.push(`臂 ${arm.armId} 事实硬错 ${arm.factHardErrors} 次（零容忍，必须为 0）`);
    }
    if (arm.failureClassificationCompleteness < 1) {
      reasons.push(
        `臂 ${arm.armId} 失败分类完整率 ${arm.failureClassificationCompleteness.toFixed(3)} < 1（存在未分类失败）`,
      );
    }
    if (arm.coverage < minCoverage) {
      reasons.push(`臂 ${arm.armId} coverage ${arm.coverage.toFixed(3)} < 最低阈值 ${minCoverage}`);
    }
    if (arm.completeness < minCompleteness) {
      reasons.push(
        `臂 ${arm.armId} completeness ${arm.completeness.toFixed(3)} < 最低阈值 ${minCompleteness}`,
      );
    }
    if (arm.continuity < minContinuity) {
      reasons.push(`臂 ${arm.armId} continuity ${arm.continuity.toFixed(3)} < 最低阈值 ${minContinuity}`);
    }
  }

  // -- candidate pass^3 = 100% 强制（F2：发布关键路径门槛）--------------------
  const candidatePassAt3 = candidate ? computePassAtK(candidate.perSamplePass, 3) : null;
  const candidatePassPow3 = candidate ? computePassPowK(candidate.perSamplePass, 3) : null;
  if (candidate !== null) {
    if (candidate.perSamplePass.length < 3) {
      reasons.push(
        `candidate 样本数 ${candidate.perSamplePass.length} < 3（pass^3 样本不足，不得作为发布证据）`,
      );
    } else if (candidatePassPow3 !== 1) {
      reasons.push(
        `candidate pass^3 = ${candidatePassPow3?.toFixed(3)}（发布关键路径要求连续 3 次全通过 = 1.0）`,
      );
    }
  }

  const maxRegression = options.maxSuccessRateRegression ?? 0;
  const maxLongTail = options.maxLongTailIncrease ?? 0;
  if (candidate && baseline) {
    if (
      candidate.firstAttemptSuccessRate <
      baseline.firstAttemptSuccessRate - maxRegression
    ) {
      reasons.push(
        `candidate 首次成功率退化：${candidate.firstAttemptSuccessRate.toFixed(3)} < ` +
          `baseline ${baseline.firstAttemptSuccessRate.toFixed(3)}（允许下降 ${maxRegression}）`,
      );
    }
    if (
      candidate.recoveredSuccessRate <
      baseline.recoveredSuccessRate - maxRegression
    ) {
      reasons.push(
        `candidate 自动恢复后成功率退化：${candidate.recoveredSuccessRate.toFixed(3)} < ` +
          `baseline ${baseline.recoveredSuccessRate.toFixed(3)}（允许下降 ${maxRegression}）`,
      );
    }
    if (candidate.longTailFailures > baseline.longTailFailures + maxLongTail) {
      reasons.push(
        `candidate 长尾失败增量超限：${candidate.longTailFailures} > ` +
          `baseline ${baseline.longTailFailures} + ${maxLongTail}`,
      );
    }
  }

  return {
    schemaId: "pinovel.eval-replay-matrix",
    schemaVersion: 1,
    candidateReleaseId: options.candidateReleaseId,
    candidateBundleId: options.candidateBundleId,
    baselineReleaseId: options.baselineReleaseId,
    createdAt: new Date().toISOString(),
    arms: options.arms,
    zeroTolerance,
    verdict: reasons.length === 0 ? "pass" : "reject",
    verdictReasons: reasons,
    candidatePassAt3,
    candidatePassPow3,
    humanBlindPreference: options.humanBlindPreference,
  };
}

/**
 * 校验 A/B 矩阵完整性：每次 A/B 至少包含 baseline / candidate /
 * raw_direct / recovery 四臂（缺失 → 返回缺失清单）。
 */
export function validateMatrixArmCompleteness(
  arms: ReadonlyArray<MatrixArmMetrics>,
): { complete: boolean; missing: MatrixArmId[] } {
  const present = new Set(arms.map((a) => a.armId));
  const missing = MATRIX_ARM_IDS.filter((id) => !present.has(id));
  return { complete: missing.length === 0, missing };
}
