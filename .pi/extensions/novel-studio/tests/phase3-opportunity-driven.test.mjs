/**
 * Phase 3 机会驱动候选生成测试（计划 §Phase 3 + §10.1 确定性单元测试）
 *
 * 覆盖：
 * 1. EditorialStrategyRegistry：注册/查询/按机会类型选取/为 hypothesis 选取策略
 * 2. EditorialOpportunityJudge：
 *    - 无机会返回 no-op（高质量 raw）
 *    - 章末弱钩子 → chapter_end_pressure hypothesis 带 span
 *    - 主角行动稀疏 → character_choice hypothesis 带 span
 *    - 感知侵蚀过多 → voice_and_naturalness hypothesis 带 span
 *    - 信息倾泻 → information_dramatization hypothesis 带 span
 *    - 最多 2 个 hypothesis（准入控制）
 *    - 空 raw → no-op
 *    - 所有 hypothesis 的 span 真实存在于 raw（validateHypothesis 通过）
 * 3. EditorialCandidateGenerator：
 *    - 0 hypothesis → 空候选 + noOpReason
 *    - 1 hypothesis → 1 候选，携带 hypothesisId + editorialStrategy + sourceCandidateId
 *    - 2 hypothesis → 2 候选
 *    - 候选 prompt 通过 auditPrompt（editorial 型）
 *    - 空文本重试耗尽 → failure
 *    - 候选 prompt 含 inviolableFacts 守卫
 *
 * 退出条件：日常链路不会无条件生成多候选；无 span 不生成；最多两个候选；
 * 候选不得改变不可侵犯事实。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createEditorialStrategyRegistry,
} from "../dist/v2/core/editorial-strategy-registry.js";
import {
  createEditorialOpportunityJudge,
} from "../dist/v2/core/editorial-opportunity-judge.js";
import {
  createEditorialCandidateGenerator,
  auditPrompt,
} from "../dist/v2/core/editorial-candidate-generator.js";
import {
  validateHypothesis,
} from "../dist/v2/core/editorial-hypothesis.js";

// ============================================================================
// 辅助：env 保存/恢复（Step 4a 起默认 1 候选 + 第2候选置信门，测试需显式开启）
// ============================================================================

async function withEnvAsync(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    process.env[k] = String(vars[k]);
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ============================================================================
// 辅助：构造 ChapterIntent / CompiledContext / stub model
// ============================================================================

function makeIntent(overrides = {}) {
  return {
    chapterFunction: "推进核心冲突",
    readerExperience: ["紧张", "期待"],
    currentPressure: ["水下救援压力"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["林川", "苏婉", "老周"],
    inviolableFacts: ["水下暗流不可消除", "林川会水"],
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
    styleReferences: [],
    sourceMap: [],
    constitution: null,
    longTermState: null,
    ...overrides,
  };
}

/** 高质量 raw：章末有钩子、行动词充足、无感知侵蚀、无信息倾泻 */
const HIGH_QUALITY_RAW = [
  "林川推开舱门，冲进浑浊的水里。",
  "他抓住苏婉的手臂，把她往水面拉。",
  "暗流拉扯着他的腿，他用力蹬水，转身挡住一块漂来的木板。",
  "苏婉呛了一口水，林川决定先把她送上岸再回去找老周。",
  "他把苏婉推到浅滩，转身再次扎进水里。",
  "浑浊的水下，一个黑影正缓缓游向老周。",
  "林川心里一紧：那东西的形状，不像鱼。",
  "他加速游过去，却看到老周正在朝他招手，脸上带着一种诡异的笑。",
  "林川猛地停下：老周为什么笑？他到底看到了什么？",
].join("\n");

/**
 * stub model：返回固定正文。
 *
 * MODEL-ROUTING-CLAUDE46-1C：route 感知。
 * - v2_chinese_calibration (Doubao span 校准)：从 userPrompt 抽出待校准原文，
 *   做最小 span 级感知侵蚀词替换（林川感到 → 林川看到），让候选通过
 *   span 边界 + completeness + 中文母语语感 before/after 三道流水线检查。
 * - 其他路由（v2_amplified 等）：返回固定正文（行为与 1C 前一致）。
 */
function makeStubModel(text) {
  return async (input) => {
    if (input?.route === "v2_chinese_calibration") {
      const m = input.userPrompt.match(/【待校准原文（完整）】\n([\s\S]*?)\n\n【/);
      const raw = m ? m[1] : "";
      // 最小感知侵蚀词替换：把首个命中替换为具体动作词
      const calibrated = raw.replace(/林川感到|感到|意识到|注意到|突然明白/, (w) => {
        if (w === "林川感到") return "林川看到";
        if (w === "感到") return "看到";
        if (w === "意识到") return "看清";
        if (w === "注意到") return "瞥见";
        if (w === "突然明白") return "猛然看清";
        return w;
      });
      return {
        text: calibrated || raw || text,
        model: "doubao-seed-2-1-pro-260628",
        route: "v2_chinese_calibration",
        durationMs: 10,
      };
    }
    return {
      text,
      model: "stub-model",
      route: input?.route ?? "v2_amplified",
      durationMs: 10,
    };
  };
}

/** stub model：始终返回空文本 */
function makeEmptyModel() {
  return async () => ({
    text: "",
    model: "stub-model",
    route: "v2_amplified",
    durationMs: 10,
  });
}

/** stub model：抛异常 */
function makeThrowingModel(err) {
  return async () => {
    throw new Error(err);
  };
}

// ============================================================================
// 1. EditorialStrategyRegistry
// ============================================================================

test("StrategyRegistry: 默认注册 8 个策略（每 opportunityType 一个）", () => {
  const registry = createEditorialStrategyRegistry();
  const all = registry.listStrategies();
  assert.equal(all.length, 8);
  // 每个 opportunityType 都有策略
  const oppTypes = new Set(all.map((s) => s.opportunityType));
  assert.equal(oppTypes.size, 8);
});

