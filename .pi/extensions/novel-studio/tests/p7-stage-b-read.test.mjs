/**
 * P7 Stage B-Read — 读侧切换（投影优先、旧文件回退）
 *
 * 阶段 B-Read 绑定约束（VERBATIM）：
 *   - 补齐必要审计事件（gate_evaluated 已携带 strategyContext/gates/stageResults 读侧证据）
 *   - 将 R1-R6 改为「投影优先、旧文件回退」的分段读路径
 *   - 保留旧文件回退；完成治理、成本、canary、batch 相关回归
 *   - 暂不执行 Stage C 写侧收口；暂不删除旧文件；暂不处理 SIGKILL / re-FactGuard
 *
 * 本文件覆盖 R1 + R2/R3 的读侧切换：
 *   R1  = loadStrategyTraceContext（strategyContext 读点）
 *   R2/R3 = readChapterCostStats（治理/成本读点，二者共享同一读点）
 *   读点定位 = loadQualityTraceProjection（投影优先读入口）
 *
 * R4（canary）校验物理产物 + hash，本质是文件内禀校验，保持文件读；R5/R6（batch）
 * 是路径引用非内容读，无需迁移——此三者不在此测试覆盖范围，见最终报告。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { loadQualityTraceProjection } from "../dist/v2/core/audit/trace-projection-reader.js";
import { loadStrategyTraceContext } from "../dist/handlers/strategy-feedback-trace-context.js";
import { readChapterCostStats } from "../dist/v2/governance/chapter-cost-snapshot.js";
import { createAuditRunSession } from "../dist/v2/core/audit/audit-run-session.js";
import { createQualityTraceRecorder } from "../dist/craft/quality-trace-recorder.js";

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 返回 audit store 使用的 workspace 目录（projectRoot/workspaces/{id}） */
function workspaceDir(root, workspaceId) {
  return join(root, "workspaces", workspaceId);
}

/** 构造一个已持久化的 run：run_started(chapterId) + 若干 gate_evaluated */
function persistRun(root, workspaceId, chapterId, chapterNumber, gates) {
  const session = createAuditRunSession({
    projectRoot: root,
    workspaceId,
    chapterId,
    chapterNumber,
    persist: true,
  });
  session.start({});
  const recorder = createQualityTraceRecorder({
    workspacePath: join(root, "workspaces"),
    workspaceId,
    chapterId,
    auditSink: session,
  });
  for (const gate of gates) recorder.recordGate(gate);
  return { session, recorder };
}

// ============================================================================
// R1：strategyContext 读点（投影优先 + 旧文件回退）
// ============================================================================

