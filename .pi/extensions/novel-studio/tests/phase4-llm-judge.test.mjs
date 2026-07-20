/**
 * Phase 4 LLM Pairwise Judge 测试（计划 §Phase 4 + §5 + §10.1 确定性单元测试）
 *
 * 覆盖：
 * 1. JudgePromptBuilder：构建匿名 prompt、解析 verdict JSON、处理代码块/说明文字
 * 2. JudgeEvidenceValidator：span 强制、winner 一致性、负面判断证据完整性
 * 3. PairwiseLiteraryJudge：
 *    - 正常裁判（amplified clear 胜出）
 *    - LLM 调用失败 → 降级保留 raw
 *    - 空文本 → 降级
 *    - parse 失败 → 降级
 *    - 证据无效 → 保留 raw（触发反向复判）
 *    - tie → 保留 raw（触发反向复判）
 *    - 匿名映射可复现
 *    - mapping 覆盖（反向复判基础）
 * 4. JudgeArbitrator：
 *    - 首轮 clear 胜出 → 不反向复判，直接交付 amplified
 *    - 首轮降级 → 保留 raw，不反向复判
 *    - needsReverseReview + 两轮一致 amplified → 交付 amplified（可审计胜因）
 *    - needsReverseReview + 两轮冲突 + 无仲裁器 → 保留 raw
 *    - needsReverseReview + 两轮冲突 + 仲裁器一致 → 采纳
 *    - needsReverseReview + 两轮冲突 + 仲裁器 tie → 保留 raw
 *    - needsReverseReview + 两轮均 tie → 保留 raw
 *
 * 退出条件：无证据负评失效；顺序交换冲突时保留 raw；任何 amplified 交付都有可审计胜因。
 *
 * 测试策略：stub 模型解析 userPrompt 识别候选 A/B 文本，按内容标记决定 winner，
 * 保证测试对匿名标签随机化鲁棒。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildJudgePrompt,
  parseJudgeVerdict,
} from "../dist/v2/core/judge-prompt-builder.js";
import {
  validateJudgeEvidence,
  hasSufficientEvidenceForAmplified,
} from "../dist/v2/core/judge-evidence-validator.js";
import {
  buildAnonymousMapping,
  swapOrder,
  resolveVerdictToCandidates,
  decideSelection,
} from "../dist/v2/core/judge-types.js";
import {
  createPairwiseLiteraryJudge,
} from "../dist/v2/core/pairwise-literary-judge.js";
import {
  createJudgeArbitrator,
} from "../dist/v2/core/judge-arbitrator.js";

// ============================================================================
// 辅助：构造候选 / intent / constitution
// ============================================================================

function makeCandidate(id, text, kind = "editorial_amplified") {
  return {
    id,
    text,
    kind,
    model: "stub-model",
    route: kind === "raw" ? "v2_rawstage2" : "v2_amplified",
    contextHash: "hash-" + id,
    generatedAt: "2026-07-10T00:00:00Z",
    promptProfile: {
      type: "editorial",
      containsDialogueRatio: false,
      containsParagraphLengthConstraint: false,
    },
  };
}

function makeRawCandidate(id, text) {
  return makeCandidate(id, text, "context_enhanced");
}

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

const CONSTITUTION = null;

// 候选正文：raw 章末平淡无钩子，editorial 章末有钩子（含"？")
const RAW_TEXT = "林川推开门，走了进去。房间里很暗。他坐在床边，闭上眼睛，很快睡着了，这一天就这样平淡地过去了。";
const EDITORIAL_TEXT = "林川推开门，走了进去。房间里很暗。他突然发现桌上有一封信，信上没有署名。这到底是谁留下的？为什么没有署名？";

// ============================================================================
// 辅助：内容感知 stub 模型
// ============================================================================

/**
 * 解析 userPrompt 提取候选 A/B 文本。
 */
function extractCandidates(userPrompt) {
  const aMatch = userPrompt.match(/【候选 A】\n([\s\S]*?)\n（候选 A 总字符数/);
  const bMatch = userPrompt.match(/【候选 B】\n([\s\S]*?)\n（候选 B 总字符数/);
  return {
    textA: aMatch ? aMatch[1] : "",
    textB: bMatch ? bMatch[1] : "",
  };
}

/**
 * 构造一条 decisiveReason，betterCandidate 胜出，worse 一方带有效 span。
 */
function makeReason(betterLabel, worseText, dimension = "章末钩子") {
  const worseLabel = betterLabel === "A" ? "B" : "A";
  const span = {
    start: 0,
    end: Math.min(8, worseText.length),
    excerpt: worseText.slice(0, Math.min(8, worseText.length)),
  };
  const reason = {
    dimension,
    betterCandidate: betterLabel,
    evidenceA: worseLabel === "A" ? [span] : [],
    evidenceB: worseLabel === "B" ? [span] : [],
    explanation: `${betterLabel} 的${dimension}更强，${worseLabel} 结尾平淡`,
  };
  return reason;
}

