/**
 * TOOL-INTERFACE-BASELINE-1：Phase 4 pre-baseline replay spec（eval-only）
 *
 * 冻结"当前 9 个专用工具"行为作为 Phase 3（统一结果格式）的对照组。
 * 本测试直接驱动 createNarrativeTools 真实实现（零模型调用、确定性），
 * 断言 7 类场景 × 指标收集的正确性。
 *
 * 覆盖：
 * 1. 7 类场景齐全（canon / 角色状态 / 时间线 / 伏笔 / 章节 span / 低风险无检索 / 多工具混合）
 * 2. 聚合指标：总调用、重复查询、空白结果、超时、失败、有效/无效 sourceRef、覆盖率
 * 3. 场景级指标：callsByTool / duplicateQueries / emptyResults / sourceRefsInvalid / coverage
 * 4. 报告格式化：JSON roundtrip + Markdown 关键章节
 *
 * 关键基线发现（当前工具行为）：
 * - narrative 工具在无匹配时也返回非空提示文本（如"未找到…"），所以 tracer 的
 *   `empty`（零文本长度）指标恒为 0；真正的"无结果"信号由无效 sourceRef
 *   （no-match / *:empty / *:degraded）+ evidenceLevel=inferred 承载。
 *
 * 授权边界：不调用模型，不依赖真实 workspace，纯本地确定性执行。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
const MODULE_PATH = join(
  EXTENSION_ROOT,
  "dist-eval",
  "novelos",
  "eval",
  "tool-interface-baseline.js",
);

async function importModule() {
  return import(`file://${MODULE_PATH}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试 1：7 类场景齐全 + 工具面
// ─────────────────────────────────────────────────────────────────────────────

describe("TOOL-INTERFACE-BASELINE-1：场景与工具面", () => {
  it("BASELINE_SCENARIOS 共 7 类场景", async () => {
    const mod = await importModule();
    assert.equal(mod.BASELINE_SCENARIOS.length, 7);
  });

  it("7 类场景分类覆盖全部要求", async () => {
    const mod = await importModule();
    const categories = mod.BASELINE_SCENARIOS.map((s) => s.category).sort();
    assert.deepEqual(categories, [
      "canon_fact_retrieval",
      "chapter_span",
      "character_state",
      "low_risk_no_retrieval",
      "multi_tool_mixed",
      "promise_foreshadow",
      "timeline",
    ]);
  });

  it("visibleTools 为当前 9 个专用工具面", async () => {
    const mod = await importModule();
    const baseline = await mod.runToolInterfaceBaseline();
    assert.equal(baseline.visibleTools.length, 9);
    assert.ok(baseline.visibleTools.includes("search_narrative_evidence"));
    assert.ok(baseline.visibleTools.includes("search_chapter_span"));
    assert.ok(baseline.visibleTools.includes("query_canon"));
    assert.ok(baseline.visibleTools.includes("query_character_state"));
    assert.ok(baseline.visibleTools.includes("query_timeline"));
    assert.ok(baseline.visibleTools.includes("query_character_knowledge_boundary"));
    assert.ok(baseline.visibleTools.includes("query_promise_ledger"));
    assert.ok(baseline.visibleTools.includes("query_pattern_memory"));
    assert.ok(baseline.visibleTools.includes("query_voice_evidence"));
  });

  it("phase / toolSurface / schema 元数据正确", async () => {
    const mod = await importModule();
    const baseline = await mod.runToolInterfaceBaseline();
    assert.equal(baseline.phase, "phase4-pre-baseline");
    assert.equal(baseline.toolSurface, "specialized-9-tools");
    assert.equal(baseline.schema, "tool-interface-baseline/v1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 2：聚合指标
// ─────────────────────────────────────────────────────────────────────────────

describe("TOOL-INTERFACE-BASELINE-1：聚合指标", () => {
  it("跑出 7 个场景，总调用 = 3×6 + 5 = 23", async () => {
    const mod = await importModule();
    const baseline = await mod.runToolInterfaceBaseline();
    assert.equal(baseline.scenarios.length, 7);
    assert.equal(baseline.summary.scenarioCount, 7);
    assert.equal(baseline.summary.totalCalls, 23);
  });

  it("重复查询 = 3（SC2 角色状态空 query 重复 + SC4 伏笔空 query 重复 + SC7 显式重复 query）", async () => {
    const mod = await importModule();
    const baseline = await mod.runToolInterfaceBaseline();
    assert.equal(baseline.summary.totalDuplicateQueries, 3);
  });

  it("零文本空白结果 = 0（当前工具无匹配也返回提示文本，见头部说明）", async () => {
    const mod = await importModule();
    const baseline = await mod.runToolInterfaceBaseline();
    assert.equal(baseline.summary.totalEmptyResults, 0);
  });

  it("超时与失败 = 0（本地确定性执行）", async () => {
    const mod = await importModule();
    const baseline = await mod.runToolInterfaceBaseline();
    assert.equal(baseline.summary.totalTimeouts, 0);
    assert.equal(baseline.summary.totalErrors, 0);
  });

  it("有效 sourceRef = 19，无效 = 4（无结果信号由无效 sourceRef 承载）", async () => {
    const mod = await importModule();
    const baseline = await mod.runToolInterfaceBaseline();
    assert.equal(baseline.summary.totalSourceRefsValid, 19);
    assert.equal(baseline.summary.totalSourceRefsInvalid, 4);
  });

  it("每个场景 actualCalls === samples，且逐场景 有效+无效 sourceRef === actualCalls", async () => {
    const mod = await importModule();
    const baseline = await mod.runToolInterfaceBaseline();
    for (const s of baseline.scenarios) {
      assert.equal(s.actualCalls, s.samples, `${s.id} 调用数应等于样本数`);
      assert.equal(
        s.sourceRefsValid + s.sourceRefsInvalid,
        s.actualCalls,
        `${s.id} sourceRef 有效+无效应等于总调用数`,
      );
    }
  });

  it("各场景 mustVerify 覆盖率 ∈ [0,1]", async () => {
    const mod = await importModule();
    const baseline = await mod.runToolInterfaceBaseline();
    for (const s of baseline.scenarios) {
      assert.ok(
        s.mustVerify.coverageRatio >= 0 && s.mustVerify.coverageRatio <= 1,
        `${s.id} 覆盖率超出范围: ${s.mustVerify.coverageRatio}`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 3：场景级指标
// ─────────────────────────────────────────────────────────────────────────────

describe("TOOL-INTERFACE-BASELINE-1：场景级指标", () => {
  it("SC7 多工具混合：5 次调用、1 次重复查询、5 个有结果调用", async () => {
    const mod = await importModule();
    const baseline = await mod.runToolInterfaceBaseline();
    const sc7 = baseline.scenarios.find((s) => s.id === "SC7-multi-tool-mixed");
    assert.ok(sc7, "SC7 应存在");
    assert.equal(sc7.actualCalls, 5);
    assert.equal(sc7.duplicateQueries, 1, "SC7 应有 1 次重复查询");
    assert.equal(sc7.sourceRefsInvalid, 0, "SC7 全部调用应命中有效证据");
    assert.equal(sc7.emptyResults, 0);
  });

  it("SC6 低风险无检索：3 次调用全部无结果（无效 sourceRef），覆盖率为空集=1", async () => {
    const mod = await importModule();
    const baseline = await mod.runToolInterfaceBaseline();
    const sc6 = baseline.scenarios.find((s) => s.id === "SC6-low-risk-no-retrieval");
    assert.ok(sc6, "SC6 应存在");
    assert.equal(sc6.actualCalls, 3);
    assert.equal(sc6.sourceRefsInvalid, 3, "SC6 全部调用应无有效证据");
    assert.equal(sc6.sourceRefsValid, 0);
    assert.equal(sc6.mustVerify.itemCount, 0);
    assert.equal(sc6.mustVerify.coverageRatio, 1, "无 mustVerify 项时覆盖率为 1");
  });

  it("SC1 canon 事实检索：mustVerify 全部覆盖（coverageRatio=1）", async () => {
    const mod = await importModule();
    const baseline = await mod.runToolInterfaceBaseline();
    const sc1 = baseline.scenarios.find((s) => s.id === "SC1-canon-fact");
    assert.ok(sc1, "SC1 应存在");
    assert.equal(sc1.mustVerify.coverageRatio, 1);
    assert.equal(sc1.mustVerify.coveredCount, 4);
    assert.equal(sc1.mustVerify.itemCount, 4);
    assert.equal(sc1.mustVerify.uncoveredItems.length, 0);
  });

  it("SC5 章节 span：evidenceLevel 为 confirmed（当前工具把 span 证据上报为 confirmed），mustVerify 全覆盖", async () => {
    const mod = await importModule();
    const baseline = await mod.runToolInterfaceBaseline();
    const sc5 = baseline.scenarios.find((s) => s.id === "SC5-chapter-span");
    assert.ok(sc5, "SC5 应存在");
    assert.equal(sc5.mustVerify.coverageRatio, 1);
    assert.ok(
      sc5.evidenceLevels["confirmed"] >= 3,
      "章节 span 场景应有 3 条 confirmed 证据",
    );
  });

  it("callsByTool 聚合跨场景正确（search_narrative_evidence 至少 5 次）", async () => {
    const mod = await importModule();
    const baseline = await mod.runToolInterfaceBaseline();
    const totalByTool = baseline.summary.callsByTool;
    // SC1(2) + SC3(1) + SC4(1) + SC6(1) + SC7(2) = 7
    assert.equal(totalByTool["search_narrative_evidence"], 7);
    // SC1 + SC3 + SC6 = 3
    assert.equal(totalByTool["query_canon"], 3);
    // SC5(3) + SC7(1) = 4
    assert.equal(totalByTool["search_chapter_span"], 4);
    // SC2(2) + SC6(1) + SC7(1) = 4
    assert.equal(totalByTool["query_character_state"], 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 4：报告格式化
// ─────────────────────────────────────────────────────────────────────────────

describe("TOOL-INTERFACE-BASELINE-1：报告格式化", () => {
  it("JSON roundtrip 保持结构一致", async () => {
    const mod = await importModule();
    const baseline = await mod.runToolInterfaceBaseline();
    const json = mod.formatToolInterfaceBaselineJson(baseline);
    const parsed = JSON.parse(json);
    assert.equal(parsed.schema, baseline.schema);
    assert.equal(parsed.scenarios.length, 7);
    assert.equal(parsed.summary.totalCalls, baseline.summary.totalCalls);
  });

  it("Markdown 含标题、聚合指标表、各场景小节与 Phase 3 兼容性说明", async () => {
    const mod = await importModule();
    const baseline = await mod.runToolInterfaceBaseline();
    const md = mod.formatToolInterfaceBaselineMarkdown(baseline);
    assert.ok(md.includes("NovelOS 工具接口基线报告"), "应含报告主标题");
    assert.ok(md.includes("## 聚合指标"), "应含聚合指标区");
    assert.ok(md.includes("## 各场景详情"), "应含场景详情区");
    assert.ok(md.includes("SC1-canon-fact"), "应含 SC1");
    assert.ok(md.includes("SC7-multi-tool-mixed"), "应含 SC7");
    assert.ok(md.includes("Phase 3 兼容性要求"), "应含 Phase 3 兼容性说明");
  });
});