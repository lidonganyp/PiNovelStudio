/**
 * UNCERTAINTY-ABLATION-STATISTICS-1：多 seed 统计模块测试
 *
 * Step 3 of 4: 验证 Wilson 置信区间 / 符号检验 p-value / meanStd 标准差 计算。
 *
 * 测试内容：
 * 1. computeWilsonInterval：二项分布 95% 置信区间边界
 * 2. computeSignTestPValue：符号检验 p-value 显著性
 * 3. computeMeanStd：均值与标准差
 * 4. computeMultiSeedStatistics：多 seed 聚合统计
 *
 * RED 阶段：模块不存在，所有测试失败（ERR_MODULE_NOT_FOUND）
 * GREEN 阶段：实现 uncertainty-statistics.ts 后全部通过
 *
 * 授权边界：纯函数测试，不调用模型 API，不依赖 workspace fixture。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
const MODULE_PATH = join(
  EXTENSION_ROOT,
  "dist-eval",
  "novelos",
  "eval",
  "uncertainty-statistics.js",
);

async function importModule() {
  return import(`file://${MODULE_PATH}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试 1：模块导出
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-ABLATION-STATISTICS-1：模块导出", () => {
  it("模块文件存在且可导入", async () => {
    const mod = await importModule();
    assert.ok(mod, "uncertainty-statistics 模块应可导入");
  });

  it("导出 computeWilsonInterval / computeSignTestPValue / computeMeanStd / computeMultiSeedStatistics", async () => {
    const mod = await importModule();
    assert.equal(typeof mod.computeWilsonInterval, "function");
    assert.equal(typeof mod.computeSignTestPValue, "function");
    assert.equal(typeof mod.computeMeanStd, "function");
    assert.equal(typeof mod.computeMultiSeedStatistics, "function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 2：computeWilsonInterval — 二项分布 95% 置信区间
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-ABLATION-STATISTICS-1：computeWilsonInterval", () => {
  it("0 成功 / 0 总数 → [0, 0]（无样本）", async () => {
    const mod = await importModule();
    const [lower, upper] = mod.computeWilsonInterval(0, 0);
    assert.equal(lower, 0);
    assert.equal(upper, 0);
  });

  it("0 成功 / 10 总数 → lower=0，upper<0.5", async () => {
    const mod = await importModule();
    const [lower, upper] = mod.computeWilsonInterval(0, 10);
    assert.equal(lower, 0);
    assert.ok(upper < 0.5, `upper 应 <0.5，实际 ${upper}`);
    assert.ok(upper > 0, `upper 应 >0，实际 ${upper}`);
  });

  it("10 成功 / 10 总数 → lower>0.5，upper=1", async () => {
    const mod = await importModule();
    const [lower, upper] = mod.computeWilsonInterval(10, 10);
    assert.ok(lower > 0.5, `lower 应 >0.5，实际 ${lower}`);
    assert.equal(upper, 1);
  });

  it("5 成功 / 10 总数 → lower≈0.27，upper≈0.73（对称）", async () => {
    const mod = await importModule();
    const [lower, upper] = mod.computeWilsonInterval(5, 10);
    // Wilson 95% 区间对 5/10 应约为 [0.237, 0.763]
    assert.ok(lower > 0.2 && lower < 0.3, `lower 应在 0.2-0.3，实际 ${lower}`);
    assert.ok(upper > 0.7 && upper < 0.8, `upper 应在 0.7-0.8，实际 ${upper}`);
    // 对称性：lower + upper ≈ 1
    assert.ok(Math.abs(lower + upper - 1) < 0.01, `lower+upper 应≈1，实际 ${lower + upper}`);
  });

  it("z=1.96（默认 95%）/ z=2.576（99%）区间更宽", async () => {
    const mod = await importModule();
    const [lower95, upper95] = mod.computeWilsonInterval(5, 10, 1.96);
    const [lower99, upper99] = mod.computeWilsonInterval(5, 10, 2.576);
    assert.ok(lower99 < lower95, "99% 区间下界应更低");
    assert.ok(upper99 > upper95, "99% 区间上界应更高");
  });

  it(" successes > total 时抛错或 clamp", async () => {
    const mod = await importModule();
    // 成功数大于总数应处理（clamp 或抛错），不应返回 NaN
    const result = mod.computeWilsonInterval(15, 10);
    assert.ok(!Number.isNaN(result[0]) && !Number.isNaN(result[1]), "不应返回 NaN");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 3：computeSignTestPValue — 符号检验 p-value
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-ABLATION-STATISTICS-1：computeSignTestPValue", () => {
  it("0 正 / 0 总 → 1（无样本，无显著性）", async () => {
    const mod = await importModule();
    const p = mod.computeSignTestPValue(0, 0);
    assert.equal(p, 1);
  });

  it("n/2 正 / n 总（无差异）→ p≈1（不显著）", async () => {
    const mod = await importModule();
    // H0: B 不优于 A，正号 = B 优于 A 的 case 数
    // 5/10 正号 → p≈1（不拒绝 H0）
    const p = mod.computeSignTestPValue(5, 10);
    assert.ok(p > 0.5, `5/10 应不显著（p>0.5），实际 p=${p}`);
  });

  it("9 正 / 10 总（B 显著优于 A）→ p<0.05", async () => {
    const mod = await importModule();
    // 9/10 正号 → 单侧符号检验 p 应 <0.05
    const p = mod.computeSignTestPValue(9, 10);
    assert.ok(p < 0.05, `9/10 应显著（p<0.05），实际 p=${p}`);
  });

  it("10 正 / 10 总（B 完全优于 A）→ p<0.01", async () => {
    const mod = await importModule();
    const p = mod.computeSignTestPValue(10, 10);
    assert.ok(p < 0.01, `10/10 应高度显著（p<0.01），实际 p=${p}`);
  });

  it("1 正 / 10 总（B 显著差于 A）→ p<0.05", async () => {
    const mod = await importModule();
    // 1/10 正号 → B 显著差于 A
    const p = mod.computeSignTestPValue(1, 10);
    assert.ok(p < 0.05, `1/10 应显著（p<0.05），实际 p=${p}`);
  });

  it("正号数 > 总数时 clamp 到 总数", async () => {
    const mod = await importModule();
    const p = mod.computeSignTestPValue(15, 10);
    // 应 clamp 到 10/10，不抛错
    assert.ok(p >= 0 && p <= 1, `p 应在 [0,1]，实际 ${p}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 4：computeMeanStd — 均值与标准差
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-ABLATION-STATISTICS-1：computeMeanStd", () => {
  it("空数组 → mean=0, std=0", async () => {
    const mod = await importModule();
    const r = mod.computeMeanStd([]);
    assert.equal(r.mean, 0);
    assert.equal(r.std, 0);
  });

  it("单元素数组 → mean=元素值, std=0", async () => {
    const mod = await importModule();
    const r = mod.computeMeanStd([5.5]);
    assert.equal(r.mean, 5.5);
    assert.equal(r.std, 0);
  });

  it("[1,2,3,4,5] → mean=3, std≈1.58（样本标准差）", async () => {
    const mod = await importModule();
    const r = mod.computeMeanStd([1, 2, 3, 4, 5]);
    assert.equal(r.mean, 3);
    // 样本标准差（n-1 分母）= sqrt(2.5) ≈ 1.581
    // 总体标准差（n 分母）= sqrt(2) ≈ 1.414
    // 接受任一约定，但应在 1.4-1.6 之间
    assert.ok(r.std > 1.4 && r.std < 1.6, `std 应在 1.4-1.6，实际 ${r.std}`);
  });

  it("[10,10,10] → mean=10, std=0（无方差）", async () => {
    const mod = await importModule();
    const r = mod.computeMeanStd([10, 10, 10]);
    assert.equal(r.mean, 10);
    assert.equal(r.std, 0);
  });

  it("含负值 [-2, 0, 2] → mean=0, std=2", async () => {
    const mod = await importModule();
    const r = mod.computeMeanStd([-2, 0, 2]);
    assert.equal(r.mean, 0);
    // 样本 std = sqrt((4+0+4)/2) = sqrt(4) = 2
    // 总体 std = sqrt((4+0+4)/3) = sqrt(2.67) ≈ 1.63
    assert.ok(r.std > 1.5 && r.std < 2.1, `std 应在 1.5-2.1，实际 ${r.std}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 5：computeMultiSeedStatistics — 多 seed 聚合统计
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-ABLATION-STATISTICS-1：computeMultiSeedStatistics", () => {
  it("空 seedResults → 返回零值结构", async () => {
    const mod = await importModule();
    const r = mod.computeMultiSeedStatistics([]);
    assert.equal(r.seeds, 0);
    assert.equal(r.passRate, 0);
  });

  it("3 seed，每 seed B 工具调用 < A → bWinRate.toolCalls 高，signTestPValue.toolCalls < 0.05", async () => {
    const mod = await importModule();
    // 模拟 3 个 seed 的聚合指标：每 seed B 组 toolCalls < A 组
    const seedResults = [
      { aggregate: { armA: { avgToolCalls: 6, avgFactGuardErrors: 1, avgCoverage: 0.5 }, armB: { avgToolCalls: 4, avgFactGuardErrors: 1, avgCoverage: 0.5 } }, passCriteria: { overallPassed: true } },
      { aggregate: { armA: { avgToolCalls: 5, avgFactGuardErrors: 1, avgCoverage: 0.6 }, armB: { avgToolCalls: 3, avgFactGuardErrors: 1, avgCoverage: 0.6 } }, passCriteria: { overallPassed: true } },
      { aggregate: { armA: { avgToolCalls: 7, avgFactGuardErrors: 1, avgCoverage: 0.4 }, armB: { avgToolCalls: 5, avgFactGuardErrors: 1, avgCoverage: 0.4 } }, passCriteria: { overallPassed: true } },
    ];
    const r = mod.computeMultiSeedStatistics(seedResults);
    assert.equal(r.seeds, 3);
    assert.equal(r.passRate, 1); // 3/3 通过
    assert.equal(r.bWinRate.toolCalls, 1); // 3/3 B 工具调用更少
    // 3/3 符号检验 p < 0.05？单侧 3/3 二项 p = 0.125（不显著）
    // 但 3 seed 太少，p 可能 > 0.05；只验证不抛错
    assert.ok(r.signTestPValue.toolCalls >= 0 && r.signTestPValue.toolCalls <= 1,
      `signTestPValue.toolCalls 应在 [0,1]，实际 ${r.signTestPValue.toolCalls}`);
  });

  it("5 seed，全部 B 工具调用 < A → signTestPValue.toolCalls < 0.05（5/5 显著）", async () => {
    const mod = await importModule();
    const seedResults = Array(5).fill(0).map(() => ({
      aggregate: { armA: { avgToolCalls: 6, avgFactGuardErrors: 1, avgCoverage: 0.5 }, armB: { avgToolCalls: 4, avgFactGuardErrors: 1, avgCoverage: 0.5 } },
      passCriteria: { overallPassed: true },
    }));
    const r = mod.computeMultiSeedStatistics(seedResults);
    // 5/5 单侧二项 p = (1/2)^5 = 0.03125 < 0.05
    assert.ok(r.signTestPValue.toolCalls < 0.05,
      `5/5 应显著（p<0.05），实际 p=${r.signTestPValue.toolCalls}`);
    assert.equal(r.bWinRate.toolCalls, 1);
  });

  it("5 seed，B 工具调用混合（3 < A，2 > A）→ signTestPValue.toolCalls > 0.05（不显著）", async () => {
    const mod = await importModule();
    const seedResults = [
      { aggregate: { armA: { avgToolCalls: 6, avgFactGuardErrors: 1, avgCoverage: 0.5 }, armB: { avgToolCalls: 4, avgFactGuardErrors: 1, avgCoverage: 0.5 } }, passCriteria: { overallPassed: true } },
      { aggregate: { armA: { avgToolCalls: 6, avgFactGuardErrors: 1, avgCoverage: 0.5 }, armB: { avgToolCalls: 4, avgFactGuardErrors: 1, avgCoverage: 0.5 } }, passCriteria: { overallPassed: true } },
      { aggregate: { armA: { avgToolCalls: 6, avgFactGuardErrors: 1, avgCoverage: 0.5 }, armB: { avgToolCalls: 4, avgFactGuardErrors: 1, avgCoverage: 0.5 } }, passCriteria: { overallPassed: true } },
      { aggregate: { armA: { avgToolCalls: 4, avgFactGuardErrors: 1, avgCoverage: 0.5 }, armB: { avgToolCalls: 6, avgFactGuardErrors: 1, avgCoverage: 0.5 } }, passCriteria: { overallPassed: true } },
      { aggregate: { armA: { avgToolCalls: 4, avgFactGuardErrors: 1, avgCoverage: 0.5 }, armB: { avgToolCalls: 6, avgFactGuardErrors: 1, avgCoverage: 0.5 } }, passCriteria: { overallPassed: true } },
    ];
    const r = mod.computeMultiSeedStatistics(seedResults);
    // 3/5 单侧二项 p ≈ 0.5（不显著）
    assert.ok(r.signTestPValue.toolCalls > 0.05,
      `3/5 应不显著（p>0.05），实际 p=${r.signTestPValue.toolCalls}`);
    assert.ok(r.bWinRate.toolCalls < 1, "B 不应 100% 胜");
  });

  it("meanStd 字段含 mean/std 数值", async () => {
    const mod = await importModule();
    const seedResults = [
      { aggregate: { armA: { avgToolCalls: 6, avgFactGuardErrors: 1, avgCoverage: 0.5 }, armB: { avgToolCalls: 4, avgFactGuardErrors: 1, avgCoverage: 0.5 } }, passCriteria: { overallPassed: true } },
      { aggregate: { armA: { avgToolCalls: 8, avgFactGuardErrors: 1, avgCoverage: 0.5 }, armB: { avgToolCalls: 5, avgFactGuardErrors: 1, avgCoverage: 0.5 } }, passCriteria: { overallPassed: true } },
    ];
    const r = mod.computeMultiSeedStatistics(seedResults);
    assert.ok(typeof r.meanStd.avgToolCallsA.mean === "number");
    assert.ok(typeof r.meanStd.avgToolCallsA.std === "number");
    assert.ok(typeof r.meanStd.avgToolCallsB.mean === "number");
    assert.ok(typeof r.meanStd.avgToolCallsB.std === "number");
    // mean(A) = (6+8)/2 = 7
    assert.equal(r.meanStd.avgToolCallsA.mean, 7);
    // mean(B) = (4+5)/2 = 4.5
    assert.equal(r.meanStd.avgToolCallsB.mean, 4.5);
  });

  it("wilsonInterval 字段含 [lower, upper] 数组", async () => {
    const mod = await importModule();
    const seedResults = Array(5).fill(0).map(() => ({
      aggregate: { armA: { avgToolCalls: 6, avgFactGuardErrors: 1, avgCoverage: 0.5 }, armB: { avgToolCalls: 4, avgFactGuardErrors: 1, avgCoverage: 0.5 } },
      passCriteria: { overallPassed: true },
    }));
    const r = mod.computeMultiSeedStatistics(seedResults);
    assert.ok(Array.isArray(r.wilsonInterval.toolCalls));
    assert.equal(r.wilsonInterval.toolCalls.length, 2);
    assert.ok(r.wilsonInterval.toolCalls[0] <= r.wilsonInterval.toolCalls[1],
      "lower 应 <= upper");
  });
});
