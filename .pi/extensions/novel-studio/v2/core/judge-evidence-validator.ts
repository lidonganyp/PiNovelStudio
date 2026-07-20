/**
 * JudgeEvidenceValidator — 裁判证据校验器（Phase 4，计划 §Phase 4 + §5.2）
 *
 * 校验 LLM 裁判 verdict 的证据完整性，确保所有负面判断都引用有效 span。
 *
 * 设计原则（计划 §5.2 第 4 条：所有负面判断必须引用正文 span）：
 * - decisiveReasons 中，被判定更差的一方的 evidence 必须非空且 span 有效
 * - factualRisks / regressionRisks 至少要能对应到某条 reason 的 evidence（松校验）
 * - winner 非 tie 时，必须有至少 1 条 decisiveReason 且 betterCandidate 与 winner 一致
 * - 无证据负评失效：校验失败的 verdict 不能用于选择 amplified，保留 raw
 *
 * 与 judge-types.validateVerdictEvidence 的关系：
 * - validateVerdictEvidence 是 Phase 1 的纯函数，做基础 span 越界校验
 * - 本模块在其上追加语义校验（winner 一致性、decisiveReasons 完整性、风险可追溯性）
 */

import type { TextSpan } from "./types.js";
import type { JudgeVerdict, DecisiveReason } from "./judge-types.js";
import { validateVerdictEvidence } from "./judge-types.js";

// ============================================================================
// 输入/输出类型
// ============================================================================

export interface EvidenceValidationResult {
  /** 是否通过校验 */
  ok: boolean;
  /** 所有错误（基础 span 越界 + 语义校验） */
  errors: string[];
  /** 缺少 span 的负面判断（供 trace 审计与反向复判决策） */
  missingSpanReasons: string[];
  /** decisiveReasons 中 betterCandidate 与 winner 不一致的条目索引 */
  inconsistentWinnerReasons: number[];
}

// ============================================================================
// 校验主函数
// ============================================================================

/**
 * 校验裁判证据完整性。
 *
 * 三层校验：
 * 1. 基础 span 越界（复用 validateVerdictEvidence）
 * 2. winner 一致性：winner 非 tie 时，至少 1 条 decisiveReason 的 betterCandidate 与 winner 一致
 * 3. 负面判断 span 强制：被判定更差的一方的 evidence 必须非空
 *
 * @param verdict 裁判输出
 * @param candidateAText 候选 A 正文（用于 span 越界校验）
 * @param candidateBText 候选 B 正文
 */