/**
 * 内容感知 stub：按 betterMarker 标记决定哪个候选胜出。
 * - 只有 A 含标记 → winner=A
 * - 只有 B 含标记 → winner=B
 * - 都含/都不含 → tie
 * - confidence 由参数指定
 *
 * 返回 verdict JSON 字符串。
 */
function makeContentAwareStub(betterMarker, confidence = "clear") {
  return async (input) => {
    const { textA, textB } = extractCandidates(input.userPrompt);
    const aHas = textA.includes(betterMarker);
    const bHas = textB.includes(betterMarker);
    let winner;
    let reason;
    if (aHas && !bHas) {
      winner = "A";
      reason = makeReason("A", textB);
    } else if (bHas && !aHas) {
      winner = "B";
      reason = makeReason("B", textA);
    } else {
      winner = "tie";
      reason = {
        dimension: "整体",
        betterCandidate: "neither",
        evidenceA: [],
        evidenceB: [],
        explanation: "两者质量接近",
      };
    }
    const verdict = {
      winner,
      confidence: winner === "tie" ? "uncertain" : confidence,
      decisiveReasons: [reason],
      factualRisks: [],
      regressionRisks: [],
      constitutionAlignment: "两者均对齐",
    };
    return {
      text: JSON.stringify(verdict),
      model: "stub-judge",
      route: input.route,
      durationMs: 10,
    };
  };
}

/** stub：始终返回空文本 */
function makeEmptyStub() {
  return async (input) => ({
    text: "",
    model: "stub-judge",
    route: input.route,
    durationMs: 10,
  });
}

/** stub：抛异常 */
function makeThrowingStub(err) {
  return async () => {
    throw new Error(err);
  };
}

/** stub：返回非 JSON 文本 */
function makeGarbageStub() {
  return async (input) => ({
    text: "这不是 JSON，裁判无法解析",
    model: "stub-judge",
    route: input.route,
    durationMs: 10,
  });
}

/**
 * 队列 stub：按调用顺序返回队列中的 verdict JSON。
 * 用于 arbitrator 多轮测试（首轮/反向/仲裁返回不同结果）。
 */
function makeQueueStub(verdictJsons) {
  let idx = 0;
  return async (input) => {
    const json = verdictJsons[idx] ?? verdictJsons[verdictJsons.length - 1];
    idx++;
    return {
      text: json,
      model: "stub-judge",
      route: input.route,
      durationMs: 10,
    };
  };
}

/**
 * 构造 verdict JSON：指定 winner 标签、confidence、两候选文本。
 * worse 一方带有效 span。
 */
function makeVerdictJson(winnerLabel, confidence, textA, textB) {
  let reason;
  if (winnerLabel === "tie") {
    reason = {
      dimension: "整体",
      betterCandidate: "neither",
      evidenceA: [],
      evidenceB: [],
      explanation: "两者质量接近",
    };
  } else {
    const worseText = winnerLabel === "A" ? textB : textA;
    reason = makeReason(winnerLabel, worseText);
  }
  return JSON.stringify({
    winner: winnerLabel,
    confidence: winnerLabel === "tie" ? "uncertain" : confidence,
    decisiveReasons: [reason],
    factualRisks: [],
    regressionRisks: [],
    constitutionAlignment: "两者均对齐",
  });
}

// ============================================================================
// 1. JudgePromptBuilder
// ============================================================================

test("PromptBuilder: buildJudgePrompt 生成匿名 A/B prompt", () => {
  const mapping = buildAnonymousMapping("raw-1", "ed-1", 42);
  const { systemPrompt, userPrompt } = buildJudgePrompt({
    candidateAText: RAW_TEXT,
    candidateBText: EDITORIAL_TEXT,
    mapping,
    intent: makeIntent(),
    constitution: CONSTITUTION,
  });
  assert.ok(systemPrompt.includes("文学裁判"));
  assert.ok(userPrompt.includes("【候选 A】"));
  assert.ok(userPrompt.includes("【候选 B】"));
  assert.ok(userPrompt.includes(RAW_TEXT));
  assert.ok(userPrompt.includes(EDITORIAL_TEXT));
  // 不暴露 raw/amplified 身份
  assert.ok(!userPrompt.includes("raw"));
  assert.ok(!userPrompt.includes("amplified"));
});

test("PromptBuilder: parseJudgeVerdict 解析合法 JSON", () => {
  const json = JSON.stringify({
    winner: "A",
    confidence: "clear",
    decisiveReasons: [
      {
        dimension: "钩子",
        betterCandidate: "A",
        evidenceA: [],
        evidenceB: [{ start: 0, end: 5, excerpt: "平淡结尾" }],
        explanation: "A 钩子更强",
      },
    ],
    factualRisks: [],
    regressionRisks: [],
    constitutionAlignment: "对齐",
  });
  const v = parseJudgeVerdict(json);
  assert.ok(v);
  assert.equal(v.winner, "A");
  assert.equal(v.confidence, "clear");
  assert.equal(v.decisiveReasons.length, 1);
  assert.equal(v.decisiveReasons[0].betterCandidate, "A");
  assert.equal(v.decisiveReasons[0].evidenceB.length, 1);
});