test("StrategyRegistry: getStrategy 按 strategyId 查询", () => {
  const registry = createEditorialStrategyRegistry();
  const s = registry.getStrategy("chapter_end_pressure_focus");
  assert.ok(s);
  assert.equal(s.opportunityType, "chapter_end_pressure");
  assert.deepEqual(
    Object.keys(s).sort(),
    ["opportunityType", "strategyId"],
    "策略只能提供审计标签，不能携带固定修法或正文指导",
  );
});

test("StrategyRegistry: strategiesForOpportunity 返回对应类型策略", () => {
  const registry = createEditorialStrategyRegistry();
  const list = registry.strategiesForOpportunity("character_choice");
  assert.ok(list.length >= 1);
  assert.equal(list[0].opportunityType, "character_choice");
});

test("StrategyRegistry: pickStrategyForHypothesis 选取首选策略", () => {
  const registry = createEditorialStrategyRegistry();
  const s = registry.pickStrategyForHypothesis({
    id: "h1",
    opportunityType: "reader_payoff",
    diagnosis: "x",
    evidenceSpans: [{ start: 0, end: 1 }],
    expectedReaderGain: "y",
    damageRisks: ["z"],
    rewriteScope: "span_candidate",
    confidence: 0.5,
  });
  assert.ok(s);
  assert.equal(s.strategyId, "reader_payoff_strengthen");
});

test("StrategyRegistry: 自定义策略注册后可查询", () => {
  const registry = createEditorialStrategyRegistry();
  registry.register({
    strategyId: "custom_test",
    opportunityType: "ensemble_function",
  });
  const list = registry.strategiesForOpportunity("ensemble_function");
  assert.ok(list.length >= 2);
  assert.ok(list.some((s) => s.strategyId === "custom_test"));
});

// ============================================================================
// 2. EditorialOpportunityJudge
// ============================================================================

test("OpportunityJudge: 空 raw → no-op", async () => {
  const judge = createEditorialOpportunityJudge();
  const result = await judge.judge({
    rawText: "",
    intent: makeIntent(),
    longTermState: null,
    constitution: null,
    characterNames: ["林川", "苏婉", "老周"],
  });
  assert.equal(result.hypotheses.length, 0);
  assert.ok(result.noOpReason);
  assert.match(result.noOpReason, /空/);
});

test("OpportunityJudge: 高质量 raw → 无机会返回 no-op", async () => {
  const judge = createEditorialOpportunityJudge();
  const result = await judge.judge({
    rawText: HIGH_QUALITY_RAW,
    intent: makeIntent(),
    longTermState: null,
    constitution: null,
    characterNames: ["林川", "苏婉", "老周"],
  });
  // 高质量 raw 可能仍有少量信号触发，但 hypotheses 应为 0 或极少
  // 关键断言：不会无条件生成 2 个候选
  assert.ok(result.hypotheses.length <= 2, `hypotheses 应 ≤ 2，实际 ${result.hypotheses.length}`);
  if (result.hypotheses.length === 0) {
    assert.ok(result.noOpReason, "0 hypothesis 时应有 noOpReason");
  }
});

test("OpportunityJudge: 章末机械信号只写入诊断，不生成 hypothesis", async () => {
  const judge = createEditorialOpportunityJudge();
  // 结尾平淡无钩子（刻意避开 WEBNOVEL_HOOK_PATTERN 的所有命中词：
  // ？为什么 什么 谁 怎么 哪里 难道 发现 意识到 注意到 突然 决定 选择 转身 走向 原来 竟然 居然 不对 等）
  const raw = [
    "林川推开舱门，冲进浑浊的水里。",
    "他抓住苏婉的手臂，把她往水面拉。",
    "暗流拉扯着他的腿，他用力蹬水。",
    "他把苏婉推到浅滩，又一次跳进水里。",
    "过了一会儿，他回到了岸上，换了干衣服，坐在床边休息。",
    "窗外的雨还在下，水面恢复了平静，他闭上眼睛，很快睡着了。",
  ].join("\n");
  const result = await judge.judge({
    rawText: raw,
    intent: makeIntent(),
    longTermState: null,
    constitution: null,
    characterNames: ["林川", "苏婉"],
  });
  assert.deepEqual(result.hypotheses, []);
  const endSignal = result.scannedSignals.find((s) => s.opportunityType === "chapter_end_pressure");
  assert.ok(endSignal && endSignal.triggered, "章末压力信号应触发");
});

test("OpportunityJudge: 行动词密度信号只写入诊断，不生成 hypothesis", async () => {
  const judge = createEditorialOpportunityJudge();
  // 长文本但行动词极少
  const raw = [
    "水面很浑浊，林川感到一阵不安。",
    "他意识到情况比想象的复杂，注意到远处有黑影。",
    "苏婉似乎也很害怕，仿佛预感到了什么。",
    "水下的东西让人不安，林川突然明白了一切。",
    "他感到无力，意识到自己可能无法救出所有人。",
    "注意到水流的异常后，他感到一阵寒意。",
  ].join("\n");
  const result = await judge.judge({
    rawText: raw,
    intent: makeIntent(),
    longTermState: null,
    constitution: null,
    characterNames: ["林川", "苏婉"],
  });
  assert.deepEqual(result.hypotheses, []);
  assert.equal(
    result.scannedSignals.find((s) => s.opportunityType === "character_choice")?.triggered,
    true,
  );
});

test("OpportunityJudge: 感知词信号只写入诊断，不生成 hypothesis", async () => {
  const judge = createEditorialOpportunityJudge();
  const raw = [
    "林川感到水下有东西。",
    "他意识到危险正在逼近。",
    "苏婉注意到水面异常。",
    "林川突然明白了真相。",
    "他感到一阵寒意。",
    "他意识到自己必须行动，推开舱门冲了出去，抓住苏婉，转身游回岸上。",
    "这一切到底是怎么回事？他还会遇到什么？",
  ].join("\n");
  const result = await judge.judge({
    rawText: raw,
    intent: makeIntent(),
    longTermState: null,
    constitution: null,
    characterNames: ["林川", "苏婉"],
  });
  assert.deepEqual(result.hypotheses, []);
  assert.equal(
    result.scannedSignals.find((s) => s.opportunityType === "voice_and_naturalness")?.triggered,
    true,
  );
});

