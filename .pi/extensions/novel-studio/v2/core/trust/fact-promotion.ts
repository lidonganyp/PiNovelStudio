/**
 * FACT-PROMOTION — 检索事实晋级与长期状态防穿透
 * （PROMPT-INJECTION-TRUST-ARCHITECTURE-1 Phase 3）
 *
 * 状态机：
 * retrieved_fragment → evidence_candidate → verified_fact
 *   → current_generation_input → state_commit_candidate → committed
 *
 * 禁止：ChapterSeed / 模型结构化状态 / 检索结果直接写入 Canon。
 */

import { createHash, randomBytes } from "node:crypto";
import type {
  EvidenceRef,
  FactPromotionCandidate,
  FactPromotionStage,
  PromotionDecision,
  TrustClass,
} from "./trust-types.js";

const STAGE_ORDER: readonly FactPromotionStage[] = [
  "retrieved_fragment",
  "evidence_candidate",
  "verified_fact",
  "current_generation_input",
  "state_commit_candidate",
  "committed",
] as const;

export interface CreateFactCandidateInput {
  factText: string;
  sourceRefs: EvidenceRef[];
  trustClass?: TrustClass;
  stage?: FactPromotionStage;
  boundTextHash?: string;
  boundSpan?: { start: number; end: number };
  promotionReason?: string;
}

export interface PromoteFactInput {
  candidate: FactPromotionCandidate;
  targetStage: FactPromotionStage;
  /** 验证器结果（进入 verified_fact 及之后必须） */
  verification?: FactPromotionCandidate["verification"];
  /** 用户确认（进入 state_commit_candidate 必须） */
  userConfirmed?: boolean;
  /** 最终正文 hash（提交候选必须绑定） */
  finalTextHash?: string;
  promotionReason?: string;
  now?: Date;
}

