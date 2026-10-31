/**
 * EXTERNAL-KB-1 — 外挂蒸馏知识库（实验通道）。
 *
 * 验证六件事：
 * 1. 默认关闭：未设置 PINOVEL_EXTERNAL_KB=1 时不读文件、不产生任何条目；
 * 2. 切片是判断文本：可加载、无原文摘录、渲染后 ≤520 字；
 * 3. 检索确定性：硬过滤（scene_type / avoid_when）→ 内容相关性准入 → 加权 → 阈值 → Top-3，丢弃有记录；
 * 4. R08：内容相关性是入选前提，情绪/阶段加权不得单独穿透；缺 sceneType 不虚构场景匹配；
 * 5. R02：原文范文通道只在隔离评测显式 allowExcerpts=true 时启用，生产仅设环境变量不会收到范文；
 * 6. 接入零劣化：开关打开只新增 P4 参考槽条目，P0/P1/P2/P3 与 token 预算逐项不变。
 *
 * R06：全部使用临时目录里的自包含 fixture，不读取被 .gitignore 忽略的 data/external-distilled/。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXTERNAL_KB_ENV_FLAG,
  EXTERNAL_KB_RELATIVE_PATH,
  EXTERNAL_KB_TOP_K,
  EXTERNAL_KB_PRODUCTION_TOP_K,
  EXTERNAL_KB_MIN_STRUCTURED_HITS,
  EXTERNAL_SLICE_MAX_CHARS,
  EXTERNAL_KB_EMOTION_BOOST,
  EXTERNAL_KB_PHASE_BOOST,
  EXTERNAL_EXCERPTS_ENV_FLAG,
  isExternalKnowledgeEnabled,
  loadExternalDistilledSlices,
  buildExternalKnowledgeQuery,
  deriveChapterPhase,
  deriveStructuredRetrievalKey,
  retrieveExternalDistilledSlices,
  buildExternalKnowledgeSelection,
  renderSliceAdvisory,
} from "../dist/v2/core/external-knowledge-base.js";
import {
  createConstraintManifest,
  compileContextSafety,
} from "../dist/v2/core/context-safety.js";
import {
  buildExtraReferenceItems,
  compileProductionContextPackage,
  renderContextPackage,
  collectConfirmedCoverageFromPackage,
} from "../dist-test/v2/core/context-package-production.js";

// ============================================================================
// 自包含 fixture（R06：不依赖本机真实语料）
// ============================================================================

const FIXTURE_SLICES = [
  {
    id: "slice-rule-probe",
    scene_type: "rule_dungeon",
    chapter_phase: "opening",
    emotion_target: ["好奇", "不安"],
    narrative_function: "规则显形",
    scene_function: "boundary_test",
    beat: "test",
    pressure_type: "environmental_rule",
    decision_tradeoff: "short_term_safety_for_information",
    cost_type: ["rule_trigger_risk"],
    state_delta: ["knowledge_up", "risk_up"],
    rule: "首次进入规则场景先做低成本试探，再让代价显形",
    anti_pattern: "直接口述全部规则",
    applicable_when: ["首次进入副本", "规则未明示"],
    confidence: "high",
  },
  {
    id: "slice-consequence",
    scene_type: "rule_dungeon",
    chapter_phase: "opening",
    emotion_target: ["不安"],
    narrative_function: "后果显形",
    scene_function: "world_reveal",
    beat: "setup",
    pressure_type: "environmental_rule",
    decision_tradeoff: null,
    cost_type: [],
    state_delta: ["knowledge_up"],
    rule: "让世界规则通过后果显形，而不是靠人物口述说明",
    applicable_when: ["规则未明示"],
  },
  {
    id: "slice-combat",
    scene_type: "combat",
    chapter_phase: "climax",
    emotion_target: ["紧张"],
    narrative_function: "交锋",
    scene_function: "combat_approach",
    beat: "escalation",
    pressure_type: "hostile_presence",
    decision_tradeoff: "cost_for_power",
    cost_type: ["physical_injury"],
    state_delta: ["risk_up"],
    rule: "刀剑交锋要写出重心变化与招式代价",
    avoid_when: ["纯日常过渡"],
  },
  {
    id: "slice-daily",
    scene_type: "daily",
    chapter_phase: "any",
    narrative_function: "过渡",
    scene_function: "relationship_shift",
    beat: "setup",
    pressure_type: "general_pressure",
    decision_tradeoff: null,
    cost_type: [],
    state_delta: [],
    rule: "日常过渡只保留一个未解决的小钩子",
    avoid_when: ["战斗、交锋、追杀、规则"],
  },
  {
    id: "slice-cost",
    scene_type: "rule_dungeon",
    chapter_phase: "any",
    narrative_function: "代价递增",
    scene_function: "cost_payment",
    beat: "escalation",
    pressure_type: "resource_scarcity",
    decision_tradeoff: "cost_for_power",
    cost_type: ["resource_loss"],
    state_delta: ["resource_down"],
    rule: "能力使用必须付出递增代价",
    avoid_when: ["纯日常过渡"],
  },
];

/**
 * 真实章节查询形态：由 ChapterIntent 派生，专名与散文字段占主导，
 * 与通用判断切片的字面余弦实测 0.03–0.07（低于 EXTERNAL_KB_CONTENT_MIN_SCORE=0.08）。
 */
