/**
 * EVOLUTION-RELEASE-GOVERNANCE-G7 — 真实 gpt5.6-sol 章节代理审批 caller 切片3 测试
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 / §7 / Phase G7
 * 派工：docs/remaining-development-dispatch-plan-20260715.md §0.2
 *
 * 本测试覆盖切片3：把 runRealChapterProxyReview 的 NOT_IMPLEMENTED 占位替换为真实 gpt5.6-sol
 * 章节代理审批 caller：
 * 1. createRealGpt56SolChapterProxyApprovalCaller 工厂：identity="gpt5.6-sol"，
 *    接受可注入的 callChatCompletions 函数（测试用 mock；生产用 callJudgeModel）
 * 2. caller.call 行为：
 *    - forward/reverse 双调用 gpt5.6-sol（共 2 次）
 *    - 模型输出 verdict 归一化（slight_win/uncertain → HOLD_FOR_REGENERATION）
 *    - forward≠reverse → finalStatus=HOLD_FOR_REGENERATION（顺序敏感保守）
 *    - recommendedLabel 反推 recommendedCandidateId（用 mapping.forward/reverse.A/B）
 *    - forward/reverse 推荐不一致 → HOLD_FOR_REGENERATION（保守）
 *    - reviewerModel="gpt5.6-sol"，reviewerType="validated_human_proxy"
 * 3. 预算守护：maxCalls < 2 抛错
 * 4. runner.runRealChapterProxyReview：
 *    - 合法授权卡 + callerOverride 注入 → 端到端成功，artifact 写入 registry
 *    - 授权卡过期 / 不覆盖 releaseId / 预算不足 → REQUIRES_AUTH
 *    - 无 callerOverride + 无 NOVELOS_JUDGE_* env → 抛错（API 配置缺失），不抛 NOT_IMPLEMENTED
 *
 * 边界（READY_LOCAL；真实模型调用 REQUIRES_AUTH）：
 * - 不调用真实模型：所有测试通过 mock callChatCompletions 或 callerOverride 注入
 * - 不联网、不写正式 chapters/ 目录、不提交长期状态
 * - 仅写 chapter-proxy-approval registry（临时目录）
 * - 不修改 production entry；本切片只替换 NOT_IMPLEMENTED 占位为真实 caller 调用链
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAnonymousChapterApprovalPacket,
  buildAnonymousMapping,
} from "../dist-test/v2/governance/chapter-proxy-approval-packet-builder.js";
import {
  createStubChapterProxyApprovalCaller,
  createRealGpt56SolChapterProxyApprovalCaller,
} from "../dist-test/v2/governance/chapter-proxy-approval-caller.js";
import {
  executeChapterProxyApproval,
} from "../dist-test/v2/governance/chapter-proxy-approval-executor.js";
import {
  runRealChapterProxyReview,
} from "../dist-test/v2/governance/chapter-proxy-approval-runner.js";
import {
  createChapterProxyApprovalRegistry,
} from "../dist-test/v2/governance/chapter-proxy-approval-registry.js";
import {
  loadAuthorizationCardFromFile,
} from "../dist-test/v2/governance/authorization-card.js";

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

/**
 * 构造合法授权卡 JSON（cardType=real_gpt56sol，未过期，覆盖目标 releaseId，预算充足）。
 */
function makeValidCardJson(overrides = {}) {
  const futureIso = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const pastIso = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  return {
    schemaId: "pinovel.evolution-authorization-card",
    schemaVersion: 1,
    cardId: "card-real-001",
    cardType: "real_gpt56sol",
    model: "gpt5.6-sol",
    allowedReleaseIds: ["rel-001"],
    budget: { maxCalls: 2, timeoutMs: 60000 },
    modelVersion: "gpt5.6-sol-2026-07",
    issuedAt: pastIso,
    expiresAt: futureIso,
    issuer: "test-issuer",
    ...overrides,
  };
}

/**
 * mock gpt5.6-sol 调用：根据 messages 中的顺序标记决定返回 forward 或 reverse 输出。
 * 返回 OpenAI Chat Completions 兼容结构（被 callChatCompletions 注入替代真实 fetch）。
 */