test("PromptBuilder: parseJudgeVerdict 处理代码块包裹", () => {
  const json = "```json\n" + JSON.stringify({
    winner: "B",
    confidence: "slight",
    decisiveReasons: [],
    factualRisks: ["风险"],
    regressionRisks: [],
    constitutionAlignment: "",
  }) + "\n```";
  const v = parseJudgeVerdict(json);
  assert.ok(v);
  assert.equal(v.winner, "B");
  assert.equal(v.confidence, "slight");
  assert.deepEqual(v.factualRisks, ["风险"]);
});

test("PromptBuilder: parseJudgeVerdict 处理含说明文字的 JSON", () => {
  const json = "以下是裁判结果：\n" + JSON.stringify({
    winner: "tie",
    confidence: "uncertain",
    decisiveReasons: [],
    factualRisks: [],
    regressionRisks: [],
    constitutionAlignment: "",
  }) + "\n以上就是结果。";
  const v = parseJudgeVerdict(json);
  assert.ok(v);
  assert.equal(v.winner, "tie");
});

test("PromptBuilder: parseJudgeVerdict 非法输入返回 null", () => {
  assert.equal(parseJudgeVerdict(""), null);
  assert.equal(parseJudgeVerdict("   "), null);
  assert.equal(parseJudgeVerdict("不是 JSON"), null);
  assert.equal(parseJudgeVerdict(JSON.stringify({ winner: "X" })), null); // 非法 winner
  assert.equal(parseJudgeVerdict(JSON.stringify({ winner: "A" })), null); // 缺 confidence
});

// ============================================================================
// 2. JudgeEvidenceValidator
// ============================================================================

test("EvidenceValidator: 合法 verdict（worse 一方带 span）通过", () => {
  const verdict = {
    winner: "A",
    confidence: "clear",
    decisiveReasons: [
      {
        dimension: "钩子",
        betterCandidate: "A",
        evidenceA: [],
        evidenceB: [{ start: 0, end: 5, excerpt: "平淡结尾" }],
        explanation: "A 更强",
      },
    ],
    factualRisks: [],
    regressionRisks: [],
    constitutionAlignment: "",
  };
  const r = validateJudgeEvidence(verdict, RAW_TEXT, EDITORIAL_TEXT);
  assert.ok(r.ok, `应通过：${r.errors.join("; ")}`);
});

test("EvidenceValidator: worse 一方缺 span → 失败", () => {
  const verdict = {
    winner: "A",
    confidence: "clear",
    decisiveReasons: [
      {
        dimension: "钩子",
        betterCandidate: "A",
        evidenceA: [],
        evidenceB: [], // 缺 span
        explanation: "A 更强",
      },
    ],
    factualRisks: [],
    regressionRisks: [],
    constitutionAlignment: "",
  };
  const r = validateJudgeEvidence(verdict, RAW_TEXT, EDITORIAL_TEXT);
  assert.ok(!r.ok);
  assert.ok(r.missingSpanReasons.length > 0);
});

test("EvidenceValidator: winner 与 decisiveReasons 不一致 → 失败", () => {
  const verdict = {
    winner: "A",
    confidence: "clear",
    decisiveReasons: [
      {
        dimension: "钩子",
        betterCandidate: "B", // 与 winner=A 不一致
        evidenceA: [{ start: 0, end: 5, excerpt: "问题" }],
        evidenceB: [],
        explanation: "B 更强",
      },
    ],
    factualRisks: [],
    regressionRisks: [],
    constitutionAlignment: "",
  };
  const r = validateJudgeEvidence(verdict, RAW_TEXT, EDITORIAL_TEXT);
  assert.ok(!r.ok);
  assert.ok(r.inconsistentWinnerReasons.includes(0));
});

test("EvidenceValidator: span 越界 → 失败", () => {
  const verdict = {
    winner: "A",
    confidence: "clear",
    decisiveReasons: [
      {
        dimension: "钩子",
        betterCandidate: "A",
        evidenceA: [],
        evidenceB: [{ start: 0, end: 99999, excerpt: "越界" }],
        explanation: "A 更强",
      },
    ],
    factualRisks: [],
    regressionRisks: [],
    constitutionAlignment: "",
  };
  const r = validateJudgeEvidence(verdict, RAW_TEXT, EDITORIAL_TEXT);
  assert.ok(!r.ok);
});

