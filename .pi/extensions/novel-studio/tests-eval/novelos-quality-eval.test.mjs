/**
 * NovelOS 质量评测测试（P1-1）
 *
 * 用 stub modelGenerate 测试 runQualityEval 控制流（不调真实 API）。
 *
 * 验证：
 * - B1/B2/B3 共用同一 modelGenerate（通过计数器验证 3 条 baseline 都调了同一函数）
 * - provenance 记录但不进盲测包
 * - 盲测包不含 baseline 名称（A.txt/B.txt/C.txt + mapping.csv）
 * - 聚合指标计算正确（avgB1Coverage/avgB2Coverage/avgB3Coverage/b3FixedB2Rate）
 * - perFixture 结构完整（含 b1Text/b2Text/b3Text/modelCalls/fallbacks）
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
// novelos/eval/* 模块是 dormant-from-prod（PROD-BUILD-BOUNDARY-1 后退出生产构建），
// 只存在于 dist-eval/novelos/eval/。生产 dist/novelos/ 不含 eval 子目录。
const DIST_ROOT = join(EXTENSION_ROOT, "dist-eval");

// 从 dist/ 导入 eval 模块
const evalHarnessUrl = pathToFileURL(
  join(DIST_ROOT, "novelos", "eval", "eval-harness.js"),
).href;
const fixturesUrl = pathToFileURL(
  join(DIST_ROOT, "novelos", "eval", "fixtures.js"),
).href;

const hasBuild = existsSync(join(DIST_ROOT, "novelos", "eval", "eval-harness.js"));

const {
  runQualityEval,
  formatQualityReportAsMarkdown,
} = await import(evalHarnessUrl);
const { EVAL_FIXTURES } = await import(fixturesUrl);

// ============================================================================
// 测试用 stub modelGenerate（计数器验证 B1/B2/B3 共用）
// ============================================================================

/**
 * 创建计数器 stub modelGenerate。
 * 记录调用次数，返回 fixture 的预期文本（模拟真实模型的输出差异）。
 */
function createCountingStubModelGenerate() {
  let callCount = 0;
  const calls = [];
  const fn = async (input) => {
    callCount++;
    calls.push({ route: input.route, kind: input.kind, userPromptPreview: input.userPrompt.slice(0, 50) });
    // 返回简单文本（不模拟 ReAct 工具调用，只验证控制流）
    return {
      text: `stub-quality-output-${callCount}`,
      model: "stub-quality-model",
      route: input.route,
      durationMs: 1,
    };
  };
  return { fn, getCallCount: () => callCount, getCalls: () => calls };
}

// ============================================================================
// 测试
// ============================================================================