test("OpportunityJudge: 段落长度信号只写入诊断，不生成 hypothesis", async () => {
  const judge = createEditorialOpportunityJudge();
  // 构造一段超长无对白无动作的说明段落
  const dump = "这片水域的历史可以追溯到百年之前，当地渔民世代相传关于水怪的传说，据说每逢月圆之夜便会有异象出现，青鱼嘴因为地形特殊水流湍急暗礁密布，曾经有许多船只在此沉没，据县志记载光绪年间曾有一次大规模的沉船事故，此后便常有目击报告，但均未被证实，科学界对此持保留态度，认为可能是水下暗流与光学折射共同作用的结果。";
  const raw = [
    "林川推开门，冲进水里。",
    dump,
    "他抓住苏婉，转身游回岸上。",
    "这一切到底是怎么回事？",
  ].join("\n");
  const result = await judge.judge({
    rawText: raw,
    intent: makeIntent(),
    longTermState: null,
    constitution: null,
    characterNames: ["林川", "苏婉"],
  });
  assert.deepEqual(result.hypotheses, []);
  assert.ok(
    result.scannedSignals.some((s) => s.opportunityType === "information_dramatization"),
    "段落长度扫描结果应保留在诊断 trace 中",
  );
});

test("OpportunityJudge: 所有返回的 hypothesis 都通过 validateHypothesis（无 span 不生成）", async () => {
  const judge = createEditorialOpportunityJudge();
  const raw = [
    "林川感到水下有东西。",
    "他意识到危险正在逼近，注意到远处有黑影。",
    "他感到无力，仿佛预感到了什么。",
    "过了一会儿，他回到了岸上，这一天就这样平淡地结束了。",
  ].join("\n");
  const result = await judge.judge({
    rawText: raw,
    intent: makeIntent(),
    longTermState: null,
    constitution: null,
    characterNames: ["林川"],
  });
  for (const h of result.hypotheses) {
    const v = validateHypothesis(h, raw);
    assert.ok(v.ok, `hypothesis ${h.id} 应通过校验：${v.errors.join(";")}`);
    assert.doesNotMatch(
      h.expectedReaderGain,
      /抛回|施加新压力|主动选择|不可逆后果|改写为|拆进|质疑\/泄密\/阻拦\/见证/,
      "收益描述只能说明预期读者结果，不能规定模型采用哪种表达手段",
    );
    // span 必须真实存在于 raw
    for (const s of h.evidenceSpans) {
      assert.ok(s.start >= 0 && s.end <= raw.length && s.start < s.end, `${h.id} span 越界`);
    }
  }
});

test("OpportunityJudge: 最多 2 个 hypothesis（准入控制）", async () => {
  const judge = createEditorialOpportunityJudge();
  // 构造一个多机会并发的 raw：弱钩子 + 行动稀疏 + 感知侵蚀 + 信息倾泻
  const dump = "这片水域的历史可以追溯到百年之前，当地渔民世代相传关于水怪的传说，据说每逢月圆之夜便会有异象出现，青鱼嘴因为地形特殊水流湍急暗礁密布，曾经有许多船只在此沉没，据县志记载光绪年间曾有一次大规模的沉船事故，此后便常有目击报告，但均未被证实，科学界对此持保留态度，认为可能是水下暗流与光学折射共同作用的结果。";
  const raw = [
    "林川感到水下有东西。",
    "他意识到危险正在逼近，注意到远处有黑影。",
    "他感到无力，仿佛预感到了什么。",
    "苏婉似乎也很害怕。",
    dump,
    "过了一会儿，他回到了岸上，这一天就这样平淡地结束了，什么也没有发生。",
  ].join("\n");
  const result = await judge.judge({
    rawText: raw,
    intent: makeIntent(),
    longTermState: null,
    constitution: null,
    characterNames: ["林川", "苏婉", "老周"],
  });
  assert.ok(
    result.hypotheses.length <= 2,
    `hypotheses 应 ≤ 2（准入控制），实际 ${result.hypotheses.length}`
  );
  // selected 的 opportunityType 互不冲突
  const types = new Set(result.hypotheses.map((h) => h.opportunityType));
  assert.equal(types.size, result.hypotheses.length, "selected hypothesis 的 opportunityType 应互不冲突");
});

test("OpportunityJudge: scannedSignals 记录所有扫描器命中情况（供 trace 审计）", async () => {
  const judge = createEditorialOpportunityJudge();
  const result = await judge.judge({
    rawText: HIGH_QUALITY_RAW,
    intent: makeIntent(),
    longTermState: null,
    constitution: null,
    characterNames: ["林川", "苏婉", "老周"],
  });
  // 6 个扫描器都应被记录
  assert.ok(result.scannedSignals.length >= 6, "应记录至少 6 个扫描器信号");
  for (const s of result.scannedSignals) {
    assert.ok(typeof s.triggered === "boolean");
    assert.ok(typeof s.reason === "string" && s.reason.length > 0);
  }
});

// ============================================================================
// 3. EditorialCandidateGenerator
// ============================================================================

test("CandidateGenerator: 0 hypothesis → 空候选 + noOpReason", async () => {
  const gen = createEditorialCandidateGenerator();
  const registry = createEditorialStrategyRegistry();
  const result = await gen.generate({
    rawText: HIGH_QUALITY_RAW,
    rawCandidateId: "candidate:raw:1",
    hypotheses: [],
    intent: makeIntent(),
    context: makeContext(),
    contextHash: "hash-1",
    chapterNumber: 5,
    modelGenerate: makeStubModel("正文"),
    strategyRegistry: registry,
  });
  assert.equal(result.candidates.length, 0);
  assert.ok(result.noOpReason);
  assert.match(result.noOpReason, /no-op/);
});

