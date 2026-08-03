/**
 * Phase 4B/4C 测试：作者风格优化策略选择 + 模型版本隔离
 *
 * 验证 author-style-strategy-registry.ts 的核心行为：
 * - 默认策略集包含 3 个 arm（guidance_reduction / voice_emphasis / rhythm_adjustment）
 * - Thompson Sampling 在 modelVersion 隔离的 policyStore 上选择 0-2 个策略
 * - mergeStrategyParams 合并多策略参数
 * - candidate 策略不参与在线采样（staticFallback）
 * - 模型版本隔离：不同 modelVersion 的策略信誉独立（Phase 4C）
 * - 新 modelVersion 无历史经验时使用弱先验 Beta(1,1)（不限制新模型能力）
 *
 * 不调用真实模型，纯规则测试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_AUTHOR_STYLE_STRATEGIES,
  selectAuthorStyleStrategies,
  mergeStrategyParams,
  buildAuthorStyleStrategyContext,
} from "../dist/v2/learning/author-style-strategy-registry.js";
import {
  createStrategyPolicyStore,
  WEAK_PRIOR_ALPHA,
  WEAK_PRIOR_BETA,
} from "../dist/v2/learning/strategy-policy-store.js";

describe("Phase 4B: author-style-strategy-registry — 作者风格优化策略选择", () => {
  it("默认策略集包含 3 个 arm", () => {
    assert.equal(DEFAULT_AUTHOR_STYLE_STRATEGIES.length, 3, `应有 3 个默认策略，实际: ${DEFAULT_AUTHOR_STYLE_STRATEGIES.length}`);
    const ids = DEFAULT_AUTHOR_STYLE_STRATEGIES.map((s) => s.strategyId).sort();
    assert.deepEqual(ids, ["guidance_reduction", "rhythm_adjustment", "voice_emphasis"]);
  });

  it("每个默认策略都有 strategyId / label / objective / params", () => {
    for (const strat of DEFAULT_AUTHOR_STYLE_STRATEGIES) {
      assert.ok(strat.strategyId.length > 0, "strategyId 应非空");
      assert.ok(strat.label.length > 0, "label 应非空");
      assert.ok(strat.objective.length > 0, "objective 应非空");
      assert.ok(strat.params, "params 应存在");
      assert.equal(strat.opportunityType, "author_style", "opportunityType 应为 author_style");
    }
  });

  it("guidance_reduction 策略有 reducedGuidanceRatio 参数（0-1）", () => {
    const strat = DEFAULT_AUTHOR_STYLE_STRATEGIES.find((s) => s.strategyId === "guidance_reduction");
    assert.ok(strat, "guidance_reduction 策略应存在");
    assert.ok(typeof strat.params.reducedGuidanceRatio === "number", "reducedGuidanceRatio 应为 number");
    assert.ok(strat.params.reducedGuidanceRatio > 0 && strat.params.reducedGuidanceRatio < 1, "reducedGuidanceRatio 应在 0-1 之间");
  });

  it("voice_emphasis 策略有 voiceEmphasisBlock 参数", () => {
    const strat = DEFAULT_AUTHOR_STYLE_STRATEGIES.find((s) => s.strategyId === "voice_emphasis");
    assert.ok(strat, "voice_emphasis 策略应存在");
    assert.ok(typeof strat.params.voiceEmphasisBlock === "string", "voiceEmphasisBlock 应为 string");
    assert.ok(strat.params.voiceEmphasisBlock.length > 0, "voiceEmphasisBlock 应非空");
  });

  it("rhythm_adjustment 策略有 rhythmAdjustmentBlock 参数", () => {
    const strat = DEFAULT_AUTHOR_STYLE_STRATEGIES.find((s) => s.strategyId === "rhythm_adjustment");
    assert.ok(strat, "rhythm_adjustment 策略应存在");
    assert.ok(typeof strat.params.rhythmAdjustmentBlock === "string", "rhythmAdjustmentBlock 应为 string");
    assert.ok(strat.params.rhythmAdjustmentBlock.length > 0, "rhythmAdjustmentBlock 应非空");
  });

  it("Thompson Sampling 在弱先验下选择策略（无历史经验时仍可探索）", () => {
    const store = createStrategyPolicyStore("test-ws");
    // 新 modelVersion 无历史经验 → 弱先验 Beta(1,1) = 均匀分布
    const result = selectAuthorStyleStrategies({
      modelVersion: "new-model-v1",
      policyStore: store,
      seed: 42, // 固定种子便于复现
    });
    // 在弱先验下，0-2 个策略被选中（具体取决于采样值）
    assert.ok(result.selected.length <= 2, `最多选 2 个策略，实际: ${result.selected.length}`);
    assert.equal(result.samples.length, 3, "应采样全部 3 个候选策略");
    // 弱先验下所有策略都是 candidate（未准入）
    assert.equal(result.staticFallback.length, 3, "弱先验下所有策略都是 candidate，进 staticFallback");
    assert.equal(result.selected.length, 0, "candidate 策略不参与在线采样，selected 应为 0");
  });

  it("已准入 active 策略参与 Thompson Sampling", () => {
    const store = createStrategyPolicyStore("test-ws");
    // 手动把 guidance_reduction 设为 active，并给予高胜率
    store.setStatus("guidance_reduction", "model-v1", "active", "测试用：手动准入");
    // 给 guidance_reduction 高胜率（10 win, 1 loss）
    for (let i = 0; i < 10; i++) {
      store.recordOutcome("guidance_reduction", "model-v1", {
        sourceChapter: `ch${i}`,
        outcome: "win",
        source: "user",
        weight: 1,
        timestamp: new Date().toISOString(),
      });
    }
    store.recordOutcome("guidance_reduction", "model-v1", {
      sourceChapter: "ch10",
      outcome: "loss",
      source: "user",
      weight: 1,
      timestamp: new Date().toISOString(),
    });

    const result = selectAuthorStyleStrategies({
      modelVersion: "model-v1",
      policyStore: store,
      seed: 42,
    });

    // guidance_reduction 应被采样（active 状态）
    const sampled = result.samples.find((s) => s.strategyId === "guidance_reduction");
    assert.ok(sampled, "guidance_reduction 应被采样");
    assert.equal(sampled.status, "active", "状态应为 active");
    assert.ok(sampled.sampled > 0, `采样值应 > 0，实际: ${sampled.sampled}`);
  });

  it("dormant 策略不参与采样", () => {
    const store = createStrategyPolicyStore("test-ws");
    store.setStatus("voice_emphasis", "model-v1", "dormant", "测试用：dormant");
    const result = selectAuthorStyleStrategies({
      modelVersion: "model-v1",
      policyStore: store,
      seed: 42,
    });
    const voiceSample = result.samples.find((s) => s.strategyId === "voice_emphasis");
    assert.ok(voiceSample, "voice_emphasis 应在 samples 中");
    assert.equal(voiceSample.status, "dormant", "状态应为 dormant");
    assert.equal(voiceSample.selected, false, "dormant 策略不应被选中");
  });

  it("retired 策略不参与采样", () => {
    const store = createStrategyPolicyStore("test-ws");
    store.setStatus("rhythm_adjustment", "model-v1", "retired", "测试用：retired");
    const result = selectAuthorStyleStrategies({
      modelVersion: "model-v1",
      policyStore: store,
      seed: 42,
    });
    const rhythmSample = result.samples.find((s) => s.strategyId === "rhythm_adjustment");
    assert.ok(rhythmSample, "rhythm_adjustment 应在 samples 中");
    assert.equal(rhythmSample.status, "retired", "状态应为 retired");
    assert.equal(rhythmSample.selected, false, "retired 策略不应被选中");
  });
});

describe("Phase 4B: mergeStrategyParams — 策略参数合并", () => {
  it("空选中列表 → 空参数对象", () => {
    const params = mergeStrategyParams([]);
    assert.equal(Object.keys(params).length, 0, "应返回空对象");
  });

  it("单个 guidance_reduction → reducedGuidanceRatio", () => {
    const strat = DEFAULT_AUTHOR_STYLE_STRATEGIES.find((s) => s.strategyId === "guidance_reduction");
    assert.ok(strat, "guidance_reduction 策略应存在");
    const params = mergeStrategyParams([strat]);
    assert.ok(typeof params.reducedGuidanceRatio === "number", "应有 reducedGuidanceRatio");
    assert.equal(params.voiceEmphasisBlock, undefined, "不应有 voiceEmphasisBlock");
    assert.equal(params.rhythmAdjustmentBlock, undefined, "不应有 rhythmAdjustmentBlock");
  });

  it("多个策略合并：reducedGuidanceRatio 取最小值，其他块拼接", () => {
    const customStrategies = [
      {
        strategyId: "guidance_reduction_a",
        opportunityType: "author_style",
        label: "A",
        objective: "A",
        params: { reducedGuidanceRatio: 0.7, voiceEmphasisBlock: "块A" },
      },
      {
        strategyId: "guidance_reduction_b",
        opportunityType: "author_style",
        label: "B",
        objective: "B",
        params: { reducedGuidanceRatio: 0.5, rhythmAdjustmentBlock: "块B" },
      },
    ];
    const params = mergeStrategyParams(customStrategies);
    assert.equal(params.reducedGuidanceRatio, 0.5, "应取最小值 0.5");
    assert.ok(params.voiceEmphasisBlock?.includes("块A"), "voiceEmphasisBlock 应包含块A");
    assert.ok(params.rhythmAdjustmentBlock?.includes("块B"), "rhythmAdjustmentBlock 应包含块B");
  });
});

describe("Phase 4B: buildAuthorStyleStrategyContext — 策略上下文构造", () => {
  it("构造的上下文包含 sourceChapter / modelVersion / strategyIds / opportunityType", () => {
    const firstStrategy = DEFAULT_AUTHOR_STYLE_STRATEGIES[0];
    assert.ok(firstStrategy, "应有至少一个默认策略");
    const selected = [firstStrategy];
    const ctx = buildAuthorStyleStrategyContext({
      sourceChapter: "ch17",
      modelVersion: "model-v1",
      selected,
    });
    assert.equal(ctx.sourceChapter, "ch17");
    assert.equal(ctx.modelVersion, "model-v1");
    assert.equal(ctx.opportunityType, "author_style");
    assert.deepEqual(ctx.strategyIds, ["guidance_reduction"]);
  });

  it("空选中列表 → strategyIds 为空数组", () => {
    const ctx = buildAuthorStyleStrategyContext({
      sourceChapter: "ch17",
      modelVersion: "model-v1",
      selected: [],
    });
    assert.deepEqual(ctx.strategyIds, []);
  });
});

describe("Phase 4C: 模型版本隔离 — 策略信誉按 modelVersion 独立存储", () => {
  it("不同 modelVersion 的策略信誉独立", () => {
    const store = createStrategyPolicyStore("test-ws");
    // model-v1 的 guidance_reduction 设为 active，积累 win
    store.setStatus("guidance_reduction", "model-v1", "active", "v1 准入");
    store.recordOutcome("guidance_reduction", "model-v1", {
      sourceChapter: "ch1",
      outcome: "win",
      source: "user",
      weight: 3,
      timestamp: new Date().toISOString(),
    });

    // model-v2 的 guidance_reduction 仍是 candidate（无历史经验）
    const repV1 = store.getReputation("guidance_reduction", "model-v1");
    const repV2 = store.getReputation("guidance_reduction", "model-v2");

    assert.equal(repV1.status, "active", "v1 应为 active");
    assert.equal(repV2.status, "candidate", "v2 应为 candidate（无历史经验）");
    assert.ok(repV1.alpha > WEAK_PRIOR_ALPHA, `v1 alpha 应 > 弱先验，实际: ${repV1.alpha}`);
    assert.equal(repV2.alpha, WEAK_PRIOR_BETA, `v2 alpha 应为弱先验 ${WEAK_PRIOR_ALPHA}，实际: ${repV2.alpha}`);
  });

  it("新 modelVersion 无历史经验时使用弱先验 Beta(1,1)（不限制新模型能力）", () => {
    const store = createStrategyPolicyStore("test-ws");
    const rep = store.getReputation("guidance_reduction", "brand-new-model-v3");
    assert.equal(rep.alpha, WEAK_PRIOR_ALPHA, `alpha 应为弱先验 ${WEAK_PRIOR_ALPHA}`);
    assert.equal(rep.beta, WEAK_PRIOR_BETA, `beta 应为弱先验 ${WEAK_PRIOR_BETA}`);
    assert.equal(rep.sampleCount, 0, "sampleCount 应为 0");
    assert.equal(rep.status, "candidate", "status 应为 candidate");
    assert.equal(rep.evidence.length, 0, "evidence 应为空");
  });

  it("旧 modelVersion 的高胜率不影响新 modelVersion 的策略选择", () => {
    const store = createStrategyPolicyStore("test-ws");
    // old-model 积累高胜率
    store.setStatus("guidance_reduction", "old-model", "active", "旧模型准入");
    for (let i = 0; i < 5; i++) {
      store.recordOutcome("guidance_reduction", "old-model", {
        sourceChapter: `ch${i}`,
        outcome: "win",
        source: "user",
        weight: 3,
        timestamp: new Date().toISOString(),
      });
    }

    // 新模型选择策略时，old-model 的高胜率不影响 new-model
    const result = selectAuthorStyleStrategies({
      modelVersion: "new-model",
      policyStore: store,
      seed: 42,
    });

    // new-model 下 guidance_reduction 应是 candidate（弱先验），进 staticFallback
    const guidanceSample = result.samples.find((s) => s.strategyId === "guidance_reduction");
    assert.ok(guidanceSample, "应被采样");
    assert.equal(guidanceSample.status, "candidate", "new-model 下应为 candidate");
    assert.equal(guidanceSample.alpha, WEAK_PRIOR_ALPHA, `alpha 应为弱先验，实际: ${guidanceSample.alpha}`);
    assert.equal(result.selected.length, 0, "candidate 策略不参与在线采样");
  });

  it("Thompson Sampling 只采样同一 modelVersion 的经验", () => {
    const store = createStrategyPolicyStore("test-ws");
    // model-a 的 voice_emphasis 有高胜率（active + wins）
    store.setStatus("voice_emphasis", "model-a", "active", "model-a 准入");
    for (let i = 0; i < 10; i++) {
      store.recordOutcome("voice_emphasis", "model-a", {
        sourceChapter: `ch${i}`,
        outcome: "win",
        source: "user",
        weight: 1,
        timestamp: new Date().toISOString(),
      });
    }
    // model-b 的 voice_emphasis 有高失败率（active + losses）
    store.setStatus("voice_emphasis", "model-b", "active", "model-b 准入");
    for (let i = 0; i < 10; i++) {
      store.recordOutcome("voice_emphasis", "model-b", {
        sourceChapter: `ch${i}`,
        outcome: "loss",
        source: "user",
        weight: 1,
        timestamp: new Date().toISOString(),
      });
    }

    // model-a 选择时：voice_emphasis 应有高采样值
    const resultA = selectAuthorStyleStrategies({
      modelVersion: "model-a",
      policyStore: store,
      seed: 42,
    });
    const sampleA = resultA.samples.find((s) => s.strategyId === "voice_emphasis");
    assert.ok(sampleA, "model-a 应采样 voice_emphasis");
    assert.ok(sampleA.alpha > sampleA.beta, "model-a alpha 应 > beta（高胜率）");

    // model-b 选择时：voice_emphasis 应有低采样值（高失败率）
    const resultB = selectAuthorStyleStrategies({
      modelVersion: "model-b",
      policyStore: store,
      seed: 42,
    });
    const sampleB = resultB.samples.find((s) => s.strategyId === "voice_emphasis");
    assert.ok(sampleB, "model-b 应采样 voice_emphasis");
    assert.ok(sampleB.beta > sampleB.alpha, "model-b beta 应 > alpha（高失败率）");
  });
});
