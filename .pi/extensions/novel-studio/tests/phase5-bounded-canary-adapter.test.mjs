/**
 * Phase 5.1 bounded-canary completion-trace adapter focused 测试
 *
 * 覆盖 completion-trace-adapter.mjs 的三项证据补齐 + shadow→real 绑定：
 *   1. classifyFailureBucket / buildFailureMetrics：失败指标分桶
 *      （empty/truncated/error/timeout + blockRate/firstPass/recovery）
 *   2. buildModelFingerprint：模型指纹（detectedModel + providers + modelCalls）
 *   3. freezeResultArtifacts：结果 artifact 冻结（越界 trace 排除 + SHA-256）
 *   4. buildCompletionTrace：completion-trace 构造
 *      （toolMode 绑定、verdict 对齐门槛、sourceRunId/releaseId/authorizationId 绑定、
 *        schema 字段完整、结果 artifact 冻结进入 evidence）
 *
 * 依赖边界：本测试只import completion-trace-adapter.mjs（纯函数 + 单文件 IO），
 * 不依赖 dist/ 生产闭包，可在未 build 时独立运行。
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  classifyFailureBucket,
  buildFailureMetrics,
  buildModelFingerprint,
  freezeResultArtifacts,
  buildCompletionTrace,
} from "../scripts/canary/completion-trace-adapter.mjs";

// ============================================================================
// fixture：构造一个可复现的 CanaryChapterResult
// ============================================================================

/** 普通成功章（非 stub 模型调用） */
function okResult(overrides = {}) {
  return {
    workspaceId: "ws-canary",
    chapterId: "1",
    chapterNumber: 1,
    seed: 1,
    status: "ok",
    selectedSource: "agentic_style",
    outcomeType: "ok",
    chapterFilePath: null,
    textLength: 1500,
    durationMs: 5000,
    modelCalls: [
      { kind: "agentic", route: "v2_rawstage2_gemini31", actualProvider: "gemini31", actualModel: "gemini-3.1-pro", durationMs: 2000 },
      { kind: "editorial", route: "v2_amplified_gemini31", actualProvider: "gemini31", actualModel: "gemini-3.1-pro", durationMs: 3000 },
    ],
    tracePath: null,
    recoveryAttempted: false,
    recoverySucceeded: false,
    modelVersion: "gemini31",
    ...overrides,
  };
}

// ============================================================================
// 1. 失败指标分桶
// ============================================================================

describe("Phase 5.1 classifyFailureBucket", () => {
  it("status=ok 且文本正常 → null（不计入失败证据）", () => {
    assert.equal(classifyFailureBucket(okResult()), null);
  });

  it("status=ok 但空文本 → empty", () => {
    assert.equal(classifyFailureBucket(okResult({ textLength: 0 })), "empty");
  });

  it("status=ok 但文本过短（<200 字）→ truncated", () => {
    assert.equal(classifyFailureBucket(okResult({ textLength: 120 })), "truncated");
  });

  it("outcomeType=model_timeout → timeout", () => {
    assert.equal(
      classifyFailureBucket(okResult({ status: "blocked", outcomeType: "model_timeout" })),
      "timeout",
    );
  });

  it("其余非成功 → error", () => {
    assert.equal(
      classifyFailureBucket(okResult({ status: "blocked", outcomeType: "factguard_block" })),
      "error",
    );
    assert.equal(
      classifyFailureBucket(okResult({ status: "error", outcomeType: "unknown" })),
      "error",
    );
  });
});

describe("Phase 5.1 buildFailureMetrics 分桶聚合", () => {
  it("聚合 empty/truncated/error/timeout 并计算 blockRate/firstPass/recovery", () => {
    const results = [
      okResult(), // ok, first-pass
      okResult({ textLength: 0 }), // ok 但 empty
      okResult({ textLength: 80 }), // ok 但 truncated
      okResult({ status: "blocked", outcomeType: "model_timeout" }), // timeout
      okResult({ status: "error", outcomeType: "unknown" }), // error
    ];
    const fm = buildFailureMetrics(results);
    assert.equal(fm.total, 5);
    assert.equal(fm.empty, 1);
    assert.equal(fm.truncated, 1);
    assert.equal(fm.timeout, 1);
    assert.equal(fm.error, 1);
    assert.equal(fm.blockRate, 2 / 5); // blocked+error = 2
    // first-pass ok：3 章（正常 ok + empty + truncated 虽文本异常但 status=ok）
    assert.equal(fm.firstPassSuccessRate, 3 / 5);
    assert.equal(fm.recoverySuccessRate, null); // 无恢复尝试
  });

  it("恢复成功/尝试正确计入 recoverySuccessRate", () => {
    const results = [
      okResult(),
      okResult({ recoveryAttempted: true, recoverySucceeded: true }),
      okResult({ recoveryAttempted: true, recoverySucceeded: false, status: "blocked", outcomeType: "model_timeout" }),
    ];
    const fm = buildFailureMetrics(results);
    assert.equal(fm.recoverySuccessRate, 0.5);
    assert.equal(fm.blockRate, 0.3333); // round4(1/3)
  });

  it("零结果 → total=0、blockRate=0、recovery=null", () => {
    const fm = buildFailureMetrics([]);
    assert.equal(fm.total, 0);
    assert.equal(fm.blockRate, 0);
    assert.equal(fm.recoverySuccessRate, null);
  });
});

