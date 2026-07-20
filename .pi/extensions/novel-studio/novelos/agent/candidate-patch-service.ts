/**
 * NovelOS Candidate Patch Service（OPT-9.7 配套）
 *
 * 根据 VerificationFeedback 产生 span 级 patch proposal。
 *
 * 设计原则（M1 纵向切片）：
 * - 只产生 patch candidate，不直接覆盖 draft/raw
 * - patch proposal 写入 candidate-workspace/patch-proposals.json
 * - 退化时（agency 稀释 / 正文大幅缩短）保留原 candidate，patch 标记 rejected
 * - patch 类型遵循 AGENTS.md 修订优先级：sentence_patch → paragraph_patch → bridge_patch → event_patch
 *   （chapter_rewrite 仅灾难级使用，M1 不产生）
 *
 * 退化判定（M1 启发式）：
 * - patch 后正文长度大幅缩短（> 30%）→ 退化
 * - patch 后行动词密度下降（< 80%）→ agency 稀释 → 退化
 * - 退化时 accepted=false，原 candidate 保留
 */

import type { TextSpan } from "../../v2/core/types.js";
import type { VerificationFailureType } from "../verification/narrative-verifier-suite.js";
import type { VerificationFeedback } from "../verification/verification-feedback-compiler.js";

// ============================================================================
// 类型定义
// ============================================================================

export type PatchType =
  | "sentence_patch"
  | "paragraph_patch"
  | "bridge_patch"
  | "event_patch";

export interface PatchProposal {
  /** 对应的 feedback finding id */
  findingId: string;
  /** patch 类型 */
  type: PatchType;
  /** 目标 span（在原 draft 中的位置） */
  targetSpan: TextSpan;
  /** 修复建议（人类可读） */
  suggestion: string;
  /** 修复方向描述（供 LLM 生成 patch 时参考） */
  repairDirection: string;
  /** 是否已应用（默认 false，patch service 只产生 proposal，不应用） */
  applied: boolean;
  /** 退化标记（patch 无改善时保留原 candidate，此 proposal 标记为 rejected） */
  rejected?: boolean;
  /** 拒绝原因（如退化） */
  rejectionReason?: string;
}

export interface PatchEvaluationResult {
  /** patch 是否被接受（非退化） */
  accepted: boolean;
  /** 接受/拒绝原因 */
  reason: string;
  /** 评估指标 */
  metrics: {
    originalLength: number;
    patchedLength: number;
    lengthRatio: number;
    originalAgencyCount: number;
    patchedAgencyCount: number;
    agencyRatio: number;
    /** span 外不变性是否通过（目标 span 外正文保持不变） */
    spanImmutabilityPassed: boolean;
    /** span 外不变性违规详情（未通过时填充） */
    spanViolationDetail?: string;
  };
}

// ============================================================================
// CandidatePatchService
// ============================================================================

export class CandidatePatchService {
  /**
   * 根据 feedback list 产生 patch proposal list。
   * 不直接覆盖 draft/raw，只产生 proposal。
   */
  proposePatches(
    draft: string,
    feedbacks: VerificationFeedback[],
  ): PatchProposal[] {
    return feedbacks.map((fb) => this.proposePatch(draft, fb));
  }

  /**
   * 单个 feedback → patch proposal。
   */
  proposePatch(
    draft: string,
    feedback: VerificationFeedback,
  ): PatchProposal {
    const type = this.inferPatchType(feedback.failureType);
    const repairDirection = this.buildRepairDirection(feedback);

    return {
      findingId: feedback.findingId,
      type,
      targetSpan: feedback.allowedRepairRange,
      suggestion: feedback.repairSuggestion,
      repairDirection,
      applied: false,
    };
  }

