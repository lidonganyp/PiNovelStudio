/**
 * EVOLUTION-RELEASE-GOVERNANCE-G8 CLI 测试 — evolution:health 子命令
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §8 Phase G8
 * 计划：.trae/documents/g8-health-monitoring-and-retirement-implementation.md §2.7 / §3 Step 9
 *
 * G8 CLI 子命令：
 *   evolution:health --release-id <id> --workspace <path>
 *     打印单个 release 健康报告（status / evidence / decision / costStats / eligibility / suggestions）
 *   evolution:health --all --workspace <path>
 *     打印所有 active release 健康报告
 *   evolution:health --release-id <id> --workspace <path> --apply
 *     执行 auto-hold（幂等：已 held 不重复触发；retired 建议不自动执行）
 *   evolution:health --release-id <id> --workspace <path> --recompute-eligibility
 *     打印 eligibility 重算结果
 *
 * 退出码：0 成功 / 2 参数错误 / 3 release 不存在 / 5 操作失败
 *
 * RED 状态：cmdHealth 尚未实现，CLI dispatch 走 default 分支 → exit 1（"未知子命令：health"），
 * 所有测试因期望 exit 0/2/3 但实际 exit 1 而失败。
 *
 * 边界（READY_LOCAL）：
 * - 不调用模型、不生成章节正文、不提交长期状态
 * - 复用 G8 governance 模块（evaluator / actions / aggregator / eligibility-recomputer）
 * - 不修改 evolution-release-registry / release-pointer-store / chapter-proxy-approval-registry
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createEvolutionReleaseRegistry } from "../dist-test/v2/governance/evolution-release-registry.js";
import { createReleasePointerStore } from "../dist-test/v2/governance/release-pointer-store.js";
import {
  EVOLUTION_RELEASE_SCHEMA_ID,
  EVOLUTION_RELEASE_SCHEMA_VERSION,
} from "../dist-test/v2/governance/evolution-release-types.js";
import { createProxyApprovalRegistry } from "../dist-test/v2/governance/release-proxy-approval-registry.js";
import { computeReleasePayloadHash } from "../dist-test/v2/governance/evolution-release-schema.js";
import { createChapterProxyApprovalRegistry } from "../dist-test/v2/governance/chapter-proxy-approval-registry.js";
import { recordProxyApprovalFeedback } from "../dist-test/v2/governance/chapter-proxy-approval-feedback-recorder.js";
import {
  CHAPTER_PROXY_APPROVAL_SCHEMA_ID,
  CHAPTER_PROXY_APPROVAL_SCHEMA_VERSION,
} from "../dist-test/v2/governance/chapter-proxy-approval-types.js";

// ============================================================================
// helpers
// ============================================================================

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_PATH = join(__dirname, "..", "scripts", "evolution-cli.mjs");
const EXT_ROOT = join(__dirname, "..");

/** 创建临时 evolution root（存放 release manifests）。 */
function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), "evolution-cli-g8-"));
}

/**
 * 创建临时 workspace（存放 chapter-approvals / traces / strategy-policy.json）。
 * 返回 workspacePath（= workspaces/{workspaceId} 目录的绝对路径）。
 */
function makeTempWorkspace(workspaceId = "ws-test") {
  const projectRoot = mkdtempSync(join(tmpdir(), "g8-ws-"));
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(join(workspacePath, "chapter-approvals"), { recursive: true });
  mkdirSync(join(workspacePath, "traces"), { recursive: true });
  return { projectRoot, workspaceId, workspacePath };
}

/** 构造 release manifest fixture。 */
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
    approvalRef: opts.approvalRef ?? null,
    createdAt: "2026-07-17T00:00:00.000Z",
    activatedAt: null,
  };
}

function setupReleases(root, manifests) {
  const releasesDir = join(root, "releases");
  const registry = createEvolutionReleaseRegistry({ releasesDir });
  for (const m of manifests) {
    registry.writeManifest(m);
  }
  return registry;
}

function makeRegistry(root) {
  return createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
}