function makeMockCallChatCompletions({
  forwardVerdict,
  reverseVerdict,
  forwardRecommendedLabel,
  reverseRecommendedLabel,
  forwardRationale = "forward rationale",
  reverseRationale = "reverse rationale",
}) {
  let callCount = 0;
  const fn = async (_messages, _options) => {
    callCount += 1;
    const isForward = callCount === 1;
    const verdict = isForward ? forwardVerdict : reverseVerdict;
    const recommendedLabel = isForward ? forwardRecommendedLabel : reverseRecommendedLabel;
    const rationale = isForward ? forwardRationale : reverseRationale;
    const text = JSON.stringify({
      verdict,
      recommendedLabel,
      rationale,
      winningSpans: [],
      losingSpans: [],
    });
    return {
      text,
      model: "gpt-5.6-sol",
      durationMs: 100,
    };
  };
  fn._getCallCount = () => callCount;
  return fn;
}

// ============================================================================
// 1. createRealGpt56SolChapterProxyApprovalCaller 工厂
// ============================================================================

test("real caller: identity='gpt5.6-sol'", () => {
  const caller = createRealGpt56SolChapterProxyApprovalCaller({
    apiKey: "test-key",
    apiBaseUrl: "https://example.invalid/v1",
    modelId: "gpt-5.6-sol",
    callChatCompletions: makeMockCallChatCompletions({
      forwardVerdict: "PROXY_APPROVED",
      reverseVerdict: "PROXY_APPROVED",
      forwardRecommendedLabel: "A",
      reverseRecommendedLabel: "A",
    }),
  });
  assert.equal(caller.identity, "gpt5.6-sol");
});

test("real caller: forward/reverse 都 PROXY_APPROVED + 推荐一致 → finalStatus=PROXY_APPROVED", async () => {
  // forward recommendedLabel="A" → mapping.forward.A = "cand-raw-001"
  // reverse recommendedLabel="A" → mapping.reverse.A = "cand-edit-001"
  // 两者不一致 → 应为 HOLD_FOR_REGENERATION；这里用 reverse recommendedLabel="B" 让它一致
  // reverse.A = "cand-edit-001"，reverse.B = "cand-raw-001"
  // forward.A="cand-raw-001", reverse.B="cand-raw-001" → 一致 → cand-raw-001
  const mockFn = makeMockCallChatCompletions({
    forwardVerdict: "PROXY_APPROVED",
    reverseVerdict: "PROXY_APPROVED",
    forwardRecommendedLabel: "A",
    reverseRecommendedLabel: "B",
  });
  const caller = createRealGpt56SolChapterProxyApprovalCaller({
    apiKey: "test-key",
    apiBaseUrl: "https://example.invalid/v1",
    modelId: "gpt-5.6-sol",
    callChatCompletions: mockFn,
  });

  const input = makePacketInput();
  const packet = buildAnonymousChapterApprovalPacket(input);
  const mapping = buildAnonymousMapping(input.candidates, 42);
  const result = await caller.call(packet, mapping, {
    promptHash: "sha256-prompt-abc",
    modelVersion: "gpt5.6-sol-2026-07",
    budget: { maxCalls: 2, timeoutMs: 60000 },
  });

  assert.equal(result.identity ?? null, null, "result 不应有 identity 字段");
  assert.equal(result.forwardVerdict, "PROXY_APPROVED");
  assert.equal(result.reverseVerdict, "PROXY_APPROVED");
  assert.equal(result.finalStatus, "PROXY_APPROVED");
  assert.equal(result.recommendedCandidateId, "cand-raw-001");
  assert.equal(result.recommendedSource, "raw");
  assert.equal(result.reviewerType, "validated_human_proxy");
  assert.equal(result.reviewerModel, "gpt5.6-sol");
  assert.equal(result.reviewerModelVersion, "gpt5.6-sol-2026-07");
  assert.equal(result.promptHash, "sha256-prompt-abc");
  assert.equal(result.budgetUsed.calls, 2);
  assert.equal(mockFn._getCallCount(), 2, "应调用 2 次（forward + reverse）");
});

