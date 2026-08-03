/**
 * Phase 5 统一编排与单主链路切换测试（计划 §Phase 5 + §10.1）
 *
 * 覆盖退出条件：
 * 1. 所有章节走统一入口（无 whitelist gating）
 * 2. 非白名单 workspace 可用
 * 3. 编辑层失败仍返回 raw
 * 4. raw 失败结构化阻断（hard block）
 * 5. 无 silent legacy fallback（无 v2NotImplemented）
 * 6. 成功路径：raw → editorial → judge → select editorial
 * 7. 最终正文选定后状态提交 + 原子保存
 *
 * 降级链（计划 §Phase 5）：
 *   editorial_success → 交付 editorial
 *   editorial_fail/judge_fail → 交付 raw + warning
 *   raw_fail → hard_block（无 legacy 回退）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUnifiedOrchestrator } from "../dist/v2/core/unified-orchestrator.js";
import { buildJudgeEvidence } from "../dist/v2/core/unified-entry.js";

// ============================================================================
// 辅助：构造 intent / context / 候选正文
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
    // P1 修复（Phase 1 整改）：orchestrator 入口要求 style_profile 风格指纹（kind=fingerprint），
    // 缺失会在模型调用前 hard block。测试默认提供最小可消费档案。
    styleReferences: [
      {
        id: "style:default-fingerprint",
        kind: "fingerprint",
        content: JSON.stringify({
          editorialGuidance: ["保持叙事节奏紧凑", "对白自然口语化"],
          characterVoiceGuidance: {},
        }),
      },
    ],
    sourceMap: [],
    constitution: null,
    longTermState: null,
    ...overrides,
  };
}

/** raw 正文：章末平淡无钩子（触发 chapter_end_pressure 机会） */
const RAW_TEXT_WEAK_END = [
  "林川推开门，走了进去。房间里很暗，他摸索着前进。",
  "他抓住苏婉的手臂，把她往水面拉。",
  "暗流拉扯着他的腿，他用力蹬水，把苏婉推到浅滩。",
  "过了一会儿，他回到了岸上，换了干衣服，坐在床边休息。",
  "窗外的雨还在下，水面恢复了平静，他闭上眼睛，很快睡着了。",
].join("\n");

/** editorial 正文：章末有钩子（含"？") */
const EDITORIAL_TEXT_STRONG_HOOK = [
  "林川推开门，走了进去。房间里很暗，他摸索着前进。",
  "他抓住苏婉的手臂，把她往水面拉，暗流拉扯着他的腿。",
  "他把苏婉推到浅滩，又一次跳进水里去找老周。",
  "浑浊的水下，一个黑影正缓缓游向老周。",
  "林川心里一紧：那东西的形状，不像鱼。老周为什么在笑？他到底看到了什么？",
].join("\n");

const TEST_CONSTITUTION = {
  workIdentity: "一部以主动选择、真实代价和长期人物成长为核心的都市异能成长小说。",
  readerPromise: ["关键胜利必须来自角色选择，并留下可追踪代价。"],
  genrePromises: ["都市日常与异能危险必须同时保持可信。"],
  protagonistCoreConflict: "林川必须在保护同伴与追索水下真相之间持续做出不可回避的选择。",
  thematicQuestions: ["保护他人是否必然要求牺牲自己？"],
  aestheticDirection: ["具体动作承载情绪，不用作者总结替代人物反应。"],
  forbiddenDrift: ["禁止无来源空降新神器、新组织计划或升级结果。"],
  sourceIds: ["test:constitution"],
};

/** 高质量 raw：章末有钩子，不触发编辑机会 */
const HIGH_QUALITY_RAW = [
  "林川推开舱门，冲进浑浊的水里。",
  "他抓住苏婉的手臂，把她往水面拉。",
  "暗流拉扯着他的腿，他用力蹬水，转身挡住一块漂来的木板。",
  "他把苏婉推到浅滩，又一次跳进水里去找老周。",
  "浑浊的水下，一个黑影正缓缓游向老周。",
  "林川心里一紧：那东西的形状，不像鱼。他到底看到了什么？",
].join("\n");

// ============================================================================
// 辅助：复合 stub 模型（按 kind 路由）
// ============================================================================

/**
 * 构造复合 stub 模型，按 input.kind 路由：
 * - "raw_chapter" → 返回 rawText
 * - "editorial_amplified" → 返回 editorialText（或抛异常/返回空）
 * - "literary_judge" → 解析 prompt，按 betterMarker 决定 winner
 */
function makeCompositeStub(opts) {
  const {
    rawText,
    editorialText,
    betterMarker = "？",
    judgeConfidence = "clear",
    rawThrow = false,
    editorialThrow = false,
    editorialEmpty = false,
    judgeThrow = false,
    opportunities,
    craftPhenomena = [],
    opportunityNoOpReason = null,
    captureCalls,
  } = opts;

  return async (input) => {
    captureCalls?.push(input);
    if (input.kind === "raw_chapter") {
      if (rawThrow) throw new Error("raw 生成异常（stub）");
      return { text: rawText, model: "stub-raw", route: input.route, durationMs: 10 };
    }
    if (input.kind === "editorial_amplified") {
      if (editorialThrow) throw new Error("editorial 生成异常（stub）");
      if (editorialEmpty) return { text: "", model: "stub-ed", route: input.route, durationMs: 10 };
      return { text: editorialText, model: "stub-ed", route: input.route, durationMs: 10 };
    }
    if (input.kind === "opportunity_judge") {
      const resolvedOpportunities = opportunities ?? [{
        opportunityType: "chapter_end_pressure",
        craftDomain: "ending_and_closure",
        diagnosis: "章末因果牵引力不足",
        evidenceExcerpt: rawText.slice(0, Math.min(12, rawText.length)),
        expectedReaderGain: "增强继续阅读意愿",
        damageRisks: ["可能破坏既定章末事实"],
        confidence: 0.8,
      }];
      return {
        text: JSON.stringify({
          craftPhenomena,
          opportunities: resolvedOpportunities,
          noOpReason: opportunityNoOpReason,
        }),
        model: "stub-opportunity",
        route: input.route,
        durationMs: 10,
      };
    }
    if (input.kind === "literary_judge") {
      if (judgeThrow) throw new Error("裁判异常（stub）");
      // 解析 prompt 识别候选甲/乙
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
      return { text: JSON.stringify(verdict), model: "stub-judge", route: input.route, durationMs: 10 };
    }
    return { text: "", model: "stub", route: input.route, durationMs: 10 };
  };
}

