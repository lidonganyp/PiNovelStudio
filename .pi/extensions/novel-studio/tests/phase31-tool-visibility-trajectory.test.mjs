/**
 * Phase 3.1 收口：完整 eval-only replay 的 tool_visibility trajectory 核对。
 *
 * 与 phase31-tool-visibility-runtime.test.mjs 的区别：
 * - runtime 测试用 stub runtime + 内存 trajectory（Proxy 空实现），只验证"注入链路"。
 * - 本测试用真实 createAgenticRawCandidateSource（经 runAgentLoopForEval 的 b2 全链路），
 *   产出真实持久化 trajectory.jsonl，并读取其中的 tool_visibility / tool_call_metrics 条目，
 *   核对 allowedTools → runtime tools → schema → visibleTools 全链路。
 *
 * 持久化证据：trajectory 落盘到
 *   workspaces/{workspaceId}/novelos-sessions/{sessionId}/trajectory.jsonl
 * 测试运行期间保留 workspace（不清理），读取后再清理，保证证据被真实读取而非内存伪造。
 *
 * 使用 stub model，零真实模型调用，确定性可复现。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { setupFixtureWorkspace, runAgentLoopForEval } from "../dist-eval/novelos/eval/eval-harness.js";
import { EVAL_FIXTURES } from "../dist-eval/novelos/eval/fixtures.js";
import { injectToolSchemas, REACT_CALLING_CONVENTION } from "../dist/novelos/adapters/tool-schema-injector.js";
import { createNarrativeTools, NARRATIVE_TOOL_NAMES } from "../dist/novelos/tools/narrative-tools.js";
import { createNarrativeSearchService } from "../dist/novelos/agent/narrative-search-service.js";

/** 读取 trajectory.jsonl，按 type 分组返回条目 */
function readTrajectory(trajectoryPath) {
  const byType = new Map();
  for (const line of readFileSync(trajectoryPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (!byType.has(entry.type)) byType.set(entry.type, []);
    byType.get(entry.type).push(entry.data);
  }
  return byType;
}

const fixture = EVAL_FIXTURES.find((f) => f.id === "F1-historical-fact");
assert.ok(fixture, "应存在 F1-historical-fact fixture");

test("Phase 3.1 · 完整 eval-only replay 产出持久化 tool_visibility trajectory", async () => {
  const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);
  try {
    // b2 = enableRetrieval=true, enableVerification=false（有检索工具，可触发工具调用）
    const result = await runAgentLoopForEval(fixture, "b2", projectRoot, workspaceId);

    // 1. 持久化证据：trajectory 文件必须真实存在
    assert.ok(result.trajectoryPath, "应返回 trajectoryPath");
    assert.ok(existsSync(result.trajectoryPath), "trajectory.jsonl 应真实落盘（持久化 trace 证据）");

    const byType = readTrajectory(result.trajectoryPath);

    // 2. 完整回放：session_start → ... → session_end 应齐全
    assert.ok(byType.has("session_start"), "trajectory 应含 session_start");
    assert.ok(byType.has("session_end"), "trajectory 应含 session_end（loop 完成）");

    // 3. 必须存在 tool_visibility 条目（决策后的真实可见集快照）
    assert.ok(byType.has("tool_visibility"), "trajectory 应含 tool_visibility 条目");
    const vis = byType.get("tool_visibility");
    assert.ok(vis.length >= 1, "应至少有一条 tool_visibility 快照");
    const snapshot = vis[vis.length - 1];

    // ── 全链路核对：allowedTools → runtime tools → schema → visibleTools ──
    // 链路1：visibleTools ⊆ systemAllowedTools（allowedTools 决定 runtime 工具的子集）
    assert.ok(Array.isArray(snapshot.systemAllowedTools), "systemAllowedTools 应为数组");
    assert.ok(snapshot.systemAllowedTools.length > 0, "systemAllowedTools 非空");
    assert.ok(Array.isArray(snapshot.visibleTools), "visibleTools 应为数组");
    assert.ok(snapshot.visibleTools.length > 0, "visibleTools 非空（b2 检索模式应暴露工具）");
    for (const t of snapshot.visibleTools) {
      assert.ok(
        snapshot.systemAllowedTools.includes(t),
        `visibleTools={t} 必须在 systemAllowedTools（allowedTools→runtime工具 失败）`,
      );
    }

    // 链路2：AGENTIC-EVIDENCE-MERGE-1 后快照只记录 systemAllowedTools / visibleTools，
    // 不再记录模型决策的 selectedTools / rejectedTools（独立证据决策回合已退役）。
    assert.equal("rejectedTools" in snapshot, false, "快照不应再含 rejectedTools（模型决策字段已移除）");
    assert.equal("selectedTools" in snapshot, false, "快照不应再含 selectedTools（模型决策字段已移除）");

    // 链路3：runtime tools / schema — 用与 runtime 相同的构造重建真实工具对象，
    // 断言「过滤后的真实工具名 == visibleTools」，且这些工具可被 injectToolSchemas 注入。
    const searchService = createNarrativeSearchService({
      projectRoot,
      workspaceId,
      sourceChapter: fixture.chapterIntent.chapterId ?? "ch3",
    });
    const allTools = createNarrativeTools({ searchService });
    const visibleFiltered = allTools.filter((t) => snapshot.visibleTools.includes(t.name));
    assert.equal(
      visibleFiltered.length,
      snapshot.visibleTools.length,
      "runtime 构造中 visibleTools 应能全部映射到真实工具对象（无缺失）",
    );
    assert.deepEqual(
      visibleFiltered.map((t) => t.name).sort(),
      [...snapshot.visibleTools].sort(),
      "runtime tools（过滤后）应与 trajectory 的 visibleTools 完全一致",
    );
    // 显式复现注入：schema 只含 visibleTools，且全部在白名单内（schema→visibleTools 一致）
    const injected = injectToolSchemas("你是网文作家。", visibleFiltered, NARRATIVE_TOOL_NAMES);
    assert.ok(injected.includes(REACT_CALLING_CONVENTION), "注入应含调用约定（schema 注入生效）");
    for (const t of snapshot.visibleTools) {
      assert.ok(NARRATIVE_TOOL_NAMES.has(t), `visibleTools={t} 应在叙事工具白名单内`);
    }

    // 链路4：实际执行的工具 ⊆ visibleTools（runtime 真正执行的工具都在可见集内）
    const metrics = byType.get("tool_call_metrics") ?? [];
    for (const m of metrics) {
      assert.ok(
        snapshot.visibleTools.includes(m.toolName),
        `实际执行的工具={m.toolName} 必须在 visibleTools 内（runtime工具→schema 一致性）`,
      );
    }
  } finally {
    cleanup();
  }
}, { timeout: 120_000 });