test("real caller: forward≠reverse → finalStatus=HOLD_FOR_REGENERATION", async () => {
  const mockFn = makeMockCallChatCompletions({
    forwardVerdict: "PROXY_APPROVED",
    reverseVerdict: "HOLD_FOR_REGENERATION",
    forwardRecommendedLabel: "A",
    reverseRecommendedLabel: "A",
  });
  const caller = createRealGpt56SolChapterProxyApprovalCaller({
    apiKey: "test-key",
    apiBaseUrl: "https://example.invalid/v1",
    modelId: "gpt-5.6-sol",
    callChatCompletions: mockFn,
  });

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
  assert.match(result.rationale, /不一致|forward/);
});

test("real caller: forward/reverse 推荐候选不一致 → finalStatus=HOLD_FOR_REGENERATION", async () => {
  // forward recommendedLabel="A" → mapping.forward.A = "cand-raw-001"
  // reverse recommendedLabel="A" → mapping.reverse.A = "cand-edit-001"
  // 两者不一致（cand-raw-001 vs cand-edit-001）→ HOLD_FOR_REGENERATION
  const mockFn = makeMockCallChatCompletions({
    forwardVerdict: "PROXY_APPROVED",
    reverseVerdict: "PROXY_APPROVED",
    forwardRecommendedLabel: "A",
    reverseRecommendedLabel: "A",
  });
  const caller = createRealGpt56SolChapterProxyApprovalCaller({
    apiKey: "test-key",
    apiBaseUrl: "https://example.invalid/v1",
    modelId: "gpt-5.6-sol",
    callChatCompletions: mockFn,
  });

  const input = makePacketInput();
  const packet = buildAnonymousChapterApprovalPacket(input);
  const mapping = buildAnonymousMapping(input.candidates, 42);
  const result = await caller.call(packet, mapping, {
    promptHash: "sha256-prompt-abc",
    modelVersion: "gpt5.6-sol-2026-07",
    budget: { maxCalls: 2, timeoutMs: 60000 },
  });

  // forward/reverse verdict 一致，但反推的 recommendedCandidateId 不一致 → HOLD
  assert.equal(result.finalStatus, "HOLD_FOR_REGENERATION");
  // recommendedCandidateId 仍指向 forward 推荐的合法候选（schema 要求属于 candidateIds）
  assert.equal(result.recommendedCandidateId, "cand-raw-001");
});

