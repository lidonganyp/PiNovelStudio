/**
 * 不确定性驱动检索消融实验：多 seed 统计模块（Step 3）
 *
 * 提供 Wilson 置信区间、符号检验 p-value、均值/标准差 和多 seed 聚合统计，
 * 用于分离检索策略收益与生成随机性。
 *
 * 设计原则：
 * - 纯函数，不调用模型 API，不依赖 workspace fixture
 * - 统计方法：Wilson score interval（二项分布）、sign test（非参数）、样本标准差（n-1）
 * - computeSignTestPValue 为双侧检验（B 显著优于或差于 A 都算极端）
 * - computeMultiSeedStatistics 内部用单侧检验（只关心 B 是否优于 A）
 *
 * 授权边界：eval-only 模块，tsconfig.eval.json 注册。
 */

// ============================================================================
// 二项分布工具
// ============================================================================

/**
 * 计算二项式系数 C(n, k)。
 * 使用迭代乘法，避免直接计算阶乘溢出。
 * n <= 170 时结果在 double 范围内。
 */
export function binomialCoeff(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < kk; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

/**
 * P(X >= k) where X ~ Binomial(n, p)。
 * 单侧上尾概率。
 */
function binomialUpperTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let sum = 0;
  for (let i = k; i <= n; i++) {
    sum += binomialCoeff(n, i) * Math.pow(p, i) * Math.pow(1 - p, n - i);
  }
  // 浮点累积可能略微超过 1，钳制
  return Math.min(1, sum);
}

/**
 * P(X <= k) where X ~ Binomial(n, p)。
 * 单侧下尾概率。
 */
function binomialLowerTail(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    sum += binomialCoeff(n, i) * Math.pow(p, i) * Math.pow(1 - p, n - i);
  }
  return Math.min(1, sum);
}

// ============================================================================
// Wilson 置信区间
// ============================================================================

/**
 * Wilson score interval for a binomial proportion.
 *
 * 给定 successes/total，返回 [lower, upper] 置信区间（默认 z=1.96 = 95%）。
 * - 0/0 → [0, 0]
 * - successes > total → clamp 到 total（不返回 NaN）
 *
 * @param successes 成功数
 * @param total 总数
 * @param z z-value（默认 1.96 = 95% 置信；2.576 = 99%）
 * @returns [lower, upper] 置信区间边界
 */
