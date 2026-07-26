/**
 * NovelOS Verification Feedback Compiler（OPT-9.7）
 *
 * 把 NarrativeVerifierSuite 的 findings 编译成结构化 feedback list，
 * 供 CandidatePatchService 消费（产生 span 级 patch proposal）。
 *
 * 设计原则：
 * - 只编译 hard findings（fatal/hard）为 feedback → 触发 patch candidate
 * - 软意见（review/info）不编译为 feedback，不触发 patch
 * - feedback 必须包含 candidate span / 冲突事实 / sourceRef / 失败类型 / 置信度 / 允许修改范围
 * - 修复建议（repairSuggestion）基于 failureType 给出人类可读指令
 *
 * 与 CandidatePatchService 的契约：
 * - patch service 只在 allowedRepairRange 内修改
 * - patch service 不得越界修改超出 allowedRepairRange 的正文
 */

import type { TextSpan } from "../../v2/core/types.js";
import type {
  VerificationFailureType,
  VerificationFinding,
  VerificationCertainty,
  VerificationCoverageStatus,
  NarrativeVerifierReport,
} from "./narrative-verifier-suite.js";

// ============================================================================
// 类型定义
// ============================================================================

export interface VerificationFeedback {
  /** 对应的 finding id */
  findingId: string;
  /** candidate span（问题位置） */
  span: TextSpan;
  /** 冲突事实描述 */
  conflictFact: string;
  /** 证据来源引用（fact id / character id / diag id） */
  sourceRef: string;
  /** 失败类型 */
  failureType: VerificationFailureType;
  /** 置信度 0-1 */
  confidence: number;
  /** 允许修改范围（span 级，patch service 只在此范围内修改） */
  allowedRepairRange: TextSpan;
  /** 修复建议（人类可读指令） */
  repairSuggestion: string;
  /** P0-2：确定性等级（从 finding 传播，供 patch service / loop 决定修复预算） */
  certainty: VerificationCertainty;
  /** P0-2：覆盖状态（从 finding 传播，供 patch service / loop 决定是否触发改写） */
  coverageStatus: VerificationCoverageStatus;
}

// ============================================================================
// failureType → 修复建议映射
// ============================================================================

const REPAIR_SUGGESTIONS: Record<VerificationFailureType, string> = {
  format_error: "修复格式损坏：检查截断、乱码、未闭合引号，恢复完整正文结构",
  duplicate_pollution: "删除大段重复内容，保留首次出现的版本",
  entity_hallucination: "移除未在角色档案中的实体，或替换为已知角色",
  scene_continuity: "补充空间/时间过渡，消除无过门跳转",
  skeleton_inconsistency: "恢复前章未解张力，不要无依据消解",
  event_progression: "补充状态变化事件，确保主干 progression 推进",
  knowledge_boundary: "移除角色不该知道的信息，或改用其他角色视角表达",
  canon_conflict: "修正违反 canon 约束的内容，使其符合作品设定",
  promise_conflict: "不要在正文中声称未兑现的 promise 已解决",
  intent_omission: "补充遗漏的关键事件，确保 chapterIntent 核心内容在正文中出现",
  language_risk: "（软意见，不强制修复）优化语言风险，减少 AI 腔/感知侵蚀",
  // M1.1 新增
  fact_omission: "补充遗漏的必需事实，确保 inviolableFacts 中的关键内容在正文中出现",
  timeline_inconsistency: "修正时间回退，确保本章时间不早于已记录的最新时间",
  location_discontinuity: "补充空间过门词，消除无过门的位置跳转",
  fact_contradiction: "修正属性矛盾，使正文与 canon 声明的属性（如颜色）一致",
};

// ============================================================================
// FeedbackCompiler
// ============================================================================

/**
 * 把 verifier report 编译成结构化 feedback list。
 *
 * P0-2 修复：只编译 hard findings 且 allowedRepairRange 非空（start < end）→ 触发 patch candidate。
 * - hard findings 且空范围（start === end）→ 诊断 only，不触发 patch（避免启发式误判触发整章改写）
 * - 软意见（review/info）不编译，不触发 patch
 *
 * @param report NarrativeVerifierSuite.verify() 的返回
 * @returns 可操作的 feedback list（供 CandidatePatchService 消费）
 */
export function compileFeedback(
  report: NarrativeVerifierReport,
): VerificationFeedback[] {
  return report.hardFindings
    .filter((finding) => finding.allowedRepairRange.end > finding.allowedRepairRange.start)
    .map((finding) => findingToFeedback(finding));
}

/**
 * 单个 finding → feedback 转换。
 *
 * P0-2：传播 certainty 与 coverageStatus，供 patch service / loop 决定修复预算。
 */
export function findingToFeedback(
  finding: VerificationFinding,
): VerificationFeedback {
  return {
    findingId: finding.id,
    span: finding.span,
    conflictFact: finding.conflictFact,
    sourceRef: finding.sourceRef,
    failureType: finding.failureType,
    confidence: finding.confidence,
    allowedRepairRange: finding.allowedRepairRange,
    repairSuggestion:
      REPAIR_SUGGESTIONS[finding.failureType] ??
      `修复 ${finding.failureType} 问题`,
    certainty: finding.certainty,
    coverageStatus: finding.coverageStatus,
  };
}

/**
 * 提取软意见（不触发 patch，但可记录到 verifier-report.json 供人工审阅）。
 */
export function extractSoftFindings(
  report: NarrativeVerifierReport,
): VerificationFinding[] {
  return report.softFindings;
}
