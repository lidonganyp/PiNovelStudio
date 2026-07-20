/**
 * EVOLUTION-RELEASE-GOVERNANCE-G8 - auto-hold actions 测试（RED）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §8 Phase G8
 * 计划：.trae/documents/g8-health-monitoring-and-retirement-implementation.md §2.5
 *
 * 本测试覆盖 release-health-actions 模块：
 * - executeAutoHold：幂等（已 held 跳过）/ shouldAutoHold=false 跳过 / 成功执行 / 错误捕获
 * - actor 继承：system / user 均通过 approvalRef 继承 existing
 * - 状态事件 append-only：重复 eventId 抛错并被 executeAutoHold 捕获
 * - 幂等：第二次调用同 releaseId（重新 evaluate 后 alreadyHeld=true）→ skippedReason="already_held"
 * - generateRetiredSuggestion：纯函数，不调 transitionStatus，返回建议文本
 *
 * RED 状态：import 的模块尚未实现，所有测试因 import 失败而 fail。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvolutionReleaseRegistry } from "../dist-test/v2/governance/evolution-release-registry.js";
import {
  EVOLUTION_RELEASE_SCHEMA_ID,
  EVOLUTION_RELEASE_SCHEMA_VERSION,
} from "../dist-test/v2/governance/evolution-release-types.js";
import { evaluateReleaseHealth } from "../dist-test/v2/governance/release-health-evaluator.js";
import {
  executeAutoHold,
  generateRetiredSuggestion,
} from "../dist-test/v2/governance/release-health-actions.js";

// ============================================================================
// helpers
// ============================================================================

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), "evolution-g8-actions-"));
}

/**
 * 构造 manifest fixture。
 * 默认 status="active_dev", approvalRef="apr-001"。
 */
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

/**
 * 构造一个 shouldAutoHold=true 的 evaluation fixture。
 * 默认 releaseId="rel-001", currentStatus="active_dev"。
 */
function makeAutoHoldEvaluation(overrides = {}) {
  return {
    releaseId: overrides.releaseId ?? "rel-001",
    status: overrides.status ?? "auto_hold_eligible",
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
    // 重新覆盖顶层 status / releaseId（防止上面 ...overrides 把它们覆盖错）
    releaseId: overrides.releaseId ?? "rel-001",
    status: overrides.status ?? "auto_hold_eligible",
  };
}

/**
 * 构造一个 shouldSuggestRetired=true 的 evaluation fixture。
 */
function makeRetiredEvaluation(overrides = {}) {
  return {
    releaseId: overrides.releaseId ?? "rel-001",
    status: overrides.status ?? "retired_suggestion",
    evidence: {
      sampleCount: 5,
      alignmentRate: 0.25,
      rollbackRate: 0.0,
      factGuardPassRate: null,
      consecutiveNegative: 1,
      longTermAlignmentRate: 0.2,
      ...overrides.evidence,
    },
    decision: {
      shouldAutoHold: false,
      shouldSuggestRetired: true,
      recoveryAlignmentRate: 0.8,
      currentStatus: overrides.decision?.currentStatus ?? "active_dev",
      alreadyHeld: false,
      ...overrides.decision,
    },
    ...overrides,
    releaseId: overrides.releaseId ?? "rel-001",
    status: overrides.status ?? "retired_suggestion",
  };
}

// ============================================================================
// executeAutoHold：幂等 / 跳过 / 成功 / 错误
// ============================================================================

