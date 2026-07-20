/**
 * P4 CandidateGenerator + legacy-model-route-adapter 测试
 *
 * 验收口径（计划 Task 5）：
 * - 5 类候选生成
 * - 保存不覆盖
 * - promptProfile 审计通过（containsDialogueRatio===false, type==="editorial"）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { ContextCompiler } from "../dist/v2/core/context-compiler.js";
import { CraftJudgmentLibrary } from "../dist/v2/core/craft-judgment-library.js";
import { SceneContractPlanner } from "../dist/v2/core/scene-contract-planner.js";
import { CandidateGenerator, auditPrompt } from "../dist/v2/core/candidate-generator.js";
import {
  createStubModelGenerateFn,
  saveCandidate,
  V2_ROUTES,
} from "../dist/v2/adapters/legacy-model-route-adapter.js";

const PROJECT_ROOT = "D:/CODE/PiNovelStudio";

function setupCh17() {
  const cc = new ContextCompiler();
  const ctxResult = cc.compile({
    workspaceId: "xinmo",
    chapterId: "17",
    chapterNumber: 17,
    projectRoot: PROJECT_ROOT,
  });
  const lib = new CraftJudgmentLibrary();
  const planner = new SceneContractPlanner();
  const plan = planner.plan({
    context: ctxResult.context,
    library: lib,
    seed: ctxResult.sourceSeed,
  });
  return { ctxResult, lib, plan };
}

test("P4: 生成 5 类候选（direct_baseline/context_enhanced/scene_contract/style_aware/model_variant）", async () => {
  const { ctxResult, plan } = setupCh17();
  const gen = new CandidateGenerator();
  const result = await gen.generate({
    context: ctxResult.context,
    contracts: plan.contracts,
    contextHash: ctxResult.contextHash,
    chapterNumber: 17,
    modelGenerate: createStubModelGenerateFn(),
    // 显式排除 editorial_amplified：本测试验证 5 类旧候选，
    // editorial_amplified 需 editorialPlan（见 Layer 2 测试），默认 kinds 含它会触发 auditFailure
    kinds: ["direct_baseline", "context_enhanced", "scene_contract", "style_aware", "model_variant"],
  });

  assert.ok(result.candidates.length >= 5, `应 >= 5 个候选，实际 ${result.candidates.length}`);
  const kinds = new Set(result.candidates.map((c) => c.kind));
  for (const k of ["direct_baseline", "context_enhanced", "scene_contract", "style_aware", "model_variant"]) {
    assert.ok(kinds.has(k), `应包含 kind=${k}`);
  }
});

test("P4: 每个候选 promptProfile 审计通过（containsDialogueRatio===false, type==='editorial'）", async () => {
  const { ctxResult, plan } = setupCh17();
  const gen = new CandidateGenerator();
  const result = await gen.generate({
    context: ctxResult.context,
    contracts: plan.contracts,
    contextHash: ctxResult.contextHash,
    chapterNumber: 17,
    modelGenerate: createStubModelGenerateFn(),
    // 显式排除 editorial_amplified（需 editorialPlan，否则 auditFailure 污染断言）
    kinds: ["direct_baseline", "context_enhanced", "scene_contract", "style_aware", "model_variant"],
  });

  assert.equal(result.auditFailures.length, 0, `不应有审计失败：${JSON.stringify(result.auditFailures)}`);

  for (const c of result.candidates) {
    assert.equal(
      c.promptProfile.containsDialogueRatio,
      false,
      `${c.kind} prompt 不含对白比例`
    );
    assert.equal(
      c.promptProfile.containsParagraphLengthConstraint,
      false,
      `${c.kind} prompt 不含段落长度约束`
    );
    assert.equal(
      c.promptProfile.type,
      "editorial",
      `${c.kind} prompt 应为 editorial 型`
    );
  }
});

test("P4: 候选记录 model/route/promptProfile/contextHash/generatedAt/durationMs", async () => {
  const { ctxResult, plan } = setupCh17();
  const gen = new CandidateGenerator();
  const result = await gen.generate({
    context: ctxResult.context,
    contracts: plan.contracts,
    contextHash: ctxResult.contextHash,
    chapterNumber: 17,
    modelGenerate: createStubModelGenerateFn(),
    // 显式排除 editorial_amplified（需 editorialPlan）
    kinds: ["direct_baseline", "context_enhanced", "scene_contract", "style_aware", "model_variant"],
  });

  for (const c of result.candidates) {
    assert.ok(typeof c.id === "string" && c.id.length > 0);
    assert.ok(typeof c.text === "string" && c.text.length > 0);
    assert.ok(typeof c.model === "string" && c.model.length > 0);
    assert.ok(typeof c.route === "string" && c.route.length > 0);
    assert.ok(typeof c.contextHash === "string" && c.contextHash.length > 0);
    assert.ok(typeof c.generatedAt === "string");
    assert.ok(typeof c.durationMs === "number" && c.durationMs >= 0);
    assert.ok(c.promptProfile.tokensIn > 0);
  }
});

test("P4: 保存候选正文，不覆盖已存在文件（同名追加序号）", async () => {
  const { ctxResult, plan } = setupCh17();
  const gen = new CandidateGenerator();
  const result = await gen.generate({
    context: ctxResult.context,
    contracts: plan.contracts,
    contextHash: ctxResult.contextHash,
    chapterNumber: 17,
    modelGenerate: createStubModelGenerateFn(),
    kinds: ["direct_baseline"],
  });

  const candidate = result.candidates[0];
  const tmpDir = join(PROJECT_ROOT, "workspaces", "xinmo", "v2-candidates-test-tmp");
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  try {
    // 第一次保存
    const r1 = saveCandidate(candidate, tmpDir, "17");
    assert.equal(r1.deduplicated, false, "首次保存不应去重");
    assert.ok(existsSync(r1.filePath));

    // 第二次保存同候选 → 应去重（追加 -1.md）
    const r2 = saveCandidate(candidate, tmpDir, "17");
    assert.equal(r2.deduplicated, true, "二次保存应去重");
    assert.notEqual(r1.filePath, r2.filePath, "去重后文件名不同");
    assert.ok(existsSync(r2.filePath));

    // 第三次保存 → -2.md
    const r3 = saveCandidate(candidate, tmpDir, "17");
    assert.equal(r3.deduplicated, true);
    assert.ok(existsSync(r3.filePath));

    // 原文件内容未被覆盖
    const orig = readFileSync(r1.filePath, "utf-8");
    assert.ok(orig.includes(candidate.id));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("P4: auditPrompt 检测控制型 prompt（对白比例/段落长度/清单）", () => {
  // editorial prompt
  const editorial = auditPrompt(
    "你是顶尖网文作者。",
    "请写出第 17 章。字数预算：3000-5000 字。"
  );
  assert.equal(editorial.type, "editorial");
  assert.equal(editorial.containsDialogueRatio, false);
  assert.equal(editorial.containsParagraphLengthConstraint, false);

  // control: 对白比例
  const control1 = auditPrompt("", "对白比例必须 34%。");
  assert.equal(control1.type, "control");
  assert.equal(control1.containsDialogueRatio, true);

  // control: 段落长度
  const control2 = auditPrompt("", "每段 200 字。");
  assert.equal(control2.type, "control");
  assert.equal(control2.containsParagraphLengthConstraint, true);

  // control: 清单
  const control3 = auditPrompt("", "必须按清单逐条写。");
  assert.equal(control3.type, "control");
});

// Phase D 续修复（2026-07-09 第五轮）：prompt audit 分层 + 诊断字段补全
// 根因：scene_contract 渲染的"【硬约束·必须遵守】...至少保留 80%"被
// `必须.*?\d+\s*%` 误判为 mechanical metric → isControl=true → 候选被拦截。
// 修复后：行动保真约束不应被判为 control，且 profile 暴露 4 项完整诊断字段。
test("Phase D 续: scene_contract 行动保真约束不被误判为 control", () => {
  // 模拟 buildSceneContractBlock 渲染后的 scene_contract prompt 片段
  const sceneContractPrompt =
    "【场景契约】\n## scene:0:rescue（rescue）\n" +
    "读者体验：空间清楚，读者能跟着角色走完救援路径\n" +
    "事实边界：救援路径的空间锚点\n" +
    "【硬约束·必须遵守】保留 rawStage2 已有的主角行动词（至少保留 80%）：推开、冲进、夺过\n" +
    "违反硬约束的候选将被废弃重写。请确保行动词在正文动作描写中实际出现,不要用感知词替代主角主动行动。\n" +
    "质量杠杆：主角行动词命中数不得少于 rawStage2 基线（3 个）；感知词命中数不得多于 rawStage2 基线（2 个）";

  const profile = auditPrompt("你是顶尖网文作者。", sceneContractPrompt);

  // 核心断言：行动保真约束不应被判为 control
  assert.equal(profile.type, "editorial",
    `scene_contract 行动保真约束应为 editorial，实际 control（dialogue=${profile.containsDialogueRatio}, paragraph=${profile.containsParagraphLengthConstraint}, checklist=${profile.containsControlChecklist}, mechanical=${profile.containsMechanicalMetric}）`);
  assert.equal(profile.containsMechanicalMetric, false, "行动保真约束不应命中 mechanical metric");
  assert.equal(profile.containsControlChecklist, false, "行动保真约束不应命中 control checklist");
  assert.equal(profile.containsDialogueRatio, false);
  assert.equal(profile.containsParagraphLengthConstraint, false);
});

test("Phase D 续: auditPrompt 返回值包含 4 项完整诊断字段", () => {
  // editorial prompt — 4 项全 false
  const editorial = auditPrompt("你是顶尖网文作者。", "请写出第 17 章。");
  assert.equal(editorial.containsControlChecklist, false);
  assert.equal(editorial.containsMechanicalMetric, false);

  // control: 机械指标 — containsMechanicalMetric=true
  const mechanical = auditPrompt("", "对白比例必须 34%。");
  assert.equal(mechanical.type, "control");
  assert.equal(mechanical.containsMechanicalMetric, true);
  assert.equal(mechanical.containsDialogueRatio, true);

  // control: 清单 — containsControlChecklist=true
  const checklist = auditPrompt("", "必须按清单逐条写。");
  assert.equal(checklist.type, "control");
  assert.equal(checklist.containsControlChecklist, true);
});

test("P4: control 型 prompt 不发送模型（auditFailures 记录）", async () => {
  const { ctxResult, plan } = setupCh17();
  const gen = new CandidateGenerator();
  // 用一个会注入控制指令的 modelGenerate wrapper 来验证：
  // 实际上 CandidateGenerator 内部构建的 prompt 不会含控制指令，
  // 这里通过 auditPrompt 单元测试已覆盖。本测试验证 auditFailures 机制本身：
  // 当 modelGenerate 抛错时，应记入 auditFailures 而非崩溃。
  const failingGen = async () => { throw new Error("simulated model failure"); };
  const result = await gen.generate({
    context: ctxResult.context,
    contracts: plan.contracts,
    contextHash: ctxResult.contextHash,
    chapterNumber: 17,
    modelGenerate: failingGen,
    kinds: ["direct_baseline"],
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.auditFailures.length, 1);
  assert.ok(result.auditFailures[0].reason.includes("模型调用失败"));
});

test("P4: model_variant 支持多路由（gpt/claude/doubao）", async () => {
  const { ctxResult, plan } = setupCh17();
  const gen = new CandidateGenerator();
  const result = await gen.generate({
    context: ctxResult.context,
    contracts: plan.contracts,
    contextHash: ctxResult.contextHash,
    chapterNumber: 17,
    modelGenerate: createStubModelGenerateFn(),
    kinds: ["model_variant"],
    modelVariantRoutes: [V2_ROUTES.DIRECT_GPT, V2_ROUTES.DIRECT_CLAUDE, V2_ROUTES.DIRECT_DOUBAO],
  });
  assert.equal(result.candidates.length, 3, "应生成 3 个 model_variant 候选");
  const routes = result.candidates.map((c) => c.route);
  assert.ok(routes.includes(V2_ROUTES.DIRECT_GPT));
  assert.ok(routes.includes(V2_ROUTES.DIRECT_CLAUDE));
  assert.ok(routes.includes(V2_ROUTES.DIRECT_DOUBAO));
});

test("P4: scene_contract 候选的 promptProfile.contractIds 引用契约 id", async () => {
  const { ctxResult, plan } = setupCh17();
  const gen = new CandidateGenerator();
  const result = await gen.generate({
    context: ctxResult.context,
    contracts: plan.contracts,
    contextHash: ctxResult.contextHash,
    chapterNumber: 17,
    modelGenerate: createStubModelGenerateFn(),
    kinds: ["scene_contract"],
  });
  const candidate = result.candidates[0];
  // contractIds 应非空（ch17 有契约）
  if (plan.contracts.length > 0) {
    assert.ok(
      candidate.promptProfile.contractIds.length >= 1,
      "scene_contract 候选应引用契约 id"
    );
  }
});

test("P4: 同 contextHash 多次生成产生不同 candidate id（时间戳隔离）", async () => {
  const { ctxResult, plan } = setupCh17();
  const gen = new CandidateGenerator();
  const r1 = await gen.generate({
    context: ctxResult.context,
    contracts: plan.contracts,
    contextHash: ctxResult.contextHash,
    chapterNumber: 17,
    modelGenerate: createStubModelGenerateFn(),
    kinds: ["direct_baseline"],
  });
  // 确保时间戳不同
  await new Promise((r) => setTimeout(r, 5));
  const r2 = await gen.generate({
    context: ctxResult.context,
    contracts: plan.contracts,
    contextHash: ctxResult.contextHash,
    chapterNumber: 17,
    modelGenerate: createStubModelGenerateFn(),
    kinds: ["direct_baseline"],
  });
  assert.notEqual(r1.candidates[0].id, r2.candidates[0].id, "candidate id 应不同");
  assert.equal(r1.candidates[0].contextHash, r2.candidates[0].contextHash, "contextHash 应相同");
});

test("P4: stub ModelGenerateFn 返回可区分的正文（按 kind+route）", async () => {
  const { ctxResult, plan } = setupCh17();
  const gen = new CandidateGenerator();
  const result = await gen.generate({
    context: ctxResult.context,
    contracts: plan.contracts,
    contextHash: ctxResult.contextHash,
    chapterNumber: 17,
    modelGenerate: createStubModelGenerateFn(),
    kinds: ["direct_baseline", "scene_contract"],
  });
  const texts = result.candidates.map((c) => c.text);
  // 两个候选正文应可区分（kind 不同）
  assert.notEqual(texts[0], texts[1]);
});

// ============================================================================
// Phase D 续（Change 1 + 3B）: 空文本防护 + 契约有界重生成
// ============================================================================

test("Phase D Change 1: 空文本重试成功 — 前 2 次空,第 3 次非空,应生成候选", async () => {
  const { ctxResult, plan } = setupCh17();
  const gen = new CandidateGenerator();
  let callCount = 0;
  const emptyThenOk = async (input) => {
    callCount++;
    if (callCount <= 2) {
      return { text: "", model: "stub", route: input.route, durationMs: 1 };
    }
    return {
      text: "主角推开石门,冲进暗室,抓住绳索,转身撤退。风险递增,动作连续。",
      model: "stub",
      route: input.route,
      durationMs: 2,
    };
  };
  const result = await gen.generate({
    context: ctxResult.context,
    contracts: plan.contracts,
    contextHash: ctxResult.contextHash,
    chapterNumber: 17,
    modelGenerate: emptyThenOk,
    kinds: ["direct_baseline"],
  });
  assert.equal(result.candidates.length, 1, "第 3 次非空应生成候选");
  assert.ok(result.candidates[0].text.length > 0);
  assert.equal(callCount, 3, "应调用 3 次(2 次空 + 1 次成功)");
});

test("Phase D Change 1: 空文本重试耗尽 — 全部空,应记 auditFailure 且无候选", async () => {
  const { ctxResult, plan } = setupCh17();
  const gen = new CandidateGenerator();
  let callCount = 0;
  const alwaysEmpty = async (input) => {
    callCount++;
    return { text: "", model: "stub", route: input.route, durationMs: 1 };
  };
  const result = await gen.generate({
    context: ctxResult.context,
    contracts: plan.contracts,
    contextHash: ctxResult.contextHash,
    chapterNumber: 17,
    modelGenerate: alwaysEmpty,
    kinds: ["direct_baseline"],
  });
  assert.equal(result.candidates.length, 0, "全空不应生成候选");
  assert.ok(result.auditFailures.length >= 1, "应记 auditFailure");
  assert.ok(
    result.auditFailures.some((f) => f.reason.includes("空文本重试耗尽")),
    `应含"空文本重试耗尽":${JSON.stringify(result.auditFailures)}`,
  );
  // MAX_EMPTY_RETRIES=2 → 3 次总尝试
  assert.equal(callCount, 3, "应调用 3 次(耗尽 2 次重试)");
});

test("P44: scene_contract 不再触发 checkAgencyDilution 重写循环 — 单次生成即交付", async () => {
  const { ctxResult, plan } = setupCh17();
  const gen = new CandidateGenerator();
  let sceneContractCallCount = 0;
  const modelGen = async (input) => {
    if (input.kind === "scene_contract") {
      sceneContractCallCount++;
      // 模拟一稿（即便丢行动词+加感知词，P44 后也不应触发 sharper prompt 重写）
      return {
        text: "主角感到石门沉重,似乎有暗流,他意识到危险,觉得应该撤退。无行动词版本。",
        model: "stub",
        route: input.route,
        durationMs: 1,
      };
    }
    return {
      text: `【stub】kind=${input.kind} 正文。`,
      model: "stub",
      route: input.route,
      durationMs: 1,
    };
  };
  const result = await gen.generate({
    context: ctxResult.context,
    contracts: plan.contracts,
    contextHash: ctxResult.contextHash,
    chapterNumber: 17,
    modelGenerate: modelGen,
    kinds: ["scene_contract"],
  });
  const sceneCandidate = result.candidates.find((c) => c.kind === "scene_contract");
  assert.ok(sceneCandidate, "应生成 scene_contract 候选");
  // P44: 不再有 sharper prompt 重写循环，单次调用即交付
  assert.equal(
    sceneContractCallCount,
    1,
    `应只调用 1 次（无重写循环），实际 ${sceneContractCallCount}`,
  );
  // P44: contractRegenerations 字段已从 result 删除
  assert.equal(
    result.contractRegenerations,
    undefined,
    "contractRegenerations 应已删除（undefined）",
  );
  // 一稿即交付，即便含感知词也不被 sharper prompt 重写
  assert.ok(
    sceneCandidate.text.includes("感到"),
    "应保留一稿原文（即便含感知词，不再被 sharper prompt 重写）",
  );
});

test("P44: scene_contract 不接受 rawStage2Text — 传与不传行为一致", async () => {
  const { ctxResult, plan } = setupCh17();
  const gen = new CandidateGenerator();
  const modelGen = async (input) => ({
    text: `【stub】kind=${input.kind} 正文。主角推开石门,冲进暗室。`,
    model: "stub",
    route: input.route,
    durationMs: 1,
  });
  const resultWithout = await gen.generate({
    context: ctxResult.context,
    contracts: plan.contracts,
    contextHash: ctxResult.contextHash,
    chapterNumber: 17,
    modelGenerate: modelGen,
    kinds: ["scene_contract"],
  });
  const resultWith = await gen.generate({
    context: ctxResult.context,
    contracts: plan.contracts,
    contextHash: ctxResult.contextHash,
    chapterNumber: 17,
    modelGenerate: modelGen,
    kinds: ["scene_contract"],
    rawStage2Text: "主角推开石门,冲进暗室,抓住绳索。", // 运行时多余字段，应被忽略
  });
  assert.equal(
    resultWithout.candidates.length,
    resultWith.candidates.length,
    "候选数应一致（rawStage2Text 不再生效）",
  );
  assert.equal(
    resultWithout.contractRegenerations,
    undefined,
    "无 rawStage2Text 时 contractRegenerations 应 undefined",
  );
  assert.equal(
    resultWith.contractRegenerations,
    undefined,
    "传 rawStage2Text 时 contractRegenerations 也应 undefined（透传已切断）",
  );
});

// ============================================================================
// Layer 2 (Task I2): editorial_amplified 多变体候选生成
// ============================================================================

function makeEditorialPlan(strategies) {
  return {
    readerExperience: "紧张与释放",
    protagonistChoice: "主角深入险地承担代价",
    expectationAdvancement: "释放伏笔并埋下新问题",
    chapterEndPressure: "留下生死悬念",
    ensembleRoles: "配角甲负责情报，配角乙制造阻力",
    inviolableFacts: ["世界无魔法"],
    variantStrategies: strategies.map((s) => ({
      strategy: s,
      focus: `${s} 焦点`,
      angle: `${s} 角度`,
    })),
    _source: "llm",
  };
}

test("Layer 2: editorial_amplified 按 variantStrategies 展开多变体候选", async () => {
  const { ctxResult, plan } = setupCh17();
  const gen = new CandidateGenerator();
  const result = await gen.generate({
    context: ctxResult.context,
    contracts: plan.contracts,
    contextHash: ctxResult.contextHash,
    chapterNumber: 17,
    modelGenerate: createStubModelGenerateFn(),
    kinds: ["editorial_amplified"],
    editorialPlan: makeEditorialPlan([
      "payoff_first",
      "character_agency_first",
      "suspense_info_release",
    ]),
  });
  assert.equal(result.candidates.length, 3, "应按 3 个 variantStrategies 生成 3 个候选");
  for (const c of result.candidates) {
    assert.equal(c.kind, "editorial_amplified", "kind 应为 editorial_amplified");
  }
});

test("Layer 2: editorial_amplified 候选 id 含变体策略后缀", async () => {
  const { ctxResult, plan } = setupCh17();
  const gen = new CandidateGenerator();
  const result = await gen.generate({
    context: ctxResult.context,
    contracts: plan.contracts,
    contextHash: ctxResult.contextHash,
    chapterNumber: 17,
    modelGenerate: createStubModelGenerateFn(),
    kinds: ["editorial_amplified"],
    editorialPlan: makeEditorialPlan(["payoff_first", "ensemble_layered"]),
  });
  for (const c of result.candidates) {
    assert.match(
      c.id,
      /^candidate:editorial_amplified:v2_amplified:(payoff_first|ensemble_layered):\d+$/,
      `id 应含变体策略后缀，实际 ${c.id}`,
    );
  }
});

test("Layer 2: 缺失 editorialPlan 时跳过 editorial_amplified 并记 auditFailure", async () => {
  const { ctxResult, plan } = setupCh17();
  const gen = new CandidateGenerator();
  const result = await gen.generate({
    context: ctxResult.context,
    contracts: plan.contracts,
    contextHash: ctxResult.contextHash,
    chapterNumber: 17,
    modelGenerate: createStubModelGenerateFn(),
    kinds: ["editorial_amplified"],
    // 不传 editorialPlan
  });
  assert.equal(result.candidates.length, 0, "无 editorialPlan 不应生成 editorial_amplified 候选");
  assert.ok(
    result.auditFailures.some((f) => f.reason.includes("editorialPlan") && f.kind === "editorial_amplified"),
    `应记 editorialPlan 缺失 auditFailure：${JSON.stringify(result.auditFailures)}`,
  );
});

test("Layer 2: editorial_amplified route 解析为 v2_amplified 且 editorialStrategy 已设", async () => {
  const { ctxResult, plan } = setupCh17();
  const gen = new CandidateGenerator();
  const result = await gen.generate({
    context: ctxResult.context,
    contracts: plan.contracts,
    contextHash: ctxResult.contextHash,
    chapterNumber: 17,
    modelGenerate: createStubModelGenerateFn(),
    kinds: ["editorial_amplified"],
    editorialPlan: makeEditorialPlan(["payoff_first", "style_native"]),
  });
  for (const c of result.candidates) {
    assert.equal(c.route, "v2_amplified", `route 应为 v2_amplified，实际 ${c.route}`);
    assert.ok(c.editorialStrategy, `editorialStrategy 应已设，实际 ${c.editorialStrategy}`);
  }
  const strategies = result.candidates.map((c) => c.editorialStrategy).sort();
  assert.deepEqual(strategies, ["payoff_first", "style_native"], "应覆盖两个变体策略");
});
