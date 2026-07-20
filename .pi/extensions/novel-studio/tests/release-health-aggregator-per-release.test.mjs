/**
 * EVOLUTION-RELEASE-GOVERNANCE-G8 - aggregator per-release 分桶 + cost stats 测试（RED）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §8 Phase G8
 * 计划：.trae/documents/g8-health-monitoring-and-retirement-implementation.md §2.3 / §2.4
 *
 * 本测试覆盖 release-health-aggregator 扩展：
 * - aggregateReleaseHealthByRelease：按 releaseId 过滤 feedback（通过 listArtifactsByRelease 反查 approvalId）
 * - aggregateReleaseCostStats：从 trace 的 v2_final_selected gate.evidence.modelCalls 聚合
 *
 * trace 结构（v2/adapters/legacy-trace-adapter.ts:394）：
 *   gates[].stage === "v2_final_selected" 时 evidence 是完整 V2TraceRecord，
 *   其中 evidence.modelCalls: ModelCallEntry[] 含 route/provider/durationMs/failed 等字段。
 *
 * RED 状态：import 的函数尚未实现，所有测试因函数不存在而 fail。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createChapterProxyApprovalRegistry } from "../dist-test/v2/governance/chapter-proxy-approval-registry.js";
import { recordProxyApprovalFeedback } from "../dist-test/v2/governance/chapter-proxy-approval-feedback-recorder.js";
import {
  CHAPTER_PROXY_APPROVAL_SCHEMA_ID,
  CHAPTER_PROXY_APPROVAL_SCHEMA_VERSION,
} from "../dist-test/v2/governance/chapter-proxy-approval-types.js";
import {
  aggregateReleaseHealthByRelease,
  aggregateReleaseCostStats,
} from "../dist-test/v2/governance/release-health-aggregator.js";

// ============================================================================
// helpers
// ============================================================================

function makeTempWorkspace() {
  const projectRoot = mkdtempSync(join(tmpdir(), "g8-aggregator-"));
  const workspaceId = "ws-test";
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(join(workspacePath, "chapter-approvals"), { recursive: true });
  mkdirSync(join(workspacePath, "traces"), { recursive: true });
  return { projectRoot, workspaceId, workspacePath };
}

/**
 * 构造 ChapterProxyApprovalArtifact fixture。
 * 默认 releaseId="rel-001", chapterId="1", workspaceId="ws-test"。
 *
 * schema 合法值约束（chapter-proxy-approval-types.ts）：
 * - forwardVerdict/reverseVerdict/finalStatus ∈ {PROXY_APPROVED, HOLD_FOR_REGENERATION}
 * - finalStatus=PROXY_APPROVED 时 forward/reverse 必须都为 PROXY_APPROVED
 * - anonymousMapping.forward/reverse 各含 A/B 字符串（候选 ID），reverse 必须真正交换 forward 的 A/B
 * - anonymousMapping.seed 为非负数
 */
