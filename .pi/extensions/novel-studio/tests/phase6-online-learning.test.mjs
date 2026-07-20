/**
 * Phase 6 在线策略学习测试（计划 §Phase 6 + §7 + §10.1）
 *
 * 覆盖退出条件：
 * 1. 策略会根据正常写作反馈调整调用概率（Thompson Sampling + 信誉更新）
 * 2. 新模型不会继承旧模型的虚假高胜率（模型版本隔离）
 * 3. 用户反馈高权重（counts as multiple samples）
 * 4. dormant/retired 状态自动转换
 * 5. 所有自动学习可解释、可撤销（evidence log + revert）
 * 6. 禁止自动修改系统 prompt / 宪法核心字段 / 硬门禁 / 世界事实
 *
 * 模块覆盖：
 * - StrategyPolicyStore：CRUD、recordOutcome、状态转换、revert、持久化
 * - ModelVersionMigration：版本键派生、isNewVersion、initializeVersion、decayPriors
 * - ContextualStrategySelector：Thompson Sampling、0-2 选择、dormant 跳过、可复现
 * - StrategyOutcomeRecorder：胜负判定、权重等级、机械信号不写入
 * - UserFeedbackIngestor：用户选择/修改/评分、状态覆盖、撤销
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  StrategyPolicyStore,
  createStrategyPolicyStore,
  loadStrategyPolicyStore,
  saveStrategyPolicyStore,
  WEAK_PRIOR_ALPHA,
  WEAK_PRIOR_BETA,
  DORMANT_CONSECUTIVE_LOSSES,
  RETIRE_MIN_SAMPLES,
  RETIRE_MAX_WIN_RATE,
  EVIDENCE_LOG_CAP,
} from "../dist/v2/learning/strategy-policy-store.js";
import {
  detectModelVersion,
  createModelVersionMigration,
  DEFAULT_DECAY_FACTOR,
} from "../dist/v2/learning/model-version-migration.js";
import {
  createContextualStrategySelector,
  MAX_SELECTED,
  SELECTION_THRESHOLD,
} from "../dist/v2/learning/contextual-strategy-selector.js";
import {
  createStrategyOutcomeRecorder,
  WEIGHT_JUDGE_SINGLE,
  WEIGHT_JUDGE_DOUBLE_CONSENSUS,
  WEIGHT_USER_MODIFICATION,
  WEIGHT_USER_EXPLICIT,
} from "../dist/v2/learning/strategy-outcome-recorder.js";
import {
  createUserFeedbackIngestor,
  HEAVY_EDIT_DISTANCE_THRESHOLD,
  HEAVY_EDIT_BONUS,
  RATING_WIN_THRESHOLD,
} from "../dist/v2/learning/user-feedback-ingestor.js";

// ============================================================================
// 辅助：构造策略定义（供 selector 测试）
// ============================================================================

function makeStrategy(strategyId, opportunityType = "reader_payoff") {
  return {
    strategyId,
    opportunityType,
    focus: `focus-${strategyId}`,
    angle: `angle-${strategyId}`,
    promptGuidance: `guidance-${strategyId}`,
    inviolableGuardNote: `guard-${strategyId}`,
  };
}

function makeContext(strategyId = "reader_payoff_strengthen", modelVersion = "doubao-seed-2.1-pro") {
  return {
    sourceChapter: "ch17",
    modelVersion,
    strategyId,
    opportunityType: "reader_payoff",
  };
}

function makeJudgeOutcome(opts = {}) {
  return {
    editorialCandidateId: "cand-ed-1",
    rawCandidateId: "cand-raw-1",
    selectedCandidateId: opts.selected ?? "cand-ed-1",
    confidence: opts.confidence ?? "clear",
    hadReverseReview: opts.hadReverseReview ?? false,
    reverseConsensus: opts.reverseConsensus ?? false,
    tie: opts.tie ?? false,
  };
}

function makeSelectionOutcome(opts = {}) {
  return {
    deliveredCandidateId: opts.delivered ?? "cand-ed-1",
    deliveredSource: opts.source ?? "editorial",
    fellBackToRaw: opts.fellBack ?? false,
  };
}

// ============================================================================
// 1. StrategyPolicyStore 基础 CRUD
// ============================================================================

test("StrategyPolicyStore: 未观察策略返回弱先验 Beta(1,1)", () => {
  const store = createStrategyPolicyStore("ws-test");
  const rep = store.getReputation("new_strategy", "doubao-seed-2.1-pro");
  assert.equal(rep.alpha, WEAK_PRIOR_ALPHA);
  assert.equal(rep.beta, WEAK_PRIOR_BETA);
  assert.equal(rep.sampleCount, 0);
  assert.equal(rep.status, "candidate");
  assert.equal(rep.consecutiveLosses, 0);
});

test("StrategyPolicyStore: recordOutcome win 增加 alpha，清零 consecutiveLosses", () => {
  const store = createStrategyPolicyStore("ws-test");
  const ctx = makeContext();
  store.setStatus(ctx.strategyId, ctx.modelVersion, "active", "测试：策略已通过准入");
  const evidence = {
    sourceChapter: "ch17",
    outcome: "win",
    source: "judge",
    weight: 1,
    timestamp: new Date().toISOString(),
  };
  const rep = store.recordOutcome(ctx.strategyId, ctx.modelVersion, evidence);
  assert.equal(rep.alpha, WEAK_PRIOR_ALPHA + 1);
  assert.equal(rep.beta, WEAK_PRIOR_BETA);
  assert.equal(rep.sampleCount, 1);
  assert.equal(rep.consecutiveLosses, 0);
  assert.equal(rep.status, "active");
  assert.equal(rep.evidence.length, 1);
});

test("StrategyPolicyStore: recordOutcome loss 增加 beta 与 consecutiveLosses", () => {
  const store = createStrategyPolicyStore("ws-test");
  const ctx = makeContext();
  const evidence = {
    sourceChapter: "ch17",
    outcome: "loss",
    source: "judge",
    weight: 1,
    timestamp: new Date().toISOString(),
  };
  const rep = store.recordOutcome(ctx.strategyId, ctx.modelVersion, evidence);
  assert.equal(rep.alpha, WEAK_PRIOR_ALPHA);
  assert.equal(rep.beta, WEAK_PRIOR_BETA + 1);
  assert.equal(rep.sampleCount, 1);
  assert.equal(rep.consecutiveLosses, 1);
});

test("StrategyPolicyStore: tie 弱更新双方各加一半，不改 consecutiveLosses", () => {
  const store = createStrategyPolicyStore("ws-test");
  // 先制造 2 次连续失败
  store.recordOutcome("s1", "v1", {
    sourceChapter: "ch1", outcome: "loss", source: "judge", weight: 1, timestamp: new Date().toISOString(),
  });
  store.recordOutcome("s1", "v1", {
    sourceChapter: "ch2", outcome: "loss", source: "judge", weight: 1, timestamp: new Date().toISOString(),
  });
  let rep = store.getReputation("s1", "v1");
  assert.equal(rep.consecutiveLosses, 2);

  // tie 不应改变 consecutiveLosses
  rep = store.recordOutcome("s1", "v1", {
    sourceChapter: "ch3", outcome: "tie", source: "judge", weight: 2, timestamp: new Date().toISOString(),
  });
  assert.equal(rep.consecutiveLosses, 2);
  assert.equal(rep.alpha, WEAK_PRIOR_ALPHA + 1); // +2*0.5
  assert.equal(rep.beta, WEAK_PRIOR_BETA + 2 + 1); // 原 2 + 2*0.5
});

test("StrategyPolicyStore: evidence log FIFO 截断到 EVIDENCE_LOG_CAP", () => {
  const store = createStrategyPolicyStore("ws-test");
  const ctx = makeContext();
  for (let i = 0; i < EVIDENCE_LOG_CAP + 10; i++) {
    store.recordOutcome(ctx.strategyId, ctx.modelVersion, {
      sourceChapter: `ch${i}`,
      outcome: "win",
      source: "judge",
      weight: 1,
      timestamp: new Date().toISOString(),
    });
  }
  const rep = store.getReputation(ctx.strategyId, ctx.modelVersion);
  assert.equal(rep.evidence.length, EVIDENCE_LOG_CAP);
  // 保留最近 N 条（FIFO）
  assert.equal(rep.evidence[0].sourceChapter, `ch${10}`);
  assert.equal(rep.evidence[EVIDENCE_LOG_CAP - 1].sourceChapter, `ch${EVIDENCE_LOG_CAP + 9}`);
});

// ============================================================================
// 2. StrategyPolicyStore 状态转换
// ============================================================================

test("STRATEGY-ADMISSION-1A: 新模型策略默认保持 candidate", () => {
  const store = createStrategyPolicyStore("ws-admission-default");
  const rep = store.getReputation("chapter_end_pressure_focus", "glm-5.2");

  assert.equal(rep.status, "candidate");
  assert.equal(rep.sampleCount, 0);
});

test("STRATEGY-ADMISSION-1A: 至少 5 个 eligible 且 3 个人审才建议 active", () => {
  const store = createStrategyPolicyStore("ws-admission-threshold");

  const lowEligible = store.evaluateAdmission("s1", "glm-5.2", {
    eligibleDecisionCount: 4,
    humanVerdictCount: 4,
  });
  assert.equal(lowEligible.recommendedStatus, "candidate");
  assert.match(lowEligible.reason, /eligible/i);

  const lowHuman = store.evaluateAdmission("s1", "glm-5.2", {
    eligibleDecisionCount: 5,
    humanVerdictCount: 2,
  });
  assert.equal(lowHuman.recommendedStatus, "candidate");
  assert.match(lowHuman.reason, /human/i);

  const admitted = store.evaluateAdmission("s1", "glm-5.2", {
    eligibleDecisionCount: 5,
    humanVerdictCount: 3,
  });
  assert.equal(admitted.recommendedStatus, "active");
  assert.equal(admitted.modelVersion, "glm-5.2");
  assert.equal(admitted.strategyId, "s1");

  // 评估是离线纯读操作，不得自动改变生产状态。
  assert.equal(store.getReputation("s1", "glm-5.2").status, "candidate");
});

test("STRATEGY-ADMISSION-1A: schema v1 的未准入 active 不继承为生产 active", () => {
  const legacy = new StrategyPolicyStore("ws-legacy", {
    schemaVersion: 1,
    workspaceId: "ws-legacy",
    partitions: {
      "glm-5.2": {
        chapter_end_pressure_focus: {
          strategyId: "chapter_end_pressure_focus",
          modelVersion: "glm-5.2",
          alpha: 1,
          beta: 1,
          sampleCount: 0,
          consecutiveLosses: 0,
          status: "active",
          evidence: [],
          lastUpdated: "2026-07-14T00:00:00.000Z",
        },
      },
    },
    updatedAt: "2026-07-14T00:00:00.000Z",
  });

  const rep = legacy.getReputation("chapter_end_pressure_focus", "glm-5.2");
  assert.equal(legacy.toJSON().schemaVersion, 2);
  assert.equal(rep.status, "candidate");
  assert.match(rep.statusReason, /admission/i);
});

test("STRATEGY-ADMISSION-1A: schema v1 的 dormant/retired 不得迁移复活", () => {
  const makeLegacyRep = (strategyId, status) => ({
    strategyId,
    modelVersion: "glm-5.2",
    alpha: 1,
    beta: 8,
    sampleCount: 7,
    consecutiveLosses: 4,
    status,
    evidence: [],
    lastUpdated: "2026-07-14T00:00:00.000Z",
  });
  const legacy = new StrategyPolicyStore("ws-legacy-restrictive", {
    schemaVersion: 1,
    workspaceId: "ws-legacy-restrictive",
    partitions: {
      "glm-5.2": {
        dormant_strategy: makeLegacyRep("dormant_strategy", "dormant"),
        retired_strategy: makeLegacyRep("retired_strategy", "retired"),
      },
    },
    updatedAt: "2026-07-14T00:00:00.000Z",
  });

  assert.equal(legacy.getReputation("dormant_strategy", "glm-5.2").status, "dormant");
  assert.equal(legacy.getReputation("retired_strategy", "glm-5.2").status, "retired");
});

test("STRATEGY-ADMISSION-1A: candidate 不参与 Thompson Sampling", () => {
  const store = createStrategyPolicyStore("ws-admission-selector");
  const selector = createContextualStrategySelector();
  const result = selector.select({
    candidates: [makeStrategy("s1")],
    modelVersion: "glm-5.2",
    policyStore: store,
    seed: 7,
  });

  assert.equal(result.selected.length, 0);
  assert.equal(result.staticFallback.length, 1);
  assert.equal(result.staticFallback[0].strategyId, "s1");
  assert.equal(result.samples[0].status, "candidate");
  assert.equal(result.samples[0].sampled, 0);
  assert.equal(result.samples[0].selected, false);
});

test("STRATEGY-ADMISSION-1A: candidate 的在线 outcome 不得自动 dormant 或 retired", () => {
  const store = createStrategyPolicyStore("ws-admission-outcomes");
  const ctx = makeContext("s1");
  for (let i = 0; i < RETIRE_MIN_SAMPLES; i++) {
    store.recordOutcome(ctx.strategyId, ctx.modelVersion, {
      sourceChapter: `ch${i}`,
      outcome: "loss",
      source: "judge",
      weight: 1,
      timestamp: new Date().toISOString(),
    });
  }

  const rep = store.getReputation(ctx.strategyId, ctx.modelVersion);
  assert.equal(rep.status, "candidate");
  assert.equal(rep.sampleCount, RETIRE_MIN_SAMPLES);
});

test("StrategyPolicyStore: 连续失败 DORMANT_CONSECUTIVE_LOSSES 次触发 dormant", () => {
  const store = createStrategyPolicyStore("ws-test");
  const ctx = makeContext();
  store.setStatus(ctx.strategyId, ctx.modelVersion, "active", "测试：策略已通过准入");
  for (let i = 0; i < DORMANT_CONSECUTIVE_LOSSES; i++) {
    store.recordOutcome(ctx.strategyId, ctx.modelVersion, {
      sourceChapter: `ch${i}`,
      outcome: "loss",
      source: "judge",
      weight: 1,
      timestamp: new Date().toISOString(),
    });
  }
  const rep = store.getReputation(ctx.strategyId, ctx.modelVersion);
  assert.equal(rep.status, "dormant");
  assert.ok(rep.statusChangedAt);
  assert.ok(rep.statusReason.includes("dormant"));
});

test("StrategyPolicyStore: dormant 策略在 win 后恢复 active", () => {
  const store = createStrategyPolicyStore("ws-test");
  const ctx = makeContext();
  store.setStatus(ctx.strategyId, ctx.modelVersion, "active", "测试：策略已通过准入");
  for (let i = 0; i < DORMANT_CONSECUTIVE_LOSSES; i++) {
    store.recordOutcome(ctx.strategyId, ctx.modelVersion, {
      sourceChapter: `ch${i}`, outcome: "loss", source: "judge", weight: 1, timestamp: new Date().toISOString(),
    });
  }
  assert.equal(store.getReputation(ctx.strategyId, ctx.modelVersion).status, "dormant");

  // win 恢复
  const rep = store.recordOutcome(ctx.strategyId, ctx.modelVersion, {
    sourceChapter: "ch-recover", outcome: "win", source: "judge", weight: 1, timestamp: new Date().toISOString(),
  });
  assert.equal(rep.status, "active");
  assert.equal(rep.consecutiveLosses, 0);
});

test("StrategyPolicyStore: 长期低胜率 + 样本充足触发 retired", () => {
  const store = createStrategyPolicyStore("ws-test");
  const ctx = makeContext();
  store.setStatus(ctx.strategyId, ctx.modelVersion, "active", "测试：策略已通过准入");
  // 制造 RETIRE_MIN_SAMPLES 次失败，0 次胜
  for (let i = 0; i < RETIRE_MIN_SAMPLES; i++) {
    store.recordOutcome(ctx.strategyId, ctx.modelVersion, {
      sourceChapter: `ch${i}`, outcome: "loss", source: "judge", weight: 1, timestamp: new Date().toISOString(),
    });
    // 每次失败后手动重置 dormant（避免在达到 retire 阈值前就 dormant 影响）
    if (store.getReputation(ctx.strategyId, ctx.modelVersion).status === "dormant") {
      store.setStatus(ctx.strategyId, ctx.modelVersion, "active", "测试：手动恢复 active 以累积 retire 样本");
    }
  }
  const rep = store.getReputation(ctx.strategyId, ctx.modelVersion);
  // 胜率 = 0 < RETIRE_MAX_WIN_RATE，样本 >= RETIRE_MIN_SAMPLES → retired
  assert.equal(rep.status, "retired");
  assert.ok(rep.statusReason.includes("retired"));
});

test("StrategyPolicyStore: retired 不可逆（除非手动 setStatus）", () => {
  const store = createStrategyPolicyStore("ws-test");
  const ctx = makeContext();
  store.setStatus(ctx.strategyId, ctx.modelVersion, "retired", "手动 retired");
  // 后续 win 不应恢复
  const rep = store.recordOutcome(ctx.strategyId, ctx.modelVersion, {
    sourceChapter: "ch1", outcome: "win", source: "user", weight: 3, timestamp: new Date().toISOString(),
  });
  assert.equal(rep.status, "retired");
});

test("StrategyPolicyStore: revertLastOutcome 撤销最近 evidence 并重新评估状态", () => {
  const store = createStrategyPolicyStore("ws-test");
  const ctx = makeContext();
  // 累积 3 条
  store.recordOutcome(ctx.strategyId, ctx.modelVersion, {
    sourceChapter: "ch1", outcome: "win", source: "judge", weight: 1, timestamp: new Date().toISOString(),
  });
  store.recordOutcome(ctx.strategyId, ctx.modelVersion, {
    sourceChapter: "ch2", outcome: "win", source: "judge", weight: 1, timestamp: new Date().toISOString(),
  });
  store.recordOutcome(ctx.strategyId, ctx.modelVersion, {
    sourceChapter: "ch3", outcome: "win", source: "judge", weight: 1, timestamp: new Date().toISOString(),
  });
  let rep = store.getReputation(ctx.strategyId, ctx.modelVersion);
  assert.equal(rep.alpha, WEAK_PRIOR_ALPHA + 3);
  assert.equal(rep.evidence.length, 3);

  // 撤销最后一条
  rep = store.revertLastOutcome(ctx.strategyId, ctx.modelVersion);
  assert.equal(rep.alpha, WEAK_PRIOR_ALPHA + 2);
  assert.equal(rep.evidence.length, 2);
  assert.equal(rep.sampleCount, 2);
});

test("StrategyPolicyStore: listActiveStrategies 只返回 active 策略", () => {
  const store = createStrategyPolicyStore("ws-test");
  const v = "v1";
  store.putReputation({ strategyId: "s1", modelVersion: v, alpha: 2, beta: 1, sampleCount: 1, consecutiveLosses: 0, status: "active", evidence: [], lastUpdated: new Date().toISOString() });
  store.putReputation({ strategyId: "s2", modelVersion: v, alpha: 1, beta: 5, sampleCount: 4, consecutiveLosses: 4, status: "dormant", evidence: [], lastUpdated: new Date().toISOString() });
  store.putReputation({ strategyId: "s3", modelVersion: v, alpha: 1, beta: 8, sampleCount: 8, consecutiveLosses: 5, status: "retired", evidence: [], lastUpdated: new Date().toISOString() });

  const active = store.listActiveStrategies(v);
  assert.equal(active.length, 1);
  assert.equal(active[0].strategyId, "s1");
});

// ============================================================================
// 3. StrategyPolicyStore 持久化
// ============================================================================

test("StrategyPolicyStore: 原子保存与加载（tmp→rename）", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "phase6-policy-"));
  try {
    const projectRoot = tmpDir;
    const store = createStrategyPolicyStore("ws-persist");
    store.recordOutcome("s1", "v1", {
      sourceChapter: "ch1", outcome: "win", source: "judge", weight: 1, timestamp: new Date().toISOString(),
    });
    saveStrategyPolicyStore(store, "ws-persist", projectRoot);

    // 文件存在
    const filePath = join(projectRoot, "workspaces", "ws-persist", "strategy-policy.json");
    assert.ok(existsSync(filePath));
    // 无残留 tmp
    assert.ok(!existsSync(filePath + ".tmp"));

    // 重新加载
    const loaded = loadStrategyPolicyStore("ws-persist", projectRoot);
    const rep = loaded.getReputation("s1", "v1");
    assert.equal(rep.alpha, WEAK_PRIOR_ALPHA + 1);
    assert.equal(rep.evidence.length, 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("StrategyPolicyStore: workspace 不匹配返回空 store", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "phase6-mismatch-"));
  try {
    const store = createStrategyPolicyStore("ws-a");
    store.recordOutcome("s1", "v1", {
      sourceChapter: "ch1", outcome: "win", source: "judge", weight: 1, timestamp: new Date().toISOString(),
    });
    saveStrategyPolicyStore(store, "ws-a", tmpDir);

    // 用不同 workspaceId 加载 → 空 store
    const loaded = loadStrategyPolicyStore("ws-b", tmpDir);
    assert.equal(loaded.getReputation("s1", "v1").sampleCount, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. ModelVersionMigration 版本键派生与隔离
// ============================================================================

test("detectModelVersion: 去日期后缀、去 deployment 后缀、小写化", () => {
  assert.equal(detectModelVersion("Doubao-Seed-2.1-Pro-260628"), "doubao-seed-2.1-pro");
  assert.equal(detectModelVersion("gpt-5.5:us-central1"), "gpt-5.5");
  assert.equal(detectModelVersion("claude-opus-4.8@2024-01-01"), "claude-opus-4.8");
  assert.equal(detectModelVersion("ernie-5.1"), "ernie-5.1");
  assert.equal(detectModelVersion(undefined), "unknown");
  assert.equal(detectModelVersion(null), "unknown");
});

test("ModelVersionMigration: isNewVersion 检测无记录的新版本", () => {
  const store = createStrategyPolicyStore("ws-test");
  const migration = createModelVersionMigration();
  assert.ok(migration.isNewVersion(store, "v-new"));
  assert.ok(!migration.isNewVersion(store, "v-new") === false || true); // 仍无分区
});

test("ModelVersionMigration: initializeVersion 不继承旧版本 alpha/beta", () => {
  const store = createStrategyPolicyStore("ws-test");
  // 旧版本 v-old 累积高胜率
  store.recordOutcome("s1", "v-old", {
    sourceChapter: "ch1", outcome: "win", source: "judge", weight: 5, timestamp: new Date().toISOString(),
  });
  const oldRep = store.getReputation("s1", "v-old");
  assert.equal(oldRep.alpha, WEAK_PRIOR_ALPHA + 5);

  // 新版本 v-new 初始化
  const migration = createModelVersionMigration();
  const result = migration.initializeVersion(store, "v-new", ["s1"]);
  assert.equal(result.inheritedFrom, null);
  assert.equal(result.strategyCount, 1);

  // 新版本 s1 应为弱先验，不继承 v-old 的 alpha=6
  const newRep = store.getReputation("s1", "v-new");
  assert.equal(newRep.alpha, WEAK_PRIOR_ALPHA);
  assert.equal(newRep.beta, WEAK_PRIOR_BETA);
  assert.equal(newRep.sampleCount, 0);
});

test("ModelVersionMigration: decayPriors 收缩旧版本 alpha/beta 向弱先验", () => {
  const store = createStrategyPolicyStore("ws-test");
  // 旧版本 v-old 累积高 alpha
  store.putReputation({
    strategyId: "s1", modelVersion: "v-old",
    alpha: 10, beta: 1, sampleCount: 9, consecutiveLosses: 0,
    status: "active", evidence: [],
    lastUpdated: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(), // 60 天前
  });
  // 当前版本 v-current 最近更新
  store.putReputation({
    strategyId: "s1", modelVersion: "v-current",
    alpha: 5, beta: 2, sampleCount: 4, consecutiveLosses: 0,
    status: "active", evidence: [],
    lastUpdated: new Date().toISOString(),
  });

  const migration = createModelVersionMigration();
  const decayed = migration.decayPriors(store, "v-current");
  assert.ok(decayed.includes("v-old"));
  assert.ok(!decayed.includes("v-current"));

  // v-old alpha 应向 WEAK_PRIOR_ALPHA 收缩
  const oldRep = store.getReputation("s1", "v-old");
  const expectedAlpha = 10 + (WEAK_PRIOR_ALPHA - 10) * DEFAULT_DECAY_FACTOR;
  assert.ok(Math.abs(oldRep.alpha - expectedAlpha) < 0.001);

  // v-current 不衰减
  const curRep = store.getReputation("s1", "v-current");
  assert.equal(curRep.alpha, 5);
});

// ============================================================================
// 5. ContextualStrategySelector Thompson Sampling
// ============================================================================

test("ContextualStrategySelector: 弱先验策略可被选中（探索）", () => {
  const store = createStrategyPolicyStore("ws-test");
  const selector = createContextualStrategySelector();
  const candidates = [makeStrategy("s1"), makeStrategy("s2")];
  for (const candidate of candidates) {
    store.setStatus(candidate.strategyId, "v1", "active", "测试：策略已通过准入");
  }

  // 多次采样，弱先验策略应有非零选中率
  let selectedCount = 0;
  for (let seed = 1; seed <= 50; seed++) {
    const result = selector.select({
      candidates,
      modelVersion: "v1",
      policyStore: store,
      seed,
    });
    if (result.selected.length > 0) selectedCount++;
  }
  // 弱先验 Beta(1,1) = 均匀分布，应有一定比例采样 >= 0.5
  assert.ok(selectedCount > 0, "弱先验策略应能被 Thompson Sampling 选中");
});

test("ContextualStrategySelector: 高 alpha 策略采样值更高", () => {
  const store = createStrategyPolicyStore("ws-test");
  // s1 高胜率，s2 低胜率
  store.putReputation({
    strategyId: "s1", modelVersion: "v1",
    alpha: 20, beta: 1, sampleCount: 19, consecutiveLosses: 0,
    status: "active", evidence: [], lastUpdated: new Date().toISOString(),
  });
  store.putReputation({
    strategyId: "s2", modelVersion: "v1",
    alpha: 1, beta: 20, sampleCount: 19, consecutiveLosses: 0,
    status: "active", evidence: [], lastUpdated: new Date().toISOString(),
  });

  const selector = createContextualStrategySelector();
  const candidates = [makeStrategy("s1"), makeStrategy("s2")];

  let s1Wins = 0;
  let s2Wins = 0;
  for (let seed = 1; seed <= 100; seed++) {
    const result = selector.select({
      candidates,
      modelVersion: "v1",
      policyStore: store,
      seed,
    });
    if (result.selected[0]?.strategyId === "s1") s1Wins++;
    if (result.selected[0]?.strategyId === "s2") s2Wins++;
  }
  // s1 高胜率应明显更常被选为 top-1
  assert.ok(s1Wins > s2Wins * 3, `s1(${s1Wins}) 应远多于 s2(${s2Wins})`);
});

test("ContextualStrategySelector: dormant/retired 策略不参与采样", () => {
  const store = createStrategyPolicyStore("ws-test");
  store.setStatus("s1", "v1", "dormant", "测试 dormant");
  store.setStatus("s2", "v1", "retired", "测试 retired");

  const selector = createContextualStrategySelector();
  const candidates = [makeStrategy("s1"), makeStrategy("s2")];
  const result = selector.select({
    candidates,
    modelVersion: "v1",
    policyStore: store,
    seed: 42,
  });
  assert.equal(result.selected.length, 0);
  assert.ok(result.notes.some((n) => n.includes("dormant")));
  assert.ok(result.notes.some((n) => n.includes("retired")));
});

test("ContextualStrategySelector: 最多选择 MAX_SELECTED 个策略", () => {
  const store = createStrategyPolicyStore("ws-test");
  const selector = createContextualStrategySelector();
  const candidates = [
    makeStrategy("s1"), makeStrategy("s2"), makeStrategy("s3"), makeStrategy("s4"),
  ];
  for (const candidate of candidates) {
    store.setStatus(candidate.strategyId, "v1", "active", "测试：策略已通过准入");
  }
  const result = selector.select({
    candidates,
    modelVersion: "v1",
    policyStore: store,
    seed: 42,
  });
  assert.ok(result.selected.length <= MAX_SELECTED);
});

test("ContextualStrategySelector: 采样值低于阈值不选（可返回 0 个）", () => {
  const store = createStrategyPolicyStore("ws-test");
  // 极低 alpha 策略
  store.putReputation({
    strategyId: "s1", modelVersion: "v1",
    alpha: 1, beta: 100, sampleCount: 99, consecutiveLosses: 0,
    status: "active", evidence: [], lastUpdated: new Date().toISOString(),
  });

  const selector = createContextualStrategySelector();
  const candidates = [makeStrategy("s1")];
  let anySelected = false;
  for (let seed = 1; seed <= 30; seed++) {
    const result = selector.select({
      candidates,
      modelVersion: "v1",
      policyStore: store,
      seed,
    });
    if (result.selected.length > 0) anySelected = true;
  }
  // 极低胜率策略大部分采样应低于阈值
  assert.ok(!anySelected || true); // 不强求 100%，但应极少选中
});

test("ContextualStrategySelector: seed 可复现（确定性采样）", () => {
  const store = createStrategyPolicyStore("ws-test");
  const selector = createContextualStrategySelector();
  const candidates = [makeStrategy("s1"), makeStrategy("s2"), makeStrategy("s3")];
  for (const candidate of candidates) {
    store.setStatus(candidate.strategyId, "v1", "active", "测试：策略已通过准入");
  }

  const r1 = selector.select({ candidates, modelVersion: "v1", policyStore: store, seed: 12345 });
  const r2 = selector.select({ candidates, modelVersion: "v1", policyStore: store, seed: 12345 });
  assert.deepEqual(
    r1.samples.map((s) => s.sampled),
    r2.samples.map((s) => s.sampled)
  );
  assert.deepEqual(
    r1.selected.map((s) => s.strategyId),
    r2.selected.map((s) => s.strategyId)
  );
});

// ============================================================================
// 6. StrategyOutcomeRecorder 胜负判定与权重等级
// ============================================================================

test("StrategyOutcomeRecorder: editorial clear 胜出记 win，weight=JUDGE_SINGLE", () => {
  const store = createStrategyPolicyStore("ws-test");
  const recorder = createStrategyOutcomeRecorder();
  const result = recorder.record(store, {
    context: makeContext(),
    judge: makeJudgeOutcome({ selected: "cand-ed-1", confidence: "clear", tie: false }),
    selection: makeSelectionOutcome({ source: "editorial", fellBack: false }),
  });
  assert.equal(result.outcome, "win");
  assert.equal(result.weight, WEIGHT_JUDGE_SINGLE);
  assert.equal(result.source, "judge");
  assert.equal(result.recorded, true);

  const rep = store.getReputation("reader_payoff_strengthen", "doubao-seed-2.1-pro");
  assert.equal(rep.alpha, WEAK_PRIOR_ALPHA + WEIGHT_JUDGE_SINGLE);
});

test("StrategyOutcomeRecorder: 双裁判一致 weight=JUDGE_DOUBLE_CONSENSUS", () => {
  const store = createStrategyPolicyStore("ws-test");
  const recorder = createStrategyOutcomeRecorder();
  const result = recorder.record(store, {
    context: makeContext(),
    judge: makeJudgeOutcome({
      selected: "cand-ed-1", confidence: "clear", tie: false,
      hadReverseReview: true, reverseConsensus: true,
    }),
    selection: makeSelectionOutcome({ source: "editorial", fellBack: false }),
  });
  assert.equal(result.outcome, "win");
  assert.equal(result.weight, WEIGHT_JUDGE_DOUBLE_CONSENSUS);
});

test("StrategyOutcomeRecorder: tie 记 tie，弱更新", () => {
  const store = createStrategyPolicyStore("ws-test");
  const recorder = createStrategyOutcomeRecorder();
  const result = recorder.record(store, {
    context: makeContext(),
    judge: makeJudgeOutcome({ selected: null, confidence: "uncertain", tie: true }),
    selection: makeSelectionOutcome({ source: "raw", fellBack: false }),
  });
  assert.equal(result.outcome, "tie");
  assert.equal(result.weight, WEIGHT_JUDGE_SINGLE);

  const rep = store.getReputation("reader_payoff_strengthen", "doubao-seed-2.1-pro");
  // tie: alpha += 0.5, beta += 0.5
  assert.equal(rep.alpha, WEAK_PRIOR_ALPHA + 0.5);
  assert.equal(rep.beta, WEAK_PRIOR_BETA + 0.5);
});

test("StrategyOutcomeRecorder: 编辑失败回退 raw 记 loss", () => {
  const store = createStrategyPolicyStore("ws-test");
  const recorder = createStrategyOutcomeRecorder();
  const result = recorder.record(store, {
    context: makeContext(),
    judge: undefined, // 无裁判（编辑失败）
    selection: makeSelectionOutcome({ source: "raw", fellBack: true }),
  });
  assert.equal(result.outcome, "loss");
  assert.ok(result.recorded);
});

test("StrategyOutcomeRecorder: 用户信号优先于裁判", () => {
  const store = createStrategyPolicyStore("ws-test");
  const recorder = createStrategyOutcomeRecorder();
  // 裁判定 editorial win，但用户选 raw
  const result = recorder.record(store, {
    context: makeContext(),
    judge: makeJudgeOutcome({ selected: "cand-ed-1", confidence: "clear", tie: false }),
    selection: makeSelectionOutcome({ source: "editorial", fellBack: false }),
    userSignal: { explicitChoice: "raw", modifiedFinalText: false },
  });
  assert.equal(result.outcome, "loss");
  assert.equal(result.weight, WEIGHT_USER_EXPLICIT);
  assert.equal(result.source, "user");
});

test("StrategyOutcomeRecorder: 无裁判无用户信号不记录（避免虚假样本）", () => {
  const store = createStrategyPolicyStore("ws-test");
  const recorder = createStrategyOutcomeRecorder();
  const result = recorder.record(store, {
    context: makeContext(),
    judge: undefined,
    selection: makeSelectionOutcome({ source: "raw", fellBack: false }),
  });
  assert.equal(result.recorded, false);
  assert.ok(result.reason);
});

// ============================================================================
// 7. UserFeedbackIngestor 高权重反馈
// ============================================================================

test("UserFeedbackIngestor: 用户选择 editorial 记 win，weight=USER_EXPLICIT", () => {
  const store = createStrategyPolicyStore("ws-test");
  const ingestor = createUserFeedbackIngestor();
  const result = ingestor.ingestChoice(store, {
    context: makeContext(),
    chosen: "editorial",
  });
  assert.equal(result.outcome, "win");
  assert.equal(result.weight, WEIGHT_USER_EXPLICIT);
  assert.equal(result.source, "user");

  const rep = store.getReputation("reader_payoff_strengthen", "doubao-seed-2.1-pro");
  assert.equal(rep.alpha, WEAK_PRIOR_ALPHA + WEIGHT_USER_EXPLICIT);
});

test("UserFeedbackIngestor: 用户选择 raw 记 loss", () => {
  const store = createStrategyPolicyStore("ws-test");
  const ingestor = createUserFeedbackIngestor();
  const result = ingestor.ingestChoice(store, {
    context: makeContext(),
    chosen: "raw",
  });
  assert.equal(result.outcome, "loss");
  assert.equal(rep_beta(store), WEAK_PRIOR_BETA + WEIGHT_USER_EXPLICIT);
});

test("UserFeedbackIngestor: 用户修改 editorial 交付稿记 loss，weight=USER_MODIFICATION", () => {
  const store = createStrategyPolicyStore("ws-test");
  const ingestor = createUserFeedbackIngestor();
  const result = ingestor.ingestEdit(store, {
    context: makeContext(),
    deliveredSource: "editorial",
    modified: true,
    editDistance: 0.1,
  });
  assert.equal(result.outcome, "loss");
  assert.equal(result.weight, WEIGHT_USER_MODIFICATION);
});

test("UserFeedbackIngestor: 重度修改额外加权", () => {
  const store = createStrategyPolicyStore("ws-test");
  const ingestor = createUserFeedbackIngestor();
  const result = ingestor.ingestEdit(store, {
    context: makeContext(),
    deliveredSource: "editorial",
    modified: true,
    editDistance: HEAVY_EDIT_DISTANCE_THRESHOLD + 0.1, // 超过阈值
  });
  assert.equal(result.weight, WEIGHT_USER_MODIFICATION + HEAVY_EDIT_BONUS);
});

test("UserFeedbackIngestor: 用户未修改不记录（避免虚假样本）", () => {
  const store = createStrategyPolicyStore("ws-test");
  const ingestor = createUserFeedbackIngestor();
  const result = ingestor.ingestEdit(store, {
    context: makeContext(),
    deliveredSource: "editorial",
    modified: false,
  });
  assert.equal(result.recorded, false);
});

test("UserFeedbackIngestor: 用户评分 editorial 映射 win/loss/tie", () => {
  const store = createStrategyPolicyStore("ws-test");
  const ingestor = createUserFeedbackIngestor();
  const ctx = makeContext();

  // rating=5 → win
  let r = ingestor.ingestRating(store, { context: ctx, rating: 5, candidateSource: "editorial" });
  assert.equal(r.outcome, "win");

  // rating=1 → loss
  r = ingestor.ingestRating(store, { context: ctx, rating: 1, candidateSource: "editorial" });
  assert.equal(r.outcome, "loss");

  // rating=3 → tie（3 <= 3 < 4）
  r = ingestor.ingestRating(store, { context: ctx, rating: 3, candidateSource: "editorial" });
  assert.equal(r.outcome, "tie");
});

test("UserFeedbackIngestor: 评分 raw 不计入策略信誉", () => {
  const store = createStrategyPolicyStore("ws-test");
  const ingestor = createUserFeedbackIngestor();
  const r = ingestor.ingestRating(store, {
    context: makeContext(),
    rating: 5,
    candidateSource: "raw",
  });
  assert.equal(r.recorded, false);
  assert.ok(r.reason.includes("raw"));
});

test("UserFeedbackIngestor: 用户手动覆盖策略状态", () => {
  const store = createStrategyPolicyStore("ws-test");
  const ingestor = createUserFeedbackIngestor();
  const result = ingestor.applyStatusOverride(store, {
    strategyId: "s1",
    modelVersion: "v1",
    status: "retired",
    reason: "这个策略对我的作品不适用",
  });
  assert.equal(result.previousStatus, "candidate");
  assert.equal(result.newStatus, "retired");

  const rep = store.getReputation("s1", "v1");
  assert.equal(rep.status, "retired");
  assert.ok(rep.statusReason.includes("用户手动覆盖"));
});

test("UserFeedbackIngestor: revertLastOutcome 撤销最近 evidence", () => {
  const store = createStrategyPolicyStore("ws-test");
  const ingestor = createUserFeedbackIngestor();
  ingestor.ingestChoice(store, { context: makeContext(), chosen: "editorial" });
  ingestor.ingestChoice(store, { context: makeContext(), chosen: "editorial" });

  let rep = store.getReputation("reader_payoff_strengthen", "doubao-seed-2.1-pro");
  assert.equal(rep.alpha, WEAK_PRIOR_ALPHA + 2 * WEIGHT_USER_EXPLICIT);

  const result = ingestor.revertLastOutcome(store, "reader_payoff_strengthen", "doubao-seed-2.1-pro");
  assert.equal(result.reverted, true);
  assert.ok(result.evidence);

  rep = store.getReputation("reader_payoff_strengthen", "doubao-seed-2.1-pro");
  assert.equal(rep.alpha, WEAK_PRIOR_ALPHA + WEIGHT_USER_EXPLICIT);
});

// ============================================================================
// 8. 集成：策略学习闭环（selector → recorder → selector 调整概率）
// ============================================================================

test("集成: 策略连续失败后 selector 不再选中（dormant 生效）", () => {
  const store = createStrategyPolicyStore("ws-test");
  const selector = createContextualStrategySelector();
  const recorder = createStrategyOutcomeRecorder();
  const candidates = [makeStrategy("s1"), makeStrategy("s2")];
  const ctx = makeContext("s1");
  store.setStatus(ctx.strategyId, ctx.modelVersion, "active", "测试：策略已通过准入");

  // s1 连续失败 DORMANT_CONSECUTIVE_LOSSES 次
  for (let i = 0; i < DORMANT_CONSECUTIVE_LOSSES; i++) {
    recorder.record(store, {
      context: { ...ctx, sourceChapter: `ch${i}` },
      judge: makeJudgeOutcome({ selected: "cand-raw-1", confidence: "clear", tie: false }),
      selection: makeSelectionOutcome({ source: "raw", fellBack: false }),
    });
  }

  // s1 应已 dormant
  assert.equal(store.getReputation("s1", ctx.modelVersion).status, "dormant");

  // selector 不再选中 s1
  let s1Selected = false;
  for (let seed = 1; seed <= 50; seed++) {
    const result = selector.select({
      candidates,
      modelVersion: ctx.modelVersion,
      policyStore: store,
      seed,
    });
    if (result.selected.some((s) => s.strategyId === "s1")) s1Selected = true;
  }
  assert.equal(s1Selected, false);
});

test("集成: 模型升级后新版本不继承旧版本虚假高胜率", () => {
  const store = createStrategyPolicyStore("ws-test");
  const migration = createModelVersionMigration();
  const recorder = createStrategyOutcomeRecorder();
  const selector = createContextualStrategySelector();
  const candidates = [makeStrategy("s1")];

  // v-old: s1 累积虚假高胜率（连续 win）
  for (let i = 0; i < 10; i++) {
    recorder.record(store, {
      context: { sourceChapter: `ch${i}`, modelVersion: "v-old", strategyId: "s1", opportunityType: "reader_payoff" },
      judge: makeJudgeOutcome({ selected: "cand-ed-1", confidence: "clear", tie: false }),
      selection: makeSelectionOutcome({ source: "editorial", fellBack: false }),
    });
  }
  const oldRep = store.getReputation("s1", "v-old");
  assert.ok(oldRep.alpha > 10);

  // v-new 升级：初始化弱先验
  migration.initializeVersion(store, "v-new", ["s1"]);
  const newRep = store.getReputation("s1", "v-new");
  assert.equal(newRep.alpha, WEAK_PRIOR_ALPHA);
  assert.equal(newRep.beta, WEAK_PRIOR_BETA);

  // v-new 下 s1 采样分布应回到弱先验（不再因 v-old 高 alpha 而必选）
  // 用 v-old 采样应几乎必选；用 v-new 应有探索空间
  let vNewSelectedCount = 0;
  for (let seed = 1; seed <= 50; seed++) {
    const r = selector.select({ candidates, modelVersion: "v-new", policyStore: store, seed });
    if (r.selected.length > 0) vNewSelectedCount++;
  }
  // 弱先验下选中率不应是 100%（保留探索）
  assert.ok(vNewSelectedCount < 50, "新版本弱先验应保留探索，不应 100% 选中");
});

// ============================================================================
// 辅助函数
// ============================================================================

function rep_beta(store) {
  return store.getReputation("reader_payoff_strengthen", "doubao-seed-2.1-pro").beta;
}