// ============================================================================
// 2. 模型指纹
// ============================================================================

describe("Phase 5.1 buildModelFingerprint", () => {
  it("聚合 provider 分布 + 总调用数 + detectedModel", () => {
    const results = [
      okResult(), // 2 gemini31 calls
      okResult({
        modelCalls: [
          { kind: "agentic", route: "x", actualProvider: "claude", actualModel: "claude-opus", durationMs: 100 },
        ],
      }),
    ];
    const fp = buildModelFingerprint(results);
    assert.equal(fp.modelCalls, 3);
    assert.equal(fp.providers.gemini31, 2);
    assert.equal(fp.providers.claude, 1);
    assert.equal(fp.detectedModel, "gemini31"); // 首个非 stub provider
  });

  it("全 stub → detectedModel 取首个 provider（stub）", () => {
    const fp = buildModelFingerprint([
      okResult({
        modelVersion: "stub",
        modelCalls: [{ kind: "agentic", route: "s", actualProvider: "stub", durationMs: 1 }],
      }),
    ]);
    assert.equal(fp.detectedModel, "stub");
    assert.equal(fp.providers.stub, 1);
  });

  it("空结果 → detectedModel=unknown、providers={}、modelCalls=0", () => {
    const fp = buildModelFingerprint([]);
    assert.equal(fp.detectedModel, "unknown");
    assert.deepEqual(fp.providers, {});
    assert.equal(fp.modelCalls, 0);
  });
});

// ============================================================================
// 3. 结果 artifact 冻结
// ============================================================================

describe("Phase 5.1 freezeResultArtifacts", () => {
  let tmp;
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("收录 workspace 内 quality-trace 并计算 SHA-256，越界 trace 排除", () => {
    tmp = mkdtempSync(join(tmpdir(), "phase5-adapt-"));
    const ws = join(tmp, "ws");
    const tracesDir = join(ws, "traces");
    mkdirSync(tracesDir, { recursive: true });
    const traceContent = JSON.stringify({ runId: "r1", status: "ok" });
    writeFileSync(join(tracesDir, "1-quality-trace.json"), traceContent, "utf8");

    const results = [
      okResult({ tracePath: join(tracesDir, "1-quality-trace.json") }),
      // 越界 trace（位于 ws 之外）应被排除
      okResult({ tracePath: join(tmp, "outside.json") }),
    ];
    const arts = freezeResultArtifacts(results, ws);
    assert.equal(arts.observedChapters, 1);
    assert.equal(arts.observedCalls, 4); // 2 结果 × 2 个 modelCalls（okResult 默认）
    assert.equal(arts.refs.length, 1);
    assert.equal(arts.refs[0], join("traces", "1-quality-trace.json").split("\\").join("/"));
    assert.equal(typeof arts.hashes[arts.refs[0]], "string");
    assert.equal(arts.hashes[arts.refs[0]].length, 64);
  });

  it("无 tracePath → refs 空、observedChapters=0", () => {
    tmp = mkdtempSync(join(tmpdir(), "phase5-adapt-"));
    const ws = join(tmp, "ws");
    mkdirSync(ws, { recursive: true });
    const arts = freezeResultArtifacts([okResult({ tracePath: null })], ws);
    assert.equal(arts.refs.length, 0);
    assert.equal(arts.observedChapters, 0);
  });
});

// ============================================================================
// 4. completion-trace 构造
// ============================================================================

