/**
 * DATA-VERSION-RELEASE-GOVERNANCE DG-5 — 发布生命周期与权限收敛 (RED)
 *
 * 真相源：docs/data-version-release-governance-development-plan-20260813.md §5 DG-5
 * 任务卡：DG-5「发布生命周期与权限收敛」
 *
 * 验收点（任务卡“必须测试”）：
 * - 未批准 pointer 切换为 0（production pointer 仅 user + manifest 就绪，由 release-pointer-store 强制）
 * - 双 active 直接失败（active_prod 单例约束）
 * - 越权 canary 直接阻断（workspace 授权 + 时限 + 退出条件，由 canary-*.ts 强制）
 * - R3 无用户批准不能晋级（变更风险分级门禁：R2/R3 要求完整 Eval + Replay + 人工批准）
 * - 固化状态迁移与每个状态的可写字段
 * - 代理只能产生准入建议，不能自行切换 pointer / 晋级生产
 * - 单次用户反馈只能写入章节/策略证据与健康报告，不得直接切换生产基线
 *
 * 边界（READY_LOCAL）：
 * - 纯函数，无 fs / 无模型 / 无副作用
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getWritableFields,
  assertFieldsWritable,
  evaluatePromotionPermission,
  assertActiveProdSingleton,
  evaluateProxyPermission,
  LIFECYCLE_FIELDS,
} from "../dist-test/v2/governance/release-lifecycle-permissions.js";
import { singleFeedbackCanSwitchProductionBaseline } from "../dist-test/v2/learning/strategy-promotion-governance.js";

// ============================================================================
// 1. 每个状态的可写字段矩阵
// ============================================================================

test("DG-5: draft/candidate 可写全部字段（草拟阶段）", () => {
  for (const status of ["draft", "candidate"]) {
    const writable = new Set(getWritableFields(status));
    for (const f of [...LIFECYCLE_FIELDS, "bundleId", "modelVersion", "changeClass", "claims"]) {
      assert.ok(writable.has(f), `${status} 应可写字段 ${f}`);
    }
  }
});

test("DG-5: frozen 后仅生命周期字段可写，行为字段被锁定", () => {
  for (const status of [
    "frozen",
    "evaluated",
    "approved_dev",
    "active_dev",
    "candidate_prod",
    "active_prod",
    "held",
  ]) {
    const writable = new Set(getWritableFields(status));
    for (const f of LIFECYCLE_FIELDS) {
      assert.ok(writable.has(f), `${status} 应可写生命周期字段 ${f}`);
    }
    // 行为字段全部锁定
    for (const f of ["bundleId", "modelVersion", "promptBundleHash", "changeClass", "claims", "environmentFingerprint"]) {
      assert.ok(!writable.has(f), `${status} 不得写行为字段 ${f}`);
    }
  }
});

test("DG-5: 终态不可原地写任何字段（需新 releaseId）", () => {
  for (const status of ["rejected", "quarantined", "revoked", "retired"]) {
    assert.deepEqual(getWritableFields(status), [], `${status} 应无任何可写字段`);
  }
});

test("DG-5: assertFieldsWritable 拒绝 frozen 状态下写行为字段", () => {
  const res = assertFieldsWritable("frozen", ["status", "bundleId", "modelVersion"]);
  assert.equal(res.ok, false);
  assert.deepEqual(res.blockedFields, ["bundleId", "modelVersion"]);

  const okRes = assertFieldsWritable("frozen", ["status", "approvalRef"]);
  assert.equal(okRes.ok, true);
  assert.deepEqual(okRes.blockedFields, []);
});

// ============================================================================
// 2. 变更风险分级门禁（R2/R3 要求完整 Eval + Replay + 人工批准）
// ============================================================================

test("DG-5: R3 无用户批准/缺 Eval/Replay → 不能晋级", () => {
  // 缺全部 R3 证据
  const res = evaluatePromotionPermission({
    changeClass: "R3",
    actor: "system",
    targetStatus: "active_prod",
    hasEvalReport: false,
    hasReplayReport: false,
    hasHumanApproval: false,
    approvalRef: null,
  });
  assert.equal(res.ok, false);
  assert.ok(res.missingEvidence.includes("actor=user"));
  assert.ok(res.missingEvidence.includes("approvalRef"));
  assert.ok(res.missingEvidence.includes("evalReport"));
  assert.ok(res.missingEvidence.includes("replayReport"));
  assert.ok(res.missingEvidence.includes("humanApproval"));
});

test("DG-5: R3 有 user + approvalRef 但缺 Eval/Replay → 仍不能晋级", () => {
  const res = evaluatePromotionPermission({
    changeClass: "R3",
    actor: "user",
    targetStatus: "active_prod",
    hasEvalReport: false,
    hasReplayReport: false,
    hasHumanApproval: true,
    approvalRef: "apr-1",
  });
  assert.equal(res.ok, false);
  assert.ok(res.missingEvidence.includes("evalReport"));
  assert.ok(res.missingEvidence.includes("replayReport"));
});

test("DG-5: R2 缺 Replay → 不能晋级", () => {
  const res = evaluatePromotionPermission({
    changeClass: "R2",
    actor: "user",
    targetStatus: "candidate_prod",
    hasEvalReport: true,
    hasReplayReport: false,
    hasHumanApproval: true,
    approvalRef: "apr-1",
  });
  assert.equal(res.ok, false);
  assert.ok(res.missingEvidence.includes("replayReport"));
});

test("DG-5: R3 完整证据（Eval+Replay+人工批准+user+approvalRef）→ 晋级", () => {
  const res = evaluatePromotionPermission({
    changeClass: "R3",
    actor: "user",
    targetStatus: "active_prod",
    hasEvalReport: true,
    hasReplayReport: true,
    hasHumanApproval: true,
    approvalRef: "apr-1",
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.missingEvidence, []);
});

test("DG-5: R1 低风险仅需 user + approvalRef，无需 Eval/Replay", () => {
  const res = evaluatePromotionPermission({
    changeClass: "R1",
    actor: "user",
    targetStatus: "candidate_prod",
    hasEvalReport: false,
    hasReplayReport: false,
    hasHumanApproval: false,
    approvalRef: "apr-1",
  });
  assert.equal(res.ok, true);
});

test("DG-5: R0/R1 晋级 active_prod 仍需人工批准", () => {
  const res = evaluatePromotionPermission({
    changeClass: "R0",
    actor: "user",
    targetStatus: "active_prod",
    hasEvalReport: false,
    hasReplayReport: false,
    hasHumanApproval: false,
    approvalRef: "apr-1",
  });
  assert.equal(res.ok, false);
  assert.ok(res.missingEvidence.includes("humanApproval"));
});

// ============================================================================
// 3. active_prod 单例约束
// ============================================================================

test("DG-5: 无其他 active_prod → 允许晋级（单例不冲突）", () => {
  const res = assertActiveProdSingleton(
    [
      { releaseId: "rel-1", status: "candidate_prod" },
      { releaseId: "rel-2", status: "active_dev" },
    ],
    "rel-2",
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.conflictingReleaseIds, []);
});

test("DG-5: 双 active 直接失败（存在其他 active_prod）", () => {
  const res = assertActiveProdSingleton(
    [
      { releaseId: "rel-old", status: "active_prod" },
      { releaseId: "rel-new", status: "candidate_prod" },
    ],
    "rel-new",
  );
  assert.equal(res.ok, false);
  assert.deepEqual(res.conflictingReleaseIds, ["rel-old"]);
});

test("DG-5: 同一 releaseId 的 reaffirm 不视为双 active 冲突", () => {
  const res = assertActiveProdSingleton(
    [{ releaseId: "rel-a", status: "active_prod" }],
    "rel-a",
  );
  assert.equal(res.ok, true);
});

// ============================================================================
// 4. 代理仅能产生准入建议
// ============================================================================

test("DG-5: 代理可产生准入建议（recommend）", () => {
  const res = evaluateProxyPermission("gpt5.6-sol-proxy", "recommend");
  assert.equal(res.ok, true);
});

test("DG-5: 代理不得切换 production pointer", () => {
  const res = evaluateProxyPermission("gpt5.6-sol-proxy", "switch_pointer");
  assert.equal(res.ok, false);
  assert.match(res.reason, /只能产生准入建议|不得/);
});

test("DG-5: 代理不得晋级生产", () => {
  const res = evaluateProxyPermission("gpt5.6-sol-proxy", "promote_production");
  assert.equal(res.ok, false);
});

test("DG-5: 非代理角色不受代理权限限制", () => {
  assert.equal(evaluateProxyPermission("user", "switch_pointer").ok, true);
  assert.equal(evaluateProxyPermission("system", "recommend").ok, true);
});

// ============================================================================
// 5. 单次用户反馈不得切换生产基线
// ============================================================================

test("DG-5: 单次用户反馈不得直接切换生产基线", () => {
  assert.equal(
    singleFeedbackCanSwitchProductionBaseline(),
    false,
    "单次用户反馈只能写入章节/策略证据与健康报告，不得切换生产 pointer",
  );
});
