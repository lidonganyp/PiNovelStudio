/**
 * 专家群接入生产工具面 + 章节契约正式 handoff 测试（EXPERT-HOST-HANDOFF-1）
 *
 * 锁定：
 * - novel_workspace_manager 暴露 list_experts / dispatch_expert / handoff_chapter_contract，
 *   不新增第 7 个公开工具；
 * - dispatch_expert 只产出宿主可执行任务包（零模型调用、零写入），未知角色/越权路径/
 *   execute 模式一律 fail-closed；
 * - handoff preview 只校验/预览、不签发 commit 凭证；commit 必须 confirm + 可信宿主审批层
 *   （issueChapterContractApproval）签发的一次性凭证，confirmedBy 仅作审计；
 *   写入 series/ch{N}-outline-explicit.md 后既有解析器与 ChapterSeed 构建器能真实消费，
 *   并落 provenance（含 approval.issuedBy / approvedBy）。
 *
 * 依赖边界：只在临时目录构造 workspace，不写真实 workspaces/。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, chmodSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerTools } from "../dist/tools/register-tools.js";
import { handleWorkspaceManager } from "../dist/tools/workspace-manager-handler.js";
import {
  handleExpertHandoff,
  issueChapterContractApproval,
} from "../dist/handlers/expert-handoff-handler.js";
import { parseExplicitOutline } from "../dist/craft/explicit-outline-parser.js";
import { buildChapterSeed } from "../dist/craft/chapter-seed-builder.js";
import { resolveChapterContractConsumption } from "../dist/craft/chapter-contract-provenance.js";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = resolve(TESTS_DIR, "../../../agents");

const PROPOSAL = [
  "## 章节功能",
  "- chapterNumber: 12",
  "- 职能：推进",
  "- 缺失后果：不写这章，师门线索就断了",
  "",
  "## 意图",
  "- 主意图：主角第一次主动追查师门线索",
  "- 次意图：揭开笔记少一页的部分真相",
  "- 关键词：师门、笔记、主动",
  "",
  "## 不可违背事实",
  "| 类型 | ID | 内容 | 违反后果 |",
  "|---|---|---|---|",
  "| FACT | FACT-03 | 复苏之眼每日唤醒一次 | 世界观硬冲突 → FactGuard 阻断 |",
  "| OOC | OOC-02 | 林默不会出卖同伴 | 角色失真 |",
  "",
  "## 章末目标",
  "- 读者状态：读者应意识到苏雨一直在隐瞒",
  "- 主角位置：主角从被动挨打转为主动布局",
  "- 新问题：笔记为何少一页",
  "- 强制召回：不适用",
  "",
  "## 缺口自检",
  "| 项目 | 是否齐备 | 缺失时补什么 |",
  "|---|---|---|",
  "| 方向 | 是 | — |",
  "| 冲突 | 是 | — |",
  "| 状态 | 是 | — |",
  "",
  "status: ready",
  "",
  "## 事件",
  "### 事件 1：藏书阁受阻",
  "- **参与角色**：林默、守门人",
  "- **必须包含**：守门人索要身份令牌",
  "- **内容摘要**：林默被拦在藏书阁门外",
  "- **事件结果**：林默决定夜间潜入",
].join("\n");

function makeTempProject() {
  const root = mkdtempSync(join(tmpdir(), "expert-handoff-"));
  const workspacePath = join(root, "workspaces", "ws1");
  mkdirSync(join(workspacePath, "series"), { recursive: true });
  mkdirSync(join(workspacePath, "characters"), { recursive: true });
  writeFileSync(
    join(workspacePath, "config.json"),
    JSON.stringify({ workspaceId: "ws1", novelName: "测试书", genre: "仙侠" }),
    "utf8",
  );
  return { root, workspacePath };
}

test("EXPERT-HOST-HANDOFF-1 · 6 工具契约不变，专家子操作通过 workspace_manager 暴露", () => {
  const tools = registerTools({
    handleGenerateChapter: async () => ({}),
    handlePreflightWorkspace: async () => ({}),
    handleWorkspaceManager,
    handlePlanStoryOutline: async () => ({}),
    handleStrategyPolicyView: async () => ({}),
    handleStrategyFeedback: async () => ({}),
    handleBatchGeneration: async () => ({}),
  });
  assert.equal(tools.length, 6, "不得新增第 7 个公开工具");
  const ws = tools.find((tool) => tool.name === "novel_workspace_manager");
  assert.ok(ws);
  const actions = ws.parameters.properties.action.enum;
  for (const action of ["list_experts", "dispatch_expert", "handoff_chapter_contract"]) {
    assert.ok(actions.includes(action), `schema 必须暴露 ${action}`);
  }
  assert.deepEqual(ws.parameters.required, ["action"], "条件必填字段不得写成无条件 required");
});

test("list_experts 发现真实 10 个专家资产", () => {
  const result = handleExpertHandoff({ action: "list_experts", _agentsDir: AGENTS_DIR });
  assert.equal(result.status, "ok", JSON.stringify(result.registryIssues?.slice(0, 3)));
  assert.equal(result.registryOk, true);
  assert.equal(result.experts.length, 10);
  const names = result.experts.map((expert) => expert.name);
  assert.ok(names.includes("chapter-intent-builder"));
  assert.ok(names.includes("novel-director"));
});

test("dispatch_expert：未知角色 / 越权路径 / execute 模式 fail-closed", () => {
  const unknown = handleExpertHandoff({
    action: "dispatch_expert",
    expertRole: "unknown-role",
    objective: "写章纲",
    _agentsDir: AGENTS_DIR,
  });
  assert.equal(unknown.status, "error");
  assert.match(unknown.error, /未知专家角色/);

  const execute = handleExpertHandoff({
    action: "dispatch_expert",
    expertRole: "chapter-intent-builder",
    objective: "写章纲",
    executionMode: "execute",
    _agentsDir: AGENTS_DIR,
  });
  assert.equal(execute.status, "error");
  assert.match(execute.error, /expert_execution_requires_authorized_executor/);

  const env = handleExpertHandoff({
    action: "dispatch_expert",
    expertRole: "chapter-intent-builder",
    objective: "写章纲",
    inputPaths: [".env"],
    _agentsDir: AGENTS_DIR,
  });
  assert.equal(env.status, "error");
  assert.match(env.error, /path_env_denied/);

  const chapters = handleExpertHandoff({
    action: "dispatch_expert",
    expertRole: "chapter-intent-builder",
    objective: "写章纲",
    inputPaths: ["chapters/chapter-1.md"],
    _agentsDir: AGENTS_DIR,
  });
  assert.equal(chapters.status, "error");
  assert.match(chapters.error, /path_scope_denied/);
});

test("dispatch_expert：返回宿主任务包，零写入零模型调用", () => {
  const before = readFileSync(join(AGENTS_DIR, "chapter-intent-builder.md"), "utf8");
  const result = handleExpertHandoff({
    action: "dispatch_expert",
    expertRole: "chapter-intent-builder",
    objective: "为第 12 章产出章节契约提案",
    inputPaths: ["README.md"],
    expect: "章节契约提案 Markdown",
    chapterNumber: 12,
    _agentsDir: AGENTS_DIR,
  });
  assert.equal(result.status, "ok", result.error);
  assert.equal(result.execution.mode, "host_package");
  assert.equal(result.execution.executed, false);
  const pkg = result.expertPackage;
  assert.equal(pkg.name, "chapter-intent-builder");
  for (const section of ["【角色】", "【指令】", "【约束】", "【示例】", "【输出格式】"]) {
    assert.ok(pkg.systemPrompt.includes(section), `专家 system prompt 必须含 ${section}`);
  }
  assert.ok(pkg.taskMessage.includes("为第 12 章产出章节契约提案"));
  assert.ok(pkg.taskMessage.includes("## 【约束】"));
  assert.ok(pkg.tools.every((tool) => ["read", "grep", "find", "ls", "novel_workspace_manager", "novel_preflight_workspace", "novel_strategy_policy_view"].includes(tool)));
  // 带子操作的工具必须携带 action 白名单，宿主不能只看工具名放行。
  for (const entry of pkg.allowedActions) {
    assert.ok(pkg.tools.includes(entry.tool));
    assert.ok(entry.actions.length > 0);
    assert.ok(entry.actions.every((action) => !["init", "switch", "proxy_finalization", "ingest_reader_feedback", "record_return_chapter", "handoff_chapter_contract"].includes(action)));
  }
  assert.ok(pkg.authority.mayWriteFiles === false);
  assert.equal(result.promptBudget.exceeded, false);
  // 零写入：专家定义文件内容不变
  assert.equal(readFileSync(join(AGENTS_DIR, "chapter-intent-builder.md"), "utf8"), before);
});

test("handoff：preview 不写盘且不签发凭证；commit 需宿主签发的一次性凭证", async () => {
  const { root, workspacePath } = makeTempProject();
  const targetFile = join(workspacePath, "series", "ch12-outline-explicit.md");
  try {
    const preview = await handleWorkspaceManager({
      action: "handoff_chapter_contract",
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalText: PROPOSAL,
      handoffMode: "preview",
      knownFactIds: ["FACT-03", "OOC-02"],
      knownPromiseIds: [],
      expertRole: "chapter-intent-builder",
      _projectRoot: root,
    });
    assert.equal(preview.status, "ok", preview.error);
    assert.equal(preview.expertHandoff.wrote, false);
    assert.equal(existsSync(targetFile), false, "preview 不得写盘");
    // EXPERT-HOST-APPROVAL-1：preview 只校验/预览，不签发 commit 凭证。
    assert.equal(preview.expertHandoff.approvalReceipt, undefined, "preview 不得签发凭证");
    assert.equal(preview.expertHandoff.approvalRequired.issuer, "trusted_host");
    assert.equal(
      preview.expertHandoff.approvalRequired.proposalHash,
      preview.expertHandoff.proposalHash,
    );

    // 作者批准后由可信宿主审批层签发一次性凭证；工具调用方无法自行签发。
    const approval = issueChapterContractApproval({
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalHash: preview.expertHandoff.proposalHash,
      approvedBy: "作者-张三",
    });
    const receipt = approval.receiptId;

    const noConfirm = await handleWorkspaceManager({
      action: "handoff_chapter_contract",
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalText: PROPOSAL,
      handoffMode: "commit",
      knownFactIds: ["FACT-03", "OOC-02"],
      knownPromiseIds: [],
      expertRole: "chapter-intent-builder",
      _projectRoot: root,
    });
    assert.equal(noConfirm.status, "error");
    assert.match(noConfirm.error, /confirm=true/);

    // APPROVAL-RECEIPT-1：只有 confirm + confirmedBy 字符串不再构成授权。
    const stringOnly = await handleWorkspaceManager({
      action: "handoff_chapter_contract",
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalText: PROPOSAL,
      handoffMode: "commit",
      confirm: true,
      confirmedBy: "作者-张三",
      knownFactIds: ["FACT-03", "OOC-02"],
      knownPromiseIds: [],
      expertRole: "chapter-intent-builder",
      _projectRoot: root,
    });
    assert.equal(stringOnly.status, "blocked");
    assert.match(stringOnly.error, /approval_receipt_required/);
    assert.equal(existsSync(targetFile), false, "无凭证不得写盘");

    // 拿另一份提案的批准凭证不能签本提案：凭证绑定 proposalHash。
    const mismatched = issueChapterContractApproval({
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalHash: "not-this-proposal-hash",
      approvedBy: "作者-张三",
    });
    const mismatchCommit = await handleWorkspaceManager({
      action: "handoff_chapter_contract",
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalText: PROPOSAL,
      handoffMode: "commit",
      confirm: true,
      confirmedBy: "作者-张三",
      approvalReceipt: mismatched.receiptId,
      knownFactIds: ["FACT-03", "OOC-02"],
      knownPromiseIds: [],
      expertRole: "chapter-intent-builder",
      _projectRoot: root,
    });
    assert.equal(mismatchCommit.status, "blocked");
    assert.match(mismatchCommit.error, /approval_receipt_mismatch/);
    assert.equal(existsSync(targetFile), false, "错配凭证不得写盘");

    const commit = await handleWorkspaceManager({
      action: "handoff_chapter_contract",
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalText: PROPOSAL,
      handoffMode: "commit",
      confirm: true,
      confirmedBy: "作者-张三",
      approvalReceipt: receipt,
      knownFactIds: ["FACT-03", "OOC-02"],
      knownPromiseIds: [],
      expertRole: "chapter-intent-builder",
      _projectRoot: root,
    });
    assert.equal(commit.status, "ok", commit.error);
    assert.equal(commit.expertHandoff.wrote, true);
    assert.equal(commit.expertHandoff.targetPath, "series/ch12-outline-explicit.md");
    assert.ok(existsSync(targetFile));

    const written = readFileSync(targetFile, "utf8");
    const parsed = parseExplicitOutline(written);
    assert.equal(parsed.parseError, null);
    assert.equal(parsed.outlineEventCount, 1);
    assert.equal(parsed.events[0].title, "藏书阁受阻");

    const provenance = JSON.parse(readFileSync(`${targetFile}.provenance.json`, "utf8"));
    assert.equal(provenance.expertRole, "chapter-intent-builder");
    assert.equal(provenance.confirmedBy, "作者-张三");
    assert.equal(provenance.proposalHash, commit.expertHandoff.proposalHash);
    assert.equal(provenance.targetPath, "series/ch12-outline-explicit.md");
    assert.equal(provenance.approvalReceiptId, receipt);
    // 授权证明来自宿主审批层；confirmedBy 只是审计标签。
    assert.equal(provenance.approval.issuedBy, "trusted_host");
    assert.equal(provenance.approval.approvedBy, "作者-张三");
    assert.equal(provenance.approval.proposalHash, commit.expertHandoff.proposalHash);

    // 凭证单次使用：同一凭证不能再次提交（即使内容相同）。
    const replay = await handleWorkspaceManager({
      action: "handoff_chapter_contract",
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalText: PROPOSAL,
      handoffMode: "commit",
      confirm: true,
      confirmedBy: "作者-张三",
      approvalReceipt: receipt,
      knownFactIds: ["FACT-03", "OOC-02"],
      knownPromiseIds: [],
      _projectRoot: root,
    });
    assert.equal(replay.status, "blocked");
    assert.match(replay.error, /approval_receipt_invalid/);

    const { seed } = buildChapterSeed({
      workspacePath,
      workspaceId: "ws1",
      chapterId: "ch12",
      chapterNumber: 12,
    });
    assert.equal(seed.authorChapterContract.available, true);
    assert.deepEqual(seed.authorChapterContract.sourceIds, ["series/ch12-outline-explicit.md"]);
    assert.ok(seed.authorChapterContract.mustInclude.includes("守门人索要身份令牌"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff：内容不同且未 overwrite 时阻断，显式 overwrite 才覆盖", async () => {
  const { root, workspacePath } = makeTempProject();
  const targetFile = join(workspacePath, "series", "ch12-outline-explicit.md");
  try {
    const firstPreview = await handleWorkspaceManager({
      action: "handoff_chapter_contract",
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalText: PROPOSAL,
      handoffMode: "preview",
      knownFactIds: ["FACT-03", "OOC-02"],
      knownPromiseIds: [],
      _projectRoot: root,
    });
    assert.equal(firstPreview.status, "ok", firstPreview.error);
    const firstApproval = issueChapterContractApproval({
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalHash: firstPreview.expertHandoff.proposalHash,
      approvedBy: "作者-张三",
    });

    const first = await handleWorkspaceManager({
      action: "handoff_chapter_contract",
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalText: PROPOSAL,
      handoffMode: "commit",
      confirm: true,
      confirmedBy: "作者-张三",
      approvalReceipt: firstApproval.receiptId,
      knownFactIds: ["FACT-03", "OOC-02"],
      knownPromiseIds: [],
      _projectRoot: root,
    });
    assert.equal(first.status, "ok", first.error);

    const rewritten = PROPOSAL.replace("藏书阁受阻", "藏书阁夜探");
    const rewrittenPreview = await handleWorkspaceManager({
      action: "handoff_chapter_contract",
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalText: rewritten,
      handoffMode: "preview",
      knownFactIds: ["FACT-03", "OOC-02"],
      knownPromiseIds: [],
      _projectRoot: root,
    });
    assert.equal(rewrittenPreview.status, "ok", rewrittenPreview.error);
    const rewrittenApproval = issueChapterContractApproval({
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalHash: rewrittenPreview.expertHandoff.proposalHash,
      approvedBy: "作者-李四",
    });
    const rewrittenReceipt = rewrittenApproval.receiptId;

    const blocked = await handleWorkspaceManager({
      action: "handoff_chapter_contract",
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalText: rewritten,
      handoffMode: "commit",
      confirm: true,
      confirmedBy: "作者-李四",
      approvalReceipt: rewrittenReceipt,
      knownFactIds: ["FACT-03", "OOC-02"],
      knownPromiseIds: [],
      _projectRoot: root,
    });
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.error, /explicit_outline_exists/);
    assert.ok(readFileSync(targetFile, "utf8").includes("藏书阁受阻"), "未授权覆盖不得改动原文件");

    // 覆盖阻断不消耗凭证；显式 overwrite=true 后可用同一凭证完成覆盖。
    const overwritten = await handleWorkspaceManager({
      action: "handoff_chapter_contract",
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalText: rewritten,
      handoffMode: "commit",
      confirm: true,
      confirmedBy: "作者-李四",
      approvalReceipt: rewrittenReceipt,
      overwrite: true,
      knownFactIds: ["FACT-03", "OOC-02"],
      knownPromiseIds: [],
      _projectRoot: root,
    });
    assert.equal(overwritten.status, "ok", overwritten.error);
    assert.ok(readFileSync(targetFile, "utf8").includes("藏书阁夜探"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff：编造 FACT / PROMISE 与缺事件级契约均阻断", async () => {
  const { root } = makeTempProject();
  try {
    const fabricated = await handleWorkspaceManager({
      action: "handoff_chapter_contract",
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalText: PROPOSAL.replace("| FACT | FACT-03 |", "| FACT | FACT-99 |").replace("- 强制召回：不适用", "- 强制召回：PROMISE-01"),
      handoffMode: "commit",
      confirm: true,
      confirmedBy: "作者-张三",
      // 凭证无效也必须先被契约校验拦下：校验发生在授权消费之前。
      approvalReceipt: "not-a-real-receipt",
      knownFactIds: ["FACT-03", "OOC-02"],
      knownPromiseIds: [],
      _projectRoot: root,
    });
    assert.equal(fabricated.status, "blocked");
    const codes = fabricated.expertHandoff.validation.errors.map((issue) => issue.code);
    assert.ok(codes.includes("fabricated_fact_id"));
    assert.ok(codes.includes("promise_id_on_new_book"));

    const noEvents = await handleWorkspaceManager({
      action: "handoff_chapter_contract",
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalText: PROPOSAL.split("## 事件")[0],
      handoffMode: "preview",
      knownFactIds: ["FACT-03", "OOC-02"],
      knownPromiseIds: [],
      _projectRoot: root,
    });
    assert.equal(noEvents.status, "blocked");
    const eventCodes = noEvents.expertHandoff.validation.errors.map((issue) => issue.code);
    assert.ok(eventCodes.includes("events_required"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("宿主审批签发：approvedBy 必填，空审计标签不构成授权", () => {
  assert.throws(
    () => issueChapterContractApproval({
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalHash: "any-hash",
      approvedBy: "   ",
    }),
    /非空 approvedBy/,
  );
});

test("handoff 事务：provenance 写失败时章纲不落盘，凭证恢复可重试", async () => {
  const { root, workspacePath } = makeTempProject();
  const targetFile = join(workspacePath, "series", "ch12-outline-explicit.md");
  const provenanceFile = `${targetFile}.provenance.json`;
  try {
    const preview = await handleWorkspaceManager({
      action: "handoff_chapter_contract",
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalText: PROPOSAL,
      handoffMode: "preview",
      knownFactIds: ["FACT-03", "OOC-02"],
      knownPromiseIds: [],
      _projectRoot: root,
    });
    assert.equal(preview.status, "ok", preview.error);
    const approval = issueChapterContractApproval({
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalHash: preview.expertHandoff.proposalHash,
      approvedBy: "作者-张三",
    });

    // 人为制造 provenance 写入失败：只读目标文件在 Windows 上 rename 会 EPERM。
    writeFileSync(provenanceFile, JSON.stringify({ commitStatus: "prior" }), "utf8");
    chmodSync(provenanceFile, 0o444);
    // root 可绕过 chmod 只读位，ext4 上用 chattr +i 确保 provenance 写入真实失败。
    execFileSync("chattr", ["+i", provenanceFile]);

    const failed = await handleWorkspaceManager({
      action: "handoff_chapter_contract",
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalText: PROPOSAL,
      handoffMode: "commit",
      confirm: true,
      confirmedBy: "作者-张三",
      approvalReceipt: approval.receiptId,
      knownFactIds: ["FACT-03", "OOC-02"],
      knownPromiseIds: [],
      _projectRoot: root,
    });
    assert.equal(failed.status, "error");
    assert.match(failed.error, /handoff_commit_failed/);
    assert.match(failed.error, /已回滚/);
    // 事务未提交时不得出现“有章纲无 provenance”的孤儿文件。
    assert.equal(existsSync(targetFile), false, "provenance 失败时章纲不得落盘");
    assert.equal(readFileSync(provenanceFile, "utf8"), JSON.stringify({ commitStatus: "prior" }));
    // 一次性凭证未被消费：修正文件系统后可原样重试。
    execFileSync("chattr", ["-i", provenanceFile]);
    chmodSync(provenanceFile, 0o666);
    rmSync(provenanceFile, { force: true });
    const retried = await handleWorkspaceManager({
      action: "handoff_chapter_contract",
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalText: PROPOSAL,
      handoffMode: "commit",
      confirm: true,
      confirmedBy: "作者-张三",
      approvalReceipt: approval.receiptId,
      knownFactIds: ["FACT-03", "OOC-02"],
      knownPromiseIds: [],
      _projectRoot: root,
    });
    assert.equal(retried.status, "ok", retried.error);
    assert.ok(existsSync(targetFile));
    const committed = JSON.parse(readFileSync(provenanceFile, "utf8"));
    assert.equal(committed.commitStatus, "committed");
  } finally {
    try {
      execFileSync("chattr", ["-i", provenanceFile]);
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff 事务：章纲写失败保留可审计 failed 状态并允许凭证重试", async () => {
  const { root, workspacePath } = makeTempProject();
  const targetFile = join(workspacePath, "series", "ch12-outline-explicit.md");
  const provenanceFile = `${targetFile}.provenance.json`;
  try {
    const preview = await handleWorkspaceManager({
      action: "handoff_chapter_contract",
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalText: PROPOSAL,
      handoffMode: "preview",
      knownFactIds: ["FACT-03", "OOC-02"],
      knownPromiseIds: [],
      _projectRoot: root,
    });
    assert.equal(preview.status, "ok", preview.error);
    const approval = issueChapterContractApproval({
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalHash: preview.expertHandoff.proposalHash,
      approvedBy: "作者-张三",
    });

    // 已有章纲只读：pending provenance 可写，章纲 rename 失败。
    writeFileSync(targetFile, "旧章纲占位", "utf8");
    chmodSync(targetFile, 0o444);
    // root 可绕过 chmod 只读位，ext4 上用 chattr +i 确保章纲 rename 真实失败。
    execFileSync("chattr", ["+i", targetFile]);

    const failed = await handleWorkspaceManager({
      action: "handoff_chapter_contract",
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalText: PROPOSAL,
      handoffMode: "commit",
      confirm: true,
      confirmedBy: "作者-张三",
      approvalReceipt: approval.receiptId,
      overwrite: true,
      knownFactIds: ["FACT-03", "OOC-02"],
      knownPromiseIds: [],
      _projectRoot: root,
    });
    assert.equal(failed.status, "error");
    assert.match(failed.error, /handoff_commit_failed/);
    // 写入失败不破坏原文件内容。
    assert.equal(readFileSync(targetFile, "utf8"), "旧章纲占位");
    // 失败状态必须可审计，不能静默。
    const failureRecord = JSON.parse(readFileSync(provenanceFile, "utf8"));
    assert.equal(failureRecord.commitStatus, "failed");
    assert.equal(failureRecord.failure.outlineRolledBack, false);
    assert.ok(failureRecord.failure.message.length > 0);

    execFileSync("chattr", ["-i", targetFile]);
    chmodSync(targetFile, 0o666);
    const retried = await handleWorkspaceManager({
      action: "handoff_chapter_contract",
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalText: PROPOSAL,
      handoffMode: "commit",
      confirm: true,
      confirmedBy: "作者-张三",
      approvalReceipt: approval.receiptId,
      overwrite: true,
      knownFactIds: ["FACT-03", "OOC-02"],
      knownPromiseIds: [],
      _projectRoot: root,
    });
    assert.equal(retried.status, "ok", retried.error);
    assert.ok(readFileSync(targetFile, "utf8").includes("藏书阁受阻"));
    assert.equal(JSON.parse(readFileSync(provenanceFile, "utf8")).commitStatus, "committed");
  } finally {
    try {
      execFileSync("chattr", ["-i", targetFile]);
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * CRASH-RECOVERY-1：模拟“章纲已写入、committed provenance 尚未落盘”时进程终止。
 *
 * 通过直接把磁盘状态构造成崩溃点（章纲存在 + provenance pending），验证消费方
 * （buildChapterSeed → loadAuthorChapterContract）会对账修复而不是静默拒绝/消费。
 */
