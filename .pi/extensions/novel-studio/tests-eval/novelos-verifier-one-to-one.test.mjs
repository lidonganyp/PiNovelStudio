/**
 * NovelOS Verifier 一对一计分测试（P0-2）
 *
 * 验证 evalVerifier 使用一对一贪心匹配，一个 actual finding 最多贡献一个 TP。
 *
 * 回归用例：
 * - F1：1 个 actual finding、3 个相似 expected finding → 只得 1 TP（旧 bug 给 2 TP）
 * - 2 个 actual findings 最多 2 TP
 * - 无对应 expected 的 actual finding 计入 unmatchedActual 且 falsePositives +1
 * - actualHardFindings < truePositives 视为评测结构错误（安全网）
 * - 负控 fixture（expectedFindings=0）不再因 0/0 默认 precision=1
 *
 * 测试从 dist/ 导入构建产物（与现有 novelos-*.test.mjs 一致）。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
// novelos/eval/* 模块是 dormant-from-prod（PROD-BUILD-BOUNDARY-1 后退出生产构建），
// 只存在于 dist-eval/novelos/eval/。生产 dist/novelos/ 不含 eval 子目录。
const DIST_ROOT = join(EXTENSION_ROOT, "dist-eval");

const evalHarnessUrl = pathToFileURL(
  join(DIST_ROOT, "novelos", "eval", "eval-harness.js"),
).href;
const fixturesUrl = pathToFileURL(
  join(DIST_ROOT, "novelos", "eval", "fixtures.js"),
).href;

const { evalVerifier } = await import(evalHarnessUrl);
const { EVAL_FIXTURES } = await import(fixturesUrl);

// ============================================================================
// 辅助：构造最小负控 fixture
// ============================================================================

function makeNegativeControlFixture({ candidateWithErrors, healthyCandidate }) {
  return {
    id: "test-negative-control",
    name: "测试负控",
    description: "P0-2 负控测试",
    category: "negative_control",
    workspace: {
      workspaceId: "test-nc",
      config: { novelType: "都市", characters: [{ name: "陈默", role: "主角" }] },
      historicalChapters: [],
      narrativeState: {},
    },
    chapterIntent: {
      chapterNumber: 1,
      chapterId: "ch1",
      relevantCharacters: ["陈默"],
      inviolableFacts: [],
      retrievalQueries: [],
    },
    expected: {
      factsRetrievable: [],
      factsInCompiledContext: [],
      requiresRetrieval: false,
      expectedVerifierFindings: [], // 负控：无预期 finding
      candidateWithErrors,
      healthyCandidate,
    },
  };
}

// ============================================================================
// 测试
// ============================================================================

describe("NovelOS Verifier 一对一计分（P0-2）", () => {
  test("F1：1 个 actual finding、3 个相似 expected → 只得 1 TP（回归旧 bug 给 2 TP）", () => {
    const fixture = EVAL_FIXTURES[0]; // F1-historical-fact
    const result = evalVerifier(fixture);
    // F1 旧报告：actualHardFindings=1, truePositives=2（bug：一个 actual 匹配多个 expected）
    // P0-2 修复后：truePositives 应 <= actualHardFindings
    assert.ok(
      result.truePositives <= result.actualHardFindings,
      `truePositives(${result.truePositives}) 应 <= actualHardFindings(${result.actualHardFindings})`,
    );
    // F1 有 3 个 expected，1 个 actual → 最多 1 TP，2 个 unmatched expected
    assert.equal(result.truePositives, 1, "F1 1 个 actual 最多 1 TP");
    assert.equal(result.unmatchedExpected.length, 2, "F1 应有 2 个未匹配 expected");
    assert.equal(result.findingMatches.length, 1, "F1 应有 1 个匹配明细");
  });

  test("所有 fixture 满足一对一不变式：truePositives <= actualHardFindings", () => {
    for (const fixture of EVAL_FIXTURES) {
      const result = evalVerifier(fixture);
      assert.ok(
        result.truePositives <= result.actualHardFindings,
        `${fixture.id}: truePositives(${result.truePositives}) > actualHardFindings(${result.actualHardFindings})，一对一被破坏`,
      );
      assert.ok(
        result.truePositives <= result.expectedFindings,
        `${fixture.id}: truePositives(${result.truePositives}) > expectedFindings(${result.expectedFindings})`,
      );
    }
  });

  test("所有 fixture 的 findingMatches 无重复 actualFindingId（一个 actual 最多贡献一个 TP）", () => {
    for (const fixture of EVAL_FIXTURES) {
      const result = evalVerifier(fixture);
      const actualIds = result.findingMatches.map((m) => m.actualFindingId);
      const uniqueIds = new Set(actualIds);
      assert.equal(
        actualIds.length,
        uniqueIds.size,
        `${fixture.id}: findingMatches 中存在重复 actualFindingId`,
      );
    }
  });

  test("F3：2 个 actual findings 最多 2 TP", () => {
    const fixture = EVAL_FIXTURES[2]; // F3-continuity-conflict
    const result = evalVerifier(fixture);
    // F3 报告：actualHardFindings=2, expectedFindings=3
    assert.ok(
      result.truePositives <= 2,
      `F3: 2 个 actual 最多 2 TP，实际 ${result.truePositives}`,
    );
    assert.ok(result.truePositives <= result.actualHardFindings, "F3 一对一不变式");
  });

  test("unmatched actual finding 计入 falsePositives", () => {
    for (const fixture of EVAL_FIXTURES) {
      const result = evalVerifier(fixture);
      // falsePositives 应 >= unmatchedActual.length（还可能含健康候选误报）
      assert.ok(
        result.falsePositives >= result.unmatchedActual.length,
        `${fixture.id}: falsePositives(${result.falsePositives}) < unmatchedActual.length(${result.unmatchedActual.length})`,
      );
    }
  });

  test("负控 fixture（expectedFindings=0, 无误报）→ precision=1, isNegativeControl=true", () => {
    const fixture = makeNegativeControlFixture({
      candidateWithErrors: "陈默坐在上海陆家嘴的办公室里，盯着屏幕上的代码。",
      healthyCandidate: "陈默坐在上海陆家嘴的办公室里，盯着屏幕上的代码。",
    });
    const result = evalVerifier(fixture);
    assert.equal(result.isNegativeControl, true, "应为负控");
    assert.equal(result.expectedFindings, 0, "无预期 finding");
    assert.equal(result.truePositives, 0, "无 TP");
    // 无误报 → precision=1
    assert.equal(result.precision, 1, "无误报的负控 precision 应为 1");
  });

  test("负控 fixture + 健康候选有误报 → precision=0", () => {
    // 构造一个健康候选会触发误报的场景：inviolableFacts 含事实但正文不含
    const fixture = makeNegativeControlFixture({
      candidateWithErrors: "陈默坐在上海陆家嘴的办公室里，盯着屏幕上的代码。",
      healthyCandidate: "陈默坐在上海陆家嘴的办公室里，盯着屏幕上的代码。",
    });
    // 加 inviolableFacts 触发 intent omission 误报
    fixture.chapterIntent.inviolableFacts = ["必须包含的关键事实XYZ"];
    const result = evalVerifier(fixture);
    assert.equal(result.isNegativeControl, true, "仍应为负控");
    // 若 verifier 在健康候选上发现 hard finding → precision=0
    if (result.falsePositives > 0) {
      assert.equal(result.precision, 0, "有误报的负控 precision 应为 0");
    }
  });

  test("返回结构包含 findingMatches/unmatchedExpected/unmatchedActual/isNegativeControl", () => {
    for (const fixture of EVAL_FIXTURES) {
      const result = evalVerifier(fixture);
      assert.ok(Array.isArray(result.findingMatches), `${fixture.id}: findingMatches 应为数组`);
      assert.ok(Array.isArray(result.unmatchedExpected), `${fixture.id}: unmatchedExpected 应为数组`);
      assert.ok(Array.isArray(result.unmatchedActual), `${fixture.id}: unmatchedActual 应为数组`);
      assert.equal(typeof result.isNegativeControl, "boolean", `${fixture.id}: isNegativeControl 应为 boolean`);
    }
  });
});
