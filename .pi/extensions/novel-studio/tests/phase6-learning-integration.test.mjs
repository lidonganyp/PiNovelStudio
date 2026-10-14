/**
 * Phase 6 在线学习接入统一编排器测试（P1-7，计划 §Phase 6）
 *
 * ⚠️ 测试分类（审计 P2-2 更正）：本文件验证的是学习组件在 **legacy
 * raw/editorial/judge 隔离评测语义**下的接线（与 phase5-unified-orchestrator.test.mjs
 * 同一语义环境，PINOVEL_TEST_LEGACY_PRODUCTION_FLOW=1 测试基建）。
 * 其中"裁判后记录策略胜负 / editorial 与 raw 胜出记录 win/loss evidence"依赖
 * 机器 judge 候选选择——生产主链路已不调用机器 judge（文学评价权归用户），
 * 该语义仅保留于隔离评测。fixture 加长不构成生产测试迁移。
 *
 * 已存在的生产覆盖（统一主链路，勿在本文件重复）：
 * - tests/production-agentic-style-flow.test.mjs（生产 agentic_style 流守护）
 * - tests/phase5-unified-default-path.test.mjs（默认路径）
 * - scripts/production-generate-chapter.mjs（生产验收调用器；显式清除旧流程开关）
 *
 * 仍需迁移的历史覆盖（本文件保留为隔离评测资产，迁移前不得删除）：
 * - Thompson Sampling 过滤 hypotheses 的接线行为 → 生产侧学习组件接线
 *   需以统一主链路（Agentic → 风格优化）语义重新验证
 *
 * 验证退出条件（legacy 隔离评测语义）：
 * 1. 传入 policyStore/strategySelector/outcomeRecorder 时，编排器用 Thompson Sampling
 *    过滤 hypotheses（Stage 3.5），并在裁判后记录策略胜负（Stage 6.1）
 * 2. 策略信誉库在 editorial 胜出时记录 win evidence（alpha 增加）
 * 3. 策略信誉库在 raw 胜出时记录 loss evidence（beta 增加）
 * 4. 不传入学习组件时，编排器行为不变（无 strategySelection/strategyOutcomes）
 * 5. Thompson Sampling 过滤后无策略被选中时交付 raw
 *
 * 与 phase5-unified-orchestrator.test.mjs 的区别：
 * - phase5 测试不传学习组件（验证基础主链路）
 * - 本测试传入完整学习三件套，验证学习链路接线
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUnifiedOrchestrator } from "../dist/v2/core/unified-orchestrator.js";
import {
  loadStrategyPolicyStore,
  saveStrategyPolicyStore,
  createStrategyPolicyStore,
} from "../dist/v2/learning/strategy-policy-store.js";
import { createContextualStrategySelector } from "../dist/v2/learning/contextual-strategy-selector.js";
import { createStrategyOutcomeRecorder } from "../dist/v2/learning/strategy-outcome-recorder.js";
import { TEST_STYLE_REFERENCES } from "./test-style-fingerprint.mjs";
import { SCENE_LEAD_IN_LINES } from "./scene-lead-in.mjs";

// ============================================================================
// 辅助：复用 phase5 的 intent/context/stub 模式
// ============================================================================

function makeIntent(overrides = {}) {
  return {
    chapterFunction: "推进核心冲突",
    readerExperience: ["紧张", "期待"],
    currentPressure: ["水下救援压力"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["林川", "苏婉"],
    inviolableFacts: ["水下暗流不可消除"],
    sourceRefs: ["chapter-seed"],
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  return {
    facts: [
      { id: "fact:1", content: "青鱼嘴水域有暗流", sourceIds: ["skeleton"], kind: "fact" },
    ],
    characterStates: [
      {
        characterId: "林川",
        name: "林川",
        state: { role: "主角", mentality: "冷静", pendingTension: "救人vs自保" },
        sourceIds: ["character:林川"],
      },
    ],
    openLoops: [],
    worldRules: [],
    styleReferences: TEST_STYLE_REFERENCES,
    sourceMap: [],
    constitution: null,
    longTermState: null,
    ...overrides,
  };
}

/** raw 正文：章末平淡无钩子（触发 chapter_end_pressure 机会）。
 * 前置 SCENE_LEAD_IN 场景铺垫使去空白字符数满足统一主链路 6.6 最终正文
 * 完整性门禁默认 minWordCount=2000（不降低门禁）；弱结尾句保持在末尾，
 * 且 "很快睡着了。" 全文唯一（下方 rawWithHook 变体依赖唯一 replace）。 */