/** 写入 release 级 stub approval artifact（schema 校验通过）。 */
function writeStubApproval(root, releaseId, approvalId, manifest) {
  const approvalsDir = join(root, "releases", releaseId, "approvals");
  const registry = createProxyApprovalRegistry({ approvalsDir });
  const artifact = {
    schemaId: "pinovel.release-proxy-approval",
    schemaVersion: 1,
    approvalId,
    releaseId,
    releaseManifestHash: computeReleasePayloadHash(manifest),
    reviewerType: "validated_human_proxy",
    reviewerModel: "gpt5.6-sol",
    reviewerModelVersion: "gpt5.6-sol-2026-07",
    promptHash: "stub-prompt-hash",
    inputArtifactHash: "stub-input-hash",
    forwardVerdict: "APPROVE_DEV",
    reverseVerdict: "APPROVE_DEV",
    finalVerdict: "APPROVE_DEV",
    winningSpans: [],
    losingSpans: [],
    risks: [],
    rationale: "stub approval for test",
    decidedAt: "2026-07-17T00:00:00.000Z",
    budgetUsed: { calls: 2, timeoutMs: 300000 },
    changeClass: manifest.changeClass ?? "R2",
    r3SelfApproval: false,
  };
  registry.writeArtifact(artifact);
  return artifact;
}

/**
 * 构造 ChapterProxyApprovalArtifact fixture（章节级代理审批 artifact）。
 * 默认 releaseId="rel-001", chapterId="1", workspaceId="ws-test"。
 */
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

/**
 * 构造 feedback record fixture。
 * 默认 action="accept", aligned=true, approvalId="cpa-001"。
 */