// ============================================================================
// 辅助：临时 project
// ============================================================================

function makeTempProject() {
  const dir = mkdtempSync(join(tmpdir(), "p5-test-"));
  return { dir, projectRoot: dir };
}

function makeOrchestratorInput(overrides = {}) {
  const { dir } = makeTempProject();
  return {
    workspaceId: "test-ws",
    chapterId: "ch-test",
    chapterNumber: 1,
    projectRoot: dir,
    intent: makeIntent(),
    context: makeContext(),
    constitution: null,
    characterNames: ["林川", "苏婉", "老周"],
    allowAutomaticLiterarySelection: true,
    modelGenerate: makeCompositeStub({ rawText: RAW_TEXT_WEAK_END, editorialText: EDITORIAL_TEXT_STRONG_HOOK }),
    ...overrides,
  };
}

// ============================================================================
// 1. 成功路径：raw → editorial → judge → select editorial
// ============================================================================

test("UnifiedOrchestrator: 成功路径 → 交付 editorial", async () => {
  const input = makeOrchestratorInput();
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.equal(result.status, "ok");
    assert.ok(result.stageResults.craftPhenomenonReport, "成功候选路径必须保留 post-raw 工艺报告");
    assert.equal(result.selectedSource, "editorial");
    assert.equal(result.text, EDITORIAL_TEXT_STRONG_HOOK);
    assert.ok(result.candidates.length >= 2, "应有 raw + editorial 候选");
    assert.ok(result.judgeResult, "应有裁判结果");
    assert.equal(result.judgeResult.finalSelectedCandidateId, result.selectedCandidateId);
    // 章节文件已保存
    assert.ok(result.chapterFilePath);
    assert.ok(existsSync(result.chapterFilePath), "章节文件应已保存");
    const saved = readFileSync(result.chapterFilePath, "utf-8");
    assert.equal(saved, EDITORIAL_TEXT_STRONG_HOOK);
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

test("UnifiedOrchestrator: evalPrefix 透传到 editorial prompt", async () => {
  const baseModel = makeCompositeStub({
    rawText: RAW_TEXT_WEAK_END,
    editorialText: EDITORIAL_TEXT_STRONG_HOOK,
  });
  let editorialPrompt = "";
  const input = makeOrchestratorInput({
    evalPrefix: "前章末尾唯一内容：林川听见沉船里传来三下敲击声。",
    modelGenerate: async (modelInput) => {
      if (modelInput.kind === "editorial_amplified") {
        editorialPrompt = modelInput.userPrompt;
      }
      return baseModel(modelInput);
    },
  });
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.equal(result.status, "ok");
    assert.match(editorialPrompt, /【前文】/);
    assert.match(editorialPrompt, /前章末尾唯一内容：林川听见沉船里传来三下敲击声。/);
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

test("Step 4c: PINOVEL_PARALLEL_CANDIDATES=2 时 orchestrate 仍正常完成（并行标志集成）", async () => {
  const savedFlag = process.env.PINOVEL_PARALLEL_CANDIDATES;
  process.env.PINOVEL_PARALLEL_CANDIDATES = "2";
  try {
    const input = makeOrchestratorInput();
    try {
      const orch = createUnifiedOrchestrator();
      const result = await orch.orchestrate(input);
      assert.equal(result.status, "ok");
      assert.ok(result.candidates.length >= 2, "应有 raw + editorial 候选");
      assert.ok(result.judgeResult, "应有裁判结果");
    } finally {
      rmSync(input.projectRoot, { recursive: true, force: true });
    }
  } finally {
    if (savedFlag === undefined) delete process.env.PINOVEL_PARALLEL_CANDIDATES;
    else process.env.PINOVEL_PARALLEL_CANDIDATES = savedFlag;
  }
});

test("UnifiedOrchestrator: 成功路径有 hypothesis 和 editorial 候选", async () => {
  const input = makeOrchestratorInput();
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.ok(result.hypotheses.length > 0, "应有编辑机会 hypothesis");
    assert.ok(result.hypotheses.length <= 2, "hypothesis 应 ≤ 2");
    const editorialCands = result.candidates.filter((c) => c.kind === "editorial_amplified");
    assert.ok(editorialCands.length >= 1, "应有 editorial 候选");
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. 无编辑机会 → 交付 raw + warning
// ============================================================================

test("UnifiedOrchestrator: 高质量 raw 无编辑机会 → 交付 raw + warning", async () => {
  const observationExcerpt = "他把苏婉推到浅滩";
  const calls = [];
  const input = makeOrchestratorInput({
    modelGenerate: makeCompositeStub({
      rawText: HIGH_QUALITY_RAW,
      editorialText: EDITORIAL_TEXT_STRONG_HOOK,
      opportunities: [],
      craftPhenomena: [{
        domain: "chapter_progression",
        status: "observed",
        phenomenon: "人物行动改变了场景状态",
        evidenceExcerpt: observationExcerpt,
        readerImpact: "救援推进具有可见结果",
        confidence: 0.9,
      }],
      opportunityNoOpReason: "raw 已充分完成本章任务，无高价值编辑机会",
      captureCalls: calls,
    }),
  });
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.equal(result.status, "ok");
    assert.ok(result.stageResults.craftPhenomenonReport, "no-op/raw 路径也必须保留 post-raw 工艺报告");
    assert.equal(result.hypotheses.length, 0);
    assert.equal(result.selectedSource, "raw");
    assert.equal(result.stageResults.craftPhenomenonReport.observations.length, 1);
    assert.equal(result.stageResults.craftPhenomenonReport.observations[0].sourceSpans[0].excerpt, observationExcerpt);
    assert.equal(result.stageResults.methodologyDiagnosticState.advisoryOnly, true);
    assert.equal(result.stageResults.methodologyDiagnosticState.canEnterRawPrompt, false);
    const rawCall = calls.find((call) => call.kind === "raw_chapter");
    assert.ok(rawCall, "应捕获 raw 模型调用");
    assert.doesNotMatch(
      `${rawCall.systemPrompt}\n${rawCall.userPrompt}`,
      /methodology-diagnostic-state|MethodologyDiagnosticState|跨章诊断状态/,
      "方法论诊断状态不得进入 raw prompt",
    );
    assert.ok(result.warnings.some((w) => w.includes("raw")), `应有 raw warning：${result.warnings.join(";")}`);
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. editorial 生成失败 → 交付 raw + warning
// ============================================================================

test("UnifiedOrchestrator: editorial 生成异常 → 交付 raw + warning", async () => {
  const input = makeOrchestratorInput({
    modelGenerate: makeCompositeStub({
      rawText: RAW_TEXT_WEAK_END,
      editorialText: EDITORIAL_TEXT_STRONG_HOOK,
      editorialThrow: true,
    }),
  });
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.equal(result.status, "ok");
    assert.equal(result.selectedSource, "raw");
    assert.equal(result.text, RAW_TEXT_WEAK_END);
    assert.ok(result.warnings.some((w) => w.includes("editorial")), `应有 editorial 失败 warning：${result.warnings.join(";")}`);
    // 章节文件仍保存（raw）
    assert.ok(existsSync(result.chapterFilePath));
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

test("UnifiedOrchestrator: editorial 返回空文本 → 交付 raw + warning", async () => {
  const input = makeOrchestratorInput({
    modelGenerate: makeCompositeStub({
      rawText: RAW_TEXT_WEAK_END,
      editorialText: EDITORIAL_TEXT_STRONG_HOOK,
      editorialEmpty: true,
    }),
  });
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.equal(result.status, "ok");
    assert.equal(result.selectedSource, "raw");
    assert.ok(result.warnings.some((w) => w.includes("raw") || w.includes("editorial")), `应有 warning：${result.warnings.join(";")}`);
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. 裁判失败 → 交付 raw + warning
// ============================================================================

test("UnifiedOrchestrator: 裁判异常 → 交付 raw + warning", async () => {
  const input = makeOrchestratorInput({
    modelGenerate: makeCompositeStub({
      rawText: RAW_TEXT_WEAK_END,
      editorialText: EDITORIAL_TEXT_STRONG_HOOK,
      judgeThrow: true,
    }),
  });
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.equal(result.status, "ok");
    assert.equal(result.selectedSource, "raw");
    assert.ok(result.warnings.some((w) => w.includes("裁判")), `应有裁判失败 warning：${result.warnings.join(";")}`);
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

test("UnifiedOrchestrator: 裁判判 tie → 交付 raw", async () => {
  // 两个候选都含"门" → tie
  const input = makeOrchestratorInput({
    modelGenerate: makeCompositeStub({
      rawText: RAW_TEXT_WEAK_END,
      editorialText: EDITORIAL_TEXT_STRONG_HOOK,
      betterMarker: "门", // 两者都含"门" → tie
    }),
  });
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.equal(result.status, "ok");
    assert.equal(result.selectedSource, "raw");
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. raw 失败 → hard block（无 legacy 回退）
// ============================================================================

test("UnifiedOrchestrator: raw 异常 → hard block", async () => {
  const input = makeOrchestratorInput({
    modelGenerate: makeCompositeStub({
      rawText: RAW_TEXT_WEAK_END,
      editorialText: EDITORIAL_TEXT_STRONG_HOOK,
      rawThrow: true,
    }),
  });
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.equal(result.status, "blocked");
    assert.ok(result.failureEnvelope, "应有 failureEnvelope");
    assert.equal(result.failureEnvelope.degradedTo, "hard_block");
    assert.ok(result.failureEnvelope.reason.includes("raw"), `原因应含 raw：${result.failureEnvelope.reason}`);
    assert.equal(result.text, "");
    assert.equal(result.chapterFilePath, null);
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

test("UnifiedOrchestrator: raw 空文本 → hard block", async () => {
  const input = makeOrchestratorInput({
    modelGenerate: makeCompositeStub({
      rawText: "",
      editorialText: EDITORIAL_TEXT_STRONG_HOOK,
    }),
  });
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.equal(result.status, "blocked");
    assert.ok(result.failureEnvelope);
    assert.equal(result.failureEnvelope.degradedTo, "hard_block");
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 6. 非白名单 workspace 可用（无 whitelist gating）
// ============================================================================

test("UnifiedOrchestrator: 非白名单 workspace 可用", async () => {
  // 使用一个明确不在旧 V2_WHITELIST 中的 workspace
  const input = makeOrchestratorInput({
    workspaceId: "non-whitelist-workspace-xyz",
    chapterNumber: 42,
  });
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    // 非白名单 workspace 不应被阻断
    assert.notEqual(result.status, "blocked", "非白名单 workspace 不应被阻断");
    assert.equal(result.status, "ok");
    assert.ok(result.text.length > 0);
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 7. 无 silent legacy fallback（无 v2NotImplemented）
// ============================================================================

test("UnifiedOrchestrator: 输出无 v2NotImplemented 字段（无 legacy 回退）", async () => {
  const input = makeOrchestratorInput();
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    // UnifiedOrchestratorOutput 不含 v2NotImplemented
    assert.equal(result.v2NotImplemented, undefined, "不应有 v2NotImplemented 字段");
    assert.equal(result.legacyFallback, undefined, "不应有 legacyFallback 字段");
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

test("UnifiedOrchestrator: raw 失败时无 legacy 回退，直接 hard block", async () => {
  const input = makeOrchestratorInput({
    modelGenerate: makeCompositeStub({
      rawText: RAW_TEXT_WEAK_END,
      editorialText: EDITORIAL_TEXT_STRONG_HOOK,
      rawThrow: true,
    }),
  });
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    // raw 失败 → hard block，不回退 legacy
    assert.equal(result.status, "blocked");
    assert.equal(result.failureEnvelope.degradedTo, "hard_block");
    // 不应有 legacy 相关字段
    assert.equal(result.v2NotImplemented, undefined);
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 8. 状态提交 + 原子保存
// ============================================================================

test("UnifiedOrchestrator: 最终正文原子保存到章节文件", async () => {
  const input = makeOrchestratorInput();
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.ok(result.chapterFilePath);
    assert.ok(existsSync(result.chapterFilePath), "章节文件应存在");
    const saved = readFileSync(result.chapterFilePath, "utf-8");
    assert.equal(saved, result.text, "保存内容应等于最终正文");
    // 不应有 .tmp 残留
    assert.ok(!existsSync(result.chapterFilePath + ".tmp"), "不应有 .tmp 残留");
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

test("UnifiedOrchestrator: stageResults 记录各阶段产物（trace 审计）", async () => {
  const input = makeOrchestratorInput({
    constitution: TEST_CONSTITUTION,
    context: makeContext({ constitution: TEST_CONSTITUTION }),
  });
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.ok(result.stageResults.rawCandidate, "应有 rawCandidate 阶段产物");
    assert.ok(result.stageResults.rawFactGuard, "应有 rawFactGuard 阶段产物");
    assert.ok(result.stageResults.editorialOpportunity, "应有 editorialOpportunity 阶段产物");
    assert.ok(result.stageResults.editorialCandidateGeneration, "应有 editorialCandidateGeneration 阶段产物");
    assert.ok(result.stageResults.judgeArbitration, "应有 judgeArbitration 阶段产物");
    assert.ok(result.stageResults.finalSelection, "应有 finalSelection 阶段产物");
    assert.ok(result.stageResults.atomicSave, "应有 atomicSave 阶段产物");
    assert.equal(result.stageResults.rawPromptConstraintAudit.type, "editorial");
    assert.deepEqual(result.stageResults.methodologyPolicy.violations, []);
    assert.deepEqual(result.stageResults.constitutionConsumption, {
      raw: [
        "constitution.workIdentity",
        "constitution.readerPromise",
        "constitution.genrePromises",
        "constitution.protagonistCoreConflict",
        "constitution.thematicQuestions",
        "constitution.forbiddenDrift",
      ],
      editorial: [
        "constitution.workIdentity",
        "constitution.protagonistCoreConflict",
        "constitution.readerPromise",
        "constitution.forbiddenDrift",
      ],
      judge: [
        "constitution.protagonistCoreConflict",
        "constitution.readerPromise",
      ],
    });
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

test("UnifiedOrchestrator: stagedStateUpdate 与最终候选不匹配时整次交付失败", async () => {
  const { dir } = makeTempProject();
  const input = {
    workspaceId: "test-ws-state",
    chapterId: "ch-state",
    chapterNumber: 5,
    projectRoot: dir,
    intent: makeIntent(),
    context: makeContext(),
    constitution: null,
    characterNames: ["林川", "苏婉", "老周"],
    modelGenerate: makeCompositeStub({ rawText: RAW_TEXT_WEAK_END, editorialText: EDITORIAL_TEXT_STRONG_HOOK }),
    stagedStateUpdate: {
      additions: [{
        id: "canon:ch5:fact1",
        kind: "canon",
        fact: "林川在 ch5 发现了水怪",
        category: "entity",
        sourceChapter: "ch5",
        sourceRef: "candidate:editorial:ch-state",
        confidence: 0.8,
        lastUpdated: new Date().toISOString(),
      }],
      invalidations: [],
      sourceChapter: "ch5",
      finalCandidateId: "candidate:editorial:ch-state", // 会与实际 id 不匹配，但 editorial 候选 id 含时间戳
    },
  };
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.equal(result.status, "blocked");
    assert.equal(result.failureEnvelope.stage, "atomic_save");
    assert.ok(result.stageResults.stateCommit?.error);
    assert.equal(existsSync(join(dir, "workspaces", "test-ws-state", "chapters", "ch-state.md")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 9. P0-3: editorial 候选 FactGuard 过滤
// ============================================================================

/** editorial 正文含大段重复（触发 duplicate_scan 硬阻断） */
const DUPLICATE_SEGMENT = "这是一个足够长的重复段落用于触发重复扫描检测机制的文本"; // 24 chars
const EDITORIAL_TEXT_WITH_DUPLICATE = DUPLICATE_SEGMENT + DUPLICATE_SEGMENT + "\n林川抓住了苏婉的手臂。";

test("P0-3: editorial 候选 FactGuard 硬阻断 → 过滤后交付 raw", async () => {
  const input = makeOrchestratorInput({
    modelGenerate: makeCompositeStub({
      rawText: RAW_TEXT_WEAK_END,
      editorialText: EDITORIAL_TEXT_WITH_DUPLICATE,
    }),
  });
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.equal(result.status, "ok");
    // editorial 候选有 duplicate_scan 硬阻断 → 被过滤 → 交付 raw
    assert.equal(result.selectedSource, "raw", "editorial 有硬伤应交付 raw");
    assert.equal(result.text, RAW_TEXT_WEAK_END);
    // stageResults 应记录 editorial FactGuard 过滤
    assert.ok(result.stageResults.editorialFactGuard, "应有 editorialFactGuard 阶段产物");
    const fgResults = result.stageResults.editorialFactGuard;
    assert.ok(Array.isArray(fgResults), "editorialFactGuard 应为数组");
    assert.ok(fgResults.some((r) => !r.passed), "应有候选未通过 FactGuard");
    // warnings 应含 FactGuard 过滤信息
    assert.ok(
      result.warnings.some((w) => w.includes("FactGuard") || w.includes("事实硬伤")),
      `应有 FactGuard 过滤 warning：${result.warnings.join(";")}`
    );
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

test("P0-3: 成功路径 stageResults 含 finalFactRecheck（最终事实复检）", async () => {
  const input = makeOrchestratorInput();
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.equal(result.status, "ok");
    assert.ok(result.stageResults.finalFactRecheck, "应有 finalFactRecheck 阶段产物");
    assert.equal(result.stageResults.finalFactRecheck.passed, true, "最终正文应通过复检");
    assert.ok(result.stageResults.finalFactRecheck.selectedSource, "应记录 selectedSource");
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 9b. A4: LanguageRiskLibrary 接入统一编排（全候选语言风险扫描）
// ============================================================================

test("A4: 成功路径 stageResults 含 languageRisk（全候选扫描）", async () => {
  const input = makeOrchestratorInput();
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.equal(result.status, "ok");
    // languageRisk 阶段产物必须存在
    assert.ok(result.stageResults.languageRisk, "应有 languageRisk 阶段产物");
    const lr = result.stageResults.languageRisk;
    assert.ok(typeof lr.scannedCandidateCount === "number", "scannedCandidateCount 应为数字");
    // 成功路径应扫描 raw + 至少 1 个 editorial 候选
    assert.ok(
      lr.scannedCandidateCount >= 2,
      `成功路径应扫描至少 2 个候选（raw + editorial），实际: ${lr.scannedCandidateCount}`
    );
    assert.ok(Array.isArray(lr.reports), "reports 应为数组");
    // 每个 report 应有 candidateId/density/level
    for (const r of lr.reports) {
      assert.ok(typeof r.candidateId === "string", "report 应有 candidateId");
      assert.ok(typeof r.density === "number", "report 应有 density");
      assert.ok(["green", "yellow", "red"].includes(r.level), `report.level 应为 green/yellow/red，实际: ${r.level}`);
    }
    // 应包含 raw 候选的 report
    const rawReport = lr.reports.find((r) => r.candidateId.includes("raw"));
    assert.ok(rawReport, "languageRisk reports 应含 raw 候选");
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

test("A4: raw 交付路径 stageResults 含 languageRisk（raw 扫描）", async () => {
  // editorial 生成异常 → deliverRaw（early-return 路径）
  // A4 要求 early-return 路径也接入 LanguageRiskAnalyzer
  const input = makeOrchestratorInput({
    modelGenerate: makeCompositeStub({
      rawText: RAW_TEXT_WEAK_END,
      editorialText: EDITORIAL_TEXT_STRONG_HOOK,
      editorialThrow: true,
    }),
  });
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.equal(result.status, "ok");
    assert.equal(result.selectedSource, "raw", "editorial 异常应交付 raw");
    // deliverRaw 路径也应有 languageRisk 证据
    assert.ok(result.stageResults.languageRisk, "deliverRaw 路径也应有 languageRisk 阶段产物");
    const lr = result.stageResults.languageRisk;
    assert.ok(typeof lr.scannedCandidateCount === "number", "scannedCandidateCount 应为数字");
    assert.ok(lr.scannedCandidateCount >= 1, `至少扫描 raw 候选，实际: ${lr.scannedCandidateCount}`);
    assert.ok(Array.isArray(lr.reports), "reports 应为数组");
    const rawReport = lr.reports.find((r) => r.candidateId.includes("raw"));
    assert.ok(rawReport, "languageRisk reports 应含 raw 候选");
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 10. P1-6: 多候选比较（allArbitrations 记录全部候选）
// ============================================================================

test("P1-6: 所有 editorial 候选均参与裁判（allArbitrations 记录）", async () => {
  const input = makeOrchestratorInput();
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.equal(result.status, "ok");
    assert.ok(result.stageResults.judgeArbitration, "应有 judgeArbitration 阶段产物");
    const ja = result.stageResults.judgeArbitration;
    // allArbitrations 应存在且记录了所有参与裁判的候选
    assert.ok(ja.allArbitrations, "应有 allArbitrations 记录");
    assert.ok(Array.isArray(ja.allArbitrations), "allArbitrations 应为数组");
    const editorialCands = result.candidates.filter((c) => c.kind === "editorial_amplified");
    // 如果有 editorial 候选，allArbitrations 数量应等于有效 editorial 候选数量
    if (editorialCands.length > 0) {
      assert.ok(
        ja.allArbitrations.length >= 1,
        `allArbitrations 应有至少 1 条记录（有 ${editorialCands.length} 个 editorial 候选）`
      );
    }
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

test("P1-6: 两个 editorial 都胜过 raw 时必须直接决赛", async () => {
  const previousMax = process.env.PINOVEL_MAX_HYPOTHESES;
  process.env.PINOVEL_MAX_HYPOTHESES = "2";
  const editorialTexts = [
    `${RAW_TEXT_WEAK_END}\n第一编辑稿保留了线索。`,
    `${RAW_TEXT_WEAK_END}\n第二编辑稿揭示了终选线索。`,
  ];
  let editorialIndex = 0;
  let directEditorialComparisons = 0;

  const modelGenerate = async (input) => {
    if (input.kind === "raw_chapter") {
      return { text: RAW_TEXT_WEAK_END, model: "stub-raw", route: input.route, durationMs: 1 };
    }
    if (input.kind === "opportunity_judge") {
      return {
        text: JSON.stringify({
          craftPhenomena: [],
          opportunities: [
            {
              opportunityType: "chapter_end_pressure",
              craftDomain: "ending_and_closure",
              diagnosis: "ending needs pressure",
              evidenceExcerpt: RAW_TEXT_WEAK_END.slice(-30),
              expectedReaderGain: "stronger ending pressure",
              damageRisks: ["avoid changing facts"],
              confidence: 0.9,
            },
            {
              opportunityType: "character_choice",
              craftDomain: "chapter_progression",
              diagnosis: "choice needs consequence",
              evidenceExcerpt: RAW_TEXT_WEAK_END.slice(0, 30),
              expectedReaderGain: "clearer choice and cost",
              damageRisks: ["avoid changing facts"],
              confidence: 0.85,
            },
          ],
          noOpReason: null,
        }),
        model: "stub-opportunity",
        route: input.route,
        durationMs: 1,
      };
    }
    if (input.kind === "editorial_amplified") {
      const text = editorialTexts[Math.min(editorialIndex, editorialTexts.length - 1)];
      editorialIndex += 1;
      return { text, model: "stub-editorial", route: input.route, durationMs: 1 };
    }
    if (input.kind === "literary_judge") {
      const aMatch = input.userPrompt.match(/【候选甲】\n+([\s\S]*?)\n+（候选甲总字符数/);
      const bMatch = input.userPrompt.match(/【候选乙】\n+([\s\S]*?)\n+（候选乙总字符数/);
      const textA = aMatch?.[1] ?? "";
      const textB = bMatch?.[1] ?? "";
      const score = (text) => text.includes("终选线索") ? 2 : text.includes("第一编辑稿") ? 1 : 0;
      if (score(textA) > 0 && score(textB) > 0) directEditorialComparisons += 1;
      const winner = score(textA) >= score(textB) ? "A" : "B";
      const worseText = winner === "A" ? textB : textA;
      const worseLabel = winner === "A" ? "B" : "A";
      const excerpt = worseText.slice(0, Math.min(8, worseText.length));
      const span = { start: 0, end: excerpt.length, excerpt };
      return {
        text: JSON.stringify({
          winner,
          confidence: "clear",
          decisiveReasons: [{
            dimension: "causal pressure",
            betterCandidate: winner,
            evidenceA: worseLabel === "A" ? [span] : [],
            evidenceB: worseLabel === "B" ? [span] : [],
            explanation: `${winner} has stronger causal pressure`,
          }],
          factualRisks: [],
          regressionRisks: [],
          constitutionAlignment: "aligned",
        }),
        model: "stub-judge",
        route: input.route,
        durationMs: 1,
      };
    }
    return { text: "", model: "stub", route: input.route, durationMs: 1 };
  };

  const input = makeOrchestratorInput({ modelGenerate });
  try {
    const result = await createUnifiedOrchestrator().orchestrate(input);
    assert.equal(result.status, "ok");
    assert.equal(result.candidates.filter((c) => c.kind === "editorial_amplified").length, 2);
    assert.ok(directEditorialComparisons >= 1, "editorial winners must be compared head to head");
    assert.ok(result.stageResults.judgeArbitration.editorialFinal);
    assert.equal(result.text, editorialTexts[1]);
  } finally {
    if (previousMax === undefined) delete process.env.PINOVEL_MAX_HYPOTHESES;
    else process.env.PINOVEL_MAX_HYPOTHESES = previousMax;
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 11. P0-4: 正文保存失败 → hard block（事务一致性）
// ============================================================================

test("P0-4: 正文原子保存失败 → hard block（不假装成功）", async () => {
  const { dir } = makeTempProject();
  // 把 chapters 路径设为文件（而非目录），使 atomicSave 失败
  const wsDir = join(dir, "workspaces", "test-ws-save-fail");
  mkdirSync(join(dir, "workspaces", "test-ws-save-fail"), { recursive: true });
  const chaptersPath = join(wsDir, "chapters");
  writeFileSync(chaptersPath, "block"); // chapters 是文件，不是目录 → atomicSave 写 .tmp 会失败

  const input = {
    workspaceId: "test-ws-save-fail",
    chapterId: "ch-save-fail",
    chapterNumber: 1,
    projectRoot: dir,
    intent: makeIntent(),
    context: makeContext(),
    constitution: null,
    characterNames: ["林川", "苏婉", "老周"],
    modelGenerate: makeCompositeStub({ rawText: RAW_TEXT_WEAK_END, editorialText: EDITORIAL_TEXT_STRONG_HOOK }),
  };
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    // 正文保存失败 → hard block，不假装 ok
    assert.equal(result.status, "blocked", "正文保存失败应 hard block");
    assert.ok(result.failureEnvelope, "应有 failureEnvelope");
    assert.equal(result.failureEnvelope.degradedTo, "hard_block");
    assert.ok(
      result.failureEnvelope.stage === "atomic_save",
      `stage 应为 atomic_save，实际为 ${result.failureEnvelope.stage}`
    );
    // 状态不应被提交（无污染）
    assert.equal(result.stateCommit, null, "正文保存失败时状态不应提交");
    assert.ok(result.stageResults.chapterQualityEvidence, "structural evidence must run before save");
    assert.ok(result.stageResults.informationReleaseEvidence, "information evidence must run before save");
    assert.ok(result.stageResults.endingCraftEvidence, "ending evidence must run before save");
    assert.equal(result.stageResults.chapterQualityEvidence.structuralEvidenceMeta.skipped, false);
    assert.equal(result.stageResults.informationReleaseEvidence.meta.skipped, false);
    assert.equal(result.stageResults.endingCraftEvidence.meta.skipped, false);
    assert.ok(result.stageResults.chapterQualityEvidence.structuralEvidenceMeta.scannedTextLength > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 12. A6: Trace 完整持久化 judge 证据（匿名映射 / verdict / evidence spans）
// ============================================================================

test("A6: buildJudgeEvidence 完整持久化首轮 clear 胜出的匿名映射/verdict/spans", async () => {
  // 成功路径（raw 弱钩子 + editorial 强钩子 → editorial clear 胜出）
  // 首轮 clear 胜出无需反向复判：rounds 应只有 1 条 first 轮
  const input = makeOrchestratorInput();
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.equal(result.status, "ok");
    assert.ok(result.judgeResult, "应有裁判结果");
    const evidence = buildJudgeEvidence(result.judgeResult);

    // 顶层字段：选择决策 + 触发路径 + 审计摘要
    assert.ok(evidence.selection, "应有 selection");
    assert.equal(typeof evidence.selection.reason, "string");
    assert.equal(typeof evidence.selection.needsReverseReview, "boolean");
    assert.equal(typeof evidence.reverseReviewed, "boolean");
    assert.equal(typeof evidence.arbitrationTriggered, "boolean");
    assert.equal(typeof evidence.conflicted, "boolean");
    assert.equal(typeof evidence.auditSummary, "string");
    assert.ok(
      typeof evidence.finalSelectedCandidateId === "string",
      "finalSelectedCandidateId 应为字符串",
    );

    // rounds 必须存在且至少 1 条（首轮）
    assert.ok(Array.isArray(evidence.rounds), "rounds 应为数组");
    assert.ok(evidence.rounds.length >= 1, `至少 1 轮（首轮），实际: ${evidence.rounds.length}`);

    const firstRound = evidence.rounds[0];
    assert.equal(firstRound.round, "first", "首轮 round 应为 first");

    // 匿名映射完整持久化（A6 核心：可复现顺序随机化）
    assert.ok(firstRound.mapping, "首轮应有 mapping");
    const m = firstRound.mapping;
    assert.ok(typeof m.leftCandidateId === "string", "mapping.leftCandidateId");
    assert.ok(typeof m.rightCandidateId === "string", "mapping.rightCandidateId");
    assert.ok(["A", "B"].includes(m.leftLabel), `mapping.leftLabel 应为 A/B，实际: ${m.leftLabel}`);
    assert.ok(["A", "B"].includes(m.rightLabel), `mapping.rightLabel 应为 A/B，实际: ${m.rightLabel}`);
    assert.equal(typeof m.orderRandomized, "boolean", "mapping.orderRandomized");
    assert.equal(typeof m.seed, "number", "mapping.seed");

    // 首轮 clear 胜出且证据有效 → verdict 非 null
    assert.ok(firstRound.verdict, "首轮 clear 胜出应有 verdict（非降级）");
    const v = firstRound.verdict;
    assert.ok(["A", "B", "tie"].includes(v.winner), `verdict.winner 应为 A/B/tie，实际: ${v.winner}`);
    assert.ok(
      ["clear", "slight", "uncertain"].includes(v.confidence),
      `verdict.confidence 应为 clear/slight/uncertain，实际: ${v.confidence}`,
    );
    assert.ok(Array.isArray(v.decisiveReasons), "verdict.decisiveReasons 应为数组");
    assert.ok(Array.isArray(v.factualRisks), "verdict.factualRisks 应为数组");
    assert.ok(Array.isArray(v.regressionRisks), "verdict.regressionRisks 应为数组");
    assert.equal(typeof v.constitutionAlignment, "string", "verdict.constitutionAlignment");

    // decisiveReasons 的 evidenceA/evidenceB spans 完整持久化（A6 核心：evidence spans）
    for (const dr of v.decisiveReasons) {
      assert.equal(typeof dr.dimension, "string", "decisiveReason.dimension");
      assert.ok(["A", "B", "neither"].includes(dr.betterCandidate), "decisiveReason.betterCandidate");
      assert.ok(Array.isArray(dr.evidenceA), "decisiveReason.evidenceA 应为数组");
      assert.ok(Array.isArray(dr.evidenceB), "decisiveReason.evidenceB 应为数组");
      for (const s of dr.evidenceA) {
        assert.equal(typeof s.start, "number", "evidenceA span.start 应为 number");
        assert.equal(typeof s.end, "number", "evidenceA span.end 应为 number");
      }
      for (const s of dr.evidenceB) {
        assert.equal(typeof s.start, "number", "evidenceB span.start 应为 number");
        assert.equal(typeof s.end, "number", "evidenceB span.end 应为 number");
      }
      assert.equal(typeof dr.explanation, "string", "decisiveReason.explanation");
    }

    // 证据校验结果持久化
    assert.ok(firstRound.evidenceValidation, "首轮应有 evidenceValidation");
    assert.equal(typeof firstRound.evidenceValidation.ok, "boolean", "evidenceValidation.ok");
    assert.ok(Array.isArray(firstRound.evidenceValidation.errors), "evidenceValidation.errors");

    // winnerCandidateId 持久化（反匿名后）
    if (firstRound.verdict.winner !== "tie") {
      assert.ok(
        typeof firstRound.winnerCandidateId === "string",
        "非 tie 时 winnerCandidateId 应为字符串",
      );
    }
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

test("A6: buildJudgeEvidence 持久化降级轮次的 mapping 与 null verdict", async () => {
  // 裁判 LLM 异常 → 首轮降级（verdict=null）→ 保留 raw，不反向复判
  // 验证降级轮次仍持久化 mapping + evidenceValidation，verdict 为 null
  const input = makeOrchestratorInput({
    modelGenerate: makeCompositeStub({
      rawText: RAW_TEXT_WEAK_END,
      editorialText: EDITORIAL_TEXT_STRONG_HOOK,
      judgeThrow: true,
    }),
  });
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.equal(result.status, "ok");
    assert.ok(result.judgeResult, "即使降级也应有 judgeResult（用于 trace 审计）");
    const evidence = buildJudgeEvidence(result.judgeResult);

    assert.ok(evidence.rounds.length >= 1, "降级也应有首轮记录");
    const firstRound = evidence.rounds[0];
    assert.equal(firstRound.degraded, true, "首轮应标记 degraded=true");
    assert.equal(firstRound.verdict, null, "降级时 verdict 应为 null");
    // 降级轮次仍持久化 mapping（A6：匿名映射必须可回放，即使降级）
    assert.ok(firstRound.mapping, "降级轮次仍应有 mapping");
    assert.ok(typeof firstRound.mapping.seed === "number", "降级轮次 mapping.seed");
    assert.ok(firstRound.evidenceValidation, "降级轮次仍应有 evidenceValidation");
    assert.equal(firstRound.evidenceValidation.ok, false, "降级时证据校验应不通过");
    // 降级保留 raw
    assert.equal(evidence.reverseReviewed, false, "降级不触发反向复判");
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 12. Step 1d 修复：预算计数正确性 + 硬上限不穿透
// ============================================================================

test("Step 1d 修复: 模型调用失败也计数（used 不再为 0）", async () => {
  // 旧 wrapModelFn 只在成功后 push，失败请求不计入 → attempts=1 但 used=0，预算门控失效。
  // 修复后 catch 里 push failed:true，used 准确反映实际调用次数（含失败）。
  const input = makeOrchestratorInput({
    modelGenerate: makeCompositeStub({
      rawText: RAW_TEXT_WEAK_END,
      editorialText: EDITORIAL_TEXT_STRONG_HOOK,
      rawThrow: true, // raw 生成抛异常
    }),
  });
  try {
    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    // raw 失败 → hard block
    assert.equal(result.status, "blocked");
    // modelCallLog 应含 failed 条目
    const modelCalls = result.stageResults.modelCalls ?? [];
    assert.ok(modelCalls.length > 0, "失败调用也应计入 modelCallLog");
    assert.ok(modelCalls.some((c) => c.failed === true), "应有 failed:true 条目");
    // used 准确反映实际调用次数
    const budget = result.stageResults.modelBudget;
    assert.ok(budget, "应有 modelBudget");
    assert.ok(budget.used > 0, `used 应 > 0（失败也计数），实际 ${budget.used}`);
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

test("Step 1d 修复: arbitrate 内部多轮超 HARD 被拦截（不穿透）", async () => {
  // 旧硬上限只在 arbitrate 调用前检查，arbitrate 内部首轮+反向+仲裁可穿透 HARD。
  // 修复后 wrapModelFn 每次调用前检查 HARD，arbitrate 内部多轮也被拦截。
  const savedHard = process.env.PINOVEL_MODEL_CALL_HARD;
  process.env.PINOVEL_MODEL_CALL_HARD = "3";
  try {
    const input = makeOrchestratorInput({
      modelGenerate: makeCompositeStub({
        rawText: RAW_TEXT_WEAK_END,
        editorialText: EDITORIAL_TEXT_STRONG_HOOK,
        judgeConfidence: "slight", // 触发反向复判（多轮 LLM 调用，易穿透 HARD）
      }),
    });
    try {
      const orch = createUnifiedOrchestrator();
      const result = await orch.orchestrate(input);
      // 无论 arbitrate 是否被拦截，orchestrate 应返回 ok（拦截时交付 raw）
      assert.equal(result.status, "ok");
      // 关键断言：modelCallLog 不超过 HARD=3
      const modelCalls = result.stageResults.modelCalls ?? [];
      assert.ok(
        modelCalls.length <= 3,
        `modelCallLog 应 ≤ HARD=3（不穿透），实际 ${modelCalls.length}`
      );
      // 如果触发了 HARD 拦截，capped=true
      const budget = result.stageResults.modelBudget;
      if (modelCalls.length >= 3) {
        assert.ok(budget && budget.capped, "HARD 触发应设 capped=true");
      }
    } finally {
      rmSync(input.projectRoot, { recursive: true, force: true });
    }
  } finally {
    if (savedHard === undefined) delete process.env.PINOVEL_MODEL_CALL_HARD;
    else process.env.PINOVEL_MODEL_CALL_HARD = savedHard;
  }
});

test("fullPipelinePreview total budget caps each request and stops later model stages", async () => {
  const calls = [];
  const input = makeOrchestratorInput({
    fullPipelinePreview: true,
    previewTotalTimeoutMs: 25,
    modelGenerate: async (modelInput) => {
      calls.push({ kind: modelInput.kind, timeoutMs: modelInput.timeoutMs });
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (modelInput.kind === "raw_chapter") {
        return { text: RAW_TEXT_WEAK_END, model: "stub-raw", route: modelInput.route, durationMs: 30 };
      }
      return { text: "{}", model: "stub", route: modelInput.route, durationMs: 30 };
    },
  });
  try {
    const result = await createUnifiedOrchestrator().orchestrate(input);
    assert.equal(result.status, "ok");
    assert.equal(calls.length, 1, "budget exhaustion must stop opportunity/editorial/judge calls");
    assert.ok(calls[0].timeoutMs > 0 && calls[0].timeoutMs <= 25);
    assert.equal(result.stageResults.previewBudget?.capped, true);
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});
