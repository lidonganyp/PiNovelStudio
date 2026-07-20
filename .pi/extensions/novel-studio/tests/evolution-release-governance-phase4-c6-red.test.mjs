/**
 * EVOLUTION-RELEASE-GOVERNANCE Phase 4 C6 — 第三轮核验 4 个新阻断测试（RED）
 *
 * 真相源：用户第三轮核验（2026-07-17）4 项新生产级阻断
 * 计划：.trae/documents/phase4-c6-c7-new-blockers-fix-plan.md
 *
 * 本测试覆盖 4 项阻断：
 * - P0: canary 完成证据可伪造（verifyCanaryResultArtifacts 只检查文件存在+hash，
 *        不验证文件是真实 chapter trace、observedChapters/observedCalls 与 trace 内容一致）
 * - P1: cmdCanary 策略信誉跨 release 污染（perReleaseReport.strategyReputations
 *        = fullReport.strategyReputations，未按 release 过滤）
 * - P1: 历史成本跨 release 污染（aggregateReleaseCostStats 读当前 trace，
 *        章节被新 release 重跑后旧 release 看到新成本）
 * - P1: auto-hold 仍非原子（recordStateEvent 失败后返回 held:false，
 *        但 manifest 实际已变为 held）
 *
 * RED 状态：
 * - P0: verifyCanaryResultArtifacts 不校验 trace 结构与统计一致性 → 伪造证据通过 → 测试 fail
 * - P1 canary: cmdCanary 用 fullReport.strategyReputations → rel-b 看到 rel-a 的 loss → auto_hold_eligible → 测试 fail
 * - P1 cost: aggregateReleaseCostStats 不读 cost snapshot → 旧 release 看到新成本 → 测试 fail
 * - P1 auto-hold: recordStateEvent 失败时返回 held:false 但 manifest 已 held → 测试 fail
 *
 * 边界（READY_LOCAL）：
 * - 不调用模型、不生成章节正文、不提交长期状态
 * - 复用 governance sibling 模块（dist-test/）
 * - 不修改 evolution-release-registry / release-pointer-store（除 auto-hold 测试注入失败）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  verifyCanaryResultArtifacts,
} from "../dist-test/v2/governance/canary-promotion-gate.js";
import {
  aggregateReleaseCostStats,
} from "../dist-test/v2/governance/release-health-aggregator.js";
import { executeAutoHold } from "../dist-test/v2/governance/release-health-actions.js";
import { createEvolutionReleaseRegistry } from "../dist-test/v2/governance/evolution-release-registry.js";
import {
  EVOLUTION_RELEASE_SCHEMA_ID,
  EVOLUTION_RELEASE_SCHEMA_VERSION,
} from "../dist-test/v2/governance/evolution-release-types.js";
import { createChapterProxyApprovalRegistry } from "../dist-test/v2/governance/chapter-proxy-approval-registry.js";
import {
  CHAPTER_PROXY_APPROVAL_SCHEMA_ID,
  CHAPTER_PROXY_APPROVAL_SCHEMA_VERSION,
} from "../dist-test/v2/governance/chapter-proxy-approval-types.js";
import { recordProxyApprovalFeedback } from "../dist-test/v2/governance/chapter-proxy-approval-feedback-recorder.js";

// ============================================================================
// helpers
// ============================================================================

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_PATH = join(__dirname, "..", "scripts", "evolution-cli.mjs");
const EXT_ROOT = join(__dirname, "..");

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), "phase4-c6-"));
}

function makeTempWorkspace(workspaceId = "ws-test") {
  const projectRoot = mkdtempSync(join(tmpdir(), "c6-ws-"));
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(join(workspacePath, "chapter-approvals"), { recursive: true });
  mkdirSync(join(workspacePath, "traces"), { recursive: true });
  return { projectRoot, workspaceId, workspacePath };
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
    environmentFingerprint: opts.environmentFingerprint ?? "fp-test-hash",
    artifactRefs: [],
    approvalRef: opts.approvalRef ?? "apr-001",
    createdAt: "2026-07-17T00:00:00.000Z",
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

function makeChapterApproval(overrides = {}) {
  return {
    schemaId: CHAPTER_PROXY_APPROVAL_SCHEMA_ID,
    schemaVersion: CHAPTER_PROXY_APPROVAL_SCHEMA_VERSION,
    approvalId: overrides.approvalId ?? "cpa-001",
    releaseId: overrides.releaseId ?? "rel-001",
    workspaceId: overrides.workspaceId ?? "ws-test",
    chapterId: overrides.chapterId ?? "1",
    candidateIds: ["cand-raw", "cand-editorial"],
    anonymousMapping: {
      forward: { A: "cand-raw", B: "cand-editorial" },
      reverse: { A: "cand-editorial", B: "cand-raw" },
      seed: 12345,
    },
    forwardVerdict: "PROXY_APPROVED",
    reverseVerdict: "PROXY_APPROVED",
    finalStatus: "PROXY_APPROVED",
    recommendedCandidateId: "cand-editorial",
    recommendedSource: "editorial",
    winningSpans: [],
    losingSpans: [],
    risks: [],
    rationale: "stub chapter approval for test",
    reviewerType: "validated_human_proxy",
    reviewerModel: "gpt5.6-sol",
    reviewerModelVersion: "gpt5.6-sol-2026-07",
    promptHash: "stub-prompt-hash",
    inputArtifactHash: "stub-input-hash",
    decidedAt: "2026-07-17T00:00:00.000Z",
    budgetUsed: { calls: 2, timeoutMs: 300000 },
    ...overrides,
  };
}

function writeChapterApproval(workspacePath, artifact) {
  const registry = createChapterProxyApprovalRegistry({
    approvalsDir: join(workspacePath, "chapter-approvals"),
  });
  registry.writeArtifact(artifact);
}

/** 构造 canary trace fixture（completed 状态，含 evidence）。 */
function makeCanaryTrace(overrides = {}) {
  return {
    schemaId: "pinovel.canary-run-trace",
    schemaVersion: 1,
    runId: "canary-rel-001-completed",
    releaseId: "rel-001",
    previousReleaseId: "rel-000",
    workspaceId: "ws-test",
    startedAt: "2026-07-17T01:00:00.000Z",
    completedAt: "2026-07-17T01:10:00.000Z",
    strategy: "bounded_canary",
    status: "completed",
    healthSnapshot: {
      status: "healthy",
      alignmentRate: 0.8,
      sampleCount: 5,
      rollbackRate: 0,
      consecutiveNegative: 0,
    },
    evidence: {
      changeClass: "R2",
      currentStatus: "candidate_prod",
      authorizationId: "cauth-001",
      sourceRunId: "canary-rel-001-started",
      environmentFingerprint: "fp-001",
      approvalRef: "apr-001",
      verdict: "pass",
      observedChapters: 1,
      observedCalls: 2,
      resultArtifactRefs: [],
      resultArtifactHashes: {},
    },
    outcome: {
      promoted: false,
      heldByAutoHold: false,
    },
    shadowPendingRealRun: false,
    ...overrides,
  };
}

