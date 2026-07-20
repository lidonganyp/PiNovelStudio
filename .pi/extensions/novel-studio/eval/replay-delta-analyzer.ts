/**
 * PiNovelStudio — Replay Delta Analyzer (P9-T1/T2/T3/T4)
 *
 * 历史依据：PiNovelStudio-Agentic创作流水线升级方案 P9（文档已删除）；当前架构见 docs/top-tier-chinese-novel-system-development-plan.md
 * 目标：对比两次 replay 差异，提取候选规则，晋级到 validated。
 *
 * 4 条件晋级标准（P9-T4）：
 *   1. sampleSize ≥ 3
 *   2. validatedWinRate ≥ 0.55
 *   3. 下一轮 trace 出现 active validated rule
 *   4. 人工抽检无退化（需 human flag）
 */

// ============================================================================
// 类型定义
// ============================================================================

export interface ReplaySample {
  readonly sampleId: string;
  readonly chapterId: string;
  readonly passed: boolean;
  readonly metrics: {
    readonly progression?: number;
    readonly hook?: number;
    readonly choiceStrength?: number;
    readonly infoIncrement?: number;
    readonly readOn?: number;
    readonly subtext?: number;
    readonly antiAI?: number;
    readonly blindTest?: number;
  };
  readonly ruleHits?: readonly string[];
}

export interface ReplayDeltaReport {
  readonly sampleSize: number;
  readonly passCount: number;
  readonly failCount: number;
  readonly validatedWinRate: number;
  /** 4 条件晋级判定结果 */
  readonly promotionDecision: PromotionDecision;
  /** 差异分析报告 */
  readonly delta: {
    readonly avgProgression: number;
    readonly avgHook: number;
    readonly avgChoiceStrength: number;
    readonly avgReadOn: number;
  };
  readonly report: string;
}

export interface PromotionDecision {
  /** 条件 1：sampleSize ≥ 3 */
  readonly sampleSizeMet: boolean;
  /** 条件 2：validatedWinRate ≥ 0.55 */
  readonly winRateMet: boolean;
  /** 条件 3：下一轮 trace 出现 active validated rule */
  readonly activeRuleInTrace: boolean;
  /** 条件 4：人工抽检无退化 */
  readonly humanApproved: boolean;
  /** 4 条件 AND 门 */
  readonly canPromote: boolean;
  readonly reason: string;
}

// ============================================================================
// 候选规则提取（P9-T2）
// ============================================================================

export type RuleStatus = "candidate" | "validated" | "rejected";

export interface CandidateRule {
  readonly ruleId: string;
  readonly status: RuleStatus;
  readonly sampleSize: number;
  readonly winRate: number;
  readonly evidence: string;
  readonly extractedFrom: readonly string[];
}

export function extractCandidateRules(
  samples: readonly ReplaySample[]
): CandidateRule[] {
  const ruleMap = new Map<string, { wins: number; total: number; chapters: string[] }>();

  for (const s of samples) {
    if (!s.ruleHits) continue;
    for (const ruleId of s.ruleHits) {
      const entry = ruleMap.get(ruleId) ?? { wins: 0, total: 0, chapters: [] };
      entry.total++;
      if (s.passed) entry.wins++;
      entry.chapters.push(s.chapterId);
      ruleMap.set(ruleId, entry);
    }
  }

  const candidates: CandidateRule[] = [];
  for (const [ruleId, entry] of ruleMap) {
    const winRate = entry.total > 0 ? entry.wins / entry.total : 0;
    candidates.push({
      ruleId,
      status: "candidate",
      sampleSize: entry.total,
      winRate,
      evidence: `winRate=${winRate.toFixed(2)} samples=${entry.total}`,
      extractedFrom: entry.chapters,
    });
  }
  return candidates;
}

// ============================================================================
// Delta 分析（P9-T1）
// ============================================================================

export function analyzeReplayDelta(
  samples: readonly ReplaySample[],
  options: {
    activeRuleInTrace?: boolean;
    humanApproved?: boolean;
  } = {}
): ReplayDeltaReport {
  const sampleSize = samples.length;
  const passCount = samples.filter((s) => s.passed).length;
  const failCount = sampleSize - passCount;
  const validatedWinRate = sampleSize > 0 ? passCount / sampleSize : 0;

  const avg = (key: keyof ReplaySample["metrics"]) => {
    const vals = samples
      .map((s) => s.metrics[key])
      .filter((v): v is number => typeof v === "number");
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };

  const sampleSizeMet = sampleSize >= 3;
  const winRateMet = validatedWinRate >= 0.55;
  const activeRuleInTrace = options.activeRuleInTrace ?? false;
  const humanApproved = options.humanApproved ?? false;
  const canPromote = sampleSizeMet && winRateMet && activeRuleInTrace && humanApproved;

  const reasons: string[] = [];
  if (!sampleSizeMet) reasons.push(`sampleSize=${sampleSize} < 3`);
  if (!winRateMet) reasons.push(`winRate=${validatedWinRate.toFixed(2)} < 0.55`);
  if (!activeRuleInTrace) reasons.push("下一轮 trace 未出现 active validated rule");
  if (!humanApproved) reasons.push("人工抽检未通过");

  const decision: PromotionDecision = {
    sampleSizeMet,
    winRateMet,
    activeRuleInTrace,
    humanApproved,
    canPromote,
    reason: canPromote
      ? "4 条件全满足，可晋级 validated"
      : `未达晋级标准：${reasons.join("; ")}`,
  };

  const delta = {
    avgProgression: avg("progression"),
    avgHook: avg("hook"),
    avgChoiceStrength: avg("choiceStrength"),
    avgReadOn: avg("readOn"),
  };

  const report = canPromote
    ? `Replay 晋级通过：samples=${sampleSize} winRate=${validatedWinRate.toFixed(2)}`
    : `Replay 未晋级：${decision.reason}`;

  return {
    sampleSize,
    passCount,
    failCount,
    validatedWinRate,
    promotionDecision: decision,
    delta,
    report,
  };
}

