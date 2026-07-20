/**
 * HUMAN-PROXY-PROVENANCE-1：3 个 gpt5.6-sol verdict 规范化测试
 *
 * 派工计划 P0-B 验收口径：
 * - 每个 pair 写入 preference、winning/losing spans、rationale、A/B mapping、provenance、modelVersion、strategyId
 * - 固定 reviewerType=validated_human_proxy、reviewerModel=gpt5.6-sol、humanEquivalent=true
 * - 不得跨策略合并用于准入
 *
 * negative verification:
 * - 不得把 reviewerType 写成 natural_person
 * - 普通 judge/machine-review 不得 humanEquivalent
 * - 无 span、标签泄露、映射错误或 artifact 不同源时 verdict 无效
 *
 * recovery:
 * - 分歧或证据不足记录 tie/undecided，不强制选 editorial，不改变生产正文
 *
 * reporting:
 * - 按 modelVersion + strategyId 输出 naturalHumanCount、validatedProxyCount、humanEquivalentCount、eligibleCount
 * - 当前矩阵应为 reader_payoff_strengthen=1/1、character_agency_focus=2/2
 * - 不得报告全局 human 子门已满足
 *
 * 边界（L0 工程闭环）：
 * - 不调用网络模型
 * - 不修改 finalText / 不提交状态
 * - 不是 gate；不阻断正文生成
 * - 只读取既有 artifact 数据（fixture 形式提供），不重跑审阅
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  HUMAN_PROXY_PROVENANCE_SCHEMA_ID,
  normalizeVerdict,
  validateNormalizedVerdict,
  compileProvenanceMatrix,
} from "../dist/v2/core/human-proxy-provenance.js";

// ============================================================================
// Fixture：3 个既有 gpt5.6-sol verdict（从 reports/*.json + docs/*.md 提取）
// ============================================================================

/**
 * case04 (xinmo ch19) — reader_payoff_strengthen 策略
 * 来源：reports/case04-simulated-human-review.json
 */
function makeCase04Input(overrides = {}) {
  return {
    sourceArtifactPath: "reports/case04-simulated-human-review.json",
    sourceArtifactHash: "a".repeat(64),
    orchestratorRunId: "xinmo-case04-run",
    caseId: "case-04-xinmo-ch19",
    workspaceId: "xinmo-eb1c-real-20260714-case04",
    sourceChapter: "ch19",
    modelVersion: "glm-5.2",
    strategyId: "reader_payoff_strengthen",
    reviewerModel: "gpt5.6-sol",
    anonymousMapping: { A: "editorial", B: "raw" },
    winner: "A",
    confidence: "clear",
    worthReplacing: true,
    decisiveReasons: [
      {
        dimension: "情绪落点与人物深度",
        betterCandidate: "A",
        evidenceExcerpt: "他发现自己扛不住的东西原来不是痛。是空。十七年的空。",
        explanation: "A把母亲真相带来的冲击落在空而非泛泛的悲痛上。",
      },
      {
        dimension: "意象表现力",
        betterCandidate: "A",
        evidenceExcerpt: "连疼都找不到一个方向。",
        explanation: "把孤儿式的情感荒芜写成可感知的空间。",
      },
    ],
    summary: "A 值得替换 B，新增段落把情绪扣成完整闭环。",
    productionJudgeSelection: "editorial",
    timestamp: "2026-07-14T12:00:00.000Z",
    ...overrides,
  };
}

/**
 * case05 (xinmo ch20) — character_agency_focus 策略
 * 来源：reports/case05-ch20-simulated-human-review.json
 */
function makeCase05Input(overrides = {}) {
  return {
    sourceArtifactPath: "reports/case05-ch20-simulated-human-review.json",
    sourceArtifactHash: "b".repeat(64),
    orchestratorRunId: "xinmo-case05-run",
    caseId: "case-05-xinmo-ch20",
    workspaceId: "xinmo-eb1c-real-20260714-case05",
    sourceChapter: "ch20",
    modelVersion: "glm-5.2",
    strategyId: "character_agency_focus",
    reviewerModel: "gpt5.6-sol",
    anonymousMapping: { A: "editorial", B: "raw" },
    winner: "A",
    confidence: "clear",
    worthReplacing: true,
    decisiveReasons: [
      {
        dimension: "主角行动的自主性与人物弧光",
        betterCandidate: "A",
        evidenceExcerpt: "这一次，他选。",
        explanation: "A把锻骨行为落到主动选择这一核心变化上。",
      },
      {
        dimension: "关键行动的因果完整度",
        betterCandidate: "A",
        evidenceExcerpt: "他把左手的碎片放上了石台。不是攥着。是放下。",
        explanation: "A完整交代传承正式启动。",
      },
    ],
    summary: "A 补全了血印启动逻辑，人物力度明显强于 B。",
    productionJudgeSelection: "editorial",
    timestamp: "2026-07-14T13:00:00.000Z",
    ...overrides,
  };
}

