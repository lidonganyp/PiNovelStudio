/**
 * EVOLUTION-RELEASE-GOVERNANCE-G7 P0-3 — 代理审批稿 pending checkpoint 接通测试
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 line 117-122 / §12.2
 * 任务卡：P0-EXTENSION-WORKTREE-RECOVERY-1 Step 5
 *
 * P0-3 审批闭环接通（2026-07-17）：
 * executeChapterProxyApproval 在 finalStatus=PROXY_APPROVED 且调用方提供 draftCheckpoint 时，
 * 调用 saveProxyApprovedDraft 把 pending draft 落盘到 workspaces/{id}/chapter-approvals/，
 * 使 commitAndSave 守护（hasPendingProxyDraft）阻断正式章节提交，直到用户通过 proxy_finalization
 * accept 清除 pending。
 *
 * 本测试覆盖任务卡 Step 5 的 7 个必需用例：
 * 1. PROXY_APPROVED + draftCheckpoint → 成功保存 pending draft（draftSaved=true）
 * 2. HOLD_FOR_REGENERATION → 不保存 draft（draftSaved=undefined）
 * 3. 未提供 draftCheckpoint → 行为零变化（draftSaved=undefined，与 P0-3 前一致）
 * 4. 保存失败 → draftSaved=false + draftError（不静默继续）
 * 5. pending sentinel 创建后 hasPendingProxyDraft=true（commitAndSave 被阻断）
 * 6. clearPendingProxyDraft 后 hasPendingProxyDraft=false（用户确认后可正式提交）
 * 7. 不写正式 chapters/ 目录，不提前提交长期状态（draft 只落 chapter-approvals/）
 *
 * 额外覆盖：
 * 8. runner runStubChapterProxyReview 透传 draftCheckpoint → draftSaved=true（端到端）
 * 9. runner 未提供 draftCheckpoint → draftSaved=undefined（向后兼容）
 *
 * 边界（READY_LOCAL）：
 * - 不调用真实模型、不联网
 * - 不写正式 chapters/ 目录、不提交长期状态
 * - 仅写临时目录下的 chapter-approvals/（隔离）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createStubChapterProxyApprovalCaller,
} from "../dist-test/v2/governance/chapter-proxy-approval-caller.js";
import {
  executeChapterProxyApproval,
} from "../dist-test/v2/governance/chapter-proxy-approval-executor.js";
import {
  runStubChapterProxyReview,
} from "../dist-test/v2/governance/chapter-proxy-approval-runner.js";
import { createChapterProxyApprovalRegistry } from "../dist-test/v2/governance/chapter-proxy-approval-registry.js";
import {
  hasPendingProxyDraft,
  clearPendingProxyDraft,
  resolveDraftCheckpointDir,
  loadProxyApprovedDraft,
} from "../dist-test/v2/governance/chapter-proxy-approval-draft-checkpoint.js";
// P0-3 fail-closed（核验结论第二轮 2026-07-17）：
// 直接测试 runProxyApprovalStage 的 shouldHardBlock / shouldSkipCommit 决策，
// 覆盖 HOLD_FOR_REGENERATION 和 draftSaved=false 必须 fail-closed 的要求。
// orchestrator-proxy-approval.ts 属于 v2/core/（生产闭包），只在 dist/ 编译。
import { runProxyApprovalStage } from "../dist/v2/core/orchestrator-proxy-approval.js";

// ============================================================================
// helpers
// ============================================================================

function makeCandidates() {
  return [
    {
      candidateId: "cand-raw-001",
      candidateKind: "raw",
      text: "raw candidate text for chapter 1",
      spans: [{ id: "span-raw-1", text: "raw winning span", side: "candidate" }],
    },
    {
      candidateId: "cand-edit-001",
      candidateKind: "editorial",
      text: "editorial candidate text for chapter 1",
      spans: [{ id: "span-edit-1", text: "editorial winning span", side: "candidate" }],
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

const DRAFT_FINAL_TEXT = "这是代理审批稿正文内容，来自编排器选定的 finalText。";

// ============================================================================
// 1. PROXY_APPROVED + draftCheckpoint → 成功保存 pending draft
// ============================================================================

test("P0-3 #1: PROXY_APPROVED + draftCheckpoint → draftSaved=true，draft 文件 + sentinel 落盘", async () => {
  const root = mkdtempSync(join(tmpdir(), "p0-3-approve-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const workspacePath = join(root, "workspace-ws-1");
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
      draftCheckpoint: {
        workspacePath,
        finalText: DRAFT_FINAL_TEXT,
      },
    });

    // finalStatus 与 draftSaved
    assert.equal(result.finalStatus, "PROXY_APPROVED");
    assert.equal(result.canDeliverProxyDraft, true);
    assert.equal(result.draftSaved, true, "PROXY_APPROVED + draftCheckpoint 应 draftSaved=true");
    assert.equal(result.draftError, undefined, "成功时 draftError 应为 undefined");

    // draft 文件落盘到 chapter-approvals/ 隔离目录
    const draftDir = resolveDraftCheckpointDir(workspacePath);
    const draftFiles = readdirSync(draftDir);
    const approvalId = result.artifact.approvalId;
    assert.ok(
      draftFiles.includes(`${approvalId}.draft.md`),
      "draft 正文文件应落盘到 chapter-approvals/",
    );
    assert.ok(
      draftFiles.includes(`${approvalId}.draft.meta.json`),
      "draft 元数据文件应落盘到 chapter-approvals/",
    );
    assert.ok(
      draftFiles.includes("ch-1.pending.json"),
      "pending sentinel 应落盘到 chapter-approvals/",
    );

    // draft 正文内容正确
    const draftText = readFileSync(join(draftDir, `${approvalId}.draft.md`), "utf-8");
    assert.equal(draftText, DRAFT_FINAL_TEXT, "draft 正文内容应与 finalText 一致");

    // loadProxyApprovedDraft 可读回完整元数据
    const loaded = loadProxyApprovedDraft(workspacePath, approvalId);
    assert.ok(loaded, "loadProxyApprovedDraft 应能读回 draft");
    assert.equal(loaded.approvalId, approvalId);
    assert.equal(loaded.chapterId, "ch-1");
    assert.equal(loaded.candidateId, "cand-edit-001");
    assert.equal(loaded.selectedSource, "editorial");
    assert.equal(loaded.finalText, DRAFT_FINAL_TEXT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. HOLD_FOR_REGENERATION → 不保存 draft
// ============================================================================

test("P0-3 #2: HOLD_FOR_REGENERATION + draftCheckpoint → draftSaved=undefined，不落盘 draft/sentinel", async () => {
  const root = mkdtempSync(join(tmpdir(), "p0-3-hold-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const workspacePath = join(root, "workspace-ws-1");
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
      draftCheckpoint: {
        workspacePath,
        finalText: DRAFT_FINAL_TEXT,
      },
    });

    assert.equal(result.finalStatus, "HOLD_FOR_REGENERATION");
    assert.equal(result.canDeliverProxyDraft, false);
    // HOLD 路径不调用 saveProxyApprovedDraft：draftSaved/draftError 均为 undefined
    assert.equal(result.draftSaved, undefined, "HOLD_FOR_REGENERATION 不应保存 draft");
    assert.equal(result.draftError, undefined);

    // chapter-approvals/ 目录不应被创建（无 draft 落盘）
    const draftDir = resolveDraftCheckpointDir(workspacePath);
    assert.ok(!existsSync(draftDir), "HOLD 路径不应创建 chapter-approvals/ 目录");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. 未提供 draftCheckpoint → 行为零变化（向后兼容）
// ============================================================================

test("P0-3 #3: 未提供 draftCheckpoint → draftSaved=undefined，行为与 P0-3 前一致", async () => {
  const root = mkdtempSync(join(tmpdir(), "p0-3-no-cp-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const workspacePath = join(root, "workspace-ws-1");
    const input = makePacketInput();
    const caller = createStubChapterProxyApprovalCaller(makeStubCallerOptions());

    // 不传 draftCheckpoint（向后兼容：现有调用方行为零变化）
    const result = await executeChapterProxyApproval({
      packetInput: input,
      caller,
      registry,
      promptHash: "sha256-prompt-abc",
      modelVersion: "gpt5.6-sol-2026-07",
      budget: { maxCalls: 2, timeoutMs: 60000 },
      anonymousSeed: 42,
    });

    // PROXY_APPROVED 但不落盘 draft
    assert.equal(result.finalStatus, "PROXY_APPROVED");
    assert.equal(result.canDeliverProxyDraft, true);
    assert.equal(result.draftSaved, undefined, "未提供 draftCheckpoint 时 draftSaved 应为 undefined");
    assert.equal(result.draftError, undefined);

    // 不应创建 chapter-approvals/ 目录
    const draftDir = resolveDraftCheckpointDir(workspacePath);
    assert.ok(!existsSync(draftDir), "未提供 draftCheckpoint 不应创建 chapter-approvals/");

    // artifact 仍正常写入 registry
    const loaded = registry.loadArtifact(result.artifact.approvalId);
    assert.ok(loaded, "artifact 仍应写入 registry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. 保存失败 → draftSaved=false + draftError（不静默继续）
// ============================================================================

test("P0-3 #4: saveProxyApprovedDraft 失败 → draftSaved=false + draftError，artifact 仍写入 registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "p0-3-fail-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    // 构造一个无法创建子目录的 workspacePath：在该路径上先创建一个文件，
    // 使 ensureDir/mkdirSync 因父路径是文件而非目录失败（ENOTDIR）。
    const blockerFilePath = join(root, "blocker-file");
    writeFileSync(blockerFilePath, "I am a file, not a directory");
    const workspacePath = blockerFilePath; // chapter-approvals/ 无法在此创建

    const input = makePacketInput();
    const caller = createStubChapterProxyApprovalCaller(makeStubCallerOptions());

    const result = await executeChapterProxyApproval({
      packetInput: input,
      caller,
      registry,
      promptHash: "sha256-prompt-abc",
      modelVersion: "gpt5.6-sol-2026-07",
      budget: { maxCalls: 2, timeoutMs: 60000 },
      draftCheckpoint: {
        workspacePath,
        finalText: DRAFT_FINAL_TEXT,
      },
    });

    // PROXY_APPROVED 但 draft 落盘失败
    assert.equal(result.finalStatus, "PROXY_APPROVED");
    assert.equal(result.canDeliverProxyDraft, true);
    assert.equal(result.draftSaved, false, "落盘失败应返回 draftSaved=false");
    assert.ok(
      typeof result.draftError === "string" && result.draftError.length > 0,
      "落盘失败应返回非空 draftError",
    );

    // artifact 仍写入 registry（不可回滚，保留审批证据）
    const loaded = registry.loadArtifact(result.artifact.approvalId);
    assert.ok(loaded, "落盘失败时 artifact 仍应写入 registry（不可回滚）");
    assert.equal(loaded.finalStatus, "PROXY_APPROVED");

    // 无 pending sentinel（落盘失败未创建 sentinel）
    // 注意：workspacePath 是文件，hasPendingProxyDraft 读 sentinel 路径不存在 → false
    assert.equal(
      hasPendingProxyDraft(workspacePath, "ch-1"),
      false,
      "落盘失败不应创建 pending sentinel",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. pending sentinel 创建后 hasPendingProxyDraft=true（commitAndSave 被阻断）
// ============================================================================

test("P0-3 #5: PROXY_APPROVED + draftCheckpoint 后 hasPendingProxyDraft=true（commitAndSave 阻断）", async () => {
  const root = mkdtempSync(join(tmpdir(), "p0-3-block-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const workspacePath = join(root, "workspace-ws-1");
    const input = makePacketInput();
    const caller = createStubChapterProxyApprovalCaller(makeStubCallerOptions());

    // 落盘前：无 pending
    assert.equal(
      hasPendingProxyDraft(workspacePath, "ch-1"),
      false,
      "落盘前 hasPendingProxyDraft 应为 false",
    );

    await executeChapterProxyApproval({
      packetInput: input,
      caller,
      registry,
      promptHash: "sha256-prompt-abc",
      modelVersion: "gpt5.6-sol-2026-07",
      budget: { maxCalls: 2, timeoutMs: 60000 },
      draftCheckpoint: {
        workspacePath,
        finalText: DRAFT_FINAL_TEXT,
      },
    });

    // 落盘后：hasPendingProxyDraft=true → commitAndSave 守护阻断正式章节提交
    assert.equal(
      hasPendingProxyDraft(workspacePath, "ch-1"),
      true,
      "落盘后 hasPendingProxyDraft 应为 true（commitAndSave 应被阻断）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 6. clearPendingProxyDraft 后 hasPendingProxyDraft=false（用户确认后可正式提交）
// ============================================================================

test("P0-3 #6: clearPendingProxyDraft 后 hasPendingProxyDraft=false（用户确认后可正式提交）", async () => {
  const root = mkdtempSync(join(tmpdir(), "p0-3-clear-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const workspacePath = join(root, "workspace-ws-1");
    const input = makePacketInput();
    const caller = createStubChapterProxyApprovalCaller(makeStubCallerOptions());

    // 1. 落盘 pending draft
    const result = await executeChapterProxyApproval({
      packetInput: input,
      caller,
      registry,
      promptHash: "sha256-prompt-abc",
      modelVersion: "gpt5.6-sol-2026-07",
      budget: { maxCalls: 2, timeoutMs: 60000 },
      draftCheckpoint: {
        workspacePath,
        finalText: DRAFT_FINAL_TEXT,
      },
    });
    assert.equal(result.draftSaved, true);
    assert.equal(hasPendingProxyDraft(workspacePath, "ch-1"), true, "落盘后应阻断");

    // 2. 模拟用户通过 proxy_finalization accept → clearPendingProxyDraft
    clearPendingProxyDraft(workspacePath, "ch-1");

    // 3. 清除后 hasPendingProxyDraft=false → commitAndSave 恢复正常
    assert.equal(
      hasPendingProxyDraft(workspacePath, "ch-1"),
      false,
      "clearPendingProxyDraft 后 hasPendingProxyDraft 应为 false（可正式提交）",
    );

    // 4. draft 文件仍保留（审计痕迹，clear 只删 sentinel 不删 draft）
    const draftDir = resolveDraftCheckpointDir(workspacePath);
    const approvalId = result.artifact.approvalId;
    assert.ok(
      existsSync(join(draftDir, `${approvalId}.draft.md`)),
      "clear 后 draft 正文文件应保留（审计痕迹）",
    );
    assert.ok(
      !existsSync(join(draftDir, "ch-1.pending.json")),
      "clear 后 pending sentinel 应被删除",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 7. 不写正式 chapters/ 目录，不提前提交长期状态
// ============================================================================

test("P0-3 #7: draft 只落 chapter-approvals/，不写正式 chapters/，不提交长期状态", async () => {
  const root = mkdtempSync(join(tmpdir(), "p0-3-nochapters-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const workspacePath = join(root, "workspace-ws-1");
    const input = makePacketInput();
    const caller = createStubChapterProxyApprovalCaller(makeStubCallerOptions());

    await executeChapterProxyApproval({
      packetInput: input,
      caller,
      registry,
      promptHash: "sha256-prompt-abc",
      modelVersion: "gpt5.6-sol-2026-07",
      budget: { maxCalls: 2, timeoutMs: 60000 },
      draftCheckpoint: {
        workspacePath,
        finalText: DRAFT_FINAL_TEXT,
      },
    });

    // draft 落盘到 chapter-approvals/（隔离目录）
    const draftDir = resolveDraftCheckpointDir(workspacePath);
    assert.ok(existsSync(draftDir), "chapter-approvals/ 应被创建");

    // 不写正式 chapters/ 目录
    const chaptersDir = join(workspacePath, "chapters");
    assert.ok(!existsSync(chaptersDir), "不应创建正式 chapters/ 目录");

    // 不写 narrative-state-store.json（不提交长期状态）
    const stateStore = join(workspacePath, "narrative-state-store.json");
    assert.ok(!existsSync(stateStore), "不应写 narrative-state-store.json（不提交长期状态）");

    // workspace 下只有 chapter-approvals/，无其他产物
    const workspaceEntries = readdirSync(workspacePath);
    assert.deepEqual(
      workspaceEntries,
      ["chapter-approvals"],
      "workspace 下应只有 chapter-approvals/，无其他产物",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 8. runner runStubChapterProxyReview 透传 draftCheckpoint → draftSaved=true
// ============================================================================

test("P0-3 #8: runStubChapterProxyReview 透传 draftCheckpoint → draftSaved=true（端到端）", async () => {
  const root = mkdtempSync(join(tmpdir(), "p0-3-runner-cp-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const workspacePath = join(root, "workspace-ws-1");
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
      draftCheckpoint: {
        workspacePath,
        finalText: DRAFT_FINAL_TEXT,
      },
    });

    assert.equal(result.finalStatus, "PROXY_APPROVED");
    assert.equal(result.draftSaved, true, "runner 透传 draftCheckpoint 应 draftSaved=true");
    assert.equal(hasPendingProxyDraft(workspacePath, "ch-1"), true, "runner 落盘后应阻断 commitAndSave");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 9. runner 未提供 draftCheckpoint → draftSaved=undefined（向后兼容）
// ============================================================================

test("P0-3 #9: runStubChapterProxyReview 未提供 draftCheckpoint → draftSaved=undefined（向后兼容）", async () => {
  const root = mkdtempSync(join(tmpdir(), "p0-3-runner-no-cp-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const workspacePath = join(root, "workspace-ws-1");
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
      // 不传 draftCheckpoint
    });

    assert.equal(result.finalStatus, "PROXY_APPROVED");
    assert.equal(result.draftSaved, undefined, "未传 draftCheckpoint 时 draftSaved 应为 undefined");
    assert.equal(hasPendingProxyDraft(workspacePath, "ch-1"), false, "未传 draftCheckpoint 不应阻断");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// P0-3 fail-closed（核验结论第二轮 2026-07-17）
//
// 真相源：docs/evolution-release-governance-development-plan.md §6.3 line 117-122
// 完成定义："用户确认前不写正式章节"。
//
// 旧实现（fail-open）：
// - shouldSkipCommit = (finalStatus === "PROXY_APPROVED" && draftSaved === true)
// - HOLD_FOR_REGENERATION → shouldSkipCommit=false → 继续 commitAndSave → 写正式章节
// - PROXY_APPROVED + draftSaved=false → shouldSkipCommit=false → 继续 commitAndSave → 写正式章节
//
// 问题：HOLD_FOR_REGENERATION 意味着代理审批要求重新生成，不应交付当前正文；
//       draftSaved=false 意味着用户没有 pending draft 可 review，直接 commit 会绕过用户确认。
//       两者都违反"用户确认前不写正式章节"的完成定义。
//
// 修复（fail-closed）：
// - ProxyApprovalOutcome 新增 shouldHardBlock / hardBlockReason
// - HOLD_FOR_REGENERATION → shouldHardBlock=true（hard block，不写正式章节）
// - PROXY_APPROVED + draftSaved=false → shouldHardBlock=true（hard block，落盘失败不能继续）
// - PROXY_APPROVED + draftSaved=true → shouldHardBlock=false, shouldSkipCommit=true（pending 路径，不变）
// - 编排器在 commitAndSave 前检查 shouldHardBlock → this.hardBlock()
// ============================================================================

/**
 * 构造合法授权卡 JSON（cardType=real_gpt56sol，未过期，覆盖 rel-001，预算充足）。
 * 用于 runProxyApprovalStage 测试：提供 authorizationCardPath + callerOverride 走 real runner 路径。
 */
