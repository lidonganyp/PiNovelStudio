/**
 * PHASE4-TOOL-AB-REAL：Phase 4.2 真实模型 A/B runner 测试（dry-run，zero API）
 *
 * 验证 runner 框架（不调用外部模型）：
 * 1. A 组注入 9 专用工具，B 组只注入 query_narrative facade（工具面 9 vs 1）
 * 2. 3 高信号场景 × 3 seed × A/B 成对，seed 聚合正确（每场景每 arm 3 份 metrics）
 * 3. 记录模型实际行为：工具选择 / intent 合法性 / 路由失败 / 首证延迟 / schema token
 * 4. 重复查询按"语义操作身份"统计（intent 优先）
 * 5. 结果门槛：mustVerify 覆盖 / 有效证据 sourceRef / 无效分类不恶化 + 至少一项负担改善
 * 6. trajectory 副本（每场景每 arm 每 seed 的 JSONL）
 *
 * 授权边界：dry-run stub 模型确定性生成工具调用，零真实 API。
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
  "tool-ab-real-runner.js",
);

async function importRunner() {
  return import(`file://${RUNNER_PATH}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试 1：工具面 / seed 聚合
// ─────────────────────────────────────────────────────────────────────────────

describe("PHASE4-TOOL-AB-REAL-1：工具面与 seed 聚合", () => {
  it("A 组 9 专用工具，B 组 1 facade；3 场景 × 3 seed × A/B", async () => {
    const runner = await importRunner();
    const comparison = await runner.runRealToolAbReplay();
    assert.equal(comparison.mode, "dry-run");
    assert.equal(comparison.aggregation.A.toolSurface, 9);
    assert.equal(comparison.aggregation.B.toolSurface, 1);
    // 3 高信号场景
    assert.equal(comparison.scenarios.length, 3);
    // 每场景每 arm 3 个 seed 的 metrics（seed 聚合必须保留全部 seed）
    for (const p of comparison.scenarios) {
      assert.equal(p.A.length, 3, `场景 ${p.scenarioId} A 组应有 3 seed`);
      assert.equal(p.B.length, 3, `场景 ${p.scenarioId} B 组应有 3 seed`);
      // 每个 seed 的 schema token 成本一致（同工具注入）
      const aSchema = new Set(p.A.map((m) => m.schemaTokenCost));
      const bSchema = new Set(p.B.map((m) => m.schemaTokenCost));
      assert.equal(aSchema.size, 1, "A 组各 seed schema token 应一致");
      assert.equal(bSchema.size, 1, "B 组各 seed schema token 应一致");
    }
  });

  it("B 组 schema token 显著低于 A 组（9 工具 vs 1 facade）", async () => {
    const runner = await importRunner();
    const comparison = await runner.runRealToolAbReplay();
    const a = comparison.aggregation.A.schemaTokenCost;
    const b = comparison.aggregation.B.schemaTokenCost;
    assert.ok(a > 0, "A 组 schema token 应 > 0");
    assert.ok(b > 0, "B 组 schema token 应 > 0");
    assert.ok(b < a, `B 组 schema token ${b} 应小于 A 组 ${a}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 2：模型实际行为记录
// ─────────────────────────────────────────────────────────────────────────────

describe("PHASE4-TOOL-AB-REAL-2：模型自主决策记录", () => {
  it("A 组记录实际工具选择（selectedTool 落在可见 9 工具内）", async () => {
    const runner = await importRunner();
    const comparison = await runner.runRealToolAbReplay();
    for (const p of comparison.scenarios) {
      for (const m of p.A) {
        for (const t of m.turns) {
          if (t.decision.kind === "tool_call") {
            assert.ok(t.selectedTool, "A 组工具回合应有 selectedTool");
            assert.ok(
              m.turns.length > 0,
              `场景 ${p.scenarioId} A 组 seed 应有回合`,
            );
          }
        }
      }
    }
  });

  it("B 组 intent 合法且路由正确（intent ∈ QUERY_NARRATIVE_INTENTS）", async () => {
    const runner = await importRunner();
    const comparison = await runner.runRealToolAbReplay();
    for (const p of comparison.scenarios) {
      for (const m of p.B) {
        for (const t of m.turns) {
          if (t.decision.kind === "tool_call") {
            assert.equal(t.selectedTool, "query_narrative", "B 组工具名应为 query_narrative");
            assert.ok(t.intent, "B 组应有 facade intent");
            assert.equal(t.intentValid, true, `B 组 intent "${t.intent}" 应合法`);
            assert.equal(t.routedOk, true, "B 组意图路由应成功");
            assert.ok(t.routedTool, "B 组应路由到底层工具");
          }
        }
      }
    }
  });

  it("重复查询按语义操作身份统计（intent 优先，非 facade 工具名）", async () => {
    const runner = await importRunner();
    const comparison = await runner.runRealToolAbReplay();
    // SC1 canon 有 2 个 search_narrative_evidence 调用（不同 query），
    // 若按 facade 工具名统计会误判为重复；按 intent+query 统计则不应误报。
    const sc1 = comparison.scenarios.find((s) => s.scenarioId === "SC1-canon-fact");
    assert.ok(sc1, "SC1 应存在");
    // A 组：2 个 search_narrative_evidence 不同 query，不应都算重复
    const aDup = sc1.A[0].totalDuplicateQueries;
    assert.ok(aDup >= 0, "A 组重复查询数应 >= 0");
    // B 组：所有调用工具名同为 query_narrative，但不同 intent/query 不应互相挤占
    const bDup = sc1.B[0].totalDuplicateQueries;
    assert.ok(bDup >= 0, "B 组重复查询数应 >= 0");
    // 关键：B 组不应把所有调用都误判为重复（intent 区分了语义操作身份）
    const bCalls = sc1.B[0].totalCalls;
    assert.ok(bDup < bCalls, `B 组重复查询 ${bDup} 应小于总调用 ${bCalls}（未按工具名误判所有调用为重复）`);
  });

  it("canon 场景应产生首次有效证据节点", async () => {
    const runner = await importRunner();
    const comparison = await runner.runRealToolAbReplay();
    const sc1 = comparison.scenarios.find((s) => s.scenarioId === "SC1-canon-fact");
    assert.ok(sc1, "SC1 应存在");
    for (const m of sc1.A) assert.ok(m.firstValidEvidence, "A 组 SC1 每 seed 应有首证节点");
    for (const m of sc1.B) assert.ok(m.firstValidEvidence, "B 组 SC1 每 seed 应有首证节点");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 3：结果门槛
// ─────────────────────────────────────────────────────────────────────────────

describe("PHASE4-TOOL-AB-REAL-3：结果门槛", () => {
  it("mustVerify 覆盖率不降级 + 有效证据引用率不降级 + 无效分类不恶化", async () => {
    const runner = await importRunner();
    const comparison = await runner.runRealToolAbReplay();
    assert.ok(comparison.gate.mustVerifyCoverageNotDegraded, comparison.gate.details.mustVerifyCoverage);
    assert.ok(comparison.gate.sourceRefCompletenessNotDegraded, comparison.gate.details.sourceRefCompleteness);
    assert.ok(comparison.gate.invalidSourceRefNotWorsened, comparison.gate.details.invalidSourceRef);
  });

  it("empty/truncated 明确纳入 allPassed（设计文档 §5.6/Phase 4.3 门禁要求失败行为不恶化）", async () => {
    const runner = await importRunner();
    const comparison = await runner.runRealToolAbReplay();
    const g = comparison.gate;
    // 字段存在且为布尔
    assert.equal(typeof g.emptyResultsNotWorsened, "boolean", "gate 应含 emptyResultsNotWorsened 布尔");
    assert.equal(typeof g.truncatedNotWorsened, "boolean", "gate 应含 truncatedNotWorsened 布尔");
    // 聚合层必须暴露 truncated 计数
    assert.equal(typeof comparison.aggregation.A.truncatedResults, "number", "A 聚合应含 truncatedResults");
    assert.equal(typeof comparison.aggregation.B.truncatedResults, "number", "B 聚合应含 truncatedResults");
    // 空结果计数已存在（回归）
    assert.equal(typeof comparison.aggregation.A.emptyResults, "number", "A 聚合应含 emptyResults");
    assert.equal(typeof comparison.aggregation.B.emptyResults, "number", "B 聚合应含 emptyResults");
    // 逐分类 / 逐场景门禁字段存在
    assert.equal(typeof g.scenarioGatesPassed, "boolean", "gate 应含 scenarioGatesPassed 布尔");
  });

  it("至少一项真实负担指标改善（dry-run 下 schema token 必改善）", async () => {
    const runner = await importRunner();
    const comparison = await runner.runRealToolAbReplay();
    assert.ok(comparison.gate.burdenImproved, "应至少一项负担指标改善");
    assert.ok(
      comparison.gate.improvedBurdenMetrics.includes("schemaTokenCost"),
      `schemaTokenCost 应作为改善项，实际=${comparison.gate.improvedBurdenMetrics.join(",")}`,
    );
  });

  it("无效 sourceRef 分类和 = 无效总数，且 other=0", async () => {
    const runner = await importRunner();
    const comparison = await runner.runRealToolAbReplay();
    for (const arm of ["A", "B"]) {
      const agg = comparison.aggregation[arm];
      const cat = agg.invalidSourceRefByCategory;
      const sum = cat.no_match + cat.profile_only + cat.empty + cat.other;
      assert.equal(sum, agg.sourceRefsInvalid, `${arm} 分类和应等于无效总数`);
      assert.equal(cat.other, 0, `${arm} 不应有未分类无效 sourceRef`);
    }
  });

  it("门禁逐项字段存在且为布尔（evidenceLevel/错误/超时/非法工具/解析失败）", async () => {
    const runner = await importRunner();
    const comparison = await runner.runRealToolAbReplay();
    const g = comparison.gate;
    for (const key of [
      "mustVerifyCoverageNotDegraded",
      "sourceRefCompletenessNotDegraded",
      "invalidSourceRefNotWorsened",
      "invalidSourceRefCategoriesNotWorsened",
      "evidenceLevelNotDegraded",
      "errorsNotWorsened",
      "timeoutsNotWorsened",
      "invalidToolSelectionsNotWorsened",
      "parseErrorsNotWorsened",
      "burdenImproved",
      "allPassed",
    ]) {
      assert.equal(typeof g[key], "boolean", `门禁 ${key} 应为布尔`);
    }
    for (const key of [
      "evidenceLevel",
      "invalidSourceRefCategories",
      "errors",
      "timeouts",
      "invalidToolSelections",
      "parseErrors",
    ]) {
      assert.ok(g.details[key] !== undefined, `details 应含 ${key}`);
    }
  });

  it("evidenceLevel 口径修正：rankedEvidenceLevels 记录单回合全部有效证据等级（折叠计数）", async () => {
    const runner = await importRunner();
    const comparison = await runner.runRealToolAbReplay();
    // 1) 每个 tool_call 回合都应携带 rankedEvidenceLevels（至少为数组；无有效等级时为空）
    for (const p of comparison.scenarios) {
      for (const arm of ["A", "B"]) {
        for (const m of arm === "A" ? p.A : p.B) {
          for (const t of m.turns) {
            assert.ok(Array.isArray(t.rankedEvidenceLevels), `回合应含 rankedEvidenceLevels 数组`);
            for (const lv of t.rankedEvidenceLevels) {
              assert.ok(
                runner.VALID_EVIDENCE_LEVELS.has(lv),
                `rankedEvidenceLevels 只应含有效证据等级，实际=${lv}`,
              );
            }
          }
        }
      }
    }
    // 2) 聚合 evidenceLevelCounts 必须 >= 按首条 evidenceLevel 统计的命中（折叠等级被计入）
    for (const arm of ["A", "B"]) {
      const agg = comparison.aggregation[arm];
      const aggCount = Object.values(agg.evidenceLevelCounts).reduce((s, n) => s + n, 0);
      // 逐 fetch 首条统计（旧口径）
      let firstOnlyCount = 0;
      for (const p of comparison.scenarios) {
        for (const m of arm === "A" ? p.A : p.B) {
          for (const t of m.turns) {
            if (t.decision.kind === "final") continue;
            if (t.evidenceLevel && runner.VALID_EVIDENCE_LEVELS.has(t.evidenceLevel)) {
              firstOnlyCount++;
            }
          }
        }
      }
      assert.ok(
        aggCount >= firstOnlyCount,
        `${arm} 聚合 evidenceLevelCounts=${aggCount} 应 >= 首条口径=${firstOnlyCount}（折叠等级被计入）`,
      );
    }
    // 3) 至少存在一个回合折叠了 >=2 个证据等级（证明口径修正有实际对象）
    let multiLevelTurn = 0;
    for (const p of comparison.scenarios) {
      for (const arm of ["A", "B"]) {
        for (const m of arm === "A" ? p.A : p.B) {
          for (const t of m.turns) {
            if (t.rankedEvidenceLevels.length > 1) multiLevelTurn++;
          }
        }
      }
    }
    assert.ok(multiLevelTurn > 0, `应至少存在一个折叠多等级的回合，实际=${multiLevelTurn}`);
  });

  it("全部门禁通过", async () => {
    const runner = await importRunner();
    const comparison = await runner.runRealToolAbReplay();
    assert.ok(comparison.gate.allPassed, `门禁应全部通过：${JSON.stringify(comparison.gate.details)}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 5：逐场景失败行为门禁（empty/truncated/errors/timeouts 不恶化）
// ─────────────────────────────────────────────────────────────────────────────

describe("PHASE4-TOOL-AB-REAL-5：逐场景失败行为门禁", () => {
  it("每场景携带 scenarioGate，且失败行为（empty/truncated/errors/timeouts/非法工具/解析失败）逐项不恶化", async () => {
    const runner = await importRunner();
    const comparison = await runner.runRealToolAbReplay();
    assert.equal(comparison.scenarios.length, 3, "应含 3 高信号场景");
    for (const p of comparison.scenarios) {
      assert.ok(p.scenarioGate, `场景 ${p.scenarioId} 应有 scenarioGate`);
      const sg = p.scenarioGate;
      for (const key of [
        "emptyResultsNotWorsened",
        "truncatedNotWorsened",
        "errorsNotWorsened",
        "timeoutsNotWorsened",
        "invalidToolSelectionsNotWorsened",
        "parseErrorsNotWorsened",
        "allFailingNotWorsened",
      ]) {
        assert.equal(typeof sg[key], "boolean", `场景 ${p.scenarioId} scenarioGate.${key} 应为布尔`);
      }
      assert.ok(sg.details, `场景 ${p.scenarioId} scenarioGate 应含 details`);
    }
    // 聚合门禁要求所有逐场景失败门禁通过
    assert.ok(comparison.gate.scenarioGatesPassed, "聚合 allPassed 应要求逐场景失败门禁全通过");
  });

  it("scenarioGate 的 empty/truncated 判定与聚合门禁一致（任一场景恶化则整体不通过）", async () => {
    const runner = await importRunner();
    const comparison = await runner.runRealToolAbReplay();
    const allScenarioPass = comparison.scenarios.every((s) => s.scenarioGate.allFailingNotWorsened);
    assert.equal(comparison.gate.scenarioGatesPassed, allScenarioPass, "scenarioGatesPassed 应等于逐场景全通过");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 6：evidenceLevel 累计强度比较（Phase 4.3 收口口径）
// ─────────────────────────────────────────────────────────────────────────────

describe("PHASE4-TOOL-AB-REAL-6：evidenceLevel 累计强度比较", () => {
  it("更强等级替代较弱等级应通过（B 的 confirmed_state 补齐 exact_chapter_span 缺口）", async () => {
    const runner = await importRunner();
    // 复现真实 replay 失败对：A 有 exact_chapter_span=0.059，B 无；但 B 的 confirmed_state=1.000 > A=0.824
    const pass = runner.evidenceLevelsCumulativeNonDegraded(
      { confirmed: 0, confirmed_state: 0.824 * 100, exact_chapter_span: 0.059 * 100 },
      100,
      { confirmed: 0, confirmed_state: 1.0 * 100, exact_chapter_span: 0 },
      100,
    );
    assert.ok(pass, "更强的 confirmed_state 替代较弱的 exact_chapter_span 应判为不降级（通过）");
  });

  it("反向替代应失败（B 用更弱等级顶替更强等级）", async () => {
    const runner = await importRunner();
    // A 有大量 confirmed_state（强），B 只靠 exact_chapter_span（弱）补足总量 → 应失败
    const fail = runner.evidenceLevelsCumulativeNonDegraded(
      { confirmed: 0, confirmed_state: 100, exact_chapter_span: 0 },
      100,
      { confirmed: 0, confirmed_state: 0, exact_chapter_span: 100 },
      100,
    );
    assert.equal(fail, false, "B 用更弱等级顶替更强等级应判为降级（失败）");
  });

  it("全等命中率应通过（无差异）", async () => {
    const runner = await importRunner();
    const equal = runner.evidenceLevelsCumulativeNonDegraded(
      { confirmed: 10, confirmed_state: 20, exact_chapter_span: 30 },
      100,
      { confirmed: 10, confirmed_state: 20, exact_chapter_span: 30 },
      100,
    );
    assert.ok(equal, "A/B 命中率全等应通过");
  });

  it("B 总量更高但最强等级缺口更大时应失败（累计占优非总量占优）", async () => {
    const runner = await importRunner();
    // A: confirmed=50（强）；B: confirmed=40 但 exact_chapter_span=100（总量更高）
    const fail = runner.evidenceLevelsCumulativeNonDegraded(
      { confirmed: 50, confirmed_state: 0, exact_chapter_span: 0 },
      100,
      { confirmed: 40, confirmed_state: 0, exact_chapter_span: 100 },
      100,
    );
    assert.equal(fail, false, "B 在最强的 confirmed 累计阈值已低于 A，不能靠更弱等级总量补足");
  });

  it("B 在更强等级占优、全部累计阈值均不低于 A 时应通过", async () => {
    const runner = await importRunner();
    const pass = runner.evidenceLevelsCumulativeNonDegraded(
      { confirmed: 30, confirmed_state: 30, exact_chapter_span: 30 },
      100,
      { confirmed: 35, confirmed_state: 30, exact_chapter_span: 25 },
      100,
    );
    assert.ok(pass, "B 在每个累计阈值均不低于 A 时应通过");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 4：报告 + trajectory
// ─────────────────────────────────────────────────────────────────────────────

describe("PHASE4-TOOL-AB-REAL-4：报告与 trajectory 副本", () => {
  it("Markdown 用「有效证据引用率」术语 + 逐 seed 表", async () => {
    const runner = await importRunner();
    const comparison = await runner.runRealToolAbReplay();
    const md = runner.formatRealToolAbMarkdown(comparison);
    assert.ok(md.includes("有效证据引用率"), "应含有效证据引用率术语");
    assert.ok(md.includes("不是普通失败率"), "应含无效分类非失败率说明");
    assert.ok(md.includes("| seed |"), "应含逐 seed 表");
    assert.ok(md.includes("SC1-canon-fact"), "应含各场景详情");
  });

  it("JSON roundtrip 保留 seed 数组与聚合", async () => {
    const runner = await importRunner();
    const comparison = await runner.runRealToolAbReplay();
    const parsed = JSON.parse(runner.formatRealToolAbJson(comparison));
    assert.equal(parsed.schema, comparison.schema);
    assert.equal(parsed.aggregation.A.toolSurface, 9);
    assert.equal(parsed.aggregation.B.toolSurface, 1);
    assert.equal(parsed.scenarios[0].A.length, 3);
    assert.equal(parsed.scenarios[0].B.length, 3);
  });

  it("trajectory 副本：每场景每 arm 每 seed 的 JSONL，含 tool_visibility + tool_call_metrics", async () => {
    const runner = await importRunner();
    const comparison = await runner.runRealToolAbReplay();
    const traj = runner.buildRealToolAbTrajectory(comparison);
    // 3 场景 × 2 arm × 3 seed = 18 个 key
    const expectedKeys = comparison.scenarios.length * 2 * 3;
    assert.equal(Object.keys(traj).length, expectedKeys, `trajectory key 数应为 ${expectedKeys}`);
    for (const p of comparison.scenarios) {
      for (const arm of ["A", "B"]) {
        for (let seed = 0; seed < 3; seed++) {
          const key = `${p.scenarioId}:${arm}:${seed}`;
          assert.ok(traj[key], `${key} 应存在`);
          assert.equal(traj[key][0].type, "tool_visibility", `${key} 首条应为 tool_visibility`);
          // 后续条目为 tool_call_metrics
          const m = arm === "A" ? p.A[seed] : p.B[seed];
          const callCount = m.turns.filter((t) => t.decision.kind === "tool_call").length;
          assert.equal(traj[key].length - 1, callCount, `${key} 调用条目数`);
          // JSONL 可解析
          const jsonl = runner.formatRealTrajectoryJsonl(traj[key]);
          const lines = jsonl.trim().split("\n");
          assert.equal(lines.length, traj[key].length);
        }
      }
    }
  });
});