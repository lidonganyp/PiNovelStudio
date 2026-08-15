/**
 * ApprovalPacketBuilder — 匿名审批包生成器（EVOLUTION-RELEASE-GOVERNANCE-1B）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.1 / Phase G4
 *
 * 纯函数模块，无 fs 依赖。提供：
 * - buildAnonymousApprovalPacket：把候选侧输入转成匿名 A/B 正反顺序审批包
 * - computePacketHash：审批包规范化 hash
 * - verifyPacketAnonymity：检测包内是否泄露禁用词（候选身份/实现名称/judge 结论/开发者预期）
 * - collectLeakedReviewIdentityTerms / assertAnonymousReviewPacket：评审前强制拦截 releaseId 泄漏
 *
 * 匿名化原则（计划 §6.1）：
 * - forward：A=候选 B=当前；reverse：A=当前 B=候选（标签互换，文本不变）
 * - 不暴露候选身份（releaseId）、实现名称（uniqueVariable 值）、生产 judge 结论、开发者预期
 * - uniqueVariableDeclared 只记录 hasUniqueVariable=true，value 永远 undefined
 * - spans 用 A/B 标签，不用 candidate/current
 * - 固定 case/model/seed/budget，确保唯一变量是被审批的候选
 *
 * 边界（READY_LOCAL；真实模型调用 REQUIRES_AUTH）：
 * - 不调用模型、不写文件、不依赖 eval 模块
 */

import { createHash } from "node:crypto";
import {
  PROXY_APPROVAL_PACKET_SCHEMA_ID,
  PROXY_APPROVAL_PACKET_SCHEMA_VERSION,
} from "./release-proxy-approval-types.js";
import type {
  ApprovalPacketInput,
  AnonymousApprovalPacket,
  AnonymousPacketSide,
  AnonymousSpan,
} from "./release-proxy-approval-types.js";

// ============================================================================
// buildAnonymousApprovalPacket
// ============================================================================

/**
 * 把候选侧输入转成匿名 A/B 正反顺序审批包。
 *
 * 匿名化映射：
 * - forward: textA=candidate, textB=current, candidate spans→A, current spans→B
 * - reverse: textA=current, textB=candidate, candidate spans→B, current spans→A
 * - rawBaseline 直接保留（baseline 不暴露候选身份）
 * - 固定 case/model/seed/budget 直接保留（这些是冻结环境配置，非候选身份）
 * - factGuard/stateConsistency/costProfile 直接保留（结构化对照数据）
 * - uniqueVariableDeclared: { hasUniqueVariable: true }，不保留 value
 * - releaseId / uniqueVariable / systemJudgeConclusion / developerExpectation 不进入 packet
 */
export function buildAnonymousApprovalPacket(
  input: ApprovalPacketInput,
): AnonymousApprovalPacket {
  // 匿名化 spans
  const candidateSpans: AnonymousSpan[] = input.candidateSpans.map((s) => ({
    id: s.id,
    text: s.text,
    side: "A", // forward: candidate → A
  }));
  const currentSpans: AnonymousSpan[] = input.currentSpans.map((s) => ({
    id: s.id,
    text: s.text,
    side: "B", // forward: current → B
  }));

  // forward: A=候选 B=当前
  const forward: AnonymousPacketSide = {
    labelA: "A",
    labelB: "B",
    textA: input.candidateText,
    textB: input.currentApprovedText,
    spans: [...candidateSpans, ...currentSpans],
  };

  // reverse: A=当前 B=候选（标签互换，文本不变）
  const reverseCandidateSpans: AnonymousSpan[] = input.candidateSpans.map((s) => ({
    id: s.id,
    text: s.text,
    side: "B", // reverse: candidate → B
  }));
  const reverseCurrentSpans: AnonymousSpan[] = input.currentSpans.map((s) => ({
    id: s.id,
    text: s.text,
    side: "A", // reverse: current → A
  }));
  const reverse: AnonymousPacketSide = {
    labelA: "A",
    labelB: "B",
    textA: input.currentApprovedText,
    textB: input.candidateText,
    spans: [...reverseCurrentSpans, ...reverseCandidateSpans],
  };

  return {
    schemaId: PROXY_APPROVAL_PACKET_SCHEMA_ID,
    schemaVersion: PROXY_APPROVAL_PACKET_SCHEMA_VERSION,
    forward,
    reverse,
    rawBaseline: { text: input.rawBaselineText },
    fixedCase: input.fixedCase,
    fixedModel: input.fixedModel,
    fixedSeed: input.fixedSeed,
    budgetMaxCalls: input.budgetMaxCalls,
    timeoutMs: input.timeoutMs,
    factGuard: input.factGuardReport,
    stateConsistency: input.stateConsistency,
    costProfile: input.costProfile,
    uniqueVariableDeclared: { hasUniqueVariable: true },
  };
}

// ============================================================================
// computePacketHash
// ============================================================================

/**
 * 计算审批包规范化 hash。
 * 用于审批 artifact.inputArtifactHash 双向绑定。
 */
export function computePacketHash(packet: AnonymousApprovalPacket): string {
  const canonical = JSON.stringify(packet);
  return "sha256:" + createHash("sha256").update(canonical, "utf-8").digest("hex");
}

// ============================================================================
// verifyPacketAnonymity
// ============================================================================

/**
 * 检测审批包内是否泄露禁用词。
 * 禁用词包括：releaseId（候选身份）、uniqueVariable 值（实现名称）、
 * systemJudgeConclusion（生产 judge 结论）、developerExpectation（开发者预期）。
 *
 * @returns { ok: true, leakedTerms: [] } 或 { ok: false, leakedTerms: string[] }
 */
export function verifyPacketAnonymity(
  packet: AnonymousApprovalPacket,
  options: { forbiddenTerms: string[] },
): { ok: boolean; leakedTerms: string[] } {
  const packetStr = JSON.stringify(packet);
  const leakedTerms: string[] = [];
  for (const term of options.forbiddenTerms) {
    if (term && term.length > 0 && packetStr.includes(term)) {
      leakedTerms.push(term);
    }
  }
  return { ok: leakedTerms.length === 0, leakedTerms };
}

/** Release identity tokens that must not appear in the anonymous review packet. */
const REVIEW_IDENTITY_PATTERN = /\b(?:rel-prod-\d+|rel-phase[a-z0-9]+|rel-\d{3,})\b/gi;

export function collectLeakedReviewIdentityTerms(
  packet: AnonymousApprovalPacket,
  options: { releaseId: string; uniqueVariable?: string },
): string[] {
  const packetStr = JSON.stringify(packet);
  const leaked = new Set<string>();
  for (const term of [options.releaseId, options.uniqueVariable]) {
    if (term && packetStr.includes(term)) leaked.add(term);
  }
  for (const match of packetStr.matchAll(REVIEW_IDENTITY_PATTERN)) {
    leaked.add(match[0]);
  }
  return [...leaked];
}

export function assertAnonymousReviewPacket(
  packet: AnonymousApprovalPacket,
  options: { releaseId: string; uniqueVariable?: string },
): void {
  const leakedTerms = collectLeakedReviewIdentityTerms(packet, options);
  if (leakedTerms.length === 0) return;
  throw new Error(
    `REVIEW_PACKET_IDENTITY_LEAK: 审批包泄露候选身份（${leakedTerms.join(", ")}）。` +
      "真实评审前必须匿名化，不得写入 releaseId / 实现名。",
  );
}