test("EvidenceValidator: hasSufficientEvidenceForAmplified 门槛", () => {
  const goodVerdict = {
    winner: "A",
    confidence: "clear",
    decisiveReasons: [
      {
        dimension: "钩子",
        betterCandidate: "A",
        evidenceA: [],
        evidenceB: [{ start: 0, end: 5, excerpt: "问题" }],
        explanation: "A 更强",
      },
    ],
    factualRisks: [],
    regressionRisks: [],
    constitutionAlignment: "",
  };
  const goodValidation = validateJudgeEvidence(goodVerdict, RAW_TEXT, EDITORIAL_TEXT);
  assert.ok(hasSufficientEvidenceForAmplified(goodVerdict, goodValidation));

  // tie → 不足
  const tieVerdict = { ...goodVerdict, winner: "tie", confidence: "uncertain" };
  assert.ok(!hasSufficientEvidenceForAmplified(tieVerdict, goodValidation));

  // slight → 不足
  const slightVerdict = { ...goodVerdict, confidence: "slight" };
  assert.ok(!hasSufficientEvidenceForAmplified(slightVerdict, goodValidation));
});

// ============================================================================
// 3. PairwiseLiteraryJudge
// ============================================================================

test("PairwiseJudge: amplified clear 胜出 → 选择 amplified，无需反向复判", async () => {
  const judge = createPairwiseLiteraryJudge();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  // stub：含"？"(钩子标记)的候选胜出
  const stub = makeContentAwareStub("？", "clear");
  const result = await judge.judge({
    rawCandidate: raw,
    editorialCandidate: ed,
    intent: makeIntent(),
    constitution: CONSTITUTION,
    modelGenerate: stub,
    seed: 42,
  });
  assert.ok(!result.degraded, `不应降级：${result.degradeReason}`);
  assert.ok(result.verdict);
  assert.equal(result.verdict.confidence, "clear");
  // editorial 含"？",应胜出
  assert.equal(result.winnerCandidateId, "ed-1");
  // clear 胜出 + 证据有效 → 无需反向复判
  assert.ok(!result.selection.needsReverseReview);
  assert.equal(result.selection.selectedCandidateId, "ed-1");
});

test("PairwiseJudge: LLM 调用失败 → 降级保留 raw", async () => {
  const judge = createPairwiseLiteraryJudge();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  const result = await judge.judge({
    rawCandidate: raw,
    editorialCandidate: ed,
    intent: makeIntent(),
    constitution: CONSTITUTION,
    modelGenerate: makeThrowingStub("API 超时"),
    seed: 42,
  });
  assert.ok(result.degraded);
  assert.equal(result.verdict, null);
  assert.equal(result.selection.selectedCandidateId, "raw-1");
  assert.ok(!result.selection.needsReverseReview);
});

test("PairwiseJudge: 空文本 → 降级保留 raw", async () => {
  const judge = createPairwiseLiteraryJudge();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  const result = await judge.judge({
    rawCandidate: raw,
    editorialCandidate: ed,
    intent: makeIntent(),
    constitution: CONSTITUTION,
    modelGenerate: makeEmptyStub(),
    seed: 42,
  });
  assert.ok(result.degraded);
  assert.equal(result.selection.selectedCandidateId, "raw-1");
});

test("PairwiseJudge: 非 JSON 输出 → 降级保留 raw", async () => {
  const judge = createPairwiseLiteraryJudge();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  const result = await judge.judge({
    rawCandidate: raw,
    editorialCandidate: ed,
    intent: makeIntent(),
    constitution: CONSTITUTION,
    modelGenerate: makeGarbageStub(),
    seed: 42,
  });
  assert.ok(result.degraded);
  assert.equal(result.selection.selectedCandidateId, "raw-1");
});

test("PairwiseJudge: tie → 保留 raw，触发反向复判", async () => {
  const judge = createPairwiseLiteraryJudge();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  // 两个候选都含"门",marker 命中两者 → tie
  const stub = makeContentAwareStub("门", "clear");
  const result = await judge.judge({
    rawCandidate: raw,
    editorialCandidate: ed,
    intent: makeIntent(),
    constitution: CONSTITUTION,
    modelGenerate: stub,
    seed: 42,
  });
  assert.ok(!result.degraded);
  assert.equal(result.verdict.winner, "tie");
  assert.equal(result.winnerCandidateId, null);
  assert.equal(result.selection.selectedCandidateId, "raw-1");
  // tie + uncertain → 触发反向复判
  assert.ok(result.selection.needsReverseReview);
});

test("PairwiseJudge: slight 胜出 → 保留 raw，触发反向复判", async () => {
  const judge = createPairwiseLiteraryJudge();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  const stub = makeContentAwareStub("？", "slight");
  const result = await judge.judge({
    rawCandidate: raw,
    editorialCandidate: ed,
    intent: makeIntent(),
    constitution: CONSTITUTION,
    modelGenerate: stub,
    seed: 42,
  });
  assert.ok(!result.degraded);
  assert.equal(result.verdict.confidence, "slight");
  // slight → 暂保留 raw，触发反向复判
  assert.equal(result.selection.selectedCandidateId, "raw-1");
  assert.ok(result.selection.needsReverseReview);
});

