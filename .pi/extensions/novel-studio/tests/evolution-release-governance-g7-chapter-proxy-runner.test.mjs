/**
 * EVOLUTION-RELEASE-GOVERNANCE-G7 — 章节代理审批 runner 测试
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 / §7 / Phase G7
 *
 * 本测试覆盖 G7-Runner 切片（匿名正反复判 runner）：
 * 1. packet builder：schema 隔离、forward/reverse 顺序、candidateId 不泄露、anonymity 检测、
 *    computePacketHash 稳定且行为字段敏感、buildAnonymousMapping 双向映射、resolveRecommendedSource 反查
 * 2. stub caller：identity="stub"、零网络调用、预算守护、forward≠reverse → HOLD_FOR_REGENERATION、
 *    slight/uncertain → HOLD_FOR_REGENERATION、recommendedCandidateId 为空抛错
 * 3. executor：完整编排写入 registry、canDeliverProxyDraft 逻辑、recommendedCandidateId 不在候选列表抛错、
 *    候选数量不是 2 抛错
 * 4. runner：runStubChapterProxyReview 端到端、runRealChapterProxyReview REQUIRES_AUTH 边界（无卡/文件不存在）
 *    真实 gpt5.6-sol caller 调用链与合法授权卡端到端覆盖见
 *    evolution-release-governance-g7-real-caller.test.mjs（切片3）。
 *
 * 边界（READY_LOCAL）：
 * - 不调用真实模型、不联网
 * - 不写正式 chapters/ 目录、不提交长期状态
 * - 仅写 chapter-proxy-approval registry（临时目录）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHAPTER_PROXY_APPROVAL_PACKET_SCHEMA_ID,
  CHAPTER_PROXY_APPROVAL_PACKET_SCHEMA_VERSION,
  buildAnonymousChapterApprovalPacket,
  buildAnonymousMapping,
  computeChapterPacketHash,
  verifyChapterPacketAnonymity,
  resolveRecommendedSource,
} from "../dist-test/v2/governance/chapter-proxy-approval-packet-builder.js";
import {
  createStubChapterProxyApprovalCaller,
} from "../dist-test/v2/governance/chapter-proxy-approval-caller.js";
import {
  executeChapterProxyApproval,
} from "../dist-test/v2/governance/chapter-proxy-approval-executor.js";
import {
  runStubChapterProxyReview,
  runRealChapterProxyReview,
} from "../dist-test/v2/governance/chapter-proxy-approval-runner.js";
import { createChapterProxyApprovalRegistry } from "../dist-test/v2/governance/chapter-proxy-approval-registry.js";

// 验证 schema 隔离：ChapterProxyApprovalPacket 与 ReleaseProxyApprovalPacket 不同 schemaId
import { PROXY_APPROVAL_PACKET_SCHEMA_ID as RELEASE_PACKET_SCHEMA_ID } from "../dist-test/v2/governance/release-proxy-approval-types.js";

// ============================================================================
// helpers
// ============================================================================

function makeCandidates() {
  return [
    {
      candidateId: "cand-raw-001",
      candidateKind: "raw",
      text: "raw candidate text for chapter 1",
      spans: [
        { id: "span-raw-1", text: "raw winning span", side: "candidate" },
      ],
    },
    {
      candidateId: "cand-edit-001",
      candidateKind: "editorial",
      text: "editorial candidate text for chapter 1",
      spans: [
        { id: "span-edit-1", text: "editorial winning span", side: "candidate" },
      ],
    },
  ];
}

function makePacketInput(overrides = {}) {
  return {
    releaseId: "rel-001",
    workspaceId: "ws-1",
    chapterId: "ch-1",
    candidates: makeCandidates(),
    factGuardReport: { hardBlocked: false, warnings: [] },
    stateConsistency: { consistent: true },
    costProfile: { totalTokens: 5000, latencyMs: 12000 },
    systemJudgeConclusion: "editorial wins",
    developerExpectation: "editorial should win",
    budgetMaxCalls: 2,
    timeoutMs: 60000,
    fixedCase: "case-a-ch1",
    fixedModel: "glm-5.2",
    fixedSeed: 0,
    ...overrides,
  };
}

function makeStubCallerOptions(overrides = {}) {
  return {
    forwardVerdict: "PROXY_APPROVED",
    reverseVerdict: "PROXY_APPROVED",
    recommendedCandidateId: "cand-edit-001",
    recommendedSource: "editorial",
    modelVersion: "gpt5.6-sol-2026-07",
    ...overrides,
  };
}

// ============================================================================
// 1. packet builder
// ============================================================================

test("packet schema: CHAPTER_PROXY_APPROVAL_PACKET_SCHEMA_ID 与 ReleaseProxyApprovalPacket 不同（隔离）", () => {
  assert.equal(typeof CHAPTER_PROXY_APPROVAL_PACKET_SCHEMA_ID, "string");
  assert.ok(CHAPTER_PROXY_APPROVAL_PACKET_SCHEMA_ID.length > 0);
  assert.equal(CHAPTER_PROXY_APPROVAL_PACKET_SCHEMA_VERSION, 1);
  assert.notEqual(
    CHAPTER_PROXY_APPROVAL_PACKET_SCHEMA_ID,
    RELEASE_PACKET_SCHEMA_ID,
    "ChapterProxyApprovalPacket 必须使用独立 schemaId，不得复用 ReleaseProxyApprovalPacket",
  );
});

test("packet builder: forward/reverse 顺序构造正确（A=候选1 B=候选2 / A=候选2 B=候选1）", () => {
  const input = makePacketInput();
  const packet = buildAnonymousChapterApprovalPacket(input);

  // forward: A=cand-raw-001, B=cand-edit-001
  assert.equal(packet.forward.candidateA.text, "raw candidate text for chapter 1");
  assert.equal(packet.forward.candidateB.text, "editorial candidate text for chapter 1");
  assert.equal(packet.forward.candidateA.label, "A");
  assert.equal(packet.forward.candidateB.label, "B");

  // reverse: A=cand-edit-001, B=cand-raw-001（标签互换，文本不变）
  assert.equal(packet.reverse.candidateA.text, "editorial candidate text for chapter 1");
  assert.equal(packet.reverse.candidateB.text, "raw candidate text for chapter 1");
  assert.equal(packet.reverse.candidateA.label, "A");
  assert.equal(packet.reverse.candidateB.label, "B");

  // candidateCount 固定为 2
  assert.equal(packet.candidateCount, 2);
});

test("packet builder: candidateId / candidateKind / releaseId / workspaceId / chapterId 不进入 packet", () => {
  const input = makePacketInput();
  const packet = buildAnonymousChapterApprovalPacket(input);
  const packetStr = JSON.stringify(packet);

  // 候选身份字段不进入 packet
  assert.ok(!packetStr.includes("cand-raw-001"), "candidateId 不应泄露到 packet");
  assert.ok(!packetStr.includes("cand-edit-001"), "candidateId 不应泄露到 packet");
  assert.ok(!packetStr.includes('"raw"'), "candidateKind 字符串不应泄露到 packet");
  assert.ok(!packetStr.includes('"editorial"'), "candidateKind 字符串不应泄露到 packet");

  // 章节身份字段不进入 packet
  assert.ok(!packetStr.includes("rel-001"), "releaseId 不应泄露到 packet");
  assert.ok(!packetStr.includes("ws-1"), "workspaceId 不应泄露到 packet");
  assert.ok(!packetStr.includes("ch-1"), "chapterId 不应泄露到 packet");

  // 系统 judge 结论 / 开发者预期不进入 packet
  assert.ok(!packetStr.includes("editorial wins"), "systemJudgeConclusion 不应泄露到 packet");
  assert.ok(!packetStr.includes("editorial should win"), "developerExpectation 不应泄露到 packet");
});

test("packet builder: spans 用 A/B 标签，不用 candidate 身份", () => {
  const input = makePacketInput();
  const packet = buildAnonymousChapterApprovalPacket(input);

  // forward: candidate1 spans → A, candidate2 spans → B
  assert.equal(packet.forward.candidateA.spans[0].side, "A");
  assert.equal(packet.forward.candidateB.spans[0].side, "B");

  // reverse: candidate1 spans → B, candidate2 spans → A
  assert.equal(packet.reverse.candidateA.spans[0].side, "A");
  assert.equal(packet.reverse.candidateB.spans[0].side, "B");

  // 不应出现 side="candidate"
  const packetStr = JSON.stringify(packet);
  assert.ok(!packetStr.includes('"side":"candidate"'), "spans side 不应为 candidate（应匿名化为 A/B）");
});

test("packet builder: 候选数量不是 2 抛错", () => {
  const input = makePacketInput({
    candidates: [
      {
        candidateId: "c1",
        candidateKind: "raw",
        text: "t1",
        spans: [],
      },
    ],
  });
  assert.throws(
    () => buildAnonymousChapterApprovalPacket(input),
    /恰好 2 个候选/,
    "候选数量不是 2 应抛错",
  );
});

test("computePacketHash: 稳定且行为字段敏感", () => {
  const input = makePacketInput();
  const packet1 = buildAnonymousChapterApprovalPacket(input);
  const packet2 = buildAnonymousChapterApprovalPacket(input);

  // 同输入 → 同 hash
  const hash1 = computeChapterPacketHash(packet1);
  const hash2 = computeChapterPacketHash(packet2);
  assert.equal(hash1, hash2, "同输入应产生相同 hash");
  assert.match(hash1, /^sha256:[0-9a-f]{64}$/i, "hash 应为 sha256: + 64 位 hex");

  // 行为字段变化 → hash 变化
  const input2 = makePacketInput({
    candidates: [
      {
        candidateId: "cand-raw-001",
        candidateKind: "raw",
        text: "different raw text",
        spans: [],
      },
      makeCandidates()[1],
    ],
  });
  const packet3 = buildAnonymousChapterApprovalPacket(input2);
  const hash3 = computeChapterPacketHash(packet3);
  assert.notEqual(hash1, hash3, "候选文本变化应导致 hash 变化");
});

test("verifyChapterPacketAnonymity: 检测候选 ID 泄露", () => {
  const input = makePacketInput();
  const packet = buildAnonymousChapterApprovalPacket(input);

  // 候选 ID 不应出现在 packet 中
  const result = verifyChapterPacketAnonymity(packet, {
    forbiddenTerms: ["cand-raw-001", "cand-edit-001"],
  });
  assert.equal(result.ok, true, "候选 ID 不应泄露到 packet");
  assert.equal(result.leakedTerms.length, 0);

  // 模拟泄露场景（伪造 packet 含候选 ID）
  const leakedPacket = { ...packet, _leaked: "cand-raw-001" };
  const leakedResult = verifyChapterPacketAnonymity(leakedPacket, {
    forbiddenTerms: ["cand-raw-001"],
  });
  assert.equal(leakedResult.ok, false, "应检测到候选 ID 泄露");
  assert.ok(leakedResult.leakedTerms.includes("cand-raw-001"));
});

test("buildAnonymousMapping: forward/reverse 双向映射", () => {
  const candidates = makeCandidates();
  const mapping = buildAnonymousMapping(candidates, 42);

  // forward: A=cand-raw-001, B=cand-edit-001
  assert.equal(mapping.forward.A, "cand-raw-001");
  assert.equal(mapping.forward.B, "cand-edit-001");

  // reverse: A=cand-edit-001, B=cand-raw-001（标签互换）
  assert.equal(mapping.reverse.A, "cand-edit-001");
  assert.equal(mapping.reverse.B, "cand-raw-001");

  // seed 保留
  assert.equal(mapping.seed, 42);
});

test("buildAnonymousMapping: 候选数量不是 2 抛错", () => {
  assert.throws(
    () => buildAnonymousMapping([makeCandidates()[0]], 42),
    /恰好 2 个候选/,
    "候选数量不是 2 应抛错",
  );
});

test("resolveRecommendedSource: 反查候选来源", () => {
  const candidates = makeCandidates();

  // 推荐 editorial 候选
  assert.equal(resolveRecommendedSource(candidates, "cand-edit-001"), "editorial");

  // 推荐 raw 候选
  assert.equal(resolveRecommendedSource(candidates, "cand-raw-001"), "raw");

  // 推荐不存在的候选 → 抛错
  assert.throws(
    () => resolveRecommendedSource(candidates, "cand-not-exist"),
    /不在候选列表中/,
    "推荐不存在的候选应抛错",
  );
});

// ============================================================================
// 2. stub caller
// ============================================================================

test("stub caller: identity='stub'，零网络调用", async () => {
  const caller = createStubChapterProxyApprovalCaller(makeStubCallerOptions());
  assert.equal(caller.identity, "stub");

  const input = makePacketInput();
  const packet = buildAnonymousChapterApprovalPacket(input);
  const mapping = buildAnonymousMapping(input.candidates, 42);
  const result = await caller.call(packet, mapping, {
    promptHash: "sha256-prompt-abc",
    modelVersion: "gpt5.6-sol-2026-07",
    budget: { maxCalls: 2, timeoutMs: 60000 },
  });

  assert.equal(result.reviewerType, "validated_human_proxy");
  assert.equal(result.reviewerModel, "gpt5.6-sol");
  assert.equal(result.reviewerModelVersion, "gpt5.6-sol-2026-07");
  assert.equal(result.promptHash, "sha256-prompt-abc");
  assert.equal(result.budgetUsed.calls, 2);
  assert.equal(result.recommendedCandidateId, "cand-edit-001");
  assert.equal(result.recommendedSource, "editorial");
});

test("stub caller: 预算守护 maxCalls < 2 抛错", async () => {
  const caller = createStubChapterProxyApprovalCaller(makeStubCallerOptions());
  const input = makePacketInput();
  const packet = buildAnonymousChapterApprovalPacket(input);
  const mapping = buildAnonymousMapping(input.candidates, 42);

  await assert.rejects(
    () => caller.call(packet, mapping, {
      promptHash: "sha256-prompt-abc",
      modelVersion: "gpt5.6-sol-2026-07",
      budget: { maxCalls: 1, timeoutMs: 60000 },
    }),
    /预算不足/,
    "maxCalls < 2 应抛错",
  );
});

test("stub caller: forward≠reverse → finalStatus=HOLD_FOR_REGENERATION", async () => {
  const caller = createStubChapterProxyApprovalCaller(
    makeStubCallerOptions({
      forwardVerdict: "PROXY_APPROVED",
      reverseVerdict: "HOLD_FOR_REGENERATION",
    }),
  );
  const input = makePacketInput();
  const packet = buildAnonymousChapterApprovalPacket(input);
  const mapping = buildAnonymousMapping(input.candidates, 42);
  const result = await caller.call(packet, mapping, {
    promptHash: "sha256-prompt-abc",
    modelVersion: "gpt5.6-sol-2026-07",
    budget: { maxCalls: 2, timeoutMs: 60000 },
  });

  assert.equal(result.forwardVerdict, "PROXY_APPROVED");
  assert.equal(result.reverseVerdict, "HOLD_FOR_REGENERATION");
  assert.equal(result.finalStatus, "HOLD_FOR_REGENERATION");
  assert.match(result.rationale, /不一致/);
});

test("stub caller: slight/uncertain → HOLD_FOR_REGENERATION", async () => {
  const caller = createStubChapterProxyApprovalCaller(
    makeStubCallerOptions({
      forwardVerdict: "slight_win",
      reverseVerdict: "uncertain",
    }),
  );
  const input = makePacketInput();
  const packet = buildAnonymousChapterApprovalPacket(input);
  const mapping = buildAnonymousMapping(input.candidates, 42);
  const result = await caller.call(packet, mapping, {
    promptHash: "sha256-prompt-abc",
    modelVersion: "gpt5.6-sol-2026-07",
    budget: { maxCalls: 2, timeoutMs: 60000 },
  });

  // slight_win/uncertain 都归一化为 HOLD_FOR_REGENERATION
  assert.equal(result.forwardVerdict, "HOLD_FOR_REGENERATION");
  assert.equal(result.reverseVerdict, "HOLD_FOR_REGENERATION");
  assert.equal(result.finalStatus, "HOLD_FOR_REGENERATION");
});

test("stub caller: recommendedCandidateId 为空抛错", () => {
  assert.throws(
    () => createStubChapterProxyApprovalCaller(makeStubCallerOptions({ recommendedCandidateId: "" })),
    /recommendedCandidateId 不能为空/,
    "recommendedCandidateId 为空应抛错",
  );
});

test("stub caller: holdReason 写入 rationale 与 risks", async () => {
  const caller = createStubChapterProxyApprovalCaller(
    makeStubCallerOptions({
      forwardVerdict: "HOLD_FOR_REGENERATION",
      reverseVerdict: "HOLD_FOR_REGENERATION",
      holdReason: "raw fallback triggered, candidates may be below raw",
    }),
  );
  const input = makePacketInput();
  const packet = buildAnonymousChapterApprovalPacket(input);
  const mapping = buildAnonymousMapping(input.candidates, 42);
  const result = await caller.call(packet, mapping, {
    promptHash: "sha256-prompt-abc",
    modelVersion: "gpt5.6-sol-2026-07",
    budget: { maxCalls: 2, timeoutMs: 60000 },
  });

  assert.equal(result.finalStatus, "HOLD_FOR_REGENERATION");
  assert.match(result.rationale, /raw fallback triggered/);
  assert.ok(result.risks.includes("raw fallback triggered, candidates may be below raw"));
});

// ============================================================================
// 3. executor
// ============================================================================

test("executor: 完整编排写入 registry（PROXY_APPROVED）", async () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-exec-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const input = makePacketInput();
    const caller = createStubChapterProxyApprovalCaller(makeStubCallerOptions());

    const result = await executeChapterProxyApproval({
      packetInput: input,
      caller,
      registry,
      promptHash: "sha256-prompt-abc",
      modelVersion: "gpt5.6-sol-2026-07",
      budget: { maxCalls: 2, timeoutMs: 60000 },
      anonymousSeed: 42,
    });

    // finalStatus / canDeliverProxyDraft
    assert.equal(result.finalStatus, "PROXY_APPROVED");
    assert.equal(result.canDeliverProxyDraft, true);
    assert.equal(result.blockReason, undefined);

    // artifact 字段
    assert.equal(result.artifact.releaseId, "rel-001");
    assert.equal(result.artifact.workspaceId, "ws-1");
    assert.equal(result.artifact.chapterId, "ch-1");
    assert.equal(result.artifact.recommendedCandidateId, "cand-edit-001");
    assert.equal(result.artifact.recommendedSource, "editorial");
    assert.equal(result.artifact.reviewerType, "validated_human_proxy");
    assert.equal(result.artifact.reviewerModel, "gpt5.6-sol");
    assert.equal(result.artifact.candidateIds.length, 2);
    assert.match(result.artifact.approvalId, /^cpa-rel-001-ch-1-\d+-[0-9a-f]+$/);

    // 匿名映射
    assert.equal(result.artifact.anonymousMapping.forward.A, "cand-raw-001");
    assert.equal(result.artifact.anonymousMapping.forward.B, "cand-edit-001");
    assert.equal(result.artifact.anonymousMapping.reverse.A, "cand-edit-001");
    assert.equal(result.artifact.anonymousMapping.reverse.B, "cand-raw-001");
    assert.equal(result.artifact.anonymousMapping.seed, 42);

    // inputArtifactHash 非空
    assert.match(result.artifact.inputArtifactHash, /^sha256:[0-9a-f]{64}$/i);

    // 已写入 registry
    const loaded = registry.loadArtifact(result.artifact.approvalId);
    assert.ok(loaded, "artifact 应已写入 registry");
    assert.equal(loaded.approvalId, result.artifact.approvalId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executor: HOLD_FOR_REGENERATION → canDeliverProxyDraft=false + blockReason", async () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-exec-hold-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const input = makePacketInput();
    const caller = createStubChapterProxyApprovalCaller(
      makeStubCallerOptions({
        forwardVerdict: "HOLD_FOR_REGENERATION",
        reverseVerdict: "HOLD_FOR_REGENERATION",
        holdReason: "candidates below raw baseline",
      }),
    );

    const result = await executeChapterProxyApproval({
      packetInput: input,
      caller,
      registry,
      promptHash: "sha256-prompt-abc",
      modelVersion: "gpt5.6-sol-2026-07",
      budget: { maxCalls: 2, timeoutMs: 60000 },
    });

    assert.equal(result.finalStatus, "HOLD_FOR_REGENERATION");
    assert.equal(result.canDeliverProxyDraft, false);
    assert.match(result.blockReason, /HOLD_FOR_REGENERATION/);
    assert.match(result.blockReason, /candidates below raw baseline/);

    // HOLD 状态也写入 registry（保留审批证据）
    const loaded = registry.loadArtifact(result.artifact.approvalId);
    assert.ok(loaded, "HOLD artifact 也应写入 registry（保留审批证据）");
    assert.equal(loaded.finalStatus, "HOLD_FOR_REGENERATION");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executor: recommendedCandidateId 不在候选列表抛错", async () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-exec-bad-rec-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const input = makePacketInput();
    const caller = createStubChapterProxyApprovalCaller(
      makeStubCallerOptions({ recommendedCandidateId: "cand-not-exist" }),
    );

    await assert.rejects(
      () => executeChapterProxyApproval({
        packetInput: input,
        caller,
        registry,
        promptHash: "sha256-prompt-abc",
        modelVersion: "gpt5.6-sol-2026-07",
        budget: { maxCalls: 2, timeoutMs: 60000 },
      }),
      /不在候选列表中/,
      "recommendedCandidateId 不在候选列表应抛错",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executor: 候选数量不是 2 抛错", async () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-exec-bad-count-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const input = makePacketInput({
      candidates: [
        {
          candidateId: "c1",
          candidateKind: "raw",
          text: "t1",
          spans: [],
        },
      ],
    });
    const caller = createStubChapterProxyApprovalCaller(
      makeStubCallerOptions({ recommendedCandidateId: "c1", recommendedSource: "raw" }),
    );

    await assert.rejects(
      () => executeChapterProxyApproval({
        packetInput: input,
        caller,
        registry,
        promptHash: "sha256-prompt-abc",
        modelVersion: "gpt5.6-sol-2026-07",
        budget: { maxCalls: 2, timeoutMs: 60000 },
      }),
      /恰好 2 个候选/,
      "候选数量不是 2 应抛错",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. runner
// ============================================================================

test("runner: runStubChapterProxyReview 端到端（PROXY_APPROVED）", async () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-runner-stub-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const input = makePacketInput();

    const result = await runStubChapterProxyReview({
      chapterRegistry: registry,
      packetInput: input,
      forwardVerdict: "PROXY_APPROVED",
      reverseVerdict: "PROXY_APPROVED",
      recommendedCandidateId: "cand-edit-001",
      recommendedSource: "editorial",
      modelVersion: "gpt5.6-sol-2026-07",
      promptHash: "sha256-prompt-abc",
      budget: { maxCalls: 2, timeoutMs: 60000 },
      anonymousSeed: 42,
    });

    assert.equal(result.finalStatus, "PROXY_APPROVED");
    assert.equal(result.canDeliverProxyDraft, true);
    assert.equal(result.artifact.recommendedCandidateId, "cand-edit-001");
    assert.equal(result.artifact.recommendedSource, "editorial");

    // 已写入 registry
    const loaded = registry.loadArtifact(result.artifact.approvalId);
    assert.ok(loaded, "artifact 应已写入 registry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner: runStubChapterProxyReview HOLD_FOR_REGENERATION", async () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-runner-hold-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const input = makePacketInput();

    const result = await runStubChapterProxyReview({
      chapterRegistry: registry,
      packetInput: input,
      forwardVerdict: "uncertain",
      reverseVerdict: "order_sensitive",
      recommendedCandidateId: "cand-edit-001",
      recommendedSource: "editorial",
      modelVersion: "gpt5.6-sol-2026-07",
      promptHash: "sha256-prompt-abc",
      budget: { maxCalls: 2, timeoutMs: 60000 },
    });

    // uncertain/order_sensitive 都归一化为 HOLD_FOR_REGENERATION
    assert.equal(result.finalStatus, "HOLD_FOR_REGENERATION");
    assert.equal(result.canDeliverProxyDraft, false);
    assert.match(result.blockReason, /HOLD_FOR_REGENERATION/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner: runRealChapterProxyReview 无授权卡 → REQUIRES_AUTH", async () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-runner-real-no-card-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const input = makePacketInput();

    await assert.rejects(
      () => runRealChapterProxyReview({
        chapterRegistry: registry,
        packetInput: input,
        forwardVerdict: "PROXY_APPROVED",
        reverseVerdict: "PROXY_APPROVED",
        recommendedCandidateId: "cand-edit-001",
        recommendedSource: "editorial",
        modelVersion: "gpt5.6-sol-2026-07",
        promptHash: "sha256-prompt-abc",
        budget: { maxCalls: 2, timeoutMs: 60000 },
        // 不提供 authorizationCardPath
      }),
      /REQUIRES_AUTH.*授权卡/,
      "无授权卡应抛 REQUIRES_AUTH",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner: runRealChapterProxyReview 文件不存在 → REQUIRES_AUTH", async () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-runner-real-no-file-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const input = makePacketInput();

    await assert.rejects(
      () => runRealChapterProxyReview({
        chapterRegistry: registry,
        packetInput: input,
        forwardVerdict: "PROXY_APPROVED",
        reverseVerdict: "PROXY_APPROVED",
        recommendedCandidateId: "cand-edit-001",
        recommendedSource: "editorial",
        modelVersion: "gpt5.6-sol-2026-07",
        promptHash: "sha256-prompt-abc",
        budget: { maxCalls: 2, timeoutMs: 60000 },
        authorizationCardPath: join(root, "nonexistent-card.json"),
      }),
      /REQUIRES_AUTH.*文件不存在/,
      "授权卡文件不存在应抛 REQUIRES_AUTH",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 切片3：runRealChapterProxyReview 真实 gpt5.6-sol caller 调用链与合法授权卡端到端覆盖
// 见 tests/evolution-release-governance-g7-real-caller.test.mjs
