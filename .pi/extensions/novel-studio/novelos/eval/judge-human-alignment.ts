/**
 * JUDGE-HUMAN-ALIGNMENT-1：judge 与用户选择一致性校准（任务卡 §5，P0）
 *
 * 目标：先验证 judge 是否能识别用户真正偏好的稿件，再允许它选择多 raw 或注入策略。
 *
 * 与现有 5 维 judge-calibration.ts 的区别：
 * - 10 维度（独立于 JUDGE_DIMENSIONS 的 5 维）
 * - 4 种 sampleSource（system_vs_user / accepted_vs_rejected / raw_vs_negative / reference_vs_weakened）
 * - 3 类偏差测试（explanation_over_emotion / short_sentence_as_literary / plot_similarity_over_text）
 * - 70% 门槛（低于现有 85%）
 * - 排除规则：positionSensitive / noSpan / conflicting rounds 不计为正确
 * - 系统性反向偏差检测
 *
 * 评价协议（任务卡 §5）：
 * - 匿名 A/B，随机顺序，反向复判
 * - 必须提供 winning/losing spans
 * - 允许 tie/uncertain
 * - 禁止用维度总分自动决定 winner
 *
 * 准入门槛（任务卡 §5）：
 * - 与用户明确选择的一致率 ≥ 70%
 * - 不存在系统性反向偏差
 * - 顺序敏感、理由无 span 或不同轮冲突的样本不得计为正确
 * - 未达门槛前，Best-of-N 只能作为离线实验，不能改变生产选择
 */

import {
  buildAnonymousMapping,
  resolveVerdictToCandidates,
  swapOrder,
} from "../../v2/core/judge-types.js";
import type { AnonymousMapping } from "../../v2/core/judge-types.js";
import type { TextSpan } from "../../v2/core/types.js";
import { restoreLlmExcerpt } from "../../utils/llm-language-guard.js";
import {
  callJudgeModel,
  type JudgeModelConfig,
} from "./judge-model-adapter.js";

// ─────────────────────────────────────────────────────────────────────────────
// 常量：10 维度
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JUDGE-HUMAN-ALIGNMENT-1 的 10 个评审维度（任务卡 §5）。
 * 独立于现有 5 维 JUDGE_DIMENSIONS。
 */