/**
 * case08 (fuben ch1) — character_agency_focus 策略
 * 来源：docs/multi-work-fuben-ch1-case08-result-20260714.md（无 JSON，从 markdown 提取）
 */
function makeCase08Input(overrides = {}) {
  return {
    sourceArtifactPath: "docs/multi-work-fuben-ch1-case08-result-20260714.md",
    sourceArtifactHash: "c".repeat(64),
    orchestratorRunId: "fuben-case08-run",
    caseId: "case-08-fuben-ch1",
    workspaceId: "fuben-eb1c-real-20260714-case08",
    sourceChapter: "ch1",
    modelVersion: "glm-5.2",
    strategyId: "character_agency_focus",
    reviewerModel: "gpt5.6-sol",
    anonymousMapping: { A: "editorial", B: "raw" },
    winner: "A",
    confidence: "clear",
    worthReplacing: true,
    decisiveReasons: [
      {
        dimension: "人物动机与声音",
        betterCandidate: "A",
        evidenceExcerpt: "A 补强了林觉开门的动机、人物声音和首尾钩子。",
        explanation: "增量足以值得替换 B。",
      },
    ],
    summary: "A 虽在结尾多出一段思考，却实质补强了林觉开门的动机。",
    productionJudgeSelection: "editorial",
    timestamp: "2026-07-14T14:00:00.000Z",
    ...overrides,
  };
}

// ============================================================================
// 1. normalizeVerdict：3 个 case 规范化
// ============================================================================

test("normalizeVerdict case04 (xinmo ch19): 规范化为有效 verdict", () => {
  const result = normalizeVerdict(makeCase04Input());
  assert.equal(result.ok, true);
  const v = result.verdict;
  assert.equal(v.strategyId, "reader_payoff_strengthen");
  assert.equal(v.modelVersion, "glm-5.2");
  assert.equal(v.sourceChapter, "ch19");
  assert.equal(v.preference, "editorial"); // winner=A + mapping A=editorial
});

test("normalizeVerdict case05 (xinmo ch20): 规范化为有效 verdict", () => {
  const result = normalizeVerdict(makeCase05Input());
  assert.equal(result.ok, true);
  assert.equal(result.verdict.strategyId, "character_agency_focus");
  assert.equal(result.verdict.sourceChapter, "ch20");
  assert.equal(result.verdict.preference, "editorial");
});

test("normalizeVerdict case08 (fuben ch1): 规范化为有效 verdict（无 JSON 从 markdown 提取）", () => {
  const result = normalizeVerdict(makeCase08Input());
  assert.equal(result.ok, true);
  assert.equal(result.verdict.strategyId, "character_agency_focus");
  assert.equal(result.verdict.sourceChapter, "ch1");
  assert.equal(result.verdict.preference, "editorial");
});

// ============================================================================
// 2. 固定字段：reviewerType / reviewerModel / humanEquivalent
// ============================================================================

test("规范化 verdict 固定 reviewerType=validated_human_proxy, reviewerModel=gpt5.6-sol, humanEquivalent=true", () => {
  const result = normalizeVerdict(makeCase04Input());
  assert.equal(result.ok, true);
  const v = result.verdict;
  assert.equal(v.reviewerType, "validated_human_proxy");
  assert.equal(v.reviewerModel, "gpt5.6-sol");
  assert.equal(v.humanEquivalent, true);
});

test("schema 常量导出", () => {
  assert.equal(HUMAN_PROXY_PROVENANCE_SCHEMA_ID, "pinovel.human-proxy-provenance");
});

// ============================================================================
// 3. preference 解匿名 + anonymousMapping 完整
// ============================================================================

test("preference 由 winner + anonymousMapping 解匿名得出", () => {
  // winner=A, mapping A=editorial → preference=editorial
  const r1 = normalizeVerdict(makeCase04Input({ winner: "A", anonymousMapping: { A: "editorial", B: "raw" } }));
  assert.equal(r1.verdict.preference, "editorial");

  // winner=B, mapping B=raw → preference=raw
  const r2 = normalizeVerdict(makeCase04Input({ winner: "B", anonymousMapping: { A: "editorial", B: "raw" } }));
  assert.equal(r2.verdict.preference, "raw");

  // winner=A, mapping A=raw（顺序反转）→ preference=raw
  const r3 = normalizeVerdict(makeCase04Input({ winner: "A", anonymousMapping: { A: "raw", B: "editorial" } }));
  assert.equal(r3.verdict.preference, "raw");
});

