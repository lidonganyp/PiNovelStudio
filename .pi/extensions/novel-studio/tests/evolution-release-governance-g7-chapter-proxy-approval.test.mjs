/**
 * EVOLUTION-RELEASE-GOVERNANCE-G7 — 章节代理审批 schema + registry 测试
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 / §7 / Phase G7
 *
 * G7 要求（本章覆盖 schema + registry 基础）：
 * - ChapterProxyApproval 与 ReleaseProxyApproval 必须使用不同 schema、artifact 和 prompt；
 * - 正式章节代理审批在统一编排器完成 raw/editorial 候选、FactGuard 和 pairwise selection 后执行；
 * - 输入至少包含 raw、系统选定稿和必要时的其他 eligible editorial 候选；
 * - 不暴露候选类型、系统 winner、策略名称和生产 judge 结论；
 * - 使用正向与反向顺序复判；
 * - 明确胜出时输出 proxy_approved_draft；结论不清时输出 HOLD_FOR_REGENERATION；
 * - 代理不得直接提交长期状态或覆盖正式章节文件。
 *
 * ChapterProxyApproval 至少记录（计划 §6.3）：
 * - releaseId、workspace、chapterId、candidateIds；
 * - 匿名映射与正反顺序 verdict；
 * - recommendedCandidateId 和 recommendedSource；
 * - winning/losing spans、风险、rationale；
 * - reviewerModel/version、prompt hash、输入 artifact hash；
 * - status=PROXY_APPROVED | HOLD_FOR_REGENERATION。
 *
 * 本测试覆盖：
 * 1. schema 常量与类型隔离（与 ReleaseProxyApproval 不同 schemaId）
 * 2. validateChapterApprovalArtifact：合法 artifact 通过
 * 3. validateChapterApprovalArtifact：reviewerType=natural_person 拒绝
 * 4. validateChapterApprovalArtifact：reviewerModel 非 gpt5.6-sol 拒绝
 * 5. validateChapterApprovalArtifact：forward≠reverse → status=HOLD_FOR_REGENERATION
 * 6. validateChapterApprovalArtifact：缺字段拒绝
 * 7. registry：append-only，同 approvalId 拒绝覆盖
 * 8. registry：loadArtifact / listArtifactsByChapter / listArtifactsByRelease
 * 9. computeChapterApprovalArtifactHash：排除 decidedAt 非行为字段
 * 10. 边界：不依赖 ReleaseProxyApproval 模块（schema 隔离）
 *
 * P0 artifact-integrity 负向覆盖（G7-P0-ARTIFACT-INTEGRITY-1）：
 * 11. registry：approvalId 目录穿越（'../escaped' / 分隔符 / 点 / 空格）拒绝写入与读取
 * 12. schema：两轮均 HOLD_FOR_REGENERATION 但 finalStatus=PROXY_APPROVED 拒绝（防伪造通过）
 * 13. schema：recommendedCandidateId / anonymousMapping A/B 不在 candidateIds 拒绝（ghost 候选）
 * 14. schema：anonymousMapping.reverse 未真正交换 forward A/B 拒绝（防未反转映射伪造）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHAPTER_PROXY_APPROVAL_SCHEMA_ID,
  CHAPTER_PROXY_APPROVAL_SCHEMA_VERSION,
  CHAPTER_PROXY_APPROVAL_REVIEWER_MODEL,
  validateChapterApprovalArtifact,
  normalizeChapterVerdict,
  computeChapterApprovalArtifactHash,
} from "../dist-test/v2/governance/chapter-proxy-approval-schema.js";
import { createChapterProxyApprovalRegistry } from "../dist-test/v2/governance/chapter-proxy-approval-registry.js";

// 验证 schema 隔离：ChapterProxyApproval 与 ReleaseProxyApproval 不同 schemaId
import { PROXY_APPROVAL_SCHEMA_ID as RELEASE_SCHEMA_ID } from "../dist-test/v2/governance/release-proxy-approval-types.js";

// ============================================================================
// helpers
// ============================================================================

function makeValidArtifact(overrides = {}) {
  return {
    schemaId: CHAPTER_PROXY_APPROVAL_SCHEMA_ID,
    schemaVersion: CHAPTER_PROXY_APPROVAL_SCHEMA_VERSION,
    approvalId: "cpa-test-001",
    releaseId: "rel-001",
    workspaceId: "ws-1",
    chapterId: "ch-1",
    candidateIds: ["cand-raw", "cand-edit-1"],
    anonymousMapping: {
      forward: { A: "cand-raw", B: "cand-edit-1" },
      reverse: { A: "cand-edit-1", B: "cand-raw" },
      seed: 42,
    },
    forwardVerdict: "PROXY_APPROVED",
    reverseVerdict: "PROXY_APPROVED",
    finalStatus: "PROXY_APPROVED",
    recommendedCandidateId: "cand-edit-1",
    recommendedSource: "editorial",
    winningSpans: ["span-1"],
    losingSpans: ["span-2"],
    risks: ["minor risk"],
    rationale: "editorial candidate preserves event framework and improves pacing",
    reviewerType: "validated_human_proxy",
    reviewerModel: CHAPTER_PROXY_APPROVAL_REVIEWER_MODEL,
    reviewerModelVersion: "gpt5.6-sol-2026-07",
    promptHash: "sha256-prompt-abc",
    inputArtifactHash: "sha256-input-def",
    decidedAt: "2026-07-16T00:00:00.000Z",
    budgetUsed: { calls: 2, timeoutMs: 60000 },
    ...overrides,
  };
}

// ============================================================================
// 1. schema 常量与类型隔离
// ============================================================================

test("schema: CHAPTER_PROXY_APPROVAL_SCHEMA_ID 与 ReleaseProxyApproval 不同（隔离）", () => {
  assert.equal(typeof CHAPTER_PROXY_APPROVAL_SCHEMA_ID, "string");
  assert.ok(CHAPTER_PROXY_APPROVAL_SCHEMA_ID.length > 0);
  assert.equal(CHAPTER_PROXY_APPROVAL_SCHEMA_VERSION, 1);
  assert.notEqual(
    CHAPTER_PROXY_APPROVAL_SCHEMA_ID,
    RELEASE_SCHEMA_ID,
    "ChapterProxyApproval 必须使用独立 schemaId，不得复用 ReleaseProxyApproval",
  );
  assert.equal(
    CHAPTER_PROXY_APPROVAL_REVIEWER_MODEL,
    "gpt5.6-sol",
    "章节代理审批模型必须为 gpt5.6-sol",
  );
});

// ============================================================================
// 2-6. validateChapterApprovalArtifact
// ============================================================================

test("validate: 合法 artifact 通过", () => {
  const artifact = makeValidArtifact();
  const result = validateChapterApprovalArtifact(artifact);
  assert.equal(result.ok, true, `合法 artifact 应通过，实际: ${result.ok ? "" : result.error?.message}`);
  assert.equal(result.artifact.approvalId, "cpa-test-001");
});

test("validate: reviewerType=natural_person 拒绝（防止把模型审批伪装成自然人）", () => {
  const artifact = makeValidArtifact({ reviewerType: "natural_person" });
  const result = validateChapterApprovalArtifact(artifact);
  assert.equal(result.ok, false);
  assert.match(
    result.error.code,
    /invalid_reviewer_type|natural_person/i,
    `应拒绝 natural_person reviewerType，实际 code: ${result.error.code}`,
  );
});

test("validate: reviewerModel 非 gpt5.6-sol 拒绝", () => {
  const artifact = makeValidArtifact({ reviewerModel: "gpt-4o" });
  const result = validateChapterApprovalArtifact(artifact);
  assert.equal(result.ok, false);
  assert.match(
    result.error.code,
    /invalid_reviewer_model/i,
    `应拒绝非 gpt5.6-sol reviewerModel，实际 code: ${result.error.code}`,
  );
});

test("validate: forward≠reverse → finalStatus 必须为 HOLD_FOR_REGENERATION", () => {
  const artifact = makeValidArtifact({
    forwardVerdict: "PROXY_APPROVED",
    reverseVerdict: "HOLD_FOR_REGENERATION",
    finalStatus: "PROXY_APPROVED",
  });
  const result = validateChapterApprovalArtifact(artifact);
  assert.equal(result.ok, false, "forward≠reverse 但 finalStatus=PROXY_APPROVED 应拒绝");
  assert.match(
    result.error.code,
    /forward_reverse_mismatch|hold_for_regeneration|proxy_approved_requires_both_approve/i,
    `应检测 forward/reverse 不一致，实际 code: ${result.error.code}`,
  );
});

test("validate: forward≠reverse + finalStatus=HOLD_FOR_REGENERATION 通过", () => {
  const artifact = makeValidArtifact({
    forwardVerdict: "PROXY_APPROVED",
    reverseVerdict: "HOLD_FOR_REGENERATION",
    finalStatus: "HOLD_FOR_REGENERATION",
  });
  const result = validateChapterApprovalArtifact(artifact);
  assert.equal(result.ok, true, "forward≠reverse + HOLD_FOR_REGENERATION 应通过");
});

test("validate: 缺少必填字段拒绝", () => {
  const artifact = makeValidArtifact();
  delete artifact.releaseId;
  const result = validateChapterApprovalArtifact(artifact);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "missing_field");
  assert.match(result.error.path, /releaseId/);
});

test("validate: schemaId 未知拒绝", () => {
  const artifact = makeValidArtifact({ schemaId: "unknown.schema" });
  const result = validateChapterApprovalArtifact(artifact);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unknown_schema");
});

test("validate: finalStatus 非法值拒绝", () => {
  const artifact = makeValidArtifact({ finalStatus: "APPROVE_DEV" });
  const result = validateChapterApprovalArtifact(artifact);
  assert.equal(result.ok, false);
  assert.match(result.error.code, /invalid_status|invalid_final_status/i);
});

// ============================================================================
// normalizeChapterVerdict
// ============================================================================

test("normalizeVerdict: slight/uncertain/order_sensitive → HOLD_FOR_REGENERATION", () => {
  assert.equal(normalizeChapterVerdict("slight_win"), "HOLD_FOR_REGENERATION");
  assert.equal(normalizeChapterVerdict("uncertain"), "HOLD_FOR_REGENERATION");
  assert.equal(normalizeChapterVerdict("order_sensitive"), "HOLD_FOR_REGENERATION");
  assert.equal(normalizeChapterVerdict("conflict"), "HOLD_FOR_REGENERATION");
  assert.equal(normalizeChapterVerdict("PROXY_APPROVED"), "PROXY_APPROVED");
  assert.equal(normalizeChapterVerdict("HOLD_FOR_REGENERATION"), "HOLD_FOR_REGENERATION");
});

// ============================================================================
// 7-8. registry
// ============================================================================

test("registry: append-only，同 approvalId 拒绝覆盖", () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-registry-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const artifact = makeValidArtifact();
    registry.writeArtifact(artifact);
    assert.throws(
      () => registry.writeArtifact(artifact),
      /approvalId.*already exists|重复/i,
      "同 approvalId 重复写入应拒绝",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry: loadArtifact / listArtifactsByChapter / listArtifactsByRelease", () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-registry-list-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const a1 = makeValidArtifact({
      approvalId: "cpa-001",
      chapterId: "ch-1",
      releaseId: "rel-001",
    });
    const a2 = makeValidArtifact({
      approvalId: "cpa-002",
      chapterId: "ch-1",
      releaseId: "rel-002",
    });
    const a3 = makeValidArtifact({
      approvalId: "cpa-003",
      chapterId: "ch-2",
      releaseId: "rel-001",
    });
    registry.writeArtifact(a1);
    registry.writeArtifact(a2);
    registry.writeArtifact(a3);

    // loadArtifact
    const loaded = registry.loadArtifact("cpa-001");
    assert.ok(loaded, "loadArtifact 应返回已写入 artifact");
    assert.equal(loaded.approvalId, "cpa-001");

    // listArtifactsByChapter
    const byChapter = registry.listArtifactsByChapter("ws-1", "ch-1");
    assert.equal(byChapter.length, 2, "ch-1 应有 2 个 artifact");

    // listArtifactsByRelease
    const byRelease = registry.listArtifactsByRelease("rel-001");
    assert.equal(byRelease.length, 2, "rel-001 应有 2 个 artifact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 9. computeChapterApprovalArtifactHash
// ============================================================================

test("computeHash: 排除 decidedAt 非行为字段", () => {
  const a1 = makeValidArtifact({ decidedAt: "2026-07-16T00:00:00.000Z" });
  const a2 = makeValidArtifact({ decidedAt: "2026-07-17T12:00:00.000Z" });
  const hash1 = computeChapterApprovalArtifactHash(a1);
  const hash2 = computeChapterApprovalArtifactHash(a2);
  assert.equal(
    hash1,
    hash2,
    "仅 decidedAt 不同时 hash 应一致（非行为字段不计入）",
  );
  assert.match(hash1, /^[0-9a-f]{64}$/i, "hash 应为 64 位 hex");
});

test("computeHash: 任一行为字段变化 → hash 变化", () => {
  const a1 = makeValidArtifact();
  const a2 = makeValidArtifact({ recommendedCandidateId: "cand-raw" });
  const hash1 = computeChapterApprovalArtifactHash(a1);
  const hash2 = computeChapterApprovalArtifactHash(a2);
  assert.notEqual(hash1, hash2, "recommendedCandidateId 变化应导致 hash 变化");
});

// ============================================================================
// P0 artifact-integrity 负向测试（G7-P0-ARTIFACT-INTEGRITY-1）
//
// 覆盖三个 P0：
// - approvalId 目录穿越：registry 写入/读取/查询入口必须拒绝非法字符与穿越路径
// - 伪造 PROXY_APPROVED：两轮均 HOLD_FOR_REGENERATION 时 finalStatus=PROXY_APPROVED 必须拒绝
// - 候选关系交叉校验：recommendedCandidateId / anonymousMapping A/B 必须属于 candidateIds，
//   reverse 必须真正交换 forward A/B
// ============================================================================

// ----------------------------------------------------------------------------
// P0 #1: approvalId 目录穿越防护（registry）
// ----------------------------------------------------------------------------

test("P0 registry: approvalId='../escaped' 拒绝写入且不在 approvalsDir 外创建文件", () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-traversal-"));
  try {
    const approvalsDir = join(root, "chapter-approvals");
    const registry = createChapterProxyApprovalRegistry({ approvalsDir });
    const artifact = makeValidArtifact({ approvalId: "../escaped" });
    assert.throws(
      () => registry.writeArtifact(artifact),
      /非法字符|路径穿越|approvalId/i,
      "approvalId='../escaped' 必须被拒绝",
    );
    // approvalsDir 外不得创建任何文件
    assert.equal(existsSync(join(root, "escaped.json")), false, "不得在 approvalsDir 外创建 escaped.json");
    // approvalsDir 内也不得残留 artifact 文件（schema 校验在 path 之前，但 path 抛错应阻断写入）
    if (existsSync(approvalsDir)) {
      const leftover = readdirSync(approvalsDir).filter((f) => f.endsWith(".json"));
      assert.deepEqual(leftover, [], "approvalsDir 内不得残留 ../escaped 写入产物");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0 registry: approvalId 含路径分隔符/点/空格/冒号拒绝写入", () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-charset-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const badIds = ["a/b", "a\\b", "a.b", "a b", "..", ".", "a:b", ""];
    for (const badId of badIds) {
      const artifact = makeValidArtifact({ approvalId: badId });
      assert.throws(
        () => registry.writeArtifact(artifact),
        /非法字符|路径穿越|approvalId/i,
        `approvalId=${JSON.stringify(badId)} 必须被拒绝`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0 registry: loadArtifact 拒绝目录穿越 ID", () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-load-traversal-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    assert.throws(
      () => registry.loadArtifact("../escaped"),
      /非法字符|路径穿越|approvalId/i,
      "loadArtifact('../escaped') 必须被拒绝",
    );
    assert.throws(
      () => registry.loadArtifact("a/b"),
      /非法字符|路径穿越|approvalId/i,
      "loadArtifact('a/b') 必须被拒绝",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0 registry: 合法字符 approvalId 通过（白名单边界：字母/数字/dash/underscore）", () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-valid-charset-"));
  try {
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(root, "chapter-approvals"),
    });
    const artifact = makeValidArtifact({ approvalId: "cpa_valid-001" });
    registry.writeArtifact(artifact);
    const loaded = registry.loadArtifact("cpa_valid-001");
    assert.ok(loaded, "合法字符 approvalId 应能写入并读取");
    assert.equal(loaded.approvalId, "cpa_valid-001");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// P0 #2: PROXY_APPROVED 必须两轮均明确批准（防 HOLD 伪造通过）
// ----------------------------------------------------------------------------

test("P0 schema: 两轮均 HOLD_FOR_REGENERATION 但 finalStatus=PROXY_APPROVED 拒绝", () => {
  const artifact = makeValidArtifact({
    forwardVerdict: "HOLD_FOR_REGENERATION",
    reverseVerdict: "HOLD_FOR_REGENERATION",
    finalStatus: "PROXY_APPROVED",
  });
  const result = validateChapterApprovalArtifact(artifact);
  assert.equal(result.ok, false, "两轮 HOLD 但 finalStatus=PROXY_APPROVED 必须拒绝（防伪造通过）");
  assert.equal(
    result.error.code,
    "proxy_approved_requires_both_approve",
    `error.code 应为 proxy_approved_requires_both_approve，实际: ${result.error.code}`,
  );
});

test("P0 schema: forward=PROXY_APPROVED, reverse=HOLD, finalStatus=PROXY_APPROVED 拒绝", () => {
  const artifact = makeValidArtifact({
    forwardVerdict: "PROXY_APPROVED",
    reverseVerdict: "HOLD_FOR_REGENERATION",
    finalStatus: "PROXY_APPROVED",
  });
  const result = validateChapterApprovalArtifact(artifact);
  assert.equal(result.ok, false, "forward≠reverse 且 finalStatus=PROXY_APPROVED 必须拒绝");
  assert.match(
    result.error.code,
    /forward_reverse_mismatch|proxy_approved_requires_both_approve/,
    `应由 forward/reverse 不一致或 PROXY_APPROVED 双批准校验拒绝，实际 code: ${result.error.code}`,
  );
});

test("P0 schema: 两轮均 PROXY_APPROVED + finalStatus=PROXY_APPROVED 通过（合法路径）", () => {
  const artifact = makeValidArtifact({
    forwardVerdict: "PROXY_APPROVED",
    reverseVerdict: "PROXY_APPROVED",
    finalStatus: "PROXY_APPROVED",
  });
  const result = validateChapterApprovalArtifact(artifact);
  assert.equal(result.ok, true, "两轮均 PROXY_APPROVED 应通过（合法双批准）");
});

// ----------------------------------------------------------------------------
// P0 #3: 候选关系交叉校验（防 ghost 候选与未反转映射伪造）
// ----------------------------------------------------------------------------

test("P0 schema: recommendedCandidateId 不在 candidateIds 中拒绝（ghost 候选）", () => {
  const artifact = makeValidArtifact({ recommendedCandidateId: "ghost-cand" });
  const result = validateChapterApprovalArtifact(artifact);
  assert.equal(result.ok, false, "ghost recommendedCandidateId 必须拒绝");
  assert.equal(
    result.error.code,
    "recommended_candidate_not_in_list",
    `error.code 应为 recommended_candidate_not_in_list，实际: ${result.error.code}`,
  );
});

test("P0 schema: anonymousMapping.forward.B 不在 candidateIds 中拒绝", () => {
  const artifact = makeValidArtifact({
    anonymousMapping: {
      forward: { A: "cand-raw", B: "ghost-cand" },
      reverse: { A: "ghost-cand", B: "cand-raw" },
      seed: 42,
    },
  });
  const result = validateChapterApprovalArtifact(artifact);
  assert.equal(result.ok, false, "anonymousMapping 含 ghost 候选必须拒绝");
  assert.equal(
    result.error.code,
    "anonymous_mapping_candidate_not_in_list",
    `error.code 应为 anonymous_mapping_candidate_not_in_list，实际: ${result.error.code}`,
  );
});

test("P0 schema: anonymousMapping.reverse.A 不在 candidateIds 中拒绝", () => {
  const artifact = makeValidArtifact({
    anonymousMapping: {
      forward: { A: "cand-raw", B: "cand-edit-1" },
      reverse: { A: "ghost-cand", B: "cand-raw" },
      seed: 42,
    },
  });
  const result = validateChapterApprovalArtifact(artifact);
  assert.equal(result.ok, false, "anonymousMapping.reverse 含 ghost 候选必须拒绝");
  assert.equal(
    result.error.code,
    "anonymous_mapping_candidate_not_in_list",
    `error.code 应为 anonymous_mapping_candidate_not_in_list，实际: ${result.error.code}`,
  );
});

test("P0 schema: anonymousMapping.reverse 未交换 forward A/B 拒绝（防未反转映射伪造）", () => {
  const artifact = makeValidArtifact({
    anonymousMapping: {
      forward: { A: "cand-raw", B: "cand-edit-1" },
      // 未交换：reverse.A 应为 forward.B='cand-edit-1'，实际写成 forward.A
      reverse: { A: "cand-raw", B: "cand-edit-1" },
      seed: 42,
    },
  });
  const result = validateChapterApprovalArtifact(artifact);
  assert.equal(result.ok, false, "reverse 未交换 forward A/B 必须拒绝");
  assert.equal(
    result.error.code,
    "anonymous_mapping_not_reversed",
    `error.code 应为 anonymous_mapping_not_reversed，实际: ${result.error.code}`,
  );
});

test("P0 schema: 合法 anonymousMapping（reverse 真正交换 forward A/B）通过", () => {
  const artifact = makeValidArtifact({
    anonymousMapping: {
      forward: { A: "cand-raw", B: "cand-edit-1" },
      reverse: { A: "cand-edit-1", B: "cand-raw" },
      seed: 42,
    },
  });
  const result = validateChapterApprovalArtifact(artifact);
  assert.equal(result.ok, true, "reverse 真正交换 forward A/B 应通过");
});