const REAL_SHAPE_QUERY =
  "沈游与设计局林觉真相与解放工业化接口前六次样本与苏念调查同盟齐墨与碎片市场反向路线";

const FIXTURE_EXCERPTS_GOOD = [
  { id: "g1", text: "范文甲：雨线落在铁皮屋檐上，像有人在数细碎的账。" },
  { id: "g2", text: "范文乙：他把最后半块饼掰成三份，动作慢得像在称量自己的命。" },
  { id: "g3", text: "范文丙：巷子口的灯亮了两下，第三下没有亮。" },
  { id: "g4", text: "范文丁：她没有回头，只把伞往我这边偏了半寸。" },
];

const FIXTURE_EXCERPTS_BAD = [
  { id: "b1", text: "劣质范文甲：他非常非常震惊，感觉不可思议，情绪非常复杂。" },
  { id: "b2", text: "劣质范文乙：这一切都太突然了，让他不由得陷入了沉思。" },
  { id: "b3", text: "劣质范文丙：空气仿佛凝固了，时间仿佛静止了。" },
];

/** 每个测试用独立临时仓库根，避免共享状态与个人语料。 */
function makeFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "pns-external-kb-"));
  const dir = join(root, "data", "external-distilled");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "slices.json"), JSON.stringify(FIXTURE_SLICES, null, 2), "utf8");
  writeFileSync(
    join(dir, "excerpts-good.json"),
    JSON.stringify(FIXTURE_EXCERPTS_GOOD, null, 2),
    "utf8",
  );
  writeFileSync(
    join(dir, "excerpts-bad.json"),
    JSON.stringify(FIXTURE_EXCERPTS_BAD, null, 2),
    "utf8",
  );
  return root;
}

