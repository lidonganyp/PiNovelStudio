/**
 * GENRE-CONTRACT-1：类型读者承诺编译与只读履约证据最小闭环测试
 *
 * 验收口径（GENRE-CONTRACT-1 任务书）：
 * 1. 声明类型与漂移类型可追溯（sourceRef 指向 config / type-router advisory）。
 * 2. 本章只激活相关承诺（constitution.genrePromises 默认激活；type-dataset 按本章功能命中激活）。
 * 3. 未满足只产生 advisory/hypothesis，不构成 hard block。
 * 4. 世界硬事实仍由 P0 管理（本编译器不接管 immutable_fact）。
 * 5. 生产源码不得恢复 checkTypeContract 文学 hard block；类型缺失不应伪造具体承诺。
 * 6. 类型识别失败回退 config 声明或空 advisory，不阻断统一主链路。
 * 7. prompt compact block 不含 aggregateQualityScore / totalScore / 固定冲突数等机械指标。
 *
 * 边界：
 * - 不修改 finalText
 * - 不生成 candidate
 * - 不提交长期状态
 * - 不是 hard gate，不阻断正文
 * - 不调用 LLM
 * - 不调用 createTypeContractEngine / generateTypeConstraintCard / checkTypeContract（dormant guard）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileGenreContract,
  formatGenreContractPromptBlock,
  skippedGenreContract,
} from "../dist/v2/core/genre-contract-compiler.js";
import { createUnifiedOrchestrator } from "../dist/v2/core/unified-orchestrator.js";

// ============================================================================
// 辅助：构造 worldRules / constitution / intent
// ============================================================================

function makeWorldRules(genre = "玄幻", subGenres = []) {
  return [
    {
      id: "world:genre",
      description: `${genre}${subGenres.length ? " / " + subGenres.join("/") : ""}`,
      type: "genre",
      affectedCharacters: [],
      sourceIds: ["config.json"],
    },
    {
      id: "world:power_system",
      description: "灵气修炼体系",
      type: "power_system",
      affectedCharacters: [],
      sourceIds: ["config.json"],
    },
  ];
}

function makeConstitution(genrePromises = []) {
  return {
    workIdentity: "test-work",
    readerPromise: ["紧张感"],
    genrePromises,
    protagonistCoreConflict: "主角揭开暗流真相",
    thematicQuestions: ["真相是否值得付出代价？"],
    aestheticDirection: [],
    forbiddenDrift: [],
    sourceIds: ["creative-constitution"],
  };
}

function makeIntent(overrides = {}) {
  return {
    chapterFunction: "推进核心冲突",
    readerExperience: ["紧张"],
    currentPressure: ["水下救援压力"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["林川"],
    inviolableFacts: ["水下暗流不可消除"],
    sourceRefs: ["chapter-seed"],
    concreteDelivery: ["推进本章功能：推进核心冲突"],
    focusCharacterGoals: [],
    resistance: [],
    choicesAndCosts: [],
    expectedIrreversibleChange: [],
    selectedPromisesToAdvance: [],
    selectedExpectationsToAdvance: [],
    causalEndPressure: [],
    factAndCharacterKnowledgeForbiddenZones: [],
    fieldSourceRefs: {},
    ...overrides,
  };
}

// ============================================================================
// 测试 1：声明类型从 worldRules 派生，可追溯
// ============================================================================

test("GENRE-CONTRACT-1: 声明类型从 worldRules 派生，带 sourceRef 指向 config", () => {
  const result = compileGenreContract({
    worldRules: makeWorldRules("玄幻", ["修仙"]),
    constitution: makeConstitution(["硬核修仙体系"]),
    intent: makeIntent(),
    driftGenre: null,
  });
  assert.equal(result.genreContractContext.declaredGenre, "玄幻 / 修仙");
  assert.ok(
    result.genreContractContext.declaredGenreSourceRef.includes("world:genre"),
    "declaredGenreSourceRef 必须引用 world:genre",
  );
  assert.equal(result.genreContractContext.driftGenre, null);
  assert.equal(result.genreContractContext.genreDriftDetected, false);
});

// ============================================================================
// 测试 2：drift genre 来自 type-router advisory，可追溯
// ============================================================================

test("GENRE-CONTRACT-1: driftGenre 来自 type-router advisory，带 sourceRef", () => {
  const result = compileGenreContract({
    worldRules: makeWorldRules("玄幻"),
    constitution: makeConstitution(),
    intent: makeIntent(),
    driftGenre: "悬疑",
    driftGenreSourceRef: "type-router:chapter-scan:ch17",
  });
  assert.equal(result.genreContractContext.driftGenre, "悬疑");
  assert.equal(
    result.genreContractContext.driftGenreSourceRef,
    "type-router:chapter-scan:ch17",
  );
  assert.equal(result.genreContractContext.genreDriftDetected, true);
});

// ============================================================================
// 测试 3：声明 vs 漂移类型一致 → genreDriftDetected=false
// ============================================================================

test("GENRE-CONTRACT-1: declared===drift 时 genreDriftDetected=false", () => {
  const result = compileGenreContract({
    worldRules: makeWorldRules("玄幻"),
    constitution: makeConstitution(),
    intent: makeIntent(),
    driftGenre: "玄幻",
    driftGenreSourceRef: "type-router:chapter-scan:ch17",
  });
  assert.equal(result.genreContractContext.genreDriftDetected, false);
});

// ============================================================================
// 测试 4：constitution.genrePromises 进入 entries，默认 chapterActivated=true
// ============================================================================

test("GENRE-CONTRACT-1: constitution.genrePromises 进入 entries，作品级默认激活", () => {
  const result = compileGenreContract({
    worldRules: makeWorldRules("玄幻"),
    constitution: makeConstitution(["硬核修仙体系", "世界观自洽"]),
    intent: makeIntent(),
    driftGenre: null,
  });
  const ctx = result.genreContractContext;
  // 只检查 constitution 来源的 entries（玄幻 type-dataset 也会进入 entries，但 source 不同）
  const constitutionEntries = ctx.entries.filter((e) => e.source === "constitution");
  const datasetEntries = ctx.entries.filter((e) => e.source === "type-dataset");
  assert.equal(constitutionEntries.length, 2, "应编译 2 条 constitution genrePromises");
  assert.ok(datasetEntries.length > 0, "声明类型的本地模板承诺应与作品级承诺共存");
  for (const entry of constitutionEntries) {
    assert.equal(entry.chapterActivated, true, "constitution promise 默认激活");
    assert.ok(entry.sourceRef.includes("constitution:genrePromises"));
  }
});

// ============================================================================
// 测试 5：type-dataset promise 命中本章功能 → chapterActivated=true
// ============================================================================

test("GENRE-CONTRACT-1: type-dataset promise 命中 chapterFunction 时激活", () => {
  const result = compileGenreContract({
    worldRules: makeWorldRules("悬疑"),
    constitution: makeConstitution(),
    intent: makeIntent({ chapterFunction: "推进核心谜题推理" }),
    driftGenre: null,
  });
  const ctx = result.genreContractContext;
  const typeEntries = ctx.entries.filter((e) => e.source === "type-dataset");
  assert.ok(typeEntries.length > 0, "悬疑类型应提供 type-dataset promises");
  const activated = typeEntries.filter((e) => e.chapterActivated);
  assert.ok(
    activated.length > 0,
    "chapterFunction 含'推理'应激活悬疑 type-dataset 中的推理相关 promise",
  );
  for (const entry of activated) {
    assert.ok(entry.relevanceReason.length > 0, "激活原因不得为空");
    assert.ok(entry.sourceRef.includes("type-dataset:悬疑"));
    assert.equal(
      entry.fulfillmentEvidence,
      "unverified",
      "intent 关键词只能激活承诺，不能冒充 finalText 履约证据",
    );
  }
});

// ============================================================================
// 测试 6：type-dataset promise 未命中 → 仍进入 entries 作为背景，chapterActivated=false
// ============================================================================

test("GENRE-CONTRACT-1: type-dataset promise 未命中本章功能 → 背景条目，chapterActivated=false", () => {
  const result = compileGenreContract({
    worldRules: makeWorldRules("悬疑"),
    constitution: makeConstitution(),
    intent: makeIntent({ chapterFunction: "推进人物关系" }),
    driftGenre: null,
  });
  const ctx = result.genreContractContext;
  const typeEntries = ctx.entries.filter((e) => e.source === "type-dataset");
  // 至少应有未激活的背景条目（"推进人物关系"与悬疑推理 promise 不直接命中）
  const background = typeEntries.filter((e) => !e.chapterActivated);
  assert.ok(
    background.length > 0 || typeEntries.length === 0,
    "未命中时要么有背景条目（chapterActivated=false），要么类型 dataset 为空",
  );
  assert.ok(result.promptBlock, "有声明类型时应生成 advisory prompt block");
  for (const entry of background) {
    assert.ok(
      !result.promptBlock.includes(entry.description),
      `未激活承诺不得进入 raw prompt：${entry.description}`,
    );
  }
});

test("GENRE-CONTRACT-1: constitution 承诺保留在 trace，但不在 genre block 与 WorldPresentation 重复", () => {
  const promise = "硬核修仙体系不得退化为无代价升级";
  const result = compileGenreContract({
    worldRules: makeWorldRules("玄幻"),
    constitution: makeConstitution([promise]),
    intent: makeIntent(),
    driftGenre: null,
  });
  assert.ok(result.genreContractContext.entries.some((entry) => entry.description === promise));
  assert.ok(result.promptBlock, "声明类型应保留 genre advisory block");
  assert.ok(!result.promptBlock.includes(promise), "constitution promise 的 prompt owner 是 WorldPresentation");
});

test("GENRE-CONTRACT-1 integration: raw prompt 消费 active 类型承诺并在失败 trace 中留证", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "genre-contract-integration-"));
  let capturedPrompt = "";
  const activeDescription = "核心谜题有铺垫，不凭空出现";
  const backgroundDescription = "结局能自圆其说，不烂尾";
  try {
    const result = await createUnifiedOrchestrator().orchestrate({
      workspaceId: "genre-contract-test",
      chapterId: "ch1",
      chapterNumber: 1,
      projectRoot,
      intent: makeIntent({ chapterFunction: "推进核心谜题与线索" }),
      context: {
        facts: [],
        characterStates: [],
        openLoops: [],
        worldRules: makeWorldRules("悬疑"),
        styleReferences: [],
        sourceMap: [],
        constitution: null,
        longTermState: null,
      },
      constitution: null,
      characterNames: [],
      modelGenerate: async (input) => {
        if (input.kind === "raw_chapter") capturedPrompt = input.userPrompt;
        throw new Error("intentional raw failure");
      },
    });
    assert.equal(result.status, "blocked");
    assert.ok(capturedPrompt.includes(activeDescription), "active 类型承诺应进入 raw prompt");
    assert.ok(!capturedPrompt.includes(backgroundDescription), "background 类型承诺不得进入 raw prompt");
    assert.ok(result.stageResults.genreContract, "raw failure 仍应保留 genreContract trace");
    assert.ok(result.stageResults.chapterIntent.consumedFields.includes("genreContract"));
    assert.equal(result.stageResults.genreContract.consumedByRawPrompt, true);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 测试 7：无 worldRules genre + 无 constitution + 无 type-dataset → emptyReason
// ============================================================================

test("GENRE-CONTRACT-1: 全部源缺失时写 emptyReason，不伪造承诺", () => {
  const result = compileGenreContract({
    worldRules: [], // 无 genre rule
    constitution: null,
    intent: makeIntent(),
    driftGenre: null,
  });
  const ctx = result.genreContractContext;
  assert.equal(ctx.declaredGenre, null);
  assert.equal(ctx.entries.length, 0, "不得伪造承诺");
  assert.ok(ctx.emptyReason.length > 0, "emptyReason 不得为空");
  assert.equal(ctx.consumedByRawPrompt, false);
  assert.equal(result.promptBlock, null);
});

// ============================================================================
// 测试 8：prompt block 格式正确，无机械指标
// ============================================================================

test("GENRE-CONTRACT-1: prompt block 含声明类型与激活承诺，无机械指标", () => {
  const result = compileGenreContract({
    worldRules: makeWorldRules("玄幻"),
    constitution: makeConstitution(["硬核修仙体系"]),
    intent: makeIntent({ chapterFunction: "推进升级与战斗" }),
    driftGenre: null,
  });
  const block = result.promptBlock;
  assert.ok(block, "非空承诺必须生成 prompt block");
  assert.ok(block.includes("玄幻"), "block 必须含声明类型");
  assert.ok(block.includes("升级体系稳定推进"), "block 必须含本章激活的类型模板承诺");
  assert.ok(!block.includes("硬核修仙体系"), "constitution genrePromise 由 WorldPresentation 独占 prompt 注入");
  // 禁止机械指标
  assert.ok(!block.includes("aggregateQualityScore"), "不得包含 aggregateQualityScore");
  assert.ok(!block.includes("totalScore"), "不得包含 totalScore");
  assert.ok(!/固定.*冲突/.test(block), "不得包含固定冲突数硬门");
  assert.ok(!/每\s*\d+\s*章/.test(block), "不得包含固定兑现章数硬门");
});

// ============================================================================
// 测试 9：类型识别失败（无 worldRules genre）但有 constitution → 回退 constitution，不阻断
// ============================================================================

test("GENRE-CONTRACT-1: 类型识别失败但 constitution 存在 → 回退 constitution advisory", () => {
  const result = compileGenreContract({
    worldRules: [], // 无 genre rule → 类型识别失败
    constitution: makeConstitution(["硬核修仙体系"]),
    intent: makeIntent(),
    driftGenre: null,
  });
  const ctx = result.genreContractContext;
  assert.equal(ctx.declaredGenre, null, "declaredGenre 仍为 null（不伪造）");
  assert.equal(ctx.entries.length, 1, "constitution promise 仍编译");
  assert.equal(ctx.entries[0].source, "constitution");
  assert.ok(ctx.emptyReason === undefined || ctx.emptyReason.includes("declaredGenre"), "有 constitution 时不写 emptyReason，或写明 declaredGenre 缺失但不阻断");
});

// ============================================================================
// 测试 10：drift genre 不命中本地 dataset → 仅记录 drift，不伪造 type-dataset promises
// ============================================================================

test("GENRE-CONTRACT-1: drift genre 不在本地 dataset 时仅记录 drift，不伪造", () => {
  const result = compileGenreContract({
    worldRules: makeWorldRules("玄幻"),
    constitution: makeConstitution(),
    intent: makeIntent(),
    driftGenre: "未知类型XYZ",
    driftGenreSourceRef: "type-router:advisory",
  });
  const ctx = result.genreContractContext;
  assert.equal(ctx.driftGenre, "未知类型XYZ");
  assert.equal(ctx.genreDriftDetected, true);
  // 不应伪造"未知类型XYZ"的 type-dataset promises
  const driftTypeEntries = ctx.entries.filter((e) =>
    e.sourceRef.includes("type-dataset:未知类型XYZ"),
  );
  assert.equal(driftTypeEntries.length, 0, "不得伪造未知类型的 type-dataset promises");
});

// ============================================================================
// 测试 11：skippedGenreContract 失败路径不静默
// ============================================================================

test("GENRE-CONTRACT-1: skippedGenreContract 写 reason 不静默", () => {
  const skipped = skippedGenreContract("hardBlock: contextSafety");
  assert.equal(skipped.entries.length, 0);
  assert.equal(skipped.consumedByRawPrompt, false);
  assert.ok(skipped.emptyReason.includes("skipped"));
  assert.ok(skipped.emptyReason.includes("contextSafety"));
});

// ============================================================================
// 测试 12：formatGenreContractPromptBlock 空状态返回 null
// ============================================================================

test("GENRE-CONTRACT-1: formatGenreContractPromptBlock 空状态返回 null", () => {
  const block = formatGenreContractPromptBlock({
    declaredGenre: null,
    declaredGenreSourceRef: "",
    driftGenre: null,
    driftGenreSourceRef: null,
    genreDriftDetected: false,
    entries: [],
    sourceRefs: [],
    consumedByRawPrompt: false,
    emptyReason: "无类型承诺数据",
  });
  assert.equal(block, null);
});

// ============================================================================
// 测试 13：type-dataset 不含翻译腔术语（成长弧光/角色弧光/OOC/openingHookTypes）
// ============================================================================

test("GENRE-CONTRACT-1: type-dataset 不得含翻译腔术语（成长弧光/角色弧光/OOC/openingHookTypes）", () => {
  // 扫描所有可能类型的 dataset promises，确保不含翻译腔术语
  const allGenres = ["玄幻", "都市", "修仙", "科幻", "悬疑", "言情", "历史", "奇幻", "都市异能", "穿越", "系统", "同人"];
  for (const genre of allGenres) {
    const result = compileGenreContract({
      worldRules: [{ id: "world:genre", description: genre, type: "genre", affectedCharacters: [], sourceIds: ["config.json"] }],
      constitution: null,
      intent: makeIntent({ chapterFunction: "推进剧情人物战斗升级推理感情" }),
      driftGenre: null,
    });
    const ctx = result.genreContractContext;
    for (const entry of ctx.entries) {
      assert.ok(
        !entry.description.includes("成长弧光") &&
        !entry.description.includes("角色弧光") &&
        !entry.description.includes("OOC") &&
        !entry.description.includes("openingHookTypes"),
        `类型 ${genre} 的 promise 含翻译腔术语：${entry.description}`,
      );
    }
  }
});

// ============================================================================
// 测试 14：drift genre 命中本地 dataset → 编译 drift type-dataset promises
// ============================================================================

test("GENRE-CONTRACT-1: drift genre 命中本地 dataset 时编译 drift type promises", () => {
  const result = compileGenreContract({
    worldRules: makeWorldRules("都市"),  // declared=都市
    constitution: makeConstitution(),
    intent: makeIntent({ chapterFunction: "推进推理与线索" }),
    driftGenre: "悬疑",  // drift=悬疑，命中 dataset
    driftGenreSourceRef: "type-router:advisory",
  });
  const ctx = result.genreContractContext;
  assert.equal(ctx.driftGenre, "悬疑");
  assert.equal(ctx.genreDriftDetected, true);
  // 应同时编译 declared(都市) 和 drift(悬疑) 的 type-dataset promises
  const driftTypeEntries = ctx.entries.filter((e) =>
    e.sourceRef.includes("type-dataset:悬疑"),
  );
  assert.ok(driftTypeEntries.length > 0, "drift genre 命中 dataset 时应编译其 type promises");
});

// ============================================================================
// 测试 15：dormant guard — 编译器不得调用 createTypeContractEngine / checkTypeContract
// ============================================================================

test("GENRE-CONTRACT-1: genre-contract-compiler 不得 import 或调用 dormant engine 函数", async () => {
  // 读取编译产物源码（dist/v2/core/genre-contract-compiler.js），确认不含 dormant 引用
  const fs = await import("node:fs");
  const path = await import("node:path");
  const filePath = path.resolve("dist/v2/core/genre-contract-compiler.js");
  const code = fs.readFileSync(filePath, "utf-8");
  assert.ok(
    !code.includes("createTypeContractEngine") &&
    !code.includes("generateTypeConstraintCard") &&
    !code.includes("checkTypeContract"),
    "genre-contract-compiler 不得引用 dormant type-contract-engine 的函数",
  );
});
