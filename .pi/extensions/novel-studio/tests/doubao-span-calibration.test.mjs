/**
 * MODEL-ROUTING-CLAUDE46-1C RED 测试
 *
 * 派工卡: docs/model-routing-claude-opus-4-6-dispatch-card-20260717.md §5 (1C)
 *
 * 验证 Doubao span 驱动中文校准候选：
 * - voice_and_naturalness hypothesis 且有有效 raw span 时 → 候选走 v2_chinese_calibration (Doubao)
 * - 非 voice_and_naturalness hypothesis → 候选仍走 v2_amplified (Claude 4.6)
 * - 校准 prompt 必须是 span 级局部编辑，不得整章重写
 * - 无有效 span 的 voice_and_naturalness hypothesis 不得触发 Doubao 调用
 * - Doubao 输出修改 span 外文本时被拒绝（候选不进入 judge）
 *
 * RED 状态：当前所有候选统一走 v2_amplified，无 span 驱动路由与 span 边界检查，以下断言失败。
 * GREEN 状态：1C 实现完成后全部通过。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createEditorialCandidateGenerator } from "../dist/v2/core/editorial-candidate-generator.js";
import { createEditorialStrategyRegistry } from "../dist/v2/core/editorial-strategy-registry.js";

// ============================================================================
// 测试 fixture
// ============================================================================

const RAW_TEXT =
  "主角走进房间，感到一阵寒意。他意识到桌上有一封信。注意到信封没有署名，他犹豫了片刻。突然明白了什么，他拆开了信。";

/** 含感知侵蚀词的 span（"感到一阵寒意"） */
const PERCEPTION_SPAN_EXCERPT = "感到一阵寒意";
const PERCEPTION_SPAN_START = RAW_TEXT.indexOf(PERCEPTION_SPAN_EXCERPT);
const PERCEPTION_SPAN_END = PERCEPTION_SPAN_START + PERCEPTION_SPAN_EXCERPT.length;

/** 构造合法 ChapterIntent（必填数组字段） */
function makeIntent(overrides = {}) {
  return {
    chapterFunction: "character",
    readerExperience: [],
    currentPressure: [],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: [],
    inviolableFacts: [],
    sourceRefs: [],
    ...overrides,
  };
}

/** 构造合法 CompiledContext（必填数组字段） */
function makeContext(overrides = {}) {
  return {
    facts: [],
    characterStates: [],
    openLoops: [],
    worldRules: [],
    styleReferences: [],
    sourceMap: [],
    ...overrides,
  };
}

/** 构造 voice_and_naturalness hypothesis（带有效 span） */
function makeVoiceHypothesis(overrides = {}) {
  return {
    id: "h-voice-1",
    opportunityType: "voice_and_naturalness",
    diagnosis: "感知侵蚀词过多，用感知替代主角主动行动",
    evidenceSpans: [
      { start: PERCEPTION_SPAN_START, end: PERCEPTION_SPAN_END, excerpt: PERCEPTION_SPAN_EXCERPT },
    ],
    expectedReaderGain: "把感知替代词改写为具体动作与感官细节，回到母语自然",
    damageRisks: ["改写感知词可能削弱内省段落的情感重量"],
    rewriteScope: "span_candidate",
    confidence: 0.6,
    ...overrides,
  };
}

/** 构造 character_choice hypothesis（带有效 span，非 voice_and_naturalness） */
function makeCharacterChoiceHypothesis(overrides = {}) {
  const excerpt = "他犹豫了片刻";
  const start = RAW_TEXT.indexOf(excerpt);
  const end = start + excerpt.length;
  return {
    id: "h-char-1",
    opportunityType: "character_choice",
    diagnosis: "主角主动行动密度过低，存在用感知/反应替代选择的段落",
    evidenceSpans: [{ start, end, excerpt }],
    expectedReaderGain: "主角做出带不可逆后果的主动选择",
    damageRisks: ["强化行动可能偏离本章已确立的人物心智状态"],
    rewriteScope: "event_candidate",
    confidence: 0.6,
    ...overrides,
  };
}