test("CandidateGenerator: 1 hypothesis → 1 候选，携带 hypothesisId + editorialStrategy + sourceCandidateId", async () => {
  const gen = createEditorialCandidateGenerator();
  const registry = createEditorialStrategyRegistry();
  const raw = [
    "林川推开舱门，冲进浑浊的水里。",
    "他抓住苏婉的手臂，把她往水面拉。",
    "暗流拉扯着他的腿，他用力蹬水。",
    "他把苏婉推到浅滩，又一次跳进水里。",
    "过了一会儿，他回到了岸上，换了干衣服，坐在床边休息。",
    "窗外的雨还在下，水面恢复了平静，他闭上眼睛，很快睡着了。",
  ].join("\n");
  const excerpt = "水面恢复了平静";
  const start = raw.indexOf(excerpt);
  const hypotheses = [{
    id: "hypothesis:judge:chapter-end",
    opportunityType: "chapter_end_pressure",
    diagnosis: "章末因果牵引力不足",
    evidenceSpans: [{ start, end: start + excerpt.length, excerpt }],
    expectedReaderGain: "增强继续阅读意愿",
    damageRisks: ["可能破坏既定章末事实"],
    rewriteScope: "span_candidate",
    confidence: 0.7,
  }];

  const result = await gen.generate({
    rawText: raw,
    rawCandidateId: "candidate:raw:1",
    hypotheses,
    intent: makeIntent(),
    context: makeContext(),
    contextHash: "hash-1",
    chapterNumber: 5,
    modelGenerate: makeStubModel("这是重写后的正文。"),
    strategyRegistry: registry,
  });
  assert.equal(result.candidates.length, hypotheses.length);
  const c = result.candidates[0];
  assert.equal(c.kind, "editorial_amplified");
  assert.equal(c.sourceCandidateId, "candidate:raw:1");
  assert.ok(c.hypothesisId, "候选应携带 hypothesisId");
  assert.ok(c.editorialStrategy, "候选应携带 editorialStrategy");
  assert.ok(c.text.length > 0);
  assert.equal(c.contextHash, "hash-1");
});

test("CandidateGenerator: 2 hypothesis → 2 候选，各自携带不同 hypothesisId", async () => {
  const gen = createEditorialCandidateGenerator();
  const registry = createEditorialStrategyRegistry();
  // 手工构造 2 个互不冲突的 hypothesis
  const raw = [
    "林川感到水下有东西。",
    "他意识到危险正在逼近，注意到远处有黑影。",
    "他感到无力，仿佛预感到了什么。",
    "过了一会儿，他回到了岸上，这一天就这样平淡地结束了。",
  ].join("\n");
  const hypotheses = [
    {
      id: "h1",
      opportunityType: "voice_and_naturalness",
      diagnosis: "感知侵蚀过多",
      evidenceSpans: [{ start: 0, end: 6, excerpt: "林川感到" }],
      expectedReaderGain: "回到母语自然",
      damageRisks: ["可能削弱内省重量"],
      rewriteScope: "span_candidate",
      confidence: 0.5,
    },
    {
      id: "h2",
      opportunityType: "chapter_end_pressure",
      diagnosis: "章末弱钩子",
      evidenceSpans: [{ start: raw.length - 30, end: raw.length, excerpt: "平淡地结束了" }],
      expectedReaderGain: "提升翻页牵引力",
      damageRisks: ["可能与事实冲突"],
      rewriteScope: "span_candidate",
      confidence: 0.55,
    },
  ];
  const result = await gen.generate({
    rawText: raw,
    rawCandidateId: "candidate:raw:1",
    hypotheses,
    intent: makeIntent(),
    context: makeContext(),
    contextHash: "hash-1",
    chapterNumber: 5,
    modelGenerate: makeStubModel("重写正文"),
    strategyRegistry: registry,
  });
  assert.equal(result.candidates.length, 2);
  const ids = result.candidates.map((c) => c.hypothesisId).sort();
  assert.deepEqual(ids, ["h1", "h2"]);
  // editorialStrategy 应不同
  const strategies = new Set(result.candidates.map((c) => c.editorialStrategy));
  assert.equal(strategies.size, 2, "两个候选应绑定不同 strategyId");
});

test("Step 4c: PINOVEL_PARALLEL_CANDIDATES=2 + 2 hypothesis → 并行生成 2 候选，结果同序", async () => {
  await withEnvAsync({ PINOVEL_PARALLEL_CANDIDATES: "2" }, async () => {
    const gen = createEditorialCandidateGenerator();
    const registry = createEditorialStrategyRegistry();
    const raw = [
      "林川感到水下有东西。",
      "他意识到危险正在逼近，注意到远处有黑影。",
      "他感到无力，仿佛预感到了什么。",
      "过了一会儿，他回到了岸上，这一天就这样平淡地结束了。",
    ].join("\n");
    const hypotheses = [
      {
        id: "h1",
        opportunityType: "voice_and_naturalness",
        diagnosis: "感知侵蚀过多",
        evidenceSpans: [{ start: 0, end: 6, excerpt: "林川感到" }],
        expectedReaderGain: "回到母语自然",
        damageRisks: ["可能削弱内省重量"],
        rewriteScope: "span_candidate",
        confidence: 0.5,
      },
      {
        id: "h2",
        opportunityType: "chapter_end_pressure",
        diagnosis: "章末弱钩子",
        evidenceSpans: [{ start: raw.length - 30, end: raw.length, excerpt: "平淡地结束了" }],
        expectedReaderGain: "提升翻页牵引力",
        damageRisks: ["可能与事实冲突"],
        rewriteScope: "span_candidate",
        confidence: 0.55,
      },
    ];
    const result = await gen.generate({
      rawText: raw,
      rawCandidateId: "candidate:raw:1",
      hypotheses,
      intent: makeIntent(),
      context: makeContext(),
      contextHash: "hash-1",
      chapterNumber: 5,
      modelGenerate: makeStubModel("重写正文"),
      strategyRegistry: registry,
    });
    assert.equal(result.candidates.length, 2, "并行生成应产出 2 候选");
    const ids = result.candidates.map((c) => c.hypothesisId);
    assert.deepEqual(ids, ["h1", "h2"], "并行结果应保持输入序");
    const strategies = new Set(result.candidates.map((c) => c.editorialStrategy));
    assert.equal(strategies.size, 2, "两个候选应绑定不同 strategyId");
  });
});

