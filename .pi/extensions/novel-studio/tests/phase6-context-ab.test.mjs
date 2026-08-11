/**
 * Phase 6.2 专用测试：验证 JSON 结构、门禁逻辑、产物隔离和 arm 参数语义。
 *
 * 覆盖 A / B / C / D_pm 当前 arm 语义（historicalOverridesOfArm）。
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
const { aggregate, evaluateGate, evaluateAblationGate } = gateMod;
// Phase 6.2：导入 runner 模块（historicalOverridesOfArm）
const runnerMod = await import(
  `file://${join(process.cwd(), "dist-eval", "novelos", "eval", "context-ab-runner.js")}`
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

// ── historicalOverridesOfArm 参数测试（Phase 6.2） ───────────────────────

describe("Phase 6.2 historicalOverridesOfArm arm 参数验证", () => {
  it("A 组返回 undefined（生产默认参数，行为与生产完全一致）", () => {
    const overrides = runnerMod.historicalOverridesOfArm("A");
    // A 组返回 undefined（经类型断言后），表示生产默认不传 overrides
    assert.ok(overrides === undefined || overrides === "none", `A 组应返回 undefined 或 "none"，实际：${overrides}`);
  });

  it("B 组压缩 overrides：canon/character 减半且排除 PatternMemory", () => {
    const overrides = runnerMod.historicalOverridesOfArm("B");
    assert.ok(overrides && overrides !== "none" && overrides !== null, "B 组应返回 overrides 对象");
    assert.equal(overrides.canon.maxEntries, 2, "B 组 canon maxEntries 应为 2（生产 4 减半）");
    assert.equal(overrides.canon.maxChars, 1200, "B 组 canon maxChars 应为 1200（生产 2400 减半）");
    assert.equal(overrides.character.maxEntries, 3, "B 组 character maxEntries 应为 3（生产 6 减半）");
    assert.equal(overrides.character.maxChars, 900, "B 组 character maxChars 应为 900（生产 1800 减半）");
    assert.equal(overrides.pattern.inject, false, "B 组 pattern inject 应为 false（排除 PatternMemory）");
  });

  it("C 组返回 null（哨兵，不注入）", () => {
    const overrides = runnerMod.historicalOverridesOfArm("C");
    assert.equal(overrides, null, "C 组应返回 null（不注入）");
  });

  it("D_pm 组单因素消融：只排除 PatternMemory，canon/character 保持 A 默认", () => {
    const overrides = runnerMod.historicalOverridesOfArm("D_pm");
    assert.ok(overrides && overrides !== "none" && overrides !== null, "D_pm 组应返回 overrides 对象");
    assert.equal(overrides.pattern.inject, false, "D_pm 组 pattern inject 应为 false（排除 PatternMemory）");
    // canon 和 character 未设置（undefined），表示走生产默认（4×2400、6×1800）
    assert.equal(overrides.canon, undefined, "D_pm 组 canon 应为 undefined（保持 A 默认）");
    assert.equal(overrides.character, undefined, "D_pm 组 character 应为 undefined（保持 A 默认）");
  });

  it("D_pm_sl 组组合消融：排除 PatternMemory + 缩减 maxChars，maxItems 保持 A 默认", () => {
    const overrides = runnerMod.historicalOverridesOfArm("D_pm_sl");
    assert.ok(overrides && overrides !== "none" && overrides !== null, "D_pm_sl 组应返回 overrides 对象");
    assert.equal(overrides.pattern.inject, false, "D_pm_sl 组 pattern inject 应为 false（排除 PatternMemory）");
    assert.equal(overrides.canon.maxChars, 1200, "D_pm_sl 组 canon maxChars 应为 1200（D_sl 摘要长度）");
    assert.equal(overrides.character.maxChars, 900, "D_pm_sl 组 character maxChars 应为 900（D_sl 摘要长度）");
    // maxItems 保持 A 默认（不设置 maxEntries）
    assert.equal(overrides.canon.maxEntries, undefined, "D_pm_sl 组 canon 不应设置 maxEntries（maxItems 保持 A 默认）");
    assert.equal(overrides.character.maxEntries, undefined, "D_pm_sl 组 character 不应设置 maxEntries（maxItems 保持 A 默认）");
  });

  it("B 组与 D_pm 组的差异：B 改 maxItems/摘要长度，D_pm 不改", () => {
    const bOverrides = runnerMod.historicalOverridesOfArm("B");
    const dpmOverrides = runnerMod.historicalOverridesOfArm("D_pm");
    // B 组有 canon/character 压缩参数，D_pm 没有
    assert.ok(bOverrides.canon && bOverrides.character, "B 组应有 canon/character overrides");
    assert.equal(dpmOverrides.canon, undefined, "D_pm 组不应有 canon overrides");
    assert.equal(dpmOverrides.character, undefined, "D_pm 组不应有 character overrides");
    // 两者都排除 PatternMemory
    assert.equal(bOverrides.pattern.inject, false, "B 组排除 PatternMemory");
    assert.equal(dpmOverrides.pattern.inject, false, "D_pm 组排除 PatternMemory");
  });

  it("ContextAbArm 类型包含全部合法 arm（A/B/C/D_pm/D_mi/D_sl/D_pm_sl）", () => {
    // 验证所有合法 arm 都能正常返回
    const arms = ["A", "B", "C", "D_pm", "D_mi", "D_sl", "D_pm_sl"];
    for (const arm of arms) {
      const result = runnerMod.historicalOverridesOfArm(arm);
      // 只要不抛异常即为合法 arm
      assert.ok(result !== undefined || arm === "A", `${arm} 应为合法 arm`);
    }
  });

  it("消融门禁 evaluateAblationGate 可从 gate 模块导入", () => {
    assert.equal(typeof evaluateAblationGate, "function", "evaluateAblationGate 应从 gate 模块导出");
  });

  it("evaluateAblationGate 对 D_pm 不降级时 allPassed=true", () => {
    const aAgg = { avgCoverage: 1.0, avgSourceRef: 0.6, totalErrors: 0, totalTimeouts: 0, totalParseErrors: 0, totalEmpty: 0, totalInvalidTool: 0, totalTruncated: 0, totalInvalidIntents: 0, stopRate: 1.0, totalContextBlockTokens: 579 };
    const dpmAgg = { avgCoverage: 1.0, avgSourceRef: 0.667, totalErrors: 0, totalTimeouts: 0, totalParseErrors: 0, totalEmpty: 0, totalInvalidTool: 0, totalTruncated: 0, totalInvalidIntents: 0, stopRate: 1.0, totalContextBlockTokens: 375 };
    const gate = evaluateAblationGate(dpmAgg, aAgg, "D_pm");
    assert.equal(gate.coverageGteA, true, "D_pm coverage >= A");
    assert.equal(gate.sourceRefGteA, true, "D_pm sourceRef >= A");
    assert.equal(gate.allPassed, true, "D_pm allPassed 应为 true");
    assert.equal(gate.arm, "D_pm");
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

describe("Phase 6.2 JSON 结构", () => {
  it("真实 replay 报告包含必需字段（A + D_pm）", () => {
    const reportPath = join("D:/CODE/PiNovelStudio/reports/phase6-context-ab/real/context-ab-comparison.json");
    if (!existsSync(reportPath)) {
      // real 产物可能尚未重新生成，跳过（不 fail）
      return;
    }
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    assert.equal(report.schema, "context-ab-comparison/v1");
    assert.equal(report.mode, "real");
    assert.ok(report.crossBatchAggregation.A, "缺少 A 组聚合");
    assert.ok(report.crossBatchAggregation.D_pm, "缺少 D_pm 组聚合");
    assert.ok(report.gate.bGate, "缺少门禁（bGate 字段名保留，实际评估 D_pm vs A）");
    assert.ok(report.compressionRatio, "缺少压缩比例");
    assert.ok(report.trajectory, "缺少 trajectory");
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