describe("Phase 5.1 buildCompletionTrace", () => {
  let tmp;
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  function makeTraceResults() {
    tmp = mkdtempSync(join(tmpdir(), "phase5-adapt-"));
    const ws = join(tmp, "ws");
    mkdirSync(join(ws, "traces"), { recursive: true });
    writeFileSync(join(ws, "traces", "1-quality-trace.json"), JSON.stringify({ status: "ok" }), "utf8");
    const results = [
      okResult({ tracePath: join(ws, "traces", "1-quality-trace.json") }),
      okResult({ chapterId: "2", chapterNumber: 2, seed: 2, textLength: 0 }), // empty 失败
    ];
    return { ws, results };
  }

  function baseParams(overrides = {}) {
    return {
      runId: "r-complete",
      sourceRunId: "r-shadow",
      releaseId: "rel-1",
      previousReleaseId: null,
      workspaceId: "ws-canary",
      workspacePath: tmp,
      toolMode: "facade",
      authorizationId: "auth-1",
      environmentFingerprint: "fp-abc",
      approvalRef: "apr-1",
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T00:01:00.000Z",
      changeClass: "R2",
      currentStatus: "evaluated",
      strategy: "bounded_canary",
      results: [],
      ...overrides,
    };
  }

  it("toolMode 绑定 + sourceRunId/releaseId/authorizationId 绑定 + schema 字段", () => {
    const { ws, results } = makeTraceResults();
    const trace = buildCompletionTrace(baseParams({ workspacePath: ws, results }));
    assert.equal(trace.schemaId, "pinovel.canary-run-trace");
    assert.equal(trace.schemaVersion, 1);
    assert.equal(trace.runId, "r-complete");
    assert.equal(trace.status, "completed");
    assert.equal(trace.strategy, "bounded_canary");
    assert.equal(trace.evidence.toolMode, "facade");
    assert.equal(trace.evidence.sourceRunId, "r-shadow");
    assert.equal(trace.releaseId, "rel-1");
    assert.equal(trace.evidence.authorizationId, "auth-1");
    assert.equal(trace.evidence.environmentFingerprint, "fp-abc");
    assert.equal(trace.evidence.approvalRef, "apr-1");
    assert.equal(trace.evidence.changeClass, "R2");
    assert.equal(trace.evidence.currentStatus, "evaluated");
    assert.equal(trace.shadowPendingRealRun, false);
  });

  it("失败指标与模型指纹进入 evidence", () => {
    const { ws, results } = makeTraceResults();
    const trace = buildCompletionTrace(baseParams({ workspacePath: ws, results }));
    // 2 章：1 ok + 1 empty → blockRate=0（empty 算文本异常但不计为 blocked/error）
    assert.equal(trace.evidence.failureMetrics.total, 2);
    assert.equal(trace.evidence.failureMetrics.empty, 1);
    assert.equal(trace.evidence.failureMetrics.truncated, 0);
    assert.equal(trace.evidence.failureMetrics.blockRate, 0);
    // 模型指纹
    assert.equal(trace.evidence.modelFingerprint.modelCalls, 4); // 2 章 × 2 calls
    assert.equal(trace.evidence.modelFingerprint.providers.gemini31, 4);
    assert.equal(trace.evidence.modelFingerprint.detectedModel, "gemini31");
    // artifact 冻结（只收录 ws 内 trace）
    assert.equal(trace.evidence.observedChapters, 1);
    assert.equal(trace.evidence.observedCalls, 4);
    assert.equal(trace.evidence.resultArtifactRefs.length, 1);
  });

  it("verdict=pass：阻断率 ≤ 50%、无未知失败、恢复率合格", () => {
    const { ws, results } = makeTraceResults();
    const trace = buildCompletionTrace(baseParams({ workspacePath: ws, results }));
    assert.equal(trace.evidence.verdict, "pass");
  });

  it("verdict=fail：blockRate > 50%", () => {
    const { ws } = makeTraceResults();
    const results = [
      okResult({ status: "blocked", outcomeType: "factguard_block" }),
      okResult({ status: "error", outcomeType: "unknown" }),
    ];
    const trace = buildCompletionTrace(baseParams({ workspacePath: ws, results }));
    assert.equal(trace.evidence.verdict, "fail");
  });

  it("verdict=fail：存在未知失败（outcomeType=unknown）", () => {
    const { ws } = makeTraceResults();
    const results = [
      okResult(),
      okResult({ status: "error", outcomeType: "unknown" }),
    ];
    const trace = buildCompletionTrace(baseParams({ workspacePath: ws, results }));
    assert.equal(trace.evidence.failureMetrics.unknown, 1);
    assert.equal(trace.evidence.verdict, "fail");
  });

  it("verdict=fail：零结果", () => {
    const { ws } = makeTraceResults();
    const trace = buildCompletionTrace(baseParams({ workspacePath: ws, results: [] }));
    assert.equal(trace.evidence.verdict, "fail");
  });

  it("verdict=fail：恢复成功率 < 85%", () => {
    const { ws } = makeTraceResults();
    const results = [
      okResult(),
      okResult({ recoveryAttempted: true, recoverySucceeded: false, status: "blocked", outcomeType: "model_timeout" }),
    ];
    const trace = buildCompletionTrace(baseParams({ workspacePath: ws, results }));
    assert.ok(trace.evidence.failureMetrics.recoverySuccessRate < 0.85);
    assert.equal(trace.evidence.verdict, "fail");
  });
});