function makeApprovalArtifact(overrides = {}) {
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
    rationale: "stub approval for test",
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

function writeApproval(workspacePath, artifact) {
  const registry = createChapterProxyApprovalRegistry({
    approvalsDir: join(workspacePath, "chapter-approvals"),
  });
  registry.writeArtifact(artifact);
  return registry;
}

/**
 * 构造 feedback record fixture。
 * 默认 action="accept", aligned=true, approvalId="cpa-001"。
 */
function makeFeedbackRecord(overrides = {}) {
  return {
    timestamp: "2026-07-17T00:00:00.000Z",
    approvalId: "cpa-001",
    chapterId: "1",
    workspaceId: "ws-test",
    action: "accept",
    proxyJudgmentBias: {
      proxyRecommendedSource: "editorial",
      userAcceptedSource: "editorial",
      aligned: true,
    },
    ...overrides,
  };
}

function writeFeedback(workspacePath, feedback) {
  recordProxyApprovalFeedback({ workspacePath, feedback });
}

/**
 * 构造一个 trace JSON 文档，其中 gates[] 包含 v2_final_selected gate，
 * evidence.modelCalls 含给定条目。
 *
 * trace 路径：{workspacePath}/traces/{chapterId}-quality-trace.json
 */
function writeTraceWithModelCalls(workspacePath, chapterId, modelCalls) {
  const traceDoc = {
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
  const tracePath = join(workspacePath, "traces", `${chapterId}-quality-trace.json`);
  writeFileSync(tracePath, JSON.stringify(traceDoc, null, 2) + "\n", "utf-8");
  return tracePath;
}

/** 构造单个 ModelCallEntry fixture。 */
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

// ============================================================================
// aggregateReleaseHealthByRelease
// ============================================================================

test("1. aggregateReleaseHealthByRelease：按 releaseId 过滤 feedback", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    // 写入两个 release 的 approval + feedback
    writeApproval(workspacePath, makeApprovalArtifact({
      approvalId: "cpa-rel1-001", releaseId: "rel-001", chapterId: "1",
    }));
    writeApproval(workspacePath, makeApprovalArtifact({
      approvalId: "cpa-rel2-001", releaseId: "rel-002", chapterId: "2",
    }));

    writeFeedback(workspacePath, makeFeedbackRecord({
      approvalId: "cpa-rel1-001", chapterId: "1",
      proxyJudgmentBias: { proxyRecommendedSource: "editorial", userAcceptedSource: "editorial", aligned: true },
    }));
    writeFeedback(workspacePath, makeFeedbackRecord({
      approvalId: "cpa-rel2-001", chapterId: "2",
      proxyJudgmentBias: { proxyRecommendedSource: "editorial", userAcceptedSource: "raw", aligned: false },
    }));

    const report = aggregateReleaseHealthByRelease(workspacePath, "rel-001");
    assert.equal(report.totalFeedbackRecords, 1, "只应聚合 rel-001 的 feedback");
    assert.equal(report.alignmentStats.aligned, 1);
    assert.equal(report.alignmentStats.misaligned, 0);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("2. aggregateReleaseHealthByRelease：releaseId 无对应 approval -> 空报告（全零 + alignmentRate=0）", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    const report = aggregateReleaseHealthByRelease(workspacePath, "rel-nonexistent");
    assert.equal(report.totalFeedbackRecords, 0);
    assert.equal(report.alignmentStats.aligned, 0);
    assert.equal(report.alignmentStats.misaligned, 0);
    assert.equal(report.alignmentStats.alignmentRate, 0, "无数据时 alignmentRate=0（不是 NaN）");
    assert.equal(report.actionBreakdown.accept, 0);
    assert.equal(report.actionBreakdown.reject, 0);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("3. aggregateReleaseHealthByRelease：多个 approvalId 都归属同一 release -> 全部聚合", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    // 同一 release 下 3 个 approval（不同 chapter）
    writeApproval(workspacePath, makeApprovalArtifact({
      approvalId: "cpa-001", releaseId: "rel-001", chapterId: "1",
    }));
    writeApproval(workspacePath, makeApprovalArtifact({
      approvalId: "cpa-002", releaseId: "rel-001", chapterId: "2",
    }));
    writeApproval(workspacePath, makeApprovalArtifact({
      approvalId: "cpa-003", releaseId: "rel-001", chapterId: "3",
    }));
    // 另一个 release 的 approval（不应被聚合）
    writeApproval(workspacePath, makeApprovalArtifact({
      approvalId: "cpa-other", releaseId: "rel-002", chapterId: "4",
    }));

    writeFeedback(workspacePath, makeFeedbackRecord({ approvalId: "cpa-001", chapterId: "1" }));
    writeFeedback(workspacePath, makeFeedbackRecord({ approvalId: "cpa-002", chapterId: "2" }));
    writeFeedback(workspacePath, makeFeedbackRecord({
      approvalId: "cpa-003", chapterId: "3",
      proxyJudgmentBias: { proxyRecommendedSource: "editorial", userAcceptedSource: "raw", aligned: false },
    }));
    writeFeedback(workspacePath, makeFeedbackRecord({ approvalId: "cpa-other", chapterId: "4" }));

    const report = aggregateReleaseHealthByRelease(workspacePath, "rel-001");
    assert.equal(report.totalFeedbackRecords, 3, "应聚合 rel-001 的 3 条 feedback");
    assert.equal(report.alignmentStats.aligned, 2);
    assert.equal(report.alignmentStats.misaligned, 1);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// aggregateReleaseCostStats
// ============================================================================

test("4. aggregateReleaseCostStats：从 trace 读取 modelCalls", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    writeApproval(workspacePath, makeApprovalArtifact({
      approvalId: "cpa-001", releaseId: "rel-001", chapterId: "1",
    }));
    writeTraceWithModelCalls(workspacePath, "1", [
      makeModelCall({ route: "v2_rawstage2", provider: "claude", durationMs: 1500 }),
      makeModelCall({ route: "v2_amplified", provider: "claude", durationMs: 2000 }),
      makeModelCall({ route: "v2_literary_judge", provider: "gpt", durationMs: 3000 }),
    ]);

    const cost = aggregateReleaseCostStats(workspacePath, "rel-001");
    assert.equal(cost.totalCalls, 3);
    assert.equal(cost.totalDurationMs, 6500);
    assert.equal(cost.averageDurationMs, 6500 / 3);
    assert.equal(cost.totalFailedCalls, 0);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("5. aggregateReleaseCostStats：trace 不存在 -> 全零 CostStats", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    writeApproval(workspacePath, makeApprovalArtifact({
      approvalId: "cpa-001", releaseId: "rel-001", chapterId: "1",
    }));
    // 不写 trace 文件

    const cost = aggregateReleaseCostStats(workspacePath, "rel-001");
    assert.equal(cost.totalCalls, 0);
    assert.equal(cost.totalFailedCalls, 0);
    assert.equal(cost.totalDurationMs, 0);
    assert.equal(cost.averageDurationMs, 0);
    assert.deepEqual(cost.callsByProvider, {});
    assert.deepEqual(cost.callsByRoute, {});
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("6. aggregateReleaseCostStats：多个 chapter 聚合（同 release 下多 chapter）", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    writeApproval(workspacePath, makeApprovalArtifact({
      approvalId: "cpa-001", releaseId: "rel-001", chapterId: "1",
    }));
    writeApproval(workspacePath, makeApprovalArtifact({
      approvalId: "cpa-002", releaseId: "rel-001", chapterId: "2",
    }));
    writeTraceWithModelCalls(workspacePath, "1", [
      makeModelCall({ durationMs: 1000 }),
      makeModelCall({ durationMs: 2000 }),
    ]);
    writeTraceWithModelCalls(workspacePath, "2", [
      makeModelCall({ durationMs: 3000 }),
    ]);

    const cost = aggregateReleaseCostStats(workspacePath, "rel-001");
    assert.equal(cost.totalCalls, 3, "应聚合 chapter 1 + chapter 2 的所有 modelCalls");
    assert.equal(cost.totalDurationMs, 6000);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("7. aggregateReleaseCostStats：callsByProvider 分桶", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    writeApproval(workspacePath, makeApprovalArtifact({
      approvalId: "cpa-001", releaseId: "rel-001", chapterId: "1",
    }));
    writeTraceWithModelCalls(workspacePath, "1", [
      makeModelCall({ provider: "claude", route: "v2_rawstage2" }),
      makeModelCall({ provider: "claude", route: "v2_amplified" }),
      makeModelCall({ provider: "gpt", route: "v2_literary_judge" }),
      makeModelCall({ provider: "gpt", route: "v2_opportunity_judge" }),
      makeModelCall({ provider: "doubao", route: "v2_chinese_calibration" }),
    ]);

    const cost = aggregateReleaseCostStats(workspacePath, "rel-001");
    assert.equal(cost.callsByProvider.claude, 2);
    assert.equal(cost.callsByProvider.gpt, 2);
    assert.equal(cost.callsByProvider.doubao, 1);
    assert.equal(cost.callsByRoute.v2_rawstage2, 1);
    assert.equal(cost.callsByRoute.v2_amplified, 1);
    assert.equal(cost.callsByRoute.v2_literary_judge, 1);
    assert.equal(cost.callsByRoute.v2_opportunity_judge, 1);
    assert.equal(cost.callsByRoute.v2_chinese_calibration, 1);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("8. aggregateReleaseCostStats：failed calls 统计（ModelCallEntry.failed=true）", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    writeApproval(workspacePath, makeApprovalArtifact({
      approvalId: "cpa-001", releaseId: "rel-001", chapterId: "1",
    }));
    writeTraceWithModelCalls(workspacePath, "1", [
      makeModelCall({ failed: false, durationMs: 1000 }),
      makeModelCall({ failed: true, durationMs: 500 }),
      makeModelCall({ failed: true, durationMs: 700 }),
      makeModelCall({ durationMs: 2000 }), // failed 未设置 -> 视为 false
    ]);

    const cost = aggregateReleaseCostStats(workspacePath, "rel-001");
    assert.equal(cost.totalCalls, 4);
    assert.equal(cost.totalFailedCalls, 2, "failed=true 的调用应计入 totalFailedCalls");
    assert.equal(cost.totalDurationMs, 4200, "失败的调用 durationMs 仍应计入 totalDurationMs");
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});