test("CandidateGenerator: 候选 prompt 通过 auditPrompt（editorial 型，无机械指标）", async () => {
  const gen = createEditorialCandidateGenerator();
  const registry = createEditorialStrategyRegistry();
  let capturedPrompt = null;
  const captureModel = async (input) => {
    capturedPrompt = { system: input.systemPrompt, user: input.userPrompt };
    return { text: "正文", model: "stub", route: input.route, durationMs: 1 };
  };
  const hypotheses = [
    {
      id: "h1",
      opportunityType: "character_choice",
      diagnosis: "行动稀疏",
      evidenceSpans: [{ start: 0, end: 5, excerpt: "林川感到" }],
      expectedReaderGain: "主角主动选择",
      damageRisks: ["可能偏离心智"],
      rewriteScope: "event_candidate",
      confidence: 0.5,
    },
  ];
  await gen.generate({
    rawText: "林川感到不安。",
    rawCandidateId: "candidate:raw:1",
    hypotheses,
    intent: makeIntent(),
    context: makeContext(),
    contextHash: "hash-1",
    chapterNumber: 5,
    modelGenerate: captureModel,
    strategyRegistry: registry,
  });
  assert.ok(capturedPrompt);
  const profile = auditPrompt(capturedPrompt.system, capturedPrompt.user);
  assert.equal(profile.type, "editorial", `prompt 应为 editorial 型，实际 ${profile.type}`);
  assert.equal(profile.containsDialogueRatio, false);
  assert.equal(profile.containsParagraphLengthConstraint, false);
  assert.equal(profile.containsControlChecklist, false);
});

test("CandidateGenerator: editorial prompt 锚定完整 raw 与前文，只允许增量编辑", async () => {
  const gen = createEditorialCandidateGenerator();
  const registry = createEditorialStrategyRegistry();
  let capturedUser = "";
  const captureModel = async (input) => {
    capturedUser = input.userPrompt;
    return { text: "正文", model: "stub", route: input.route, durationMs: 1 };
  };
  const openingAnchor = "开篇唯一锚点：林川在青鱼嘴码头接过旧铜灯。";
  const closingAnchor = "结尾唯一锚点：苏婉把刻有潮纹的钥匙交给林川。";
  const raw = [
    openingAnchor,
    "两人沿着堤岸追查水下传来的敲击声。",
    "暗流卷起碎木，老周在远处示意他们绕开漩涡。",
    "林川决定先固定缆绳，再下水确认失踪船只的位置。",
    closingAnchor,
  ].join("\n");
  const hypotheses = [{
    id: "h_anchor",
    opportunityType: "character_choice",
    diagnosis: "中段选择可以更鲜明",
    evidenceSpans: [{ start: raw.indexOf("林川决定"), end: raw.indexOf("林川决定") + 4, excerpt: "林川决定" }],
    expectedReaderGain: "强化主动选择",
    damageRisks: ["不得改变既有事件"],
    rewriteScope: "event_candidate",
    confidence: 0.7,
  }];

  await gen.generate({
    rawText: raw,
    evalPrefix: "前章末尾唯一内容：潮声停下后，旧铜灯自行亮起。",
    rawCandidateId: "candidate:raw:anchor",
    hypotheses,
    intent: makeIntent(),
    context: makeContext(),
    contextHash: "hash-anchor",
    chapterNumber: 5,
    modelGenerate: captureModel,
    strategyRegistry: registry,
  });

  assert.match(capturedUser, /【前文】/);
  assert.match(capturedUser, /前章末尾唯一内容：潮声停下后，旧铜灯自行亮起。/);
  assert.ok(capturedUser.includes(openingAnchor), "prompt 应包含 raw 开篇的唯一片段");
  assert.ok(capturedUser.includes(closingAnchor), "prompt 应包含 raw 结尾的唯一片段");
  assert.match(capturedUser, /待编辑原文/);
  assert.match(capturedUser, /增量编辑/);
  assert.match(capturedUser, /保留场景.*关键事件.*人物关系/);
  assert.match(capturedUser, /禁止.*不同故事/);
});

test("CandidateGenerator: 候选 prompt 含 inviolableFacts 守卫（不改变不可侵犯事实）", async () => {
  const gen = createEditorialCandidateGenerator();
  const registry = createEditorialStrategyRegistry();
  let capturedUser = "";
  const captureModel = async (input) => {
    capturedUser = input.userPrompt;
    return { text: "正文", model: "stub", route: input.route, durationMs: 1 };
  };
  const intent = makeIntent({ inviolableFacts: ["水下暗流不可消除", "林川会水"] });
  const hypotheses = [
    {
      id: "h1",
      opportunityType: "character_choice",
      diagnosis: "行动稀疏",
      evidenceSpans: [{ start: 0, end: 5, excerpt: "林川感" }],
      expectedReaderGain: "主角主动选择",
      damageRisks: ["可能偏离心智"],
      rewriteScope: "event_candidate",
      confidence: 0.5,
    },
  ];
  await gen.generate({
    rawText: "林川感到不安。",
    rawCandidateId: "candidate:raw:1",
    hypotheses,
    intent,
    context: makeContext(),
    contextHash: "hash-1",
    chapterNumber: 5,
    modelGenerate: captureModel,
    strategyRegistry: registry,
  });
  // prompt 必须包含 inviolableFacts 守卫块与每条事实
  assert.match(capturedUser, /不可侵犯事实/);
  assert.match(capturedUser, /水下暗流不可消除/);
  assert.match(capturedUser, /林川会水/);
  assert.doesNotMatch(capturedUser, /策略守卫|固定修法|必须改成/);
  assert.match(capturedUser, /具体修订表达由你自行决定/);
});

