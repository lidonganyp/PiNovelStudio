/**
 * V2 FinalSelector — 最终交付选择器（P8）
 *
 * 范式：候选-比较-选择（规格 P8）
 *
 * 设计原则：
 * - 若候选未明显胜出，保留原文（规格 P7/P8）
 * - v2 输 rawStage2 → 标记本章负收益（规格 P8）
 * - direct 赢所有 → 标记本章负收益（规格 P8）
 * - v2 amplified 明显胜出 → 正收益，交付 amplified
 * - comparator 拒绝不覆盖：只写 selectedCandidateId 的 text
 *
 * projectGain 判定矩阵：
 * | winner source | clearWin over rawStage2 | selectedSource | projectGain |
 * |---------------|-------------------------|----------------|-------------|
 * | v2_amplified  | yes                     | v2_amplified   | positive    |
 * | v2_amplified  | no                      | rawStage2      | neutral     |
 * | rawStage2     | —                       | rawStage2      | negative    |
 * | direct        | —                       | direct         | negative    |
 *
 * "保留原文"语义：
 * - amplified 未明显胜出 → 保留 rawStage2（V2 不覆盖原文）
 * - rawStage2 未明显胜出 direct → 仍保留 rawStage2（rawStage2 是项目链路产物，
 *   direct 是裸模型基线；保留 rawStage2 不代表正收益，projectGain 仍为 negative）
 */

import type {
  Candidate,
  CandidateComparison,
  DimensionScores,
  Diagnostic,
  FinalSelectedSource,
  FinalSelectionReport,
  ProjectGain,
} from "./types.js";

// ============================================================================
// 常量
// ============================================================================

/** 默认明显胜出阈值（总分差 ≥ 5 视为明显胜出） */
export const DEFAULT_CLEAR_WIN_THRESHOLD = 5;

/**
 * 默认 confidence 门槛。confidence 低于此值不得判"明显胜出/positive"。
 *
 * confidence = (topScore - secondScore) / 100，0-1 归一化。
 * 0.15 意味着 winner 总分需领先 runner-up 至少 15 分（在 0-100 量纲下）才算明确胜出，
 * 避免低置信度（如 0.06）被包装成正收益。
 */
export const DEFAULT_CONFIDENCE_FLOOR = 0.15;

/** rawStage2 候选的 route 名（与 legacy-model-route-adapter V2_ROUTES.RAWSTAGE2 一致） */
export const RAWSTAGE2_ROUTE = "v2_rawstage2";

/** amplified 候选的 route 名（与 legacy-model-route-adapter V2_ROUTES.AMPLIFIED 一致） */
export const AMPLIFIED_ROUTE = "v2_amplified";

/** direct baseline 候选的 route 前缀 */
export const DIRECT_ROUTE_PREFIX = "v2_direct_";

// ============================================================================
// 候选来源分类
// ============================================================================

/**
 * 将候选映射到最终来源类型（direct / rawStage2 / v2_amplified）。
 *
 * 以 route 为权威来源（与 candidate-generator.routeForKind 对齐）：
 * - route === "v2_rawstage2" → rawStage2（context_enhanced 候选走此路由）
 * - route === "v2_amplified" → v2_amplified（scene_contract 候选走此路由）
 * - route 以 "v2_direct_" 开头 → direct（direct_baseline / style_aware / model_variant 走此路由）
 *
 * route 缺失时按 kind 兜底：
 * - kind === "context_enhanced" → rawStage2
 * - kind === "scene_contract" → v2_amplified
 * - 其余 → direct
 */
export function classifyCandidateSource(candidate: Candidate): FinalSelectedSource {
  // route 权威判定
  if (candidate.route === RAWSTAGE2_ROUTE) {
    return "rawStage2";
  }
  if (candidate.route === AMPLIFIED_ROUTE) {
    return "v2_amplified";
  }
  if (candidate.route?.startsWith(DIRECT_ROUTE_PREFIX)) {
    return "direct";
  }
  // kind 兜底（route 缺失或非标准值时）
  if (candidate.kind === "context_enhanced") {
    return "rawStage2";
  }
  if (candidate.kind === "scene_contract") {
    return "v2_amplified";
  }
  return "direct";
}