export function computeWilsonInterval(
  successes: number,
  total: number,
  z: number = 1.96,
): [number, number] {
  if (total <= 0) return [0, 0];
  // clamp successes 到 [0, total]，避免 NaN
  const s = Math.max(0, Math.min(successes, total));
  const n = total;
  const phat = s / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denominator;
  const margin =
    (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denominator;
  const lower = Math.max(0, center - margin);
  const upper = Math.min(1, center + margin);
  return [lower, upper];
}

// ============================================================================
// 符号检验（双侧）
// ============================================================================

/**
 * 双侧符号检验 p-value。
 *
 * H0: B 不优于 A（positiveSigns 服从 Binomial(total, 0.5)）。
 * 双侧 p = 2 * min(P(X >= positiveSigns), P(X <= positiveSigns))，上限 1。
 *
 * - 0/0 → 1（无样本，无显著性）
 * - positiveSigns > total → clamp 到 total
 *
 * @param positiveSigns B 优于 A 的样本数
 * @param total 总样本数
 * @returns 双侧 p-value（0-1）
 */
export function computeSignTestPValue(
  positiveSigns: number,
  total: number,
): number {
  if (total <= 0) return 1;
  const k = Math.max(0, Math.min(positiveSigns, total));
  const upperTail = binomialUpperTail(k, total, 0.5);
  const lowerTail = binomialLowerTail(k, total, 0.5);
  const p = 2 * Math.min(upperTail, lowerTail);
  return Math.min(1, p);
}

// ============================================================================
// 均值与标准差
// ============================================================================

export interface MeanStd {
  mean: number;
  std: number;
}

/**
 * 计算样本均值与样本标准差（n-1 分母）。
 * - 空数组 → { mean: 0, std: 0 }
 * - 单元素 → { mean: value, std: 0 }（避免除以零）
 *
 * @param values 数值数组
 * @returns { mean, std }
 */
export function computeMeanStd(values: number[]): MeanStd {
  const n = values.length;
  if (n === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  if (n === 1) return { mean, std: 0 };
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  return { mean, std: Math.sqrt(variance) };
}

// ============================================================================
// 多 seed 聚合统计
// ============================================================================

export interface MultiSeedStatistics {
  seeds: number;
  passRate: number;
  bWinRate: {
    toolCalls: number;
    factGuardErrors: number;
    coverage: number;
  };
  signTestPValue: {
    toolCalls: number;
    factGuardErrors: number;
    coverage: number;
  };
  meanStd: {
    avgToolCallsA: MeanStd;
    avgToolCallsB: MeanStd;
    avgFactGuardErrorsA: MeanStd;
    avgFactGuardErrorsB: MeanStd;
    avgCoverageA: MeanStd;
    avgCoverageB: MeanStd;
  };
  wilsonInterval: {
    toolCalls: [number, number];
    factGuardErrors: [number, number];
    coverage: [number, number];
  };
}

/**
 * 多 seed 聚合统计输入结构（与 AblationResult 对齐，但只取需要的字段）。
 *
 * 兼容真实 AblationResult（aggregate.armA/armB + passCriteria.overallPassed）
 * 和测试 mock。avgCoverage 可选（真实 AggregatedMetrics 暂无此字段时回退 0）。
 */
interface SeedResultLike {
  aggregate: {
    armA: {
      avgToolCalls: number;
      avgFactGuardErrors: number;
      avgCoverage?: number;
    };
    armB: {
      avgToolCalls: number;
      avgFactGuardErrors: number;
      avgCoverage?: number;
    };
  };
  passCriteria: {
    overallPassed: boolean;
  };
}

/**
 * 多 seed 聚合统计。
 *
 * 对每个指标（toolCalls/factGuardErrors/coverage）计算：
 * - bWinRate：B 优于 A 的 seed 比例
 *   - toolCalls/factGuardErrors: B < A（越低越好）
 *   - coverage: B > A（越高越好）
 * - signTestPValue：单侧符号检验 P(X >= wins)（B 优于 A 的方向）
 * - meanStd：A/B 两组跨 seed 的均值与标准差
 * - wilsonInterval：bWinRate 的 Wilson 95% 置信区间
 *
 * @param seedResults 每 seed 的结果（含 aggregate + passCriteria）
 * @returns 多 seed 聚合统计
 */
export function computeMultiSeedStatistics(
  seedResults: SeedResultLike[],
): MultiSeedStatistics {
  const seeds = seedResults.length;
  if (seeds === 0) {
    const zero: MeanStd = { mean: 0, std: 0 };
    const zeroInterval: [number, number] = [0, 0];
    return {
      seeds: 0,
      passRate: 0,
      bWinRate: { toolCalls: 0, factGuardErrors: 0, coverage: 0 },
      signTestPValue: { toolCalls: 1, factGuardErrors: 1, coverage: 1 },
      meanStd: {
        avgToolCallsA: zero,
        avgToolCallsB: zero,
        avgFactGuardErrorsA: zero,
        avgFactGuardErrorsB: zero,
        avgCoverageA: zero,
        avgCoverageB: zero,
      },
      wilsonInterval: {
        toolCalls: zeroInterval,
        factGuardErrors: zeroInterval,
        coverage: zeroInterval,
      },
    };
  }

  const passRate =
    seedResults.filter((s) => s.passCriteria?.overallPassed).length / seeds;

  const aToolCalls = seedResults.map((s) => s.aggregate.armA.avgToolCalls);
  const bToolCalls = seedResults.map((s) => s.aggregate.armB.avgToolCalls);
  const aFg = seedResults.map((s) => s.aggregate.armA.avgFactGuardErrors);
  const bFg = seedResults.map((s) => s.aggregate.armB.avgFactGuardErrors);
  const aCov = seedResults.map((s) => s.aggregate.armA.avgCoverage ?? 0);
  const bCov = seedResults.map((s) => s.aggregate.armB.avgCoverage ?? 0);

  // B 优于 A 的 seed 数
  const toolCallsWins = seedResults.filter(
    (s) => s.aggregate.armB.avgToolCalls < s.aggregate.armA.avgToolCalls,
  ).length;
  const fgWins = seedResults.filter(
    (s) => s.aggregate.armB.avgFactGuardErrors < s.aggregate.armA.avgFactGuardErrors,
  ).length;
  const covWins = seedResults.filter(
    (s) =>
      (s.aggregate.armB.avgCoverage ?? 0) > (s.aggregate.armA.avgCoverage ?? 0),
  ).length;

  // 单侧符号检验 P(X >= wins)（B 优于 A 方向）
  const toolCallsP = binomialUpperTail(toolCallsWins, seeds, 0.5);
  const fgP = binomialUpperTail(fgWins, seeds, 0.5);
  const covP = binomialUpperTail(covWins, seeds, 0.5);

  return {
    seeds,
    passRate,
    bWinRate: {
      toolCalls: toolCallsWins / seeds,
      factGuardErrors: fgWins / seeds,
      coverage: covWins / seeds,
    },
    signTestPValue: {
      toolCalls: toolCallsP,
      factGuardErrors: fgP,
      coverage: covP,
    },
    meanStd: {
      avgToolCallsA: computeMeanStd(aToolCalls),
      avgToolCallsB: computeMeanStd(bToolCalls),
      avgFactGuardErrorsA: computeMeanStd(aFg),
      avgFactGuardErrorsB: computeMeanStd(bFg),
      avgCoverageA: computeMeanStd(aCov),
      avgCoverageB: computeMeanStd(bCov),
    },
    wilsonInterval: {
      toolCalls: computeWilsonInterval(toolCallsWins, seeds),
      factGuardErrors: computeWilsonInterval(fgWins, seeds),
      coverage: computeWilsonInterval(covWins, seeds),
    },
  };
}
