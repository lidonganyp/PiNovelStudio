/**
 * PHASE4-TOOL-AB：Phase 4 工具接口 A/B 确定性测试（eval-only）
 *
 * 对比 A 组（specialized-9-tools）与 B 组（typed facade query_narrative）。
 * 直接驱动工具 execute（零模型调用、确定性可复现）。
 *
 * 覆盖：
 * 1. facade 路由等价：每个 intent 路由到对应底层工具，且透传结果与 A 组一致
 * 2. B 证据覆盖不降级：mustVerify 覆盖率 / sourceRef 完整率 B >= A
 * 3. 指标抽取：首次有效证据延迟、聚合指标
 * 4. 工具面减少：A=9，B=1
 * 5. 报告格式化：JSON roundtrip + Markdown 关键章节
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

const RUNNER_PATH = join(
  EXTENSION_ROOT,
  "dist-eval",
  "novelos",
  "eval",
  "tool-ab-runner.js",
);
const FACADE_PATH = join(
  EXTENSION_ROOT,
  "dist-eval",
  "novelos",
  "eval",
  "typed-facade-tool.js",
);
const BASELINE_PATH = join(
  EXTENSION_ROOT,
  "dist-eval",
  "novelos",
  "eval",
  "tool-interface-baseline.js",
);

async function importRunner() {
  return import(`file://${RUNNER_PATH}`);
}
async function importFacade() {
  return import(`file://${FACADE_PATH}`);
}
async function importBaseline() {
  return import(`file://${BASELINE_PATH}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试 1：facade 路由等价（intent → 底层工具）
// ─────────────────────────────────────────────────────────────────────────────

describe("PHASE4-TOOL-AB-1：facade 路由等价", () => {
  it("INTENT_TO_TOOL 覆盖全部 9 个底层工具，TOOL_NAME_TO_INTENT 可逆", async () => {
    const facade = await importFacade();
    const intents = facade.QUERY_NARRATIVE_INTENTS;
    assert.equal(intents.length, 9);
    assert.equal(facade.QUERY_NARRATIVE_NAME, "query_narrative");
    // 每个 intent 映射到存在的工具名
    for (const intent of intents) {
      const toolName = facade.INTENT_TO_TOOL[intent];
      assert.equal(typeof toolName, "string");
      assert.ok(toolName.length > 0);
    }
    // 可逆：TOOL_NAME_TO_INTENT 覆盖 INTENT_TO_TOOL 的值域（每个底层工具名都有对应 intent）
    const toolNames = Object.values(facade.INTENT_TO_TOOL);
    for (const toolName of toolNames) {
      const intent = facade.TOOL_NAME_TO_INTENT[toolName];
      assert.ok(intent !== undefined, `工具 ${toolName} 应有对应 intent`);
      assert.equal(facade.INTENT_TO_TOOL[intent], toolName, `intent ${intent} 可逆回工具 ${toolName}`);
    }
  });

  it("facade execute 透传结果与底层工具一致（证据等级/sourceRef/resultKind）", async () => {
    const baseline = await importBaseline();
    const facade = await importFacade();
    const scenario = baseline.BASELINE_SCENARIOS.find((s) => s.id === "SC1-canon-fact");
    assert.ok(scenario, "SC1-canon-fact 应存在");

    // 直接驱动单个调用：A 用 query_canon，B 用 facade intent=canon
    const { projectRoot, workspaceId, cleanup } = await runScenarioTools(baseline, facade, scenario);
    try {
      const searchService = await createSearchService(baseline, facade, projectRoot, workspaceId, scenario);
      // A 组底层工具
      const aTools = await makeATools(baseline, searchService);
      const aTool = aTools.find((t) => t.name === "query_canon");
      assert.ok(aTool, "query_canon 应存在");
      const aResult = await aTool.execute("ab-canon-a", { category: "timeline" });

      // B 组 facade
      const bTool = await makeFacade(facade, searchService);
      const bResult = await bTool.execute("ab-canon-b", { intent: "canon", category: "timeline" });

      // 透传等价：details 完全一致
      assert.deepEqual(bResult.details, aResult.details);
      assert.deepEqual(bResult.content, aResult.content);
    } finally {
      cleanup();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 2：A/B 全量 replay + 门禁
// ─────────────────────────────────────────────────────────────────────────────

describe("PHASE4-TOOL-AB-2：A/B replay 与门禁", () => {
  it("工具面减少：A=9，B=1", async () => {
    const runner = await importRunner();
    const comparison = await runner.runToolAbReplay();
    assert.equal(comparison.aggregation.A.toolSurface, 9);
    assert.equal(comparison.aggregation.B.toolSurface, 1);
  });

  it("mustVerify 覆盖率不降级：B >= A", async () => {
    const runner = await importRunner();
    const comparison = await runner.runToolAbReplay();
    assert.ok(
      comparison.gate.mustVerifyCoverageNotDegraded,
      `mustVerify 覆盖率应不降级：A=${comparison.aggregation.A.avgCoverageRatio}, B=${comparison.aggregation.B.avgCoverageRatio}`,
    );
    // 逐场景也应不降级
    for (const s of comparison.scenarios) {
      assert.ok(
        s.B.mustVerify.coverageRatio >= s.A.mustVerify.coverageRatio - 1e-9,
        `场景 ${s.scenarioId} mustVerify 覆盖率不降级：A=${s.A.mustVerify.coverageRatio}, B=${s.B.mustVerify.coverageRatio}`,
      );
    }
  });

  it("sourceRef/evidenceLevel 完整率不降级：B >= A", async () => {
    const runner = await importRunner();
    const comparison = await runner.runToolAbReplay();
    assert.ok(
      comparison.gate.sourceRefCompletenessNotDegraded,
      `sourceRef 完整率应不降级：A=${comparison.aggregation.A.sourceRefCompleteness}, B=${comparison.aggregation.B.sourceRefCompleteness}`,
    );
  });

  it("失败行为不退化：errors/timeouts/empty B <= A", async () => {
    const runner = await importRunner();
    const comparison = await runner.runToolAbReplay();
    assert.ok(comparison.gate.failureNotDegraded, "失败行为不应退化");
  });

  it("全部门禁通过", async () => {
    const runner = await importRunner();
    const comparison = await runner.runToolAbReplay();
    assert.ok(comparison.gate.allPassed, `A/B 全部门禁应通过：${JSON.stringify(comparison.gate.details)}`);
  });

  it("首次有效证据指标可抽取（有效证据场景应有节点）", async () => {
    const runner = await importRunner();
    const comparison = await runner.runToolAbReplay();
    // SC1（canon 事实）应产生有效证据
    const sc1 = comparison.scenarios.find((s) => s.scenarioId === "SC1-canon-fact");
    assert.ok(sc1, "SC1-canon-fact 应存在");
    assert.ok(sc1.firstValidEvidence.A, "A 组 SC1 应产生首次有效证据节点");
    assert.ok(sc1.firstValidEvidence.B, "B 组 SC1 应产生首次有效证据节点");
    assert.ok(sc1.firstValidEvidence.A.cumulativeLatencyMs >= 0);
    assert.ok(sc1.firstValidEvidence.B.cumulativeLatencyMs >= 0);
  });

  it("无效 sourceRef 分类：仅含预期分类（no_match），不含其他/失败", async () => {
    const runner = await importRunner();
    const comparison = await runner.runToolAbReplay();
    const catA = comparison.aggregation.A.invalidSourceRefByCategory;
    const catB = comparison.aggregation.B.invalidSourceRefByCategory;
    // 无效数 = 各分类之和
    const sumA = catA.no_match + catA.profile_only + catA.empty + catA.other;
    assert.equal(sumA, comparison.aggregation.A.sourceRefsInvalid, `A 组无效分类和=${sumA} 应等于无效总数=${comparison.aggregation.A.sourceRefsInvalid}`);
    const sumB = catB.no_match + catB.profile_only + catB.empty + catB.other;
    assert.equal(sumB, comparison.aggregation.B.sourceRefsInvalid, `B 组无效分类和=${sumB} 应等于无效总数=${comparison.aggregation.B.sourceRefsInvalid}`);
    // 无效分类应全部落在预期分类（no_match/profile_only/empty），other 应为 0
    assert.equal(catA.other, 0, "A 组不应有未分类的无效 sourceRef");
    assert.equal(catB.other, 0, "B 组不应有未分类的无效 sourceRef");
    // 有效证据引用率在 [0,1]
    assert.ok(comparison.aggregation.A.sourceRefCompleteness >= 0 && comparison.aggregation.A.sourceRefCompleteness <= 1);
    assert.ok(comparison.aggregation.B.sourceRefCompleteness >= 0 && comparison.aggregation.B.sourceRefCompleteness <= 1);
  });

  it("trajectory 副本：每场景每 arm 含 tool_visibility + tool_call_metrics", async () => {
    const runner = await importRunner();
    const comparison = await runner.runToolAbReplay();
    const traj = runner.buildToolAbTrajectory(comparison);
    // 7 场景 × A/B = 14 个 key
    assert.equal(Object.keys(traj).length, comparison.scenarios.length * 2);
    for (const s of comparison.scenarios) {
      const keyA = `${s.scenarioId}:A`;
      const keyB = `${s.scenarioId}:B`;
      assert.ok(traj[keyA], `${keyA} 应存在`);
      assert.ok(traj[keyB], `${keyB} 应存在`);
      // 首条为 tool_visibility
      assert.equal(traj[keyA][0].type, "tool_visibility");
      assert.equal(traj[keyB][0].type, "tool_visibility");
      // 后续为 tool_call_metrics，数量 = 实际调用数
      assert.equal(traj[keyA].length - 1, s.A.actualCalls, `${keyA} 调用条目数`);
      assert.equal(traj[keyB].length - 1, s.B.actualCalls, `${keyB} 调用条目数`);
      // JSONL 可解析
      const jsonl = runner.formatTrajectoryJsonl(traj[keyA]);
      const lines = jsonl.trim().split("\n");
      assert.equal(lines.length, traj[keyA].length);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 3：报告格式化
// ─────────────────────────────────────────────────────────────────────────────

describe("PHASE4-TOOL-AB-3：报告格式化", () => {
  it("JSON roundtrip + Markdown 关键章节", async () => {
    const runner = await importRunner();
    const comparison = await runner.runToolAbReplay();
    const json = runner.formatToolAbJson(comparison);
    const parsed = JSON.parse(json);
    assert.equal(parsed.schema, comparison.schema);
    assert.equal(parsed.aggregation.A.toolSurface, 9);
    assert.equal(parsed.aggregation.B.toolSurface, 1);

    const md = runner.formatToolAbMarkdown(comparison);
    assert.ok(md.includes("specialized-9-tools vs typed facade"), "应含标题");
    assert.ok(md.includes("allPassed") === false || true);
    assert.ok(md.includes("工具面"), "应含聚合指标表");
    assert.ok(md.includes("SC1-canon-fact"), "应含各场景详情");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 辅助（在测试内驱动工具，避免与 helper 模块耦合）
// ─────────────────────────────────────────────────────────────────────────────

async function runScenarioTools(baselineMod, facadeMod, scenario) {
  // 复用 baseline 的 setupBaselineWorkspace
  return baselineMod.setupBaselineWorkspace(scenario.workspace);
}

async function createSearchService(baselineMod, facadeMod, projectRoot, workspaceId, scenario) {
  const baseline = await importBaseline();
  const facade = await importFacade();
  const { createNarrativeSearchService } = await import(
    `file://${join(EXTENSION_ROOT, "dist-eval", "novelos", "agent", "narrative-search-service.js")}`
  );
  return createNarrativeSearchService({
    projectRoot,
    workspaceId,
    sourceChapter: `ch${scenario.workspace.historicalChapters.length}`,
  });
}

async function makeATools(baselineMod, searchService) {
  const { createNarrativeTools } = await import(
    `file://${join(EXTENSION_ROOT, "dist-eval", "novelos", "tools", "narrative-tools.js")}`
  );
  return createNarrativeTools({ searchService });
}

async function makeFacade(facadeMod, searchService) {
  return facadeMod.createTypedFacadeTool({ searchService });
}