function makeValidAuthCardJson(overrides = {}) {
  const futureIso = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const pastIso = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  return {
    schemaId: "pinovel.evolution-authorization-card",
    schemaVersion: 1,
    cardId: "card-test-001",
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
 * 构造最小 UnifiedOrchestratorInput 子集，仅包含 runProxyApprovalStage 读取的字段。
 * 运行时类型擦除：.mjs 测试不经过 tsc，只需字段匹配即可。
 *
 * 注意 spread 顺序：proxyApprovalOptions 必须单独合并（overrides.proxyApprovalOptions
 * 只含增量字段如 authorizationCardPath/callerOverride），不能让外层 ...overrides 覆盖掉
 * budget/modelVersion/promptHash/releaseId 等基线字段。
 */
function makeMinimalProxyApprovalInput(root, overrides = {}) {
  const {
    proxyApprovalOptions: proxyOverrides = {},
    ...restOverrides
  } = overrides;
  return {
    enableProxyApproval: true,
    projectRoot: root,
    workspaceId: "ws-1",
    chapterId: "ch-1",
    seed: 0,
    proxyApprovalOptions: {
      releaseId: "rel-001",
      budget: { maxCalls: 2, timeoutMs: 60000 },
      modelVersion: "gpt5.6-sol-2026-07",
      promptHash: "sha256-prompt-abc",
      ...proxyOverrides,
    },
    ...restOverrides,
  };
}

// ============================================================================
// 10. runProxyApprovalStage HOLD_FOR_REGENERATION → shouldHardBlock=true（fail-closed）
// ============================================================================

test("P0-3 #10: runProxyApprovalStage HOLD_FOR_REGENERATION → shouldHardBlock=true, shouldSkipCommit=false（fail-closed）", async () => {
  const root = mkdtempSync(join(tmpdir(), "p0-3-stage-hold-"));
  try {
    // 隔离的 registry（避免污染 workspace 路径）
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    // 合法授权卡（real runner 需要）
    const cardPath = join(root, "auth-card.json");
    writeFileSync(cardPath, JSON.stringify(makeValidAuthCardJson()), "utf-8");
    // stub caller 返回 HOLD_FOR_REGENERATION（不调用真实模型）
    const callerOverride = createStubChapterProxyApprovalCaller({
      forwardVerdict: "HOLD_FOR_REGENERATION",
      reverseVerdict: "HOLD_FOR_REGENERATION",
      recommendedCandidateId: "cand-edit-001",
      recommendedSource: "editorial",
      holdReason: "candidates below raw baseline",
      modelVersion: "gpt5.6-sol-2026-07",
    });

    const input = makeMinimalProxyApprovalInput(root, {
      proxyApprovalOptions: {
        authorizationCardPath: cardPath,
        callerOverride,
        _registryOverride: registry,
      },
    });
    const rawCandidate = { id: "cand-raw-001", text: "raw candidate text" };
    const stageResults = {};

    const outcome = await runProxyApprovalStage(
      input, rawCandidate, "cand-edit-001", "editorial", "editorial final text", stageResults,
    );

    assert.equal(outcome.ran, true, "enableProxyApproval=true + editorial → 应执行代理审批");
    assert.equal(outcome.finalStatus, "HOLD_FOR_REGENERATION");
    // fail-closed：HOLD_FOR_REGENERATION 必须 hard block
    assert.equal(outcome.shouldHardBlock, true,
      "HOLD_FOR_REGENERATION 必须 shouldHardBlock=true（不能继续 commitAndSave 写正式章节）");
    assert.equal(outcome.shouldSkipCommit, false,
      "HOLD_FOR_REGENERATION 不应 shouldSkipCommit=true（pending 路径只属于 PROXY_APPROVED）");
    assert.ok(
      typeof outcome.hardBlockReason === "string" && outcome.hardBlockReason.length > 0,
      "shouldHardBlock=true 时必须给出 hardBlockReason",
    );
    // stageResults.proxyApproval 也应记录 shouldHardBlock
    assert.equal(stageResults.proxyApproval?.shouldHardBlock, true,
      "stageResults.proxyApproval.shouldHardBlock 应同步记录");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 11. runProxyApprovalStage PROXY_APPROVED + draftSaved=false → shouldHardBlock=true（fail-closed）
// ============================================================================

test("P0-3 #11: runProxyApprovalStage PROXY_APPROVED + draftSaved=false → shouldHardBlock=true（fail-closed，落盘失败不能继续 commit）", async () => {
  const root = mkdtempSync(join(tmpdir(), "p0-3-stage-draftfail-"));
  try {
    // 隔离的 registry（用 _registryOverride，避免 registry 创建因 workspacePath 是文件而失败）
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const cardPath = join(root, "auth-card.json");
    writeFileSync(cardPath, JSON.stringify(makeValidAuthCardJson()), "utf-8");
    // stub caller 返回 PROXY_APPROVED（审批通过，但落盘会失败）
    const callerOverride = createStubChapterProxyApprovalCaller({
      forwardVerdict: "PROXY_APPROVED",
      reverseVerdict: "PROXY_APPROVED",
      recommendedCandidateId: "cand-edit-001",
      recommendedSource: "editorial",
      modelVersion: "gpt5.6-sol-2026-07",
    });

    // 构造 workspacePath 为文件（使 saveProxyApprovedDraft 创建 chapter-approvals/ 失败）：
    // input.projectRoot=root, workspaceId="ws-1" → workspacePath=join(root, "workspaces", "ws-1")
    // 在 root/workspaces/ 下创建一个名为 "ws-1" 的文件（不是目录）
    mkdirSync(join(root, "workspaces"), { recursive: true });
    writeFileSync(join(root, "workspaces", "ws-1"), "I am a file, not a directory", "utf-8");

    const input = makeMinimalProxyApprovalInput(root, {
      proxyApprovalOptions: {
        authorizationCardPath: cardPath,
        callerOverride,
        _registryOverride: registry,
      },
    });
    const rawCandidate = { id: "cand-raw-001", text: "raw candidate text" };
    const stageResults = {};

    const outcome = await runProxyApprovalStage(
      input, rawCandidate, "cand-edit-001", "editorial", "editorial final text", stageResults,
    );

    assert.equal(outcome.ran, true);
    assert.equal(outcome.finalStatus, "PROXY_APPROVED");
    assert.equal(outcome.draftSaved, false,
      "workspacePath 是文件 → saveProxyApprovedDraft 应失败 → draftSaved=false");
    assert.ok(
      typeof outcome.draftError === "string" && outcome.draftError.length > 0,
      "落盘失败应返回非空 draftError",
    );
    // fail-closed：PROXY_APPROVED + draftSaved=false 必须 hard block
    // 理由：用户没有 pending draft 可 review，直接 commit 会绕过用户确认
    assert.equal(outcome.shouldHardBlock, true,
      "PROXY_APPROVED + draftSaved=false 必须 shouldHardBlock=true（用户没有 pending draft，不能继续 commit）");
    assert.equal(outcome.shouldSkipCommit, false,
      "draftSaved=false 不应 shouldSkipCommit=true（pending sentinel 未落盘）");
    assert.ok(
      typeof outcome.hardBlockReason === "string" && outcome.hardBlockReason.length > 0,
      "shouldHardBlock=true 时必须给出 hardBlockReason",
    );
    assert.equal(stageResults.proxyApproval?.shouldHardBlock, true,
      "stageResults.proxyApproval.shouldHardBlock 应同步记录");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 12. runProxyApprovalStage PROXY_APPROVED + draftSaved=true → shouldHardBlock=false, shouldSkipCommit=true（回归守护）
// ============================================================================

test("P0-3 #12: runProxyApprovalStage PROXY_APPROVED + draftSaved=true → shouldHardBlock=false, shouldSkipCommit=true（回归守护）", async () => {
  const root = mkdtempSync(join(tmpdir(), "p0-3-stage-ok-"));
  try {
    const stagedStateUpdate = {
      additions: [
        {
          kind: "canon",
          id: "canon:fact:dark-current",
          sourceChapter: "ch1",
          sourceRef: "seed:canon:dark-current",
          confidence: 0.6,
          lastUpdated: "2026-07-16T00:00:00.000Z",
          fact: "暗流不可消除",
          category: "ability_rule",
        },
      ],
      invalidations: [],
      sourceChapter: "ch1",
    };
    const cardPath = join(root, "auth-card.json");
    writeFileSync(cardPath, JSON.stringify(makeValidAuthCardJson()), "utf-8");
    const callerOverride = createStubChapterProxyApprovalCaller({
      forwardVerdict: "PROXY_APPROVED",
      reverseVerdict: "PROXY_APPROVED",
      recommendedCandidateId: "cand-edit-001",
      recommendedSource: "editorial",
      modelVersion: "gpt5.6-sol-2026-07",
    });

    // workspacePath 是合法目录（root/workspaces/ws-1/），saveProxyApprovedDraft 成功
    // 不提供 _registryOverride：让 registry 也用同一路径（approvalsDir = workspacePath/chapter-approvals/）
    const input = makeMinimalProxyApprovalInput(root, {
      stagedStateUpdate,
      proxyApprovalOptions: {
        authorizationCardPath: cardPath,
        callerOverride,
      },
    });
    const rawCandidate = { id: "cand-raw-001", text: "raw candidate text" };
    const stageResults = {};

    const outcome = await runProxyApprovalStage(
      input, rawCandidate, "cand-edit-001", "editorial", "editorial final text", stageResults,
    );

    assert.equal(outcome.ran, true);
    assert.equal(outcome.finalStatus, "PROXY_APPROVED");
    assert.equal(outcome.draftSaved, true, "合法 workspacePath → draftSaved=true");
    // pending 路径（不变）：shouldSkipCommit=true，shouldHardBlock=false
    assert.equal(outcome.shouldSkipCommit, true,
      "PROXY_APPROVED + draftSaved=true → shouldSkipCommit=true（pending sentinel 已落盘）");
    assert.equal(outcome.shouldHardBlock, false,
      "PROXY_APPROVED + draftSaved=true 不应 hard block（pending 路径正常）");
    // pending sentinel 确实落盘
    const workspacePath = join(root, "workspaces", "ws-1");
    assert.equal(hasPendingProxyDraft(workspacePath, "ch-1"), true,
      "pending sentinel 应落盘 → commitAndSave 守护阻断");
    const draft = loadProxyApprovedDraft(workspacePath, outcome.approvalId);
    assert.deepEqual(
      draft?.stagedStateUpdate,
      stagedStateUpdate,
      "runProxyApprovalStage 必须把当前候选的完整 stagedStateUpdate 写入 pending checkpoint",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