test("P7-BR-R1: 投影优先——审计流命中时读投影，旧文件即使存在也不覆盖", () => {
  const root = tmpRoot("p7br-r1-prio-");
  try {
    const ws = "ws-br";
    const chapterId = "12";
    const workspace = workspaceDir(root, ws);

    // 先写一份「陈旧」旧文件（modelVersion 与审计流不同），用于证明投影优先。
    const tracePath = join(workspace, "traces", `${chapterId}-quality-trace.json`);
    mkdirSync(join(workspace, "traces"), { recursive: true });
    writeFileSync(
      tracePath,
      JSON.stringify({
        schemaVersion: 1,
        workspaceId: ws,
        chapterId,
        strategyContext: { modelVersion: "stale-model", selectedStrategyIds: ["stale"] },
        gates: [],
      }),
    );

    // 审计流：run_started + gate_evaluated 携带策略上下文。
    persistRun(root, ws, chapterId, 12, [
      {
        stage: "author_style_optimization",
        status: "PASS",
        passed: true,
        blocked: false,
        score: 0.95,
        reason: "ok",
        issueTypes: [],
        revisionHints: [],
        evidence: {
          strategyContext: {
            modelVersion: "claude-4.6",
            selectedStrategyIds: ["s1", "s2"],
            sourceChapter: "11",
            opportunityType: "author_style",
          },
        },
      },
    ]);

    const ctx = loadStrategyTraceContext(root, ws, chapterId);
    assert.ok(ctx, "审计流命中时应返回投影上下文");
    assert.equal(ctx.modelVersion, "claude-4.6", "投影上下文应覆盖陈旧旧文件");
    assert.deepEqual(ctx.selectedStrategyIds, ["s1", "s2"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P7-BR-R1: 旧文件回退——无审计流时读旧 quality-trace.json", () => {
  const root = tmpRoot("p7br-r1-fb-");
  try {
    const ws = "ws-fb";
    const chapterId = "3";
    const workspace = workspaceDir(root, ws);
    const tracePath = join(workspace, "traces", `${chapterId}-quality-trace.json`);
    mkdirSync(join(workspace, "traces"), { recursive: true });
    writeFileSync(
      tracePath,
      JSON.stringify({
        schemaVersion: 1,
        workspaceId: ws,
        chapterId,
        strategyContext: { modelVersion: "legacy-model", selectedStrategyIds: ["L1"] },
        gates: [],
      }),
    );

    const ctx = loadStrategyTraceContext(root, ws, chapterId);
    assert.ok(ctx, "无审计流时应回退读旧文件");
    assert.equal(ctx.modelVersion, "legacy-model");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// R2/R3：治理/成本读点（投影优先 + 旧文件回退）
// ============================================================================

test("P7-BR-R2R3: 投影优先——审计流命中时按 gate.evidence.modelCalls 聚合成本", () => {
  const root = tmpRoot("p7br-r23-prio-");
  try {
    const ws = "ws-cost";
    const chapterId = "8";
    const workspace = workspaceDir(root, ws);

    persistRun(root, ws, chapterId, 8, [
      {
        stage: "v2_final_selected",
        status: "PASS",
        passed: true,
        blocked: false,
        score: 1,
        reason: "selected",
        issueTypes: [],
        revisionHints: [],
        evidence: {
          modelCalls: [
            { route: "claude", kind: "generate", model: "claude-4.6", durationMs: 1000, failed: false, provider: "claude" },
            { route: "glm", kind: "judge", model: "glm-4", durationMs: 500, failed: true, provider: "glm" },
          ],
        },
      },
    ]);

    const stats = readChapterCostStats(workspace, { approvalId: "appr-1", chapterId });
    assert.ok(stats, "审计流命中时应返回投影聚合成本");
    assert.equal(stats.totalCalls, 2);
    assert.equal(stats.totalDurationMs, 1500);
    assert.equal(stats.averageDurationMs, 750);
    assert.equal(stats.totalFailedCalls, 1);
    assert.deepEqual(stats.callsByProvider, { claude: 1, glm: 1 });
    assert.deepEqual(stats.callsByRoute, { claude: 1, glm: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P7-BR-R2R3: 旧文件回退——无审计流时读旧 trace 的 v2_final_selected gate", () => {
  const root = tmpRoot("p7br-r23-fb-");
  try {
    const ws = "ws-costfb";
    const chapterId = "9";
    const workspace = workspaceDir(root, ws);
    const tracePath = join(workspace, "traces", `${chapterId}-quality-trace.json`);
    mkdirSync(join(workspace, "traces"), { recursive: true });
    writeFileSync(
      tracePath,
      JSON.stringify({
        schemaVersion: 1,
        workspaceId: ws,
        chapterId,
        gates: [
          {
            stage: "v2_final_selected",
            evidence: {
              modelCalls: [
                { route: "qwen", kind: "generate", durationMs: 200, failed: false, provider: "qwen" },
              ],
            },
          },
        ],
      }),
    );

    const stats = readChapterCostStats(workspace, { approvalId: "appr-2", chapterId });
    assert.ok(stats, "无审计流时应回退读旧 trace");
    assert.equal(stats.totalCalls, 1);
    assert.equal(stats.totalDurationMs, 200);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 读点定位：chapterId 归一化（"ch" 前缀剥离）
// ============================================================================

test("P7-BR-reader: loadQualityTraceProjection 剥离 ch 前缀匹配 run_started.chapterId", () => {
  const root = tmpRoot("p7br-norm-");
  try {
    const ws = "ws-norm";
    const chapterId = "21";
    const workspace = workspaceDir(root, ws);

    persistRun(root, ws, chapterId, 21, [
      {
        stage: "v2_final_selected",
        status: "PASS",
        passed: true,
        blocked: false,
        score: 1,
        reason: "ok",
        issueTypes: [],
        revisionHints: [],
        evidence: { modelCalls: [{ route: "claude", kind: "generate", durationMs: 100 }] },
      },
    ]);

    // 传入 "ch21"（带前缀），应能匹配 run_started.chapterId="21"
    const projection = loadQualityTraceProjection(workspace, "ch21");
    assert.ok(projection, "应剥离 ch 前缀匹配到 run");
    assert.ok(projection.gates.length > 0, "应重建出 gate");
    assert.equal(projection.gates[0].stage, "v2_final_selected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