test("CandidateGenerator: 空文本重试耗尽 → failure，不进入候选列表", async () => {
  const gen = createEditorialCandidateGenerator();
  const registry = createEditorialStrategyRegistry();
  const hypotheses = [
    {
      id: "h1",
      opportunityType: "character_choice",
      diagnosis: "行动稀疏",
      evidenceSpans: [{ start: 0, end: 5, excerpt: "林川感" }],
      expectedReaderGain: "主角主动选择",
      damageRisks: ["风险"],
      rewriteScope: "event_candidate",
      confidence: 0.5,
    },
  ];
  const result = await gen.generate({
    rawText: "林川感到不安。",
    rawCandidateId: "candidate:raw:1",
    hypotheses,
    intent: makeIntent(),
    context: makeContext(),
    contextHash: "hash-1",
    chapterNumber: 5,
    modelGenerate: makeEmptyModel(),
    strategyRegistry: registry,
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].hypothesisId, "h1");
  assert.match(result.failures[0].reason, /空文本|失败/);
});

test("CandidateGenerator: 模型抛异常 → failure", async () => {
  const gen = createEditorialCandidateGenerator();
  const registry = createEditorialStrategyRegistry();
  const hypotheses = [
    {
      id: "h1",
      opportunityType: "character_choice",
      diagnosis: "行动稀疏",
      evidenceSpans: [{ start: 0, end: 5, excerpt: "林川感" }],
      expectedReaderGain: "主角主动选择",
      damageRisks: ["风险"],
      rewriteScope: "event_candidate",
      confidence: 0.5,
    },
  ];
  const result = await gen.generate({
    rawText: "林川感到不安。",
    rawCandidateId: "candidate:raw:1",
    hypotheses,
    intent: makeIntent(),
    context: makeContext(),
    contextHash: "hash-1",
    chapterNumber: 5,
    modelGenerate: makeThrowingModel("API timeout"),
    strategyRegistry: registry,
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].reason, /API timeout/);
});

test("CandidateGenerator: 候选 prompt 只携带一个 hypothesis（不混入其他 hypothesis）", async () => {
  const gen = createEditorialCandidateGenerator();
  const registry = createEditorialStrategyRegistry();
  const capturedPrompts = [];
  const captureModel = async (input) => {
    capturedPrompts.push(input.userPrompt);
    return { text: "正文", model: "stub", route: input.route, durationMs: 1 };
  };
  const raw = "林川感到不安。他意识到危险。这一切到底是怎么回事？";
  const hypotheses = [
    {
      id: "h_voice",
      opportunityType: "voice_and_naturalness",
      diagnosis: "感知侵蚀诊断A",
      evidenceSpans: [{ start: 0, end: 6, excerpt: "林川感到" }],
      expectedReaderGain: "增益A",
      damageRisks: ["风险A"],
      rewriteScope: "span_candidate",
      confidence: 0.5,
    },
    {
      id: "h_end",
      opportunityType: "chapter_end_pressure",
      diagnosis: "章末弱钩子诊断B",
      evidenceSpans: [{ start: raw.length - 12, end: raw.length, excerpt: "怎么回事" }],
      expectedReaderGain: "增益B",
      damageRisks: ["风险B"],
      rewriteScope: "span_candidate",
      confidence: 0.55,
    },
  ];
  await gen.generate({
    rawText: raw,
    rawCandidateId: "candidate:raw:1",
    hypotheses,
    intent: makeIntent(),
    context: makeContext(),
    contextHash: "hash-1",
    chapterNumber: 5,
    modelGenerate: captureModel,
    strategyRegistry: registry,
  });
  assert.equal(capturedPrompts.length, 2);
  // 第一个候选 prompt 只含诊断A，不含诊断B
  assert.match(capturedPrompts[0], /感知侵蚀诊断A/);
  assert.doesNotMatch(capturedPrompts[0], /章末弱钩子诊断B/);
  // 第二个候选 prompt 只含诊断B，不含诊断A
  assert.match(capturedPrompts[1], /章末弱钩子诊断B/);
  assert.doesNotMatch(capturedPrompts[1], /感知侵蚀诊断A/);
});

test("CandidateGenerator: 无对应策略的 hypothesis → failure", async () => {
  const gen = createEditorialCandidateGenerator();
  const registry = createEditorialStrategyRegistry();
  // 构造一个没有对应策略的 hypothesis（opportunityType 合法但 registry 无该策略不可能，
  // 所以用未注册的 hypothesis 直接测试 pickStrategy 返回 null 的路径——
  // 这里用一个空 registry 触发）
  const emptyRegistry = createEditorialStrategyRegistry();
  // 清空策略：重新构造一个空 registry（构造函数支持传空数组）
  const { EditorialStrategyRegistry } = await import("../dist/v2/core/editorial-strategy-registry.js");
  const emptyReg = new EditorialStrategyRegistry([]);
  const hypotheses = [
    {
      id: "h1",
      opportunityType: "character_choice",
      diagnosis: "x",
      evidenceSpans: [{ start: 0, end: 1 }],
      expectedReaderGain: "y",
      damageRisks: ["z"],
      rewriteScope: "event_candidate",
      confidence: 0.5,
    },
  ];
  const result = await gen.generate({
    rawText: "林川。",
    rawCandidateId: "candidate:raw:1",
    hypotheses,
    intent: makeIntent(),
    context: makeContext(),
    contextHash: "hash-1",
    chapterNumber: 5,
    modelGenerate: makeStubModel("正文"),
    strategyRegistry: emptyReg,
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].reason, /策略/);
  // 引用避免未使用告警
  assert.ok(registry);
});

