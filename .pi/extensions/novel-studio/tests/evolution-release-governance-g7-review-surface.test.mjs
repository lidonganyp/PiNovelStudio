/**
 * EVOLUTION-RELEASE-GOVERNANCE-G7 — Review Surface renderChapterProxyDraft 测试
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 / §12.2
 *
 * G7 Review Surface 切片要求（计划 §12.2）：
 * - Review Surface 默认只展示代理审批稿、审批摘要和风险
 * - 纯只读渲染层：不调用模型、不修改 finalText、不提交状态、不写 chapters/
 * - 输出不泄露 secret（API key / Bearer token / 模型内部推理 redacted）
 *
 * 本测试覆盖：
 * 1. draft + approval 都有 → status=ok，渲染正文 + 审批摘要 + 风险 + losing spans + rationale
 * 2. draft=null + approval=null → status=insufficient_data
 * 3. 只有 draft（无 approval）→ status=ok，渲染正文，不渲染审批摘要
 * 4. 只有 approval（HOLD_FOR_REGENERATION，无 draft）→ status=ok，渲染 HOLD 风险，不渲染正文
 * 5. redaction：draft 正文 / rationale / risks 含 sk-XXX / Bearer / <think> → 被 redact
 * 6. pending 状态展示（hasPending=true 显示守护阻断提示）
 * 7. command="show_proxy_draft"
 * 8. 审批摘要包含 finalStatus / recommendedSource / reviewerModel / reviewerModelVersion / decidedAt
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderChapterProxyDraft } from "../dist/v2/core/review-surface-cli.js";

// ============================================================================
// helpers
// ============================================================================

function makeDraft(overrides = {}) {
  return {
    approvalId: "cpa-draft-001",
    chapterId: "1",
    candidateId: "cand-raw-001",
    selectedSource: "raw",
    finalText: "这是代理审批稿的正文内容。\n第二段。",
    savedAt: "2026-07-16T00:00:00.000Z",
    draftFilePath: "/tmp/workspaces/ws/chapter-approvals/cpa-draft-001.draft.md",
    ...overrides,
  };
}

function makeApproval(overrides = {}) {
  return {
    schemaId: "pinovel.chapter-proxy-approval",
    schemaVersion: 1,
    approvalId: "cpa-draft-001",
    releaseId: "release-001",
    workspaceId: "ws-test",
    chapterId: "1",
    candidateIds: ["cand-raw-001", "cand-ed-001"],
    anonymousMapping: {
      forward: { A: "cand-raw-001", B: "cand-ed-001" },
      reverse: { A: "cand-ed-001", B: "cand-raw-001" },
      seed: 12345,
    },
    forwardVerdict: "PROXY_APPROVED",
    reverseVerdict: "PROXY_APPROVED",
    finalStatus: "PROXY_APPROVED",
    recommendedCandidateId: "cand-raw-001",
    recommendedSource: "raw",
    winningSpans: ["span-A-0-10"],
    losingSpans: ["span-B-0-8"],
    risks: ["editorial 候选对白密度偏高"],
    rationale: "raw 候选叙事推进更稳，editorial 对白过密。",
    reviewerType: "validated_human_proxy",
    reviewerModel: "gpt5.6-sol",
    reviewerModelVersion: "gpt5.6-sol-2026-07",
    promptHash: "hash-prompt-001",
    inputArtifactHash: "hash-input-001",
    decidedAt: "2026-07-16T00:00:00.000Z",
    budgetUsed: { calls: 2, timeoutMs: 60000 },
    ...overrides,
  };
}

// ============================================================================
// 1. draft + approval 都有 → ok
// ============================================================================

test("renderChapterProxyDraft: draft + approval 都有 → status=ok，渲染正文 + 审批摘要 + 风险", () => {
  const draft = makeDraft();
  const approval = makeApproval();
  const out = renderChapterProxyDraft({ draft, approval, hasPending: true });

  assert.equal(out.command, "show_proxy_draft");
  assert.equal(out.status, "ok");
  // 标题 + 标识
  assert.match(out.body, /=== Chapter Proxy Draft ===/);
  assert.match(out.body, /approvalId: cpa-draft-001/);
  assert.match(out.body, /chapterId: 1/);
  // pending 状态
  assert.match(out.body, /pending: 是/);
  assert.match(out.body, /commitAndSave/);
  // 审批摘要
  assert.match(out.body, /--- Approval Summary ---/);
  assert.match(out.body, /finalStatus: PROXY_APPROVED/);
  assert.match(out.body, /recommendedSource: raw/);
  assert.match(out.body, /recommendedCandidateId: cand-raw-001/);
  assert.match(out.body, /reviewerType: validated_human_proxy/);
  assert.match(out.body, /reviewerModel: gpt5.6-sol/);
  assert.match(out.body, /reviewerModelVersion: gpt5\.6-sol-2026-07/);
  assert.match(out.body, /decidedAt: 2026-07-16T00:00:00\.000Z/);
  // 风险
  assert.match(out.body, /--- Risks ---/);
  assert.match(out.body, /editorial 候选对白密度偏高/);
  // losing spans
  assert.match(out.body, /--- Losing Spans ---/);
  assert.match(out.body, /span-B-0-8/);
  // rationale
  assert.match(out.body, /--- Rationale ---/);
  assert.match(out.body, /raw 候选叙事推进更稳/);
  // 代理审批稿正文
  assert.match(out.body, /--- Proxy Draft Text ---/);
  assert.match(out.body, /candidateId: cand-raw-001/);
  assert.match(out.body, /selectedSource: raw/);
  assert.match(out.body, /这是代理审批稿的正文内容。/);
});

// ============================================================================
// 2. draft=null + approval=null → insufficient_data
// ============================================================================

test("renderChapterProxyDraft: draft=null + approval=null → status=insufficient_data", () => {
  const out = renderChapterProxyDraft({ draft: null, approval: null, hasPending: false });

  assert.equal(out.command, "show_proxy_draft");
  assert.equal(out.status, "insufficient_data");
  assert.match(out.body, /INSUFFICIENT DATA/);
  assert.equal(out.redactionLog.length, 0);
});

// ============================================================================
// 3. 只有 draft（无 approval）→ ok，渲染正文，不渲染审批摘要
// ============================================================================

test("renderChapterProxyDraft: 只有 draft（无 approval）→ status=ok，渲染正文，不渲染 Approval Summary", () => {
  const draft = makeDraft();
  const out = renderChapterProxyDraft({ draft, approval: null, hasPending: true });

  assert.equal(out.status, "ok");
  assert.match(out.body, /--- Proxy Draft Text ---/);
  assert.match(out.body, /这是代理审批稿的正文内容。/);
  // 不渲染审批摘要
  assert.doesNotMatch(out.body, /--- Approval Summary ---/);
  assert.doesNotMatch(out.body, /--- Risks ---/);
});

// ============================================================================
// 4. 只有 approval（HOLD_FOR_REGENERATION，无 draft）→ ok，渲染 HOLD 风险
// ============================================================================

test("renderChapterProxyDraft: approval=HOLD_FOR_REGENERATION 无 draft → status=ok，渲染 HOLD 风险，不渲染正文", () => {
  const approval = makeApproval({
    finalStatus: "HOLD_FOR_REGENERATION",
    forwardVerdict: "uncertain",
    reverseVerdict: "uncertain",
    recommendedSource: "system_selected",
  });
  const out = renderChapterProxyDraft({ draft: null, approval, hasPending: false });

  assert.equal(out.status, "ok");
  // 审批摘要显示 HOLD
  assert.match(out.body, /finalStatus: HOLD_FOR_REGENERATION/);
  // HOLD 风险
  assert.match(out.body, /\[BLOCK\] finalStatus=HOLD_FOR_REGENERATION/);
  assert.match(out.body, /要求重新生成/);
  // 不渲染正文
  assert.doesNotMatch(out.body, /--- Proxy Draft Text ---/);
});

// ============================================================================
// 5. redaction：draft 正文 / rationale / risks 含 secret → 被 redact
// ============================================================================

test("renderChapterProxyDraft: draft 正文含 sk-XXX API key → 被 redact，记录 redactionLog", () => {
  const draft = makeDraft({
    finalText: "正文中有 API key sk-abc123secret 出现。",
  });
  const out = renderChapterProxyDraft({ draft, approval: null, hasPending: false });

  assert.equal(out.status, "ok");
  // API key 被 redacted
  assert.doesNotMatch(out.body, /sk-abc123secret/);
  assert.match(out.body, /\[REDACTED:api-key\]/);
  assert.ok(out.redactionLog.length > 0, "redactionLog 应记录 API key redaction");
});

test("renderChapterProxyDraft: rationale 含 Bearer token → 被 redact", () => {
  const draft = makeDraft();
  const approval = makeApproval({
    rationale: "代理判断依据 Bearer xyz789token 不应泄漏。",
  });
  const out = renderChapterProxyDraft({ draft, approval, hasPending: false });

  assert.equal(out.status, "ok");
  assert.doesNotMatch(out.body, /Bearer xyz789token/);
  assert.match(out.body, /\[REDACTED:bearer-token\]/);
  assert.ok(out.redactionLog.some((l) => l.includes("bearer-token")));
});

test("renderChapterProxyDraft: risks 含 <think> 内部推理 → 被 redact", () => {
  const draft = makeDraft();
  const approval = makeApproval({
    risks: ["风险：<think>内部推理不应暴露</think>结束。"],
  });
  const out = renderChapterProxyDraft({ draft, approval, hasPending: false });

  assert.equal(out.status, "ok");
  assert.doesNotMatch(out.body, /内部推理不应暴露/);
  assert.match(out.body, /\[REDACTED:internal-reasoning\]/);
  assert.ok(out.redactionLog.some((l) => l.includes("internal-reasoning")));
});

// ============================================================================
// 6. pending 状态展示
// ============================================================================

test("renderChapterProxyDraft: hasPending=true 显示守护阻断提示；hasPending=false 显示否", () => {
  const draft = makeDraft();

  const outPending = renderChapterProxyDraft({ draft, approval: null, hasPending: true });
  assert.match(outPending.body, /pending: 是/);
  assert.match(outPending.body, /commitAndSave/);

  const outNoPending = renderChapterProxyDraft({ draft, approval: null, hasPending: false });
  assert.match(outNoPending.body, /pending: 否/);
});

// ============================================================================
// 7. command 恒为 show_proxy_draft
// ============================================================================

test("renderChapterProxyDraft: command 恒为 show_proxy_draft（所有路径）", () => {
  const draft = makeDraft();
  const approval = makeApproval();

  assert.equal(
    renderChapterProxyDraft({ draft, approval, hasPending: true }).command,
    "show_proxy_draft",
  );
  assert.equal(
    renderChapterProxyDraft({ draft: null, approval: null, hasPending: false }).command,
    "show_proxy_draft",
  );
  assert.equal(
    renderChapterProxyDraft({ draft, approval: null, hasPending: false }).command,
    "show_proxy_draft",
  );
  assert.equal(
    renderChapterProxyDraft({ draft: null, approval, hasPending: false }).command,
    "show_proxy_draft",
  );
});

// ============================================================================
// 8. 审批摘要字段完整性
// ============================================================================

test("renderChapterProxyDraft: 审批摘要包含 forward/reverse verdict 双向映射信息", () => {
  const draft = makeDraft();
  const approval = makeApproval({
    forwardVerdict: "PROXY_APPROVED",
    reverseVerdict: "PROXY_APPROVED",
  });
  const out = renderChapterProxyDraft({ draft, approval, hasPending: false });

  assert.match(out.body, /forwardVerdict: PROXY_APPROVED/);
  assert.match(out.body, /reverseVerdict: PROXY_APPROVED/);
});

test("renderChapterProxyDraft: 纯只读，不调用模型、不修改 finalText（输入 draft 不可变）", () => {
  const draft = makeDraft();
  const originalText = draft.finalText;
  const approval = makeApproval();

  renderChapterProxyDraft({ draft, approval, hasPending: true });

  // 输入对象不被修改（纯渲染层）
  assert.equal(draft.finalText, originalText);
  assert.equal(draft.approvalId, "cpa-draft-001");
});
