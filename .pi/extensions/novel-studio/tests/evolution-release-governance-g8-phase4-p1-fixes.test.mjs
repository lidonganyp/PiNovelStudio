/**
 * EVOLUTION-RELEASE-GOVERNANCE Phase 4 — P1 阻断修复测试（RED）
 *
 * 真相源：用户第二轮核验（2026-07-17）4 项阻断
 * 计划：.trae/documents/phase4-g8-governance-blockers-fix-plan.md
 *
 * 本测试覆盖 3 项 P1 修复：
 * - P1-2: stateCommit.error 非空时不记录 accept 成功反馈
 * - P1-3: auto-hold 后 dev pointer 自动回滚 + production pointer 悬挂报告
 * - P1-4: 策略信誉按 release chapter 集合过滤（filterStrategyReputationsByRelease）
 *
 * RED 状态：
 * - P1-2: 当前 shouldRecordFeedback 只检查 commit.ok，不检查 stateCommit.error → 测试 fail
 * - P1-3: executeAutoHold 不接受 pointerStore 参数 → pointerCleanup 为 undefined → 测试 fail
 * - P1-4: filterStrategyReputationsByRelease 未导出 → import 失败 → 测试 fail
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  saveProxyApprovedDraft,
  hasPendingProxyDraft,
} from "../dist/v2/governance/chapter-proxy-approval-draft-checkpoint.js";
import { loadProxyApprovalFeedback } from "../dist/v2/governance/chapter-proxy-approval-feedback-recorder.js";
import { handleChapterProxyFinalization } from "../dist-test/handlers/chapter-proxy-finalization-handler.js";

import { createEvolutionReleaseRegistry } from "../dist-test/v2/governance/evolution-release-registry.js";
import {
  EVOLUTION_RELEASE_SCHEMA_ID,
  EVOLUTION_RELEASE_SCHEMA_VERSION,
} from "../dist-test/v2/governance/evolution-release-types.js";
import { executeAutoHold } from "../dist-test/v2/governance/release-health-actions.js";
import { createReleasePointerStore } from "../dist-test/v2/governance/release-pointer-store.js";
import { createChapterProxyApprovalRegistry } from "../dist-test/v2/governance/chapter-proxy-approval-registry.js";
import {
  CHAPTER_PROXY_APPROVAL_SCHEMA_ID,
  CHAPTER_PROXY_APPROVAL_SCHEMA_VERSION,
} from "../dist-test/v2/governance/chapter-proxy-approval-types.js";
import { filterStrategyReputationsByRelease } from "../dist-test/v2/governance/release-health-aggregator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// helpers
// ============================================================================

function makeTempWorkspace() {
  const projectRoot = mkdtempSync(join(tmpdir(), "phase4-p1-"));
  const workspaceId = "ws-test";
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(join(workspacePath, "chapter-approvals"), { recursive: true });
  return { projectRoot, workspaceId, workspacePath };
}

function writeWorkspaceConfig(workspacePath, characters = []) {
  const config = {
    workspaceId: "ws-test",
    novelName: "测试小说",
    genre: "都市异能",
    subGenres: [],
    styleProfile: "default",
    styleOverrides: {},
    brainholePreferences: { enabledPatterns: [], aggressiveness: 0.3, autoApplyThreshold: 0.7, maxInjectionsPerChapter: 1 },
    qualityGates: { antiAiThreshold: 0.2, emotionMetronome: "strict", dependencyCheck: "strict", minSatisfactionDensity: 0.00015, maxOppressionLength: 4000 },
    targetWordCount: { perChapter: { min: 2500, max: 4500 }, total: 600000 },
    chapterProgress: { completed: 0, current: 1 },
    characters,
  };
  writeFileSync(join(workspacePath, "config.json"), JSON.stringify(config, null, 2), "utf-8");
}

const TEST_CHARACTERS = [
  { id: "li-yifan", name: "李一凡", role: "protagonist", aliases: ["一凡"] },
];

function makeDraftOptions(overrides = {}) {
  return {
    workspacePath: "",
    approvalId: "cpa-phase4-001",
    chapterId: "1",
    candidateId: "cand-raw-001",
    selectedSource: "raw",
    finalText: "代理审批稿正文。这是一段足够长的正文，用于通过 FactGuard 的格式校验。",
    savedAt: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

function setupPendingDraft(workspacePath, approvalId = "cpa-phase4-001") {
  saveProxyApprovedDraft(makeDraftOptions({ workspacePath, approvalId }));
  assert.equal(hasPendingProxyDraft(workspacePath, "1"), true);
}

// --- P1-3 helpers ---

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), "phase4-p1-3-"));
}

function makeManifest(releaseId, status, opts = {}) {
  return {
    schemaId: EVOLUTION_RELEASE_SCHEMA_ID,
    schemaVersion: EVOLUTION_RELEASE_SCHEMA_VERSION,
    releaseId,
    status,
    parentReleaseId: opts.parentReleaseId ?? "rel-000",
    rollbackReleaseId: opts.rollbackReleaseId ?? "rel-000",
    supersedesRef: null,
    changeClass: opts.changeClass ?? "R2",
    claims: opts.claims ?? ["test-claim"],
    environmentFingerprint: "fp-test-hash",
    artifactRefs: [],
    approvalRef: opts.approvalRef ?? "apr-001",
    createdAt: "2026-07-16T00:00:00.000Z",
    activatedAt: null,
  };
}

function makeRegistry(root) {
  return createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
}

function setupRelease(root, releaseId, status, opts = {}) {
  const registry = makeRegistry(root);
  registry.writeManifest(makeManifest(releaseId, status, opts));
  return registry;
}

function makeAutoHoldEvaluation(overrides = {}) {
  return {
    releaseId: overrides.releaseId ?? "rel-001",
    status: "auto_hold_eligible",
    evidence: {
      sampleCount: 5,
      alignmentRate: 0.2,
      rollbackRate: 0.0,
      factGuardPassRate: null,
      consecutiveNegative: 3,
      longTermAlignmentRate: 0.2,
      ...overrides.evidence,
    },
    decision: {
      shouldAutoHold: true,
      shouldSuggestRetired: false,
      recoveryAlignmentRate: 0.8,
      currentStatus: overrides.decision?.currentStatus ?? "active_dev",
      alreadyHeld: false,
      ...overrides.decision,
    },
    ...overrides,
    releaseId: overrides.releaseId ?? "rel-001",
    status: "auto_hold_eligible",
  };
}

// --- P1-4 helpers ---

function makeApprovalArtifact(overrides = {}) {
  return {
    schemaId: CHAPTER_PROXY_APPROVAL_SCHEMA_ID,
    schemaVersion: CHAPTER_PROXY_APPROVAL_SCHEMA_VERSION,
    approvalId: overrides.approvalId ?? "cpa-001",
    releaseId: overrides.releaseId ?? "rel-001",
    workspaceId: overrides.workspaceId ?? "ws-test",
    chapterId: overrides.chapterId ?? "1",
    candidateIds: ["cand-raw", "cand-editorial"],
    anonymousMapping: { forward: { A: "cand-raw", B: "cand-editorial" }, reverse: { A: "cand-editorial", B: "cand-raw" }, seed: 12345 },
    forwardVerdict: "PROXY_APPROVED",
    reverseVerdict: "PROXY_APPROVED",
    finalStatus: "PROXY_APPROVED",
    recommendedCandidateId: "cand-editorial",
    recommendedSource: "editorial",
    winningSpans: [],
    losingSpans: [],
    risks: [],
    rationale: "stub approval for test",
    reviewerType: "validated_human_proxy",
    reviewerModel: "gpt5.6-sol",
    reviewerModelVersion: "gpt5.6-sol-2026-07",
    promptHash: "stub-prompt-hash",
    inputArtifactHash: "stub-input-hash",
    decidedAt: "2026-07-16T00:00:00.000Z",
    budgetUsed: { calls: 2, timeoutMs: 300000 },
    evaluatedAt: "2026-07-16T00:00:00.000Z",
    finalizedAt: null,
  };
}

function makeStrategySnapshot(strategyId, sourceChapters, overrides = {}) {
  return {
    modelVersion: overrides.modelVersion ?? "claude-opus-4-6",
    strategyId,
    status: overrides.status ?? "active",
    alpha: overrides.alpha ?? 5,
    beta: overrides.beta ?? 2,
    sampleCount: overrides.sampleCount ?? 6,
    winRate: overrides.winRate ?? 0.67,
    consecutiveLosses: overrides.consecutiveLosses ?? 0,
    lastUpdated: overrides.lastUpdated ?? "2026-07-17T00:00:00.000Z",
    sourceChapters,
  };
}

// ============================================================================
// P1-2: stateCommit.error 非空时不记录 accept 成功反馈
// ============================================================================

test("P1-2: stateCommit.error 非空时不记录 accept 成功反馈", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);
    setupPendingDraft(workspacePath);

    // 注入部分失败的 commitAndSave：正文保存成功(ok=true)但状态提交失败(stateCommit.error 非空)
    const partialFailureCommitAndSave = () => ({
      ok: true,
      stateCommit: { committed: 0, rejected: 3, error: "narrative-state write failed" },
    });

    const result = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-phase4-001",
      action: "accept",
      confirm: true,
      _commitAndSaveFn: partialFailureCommitAndSave,
      _projectRoot: projectRoot,
    });

    // commit 成功（正文已保存）
    assert.ok(result.finalization, "应有 finalization 结果");
    assert.equal(result.finalization.commit.ok, true, "commitAndSave 应成功（正文已保存）");
    assert.ok(
      result.finalization.commit.stateCommit?.error,
      "stateCommit.error 应非空（状态提交失败）",
    );

    // P1-2 修复后：stateCommit.error 非空时不记录 accept 成功反馈
    // P1-2 修复前：commit.ok===true 就记录反馈 → feedback.jsonl 有 1 条
    const records = loadProxyApprovalFeedback(workspacePath);
    assert.equal(
      records.length,
      0,
      `stateCommit.error 非空时不应记录 accept 反馈，实际 ${records.length} 条`,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// P1-3: auto-hold 后 dev pointer 自动回滚 + production pointer 悬挂报告
// ============================================================================

test("P1-3a: held release 是 active dev pointer 时自动 rollback", () => {
  const root = makeTempRoot();
  try {
    const registry = setupRelease(root, "rel-001", "active_dev");
    // 也写一个 rel-000 manifest（rollback 目标需要存在）
    registry.writeManifest(makeManifest("rel-000", "retired", { approvalRef: "apr-000" }));

    const pointerStore = createReleasePointerStore({ configDir: join(root, "config") });

    // 先 switch dev pointer 到 rel-000（建立历史），再 switch 到 rel-001（当前 active）
    pointerStore.switchActive("development", "rel-000", { actor: "system", reason: "initial" });
    pointerStore.switchActive("development", "rel-001", { actor: "system", reason: "promote" });
    assert.equal(pointerStore.readActive("development")?.releaseId, "rel-001");

    // 触发 auto-hold（传入 pointerStore）
    const evaluation = makeAutoHoldEvaluation({ releaseId: "rel-001" });
    const result = executeAutoHold(registry, evaluation, {
      actor: "system",
      pointerStore,
    });

    // 验证 hold 成功
    assert.equal(result.held, true, "应成功 hold");

    // P1-3 修复后：dev pointer 自动 rollback 到 rel-000
    // P1-3 修复前：pointerCleanup 为 undefined，dev pointer 仍指向 rel-001
    assert.ok(result.pointerCleanup, "应返回 pointerCleanup 结果");
    assert.equal(
      result.pointerCleanup.devPointerRolledBack,
      true,
      "dev pointer 应被自动 rollback",
    );
    assert.notEqual(
      pointerStore.readActive("development")?.releaseId,
      "rel-001",
      "dev pointer 不应再指向 held release",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P1-3b: held release 是 active production pointer 时报告悬挂（system 无权回滚）", () => {
  const root = makeTempRoot();
  try {
    const registry = setupRelease(root, "rel-001", "active_prod", { approvalRef: "apr-001" });
    registry.writeManifest(makeManifest("rel-000", "active_prod", { approvalRef: "apr-000" }));

    const pointerStore = createReleasePointerStore({ configDir: join(root, "config") });

    // 先 switch production pointer 到 rel-000，再 switch 到 rel-001
    pointerStore.switchActive("production", "rel-000", { actor: "user", reason: "initial" });
    pointerStore.switchActive("production", "rel-001", { actor: "user", reason: "promote" });
    assert.equal(pointerStore.readActive("production")?.releaseId, "rel-001");

    // 触发 auto-hold（system actor，无权 rollback production pointer）
    const evaluation = makeAutoHoldEvaluation({
      releaseId: "rel-001",
      decision: { currentStatus: "active_prod", alreadyHeld: false, shouldAutoHold: true },
    });
    const result = executeAutoHold(registry, evaluation, {
      actor: "system",
      pointerStore,
    });

    // 验证 hold 成功
    assert.equal(result.held, true, "应成功 hold");

    // P1-3 修复后：production pointer 悬挂（system 无权 rollback）
    assert.ok(result.pointerCleanup, "应返回 pointerCleanup 结果");
    assert.equal(
      result.pointerCleanup.productionPointerDangling,
      true,
      "production pointer 应标记为悬挂",
    );
    assert.ok(
      result.pointerCleanup.productionPointerWarning,
      "应包含手动回滚命令的 warning",
    );
    assert.match(
      result.pointerCleanup.productionPointerWarning,
      /evolution rollback.*production/i,
      "warning 应包含手动回滚命令",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P1-3c: 不提供 pointerStore 时不执行清理（向后兼容）", () => {
  const root = makeTempRoot();
  try {
    const registry = setupRelease(root, "rel-001", "active_dev");
    const evaluation = makeAutoHoldEvaluation({ releaseId: "rel-001" });

    // 不提供 pointerStore（向后兼容）
    const result = executeAutoHold(registry, evaluation, { actor: "system" });

    assert.equal(result.held, true, "应成功 hold");
    assert.equal(
      result.pointerCleanup,
      undefined,
      "不提供 pointerStore 时 pointerCleanup 应为 undefined",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// P1-4: 策略信誉按 release chapter 集合过滤
// ============================================================================

test("P1-4a: filterStrategyReputationsByRelease 只保留有 release chapter evidence 的策略", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    // 写入 approval artifacts：
    // releaseA ("rel-a") 关联 ch1, ch2
    // releaseB ("rel-b") 关联 ch3
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(workspacePath, "chapter-approvals"),
    });
    registry.writeArtifact(makeApprovalArtifact({
      approvalId: "cpa-a1", releaseId: "rel-a", chapterId: "ch1",
    }));
    registry.writeArtifact(makeApprovalArtifact({
      approvalId: "cpa-a2", releaseId: "rel-a", chapterId: "ch2",
    }));
    registry.writeArtifact(makeApprovalArtifact({
      approvalId: "cpa-b1", releaseId: "rel-b", chapterId: "ch3",
    }));

    // 构造策略信誉快照：
    // strategy1: evidence=[ch1] → 属于 rel-a
    // strategy2: evidence=[ch3] → 属于 rel-b（不属于 rel-a）
    // strategy3: evidence=[ch2, ch3] → 同时属于 rel-a 和 rel-b
    const snapshots = [
      makeStrategySnapshot("strategy1", ["ch1"]),
      makeStrategySnapshot("strategy2", ["ch3"]),
      makeStrategySnapshot("strategy3", ["ch2", "ch3"]),
    ];

    // 过滤 rel-a 的策略信誉
    const filtered = filterStrategyReputationsByRelease(snapshots, workspacePath, "rel-a");

    // 应返回 strategy1 和 strategy3（有 ch1 或 ch2 evidence）
    assert.equal(filtered.length, 2, `应返回 2 个策略，实际 ${filtered.length}`);
    const strategyIds = filtered.map((s) => s.strategyId).sort();
    assert.deepEqual(strategyIds, ["strategy1", "strategy3"]);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("P1-4b: release 无 approval artifact 时返回空数组", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    // rel-c 无任何 approval artifact
    const snapshots = [
      makeStrategySnapshot("strategy1", ["ch1"]),
      makeStrategySnapshot("strategy2", ["ch3"]),
    ];

    const filtered = filterStrategyReputationsByRelease(snapshots, workspacePath, "rel-c");

    assert.equal(filtered.length, 0, `无 approval artifact 时应返回空数组，实际 ${filtered.length}`);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});