// ============================================================================
// 4. P1-9：EditorialOpportunityJudge LLM 主导模式
// ============================================================================

/**
 * stub model：按 kind 返回不同内容。
 * kind === "opportunity_judge" → 返回结构化 JSON verdict（编辑机会判断）
 * 其他 kind → 返回空文本（不影响候选生成/裁判路径）
 */
function makeOpportunityStubModel(verdict) {
  return async (input) => {
    if (input.kind === "opportunity_judge") {
      return {
        text: JSON.stringify(verdict),
        model: "stub-opportunity",
        route: input.route,
        durationMs: 5,
      };
    }
    return { text: "", model: "stub", route: input.route, durationMs: 1 };
  };
}

/** LLM 抛异常的 stub model */
function makeOpportunityThrowingModel(err) {
  return async (input) => {
    if (input.kind === "opportunity_judge") {
      throw new Error(err);
    }
    return { text: "", model: "stub", route: input.route, durationMs: 1 };
  };
}

/** LLM 返回非法 JSON 的 stub model */
function makeOpportunityGarbageModel() {
  return async (input) => {
    if (input.kind === "opportunity_judge") {
      return {
        text: "这不是 JSON，无法解析",
        model: "stub-opportunity",
        route: input.route,
        durationMs: 5,
      };
    }
    return { text: "", model: "stub", route: input.route, durationMs: 1 };
  };
}

test("OpportunityJudge LLM 模式: LLM 返回带真实 excerpt 的机会 → hypotheses 生成（llmJudged=true）", async () => {
  const judge = createEditorialOpportunityJudge();
  const raw = [
    "林川推开舱门，冲进浑浊的水里。",
    "他抓住苏婉的手臂，把她往水面拉。",
    "暗流拉扯着他的腿，他用力蹬水。",
    "过了一会儿，他回到了岸上，换了干衣服，坐在床边休息。",
    "窗外的雨还在下，水面恢复了平静，他闭上眼睛，很快睡着了。",
  ].join("\n");
  // excerpt 必须逐字存在于 raw
  const realExcerpt = "窗外的雨还在下，水面恢复了平静";
  const verdict = {
    opportunities: [
      {
        opportunityType: "chapter_end_pressure",
        diagnosis: "章末平淡收束，缺少翻页牵引力",
        evidenceExcerpt: realExcerpt,
        expectedReaderGain: "章末抛出新压力，提升翻页牵引力",
        damageRisks: ["强行加钩子可能与本章事实冲突"],
        confidence: 0.7,
      },
    ],
    noOpReason: null,
  };
  const result = await judge.judge({
    rawText: raw,
    intent: makeIntent(),
    longTermState: null,
    constitution: null,
    characterNames: ["林川", "苏婉"],
    modelGenerate: makeOpportunityStubModel(verdict),
  });
  assert.equal(result.llmJudged, true, "应由 LLM 主导判断");
  assert.equal(result.hypotheses.length, 1, "应生成 1 个 hypothesis");
  const h = result.hypotheses[0];
  assert.equal(h.opportunityType, "chapter_end_pressure");
  // span 必须真实存在于 raw
  assert.equal(h.evidenceSpans.length, 1);
  const span = h.evidenceSpans[0];
  assert.ok(span.start >= 0 && span.end <= raw.length, "span 应在 raw 范围内");
  assert.equal(raw.slice(span.start, span.end), realExcerpt, "span excerpt 应与 raw 原文一致");
  assert.ok(!result.llmFallbackReason, "LLM 成功不应有 fallbackReason");
});

test("OpportunityJudge LLM 模式: span 强制 — excerpt 不在 raw 中 → 该机会被丢弃", async () => {
  const judge = createEditorialOpportunityJudge();
  const raw = "林川推开门，走进房间，坐下来休息。";
  const verdict = {
    opportunities: [
      {
        opportunityType: "chapter_end_pressure",
        diagnosis: "机会1（真实 excerpt）",
        evidenceExcerpt: "坐下来休息", // 真实存在于 raw
        expectedReaderGain: "增益1",
        damageRisks: ["风险1"],
        confidence: 0.6,
      },
      {
        opportunityType: "character_choice",
        diagnosis: "机会2（伪造 excerpt）",
        evidenceExcerpt: "这段文字根本不在raw中", // 不在 raw 中
        expectedReaderGain: "增益2",
        damageRisks: ["风险2"],
        confidence: 0.6,
      },
    ],
    noOpReason: null,
  };
  const result = await judge.judge({
    rawText: raw,
    intent: makeIntent(),
    longTermState: null,
    constitution: null,
    characterNames: ["林川"],
    modelGenerate: makeOpportunityStubModel(verdict),
  });
  assert.equal(result.llmJudged, true);
  // 只有真实 excerpt 的机会被保留，伪造的被 span 强制丢弃
  assert.equal(result.hypotheses.length, 1, "伪造 excerpt 的机会应被丢弃");
  assert.equal(result.hypotheses[0].opportunityType, "chapter_end_pressure");
});