const RAW_TEXT_WEAK_END = [
  ...SCENE_LEAD_IN_LINES,
  "林川推开门，走了进去。房间里很暗，他摸索着前进。",
  "他抓住苏婉的手臂，把她往水面拉。",
  "暗流拉扯着他的腿，他用力蹬水，把苏婉推到浅滩。",
  "过了一会儿，他回到了岸上，换了干衣服，坐在床边休息。",
  "窗外的雨还在下，水面恢复了平静，他闭上眼睛，很快睡着了。",
].join("\n");

/** editorial 正文：章末有钩子（含"？"）。铺垫段零"？"，钩子 marker 只来自尾部。 */
const EDITORIAL_TEXT_STRONG_HOOK = [
  ...SCENE_LEAD_IN_LINES,
  "林川推开门，走了进去。房间里很暗，他摸索着前进。",
  "他抓住苏婉的手臂，把她往水面拉，暗流拉扯着他的腿。",
  "他把苏婉推到浅滩，又一次跳进水里去找老周。",
  "浑浊的水下，一个黑影正缓缓游向老周。",
  "林川心里一紧：那东西的形状，不像鱼。老周为什么在笑？他到底看到了什么？",
].join("\n");

/**
 * 复合 stub 模型，按 input.kind 路由：
 * - "raw_chapter" → 返回 rawText
 * - "editorial_amplified" → 返回 editorialText
 * - "literary_judge" → 按 betterMarker（"？"）决定 winner
 */
function makeCompositeStub(opts) {
  const {
    rawText,
    editorialText,
    betterMarker = "？",
    judgeConfidence = "clear",
  } = opts;

  return async (input) => {
    if (input.kind === "raw_chapter") {
      return { text: rawText, model: "stub-raw-model", route: input.route, durationMs: 10 };
    }
    if (input.kind === "editorial_amplified") {
      return { text: editorialText, model: "stub-ed-model", route: input.route, durationMs: 10 };
    }
    if (input.kind === "opportunity_judge") {
      return {
        text: JSON.stringify({
          craftPhenomena: [],
          opportunities: [{
            opportunityType: "chapter_end_pressure",
            craftDomain: "ending_and_closure",
            diagnosis: "章末因果牵引力不足",
            evidenceExcerpt: rawText.slice(0, Math.min(12, rawText.length)),
            expectedReaderGain: "增强继续阅读意愿",
            damageRisks: ["可能破坏既定章末事实"],
            confidence: 0.8,
          }],
          noOpReason: null,
        }),
        model: "stub-opportunity",
        route: input.route,
        durationMs: 10,
      };
    }
    if (input.kind === "literary_judge") {
      const aMatch = input.userPrompt.match(/【候选甲】\n+([\s\S]*?)\n+（候选甲总字符数/);
      const bMatch = input.userPrompt.match(/【候选乙】\n+([\s\S]*?)\n+（候选乙总字符数/);
      const textA = aMatch ? aMatch[1] : "";
      const textB = bMatch ? bMatch[1] : "";
      const aHas = textA.includes(betterMarker);
      const bHas = textB.includes(betterMarker);
      let winner;
      let worseText;
      if (aHas && !bHas) { winner = "A"; worseText = textB; }
      else if (bHas && !aHas) { winner = "B"; worseText = textA; }
      else { winner = "tie"; worseText = ""; }
      const worseLabel = winner === "A" ? "B" : "A";
      const span = worseText ? { start: 0, end: Math.min(8, worseText.length), excerpt: worseText.slice(0, Math.min(8, worseText.length)) } : { start: 0, end: 1, excerpt: "x" };
      const verdict = {
        winner,
        confidence: winner === "tie" ? "uncertain" : judgeConfidence,
        decisiveReasons: [{
          dimension: "章末钩子",
          betterCandidate: winner === "tie" ? "neither" : winner,
          evidenceA: worseLabel === "A" ? [span] : [],
          evidenceB: worseLabel === "B" ? [span] : [],
          explanation: winner === "tie" ? "两者接近" : `${winner} 钩子更强`,
        }],
        factualRisks: [],
        regressionRisks: [],
        constitutionAlignment: "两者均对齐",
      };
      return { text: JSON.stringify(verdict), model: "stub-judge-model", route: input.route, durationMs: 10 };
    }
    return { text: "", model: "stub", route: input.route, durationMs: 10 };
  };
}