// ============================================================================
// 输入类型
// ============================================================================

export interface FinalSelectorInput {
  /** 候选比较器输出 */
  comparison: CandidateComparison;
  /** 全部候选（用于按 id 查找 source 类型） */
  candidates: Candidate[];
  /** 明显胜出阈值（总分差），默认 5 */
  clearWinThreshold?: number;
  /**
   * confidence 门槛，默认 0.15。
   * amplified 获胜时，confidence 低于此值不得判"明显胜出/positive"，
   * 避免低置信度（如 0.06）被包装成正收益。
   */
  confidenceFloor?: number;
  /**
   * 每个候选的 hard/fatal 诊断（按 candidateId 索引）。
   * 获胜候选若带未解决 hard 诊断，不得判 positive（降级 neutral 保留 rawStage2）。
   */
  hardDiagnosticsByCandidate?: Record<string, Diagnostic[]>;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 计算候选的 11 维总分（与 CandidateComparator.totalScore 同口径）。
 */
function totalScore(scores: DimensionScores): number {
  const values = Object.values(scores);
  if (values.length === 0) return 0;
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.round(sum / values.length);
}

/**
 * 按 source 类型分组候选，返回每组的最高总分候选 id。
 */
function findBestPerSource(
  candidates: Candidate[],
  dimensionScores: Record<string, DimensionScores>
): { direct?: string; rawStage2?: string; amplified?: string } {
  let best: { direct?: string; rawStage2?: string; amplified?: string } = {};
  let bestScores: { direct?: number; rawStage2?: number; amplified?: number } = {};

  for (const candidate of candidates) {
    const source = classifyCandidateSource(candidate);
    const score = totalScore(dimensionScores[candidate.id] || {});
    const key = source === "v2_amplified" ? "amplified" : source;
    if (bestScores[key] === undefined || score > (bestScores[key] ?? -1)) {
      bestScores[key] = score;
      best[key] = candidate.id;
    }
  }

  return best;
}

// ============================================================================
// FinalSelector 主类
// ============================================================================

export class FinalSelector {
  /**
   * 选择最终交付候选，并判定项目收益。
   *
   * 步骤：
   * 1. 从 comparison.winnerId 确定获胜候选
   * 2. 分类 winner 的 source（direct/rawStage2/v2_amplified）
   * 3. 找出每组 source 的最佳候选
   * 4. 按判定矩阵决定 selectedSource + projectGain
   * 5. 收集 whySelected / whyRejected 理由
   */
  select(input: FinalSelectorInput): FinalSelectionReport {
    const { comparison, candidates } = input;
    const threshold = input.clearWinThreshold ?? DEFAULT_CLEAR_WIN_THRESHOLD;
    const confidenceFloor = input.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;
    const hardDiagsByCandidate = input.hardDiagnosticsByCandidate ?? {};

    // 空候选保护
    if (candidates.length === 0 || !comparison.winnerId) {
      return {
        selectedCandidateId: "",
        selectedSource: "direct",
        projectGain: "negative",
        whySelected: ["no candidates provided"],
        whyRejected: [],
        acceptedRepairs: comparison.acceptedRepairs,
        rejectedRepairs: comparison.rejectedRepairs,
      };
    }

    const winnerId = comparison.winnerId;
    const winner = candidates.find((c) => c.id === winnerId);
    if (!winner) {
      return {
        selectedCandidateId: "",
        selectedSource: "direct",
        projectGain: "negative",
        whySelected: [`winnerId=${winnerId} not found in candidates`],
        whyRejected: [],
        acceptedRepairs: comparison.acceptedRepairs,
        rejectedRepairs: comparison.rejectedRepairs,
      };
    }

    const winnerSource = classifyCandidateSource(winner);
    const bestPerSource = findBestPerSource(candidates, comparison.dimensionScores);

    // 计算各组最高分
    const amplifiedScore = bestPerSource.amplified
      ? totalScore(comparison.dimensionScores[bestPerSource.amplified])
      : -1;
    const rawStage2Score = bestPerSource.rawStage2
      ? totalScore(comparison.dimensionScores[bestPerSource.rawStage2])
      : -1;
    const directScore = bestPerSource.direct
      ? totalScore(comparison.dimensionScores[bestPerSource.direct])
      : -1;

    const whySelected: string[] = [];
    const whyRejected: string[] = [];

    // 按判定矩阵决策
    let selectedSource: FinalSelectedSource;
    let projectGain: ProjectGain;
    let selectedCandidateId: string;

    if (winnerSource === "v2_amplified") {
      // amplified 获胜，检查是否"明显胜出"——四重门槛（Phase D 改造第 2 门）：
      //   (a) score diff ≥ threshold（amplified-vs-rawStage2 总分差）
      //   (b) Phase D: amplifiedBaselineMargin ≥ threshold（替代原 confidenceOk）
      //       - amplified-vs-rawStage2 决策指标，解决 tie 场景 confidence=0 死锁
      //       - 向后兼容：旧 trace 无 amplifiedBaselineMargin 字段时 fallback 到 confidenceOk
      //   (c) winner 无未解决 hard/fatal 诊断（hard 诊断不得正收益交付）
      //   (d) antiRegression 未退化（score≥95 或 regressedChecks 为空）
      const hasRawStage2 = bestPerSource.rawStage2 !== undefined;
      const scoreDiffOk = !hasRawStage2 || amplifiedScore - rawStage2Score >= threshold;

      // Phase D: amplifiedBaselineMarginOk 替换 confidenceOk
      // 语义：amplified 胜过 rawStage2 的总分差 >= threshold 即可，不再依赖 winner-vs-runnerup confidence
      // 向后兼容：旧 comparison 无 amplifiedBaselineMargin 字段时，fallback 到原 confidenceOk 逻辑
      const hasAmplifiedBaselineMargin = comparison.amplifiedBaselineMargin !== undefined;
      const amplifiedBaselineMarginOk = hasAmplifiedBaselineMargin
        ? (comparison.amplifiedBaselineMargin as number) >= threshold
        : comparison.confidence >= confidenceFloor; // 向后兼容

      const winnerHardDiags = hardDiagsByCandidate[winnerId] ?? [];
      const hardDiagsOk = winnerHardDiags.length === 0;

      // P2 第 4 门：antiRegression 退化防护
      // 语义：score=100 ⟺ 无退化证据（通过）；score<95 且有 regressedChecks → 阻断 positive
      // score=100 但 regressedChecks 非空（check 4/5/6 运行时 evidence 缺失）算通过
      // 向后兼容：旧 trace 无 antiRegressionDetailsByCandidate 字段 → 按无退化证据处理（通过）
      const winnerAntiRegression = comparison.antiRegressionDetailsByCandidate?.[winnerId];
      const hasRegressionEvidence =
        !!winnerAntiRegression &&
        winnerAntiRegression.regressedChecks.length > 0;
      const winnerAntiRegressionScore = winnerAntiRegression?.score ?? 100;
      const antiRegressionOk =
        !hasRegressionEvidence || winnerAntiRegressionScore >= 95;

      // clearWin 4 门:scoreDiffOk && amplifiedBaselineMarginOk && hardDiagsOk && antiRegressionOk
      const clearWin = scoreDiffOk && amplifiedBaselineMarginOk && hardDiagsOk && antiRegressionOk;

      if (clearWin) {
        // 明显胜出 → 正收益，交付 amplified
        selectedSource = "v2_amplified";
        projectGain = "positive";
        selectedCandidateId = winnerId;
        whySelected.push(
          `v2_amplified 明显胜出：amplifiedScore=${amplifiedScore}` +
            (hasRawStage2 ? ` - rawStage2Score=${rawStage2Score} = ${amplifiedScore - rawStage2Score} >= ${threshold}` : "（无 rawStage2 候选）") +
            `；amplifiedBaselineMargin=${comparison.amplifiedBaselineMargin ?? "N/A"} >= ${threshold}` +
            `；winner hard 诊断=0` +
            `；antiRegression=${winnerAntiRegressionScore}${hasRegressionEvidence ? `（regressedChecks=[${winnerAntiRegression!.regressedChecks.join(",")}]` : "（无退化证据）"}`
        );
        if (hasRawStage2) {
          whyRejected.push(
            `rawStage2(${bestPerSource.rawStage2}) 未明显胜出：score=${rawStage2Score}，差距 ${amplifiedScore - rawStage2Score} < ${threshold}`
          );
        }
      } else {
        // amplified 获胜但未明显胜出 → 保留 rawStage2，neutral
        selectedSource = "rawStage2";
        projectGain = "neutral";
        selectedCandidateId = bestPerSource.rawStage2 ?? winnerId;
        const blockers: string[] = [];
        if (!scoreDiffOk) {
          blockers.push(`scoreDiff=${amplifiedScore - rawStage2Score} < ${threshold}`);
        }
        if (!amplifiedBaselineMarginOk) {
          blockers.push(
            hasAmplifiedBaselineMargin
              ? `amplifiedBaselineMargin=${comparison.amplifiedBaselineMargin} < ${threshold}`
              : `confidence=${comparison.confidence.toFixed(3)} < ${confidenceFloor}（向后兼容模式）`
          );
        }
        if (!hardDiagsOk) {
          blockers.push(`winner 带 ${winnerHardDiags.length} 条 hard 诊断`);
        }
        if (!antiRegressionOk) {
          blockers.push(
            `antiRegression=${winnerAntiRegressionScore} < 95（regressedChecks=[${winnerAntiRegression!.regressedChecks.join(",")}]）`
          );
        }
        whySelected.push(
          `v2_amplified 获胜但未明显胜出（${blockers.join("；")}），保留 rawStage2 原文`
        );
        whyRejected.push(
          `v2_amplified(${winnerId}) 未明显胜出 rawStage2（${blockers.join("；")}），不覆盖原文`
        );
      }
    } else if (winnerSource === "rawStage2") {
      // rawStage2 获胜 → v2 输 rawStage2 → 负收益
      selectedSource = "rawStage2";
      projectGain = "negative";
      selectedCandidateId = winnerId;
      whySelected.push(
        `rawStage2 获胜（v2_amplified 未胜出）：rawStage2Score=${rawStage2Score}` +
          (amplifiedScore >= 0 ? ` >= amplifiedScore=${amplifiedScore}` : "（无 amplified 候选）")
      );
      whyRejected.push(
        amplifiedScore >= 0
          ? `v2_amplified(${bestPerSource.amplified}) 未胜出 rawStage2：amplifiedScore=${amplifiedScore} < rawStage2Score=${rawStage2Score}`
          : "无 v2_amplified 候选参与比较"
      );
    } else {
      // direct 获胜 → 整条项目链路负收益
      selectedSource = "direct";
      projectGain = "negative";
      selectedCandidateId = winnerId;
      whySelected.push(
        `direct baseline 获胜（项目链路未胜出裸模型）：directScore=${directScore}`
      );
      whyRejected.push(
        rawStage2Score >= 0
          ? `rawStage2(${bestPerSource.rawStage2}) 未胜出 direct：rawStage2Score=${rawStage2Score} < directScore=${directScore}`
          : "无 rawStage2 候选"
      );
      if (amplifiedScore >= 0) {
        whyRejected.push(
          `v2_amplified(${bestPerSource.amplified}) 未胜出 direct：amplifiedScore=${amplifiedScore} < directScore=${directScore}`
        );
      }
    }

    // 补充 comparison.reasons 中的维度优势信息
    if (comparison.reasons.length > 0) {
      const advantageReason = comparison.reasons.find((r) => r.includes("优势维度"));
      if (advantageReason) {
        whySelected.push(advantageReason);
      }
    }

    return {
      selectedCandidateId,
      selectedSource,
      projectGain,
      whySelected,
      whyRejected,
      acceptedRepairs: comparison.acceptedRepairs,
      rejectedRepairs: comparison.rejectedRepairs,
    };
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

export function createFinalSelector(): FinalSelector {
  return new FinalSelector();
}