  /**
   * 评估 patch 是否退化。
   *
   * 退化条件（M1 启发式）：
   * - patch 修改了目标 span 外的正文 → span 违规 → 退化
   * - patch 后正文长度大幅缩短（> 30%）→ 退化
   * - patch 后行动词密度下降（< 80%）→ agency 稀释 → 退化
   *
   * 退化时 accepted=false，原 candidate 保留，patch 标记 rejected。
   *
   * @param originalDraft 原 draft 文本
   * @param patchedText patch 后的文本
   * @param proposal 对应的 patch proposal
   */
  evaluatePatch(
    originalDraft: string,
    patchedText: string,
    proposal: PatchProposal,
  ): PatchEvaluationResult {
    const originalLength = originalDraft.length;
    const patchedLength = patchedText.length;
    const lengthRatio = originalLength > 0 ? patchedLength / originalLength : 1;

    const originalAgencyCount = this.countAgencyActions(originalDraft);
    const patchedAgencyCount = this.countAgencyActions(patchedText);
    const agencyRatio =
      originalAgencyCount > 0 ? patchedAgencyCount / originalAgencyCount : 1;

    // span 外不变性检查（先于其他退化判定：span 违规是最严重的暗改）
    const spanCheck = this.checkSpanImmutability(originalDraft, patchedText, [proposal.targetSpan]);

    const metrics = {
      originalLength,
      patchedLength,
      lengthRatio,
      originalAgencyCount,
      patchedAgencyCount,
      agencyRatio,
      spanImmutabilityPassed: spanCheck.passed,
      ...(spanCheck.detail ? { spanViolationDetail: spanCheck.detail } : {}),
    };

    // 退化判定 0：span 外不变性违规
    if (!spanCheck.passed) {
      proposal.rejected = true;
      proposal.rejectionReason = `patch 修改了目标 span 外的正文：${spanCheck.detail}`;
      return {
        accepted: false,
        reason: proposal.rejectionReason,
        metrics,
      };
    }

    // 退化判定 1：正文大幅缩短
    if (lengthRatio < 0.7) {
      proposal.rejected = true;
      proposal.rejectionReason = `patch 导致正文大幅缩短（${originalLength}→${patchedLength}，ratio=${lengthRatio.toFixed(2)}），视为退化`;
      return {
        accepted: false,
        reason: proposal.rejectionReason,
        metrics,
      };
    }

    // 退化判定 2：agency 稀释
    if (agencyRatio < 0.8) {
      proposal.rejected = true;
      proposal.rejectionReason = `patch 导致行动词密度下降（${originalAgencyCount}→${patchedAgencyCount}，ratio=${agencyRatio.toFixed(2)}），agency 稀释，视为退化`;
      return {
        accepted: false,
        reason: proposal.rejectionReason,
        metrics,
      };
    }

    return {
      accepted: true,
      reason: "patch 通过退化检查",
      metrics,
    };
  }

  // ── 内部：span 外不变性检查 ──────────────────────────────────────────