test("anonymousMapping 完整保留在 verdict 中（A/B -> candidateId）", () => {
  const result = normalizeVerdict(makeCase04Input());
  assert.deepEqual(result.verdict.anonymousMapping, { A: "editorial", B: "raw" });
});

// ============================================================================
// 4. winningSpans / losingSpans 结构化
// ============================================================================

test("winningSpans 结构化：含 side/excerpt/dimension，非空", () => {
  const result = normalizeVerdict(makeCase04Input());
  assert.equal(result.ok, true);
  const v = result.verdict;
  assert.ok(v.winningSpans.length >= 1, "winningSpans 必须非空");
  for (const span of v.winningSpans) {
    assert.ok(typeof span.side === "string" && (span.side === "A" || span.side === "B"));
    assert.ok(typeof span.excerpt === "string" && span.excerpt.length > 0);
    assert.ok(typeof span.dimension === "string");
  }
  // winner=A, 所有 decisiveReasons betterCandidate=A → winningSpans 全部 side=A
  assert.ok(v.winningSpans.every((s) => s.side === "A"));
});

test("losingSpans 字段存在（可为空当所有 reasons 支持 winner）", () => {
  const result = normalizeVerdict(makeCase04Input());
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.verdict.losingSpans));
});

test("losingSpans 在 betterCandidate=loser 时被填充", () => {
  const input = makeCase04Input({
    decisiveReasons: [
      { dimension: "d1", betterCandidate: "A", evidenceExcerpt: "win excerpt", explanation: "x" },
      { dimension: "d2", betterCandidate: "B", evidenceExcerpt: "lose excerpt", explanation: "y" },
    ],
  });
  const result = normalizeVerdict(input);
  assert.equal(result.ok, true);
  assert.equal(result.verdict.losingSpans.length, 1);
  assert.equal(result.verdict.losingSpans[0].side, "B");
  assert.equal(result.verdict.losingSpans[0].excerpt, "lose excerpt");
});

// ============================================================================
// 5. provenance 完整
// ============================================================================

test("provenance 含 sourceArtifactPath/hash/orchestratorRunId/caseId/workspaceId/sourceChapter", () => {
  const result = normalizeVerdict(makeCase04Input());
  const p = result.verdict.provenance;
  assert.equal(p.sourceArtifactPath, "reports/case04-simulated-human-review.json");
  assert.equal(p.sourceArtifactHash, "a".repeat(64));
  assert.equal(p.orchestratorRunId, "xinmo-case04-run");
  assert.equal(p.caseId, "case-04-xinmo-ch19");
  assert.equal(p.workspaceId, "xinmo-eb1c-real-20260714-case04");
  assert.equal(p.sourceChapter, "ch19");
});

// ============================================================================
// 6. negative verification：无效 verdict
// ============================================================================

test("negative: reviewerModel != gpt5.6-sol → invalid（普通 judge/machine-review 不得 humanEquivalent）", () => {
  const result = normalizeVerdict(makeCase04Input({ reviewerModel: "glm-5.2" }));
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => /reviewerModel|gpt5.6-sol|humanEquivalent/i.test(r)));
});

test("negative: reviewerType 不得写成 natural_person（模块固定 validated_human_proxy，不允许外部覆盖）", () => {
  // reviewerType 不在 input 中（模块固定），无法从外部传 natural_person
  // 验证：normalized verdict 的 reviewerType 永远是 validated_human_proxy
  const result = normalizeVerdict(makeCase04Input());
  assert.equal(result.verdict.reviewerType, "validated_human_proxy");
  assert.notEqual(result.verdict.reviewerType, "natural_person");
});

test("negative: winningSpans 为空（无 decisiveReasons）→ invalid", () => {
  const result = normalizeVerdict(makeCase04Input({ decisiveReasons: [] }));
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => /span|winning|decisive/i.test(r)));
});

test("negative: rationale/summary 泄露 editorial 或 raw 标签 → invalid", () => {
  const result = normalizeVerdict(makeCase04Input({
    summary: "editorial 候选明显胜出，raw 太弱",
  }));
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => /标签泄露|label.*leak|editorial|raw/i.test(r)));
});

