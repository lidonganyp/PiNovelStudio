/**
 * EVOLUTION-RELEASE-GOVERNANCE-G7 — 代理审批稿 pending checkpoint 测试
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 / §12.2
 *
 * G7-Checkpoint 切片要求（计划 §6.3 line 280）：
 * - 代理审批稿不是正式最终版。用户最终确认前，FinalStateCommit 和正式章节原子保存均不得执行。
 * - 允许保存只读、可恢复的 pending checkpoint，但不得推进下一章 frontier。
 * - 代理审批稿落盘到 workspaces/{id}/chapter-approvals/（隔离目录），不写正式 chapters/。
 *
 * negative verification（派工计划 §0.2）：
 * - 代理审批稿不得绕过 FactGuard；
 * - 用户未确认版本不得执行 FinalStateCommit；
 * - 代理审批不得自动晋级为正式章节。
 *
 * 本测试覆盖：
 * 1. saveProxyApprovedDraft 落盘到 chapter-approvals/（隔离目录），不写 chapters/
 * 2. hasPendingProxyDraft 在 save 后返回 true，clear 后返回 false
 * 3. loadProxyApprovedDraft 返回完整 draft 文本 + 元数据
 * 4. append-only：同 approvalId 重复写入拒绝（防止篡改审批稿）
 * 5. 目录穿越：恶意 approvalId（'../escaped' / 分隔符 / 点 / 空格）拒绝
 * 6. commitAndSave 守护：有 pending draft 时拒绝执行（ok=false），不写 chapters/，不提交状态
 * 7. commitAndSave 守护：无 pending draft 时正常执行（ok=true），写 chapters/
 * 8. 隔离验证：pending draft 文件不出现在 chapters/ 目录
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  saveProxyApprovedDraft,
  loadProxyApprovedDraft,
  hasPendingProxyDraft,
  getPendingProxyDraft,
  getPendingSentinel,
  clearPendingProxyDraft,
  resolveDraftCheckpointDir,
} from "../dist/v2/governance/chapter-proxy-approval-draft-checkpoint.js";
import { commitAndSave } from "../dist/v2/core/orchestrator-commit-save.js";

// ============================================================================
// helpers
// ============================================================================

function makeTempWorkspace() {
  const projectRoot = mkdtempSync(join(tmpdir(), "g7-draft-checkpoint-"));
  const workspaceId = "ws-test";
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  return { projectRoot, workspaceId, workspacePath };
}

function makeDraftOptions(overrides = {}) {
  return {
    workspacePath: "",
    approvalId: "cpa-draft-001",
    chapterId: "1",
    candidateId: "cand-raw-001",
    selectedSource: "raw",
    finalText: "这是代理审批稿的正文内容。\n第二段。",
    savedAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

function makeMinimalOrchestratorInput(projectRoot, workspaceId, chapterId = "1") {
  return {
    workspaceId,
    chapterId,
    chapterNumber: 1,
    projectRoot,
    intent: {},
    context: { facts: [], longTermState: null },
    constitution: null,
    characterNames: [],
    stagedStateUpdate: null,
  };
}

function makeOrchestratorInputWithStagedState(projectRoot, workspaceId, chapterId = "1") {
  return {
    ...makeMinimalOrchestratorInput(projectRoot, workspaceId, chapterId),
    chapterNumber: 1,
    stagedStateUpdate: {
      additions: [
        {
          kind: "canon",
          id: "canon:ch1:test",
          sourceChapter: "ch1",
          sourceRef: "seed:ch1",
          confidence: 0.6,
          lastUpdated: "2026-07-16T00:00:00.000Z",
          fact: "测试事实",
          category: "entity",
        },
      ],
      invalidations: [],
      sourceChapter: "ch1",
    },
  };
}

// ============================================================================
// 测试
// ============================================================================

test("G7-Checkpoint: saveProxyApprovedDraft 落盘到 chapter-approvals/ 隔离目录", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    const options = makeDraftOptions({ workspacePath });
    saveProxyApprovedDraft(options);

    const draftDir = resolveDraftCheckpointDir(workspacePath);
    assert.ok(existsSync(draftDir), "chapter-approvals/ 目录应存在");

    // draft 文本文件
    const draftFile = join(draftDir, "cpa-draft-001.draft.md");
    assert.ok(existsSync(draftFile), "draft.md 文件应存在");
    const draftText = readFileSync(draftFile, "utf-8");
    assert.equal(draftText, options.finalText);

    // draft 元数据文件
    const metaFile = join(draftDir, "cpa-draft-001.draft.meta.json");
    assert.ok(existsSync(metaFile), "draft.meta.json 文件应存在");
    const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
    assert.equal(meta.approvalId, "cpa-draft-001");
    assert.equal(meta.chapterId, "1");
    assert.equal(meta.candidateId, "cand-raw-001");
    assert.equal(meta.selectedSource, "raw");

    // pending sentinel
    const pendingFile = join(draftDir, "1.pending.json");
    assert.ok(existsSync(pendingFile), "pending sentinel 应存在");
    const pending = JSON.parse(readFileSync(pendingFile, "utf-8"));
    assert.equal(pending.chapterId, "1");
    assert.equal(pending.approvalId, "cpa-draft-001");
    assert.equal(pending.status, "pending");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("G7-Checkpoint: pending draft 不写 chapters/ 目录", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    const options = makeDraftOptions({ workspacePath });
    saveProxyApprovedDraft(options);

    const chaptersDir = join(workspacePath, "chapters");
    assert.ok(
      !existsSync(chaptersDir) || readdirSync(chaptersDir).length === 0,
      "chapters/ 目录不应存在或应为空",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("G7-Checkpoint: hasPendingProxyDraft 在 save 后 true，clear 后 false", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), false, "save 前应无 pending");

    saveProxyApprovedDraft(makeDraftOptions({ workspacePath }));
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), true, "save 后应有 pending");

    clearPendingProxyDraft(workspacePath, "1");
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), false, "clear 后应无 pending");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("G7-Checkpoint: loadProxyApprovedDraft 返回完整 draft + meta", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    const options = makeDraftOptions({ workspacePath });
    saveProxyApprovedDraft(options);

    const loaded = loadProxyApprovedDraft(workspacePath, "cpa-draft-001");
    assert.ok(loaded, "应返回 draft 数据");
    assert.equal(loaded.approvalId, "cpa-draft-001");
    assert.equal(loaded.chapterId, "1");
    assert.equal(loaded.candidateId, "cand-raw-001");
    assert.equal(loaded.selectedSource, "raw");
    assert.equal(loaded.finalText, options.finalText);
    assert.ok(loaded.savedAt, "应有 savedAt 时间戳");
    assert.ok(loaded.draftFilePath, "应有 draftFilePath");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("G7-Checkpoint: stagedStateUpdate 随 pending draft 持久化并完整 round-trip", () => {
  const { projectRoot, workspacePath } = makeTempWorkspace();
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
        {
          kind: "character",
          id: "character:林川:ch1",
          sourceChapter: "ch1",
          sourceRef: "seed:character:林川",
          confidence: 0.6,
          lastUpdated: "2026-07-16T00:00:00.000Z",
          characterId: "林川",
          field: "participation",
          value: "present",
        },
        {
          kind: "promise",
          id: "promise:dark-current",
          sourceChapter: "ch1",
          sourceRef: "seed:promise:dark-current",
          confidence: 0.6,
          lastUpdated: "2026-07-16T00:00:00.000Z",
          promiseId: "promise:dark-current",
          description: "暗流真相",
          currentHeat: 1,
          status: "advancing",
        },
      ],
      invalidations: [],
      sourceChapter: "ch1",
    };

    saveProxyApprovedDraft(
      makeDraftOptions({ workspacePath, stagedStateUpdate }),
    );

    const loaded = loadProxyApprovedDraft(workspacePath, "cpa-draft-001");
    assert.ok(loaded, "应返回 draft 数据");
    assert.deepEqual(
      loaded.stagedStateUpdate,
      stagedStateUpdate,
      "pending checkpoint 必须保留完整 stagedStateUpdate，避免定稿时四类状态丢失",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("G7-Checkpoint: getPendingProxyDraft 返回最新 pending draft", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    assert.equal(getPendingProxyDraft(workspacePath, "1"), null, "无 pending 时返回 null");

    saveProxyApprovedDraft(makeDraftOptions({ workspacePath }));
    const pending = getPendingProxyDraft(workspacePath, "1");
    assert.ok(pending, "有 pending 时应返回 draft");
    assert.equal(pending.approvalId, "cpa-draft-001");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// getPendingSentinel：只读 sentinel（用于定稿操作 approvalId 双重绑定校验）
// ============================================================================

test("getPendingSentinel: 无 pending 时返回 null", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    assert.equal(getPendingSentinel(workspacePath, "1"), null, "无 sentinel 时应返回 null");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("getPendingSentinel: 有 pending 时返回 sentinel（含 approvalId/chapterId/status/savedAt）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    saveProxyApprovedDraft(makeDraftOptions({ workspacePath, approvalId: "cpa-sent-001", chapterId: "7" }));
    const sentinel = getPendingSentinel(workspacePath, "7");
    assert.ok(sentinel, "有 pending 时应返回 sentinel");
    assert.equal(sentinel.approvalId, "cpa-sent-001");
    assert.equal(sentinel.chapterId, "7");
    assert.equal(sentinel.status, "pending");
    assert.equal(sentinel.savedAt, "2026-07-16T00:00:00.000Z");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("getPendingSentinel: clear 后返回 null", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    saveProxyApprovedDraft(makeDraftOptions({ workspacePath }));
    assert.ok(getPendingSentinel(workspacePath, "1"), "save 后应有 sentinel");
    clearPendingProxyDraft(workspacePath, "1");
    assert.equal(getPendingSentinel(workspacePath, "1"), null, "clear 后应返回 null");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("getPendingSentinel: draft 元数据损坏时仍能返回 sentinel approvalId（不依赖 draft 元数据）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    saveProxyApprovedDraft(makeDraftOptions({ workspacePath, approvalId: "cpa-robust-001" }));
    // 篡改 draft 元数据文件（模拟损坏），sentinel 应不受影响
    const metaFile = join(resolveDraftCheckpointDir(workspacePath), "cpa-robust-001.draft.meta.json");
    writeFileSync(metaFile, "{ corrupted json", "utf-8");
    // getPendingProxyDraft 因 draft 元数据损坏返回 null
    assert.equal(getPendingProxyDraft(workspacePath, "1"), null);
    // getPendingSentinel 仍能返回 sentinel（只读 sentinel，不加载 draft 元数据）
    const sentinel = getPendingSentinel(workspacePath, "1");
    assert.ok(sentinel, "sentinel 不应受 draft 元数据损坏影响");
    assert.equal(sentinel.approvalId, "cpa-robust-001");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("getPendingSentinel: sentinel JSON 损坏时返回 null（fail-closed）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    const draftDir = resolveDraftCheckpointDir(workspacePath);
    mkdirSync(draftDir, { recursive: true });
    const sentinelFile = join(draftDir, "1.pending.json");
    writeFileSync(sentinelFile, "{ invalid json", "utf-8");
    assert.equal(getPendingSentinel(workspacePath, "1"), null, "损坏 sentinel 应返回 null");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// P0: hasPendingProxyDraft fail-closed 守护（防损坏/异常 sentinel 放行 commitAndSave）
//
// 安全约束（计划 §6.3 line 280）：sentinel 文件存在即代表"曾被写入 pending"，
// 损坏或字段异常时不得假定无 pending 放行正式保存。
// - JSON 损坏 -> hasPendingProxyDraft 返回 true（阻断 commitAndSave）
// - 关键字段缺失/类型异常 -> hasPendingProxyDraft 返回 true（阻断 commitAndSave）
// - status 字段缺失/类型异常 -> hasPendingProxyDraft 返回 true（阻断 commitAndSave）
// - status 非 "pending" 且字段完整 -> 返回 false（明示已清除）
// - 文件不存在 -> 返回 false（确定无 pending）
// ============================================================================

function writeSentinelRaw(workspacePath, chapterId, content) {
  const draftDir = resolveDraftCheckpointDir(workspacePath);
  mkdirSync(draftDir, { recursive: true });
  const sentinelFile = join(draftDir, `${chapterId}.pending.json`);
  writeFileSync(sentinelFile, content, "utf-8");
  return sentinelFile;
}

test("P0 hasPendingProxyDraft: JSON 损坏 sentinel -> 返回 true（fail-closed，阻断 commitAndSave）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeSentinelRaw(workspacePath, "1", "{ invalid json");
    assert.equal(
      hasPendingProxyDraft(workspacePath, "1"),
      true,
      "损坏 JSON sentinel 必须视为 pending（fail-closed），不得放行 commitAndSave",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("P0 hasPendingProxyDraft: 空文件 sentinel -> 返回 true（fail-closed）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeSentinelRaw(workspacePath, "1", "");
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), true, "空文件 sentinel 必须 fail-closed");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("P0 hasPendingProxyDraft: chapterId 字段缺失 -> 返回 true（fail-closed）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeSentinelRaw(
      workspacePath,
      "1",
      JSON.stringify({ approvalId: "cpa-001", status: "pending", savedAt: "2026-07-16T00:00:00.000Z" }),
    );
    assert.equal(
      hasPendingProxyDraft(workspacePath, "1"),
      true,
      "chapterId 字段缺失必须 fail-closed",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("P0 hasPendingProxyDraft: approvalId 字段缺失 -> 返回 true（fail-closed）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeSentinelRaw(
      workspacePath,
      "1",
      JSON.stringify({ chapterId: "1", status: "pending", savedAt: "2026-07-16T00:00:00.000Z" }),
    );
    assert.equal(
      hasPendingProxyDraft(workspacePath, "1"),
      true,
      "approvalId 字段缺失必须 fail-closed",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("P0 hasPendingProxyDraft: savedAt 字段缺失 -> 返回 true（fail-closed）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeSentinelRaw(
      workspacePath,
      "1",
      JSON.stringify({ chapterId: "1", approvalId: "cpa-001", status: "pending" }),
    );
    assert.equal(
      hasPendingProxyDraft(workspacePath, "1"),
      true,
      "savedAt 字段缺失必须 fail-closed",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("P0 hasPendingProxyDraft: status 字段缺失 -> 返回 true（fail-closed）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeSentinelRaw(
      workspacePath,
      "1",
      JSON.stringify({ chapterId: "1", approvalId: "cpa-001", savedAt: "2026-07-16T00:00:00.000Z" }),
    );
    assert.equal(
      hasPendingProxyDraft(workspacePath, "1"),
      true,
      "status 字段缺失必须 fail-closed（视为 pending）",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("P0 hasPendingProxyDraft: 字段类型异常（非字符串）-> 返回 true（fail-closed）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    // chapterId 是数字而非字符串
    writeSentinelRaw(
      workspacePath,
      "1",
      JSON.stringify({ chapterId: 1, approvalId: "cpa-001", status: "pending", savedAt: "2026-07-16T00:00:00.000Z" }),
    );
    assert.equal(
      hasPendingProxyDraft(workspacePath, "1"),
      true,
      "字段类型异常必须 fail-closed",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// P0 阻断项修复：未知 sentinel 状态必须 fail-closed（draft-checkpoint:337）
// ============================================================================
// 用户阻断项 P0-2：现存 pending 文件只要把 status 改为 "cleared" 等任意非 "pending"
// 字符串，即被判定为无 pending -> 反向放行 commitAndSave -> 章节被错误提交。
//
// 系统实际写入行为：
// - saveProxyApprovedDraft 总是写 status="pending"
// - clearPendingProxyDraft 直接 unlink 文件（不写 status）
// - restorePendingSentinel 总是写 status="pending"
// 因此磁盘上合法的 sentinel 永远 status="pending"；任何非 "pending" 值都是
// 篡改/损坏/未知来源。fail-closed 白名单：只有 status === "pending" 返回 true，
// 其他任何字符串值（"cleared" / "unknown" / ""）也返回 true（视为 pending，阻断）。
// ============================================================================

test("P0 hasPendingProxyDraft: status='cleared' 且字段完整 -> 返回 true（fail-closed，未知值视为 pending）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeSentinelRaw(
      workspacePath,
      "1",
      JSON.stringify({
        chapterId: "1",
        approvalId: "cpa-001",
        status: "cleared",
        savedAt: "2026-07-16T00:00:00.000Z",
      }),
    );
    assert.equal(
      hasPendingProxyDraft(workspacePath, "1"),
      true,
      "status='cleared' 是系统从不写入的值，必须 fail-closed 视为 pending，阻断 commitAndSave",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("P0 hasPendingProxyDraft: status='unknown' 且字段完整 -> 返回 true（fail-closed，未知值视为 pending）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeSentinelRaw(
      workspacePath,
      "1",
      JSON.stringify({
        chapterId: "1",
        approvalId: "cpa-001",
        status: "unknown",
        savedAt: "2026-07-16T00:00:00.000Z",
      }),
    );
    assert.equal(
      hasPendingProxyDraft(workspacePath, "1"),
      true,
      "未知 status 字符串必须 fail-closed 视为 pending",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("P0 hasPendingProxyDraft: status='' 空字符串且字段完整 -> 返回 true（fail-closed）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeSentinelRaw(
      workspacePath,
      "1",
      JSON.stringify({
        chapterId: "1",
        approvalId: "cpa-001",
        status: "",
        savedAt: "2026-07-16T00:00:00.000Z",
      }),
    );
    assert.equal(
      hasPendingProxyDraft(workspacePath, "1"),
      true,
      "空字符串 status 必须 fail-closed 视为 pending",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("P0 hasPendingProxyDraft: status='completed' 且字段完整 -> 返回 true（fail-closed，未知值视为 pending）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeSentinelRaw(
      workspacePath,
      "1",
      JSON.stringify({
        chapterId: "1",
        approvalId: "cpa-001",
        status: "completed",
        savedAt: "2026-07-16T00:00:00.000Z",
      }),
    );
    assert.equal(
      hasPendingProxyDraft(workspacePath, "1"),
      true,
      "status='completed' 是系统从不写入的值，必须 fail-closed",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("P0 hasPendingProxyDraft: 文件不存在 -> 返回 false（确定无 pending）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    assert.equal(
      hasPendingProxyDraft(workspacePath, "1"),
      false,
      "无 sentinel 文件时放行（确定无 pending）",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("P0 commitAndSave 守护：损坏 sentinel 时拒绝执行（fail-closed，不写 chapters/、不提交状态）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    // 写入损坏 sentinel（模拟磁盘损坏/篡改）
    writeSentinelRaw(workspacePath, "1", "{ corrupted json");

    const input = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");
    const stageResults = {};
    const outcome = commitAndSave(input, "cand-raw-001", "尝试写入正式章节", stageResults);

    // commitAndSave 必须 fail-closed：拒绝执行
    assert.equal(outcome.ok, false, "损坏 sentinel 时 commitAndSave 必须返回 ok=false（fail-closed）");
    assert.ok(outcome.error, "应有 error 信息");
    assert.ok(
      outcome.error.includes("pending") || outcome.error.includes("proxy"),
      `error 应提及 pending/proxy：${outcome.error}`,
    );
    assert.equal(outcome.stateCommit, null, "不应提交状态");

    // chapters/ 不应被写入
    const chapterFile = join(workspacePath, "chapters", "1.md");
    assert.ok(!existsSync(chapterFile), "损坏 sentinel 时正式章节文件不应被写入");

    // stageResults 应记录阻断
    assert.ok(stageResults.atomicSave, "应有 atomicSave stage result");
    assert.ok(
      stageResults.atomicSave.blocked === true,
      `atomicSave 应记录 blocked=true：${JSON.stringify(stageResults.atomicSave)}`,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("P0 commitAndSave 守护：字段异常 sentinel 时拒绝执行（fail-closed）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    // 写入字段缺失的 sentinel（status 缺失）
    writeSentinelRaw(
      workspacePath,
      "1",
      JSON.stringify({ chapterId: "1", approvalId: "cpa-001", savedAt: "2026-07-16T00:00:00.000Z" }),
    );

    const input = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");
    const stageResults = {};
    const outcome = commitAndSave(input, "cand-raw-001", "尝试写入", stageResults);

    assert.equal(outcome.ok, false, "字段异常 sentinel 时 commitAndSave 必须 fail-closed");
    const chapterFile = join(workspacePath, "chapters", "1.md");
    assert.ok(!existsSync(chapterFile), "字段异常 sentinel 时不应写 chapters/");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("G7-Checkpoint: append-only — 同 approvalId 重复写入拒绝", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    saveProxyApprovedDraft(makeDraftOptions({ workspacePath }));

    assert.throws(
      () => saveProxyApprovedDraft(makeDraftOptions({ workspacePath, finalText: "篡改内容" })),
      /already exists|已存在|append-only/i,
      "同 approvalId 重复写入应抛错",
    );

    // 确认内容未被篡改
    const loaded = loadProxyApprovedDraft(workspacePath, "cpa-draft-001");
    assert.equal(loaded.finalText, "这是代理审批稿的正文内容。\n第二段。", "原内容不应被覆盖");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("G7-Checkpoint: 目录穿越 — 恶意 approvalId 拒绝", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    const maliciousIds = [
      "../escaped",
      "..\\escaped",
      "foo/bar",
      "foo\\bar",
      "foo.bar",
      "foo bar",
      "foo\x00bar",
    ];
    for (const maliciousId of maliciousIds) {
      assert.throws(
        () => saveProxyApprovedDraft(makeDraftOptions({ workspacePath, approvalId: maliciousId })),
        /非法字符|path traversal|路径穿越|invalid/i,
        `恶意 approvalId=${JSON.stringify(maliciousId)} 应被拒绝`,
      );
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("G7-Checkpoint: commitAndSave 守护 — 有 pending draft 时拒绝执行", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    // 1. 先创建 pending proxy draft
    saveProxyApprovedDraft(makeDraftOptions({ workspacePath }));

    // 2. 尝试 commitAndSave — 应被守护拒绝
    const input = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");
    const stageResults = {};
    const outcome = commitAndSave(input, "cand-raw-001", "尝试写入正式章节", stageResults);

    assert.equal(outcome.ok, false, "有 pending draft 时 commitAndSave 应返回 ok=false");
    assert.ok(outcome.error, "应有 error 信息");
    assert.ok(
      outcome.error.includes("pending") || outcome.error.includes("proxy"),
      `error 应提及 pending/proxy：${outcome.error}`,
    );
    assert.equal(outcome.stateCommit, null, "不应提交状态");

    // 3. 正式 chapters/ 不应被写入
    const chapterFile = join(workspacePath, "chapters", "1.md");
    assert.ok(!existsSync(chapterFile), "正式章节文件不应被写入");

    // 4. stageResults 应记录阻断
    assert.ok(stageResults.atomicSave, "应有 atomicSave stage result");
    assert.ok(
      stageResults.atomicSave.blocked === true ||
      (typeof stageResults.atomicSave.error === "string" &&
       stageResults.atomicSave.error.includes("pending")),
      `atomicSave 应记录阻断：${JSON.stringify(stageResults.atomicSave)}`,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("G7-Checkpoint: commitAndSave 守护 — 无 pending draft 时正常执行", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    // 无 pending draft
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), false);

    const input = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");
    const stageResults = {};
    const finalText = "正式章节正文";
    const outcome = commitAndSave(input, "cand-raw-001", finalText, stageResults);

    assert.equal(outcome.ok, true, "无 pending draft 时 commitAndSave 应正常执行");
    const chapterFile = join(workspacePath, "chapters", "1.md");
    assert.ok(existsSync(chapterFile), "正式章节文件应被写入");
    assert.equal(readFileSync(chapterFile, "utf-8"), finalText);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("G7-Checkpoint: clearPendingProxyDraft 后 commitAndSave 恢复正常", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    // 1. 创建 pending draft
    saveProxyApprovedDraft(makeDraftOptions({ workspacePath }));
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), true);

    // 2. commitAndSave 被拒绝
    const input = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");
    let stageResults = {};
    let outcome = commitAndSave(input, "cand-raw-001", "尝试写入", stageResults);
    assert.equal(outcome.ok, false, "pending 时应拒绝");

    // 3. clear pending（模拟用户最终确认）
    clearPendingProxyDraft(workspacePath, "1");
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), false);

    // 4. commitAndSave 恢复正常
    stageResults = {};
    outcome = commitAndSave(input, "cand-raw-001", "用户确认后的正式正文", stageResults);
    assert.equal(outcome.ok, true, "clear 后应恢复正常");
    const chapterFile = join(workspacePath, "chapters", "1.md");
    assert.ok(existsSync(chapterFile), "正式章节文件应被写入");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("G7-Checkpoint: 隔离验证 — pending draft 文件不出现在 chapters/", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    saveProxyApprovedDraft(makeDraftOptions({ workspacePath }));

    // chapters/ 不应存在（commitAndSave 未执行）
    const chaptersDir = join(workspacePath, "chapters");
    assert.ok(!existsSync(chaptersDir), "chapters/ 不应存在");

    // chapter-approvals/ 应有 draft 文件
    const draftDir = resolveDraftCheckpointDir(workspacePath);
    const draftFiles = readdirSync(draftDir);
    assert.ok(draftFiles.length > 0, "chapter-approvals/ 应有文件");
    assert.ok(
      draftFiles.some((f) => f.endsWith(".draft.md")),
      "应有 .draft.md 文件",
    );
    assert.ok(
      !draftFiles.some((f) => f.endsWith(".md") && !f.includes("draft") && !f.includes("pending")),
      "不应有非 draft/pending 的 .md 文件",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// P1: commitAndSave 在状态提交前备份 narrative-state-store.json
//
// 备份到 chapter-approvals/{chapterId}.pre-commit-state-{timestamp}.json，
// 供 rollbackCommittedChapter 恢复，实现"正文与状态一起回退"闭环。
// ============================================================================

test("P1 commitAndSave: 有 stagedStateUpdate + 已有 state store -> 创建 pre-commit-state 备份", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    // 1. 预置章节前 narrative-state-store.json
    const stateStorePath = join(workspacePath, "narrative-state-store.json");
    mkdirSync(workspacePath, { recursive: true });
    const preCommitState = JSON.stringify({
      schemaVersion: 1,
      workspaceId,
      canon: [{ id: "canon:pre:1", kind: "canon", fact: "章节前事实", sourceChapter: "ch0", sourceRef: "ch0#seed", confidence: 0.7, lastUpdated: "2026-07-15T00:00:00.000Z", category: "entity" }],
      character: [],
      promise: [],
      pattern: [],
      expectation: [],
      updatedAt: "2026-07-15T00:00:00.000Z",
    }, null, 2);
    writeFileSync(stateStorePath, preCommitState, "utf-8");

    // 2. commitAndSave（带 stagedStateUpdate）
    const input = makeOrchestratorInputWithStagedState(projectRoot, workspaceId, "1");
    const stageResults = {};
    const outcome = commitAndSave(input, "cand-raw-001", "正式章节正文", stageResults);

    assert.equal(outcome.ok, true, "commitAndSave 应成功");

    // 3. 应创建 pre-commit-state 备份
    assert.ok(stageResults.stateBackup, "应有 stateBackup stage result");
    assert.ok(stageResults.stateBackup.backupPath, "应有 backupPath");
    assert.match(
      stageResults.stateBackup.backupPath,
      /chapter-approvals[\\/]1\.pre-commit-state-\d+\.json/,
      "备份路径应匹配 chapter-approvals/1.pre-commit-state-{timestamp}.json",
    );
    assert.equal(existsSync(stageResults.stateBackup.backupPath), true, "备份文件应存在");

    // 4. 备份内容应为章节前状态（只有 canon:pre:1，不含本章新增的 canon:ch1:test）
    const backupContent = JSON.parse(readFileSync(stageResults.stateBackup.backupPath, "utf-8"));
    assert.equal(backupContent.canon.length, 1, "备份应为章节前状态（1 条 canon）");
    assert.equal(backupContent.canon[0].id, "canon:pre:1");
    assert.equal(
      backupContent.canon.some((c) => c.id === "canon:ch1:test"),
      false,
      "备份不应包含本章新增的 canon",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("P1 commitAndSave: 无 stagedStateUpdate -> 不创建 pre-commit-state 备份", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    // 无 stagedStateUpdate（makeMinimalOrchestratorInput）
    const input = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");
    const stageResults = {};
    const outcome = commitAndSave(input, "cand-raw-001", "正式章节正文", stageResults);

    assert.equal(outcome.ok, true, "commitAndSave 应成功");
    assert.equal(stageResults.stateBackup, undefined, "无 stagedStateUpdate 时不应创建 stateBackup");

    // chapter-approvals/ 不应有 pre-commit-state 备份文件
    const approvalsDir = join(workspacePath, "chapter-approvals");
    if (existsSync(approvalsDir)) {
      const backups = readdirSync(approvalsDir).filter((f) => f.includes("pre-commit-state"));
      assert.deepEqual(backups, [], "不应有 pre-commit-state 备份文件");
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("P1 commitAndSave: 无已有 state store + 有 stagedStateUpdate -> stateBackup.skipped（不报错）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    // 不预置 narrative-state-store.json（首章场景）
    const input = makeOrchestratorInputWithStagedState(projectRoot, workspaceId, "1");
    const stageResults = {};
    const outcome = commitAndSave(input, "cand-raw-001", "正式章节正文", stageResults);

    assert.equal(outcome.ok, true, "commitAndSave 应成功");
    assert.ok(stageResults.stateBackup, "应有 stateBackup stage result");
    assert.equal(stageResults.stateBackup.skipped, "no_prior_state_store", "无 prior state store 时应 skipped");
    assert.equal(stageResults.stateBackup.backupPath, undefined, "不应有 backupPath");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// P1#2: 状态备份失败时阻断状态提交（保证"正文与状态一起回退"闭环）
//
// 计划 §12.2 验收 3：pre-commit 状态备份失败不得继续提交状态。
// 若备份失败仍提交状态，此后 rollbackCommittedChapter 会删除正文却无法恢复
// 叙事状态（无 pre-commit 备份），破坏"正文与状态一起回退"保证。
//
// 修复方向：备份失败（且存在 prior state store）时阻断状态提交——
// 正文仍保存（主产物交付），但状态不提交（committed=0），state store 保持章节前状态。
// ============================================================================

test("P1#2 commitAndSave: 状态备份失败 -> 阻断状态提交（committed=0，state store 不被污染）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    // 1. 预置章节前 narrative-state-store.json（有 prior state，需要备份）
    mkdirSync(workspacePath, { recursive: true });
    const stateStorePath = join(workspacePath, "narrative-state-store.json");
    const preCommitState = JSON.stringify({
      schemaVersion: 1,
      workspaceId,
      canon: [{ id: "canon:pre:1", kind: "canon", fact: "章节前事实", sourceChapter: "ch0", sourceRef: "ch0#seed", confidence: 0.7, lastUpdated: "2026-07-15T00:00:00.000Z", category: "entity" }],
      character: [],
      promise: [],
      pattern: [],
      expectation: [],
      updatedAt: "2026-07-15T00:00:00.000Z",
    }, null, 2);
    writeFileSync(stateStorePath, preCommitState, "utf-8");

    // 2. 让 chapter-approvals 成为文件（不是目录），使 pre-commit-state 备份写入失败。
    //    备份路径 chapter-approvals/{chapterId}.pre-commit-state-{ts}.json 无法在文件内创建。
    //    hasPendingProxyDraft 读取 chapter-approvals/{chapterId}.pending.json 时 existsSync
    //    返回 false（路径无效），不阻断 commitAndSave 进入备份/提交阶段。
    writeFileSync(join(workspacePath, "chapter-approvals"), "blocker-file", "utf-8");

    // 3. commitAndSave（带 stagedStateUpdate，finalText 含事实关键词以提高 commit 命中）
    const input = makeOrchestratorInputWithStagedState(projectRoot, workspaceId, "1");
    const stageResults = {};
    const outcome = commitAndSave(input, "cand-raw-001", "正式章节正文，包含测试事实关键词。", stageResults);

    // 4. 状态备份失败时整次提交失败，已经写入的新章节必须回滚。
    assert.equal(outcome.ok, false, "状态备份失败时正文和状态必须一起回滚");
    const chapterFile = join(workspacePath, "chapters", "1.md");
    assert.equal(existsSync(chapterFile), false, "新章节必须在状态备份失败后删除");
    assert.equal(stageResults.atomicSave?.rolledBack, true, "atomicSave 应记录成功回滚");
    assert.equal(stageResults.atomicSave?.rollbackAction, "removed_new");

    // 5. 关键验收：状态备份失败 -> 阻断状态提交
    assert.ok(stageResults.stateBackup, "应有 stateBackup stage result");
    assert.ok(stageResults.stateBackup.error, "备份失败应有 error 信息");
    assert.equal(stageResults.stateBackup.backupPath, undefined, "备份失败不应有 backupPath");

    assert.ok(stageResults.stateCommit, "应有 stateCommit stage result");
    assert.equal(
      outcome.stateCommit && outcome.stateCommit.committed,
      0,
      "备份失败时必须阻断状态提交（committed=0）",
    );
    assert.equal(
      stageResults.stateCommit.blocked,
      "backup_failed",
      "stateCommit 应标记 blocked=backup_failed",
    );
    assert.ok(outcome.stateCommit?.error, "返回值必须暴露状态备份失败原因");

    // 6. narrative-state-store.json 应保持章节前状态（未被本章新增 canon 污染）
    const finalState = JSON.parse(readFileSync(stateStorePath, "utf-8"));
    assert.equal(finalState.canon.length, 1, "状态未提交，应保持章节前 1 条 canon");
    assert.equal(finalState.canon[0].id, "canon:pre:1", "应保持章节前 canon");
    assert.equal(
      finalState.canon.some((c) => c.id === "canon:ch1:test"),
      false,
      "不应包含本章新增 canon（状态被阻断）",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