  /**
   * 检查 patchedText 是否只修改了 repairRanges 内的内容，span 外正文保持不变。
   *
   * M1.2 P0-3 严格局部替换验证（prefix/suffix/gap 逐字校验）：
   * 1. 范围校验：拒绝非法（倒置）、越界、重叠 span（不再静默合并）
   * 2. 无 range → 全文不可变
   * 3. 严格 prefix 校验：patchedText 必须以 original 第一个 span 之前的文本开头
   * 4. 严格 suffix 校验：patchedText 必须以 original 最后一个 span 之后的文本结尾
   * 5. 中间不可变段（多 span 之间）按序精确匹配，禁止 span 间插入未授权内容（pos > cursor 拒绝）
   * 6. 单 span 场景：无 gap，middle 全部是 span 内修改 → 通过
   *
   * M1.1 旧算法漏洞（已修复）：
   * - 不校验 prefix/suffix → 新增前缀/后缀可绕过
   * - 不检查 span 间插入内容（pos > cursor 未拒绝）→ 两个不可变段之间插入内容可绕过
   * - 静默合并重叠 span（cursor = Math.max）→ 重叠 span 未被拒绝
   * - 不校验越界 span → 越界 span 未被拒绝
   *
   * 容忍 repairRanges 内长度变化（patch 可能增删 span 内文本），
   * 但 span 外文本必须逐字保留且顺序不变。
   */
  private checkSpanImmutability(
    originalDraft: string,
    patchedText: string,
    repairRanges: TextSpan[],
  ): { passed: boolean; detail?: string } {
    // 1. 范围校验：拒绝非法/重叠/越界（不再静默合并）
    const sortedRanges = [...repairRanges]
      .filter((r) => r.end > r.start)
      .sort((a, b) => a.start - b.start);
    for (let i = 0; i < sortedRanges.length; i++) {
      const r = sortedRanges[i];
      if (r.start < 0 || r.end > originalDraft.length || r.start >= r.end) {
        return {
          passed: false,
          detail: `非法 span [${r.start}, ${r.end}]（越界或倒置，原文长度=${originalDraft.length}）`,
        };
      }
      if (i > 0 && r.start < sortedRanges[i - 1].end) {
        return {
          passed: false,
          detail: `重叠 span：[${r.start}, ${r.end}] 与 [${sortedRanges[i - 1].start}, ${sortedRanges[i - 1].end}] 重叠`,
        };
      }
    }

    // 2. 无 range → 全文不可变
    if (sortedRanges.length === 0) {
      if (patchedText === originalDraft) return { passed: true };
      return { passed: false, detail: "无 repair span 但正文被修改" };
    }

    // 3. 严格 prefix 校验：patched 必须以 original 第一个 span 之前的文本开头
    const prefix = originalDraft.slice(0, sortedRanges[0].start);
    if (!patchedText.startsWith(prefix)) {
      const preview = prefix.length > 30 ? `${prefix.slice(0, 30)}...` : prefix;
      return {
        passed: false,
        detail: `span 外前缀被修改（期望以 "${preview}" 开头）`,
      };
    }

    // 4. 严格 suffix 校验：patched 必须以 original 最后一个 span 之后的文本结尾
    const suffix = originalDraft.slice(sortedRanges[sortedRanges.length - 1].end);
    if (!patchedText.endsWith(suffix)) {
      const preview = suffix.length > 30 ? `...${suffix.slice(-30)}` : suffix;
      return {
        passed: false,
        detail: `span 外后缀被修改（期望以 "${preview}" 结尾）`,
      };
    }

    // 5. 中间不可变段（多 span 之间）按序精确匹配，禁止 span 间插入未授权内容
    //    构造不可变段序列：prefix, gap1, gap2, ..., suffix
    //    patched 去掉 prefix 和 suffix 后，剩余中间部分必须按序包含每个 gap，
    //    且 gap 前不得有多余内容（pos > cursor 表示 span 间插入了未授权内容）
    const middle = patchedText.slice(prefix.length, patchedText.length - suffix.length);
    let cursor = 0;
    for (let i = 0; i < sortedRanges.length - 1; i++) {
      const gapStart = sortedRanges[i].end;
      const gapEnd = sortedRanges[i + 1].start;
      const gap = originalDraft.slice(gapStart, gapEnd);
      if (gap.length === 0) continue;
      const pos = middle.indexOf(gap, cursor);
      if (pos < 0) {
        const preview = gap.length > 30 ? `${gap.slice(0, 30)}...` : gap;
        return {
          passed: false,
          detail: `span 间不可变段被修改/缺失（期望保留 "${preview}"）`,
        };
      }
      if (pos > cursor) {
        const gapPreview = gap.length > 30 ? `${gap.slice(0, 30)}...` : gap;
        const inserted = middle.slice(cursor, pos);
        const insertedPreview = inserted.length > 30 ? `${inserted.slice(0, 30)}...` : inserted;
        return {
          passed: false,
          detail: `span 间插入了未授权内容（在不可变段 "${gapPreview}" 前多出 "${insertedPreview}"）`,
        };
      }
      cursor = pos + gap.length;
    }
    // 6. 单 span 场景：cursor 仍为 0，middle 全部是 span 内修改 → 通过
    return { passed: true };
  }

  // ── 内部：failureType → patch 类型 ────────────────────────────────────

  private inferPatchType(failureType: VerificationFailureType): PatchType {
    switch (failureType) {
      case "format_error":
      case "duplicate_pollution":
        return "sentence_patch";
      case "entity_hallucination":
      case "knowledge_boundary":
        return "sentence_patch";
      case "scene_continuity":
        return "bridge_patch";
      case "skeleton_inconsistency":
      case "event_progression":
        return "event_patch";
      case "canon_conflict":
      case "promise_conflict":
        return "sentence_patch";
      case "intent_omission":
        return "paragraph_patch";
      // M1.1 新增
      case "fact_omission":
        return "paragraph_patch";
      case "timeline_inconsistency":
        return "sentence_patch";
      case "location_discontinuity":
        return "bridge_patch";
      case "fact_contradiction":
        return "sentence_patch";
      default:
        return "sentence_patch";
    }
  }

  // ── 内部：构建修复方向 ────────────────────────────────────────────────

  private buildRepairDirection(feedback: VerificationFeedback): string {
    const range = feedback.allowedRepairRange;
    return `在 span [${range.start}, ${range.end}] 范围内修复：${feedback.repairSuggestion}`;
  }

  // ── 内部：行动词计数 ──────────────────────────────────────────────────

  /**
   * 统计正文中的行动词数量（状态变化动词）。
   * 用于 agency 稀释检测。
   */
  private countAgencyActions(text: string): number {
    const pattern = /[变改破建死伤灭裂断胜败逃离获说问道笑怒喊叹答回应看听想走跑跳抓拿放推拉]/g;
    return (text.match(pattern) ?? []).length;
  }
}

// ============================================================================
// 工厂
// ============================================================================

export function createCandidatePatchService(): CandidatePatchService {
  return new CandidatePatchService();
}