test("PairwiseJudge: 匿名映射可复现（相同 seed 相同 mapping）", async () => {
  const judge = createPairwiseLiteraryJudge();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  const stub = makeContentAwareStub("？", "clear");
  const r1 = await judge.judge({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: stub, seed: 100,
  });
  const r2 = await judge.judge({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: stub, seed: 100,
  });
  assert.deepEqual(r1.mapping, r2.mapping);
});

test("PairwiseJudge: mapping 覆盖生效（反向复判基础）", async () => {
  const judge = createPairwiseLiteraryJudge();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  const stub = makeContentAwareStub("？", "clear");
  // 先用 seed=42 得到一个 mapping
  const r1 = await judge.judge({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: stub, seed: 42,
  });
  // 用 swapOrder 得到反向 mapping,传入 mapping 覆盖
  const swapped = swapOrder(r1.mapping);
  const r2 = await judge.judge({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: stub, mapping: swapped,
  });
  // mapping 覆盖：r2.mapping 应等于 swapped
  assert.equal(r2.mapping.leftLabel, swapped.leftLabel);
  assert.equal(r2.mapping.rightLabel, swapped.rightLabel);
  assert.equal(r2.mapping.orderRandomized, swapped.orderRandomized);
  // 反匿名后 winner 应一致（都是 ed-1,因为 stub 按内容判定）
  assert.equal(r1.winnerCandidateId, r2.winnerCandidateId);
});

test("PairwiseJudge: 证据无效（worse 缺 span）→ 保留 raw，触发反向复判", async () => {
  const judge = createPairwiseLiteraryJudge();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  // stub 返回 winner=amplified 但 worse 一方缺 span
  const stub = async (input) => {
    const { textA, textB } = extractCandidates(input.userPrompt);
    const edIsA = textA.includes("？");
    const winnerLabel = edIsA ? "A" : "B";
    const verdict = {
      winner: winnerLabel,
      confidence: "clear",
      decisiveReasons: [
        {
          dimension: "钩子",
          betterCandidate: winnerLabel,
          evidenceA: [], // 都空 → worse 缺 span
          evidenceB: [],
          explanation: "胜出",
        },
      ],
      factualRisks: [],
      regressionRisks: [],
      constitutionAlignment: "",
    };
    return { text: JSON.stringify(verdict), model: "stub", route: input.route, durationMs: 10 };
  };
  const result = await judge.judge({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: stub, seed: 42,
  });
  assert.ok(!result.degraded);
  assert.ok(!result.evidenceValidation.ok);
  // 证据无效 → 保留 raw，触发反向复判
  assert.equal(result.selection.selectedCandidateId, "raw-1");
  assert.ok(result.selection.needsReverseReview);
});

// ============================================================================
// 4. JudgeArbitrator
// ============================================================================

test("Arbitrator: 首轮 clear 胜出 → 不反向复判，直接交付 amplified", async () => {
  const arb = createJudgeArbitrator();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  const stub = makeContentAwareStub("？", "clear");
  const result = await arb.arbitrate({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: stub, seed: 42,
  });
  assert.ok(!result.reverseReviewed);
  assert.ok(!result.arbitrationTriggered);
  assert.ok(!result.conflicted);
  assert.equal(result.finalSelectedCandidateId, "ed-1");
  assert.ok(result.auditSummary.includes("跳过反向复判"), `auditSummary 应含跳过反向复判：${result.auditSummary}`);
});

test("Step 4b: PINOVEL_JUDGE_CLEAR_SKIP=0 时 clear 胜出仍触发反向复判", async () => {
  const saved = process.env.PINOVEL_JUDGE_CLEAR_SKIP;
  process.env.PINOVEL_JUDGE_CLEAR_SKIP = "0";
  try {
    const arb = createJudgeArbitrator();
    const raw = makeRawCandidate("raw-1", RAW_TEXT);
    const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
    const stub = makeContentAwareStub("？", "clear");
    const result = await arb.arbitrate({
      rawCandidate: raw, editorialCandidate: ed,
      intent: makeIntent(), constitution: CONSTITUTION,
      modelGenerate: stub, seed: 42,
    });
    // SKIP_CLEAR=0 → clear 胜出不跳过，进入反向复判
    assert.ok(result.reverseReviewed, "PINOVEL_JUDGE_CLEAR_SKIP=0 应触发反向复判");
    assert.ok(result.rounds.length >= 2, "应有 first + reverse 轮");
    assert.equal(result.rounds[1].round, "reverse");
  } finally {
    if (saved === undefined) delete process.env.PINOVEL_JUDGE_CLEAR_SKIP;
    else process.env.PINOVEL_JUDGE_CLEAR_SKIP = saved;
  }
});

