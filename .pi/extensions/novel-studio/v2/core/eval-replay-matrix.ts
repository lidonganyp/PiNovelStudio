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
}

/**
 * 生成统一 A/B 矩阵比较报告。
 *
 * verdict 规则（确定性）：
 *  1. 零容忍违规（statePollution / productionPointerMutation /
 *     factHardGateViolation / duplicateSubmission）任一 > 0 → reject；
 *  2. candidate 缺失 → reject；
 *  3. candidate 相对 baseline 的 firstAttemptSuccessRate /
 *     recoveredSuccessRate 下降超过阈值 → reject；
 *  4. candidate 长尾失败增量超过阈值 → reject；
 *  5. 其余 → pass。
 * 文学偏好（humanBlindPreference）只存档，不影响 verdict。
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

  if (candidate === null) {
    reasons.push("矩阵缺少 candidate 臂（每次 A/B 必须包含 candidate）");
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

  const candidatePassAt3 = candidate ? computePassAtK(candidate.perSamplePass, 3) : null;
  const candidatePassPow3 = candidate ? computePassPowK(candidate.perSamplePass, 3) : null;

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