test("real caller: 模型输出 slight_win/uncertain → 归一化为 HOLD_FOR_REGENERATION", async () => {
  const mockFn = makeMockCallChatCompletions({
    forwardVerdict: "slight_win",
    reverseVerdict: "uncertain",
    forwardRecommendedLabel: "A",
    reverseRecommendedLabel: "A",
  });
  const caller = createRealGpt56SolChapterProxyApprovalCaller({
    apiKey: "test-key",
    apiBaseUrl: "https://example.invalid/v1",
    modelId: "gpt-5.6-sol",
    callChatCompletions: mockFn,
  });

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

test("real caller: 预算守护 maxCalls < 2 抛错", async () => {
  const caller = createRealGpt56SolChapterProxyApprovalCaller({
    apiKey: "test-key",
    apiBaseUrl: "https://example.invalid/v1",
    modelId: "gpt-5.6-sol",
    callChatCompletions: makeMockCallChatCompletions({
      forwardVerdict: "PROXY_APPROVED",
      reverseVerdict: "PROXY_APPROVED",
      forwardRecommendedLabel: "A",
      reverseRecommendedLabel: "A",
    }),
  });

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

test("real caller: 反推 recommendedSource 正确（editorial 胜出）", async () => {
  // forward recommendedLabel="B" → mapping.forward.B = "cand-edit-001"
  // reverse recommendedLabel="A" → mapping.reverse.A = "cand-edit-001"
  // 两者一致 → cand-edit-001，recommendedSource=editorial
  const mockFn = makeMockCallChatCompletions({
    forwardVerdict: "PROXY_APPROVED",
    reverseVerdict: "PROXY_APPROVED",
    forwardRecommendedLabel: "B",
    reverseRecommendedLabel: "A",
  });
  const caller = createRealGpt56SolChapterProxyApprovalCaller({
    apiKey: "test-key",
    apiBaseUrl: "https://example.invalid/v1",
    modelId: "gpt-5.6-sol",
    callChatCompletions: mockFn,
  });

  const input = makePacketInput();
  const packet = buildAnonymousChapterApprovalPacket(input);
  const mapping = buildAnonymousMapping(input.candidates, 42);
  const result = await caller.call(packet, mapping, {
    promptHash: "sha256-prompt-abc",
    modelVersion: "gpt5.6-sol-2026-07",
    budget: { maxCalls: 2, timeoutMs: 60000 },
  });

  assert.equal(result.finalStatus, "PROXY_APPROVED");
  assert.equal(result.recommendedCandidateId, "cand-edit-001");
  assert.equal(result.recommendedSource, "editorial");
});

test("real caller: 调用次数 = 2（forward + reverse）", async () => {
  const mockFn = makeMockCallChatCompletions({
    forwardVerdict: "PROXY_APPROVED",
    reverseVerdict: "PROXY_APPROVED",
    forwardRecommendedLabel: "A",
    reverseRecommendedLabel: "B",
  });
  const caller = createRealGpt56SolChapterProxyApprovalCaller({
    apiKey: "test-key",
    apiBaseUrl: "https://example.invalid/v1",
    modelId: "gpt-5.6-sol",
    callChatCompletions: mockFn,
  });

  const input = makePacketInput();
  const packet = buildAnonymousChapterApprovalPacket(input);
  const mapping = buildAnonymousMapping(input.candidates, 42);
  await caller.call(packet, mapping, {
    promptHash: "sha256-prompt-abc",
    modelVersion: "gpt5.6-sol-2026-07",
    budget: { maxCalls: 2, timeoutMs: 60000 },
  });

  assert.equal(mockFn._getCallCount(), 2, "应调用 2 次（forward + reverse）");
});

// ============================================================================
// 2. executor + 真实 caller 端到端
// ============================================================================

test("executor + real caller: 端到端写入 registry（PROXY_APPROVED）", async () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-real-exec-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const input = makePacketInput();
    const caller = createRealGpt56SolChapterProxyApprovalCaller({
      apiKey: "test-key",
      apiBaseUrl: "https://example.invalid/v1",
      modelId: "gpt-5.6-sol",
      callChatCompletions: makeMockCallChatCompletions({
        forwardVerdict: "PROXY_APPROVED",
        reverseVerdict: "PROXY_APPROVED",
        forwardRecommendedLabel: "B",
        reverseRecommendedLabel: "A",
      }),
    });

    const result = await executeChapterProxyApproval({
      packetInput: input,
      caller,
      registry,
      promptHash: "sha256-prompt-abc",
      modelVersion: "gpt5.6-sol-2026-07",
      budget: { maxCalls: 2, timeoutMs: 60000 },
      anonymousSeed: 42,
    });

    assert.equal(result.finalStatus, "PROXY_APPROVED");
    assert.equal(result.canDeliverProxyDraft, true);
    assert.equal(result.artifact.recommendedCandidateId, "cand-edit-001");
    assert.equal(result.artifact.recommendedSource, "editorial");
    assert.equal(result.artifact.reviewerModel, "gpt5.6-sol");
    assert.equal(result.artifact.reviewerType, "validated_human_proxy");
    assert.equal(result.artifact.reviewerModelVersion, "gpt5.6-sol-2026-07");

    // 已写入 registry
    const loaded = registry.loadArtifact(result.artifact.approvalId);
    assert.ok(loaded, "artifact 应已写入 registry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. runRealChapterProxyReview 真实调用链
// ============================================================================

test("runner: runRealChapterProxyReview 合法授权卡 + callerOverride → 端到端成功", async () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-real-runner-ok-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const cardPath = join(root, "auth-card.json");
    writeFileSync(cardPath, JSON.stringify(makeValidCardJson()), "utf-8");

    const input = makePacketInput();
    const callerOverride = createRealGpt56SolChapterProxyApprovalCaller({
      apiKey: "test-key",
      apiBaseUrl: "https://example.invalid/v1",
      modelId: "gpt-5.6-sol",
      callChatCompletions: makeMockCallChatCompletions({
        forwardVerdict: "PROXY_APPROVED",
        reverseVerdict: "PROXY_APPROVED",
        forwardRecommendedLabel: "B",
        reverseRecommendedLabel: "A",
      }),
    });

    const result = await runRealChapterProxyReview({
      chapterRegistry: registry,
      packetInput: input,
      modelVersion: "gpt5.6-sol-2026-07",
      promptHash: "sha256-prompt-abc",
      budget: { maxCalls: 2, timeoutMs: 60000 },
      anonymousSeed: 42,
      authorizationCardPath: cardPath,
      callerOverride,
    });

    assert.equal(result.finalStatus, "PROXY_APPROVED");
    assert.equal(result.canDeliverProxyDraft, true);
    assert.equal(result.artifact.recommendedCandidateId, "cand-edit-001");
    assert.equal(result.artifact.reviewerModel, "gpt5.6-sol");
    assert.equal(result.artifact.reviewerModelVersion, "gpt5.6-sol-2026-07");

    // 已写入 registry
    const loaded = registry.loadArtifact(result.artifact.approvalId);
    assert.ok(loaded, "artifact 应已写入 registry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner: runRealChapterProxyReview 合法授权卡 + HOLD mock → HOLD_FOR_REGENERATION", async () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-real-runner-hold-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const cardPath = join(root, "auth-card.json");
    writeFileSync(cardPath, JSON.stringify(makeValidCardJson()), "utf-8");

    const input = makePacketInput();
    const callerOverride = createRealGpt56SolChapterProxyApprovalCaller({
      apiKey: "test-key",
      apiBaseUrl: "https://example.invalid/v1",
      modelId: "gpt-5.6-sol",
      callChatCompletions: makeMockCallChatCompletions({
        forwardVerdict: "PROXY_APPROVED",
        reverseVerdict: "HOLD_FOR_REGENERATION",
        forwardRecommendedLabel: "B",
        reverseRecommendedLabel: "A",
      }),
    });

    const result = await runRealChapterProxyReview({
      chapterRegistry: registry,
      packetInput: input,
      modelVersion: "gpt5.6-sol-2026-07",
      promptHash: "sha256-prompt-abc",
      budget: { maxCalls: 2, timeoutMs: 60000 },
      authorizationCardPath: cardPath,
      callerOverride,
    });

    assert.equal(result.finalStatus, "HOLD_FOR_REGENERATION");
    assert.equal(result.canDeliverProxyDraft, false);
    assert.match(result.blockReason, /HOLD_FOR_REGENERATION/);

    // HOLD 也写入 registry
    const loaded = registry.loadArtifact(result.artifact.approvalId);
    assert.ok(loaded, "HOLD artifact 也应写入 registry");
    assert.equal(loaded.finalStatus, "HOLD_FOR_REGENERATION");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. runRealChapterProxyReview 授权卡边界
// ============================================================================

test("runner: runRealChapterProxyReview 授权卡过期 → REQUIRES_AUTH", async () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-real-runner-expired-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    // 过期授权卡（expiresAt 在过去）
    const expiredCard = makeValidCardJson({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const cardPath = join(root, "auth-card.json");
    writeFileSync(cardPath, JSON.stringify(expiredCard), "utf-8");

    const input = makePacketInput();
    const callerOverride = createRealGpt56SolChapterProxyApprovalCaller({
      apiKey: "test-key",
      apiBaseUrl: "https://example.invalid/v1",
      modelId: "gpt-5.6-sol",
      callChatCompletions: makeMockCallChatCompletions({
        forwardVerdict: "PROXY_APPROVED",
        reverseVerdict: "PROXY_APPROVED",
        forwardRecommendedLabel: "A",
        reverseRecommendedLabel: "B",
      }),
    });

    await assert.rejects(
      () => runRealChapterProxyReview({
        chapterRegistry: registry,
        packetInput: input,
        modelVersion: "gpt5.6-sol-2026-07",
        promptHash: "sha256-prompt-abc",
        budget: { maxCalls: 2, timeoutMs: 60000 },
        authorizationCardPath: cardPath,
        callerOverride,
      }),
      /REQUIRES_AUTH.*过期/,
      "授权卡过期应抛 REQUIRES_AUTH",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner: runRealChapterProxyReview 授权卡不覆盖 releaseId → REQUIRES_AUTH", async () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-real-runner-no-cov-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    // 授权卡只覆盖 other-release-001，但 packetInput.releaseId=rel-001
    const card = makeValidCardJson({
      allowedReleaseIds: ["other-release-001"],
    });
    const cardPath = join(root, "auth-card.json");
    writeFileSync(cardPath, JSON.stringify(card), "utf-8");

    const input = makePacketInput();
    const callerOverride = createRealGpt56SolChapterProxyApprovalCaller({
      apiKey: "test-key",
      apiBaseUrl: "https://example.invalid/v1",
      modelId: "gpt-5.6-sol",
      callChatCompletions: makeMockCallChatCompletions({
        forwardVerdict: "PROXY_APPROVED",
        reverseVerdict: "PROXY_APPROVED",
        forwardRecommendedLabel: "A",
        reverseRecommendedLabel: "B",
      }),
    });

    await assert.rejects(
      () => runRealChapterProxyReview({
        chapterRegistry: registry,
        packetInput: input,
        modelVersion: "gpt5.6-sol-2026-07",
        promptHash: "sha256-prompt-abc",
        budget: { maxCalls: 2, timeoutMs: 60000 },
        authorizationCardPath: cardPath,
        callerOverride,
      }),
      /REQUIRES_AUTH.*不覆盖/,
      "授权卡不覆盖 releaseId 应抛 REQUIRES_AUTH",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner: runRealChapterProxyReview 授权卡预算不足 → REQUIRES_AUTH", async () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-real-runner-low-budget-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const card = makeValidCardJson({
      budget: { maxCalls: 1, timeoutMs: 60000 },
    });
    const cardPath = join(root, "auth-card.json");
    writeFileSync(cardPath, JSON.stringify(card), "utf-8");

    const input = makePacketInput();
    const callerOverride = createRealGpt56SolChapterProxyApprovalCaller({
      apiKey: "test-key",
      apiBaseUrl: "https://example.invalid/v1",
      modelId: "gpt-5.6-sol",
      callChatCompletions: makeMockCallChatCompletions({
        forwardVerdict: "PROXY_APPROVED",
        reverseVerdict: "PROXY_APPROVED",
        forwardRecommendedLabel: "A",
        reverseRecommendedLabel: "B",
      }),
    });

    await assert.rejects(
      () => runRealChapterProxyReview({
        chapterRegistry: registry,
        packetInput: input,
        modelVersion: "gpt5.6-sol-2026-07",
        promptHash: "sha256-prompt-abc",
        budget: { maxCalls: 2, timeoutMs: 60000 },
        authorizationCardPath: cardPath,
        callerOverride,
      }),
      /REQUIRES_AUTH.*预算不足/,
      "授权卡预算不足应抛 REQUIRES_AUTH",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner: runRealChapterProxyReview 授权卡 schema 非法 → 抛错（非 NOT_IMPLEMENTED）", async () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-real-runner-bad-schema-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    // schema 非法卡（cardId 存在但缺 schemaId/schemaVersion/model 等必填字段）
    const cardPath = join(root, "auth-card.json");
    writeFileSync(cardPath, JSON.stringify({ cardId: "test-card" }), "utf-8");

    const input = makePacketInput();
    const callerOverride = createRealGpt56SolChapterProxyApprovalCaller({
      apiKey: "test-key",
      apiBaseUrl: "https://example.invalid/v1",
      modelId: "gpt-5.6-sol",
      callChatCompletions: makeMockCallChatCompletions({
        forwardVerdict: "PROXY_APPROVED",
        reverseVerdict: "PROXY_APPROVED",
        forwardRecommendedLabel: "A",
        reverseRecommendedLabel: "B",
      }),
    });

    await assert.rejects(
      () => runRealChapterProxyReview({
        chapterRegistry: registry,
        packetInput: input,
        modelVersion: "gpt5.6-sol-2026-07",
        promptHash: "sha256-prompt-abc",
        budget: { maxCalls: 2, timeoutMs: 60000 },
        authorizationCardPath: cardPath,
        callerOverride,
      }),
      (err) => {
        const msg = err.message;
        // 应抛授权卡校验失败，而不是 NOT_IMPLEMENTED
        assert.ok(!/NOT_IMPLEMENTED/.test(msg), `不应抛 NOT_IMPLEMENTED，实际：${msg}`);
        assert.ok(/授权卡校验失败|unknown_schema|missing_field/.test(msg), `应抛授权卡校验失败，实际：${msg}`);
        return true;
      },
      "schema 非法卡应抛授权卡校验失败，而非 NOT_IMPLEMENTED",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner: runRealChapterProxyReview 无 callerOverride + 无 env → 抛 API 配置缺失错误（非 NOT_IMPLEMENTED）", async () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-real-runner-no-env-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const cardPath = join(root, "auth-card.json");
    writeFileSync(cardPath, JSON.stringify(makeValidCardJson()), "utf-8");

    const input = makePacketInput();

    // 保存现有 env，测试结束后恢复
    const savedKey = process.env.NOVELOS_JUDGE_API_KEY;
    const savedBaseUrl = process.env.NOVELOS_JUDGE_BASE_URL;
    const savedModel = process.env.NOVELOS_JUDGE_MODEL;
    delete process.env.NOVELOS_JUDGE_API_KEY;
    delete process.env.NOVELOS_JUDGE_BASE_URL;
    delete process.env.NOVELOS_JUDGE_MODEL;

    try {
      await assert.rejects(
        () => runRealChapterProxyReview({
          chapterRegistry: registry,
          packetInput: input,
          modelVersion: "gpt5.6-sol-2026-07",
          promptHash: "sha256-prompt-abc",
          budget: { maxCalls: 2, timeoutMs: 60000 },
          authorizationCardPath: cardPath,
          // 不提供 callerOverride，也不设置 NOVELOS_JUDGE_* env
        }),
        (err) => {
          const msg = err.message;
          // 应抛 API 配置缺失错误，而不是 NOT_IMPLEMENTED
          assert.ok(!/NOT_IMPLEMENTED/.test(msg), `不应抛 NOT_IMPLEMENTED，实际：${msg}`);
          assert.ok(/env|API|配置|config|未配置|NOVELOS_JUDGE/i.test(msg), `应抛 API 配置缺失错误，实际：${msg}`);
          return true;
        },
        "无 callerOverride 且无 env 应抛 API 配置缺失错误，而非 NOT_IMPLEMENTED",
      );
    } finally {
      // 恢复 env
      if (savedKey !== undefined) process.env.NOVELOS_JUDGE_API_KEY = savedKey;
      if (savedBaseUrl !== undefined) process.env.NOVELOS_JUDGE_BASE_URL = savedBaseUrl;
      if (savedModel !== undefined) process.env.NOVELOS_JUDGE_MODEL = savedModel;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. 授权卡加载单元测试（确认 loadAuthorizationCardFromFile 行为）
// ============================================================================

test("loadAuthorizationCardFromFile: 合法卡返回 AuthorizationCard", () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-card-load-ok-"));
  try {
    const cardPath = join(root, "auth-card.json");
    writeFileSync(cardPath, JSON.stringify(makeValidCardJson()), "utf-8");
    const card = loadAuthorizationCardFromFile(cardPath);
    assert.equal(card.cardId, "card-real-001");
    assert.equal(card.cardType, "real_gpt56sol");
    assert.equal(card.model, "gpt5.6-sol");
    assert.deepEqual(card.allowedReleaseIds, ["rel-001"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadAuthorizationCardFromFile: schema 非法 → 抛授权卡校验失败", () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-card-load-bad-"));
  try {
    const cardPath = join(root, "auth-card.json");
    writeFileSync(cardPath, JSON.stringify({ cardId: "test-card" }), "utf-8");
    assert.throws(
      () => loadAuthorizationCardFromFile(cardPath),
      /授权卡校验失败/,
      "schema 非法卡应抛授权卡校验失败",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 6. stub caller 仍可工作（regression）
// ============================================================================

test("regression: stub caller 仍可工作（identity='stub'）", async () => {
  const caller = createStubChapterProxyApprovalCaller({
    forwardVerdict: "PROXY_APPROVED",
    reverseVerdict: "PROXY_APPROVED",
    recommendedCandidateId: "cand-edit-001",
    recommendedSource: "editorial",
    modelVersion: "gpt5.6-sol-2026-07",
  });
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
  assert.equal(result.finalStatus, "PROXY_APPROVED");
});