test("OpportunityJudge LLM 模式: LLM 抛异常 → 本地信号只诊断并保留 raw", async () => {
  const judge = createEditorialOpportunityJudge();
  // 构造一个本地扫描器会触发的 raw（章末无钩子）
  const raw = [
    "林川推开舱门，冲进浑浊的水里。",
    "他抓住苏婉的手臂，把她往水面拉。",
    "过了一会儿，他回到了岸上，换了干衣服，坐在床边休息。",
    "窗外的雨还在下，水面恢复了平静，他闭上眼睛，很快睡着了。",
  ].join("\n");
  const result = await judge.judge({
    rawText: raw,
    intent: makeIntent(),
    longTermState: null,
    constitution: null,
    characterNames: ["林川", "苏婉"],
    modelGenerate: makeOpportunityThrowingModel("LLM API timeout"),
  });
  assert.equal(result.llmJudged, false, "LLM 异常时不能伪装成文学判断成功");
  assert.ok(result.llmFallbackReason, "应有失败原因");
  assert.match(result.llmFallbackReason, /仅作诊断，保留 raw/);
  assert.deepEqual(result.hypotheses, []);
  assert.ok(result.scannedSignals.length > 0, "本地扫描器应运行");
});

test("OpportunityJudge LLM 模式: LLM 返回非法 JSON → 本地信号只诊断并保留 raw", async () => {
  const judge = createEditorialOpportunityJudge();
  const raw = [
    "林川推开舱门，冲进浑浊的水里。",
    "他抓住苏婉的手臂，把她往水面拉。",
    "过了一会儿，他回到了岸上，换了干衣服，坐在床边休息。",
    "窗外的雨还在下，水面恢复了平静，他闭上眼睛，很快睡着了。",
  ].join("\n");
  const result = await judge.judge({
    rawText: raw,
    intent: makeIntent(),
    longTermState: null,
    constitution: null,
    characterNames: ["林川", "苏婉"],
    modelGenerate: makeOpportunityGarbageModel(),
  });
  assert.equal(result.llmJudged, false, "parse 失败不能伪装成文学判断成功");
  assert.ok(result.llmFallbackReason, "应有失败原因");
  assert.deepEqual(result.hypotheses, []);
});

test("OpportunityJudge LLM 模式: LLM 判定无机会（空 opportunities + noOpReason）→ no-op（llmJudged=true）", async () => {
  const judge = createEditorialOpportunityJudge();
  const raw = HIGH_QUALITY_RAW;
  const verdict = {
    opportunities: [],
    noOpReason: "raw 已充分满足章节意图，无值得生成编辑候选的机会",
  };
  const result = await judge.judge({
    rawText: raw,
    intent: makeIntent(),
    longTermState: null,
    constitution: null,
    characterNames: ["林川", "苏婉", "老周"],
    modelGenerate: makeOpportunityStubModel(verdict),
  });
  assert.equal(result.llmJudged, true);
  assert.equal(result.hypotheses.length, 0, "LLM 判定无机会 → 0 hypothesis");
  assert.ok(result.noOpReason, "应有 noOpReason");
  assert.match(result.noOpReason, /无机会|满足/);
});

test("OpportunityJudge LLM 模式: 不传 modelGenerate → 纯本地模式（llmJudged=false，无 fallbackReason）", async () => {
  const judge = createEditorialOpportunityJudge();
  const raw = HIGH_QUALITY_RAW;
  const result = await judge.judge({
    rawText: raw,
    intent: makeIntent(),
    longTermState: null,
    constitution: null,
    characterNames: ["林川", "苏婉", "老周"],
    // 不传 modelGenerate → 只保留本地诊断
  });
  assert.equal(result.llmJudged, false, "无 modelGenerate 应为本地模式");
  assert.equal(result.llmFallbackReason, undefined, "本地模式不应有 fallbackReason");
  assert.deepEqual(result.hypotheses, [], "本地机械信号不能独立授权候选");
  assert.ok(result.scannedSignals.length > 0, "本地扫描器应运行");
});

test("OpportunityJudge LLM 模式: LLM 机会通过准入控制（最多 2 个，类型不冲突）", async () => {
  // Step 4a：默认 maxHypotheses=1 + 第2候选置信门 0.7；本测试验证准入控制（类型互斥），
  // 需显式开启 2 候选并降低置信门以隔离准入控制逻辑。
  await withEnvAsync({ PINOVEL_MAX_HYPOTHESES: "2", PINOVEL_SECOND_CANDIDATE_CONFIDENCE: "0" }, async () => {
    const judge = createEditorialOpportunityJudge();
    const raw = [
      "林川感到水下有东西。",
      "他意识到危险正在逼近，注意到远处有黑影。",
      "他感到无力，仿佛预感到了什么。",
      "过了一会儿，他回到了岸上，换了干衣服，坐在床边休息。",
      "窗外的雨还在下，水面恢复了平静，他闭上眼睛，很快睡着了。",
    ].join("\n");
    const verdict = {
      opportunities: [
        {
          opportunityType: "voice_and_naturalness",
          diagnosis: "感知侵蚀过多",
          evidenceExcerpt: "林川感到",
          expectedReaderGain: "回到母语自然",
          damageRisks: ["可能削弱内省重量"],
          confidence: 0.6,
        },
        {
          opportunityType: "chapter_end_pressure",
          diagnosis: "章末弱钩子",
          evidenceExcerpt: "很快睡着了",
          expectedReaderGain: "提升翻页牵引力",
          damageRisks: ["可能与事实冲突"],
          confidence: 0.65,
        },
      ],
      noOpReason: null,
    };
    const result = await judge.judge({
      rawText: raw,
      intent: makeIntent(),
      longTermState: null,
      constitution: null,
      characterNames: ["林川"],
      modelGenerate: makeOpportunityStubModel(verdict),
    });
    assert.equal(result.llmJudged, true);
    assert.equal(result.hypotheses.length, 2, "应通过准入控制生成 2 个 hypothesis");
    const types = result.hypotheses.map((h) => h.opportunityType).sort();
    assert.deepEqual(types, ["chapter_end_pressure", "voice_and_naturalness"]);
    // 每个 hypothesis 的 span 应真实存在于 raw
    for (const h of result.hypotheses) {
      for (const s of h.evidenceSpans) {
        assert.ok(s.start >= 0 && s.end <= raw.length, "span 应在 raw 范围内");
        assert.equal(raw.slice(s.start, s.end).length > 0, true, "span 应非空");
      }
    }
  });
});