function makeTempProject() {
  const dir = mkdtempSync(join(tmpdir(), "p6-learn-"));
  return { dir, projectRoot: dir };
}

// ============================================================================
// 测试
// ============================================================================

test("P1-7: editorial 胜出时记录 win evidence 到策略信誉库", async () => {
  const { dir, projectRoot } = makeTempProject();
  try {
    const workspaceId = "test-ws-win";
    const policyStore = loadStrategyPolicyStore(workspaceId, projectRoot);
    const strategySelector = createContextualStrategySelector();
    const outcomeRecorder = createStrategyOutcomeRecorder();

    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate({
      workspaceId,
      chapterId: "ch1",
      chapterNumber: 1,
      projectRoot,
      intent: makeIntent(),
      context: makeContext(),
      constitution: null,
      characterNames: ["林川", "苏婉", "老周"],
      allowAutomaticLiterarySelection: true,
      modelGenerate: makeCompositeStub({
        rawText: RAW_TEXT_WEAK_END,
        editorialText: EDITORIAL_TEXT_STRONG_HOOK,
      }),
      policyStore,
      strategySelector,
      outcomeRecorder,
      // 固定 seed 使 Thompson Sampling 确定性（弱先验 Beta(1,1) 下首个采样
      // 0.6271 >= 0.5 阈值，必选中策略，避免非确定性过滤导致 Stage 6.1 不执行）
      seed: 1,
    });

    // 验证主链路正常交付 editorial
    assert.equal(result.status, "ok");
    assert.equal(result.selectedSource, "editorial");

    // 验证 Stage 3.5：Thompson Sampling 运行
    const sel = result.stageResults.strategySelection;
    assert.ok(sel, "应有 strategySelection 阶段产物");
    assert.ok(Array.isArray(sel.sampled), "应有采样详情");
    assert.ok(sel.selectedCount >= 1, "弱先验下应至少选中 1 个策略");

    // 验证 Stage 6.1：策略结果记录
    const outcomes = result.stageResults.strategyOutcomes;
    assert.ok(Array.isArray(outcomes), "应有 strategyOutcomes 数组");
    assert.ok(outcomes.length >= 1, "应至少记录 1 条策略结果");

    // editorial 胜出 → outcome=win
    const winOutcome = outcomes.find((o) => o.outcome === "win");
    assert.ok(winOutcome, "应存在 win outcome");
    assert.ok(winOutcome.recorded, "win 应实际写入策略信誉");
    assert.ok(winOutcome.weight >= 1, "win weight 应 >= 1");

    // 验证策略信誉库已更新：alpha 增加（win）
    const modelVersion = result.stageResults.modelVersion;
    assert.ok(modelVersion, "应有 modelVersion");
    const rep = policyStore.getReputation(winOutcome.strategyId, modelVersion);
    assert.ok(rep, "策略信誉应存在");
    assert.ok(rep.alpha > 1, `win 后 alpha 应 > 1（实际=${rep.alpha}）`);
    assert.equal(rep.sampleCount, 1, "sampleCount 应为 1");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("P1-7: raw 胜出时记录 loss evidence 到策略信誉库", async () => {
  const { dir, projectRoot } = makeTempProject();
  try {
    const workspaceId = "test-ws-loss";
    const policyStore = loadStrategyPolicyStore(workspaceId, projectRoot);
    const strategySelector = createContextualStrategySelector();
    const outcomeRecorder = createStrategyOutcomeRecorder();

    // raw 有钩子（"？")，editorial 也有钩子 → judge 判 tie → 保留 raw
    // 用 betterMarker 让两者都有 → tie → loss
    const rawWithHook = RAW_TEXT_WEAK_END.replace("很快睡着了。", "他到底看到了什么？");
    const editorialAlsoHook = EDITORIAL_TEXT_STRONG_HOOK;

    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate({
      workspaceId,
      chapterId: "ch2",
      chapterNumber: 2,
      projectRoot,
      intent: makeIntent(),
      context: makeContext(),
      constitution: null,
      characterNames: ["林川", "苏婉", "老周"],
      allowAutomaticLiterarySelection: true,
      modelGenerate: makeCompositeStub({
        rawText: rawWithHook,
        editorialText: editorialAlsoHook,
      }),
      policyStore,
      strategySelector,
      outcomeRecorder,
      // 固定 seed 使 Thompson Sampling 确定性（弱先验 Beta(1,1) 下首个采样
      // 0.6271 >= 0.5 阈值，必选中策略，避免非确定性过滤导致 Stage 6.1 不执行）
      seed: 1,
    });

    // tie → 保留 raw
    assert.equal(result.status, "ok");
    assert.equal(result.selectedSource, "raw");

    // 验证 Stage 6.1：tie 记录
    const outcomes = result.stageResults.strategyOutcomes;
    assert.ok(Array.isArray(outcomes), "应有 strategyOutcomes");

    // tie 或 loss 应存在（raw 胜出 = editorial loss）
    const lossOrTie = outcomes.find((o) => o.outcome === "loss" || o.outcome === "tie");
    assert.ok(lossOrTie, "应存在 loss 或 tie outcome");

    // 验证策略信誉库已更新
    if (lossOrTie.recorded) {
      const modelVersion = result.stageResults.modelVersion;
      const rep = policyStore.getReputation(lossOrTie.strategyId, modelVersion);
      assert.ok(rep, "策略信誉应存在");
      assert.ok(rep.sampleCount >= 1, "sampleCount 应 >= 1");
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("P1-7: 不传入学习组件时编排器行为不变", async () => {
  const { dir, projectRoot } = makeTempProject();
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate({
      workspaceId: "test-ws-nolearn",
      chapterId: "ch3",
      chapterNumber: 3,
      projectRoot,
      intent: makeIntent(),
      context: makeContext(),
      constitution: null,
      characterNames: ["林川", "苏婉", "老周"],
      allowAutomaticLiterarySelection: true,
      modelGenerate: makeCompositeStub({
        rawText: RAW_TEXT_WEAK_END,
        editorialText: EDITORIAL_TEXT_STRONG_HOOK,
      }),
      // 不传 policyStore/strategySelector/outcomeRecorder
      seed: 1,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.selectedSource, "editorial");

    // 无学习组件 → 无 strategySelection / strategyOutcomes
    assert.ok(!result.stageResults.strategySelection, "不应有 strategySelection");
    assert.ok(!result.stageResults.strategyOutcomes, "不应有 strategyOutcomes");
    // 但 modelVersion 仍应存在（从 raw 模型派生）
    assert.ok(result.stageResults.modelVersion, "应有 modelVersion");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("STRATEGY-ADMISSION-1A: 未准入策略走静态 registry，不被低 Thompson 样本随机过滤", async () => {
  const { projectRoot } = makeTempProject();
  try {
    const policyStore = createStrategyPolicyStore("test-ws-candidate-static");
    const result = await createUnifiedOrchestrator().orchestrate({
      workspaceId: "test-ws-candidate-static",
      chapterId: "ch3-candidate-static",
      chapterNumber: 3,
      projectRoot,
      intent: makeIntent(),
      context: makeContext(),
      constitution: null,
      characterNames: ["林川", "苏婉", "老周"],
      allowAutomaticLiterarySelection: true,
      modelGenerate: makeCompositeStub({
        rawText: RAW_TEXT_WEAK_END,
        editorialText: EDITORIAL_TEXT_STRONG_HOOK,
      }),
      policyStore,
      strategySelector: createContextualStrategySelector(),
      outcomeRecorder: createStrategyOutcomeRecorder(),
      // 旧 Beta(1,1) 路径下 seed=7 的首样本约 0.0117，会错误过滤唯一 hypothesis。
      seed: 7,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.selectedSource, "editorial");
    assert.ok(result.candidates.some((candidate) => candidate.kind === "editorial_amplified"));
    assert.equal(result.stageResults.strategySelection.mode, "static_registry");
    assert.equal(result.stageResults.strategySelection.onlineSelectedCount, 0);
    assert.equal(result.stageResults.strategySelection.staticFallbackCount, 1);
    assert.equal(result.stageResults.strategySelection.selectedCount, 1);
    assert.equal(result.stageResults.strategySelection.sampled[0].status, "candidate");
    assert.equal(result.stageResults.strategySelection.sampled[0].sampled, 0);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("P1-7: modelVersion 从 raw 实际模型名派生（隔离策略信誉）", async () => {
  const { dir, projectRoot } = makeTempProject();
  try {
    const workspaceId = "test-ws-mv";
    const policyStore = loadStrategyPolicyStore(workspaceId, projectRoot);
    const strategySelector = createContextualStrategySelector();
    const outcomeRecorder = createStrategyOutcomeRecorder();

    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate({
      workspaceId,
      chapterId: "ch4",
      chapterNumber: 4,
      projectRoot,
      intent: makeIntent(),
      context: makeContext(),
      constitution: null,
      characterNames: ["林川", "苏婉", "老周"],
      allowAutomaticLiterarySelection: true,
      modelGenerate: makeCompositeStub({
        rawText: RAW_TEXT_WEAK_END,
        editorialText: EDITORIAL_TEXT_STRONG_HOOK,
      }),
      policyStore,
      strategySelector,
      outcomeRecorder,
      // 固定 seed 使 Thompson Sampling 确定性（弱先验 Beta(1,1) 下首个采样
      // 0.6271 >= 0.5 阈值，必选中策略，避免非确定性过滤导致 Stage 6.1 不执行）
      seed: 1,
    });

    assert.equal(result.status, "ok");
    // stub 模型名 "stub-raw-model" → detectModelVersion 派生稳定版本键
    const mv = result.stageResults.modelVersion;
    assert.ok(typeof mv === "string" && mv.length > 0, "modelVersion 应为非空字符串");
    // 验证策略信誉按此 modelVersion 分区
    const outcomes = result.stageResults.strategyOutcomes;
    if (Array.isArray(outcomes) && outcomes.length > 0) {
      const rep = policyStore.getReputation(outcomes[0].strategyId, mv);
      assert.ok(rep, `策略信誉应在 modelVersion=${mv} 下存在`);
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("P1-7: 持久化策略信誉库后重新加载保留学习结果", async () => {
  const { dir, projectRoot } = makeTempProject();
  try {
    const workspaceId = "test-ws-persist";

    // 第一次生成：记录 win
    const store1 = loadStrategyPolicyStore(workspaceId, projectRoot);
    const orch1 = createUnifiedOrchestrator();
    await orch1.orchestrate({
      workspaceId,
      chapterId: "ch5",
      chapterNumber: 5,
      projectRoot,
      intent: makeIntent(),
      context: makeContext(),
      constitution: null,
      characterNames: ["林川", "苏婉", "老周"],
      allowAutomaticLiterarySelection: true,
      modelGenerate: makeCompositeStub({
        rawText: RAW_TEXT_WEAK_END,
        editorialText: EDITORIAL_TEXT_STRONG_HOOK,
      }),
      policyStore: store1,
      strategySelector: createContextualStrategySelector(),
      outcomeRecorder: createStrategyOutcomeRecorder(),
      seed: 1,
    });

    // 保存
    saveStrategyPolicyStore(store1, workspaceId, projectRoot);
    const policyPath = join(projectRoot, "workspaces", workspaceId, "strategy-policy.json");
    assert.ok(existsSync(policyPath), "策略信誉库文件应已保存");

    // 重新加载：验证学习结果保留
    const store2 = loadStrategyPolicyStore(workspaceId, projectRoot);
    const data2 = store2.toJSON();
    assert.equal(data2.workspaceId, workspaceId, "workspaceId 应匹配");

    // 应有至少 1 个策略信誉（win 记录）
    let totalReps = 0;
    for (const mv of Object.keys(data2.partitions)) {
      totalReps += Object.keys(data2.partitions[mv]).length;
    }
    assert.ok(totalReps >= 1, `重新加载后应有 >= 1 个策略信誉（实际=${totalReps}）`);

    // 验证 evidence log 保留
    let hasEvidence = false;
    for (const mv of Object.keys(data2.partitions)) {
      for (const sid of Object.keys(data2.partitions[mv])) {
        const rep = data2.partitions[mv][sid];
        if (rep.evidence && rep.evidence.length > 0) {
          hasEvidence = true;
          assert.equal(rep.evidence[0].outcome, "win", "首条 evidence 应为 win");
          assert.equal(rep.evidence[0].source, "judge", "来源应为 judge");
        }
      }
    }
    assert.ok(hasEvidence, "应至少有 1 条 evidence log");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("P1-7: 策略去重 — 同 strategyId 只记录一条 evidence", async () => {
  const { dir, projectRoot } = makeTempProject();
  try {
    const workspaceId = "test-ws-dedup";
    const policyStore = loadStrategyPolicyStore(workspaceId, projectRoot);
    const strategySelector = createContextualStrategySelector();
    const outcomeRecorder = createStrategyOutcomeRecorder();

    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate({
      workspaceId,
      chapterId: "ch6",
      chapterNumber: 6,
      projectRoot,
      intent: makeIntent(),
      context: makeContext(),
      constitution: null,
      characterNames: ["林川", "苏婉", "老周"],
      allowAutomaticLiterarySelection: true,
      modelGenerate: makeCompositeStub({
        rawText: RAW_TEXT_WEAK_END,
        editorialText: EDITORIAL_TEXT_STRONG_HOOK,
      }),
      policyStore,
      strategySelector,
      outcomeRecorder,
      // 固定 seed 使 Thompson Sampling 确定性（弱先验 Beta(1,1) 下首个采样
      // 0.6271 >= 0.5 阈值，必选中策略，避免非确定性过滤导致 Stage 6.1 不执行）
      seed: 1,
    });

    assert.equal(result.status, "ok");
    const outcomes = result.stageResults.strategyOutcomes;
    assert.ok(Array.isArray(outcomes));

    // 验证无重复 strategyId
    const strategyIds = outcomes.map((o) => o.strategyId);
    const unique = new Set(strategyIds);
    assert.equal(strategyIds.length, unique.size, "不应有重复 strategyId 记录");

    // 每个策略信誉的 sampleCount 应为 1（只记录一次）
    const mv = result.stageResults.modelVersion;
    for (const o of outcomes) {
      const rep = policyStore.getReputation(o.strategyId, mv);
      assert.ok(rep);
      assert.equal(rep.sampleCount, 1, `策略 ${o.strategyId} sampleCount 应为 1（实际=${rep.sampleCount}）`);
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