function makeFeedback(overrides = {}) {
  return {
    timestamp: overrides.timestamp ?? "2026-07-17T00:00:00.000Z",
    approvalId: overrides.approvalId ?? "cpa-001",
    chapterId: overrides.chapterId ?? "1",
    workspaceId: overrides.workspaceId ?? "ws-test",
    action: overrides.action ?? "accept",
    proxyJudgmentBias: overrides.proxyJudgmentBias ?? {
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
 * 批量写入 N 条 feedback 记录（alternating aligned/misaligned 模式）。
 * alignedCount 条 aligned + misalignedCount 条 misaligned。
 */
function writeBulkFeedback(workspacePath, approvalId, chapterId, alignedCount, misalignedCount) {
  let idx = 0;
  for (let i = 0; i < alignedCount; i++) {
    writeFeedback(workspacePath, makeFeedback({
      timestamp: `2026-07-17T00:00:${String(idx).padStart(2, "0")}.000Z`,
      approvalId, chapterId,
      proxyJudgmentBias: { proxyRecommendedSource: "editorial", userAcceptedSource: "editorial", aligned: true },
    }));
    idx++;
  }
  for (let i = 0; i < misalignedCount; i++) {
    writeFeedback(workspacePath, makeFeedback({
      timestamp: `2026-07-17T00:01:${String(idx).padStart(2, "0")}.000Z`,
      approvalId, chapterId,
      proxyJudgmentBias: { proxyRecommendedSource: "editorial", userAcceptedSource: "raw", aligned: false },
    }));
    idx++;
  }
}

/** 构造 trace JSON 文档，gates[] 含 v2_final_selected gate，evidence.modelCalls 含给定条目。 */
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

/** 写入 strategy-policy.json（含 retired strategy 以触发 needs_requalify）。 */
function writeStrategyPolicyWithRetired(workspacePath, workspaceId = "ws-test") {
  const storeData = {
    schemaVersion: 1,
    workspaceId,
    partitions: {
      "claude-opus-4.6": {
        "strategy-001": {
          strategyId: "strategy-001",
          modelVersion: "claude-opus-4.6",
          alpha: 1,
          beta: 5,
          sampleCount: 5,
          consecutiveLosses: 3,
          status: "retired",
          statusChangedAt: "2026-07-17T00:00:00.000Z",
          statusReason: "test retirement",
          // P1-4 修复后：filterStrategyReputationsByRelease 需要 evidence[].sourceChapter
          // 与 release 的 chapterId 集合有交集才保留策略；测试场景 chapterId="1"
          evidence: [
            {
              sourceChapter: "1",
              outcome: "loss",
              source: "judge",
              weight: 1,
              timestamp: "2026-07-17T00:00:00.000Z",
            },
          ],
          lastUpdated: "2026-07-17T00:00:00.000Z",
        },
      },
    },
    updatedAt: "2026-07-17T00:00:00.000Z",
  };
  const policyPath = join(workspacePath, "strategy-policy.json");
  writeFileSync(policyPath, JSON.stringify(storeData, null, 2) + "\n", "utf-8");
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
// 1. evolution:health --release-id <id>：打印健康报告
// ============================================================================

test("1. health --release-id：打印健康报告（warning 状态）", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const manifest = makeManifest("rel-001", "active_dev", { approvalRef: "apr-001" });
    setupReleases(root, [manifest]);
    writeStubApproval(root, "rel-001", "apr-001", manifest);

    // chapter-level approval + feedback（3 aligned, 2 misaligned → alignmentRate=0.6 → warning）
    writeChapterApproval(workspacePath, makeChapterApproval({
      approvalId: "cpa-001", releaseId: "rel-001", chapterId: "1",
    }));
    writeBulkFeedback(workspacePath, "cpa-001", "1", 3, 2);

    const result = runCli(
      ["health", "--release-id", "rel-001", "--workspace", workspacePath],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Release Health: rel-001/);
    assert.match(result.stdout, /warning/);
    assert.match(result.stdout, /sampleCount/);
    assert.match(result.stdout, /alignmentRate/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. evolution:health --release-id <unknown>：exit 3
// ============================================================================

test("2. health --release-id <unknown>：release 不存在退出码 3", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const result = runCli(
      ["health", "--release-id", "rel-nonexistent", "--workspace", workspacePath],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 3);
    assert.match(result.stderr, /不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. evolution:health --release-id <id>：无 approval → insufficient_data
// ============================================================================

test("3. health --release-id：无 approval → insufficient_data", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const manifest = makeManifest("rel-001", "active_dev", { approvalRef: "apr-001" });
    setupReleases(root, [manifest]);
    writeStubApproval(root, "rel-001", "apr-001", manifest);
    // 不写 chapter-approval / feedback → sampleCount=0 → insufficient_data

    const result = runCli(
      ["health", "--release-id", "rel-001", "--workspace", workspacePath],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /insufficient_data/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. evolution:health --release-id <id> --apply：auto-hold 执行
// ============================================================================

test("4. health --apply：auto-hold 执行（alignmentRate < 0.4 → held）", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const manifest = makeManifest("rel-001", "active_dev", { approvalRef: "apr-001" });
    setupReleases(root, [manifest]);
    writeStubApproval(root, "rel-001", "apr-001", manifest);

    // chapter-level approval + feedback（1 aligned, 4 misaligned → alignmentRate=0.2 < 0.4 → auto_hold_eligible）
    writeChapterApproval(workspacePath, makeChapterApproval({
      approvalId: "cpa-001", releaseId: "rel-001", chapterId: "1",
    }));
    writeBulkFeedback(workspacePath, "cpa-001", "1", 1, 4);

    const result = runCli(
      ["health", "--release-id", "rel-001", "--workspace", workspacePath, "--apply"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /auto_hold_eligible|held/);

    // manifest 状态应迁移到 held
    const registry = makeRegistry(root);
    const updated = registry.loadManifest("rel-001");
    assert.equal(updated.status, "held", "manifest status 应为 held");

    // 状态事件应包含 held 迁移
    const events = registry.loadStateEvents("rel-001");
    assert.ok(events.some((e) => e.toStatus === "held"), "应有 held 状态事件");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. evolution:health --release-id <id> --apply：已 held → 不重复触发
// ============================================================================

test("5. health --apply：已 held → 不重复触发（幂等）", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const manifest = makeManifest("rel-001", "held", { approvalRef: "apr-001" });
    setupReleases(root, [manifest]);
    writeStubApproval(root, "rel-001", "apr-001", manifest);

    // chapter-level approval + feedback（1 aligned, 4 misaligned → alignmentRate=0.2）
    writeChapterApproval(workspacePath, makeChapterApproval({
      approvalId: "cpa-001", releaseId: "rel-001", chapterId: "1",
    }));
    writeBulkFeedback(workspacePath, "cpa-001", "1", 1, 4);

    const eventsBefore = makeRegistry(root).loadStateEvents("rel-001").length;

    const result = runCli(
      ["health", "--release-id", "rel-001", "--workspace", workspacePath, "--apply"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /already_held|held/);

    // manifest 状态仍为 held（不变）
    const registry = makeRegistry(root);
    const updated = registry.loadManifest("rel-001");
    assert.equal(updated.status, "held");

    // 不应有新的状态事件
    const eventsAfter = registry.loadStateEvents("rel-001").length;
    assert.equal(eventsAfter, eventsBefore, "不应写入新的状态事件（幂等）");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 6. evolution:health --release-id <id> --apply：shouldAutoHold=false → 不执行
// ============================================================================

test("6. health --apply：shouldAutoHold=false → 不执行（healthy 状态）", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const manifest = makeManifest("rel-001", "active_dev", { approvalRef: "apr-001" });
    setupReleases(root, [manifest]);
    writeStubApproval(root, "rel-001", "apr-001", manifest);

    // chapter-level approval + feedback（4 aligned, 1 misaligned → alignmentRate=0.8 → healthy）
    writeChapterApproval(workspacePath, makeChapterApproval({
      approvalId: "cpa-001", releaseId: "rel-001", chapterId: "1",
    }));
    writeBulkFeedback(workspacePath, "cpa-001", "1", 4, 1);

    const result = runCli(
      ["health", "--release-id", "rel-001", "--workspace", workspacePath, "--apply"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /healthy|not_eligible/);

    // manifest 状态应仍为 active_dev（未迁移）
    const registry = makeRegistry(root);
    const updated = registry.loadManifest("rel-001");
    assert.equal(updated.status, "active_dev", "manifest status 不应变（shouldAutoHold=false）");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 7. evolution:health --all：打印所有 active release
// ============================================================================

test("7. health --all：打印所有 active release（active_dev / candidate_prod），跳过 held/draft", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const m1 = makeManifest("rel-001", "active_dev", { approvalRef: "apr-001" });
    const m2 = makeManifest("rel-002", "candidate_prod", { approvalRef: "apr-002" });
    const m3 = makeManifest("rel-003", "held", { approvalRef: "apr-003" });
    const m4 = makeManifest("rel-004", "draft");
    setupReleases(root, [m1, m2, m3, m4]);
    writeStubApproval(root, "rel-001", "apr-001", m1);
    writeStubApproval(root, "rel-002", "apr-002", m2);
    writeStubApproval(root, "rel-003", "apr-003", m3);

    // 为 rel-001 / rel-002 写入 chapter approval + feedback
    writeChapterApproval(workspacePath, makeChapterApproval({
      approvalId: "cpa-001", releaseId: "rel-001", chapterId: "1",
    }));
    writeBulkFeedback(workspacePath, "cpa-001", "1", 3, 2);

    writeChapterApproval(workspacePath, makeChapterApproval({
      approvalId: "cpa-002", releaseId: "rel-002", chapterId: "2",
    }));
    writeBulkFeedback(workspacePath, "cpa-002", "2", 4, 1);

    const result = runCli(
      ["health", "--all", "--workspace", workspacePath],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    // 应打印 active release
    assert.match(result.stdout, /rel-001/);
    assert.match(result.stdout, /rel-002/);
    // 不应打印非 active release
    assert.doesNotMatch(result.stdout, /rel-003/);
    assert.doesNotMatch(result.stdout, /rel-004/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 8. evolution:health --release-id <id> --recompute-eligibility：打印 eligibility
// ============================================================================

test("8. health --recompute-eligibility：打印 eligibility（needs_requalify）", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const manifest = makeManifest("rel-001", "active_dev", { approvalRef: "apr-001" });
    setupReleases(root, [manifest]);
    writeStubApproval(root, "rel-001", "apr-001", manifest);

    // chapter-level approval + feedback（3 aligned, 2 misaligned → alignmentRate=0.6）
    writeChapterApproval(workspacePath, makeChapterApproval({
      approvalId: "cpa-001", releaseId: "rel-001", chapterId: "1",
    }));
    writeBulkFeedback(workspacePath, "cpa-001", "1", 3, 2);

    // strategy-policy.json 含 retired strategy → needs_requalify
    writeStrategyPolicyWithRetired(workspacePath);

    const result = runCli(
      ["health", "--release-id", "rel-001", "--workspace", workspacePath, "--recompute-eligibility"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Eligibility/);
    assert.match(result.stdout, /needs_requalify/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 9. evolution:health：无参数 → exit 2
// ============================================================================

test("9. health：无参数退出码 2", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const result = runCli(
      ["health", "--workspace", workspacePath],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /release-id|--all/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 10. evolution:health --release-id <id>：retired_suggestion → 打印建议（不执行）
// ============================================================================

test("10. health --release-id：retired_suggestion → 打印建议（不执行 retired）", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const manifest = makeManifest("rel-001", "active_dev", { approvalRef: "apr-001" });
    setupReleases(root, [manifest]);
    writeStubApproval(root, "rel-001", "apr-001", manifest);

    // 15 条 feedback：前 5 aligned，后 10 条中 2 aligned + 8 misaligned
    // overall alignmentRate = 7/15 ≈ 0.467 (>= 0.4，不触发 auto_hold)
    // longTermAlignmentRate (last 10) = 2/10 = 0.2 (< 0.3 → retired_suggestion)
    writeChapterApproval(workspacePath, makeChapterApproval({
      approvalId: "cpa-001", releaseId: "rel-001", chapterId: "1",
    }));
    // 先写 5 条 aligned（旧记录，在 longTerm 窗口外）
    for (let i = 0; i < 5; i++) {
      writeFeedback(workspacePath, makeFeedback({
        timestamp: `2026-07-17T00:00:${String(i).padStart(2, "0")}.000Z`,
        approvalId: "cpa-001", chapterId: "1",
        proxyJudgmentBias: { proxyRecommendedSource: "editorial", userAcceptedSource: "editorial", aligned: true },
      }));
    }
    // 再写 10 条（2 aligned + 8 misaligned，在 longTerm 窗口内）
    for (let i = 0; i < 2; i++) {
      writeFeedback(workspacePath, makeFeedback({
        timestamp: `2026-07-17T00:01:${String(i).padStart(2, "0")}.000Z`,
        approvalId: "cpa-001", chapterId: "1",
        proxyJudgmentBias: { proxyRecommendedSource: "editorial", userAcceptedSource: "editorial", aligned: true },
      }));
    }
    for (let i = 0; i < 8; i++) {
      writeFeedback(workspacePath, makeFeedback({
        timestamp: `2026-07-17T00:02:${String(i).padStart(2, "0")}.000Z`,
        approvalId: "cpa-001", chapterId: "1",
        proxyJudgmentBias: { proxyRecommendedSource: "editorial", userAcceptedSource: "raw", aligned: false },
      }));
    }

    const result = runCli(
      ["health", "--release-id", "rel-001", "--workspace", workspacePath],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /retired_suggestion/);
    // 应打印手动执行命令
    assert.match(result.stdout, /evolution:promote --target retired/);

    // manifest 状态应仍为 active_dev（retired 不自动执行）
    const registry = makeRegistry(root);
    const updated = registry.loadManifest("rel-001");
    assert.equal(updated.status, "active_dev", "retired 不应自动执行");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 11. evolution:health --release-id <id>：costStats 打印
// ============================================================================

test("11. health --release-id：costStats 打印（从 trace 聚合 modelCalls）", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const manifest = makeManifest("rel-001", "active_dev", { approvalRef: "apr-001" });
    setupReleases(root, [manifest]);
    writeStubApproval(root, "rel-001", "apr-001", manifest);

    // chapter-level approval + feedback（3 aligned, 2 misaligned → alignmentRate=0.6 → warning）
    writeChapterApproval(workspacePath, makeChapterApproval({
      approvalId: "cpa-001", releaseId: "rel-001", chapterId: "1",
    }));
    writeBulkFeedback(workspacePath, "cpa-001", "1", 3, 2);

    // trace 含 modelCalls
    writeTraceWithModelCalls(workspacePath, "1", [
      { route: "v2_rawstage2", kind: "generation", model: "claude-opus-4.6", durationMs: 1500, provider: "claude" },
      { route: "v2_amplified", kind: "generation", model: "claude-opus-4.6", durationMs: 2000, provider: "claude" },
      { route: "v2_literary_judge", kind: "judge", model: "gpt-5.6-sol", durationMs: 3000, provider: "gpt" },
    ]);

    const result = runCli(
      ["health", "--release-id", "rel-001", "--workspace", workspacePath],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Cost Stats/);
    assert.match(result.stdout, /totalCalls/);
    assert.match(result.stdout, /3/); // totalCalls=3
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 12. evolution:health --release-id <id>：滞回提示打印
// ============================================================================

test("12. health --release-id：滞回提示打印（已 held 且 alignmentRate < recoveryAlignmentRate）", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const manifest = makeManifest("rel-001", "held", { approvalRef: "apr-001" });
    setupReleases(root, [manifest]);
    writeStubApproval(root, "rel-001", "apr-001", manifest);

    // chapter-level approval + feedback（3 aligned, 2 misaligned → alignmentRate=0.6 < 0.8 → 滞回提示）
    writeChapterApproval(workspacePath, makeChapterApproval({
      approvalId: "cpa-001", releaseId: "rel-001", chapterId: "1",
    }));
    writeBulkFeedback(workspacePath, "cpa-001", "1", 3, 2);

    const result = runCli(
      ["health", "--release-id", "rel-001", "--workspace", workspacePath],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    // 应打印滞回提示（overrideHint 提示 recoveryAlignmentRate 或 --force）
    assert.match(result.stdout, /recoveryAlignmentRate|override|force/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});