/**
 * AGENTIC-EVIDENCE-MERGE-1 可观测性：完整 b3 路径（retrieval + verify/patch + coverage gate）
 * 应返回 trace 可观测聚合字段，直接解释 Agentic 在 ReAct 循环内实际做了什么。
 *
 * 断言口径（计划 §5.6 trace 新契约）：
 * - decisionMode 恒为 "agentic_inline"（独立证据决策回合已合并进首轮）
 * - firstAction ∈ {"draft","tool_call"}（首回合实际动作）
 * - actualRetrievalCalls 为非负整数（实际检索类工具调用数）
 * - mustVerifyCount / mustVerifyCoveredCount 为非负整数，covered ≤ total
 * - coverageResult 存在（b3 含 coverage gate）
 * - modelCallsByKind 含 draft/patch/verify 三个非负整数
 */
test("AGENTIC-EVIDENCE-MERGE-1 · 完整 b3 路径产出可观测聚合 trace 字段", async () => {
  const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);
  try {
    // b3 = enableRetrieval=true, enableVerification=true, enableCoverageGate=true（全链路）
    const result = await runAgentLoopForEval(fixture, "b3", projectRoot, workspaceId);

    // 1. 决策模式：独立 EvidenceDecision 已退役，恒为 agentic_inline
    assert.equal(result.decisionMode, "agentic_inline", "decisionMode 应恒为 agentic_inline");

    // 2. 首回合实际动作（draft 或 tool_call）
    assert.ok(
      result.firstAction === "draft" || result.firstAction === "tool_call",
      `firstAction 应为 draft 或 tool_call，实际=${result.firstAction}`,
    );

    // 3. 实际检索调用数：非负整数
    assert.equal(Number.isInteger(result.actualRetrievalCalls), true, "actualRetrievalCalls 应为整数");
    assert.ok(result.actualRetrievalCalls >= 0, "actualRetrievalCalls 应 ≥ 0");

    // 4. mustVerify 覆盖：total ≥ covered ≥ 0
    assert.equal(Number.isInteger(result.mustVerifyCount), true, "mustVerifyCount 应为整数");
    assert.ok(result.mustVerifyCount >= 0, "mustVerifyCount 应 ≥ 0");
    assert.equal(Number.isInteger(result.mustVerifyCoveredCount), true, "mustVerifyCoveredCount 应为整数");
    assert.ok(result.mustVerifyCoveredCount >= 0, "mustVerifyCoveredCount 应 ≥ 0");
    assert.ok(
      result.mustVerifyCoveredCount <= result.mustVerifyCount,
      "mustVerifyCoveredCount 不应超过 mustVerifyCount",
    );

    // 5. coverage gate 结果存在（b3 全链路含 coverage gate）
    assert.ok(result.coverageResult, "b3 路径应返回 coverageResult");
    assert.equal(typeof result.coverageResult.passed, "boolean", "coverageResult.passed 应为布尔");

    // 6. 按阶段模型调用数：draft/patch/verify 三个非负整数，总量 ≥ draft（至少一次 draft 调用）
    const m = result.modelCallsByKind;
    assert.ok(m && typeof m === "object", "modelCallsByKind 应存在");
    for (const k of ["draft", "patch", "verify"]) {
      assert.equal(Number.isInteger(m[k]), true, `modelCallsByKind.${k} 应为整数`);
      assert.ok(m[k] >= 0, `modelCallsByKind.${k} 应 ≥ 0`);
    }
    assert.ok(m.draft >= 1, "draft 阶段至少应有 1 次模型调用");
  } finally {
    cleanup();
  }
}, { timeout: 120_000 });