/**
 * DATA-VERSION-RELEASE-GOVERNANCE DG-4 — 策略证据按完整行为环境分区 (RED)
 *
 * 真相源：docs/data-version-release-governance-development-plan-20260813.md §5 DG-4
 * 任务卡：DG-4「策略证据按完整行为环境隔离」
 *
 * 验收点（任务卡“必须测试”）：
 * - 分区键（modelVersion + bundleId + strategyId + evalProtocolVersion）确定性派生
 * - classifyPartitionMatch：match / legacy / mismatch 三态分类正确
 * - checkCrossBundleContamination：match ok / legacy 仅审计 / mismatch 污染
 * - 新 Bundle 不继承旧 Bundle 策略信誉（读取隔离 → 弱先验）
 * - 旧 evidence 可审计（无 partition 读取仍返回旧物化）但不能作为新 bundle 准入依据
 * - 跨 Bundle 污染写入被拒绝（recordOutcome mismatch → throw）
 * - legacy → 新 bundle 首次写入从弱先验重新起步（不合并旧 alpha/beta）
 *
 * 边界（READY_LOCAL）：
 * - 纯内存 store（createStrategyPolicyStore），不落盘、不调模型、无 fs 副作用
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildStrategyEvidencePartitionKey,
  classifyPartitionMatch,
  checkCrossBundleContamination,
} from "../dist-test/v2/learning/strategy-evidence-partition.js";
import {
  createStrategyPolicyStore,
  WEAK_PRIOR_ALPHA,
  WEAK_PRIOR_BETA,
} from "../dist-test/v2/learning/strategy-policy-store.js";

const MODEL_VERSION = "gemini-3.1-pro";
const STRATEGY_ID = "editorial-strategy-dg4";

const BUNDLE_A = "a".repeat(64);
const BUNDLE_B = "b".repeat(64);
const EVAL_V1 = "2026-08-01";
const EVAL_V2 = "2026-08-02";

function makeEvidence(outcome, overrides = {}) {
  return {
    sourceChapter: "ch17",
    outcome,
    source: "judge",
    weight: 1,
    timestamp: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

// ============================================================================
// 1. 分区键确定性派生
// ============================================================================

test("DG-4: 分区键确定性派生，且任意一维变化 → 新分区键", () => {
  const base = {
    modelVersion: MODEL_VERSION,
    bundleId: BUNDLE_A,
    strategyId: STRATEGY_ID,
    evalProtocolVersion: EVAL_V1,
  };

  const k1 = buildStrategyEvidencePartitionKey(base);
  const k2 = buildStrategyEvidencePartitionKey({ ...base });
  assert.equal(k1, k2, "相同输入应派生相同分区键");

  assert.equal(
    buildStrategyEvidencePartitionKey({ ...base, bundleId: BUNDLE_B }),
    buildStrategyEvidencePartitionKey({ ...base, bundleId: BUNDLE_B }),
  );
  assert.notEqual(
    buildStrategyEvidencePartitionKey({ ...base, bundleId: BUNDLE_B }),
    k1,
    "bundleId 变化应产生不同分区键",
  );
  assert.notEqual(
    buildStrategyEvidencePartitionKey({ ...base, evalProtocolVersion: EVAL_V2 }),
    k1,
    "evalProtocolVersion 变化应产生不同分区键",
  );
  assert.notEqual(
    buildStrategyEvidencePartitionKey({ ...base, modelVersion: "other-model" }),
    k1,
    "modelVersion 变化应产生不同分区键",
  );
  assert.notEqual(
    buildStrategyEvidencePartitionKey({ ...base, strategyId: "other-strategy" }),
    k1,
    "strategyId 变化应产生不同分区键",
  );

  assert.equal(k1, `${MODEL_VERSION}::${BUNDLE_A}::${STRATEGY_ID}::${EVAL_V1}`);
});

// ============================================================================
// 2. classifyPartitionMatch 三态
// ============================================================================

test("DG-4: classifyPartitionMatch 分类 match / legacy / mismatch", () => {
  const requestedA = { bundleId: BUNDLE_A, evalProtocolVersion: EVAL_V1 };

  // match：stored 的 bundleId + evalProtocolVersion 与 requested 完全一致
  assert.equal(
    classifyPartitionMatch({ bundleId: BUNDLE_A, evalProtocolVersion: EVAL_V1 }, requestedA),
    "match",
  );
  // legacy：stored 未捕获任何行为身份（旧证据）
  assert.equal(
    classifyPartitionMatch({ modelVersion: MODEL_VERSION }, requestedA),
    "legacy",
  );
  assert.equal(classifyPartitionMatch({}, requestedA), "legacy");
  // 部分捕获（仅一维）→ mismatch：不完整身份无法确认为同一 bundle，fail-closed
  assert.equal(classifyPartitionMatch({ bundleId: BUNDLE_A }, requestedA), "mismatch");
  assert.equal(
    classifyPartitionMatch({ evalProtocolVersion: EVAL_V1 }, requestedA),
    "mismatch",
  );
  // mismatch：bundleId 或 evalProtocolVersion 不同
  assert.equal(
    classifyPartitionMatch({ bundleId: BUNDLE_B, evalProtocolVersion: EVAL_V1 }, requestedA),
    "mismatch",
  );
  assert.equal(
    classifyPartitionMatch({ bundleId: BUNDLE_A, evalProtocolVersion: EVAL_V2 }, requestedA),
    "mismatch",
  );
});

// ============================================================================
// 3. checkCrossBundleContamination 判定
// ============================================================================

test("DG-4: checkCrossBundleContamination match→ok / legacy→仅审计 / mismatch→污染", () => {
  const requestedA = { bundleId: BUNDLE_A, evalProtocolVersion: EVAL_V1 };

  const match = checkCrossBundleContamination(
    { bundleId: BUNDLE_A, evalProtocolVersion: EVAL_V1 },
    requestedA,
  );
  assert.equal(match.ok, true);
  assert.equal(match.classification, "match");

  const legacy = checkCrossBundleContamination({}, requestedA);
  assert.equal(legacy.ok, false);
  assert.equal(legacy.classification, "legacy");
  assert.match(legacy.reason, /审计|准入/);

  const mismatch = checkCrossBundleContamination(
    { bundleId: BUNDLE_B, evalProtocolVersion: EVAL_V1 },
    requestedA,
  );
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.classification, "mismatch");
  assert.match(mismatch.reason, /污染/);
});

// ============================================================================
// 4. 读取隔离：新 Bundle 不继承旧 Bundle 策略信誉
// ============================================================================

test("DG-4: 新 Bundle 读取返回弱先验，不继承旧 Bundle 的 alpha/beta", () => {
  const store = createStrategyPolicyStore("dg4-read-isolation");

  // 旧 Bundle A 积累了 4 条 win（alpha 从 1 涨到 5）
  store.recordOutcome(STRATEGY_ID, MODEL_VERSION, makeEvidence("win", { weight: 4 }), {
    bundleId: BUNDLE_A,
    evalProtocolVersion: EVAL_V1,
  });
  const oldRep = store.getReputation(STRATEGY_ID, MODEL_VERSION);
  assert.equal(oldRep.alpha, WEAK_PRIOR_ALPHA + 4);
  assert.equal(oldRep.bundleId, BUNDLE_A);

  // 新 Bundle B 读取同一 (strategyId, modelVersion) → 弱先验，不继承 A 的 alpha
  const newRep = store.getReputation(STRATEGY_ID, MODEL_VERSION, {
    bundleId: BUNDLE_B,
    evalProtocolVersion: EVAL_V2,
  });
  assert.equal(newRep.alpha, WEAK_PRIOR_ALPHA);
  assert.equal(newRep.beta, WEAK_PRIOR_BETA);
  assert.equal(newRep.sampleCount, 0);
  assert.equal(newRep.evidence.length, 0);
});

// ============================================================================
// 5. 旧 evidence 可审计但不得作为新 bundle 准入依据
// ============================================================================

test("DG-4: 旧 evidence 可审计（无 partition 读取）但不计入新 bundle 准入", () => {
  const store = createStrategyPolicyStore("dg4-audit-isolation");

  // 旧证据（legacy，无 bundleId/evalProtocolVersion）写入
  store.recordOutcome(STRATEGY_ID, MODEL_VERSION, makeEvidence("win", { weight: 10 }));
  const legacyRep = store.getReputation(STRATEGY_ID, MODEL_VERSION);
  assert.equal(legacyRep.alpha, WEAK_PRIOR_ALPHA + 10, "旧证据仍可审计读取");
  assert.equal(legacyRep.sampleCount, 1);

  // 新 bundle 带分区身份读取 → 旧证据不构成新 bundle 的准入基础
  const newRep = store.getReputation(STRATEGY_ID, MODEL_VERSION, {
    bundleId: BUNDLE_A,
    evalProtocolVersion: EVAL_V1,
  });
  assert.equal(newRep.alpha, WEAK_PRIOR_ALPHA, "新 bundle 不继承旧证据 alpha");
  assert.equal(newRep.sampleCount, 0, "新 bundle sampleCount 从 0 起算");
});

// ============================================================================
// 6. 跨 Bundle 污染写入拒绝
// ============================================================================

test("DG-4: 跨 Bundle 污染写入被拒绝（mismatch → throw）", () => {
  const store = createStrategyPolicyStore("dg4-write-rejection");

  store.recordOutcome(STRATEGY_ID, MODEL_VERSION, makeEvidence("win"), {
    bundleId: BUNDLE_A,
    evalProtocolVersion: EVAL_V1,
  });

  assert.throws(
    () =>
      store.recordOutcome(STRATEGY_ID, MODEL_VERSION, makeEvidence("loss"), {
        bundleId: BUNDLE_B,
        evalProtocolVersion: EVAL_V2,
      }),
    /跨 Bundle 污染/,
    "跨 Bundle 污染写入应抛错拒绝",
  );

  // 写入被拒绝后，旧 Bundle A 的信誉不被污染
  const repA = store.getReputation(STRATEGY_ID, MODEL_VERSION, {
    bundleId: BUNDLE_A,
    evalProtocolVersion: EVAL_V1,
  });
  assert.equal(repA.bundleId, BUNDLE_A);
  assert.equal(repA.beta, WEAK_PRIOR_BETA, "B 的 loss 未污染 A 的 beta");
});

// ============================================================================
// 7. legacy → 新 bundle 首次写入从弱先验重新起步
// ============================================================================

test("DG-4: legacy 条目被新 bundle 首次写入时从弱先验重新起步（不合并旧 alpha/beta）", () => {
  const store = createStrategyPolicyStore("dg4-legacy-fresh-start");

  // 旧证据（legacy）积累大量 win
  store.recordOutcome(STRATEGY_ID, MODEL_VERSION, makeEvidence("win", { weight: 50 }));

  // 新 bundle A 首次写入：不合并 legacy 的 alpha，从弱先验 + 本 bundle 证据起步
  const rep = store.recordOutcome(
    STRATEGY_ID,
    MODEL_VERSION,
    makeEvidence("win", { weight: 1 }),
    { bundleId: BUNDLE_A, evalProtocolVersion: EVAL_V1 },
  );

  assert.equal(rep.bundleId, BUNDLE_A);
  assert.equal(rep.evalProtocolVersion, EVAL_V1);
  // 弱先验(1) + 本 bundle win(weight=1) = 2；若错误合并 legacy 会远大于此
  assert.equal(rep.alpha, WEAK_PRIOR_ALPHA + 1);
  assert.equal(rep.sampleCount, 1);
  assert.equal(rep.evidence.length, 1, "仅含新 bundle 自己的证据，不携带 legacy 证据");
});

// ============================================================================
// 8. 分区写入携带 bundleId/evalProtocolVersion 标记
// ============================================================================

test("DG-4: 分区写入后物化条目携带 bundleId + evalProtocolVersion 标记", () => {
  const store = createStrategyPolicyStore("dg4-tagging");

  store.recordOutcome(STRATEGY_ID, MODEL_VERSION, makeEvidence("win"), {
    bundleId: BUNDLE_A,
    evalProtocolVersion: EVAL_V1,
  });

  const rep = store.getReputation(STRATEGY_ID, MODEL_VERSION);
  assert.equal(rep.bundleId, BUNDLE_A);
  assert.equal(rep.evalProtocolVersion, EVAL_V1);

  const data = store.toJSON();
  assert.equal(data.partitions[MODEL_VERSION][STRATEGY_ID].bundleId, BUNDLE_A);
  assert.equal(data.partitions[MODEL_VERSION][STRATEGY_ID].evalProtocolVersion, EVAL_V1);
});