/**
 * stub modelGenerate：记录每次调用的 route，按 route 返回不同模型/provider。
 * 返回的 text 可由调用方控制，用于测试 span 边界检查。
 */
function makeRecordingModelGenerate(opts = {}) {
  const calls = [];
  const fn = async (input) => {
    calls.push({ route: input.route, kind: input.kind, systemPrompt: input.systemPrompt, userPrompt: input.userPrompt });
    const isCalibration = input.route === "v2_chinese_calibration";
    const text = opts.text ?? (isCalibration
      ? RAW_TEXT.replace(PERCEPTION_SPAN_EXCERPT, "一阵寒意袭来")
      : RAW_TEXT + "\n（编辑后正文）");
    return {
      text,
      model: isCalibration ? "doubao-seed-2-1-pro-260628" : "claude-opus-4-6",
      route: input.route,
      provider: isCalibration ? "doubao" : "anthropic",
      durationMs: 10,
    };
  };
  fn.calls = calls;
  return fn;
}

// ============================================================================
// RED 测试
// ============================================================================

describe("MODEL-ROUTING-CLAUDE46-1C: Doubao span 驱动中文校准候选", () => {
  describe("voice_and_naturalness hypothesis 走 v2_chinese_calibration (Doubao)", () => {
    test("voice_and_naturalness + 有效 span → 候选 route 为 v2_chinese_calibration", async () => {
      const modelGenerate = makeRecordingModelGenerate();
      const gen = createEditorialCandidateGenerator();
      const result = await gen.generate({
        rawText: RAW_TEXT,
        rawCandidateId: "candidate:raw:1",
        hypotheses: [makeVoiceHypothesis()],
        intent: makeIntent(),
        context: makeContext(),
        contextHash: "hash-1",
        chapterNumber: 1,
        modelGenerate,
        strategyRegistry: createEditorialStrategyRegistry(),
      });

      assert.equal(result.candidates.length, 1, "应生成 1 个候选");
      const cand = result.candidates[0];
      assert.equal(
        cand.route,
        "v2_chinese_calibration",
        `voice_and_naturalness 候选 route 必须为 v2_chinese_calibration (Doubao)，实际为 ${cand.route}`,
      );
      // 验证确实调用了 Doubao 路由
      const calibrationCalls = modelGenerate.calls.filter((c) => c.route === "v2_chinese_calibration");
      assert.equal(calibrationCalls.length, 1, "应恰好 1 次 v2_chinese_calibration 调用");
    });

    test("voice_and_naturalness 候选 model 为 doubao（非 claude）", async () => {
      const modelGenerate = makeRecordingModelGenerate();
      const gen = createEditorialCandidateGenerator();
      const result = await gen.generate({
        rawText: RAW_TEXT,
        rawCandidateId: "candidate:raw:1",
        hypotheses: [makeVoiceHypothesis()],
        intent: makeIntent(),
        context: makeContext(),
        contextHash: "hash-1",
        chapterNumber: 1,
        modelGenerate,
        strategyRegistry: createEditorialStrategyRegistry(),
      });

      assert.equal(result.candidates.length, 1);
      assert.equal(
        result.candidates[0].model,
        "doubao-seed-2-1-pro-260628",
        `voice_and_naturalness 候选 model 必须为 doubao，实际为 ${result.candidates[0].model}`,
      );
    });
  });

  describe("非 voice_and_naturalness hypothesis 仍走 v2_amplified (Claude 4.6)", () => {
    test("character_choice + 有效 span → 候选 route 为 v2_amplified", async () => {
      const modelGenerate = makeRecordingModelGenerate();
      const gen = createEditorialCandidateGenerator();
      const result = await gen.generate({
        rawText: RAW_TEXT,
        rawCandidateId: "candidate:raw:1",
        hypotheses: [makeCharacterChoiceHypothesis()],
        intent: makeIntent(),
        context: makeContext(),
        contextHash: "hash-1",
        chapterNumber: 1,
        modelGenerate,
        strategyRegistry: createEditorialStrategyRegistry(),
      });

      assert.equal(result.candidates.length, 1);
      assert.equal(
        result.candidates[0].route,
        "v2_amplified",
        `character_choice 候选 route 必须为 v2_amplified (Claude)，实际为 ${result.candidates[0].route}`,
      );
      // 不得触发 Doubao
      const calibrationCalls = modelGenerate.calls.filter((c) => c.route === "v2_chinese_calibration");
      assert.equal(calibrationCalls.length, 0, "character_choice 不得触发 v2_chinese_calibration");
    });
  });

  describe("校准 prompt 必须是 span 级局部编辑", () => {
    test("voice_and_naturalness prompt 包含 span 局部编辑约束（非整章重写）", async () => {
      const modelGenerate = makeRecordingModelGenerate();
      const gen = createEditorialCandidateGenerator();
      await gen.generate({
        rawText: RAW_TEXT,
        rawCandidateId: "candidate:raw:1",
        hypotheses: [makeVoiceHypothesis()],
        intent: makeIntent(),
        context: makeContext(),
        contextHash: "hash-1",
        chapterNumber: 1,
        modelGenerate,
        strategyRegistry: createEditorialStrategyRegistry(),
      });

      const calibrationCall = modelGenerate.calls.find((c) => c.route === "v2_chinese_calibration");
      assert.ok(calibrationCall, "应存在 v2_chinese_calibration 调用");
      const prompt = calibrationCall.userPrompt;
      // span 级约束：prompt 必须包含"只修改"/"仅修改"/"span"/"局部"等 span 约束措辞
      const hasSpanConstraint = /只修改|仅修改|局部修改|不得整章|span\s*级|证据\s*span/i.test(prompt);
      assert.ok(
        hasSpanConstraint,
        "voice_and_naturalness 校准 prompt 必须包含 span 级局部编辑约束（不得整章重写）",
      );
      // prompt 必须引用具体 span excerpt
      assert.ok(
        prompt.includes(PERCEPTION_SPAN_EXCERPT),
        `校准 prompt 必须引用证据 span excerpt "${PERCEPTION_SPAN_EXCERPT}"`,
      );
    });
  });

  describe("无有效 span 的 voice_and_naturalness 不得触发 Doubao", () => {
    test("voice_and_naturalness hypothesis 的 evidenceSpans 为空 → 不生成候选（无 Doubao 调用）", async () => {
      const modelGenerate = makeRecordingModelGenerate();
      const gen = createEditorialCandidateGenerator();
      const result = await gen.generate({
        rawText: RAW_TEXT,
        rawCandidateId: "candidate:raw:1",
        hypotheses: [
          makeVoiceHypothesis({
            evidenceSpans: [], // 无 span
          }),
        ],
        intent: makeIntent(),
        context: makeContext(),
        contextHash: "hash-1",
        chapterNumber: 1,
        modelGenerate,
        strategyRegistry: createEditorialStrategyRegistry(),
      });

      // 无 span 的 hypothesis 不得生成任何候选（含 Doubao）
      assert.equal(result.candidates.length, 0, "无 span 的 hypothesis 不得生成候选");
      const calibrationCalls = modelGenerate.calls.filter((c) => c.route === "v2_chinese_calibration");
      assert.equal(calibrationCalls.length, 0, "无 span 时不得触发 Doubao 调用");
    });
  });

  describe("Doubao 输出 span 边界检查", () => {
    test("Doubao 输出修改 span 外文本 → 候选被拒绝（不进入 judge）", async () => {
      // Doubao 返回的文本在 span 外做了额外修改（改了"他犹豫了片刻"→"他果断拆信"）
      const outOfBoundsText = RAW_TEXT.replace(PERCEPTION_SPAN_EXCERPT, "一阵寒意袭来").replace(
        "他犹豫了片刻",
        "他果断拆信",
      );
      const modelGenerate = makeRecordingModelGenerate({ text: outOfBoundsText });
      const gen = createEditorialCandidateGenerator();
      const result = await gen.generate({
        rawText: RAW_TEXT,
        rawCandidateId: "candidate:raw:1",
        hypotheses: [makeVoiceHypothesis()],
        intent: makeIntent(),
        context: makeContext(),
        contextHash: "hash-1",
        chapterNumber: 1,
        modelGenerate,
        strategyRegistry: createEditorialStrategyRegistry(),
      });

      // span 外修改 → 候选被拒绝
      assert.equal(
        result.candidates.length,
        0,
        "Doubao 输出修改 span 外文本时候选必须被拒绝，不进入 judge",
      );
      assert.ok(
        result.failures.length > 0,
        "应有 failure 记录说明 span 边界违规",
      );
      const failure = result.failures[0];
      assert.match(
        failure.reason,
        /span|边界|out.of.bounds|越界|span\s*外/i,
        `failure reason 应说明 span 边界违规，实际：${failure.reason}`,
      );
    });

    test("Doubao 输出仅在 span 邻接上下文修改 → 候选通过", async () => {
      // Doubao 只修改 span 本身（"感到一阵寒意"→"一阵寒意袭来"），span 外不变
      const inBoundsText = RAW_TEXT.replace(PERCEPTION_SPAN_EXCERPT, "一阵寒意袭来");
      const modelGenerate = makeRecordingModelGenerate({ text: inBoundsText });
      const gen = createEditorialCandidateGenerator();
      const result = await gen.generate({
        rawText: RAW_TEXT,
        rawCandidateId: "candidate:raw:1",
        hypotheses: [makeVoiceHypothesis()],
        intent: makeIntent(),
        context: makeContext(),
        contextHash: "hash-1",
        chapterNumber: 1,
        modelGenerate,
        strategyRegistry: createEditorialStrategyRegistry(),
      });

      assert.equal(
        result.candidates.length,
        1,
        "Doubao 输出仅在 span 内修改时候选应通过 span 边界检查",
      );
    });
  });

  // ==========================================================================
  // MODEL-ROUTING-CLAUDE46-1C 派工卡 §5 item 4：校准候选流水线
  //   candidate completeness → evaluateChineseNativeRewriteAllowance → 语言风险 before/after
  // 以下测试验证流水线后两道（completeness + 语言风险 before/after），
  // span 边界检查由前一组测试覆盖。
  // ==========================================================================
  describe("校准候选流水线：completeness + 语言风险 before/after", () => {
    test("Doubao 输出被截断（缺句末标点 + 残片）→ 候选被 completeness 拒绝", async () => {
      // 在 span 内引入显式截断标记：把"感到一阵寒意"替换为"[内容截断]"
      // 两者均为 6 字符，差异区间恰好等于 span [7,13]，落在 allowStart=-8/allowEnd=28 内
      // span 边界检查通过；completeness 检查拒绝（[内容截断] 是 hard blocked 标记）
      const truncatedText = RAW_TEXT.replace(PERCEPTION_SPAN_EXCERPT, "[内容截断]");
      const modelGenerate = makeRecordingModelGenerate({ text: truncatedText });
      const gen = createEditorialCandidateGenerator();
      const result = await gen.generate({
        rawText: RAW_TEXT,
        rawCandidateId: "candidate:raw:1",
        hypotheses: [makeVoiceHypothesis()],
        intent: makeIntent(),
        context: makeContext(),
        contextHash: "hash-1",
        chapterNumber: 1,
        modelGenerate,
        strategyRegistry: createEditorialStrategyRegistry(),
      });

      assert.equal(
        result.candidates.length,
        0,
        "Doubao 输出含截断标记时候选必须被 completeness 拒绝",
      );
      assert.ok(result.failures.length > 0, "应有 failure 记录");
      assert.match(
        result.failures[0].reason,
        /completeness|截断|truncation/i,
        `failure reason 应说明 completeness 拒绝，实际：${result.failures[0].reason}`,
      );
    });

    test("Doubao 输出 finishReason=length → 候选被 completeness 拒绝", async () => {
      // 即使文本看起来完整，finishReason=length 也表示可能被 max_tokens 截断
      const inBoundsText = RAW_TEXT.replace(PERCEPTION_SPAN_EXCERPT, "一阵寒意袭来");
      const modelGenerate = async (input) => {
        return {
          text: inBoundsText,
          model: "doubao-seed-2-1-pro-260628",
          route: input.route,
          provider: "doubao",
          durationMs: 10,
          finishReason: "length",
        };
      };
      const gen = createEditorialCandidateGenerator();
      const result = await gen.generate({
        rawText: RAW_TEXT,
        rawCandidateId: "candidate:raw:1",
        hypotheses: [makeVoiceHypothesis()],
        intent: makeIntent(),
        context: makeContext(),
        contextHash: "hash-1",
        chapterNumber: 1,
        modelGenerate,
        strategyRegistry: createEditorialStrategyRegistry(),
      });

      assert.equal(
        result.candidates.length,
        0,
        "Doubao finishReason=length 时候选必须被 completeness 拒绝（截断风险）",
      );
      assert.match(
        result.failures[0].reason,
        /completeness|length|max_tokens|截断/i,
        `failure reason 应说明 length 截断，实际：${result.failures[0].reason}`,
      );
    });

    test("Doubao 校准后翻译腔/感知侵蚀命中数增加 → 候选被语言风险 before/after 拒绝", async () => {
      // 构造一个"看似在 span 内修改，但实际引入了更多感知侵蚀词"的输出。
      // 原 raw 的 span 是"感到一阵寒意"。Doubao 把它改成"感到一阵寒意，意识到危险"——
      // span 边界内的修改，但引入了新的"意识到"感知侵蚀词，使感知侵蚀命中数从 N 增至 N+1。
      // 注：构造时需保证差异区间落在 span 允许区域内（避免先被 span 边界拒绝）。
      const hypothesis = makeVoiceHypothesis();
      // span: "感到一阵寒意" 位于 PERCEPTION_SPAN_START..PERCEPTION_SPAN_END
      // 在原 span 位置替换为含更多感知侵蚀词的文本（仍位于 span 允许区域内）
      const worseCalibration = RAW_TEXT.replace(
        PERCEPTION_SPAN_EXCERPT,
        "感到一阵寒意，意识到危险",
      );
      const modelGenerate = makeRecordingModelGenerate({ text: worseCalibration });
      const gen = createEditorialCandidateGenerator();
      const result = await gen.generate({
        rawText: RAW_TEXT,
        rawCandidateId: "candidate:raw:1",
        hypotheses: [hypothesis],
        intent: makeIntent(),
        context: makeContext(),
        contextHash: "hash-1",
        chapterNumber: 1,
        modelGenerate,
        strategyRegistry: createEditorialStrategyRegistry(),
      });

      assert.equal(
        result.candidates.length,
        0,
        "Doubao 校准后感知侵蚀命中数增加时候选必须被语言风险 before/after 拒绝",
      );
      assert.ok(result.failures.length > 0, "应有 failure 记录");
      assert.match(
        result.failures[0].reason,
        /中文母语语感|语言风险|退化|命中数增加|countIncreased|riskWorsened/i,
        `failure reason 应说明语言风险退化，实际：${result.failures[0].reason}`,
      );
    });

    test("Doubao 校准减少感知侵蚀命中数 → 候选通过流水线（语言风险不退化）", async () => {
      // Doubao 把"感到一阵寒意"改成"一阵寒意袭来"——感知侵蚀词减少 1，命中数下降。
      // 这是校准的正向结果，应通过 evaluateChineseNativeRewriteAllowance。
      const improvedText = RAW_TEXT.replace(PERCEPTION_SPAN_EXCERPT, "一阵寒意袭来");
      const modelGenerate = makeRecordingModelGenerate({ text: improvedText });
      const gen = createEditorialCandidateGenerator();
      const result = await gen.generate({
        rawText: RAW_TEXT,
        rawCandidateId: "candidate:raw:1",
        hypotheses: [makeVoiceHypothesis()],
        intent: makeIntent(),
        context: makeContext(),
        contextHash: "hash-1",
        chapterNumber: 1,
        modelGenerate,
        strategyRegistry: createEditorialStrategyRegistry(),
      });

      assert.equal(
        result.candidates.length,
        1,
        "Doubao 校准减少感知侵蚀命中数时候选应通过流水线（语言风险不退化）",
      );
    });
  });
});
