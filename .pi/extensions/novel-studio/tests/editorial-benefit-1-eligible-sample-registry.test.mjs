/**
 * EDITORIAL-BENEFIT-1：EligibleSampleRegistry + 匿名人工审阅协议最小闭环测试
 *
 * 验收口径（EDITORIAL-BENEFIT-1 任务书）：
 * 1. 建立可比较的 raw/editorial 样本注册表，区分 no-editorial、candidate rejected、judge raw、editorial win。
 * 2. 至少 3 个 eligible pair 才可进入收益验证（insufficient-data 保护）。
 * 3. 同一 run/raw provenance（pair 的 raw 与 editorial 必须来自同一次 orchestrate 运行）。
 * 4. 人工表单匿名（reviewer 身份匿名化；model 版本/路由不进入表单；judge verdict 不展示给 reviewer）。
 * 5. fallback 样本不冒充 editorial 增量（no_editorial / factguard_block / story_preservation_block 排除在 win/loss pair 之外）。
 * 6. 重复样本去重。
 * 7. 样本不足保持 insufficient-data，不推断正负收益。
 *
 * 边界：
 * - 不重新生成章节（只整理已有 artifact）
 * - 不调用网络模型
 * - 不修改 finalText / 不提交状态
 * - 不是 gate；不阻断正文生成
 * - L0 工程闭环：用 fixture 证明 registry 分类与协议 schema 正确，不构成真实质量收益证据
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compileEligibleSampleRegistry,
  DEFAULT_HUMAN_REVIEW_PROTOCOL,
  anonymizeReviewerId,
  validateEligiblePairProvenance,
} from "../dist/v2/core/eligible-sample-registry.js";

// ============================================================================
// Fixture 构造辅助
// ============================================================================

function makeRawProvenance(overrides = {}) {
  return {
    candidateId: "raw-001",
    candidateKind: "raw",
    sourcePath: "data/cases/case-a/b4-artifacts/raw-raw-001.md",
    sourceSha256: "a".repeat(64),
    orchestratorRunId: "run-001",
    caseId: "case-a",
    layer: "B4",
    ...overrides,
  };
}

function makeEditorialProvenance(overrides = {}) {
  return {
    candidateId: "ed-001",
    candidateKind: "editorial",
    sourcePath: "data/cases/case-a/b4-artifacts/editorial-ed-001.md",
    sourceSha256: "b".repeat(64),
    orchestratorRunId: "run-001",
    caseId: "case-a",
    layer: "B4",
    ...overrides,
  };
}

function makeSample(overrides = {}) {
  const base = {
    sampleId: "run-001:raw-001",
    runProvenance: {
      orchestratorRunId: "run-001",
      caseId: "case-a",
      layer: "B4",
      modelVersion: "glm-5.2",
      seed: 0,
    },
    rawCandidate: makeRawProvenance(),
    editorialCandidate: makeEditorialProvenance(),
    outcomeType: "editorial_win",
    factGuardResults: [
      { candidateId: "raw-001", passed: true },
      { candidateId: "ed-001", passed: true },
    ],
    storyPreservationReport: { passed: true },
    judgeResult: {
      winner: "editorial",
      anonymousMapping: { A: "editorial", B: "raw" },
    },
    selectedCandidateId: "ed-001",
    finalSource: "editorial",
    fallbacked: false,
  };
  return { ...base, ...overrides };
}

// ============================================================================
// 1. Eligible pair 分类
// ============================================================================

test("editorial_win 样本进入 eligiblePairs", () => {
  const result = compileEligibleSampleRegistry([makeSample({ outcomeType: "editorial_win" })]);
  assert.equal(result.eligiblePairs.length, 1);
  assert.equal(result.eligiblePairs[0].outcomeType, "editorial_win");
  assert.equal(result.excludedSamples.length, 0);
});

test("judge_raw_win 样本进入 eligiblePairs（editorial 候选存在但 judge 选 raw）", () => {
  const sample = makeSample({
    outcomeType: "judge_raw_win",
    judgeResult: { winner: "raw", anonymousMapping: { A: "raw", B: "editorial" } },
    selectedCandidateId: "raw-001",
    finalSource: "raw",
    fallbacked: true,
  });
  const result = compileEligibleSampleRegistry([sample]);
  assert.equal(result.eligiblePairs.length, 1);
  assert.equal(result.eligiblePairs[0].outcomeType, "judge_raw_win");
  assert.equal(result.eligiblePairs[0].judgeWinner, "raw");
});

// ============================================================================
// 2. 排除分类（fallback 不冒充 editorial 增量）
// ============================================================================

test("no_editorial 样本被排除（无 editorial 候选，不计 win/loss pair）", () => {
  const sample = makeSample({
    sampleId: "run-noed:raw-001",
    outcomeType: "no_editorial",
    editorialCandidate: undefined,
    judgeResult: undefined,
    selectedCandidateId: "raw-001",
    finalSource: "raw",
    fallbacked: true,
  });
  const result = compileEligibleSampleRegistry([sample]);
  assert.equal(result.eligiblePairs.length, 0);
  assert.equal(result.excludedSamples.length, 1);
  assert.match(result.excludedSamples[0].reason, /no_editorial/);
});

test("factguard_block 样本被排除（候选生成但被 FactGuard 拒绝）", () => {
  const sample = makeSample({
    sampleId: "run-fg:raw-001",
    outcomeType: "factguard_block",
    factGuardResults: [
      { candidateId: "raw-001", passed: true },
      { candidateId: "ed-001", passed: false, reason: "实体幻觉：未登记角色'张三'" },
    ],
    judgeResult: undefined,
    selectedCandidateId: "raw-001",
    finalSource: "raw",
    fallbacked: true,
  });
  const result = compileEligibleSampleRegistry([sample]);
  assert.equal(result.eligiblePairs.length, 0);
  assert.equal(result.excludedSamples.length, 1);
  assert.match(result.excludedSamples[0].reason, /factguard_block/);
});

test("story_preservation_block 样本被排除（通过 FactGuard 但故事保存门拒绝）", () => {
  const sample = makeSample({
    sampleId: "run-sp:raw-001",
    outcomeType: "story_preservation_block",
    storyPreservationReport: { passed: false, reason: "missing_event: 关键动作被删除" },
    judgeResult: undefined,
    selectedCandidateId: "raw-001",
    finalSource: "raw",
    fallbacked: true,
  });
  const result = compileEligibleSampleRegistry([sample]);
  assert.equal(result.eligiblePairs.length, 0);
  assert.equal(result.excludedSamples.length, 1);
  assert.match(result.excludedSamples[0].reason, /story_preservation_block/);
});

test("excludedSamples 含 outcomeType 与排除原因（不静默丢弃）", () => {
  const sample = makeSample({
    sampleId: "run-fg2:raw-001",
    outcomeType: "factguard_block",
    factGuardResults: [{ candidateId: "ed-001", passed: false, reason: "事实冲突" }],
    selectedCandidateId: "raw-001",
    finalSource: "raw",
    fallbacked: true,
  });
  const result = compileEligibleSampleRegistry([sample]);
  assert.equal(result.excludedSamples[0].outcomeType, "factguard_block");
  assert.ok(result.excludedSamples[0].reason.length > 0);
});

// ============================================================================
// 3. insufficient-data 保护（< 3 eligible pair）
// ============================================================================

test("eligiblePairs < 3 时 insufficientData=true（不推断正负收益）", () => {
  const result = compileEligibleSampleRegistry([
    makeSample({ sampleId: "run-a:raw-001" }),
    makeSample({ sampleId: "run-b:raw-001" }),
  ]);
  assert.equal(result.eligiblePairs.length, 2);
  assert.equal(result.insufficientData, true);
});

test("eligiblePairs >= 3 时 insufficientData=false", () => {
  const result = compileEligibleSampleRegistry([
    makeSample({ sampleId: "run-a:raw-001" }),
    makeSample({ sampleId: "run-b:raw-001" }),
    makeSample({ sampleId: "run-c:raw-001" }),
  ]);
  assert.equal(result.eligiblePairs.length, 3);
  assert.equal(result.insufficientData, false);
});

test("0 eligible pair 时 insufficientData=true 且 eligibleCount=0", () => {
  const result = compileEligibleSampleRegistry([
    makeSample({ sampleId: "run-x:raw-001", outcomeType: "no_editorial", editorialCandidate: undefined, judgeResult: undefined, selectedCandidateId: "raw-001", finalSource: "raw", fallbacked: true }),
  ]);
  assert.equal(result.eligibleCount, 0);
  assert.equal(result.insufficientData, true);
});

// ============================================================================
// 4. provenance 一致性验证
// ============================================================================

test("pair 的 raw 与 editorial 必须来自同一 orchestratorRunId", () => {
  const sample = makeSample({
    rawCandidate: makeRawProvenance({ orchestratorRunId: "run-001" }),
    editorialCandidate: makeEditorialProvenance({ orchestratorRunId: "run-002" }),
  });
  const result = compileEligibleSampleRegistry([sample]);
  assert.equal(result.eligiblePairs.length, 0);
  assert.equal(result.excludedSamples.length, 1);
  assert.match(result.excludedSamples[0].reason, /provenance|runId/i);
});

test("validateEligiblePairProvenance 返回 false 当 caseId 不一致", () => {
  const raw = makeRawProvenance({ caseId: "case-a" });
  const ed = makeEditorialProvenance({ caseId: "case-b" });
  assert.equal(validateEligiblePairProvenance(raw, ed), false);
});

test("validateEligiblePairProvenance 返回 true 当 run/case/layer 一致", () => {
  const raw = makeRawProvenance();
  const ed = makeEditorialProvenance();
  assert.equal(validateEligiblePairProvenance(raw, ed), true);
});

// ============================================================================
// 5. 去重
// ============================================================================

test("相同 sampleId 的样本去重（保留首个）", () => {
  const s1 = makeSample({ sampleId: "dup:raw-001" });
  const s2 = makeSample({ sampleId: "dup:raw-001", outcomeType: "judge_raw_win" });
  const result = compileEligibleSampleRegistry([s1, s2]);
  assert.equal(result.eligiblePairs.length, 1);
  // 保留首个（editorial_win）
  assert.equal(result.eligiblePairs[0].outcomeType, "editorial_win");
  assert.equal(result.totalCount, 1);
});

// ============================================================================
// 6. eligible pair 结构完整性
// ============================================================================

test("eligible pair 必须同时有 raw 和 editorial candidate", () => {
  const sample = makeSample({
    outcomeType: "editorial_win",
    editorialCandidate: undefined, // 缺失
  });
  const result = compileEligibleSampleRegistry([sample]);
  assert.equal(result.eligiblePairs.length, 0);
  assert.equal(result.excludedSamples.length, 1);
  assert.match(result.excludedSamples[0].reason, /editorialCandidate|missing/i);
});

test("eligible pair 的 selectedCandidateId 必须匹配 raw 或 editorial", () => {
  const sample = makeSample({
    outcomeType: "editorial_win",
    selectedCandidateId: "unknown-cand", // 不匹配任何一个
  });
  const result = compileEligibleSampleRegistry([sample]);
  assert.equal(result.eligiblePairs.length, 0);
  assert.match(result.excludedSamples[0].reason, /selectedCandidateId|inconsistent/i);
});

test("eligible pair 的 finalSource 与 selectedCandidateId 一致性检查", () => {
  // selectedCandidateId=ed-001 但 finalSource=raw → 矛盾
  const sample = makeSample({
    outcomeType: "editorial_win",
    selectedCandidateId: "ed-001",
    finalSource: "raw",
  });
  const result = compileEligibleSampleRegistry([sample]);
  assert.equal(result.eligiblePairs.length, 0);
  assert.match(result.excludedSamples[0].reason, /finalSource|inconsistent/i);
});

// ============================================================================
// 7. 匿名人工审阅协议
// ============================================================================

test("DEFAULT_HUMAN_REVIEW_PROTOCOL 含匿名化规则", () => {
  assert.ok(DEFAULT_HUMAN_REVIEW_PROTOCOL.anonymizationRules.length >= 3);
  assert.ok(DEFAULT_HUMAN_REVIEW_PROTOCOL.anonymizationRules.some(r => /reviewer.*匿名|anon/i.test(r)));
  assert.ok(DEFAULT_HUMAN_REVIEW_PROTOCOL.anonymizationRules.some(r => /model|路由/i.test(r)));
  assert.ok(DEFAULT_HUMAN_REVIEW_PROTOCOL.anonymizationRules.some(r => /judge.*不展示|不.*reviewer|锚定/i.test(r)));
});

test("DEFAULT_HUMAN_REVIEW_PROTOCOL 含评审维度", () => {
  assert.ok(DEFAULT_HUMAN_REVIEW_PROTOCOL.reviewDimensions.length >= 3);
  assert.ok(DEFAULT_HUMAN_REVIEW_PROTOCOL.reviewDimensions.includes("整体偏好"));
});

test("DEFAULT_HUMAN_REVIEW_PROTOCOL 含提交规则（防'都好'规避）", () => {
  assert.ok(DEFAULT_HUMAN_REVIEW_PROTOCOL.submissionRules.length >= 1);
  assert.ok(DEFAULT_HUMAN_REVIEW_PROTOCOL.submissionRules.some(r => /spans|winning|losing/i.test(r)));
});

test("anonymizeReviewerId 输出不可逆 anon-XXXX 格式（不暴露原身份）", () => {
  const anon = anonymizeReviewerId("张三");
  assert.match(anon, /^anon-[a-f0-9]{8}$/i);
  // 同输入同输出（确定性哈希）
  assert.equal(anon, anonymizeReviewerId("张三"));
  // 不同输入不同输出
  assert.notEqual(anon, anonymizeReviewerId("李四"));
  // 不含原身份
  assert.ok(!anon.includes("张三"));
});

test("anonymizeReviewerId 空输入返回 anon-unknown（不抛异常）", () => {
  assert.equal(anonymizeReviewerId(""), "anon-unknown");
  assert.equal(anonymizeReviewerId(null), "anon-unknown");
  assert.equal(anonymizeReviewerId(undefined), "anon-unknown");
});

// ============================================================================
// 8. 不变量：不调用 LLM / 不修改 finalText / 不是 gate
// ============================================================================

test("registry 不含 rewriteRaw/patchRaw/overrideRaw 字段（不接管 finalText）", () => {
  const result = compileEligibleSampleRegistry([makeSample()]);
  const json = JSON.stringify(result);
  assert.ok(!/rewriteRaw|patchRaw|overrideRaw/.test(json));
});

test("registry 不含 hardBlock/blockGeneration 字段（不是 gate）", () => {
  const result = compileEligibleSampleRegistry([makeSample()]);
  const json = JSON.stringify(result);
  assert.ok(!/hardBlock|blockGeneration|passed|blocked/.test(json));
});

test("registry 总计数字段（totalCount/eligibleCount/excludedCount 一致）", () => {
  const result = compileEligibleSampleRegistry([
    makeSample({ sampleId: "run-a:raw-001" }),
    makeSample({ sampleId: "run-b:raw-001", outcomeType: "no_editorial", editorialCandidate: undefined, judgeResult: undefined, selectedCandidateId: "raw-001", finalSource: "raw", fallbacked: true }),
    makeSample({ sampleId: "run-c:raw-001" }),
  ]);
  assert.equal(result.totalCount, 3);
  assert.equal(result.eligibleCount, 2);
  assert.equal(result.excludedSamples.length, 1);
  assert.equal(result.eligiblePairs.length, 2);
});