function withFixture(fn) {
  const root = makeFixtureRoot();
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function loadFixtureSlices(root) {
  const loaded = loadExternalDistilledSlices(root);
  assert.equal(loaded.ok, true, "自包含 fixture 必须可加载");
  return loaded;
}

/** 丢弃记录必须能解释池子里每一条：delivered + 各丢弃通道 = poolSize。 */
function accountedReport(report) {
  return report.deliveredIds.length
    + report.droppedIds.length
    + report.droppedByHardFilterIds.length
    + report.droppedByRelevanceIds.length
    + report.droppedByStructuredAdmissionIds.length;
}

function minimalIntent(overrides = {}) {
  return {
    chapterFunction: "首次进入副本，规则未明示，主角需要试探规则边界",
    overallPlotDirection: ["调查规则"],
    previousState: ["主角刚进入副本"],
    characterMotivations: [{ character: "林觉", motivation: "活下来" }],
    focusCharacterGoals: [{ character: "林觉", goal: "验证规则" }],
    foreshadowing: [],
    causalRelations: ["试探导致规则显形"],
    endingTarget: ["确认一条新规则"],
    authorEventSummaries: [],
    authorMustInclude: ["主角做一次低成本试探"],
    authorStateChanges: [],
    readerExperience: ["不安", "好奇"],
    currentPressure: ["时间紧迫", "规则不清"],
    inviolableFacts: ["林觉没有超能力"],
    concreteDelivery: [],
    resistance: ["规则会杀人"],
    choicesAndCosts: [{ choice: "强行试探", cost: "触发死亡条件" }],
    expectedIrreversibleChange: [],
    causalEndPressure: [],
    factAndCharacterKnowledgeForbiddenZones: [],
    relevantCharacters: ["林觉"],
    selectedPromisesToAdvance: [],
    selectedExpectationsToAdvance: [],
    sourceRefs: ["intent:test"],
    ...overrides,
  };
}

function minimalContext() {
  return {
    facts: [{ id: "fact-1", content: "林觉是普通人", sourceIds: ["ch1#fact-1"], kind: "fact" }],
    characterStates: [
      { characterId: "linjue", name: "林觉", state: { location: "副本入口" }, sourceIds: ["ch1#linjue"] },
    ],
    openLoops: [
      { id: "loop-1", description: "规则未验证", openedAt: "ch1", urgency: 2, sourceIds: ["ch1#loop-1"] },
    ],
    worldRules: [
      {
        id: "rule-imm",
        description: "副本内违反规则即死",
        type: "immutable_fact",
        affectedCharacters: ["林觉"],
        sourceIds: ["canon#rule-imm"],
      },
    ],
    styleReferences: [
      { id: "style-1", kind: "fingerprint", content: "克制压抑，短句为主", sourceIds: ["style:hist"] },
    ],
    constitution: {
      workIdentity: "测试作品",
      readerPromise: [],
      genrePromises: [],
      protagonistCoreConflict: "规则与人",
      thematicQuestions: [],
      aestheticDirection: [],
      forbiddenDrift: ["修仙化"],
      sourceIds: ["constitution"],
    },
    longTermState: { canon: [], character: [], promise: [], pattern: [], sourceIds: [] },
    bridgeContext: {
      available: true,
      lastEventSummary: "林觉站在副本入口",
      endingEmotion: "紧绷",
      openHooks: ["规则屏还没亮"],
      unresolvedTensions: ["同批人里有内鬼"],
      introducedCharacters: ["苏念"],
      sourceIds: ["ch1#bridge"],
    },
  };
}

function compileSafety(intent, context, extraItems = []) {
  return compileContextSafety({
    manifest: createConstraintManifest({ intent, context }),
    intent,
    context,
    modelWindowTokens: 128000,
    outputReserveTokens: 8192,
    safetyMarginTokens: 4096,
    extraItems,
  });
}

function slotItemIds(pkg, slot) {
  return (pkg.slots[slot]?.items ?? []).map((item) => item.id);
}

// ============================================================================
// 开关与加载
// ============================================================================

test("默认关闭：未设置 PINOVEL_EXTERNAL_KB=1 时返回 null，不读文件", () => {
  assert.equal(isExternalKnowledgeEnabled({}), false);
  assert.equal(isExternalKnowledgeEnabled({ [EXTERNAL_KB_ENV_FLAG]: "0" }), false);
  assert.equal(isExternalKnowledgeEnabled({ [EXTERNAL_KB_ENV_FLAG]: "1" }), true);
  withFixture((root) => {
    const selection = buildExternalKnowledgeSelection({
      projectRoot: root,
      query: "首次进入副本 规则未明示 试探",
      env: {},
    });
    assert.equal(selection, null);
  });
});

test("开关打开但切片缺失：降级为空的选集并记录原因（不阻断生成）", () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), "pns-external-kb-empty-"));
  try {
    const selection = buildExternalKnowledgeSelection({
      projectRoot: emptyRoot,
      query: "首次进入副本 规则未明示 试探",
      env: { [EXTERNAL_KB_ENV_FLAG]: "1" },
    });
    assert.ok(selection);
    assert.equal(selection.items.length, 0);
    assert.equal(selection.report.enabled, true);
    assert.ok(selection.report.degradedReason);
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test("切片加载：只含判断文本，渲染后不超 520 字、无原文摘录字段", () => {
  withFixture((root) => {
    const loaded = loadFixtureSlices(root);
    assert.ok(loaded.slices.length >= 5);
    assert.ok(loaded.path.endsWith(EXTERNAL_KB_RELATIVE_PATH.replace(/\//g, sep)));
    for (const slice of loaded.slices) {
      assert.equal(typeof slice.rule, "string");
      assert.ok(slice.rule.length > 0);
      assert.equal("excerpt" in slice, false);
      assert.ok(renderSliceAdvisory(slice).length <= EXTERNAL_SLICE_MAX_CHARS);
    }
  });
});

// ============================================================================
// 检索：确定性、硬过滤、阈值与丢弃记录
// ============================================================================

test("检索确定性：硬过滤 → 相关性 → 阈值 → Top-3，同输入两次结果一致", () => {
  withFixture((root) => {
    const { slices } = loadFixtureSlices(root);
    const query = "首次进入副本，规则未明示，主角需要先做一次低成本试探验证规则边界";
    const first = retrieveExternalDistilledSlices({ slices, query });
    const second = retrieveExternalDistilledSlices({ slices, query });

    assert.deepEqual(first.report.deliveredIds, second.report.deliveredIds);
    assert.ok(first.items.length > 0);
    assert.ok(first.items.length <= EXTERNAL_KB_TOP_K);
    assert.ok(first.report.deliveredIds.includes("slice-rule-probe"));
    for (const item of first.items) {
      assert.ok(item.sourceRef.startsWith(`${EXTERNAL_KB_RELATIVE_PATH}#`));
      assert.ok(item.content.length <= EXTERNAL_SLICE_MAX_CHARS);
    }
    const scores = first.items.map((item) => item.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
    assert.equal(accountedReport(first.report), first.report.poolSize, "所有丢弃都必须有记录");
  });
});

test("硬过滤：scene_type 不匹配与 avoid_when 命中都排除", () => {
  withFixture((root) => {
    const { slices } = loadFixtureSlices(root);
    const byType = retrieveExternalDistilledSlices({
      slices,
      query: "首次进入副本 规则未明示 试探",
      sceneType: "combat",
    });
    assert.deepEqual(byType.report.droppedByHardFilterIds.sort(), [
      "slice-consequence",
      "slice-cost",
      "slice-daily",
      "slice-rule-probe",
    ]);
    // sceneType=combat 只有 slice-combat 具备场景兼容资格；字面无关时分数为 0，仍被阈值拦下。
    assert.equal(byType.items.length, 0);

    const byAvoid = retrieveExternalDistilledSlices({
      slices,
      query: "本章是纯日常过渡，主角只想休息",
    });
    assert.ok(byAvoid.report.droppedByHardFilterIds.includes("slice-combat"));
    assert.ok(byAvoid.report.droppedByHardFilterIds.includes("slice-cost"));
    assert.equal(accountedReport(byAvoid.report), byAvoid.report.poolSize);
  });
});

test("阈值：高于全部候选时不下发，但保留打分与丢弃记录", () => {
  withFixture((root) => {
    const { slices } = loadFixtureSlices(root);
    const result = retrieveExternalDistilledSlices({
      slices,
      query: "首次进入副本 规则未明示 试探",
      minScore: 0.999,
    });
    assert.equal(result.items.length, 0);
    assert.equal(result.report.scoredCount, result.report.afterHardFilter);
    assert.equal(
      result.report.droppedIds.length + result.report.droppedByHardFilterIds.length
      + result.report.droppedByRelevanceIds.length,
      result.report.poolSize,
    );
    assert.equal(accountedReport(result.report), result.report.poolSize);
  });
});

// ============================================================================
// R08：内容相关性是入选前提
// ============================================================================

test("R08 · 跨题材负例：情绪与阶段信号不能把零相关候选送进选集", () => {
  withFixture((root) => {
    const { slices } = loadFixtureSlices(root);
    // 与任何切片都无字符二元组重合：字面余弦恒为 0。
    const crossGenreQuery = "股市暴跌，债券收益率上升，投资者情绪低落";
    const negative = retrieveExternalDistilledSlices({
      slices,
      query: crossGenreQuery,
      emotionTargets: ["好奇", "紧张"],
      chapterPhase: "opening",
    });
    assert.equal(negative.items.length, 0, "零相关内容不得靠情绪/阶段加分入选");
    assert.equal(
      negative.report.droppedByRelevanceIds.length,
      negative.report.afterHardFilter,
      "零相关候选必须全部记录在 droppedByRelevanceIds",
    );
    assert.deepEqual(negative.report.droppedIds, []);
    assert.equal(accountedReport(negative.report), negative.report.poolSize);
  });
});

test("R08 · 缺 sceneType 不虚构场景匹配；显式 sceneType 兼容才允许加权召回", () => {
  withFixture((root) => {
    const { slices } = loadFixtureSlices(root);
    const crossGenreQuery = "股市暴跌，债券收益率上升，投资者情绪低落";

    const withoutScene = retrieveExternalDistilledSlices({
      slices,
      query: crossGenreQuery,
      emotionTargets: ["紧张"],
      chapterPhase: "climax",
    });
    assert.equal(withoutScene.items.length, 0);
    assert.equal(withoutScene.report.sceneType, null);

    const withScene = retrieveExternalDistilledSlices({
      slices,
      query: crossGenreQuery,
      sceneType: "combat",
      emotionTargets: ["紧张"],
      chapterPhase: "climax",
    });
    assert.deepEqual(withScene.items.map((item) => item.id), ["slice-combat"]);
    assert.equal(withScene.report.sceneType, "combat");
    assert.equal(withScene.items[0].literalScore, 0);
    assert.equal(
      withScene.items[0].boostScore,
      EXTERNAL_KB_EMOTION_BOOST + EXTERNAL_KB_PHASE_BOOST,
    );
    assert.equal(accountedReport(withScene.report), withScene.report.poolSize);
  });
});

test("R08 · 同义相关例稳定召回，且只在已相关候选之间排序", () => {
  withFixture((root) => {
    const { slices } = loadFixtureSlices(root);
    const relevantQuery = "刀剑交锋 招式代价 重心变化";
    const relevant = retrieveExternalDistilledSlices({ slices, query: relevantQuery });
    assert.equal(relevant.items[0].id, "slice-combat", "最相关的候选应稳定排在第一");
    assert.ok(relevant.items.length <= EXTERNAL_KB_TOP_K);
    for (const item of relevant.items) {
      assert.ok(item.literalScore > 0, "入选项必须与查询有字面相关性，不能只靠加权");
    }
    assert.ok(relevant.report.droppedByRelevanceIds.length > 0, "无关候选应被相关性前提挡下");
    assert.equal(accountedReport(relevant.report), relevant.report.poolSize);
  });
});

test("查询派生：只取方向性字段，不注入角色名", () => {
  const query = buildExternalKnowledgeQuery(minimalIntent());
  assert.ok(query.includes("首次进入副本"));
  assert.ok(query.includes("时间紧迫"));
  assert.equal(query.includes("林觉"), false);
});

test("阶段派生：收束/高潮关键词优先，首章为 opening", () => {
  assert.equal(deriveChapterPhase({ chapterNumber: 1, chapterFunction: "进入副本" }), "opening");
  assert.equal(deriveChapterPhase({ chapterNumber: 5, chapterFunction: "调查线索" }), "middle");
  assert.equal(deriveChapterPhase({ chapterNumber: 3, chapterFunction: "本章收束旧线索" }), "ending");
  assert.equal(deriveChapterPhase({ chapterNumber: 3, chapterFunction: "决战爆发" }), "climax");
});

test("结构化加权：合并情绪串先拆分，阶段只对精确匹配生效", () => {
  withFixture((root) => {
    const { slices } = loadFixtureSlices(root);
    const merged = retrieveExternalDistilledSlices({
      slices,
      query: "试探规则边界 代价显形",
      emotionTargets: ["目标情绪：好奇、紧张"],
      chapterPhase: "opening",
    });
    assert.deepEqual(merged.report.emotionTargets, ["好奇", "紧张"]);
    // slice-daily 的 chapter_phase=any 不享受阶段加分。
    const daily = retrieveExternalDistilledSlices({
      slices,
      query: "日常过渡小钩子",
      chapterPhase: "opening",
    });
    for (const item of daily.items) {
      if (item.id !== "slice-daily") continue;
      assert.equal(item.boostScore, 0);
    }
  });
});

// ============================================================================
// EXTERNAL-KB-3：结构化准入（结构化为主，字面只做 tie-break，空结果优先）
// ============================================================================

test("KB-3 · 结构化 key 由 ChapterIntent 派生，不拼接专名", () => {
  const key = deriveStructuredRetrievalKey(minimalIntent());
  assert.equal(key.sceneFunction, "boundary_test");
  assert.equal(key.beat, "test");
  assert.equal(key.pressureType, "environmental_rule");
  assert.equal(key.decisionTradeoff, "safety_for_advantage");
  assert.deepEqual(key.costType, ["rule_trigger_risk"]);
  assert.deepEqual(key.readerEffect, ["不安", "好奇"]);
  assert.equal(JSON.stringify(key).includes("林觉"), false, "检索键不得包含人物专名");
});

test("KB-3 · sceneFunction 第二层派生：本章功能无关键词时退化到作者事件摘要/必须包含", () => {
  const key = deriveStructuredRetrievalKey({
    chapterFunction: "推进主线日常",
    authorEventSummaries: ["现场留下一具没有流血的尸体，断口平整得像铣刀切过"],
    authorMustInclude: [],
    readerExperience: [],
  });
  assert.equal(key.sceneFunction, "horror_anomaly");
});

test("KB-3 · sceneFunction 优先本章功能，不被兜底层覆盖", () => {
  const key = deriveStructuredRetrievalKey({
    chapterFunction: "首次进入副本，主角试探规则边界",
    authorEventSummaries: ["现场留下一具没有流血的尸体"],
    readerExperience: [],
  });
  assert.equal(key.sceneFunction, "boundary_test");
});

test("KB-3 · sceneFunction 两层都无关键词时保持 null（空结果优先，不补默认值）", () => {
  const key = deriveStructuredRetrievalKey({
    chapterFunction: "推进主线日常",
    authorEventSummaries: ["他和父亲一起吃了顿饭"],
    readerExperience: [],
  });
  assert.equal(key.sceneFunction, null);
});

test("KB-3 · 结构化准入：≥N 维且命中主维度，生产默认只交付 1 条", () => {
  withFixture((root) => {
    const { slices } = loadFixtureSlices(root);
    const key = deriveStructuredRetrievalKey(minimalIntent());
    const result = retrieveExternalDistilledSlices({
      slices,
      query: REAL_SHAPE_QUERY,
      retrievalKey: key,
      topK: EXTERNAL_KB_PRODUCTION_TOP_K,
    });
    assert.equal(result.report.selectionMode, "structured");
    assert.equal(result.items.length, 1, "生产默认只选 1 条主 advisory");
    assert.equal(result.items[0].id, "slice-rule-probe");
    assert.ok(result.items[0].structuredHits >= EXTERNAL_KB_MIN_STRUCTURED_HITS);
    assert.deepEqual(
      [...result.items[0].matchedDimensions].sort(),
      ["beat", "costType", "pressureType", "readerEffect", "sceneFunction"],
    );
    // 未达准入的卡片必须记录在 droppedByStructuredAdmissionIds（不得静默丢弃）。
    assert.equal(
      result.report.droppedByStructuredAdmissionIds.length,
      result.report.afterHardFilter - 1,
    );
    assert.equal(accountedReport(result.report), result.report.poolSize);
  });
});

test("KB-3 · 无法派生结构化键时返回空，不用阶段兜底", () => {
  withFixture((root) => {
    const { slices } = loadFixtureSlices(root);
    const emptyKey = deriveStructuredRetrievalKey({
      chapterFunction: "股市暴跌，投资者情绪低落",
      currentPressure: ["债券收益率上升"],
      readerExperience: ["焦虑"],
    });
    assert.equal(emptyKey.sceneFunction, null);
    assert.equal(emptyKey.beat, null);
    const result = retrieveExternalDistilledSlices({
      slices,
      query: "股市暴跌 债券收益率上升",
      retrievalKey: emptyKey,
    });
    assert.equal(result.items.length, 0, "空 key 不得靠阶段/情绪兜底");
    assert.equal(result.report.selectionMode, "none");
    assert.equal(result.report.skippedReason, "structured_key_empty");
    assert.equal(
      result.report.droppedByStructuredAdmissionIds.length,
      result.report.afterHardFilter,
      "无法派生的候选也必须留痕",
    );
    assert.equal(accountedReport(result.report), result.report.poolSize);
  });
});

test("KB-3 · 只有 1 个独立维度命中 → 不入选", () => {
  withFixture((root) => {
    const { slices } = loadFixtureSlices(root);
    const oneDimensionKey = {
      sceneFunction: null,
      beat: null,
      pressureType: "environmental_rule",
      decisionTradeoff: null,
      costType: [],
      stateDelta: [],
      readerEffect: ["不安"],
    };
    const result = retrieveExternalDistilledSlices({
      slices,
      query: REAL_SHAPE_QUERY,
      retrievalKey: oneDimensionKey,
    });
    assert.equal(result.items.length, 0);
    assert.equal(result.report.selectionMode, "none");
    assert.equal(
      result.report.droppedByStructuredAdmissionIds.length,
      result.report.afterHardFilter,
    );
    for (const hits of Object.values(result.report.structuredHitsById)) {
      assert.ok(hits <= 1, "所有候选的独立维度命中数都应 ≤1");
    }
  });
});

test("KB-3 · 缺主维度（场景功能/节拍）时，压力+代价两项也不得入围", () => {
  withFixture((root) => {
    const { slices } = loadFixtureSlices(root);
    // pressure_type + cost_type 是同类题材的通用维度，只靠它们等于没有筛选。
    const genericKey = {
      sceneFunction: null,
      beat: null,
      pressureType: "environmental_rule",
      decisionTradeoff: null,
      costType: ["rule_trigger_risk"],
      stateDelta: [],
      readerEffect: [],
    };
    const result = retrieveExternalDistilledSlices({
      slices,
      query: REAL_SHAPE_QUERY,
      retrievalKey: genericKey,
    });
    assert.equal(result.items.length, 0);
    assert.equal(result.report.selectionMode, "none");
    assert.ok(result.report.structuredHitsById["slice-rule-probe"] >= 2, "确实达到 2 维");
    assert.ok(
      result.report.droppedByStructuredAdmissionIds.includes("slice-rule-probe"),
      "达到 2 维但缺主维度，仍必须被准入挡下",
    );
  });
});

test("KB-3 · 结构化主排序 + 字面 tie-break；margin 只记录不参与放行", () => {
  withFixture((root) => {
    const { slices } = loadFixtureSlices(root);
    const altSlice = {
      ...slices.find((entry) => entry.id === "slice-rule-probe"),
      id: "slice-rule-alt",
      decision_tradeoff: "safety_for_advantage",
      rule: "另一条同机制卡片：先试探边界，再把代价交给读者核对",
    };
    const key = deriveStructuredRetrievalKey(minimalIntent());
    const result = retrieveExternalDistilledSlices({
      slices: [...slices, altSlice],
      query: REAL_SHAPE_QUERY,
      retrievalKey: key,
      topK: 2,
    });
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].id, "slice-rule-alt", "多命中一个维度的候选排前");
    assert.ok(result.items.every((item) => item.structuredHits >= EXTERNAL_KB_MIN_STRUCTURED_HITS));
    assert.ok(result.report.marginGap !== null && result.report.marginGap > 0);
    assert.equal(accountedReport(result.report), result.report.poolSize);
  });
});

// ============================================================================
// P2：生产调用点必须走结构化 key、只交付 1 条、不注入原文
// ============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));

test("P2 · 生产守卫：unified-entry 派生结构化 key + topK=1，无阶段兜底", () => {
  const source = readFileSync(
    join(HERE, "..", "v2", "core", "unified-entry.ts"),
    "utf8",
  );
  assert.equal(
    /allowStructuralFallback|structuralFallback/.test(source),
    false,
    "生产 entry 不得保留结构化兜底（阶段匹配但零相关会违反 RAG 约束）",
  );
  assert.ok(
    /retrievalKey\s*:\s*deriveStructuredRetrievalKey\(intent\)/.test(source),
    "生产 entry 必须由 ChapterIntent 派生结构化检索键",
  );
  assert.ok(
    /topK\s*:\s*EXTERNAL_KB_PRODUCTION_TOP_K/.test(source),
    "生产 entry 必须显式只交付 1 条主 advisory",
  );
  assert.equal(
    /allowExcerpts\s*:\s*true/.test(source),
    false,
    "生产 entry 不得开启原文范文通道（含短 span）",
  );
});

test("P2 · 复现：跨题材 ChapterIntent 在生产参数下零注入且全部留痕", () => {
  withFixture((root) => {
    const crossGenreIntent = {
      chapterFunction: "股市暴跌，投资者情绪低落",
      currentPressure: ["债券收益率上升"],
      readerExperience: ["焦虑"],
      choicesAndCosts: [],
      expectedIrreversibleChange: [],
    };
    const selection = buildExternalKnowledgeSelection({
      projectRoot: root,
      query: buildExternalKnowledgeQuery(crossGenreIntent),
      retrievalKey: deriveStructuredRetrievalKey(crossGenreIntent),
      topK: EXTERNAL_KB_PRODUCTION_TOP_K,
      env: { [EXTERNAL_KB_ENV_FLAG]: "1" },
    });
    assert.ok(selection);
    assert.equal(selection.report.mode, "slices");
    assert.equal(selection.items.length, 0, "零相关候选不得进入生产上下文");
    assert.equal(selection.report.selectionMode, "none");
    assert.equal(
      selection.report.droppedByStructuredAdmissionIds.length,
      selection.report.afterHardFilter,
      "被准入挡下的候选必须全部留痕",
    );
    assert.equal(accountedReport(selection.report), selection.report.poolSize);
  });
});

// ============================================================================
// R02：原文范文通道只属隔离评测
// ============================================================================

test("R02 · 生产入口组合同一行为：仅设 excerpts 环境变量不会开启原文通道", () => {
  withFixture((root) => {
    // KB 关 + excerpts 设置 → 生产返回 null（忽略误配置，不读范文文件）。
    for (const quality of ["good", "bad"]) {
      const selection = buildExternalKnowledgeSelection({
        projectRoot: root,
        query: "首次进入副本",
        env: { [EXTERNAL_EXCERPTS_ENV_FLAG]: quality },
      });
      assert.equal(selection, null, `仅设置 excerpts=${quality} 不得在生产开启原文通道`);
    }

    // KB 开 + excerpts 设置 → 仍走切片通道，不产生 excerpts_* 条目。
    const production = buildExternalKnowledgeSelection({
      projectRoot: root,
      query: buildExternalKnowledgeQuery(minimalIntent()),
      env: {
        [EXTERNAL_KB_ENV_FLAG]: "1",
        [EXTERNAL_EXCERPTS_ENV_FLAG]: "good",
      },
    });
    assert.ok(production);
    assert.equal(production.report.mode, "slices");
    for (const item of production.items) {
      assert.equal(item.id.startsWith("excerpt-"), false);
      assert.equal(item.content.includes("范文甲"), false);
    }
    for (const item of production.items) {
      assert.ok(renderSliceAdvisory({ rule: item.content }).length <= EXTERNAL_SLICE_MAX_CHARS);
    }
  });
});

test("R02 · 隔离评测显式 allowExcerpts=true 才能加载固定 fixture", () => {
  withFixture((root) => {
    for (const [quality, expectedMode, expectedCount] of [
      ["good", "excerpts_good", FIXTURE_EXCERPTS_GOOD.length],
      ["bad", "excerpts_bad", FIXTURE_EXCERPTS_BAD.length],
    ]) {
      const selection = buildExternalKnowledgeSelection({
        projectRoot: root,
        query: "任意查询",
        env: { [EXTERNAL_EXCERPTS_ENV_FLAG]: quality },
        allowExcerpts: true,
      });
      assert.ok(selection, `${quality} 评测臂应返回选集`);
      assert.equal(selection.report.mode, expectedMode);
      assert.equal(selection.report.poolSize, expectedCount);
      assert.ok(selection.items.length > 0 && selection.items.length <= EXTERNAL_KB_TOP_K);
      for (const item of selection.items) {
        assert.ok(item.id.startsWith("excerpt-"));
        assert.ok(item.content.length <= EXTERNAL_SLICE_MAX_CHARS);
      }
      assert.equal(accountedReport(selection.report), selection.report.poolSize);
    }
  });
});

test("R02 · 生产入口不接受范文环境变量开关（eval-only 通道）", () => {
  const distEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "v2", "core", "unified-entry.js");
  const source = readFileSync(distEntry, "utf-8");
  assert.equal(
    source.includes("PINOVEL_EXPERIMENT_ALLOW_EXCERPTS"),
    false,
    "生产统一入口不得读取 PINOVEL_EXPERIMENT_ALLOW_EXCERPTS；范文只能由隔离评测显式传 allowExcerpts=true",
  );
  assert.equal(
    /allowExcerpts\s*:\s*true/.test(source),
    false,
    "生产统一入口不得把 allowExcerpts 置为 true",
  );
});

test("R02 · excerpts=off 与未设置都不得触发范文通道", () => {
  withFixture((root) => {
    for (const env of [{ [EXTERNAL_EXCERPTS_ENV_FLAG]: "off" }, {}]) {
      const selection = buildExternalKnowledgeSelection({
        projectRoot: root,
        query: "首次进入副本 规则未明示 试探",
        env,
      });
      assert.equal(selection, null);
    }
  });
});

// ============================================================================
// 接入零劣化
// ============================================================================

test("接入零劣化：开关打开只新增 P4 参考槽条目，权威槽与预算逐项不变", () => {
  withFixture((root) => {
    const intent = minimalIntent();
    const context = minimalContext();
    const safety = compileSafety(intent, context);
    assert.equal(safety.ok, true);

    const without = compileProductionContextPackage({ safety, snapshotId: "snap-1" });
    const selection = buildExternalKnowledgeSelection({
      projectRoot: root,
      query: buildExternalKnowledgeQuery(intent),
      env: { [EXTERNAL_KB_ENV_FLAG]: "1" },
    });
    assert.ok(selection);
    const withExternalExtraItems = buildExtraReferenceItems({
      snapshotId: "snap-1",
      externalKnowledgeSelection: selection,
    });
    // R03：外部知识作为附加项进入统一预算裁剪，不再于编译之后追加。
    const safetyWith = compileSafety(intent, context, withExternalExtraItems);
    assert.equal(safetyWith.ok, true);
    const withExternal = compileProductionContextPackage({
      safety: safetyWith,
      snapshotId: "snap-1",
    });
    assert.equal(without.ok, true);
    assert.equal(withExternal.ok, true);

    // P0/P1/P2/P3 完全一致（只允许 p4:external: 前缀新增）
    const slots = [
      "SYSTEM_AUTHORITY",
      "AUTHOR_CONTRACT",
      "IMMUTABLE_FACTS",
      "COMMITTED_STATE",
      "DIAGNOSTIC_EVIDENCE",
      "UNTRUSTED_DRAFT",
      "USER_FEEDBACK",
    ];
    for (const slot of slots) {
      assert.deepEqual(slotItemIds(withExternal.package, slot), slotItemIds(without.package, slot));
    }
    const referenceWith = slotItemIds(withExternal.package, "REFERENCE_MATERIAL");
    const referenceWithout = slotItemIds(without.package, "REFERENCE_MATERIAL");
    const additions = referenceWith.filter((id) => !referenceWithout.includes(id));
    assert.ok(additions.length <= EXTERNAL_KB_TOP_K);
    for (const id of additions) assert.ok(id.startsWith("p4:external:"));

    // 参考槽条目无指令权，不得升级为硬约束
    for (const item of withExternal.package.slots.REFERENCE_MATERIAL?.items ?? []) {
      if (!item.id.startsWith("p4:external:")) continue;
      assert.notEqual(item.authority, "hard_constraint");
      assert.ok(item.content.length <= EXTERNAL_SLICE_MAX_CHARS);
    }

    // 权威槽硬约束集合不变：外挂条目不得进入 confirmed coverage
    const coverageWithout = collectConfirmedCoverageFromPackage(without.package, "snap-1");
    const coverageWith = collectConfirmedCoverageFromPackage(withExternal.package, "snap-1");
    assert.deepEqual(
      coverageWith.map((fact) => fact.sourceRef),
      coverageWithout.map((fact) => fact.sourceRef),
    );
    assert.deepEqual(
      coverageWith.map((fact) => fact.statement),
      coverageWithout.map((fact) => fact.statement),
    );
    assert.ok(coverageWith.every((fact) => !fact.sourceRef.includes("external-distilled")));

    // 渲染文本：外挂判断确实进入模型输入，且位于「参考资料」段
    const renderedWith = renderContextPackage(withExternal.package);
    const renderedWithout = renderContextPackage(without.package);
    assert.ok(renderedWith.text.length > renderedWithout.text.length);
    assert.equal(renderedWithout.text.includes("反模式："), false);
    assert.ok(renderedWith.text.includes("【参考资料】"));
    for (const item of selection.items) {
      assert.ok(renderedWith.text.includes(item.content.slice(0, 20)));
    }
  });
});