export interface PromoteFactResult {
  decision: PromotionDecision;
  candidate: FactPromotionCandidate;
  reason: string;
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function newCandidateId(): string {
  return `fact-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function stageIndex(stage: FactPromotionStage): number {
  const idx = STAGE_ORDER.indexOf(stage);
  return idx;
}

/** 创建检索片段候选（默认 retrieved_fragment） */
export function createFactPromotionCandidate(
  input: CreateFactCandidateInput,
): FactPromotionCandidate {
  const factText = (input.factText ?? "").trim();
  if (!factText) {
    throw new Error("createFactPromotionCandidate: factText 不能为空");
  }
  if (!input.sourceRefs?.length) {
    throw new Error(
      "createFactPromotionCandidate: 无来源检索结果不能成为候选（sourceRefs 必填）",
    );
  }
  const now = new Date().toISOString();
  return {
    candidateId: newCandidateId(),
    stage: input.stage ?? "retrieved_fragment",
    factText,
    contentHash: hashText(factText),
    sourceRefs: [...input.sourceRefs],
    trustClass: input.trustClass ?? "retrieved_reference",
    boundTextHash: input.boundTextHash,
    boundSpan: input.boundSpan,
    promotionReason: input.promotionReason,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 晋级事实候选。
 * - 不可跳跃超过 1 级（committed 除外需逐步）
 * - verified_fact 需要 verification.passed
 * - state_commit_candidate 需要 userConfirmed + finalTextHash
 * - 无来源永远 denied
 */
export function promoteFactCandidate(input: PromoteFactInput): PromoteFactResult {
  const { candidate, targetStage } = input;
  const nowIso = (input.now ?? new Date()).toISOString();

  if (candidate.stage === "rejected" || candidate.stage === "quarantined") {
    return {
      decision: "denied",
      candidate,
      reason: `候选已 ${candidate.stage}，不可晋级`,
    };
  }

  if (targetStage === "rejected" || targetStage === "quarantined") {
    return {
      decision: "allowed",
      candidate: {
        ...candidate,
        stage: targetStage,
        promotionReason: input.promotionReason ?? targetStage,
        updatedAt: nowIso,
      },
      reason: `标记为 ${targetStage}`,
    };
  }

  if (!candidate.sourceRefs.length) {
    return {
      decision: "denied",
      candidate,
      reason: "无来源检索结果不能成为硬事实",
    };
  }

  const from = stageIndex(candidate.stage);
  const to = stageIndex(targetStage);
  if (from < 0 || to < 0) {
    return {
      decision: "denied",
      candidate,
      reason: `非法阶段：${candidate.stage} → ${targetStage}`,
    };
  }
  if (to < from) {
    return {
      decision: "denied",
      candidate,
      reason: "不允许降级晋级路径（请用 reject/quarantine）",
    };
  }
  if (to === from) {
    return {
      decision: "allowed",
      candidate,
      reason: "已在目标阶段",
    };
  }
  // 允许一次推进多级，但每一级门槛都必须满足
  if (to > stageIndex("verified_fact") || to >= stageIndex("verified_fact")) {
    const verification = input.verification ?? candidate.verification;
    if (!verification?.passed) {
      return {
        decision: "requires_verification",
        candidate,
        reason: "进入 verified_fact 及之后需要验证器通过",
      };
    }
  }

  if (to >= stageIndex("state_commit_candidate")) {
    if (input.userConfirmed !== true) {
      return {
        decision: "requires_author_confirm",
        candidate,
        reason: "进入 state_commit_candidate 需要用户确认",
      };
    }
    const textHash = input.finalTextHash ?? candidate.boundTextHash;
    if (!textHash?.trim()) {
      return {
        decision: "denied",
        candidate,
        reason: "状态提交候选必须绑定最终正文 hash",
      };
    }
  }

  if (targetStage === "committed") {
    if (input.userConfirmed !== true) {
      return {
        decision: "requires_author_confirm",
        candidate,
        reason: "提交长期状态需要用户确认",
      };
    }
    if (!(input.finalTextHash ?? candidate.boundTextHash)) {
      return {
        decision: "denied",
        candidate,
        reason: "提交长期状态需要最终正文 hash",
      };
    }
    const verification = input.verification ?? candidate.verification;
    if (!verification?.passed) {
      return {
        decision: "requires_verification",
        candidate,
        reason: "提交长期状态需要验证通过",
      };
    }
  }

  // trustClass 保护：retrieved 不能直接当 committed_state 写入，除非已验证并确认
  if (
    candidate.trustClass === "model_or_user_untrusted" &&
    to >= stageIndex("verified_fact")
  ) {
    return {
      decision: "denied",
      candidate,
      reason: "model_or_user_untrusted 不能晋级为 verified_fact",
    };
  }

  const verification = input.verification ?? candidate.verification;
  const next: FactPromotionCandidate = {
    ...candidate,
    stage: targetStage,
    verification,
    boundTextHash: input.finalTextHash ?? candidate.boundTextHash,
    promotionReason: input.promotionReason ?? `promote_to_${targetStage}`,
    // 验证通过后可提升 trust 到 committed_state 候选（仍非权威写入）
    trustClass:
      to >= stageIndex("verified_fact") && candidate.trustClass === "retrieved_reference"
        ? "retrieved_reference"
        : candidate.trustClass,
    updatedAt: nowIso,
  };

  return {
    decision: "allowed",
    candidate: next,
    reason: `晋级 ${candidate.stage} → ${targetStage}`,
  };
}

/**
 * 是否允许写入长期状态（Canon/Character/Promise/Pattern）。
 * 仅 state_commit_candidate 或 committed 且用户确认。
 */
export function canWriteToLongTermState(
  candidate: FactPromotionCandidate,
  options?: { userConfirmed?: boolean; finalTextHash?: string },
): { allowed: boolean; reason: string } {
  if (
    candidate.stage !== "state_commit_candidate" &&
    candidate.stage !== "committed"
  ) {
    return {
      allowed: false,
      reason: `阶段 ${candidate.stage} 不得写入长期状态`,
    };
  }
  if (options?.userConfirmed !== true) {
    return { allowed: false, reason: "未确认候选不得提交长期状态" };
  }
  if (!candidate.sourceRefs.length) {
    return { allowed: false, reason: "无来源不能写入长期状态" };
  }
  if (!candidate.verification?.passed) {
    return { allowed: false, reason: "未验证不能写入长期状态" };
  }
  const textHash = options.finalTextHash ?? candidate.boundTextHash;
  if (!textHash) {
    return { allowed: false, reason: "缺少最终正文 hash 绑定" };
  }
  if (candidate.boundTextHash && candidate.boundTextHash !== textHash) {
    return {
      allowed: false,
      reason: "正文 hash 与候选绑定不一致",
    };
  }
  return { allowed: true, reason: "允许写入长期状态" };
}

/** 从工具/检索文本创建不可直接提交的 proposal */
export function createStateProposalFromRetrieval(input: {
  factText: string;
  sourceRef: string;
  contentHash?: string;
  span?: { start: number; end: number };
}): FactPromotionCandidate {
  return createFactPromotionCandidate({
    factText: input.factText,
    sourceRefs: [
      {
        kind: "retrieval",
        id: input.sourceRef,
        contentHash: input.contentHash,
        span: input.span,
        locator: input.sourceRef,
      },
    ],
    trustClass: "retrieved_reference",
    stage: "retrieved_fragment",
    promotionReason: "retrieval_proposal_only",
  });
}
