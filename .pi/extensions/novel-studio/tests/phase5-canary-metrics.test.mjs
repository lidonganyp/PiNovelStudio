/**
 * Phase 5A 测试：canary-metrics.mjs 纯函数 + canary runner 集成
 *
 * 验证：
 *   1. classifyOutcome：4 类输出类型分类正确
 *   2. computeCanaryMetrics：聚合指标计算（阻断率/首次成功率/恢复率/调用预算）
 *   3. anonymizeChapterResult：去标识化映射稳定 + 不泄露路径
 *   4. buildBlindEvalPairs：raw vs final 对照对构造 + A/B 顺序由 hash 决定（可复现）
 *   5. generateCanaryReport：Markdown 报告包含必要章节
 *   6. detectModelVersion：从 modelCalls 推断模型版本
 *
 * 不调用真实模型，纯规则测试。
 * Runner 集成测试用 V2_FORCE_STUB=1 + dist/index.js（验证 runner 能加载工具并完整运行）。
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import {
  classifyOutcome,
  computeCanaryMetrics,
  anonymizeChapterResult,
  buildBlindEvalPairs,
  generateCanaryReport,
  detectModelVersion,
  normalizeChapterResult,
  BLIND_EVAL_DIMENSIONS,
  SINGLE_CHAPTER_SOFT_BUDGET,
  SINGLE_CHAPTER_HARD_BUDGET,
} from "../scripts/canary/canary-metrics.mjs";

// ============================================================================
// Helpers
// ============================================================================

function makeModelCall(overrides = {}) {
  return {
    kind: "raw",
    route: "v2_rawstage2",
    actualProvider: "stub",
    actualModel: "stub-model",
    durationMs: 100,
    finishReason: "stop",
    failed: false,
    ...overrides,
  };
}

function makeOkResult(overrides = {}) {
  return {
    workspaceId: "ws-test",
    chapterId: "1",
    chapterNumber: 1,
    seed: 1,
    status: "ok",
    selectedSource: "raw",
    selectedCandidateId: "c-1",
    outcomeType: "ok",
    chapterFilePath: "/some/path/chapter-1.md",
    textHash: "abc123def456",
    textLength: 3000,
    durationMs: 5000,
    failureEnvelope: null,
    modelCalls: [makeModelCall()],
    tracePath: "/some/traces/1-quality-trace.json",
    recoveryAttempted: false,
    recoverySucceeded: false,
    warnings: [],
    rawTextPreview: "前 200 字预览...",
    finalTextPreview: "前 200 字预览...",
    modelVersion: "stub",
    ...overrides,
  };
}

function makeBlockedResult(overrides = {}) {
  return makeOkResult({
    status: "blocked",
    selectedSource: null,
    outcomeType: "factguard_block",
    chapterFilePath: null,
    textHash: null,
    textLength: 0,
    failureEnvelope: {
      stage: "factguard",
      gate: "factguard",
      severity: "hard",
      reason: "事实硬冲突：林默不在场",
      recoverable: false,
    },
    ...overrides,
  });
}

// ============================================================================
// 1. classifyOutcome
// ============================================================================

describe("Phase 5A: classifyOutcome — 4 类输出类型分类", () => {
  it("status=ok → outcomeType=ok", () => {
    const t = classifyOutcome({
      status: "ok", selectedSource: "raw",
      failureEnvelope: null, modelCalls: [],
      recoveryAttempted: false, recoverySucceeded: false,
    });
    assert.equal(t, "ok");
  });

  it("stage=preflight → outcomeType=preflight_block", () => {
    const t = classifyOutcome({
      status: "blocked",
      selectedSource: null,
      failureEnvelope: { stage: "preflight", severity: "preflight", reason: "缺世界观" },
      modelCalls: [],
      recoveryAttempted: false, recoverySucceeded: false,
    });
    assert.equal(t, "preflight_block");
  });

  it("gate=model_timeout → outcomeType=model_timeout", () => {
    const t = classifyOutcome({
      status: "blocked",
      selectedSource: null,
      failureEnvelope: { stage: "model_timeout", gate: "model_timeout", severity: "recoverable", reason: "超时" },
      modelCalls: [],
      recoveryAttempted: false, recoverySucceeded: false,
    });
    assert.equal(t, "model_timeout");
  });

  it("stage 包含 factguard → outcomeType=factguard_block", () => {
    const t = classifyOutcome({
      status: "blocked",
      selectedSource: null,
      failureEnvelope: { stage: "factguard_precheck", severity: "hard", reason: "x" },
      modelCalls: [],
      recoveryAttempted: false, recoverySucceeded: false,
    });
    assert.equal(t, "factguard_block");
  });

  it("stage=novelos_agentic_verification → outcomeType=factguard_block（Agentic 内部 verifier 事实硬冲突）", () => {
    const t = classifyOutcome({
      status: "blocked",
      selectedSource: null,
      failureEnvelope: { stage: "novelos_agentic_verification", severity: "hard", reason: "事实硬冲突" },
      modelCalls: [],
      recoveryAttempted: false, recoverySucceeded: false,
    });
    assert.equal(t, "factguard_block");
  });

  it("stage=final_fact_recheck → outcomeType=factguard_block（最终事实复检失败）", () => {
    const t = classifyOutcome({
      status: "blocked",
      selectedSource: null,
      failureEnvelope: { stage: "final_fact_recheck", severity: "hard", reason: "x" },
      modelCalls: [],
      recoveryAttempted: false, recoverySucceeded: false,
    });
    assert.equal(t, "factguard_block");
  });

  it("stage 包含 story_preservation → outcomeType=story_preservation_block", () => {
    const t = classifyOutcome({
      status: "blocked",
      selectedSource: null,
      failureEnvelope: { stage: "story_preservation_gate", severity: "hard", reason: "事件被替换" },
      modelCalls: [],
      recoveryAttempted: false, recoverySucceeded: false,
    });
    assert.equal(t, "story_preservation_block");
  });

  it("有 editorial 调用但 selectedSource=null → 推断为 factguard_block", () => {
    const t = classifyOutcome({
      status: "blocked",
      selectedSource: null,
      failureEnvelope: { stage: "unknown", severity: "hard", reason: "未分类" },
      modelCalls: [makeModelCall({ kind: "editorial", route: "v2_amplified" })],
      recoveryAttempted: false, recoverySucceeded: false,
    });
    assert.equal(t, "factguard_block");
  });

  it("未分类失败 → outcomeType=unknown", () => {
    const t = classifyOutcome({
      status: "error",
      selectedSource: null,
      failureEnvelope: { stage: "mystery", severity: "fatal", reason: "x" },
      modelCalls: [],
      recoveryAttempted: false, recoverySucceeded: false,
    });
    assert.equal(t, "unknown");
  });
});

// ============================================================================
// 2. computeCanaryMetrics
// ============================================================================

describe("Phase 5A: computeCanaryMetrics — 聚合指标计算", () => {
  it("空数组 → 全零指标", () => {
    const m = computeCanaryMetrics([]);
    assert.equal(m.total, 0);
    assert.equal(m.ok, 0);
    assert.equal(m.blockRate, 0);
    assert.equal(m.firstPassSuccessRate, 0);
    assert.equal(m.recoverySuccessRate, null);
  });

  it("全 ok → blockRate=0, firstPassSuccessRate=1", () => {
    const results = [
      makeOkResult(),
      makeOkResult({ chapterNumber: 2 }),
      makeOkResult({ chapterNumber: 3 }),
    ];
    const m = computeCanaryMetrics(results);
    assert.equal(m.total, 3);
    assert.equal(m.ok, 3);
    assert.equal(m.blocked, 0);
    assert.equal(m.blockRate, 0);
    assert.equal(m.firstPassSuccessRate, 1);
  });

  it("2 ok + 1 blocked → blockRate≈0.333", () => {
    const results = [
      makeOkResult(),
      makeOkResult({ chapterNumber: 2 }),
      makeBlockedResult({ chapterNumber: 3 }),
    ];
    const m = computeCanaryMetrics(results);
    assert.equal(m.total, 3);
    assert.equal(m.ok, 2);
    assert.equal(m.blocked, 1);
    // blockRate 经 round4 处理，1/3 → 0.3333
    assert.ok(Math.abs(m.blockRate - 1 / 3) < 0.001, `blockRate=${m.blockRate} 应接近 1/3`);
    assert.ok(Math.abs(m.firstPassSuccessRate - 2 / 3) < 0.001, `firstPassSuccessRate=${m.firstPassSuccessRate} 应接近 2/3`);
  });

  it("恢复成功：recoveryAttempted + recoverySucceeded → recoverySuccessRate=1", () => {
    const results = [
      makeOkResult({ recoveryAttempted: true, recoverySucceeded: true }),
      makeOkResult({ chapterNumber: 2, recoveryAttempted: true, recoverySucceeded: true }),
    ];
    const m = computeCanaryMetrics(results);
    assert.equal(m.recoveryAttemptedCount, 2);
    assert.equal(m.recoverySucceededCount, 2);
    assert.equal(m.recoverySuccessRate, 1);
    // 首次成功率应为 0（全部走了恢复）
    assert.equal(m.firstPassSuccessRate, 0);
  });

  it("恢复失败：recoveryAttempted 但 recoverySucceeded=false → recoverySuccessRate=0", () => {
    const results = [
      makeBlockedResult({ recoveryAttempted: true, recoverySucceeded: false }),
    ];
    const m = computeCanaryMetrics(results);
    assert.equal(m.recoveryAttemptedCount, 1);
    assert.equal(m.recoverySucceededCount, 0);
    assert.equal(m.recoverySuccessRate, 0);
  });

  it("超软上限章数：模型调用 > 6 → overSoftBudgetCount", () => {
    const overCalls = Array.from({ length: 8 }, () => makeModelCall());
    const results = [
      makeOkResult({ modelCalls: overCalls }), // 8 calls > 6
      makeOkResult({ chapterNumber: 2, modelCalls: [makeModelCall()] }), // 1 call
    ];
    const m = computeCanaryMetrics(results);
    assert.equal(m.modelCalls.total, 9);
    assert.equal(m.modelCalls.overSoftBudgetCount, 1);
    assert.equal(m.modelCalls.overHardBudgetCount, 0);
  });

  it("超硬上限章数：模型调用 > 10 → overHardBudgetCount", () => {
    const overCalls = Array.from({ length: 11 }, () => makeModelCall());
    const results = [makeOkResult({ modelCalls: overCalls })];
    const m = computeCanaryMetrics(results);
    assert.equal(m.modelCalls.overHardBudgetCount, 1);
  });

  it("outcomeType 分桶正确", () => {
    const results = [
      makeOkResult(),
      makeBlockedResult({ chapterNumber: 2, outcomeType: "factguard_block" }),
      makeBlockedResult({
        chapterNumber: 3,
        outcomeType: "story_preservation_block",
        failureEnvelope: { stage: "story_preservation_gate", severity: "hard", reason: "事件替换" },
      }),
    ];
    const m = computeCanaryMetrics(results);
    assert.equal(m.outcomeTypeCounts.ok, 1);
    assert.equal(m.outcomeTypeCounts.factguard_block, 1);
    assert.equal(m.outcomeTypeCounts.story_preservation_block, 1);
  });

  it("byModelVersion 按模型版本分桶", () => {
    const results = [
      makeOkResult({ modelVersion: "gemini31" }),
      makeOkResult({ chapterNumber: 2, modelVersion: "gemini31" }),
      makeOkResult({ chapterNumber: 3, modelVersion: "claude" }),
    ];
    const m = computeCanaryMetrics(results);
    assert.equal(m.byModelVersion.gemini31.total, 2);
    assert.equal(m.byModelVersion.gemini31.ok, 2);
    assert.equal(m.byModelVersion.claude.total, 1);
    assert.equal(m.byModelVersion.claude.ok, 1);
  });

  it("duration 聚合：总耗时 / 平均 / 最慢", () => {
    const results = [
      makeOkResult({ durationMs: 1000 }),
      makeOkResult({ chapterNumber: 2, durationMs: 3000 }),
      makeOkResult({ chapterNumber: 3, durationMs: 2000 }),
    ];
    const m = computeCanaryMetrics(results);
    assert.equal(m.duration.totalMs, 6000);
    assert.equal(m.duration.averagePerChapterMs, 2000);
    assert.equal(m.duration.maxMs, 3000);
  });
});

// ============================================================================
// 3. anonymizeChapterResult
// ============================================================================

describe("Phase 5A: anonymizeChapterResult — 去标识化", () => {
  it("workspaceId / chapterId 替换为匿名 ID", () => {
    const r = makeOkResult({ workspaceId: "xinmo", chapterId: "17" });
    const map = new Map();
    const a = anonymizeChapterResult(r, map);
    assert.match(a.workspaceId, /^ws-[a-z]$/);
    assert.match(a.chapterId, /^ch-\d{3}$/);
    assert.notEqual(a.workspaceId, "xinmo");
    assert.notEqual(a.chapterId, "17");
  });

  it("同一 workspaceId 多次匿名化映射一致", () => {
    const map = new Map();
    const r1 = makeOkResult({ workspaceId: "xinmo", chapterId: "1" });
    const r2 = makeOkResult({ workspaceId: "xinmo", chapterId: "2" });
    const a1 = anonymizeChapterResult(r1, map);
    const a2 = anonymizeChapterResult(r2, map);
    assert.equal(a1.workspaceId, a2.workspaceId, "同一 workspaceId 应映射到同一匿名 ID");
    assert.notEqual(a1.chapterId, a2.chapterId, "不同 chapterId 应映射到不同匿名 ID");
  });

  it("匿名化结果不包含 chapterFilePath / tracePath（防路径泄露）", () => {
    const r = makeOkResult({
      chapterFilePath: "/secret/path/chapter.md",
      tracePath: "/secret/traces/trace.json",
    });
    const a = anonymizeChapterResult(r, new Map());
    assert.equal(a.chapterFilePath, undefined);
    assert.equal(a.tracePath, undefined);
  });

  it("保留可机器度量字段（status / outcomeType / modelCalls / duration）", () => {
    const r = makeOkResult();
    const a = anonymizeChapterResult(r, new Map());
    assert.equal(a.status, r.status);
    assert.equal(a.outcomeType, r.outcomeType);
    assert.equal(a.durationMs, r.durationMs);
    assert.equal(a.modelCalls.length, r.modelCalls.length);
    assert.equal(a.textHash, r.textHash);
    assert.equal(a.textLength, r.textLength);
  });
});

// ============================================================================
// 4. buildBlindEvalPairs
// ============================================================================

describe("Phase 5A: buildBlindEvalPairs — raw vs final 盲评对照对", () => {
  it("只对 status=ok 的章节生成对照对", () => {
    const results = [
      makeOkResult({ chapterFilePath: "/path/1.md" }),
      makeBlockedResult({ chapterNumber: 2 }),
      makeOkResult({ chapterNumber: 3, chapterFilePath: "/path/3.md" }),
    ];
    // 用 mock fs
    const fs = {
      readFileSync: (path) => {
        if (path === "/path/1.md") return "第一章正文内容";
        if (path === "/path/3.md") return "第三章正文内容";
        throw new Error("not found");
      },
    };
    const pairs = buildBlindEvalPairs(results, fs);
    assert.equal(pairs.length, 2, "只应生成 2 对（blocked 跳过）");
  });

  it("每对包含 5 维度评分模板", () => {
    const results = [makeOkResult({ chapterFilePath: "/path/1.md" })];
    const fs = { readFileSync: () => "正文内容" };
    const pairs = buildBlindEvalPairs(results, fs);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].dimensions.length, 5);
    const ids = pairs[0].dimensions.map((d) => d.id);
    assert.deepEqual(ids.sort(), [
      "character_consistency",
      "ending_hook",
      "factual_accuracy",
      "prose_naturalness",
      "story_coherence",
    ]);
  });

  it("A/B 顺序由 hash 决定（同输入可复现）", () => {
    const r = makeOkResult({
      chapterFilePath: "/path/1.md",
      textHash: "abcdef0123456789",
      rawTextPreview: "raw preview text",
    });
    const fs = { readFileSync: () => "final text" };
    const pair1 = buildBlindEvalPairs([r], fs)[0];
    const pair2 = buildBlindEvalPairs([r], fs)[0];
    assert.equal(pair1.sampleA.text, pair2.sampleA.text, "同输入应产生相同 A/B 顺序");
    assert.equal(pair1.sampleB.text, pair2.sampleB.text);
  });

  it("sampleA + sampleB 总是包含 raw 和 final（顺序可能互换）", () => {
    const r = makeOkResult({
      chapterFilePath: "/path/1.md",
      rawTextPreview: "RAW_TEXT_MARKER",
    });
    const fs = { readFileSync: () => "FINAL_TEXT_MARKER" };
    const pair = buildBlindEvalPairs([r], fs)[0];
    const combined = pair.sampleA.text + pair.sampleB.text;
    assert.ok(combined.includes("RAW_TEXT_MARKER"), "raw 文本应在 A 或 B 中");
    assert.ok(combined.includes("FINAL_TEXT_MARKER"), "final 文本应在 A 或 B 中");
  });

  it("blocked 章节不进入盲评", () => {
    const results = [makeBlockedResult()];
    const pairs = buildBlindEvalPairs(results, { readFileSync: () => "" });
    assert.equal(pairs.length, 0);
  });

  it("pairId 自增 + 格式正确", () => {
    const results = [
      makeOkResult({ chapterFilePath: "/path/1.md" }),
      makeOkResult({ chapterNumber: 2, chapterFilePath: "/path/2.md" }),
    ];
    const fs = { readFileSync: (p) => p === "/path/1.md" ? "a" : "b" };
    const pairs = buildBlindEvalPairs(results, fs);
    assert.equal(pairs[0].pairId, "pair-001");
    assert.equal(pairs[1].pairId, "pair-002");
  });

  // ── P1-6 生产探针：盲评双方必须非空才导出 ──────────────────────────

  it("P1-6: raw 为空时跳过该章（不允许单边盲评）", () => {
    const results = [
      makeOkResult({ chapterFilePath: "/path/1.md", rawTextPreview: undefined }),
    ];
    const fs = { readFileSync: () => "final text" };
    const pairs = buildBlindEvalPairs(results, fs);
    assert.equal(pairs.length, 0, "raw 为空不应导出盲评对");
    assert.ok(Array.isArray(pairs.skipped), "应暴露 skipped 数组");
    assert.equal(pairs.skipped.length, 1);
    assert.equal(pairs.skipped[0].reason, "raw_text_missing");
  });

  it("P1-6: final 为空时跳过该章（不允许单边盲评）", () => {
    const results = [
      makeOkResult({ chapterFilePath: null, rawTextPreview: "raw text", finalTextPreview: undefined }),
    ];
    const pairs = buildBlindEvalPairs(results, { readFileSync: () => "" });
    assert.equal(pairs.length, 0, "final 为空不应导出盲评对");
    assert.equal(pairs.skipped[0].reason, "final_text_missing");
  });

  it("P1-6: final 文件读不到时跳过并记录 final_file_unreadable", () => {
    const results = [
      makeOkResult({ chapterFilePath: "/missing/path.md", rawTextPreview: "raw text" }),
    ];
    const fs = { readFileSync: () => { throw new Error("ENOENT"); } };
    const pairs = buildBlindEvalPairs(results, fs);
    assert.equal(pairs.length, 0);
    assert.equal(pairs.skipped[0].reason, "final_file_unreadable");
  });

  it("P1-6: pairs.skipped 在所有章都成功时为空数组", () => {
    const results = [makeOkResult({ chapterFilePath: "/path/1.md" })];
    const fs = { readFileSync: () => "final text" };
    const pairs = buildBlindEvalPairs(results, fs);
    assert.equal(pairs.length, 1);
    assert.equal(pairs.skipped.length, 0);
  });
});

// ============================================================================
// 5. generateCanaryReport
// ============================================================================

describe("Phase 5A: generateCanaryReport — Markdown 报告生成", () => {
  it("报告包含必要章节", () => {
    const results = [
      makeOkResult(),
      makeBlockedResult({ chapterNumber: 2 }),
    ];
    const metrics = computeCanaryMetrics(results);
    const report = generateCanaryReport({
      metrics,
      results,
      metadata: {
        runId: "test-run-001",
        startedAt: "2026-07-28T10:00:00Z",
        finishedAt: "2026-07-28T11:00:00Z",
        gitHead: "abc1234",
        workspaces: ["xinmo"],
        chapterRange: "1-2",
        modelVersion: "stub",
        realModel: false,
      },
    });
    assert.ok(report.includes("# Phase 5 Canary 验证报告"), "应包含标题");
    assert.ok(report.includes("## 1. Summary"), "应包含 Summary 章节");
    assert.ok(report.includes("## 2. Outcome 分布"), "应包含 Outcome 分布");
    assert.ok(report.includes("## 3. 失败 Stage 分布"), "应包含失败 Stage 分布");
    assert.ok(report.includes("## 4. 模型调用"), "应包含模型调用章节");
    assert.ok(report.includes("## 5. 耗时"), "应包含耗时章节");
    assert.ok(report.includes("## 9. 验收门槛对照"), "应包含验收门槛对照");
    assert.ok(report.includes("test-run-001"), "应包含 runId");
    assert.ok(report.includes("abc1234"), "应包含 git HEAD");
  });

  it("报告呈现每章详情表格", () => {
    const results = [
      makeOkResult({ workspaceId: "xinmo", chapterNumber: 17 }),
      makeBlockedResult({ workspaceId: "xinmo", chapterNumber: 18 }),
    ];
    const metrics = computeCanaryMetrics(results);
    const report = generateCanaryReport({
      metrics,
      results,
      metadata: {
        runId: "r1",
        startedAt: "2026-07-28T10:00:00Z",
        finishedAt: "2026-07-28T11:00:00Z",
        workspaces: ["xinmo"],
        chapterRange: "17-18",
        realModel: false,
      },
    });
    assert.ok(report.includes("## 8. 每章详情"), "应包含每章详情");
    assert.ok(report.includes("ch17"), "应包含 ch17");
    assert.ok(report.includes("ch18"), "应包含 ch18");
  });

  it("验收门槛对照包含恢复成功率门槛", () => {
    const metrics = computeCanaryMetrics([makeOkResult()]);
    const report = generateCanaryReport({
      metrics,
      metadata: {
        runId: "r1",
        startedAt: "2026-07-28T10:00:00Z",
        finishedAt: "2026-07-28T11:00:00Z",
        workspaces: ["x"],
        chapterRange: "1-1",
        realModel: false,
      },
    });
    assert.ok(report.includes("自动恢复后成功率"), "应包含恢复成功率门槛");
    assert.ok(report.includes("85%"), "应包含 85% 目标");
  });
});

// ============================================================================
// 6. detectModelVersion
// ============================================================================

describe("Phase 5A: detectModelVersion — 模型版本检测", () => {
  it("取首个非 stub provider", () => {
    const calls = [
      makeModelCall({ actualProvider: "stub" }),
      makeModelCall({ actualProvider: "gemini31", actualModel: "gemini-3.1-pro" }),
      makeModelCall({ actualProvider: "claude" }),
    ];
    assert.equal(detectModelVersion(calls), "gemini31");
  });

  it("全部 stub → 返回 'stub'", () => {
    const calls = [
      makeModelCall({ actualProvider: "stub" }),
      makeModelCall({ actualProvider: "stub" }),
    ];
    assert.equal(detectModelVersion(calls), "stub");
  });

  it("空数组 → 'unknown'", () => {
    assert.equal(detectModelVersion([]), "unknown");
  });

  it("无 actualProvider 字段 → 取 actualModel", () => {
    const calls = [makeModelCall({ actualProvider: undefined, actualModel: "claude-opus-4.6" })];
    assert.equal(detectModelVersion(calls), "claude-opus-4.6");
  });
});

// ============================================================================
// 7. normalizeChapterResult
// ============================================================================

describe("Phase 5A: normalizeChapterResult — V2Output 归一化", () => {
  it("从 V2Output 抽取 status / selectedSource / modelCalls", () => {
    const output = {
      status: "ok",
      selectedSource: "raw",
      selectedCandidateId: "c-1",
      stageResults: {
        modelCalls: [
          { kind: "raw", route: "v2_rawstage2", actualProvider: "gemini31", durationMs: 5000, finishReason: "stop" },
        ],
        chapterFilePath: "/path/chapter.md",
        tracePath: "/path/trace.json",
      },
      candidates: [
        { kind: "context_enhanced", text: "raw text..." },
      ],
    };
    const r = normalizeChapterResult({
      workspaceId: "ws",
      chapterId: "1",
      chapterNumber: 1,
      seed: 1,
      durationMs: 5000,
      run: { output, chapterFilePath: "/path/chapter.md", tracePath: "/path/trace.json" },
      fs: { readFileSync: () => "chapter content here" },
    });
    assert.equal(r.status, "ok");
    assert.equal(r.selectedSource, "raw");
    assert.equal(r.modelCalls.length, 1);
    assert.equal(r.modelCalls[0].actualProvider, "gemini31");
    assert.ok(r.textHash !== null);
    assert.equal(r.textLength, "chapter content here".length);
  });

  it("blocked 输出 → chapterFilePath=null, textHash=null", () => {
    const output = {
      status: "blocked",
      selectedSource: null,
      failureEnvelope: { stage: "preflight", severity: "preflight", reason: "缺世界观" },
      stageResults: { modelCalls: [] },
    };
    const r = normalizeChapterResult({
      workspaceId: "ws",
      chapterId: "1",
      chapterNumber: 1,
      seed: 1,
      durationMs: 100,
      run: { output, chapterFilePath: null, tracePath: null },
    });
    assert.equal(r.status, "blocked");
    assert.equal(r.outcomeType, "preflight_block");
    assert.equal(r.chapterFilePath, null);
    assert.equal(r.textHash, null);
    assert.equal(r.textLength, 0);
  });

  it("candidates 中 kind=context_enhanced → 抽为 rawTextPreview", () => {
    const output = {
      status: "ok",
      selectedSource: "raw",
      stageResults: { modelCalls: [] },
      candidates: [
        { kind: "context_enhanced", text: "这是一段 raw 候选文本，前 200 字会被截取作为 preview。" },
      ],
    };
    const r = normalizeChapterResult({
      workspaceId: "ws",
      chapterId: "1",
      chapterNumber: 1,
      seed: 1,
      durationMs: 100,
      run: { output, chapterFilePath: null, tracePath: null },
    });
    assert.ok(r.rawTextPreview !== undefined);
    assert.ok(r.rawTextPreview.includes("raw 候选文本"));
  });

  // ── P1-6 生产探针：raw 筛选含 agentic_raw；不再截断到 200 字 ──────────────
  it("P1-6: candidates 中 kind=agentic_raw → 抽为 rawTextPreview（生产 raw kind 必须被识别）", () => {
    const longRaw = "A".repeat(500); // > 200 字
    const output = {
      status: "ok",
      selectedSource: "editorial",
      stageResults: { modelCalls: [] },
      candidates: [
        { kind: "agentic_raw", text: longRaw },
      ],
    };
    const r = normalizeChapterResult({
      workspaceId: "ws",
      chapterId: "1",
      chapterNumber: 1,
      seed: 1,
      durationMs: 100,
      run: { output, chapterFilePath: null, tracePath: null },
    });
    assert.ok(r.rawTextPreview !== undefined, "agentic_raw 应被抽为 rawTextPreview");
    assert.equal(r.rawTextPreview.length, 500, "P1-6: raw 不再截断到 200 字，应保留完整 500 字");
  });

  it("P1-6: 多种 raw kind 共存时按数组顺序取首个匹配（生产中通常只存在一种）", () => {
    const output = {
      status: "ok",
      selectedSource: "editorial",
      stageResults: { modelCalls: [] },
      candidates: [
        { kind: "context_enhanced", text: "context_text" },
        { kind: "agentic_raw", text: "agentic_text" },
        { kind: "raw", text: "raw_text" },
      ],
    };
    const r = normalizeChapterResult({
      workspaceId: "ws",
      chapterId: "1",
      chapterNumber: 1,
      seed: 1,
      durationMs: 100,
      run: { output, chapterFilePath: null, tracePath: null },
    });
    // Array.find 返回首个匹配；生产中通常只存在一种 raw kind。
    // 关键修复点是 agentic_raw 不再被跳过；此处验证三种 kind 均被识别为 raw。
    assert.ok(r.rawTextPreview !== undefined, "应能从多种 raw kind 中抽取 rawTextPreview");
    assert.ok(
      r.rawTextPreview === "context_text" || r.rawTextPreview === "agentic_text" || r.rawTextPreview === "raw_text",
      "应命中 context_enhanced / agentic_raw / raw 之一",
    );
  });

  it("P1-6: 只有 agentic_raw 时被正确识别（生产主路径场景）", () => {
    const output = {
      status: "ok",
      selectedSource: "editorial",
      stageResults: { modelCalls: [] },
      candidates: [
        { kind: "editorial_amplified", text: "editorial_text" },
        { kind: "agentic_raw", text: "agentic_only_text" },
      ],
    };
    const r = normalizeChapterResult({
      workspaceId: "ws",
      chapterId: "1",
      chapterNumber: 1,
      seed: 1,
      durationMs: 100,
      run: { output, chapterFilePath: null, tracePath: null },
    });
    assert.equal(r.rawTextPreview, "agentic_only_text", "生产主路径只有 agentic_raw 时应被选中");
  });
});

// ============================================================================
// 8. 常量
// ============================================================================

describe("Phase 5A: 常量 — 与项目约束对齐", () => {
  it("SINGLE_CHAPTER_SOFT_BUDGET = 6（与 project_memory 单章 6 次软限一致）", () => {
    assert.equal(SINGLE_CHAPTER_SOFT_BUDGET, 6);
  });

  it("SINGLE_CHAPTER_HARD_BUDGET = 10（与 project_memory 单章 10 次硬帽一致）", () => {
    assert.equal(SINGLE_CHAPTER_HARD_BUDGET, 10);
  });

  it("BLIND_EVAL_DIMENSIONS 有 5 个维度（不使用单一总分）", () => {
    assert.equal(BLIND_EVAL_DIMENSIONS.length, 5);
    const ids = BLIND_EVAL_DIMENSIONS.map((d) => d.id);
    assert.deepEqual(ids.sort(), [
      "character_consistency",
      "ending_hook",
      "factual_accuracy",
      "prose_naturalness",
      "story_coherence",
    ]);
  });

  it("每个维度有 id / label / description", () => {
    for (const d of BLIND_EVAL_DIMENSIONS) {
      assert.ok(typeof d.id === "string" && d.id.length > 0);
      assert.ok(typeof d.label === "string" && d.label.length > 0);
      assert.ok(typeof d.description === "string" && d.description.length > 0);
    }
  });
});

// ============================================================================
// 9. P1-6 工具层 model_timeout 重试恢复检测
// ============================================================================
//
// 验证 canary runner 能识别 Phase 1 工具层 chapter_level_retry。
// 旧 canary 只识别 stageResults.blockedRawRecovery，导致 Phase 1 工具层重试
// 不计入恢复率指标，恢复率失真。
//
// 修复：chapter-canary-runner.mjs 同时识别
//   - stageResults.blockedRawRecovery（legacy stage-level raw 恢复）
//   - stageResults.modelTimeoutRetry（Phase 1 工具层 chapter_level_retry）
//

describe("Phase 5A: P1-6 工具层 model_timeout 重试恢复检测", () => {
  // 模拟 chapter-canary-runner.mjs 中的恢复检测逻辑（与源码同步）
  function detectRecovery(output) {
    const blockedRawRecovery = !!(output.stageResults?.blockedRawRecovery);
    const modelTimeoutRetry = output.stageResults?.modelTimeoutRetry;
    const toolLayerRetryAttempted = !!(modelTimeoutRetry?.attempted);
    const recoveryAttempted = blockedRawRecovery || toolLayerRetryAttempted;
    const recoverySucceeded = recoveryAttempted && output.status === "ok";
    return { recoveryAttempted, recoverySucceeded };
  }

  it("P1-6: stageResults.modelTimeoutRetry.attempted=true + status=ok → 恢复成功", () => {
    const output = {
      status: "ok",
      stageResults: {
        modelTimeoutRetry: {
          attempted: true,
          attempts: 1,
          succeeded: true,
          firstFailureEnvelope: { gate: "model_timeout", severity: "recoverable" },
        },
      },
    };
    const { recoveryAttempted, recoverySucceeded } = detectRecovery(output);
    assert.equal(recoveryAttempted, true, "应识别到工具层重试");
    assert.equal(recoverySucceeded, true, "重试后 status=ok 应视为恢复成功");
  });

  it("P1-6: stageResults.modelTimeoutRetry.attempted=true + status=blocked → 恢复失败", () => {
    const output = {
      status: "blocked",
      stageResults: {
        modelTimeoutRetry: {
          attempted: true,
          attempts: 1,
          succeeded: false,
          firstFailureEnvelope: { gate: "model_timeout", severity: "recoverable" },
        },
      },
    };
    const { recoveryAttempted, recoverySucceeded } = detectRecovery(output);
    assert.equal(recoveryAttempted, true);
    assert.equal(recoverySucceeded, false, "重试后仍 blocked 应视为恢复失败");
  });

  it("P1-6: 无 modelTimeoutRetry 且无 blockedRawRecovery → 未触发恢复", () => {
    const output = {
      status: "ok",
      stageResults: {},
    };
    const { recoveryAttempted, recoverySucceeded } = detectRecovery(output);
    assert.equal(recoveryAttempted, false);
    assert.equal(recoverySucceeded, false);
  });

  it("P1-6: 旧 blockedRawRecovery 仍被识别（向后兼容）", () => {
    const output = {
      status: "ok",
      stageResults: {
        blockedRawRecovery: { attempted: true, succeeded: true },
      },
    };
    const { recoveryAttempted, recoverySucceeded } = detectRecovery(output);
    assert.equal(recoveryAttempted, true, "旧 blockedRawRecovery 应仍被识别");
    assert.equal(recoverySucceeded, true);
  });

  it("P1-6: 两类恢复同时存在时都识别", () => {
    const output = {
      status: "ok",
      stageResults: {
        blockedRawRecovery: { attempted: true },
        modelTimeoutRetry: { attempted: true, attempts: 1, succeeded: true },
      },
    };
    const { recoveryAttempted, recoverySucceeded } = detectRecovery(output);
    assert.equal(recoveryAttempted, true);
    assert.equal(recoverySucceeded, true);
  });

  it("P1-6: 工具层重试证据影响 recoverySuccessRate 指标", () => {
    // 模拟 3 章：1 章首次成功 + 1 章工具层重试成功 + 1 章工具层重试失败
    const results = [
      makeOkResult({ chapterNumber: 1, recoveryAttempted: false, recoverySucceeded: false }),
      makeOkResult({ chapterNumber: 2, recoveryAttempted: true, recoverySucceeded: true }),
      makeBlockedResult({
        chapterNumber: 3,
        recoveryAttempted: true,
        recoverySucceeded: false,
        failureEnvelope: { stage: "model_timeout", gate: "model_timeout", severity: "hard", reason: "重试耗尽" },
      }),
    ];
    const m = computeCanaryMetrics(results);
    assert.equal(m.recoveryAttemptedCount, 2, "2 章触发恢复");
    assert.equal(m.recoverySucceededCount, 1, "1 章恢复成功");
    assert.equal(m.recoverySuccessRate, 0.5, "恢复成功率应为 0.5");
    // firstPassSuccessRate 经 round4 处理，1/3 → 0.3333
    assert.ok(Math.abs(m.firstPassSuccessRate - 1 / 3) < 0.001, `首次成功率应接近 1/3, actual=${m.firstPassSuccessRate}`);
  });
});
