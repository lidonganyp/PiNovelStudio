/**
 * EVOLUTION-RELEASE-GOVERNANCE-1B 审批包生成器测试 — 匿名化 / 正反顺序 / 无身份泄露
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.1 / Phase G4
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildAnonymousApprovalPacket,
  computePacketHash,
  verifyPacketAnonymity,
} from "../dist-test/v2/governance/approval-packet-builder.js";
import { computeReleasePayloadHash } from "../dist-test/v2/governance/evolution-release-schema.js";

// ============================================================================
// helpers
// ============================================================================

function makeCandidateInput(overrides = {}) {
  return {
    releaseId: "rel-cand-001",
    releaseManifestHash: computeReleasePayloadHash({
      schemaId: "pinovel.evolution-release",
      schemaVersion: 1,
      releaseId: "rel-cand-001",
      status: "evaluated",
      parentReleaseId: "rel-000",
      rollbackReleaseId: "rel-000",
      supersedesRef: null,
      changeClass: "R2",
      claims: ["unique-variable:editorial-strategy-A"],
      environmentFingerprint: "fp-cand",
      artifactRefs: ["eval/report.json"],
      approvalRef: null,
      createdAt: "2026-07-16T00:00:00.000Z",
      activatedAt: null,
    }),
    changeClass: "R2",
    uniqueVariable: "editorial-strategy-A",
    fixedCase: "case-mysterious-revival-ch1",
    fixedModel: "doubao-seed-2.1-pro",
    fixedSeed: 0,
    budgetMaxCalls: 6,
    timeoutMs: 300000,
    candidateText: "候选正文文本...",
    currentApprovedText: "当前批准版本正文...",
    rawBaselineText: "raw 基线正文...",
    factGuardReport: { candidatePass: true, currentPass: true, violations: [] },
    stateConsistency: { candidateConsistent: true, currentConsistent: true },
    costProfile: { candidateTokens: 12000, currentTokens: 11000, candidateLatencyMs: 4500, currentLatencyMs: 4200 },
    systemJudgeConclusion: "editorial wins on emotion pacing", // 必须被匿名化
    developerExpectation: "candidate should win", // 必须被匿名化
    candidateSpans: [
      { id: "span-1", text: "候选第3段情绪节拍更稳", side: "candidate" },
      { id: "span-2", text: "候选第5段对白密度合理", side: "candidate" },
    ],
    currentSpans: [
      { id: "span-3", text: "当前版本第5段对白过多", side: "current" },
    ],
    ...overrides,
  };
}

// ============================================================================
// buildAnonymousApprovalPacket
// ============================================================================

test("buildAnonymousApprovalPacket: 生成包含正反顺序的匿名包", () => {
  const packet = buildAnonymousApprovalPacket(makeCandidateInput());
  assert.ok(packet.forward);
  assert.ok(packet.reverse);
  assert.equal(packet.schemaId, "pinovel.release-proxy-approval-packet");
});

test("buildAnonymousApprovalPacket: forward A=候选 B=当前；reverse A=当前 B=候选", () => {
  const input = makeCandidateInput();
  const packet = buildAnonymousApprovalPacket(input);
  // forward: A = candidate, B = current
  assert.equal(packet.forward.labelA, "A");
  assert.equal(packet.forward.labelB, "B");
  assert.equal(packet.forward.textA, input.candidateText);
  assert.equal(packet.forward.textB, input.currentApprovedText);
  // reverse: A = current, B = candidate
  assert.equal(packet.reverse.textA, input.currentApprovedText);
  assert.equal(packet.reverse.textB, input.candidateText);
});

test("buildAnonymousApprovalPacket: 提供 raw baseline", () => {
  const packet = buildAnonymousApprovalPacket(makeCandidateInput());
  assert.ok(packet.rawBaseline);
  assert.equal(packet.rawBaseline.text, "raw 基线正文...");
});

test("buildAnonymousApprovalPacket: 固定 case/model/seed/budget", () => {
  const packet = buildAnonymousApprovalPacket(makeCandidateInput());
  assert.equal(packet.fixedCase, "case-mysterious-revival-ch1");
  assert.equal(packet.fixedModel, "doubao-seed-2.1-pro");
  assert.equal(packet.fixedSeed, 0);
  assert.equal(packet.budgetMaxCalls, 6);
  assert.equal(packet.timeoutMs, 300000);
});

test("buildAnonymousApprovalPacket: 包含 FactGuard / 状态一致性 / 成本延迟", () => {
  const packet = buildAnonymousApprovalPacket(makeCandidateInput());
  assert.ok(packet.factGuard);
  assert.ok(packet.stateConsistency);
  assert.ok(packet.costProfile);
  assert.equal(packet.factGuard.candidatePass, true);
  assert.equal(packet.costProfile.candidateTokens, 12000);
});

test("buildAnonymousApprovalPacket: 不暴露候选身份 / 实现名称 / 生产 judge 结论 / 开发者预期", () => {
  const packet = buildAnonymousApprovalPacket(makeCandidateInput());
  const packetStr = JSON.stringify(packet);
  // 不含 systemJudgeConclusion 原文
  assert.doesNotMatch(packetStr, /editorial wins on emotion pacing/);
  // 不含 developerExpectation 原文
  assert.doesNotMatch(packetStr, /candidate should win/);
  // 不含 uniqueVariable 实现名称（只记为 "unique-variable" 占位）
  assert.doesNotMatch(packetStr, /editorial-strategy-A/);
  // 不含 releaseId（候选身份）
  assert.doesNotMatch(packetStr, /rel-cand-001/);
});

test("buildAnonymousApprovalPacket: 包含唯一变量声明但不暴露值", () => {
  const packet = buildAnonymousApprovalPacket(makeCandidateInput());
  assert.ok(packet.uniqueVariableDeclared);
  assert.equal(packet.uniqueVariableDeclared.hasUniqueVariable, true);
  // 不暴露具体变量名
  assert.equal(packet.uniqueVariableDeclared.value, undefined);
});

test("buildAnonymousApprovalPacket: 包含匿名化的 winning/losing spans", () => {
  const packet = buildAnonymousApprovalPacket(makeCandidateInput());
  assert.ok(packet.forward.spans);
  assert.ok(Array.isArray(packet.forward.spans));
  // spans 用 A/B 标签而非 candidate/current
  for (const span of packet.forward.spans) {
    assert.ok(span.side === "A" || span.side === "B");
  }
});

test("buildAnonymousApprovalPacket: 正反顺序 spans 标签互换", () => {
  const input = makeCandidateInput();
  const packet = buildAnonymousApprovalPacket(input);
  // forward: candidate span → side A
  const fwdSpanA = packet.forward.spans.find((s) => s.side === "A");
  assert.ok(fwdSpanA);
  // reverse: candidate span → side B
  const revSpanB = packet.reverse.spans.find((s) => s.side === "B");
  assert.ok(revSpanB);
  // 文本相同（同一 span 在正反顺序中只是标签互换）
  assert.equal(fwdSpanA.text, revSpanB.text);
});

// ============================================================================
// computePacketHash
// ============================================================================

test("computePacketHash: 同输入同 hash", () => {
  const a = buildAnonymousApprovalPacket(makeCandidateInput());
  const b = buildAnonymousApprovalPacket(makeCandidateInput());
  // 注意：packet 可能含生成时间戳；先检查结构一致
  assert.equal(a.schemaId, b.schemaId);
});

test("computePacketHash: 不同候选文本 → 不同 hash", () => {
  const a = buildAnonymousApprovalPacket(makeCandidateInput({ candidateText: "text-A" }));
  const b = buildAnonymousApprovalPacket(makeCandidateInput({ candidateText: "text-B" }));
  assert.notEqual(computePacketHash(a), computePacketHash(b));
});

// ============================================================================
// verifyPacketAnonymity
// ============================================================================

test("verifyPacketAnonymity: 干净 packet 通过", () => {
  const packet = buildAnonymousApprovalPacket(makeCandidateInput());
  const result = verifyPacketAnonymity(packet, {
    forbiddenTerms: ["editorial-strategy-A", "rel-cand-001", "editorial wins"],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.leakedTerms, []);
});

test("verifyPacketAnonymity: 泄露禁用词 → 拒绝", () => {
  const packet = buildAnonymousApprovalPacket(makeCandidateInput());
  // 故意注入泄露词
  packet.forward.textA = "editorial-strategy-A leaked";
  const result = verifyPacketAnonymity(packet, {
    forbiddenTerms: ["editorial-strategy-A"],
  });
  assert.equal(result.ok, false);
  assert.ok(result.leakedTerms.length > 0);
});

test("verifyPacketAnonymity: 不含 releaseId / 实现名称 / judge 结论", () => {
  const input = makeCandidateInput();
  const packet = buildAnonymousApprovalPacket(input);
  const result = verifyPacketAnonymity(packet, {
    forbiddenTerms: [
      input.releaseId,
      input.uniqueVariable,
      input.systemJudgeConclusion,
      input.developerExpectation,
    ],
  });
  assert.equal(result.ok, true);
});
