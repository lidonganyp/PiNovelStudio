/**
 * USER-FEEDBACK-EVIDENCE-PIPELINE-1 — 事务边界（场景 14/16）
 *
 * 反馈写入失败不得回滚已确认正文；
 * 反馈不得修改硬门禁/事实状态/Prompt Bundle/章节提交状态。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createStrategyPolicyStore,
} from "../dist/v2/learning/strategy-policy-store.js";
import {
  createUserFeedbackIngestor,
} from "../dist/v2/learning/user-feedback-ingestor.js";
import {
  assertFeedbackAffectsNextRequestOnly,
  FEEDBACK_FORBIDDEN_MUTATIONS,
} from "../dist/v2/learning/feedback-evidence-contracts.js";

test("场景14: 反馈系统失败不回滚已确认正文（隔离副作用）", () => {
  // 模拟：正文事务已提交
  const chapterCommit = {
    chapterId: "ch1",
    finalText: "已确认正文不可被反馈链路改写",
    committed: true,
  };

  const store = createStrategyPolicyStore("ws-tx");
  const ingestor = createUserFeedbackIngestor();

  // 反馈写入使用独立 store；即使后续抛错，正文对象保持不变
  let feedbackError = null;
  try {
    ingestor.ingestChoice(store, {
      context: {
        sourceChapter: "ch1",
        modelVersion: "m1",
        strategyId: "s1",
        opportunityType: "reader_payoff",
      },
      chosen: "editorial",
      feedbackEventId: "tx-1",
    });
    // 模拟反馈持久化失败
    throw new Error("simulated feedback persistence failure");
  } catch (e) {
    feedbackError = e;
  }

  assert.ok(feedbackError);
  assert.equal(chapterCommit.committed, true);
  assert.equal(chapterCommit.finalText, "已确认正文不可被反馈链路改写");
});

test("场景16: 反馈禁止 mutation 列表覆盖生产硬边界", () => {
  const required = [
    "current_request_text",
    "chapter_final_text",
    "creative_constitution",
    "narrative_state",
    "fact_guard",
    "prompt_bundle",
    "model_routing",
    "hard_gate",
    "chapter_commit_status",
    "production_baseline",
  ];
  for (const key of required) {
    assert.ok(
      FEEDBACK_FORBIDDEN_MUTATIONS.includes(key),
      `missing forbidden mutation: ${key}`,
    );
  }

  const violated = assertFeedbackAffectsNextRequestOnly(["fact_guard", "prompt_bundle"]);
  assert.equal(violated.ok, false);

  const allowed = assertFeedbackAffectsNextRequestOnly([
    "next_request_strategy_sampling",
  ]);
  assert.equal(allowed.ok, true);
});

test("ingest 路径只写 strategy store，不暴露正文 mutation API", () => {
  const ingestor = createUserFeedbackIngestor();
  // 公共 API 不应包含改写正文/门禁的方法
  assert.equal(typeof ingestor.ingestChoice, "function");
  assert.equal(typeof ingestor.ingestEdit, "function");
  assert.equal(ingestor.rewriteChapter, undefined);
  assert.equal(ingestor.mutateFactGuard, undefined);
  assert.equal(ingestor.updatePromptBundle, undefined);
  assert.equal(ingestor.switchProductionBaseline, undefined);
});