test("JUDGE-CALIBRATION-1: editorial 明显加长时的 clear 胜出强制反向复判", async () => {
  // fuben ch1 暴露：editorial 加长 25% 判 clear 直接采纳，但人工选 raw（pacing）。
  // 护栏：editorial 比 raw 加长 >500 字 且 比例 >1.15 时的 clear 胜出不跳过复判。
  const arb = createJudgeArbitrator();
  const calRaw = "基底内容".repeat(80);  // 320 字，无 ？
  const calEdit = "基底内容".repeat(80) + "这到底是谁留下的？" + "编辑增加的长铺垫场景内容用于测试校准护栏。".repeat(40);  // ~1129 字，含 ？
  assert.ok(calEdit.length - calRaw.length > 500, "测试 fixture：editorial 应明显加长");
  const raw = makeRawCandidate("raw-cal", calRaw);
  const ed = makeCandidate("ed-cal", calEdit);
  const stub = makeContentAwareStub("？", "clear");  // editorial 含 ？ -> editorial clear 胜出
  const result = await arb.arbitrate({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: stub, seed: 42,
  });
  assert.ok(result.reverseReviewed, "editorial 明显加长时的 clear 胜出应强制反向复判（JUDGE-CALIBRATION-1 护栏）");
  assert.ok(result.rounds.length >= 2, "应有 first + reverse 轮");
  assert.equal(result.rounds[1].round, "reverse");
});

test("JUDGE-CALIBRATION-1: editorial 未明显加长时 clear 胜出仍跳过复判（行为不变）", async () => {
  const arb = createJudgeArbitrator();
  const calRaw = "基底内容".repeat(80);  // 320 字，无 ？
  const calEdit = "基底内容".repeat(80) + "这到底是谁留下的？";  // 329 字，仅 +9 < 500
  const raw = makeRawCandidate("raw-cal2", calRaw);
  const ed = makeCandidate("ed-cal2", calEdit);
  const stub = makeContentAwareStub("？", "clear");
  const result = await arb.arbitrate({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: stub, seed: 42,
  });
  assert.ok(!result.reverseReviewed, "未明显加长时 clear 胜出应跳过复判（行为不变）");
  assert.equal(result.finalSelectedCandidateId, "ed-cal2");
});

test("Arbitrator: 首轮降级 → 保留 raw，不反向复判", async () => {
  const arb = createJudgeArbitrator();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  const result = await arb.arbitrate({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: makeThrowingStub("API 失败"), seed: 42,
  });
  assert.ok(!result.reverseReviewed);
  assert.equal(result.finalSelectedCandidateId, "raw-1");
  assert.ok(result.firstRound.degraded);
});

test("Arbitrator: needsReverseReview + 两轮一致 amplified → 交付 amplified（可审计胜因）", async () => {
  const arb = createJudgeArbitrator();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  // stub 按"？"内容判定 → 两轮都判 amplified 胜,但 confidence=slight 触发反向复判
  const stub = makeContentAwareStub("？", "slight");
  const result = await arb.arbitrate({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: stub, seed: 42,
  });
  assert.ok(result.reverseReviewed);
  assert.ok(!result.conflicted);
  // 两轮一致确认 amplified → 交付 amplified
  assert.equal(result.finalSelectedCandidateId, "ed-1");
  assert.ok(result.auditSummary.includes("两轮一致确认"));
});

test("Arbitrator: needsReverseReview + 两轮冲突 + 无仲裁器 → 保留 raw", async () => {
  const arb = createJudgeArbitrator();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  // 队列 stub：首轮判 amplified 胜(slight),反向判 raw 胜 → 冲突
  // 需要根据每轮的 A/B 标签返回不同 winner
  const mapping42 = buildAnonymousMapping("raw-1", "ed-1", 42);
  const swapped = swapOrder(mapping42);
  // 首轮：amplified(ed-1) 胜 → winner = ed-1 的标签
  const firstWinnerLabel = mapping42.leftCandidateId === "ed-1" ? mapping42.leftLabel : mapping42.rightLabel;
  // 反向：raw(raw-1) 胜 → winner = raw-1 在 swapped 中的标签
  const reverseWinnerLabel = swapped.leftCandidateId === "raw-1" ? swapped.leftLabel : swapped.rightLabel;
  const stub = makeQueueStub([
    makeVerdictJson(firstWinnerLabel, "slight", RAW_TEXT, EDITORIAL_TEXT),
    makeVerdictJson(reverseWinnerLabel, "clear", EDITORIAL_TEXT, RAW_TEXT),
  ]);
  const result = await arb.arbitrate({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: stub, seed: 42,
  });
  assert.ok(result.reverseReviewed);
  assert.ok(result.conflicted);
  assert.ok(!result.arbitrationTriggered);
  // 冲突 + 无仲裁器 → 保留 raw
  assert.equal(result.finalSelectedCandidateId, "raw-1");
  assert.ok(result.auditSummary.includes("冲突"));
});