/** 构造 trace JSON 文档，gates[] 含 v2_final_selected gate，evidence.modelCalls 含给定条目。 */
function makeTraceDoc(chapterId, modelCalls) {
  return {
    schemaVersion: 1,
    workspaceId: "ws-test",
    chapterId,
    createdAt: "2026-07-17T00:00:00.000Z",
    events: [],
    patches: [],
    gates: [
      {
        stage: "v2_final_selected",
        status: "PASS",
        passed: true,
        blocked: false,
        score: 1,
        reason: "selected=cand-editorial source=editorial gain=positive",
        issueTypes: [],
        revisionHints: [],
        evidence: {
          stage: "final_selected",
          timestamp: "2026-07-17T00:00:00.000Z",
          finalSelection: {
            selectedCandidateId: "cand-editorial",
            selectedSource: "editorial",
            projectGain: "positive",
          },
          contextHash: "stub-context-hash",
          modelCalls,
        },
      },
    ],
  };
}

function writeTrace(workspacePath, chapterId, modelCalls) {
  const traceDoc = makeTraceDoc(chapterId, modelCalls);
  const tracePath = join(workspacePath, "traces", `${chapterId}-quality-trace.json`);
  writeFileSync(tracePath, JSON.stringify(traceDoc, null, 2) + "\n", "utf-8");
  return tracePath;
}