test("negative: anonymousMapping 不一致（A 和 B 都映射到 editorial）→ invalid", () => {
  const result = normalizeVerdict(makeCase04Input({
    anonymousMapping: { A: "editorial", B: "editorial" },
  }));
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => /mapping|映射|一致/i.test(r)));
});

test("negative: anonymousMapping 缺少 A 或 B → invalid", () => {
  const result = normalizeVerdict(makeCase04Input({
    anonymousMapping: { A: "editorial" },
  }));
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => /mapping|映射|A.*B/i.test(r)));
});

test("negative: sourceArtifactHash 为空（artifact 不同源）→ invalid", () => {
  const result = normalizeVerdict(makeCase04Input({ sourceArtifactHash: "" }));
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => /hash|artifact|不同源|provenance/i.test(r)));
});

test("negative: modelVersion 为空 → invalid", () => {
  const result = normalizeVerdict(makeCase04Input({ modelVersion: "" }));
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => /modelVersion/i.test(r)));
});

test("negative: strategyId 为空 → invalid", () => {
  const result = normalizeVerdict(makeCase04Input({ strategyId: "" }));
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => /strategyId/i.test(r)));
});

// ============================================================================
// 7. recovery: tie/undecided 不强制选 editorial
// ============================================================================

test("recovery: winner=tie → preference=tie，不强制选 editorial", () => {
  const result = normalizeVerdict(makeCase04Input({
    winner: "tie",
    decisiveReasons: [
      { dimension: "d1", betterCandidate: "A", evidenceExcerpt: "a excerpt", explanation: "x" },
      { dimension: "d2", betterCandidate: "B", evidenceExcerpt: "b excerpt", explanation: "y" },
    ],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.verdict.preference, "tie");
});

test("recovery: winner=undecided → preference=undecided", () => {
  const result = normalizeVerdict(makeCase04Input({ winner: "undecided" }));
  assert.equal(result.ok, true);
  assert.equal(result.verdict.preference, "undecided");
});

// ============================================================================
// 8. validateNormalizedVerdict
// ============================================================================

test("validateNormalizedVerdict: 合法 verdict 通过", () => {
  const { verdict } = normalizeVerdict(makeCase04Input());
  const validation = validateNormalizedVerdict(verdict);
  assert.equal(validation.ok, true);
});

test("validateNormalizedVerdict: 篡改 reviewerType=natural_person → 不通过", () => {
  const { verdict } = normalizeVerdict(makeCase04Input());
  const tampered = { ...verdict, reviewerType: "natural_person" };
  const validation = validateNormalizedVerdict(tampered);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((e) => /reviewerType|natural_person/i.test(e)));
});

test("validateNormalizedVerdict: 篡改 humanEquivalent=false → 不通过", () => {
  const { verdict } = normalizeVerdict(makeCase04Input());
  const tampered = { ...verdict, humanEquivalent: false };
  const validation = validateNormalizedVerdict(tampered);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((e) => /humanEquivalent/i.test(e)));
});

// ============================================================================
// 9. compileProvenanceMatrix：按 modelVersion + strategyId 计数
// ============================================================================

test("compileProvenanceMatrix: 3 verdicts → reader_payoff_strengthen=1/1, character_agency_focus=2/2", () => {
  const verdicts = [
    normalizeVerdict(makeCase04Input()).verdict,
    normalizeVerdict(makeCase05Input()).verdict,
    normalizeVerdict(makeCase08Input()).verdict,
  ];
  const matrix = compileProvenanceMatrix(verdicts);
  const entries = matrix.entries;
  assert.equal(entries.length, 2, "应有 2 个 (modelVersion, strategyId) 分区");

  const rps = entries.find((e) => e.strategyId === "reader_payoff_strengthen");
  assert.ok(rps, "reader_payoff_strengthen 分区存在");
  assert.equal(rps.modelVersion, "glm-5.2");
  assert.equal(rps.eligibleCount, 1, "reader_payoff_strengthen eligible=1");
  assert.equal(rps.humanEquivalentCount, 1, "reader_payoff_strengthen humanEquivalent=1");
  assert.equal(rps.validatedProxyCount, 1, "reader_payoff_strengthen validatedProxy=1");
  assert.equal(rps.naturalHumanCount, 0, "reader_payoff_strengthen naturalHuman=0");

  const caf = entries.find((e) => e.strategyId === "character_agency_focus");
  assert.ok(caf, "character_agency_focus 分区存在");
  assert.equal(caf.eligibleCount, 2, "character_agency_focus eligible=2");
  assert.equal(caf.humanEquivalentCount, 2, "character_agency_focus humanEquivalent=2");
  assert.equal(caf.validatedProxyCount, 2, "character_agency_focus validatedProxy=2");
  assert.equal(caf.naturalHumanCount, 0, "character_agency_focus naturalHuman=0");
});

