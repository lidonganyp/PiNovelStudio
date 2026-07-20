/**
 * P1-3：Pairwise LLM Judge（3 轮多数决，匿名 A/B 比较）。
 * P1-4：证据约束输出校验 + 事实风险合并。
 *
 * 设计原则（计划 §6.2 裁判 prompt 约束）：
 * - 裁判输入只含 workGoal + chapterIntent + priorFacts + 匿名 A/B + 五维度
 * - 不得包含 baseline 名称、生成模型、tool trajectory、verifier 结果、机械分数、mapping.csv
 * - 每个维度判断必须引用候选正文 span（start/end 字符位置）
 * - 没有引用的维度判断视为无效（P1-4 validateJudgeVerdict）
 * - 允许 tie
 *
 * 3 轮多数决（计划 §6.1）：
 * 1. 匿名随机顺序评审（buildAnonymousMapping）
 * 2. 左右反转复判（swapOrder）
 * 3. 第三次独立复判（新 seed 的 mapping）
 * 4. 多数决产生 winner/tie
 * 5. 顺序反转导致 winner 随位置变化 → positionSensitive=true
 *
 * 安全约束：
 * - 不记录 Key / Authorization header / 完整请求体
 * - 只记录 provider / model / 脱敏 endpoint / 响应耗时
 */

import {
  buildAnonymousMapping,
  resolveVerdictToCandidates,
  swapOrder,
} from "../../v2/core/judge-types.js";
import type { AnonymousMapping } from "../../v2/core/judge-types.js";
import type { TextSpan } from "../../v2/core/types.js";
import {
  callJudgeModel,
  maskEndpoint,
  type JudgeModelConfig,
} from "./judge-model-adapter.js";

// ─────────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────────

/** 单个评审维度的判断 */
export interface JudgeDimension {
  name: string;
  winner: "A" | "B" | "tie";
  reason: string;
  evidenceA: TextSpan[];
  evidenceB: TextSpan[];
}

/** P1-3 裁判输出结构（证据约束） */
export interface PairwiseJudgeVerdict {
  winner: "A" | "B" | "tie";
  confidence: number; // 0-1
  dimensions: JudgeDimension[];
  hardFactRisk: boolean;
  literaryRegressionRisk: boolean;
  /** 顺序敏感标记（由 judgePairwise 计算，不由 LLM 输出） */
  positionSensitive: boolean;
}

/** judgePairwise 3 轮结果 */
export interface PairwiseJudgeResult {
  finalVerdict: PairwiseJudgeVerdict;
  rounds: Array<{
    round: number;
    mapping: AnonymousMapping;
    verdict: PairwiseJudgeVerdict;
    /** M1-R3：该轮 verdict 是否通过 validateJudgeVerdict（无效 verdict 排除出多数决） */
    valid: boolean;
  }>;
  majorityWinner: "left" | "right" | "tie";
  positionSensitive: boolean;
  /** M1-R3：有效 verdict < 2/3 时为 true，下游触发 NEEDS_HUMAN_REVIEW */
  insufficientValidVerdicts: boolean;
}