test("Arbitrator: needsReverseReview + 两轮冲突 + 仲裁器一致 → 采纳 amplified", async () => {
  const arb = createJudgeArbitrator();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  const mapping42 = buildAnonymousMapping("raw-1", "ed-1", 42);
  const swapped = swapOrder(mapping42);
  const firstWinnerLabel = mapping42.leftCandidateId === "ed-1" ? mapping42.leftLabel : mapping42.rightLabel;
  const reverseWinnerLabel = swapped.leftCandidateId === "raw-1" ? swapped.leftLabel : swapped.rightLabel;
  // 仲裁轮用首轮 mapping,判 amplified 胜(与首轮一致)
  const arbWinnerLabel = firstWinnerLabel;
  const mainStub = makeQueueStub([
    makeVerdictJson(firstWinnerLabel, "slight", RAW_TEXT, EDITORIAL_TEXT),
    makeVerdictJson(reverseWinnerLabel, "clear", EDITORIAL_TEXT, RAW_TEXT),
  ]);
  const arbStub = async (input) => ({
    text: makeVerdictJson(arbWinnerLabel, "clear", RAW_TEXT, EDITORIAL_TEXT),
    model: "arb-stub", route: input.route, durationMs: 10,
  });
  const result = await arb.arbitrate({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: mainStub, arbitratorModelGenerate: arbStub, seed: 42,
  });
  assert.ok(result.conflicted);
  assert.ok(result.arbitrationTriggered);
  // 仲裁与首轮一致 → 确认 amplified
  assert.equal(result.finalSelectedCandidateId, "ed-1");
});

test("Arbitrator: needsReverseReview + 两轮冲突 + 仲裁器 tie → 保留 raw", async () => {
  const arb = createJudgeArbitrator();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  const mapping42 = buildAnonymousMapping("raw-1", "ed-1", 42);
  const swapped = swapOrder(mapping42);
  const firstWinnerLabel = mapping42.leftCandidateId === "ed-1" ? mapping42.leftLabel : mapping42.rightLabel;
  const reverseWinnerLabel = swapped.leftCandidateId === "raw-1" ? swapped.leftLabel : swapped.rightLabel;
  const mainStub = makeQueueStub([
    makeVerdictJson(firstWinnerLabel, "slight", RAW_TEXT, EDITORIAL_TEXT),
    makeVerdictJson(reverseWinnerLabel, "clear", EDITORIAL_TEXT, RAW_TEXT),
  ]);
  // 仲裁判 tie
  const arbStub = async (input) => ({
    text: makeVerdictJson("tie", "uncertain", RAW_TEXT, EDITORIAL_TEXT),
    model: "arb-stub", route: input.route, durationMs: 10,
  });
  const result = await arb.arbitrate({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: mainStub, arbitratorModelGenerate: arbStub, seed: 42,
  });
  assert.ok(result.arbitrationTriggered);
  // 仲裁 tie → 保留 raw
  assert.equal(result.finalSelectedCandidateId, "raw-1");
});

test("Arbitrator: needsReverseReview + 两轮均 tie → 保留 raw", async () => {
  const arb = createJudgeArbitrator();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  // 两个候选都含"门" → 两轮都 tie
  const stub = makeContentAwareStub("门", "uncertain");
  const result = await arb.arbitrate({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: stub, seed: 42,
  });
  assert.ok(result.reverseReviewed);
  assert.ok(!result.conflicted); // 两轮都 tie → 一致(null == null)
  // 一致 tie → 保留 raw
  assert.equal(result.finalSelectedCandidateId, "raw-1");
  assert.ok(result.auditSummary.includes("两轮均判 tie"));
});

test("Arbitrator: rounds 记录所有轮次供 trace 审计", async () => {
  const arb = createJudgeArbitrator();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  const stub = makeContentAwareStub("？", "clear");
  const result = await arb.arbitrate({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: stub, seed: 42,
  });
  // 首轮 clear 胜出 → 只 1 轮
  assert.equal(result.rounds.length, 1);
  assert.equal(result.rounds[0].round, "first");
});

test("Arbitrator: 反向复判时 rounds 记录 first + reverse", async () => {
  const arb = createJudgeArbitrator();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  const stub = makeContentAwareStub("？", "slight");
  const result = await arb.arbitrate({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: stub, seed: 42,
  });
  // slight → 反向复判 → 2 轮
  assert.equal(result.rounds.length, 2);
  assert.equal(result.rounds[0].round, "first");
  assert.equal(result.rounds[1].round, "reverse");
});

// ============================================================================
// 5. Step 4d：裁判结果缓存
// ============================================================================

test("Step 4d: 缓存命中 — 同 raw+editorial+seed 二次 arbitrate 不重复调用 LLM", async () => {
  const arb = createJudgeArbitrator();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  let callCount = 0;
  const countingStub = async (input) => {
    callCount++;
    return makeContentAwareStub("？", "clear")(input);
  };
  const r1 = await arb.arbitrate({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: countingStub, seed: 42,
  });
  const callsAfterFirst = callCount;
  const r2 = await arb.arbitrate({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: countingStub, seed: 42,
  });
  assert.equal(callCount, callsAfterFirst, "第二次应命中缓存，LLM 调用计数不增");
  assert.deepEqual(r1.selection, r2.selection, "缓存结果与首次内容相等");
});