test("compileProvenanceMatrix: 不得报告全局 human 子门已满足（globalHumanSubgateSatisfied=false）", () => {
  const verdicts = [
    normalizeVerdict(makeCase04Input()).verdict,
    normalizeVerdict(makeCase05Input()).verdict,
    normalizeVerdict(makeCase08Input()).verdict,
  ];
  const matrix = compileProvenanceMatrix(verdicts);
  // 3 个样本不足以满足 5+3 准入阈值；全局子门未满足
  assert.equal(matrix.globalHumanSubgateSatisfied, false);
});

test("compileProvenanceMatrix: 不得跨策略合并（不同 strategyId 分开计数）", () => {
  const verdicts = [
    normalizeVerdict(makeCase04Input()).verdict, // reader_payoff_strengthen
    normalizeVerdict(makeCase05Input()).verdict, // character_agency_focus
    normalizeVerdict(makeCase08Input()).verdict, // character_agency_focus
  ];
  const matrix = compileProvenanceMatrix(verdicts);
  // 不应出现合并的分区（如 reader_payoff_strengthen + character_agency_focus = 3）
  const totalEligible = matrix.entries.reduce((sum, e) => sum + e.eligibleCount, 0);
  assert.equal(totalEligible, 3, "总 eligible=3，但分区不合并");
  // 每个分区独立计数
  for (const entry of matrix.entries) {
    assert.ok(entry.eligibleCount <= 2, "每分区 eligible <= 2（不跨策略合并）");
  }
});

test("compileProvenanceMatrix: 模型版本隔离（不同 modelVersion 分开计数）", () => {
  const verdicts = [
    normalizeVerdict(makeCase04Input()).verdict, // glm-5.2
    normalizeVerdict(makeCase05Input({ modelVersion: "glm-5.3" })).verdict, // glm-5.3
  ];
  const matrix = compileProvenanceMatrix(verdicts);
  const glm52 = matrix.entries.find((e) => e.modelVersion === "glm-5.2");
  const glm53 = matrix.entries.find((e) => e.modelVersion === "glm-5.3");
  assert.ok(glm52 && glm53, "不同 modelVersion 分区隔离");
  assert.equal(glm52.eligibleCount, 1);
  assert.equal(glm53.eligibleCount, 1);
});

test("compileProvenanceMatrix: 空输入 → 空矩阵", () => {
  const matrix = compileProvenanceMatrix([]);
  assert.equal(matrix.entries.length, 0);
  assert.equal(matrix.globalHumanSubgateSatisfied, false);
});

// ============================================================================
// 10. 不得改变生产正文 / 不提交状态（边界检查）
// ============================================================================

test("normalized verdict 不含 chapterFilePath / stateCommit（不改变生产正文/状态）", () => {
  // human-proxy-provenance 模块只读、只规范化、只计数；不写生产正文/状态
  const result = normalizeVerdict(makeCase04Input());
  const v = result.verdict;
  assert.equal("chapterFilePath" in v, false, "verdict 不得含 chapterFilePath");
  assert.equal("stateCommit" in v, false, "verdict 不得含 stateCommit");
  assert.equal("finalText" in v, false, "verdict 不得含 finalText");
});

// ============================================================================
// 11. 异构一致性记录（生产 judge vs gpt5.6-sol）
// ============================================================================

test("productionJudgeAgreement 在生产 judge 与 proxy 一致时为 true", () => {
  const result = normalizeVerdict(makeCase04Input({
    productionJudgeSelection: "editorial", // 与 preference=editorial 一致
  }));
  assert.equal(result.verdict.productionJudgeAgreement, true);
});

test("productionJudgeAgreement 在生产 judge 与 proxy 不一致时为 false", () => {
  const result = normalizeVerdict(makeCase04Input({
    productionJudgeSelection: "raw", // 与 preference=editorial 不一致
  }));
  assert.equal(result.verdict.productionJudgeAgreement, false);
});

test("productionJudgeAgreement 在无生产 judge 对比时为 undefined", () => {
  const result = normalizeVerdict(makeCase04Input({ productionJudgeSelection: undefined }));
  assert.equal(result.verdict.productionJudgeAgreement, undefined);
});