// ============================================================================
// Contract 自动调参（P9-T3）
// ============================================================================

export interface ContractAutoTuneResult {
  readonly tuned: boolean;
  readonly oldThreshold: number;
  readonly newThreshold: number;
  readonly reason: string;
  /** 调参可回滚（记录 oldThreshold） */
  readonly rollback: () => void;
}

export function autoTuneContractThreshold(
  currentThreshold: number,
  winRate: number,
  options: { minSampleSize?: number; actualSampleSize?: number; adjustmentStep?: number } = {}
): ContractAutoTuneResult {
  const minSampleSize = options.minSampleSize ?? 3;
  const actualSampleSize = options.actualSampleSize ?? 0;
  const step = options.adjustmentStep ?? 0.05;

  // 样本不足 → 不调参
  if (actualSampleSize < minSampleSize) {
    return {
      tuned: false,
      oldThreshold: currentThreshold,
      newThreshold: currentThreshold,
      reason: `样本不足 (${actualSampleSize} < ${minSampleSize})，不调参`,
      rollback: () => {},
    };
  }

  // 胜率高 → 适度提高阈值（防止标准过松）
  // 胜率低 → 适度降低阈值（防止标准过严）
  let newThreshold = currentThreshold;
  if (winRate >= 0.7) {
    newThreshold = Math.min(1, currentThreshold + step);
  } else if (winRate < 0.4) {
    newThreshold = Math.max(0, currentThreshold - step);
  }

  const tuned = newThreshold !== currentThreshold;
  return {
    tuned,
    oldThreshold: currentThreshold,
    newThreshold,
    reason: tuned
      ? `winRate=${winRate.toFixed(2)} 调整阈值 ${currentThreshold} → ${newThreshold}`
      : `winRate=${winRate.toFixed(2)} 阈值保持 ${currentThreshold}`,
    rollback: () => {
      // 调用方可在外部分配新阈值，回滚时恢复 oldThreshold
    },
  };
}

// ============================================================================
// A/B 对比（P9-T5）
// ============================================================================

export interface ABGroupMetrics {
  readonly group: "A" | "B";
  readonly samples: readonly ReplaySample[];
  readonly avgProgression: number;
  readonly avgHook: number;
  readonly avgChoiceStrength: number;
  readonly avgReadOn: number;
  readonly avgAntiAI: number;
  readonly avgBlindTest: number;
  readonly winRate: number;
}

export interface ABComparisonReport {
  readonly groupA: ABGroupMetrics;
  readonly groupB: ABGroupMetrics;
  /** B 相对 A 的提升（正数=B 优） */
  readonly improvements: {
    readonly progression: number;
    readonly hook: number;
    readonly choiceStrength: number;
    readonly readOn: number;
    readonly antiAI: number;
    readonly blindTest: number;
  };
  readonly report: string;
}

export function compareABGroups(
  groupASamples: readonly ReplaySample[],
  groupBSamples: readonly ReplaySample[]
): ABComparisonReport {
  const computeMetrics = (group: "A" | "B", samples: readonly ReplaySample[]): ABGroupMetrics => {
    const avg = (key: keyof ReplaySample["metrics"]) => {
      const vals = samples
        .map((s) => s.metrics[key])
        .filter((v): v is number => typeof v === "number");
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    };
    const winRate = samples.length > 0
      ? samples.filter((s) => s.passed).length / samples.length
      : 0;
    return {
      group,
      samples,
      avgProgression: avg("progression"),
      avgHook: avg("hook"),
      avgChoiceStrength: avg("choiceStrength"),
      avgReadOn: avg("readOn"),
      avgAntiAI: avg("antiAI"),
      avgBlindTest: avg("blindTest"),
      winRate,
    };
  };

  const groupA = computeMetrics("A", groupASamples);
  const groupB = computeMetrics("B", groupBSamples);

  const improvements = {
    progression: groupB.avgProgression - groupA.avgProgression,
    hook: groupB.avgHook - groupA.avgHook,
    choiceStrength: groupB.avgChoiceStrength - groupA.avgChoiceStrength,
    readOn: groupB.avgReadOn - groupA.avgReadOn,
    antiAI: groupB.avgAntiAI - groupA.avgAntiAI,
    blindTest: groupB.avgBlindTest - groupA.avgBlindTest,
  };

  const report = `A/B 对比：B 组相对 A 组 progression ${improvements.progression >= 0 ? "+" : ""}${improvements.progression.toFixed(2)}, hook ${improvements.hook >= 0 ? "+" : ""}${improvements.hook.toFixed(2)}, readOn ${improvements.readOn >= 0 ? "+" : ""}${improvements.readOn.toFixed(2)}`;

  return { groupA, groupB, improvements, report };
}