describe("NovelOS 质量评测（P1-1）", { skip: !hasBuild ? "dist/ 不存在，先 npm run build" : false }, () => {
  test("B1/B2/B3 共用同一 modelGenerate（通过计数器验证）", async () => {
    const counter = createCountingStubModelGenerate();
    // 只跑 1 个 fixture 加快速度
    const fixtures = EVAL_FIXTURES.slice(0, 1);
    const report = await runQualityEval(fixtures, counter.fn, "narrator_primary");

    // stub 不发 tool_call，但每条 baseline 至少调 1 次模型
    assert.ok(counter.getCallCount() >= 3, `B1/B2/B3 应至少各调 1 次 modelGenerate，实际 ${counter.getCallCount()}`);

    // 所有调用的 route 一致（共用同一路由）
    for (const call of counter.getCalls()) {
      assert.equal(call.route, "narrator_primary", `route 应为 narrator_primary，实际 ${call.route}`);
    }

    // 报告结构正确
    assert.equal(report.totalFixtures, 1);
    assert.ok(report.perFixture.length === 1);
  });

  test("provenance 记录 model/route/samplingParams", async () => {
    const counter = createCountingStubModelGenerate();
    const fixtures = EVAL_FIXTURES.slice(0, 1);
    const report = await runQualityEval(fixtures, counter.fn, "narrator_primary");

    assert.ok(report.provenance, "provenance 应存在");
    assert.equal(report.provenance.route, "narrator_primary");
    assert.equal(typeof report.provenance.model, "string");
    assert.ok(report.provenance.samplingParams, "samplingParams 应存在");
    assert.ok(report.provenance.samplingParams.temperature !== undefined, "temperature 应有值");
    assert.ok(report.provenance.samplingParams.maxTokens !== undefined, "maxTokens 应有值");
  });

  test("盲测包不含 baseline 名称（A.txt/B.txt/C.txt 文本匿名，mapping.csv 是答案钥）", async () => {
    const counter = createCountingStubModelGenerate();
    const fixtures = EVAL_FIXTURES.slice(0, 1);
    const report = await runQualityEval(fixtures, counter.fn, "narrator_primary");

    assert.ok(existsSync(report.blindTestDir), "盲测包目录应存在");
    const fixtureDir = join(report.blindTestDir, fixtures[0].id);
    assert.ok(existsSync(join(fixtureDir, "A.txt")), "A.txt 应存在");
    assert.ok(existsSync(join(fixtureDir, "B.txt")), "B.txt 应存在");
    assert.ok(existsSync(join(fixtureDir, "C.txt")), "C.txt 应存在");
    assert.ok(existsSync(join(fixtureDir, "mapping.csv")), "mapping.csv 应存在");

    // A/B/C 文件内容是给裁判看的候选正文，不应包含 baseline 标识
    // （mapping.csv 是答案钥，不暴露给裁判，可含 b1/b2/b3）
    const aContent = readFileSync(join(fixtureDir, "A.txt"), "utf-8");
    const bContent = readFileSync(join(fixtureDir, "B.txt"), "utf-8");
    const cContent = readFileSync(join(fixtureDir, "C.txt"), "utf-8");
    assert.ok(!aContent.includes("baseline:") && !aContent.includes("mode:"), "A.txt 不应含 baseline/mode 标识");
    assert.ok(!bContent.includes("baseline:") && !bContent.includes("mode:"), "B.txt 不应含 baseline/mode 标识");
    assert.ok(!cContent.includes("baseline:") && !cContent.includes("mode:"), "C.txt 不应含 baseline/mode 标识");

    // mapping.csv 是答案钥，应包含 source 标识（b1/b2/b3）供后续解盲
    const mappingContent = readFileSync(join(fixtureDir, "mapping.csv"), "utf-8");
    assert.ok(mappingContent.includes("b1") || mappingContent.includes("b2") || mappingContent.includes("b3"),
      "mapping.csv 应包含 source 标识（b1/b2/b3）作为答案钥");
  });

  test("perFixture 结构完整（含 b1Text/b2Text/b3Text/modelCalls/fallbacks）", async () => {
    const counter = createCountingStubModelGenerate();
    const fixtures = EVAL_FIXTURES.slice(0, 1);
    const report = await runQualityEval(fixtures, counter.fn, "narrator_primary");

    const r = report.perFixture[0];
    assert.equal(typeof r.b1Text, "string", "b1Text 应为 string");
    assert.equal(typeof r.b2Text, "string", "b2Text 应为 string");
    assert.equal(typeof r.b3Text, "string", "b3Text 应为 string");
    assert.equal(typeof r.b1HasRequiredFacts, "boolean", "b1HasRequiredFacts 应为 boolean");
    assert.equal(typeof r.b2HasRequiredFacts, "boolean", "b2HasRequiredFacts 应为 boolean");
    assert.equal(typeof r.b3HasRequiredFacts, "boolean", "b3HasRequiredFacts 应为 boolean");
    assert.equal(typeof r.b3FixedB2Issues, "boolean", "b3FixedB2Issues 应为 boolean");
    assert.equal(typeof r.b2HardFindingCount, "number", "b2HardFindingCount 应为 number");
    assert.equal(typeof r.b3HardFindingCount, "number", "b3HardFindingCount 应为 number");
    assert.ok(r.modelCalls, "modelCalls 应存在");
    assert.equal(typeof r.modelCalls.b1, "number", "modelCalls.b1 应为 number");
    assert.equal(typeof r.modelCalls.b2, "number", "modelCalls.b2 应为 number");
    assert.equal(typeof r.modelCalls.b3, "number", "modelCalls.b3 应为 number");
    assert.ok(r.fallbacks, "fallbacks 应存在");
    assert.equal(typeof r.fallbacks.b1, "boolean", "fallbacks.b1 应为 boolean");
    assert.equal(typeof r.fallbacks.b2, "boolean", "fallbacks.b2 应为 boolean");
    assert.equal(typeof r.fallbacks.b3, "boolean", "fallbacks.b3 应为 boolean");
  });

  test("聚合指标计算正确（覆盖率/增益/修复率）", async () => {
    const counter = createCountingStubModelGenerate();
    const fixtures = EVAL_FIXTURES.slice(0, 2);
    const report = await runQualityEval(fixtures, counter.fn, "narrator_primary");

    assert.equal(report.totalFixtures, 2);
    assert.equal(report.perFixture.length, 2);

    // 覆盖率应在 [0, 1] 范围
    assert.ok(report.summary.avgB1Coverage >= 0 && report.summary.avgB1Coverage <= 1, `avgB1Coverage 超范围：${report.summary.avgB1Coverage}`);
    assert.ok(report.summary.avgB2Coverage >= 0 && report.summary.avgB2Coverage <= 1, `avgB2Coverage 超范围：${report.summary.avgB2Coverage}`);
    assert.ok(report.summary.avgB3Coverage >= 0 && report.summary.avgB3Coverage <= 1, `avgB3Coverage 超范围：${report.summary.avgB3Coverage}`);

    // 增益 = B2 - B1
    const expectedB2OverB1 = report.summary.avgB2Coverage - report.summary.avgB1Coverage;
    assert.ok(
      Math.abs(report.summary.avgB2OverB1FactCoverage - expectedB2OverB1) < 0.001,
      `avgB2OverB1FactCoverage=${report.summary.avgB2OverB1FactCoverage} 应等于 B2-B1=${expectedB2OverB1}`,
    );

    // B3 修复率在 [0, 1]
    assert.ok(report.summary.b3FixedB2Rate >= 0 && report.summary.b3FixedB2Rate <= 1, `b3FixedB2Rate 超范围：${report.summary.b3FixedB2Rate}`);
  });

  test("formatQualityReportAsMarkdown 包含关键章节", async () => {
    const counter = createCountingStubModelGenerate();
    const fixtures = EVAL_FIXTURES.slice(0, 1);
    const report = await runQualityEval(fixtures, counter.fn, "narrator_primary");

    const md = formatQualityReportAsMarkdown(report);
    assert.ok(md.includes("# NovelOS M1 质量评测报告"), "应包含标题");
    assert.ok(md.includes("## 聚合指标"), "应包含聚合指标章节");
    assert.ok(md.includes("## 各 Fixture 详情"), "应包含各 Fixture 详情章节");
    assert.ok(md.includes("## Provenance"), "应包含 Provenance 章节");
    assert.ok(md.includes("narrator_primary"), "应包含路由名");
    assert.ok(md.includes(fixtures[0].id), "应包含 fixture id");
  });
});