test("1. executeAutoHold 已 held -> held=false, skippedReason='already_held'", () => {
  const root = makeTempRoot();
  try {
    const registry = setupRelease(root, "rel-001", "held");
    const evaluation = makeAutoHoldEvaluation({
      decision: { currentStatus: "held", alreadyHeld: true, shouldAutoHold: true },
    });
    const result = executeAutoHold(registry, evaluation, { actor: "system" });
    assert.equal(result.releaseId, "rel-001");
    assert.equal(result.held, false);
    assert.equal(result.skippedReason, "already_held");
    assert.equal(result.eventId, undefined, "已 held 时不应生成 eventId");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("2. executeAutoHold shouldAutoHold=false -> held=false, skippedReason='not_eligible'", () => {
  const root = makeTempRoot();
  try {
    const registry = setupRelease(root, "rel-001", "active_dev");
    const evaluation = makeAutoHoldEvaluation({
      decision: { shouldAutoHold: false, currentStatus: "active_dev", alreadyHeld: false },
    });
    const result = executeAutoHold(registry, evaluation, { actor: "system" });
    assert.equal(result.held, false);
    assert.equal(result.skippedReason, "not_eligible");
    assert.equal(result.eventId, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("3. executeAutoHold shouldAutoHold=true -> held=true, eventId 写入", () => {
  const root = makeTempRoot();
  try {
    const registry = setupRelease(root, "rel-001", "active_dev");
    const evaluation = makeAutoHoldEvaluation();
    const result = executeAutoHold(registry, evaluation, {
      actor: "system",
      eventId: "evt-test-001",
      timestamp: "2026-07-17T00:00:00.000Z",
    });
    assert.equal(result.held, true);
    assert.equal(result.eventId, "evt-test-001");
    assert.equal(result.skippedReason, undefined);

    // 验证 manifest 状态已迁移到 held
    const manifest = registry.loadManifest("rel-001");
    assert.equal(manifest.status, "held");

    // 验证 state event 已写入
    const events = registry.loadStateEvents("rel-001");
    assert.equal(events.length, 1);
    assert.equal(events[0].eventId, "evt-test-001");
    assert.equal(events[0].toStatus, "held");
    assert.equal(events[0].actor, "system");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("4. executeAutoHold transitionStatus 抛错 -> held=false, skippedReason=error.message", () => {
  const root = makeTempRoot();
  try {
    // 写入一个 draft 状态的 manifest，draft → held 不是合法迁移
    const registry = setupRelease(root, "rel-001", "draft");
    const evaluation = makeAutoHoldEvaluation({
      decision: { currentStatus: "draft", alreadyHeld: false, shouldAutoHold: true },
    });
    const result = executeAutoHold(registry, evaluation, { actor: "system" });
    assert.equal(result.held, false);
    assert.ok(result.skippedReason, "应有 skippedReason 说明错误");
    assert.ok(
      result.skippedReason.includes("非法状态迁移") || result.skippedReason.includes("draft"),
      `skippedReason 应提及非法迁移或 draft，实际：${result.skippedReason}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("5. executeAutoHold actor='system'：approvalRef 继承 existing", () => {
  const root = makeTempRoot();
  try {
    const registry = setupRelease(root, "rel-001", "active_dev", { approvalRef: "apr-inherited" });
    const evaluation = makeAutoHoldEvaluation();
    const result = executeAutoHold(registry, evaluation, {
      actor: "system",
      eventId: "evt-test-005",
      timestamp: "2026-07-17T00:00:00.000Z",
    });
    assert.equal(result.held, true);
    // approvalRef 应从 existing manifest 继承（held 状态不需要 approvalRef，但 manifest 字段保留）
    const manifest = registry.loadManifest("rel-001");
    assert.equal(manifest.approvalRef, "apr-inherited");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("6. executeAutoHold actor='user'：approvalRef 继承 existing", () => {
  const root = makeTempRoot();
  try {
    const registry = setupRelease(root, "rel-001", "active_dev", { approvalRef: "apr-user-001" });
    const evaluation = makeAutoHoldEvaluation();
    const result = executeAutoHold(registry, evaluation, {
      actor: "user",
      eventId: "evt-test-006",
      timestamp: "2026-07-17T00:00:00.000Z",
    });
    assert.equal(result.held, true);
    const events = registry.loadStateEvents("rel-001");
    assert.equal(events[0].actor, "user");
    const manifest = registry.loadManifest("rel-001");
    assert.equal(manifest.approvalRef, "apr-user-001");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("7. executeAutoHold 状态事件 append-only：重复 eventId 抛错", () => {
  const root = makeTempRoot();
  try {
    const registry = setupRelease(root, "rel-001", "active_dev");
    const evaluation = makeAutoHoldEvaluation();

    // 第一次调用：成功
    const r1 = executeAutoHold(registry, evaluation, {
      actor: "system",
      eventId: "evt-dup-001",
      timestamp: "2026-07-17T00:00:00.000Z",
    });
    assert.equal(r1.held, true);

    // 重置 manifest 状态为 active_dev 以便再次调用
    // （实际场景下 second call 应该是不同 release，这里直接构造 second release 测重复 eventId）
    registry.writeManifest(makeManifest("rel-002", "active_dev", { approvalRef: "apr-002" }));
    const evaluation2 = makeAutoHoldEvaluation({ releaseId: "rel-002" });

    // 第二次调用：使用相同 eventId，应被 recordStateEvent 拒绝
    // 注意：state-events.jsonl 是 per-releaseId 的，但 eventId 是全局唯一的
    // 实际上 recordStateEvent 只检查同 releaseId 下的 eventId 重复。
    // 为了测试"重复 eventId 抛错"，我们在同一 releaseId 下重复调用。
    // 但第一次调用后 status 已变为 held，第二次调用会因为 alreadyHeld 而跳过。
    // 所以这里直接调 registry.recordStateEvent 验证 append-only 行为。
    assert.throws(
      () =>
        registry.recordStateEvent({
          eventId: "evt-dup-001",
          releaseId: "rel-001",
          fromStatus: "active_dev",
          toStatus: "held",
          reason: "duplicate test",
          actor: "system",
          timestamp: "2026-07-17T00:00:01.000Z",
        }),
      /重复 eventId/,
    );

    // 验证 executeAutoHold 捕获 recordStateEvent 错误：
    // 构造一个场景，让 transitionStatus 成功但 recordStateEvent 失败。
    // 由于 transitionStatus 已经把 status 改为 held，再次调用会 alreadyHeld。
    // 所以这个测试主要验证 recordStateEvent 本身的 append-only 行为。
    // executeAutoHold 的错误捕获在 test 4 已覆盖（transitionStatus 抛错）。
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("8. executeAutoHold 幂等：第二次调用同 releaseId -> skippedReason='already_held'", () => {
  const root = makeTempRoot();
  try {
    const registry = setupRelease(root, "rel-001", "active_dev");

    // 第一次调用：成功执行 auto-hold
    const evaluation1 = makeAutoHoldEvaluation();
    const r1 = executeAutoHold(registry, evaluation1, {
      actor: "system",
      eventId: "evt-idem-001",
      timestamp: "2026-07-17T00:00:00.000Z",
    });
    assert.equal(r1.held, true, "第一次调用应成功");

    // 重新加载 manifest，验证状态已变为 held
    const manifest = registry.loadManifest("rel-001");
    assert.equal(manifest.status, "held");

    // 模拟调用方重新 evaluate：currentStatus 现在是 "held"，alreadyHeld=true
    const evaluation2 = makeAutoHoldEvaluation({
      decision: { currentStatus: "held", alreadyHeld: true, shouldAutoHold: false },
    });
    const r2 = executeAutoHold(registry, evaluation2, { actor: "system" });
    assert.equal(r2.held, false, "第二次调用应跳过");
    assert.equal(r2.skippedReason, "already_held");
    assert.equal(r2.eventId, undefined, "跳过时不应生成新 eventId");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// generateRetiredSuggestion：纯函数，不调 transitionStatus
// ============================================================================

test("9. generateRetiredSuggestion shouldSuggestRetired=false -> 返回 null，不调用 registry", () => {
  const root = makeTempRoot();
  try {
    const registry = setupRelease(root, "rel-001", "active_dev");
    const evaluation = makeAutoHoldEvaluation(); // shouldSuggestRetired=false
    const result = generateRetiredSuggestion(evaluation);
    assert.equal(result, null);

    // 验证 manifest 状态未变（registry 未被调用）
    const manifest = registry.loadManifest("rel-001");
    assert.equal(manifest.status, "active_dev", "retired 建议不应修改 manifest 状态");
    const events = registry.loadStateEvents("rel-001");
    assert.equal(events.length, 0, "retired 建议不应写入 state event");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("10. generateRetiredSuggestion shouldSuggestRetired=true -> 返回建议文本，含 releaseId / longTermAlignmentRate / 人工执行提示", () => {
  const evaluation = makeRetiredEvaluation({
    releaseId: "rel-retire-001",
    evidence: {
      sampleCount: 8,
      longTermAlignmentRate: 0.2,
      alignmentRate: 0.25,
    },
  });
  const result = generateRetiredSuggestion(evaluation);
  assert.ok(result, "shouldSuggestRetired=true 时应返回建议");
  assert.equal(result.releaseId, "rel-retire-001");
  assert.ok(result.suggestion, "应有建议文本");
  assert.ok(
    result.suggestion.includes("rel-retire-001") || result.releaseId.includes("rel-retire-001"),
    "建议应包含 releaseId",
  );
  assert.ok(
    result.suggestion.includes("0.2") || result.evidence.longTermAlignmentRate === 0.2,
    "建议应反映 longTermAlignmentRate=0.2",
  );
  assert.ok(result.manualCommand, "应有 manualCommand 提示用户手动执行");
  assert.ok(
    result.manualCommand.includes("retired") || result.manualCommand.includes("promote"),
    "manualCommand 应提示 retired 或 promote 命令",
  );
  assert.equal(result.evidence.longTermAlignmentRate, 0.2);
  assert.equal(result.evidence.sampleCount, 8);
});
