/**
 * NB-5 Reference-aware Judge 测试
 *
 * 验证（任务要求，纯本地 stub，不调真实模型）：
 * - 匿名 pairwise：A/B 不暴露 B0-B4 身份
 * - 5 维度评分完整且不重复
 * - span 引用：excerpt 必须是候选正文子串
 * - 反向复判：forward + reverse 一致才算有效
 * - 多数投票：N 轮一致 verdict 多数胜出
 * - < 2 一致 verdict → needsManualReview
 *
 * 测试维度：
 * 1. Happy path：3 轮全部一致 → majority winner
 * 2. 反向不一致：forward 和 reverse 选不同候选 → 不计入一致
 * 3. 无效 verdict：维度缺失 / span 非子串 / JSON 解析失败
 * 4. < 2 一致 verdict → needsManualReview
 * 5. 空候选 → needsManualReview
 * 6. 匿名映射：seed + round + reversed 决定 A/B
 * 7. JSON 容错解析：valid / 含前后文 / 无效
 * 8. 模型调用计数
 * 9. 置信度计算
 * 10. 架构边界：不 import reference-registry/generator-bundle 等
 *
 * import 自 dist-eval/novelbench/index.js（lab-only）。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runReferenceAwareJudge,
  ALL_DIMENSIONS,
} from "../dist-eval/novelbench/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = join(__dirname, "..");
const JUDGE_JS = join(EXT_ROOT, "dist-eval", "novelbench", "reference-aware-judge.js");

// ─────────────────────────────────────────────────────────────────────────────
// Stub 工具
// ─────────────────────────────────────────────────────────────────────────────

function createStubModelGenerateFn(responder) {
  const calls = [];
  const fn = async (input) => {
    calls.push({ ...input });
    const response = responder(input, calls.length);
    if (response.throw) {
      throw new Error(response.throw);
    }
    const text = typeof response === "string" ? response : response.text;
    return {
      text,
      model: response.model ?? "stub-model",
      route: response.route ?? input.route,
      durationMs: response.durationMs ?? 10,
    };
  };
  fn.calls = calls;
  return fn;
}

const STUB_CANDIDATES = {
  B0: "B0 基线正文。宋霆走入执法堂。",
  B1: "B1 上下文增强。宋霆踏入执法堂，目光如电。",
  B2: "B2 意图增强。宋霆踏入执法堂，目光如电，灵力暗涌。",
  B3: "B3 编辑改写。宋霆步入执法堂，双目精光暴射，灵力在体内暗暗涌动。",
  B4: "B4 最终。宋霆步入执法堂，双目精光暴射，灵力在体内暗暗涌动。",
};

const STUB_REFERENCE = "参考正文：宋霆走进执法堂，眼中精光一闪，体内灵力涌动。";

/** 构造一个合法的 verdict JSON（5 维度 + span） */
function makeValidVerdictJson(winner, textA, textB) {
  const winnerText = winner === "A" ? textA : textB;
  const loserText = winner === "A" ? textB : textA;
  const loserLetter = winner === "A" ? "B" : "A";
  // 取正文前 10 字作为 span excerpt
  const winExcerpt = winnerText.slice(0, 10);
  const loseExcerpt = loserText.slice(0, 10);
  return JSON.stringify({
    winner,
    reason: `${winner} 更好，因为文学性更强。`,
    dimensions: [
      { dimension: "中文自然度", winner, reason: "更自然" },
      { dimension: "情节推进", winner, reason: "推进更好" },
      { dimension: "人物质感", winner, reason: "人物更鲜活" },
      { dimension: "细节画面", winner, reason: "画面感更强" },
      { dimension: "章末张力", winner, reason: "钩子更足" },
    ],
    winningSpans: [{ letter: winner, excerpt: winExcerpt }],
    losingSpans: [{ letter: loserLetter, excerpt: loseExcerpt }],
  });
}

/**
 * 构造一个 responder，让 forward 和 reverse 都选同一层（一致）。
 * 由于 forward 和 reverse 的 A/B 映射不同，需要根据实际 textA/textB 判断。
 * 策略：总是选"含'B4 最终'的候选"作为胜者。
 */
