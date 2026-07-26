/**
 * NovelOS Repair Finding Selector（OPT-9.5 拆分自 narrative-agent-loop.ts）
 *
 * 选择有限且有优先级的 finding 批次，避免把整章所有约束一次性压给模型。
 *
 * P0-3 修复：
 * - 过滤掉空范围 finding（allowedRepairRange.start === end）→ 诊断 only，不进入修复批次
 * - 过滤掉已达 semantic 修复预算上限的 finding（由 semanticRepairTracker 追踪）
 *
 * 拆分目的：满足 simplicity-gate 800 行限制；这是纯函数，可独立测试。
 */

import type { VerificationFinding } from "../verification/narrative-verifier-suite.js";

// ============================================================================
// 常量
// ============================================================================

export const DEFAULT_REPAIR_BATCH_SIZE = 4;
export const MAX_STAGNANT_REPAIR_ROUNDS = 2;
/** P0-3：语义类 finding（intent_omission）最多自动修复1轮 */
export const MAX_SEMANTIC_REPAIR_ROUNDS = 1;
/** P0-3：确定性 finding（format/fact/canon 等）可按现有预算执行最多2轮 */
export const MAX_DETERMINISTIC_REPAIR_ROUNDS = 2;

// ============================================================================
// Finding 分类辅助
// ============================================================================

export function isVerbatimIntentFinding(finding: VerificationFinding): boolean {
  return /(?:原句|原文|\[verbatim\])/iu.test(`${finding.conflictFact}\n${finding.sourceRef}`);
}

export function isSemanticFinding(finding: VerificationFinding): boolean {
  // P0-3 修复：只有 heuristic intent_omission 才算语义遗漏（受1轮预算约束）。
  // - deterministic intent_omission（如 verbatim 原句缺失）→ 确定性遗漏，按现有预算2轮
  // - corroborated intent_omission → 多源印证遗漏，按现有预算2轮
  // - 无 certainty 字段的旧 finding（向后兼容）→ 不算语义，按现有预算2轮
  // 这样保证 verbatim 原句缺失等确定性问题仍可修复2轮，只有启发式误判受1轮约束。
  return finding.failureType === "intent_omission" && finding.certainty === "heuristic";
}

function repairPriority(finding: VerificationFinding): number {
  if (finding.failureType !== "intent_omission") return 0;
  if (isVerbatimIntentFinding(finding)) return 1;
  if (finding.source === "event_intent_checker") return 3;
  return 2;
}

// ============================================================================
// 公开入口
// ============================================================================

/**
 * Select a bounded repair batch. Specific must-include findings suppress broad
 * event-summary findings until the concrete obligations have been addressed.
 *
 * P0-3 修复：
 * - 过滤掉空范围 finding（allowedRepairRange.start === end）→ 诊断 only，不进入修复批次
 * - 过滤掉已达 semantic 修复预算上限的 finding（由 semanticRepairTracker 追踪）
 */
export function selectRepairFindings(
  findings: VerificationFinding[],
  limit = DEFAULT_REPAIR_BATCH_SIZE,
  semanticRepairTracker?: Map<string, number>,
): VerificationFinding[] {
  const unique = [...new Map(findings.map((finding) => [finding.id, finding])).values()];
  // P0-3：过滤空范围 finding（诊断 only，不触发改写）
  // inc-3 修复：零宽范围 [textLen, textLen] + deterministic = 插入点，不过滤
  // inc-5 修复：author_input_conflict 必须走 ChapterSeed 修订，不进入正文补丁链；
  //            零宽插入点仅对 intent_omission + deterministic（verbatim 原句缺失）放行
  const nonEmptyRange = unique.filter((finding) => {
    if (finding.failureType === "author_input_conflict") return false;
    const range = finding.allowedRepairRange;
    if (range.end > range.start) return true;
    if (
      range.start === range.end
      && finding.certainty === "deterministic"
      && finding.failureType === "intent_omission"
    ) return true;
    return false;
  });
  // P0-3：过滤已达 semantic 修复预算的 finding
  const budgetEligible = semanticRepairTracker
    ? nonEmptyRange.filter((finding) => {
        if (!isSemanticFinding(finding)) return true;
        const repaired = semanticRepairTracker.get(finding.id) ?? 0;
        return repaired < MAX_SEMANTIC_REPAIR_ROUNDS;
      })
    : nonEmptyRange;

  const hasSpecificIntentFinding = budgetEligible.some(
    (finding) => finding.failureType === "intent_omission" && finding.source !== "event_intent_checker",
  );
  const eligible = hasSpecificIntentFinding
    ? budgetEligible.filter((finding) => finding.source !== "event_intent_checker")
    : budgetEligible;

  return eligible
    .map((finding, index) => ({ finding, index }))
    .sort((left, right) =>
      repairPriority(left.finding) - repairPriority(right.finding) || left.index - right.index)
    .slice(0, Math.max(1, limit))
    .map(({ finding }) => finding);
}

export function findingIds(findings: VerificationFinding[]): Set<string> {
  return new Set(findings.map((finding) => finding.id));
}
