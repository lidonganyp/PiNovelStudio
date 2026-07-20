/**
 * JudgeTypes — LLM 文学裁判类型与匿名化协议（Phase 1 类型层，Phase 4 落地裁判器，计划 §4.5 §5）
 *
 * 裁判协议核心：
 * - 候选匿名为 A/B，不暴露模型/route/raw/amplified 身份
 * - 顺序随机化
 * - 不允许绝对打分决定胜负，必须直接比较
 * - 所有负面判断必须引用正文 span
 * - 允许 tie/uncertain，默认保留 raw
 *
 * 本模块只定义类型与匿名化/反匿名化纯函数，不调用 LLM。
 */

import type { TextSpan } from "./types.js";

// ============================================================================
// 裁判输出类型
// ============================================================================

export type JudgeWinner = "A" | "B" | "tie";
export type JudgeConfidence = "clear" | "slight" | "uncertain";

export interface DecisiveReason {
  dimension: string;
  betterCandidate: "A" | "B" | "neither";
  evidenceA: TextSpan[];
  evidenceB: TextSpan[];
  explanation: string;
}

export interface JudgeVerdict {
  winner: JudgeWinner;
  confidence: JudgeConfidence;
  decisiveReasons: DecisiveReason[];
  factualRisks: string[];
  regressionRisks: string[];
  constitutionAlignment: string;
}

// ============================================================================
// 匿名化映射
// ============================================================================

export interface AnonymousMapping {
  /** 物理候选 id（左侧输入） */
  leftCandidateId: string;
  /** 物理候选 id（右侧输入） */
  rightCandidateId: string;
  /** left 被贴上的标签 */
  leftLabel: "A" | "B";
  /** right 被贴上的标签 */
  rightLabel: "A" | "B";
  orderRandomized: boolean;
  /** 种子，便于复现 */
  seed: number;
}

// ============================================================================
// 匿名化 / 反匿名化
// ============================================================================

/**
 * 构造匿名映射。orderRandomized=true 时随机交换 A/B 标签。
 * 使用简单确定性 PRNG（mulberry32）保证可复现。
 */
export function buildAnonymousMapping(
  leftCandidateId: string,
  rightCandidateId: string,
  seed: number
): AnonymousMapping {
  const orderRandomized = mulberry32(seed)() < 0.5;
  if (orderRandomized) {
    return {
      leftCandidateId,
      rightCandidateId,
      leftLabel: "B",
      rightLabel: "A",
      orderRandomized: true,
      seed,
    };
  }
  return {
    leftCandidateId,
    rightCandidateId,
    leftLabel: "A",
    rightLabel: "B",
    orderRandomized: false,
    seed,
  };
}

/**
 * 把匿名 verdict 反映射回物理候选 id。
 * 返回 winnerId（或 null 表示 tie）与"哪个物理候选更优"。
 */
export function resolveVerdictToCandidates(
  verdict: JudgeVerdict,
  mapping: AnonymousMapping
): {
  winnerCandidateId: string | null;
  loserCandidateId: string | null;
  tie: boolean;
} {
  if (verdict.winner === "tie") {
    return { winnerCandidateId: null, loserCandidateId: null, tie: true };
  }
  const winnerLabel = verdict.winner; // "A" | "B"
  const winnerId =
    mapping.leftLabel === winnerLabel ? mapping.leftCandidateId : mapping.rightCandidateId;
  const loserId =
    mapping.leftLabel === winnerLabel ? mapping.rightCandidateId : mapping.leftCandidateId;
  return { winnerCandidateId: winnerId, loserCandidateId: loserId, tie: false };
}

/**
 * 反向复判时交换 A/B 顺序：构造一个标签互换的新映射，
 * 使裁判在不知道上次结果的情况下以相反顺序重判。
 */
export function swapOrder(mapping: AnonymousMapping): AnonymousMapping {
  return {
    ...mapping,
    leftLabel: mapping.leftLabel === "A" ? "B" : "A",
    rightLabel: mapping.rightLabel === "A" ? "B" : "A",
    orderRandomized: !mapping.orderRandomized,
  };
}

// ============================================================================
// span 强制校验（计划 §5.2 第 4 条：所有负面判断必须引用正文 span）
// ============================================================================

export interface VerdictEvidenceValidation {
  ok: boolean;
  errors: string[];
}

/**
 * 校验 verdict 的负面判断是否都带有效 span。
 * "负面判断"指 decisiveReasons 中 betterCandidate != "neither" 的一方对另一方的贬低，
 * 以及 factualRisks / regressionRisks。
 *
 * 规则：
 * - decisiveReasons 中，被判定为更差的一方的 evidence 必须非空（引用其问题 span）
 * - factualRisks / regressionRisks 至少要能对应到某条 reason 的 evidence（松校验：非空字符串）
 */