function createConsistentResponder(targetMarker) {
  return (input) => {
    // 从 user prompt 中提取正文 A 和正文 B
    const aMatch = input.userPrompt.match(/【正文 A】\n([\s\S]*?)\n\n【正文 B】/);
    const bMatch = input.userPrompt.match(/【正文 B】\n([\s\S]*?)\n\n请比较/);
    const textA = aMatch ? aMatch[1] : "";
    const textB = bMatch ? bMatch[1] : "";

    // 总是选含 targetMarker 的候选
    const winner = textA.includes(targetMarker) ? "A" : "B";
    return { text: makeValidVerdictJson(winner, textA, textB) };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Happy path：3 轮全部一致
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-5 Happy Path", () => {
  test("3 轮 forward+reverse 全部一致选 B4 → majorityWinner=B4", async () => {
    // responder 总是选含 "B4 最终" 的候选
    const modelGenerate = createStubModelGenerateFn(
      createConsistentResponder("B4 最终"),
    );
    const result = await runReferenceAwareJudge({
      caseId: "test-case-1",
      candidates: STUB_CANDIDATES,
      referenceText: STUB_REFERENCE,
      pairs: [["B0", "B4"]],
      modelGenerate,
      route: "nb5_judge_glm",
      seed: 0,
      rounds: 3,
      timeoutMs: 5000,
    });

    assert.equal(result.pairResults.length, 1);
    const pr = result.pairResults[0];
    assert.equal(pr.pair[0], "B0");
    assert.equal(pr.pair[1], "B4");

    // 3 轮 × 2（forward+reverse）= 6 verdicts
    assert.equal(pr.verdicts.length, 6);

    // 全部一致
    assert.equal(pr.consistentVerdicts.length, 3, "3 轮应全部一致");

    // 多数投票：B4
    assert.equal(pr.majorityWinner, "B4");
    assert.equal(pr.needsManualReview, false);
    assert.equal(pr.confidence, 1, "3/3 一致 → confidence=1");

    // 模型调用：6 次（3 轮 × 2 向，全部一次成功）
    assert.equal(result.totalModelCalls, 6);
  });

  test("3 轮全部一致选 B0 → majorityWinner=B0", async () => {
    const modelGenerate = createStubModelGenerateFn(
      createConsistentResponder("B0 基线"),
    );
    const result = await runReferenceAwareJudge({
      caseId: "test-case-2",
      candidates: STUB_CANDIDATES,
      referenceText: STUB_REFERENCE,
      pairs: [["B0", "B4"]],
      modelGenerate,
      route: "nb5_judge_glm",
      seed: 0,
      rounds: 3,
      timeoutMs: 5000,
    });

    assert.equal(result.pairResults[0].majorityWinner, "B0");
    assert.equal(result.pairResults[0].confidence, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 反向不一致
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-5 反向不一致", () => {
  test("forward 选 A，reverse 也选 A（但 A 是不同候选）→ 不一致", async () => {
    // 这个 responder 总是选 A（不管 A 是哪层）
    // forward: A=B0 → 选 B0
    // reverse: A=B4 → 选 B4
    // 两向选不同层 → 不一致
    const modelGenerate = createStubModelGenerateFn((input) => {
      const aMatch = input.userPrompt.match(/【正文 A】\n([\s\S]*?)\n\n【正文 B】/);
      const bMatch = input.userPrompt.match(/【正文 B】\n([\s\S]*?)\n\n请比较/);
      const textA = aMatch ? aMatch[1] : "";
      const textB = bMatch ? bMatch[1] : "";
      return { text: makeValidVerdictJson("A", textA, textB) };
    });

    const result = await runReferenceAwareJudge({
      caseId: "test-inconsistent",
      candidates: STUB_CANDIDATES,
      referenceText: STUB_REFERENCE,
      pairs: [["B0", "B4"]],
      modelGenerate,
      route: "nb5_judge_glm",
      seed: 0,
      rounds: 3,
      timeoutMs: 5000,
    });

    const pr = result.pairResults[0];
    // 6 verdicts 但 0 一致（每轮 forward 选 B0、reverse 选 B4 → 不一致）
    assert.equal(pr.verdicts.length, 6);
    assert.equal(pr.consistentVerdicts.length, 0, "位置偏好导致全部不一致");
    assert.equal(pr.needsManualReview, true, "< 2 一致 → 人工审查");
    assert.equal(pr.majorityWinner, null);
    assert.equal(pr.confidence, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 无效 verdict
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-5 无效 verdict", () => {
  test("维度缺失 → verdict 无效", async () => {
    const modelGenerate = createStubModelGenerateFn((input) => {
      const aMatch = input.userPrompt.match(/【正文 A】\n([\s\S]*?)\n\n【正文 B】/);
      const bMatch = input.userPrompt.match(/【正文 B】\n([\s\S]*?)\n\n请比较/);
      const textA = aMatch ? aMatch[1] : "";
      const textB = bMatch ? bMatch[1] : "";
      // 只返回 3 个维度（缺 2 个）
      const obj = JSON.parse(makeValidVerdictJson("A", textA, textB));
      obj.dimensions = obj.dimensions.slice(0, 3);
      return { text: JSON.stringify(obj) };
    });

    const result = await runReferenceAwareJudge({
      caseId: "test-invalid-dim",
      candidates: STUB_CANDIDATES,
      referenceText: STUB_REFERENCE,
      pairs: [["B0", "B4"]],
      modelGenerate,
      route: "nb5_judge_glm",
      seed: 0,
      rounds: 1,
      timeoutMs: 5000,
    });

    const pr = result.pairResults[0];
    // 所有 verdict 都无效
    assert.ok(pr.verdicts.every((v) => !v.valid), "维度缺失应判无效");
    assert.equal(pr.consistentVerdicts.length, 0);
    assert.equal(pr.needsManualReview, true);
  });

  test("span excerpt 非候选子串 → verdict 无效", async () => {
    const modelGenerate = createStubModelGenerateFn((input) => {
      const aMatch = input.userPrompt.match(/【正文 A】\n([\s\S]*?)\n\n【正文 B】/);
      const bMatch = input.userPrompt.match(/【正文 B】\n([\s\S]*?)\n\n请比较/);
      const textA = aMatch ? aMatch[1] : "";
      const textB = bMatch ? bMatch[1] : "";
      const obj = JSON.parse(makeValidVerdictJson("A", textA, textB));
      // 注入不存在的 excerpt
      obj.winningSpans = [{ letter: "A", excerpt: "这段文字不在候选正文中出现" }];
      return { text: JSON.stringify(obj) };
    });

    const result = await runReferenceAwareJudge({
      caseId: "test-invalid-span",
      candidates: STUB_CANDIDATES,
      referenceText: STUB_REFERENCE,
      pairs: [["B0", "B4"]],
      modelGenerate,
      route: "nb5_judge_glm",
      seed: 0,
      rounds: 1,
      timeoutMs: 5000,
    });

    const pr = result.pairResults[0];
    assert.ok(pr.verdicts.every((v) => !v.valid), "span 非子串应判无效");
    assert.ok(
      pr.verdicts.every((v) => v.invalidReason?.includes("子串")),
      "无效原因应提及子串",
    );
  });

  test("winner 非 A/B → verdict 无效", async () => {
    const modelGenerate = createStubModelGenerateFn((input) => {
      return { text: JSON.stringify({ winner: "C", reason: "C 更好" }) };
    });

    const result = await runReferenceAwareJudge({
      caseId: "test-invalid-winner",
      candidates: STUB_CANDIDATES,
      referenceText: STUB_REFERENCE,
      pairs: [["B0", "B4"]],
      modelGenerate,
      route: "nb5_judge_glm",
      seed: 0,
      rounds: 1,
      timeoutMs: 5000,
    });

    const pr = result.pairResults[0];
    // winner 解析失败 → 调用 2 次（1 初试 + 1 重试），然后 verdict 为 null（不加入 verdicts）
    assert.equal(pr.verdicts.length, 0, "完全无法解析的 verdict 不加入列表");
    assert.equal(pr.needsManualReview, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. < 2 一致 verdict → needsManualReview
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-5 人工审查阈值", () => {
  test("仅 1 轮一致 → needsManualReview=true", async () => {
    let callCount = 0;
    const modelGenerate = createStubModelGenerateFn((input) => {
      callCount += 1;
      const aMatch = input.userPrompt.match(/【正文 A】\n([\s\S]*?)\n\n【正文 B】/);
      const bMatch = input.userPrompt.match(/【正文 B】\n([\s\S]*?)\n\n请比较/);
      const textA = aMatch ? aMatch[1] : "";
      const textB = bMatch ? bMatch[1] : "";
      // 第 1 轮（calls 1-2）一致选 B4
      // 第 2-3 轮（calls 3-6）总是选 A（位置偏好，不一致）
      if (callCount <= 2) {
        const winner = textA.includes("B4 最终") ? "A" : "B";
        return { text: makeValidVerdictJson(winner, textA, textB) };
      }
      return { text: makeValidVerdictJson("A", textA, textB) };
    });

    const result = await runReferenceAwareJudge({
      caseId: "test-1-consistent",
      candidates: STUB_CANDIDATES,
      referenceText: STUB_REFERENCE,
      pairs: [["B0", "B4"]],
      modelGenerate,
      route: "nb5_judge_glm",
      seed: 0,
      rounds: 3,
      timeoutMs: 5000,
    });

    const pr = result.pairResults[0];
    assert.equal(pr.consistentVerdicts.length, 1, "仅 1 轮一致");
    assert.equal(pr.needsManualReview, true, "1 < 2 → 人工审查");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. 空候选
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-5 空候选", () => {
  test("某层候选为空 → needsManualReview=true，0 verdicts", async () => {
    const modelGenerate = createStubModelGenerateFn(() => ({ text: "{}" }));
    const result = await runReferenceAwareJudge({
      caseId: "test-empty",
      candidates: { ...STUB_CANDIDATES, B4: "" },
      referenceText: STUB_REFERENCE,
      pairs: [["B0", "B4"]],
      modelGenerate,
      route: "nb5_judge_glm",
      seed: 0,
      rounds: 3,
      timeoutMs: 5000,
    });

    const pr = result.pairResults[0];
    assert.equal(pr.verdicts.length, 0, "空候选不调模型");
    assert.equal(pr.needsManualReview, true);
    assert.equal(result.totalModelCalls, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. JSON 容错解析
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-5 JSON 容错解析", () => {
  test("judge 返回含前后说明文的 JSON → 正则提取成功", async () => {
    const modelGenerate = createStubModelGenerateFn((input) => {
      const aMatch = input.userPrompt.match(/【正文 A】\n([\s\S]*?)\n\n【正文 B】/);
      const bMatch = input.userPrompt.match(/【正文 B】\n([\s\S]*?)\n\n请比较/);
      const textA = aMatch ? aMatch[1] : "";
      const textB = bMatch ? bMatch[1] : "";
      const winner = textA.includes("B4 最终") ? "A" : "B";
      const json = makeValidVerdictJson(winner, textA, textB);
      // 前后加说明文
      return { text: `好的，我来比较。\n${json}\n以上是评判。` };
    });

    const result = await runReferenceAwareJudge({
      caseId: "test-json-surround",
      candidates: STUB_CANDIDATES,
      referenceText: STUB_REFERENCE,
      pairs: [["B0", "B4"]],
      modelGenerate,
      route: "nb5_judge_glm",
      seed: 0,
      rounds: 1,
      timeoutMs: 5000,
    });

    const pr = result.pairResults[0];
    assert.ok(pr.verdicts.length > 0, "应解析出 verdict");
    assert.ok(pr.verdicts.every((v) => v.valid), "正则提取的 verdict 应有效");
  });

  test("judge 返回 markdown 代码块 JSON → 提取成功", async () => {
    const modelGenerate = createStubModelGenerateFn((input) => {
      const aMatch = input.userPrompt.match(/【正文 A】\n([\s\S]*?)\n\n【正文 B】/);
      const bMatch = input.userPrompt.match(/【正文 B】\n([\s\S]*?)\n\n请比较/);
      const textA = aMatch ? aMatch[1] : "";
      const textB = bMatch ? bMatch[1] : "";
      const winner = textA.includes("B4 最终") ? "A" : "B";
      const json = makeValidVerdictJson(winner, textA, textB);
      return { text: "```json\n" + json + "\n```" };
    });

    const result = await runReferenceAwareJudge({
      caseId: "test-json-markdown",
      candidates: STUB_CANDIDATES,
      referenceText: STUB_REFERENCE,
      pairs: [["B0", "B4"]],
      modelGenerate,
      route: "nb5_judge_glm",
      seed: 0,
      rounds: 1,
      timeoutMs: 5000,
    });

    const pr = result.pairResults[0];
    assert.ok(pr.verdicts.every((v) => v.valid), "markdown 代码块应提取成功");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. 多对比较
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-5 多对比较", () => {
  test("2 对比较 → 2 个 PairResult", async () => {
    const modelGenerate = createStubModelGenerateFn(
      createConsistentResponder("B4 最终"),
    );
    const result = await runReferenceAwareJudge({
      caseId: "test-multi-pair",
      candidates: STUB_CANDIDATES,
      referenceText: STUB_REFERENCE,
      pairs: [["B0", "B4"], ["B2", "B3"]],
      modelGenerate,
      route: "nb5_judge_glm",
      seed: 0,
      rounds: 1,
      timeoutMs: 5000,
    });

    assert.equal(result.pairResults.length, 2);
    // B0 vs B4 → B4 胜
    assert.equal(result.pairResults[0].pair[0], "B0");
    assert.equal(result.pairResults[0].pair[1], "B4");
    // B2 vs B3 → B4 最终不在 B2/B3 中，responder 选不到 → 可能不一致
    // 但 B3 含 "B3 编辑改写" 不含 "B4 最终"，B2 也不含 → responder 返回 B（因为 A 不含 targetMarker）
    // 实际：textA 和 textB 都不含 "B4 最终" → winner = B（因为 textA.includes("B4 最终") = false → winner="B"）
    assert.equal(result.pairResults[1].pair[0], "B2");
    assert.equal(result.pairResults[1].pair[1], "B3");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. 模型调用计数与重试
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-5 模型调用计数", () => {
  test("3 轮 × 2 向 = 6 次调用（全部一次成功）", async () => {
    const modelGenerate = createStubModelGenerateFn(
      createConsistentResponder("B4 最终"),
    );
    const result = await runReferenceAwareJudge({
      caseId: "test-call-count",
      candidates: STUB_CANDIDATES,
      referenceText: STUB_REFERENCE,
      pairs: [["B0", "B4"]],
      modelGenerate,
      route: "nb5_judge_glm",
      seed: 0,
      rounds: 3,
      timeoutMs: 5000,
    });

    assert.equal(result.totalModelCalls, 6);
    assert.equal(modelGenerate.calls.length, 6);
  });

  test("judge 调用抛错 → 重试 1 次，2 次调用计入 totalModelCalls", async () => {
    const modelGenerate = createStubModelGenerateFn((input) => {
      return { throw: "judge 不可用" };
    });

    const result = await runReferenceAwareJudge({
      caseId: "test-throw",
      candidates: STUB_CANDIDATES,
      referenceText: STUB_REFERENCE,
      pairs: [["B0", "B4"]],
      modelGenerate,
      route: "nb5_judge_glm",
      seed: 0,
      rounds: 1,
      timeoutMs: 5000,
    });

    // 1 轮 × 2 向 × 2 次（初试+重试）= 4 次调用
    assert.equal(result.totalModelCalls, 4);
    // verdict 为 null（调用失败）→ 不加入 verdicts
    assert.equal(result.pairResults[0].verdicts.length, 0);
    assert.equal(result.pairResults[0].needsManualReview, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. 维度完整性
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-5 维度完整性", () => {
  test("ALL_DIMENSIONS 含 5 个维度且不重复", () => {
    assert.equal(ALL_DIMENSIONS.length, 5);
    const set = new Set(ALL_DIMENSIONS);
    assert.equal(set.size, 5, "维度不重复");
    assert.ok(ALL_DIMENSIONS.includes("中文自然度"));
    assert.ok(ALL_DIMENSIONS.includes("情节推进"));
    assert.ok(ALL_DIMENSIONS.includes("人物质感"));
    assert.ok(ALL_DIMENSIONS.includes("细节画面"));
    assert.ok(ALL_DIMENSIONS.includes("章末张力"));
  });

  test("有效 verdict 含 5 个完整维度", async () => {
    const modelGenerate = createStubModelGenerateFn(
      createConsistentResponder("B4 最终"),
    );
    const result = await runReferenceAwareJudge({
      caseId: "test-dims",
      candidates: STUB_CANDIDATES,
      referenceText: STUB_REFERENCE,
      pairs: [["B0", "B4"]],
      modelGenerate,
      route: "nb5_judge_glm",
      seed: 0,
      rounds: 1,
      timeoutMs: 5000,
    });

    for (const v of result.pairResults[0].verdicts) {
      assert.ok(v.valid, "应全部有效");
      assert.equal(v.dimensions.length, 5, "应有 5 个维度");
      const dimSet = new Set(v.dimensions.map((d) => d.dimension));
      assert.equal(dimSet.size, 5, "维度不重复");
      for (const dim of ALL_DIMENSIONS) {
        assert.ok(dimSet.has(dim), `应含维度：${dim}`);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Fix-4：span 语义绑定（winningSpans[].letter === winner，losingSpans[].letter === loser）
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-5 Fix-4 span 语义绑定", () => {
  test("winningSpan.letter 与 winner 不一致 → verdict 无效", async () => {
    const modelGenerate = createStubModelGenerateFn((input) => {
      const aMatch = input.userPrompt.match(/【正文 A】\n([\s\S]*?)\n\n【正文 B】/);
      const bMatch = input.userPrompt.match(/【正文 B】\n([\s\S]*?)\n\n请比较/);
      const textA = aMatch ? aMatch[1] : "";
      const textB = bMatch ? bMatch[1] : "";
      const obj = JSON.parse(makeValidVerdictJson("A", textA, textB));
      // 故意把 winningSpan 标成 B（落败方），但 winner 是 A
      // 取 B 正文前 10 字作为 winningSpan excerpt（保证子串校验通过，只触发语义绑定失败）
      obj.winningSpans = [{ letter: "B", excerpt: textB.slice(0, 10) }];
      return { text: JSON.stringify(obj) };
    });

    const result = await runReferenceAwareJudge({
      caseId: "test-semantic-winning-mismatch",
      candidates: STUB_CANDIDATES,
      referenceText: STUB_REFERENCE,
      pairs: [["B0", "B4"]],
      modelGenerate,
      route: "nb5_judge_glm",
      seed: 0,
      rounds: 1,
      timeoutMs: 5000,
    });

    const pr = result.pairResults[0];
    assert.ok(pr.verdicts.every((v) => !v.valid), "winningSpan letter 错位应判无效");
    assert.ok(
      pr.verdicts.every((v) => v.invalidReason?.includes("语义绑定失败")),
      `无效原因应提及语义绑定失败，实际：${pr.verdicts[0]?.invalidReason}`,
    );
    assert.ok(
      pr.verdicts.every((v) => v.invalidReason?.includes("winningSpan")),
      `无效原因应提及 winningSpan，实际：${pr.verdicts[0]?.invalidReason}`,
    );
  });

  test("losingSpan.letter 与 loser 不一致 → verdict 无效", async () => {
    const modelGenerate = createStubModelGenerateFn((input) => {
      const aMatch = input.userPrompt.match(/【正文 A】\n([\s\S]*?)\n\n【正文 B】/);
      const bMatch = input.userPrompt.match(/【正文 B】\n([\s\S]*?)\n\n请比较/);
      const textA = aMatch ? aMatch[1] : "";
      const textB = bMatch ? bMatch[1] : "";
      const obj = JSON.parse(makeValidVerdictJson("A", textA, textB));
      // winner=A, loser=B；故意把 losingSpan 标成 A（胜出方）
      obj.losingSpans = [{ letter: "A", excerpt: textA.slice(0, 10) }];
      return { text: JSON.stringify(obj) };
    });

    const result = await runReferenceAwareJudge({
      caseId: "test-semantic-losing-mismatch",
      candidates: STUB_CANDIDATES,
      referenceText: STUB_REFERENCE,
      pairs: [["B0", "B4"]],
      modelGenerate,
      route: "nb5_judge_glm",
      seed: 0,
      rounds: 1,
      timeoutMs: 5000,
    });

    const pr = result.pairResults[0];
    assert.ok(pr.verdicts.every((v) => !v.valid), "losingSpan letter 错位应判无效");
    assert.ok(
      pr.verdicts.every((v) => v.invalidReason?.includes("语义绑定失败")),
      `无效原因应提及语义绑定失败，实际：${pr.verdicts[0]?.invalidReason}`,
    );
    assert.ok(
      pr.verdicts.every((v) => v.invalidReason?.includes("losingSpan")),
      `无效原因应提及 losingSpan，实际：${pr.verdicts[0]?.invalidReason}`,
    );
  });

  test("多条 winningSpans 中有一条 letter 错位 → verdict 无效", async () => {
    const modelGenerate = createStubModelGenerateFn((input) => {
      const aMatch = input.userPrompt.match(/【正文 A】\n([\s\S]*?)\n\n【正文 B】/);
      const bMatch = input.userPrompt.match(/【正文 B】\n([\s\S]*?)\n\n请比较/);
      const textA = aMatch ? aMatch[1] : "";
      const textB = bMatch ? bMatch[1] : "";
      const obj = JSON.parse(makeValidVerdictJson("A", textA, textB));
      // 第 1 条正确（A），第 2 条错位（B）
      obj.winningSpans = [
        { letter: "A", excerpt: textA.slice(0, 10) },
        { letter: "B", excerpt: textB.slice(0, 10) },
      ];
      return { text: JSON.stringify(obj) };
    });

    const result = await runReferenceAwareJudge({
      caseId: "test-semantic-partial-mismatch",
      candidates: STUB_CANDIDATES,
      referenceText: STUB_REFERENCE,
      pairs: [["B0", "B4"]],
      modelGenerate,
      route: "nb5_judge_glm",
      seed: 0,
      rounds: 1,
      timeoutMs: 5000,
    });

    const pr = result.pairResults[0];
    assert.ok(pr.verdicts.every((v) => !v.valid), "任一 winningSpan letter 错位即判无效");
  });

  test("语义绑定失败后重试，修正 letter → verdict 转为有效", async () => {
    let callCount = 0;
    const modelGenerate = createStubModelGenerateFn((input) => {
      callCount += 1;
      const aMatch = input.userPrompt.match(/【正文 A】\n([\s\S]*?)\n\n【正文 B】/);
      const bMatch = input.userPrompt.match(/【正文 B】\n([\s\S]*?)\n\n请比较/);
      const textA = aMatch ? aMatch[1] : "";
      const textB = bMatch ? bMatch[1] : "";
      // 第 1 次返回错位 winningSpan，触发语义绑定重试
      if (callCount === 1) {
        const obj = JSON.parse(makeValidVerdictJson("A", textA, textB));
        obj.winningSpans = [{ letter: "B", excerpt: textB.slice(0, 10) }];
        return { text: JSON.stringify(obj) };
      }
      // 第 2 次（重试）：检查 retry prompt 是否含语义绑定反馈
      if (callCount === 2) {
        assert.ok(
          input.userPrompt.includes("语义绑定失败"),
          `重试 prompt 应含语义绑定失败反馈，实际：${input.userPrompt.slice(-200)}`,
        );
      }
      return { text: makeValidVerdictJson("A", textA, textB) };
    });

    const result = await runReferenceAwareJudge({
      caseId: "test-semantic-retry-recover",
      candidates: STUB_CANDIDATES,
      referenceText: STUB_REFERENCE,
      pairs: [["B0", "B4"]],
      modelGenerate,
      route: "nb5_judge_glm",
      seed: 0,
      rounds: 1,
      timeoutMs: 5000,
    });

    const pr = result.pairResults[0];
    // 1 轮 = forward + reverse = 2 verdict
    // call 1 (forward 初试, 错位) → call 2 (forward 重试, 正确) → call 3 (reverse, 正确)
    assert.equal(pr.verdicts.length, 2, "应记录 2 个 verdict（forward+reverse）");
    assert.ok(pr.verdicts.every((v) => v.valid), "重试修正后两个 verdict 均应有效");
    assert.equal(callCount, 3, "应调用 3 次（forward 初试 + forward 重试 + reverse）");
    assert.equal(result.totalModelCalls, 3);
  });

  test("回归：letter 正确绑定的 verdict 仍判有效", async () => {
    // 确保新增的语义绑定校验不会误伤合法 verdict
    const modelGenerate = createStubModelGenerateFn(
      createConsistentResponder("B4 最终"),
    );
    const result = await runReferenceAwareJudge({
      caseId: "test-semantic-valid-regression",
      candidates: STUB_CANDIDATES,
      referenceText: STUB_REFERENCE,
      pairs: [["B0", "B4"]],
      modelGenerate,
      route: "nb5_judge_glm",
      seed: 0,
      rounds: 1,
      timeoutMs: 5000,
    });

    const pr = result.pairResults[0];
    assert.ok(pr.verdicts.length > 0, "应有 verdict");
    assert.ok(pr.verdicts.every((v) => v.valid), "合法 letter 绑定的 verdict 应有效");
    for (const v of pr.verdicts) {
      const loserLetter = v.winnerLetter === "A" ? "B" : "A";
      for (const s of v.winningSpans) {
        assert.equal(s.letter, v.winnerLetter, "winningSpan letter 应等于 winner");
      }
      for (const s of v.losingSpans) {
        assert.equal(s.letter, loserLetter, "losingSpan letter 应等于 loser");
      }
    }
  });

  test("winner=B 时 losingSpan.letter 必须为 A（反向场景覆盖）", async () => {
    const modelGenerate = createStubModelGenerateFn((input) => {
      const aMatch = input.userPrompt.match(/【正文 A】\n([\s\S]*?)\n\n【正文 B】/);
      const bMatch = input.userPrompt.match(/【正文 B】\n([\s\S]*?)\n\n请比较/);
      const textA = aMatch ? aMatch[1] : "";
      const textB = bMatch ? bMatch[1] : "";
      const obj = JSON.parse(makeValidVerdictJson("B", textA, textB));
      // winner=B, loser=A；故意把 losingSpan 标成 B（胜出方）
      obj.losingSpans = [{ letter: "B", excerpt: textB.slice(0, 10) }];
      return { text: JSON.stringify(obj) };
    });

    const result = await runReferenceAwareJudge({
      caseId: "test-semantic-winner-b-losing-mismatch",
      candidates: STUB_CANDIDATES,
      referenceText: STUB_REFERENCE,
      pairs: [["B0", "B4"]],
      modelGenerate,
      route: "nb5_judge_glm",
      seed: 0,
      rounds: 1,
      timeoutMs: 5000,
    });

    const pr = result.pairResults[0];
    assert.ok(pr.verdicts.every((v) => !v.valid), "winner=B 时 losingSpan=B 应判无效");
    assert.ok(
      pr.verdicts.every((v) => v.invalidReason?.includes("语义绑定失败")),
      "无效原因应提及语义绑定失败",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. 架构边界
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-5 架构边界", () => {
  test("不 import reference-registry / generator-bundle / dataset-builder / chapter-splitter", () => {
    assert.ok(existsSync(JUDGE_JS), "reference-aware-judge.js 应存在");
    const src = readFileSync(JUDGE_JS, "utf-8");
    const forbiddenImports = [
      'from "./reference-registry',
      'from "./generator-bundle',
      'from "./dataset-builder',
      'from "./leakage-scanner',
      'from "./chapter-splitter',
      'from "./corpus-auditor',
      'from "./partition',
    ];
    for (const pat of forbiddenImports) {
      assert.ok(
        !src.includes(pat),
        `reference-aware-judge.js 不得 import ${pat}（evaluator 隔离：只接收 referenceText 字符串）`,
      );
    }
  });

  test("不含 ReferenceRegistry / registry.resolve 调用（不直接 FS）", () => {
    assert.ok(existsSync(JUDGE_JS));
    const src = readFileSync(JUDGE_JS, "utf-8");
    assert.ok(
      !src.includes("ReferenceRegistry"),
      "不得引用 ReferenceRegistry（reference 由 CLI 解析后传入）",
    );
    // 检查实际代码中的 registry.resolve 调用（注释中出现说明文字可接受）
    assert.ok(
      !/registry\.resolve\s*\(/.test(src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")),
      "不得含 registry.resolve( 代码调用",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. 可复现性
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-5 可复现性", () => {
  test("同 seed 两次运行 → 一致 verdict 数相同", async () => {
    const runOnce = async () => {
      const modelGenerate = createStubModelGenerateFn(
        createConsistentResponder("B4 最终"),
      );
      return runReferenceAwareJudge({
        caseId: "test-repro",
        candidates: STUB_CANDIDATES,
        referenceText: STUB_REFERENCE,
        pairs: [["B0", "B4"]],
        modelGenerate,
        route: "nb5_judge_glm",
        seed: 7,
        rounds: 3,
        timeoutMs: 5000,
      });
    };

    const r1 = await runOnce();
    const r2 = await runOnce();

    assert.equal(r1.pairResults[0].consistentVerdicts.length,
      r2.pairResults[0].consistentVerdicts.length);
    assert.equal(r1.pairResults[0].majorityWinner,
      r2.pairResults[0].majorityWinner);
  });
});