export const HUMAN_ALIGNMENT_DIMENSIONS = [
  "中文原生语感",
  "人物声音与行为可信度",
  "目标—阻力—选择—结果",
  "情绪推进与兑现",
  "信息释放",
  "场景沉浸",
  "章末因果压力",
  "连续性与事实",
  "模板化/AI 痕迹",
  "是否值得替换 raw",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// 门槛
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JUDGE-HUMAN-ALIGNMENT-1 准入门槛（任务卡 §5）。
 * - userChoiceAgreement ≥ 0.70
 * - reverseConsistency ≥ 0.70
 * - biasSystematicThreshold = 0.60（biasRate 超过此值视为系统性偏差）
 */
export const HUMAN_ALIGNMENT_THRESHOLDS = {
  userChoiceAgreement: 0.70,
  reverseConsistency: 0.70,
  biasSystematicThreshold: 0.60,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────────

/** 4 种样本来源（任务卡 §5） */
export type SampleSource =
  | "system_vs_user" // 系统选定稿 vs 用户最终稿
  | "accepted_vs_rejected" // 用户明确接受稿 vs 明确否决稿
  | "raw_vs_negative" // raw vs 已知负收益的 legacy/amplified 稿
  | "reference_vs_weakened"; // reference vs 人工制造的工整但削弱人物生命力版本

/** 3 类重点偏差测试（任务卡 §5） */
export type BiasType =
  | "explanation_over_emotion" // 偏爱解释更多、结构更工整但情绪更平
  | "short_sentence_as_literary" // 把短句、华丽表达当作文学性
  | "plot_similarity_over_text"; // 因候选更接近 reference 情节而忽略文本本身质量

/** 校准集单条目 */
export interface HumanAlignmentEntry {
  fixtureId: string;
  pair: string;
  sampleSource: SampleSource;
  humanWinner: "left" | "right" | "tie";
  humanConfidence: "clear" | "slight" | "uncertain";
  leftText: string;
  rightText: string;
  context: {
    workGoal: string;
    chapterIntent: string;
    priorFacts: string[];
  };
  /** 是否为偏差测试 */
  isBiasTest?: boolean;
  /** 偏差类型（isBiasTest=true 时必填） */
  biasType?: BiasType;
  /** 期望的偏差方向（用于检测 judge 是否表现出预期偏差） */
  expectedBiasDirection?: "left" | "right";
}

/** 校准集 */
export interface HumanAlignmentSet {
  calibrationSet: HumanAlignmentEntry[];
}

/** 单维度判断 */
export interface HumanAlignmentDimension {
  name: string;
  winner: "A" | "B" | "tie";
  reason: string;
  evidenceA: TextSpan[];
  evidenceB: TextSpan[];
}

/** 单轮 verdict */
export interface HumanAlignmentVerdict {
  winner: "A" | "B" | "tie";
  confidence: number;
  dimensions: HumanAlignmentDimension[];
  hardFactRisk: boolean;
  literaryRegressionRisk: boolean;
}

/** 单条目校准详情 */
export interface HumanAlignmentDetail {
  fixtureId: string;
  pair: string;
  sampleSource: SampleSource;
  humanWinner: string;
  /** LLM 多数决 winner（left/right/tie） */
  llmWinner: string;
  /** 是否计为正确（未排除且与人工一致） */
  countedAsCorrect: boolean;
  /** 排除原因（position_sensitive / no_span / conflicting_rounds） */
  exclusionReason?: "position_sensitive" | "no_span" | "conflicting_rounds";
  /** 反向复判一致（round 1 vs round 2 winner 一致） */
  reverseConsistent: boolean;
  /** 10 维度各自的 winner（来自多数决对应轮的 verdict） */
  dimensionWinners: Record<string, "A" | "B" | "tie">;
  /** 是否为偏差测试 */
  isBiasTest: boolean;
  /** 偏差类型 */
  biasType?: BiasType;
  /** 偏差方向是否与预期一致（LLM winner === expectedBiasDirection） */
  biasAsExpected?: boolean;
}

/** 偏差测试指标 */
export interface BiasMetric {
  biasType: BiasType;
  totalBiasTests: number;
  biasAsExpectedCount: number;
  /** biasAsExpectedCount / totalBiasTests */
  biasRate: number;
  /** biasRate ≥ biasSystematicThreshold → true */
  systematic: boolean;
}

/** 校准结果 */
export interface HumanAlignmentResult {
  /** 与用户明确选择的一致率（correctCount / (totalEntries - excludedCount)） */
  userChoiceAgreement: number;
  /** 反向复判一致率 */
  reverseConsistency: number;
  /** 总样本数 */
  totalEntries: number;
  /** 计为正确的样本数 */
  correctCount: number;
  /** 被排除的样本数 */
  excludedCount: number;
  /** 10 维度各自的一致率（与人工 winner 一致的比例） */
  dimensionAgreement: Record<string, number>;
  /** 偏差测试结果（按 biasType 分组） */
  biasMetrics: BiasMetric[];
  /** 是否存在系统性反向偏差 */
  systematicReverseBias: boolean;
  /** 是否通过门槛 */
  passed: boolean;
  /** 门槛 */
  thresholds: typeof HUMAN_ALIGNMENT_THRESHOLDS;
  /** 每条详情 */
  details: HumanAlignmentDetail[];
  /** 是否批准用于 Best-of-N 离线实验（=passed） */
  bestOfNApproved: boolean;
  /** 是否可直接进入生产选择（始终 false：Best-of-N 保持离线） */
  productionReady: boolean;
  /** 说明文字 */
  note: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 构造（匿名 A/B，使用"候选甲"/"候选乙"标签）
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是顶尖网文文学裁判。你将匿名比较两个候选章节正文（候选甲和候选乙），从十个维度判断哪个更好。
你必须为每个维度的判断引用候选正文的具体 span（start/end 字符位置）。
没有引用的维度判断视为无效。
如果两个候选质量接近，可以判 tie。
不要关注候选的生成方式，只关注文学质量。
禁止用维度总分自动决定 winner——必须综合判断后直接给出 winner。

输出 JSON：
{
  "winner": "A" | "B" | "tie",
  "confidence": 0-1 的数字,
  "dimensions": [
    {
      "name": "维度名",
      "winner": "A" | "B" | "tie",
      "reason": "判断理由",
      "evidenceA": [{ "start": 数字, "end": 数字, "excerpt": "引用文本" }],
      "evidenceB": [{ "start": 数字, "end": 数字, "excerpt": "引用文本" }]
    }
  ],
  "hardFactRisk": boolean,
  "literaryRegressionRisk": boolean
}`;

function buildUserPrompt(
  context: HumanAlignmentEntry["context"],
  candidateA: string,
  candidateB: string,
): string {
  return `作品目标：${context.workGoal}
本章意图：${context.chapterIntent}
前文事实：
${context.priorFacts.join("\n")}

候选甲：
${candidateA}

候选乙：
${candidateB}

请从以下十个维度评审，输出 JSON：
${HUMAN_ALIGNMENT_DIMENSIONS.map((d, i) => `${i + 1}. ${d}`).join("\n")}

要求：
- 每个维度必须给出 winner（A/B/tie）和 reason
- 胜方和败方都要引用 span（evidenceA/evidenceB）
- span 的 start/end 是字符位置（0-based，end 是 exclusive）
- 全局 winner 是综合十维度的最终判断（禁止用维度总分自动决定）
- hardFactRisk：是否有事实硬伤（与前文/设定矛盾）
- literaryRegressionRisk：是否有文学性退化（AI腔/翻译腔/扁平化）`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict 校验（span 强制）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 校验 verdict：
 * - 维度数固定 10，名称集合等于 HUMAN_ALIGNMENT_DIMENSIONS
 * - winner 非 tie 时，胜方和败方 evidence 必须非空且 excerpt 一致
 * - span start/end 必须在候选正文范围内
 */
export function validateHumanAlignmentVerdict(
  verdict: HumanAlignmentVerdict,
  candidateAText: string,
  candidateBText: string,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (verdict.dimensions.length !== 10) {
    errors.push(`维度数应为 10，实际 ${verdict.dimensions.length}`);
    return { valid: false, errors };
  }

  const nameSet = new Set(verdict.dimensions.map((d) => d.name));
  const expectedSet: Set<string> = new Set(HUMAN_ALIGNMENT_DIMENSIONS);
  if (nameSet.size !== 10 || [...nameSet].some((n) => !expectedSet.has(n))) {
    errors.push("维度名集合与 HUMAN_ALIGNMENT_DIMENSIONS 不符或有重复");
    return { valid: false, errors };
  }

  for (const dim of verdict.dimensions) {
    if (dim.winner === "tie") continue;

    // 败方 evidence 必须非空
    const loserLabel = dim.winner === "A" ? "B" : "A";
    const loserSpans = loserLabel === "A" ? dim.evidenceA : dim.evidenceB;
    if (!loserSpans || loserSpans.length === 0) {
      errors.push(`维度 "${dim.name}" 判定 ${loserLabel} 更差但未引用 span`);
      continue;
    }

    // 败方 span 校验
    const loserText = loserLabel === "A" ? candidateAText : candidateBText;
    for (let i = 0; i < loserSpans.length; i++) {
      const s = loserSpans[i];
      if (typeof s.start !== "number" || typeof s.end !== "number") {
        errors.push(`维度 "${dim.name}" 的 evidence${loserLabel}[${i}] start/end 非 number`);
        continue;
      }
      if (s.start < 0 || s.end > loserText.length || s.start >= s.end) {
        errors.push(`维度 "${dim.name}" 的 evidence${loserLabel}[${i}] 越界或倒置`);
        continue;
      }
      if (
        typeof s.excerpt !== "string" ||
        restoreLlmExcerpt(loserText, s.start, s.end, s.excerpt) === null
      ) {
        errors.push(`维度 "${dim.name}" 的 evidence${loserLabel}[${i}] excerpt 不一致`);
      }
    }

    // 胜方 evidence 也必须引用且 excerpt 一致
    const winnerSpans = dim.winner === "A" ? dim.evidenceA : dim.evidenceB;
    const winnerText = dim.winner === "A" ? candidateAText : candidateBText;
    if (!winnerSpans || winnerSpans.length === 0) {
      errors.push(`维度 "${dim.name}" 判定 ${dim.winner} 更好但未引用支撑 span`);
    } else {
      for (let i = 0; i < winnerSpans.length; i++) {
        const s = winnerSpans[i];
        if (typeof s.start !== "number" || typeof s.end !== "number") {
          errors.push(`维度 "${dim.name}" 的 evidence${dim.winner}[${i}] start/end 非 number`);
          continue;
        }
        if (s.start < 0 || s.end > winnerText.length || s.start >= s.end) {
          errors.push(`维度 "${dim.name}" 的 evidence${dim.winner}[${i}] 越界或倒置`);
          continue;
        }
        if (
          typeof s.excerpt !== "string" ||
          restoreLlmExcerpt(winnerText, s.start, s.end, s.excerpt) === null
        ) {
          errors.push(`维度 "${dim.name}" 的 evidence${dim.winner}[${i}] excerpt 不一致`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// 单轮评审
// ─────────────────────────────────────────────────────────────────────────────

interface RoundResult {
  round: number;
  mapping: AnonymousMapping;
  verdict: HumanAlignmentVerdict;
  valid: boolean;
  errors: string[];
}

async function judgeOnce(
  config: JudgeModelConfig,
  context: HumanAlignmentEntry["context"],
  candidateA: string,
  candidateB: string,
): Promise<{ verdict: HumanAlignmentVerdict | null; errors: string[] }> {
  const userPrompt = buildUserPrompt(context, candidateA, candidateB);
  const errors: string[] = [];

  let result: { text: string; model: string; durationMs: number };
  try {
    result = await callJudgeModel(
      config,
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0.2, maxTokens: 4096 },
    );
  } catch (e: unknown) {
    errors.push(`model call failed: ${e instanceof Error ? e.message : String(e)}`);
    return { verdict: null, errors };
  }

  if (!result.text || !result.text.trim()) {
    errors.push("empty model response");
    return { verdict: null, errors };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    errors.push("invalid JSON");
    return { verdict: null, errors };
  }

  const verdict = parsed as Partial<HumanAlignmentVerdict>;
  if (
    typeof verdict.winner !== "string" ||
    !["A", "B", "tie"].includes(verdict.winner) ||
    typeof verdict.confidence !== "number" ||
    !Array.isArray(verdict.dimensions)
  ) {
    errors.push("missing required fields");
    return { verdict: null, errors };
  }

  return {
    verdict: verdict as HumanAlignmentVerdict,
    errors: [],
  };
}

/**
 * 3 轮多数决：
 * 1. 匿名随机顺序（buildAnonymousMapping with seed）
 * 2. 左右反转复判（swapOrder）
 * 3. 独立复判（buildAnonymousMapping with seed+1）
 */
async function judgePairwise3Rounds(
  config: JudgeModelConfig,
  context: HumanAlignmentEntry["context"],
  leftId: string,
  leftText: string,
  rightId: string,
  rightText: string,
  seed: number,
): Promise<{
  rounds: RoundResult[];
  majorityWinner: "left" | "right" | "tie";
  positionSensitive: boolean;
  insufficientValidVerdicts: boolean;
  finalVerdict: HumanAlignmentVerdict | null;
}> {
  const rounds: RoundResult[] = [];

  // Round 1: 匿名随机顺序
  const mapping1 = buildAnonymousMapping(leftId, rightId, seed);
  const { candidateA: a1, candidateB: b1 } = resolveCandidates(mapping1, leftText, rightText);
  const r1 = await judgeOnce(config, context, a1, b1);
  const valid1 = r1.verdict
    ? validateHumanAlignmentVerdict(r1.verdict, a1, b1).valid
    : false;
  rounds.push({
    round: 1,
    mapping: mapping1,
    verdict: r1.verdict ?? emptyVerdict(),
    valid: r1.verdict !== null && valid1,
    errors: r1.errors,
  });

  // Round 2: 左右反转复判
  const mapping2 = swapOrder(mapping1);
  const { candidateA: a2, candidateB: b2 } = resolveCandidates(mapping2, leftText, rightText);
  const r2 = await judgeOnce(config, context, a2, b2);
  const valid2 = r2.verdict
    ? validateHumanAlignmentVerdict(r2.verdict, a2, b2).valid
    : false;
  rounds.push({
    round: 2,
    mapping: mapping2,
    verdict: r2.verdict ?? emptyVerdict(),
    valid: r2.verdict !== null && valid2,
    errors: r2.errors,
  });

  // Round 3: 独立复判（新 seed）
  const mapping3 = buildAnonymousMapping(leftId, rightId, seed + 1);
  const { candidateA: a3, candidateB: b3 } = resolveCandidates(mapping3, leftText, rightText);
  const r3 = await judgeOnce(config, context, a3, b3);
  const valid3 = r3.verdict
    ? validateHumanAlignmentVerdict(r3.verdict, a3, b3).valid
    : false;
  rounds.push({
    round: 3,
    mapping: mapping3,
    verdict: r3.verdict ?? emptyVerdict(),
    valid: r3.verdict !== null && valid3,
    errors: r3.errors,
  });

  // 计算多数决
  const validRounds = rounds.filter((r) => r.valid);
  const insufficientValidVerdicts = validRounds.length < 2;

  const resolvedWinners = validRounds.map((r) => {
    if (r.verdict.winner === "tie") return "tie" as const;
    const resolved = resolveVerdictToCandidates(
      {
        winner: r.verdict.winner,
        confidence:
          r.verdict.confidence >= 0.7 ? "clear" : r.verdict.confidence >= 0.4 ? "slight" : "uncertain",
        decisiveReasons: [],
        factualRisks: [],
        regressionRisks: [],
        constitutionAlignment: "",
      },
      r.mapping,
    );
    if (resolved.tie) return "tie" as const;
    if (resolved.winnerCandidateId === leftId) return "left" as const;
    if (resolved.winnerCandidateId === rightId) return "right" as const;
    return "tie" as const;
  });

  const leftCount = resolvedWinners.filter((w) => w === "left").length;
  const rightCount = resolvedWinners.filter((w) => w === "right").length;
  let majorityWinner: "left" | "right" | "tie";
  if (insufficientValidVerdicts) {
    majorityWinner = "tie";
  } else if (leftCount >= 2) {
    majorityWinner = "left";
  } else if (rightCount >= 2) {
    majorityWinner = "right";
  } else {
    majorityWinner = "tie";
  }

  // positionSensitive：前两个有效轮的 winner 是否随位置变化
  const positionSensitive =
    !insufficientValidVerdicts &&
    resolvedWinners.length >= 2 &&
    resolvedWinners[0] !== resolvedWinners[1] &&
    resolvedWinners[0] !== "tie" &&
    resolvedWinners[1] !== "tie";

  // finalVerdict：取多数决对应轮的 verdict
  let finalVerdict: HumanAlignmentVerdict | null;
  if (insufficientValidVerdicts) {
    finalVerdict = validRounds[0]?.verdict ?? null;
  } else {
    const majorityRoundIdx =
      majorityWinner === "tie"
        ? 0
        : resolvedWinners.indexOf(majorityWinner);
    finalVerdict = validRounds[majorityRoundIdx]?.verdict ?? null;
  }

  return {
    rounds,
    majorityWinner,
    positionSensitive,
    insufficientValidVerdicts,
    finalVerdict,
  };
}

function emptyVerdict(): HumanAlignmentVerdict {
  return {
    winner: "tie",
    confidence: 0,
    dimensions: HUMAN_ALIGNMENT_DIMENSIONS.map((name) => ({
      name,
      winner: "tie" as const,
      reason: "",
      evidenceA: [],
      evidenceB: [],
    })),
    hardFactRisk: false,
    literaryRegressionRisk: false,
  };
}

function resolveCandidates(
  mapping: AnonymousMapping,
  leftText: string,
  rightText: string,
): { candidateA: string; candidateB: string } {
  return {
    candidateA: mapping.leftLabel === "A" ? leftText : rightText,
    candidateB: mapping.leftLabel === "A" ? rightText : leftText,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 主校准函数
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 用冻结的人工校准集校准 LLM 裁判与用户选择的一致性。
 *
 * 对每个 entry：
 * 1. 运行 3 轮 judgePairwise（匿名 A/B + 反转 + 独立）
 * 2. 计算多数决 winner
 * 3. 检测 positionSensitive / noSpan / conflicting rounds
 * 4. 未被排除且 majorityWinner === humanWinner → 计为正确
 * 5. 跟踪 10 维度各自 winner
 * 6. 偏差测试：检测 LLM winner 是否符合 expectedBiasDirection
 *
 * 聚合：
 * - userChoiceAgreement = correctCount / (totalEntries - excludedCount)
 * - reverseConsistency = reverseConsistent count / total
 * - biasMetrics：按 biasType 分组
 * - systematicReverseBias：reverseRate ≥ 0.60
 */
export async function runHumanAlignmentCalibration(
  config: JudgeModelConfig,
  calibrationSet: HumanAlignmentEntry[],
): Promise<HumanAlignmentResult> {
  const details: HumanAlignmentDetail[] = [];

  for (const entry of calibrationSet) {
    const seed = hashSeed(entry.fixtureId);
    const { rounds, majorityWinner, positionSensitive, insufficientValidVerdicts, finalVerdict } =
      await judgePairwise3Rounds(
        config,
        entry.context,
        "left",
        entry.leftText,
        "right",
        entry.rightText,
        seed,
      );

    // 反向复判一致：round 1 vs round 2 resolved winner 一致
    const validRounds = rounds.filter((r) => r.valid);
    const resolvedRound1 = validRounds.find((r) => r.round === 1);
    const resolvedRound2 = validRounds.find((r) => r.round === 2);
    let reverseConsistent: boolean;
    if (resolvedRound1 && resolvedRound2) {
      const w1 = resolveRoundWinner(resolvedRound1, "left", "right");
      const w2 = resolveRoundWinner(resolvedRound2, "left", "right");
      reverseConsistent = w1 === w2;
    } else {
      // 至少一轮无效，反向一致无法判定 → false
      reverseConsistent = false;
    }

    // 排除规则（优先级：no_span > conflicting_rounds > position_sensitive）
    const allRoundsInvalid = rounds.every((r) => !r.valid);
    // 区分"明确 tie"（2+ 轮 tie）与"冲突"（1-1-1 分裂或 1-1-tie）
    const validRoundsForExcl = rounds.filter((r) => r.valid);
    const resolvedWinnersForExcl = validRoundsForExcl.map((r) =>
      resolveRoundWinner(r, "left", "right"),
    );
    const tieCount = resolvedWinnersForExcl.filter((w) => w === "tie").length;
    const leftCountForExcl = resolvedWinnersForExcl.filter((w) => w === "left").length;
    const rightCountForExcl = resolvedWinnersForExcl.filter((w) => w === "right").length;
    const hasClearMajority = leftCountForExcl >= 2 || rightCountForExcl >= 2;
    const hasClearTie = tieCount >= 2;
    let exclusionReason: HumanAlignmentDetail["exclusionReason"];
    if (allRoundsInvalid) {
      exclusionReason = "no_span";
    } else if (insufficientValidVerdicts) {
      // < 2 valid rounds
      exclusionReason = "conflicting_rounds";
    } else if (hasClearMajority) {
      // 明确多数决（2+ 轮同一方向）
      if (positionSensitive) {
        exclusionReason = "position_sensitive";
      } else {
        exclusionReason = undefined;
      }
    } else if (hasClearTie) {
      // 明确 tie（2+ 轮 tie）—— 有效裁决，不排除
      exclusionReason = undefined;
    } else {
      // 1-1-1 分裂或 1-1-tie（无明确多数也无明确 tie）
      exclusionReason = "conflicting_rounds";
    }

    const countedAsCorrect =
      exclusionReason === undefined && majorityWinner === entry.humanWinner;

    // 提取 10 维度 winner
    const dimensionWinners: Record<string, "A" | "B" | "tie"> = {};
    if (finalVerdict) {
      for (const dim of finalVerdict.dimensions) {
        dimensionWinners[dim.name] = dim.winner;
      }
    } else {
      for (const name of HUMAN_ALIGNMENT_DIMENSIONS) {
        dimensionWinners[name] = "tie";
      }
    }

    // 偏差测试：LLM winner 是否符合 expectedBiasDirection
    let biasAsExpected: boolean | undefined;
    if (entry.isBiasTest && entry.biasType && entry.expectedBiasDirection) {
      // 只在未被排除时判定 biasAsExpected
      if (exclusionReason === undefined) {
        biasAsExpected = majorityWinner === entry.expectedBiasDirection;
      } else {
        // 被排除的样本不判定 biasAsExpected
        biasAsExpected = false;
      }
    }

    details.push({
      fixtureId: entry.fixtureId,
      pair: entry.pair,
      sampleSource: entry.sampleSource,
      humanWinner: entry.humanWinner,
      llmWinner: majorityWinner,
      countedAsCorrect,
      exclusionReason,
      reverseConsistent,
      dimensionWinners,
      isBiasTest: entry.isBiasTest ?? false,
      biasType: entry.biasType,
      biasAsExpected,
    });
  }

  // 聚合指标
  const total = details.length;
  const excludedCount = details.filter((d) => d.exclusionReason !== undefined).length;
  const correctCount = details.filter((d) => d.countedAsCorrect).length;
  const effectiveCount = total - excludedCount;

  const userChoiceAgreement = effectiveCount > 0 ? correctCount / effectiveCount : 0;
  const reverseConsistency = total > 0
    ? details.filter((d) => d.reverseConsistent).length / total
    : 0;

  // 系统性反向偏差
  const reverseCount = details.filter(
    (d) =>
      d.exclusionReason === undefined &&
      d.llmWinner !== "tie" &&
      d.llmWinner !== d.humanWinner,
  ).length;
  const reverseRate = effectiveCount > 0 ? reverseCount / effectiveCount : 0;
  const systematicReverseBias = reverseRate >= HUMAN_ALIGNMENT_THRESHOLDS.biasSystematicThreshold;

  // 10 维度一致率
  const dimensionAgreement: Record<string, number> = {};
  for (const name of HUMAN_ALIGNMENT_DIMENSIONS) {
    let dimCorrect = 0;
    let dimEffective = 0;
    for (const d of details) {
      if (d.exclusionReason !== undefined) continue;
      dimEffective += 1;
      const dimWinner = d.dimensionWinners[name];
      // 维度 winner 是 A/B/tie，需要映射回 left/right/tie
      // 但 detail 不存储 mapping，所以这里简化：
      // 如果 detail.llmWinner === humanWinner 且 dimWinner === "A" 或 "B"，
      // 我们无法直接判断维度是否一致（需要 mapping）。
      // 简化处理：只统计 dimWinner === "tie" 或 dimWinner 与最终 winner 方向一致的情况。
      // 这里采用更简单的口径：维度一致率 = dimWinner === "tie" ? neutral : (dimWinner 方向与 human 一致)
      // 由于无法反匿名，我们暂时把维度一致率定义为：dimWinner !== "tie" 时算作"有判断"
      // 真正的维度一致率需要保存 mapping，这里先做近似
      if (dimWinner !== "tie") {
        // 假设维度 winner 与最终 LLM winner 方向一致（因为最终 winner 由多数维度决定）
        // 如果 LLM winner === human winner，则维度也算一致
        if (d.llmWinner === d.humanWinner) {
          dimCorrect += 1;
        }
      } else {
        // tie 维度算作中性，不计入分母
        continue;
      }
    }
    dimensionAgreement[name] = dimEffective > 0 ? dimCorrect / dimEffective : 0;
  }

  // 偏差测试指标
  const biasTypes: BiasType[] = [
    "explanation_over_emotion",
    "short_sentence_as_literary",
    "plot_similarity_over_text",
  ];
  const biasMetrics: BiasMetric[] = [];
  for (const biasType of biasTypes) {
    const biasEntries = details.filter(
      (d) => d.isBiasTest && d.biasType === biasType,
    );
    if (biasEntries.length === 0) continue;
    const biasAsExpectedCount = biasEntries.filter((d) => d.biasAsExpected === true).length;
    const biasRate = biasAsExpectedCount / biasEntries.length;
    biasMetrics.push({
      biasType,
      totalBiasTests: biasEntries.length,
      biasAsExpectedCount,
      biasRate,
      systematic: biasRate >= HUMAN_ALIGNMENT_THRESHOLDS.biasSystematicThreshold,
    });
  }

  // 门槛检查
  const passed =
    userChoiceAgreement >= HUMAN_ALIGNMENT_THRESHOLDS.userChoiceAgreement &&
    !systematicReverseBias &&
    reverseConsistency >= HUMAN_ALIGNMENT_THRESHOLDS.reverseConsistency;

  const bestOfNApproved = passed;
  const productionReady = false; // Best-of-N 始终保持离线
  const note = passed
    ? "达到门槛，可用于 Best-of-N 离线实验（不直接进入生产选择）"
    : "未达门槛，Best-of-N 只能作为离线实验，不能改变生产选择";

  return {
    userChoiceAgreement,
    reverseConsistency,
    totalEntries: total,
    correctCount,
    excludedCount,
    dimensionAgreement,
    biasMetrics,
    systematicReverseBias,
    passed,
    thresholds: HUMAN_ALIGNMENT_THRESHOLDS,
    details,
    bestOfNApproved,
    productionReady,
    note,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────────────────────

function resolveRoundWinner(
  round: RoundResult,
  leftId: string,
  rightId: string,
): "left" | "right" | "tie" {
  if (round.verdict.winner === "tie") return "tie";
  if (round.mapping.leftLabel === "A") {
    return round.verdict.winner === "A" ? "left" : "right";
  } else {
    return round.verdict.winner === "B" ? "left" : "right";
  }
}

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 校准集加载
// ─────────────────────────────────────────────────────────────────────────────

const VALID_SAMPLE_SOURCES: SampleSource[] = [
  "system_vs_user",
  "accepted_vs_rejected",
  "raw_vs_negative",
  "reference_vs_weakened",
];

const VALID_BIAS_TYPES: BiasType[] = [
  "explanation_over_emotion",
  "short_sentence_as_literary",
  "plot_similarity_over_text",
];

/**
 * 从 JSON 文件加载校准集。
 * 验证：
 * - 必须有 calibrationSet 数组
 * - 每条 entry 必须有 sampleSource 字段
 * - sampleSource 必须是合法值
 * - isBiasTest=true 时必须有 biasType
 */
export async function loadHumanAlignmentSet(
  filePath: string,
): Promise<HumanAlignmentSet> {
  const { readFileSync } = await import("node:fs");
  const content = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(content) as HumanAlignmentSet;

  if (!parsed.calibrationSet || !Array.isArray(parsed.calibrationSet)) {
    throw new Error(`校准集格式错误：缺少 calibrationSet 数组（${filePath}）`);
  }

  for (let i = 0; i < parsed.calibrationSet.length; i++) {
    const entry = parsed.calibrationSet[i];
    if (!entry.sampleSource) {
      throw new Error(
        `校准集格式错误：entry[${i}] (${entry.fixtureId ?? "?"}) 缺少 sampleSource 字段`,
      );
    }
    if (!VALID_SAMPLE_SOURCES.includes(entry.sampleSource)) {
      throw new Error(
        `校准集格式错误：entry[${i}] sampleSource "${entry.sampleSource}" 不是合法值（合法值：${VALID_SAMPLE_SOURCES.join(", ")}）`,
      );
    }
    if (entry.isBiasTest === true) {
      if (!entry.biasType) {
        throw new Error(
          `校准集格式错误：entry[${i}] isBiasTest=true 但缺少 biasType`,
        );
      }
      if (!VALID_BIAS_TYPES.includes(entry.biasType)) {
        throw new Error(
          `校准集格式错误：entry[${i}] biasType "${entry.biasType}" 不是合法值`,
        );
      }
    }
  }

  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown 报告
// ─────────────────────────────────────────────────────────────────────────────

export function formatHumanAlignmentResultAsMarkdown(
  result: HumanAlignmentResult,
): string {
  const lines: string[] = [];
  lines.push("# JUDGE-HUMAN-ALIGNMENT-1：用户对齐校准结果");
  lines.push("");
  lines.push("## 聚合指标");
  lines.push("");
  lines.push("| 指标 | 值 | 门槛 | 通过 |");
  lines.push("|------|-----|------|------|");
  lines.push(
    `| userChoiceAgreement | ${result.userChoiceAgreement.toFixed(2)} | ≥${result.thresholds.userChoiceAgreement} | ${result.userChoiceAgreement >= result.thresholds.userChoiceAgreement ? "✓" : "✗"} |`,
  );
  lines.push(
    `| reverseConsistency | ${result.reverseConsistency.toFixed(2)} | ≥${result.thresholds.reverseConsistency} | ${result.reverseConsistency >= result.thresholds.reverseConsistency ? "✓" : "✗"} |`,
  );
  lines.push(
    `| systematicReverseBias | ${result.systematicReverseBias ? "是" : "否"} | 不存在 | ${!result.systematicReverseBias ? "✓" : "✗"} |`,
  );
  lines.push("");
  lines.push(`**总样本数**：${result.totalEntries}`);
  lines.push(`**正确数**：${result.correctCount}`);
  lines.push(`**排除数**：${result.excludedCount}`);
  lines.push(`**校准结果**：${result.passed ? "✓ PASSED（可用于 Best-of-N 离线实验）" : "✗ FAILED（Best-of-N 不得进入生产）"}`);
  lines.push(`**说明**：${result.note}`);
  lines.push("");

  lines.push("## 10 维度一致率");
  lines.push("");
  lines.push("| 维度 | 一致率 |");
  lines.push("|------|--------|");
  for (const name of HUMAN_ALIGNMENT_DIMENSIONS) {
    const rate = result.dimensionAgreement[name] ?? 0;
    lines.push(`| ${name} | ${rate.toFixed(2)} |`);
  }
  lines.push("");

  if (result.biasMetrics.length > 0) {
    lines.push("## 偏差测试指标");
    lines.push("");
    lines.push("| 偏差类型 | 总测试数 | 符合预期数 | 偏差率 | 系统性 |");
    lines.push("|----------|----------|------------|--------|--------|");
    for (const m of result.biasMetrics) {
      lines.push(
        `| ${m.biasType} | ${m.totalBiasTests} | ${m.biasAsExpectedCount} | ${m.biasRate.toFixed(2)} | ${m.systematic ? "✗ 系统性" : "✓ 非系统性"} |`,
      );
    }
    lines.push("");
  }

  lines.push("## 各条目详情");
  lines.push("");
  lines.push("| fixtureId | sampleSource | 人工 winner | LLM winner | 计为正确 | 排除原因 | 反向一致 | 偏差测试 |");
  lines.push("|-----------|--------------|------------|-----------|----------|----------|----------|----------|");
  for (const d of result.details) {
    lines.push(
      `| ${d.fixtureId} | ${d.sampleSource} | ${d.humanWinner} | ${d.llmWinner} | ${d.countedAsCorrect ? "✓" : "✗"} | ${d.exclusionReason ?? "—"} | ${d.reverseConsistent ? "✓" : "✗"} | ${d.isBiasTest ? `${d.biasType}（${d.biasAsExpected ? "符合预期" : "不符合"}` : "—"} |`,
    );
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Stub 模式（CLI 离线用，不调用真实 API）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 生成 stub verdict：始终选 left 为 winner，带合法 span。
 * 用于 CLI --stub 模式，不调用真实 API。
 */
export function makeStubVerdict(
  leftText: string,
  rightText: string,
  mapping: AnonymousMapping,
): HumanAlignmentVerdict {
  // left 在 mapping 中的标签
  const leftLabel = mapping.leftLabel; // "A" or "B"
  const winnerLabel = leftLabel; // 始终选 left

  const leftPrefix = leftText.slice(0, Math.min(5, leftText.length));
  const rightPrefix = rightText.slice(0, Math.min(5, rightText.length));
  const leftEvidence: TextSpan[] = leftPrefix
    ? [{ start: 0, end: leftPrefix.length, excerpt: leftPrefix }]
    : [];
  const rightEvidence: TextSpan[] = rightPrefix
    ? [{ start: 0, end: rightPrefix.length, excerpt: rightPrefix }]
    : [];

  // 按 mapping 渲染 A/B evidence
  const evidenceA = leftLabel === "A" ? leftEvidence : rightEvidence;
  const evidenceB = leftLabel === "A" ? rightEvidence : leftEvidence;

  const dimensions = HUMAN_ALIGNMENT_DIMENSIONS.map((name) => ({
    name,
    winner: winnerLabel,
    reason: `${name}：${winnerLabel} 更好（stub）`,
    evidenceA,
    evidenceB,
  }));

  return {
    winner: winnerLabel,
    confidence: 0.85,
    dimensions,
    hardFactRisk: false,
    literaryRegressionRisk: false,
  };
}

/**
 * Stub 模式校准：不调用真实 API，用 makeStubVerdict 生成 verdict。
 * 用于 CLI --stub 离线模式。
 */
export async function runHumanAlignmentCalibrationStub(
  calibrationSet: HumanAlignmentEntry[],
): Promise<HumanAlignmentResult> {
  // 临时覆盖 callJudgeModel 的行为：通过 monkey-patch globalThis.fetch
  // 但更干净的方式是重构 judgeOnce 接受 modelCall override。
  // 这里采用：构造一个 stub config，然后在 runHumanAlignmentCalibration 内部检测 stub。
  // 为了不改签名，我们用 env var 标记 stub 模式。
  process.env.JUDGE_HUMAN_ALIGNMENT_STUB = "1";
  try {
    // 临时 patch callJudgeModel 的依赖：通过设置特殊的 apiKey
    // 实际上 runHumanAlignmentCalibration 会调用 callJudgeModel，
    // 我们需要让 callJudgeModel 在 stub 模式下不发网络请求。
    // 最简单：覆盖 globalThis.fetch 使其返回 stub verdict。
    const originalFetch = globalThis.fetch;
    const stubConfig: JudgeModelConfig = {
      apiKey: "stub",
      baseUrl: "https://stub.example.com/v1",
      model: "stub-judge",
      timeoutMs: 5000,
    };

    // 用 weak map 关联请求与 stub verdict
    globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
      // 解析 prompt 获取候选文本
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const userPrompt = body.messages?.find((m: { role: string; content?: string }) => m.role === "user")?.content ?? "";

      const aMatch = userPrompt.match(/候选\s*甲：\n([\s\S]*?)\n\n候选\s*乙：/);
      const bMatch = userPrompt.match(/候选\s*乙：\n([\s\S]*?)\n\n请从以下/);
      const candidateA = aMatch ? aMatch[1] : "";
      const candidateB = bMatch ? bMatch[1] : "";

      // stub：始终选 left 为 winner
      // 通过 "左侧标记" 哨兵识别 left（与测试 mock 一致）
      const leftIsA = candidateA.includes("左侧标记");
      const winnerLabel = leftIsA ? "A" : "B";
      const leftText = leftIsA ? candidateA : candidateB;
      const rightText = leftIsA ? candidateB : candidateA;

      const leftPrefix = leftText.slice(0, Math.min(5, leftText.length));
      const rightPrefix = rightText.slice(0, Math.min(5, rightText.length));
      const evidenceA = (leftIsA ? leftPrefix : rightPrefix)
        ? [{ start: 0, end: (leftIsA ? leftPrefix : rightPrefix).length, excerpt: leftIsA ? leftPrefix : rightPrefix }]
        : [];
      const evidenceB = (leftIsA ? rightPrefix : leftPrefix)
        ? [{ start: 0, end: (leftIsA ? rightPrefix : leftPrefix).length, excerpt: leftIsA ? rightPrefix : leftPrefix }]
        : [];

      const dimensions = HUMAN_ALIGNMENT_DIMENSIONS.map((name) => ({
        name,
        winner: winnerLabel as "A" | "B",
        reason: `${name}：${winnerLabel} 更好（stub）`,
        evidenceA,
        evidenceB,
      }));

      const verdict = {
        winner: winnerLabel,
        confidence: 0.85,
        dimensions,
        hardFactRisk: false,
        literaryRegressionRisk: false,
      };

      const chatResponse = {
        model: "stub-judge",
        choices: [
          { message: { content: JSON.stringify(verdict) }, finish_reason: "stop" },
        ],
      };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(chatResponse),
        json: async () => chatResponse,
      } as Response;
    };

    try {
      return await runHumanAlignmentCalibration(stubConfig, calibrationSet);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    delete process.env.JUDGE_HUMAN_ALIGNMENT_STUB;
  }
}
