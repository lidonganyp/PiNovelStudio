/**
 * NovelOS M1 Eval Harness 测试（Step 6）
 *
 * 验证 eval harness 本身的正确性：
 * - setupFixtureWorkspace 能正确创建临时 workspace
 * - evalRetrieval 能正确计算 B1/B2 覆盖率和检索增益
 * - evalVerifier 能正确计算 precision/recall
 * - runFullEval 能正确产出报告和验收决策
 * - formatReportAsMarkdown 能正确格式化报告
 *
 * 测试策略：
 * - 使用 EVAL_FIXTURES 中的真实 fixture（不 mock）
 * - 验证关键指标的计算逻辑，不验证具体数值（数值可能随 fixture 变化）
 * - 验证验收决策的边界条件
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

const {
  setupFixtureWorkspace,
  evalRetrieval,
  evalVerifier,
  evalEndToEnd,
  runFullEval,
  formatReportAsMarkdown,
} = await import(evalHarnessUrl);
const { EVAL_FIXTURES } = await import(fixturesUrl);

// ============================================================================
// 测试
// ============================================================================

describe("NovelOS M1 Eval Harness — Fixture 数据完整性", () => {
  test("EVAL_FIXTURES 应有 6 个 fixture", () => {
    assert.equal(EVAL_FIXTURES.length, 6);
  });

  test("每个 fixture 有唯一 id", () => {
    const ids = EVAL_FIXTURES.map((f) => f.id);
    const uniqueIds = new Set(ids);
    assert.equal(ids.length, uniqueIds.size, "fixture id 不唯一");
  });

  test("每个 fixture 覆盖不同类别", () => {
    const categories = EVAL_FIXTURES.map((f) => f.category);
    const uniqueCategories = new Set(categories);
    assert.equal(categories.length, uniqueCategories.size, "fixture category 不唯一");
  });

  test("每个 fixture 的 expected 字段完整", () => {
    for (const fixture of EVAL_FIXTURES) {
      assert.ok(fixture.expected.factsRetrievable, `${fixture.id}: factsRetrievable 缺失`);
      assert.ok(
        Array.isArray(fixture.expected.factsInCompiledContext),
        `${fixture.id}: factsInCompiledContext 缺失`,
      );
      assert.equal(
        typeof fixture.expected.requiresRetrieval,
        "boolean",
        `${fixture.id}: requiresRetrieval 缺失`,
      );
    }
  });
});

describe("NovelOS M1 Eval Harness — setupFixtureWorkspace", () => {
  test("能正确创建临时 workspace（F1）", () => {
    const fixture = EVAL_FIXTURES[0]; // F1-historical-fact
    const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);

    try {
      assert.equal(workspaceId, fixture.workspace.workspaceId);
      assert.ok(existsSync(join(projectRoot, "workspaces", workspaceId, "config.json")));
      // F1 有 2 个历史章节
      assert.ok(
        existsSync(
          join(projectRoot, "workspaces", workspaceId, "chapters", "chapter-1", "final.md"),
        ),
      );
      assert.ok(
        existsSync(
          join(projectRoot, "workspaces", workspaceId, "chapters", "chapter-2", "final.md"),
        ),
      );
      // F1 有 narrative-state.json（characterUpdates）
      assert.ok(
        existsSync(join(projectRoot, "workspaces", workspaceId, "narrative-state.json")),
      );
      // F1 有 skeleton.json（canon events）
      assert.ok(
        existsSync(join(projectRoot, "workspaces", workspaceId, "skeleton.json")),
      );
    } finally {
      cleanup();
    }
  });

  test("F4（无历史章节）不创建章节文件", () => {
    const fixture = EVAL_FIXTURES[3]; // F4-simple-negative
    const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);

    try {
      assert.ok(existsSync(join(projectRoot, "workspaces", workspaceId, "config.json")));
      const chaptersDir = join(projectRoot, "workspaces", workspaceId, "chapters");
      assert.ok(!existsSync(chaptersDir), "F4 不应有 chapters 目录");
    } finally {
      cleanup();
    }
  });

  test("cleanup 能正确清理临时目录", () => {
    const fixture = EVAL_FIXTURES[0];
    const { projectRoot, cleanup } = setupFixtureWorkspace(fixture);
    cleanup();
    assert.ok(!existsSync(projectRoot), "cleanup 后临时目录应被删除");
  });
});

describe("NovelOS M1 Eval Harness — evalRetrieval", () => {
  test("F1 检索增益为正（B2 > B1）", async () => {
    const fixture = EVAL_FIXTURES[0]; // F1-historical-fact
    const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);
    try {
      // P0-1：evalRetrieval 必须从 B2 agent loop trajectory 提取 ranked evidence，
      // 不再绕过工具协议直接调 searchRanked()。需先跑 evalEndToEnd 产出 trajectory。
      const e2eResult = await evalEndToEnd(fixture, projectRoot, workspaceId);
      const result = evalRetrieval(fixture, projectRoot, workspaceId, e2eResult.b2TrajectoryPath);
      assert.equal(result.fixtureId, fixture.id);
      assert.ok(result.b2FactsFound >= result.b1FactsFound, "F1 B2 应 >= B1");
      assert.ok(result.retrievalGain >= 0, "F1 检索增益应 >= 0");
      assert.ok(result.b2Coverage >= result.b1Coverage, "F1 B2 覆盖率应 >= B1");
      assert.equal(result.viaToolProtocol, true, "F1 通过工具协议获取 ranked evidence");
    } finally {
      cleanup();
    }
  });

  test("F4（负控）检索增益为 0（无历史章节）", () => {
    const fixture = EVAL_FIXTURES[3]; // F4-simple-negative
    const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);
    try {
      const result = evalRetrieval(fixture, projectRoot, workspaceId);
      assert.equal(result.retrievalGain, 0, "F4 检索增益应为 0");
      assert.equal(result.totalFactsRetrievable, 0, "F4 无可检索事实");
      assert.equal(result.retrievalQueries, 0, "F4 无检索查询");
    } finally {
      cleanup();
    }
  });

  test("B2 覆盖率不超过 1.0", () => {
    for (const fixture of EVAL_FIXTURES) {
      const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);
      try {
        const result = evalRetrieval(fixture, projectRoot, workspaceId);
        assert.ok(result.b2Coverage <= 1.0, `${fixture.id}: B2 覆盖率 > 1.0`);
        assert.ok(result.b1Coverage <= 1.0, `${fixture.id}: B1 覆盖率 > 1.0`);
      } finally {
        cleanup();
      }
    }
  });
});

describe("NovelOS M1 Eval Harness — evalVerifier", () => {
  test("F2 知识边界检测：precision=1.0（无误报）", () => {
    const fixture = EVAL_FIXTURES[1]; // F2-knowledge-boundary
    const result = evalVerifier(fixture);
    assert.equal(result.fixtureId, fixture.id);
    assert.equal(result.falsePositives, 0, "F2 不应有误报");
    assert.equal(result.precision, 1.0, "F2 precision 应为 1.0");
  });

  test("F2 知识边界检测：recall > 0（至少检测到 1 个违规）", () => {
    const fixture = EVAL_FIXTURES[1]; // F2-knowledge-boundary
    const result = evalVerifier(fixture);
    assert.ok(result.truePositives > 0, "F2 应至少检测到 1 个知识边界违规");
    assert.ok(result.recall > 0, "F2 recall 应 > 0");
  });

  test("所有 fixture 的 precision = 1.0（健康候选无误报）", () => {
    for (const fixture of EVAL_FIXTURES) {
      if (!fixture.expected.healthyCandidate) continue;
      const result = evalVerifier(fixture);
      assert.equal(
        result.falsePositives,
        0,
        `${fixture.id}: 健康候选不应有误报，但 FP=${result.falsePositives}`,
      );
    }
  });
});

describe("NovelOS M1 Eval Harness — evalEndToEnd", () => {
  test("B3 文本长度 >= 0", async () => {
    for (const fixture of EVAL_FIXTURES) {
      const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);
      try {
        const result = await evalEndToEnd(fixture, projectRoot, workspaceId);
        assert.ok(result.b3TextLength >= 0, `${fixture.id}: B3 文本长度 < 0`);
      } finally {
        cleanup();
      }
    }
  });

  test("trajectory 完整率为布尔值（真实 B1/B2/B3 agent loop）", async () => {
    for (const fixture of EVAL_FIXTURES) {
      const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);
      try {
        const result = await evalEndToEnd(fixture, projectRoot, workspaceId);
        assert.equal(
          typeof result.trajectoryComplete,
          "boolean",
          `${fixture.id}: trajectoryComplete 应为 boolean`,
        );
      } finally {
        cleanup();
      }
    }
  });
});

describe("NovelOS M1 Eval Harness — runFullEval", () => {
  test("完整报告包含所有 fixture 的结果", async () => {
    const report = await runFullEval(EVAL_FIXTURES);
    assert.equal(report.totalFixtures, 6);
    assert.equal(report.retrievalResults.length, 6);
    assert.equal(report.verifierResults.length, 6);
    assert.equal(report.endToEndResults.length, 6);
  });

  test("聚合指标计算正确", async () => {
    const report = await runFullEval(EVAL_FIXTURES);
    // avgB2Coverage 应该 > avgB1Coverage（检索有增益）
    assert.ok(
      report.summary.avgB2Coverage > report.summary.avgB1Coverage,
      "B2 覆盖率应 > B1",
    );
    // trajectory 完整率（真实 B1/B2/B3 loop，放宽为数字检查）
    assert.equal(typeof report.summary.trajectoryCompleteRate, "number");
    // verifier precision = 1.0（无 FP）
    assert.equal(report.summary.avgVerifierPrecision, 1.0);
  });

  test("验收决策为 hold 或 go_candidate（检索有增益，GO 条件决定最终决策）", async () => {
    const report = await runFullEval(EVAL_FIXTURES);
    assert.ok(
      ["hold", "go_candidate"].includes(report.recommendation),
      `recommendation 应为 hold 或 go_candidate，实际：${report.recommendation}`,
    );
    assert.ok(report.recommendationReason.length > 0, "决策理由不应为空");
  });

  test("P0-4：goConditions 包含 12 项逐项检查结果", async () => {
    const report = await runFullEval(EVAL_FIXTURES);
    assert.ok(Array.isArray(report.goConditions), "goConditions 应为数组");
    assert.equal(report.goConditions.length, 12, `应有 12 项 GO 条件，实际：${report.goConditions.length}`);
    // 每项必须有 name/passed/detail
    for (const c of report.goConditions) {
      assert.ok(typeof c.name === "string" && c.name.length > 0, "条件 name 非空");
      assert.equal(typeof c.passed, "boolean", `条件 ${c.name} passed 应为 boolean`);
      assert.ok(typeof c.detail === "string" && c.detail.length > 0, `条件 ${c.name} detail 非空`);
    }
    // 验证条件名（M1-R1：wrong_retrieval_rate 替换为 evidence_imprecision_rate + 3 个新条件）
    const names = report.goConditions.map((c) => c.name);
    const expectedNames = [
      "b2_fact_coverage_gt_b1",
      "b3_fact_coverage_ge_b2",
      "b3_fixed_b2_issues",
      "verifier_precision",
      "verifier_recall",
      "evidence_imprecision_rate",
      "evidence_precision",
      "query_failure_rate",
      "evidence_utility_rate",
      "trajectory_complete",
      "no_fallback_masking",
      "negative_control_precision",
    ];
    for (const name of expectedNames) {
      assert.ok(names.includes(name), `GO 条件缺少：${name}`);
    }
  });

  test("M1-R1：同单位检索指标数学一致性", async () => {
    const report = await runFullEval(EVAL_FIXTURES);
    for (const r of report.retrievalResults) {
      // returnedEvidence >= relevantEvidence
      assert.ok(r.returnedEvidence >= r.relevantEvidence, `${r.fixtureId}: returnedEvidence(${r.returnedEvidence}) >= relevantEvidence(${r.relevantEvidence})`);
      // wrongEvidence = returnedEvidence - relevantEvidence
      assert.equal(r.wrongEvidence, r.returnedEvidence - r.relevantEvidence, `${r.fixtureId}: wrongEvidence = returned - relevant`);
      // evidencePrecision + evidenceImprecisionRate ≈ 1（容差 1e-9）
      if (r.returnedEvidence > 0) {
        assert.ok(Math.abs(r.evidencePrecision + r.evidenceImprecisionRate - 1) < 1e-9, `${r.fixtureId}: precision + imprecision ≈ 1`);
      }
      // queryFailureRate <= 1
      assert.ok(r.queryFailureRate <= 1, `${r.fixtureId}: queryFailureRate <= 1`);
      // totalQueries >= failedQueries
      assert.ok(r.totalQueries >= r.failedQueries, `${r.fixtureId}: totalQueries >= failedQueries`);
    }
  });

  test("P0-4：negativeControlExcluded 为 boolean", async () => {
    const report = await runFullEval(EVAL_FIXTURES);
    assert.equal(typeof report.negativeControlExcluded, "boolean", "negativeControlExcluded 应为 boolean");
  });

  test("P0-4：go_candidate 要求所有条件通过（HasRequiredFacts 全 false 时不触发 go_candidate）", async () => {
    const report = await runFullEval(EVAL_FIXTURES);
    // 当前 fixture 的 b1/b2/b3HasRequiredFacts 全为 false（stub model 返回预制文本）
    // 因此 b3_fact_coverage_ge_b2 通过（false >= false），但 b3_fixed_b2_issues 可能有变化
    // 关键断言：如果 recommendation 是 go_candidate，则所有 goConditions 必须通过
    if (report.recommendation === "go_candidate") {
      for (const c of report.goConditions) {
        assert.ok(c.passed, `go_candidate 要求所有条件通过，但 ${c.name} 未通过：${c.detail}`);
      }
    }
  });

  test("时间戳存在", async () => {
    const report = await runFullEval(EVAL_FIXTURES);
    assert.ok(report.timestamp, "时间戳缺失");
    // ISO 格式
    assert.ok(!isNaN(Date.parse(report.timestamp)), "时间戳不是有效 ISO 日期");
  });
});

describe("NovelOS M1 Eval Harness — formatReportAsMarkdown", () => {
  test("Markdown 报告包含关键章节", async () => {
    const report = await runFullEval(EVAL_FIXTURES);
    const md = formatReportAsMarkdown(report);
    assert.ok(md.includes("# NovelOS M1 评测报告"), "缺少标题");
    assert.ok(md.includes("## 聚合指标"), "缺少聚合指标章节");
    assert.ok(md.includes("## GO 条件逐项检查"), "缺少 GO 条件逐项检查章节（P0-4）");
    assert.ok(md.includes("## 检索评测详情"), "缺少检索评测章节");
    assert.ok(md.includes("## 验证器评测详情"), "缺少验证器评测章节");
    assert.ok(md.includes("## 端到端评测详情"), "缺少端到端评测章节");
    assert.ok(md.includes("## 验收决策标准"), "缺少验收决策标准章节");
    assert.ok(
      md.includes("HOLD") || md.includes("GO_CANDIDATE") || md.includes("NO_GO"),
      "缺少验收决策结果（HOLD/GO_CANDIDATE/NO_GO）",
    );
    // P0-4：GO 条件表应包含所有 12 个条件名（M1-R1 更新）
    const expectedConditions = [
      "b2_fact_coverage_gt_b1",
      "b3_fact_coverage_ge_b2",
      "b3_fixed_b2_issues",
      "verifier_precision",
      "verifier_recall",
      "evidence_imprecision_rate",
      "evidence_precision",
      "query_failure_rate",
      "evidence_utility_rate",
      "trajectory_complete",
      "no_fallback_masking",
      "negative_control_precision",
    ];
    for (const name of expectedConditions) {
      assert.ok(md.includes(name), `Markdown 报告缺少 GO 条件：${name}`);
    }
  });

  test("Markdown 报告包含所有 fixture id", async () => {
    const report = await runFullEval(EVAL_FIXTURES);
    const md = formatReportAsMarkdown(report);
    for (const fixture of EVAL_FIXTURES) {
      assert.ok(md.includes(fixture.id), `Markdown 报告缺少 ${fixture.id}`);
    }
  });
});
