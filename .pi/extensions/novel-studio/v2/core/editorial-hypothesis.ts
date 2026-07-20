/**
 * EditorialHypothesis — 编辑假设（Phase 1，计划 §4.4）
 *
 * 一个 EditorialHypothesis 指出 raw 上一个具体、可引用 span 证明的编辑机会。
 * 只有包含真实 span、明确读者增益和损伤风险的 hypothesis 才能触发候选生成。
 *
 * 设计原则：
 * - 没有 span 的 diagnosis 只能当备注，不能触发候选
 * - 每个候选只携带一个主要 hypothesis，避免目标互相稀释（Phase 3 落实）
 * - confidence 0-1，低于阈值不生成候选
 */

import type { TextSpan } from "./types.js";

// ============================================================================
// 类型定义
// ============================================================================

export type EditorialOpportunityType =
  | "reader_payoff"
  | "character_choice"
  | "relationship_progress"
  | "information_dramatization"
  | "promise_advancement"
  | "ensemble_function"
  | "chapter_end_pressure"
  | "voice_and_naturalness";

export type RewriteScope = "chapter_candidate" | "event_candidate" | "span_candidate";

export interface EditorialHypothesis {
  id: string;
  opportunityType: EditorialOpportunityType;
  diagnosis: string;
  evidenceSpans: TextSpan[];
  expectedReaderGain: string;
  damageRisks: string[];
  rewriteScope: RewriteScope;
  confidence: number;
}

// ============================================================================
// 校验
// ============================================================================

export interface HypothesisValidation {
  ok: boolean;
  errors: string[];
}

/**
 * 校验 hypothesis 是否"可触发候选"。
 * 硬约束：必须有真实 span、明确读者增益、至少一条损伤风险评估。
 */
export function validateHypothesis(h: EditorialHypothesis, rawText: string): HypothesisValidation {
  const errors: string[] = [];
  if (!h.id) errors.push("id 不能为空");
  if (!h.diagnosis || !h.diagnosis.trim()) errors.push("diagnosis 不能为空");
  if (!h.expectedReaderGain || !h.expectedReaderGain.trim())
    errors.push("expectedReaderGain 不能为空（必须说明读者增益）");
  if (!Array.isArray(h.evidenceSpans) || h.evidenceSpans.length === 0) {
    errors.push("evidenceSpans 必须非空（无 span 的 diagnosis 只能当备注，不能触发候选）");
  } else {
    h.evidenceSpans.forEach((s, i) => {
      const spanErr = validateSpan(s, rawText, i);
      if (spanErr) errors.push(spanErr);
    });
  }
  if (!Array.isArray(h.damageRisks) || h.damageRisks.length === 0) {
    errors.push("damageRisks 必须非空（必须评估修订可能造成的损伤）");
  }
  if (typeof h.confidence !== "number" || h.confidence < 0 || h.confidence > 1) {
    errors.push("confidence 必须为 [0,1] 区间数值");
  }
  if (!["chapter_candidate", "event_candidate", "span_candidate"].includes(h.rewriteScope)) {
    errors.push(`rewriteScope 非法：${h.rewriteScope}`);
  }
  return { ok: errors.length === 0, errors };
}

function validateSpan(span: TextSpan, rawText: string, index: number): string | null {
  if (typeof span.start !== "number" || typeof span.end !== "number") {
    return `evidenceSpans[${index}].start/end 必须为 number`;
  }
  if (span.start < 0 || span.end > rawText.length || span.start >= span.end) {
    return `evidenceSpans[${index}] 越界或倒置（start=${span.start}, end=${span.end}, rawLen=${rawText.length}）`;
  }
  return null;
}

// ============================================================================
// 候选生成准入
// ============================================================================

/** 默认置信度门槛：低于此值不生成候选 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.4;

export function shouldGenerateCandidate(
  h: EditorialHypothesis,
  rawText: string,
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD
): { generate: boolean; reason: string } {
  const validation = validateHypothesis(h, rawText);
  if (!validation.ok) {
    return { generate: false, reason: `hypothesis 校验失败：${validation.errors.join("; ")}` };
  }
  if (h.confidence < threshold) {
    return {
      generate: false,
      reason: `confidence ${h.confidence} 低于门槛 ${threshold}，不生成候选`,
    };
  }
  return { generate: true, reason: "通过校验且置信度达标" };
}

// ============================================================================
// 一章最多 2 个候选的准入控制
// ============================================================================

/**
 * 从一组 hypothesis 中选出最多 maxCandidates 个互不冲突的 hypothesis。
 * "互不冲突"指 opportunityType 不同（同一类型的机会合并为一个候选，避免目标稀释）。
 */
export function selectHypothesesForCandidates(
  hypotheses: EditorialHypothesis[],
  rawText: string,
  maxCandidates: number = 2
): { selected: EditorialHypothesis[]; rejected: EditorialHypothesis[]; reasons: string[] } {
  const reasons: string[] = [];
  const viable: EditorialHypothesis[] = [];
  for (const h of hypotheses) {
    const v = validateHypothesis(h, rawText);
    if (!v.ok) {
      reasons.push(`${h.id} 跳过：${v.errors.join("; ")}`);
      continue;
    }
    viable.push(h);
  }
  // 按 confidence 降序
  viable.sort((a, b) => b.confidence - a.confidence);

  const selected: EditorialHypothesis[] = [];
  const rejected: EditorialHypothesis[] = [];
  const usedTypes = new Set<EditorialOpportunityType>();
  for (const h of viable) {
    if (selected.length >= maxCandidates) {
      rejected.push(h);
      reasons.push(`${h.id} 跳过：已达最多 ${maxCandidates} 候选上限`);
      continue;
    }
    if (usedTypes.has(h.opportunityType)) {
      rejected.push(h);
      reasons.push(`${h.id} 跳过：与已选 hypothesis 的 opportunityType ${h.opportunityType} 冲突`);
      continue;
    }
    // Step 4a：第 2 候选需高置信（默认 0.7）；第 1 候选不受此门限制。
    // 防止日常生成因低置信第 2 候选稀释目标；评测时调低阈值或提高 maxCandidates。
    if (selected.length >= 1) {
      const secondCandidateThreshold = Number(process.env.PINOVEL_SECOND_CANDIDATE_CONFIDENCE ?? 0.7);
      if (h.confidence < secondCandidateThreshold) {
        rejected.push(h);
        reasons.push(`${h.id} 跳过：第 2 候选置信度 ${h.confidence.toFixed(2)} < 阈值 ${secondCandidateThreshold}`);
        continue;
      }
    }
    selected.push(h);
    usedTypes.add(h.opportunityType);
  }
  return { selected, rejected, reasons };
}

export function createEditorialHypothesisStore(): {
  validate: typeof validateHypothesis;
  shouldGenerate: typeof shouldGenerateCandidate;
  select: typeof selectHypothesesForCandidates;
} {
  return {
    validate: validateHypothesis,
    shouldGenerate: shouldGenerateCandidate,
    select: selectHypothesesForCandidates,
  };
}