export function validateVerdictEvidence(
  verdict: JudgeVerdict,
  candidateAText: string,
  candidateBText: string
): VerdictEvidenceValidation {
  const errors: string[] = [];
  for (let i = 0; i < verdict.decisiveReasons.length; i++) {
    const r = verdict.decisiveReasons[i];
    if (r.betterCandidate === "neither") continue;
    const worseLabel = r.betterCandidate === "A" ? "B" : "A";
    const worseSpans = worseLabel === "A" ? r.evidenceA : r.evidenceB;
    if (!worseSpans || worseSpans.length === 0) {
      errors.push(
        `decisiveReasons[${i}] 判定 ${worseLabel} 更差，但未引用 ${worseLabel} 的问题 span`
      );
    } else {
      const worseText = worseLabel === "A" ? candidateAText : candidateBText;
      for (let j = 0; j < worseSpans.length; j++) {
        const s = worseSpans[j];
        if (typeof s.start !== "number" || typeof s.end !== "number") {
          errors.push(`decisiveReasons[${i}].evidence${worseLabel}[${j}] start/end 非 number`);
          continue;
        }
        if (s.start < 0 || s.end > worseText.length || s.start >= s.end) {
          errors.push(
            `decisiveReasons[${i}].evidence${worseLabel}[${j}] 越界或倒置（start=${s.start}, end=${s.end}, len=${worseText.length}）`
          );
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// ============================================================================
// 选择策略（计划 §3 SelectionPolicy）
// ============================================================================

export interface SelectionDecision {
  /** 最终选中的物理候选 id；null 表示保留 raw（裁判不清/冲突/退化） */
  selectedCandidateId: string | null;
  reason: string;
  /** 是否触发反向复判 */
  needsReverseReview: boolean;
}

/**
 * 默认选择策略：只有 clear 且证据有效且无明确退化/事实风险时才选中 amplified；
 * slight/uncertain/冲突/退化 → 保留 raw（返回 null，由调用方回退）。
 *
 * @param amplifiedCandidateId 候选（非 raw）的物理 id
 * @param rawCandidateId raw 的物理 id
 * @param winnerCandidateId 裁判反匿名后的 winner id（tie 时为 null）
 * @param verdict 裁判输出
 * @param evidenceValid span 校验是否通过
 */
export function decideSelection(
  amplifiedCandidateId: string,
  rawCandidateId: string,
  winnerCandidateId: string | null,
  verdict: JudgeVerdict,
  evidenceValid: boolean
): SelectionDecision {
  // tie / 证据无效 → 保留 raw
  if (winnerCandidateId === null) {
    return {
      selectedCandidateId: rawCandidateId,
      reason: `tie 或不确定，保留 raw（confidence=${verdict.confidence}）`,
      needsReverseReview: verdict.confidence !== "clear",
    };
  }
  // winner 是 raw → 保留 raw
  if (winnerCandidateId === rawCandidateId) {
    return {
      selectedCandidateId: rawCandidateId,
      reason: "裁判判定 raw 更优，保留 raw",
      needsReverseReview: false,
    };
  }
  // winner 是 amplified
  if (winnerCandidateId === amplifiedCandidateId) {
    if (!evidenceValid) {
      return {
        selectedCandidateId: rawCandidateId,
        reason: "amplified 胜出但负面判断缺有效 span，保留 raw，触发反向复判",
        needsReverseReview: true,
      };
    }
    if (verdict.confidence === "clear") {
      return {
        selectedCandidateId: amplifiedCandidateId,
        reason: "amplified clear 胜出且证据有效，选择 amplified",
        needsReverseReview: false,
      };
    }
    // slight / uncertain → 复判
    return {
      selectedCandidateId: rawCandidateId,
      reason: `amplified 胜出但 confidence=${verdict.confidence}，暂保留 raw，触发反向复判`,
      needsReverseReview: true,
    };
  }
  // 异常：winner 不在两个候选中
  return {
    selectedCandidateId: rawCandidateId,
    reason: `winner ${winnerCandidateId} 不在候选集中，保留 raw`,
    needsReverseReview: false,
  };
}

// ============================================================================
// PRNG（mulberry32，确定性可复现）
// ============================================================================

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createJudgeProtocol(): {
  buildMapping: typeof buildAnonymousMapping;
  resolve: typeof resolveVerdictToCandidates;
  swap: typeof swapOrder;
  validateEvidence: typeof validateVerdictEvidence;
  decide: typeof decideSelection;
} {
  return {
    buildMapping: buildAnonymousMapping,
    resolve: resolveVerdictToCandidates,
    swap: swapOrder,
    validateEvidence: validateVerdictEvidence,
    decide: decideSelection,
  };
}
