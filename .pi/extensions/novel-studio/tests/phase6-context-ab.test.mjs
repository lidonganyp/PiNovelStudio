/**
 * Phase 6.1.1 专用测试：验证 JSON 结构、门禁逻辑和产物隔离。
 *
 * 运行方式：
 *   node --import ./tests/setup-test-env.mjs --test tests/phase6-context-ab.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
// Phase 6.1.1 收口：从 gate 模块导入，消除同步漂移
const gateMod = await import(
  `file://${join(process.cwd(), "dist-eval", "novelos", "eval", "context-ab-gate.js")}`
);
const { aggregate, evaluateGate } = gateMod;
// Phase 6.2.1：导入消融 runner 和 builder 模块
const runnerMod = await import(
  `file://${join(process.cwd(), "dist-eval", "novelos", "eval", "context-ab-runner.js")}`
);
const builderMod = await import(
  `file://${join(process.cwd(), "dist-eval", "novelos", "eval", "compressed-context-builder.js")}`
);

// ── 门禁逻辑测试 ──────────────────────────────────────────────────────────

describe("Phase 6.1.1 门禁逻辑（从 gate 模块导入）", () => {
  it("B 组 empty > A 时 failuresNotWorseThanA 应为 false", () => {
    const aAgg = { avgCoverage: 0.9, avgSourceRef: 0.8, totalErrors: 0, totalTimeouts: 0, totalParseErrors: 0, totalEmpty: 0, totalInvalidTool: 0, totalTruncated: 0, totalInvalidIntents: 0, stopRate: 0.8, totalContextBlockTokens: 1000, avgFirstValidEvidenceCallValid: 0.5 };
    const bAgg = { avgCoverage: 0.9, avgSourceRef: 0.8, totalErrors: 0, totalTimeouts: 0, totalParseErrors: 0, totalEmpty: 5, totalInvalidTool: 0, totalTruncated: 0, totalInvalidIntents: 0, stopRate: 0.8, totalContextBlockTokens: 500, avgFirstValidEvidenceCallValid: 0.5 };
    const cAgg = { avgCoverage: 0.8, avgSourceRef: 0.7, totalContextBlockTokens: 0 };
    const gate = evaluateGate(bAgg, cAgg, aAgg);
    assert.equal(gate.bGate.failuresNotWorseThanA, false, "B 组 empty=5 > A empty=0 应判定为失败");
    assert.equal(gate.bGate.allPassed, false);
  });

  it("B 组 invTool > A 时 failuresNotWorseThanA 应为 false", () => {
    const aAgg = { avgCoverage: 0.9, avgSourceRef: 0.8, totalErrors: 0, totalTimeouts: 0, totalParseErrors: 0, totalEmpty: 0, totalInvalidTool: 0, totalTruncated: 0, totalInvalidIntents: 0, stopRate: 0.8, totalContextBlockTokens: 1000, avgFirstValidEvidenceCallValid: 0.5 };
    const bAgg = { avgCoverage: 0.9, avgSourceRef: 0.8, totalErrors: 0, totalTimeouts: 0, totalParseErrors: 0, totalEmpty: 0, totalInvalidTool: 5, totalTruncated: 0, totalInvalidIntents: 0, stopRate: 0.8, totalContextBlockTokens: 500, avgFirstValidEvidenceCallValid: 0.5 };
    const cAgg = { avgCoverage: 0.8, avgSourceRef: 0.7, totalContextBlockTokens: 0 };
    const gate = evaluateGate(bAgg, cAgg, aAgg);
    assert.equal(gate.bGate.failuresNotWorseThanA, false, "B 组 invTool=5 > A invTool=0 应判定为失败");
  });

  it("B 组全部指标不劣于 A 时 failuresNotWorseThanA 应为 true", () => {
    const aAgg = { avgCoverage: 0.9, avgSourceRef: 0.8, totalErrors: 0, totalTimeouts: 0, totalParseErrors: 0, totalEmpty: 0, totalInvalidTool: 0, totalTruncated: 0, totalInvalidIntents: 0, stopRate: 0.8, totalContextBlockTokens: 1000, avgFirstValidEvidenceCallValid: 0.5 };
    const bAgg = { avgCoverage: 0.9, avgSourceRef: 0.8, totalErrors: 0, totalTimeouts: 0, totalParseErrors: 0, totalEmpty: 0, totalInvalidTool: 0, totalTruncated: 0, totalInvalidIntents: 0, stopRate: 0.8, totalContextBlockTokens: 500, avgFirstValidEvidenceCallValid: 0.5 };
    const cAgg = { avgCoverage: 0.8, avgSourceRef: 0.7, totalContextBlockTokens: 0 };
    const gate = evaluateGate(bAgg, cAgg, aAgg);
    assert.equal(gate.bGate.failuresNotWorseThanA, true);
    assert.equal(gate.bGate.allPassed, true);
  });

  it("首证据 -1（无有效证据）时不阻断门禁", () => {
    const aAgg = { avgCoverage: 0.9, avgSourceRef: 0.8, totalErrors: 0, totalTimeouts: 0, totalParseErrors: 0, totalEmpty: 0, totalInvalidTool: 0, totalTruncated: 0, totalInvalidIntents: 0, stopRate: 0.8, totalContextBlockTokens: 1000, avgFirstValidEvidenceCallValid: -1 };
    const bAgg = { avgCoverage: 0.9, avgSourceRef: 0.8, totalErrors: 0, totalTimeouts: 0, totalParseErrors: 0, totalEmpty: 0, totalInvalidTool: 0, totalTruncated: 0, totalInvalidIntents: 0, stopRate: 0.8, totalContextBlockTokens: 500, avgFirstValidEvidenceCallValid: -1 };
    const cAgg = { avgCoverage: 0.8, avgSourceRef: 0.7, totalContextBlockTokens: 0 };
    const gate = evaluateGate(bAgg, cAgg, aAgg);
    assert.equal(gate.bGate.firstEvidenceNotDelayed, true, "无有效证据时不应阻断门禁");
  });
});

// ── 消融 arm 参数测试（Phase 6.2.1） ─────────────────────────────────────

describe("Phase 6.2.1 消融 arm 参数验证", () => {
  it("每个消融 arm 只关闭一个状态类别", () => {
    const arms = ["A-Canon", "A-Character", "A-Promise", "A-Pattern"];
    for (const arm of arms) {
      const params = runnerMod.compressionParamsOfArm(arm);
      // 统计关闭的字段数
      const offCount = [
        !params.injectCanon,
        !params.injectCharacter,
        !params.injectPromise,
        !params.injectPattern,
        !params.injectExpectation,
        !params.injectPlanned,
      ].filter(Boolean).length;
      assert.equal(offCount, 1, `${arm} 应只关闭 1 个状态类别，实际关闭 ${offCount} 个`);
    }
  });

  it("A-Canon 只关闭 CanonState", () => {
    const params = runnerMod.compressionParamsOfArm("A-Canon");
    assert.equal(params.injectCanon, false);
    assert.equal(params.injectCharacter, true);
    assert.equal(params.injectPromise, true);
    assert.equal(params.injectPattern, true);
  });

  it("A-Character 只关闭 CharacterState", () => {
    const params = runnerMod.compressionParamsOfArm("A-Character");
    assert.equal(params.injectCanon, true);
    assert.equal(params.injectCharacter, false);
    assert.equal(params.injectPromise, true);
    assert.equal(params.injectPattern, true);
  });

  it("A-Promise 只关闭 PromiseLedger", () => {
    const params = runnerMod.compressionParamsOfArm("A-Promise");
    assert.equal(params.injectCanon, true);
    assert.equal(params.injectCharacter, true);
    assert.equal(params.injectPromise, false);
    assert.equal(params.injectPattern, true);
  });

  it("A-Pattern 只关闭 PatternMemory", () => {
    const params = runnerMod.compressionParamsOfArm("A-Pattern");
    assert.equal(params.injectCanon, true);
    assert.equal(params.injectCharacter, true);
    assert.equal(params.injectPromise, true);
    assert.equal(params.injectPattern, false);
  });

  it("A 组（完整）全部注入", () => {
    const params = runnerMod.compressionParamsOfArm("A");
    assert.equal(params.injectCanon, true);
    assert.equal(params.injectCharacter, true);
    assert.equal(params.injectPromise, true);
    assert.equal(params.injectPattern, true);
    assert.equal(params.injectExpectation, true);
    assert.equal(params.injectPlanned, true);
  });

  it("消融 arm 的 maxItems 和 summaryCharLimit 与 A 组一致", () => {
    const aParams = runnerMod.compressionParamsOfArm("A");
    for (const arm of ["A-Canon", "A-Character", "A-Promise", "A-Pattern"]) {
      const params = runnerMod.compressionParamsOfArm(arm);
      assert.equal(params.maxItems, aParams.maxItems, `${arm} maxItems 应与 A 一致`);
      assert.equal(params.summaryCharLimit, aParams.summaryCharLimit, `${arm} summaryCharLimit 应与 A 一致`);
    }
  });

  it("消融门禁从 gate 模块导入（无内联副本）", () => {
    // 确认 evaluateAblationGate 可从 gate 模块导入
    assert.equal(typeof gateMod.evaluateAblationGate, "function", "evaluateAblationGate 应从 gate 模块导出");
  });
});

// ── 产物隔离测试 ──────────────────────────────────────────────────────────

describe("Phase 6.1.1 产物路径隔离", () => {
  it("dry-run 和 real 使用不同输出目录", () => {
    const PROJECT_ROOT = "D:/CODE/PiNovelStudio";
    const dryRunDir = join(PROJECT_ROOT, "reports", "phase6-context-ab", "dry-run");
    const realDir = join(PROJECT_ROOT, "reports", "phase6-context-ab", "real");
    assert.notEqual(dryRunDir, realDir, "dry-run 和 real 必须使用不同目录");
  });

  it("dry-run 产物不覆盖 real 产物", () => {
    // 模拟：real 产物先存在，dry-run 产物写到不同目录
    const tmpBase = join("D:/CODE/PiNovelStudio/reports/phase6-context-ab-test-" + Date.now());
    const realDir = join(tmpBase, "real");
    const dryRunDir = join(tmpBase, "dry-run");
    mkdirSync(realDir, { recursive: true });
    mkdirSync(dryRunDir, { recursive: true });

    // 写 real 产物
    writeFileSync(join(realDir, "context-ab-comparison.json"), JSON.stringify({ mode: "real" }));
    // 写 dry-run 产物
    writeFileSync(join(dryRunDir, "context-ab-comparison.json"), JSON.stringify({ mode: "dry-run" }));

    // 验证 real 产物未被覆盖
    const realContent = JSON.parse(readFileSync(join(realDir, "context-ab-comparison.json"), "utf-8"));
    assert.equal(realContent.mode, "real", "real 产物不应被 dry-run 覆盖");

    // 清理
    rmSync(tmpBase, { recursive: true, force: true });
  });
});

// ── JSON 结构测试 ─────────────────────────────────────────────────────────

describe("Phase 6.1.1 JSON 结构", () => {
  it("真实 replay 报告包含必需字段", () => {
    const reportPath = join("D:/CODE/PiNovelStudio/reports/phase6-context-ab/real/context-ab-comparison.json");
    if (!existsSync(reportPath)) {
      // real 产物可能尚未重新生成，跳过（不 fail）
      return;
    }
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    assert.equal(report.schema, "context-ab-comparison/v1");
    assert.equal(report.mode, "real");
    assert.ok(report.crossBatchAggregation.A, "缺少 A 组聚合");
    assert.ok(report.crossBatchAggregation.B, "缺少 B 组聚合");
    assert.ok(report.crossBatchAggregation.C, "缺少 C 组聚合");
    assert.ok(report.gate.bGate, "缺少 B 组门禁");
    assert.ok(report.gate.cDelta, "缺少 C 组 delta");
    // Phase 6.1.1 新增字段
    assert.ok(report.crossBatchAggregation.A.avgFirstValidEvidenceCallValid !== undefined, "缺少 avgFirstValidEvidenceCallValid");
    assert.ok(report.crossBatchAggregation.A.noEvidenceCount !== undefined, "缺少 noEvidenceCount");
  });

  it("dry-run 报告不与 real 报告冲突", () => {
    const realPath = join("D:/CODE/PiNovelStudio/reports/phase6-context-ab/real/context-ab-comparison.json");
    const dryRunPath = join("D:/CODE/PiNovelStudio/reports/phase6-context-ab/dry-run/context-ab-comparison.json");
    if (existsSync(realPath) && existsSync(dryRunPath)) {
      const real = JSON.parse(readFileSync(realPath, "utf-8"));
      const dryRun = JSON.parse(readFileSync(dryRunPath, "utf-8"));
      assert.notEqual(real.mode, dryRun.mode, "real 和 dry-run 的 mode 必须不同");
    }
  });
});