/** 裁判上下文（不暴露 baseline 身份） */
export interface JudgeContext {
  workGoal: string;
  chapterIntent: string;
  priorFacts: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 评审维度
// ─────────────────────────────────────────────────────────────────────────────

/** 五个评审维度（计划 §6.1） */
export const JUDGE_DIMENSIONS = [
  "事实正确性（与前文/设定一致性）",
  "叙事推进力（情节/冲突/状态变化）",
  "中文自然度（语感/翻译腔/AI腔）",
  "读者体验（钩子/期待/信息释放）",
  "人物塑造（动机/矛盾/群像层次）",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// JSON schema 定义（约束裁判输出）
// ─────────────────────────────────────────────────────────────────────────────

const SPAN_SCHEMA = {
  type: "object",
  properties: {
    start: { type: "number", minimum: 0 },
    end: { type: "number", minimum: 0 },
    excerpt: { type: "string" },
  },
  required: ["start", "end", "excerpt"],
  additionalProperties: false,
} as const;

const DIMENSION_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    winner: { type: "string", enum: ["A", "B", "tie"] },
    reason: { type: "string" },
    evidenceA: { type: "array", items: SPAN_SCHEMA },
    evidenceB: { type: "array", items: SPAN_SCHEMA },
  },
  required: ["name", "winner", "reason", "evidenceA", "evidenceB"],
  additionalProperties: false,
} as const;

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    winner: { type: "string", enum: ["A", "B", "tie"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    dimensions: { type: "array", items: DIMENSION_SCHEMA, minItems: 5, maxItems: 5 },
    hardFactRisk: { type: "boolean" },
    literaryRegressionRisk: { type: "boolean" },
  },
  required: [
    "winner",
    "confidence",
    "dimensions",
    "hardFactRisk",
    "literaryRegressionRisk",
  ],
  additionalProperties: false,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 构造
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是顶尖网文文学裁判。你将匿名比较两个候选章节正文（A 和 B），从五个维度判断哪个更好。
你必须为每个维度的判断引用候选正文的具体 span（start/end 字符位置）。
没有引用的维度判断视为无效。
如果两个候选质量接近，可以判 tie。
不要关注候选的生成方式，只关注文学质量。

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
  context: JudgeContext,
  candidateA: string,
  candidateB: string,
): string {
  return `作品目标：${context.workGoal}
本章意图：${context.chapterIntent}
前文事实：
${context.priorFacts.join("\n")}

候选 A：
${candidateA}

候选 B：
${candidateB}

请从以下五个维度评审，输出 JSON：
${JUDGE_DIMENSIONS.map((d, i) => `${i + 1}. ${d}`).join("\n")}

要求：
- 每个维度必须给出 winner（A/B/tie）和 reason
- 胜方和败方都要引用 span（evidenceA/evidenceB）
- span 的 start/end 是字符位置（0-based，end 是 exclusive）
- 全局 winner 是综合五维度的最终判断
- hardFactRisk：是否有事实硬伤（与前文/设定矛盾）
- literaryRegressionRisk：是否有文学性退化（AI腔/翻译腔/扁平化）`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 单次评审（P1-3 judgeOnce）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 执行单次 pairwise 评审。
 *
 * 裁判输入只包含：
 * - 作品目标与本章意图
 * - 必要的前文事实
 * - 匿名候选 A/B
 * - 五个评审维度
 *
 * 不得包含：baseline 名称、生成模型、tool trajectory、verifier 结果、机械分数、mapping.csv
 */
export async function judgeOnce(
  config: JudgeModelConfig,
  context: JudgeContext,
  candidateA: string,
  candidateB: string,
): Promise<PairwiseJudgeVerdict> {
  const userPrompt = buildUserPrompt(context, candidateA, candidateB);
  const result = await callJudgeModel(
    config,
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    {
      responseFormat: "json_schema",
      schema: VERDICT_SCHEMA,
      schemaName: "pairwise_verdict",
      temperature: 0.2,
      maxTokens: 4096,
    },
  );

  const parsed = JSON.parse(result.text) as Omit<
    PairwiseJudgeVerdict,
    "positionSensitive"
  >;

  return {
    ...parsed,
    positionSensitive: false, // 单次评审无顺序敏感概念，由 judgePairwise 计算
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3 轮多数决（P1-3 judgePairwise）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 执行 3 轮评审（原始/反转/独立），多数决。
 *
 * 1. 匿名随机顺序评审（buildAnonymousMapping with seed）
 * 2. 左右反转复判（swapOrder）
 * 3. 第三次独立复判（buildAnonymousMapping with seed+1）
 * 4. 多数决产生 winner/tie
 * 5. 顺序反转导致 winner 随位置变化 → positionSensitive=true
 *
 * @param config 裁判模型配置
 * @param context 裁判上下文（不暴露 baseline 身份）
 * @param leftId 左侧物理候选 id
 * @param leftText 左侧物理候选正文
 * @param rightId 右侧物理候选 id
 * @param rightText 右侧物理候选正文
 * @param seed 随机种子（可复现）
 */
export async function judgePairwise(
  config: JudgeModelConfig,
  context: JudgeContext,
  leftId: string,
  leftText: string,
  rightId: string,
  rightText: string,
  seed: number,
): Promise<PairwiseJudgeResult> {
  const rounds: PairwiseJudgeResult["rounds"] = [];

  // ── Round 1：匿名随机顺序 ──────────────────────────────────────────
  const mapping1 = buildAnonymousMapping(leftId, rightId, seed);
  const { candidateA: a1, candidateB: b1 } = resolveCandidates(
    mapping1,
    leftText,
    rightText,
  );
  const verdict1 = await judgeOnce(config, context, a1, b1);
  // M1-R3：每轮用该轮匿名 A/B 文本校验 verdict 有效性
  const valid1 = validateJudgeVerdict(verdict1, a1, b1).valid;
  rounds.push({ round: 1, mapping: mapping1, verdict: verdict1, valid: valid1 });

  // ── Round 2：左右反转复判 ──────────────────────────────────────────
  const mapping2 = swapOrder(mapping1);
  const { candidateA: a2, candidateB: b2 } = resolveCandidates(
    mapping2,
    leftText,
    rightText,
  );
  const verdict2 = await judgeOnce(config, context, a2, b2);
  const valid2 = validateJudgeVerdict(verdict2, a2, b2).valid;
  rounds.push({ round: 2, mapping: mapping2, verdict: verdict2, valid: valid2 });

  // ── Round 3：独立复判（新 seed）────────────────────────────────────
  const mapping3 = buildAnonymousMapping(leftId, rightId, seed + 1);
  const { candidateA: a3, candidateB: b3 } = resolveCandidates(
    mapping3,
    leftText,
    rightText,
  );
  const verdict3 = await judgeOnce(config, context, a3, b3);
  const valid3 = validateJudgeVerdict(verdict3, a3, b3).valid;
  rounds.push({ round: 3, mapping: mapping3, verdict: verdict3, valid: valid3 });

  // ── M1-R3：有效 verdict 数检查 ──────────────────────────────────────
  const validRounds = rounds.filter((r) => r.valid);
  const insufficientValidVerdicts = validRounds.length < 2;

  // ── 多数决（M1-R3：只统计 valid===true 的轮）────────────────────────
  const resolvedWinners = validRounds.map((r) => {
    const resolved = resolveVerdictToCandidates(
      {
        winner: r.verdict.winner,
        confidence:
          r.verdict.confidence >= 0.7
            ? "clear"
            : r.verdict.confidence >= 0.4
              ? "slight"
              : "uncertain",
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
  // M1-R3：有效 verdict 不足 2/3 → tie（下游触发 NEEDS_HUMAN_REVIEW）
  if (insufficientValidVerdicts) {
    majorityWinner = "tie";
  } else if (leftCount >= 2) {
    majorityWinner = "left";
  } else if (rightCount >= 2) {
    majorityWinner = "right";
  } else {
    majorityWinner = "tie";
  }

  // ── positionSensitive：前两个有效轮的 winner 是否随位置变化 ────────
  // M1-R3：只比较有效轮；无效轮不参与 positionSensitive 判定
  const positionSensitive =
    !insufficientValidVerdicts &&
    resolvedWinners.length >= 2 &&
    resolvedWinners[0] !== resolvedWinners[1] &&
    resolvedWinners[0] !== "tie" &&
    resolvedWinners[1] !== "tie";

  // ── 最终 verdict：取多数决对应轮的 verdict，合并 positionSensitive ──
  // M1-R3：不足有效轮时取第一个有效轮（或回退到 round 0）
  let finalVerdict: PairwiseJudgeVerdict;
  if (insufficientValidVerdicts) {
    const fallbackRound = validRounds[0] ?? rounds[0];
    finalVerdict = { ...fallbackRound.verdict, positionSensitive };
  } else {
    const majorityRoundIdx = majorityWinner === "tie"
      ? 0
      : resolvedWinners.indexOf(majorityWinner);
    const sourceRound = validRounds[majorityRoundIdx] ?? validRounds[0] ?? rounds[0];
    finalVerdict = { ...sourceRound.verdict, positionSensitive };
  }

  return {
    finalVerdict,
    rounds,
    majorityWinner,
    positionSensitive,
    insufficientValidVerdicts,
  };
}

/**
 * 根据 mapping 把物理候选正文映射为匿名 A/B。
 */
function resolveCandidates(
  mapping: AnonymousMapping,
  leftText: string,
  rightText: string,
): { candidateA: string; candidateB: string } {
  const candidateA =
    mapping.leftLabel === "A" ? leftText : rightText;
  const candidateB =
    mapping.leftLabel === "A" ? rightText : leftText;
  return { candidateA, candidateB };
}

// ─────────────────────────────────────────────────────────────────────────────
// P1-4：证据约束输出校验
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 校验裁判输出的维度是否有效（必须引用候选正文 span）。
 * 引用不存在的维度标记为无效。
 *
 * 规则（M1-R3 强化）：
 * - 维度数固定 5，名称集合等于 JUDGE_DIMENSIONS（无重复无缺失）
 * - winner 非 tie 时，败方 evidence 必须非空且在候选正文中
 * - span start/end 必须在候选正文范围内且 start < end
 * - excerpt 必须 === text.slice(start, end)（excerpt 一致性硬要求）
 * - 胜方 evidence 也必须引用且 excerpt 一致（M1-R3：胜负双方都必须引用有效 span）
 */
export function validateJudgeVerdict(
  verdict: PairwiseJudgeVerdict,
  candidateAText: string,
  candidateBText: string,
): { valid: boolean; invalidDimensions: string[]; errors: string[] } {
  const invalidDimensions: string[] = [];
  const errors: string[] = [];

  // ── M1-R3：维度数固定 5 + 名称集合校验 ──────────────────────────────
  if (verdict.dimensions.length !== 5) {
    errors.push(`维度数应为 5，实际 ${verdict.dimensions.length}`);
    return {
      valid: false,
      invalidDimensions: verdict.dimensions.map((d) => d.name),
      errors,
    };
  }
  const nameSet = new Set(verdict.dimensions.map((d) => d.name));
  const expectedSet: Set<string> = new Set(JUDGE_DIMENSIONS);
  if (nameSet.size !== 5 || [...nameSet].some((n) => !expectedSet.has(n))) {
    errors.push("维度名集合与 JUDGE_DIMENSIONS 不符或有重复");
    return {
      valid: false,
      invalidDimensions: verdict.dimensions.map((d) => d.name),
      errors,
    };
  }

  for (const dim of verdict.dimensions) {
    if (dim.winner === "tie") continue;

    // 败方 evidence 必须非空
    const loserLabel = dim.winner === "A" ? "B" : "A";
    const loserSpans = loserLabel === "A" ? dim.evidenceA : dim.evidenceB;
    if (!loserSpans || loserSpans.length === 0) {
      invalidDimensions.push(dim.name);
      errors.push(
        `维度 "${dim.name}" 判定 ${loserLabel} 更差但未引用 span`,
      );
      continue;
    }

    // span 越界 + excerpt 一致性检查（败方）
    const loserText = loserLabel === "A" ? candidateAText : candidateBText;
    for (let i = 0; i < loserSpans.length; i++) {
      const s = loserSpans[i];
      if (
        typeof s.start !== "number" ||
        typeof s.end !== "number"
      ) {
        invalidDimensions.push(dim.name);
        errors.push(
          `维度 "${dim.name}" 的 evidence${loserLabel}[${i}] start/end 非 number`,
        );
        continue;
      }
      if (s.start < 0 || s.end > loserText.length || s.start >= s.end) {
        invalidDimensions.push(dim.name);
        errors.push(
          `维度 "${dim.name}" 的 evidence${loserLabel}[${i}] 越界或倒置（start=${s.start}, end=${s.end}, len=${loserText.length}）`,
        );
        continue;
      }
      // M1-R3：excerpt 一致性校验（excerpt === text.slice(start, end)）
      if (typeof s.excerpt !== "string" || s.excerpt !== loserText.slice(s.start, s.end)) {
        invalidDimensions.push(dim.name);
        errors.push(
          `维度 "${dim.name}" 的 evidence${loserLabel}[${i}] excerpt 与 text.slice(start,end) 不符`,
        );
      }
    }

    // M1-R3：胜方 evidence 也必须引用且 excerpt 一致（胜负双方都必须引用有效 span）
    const winnerSpans = dim.winner === "A" ? dim.evidenceA : dim.evidenceB;
    const winnerText = dim.winner === "A" ? candidateAText : candidateBText;
    if (!winnerSpans || winnerSpans.length === 0) {
      invalidDimensions.push(dim.name);
      errors.push(
        `维度 "${dim.name}" 判定 ${dim.winner} 更好但未引用支撑 span`,
      );
    } else {
      for (let i = 0; i < winnerSpans.length; i++) {
        const s = winnerSpans[i];
        if (
          typeof s.start !== "number" ||
          typeof s.end !== "number"
        ) {
          invalidDimensions.push(dim.name);
          errors.push(
            `维度 "${dim.name}" 的 evidence${dim.winner}[${i}] start/end 非 number`,
          );
          continue;
        }
        if (s.start < 0 || s.end > winnerText.length || s.start >= s.end) {
          invalidDimensions.push(dim.name);
          errors.push(
            `维度 "${dim.name}" 的 evidence${dim.winner}[${i}] 越界或倒置（start=${s.start}, end=${s.end}, len=${winnerText.length}）`,
          );
          continue;
        }
        if (typeof s.excerpt !== "string" || s.excerpt !== winnerText.slice(s.start, s.end)) {
          invalidDimensions.push(dim.name);
          errors.push(
            `维度 "${dim.name}" 的 evidence${dim.winner}[${i}] excerpt 与 text.slice(start,end) 不符`,
          );
        }
      }
    }
  }

  return {
    valid: invalidDimensions.length === 0,
    invalidDimensions,
    errors,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// P1-4：事实风险合并
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 事实正确性不能只由 LLM 决定，必须与本地 verifier 证据合并。
 *
 * - LLM 判 hardFactRisk=true 但 verifier 无 hard findings → 降级为 soft risk（仍记 risk，但不阻断）
 * - LLM 判 hardFactRisk=false 但 verifier 有 hard findings → 升级为 hardFactRisk=true（verifier 优先）
 *
 * @param llmHardFactRisk LLM 裁判输出的事实风险
 * @param verifierHardFindingCount 本地 verifier 检出的 hard findings 数
 * @returns 合并后的事实风险 + 来源标记
 */
export function mergeFactRisk(
  llmHardFactRisk: boolean,
  verifierHardFindingCount: number,
): {
  hardFactRisk: boolean;
  source: "llm" | "verifier" | "merged";
} {
  if (verifierHardFindingCount > 0) {
    return { hardFactRisk: true, source: "verifier" };
  }
  return {
    hardFactRisk: llmHardFactRisk,
    source: llmHardFactRisk ? "llm" : "merged",
  };
}