test("Step 4d: 文本变化 → 缓存 miss → 重新调用 LLM", async () => {
  const arb = createJudgeArbitrator();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  let callCount = 0;
  const countingStub = async (input) => {
    callCount++;
    return makeContentAwareStub("？", "clear")(input);
  };
  await arb.arbitrate({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: countingStub, seed: 42,
  });
  const callsAfterFirst = callCount;
  // 改 editorial 文本（仍含"？"→ clear 胜出），candidateHash 变 → miss
  const ed2 = makeCandidate("ed-1", EDITORIAL_TEXT + "他决定追查到底。");
  await arb.arbitrate({
    rawCandidate: raw, editorialCandidate: ed2,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: countingStub, seed: 42,
  });
  assert.ok(callCount > callsAfterFirst, "文本变化应 miss，LLM 调用计数应增加");
});

test("Step 4d: 缓存返回深拷贝，与原结果不同引用但内容相等", async () => {
  const arb = createJudgeArbitrator();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  const stub = makeContentAwareStub("？", "clear");
  const r1 = await arb.arbitrate({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: stub, seed: 42,
  });
  const r2 = await arb.arbitrate({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: stub, seed: 42,
  });
  assert.notEqual(r1, r2, "缓存命中应返回深拷贝，不同引用");
  assert.deepEqual(r1.selection, r2.selection, "深拷贝内容应相等");
});

// ============================================================================
// 5b. Step 4d 修复：缓存键正确性回归（缓存键必须覆盖所有影响裁判结果的输入）
// ============================================================================

test("Step 4d 修复: 改 ChapterIntent → 缓存 miss → 重新调用 LLM", async () => {
  // 旧缓存键漏掉 intent，改 intent 后仍命中旧缓存返回旧 winner。
  // 修复后缓存键含 intentHash，改 intent 必 miss。
  const arb = createJudgeArbitrator();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  let callCount = 0;
  const countingStub = async (input) => {
    callCount++;
    return makeContentAwareStub("？", "clear")(input);
  };
  const intent1 = makeIntent({ chapterFunction: "推进核心冲突" });
  await arb.arbitrate({
    rawCandidate: raw, editorialCandidate: ed,
    intent: intent1, constitution: CONSTITUTION,
    modelGenerate: countingStub, seed: 42,
  });
  const callsAfterFirst = callCount;
  // 改 intent（chapterFunction 变化）→ intentHash 变 → miss
  const intent2 = makeIntent({ chapterFunction: "揭示关键秘密" });
  await arb.arbitrate({
    rawCandidate: raw, editorialCandidate: ed,
    intent: intent2, constitution: CONSTITUTION,
    modelGenerate: countingStub, seed: 42,
  });
  assert.ok(callCount > callsAfterFirst, "改 intent 应 miss，LLM 调用计数应增加");
});

test("Step 4d 修复: 改 raw 正文 → 缓存 miss", async () => {
  // 旧缓存键用 rawCandidate.contextHash，不反映 raw 正文本身；
  // 修复后缓存键含 rawTextHash，改 raw 正文必 miss。
  const arb = createJudgeArbitrator();
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  let callCount = 0;
  const countingStub = async (input) => {
    callCount++;
    return makeContentAwareStub("？", "clear")(input);
  };
  const raw1 = makeRawCandidate("raw-1", RAW_TEXT);
  await arb.arbitrate({
    rawCandidate: raw1, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: countingStub, seed: 42,
  });
  const callsAfterFirst = callCount;
  // 改 raw 正文 → rawTextHash 变 → miss
  const raw2 = makeRawCandidate("raw-1", RAW_TEXT + "他决定追查到底。");
  await arb.arbitrate({
    rawCandidate: raw2, editorialCandidate: ed,
    intent: makeIntent(), constitution: CONSTITUTION,
    modelGenerate: countingStub, seed: 42,
  });
  assert.ok(callCount > callsAfterFirst, "改 raw 正文应 miss");
});

test("Step 4d 修复: 改 constitution → 缓存 miss", async () => {
  // 旧缓存键漏掉 constitution，改 constitution 后仍命中旧缓存。
  // 修复后缓存键含 constitutionHash，改 constitution 必 miss。
  const arb = createJudgeArbitrator();
  const raw = makeRawCandidate("raw-1", RAW_TEXT);
  const ed = makeCandidate("ed-1", EDITORIAL_TEXT);
  let callCount = 0;
  const countingStub = async (input) => {
    callCount++;
    return makeContentAwareStub("？", "clear")(input);
  };
  // null constitution
  await arb.arbitrate({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: null,
    modelGenerate: countingStub, seed: 42,
  });
  const callsAfterFirst = callCount;
  // 改 constitution（null → 非空）→ constitutionHash 变 → miss
  await arb.arbitrate({
    rawCandidate: raw, editorialCandidate: ed,
    intent: makeIntent(), constitution: { voiceRules: ["test"], id: "const-1" },
    modelGenerate: countingStub, seed: 42,
  });
  assert.ok(callCount > callsAfterFirst, "改 constitution 应 miss");
});