export function validateJudgeEvidence(
  verdict: JudgeVerdict,
  candidateAText: string,
  candidateBText: string
): EvidenceValidationResult {
  const errors: string[] = [];
  const missingSpanReasons: string[] = [];
  const inconsistentWinnerReasons: number[] = [];

  // 1. 基础 span 越界校验
  const base = validateVerdictEvidence(verdict, candidateAText, candidateBText);
  errors.push(...base.errors);

  // 2. winner 一致性校验
  if (verdict.winner !== "tie") {
    if (verdict.decisiveReasons.length === 0) {
      errors.push("winner 非 tie 但无 decisiveReasons，无法支撑胜负判定");
    } else {
      const consistentReasonExists = verdict.decisiveReasons.some(
        (r) => r.betterCandidate === verdict.winner
      );
      if (!consistentReasonExists) {
        errors.push(
          `winner=${verdict.winner} 但无任何 decisiveReason 的 betterCandidate 与之一致`
        );
      }
    }
    // 记录不一致的 reason 索引
    verdict.decisiveReasons.forEach((r, i) => {
      if (r.betterCandidate !== "neither" && r.betterCandidate !== verdict.winner) {
        inconsistentWinnerReasons.push(i);
      }
    });
  }

  // 3. 负面判断 span 强制：逐条检查 decisiveReasons
  verdict.decisiveReasons.forEach((r, i) => {
    const missing = checkReasonEvidence(r, i);
    if (missing) {
      missingSpanReasons.push(missing);
      errors.push(missing);
    }
  });

  // 4. factualRisks / regressionRisks 可追溯性（松校验：非空字符串即可）
  //    计划 §5.2：factualRisks 至少要能对应到某条 reason 的 evidence
  //    这里只检查非空，不强制 span（风险描述本身可能不需要 span）
  for (let i = 0; i < verdict.factualRisks.length; i++) {
    if (!verdict.factualRisks[i].trim()) {
      errors.push(`factualRisks[${i}] 为空字符串`);
    }
  }
  for (let i = 0; i < verdict.regressionRisks.length; i++) {
    if (!verdict.regressionRisks[i].trim()) {
      errors.push(`regressionRisks[${i}] 为空字符串`);
    }
  }

  // 5. 读者体验判决一致性。存在该子判决时，总胜者不得被结构性理由反向覆盖。
  if (verdict.readerExperience) {
    const reader = verdict.readerExperience;
    const votes = [
      reader.nativeChinese,
      reader.characterCredibility,
      reader.goalObstacleChoiceResult,
      reader.emotionalProgression,
      reader.informationRelease,
      reader.sceneImmersion,
      reader.causalEndPressure,
      reader.worldContinuity,
    ];
    const aVotes = votes.filter((vote) => vote === "A").length;
    const bVotes = votes.filter((vote) => vote === "B").length;
    const majority = aVotes >= 5 ? "A" : bVotes >= 5 ? "B" : "tie";
    if (majority !== "tie" && reader.preferredCandidate !== majority) {
      errors.push(
        `readerExperience 首选=${reader.preferredCandidate} 与八维读者体验多数=${majority} 不一致`,
      );
    }
    if (verdict.winner !== "tie" && reader.preferredCandidate !== verdict.winner) {
      errors.push(
        `winner=${verdict.winner} 与读者第一选择=${reader.preferredCandidate} 不一致；结构理由不得覆盖读者体验`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    missingSpanReasons,
    inconsistentWinnerReasons,
  };
}

// ============================================================================
// 单条 reason 证据检查
// ============================================================================

/**
 * 检查单条 decisiveReason 的证据完整性。
 * 被判定更差的一方的 evidence 必须非空（引用其问题 span）。
 *
 * @returns 缺失描述字符串；证据完整返回 null
 */
function checkReasonEvidence(r: DecisiveReason, index: number): string | null {
  if (r.betterCandidate === "neither") {
    // neither：不判定某方更差，不强制 evidence
    return null;
  }
  const worseLabel = r.betterCandidate === "A" ? "B" : "A";
  const worseSpans = worseLabel === "A" ? r.evidenceA : r.evidenceB;
  if (!worseSpans || worseSpans.length === 0) {
    return `decisiveReasons[${index}] 判定 ${worseLabel} 更差，但未引用 ${worseLabel} 的问题 span`;
  }
  // 检查 span 的 excerpt 是否非空（计划要求"原文片段"）
  const emptyExcerpt = worseSpans.find((s) => !s.excerpt || !s.excerpt.trim());
  if (emptyExcerpt) {
    return `decisiveReasons[${index}] 引用 ${worseLabel} 的 span 缺少 excerpt（原文片段）`;
  }
  return null;
}

// ============================================================================
// 便捷：仅检查"是否有足够证据支撑 amplified 胜出"
// ============================================================================

/**
 * 判断 verdict 是否有足够证据支撑 amplified（非 raw）胜出。
 *
 * 条件：
 * - winner 非 tie
 * - confidence 为 clear
 * - 证据校验通过（无 missingSpanReasons）
 * - 至少 1 条 decisiveReason 的 betterCandidate 与 winner 一致
 */
export function hasSufficientEvidenceForAmplified(
  verdict: JudgeVerdict,
  validation: EvidenceValidationResult
): boolean {
  if (verdict.winner === "tie") return false;
  if (verdict.confidence !== "clear") return false;
  if (!validation.ok) return false;
  return verdict.decisiveReasons.some((r) => r.betterCandidate === verdict.winner);
}

// ============================================================================
// 工厂函数
// ============================================================================

export function createJudgeEvidenceValidator() {
  return {
    validate: validateJudgeEvidence,
    hasSufficientEvidence: hasSufficientEvidenceForAmplified,
  };
}