test("崩溃恢复：章纲写入后、provenance 提交前终止 → 消费方对账修复为 committed", async () => {
  const { root, workspacePath } = makeTempProject();
  const targetFile = join(workspacePath, "series", "ch12-outline-explicit.md");
  const provenanceFile = `${targetFile}.provenance.json`;
  try {
    const preview = await handleWorkspaceManager({
      action: "handoff_chapter_contract",
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalText: PROPOSAL,
      handoffMode: "preview",
      knownFactIds: ["FACT-03", "OOC-02"],
      knownPromiseIds: [],
      _projectRoot: root,
    });
    assert.equal(preview.status, "ok", preview.error);
    const { outlineMarkdown, proposalHash } = preview.expertHandoff;

    writeFileSync(targetFile, outlineMarkdown, "utf8");
    writeFileSync(
      provenanceFile,
      JSON.stringify({
        schemaVersion: 1,
        workspaceId: "ws1",
        chapterNumber: 12,
        targetPath: "series/ch12-outline-explicit.md",
        proposalHash,
        commitStatus: "pending",
        approval: { issuedBy: "trusted_host", approvedBy: "作者-张三", proposalHash },
      }, null, 2),
      "utf8",
    );

    // 消费方对账：pending + 章纲 hash 与批准提案一致 → 原子修复为 committed。
    const consumption = resolveChapterContractConsumption(targetFile, outlineMarkdown);
    assert.equal(consumption.consumable, true);
    assert.equal(consumption.state, "recovered");

    const { seed } = buildChapterSeed({
      workspacePath,
      workspaceId: "ws1",
      chapterId: "ch12",
      chapterNumber: 12,
    });
    assert.equal(seed.authorChapterContract.available, true);
    // 同一次 build 内存在多个消费点（高层方向 / 事件角色 / 写前契约），
    // 首个消费点完成对账后，后续消费点看到的是已提交状态。
    assert.equal(seed.authorChapterContract.provenanceState, "committed");
    assert.deepEqual(seed.authorChapterContract.sourceIds, ["series/ch12-outline-explicit.md"]);
    assert.ok(seed.authorChapterContract.mustInclude.includes("守门人索要身份令牌"));

    const reconciled = JSON.parse(readFileSync(provenanceFile, "utf8"));
    assert.equal(reconciled.commitStatus, "committed");
    assert.equal(reconciled.approval.approvedBy, "作者-张三", "对账不得丢弃审批审计字段");
    assert.equal(reconciled.reconciledBy, "chapter-contract-provenance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("崩溃恢复：章纲与批准提案 hash 不一致 → 拒绝消费并记 failed", async () => {
  const { root, workspacePath } = makeTempProject();
  const targetFile = join(workspacePath, "series", "ch12-outline-explicit.md");
  const provenanceFile = `${targetFile}.provenance.json`;
  try {
    const preview = await handleWorkspaceManager({
      action: "handoff_chapter_contract",
      workspaceId: "ws1",
      chapterNumber: 12,
      proposalText: PROPOSAL,
      handoffMode: "preview",
      knownFactIds: ["FACT-03", "OOC-02"],
      knownPromiseIds: [],
      _projectRoot: root,
    });
    assert.equal(preview.status, "ok", preview.error);
    const { outlineMarkdown, proposalHash } = preview.expertHandoff;
    // 与批准提案不一致（事务外被修改）。
    writeFileSync(targetFile, `${outlineMarkdown}\n\n<!-- 事务外篡改 -->\n`, "utf8");
    writeFileSync(
      provenanceFile,
      JSON.stringify({
        schemaVersion: 1,
        workspaceId: "ws1",
        chapterNumber: 12,
        targetPath: "series/ch12-outline-explicit.md",
        proposalHash,
        commitStatus: "pending",
      }, null, 2),
      "utf8",
    );

    // 消费方对账：hash 不一致 → 拒绝消费，并把 provenance 降级为 failed。
    const tampered = `${outlineMarkdown}\n\n<!-- 事务外篡改 -->\n`;
    const consumption = resolveChapterContractConsumption(targetFile, tampered);
    assert.equal(consumption.consumable, false);
    assert.equal(consumption.state, "mismatch");

    const { seed, warnings } = buildChapterSeed({
      workspacePath,
      workspaceId: "ws1",
      chapterId: "ch12",
      chapterNumber: 12,
    });
    assert.equal(seed.authorChapterContract.available, false);
    // 降级后再消费看到的是 failed（hash 不一致的原始原因保留在 failure.message）。
    assert.equal(seed.authorChapterContract.provenanceState, "failed");
    assert.ok(
      warnings.some((warning) => warning.includes("provenance 状态为 failed")),
      "必须显式警告，不得静默退化为无章纲",
    );

    const downgraded = JSON.parse(readFileSync(provenanceFile, "utf8"));
    assert.equal(downgraded.commitStatus, "failed");
    assert.equal(downgraded.failure.message, "outline_provenance_hash_mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("崩溃恢复：failed provenance 即使 hash 一致也拒绝消费", async () => {
  const { root, workspacePath } = makeTempProject();
  const targetFile = join(workspacePath, "series", "ch12-outline-explicit.md");
  const provenanceFile = `${targetFile}.provenance.json`;
  try {
    const markdown = PROPOSAL;
    const proposalHash = createHash("sha256").update(markdown, "utf8").digest("hex");
    writeFileSync(targetFile, markdown, "utf8");
    writeFileSync(
      provenanceFile,
      JSON.stringify({
        schemaVersion: 1,
        workspaceId: "ws1",
        chapterNumber: 12,
        proposalHash,
        commitStatus: "failed",
        failure: { message: "prior_commit_failed", outlineRolledBack: false, at: "2026-10-31T00:00:00.000Z" },
      }, null, 2),
      "utf8",
    );

    const { seed } = buildChapterSeed({
      workspacePath,
      workspaceId: "ws1",
      chapterId: "ch12",
      chapterNumber: 12,
    });
    assert.equal(seed.authorChapterContract.available, false);
    assert.equal(seed.authorChapterContract.provenanceState, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