function makeModelCall(overrides = {}) {
  return {
    route: "v2_rawstage2",
    kind: "generation",
    model: "claude-opus-4.6",
    durationMs: 1500,
    ts: Date.now(),
    provider: "claude",
    ...overrides,
  };
}

/** 运行 CLI，返回 { code, stdout, stderr }。 */
function runCli(args, env = {}) {
  const fullEnv = { ...process.env, ...env };
  try {
    const output = execFileSync("node", [CLI_PATH, ...args], {
      cwd: EXT_ROOT,
      env: fullEnv,
      encoding: "utf-8",
      timeout: 30000,
    });
    return { code: 0, stdout: output, stderr: "" };
  } catch (e) {
    return {
      code: e.status ?? 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

// ============================================================================
// P0: canary 完成证据可伪造 — verifyCanaryResultArtifacts 必须校验 trace 结构 + 统计一致性
// ============================================================================

test("P0: canary 伪造的非 trace JSON 文件必须被拒绝", () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "c6-p0-forged-"));
  try {
    // 构造一个任意 JSON 文件（不是 chapter trace）
    const artifactRef = "reports/forged-evidence.json";
    const artifactPath = join(workspacePath, artifactRef);
    mkdirSync(join(workspacePath, "reports"), { recursive: true });
    const forgedContent = JSON.stringify({
      verdict: "pass",
      observedChapters: 5,
      observedCalls: 10,
      fake: "this is not a real chapter trace",
    }, null, 2) + "\n";
    writeFileSync(artifactPath, forgedContent, "utf-8");
    const hash = createHash("sha256").update(forgedContent, "utf-8").digest("hex");

    // 构造 canary trace，resultArtifactRefs 指向伪造文件，hash 匹配
    const trace = makeCanaryTrace({
      evidence: {
        ...makeCanaryTrace().evidence,
        observedChapters: 5,
        observedCalls: 10,
        resultArtifactRefs: [artifactRef],
        resultArtifactHashes: { [artifactRef]: hash },
      },
    });

    // P0 修复后：verifyCanaryResultArtifacts 必须识别这不是真实 chapter trace
    // P0 修复前：只检查文件存在 + hash 匹配 → 返回 ok: true（BUG）
    const result = verifyCanaryResultArtifacts(workspacePath, trace);
    assert.equal(
      result.ok,
      false,
      `伪造的非 trace JSON 文件必须被拒绝，实际 result=${JSON.stringify(result)}`,
    );
    assert.equal(
      result.code,
      "CANARY_ARTIFACT_MISMATCH",
      `错误码应为 CANARY_ARTIFACT_MISMATCH（或等价的拒绝码），实际 code=${result.code}`,
    );
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("P0: observedChapters/observedCalls 与 trace 内容不一致必须被拒绝", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    // 构造一个真实的 chapter trace 文件，但只有 1 个 chapter、2 次 modelCalls
    const chapterId = "1";
    const tracePath = writeTrace(workspacePath, chapterId, [
      makeModelCall({ route: "v2_rawstage2" }),
      makeModelCall({ route: "v2_amplified" }),
    ]);

    // artifactRef 指向真实 trace 文件
    const artifactRef = `traces/${chapterId}-quality-trace.json`;
    const traceContent = readFileSync(tracePath, "utf-8");
    const hash = createHash("sha256").update(traceContent, "utf-8").digest("hex");

    // 构造 canary trace，声明 observedChapters=5、observedCalls=10（与实际不符）
    const trace = makeCanaryTrace({
      evidence: {
        ...makeCanaryTrace().evidence,
        observedChapters: 5,  // 实际只有 1 个 chapter
        observedCalls: 10,    // 实际只有 2 次 modelCalls
        resultArtifactRefs: [artifactRef],
        resultArtifactHashes: { [artifactRef]: hash },
      },
    });

    // P0 修复后：verifyCanaryResultArtifacts 必须校验统计一致性
    // P0 修复前：只检查文件存在 + hash 匹配 → 返回 ok: true（BUG）
    const result = verifyCanaryResultArtifacts(workspacePath, trace);
    assert.equal(
      result.ok,
      false,
      `observedChapters/observedCalls 与 trace 内容不一致必须被拒绝，实际 result=${JSON.stringify(result)}`,
    );
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("P0: 真实 chapter trace 且统计一致时通过校验", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    // 构造真实的 chapter trace，1 个 chapter、2 次 modelCalls
    const chapterId = "1";
    const tracePath = writeTrace(workspacePath, chapterId, [
      makeModelCall({ route: "v2_rawstage2" }),
      makeModelCall({ route: "v2_amplified" }),
    ]);

    const artifactRef = `traces/${chapterId}-quality-trace.json`;
    const traceContent = readFileSync(tracePath, "utf-8");
    const hash = createHash("sha256").update(traceContent, "utf-8").digest("hex");

    // canary trace 声明与实际一致：observedChapters=1, observedCalls=2
    const trace = makeCanaryTrace({
      evidence: {
        ...makeCanaryTrace().evidence,
        observedChapters: 1,
        observedCalls: 2,
        resultArtifactRefs: [artifactRef],
        resultArtifactHashes: { [artifactRef]: hash },
      },
    });

    // P0 修复后：真实 trace + 统计一致 → ok: true
    const result = verifyCanaryResultArtifacts(workspacePath, trace);
    assert.equal(
      result.ok,
      true,
      `真实 chapter trace 且统计一致时应通过校验，实际 result=${JSON.stringify(result)}`,
    );
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// P1: cmdCanary 策略信誉按 release 过滤（CLI 子进程测试）
// ============================================================================

test("P1: cmdCanary 策略信誉按 release 过滤 — rel-b 不受 rel-a 的 loss 污染", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    // 1. 设置两个 release：rel-a（ch1）、rel-b（ch2），都处于 active_dev
    const registry = makeRegistry(root);
    registry.writeManifest(makeManifest("rel-a", "active_dev", { approvalRef: "apr-a" }));
    registry.writeManifest(makeManifest("rel-b", "active_dev", { approvalRef: "apr-b" }));

    // 2. 写入 chapter approval artifacts
    writeChapterApproval(workspacePath, makeChapterApproval({
      approvalId: "cpa-a1", releaseId: "rel-a", chapterId: "1",
    }));
    writeChapterApproval(workspacePath, makeChapterApproval({
      approvalId: "cpa-b1", releaseId: "rel-b", chapterId: "2",
    }));

    // 3. 写入 strategy-policy.json：
    //    一个 strategy 有 consecutiveLosses=3（触发 auto_hold_eligible 阈值），
    //    evidence sourceChapter="1"（属于 rel-a，不属于 rel-b）
    const strategyPolicy = {
      schemaVersion: 1,
      workspaceId: "ws-test",
      partitions: {
        "claude-opus-4.6": {
          "strategy-loss": {
            strategyId: "strategy-loss",
            modelVersion: "claude-opus-4.6",
            alpha: 1,
            beta: 4,
            sampleCount: 4,
            consecutiveLosses: 3,
            status: "active",
            statusChangedAt: "2026-07-17T00:00:00.000Z",
            statusReason: "test",
            evidence: [
              { sourceChapter: "1", outcome: "loss", source: "judge", weight: 1, timestamp: "2026-07-17T00:00:00.000Z" },
              { sourceChapter: "1", outcome: "loss", source: "judge", weight: 1, timestamp: "2026-07-17T00:00:01.000Z" },
              { sourceChapter: "1", outcome: "loss", source: "judge", weight: 1, timestamp: "2026-07-17T00:00:02.000Z" },
              { sourceChapter: "1", outcome: "win", source: "judge", weight: 1, timestamp: "2026-07-17T00:00:03.000Z" },
            ],
            lastUpdated: "2026-07-17T00:00:03.000Z",
          },
        },
      },
      updatedAt: "2026-07-17T00:00:03.000Z",
    };
    writeFileSync(
      join(workspacePath, "strategy-policy.json"),
      JSON.stringify(strategyPolicy, null, 2) + "\n",
      "utf-8",
    );

    // 4. 为 rel-b 写入 3 条 aligned feedback（alignmentRate=1.0，>= HEALTHY_ALIGNMENT_RATE=0.7）
    //    sampleCount=3 >= MIN_SAMPLE_SIZE=3 → 健康判定可执行
    for (let i = 0; i < 3; i++) {
      recordProxyApprovalFeedback({
        workspacePath,
        feedback: {
          timestamp: `2026-07-17T00:0${i}:00.000Z`,
          approvalId: "cpa-b1",
          chapterId: "2",
          workspaceId: "ws-test",
          action: "accept",
          proxyJudgmentBias: {
            proxyRecommendedSource: "editorial",
            userAcceptedSource: "editorial",
            aligned: true,
          },
        },
      });
    }

    // 5. 运行 evolution:canary --release-id rel-b
    const result = runCli(
      ["canary", "--release-id", "rel-b", "--workspace", workspacePath],
      { PINOVEL_EVOLUTION_ROOT: root },
    );

    assert.equal(
      result.code,
      0,
      `canary evaluate 模式应 exit 0，实际 exit ${result.code}，stderr=${result.stderr}`,
    );

    // P1 修复后：rel-b 的策略信誉按 release 过滤 → strategy-loss 被过滤掉（sourceChapter="1" 不属于 rel-b）
    //   → consecutiveNegative=0 → alignmentRate=1.0 >= 0.7 → healthStatus=healthy
    // P1 修复前：rel-b 看到 rel-a 的 strategy-loss → consecutiveNegative=3 → auto_hold_eligible
    const healthStatusMatch = result.stdout.match(/healthStatus\s*:\s*(\S+)/);
    assert.ok(healthStatusMatch, `stdout 应包含 healthStatus 行，实际 stdout=${result.stdout}`);
    const healthStatus = healthStatusMatch[1];

    // rel-b 自身 alignmentRate=1.0，不应被 rel-a 的 loss 污染为 auto_hold_eligible
    assert.notEqual(
      healthStatus,
      "auto_hold_eligible",
      `rel-b 不应因 rel-a 的策略 loss 被判定为 auto_hold_eligible（应按 release 过滤策略信誉），实际 healthStatus=${healthStatus}`,
    );
    assert.equal(
      healthStatus,
      "healthy",
      `rel-b 自身 alignmentRate=1.0 应判定为 healthy，实际 healthStatus=${healthStatus}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// P1: 成本不跨 release 污染 — aggregateReleaseCostStats 必须读 cost snapshot
// ============================================================================

test("P1: 旧 release 的成本不受新 release 重跑污染", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    // 1. 两个 release 都有 chapter 1 的 approval（不同 approvalId）
    writeChapterApproval(workspacePath, makeChapterApproval({
      approvalId: "cpa-a1", releaseId: "rel-a", chapterId: "1",
    }));
    writeChapterApproval(workspacePath, makeChapterApproval({
      approvalId: "cpa-b1", releaseId: "rel-b", chapterId: "1",
    }));

    // 2. 写入 cost snapshot 文件（模拟 finalization 时为 rel-a 写的快照）
    //    rel-a 快照记录 3 次 modelCalls（finalization 时的真实成本）
    const snapshotA = {
      schemaId: "pinovel.chapter-cost-snapshot",
      schemaVersion: 1,
      approvalId: "cpa-a1",
      chapterId: "1",
      releaseId: "rel-a",
      traceHash: "stub-hash-rel-a",
      costStats: {
        totalCalls: 3,
        totalDurationMs: 4500,
        averageDurationMs: 1500,
        totalFailedCalls: 0,
        callsByProvider: { claude: 3 },
        callsByRoute: { v2_rawstage2: 2, v2_amplified: 1 },
      },
      writtenAt: "2026-07-17T00:00:00.000Z",
    };
    writeFileSync(
      join(workspacePath, "chapter-approvals", "cpa-a1-cost-snapshot.json"),
      JSON.stringify(snapshotA, null, 2) + "\n",
      "utf-8",
    );

    // rel-b 快照记录 5 次 modelCalls（rel-b 重跑后的真实成本）
    const snapshotB = {
      schemaId: "pinovel.chapter-cost-snapshot",
      schemaVersion: 1,
      approvalId: "cpa-b1",
      chapterId: "1",
      releaseId: "rel-b",
      traceHash: "stub-hash-rel-b",
      costStats: {
        totalCalls: 5,
        totalDurationMs: 7500,
        averageDurationMs: 1500,
        totalFailedCalls: 0,
        callsByProvider: { claude: 5 },
        callsByRoute: { v2_rawstage2: 3, v2_amplified: 2 },
      },
      writtenAt: "2026-07-17T01:00:00.000Z",
    };
    writeFileSync(
      join(workspacePath, "chapter-approvals", "cpa-b1-cost-snapshot.json"),
      JSON.stringify(snapshotB, null, 2) + "\n",
      "utf-8",
    );

    // 3. 当前 trace 文件是 rel-b 重跑后的版本（5 次 modelCalls）
    //    模拟：rel-a 先跑（3 次），trace 被覆盖；rel-b 后跑（5 次），trace 是最新的
    writeTrace(workspacePath, "1", [
      makeModelCall({ route: "v2_rawstage2", durationMs: 1500 }),
      makeModelCall({ route: "v2_rawstage2", durationMs: 1500 }),
      makeModelCall({ route: "v2_rawstage2", durationMs: 1500 }),
      makeModelCall({ route: "v2_amplified", durationMs: 1500 }),
      makeModelCall({ route: "v2_amplified", durationMs: 1500 }),
    ]);

    // 4. 查询 rel-a 的成本
    const costA = aggregateReleaseCostStats(workspacePath, "rel-a");

    // P1 修复后：aggregateReleaseCostStats 读 cpa-a1-cost-snapshot.json → totalCalls=3
    // P1 修复前：aggregateReleaseCostStats 读当前 trace → totalCalls=5（BUG：看到 rel-b 的成本）
    assert.equal(
      costA.totalCalls,
      3,
      `rel-a 的成本应从其快照读取（3 次），不应被 rel-b 重跑污染为 5 次，实际 totalCalls=${costA.totalCalls}`,
    );

    // 5. 查询 rel-b 的成本
    const costB = aggregateReleaseCostStats(workspacePath, "rel-b");

    // rel-b 的快照记录 5 次 → totalCalls=5
    assert.equal(
      costB.totalCalls,
      5,
      `rel-b 的成本应从其快照读取（5 次），实际 totalCalls=${costB.totalCalls}`,
    );
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// P1: auto-hold state-event 失败时回滚 manifest（或返回 held:true + warning）
// ============================================================================

test("P1-4a: fromStatus=active_dev 时 recordStateEvent 失败 → 回滚 manifest → held:false", () => {
  const root = makeTempRoot();
  try {
    // rel-001 处于 active_dev（held→active_dev 允许，可以回滚）
    const registry = setupRelease(root, "rel-001", "active_dev");

    // 构造一个 registry 包装：recordStateEvent 抛错
    const realRegistry = registry;
    const failingRegistry = {
      loadManifest: (id) => realRegistry.loadManifest(id),
      transitionStatus: (id, status, opts) => realRegistry.transitionStatus(id, status, opts),
      recordStateEvent: () => {
        throw new Error("injected state-event write failure");
      },
    };

    const evaluation = {
      releaseId: "rel-001",
      status: "auto_hold_eligible",
      evidence: {
        sampleCount: 5,
        alignmentRate: 0.2,
        rollbackRate: 0.0,
        factGuardPassRate: null,
        consecutiveNegative: 3,
        longTermAlignmentRate: 0.2,
      },
      decision: {
        shouldAutoHold: true,
        shouldSuggestRetired: false,
        recoveryAlignmentRate: 0.8,
        currentStatus: "active_dev",
        alreadyHeld: false,
      },
    };

    const result = executeAutoHold(failingRegistry, evaluation, { actor: "system" });

    // P1 修复后：
    //   transitionStatus 成功（manifest → held）
    //   recordStateEvent 抛错
    //   尝试回滚 transitionStatus(releaseId, "active_dev") → 成功（held→active_dev 允许）
    //   返回 held:false + skippedReason
    // P1 修复前：
    //   transitionStatus 成功（manifest → held）
    //   recordStateEvent 抛错
    //   外层 catch 返回 held:false + skippedReason
    //   但 manifest 实际是 held（BUG）

    // 关键断言：held:false 时 manifest 必须不是 held（原子性）
    const finalManifest = realRegistry.loadManifest("rel-001");
    if (result.held === false) {
      assert.notEqual(
        finalManifest.status,
        "held",
        `held=false 时 manifest 必须不是 held（原子性），实际 manifest.status=${finalManifest.status}`,
      );
    } else {
      // held:true 时 manifest 是 held（回滚失败的兜底路径）
      assert.equal(
        finalManifest.status,
        "held",
        `held=true 时 manifest 应为 held，实际 manifest.status=${finalManifest.status}`,
      );
    }

    // 期望修复后行为：active_dev 可回滚 → held:false + manifest 回到 active_dev
    assert.equal(
      result.held,
      false,
      `fromStatus=active_dev 时应回滚成功并返回 held:false，实际 held=${result.held}`,
    );
    assert.equal(
      finalManifest.status,
      "active_dev",
      `回滚后 manifest 应恢复为 active_dev，实际 status=${finalManifest.status}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P1-4b: fromStatus=candidate_prod 时 recordStateEvent 失败 → 无法回滚 → held:true + warning", () => {
  const root = makeTempRoot();
  try {
    // rel-002 处于 candidate_prod（held→candidate_prod 不允许，无法回滚）
    const registry = setupRelease(root, "rel-002", "candidate_prod");

    const realRegistry = registry;
    const failingRegistry = {
      loadManifest: (id) => realRegistry.loadManifest(id),
      transitionStatus: (id, status, opts) => realRegistry.transitionStatus(id, status, opts),
      recordStateEvent: () => {
        throw new Error("injected state-event write failure");
      },
    };

    const evaluation = {
      releaseId: "rel-002",
      status: "auto_hold_eligible",
      evidence: {
        sampleCount: 5,
        alignmentRate: 0.2,
        rollbackRate: 0.0,
        factGuardPassRate: null,
        consecutiveNegative: 3,
        longTermAlignmentRate: 0.2,
      },
      decision: {
        shouldAutoHold: true,
        shouldSuggestRetired: false,
        recoveryAlignmentRate: 0.8,
        currentStatus: "candidate_prod",
        alreadyHeld: false,
      },
    };

    const result = executeAutoHold(failingRegistry, evaluation, { actor: "system" });

    // P1 修复后：
    //   transitionStatus 成功（manifest → held）
    //   recordStateEvent 抛错
    //   尝试回滚 transitionStatus(releaseId, "candidate_prod") → 失败（held→candidate_prod 不在 TRANSITIONS）
    //   返回 held:true + skippedReason（说明 state event 写入失败且无法回滚）
    // P1 修复前：
    //   transitionStatus 成功（manifest → held）
    //   recordStateEvent 抛错
    //   外层 catch 返回 held:false + skippedReason
    //   但 manifest 实际是 held（BUG：held=false 但 manifest=held）

    const finalManifest = realRegistry.loadManifest("rel-002");

    // 关键断言：不允许出现 held:false 但 manifest=held 的情况（非原子性 BUG）
    if (result.held === false) {
      assert.notEqual(
        finalManifest.status,
        "held",
        `held=false 时 manifest 必须不是 held（原子性），实际 manifest.status=${finalManifest.status}`,
      );
    }

    // 期望修复后行为：candidate_prod 无法回滚 → held:true + warning
    assert.equal(
      result.held,
      true,
      `fromStatus=candidate_prod 时无法回滚（held→candidate_prod 不允许），应返回 held:true + warning，实际 held=${result.held}`,
    );
    assert.equal(
      finalManifest.status,
      "held",
      `manifest 应保持 held（无法回滚），实际 status=${finalManifest.status}`,
    );
    assert.ok(
      result.skippedReason,
      `应包含 warning 说明 state event 写入失败且无法回滚，实际 skippedReason=${result.skippedReason}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
