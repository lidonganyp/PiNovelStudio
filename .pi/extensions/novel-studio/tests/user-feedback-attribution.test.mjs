/**
 * USER-FEEDBACK-EVIDENCE-PIPELINE-1 — 反馈归因与修改语义（16 项场景 1-7, 13）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createStrategyPolicyStore,
  WEAK_PRIOR_ALPHA,
  WEAK_PRIOR_BETA,
} from "../dist/v2/learning/strategy-policy-store.js";
import {
  createUserFeedbackIngestor,
  HEAVY_EDIT_DISTANCE_THRESHOLD,
} from "../dist/v2/learning/user-feedback-ingestor.js";
import {
  computeUserModificationDelta,
} from "../dist/v2/learning/user-modification-delta.js";
import {
  assertFeedbackAffectsNextRequestOnly,
  FEEDBACK_FORBIDDEN_MUTATIONS,
  literaryFeedbackAllowedOnlineActions,
  buildStrategyBundleId,
  isCompleteLineage,
} from "../dist/v2/learning/feedback-evidence-contracts.js";
import {
  createStrategyOutcomeRecorder,
  WEIGHT_USER_EXPLICIT,
} from "../dist/v2/learning/strategy-outcome-recorder.js";

function makeContext(strategyId = "reader_payoff_strengthen", modelVersion = "glm-5.2") {
  return {
    sourceChapter: "ch1",
    modelVersion,
    strategyId,
    opportunityType: "reader_payoff",
  };
}

const COMPLETE_LINEAGE = {
  orchestratorRunId: "run-1",
  candidateId: "cand-ed-1",
  strategyBundleId: "bundle:reader_payoff_strengthen",
  strategyId: "reader_payoff_strengthen",
  modelVersion: "glm-5.2",
  promptBundleId: "prompt-v1",
  deliveredSource: "editorial",
  exposureId: "exp-1",
  feedbackEventId: "fb-1",
  sourceChapter: "ch1",
};

// 1. 完整绑定的 editorial 被接受
test("场景1: 完整绑定 editorial 接受 → explicit_direct win 强证据", () => {
  const store = createStrategyPolicyStore("ws-attr");
  const ingestor = createUserFeedbackIngestor();
  const result = ingestor.ingestChoice(store, {
    context: makeContext(),
    chosen: "editorial",
    lineage: COMPLETE_LINEAGE,
    feedbackEventId: "fb-accept-1",
  });
  assert.equal(result.recorded, true);
  assert.equal(result.outcome, "win");
  assert.equal(result.feedbackLevel, "explicit_direct");
  assert.equal(result.decisionCount, 1);
  assert.equal(result.weight, WEIGHT_USER_EXPLICIT);
  const rep = store.getReputation("reader_payoff_strengthen", "glm-5.2");
  assert.equal(rep.alpha, WEAK_PRIOR_ALPHA + WEIGHT_USER_EXPLICIT);
  assert.equal(rep.sampleCount, 1);
});

// 2. editorial 被接受但缺少策略归因
test("场景2: 缺少完整血缘的选择 → neutral 不更新信誉", () => {
  const store = createStrategyPolicyStore("ws-attr");
  const ingestor = createUserFeedbackIngestor();
  const result = ingestor.ingestChoice(store, {
    context: makeContext(),
    chosen: "editorial",
    lineage: { orchestratorRunId: "run-x" }, // 不完整
    feedbackEventId: "fb-incomplete",
  });
  assert.equal(result.recorded, false);
  assert.equal(result.feedbackLevel, "natural_language_unattributed");
  assert.equal(result.attribution.outcome, "neutral");
  const rep = store.getReputation("reader_payoff_strengthen", "glm-5.2");
  assert.equal(rep.sampleCount, 0);
  assert.equal(rep.alpha, WEAK_PRIOR_ALPHA);
});

// 3. editorial 被轻度局部修改
test("场景3: 轻度局部修改 → 弱 loss 或 neutral，decisionCount=1", () => {
  const store = createStrategyPolicyStore("ws-attr");
  const ingestor = createUserFeedbackIngestor();
  const delivered = "叶尘推开石门，冷风灌入洞穴。他握紧剑柄，向前走了一步。";
  const userFinal = "叶尘推开石门，冷风灌入洞穴。他握紧剑柄，向前迈了一步。";
  const delta = computeUserModificationDelta(delivered, userFinal);
  const result = ingestor.ingestEdit(store, {
    context: makeContext(),
    deliveredSource: "editorial",
    modified: delta.modified,
    editDistance: delta.editDistance,
    delta,
    classification: delta.classification,
    feedbackEventId: "fb-light-edit",
  });
  assert.equal(result.decisionCount, 1);
  if (result.recorded) {
    assert.equal(result.outcome, "loss");
    assert.ok(result.weight <= 3);
  }
  // 绝不能把 weight 当成多个 sample
  const rep = store.getReputation("reader_payoff_strengthen", "glm-5.2");
  assert.ok(rep.sampleCount <= 1);
});

// 4. editorial 被重度结构修改
test("场景4: 重度结构修改 → 强 loss，decisionCount=1 不虚增样本", () => {
  const store = createStrategyPolicyStore("ws-attr");
  const ingestor = createUserFeedbackIngestor();
  const delivered = "叶尘推开石门。冷风灌入。他握紧剑柄。";
  const userFinal =
    "石门外传来脚步声。苏晚拦住去路，低声说别进去。叶尘后退半步，把剑收回鞘中，决定改道从侧廊绕行。";
  const delta = computeUserModificationDelta(delivered, userFinal, "结构调整 改事件顺序");
  assert.equal(delta.decisionCount, 1);
  const result = ingestor.ingestEdit(store, {
    context: makeContext(),
    deliveredSource: "editorial",
    modified: true,
    editDistance: Math.max(delta.editDistance, HEAVY_EDIT_DISTANCE_THRESHOLD + 0.05),
    delta,
    classification: {
      ...delta.classification,
      editType: "structure",
      editScope: "scene",
      attributionConfidence: "high",
      weightedEvidence: 3,
      decisionCount: 1,
      factIssue: false,
      settingCompletion: false,
      retainedCoreEffect: false,
    },
    feedbackEventId: "fb-heavy-edit",
  });
  assert.equal(result.recorded, true);
  assert.equal(result.outcome, "loss");
  assert.equal(result.decisionCount, 1);
  const rep = store.getReputation("reader_payoff_strengthen", "glm-5.2");
  assert.equal(rep.sampleCount, 1);
  assert.ok(rep.beta > WEAK_PRIOR_BETA);
});

// 5. 用户只修改事实
test("场景5: 事实修正 → neutral，不惩罚文学策略", () => {
  const store = createStrategyPolicyStore("ws-attr");
  const ingestor = createUserFeedbackIngestor();
  const delta = computeUserModificationDelta(
    "叶尘今年十八岁，刚入门派。",
    "叶尘今年十六岁，刚入门派。",
    "事实修正：年龄与前文时间线冲突",
  );
  assert.equal(delta.factIssue || delta.editType === "fact", true);
  const result = ingestor.ingestEdit(store, {
    context: makeContext(),
    deliveredSource: "editorial",
    modified: true,
    editDistance: delta.editDistance,
    delta,
    classification: delta.classification,
    note: "事实修正：年龄与前文时间线冲突",
    feedbackEventId: "fb-fact",
  });
  assert.equal(result.recorded, false);
  assert.equal(result.attribution.outcome, "neutral");
  const rep = store.getReputation("reader_payoff_strengthen", "glm-5.2");
  assert.equal(rep.sampleCount, 0);
  assert.equal(rep.beta, WEAK_PRIOR_BETA);
});

// 6. 用户拒绝代理稿
test("场景6: 用户拒绝 → loss", () => {
  const store = createStrategyPolicyStore("ws-attr");
  const ingestor = createUserFeedbackIngestor();
  const result = ingestor.ingestChoice(store, {
    context: makeContext(),
    chosen: "raw",
    feedbackEventId: "fb-reject",
  });
  assert.equal(result.recorded, true);
  assert.equal(result.outcome, "loss");
});

// 7. rollback 语义：定点撤销后信誉回退
test("场景7: rollback 已提交反馈 → evidenceId 定点撤销后信誉回退", () => {
  const store = createStrategyPolicyStore("ws-attr");
  const ingestor = createUserFeedbackIngestor();
  const first = ingestor.ingestChoice(store, {
    context: makeContext(),
    chosen: "editorial",
    feedbackEventId: "fb-roll-1",
  });
  assert.equal(first.recorded, true);
  const evidenceId = first.evidence.evidenceId;
  assert.ok(evidenceId);

  let rep = store.getReputation("reader_payoff_strengthen", "glm-5.2");
  assert.equal(rep.alpha, WEAK_PRIOR_ALPHA + WEIGHT_USER_EXPLICIT);

  const reverted = ingestor.revertOutcomeByEvidenceId(
    store,
    "reader_payoff_strengthen",
    "glm-5.2",
    evidenceId,
  );
  assert.equal(reverted.reverted, true);
  rep = store.getReputation("reader_payoff_strengthen", "glm-5.2");
  assert.equal(rep.alpha, WEAK_PRIOR_ALPHA);
  assert.equal(rep.sampleCount, 0);
});

// 13. 无法归因的自然语言反馈不得污染策略
test("场景13: 无法归因自然语言 → neutral 污染率 0", () => {
  const store = createStrategyPolicyStore("ws-attr");
  const ingestor = createUserFeedbackIngestor();
  // 模拟无法归因：lineage 不完整
  const result = ingestor.ingestChoice(store, {
    context: makeContext(),
    chosen: "raw",
    lineage: { feedbackEventId: "nl-1" },
    feedbackEventId: "nl-1",
  });
  assert.equal(result.recorded, false);
  assert.equal(result.feedbackLevel, "natural_language_unattributed");
  const rep = store.getReputation("reader_payoff_strengthen", "glm-5.2");
  assert.equal(rep.sampleCount, 0);
  assert.equal(rep.alpha, WEAK_PRIOR_ALPHA);
  assert.equal(rep.beta, WEAK_PRIOR_BETA);
});

// raw 交付修改不计入策略
test("raw 交付稿修改不计入该策略信誉", () => {
  const store = createStrategyPolicyStore("ws-attr");
  const ingestor = createUserFeedbackIngestor();
  const result = ingestor.ingestEdit(store, {
    context: makeContext(),
    deliveredSource: "raw",
    modified: true,
    editDistance: 0.5,
    feedbackEventId: "fb-raw-edit",
  });
  assert.equal(result.recorded, false);
  assert.match(result.reason ?? "", /不计入/);
  const rep = store.getReputation("reader_payoff_strengthen", "glm-5.2");
  assert.equal(rep.sampleCount, 0);
});

// 越权边界
test("场景16: 反馈不得修改硬门禁/事实/Prompt Bundle", () => {
  const check = assertFeedbackAffectsNextRequestOnly([...FEEDBACK_FORBIDDEN_MUTATIONS]);
  assert.equal(check.ok, false);
  assert.ok(check.violations.length > 0);

  const ok = assertFeedbackAffectsNextRequestOnly(["next_request_sampling_probability"]);
  assert.equal(ok.ok, true);
});

test("文学负反馈在线动作不含 retired", () => {
  const actions = literaryFeedbackAllowedOnlineActions("loss");
  assert.ok(actions.includes("downweight_next_request"));
  assert.ok(!actions.includes("retired"));
});

test("isCompleteLineage / buildStrategyBundleId 契约", () => {
  assert.equal(isCompleteLineage(COMPLETE_LINEAGE), true);
  assert.equal(isCompleteLineage({ orchestratorRunId: "x" }), false);
  assert.equal(
    buildStrategyBundleId(["b", "a"]),
    "bundle:a+b",
  );
});

test("outcome recorder: raw 修改不记策略 loss", () => {
  const store = createStrategyPolicyStore("ws-attr");
  const recorder = createStrategyOutcomeRecorder();
  const result = recorder.record(store, {
    context: makeContext(),
    selection: {
      deliveredCandidateId: "raw-1",
      deliveredSource: "raw",
      fellBackToRaw: false,
    },
    userSignal: { modifiedFinalText: true, editDistance: 0.4 },
  });
  assert.equal(result.recorded, false);
  assert.equal(result.weight, 0);
});
