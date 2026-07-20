/**
 * P15 legacy-trace-adapter 完整实现测试
 *
 * Task 15 验收口径：
 * - V2 stage 写入 gates[]（stage 名加 v2_ 前缀）
 * - V2 repairs 写入 patches[]
 * - V2 error 写入 failureEnvelopes[]
 * - v2Summary 跨阶段聚合（v2Mode/candidateCount/winnerId/阶段序列）
 * - 与 legacy QualityTraceDocument schemaVersion=1 对齐
 * - 写入失败不抛异常（trace 缺失不阻断生成）
 *
 * 测试策略：
 * - 用临时 workspacePath + workspaceId 构造 adapter
 * - record() 多条 V2 阶段记录
 * - flush() 后读回 JSON，验证 gates/patches/failureEnvelopes/v2Summary
 * - 注意：adapter 通过动态 import legacy QualityTraceRecorder 委托写入，
 *   路径为 {workspacePath}/{workspaceId}/traces/{chapterId}-quality-trace.json
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createLegacyTraceAdapter,
  deriveContextHashFromCompiled,
} from "../dist/v2/adapters/legacy-trace-adapter.js";

// ============================================================================
// 工厂与基础行为
// ============================================================================

test("P15: createLegacyTraceAdapter 创建可用 adapter", () => {
  const adapter = createLegacyTraceAdapter({
    workspacePath: tmpdir(),
    workspaceId: "test-ws",
    chapterId: "1",
  });
  assert.equal(typeof adapter.record, "function");
  assert.equal(typeof adapter.flush, "function");
  assert.equal(typeof adapter.size, "function");
  assert.equal(adapter.size(), 0);
});

test("P15: record() 累积记录，size() 反映数量", () => {
  const adapter = createLegacyTraceAdapter({
    workspacePath: tmpdir(),
    workspaceId: "test-ws",
    chapterId: "1",
  });
  adapter.record({
    stage: "context_compiled",
    timestamp: new Date().toISOString(),
    contextHash: "f1-l2-c3",
  });
  adapter.record({
    stage: "candidate_generated",
    timestamp: new Date().toISOString(),
    contextHash: "f1-l2-c3",
  });
  assert.equal(adapter.size(), 2);
});

// ============================================================================
// Task 15 核心验收：gates[] / patches[] / failureEnvelopes[] / v2Summary
// ============================================================================

test("P15: flush() 写入 legacy QualityTraceDocument（schemaVersion=1）", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "v2-trace-p15-"));
  try {
    const adapter = createLegacyTraceAdapter({
      workspacePath: tmpDir,
      workspaceId: "ws-flush",
      chapterId: "42",
    });
    adapter.record({
      stage: "context_compiled",
      timestamp: new Date().toISOString(),
      contextHash: "abc",
    });
    const path = adapter.flush();
    assert.ok(path, "flush 应返回文件路径");
    assert.ok(existsSync(path), "trace 文件应存在");
    // 路径应符合 legacy 约定：{workspacePath}/{workspaceId}/traces/{chapterId}-quality-trace.json
    assert.ok(path.includes(join("ws-flush", "traces", "42-quality-trace.json")), `path=${path}`);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.workspaceId, "ws-flush");
    assert.equal(parsed.chapterId, "42");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("P15: V2 stage 写入 gates[]（stage 名加 v2_ 前缀）", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "v2-trace-gates-"));
  try {
    const adapter = createLegacyTraceAdapter({
      workspacePath: tmpDir,
      workspaceId: "ws-gates",
      chapterId: "1",
    });
    adapter.record({
      stage: "context_compiled",
      timestamp: new Date().toISOString(),
      contextHash: "h1",
    });
    adapter.record({
      stage: "candidate_generated",
      timestamp: new Date().toISOString(),
      candidates: [{ id: "c1", kind: "direct_baseline", text: "x", model: "m", route: "DIRECT", promptProfile: { type: "editorial", tokensIn: 10, containsDialogueRatio: false, containsParagraphLengthConstraint: false, contractIds: [] }, contextHash: "h1", generatedAt: "t", durationMs: 1 }],
      contextHash: "h1",
    });
    const path = adapter.flush();
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    assert.ok(Array.isArray(parsed.gates), "应有 gates 数组");
    assert.equal(parsed.gates.length, 2);
    assert.equal(parsed.gates[0].stage, "v2_context_compiled");
    assert.equal(parsed.gates[1].stage, "v2_candidate_generated");
    // 每条 gate 有 status/passed/blocked/score/reason
    for (const g of parsed.gates) {
      assert.ok(typeof g.status === "string");
      assert.equal(typeof g.passed, "boolean");
      assert.equal(typeof g.blocked, "boolean");
      assert.ok(typeof g.reason === "string");
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("P15: V2 repairs 写入 patches[]", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "v2-trace-patches-"));
  try {
    const adapter = createLegacyTraceAdapter({
      workspacePath: tmpDir,
      workspaceId: "ws-patches",
      chapterId: "1",
    });
    adapter.record({
      stage: "repair_planned",
      timestamp: new Date().toISOString(),
      repairPlan: {
        disposition: "sentence_patch",
        repairs: [
          { candidateId: "c1", kind: "sentence_patch", rationale: "去重" },
          { candidateId: "c1", kind: "chapter_rewrite", rationale: "不可修" },
        ],
      },
    });
    const path = adapter.flush();
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    assert.ok(Array.isArray(parsed.patches), "应有 patches 数组");
    assert.equal(parsed.patches.length, 2);
    assert.equal(parsed.patches[0].stage, "v2_repair");
    // sentence_patch 被接受（accepted=true），chapter_rewrite 被拒绝（accepted=false）
    assert.equal(parsed.patches[0].accepted, true);
    assert.equal(parsed.patches[1].accepted, false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("P15: V2 error 写入 failureEnvelopes[]", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "v2-trace-env-"));
  try {
    const adapter = createLegacyTraceAdapter({
      workspacePath: tmpDir,
      workspaceId: "ws-env",
      chapterId: "1",
    });
    adapter.record({
      stage: "error",
      timestamp: new Date().toISOString(),
      error: { message: "model timeout", code: "TIMEOUT", recoverable: true },
    });
    const path = adapter.flush();
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    assert.ok(Array.isArray(parsed.failureEnvelopes), "应有 failureEnvelopes 数组");
    assert.equal(parsed.failureEnvelopes.length, 1);
    assert.equal(parsed.failureEnvelopes[0].stage, "v2_error");
    assert.equal(parsed.failureEnvelopes[0].reason, "model timeout");
    assert.equal(parsed.failureEnvelopes[0].recoverable, true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("P15: v2Summary 聚合 v2Mode/candidateCount/winnerId/阶段序列", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "v2-trace-summary-"));
  try {
    const adapter = createLegacyTraceAdapter({
      workspacePath: tmpDir,
      workspaceId: "ws-summary",
      chapterId: "17",
    });
    if (adapter.setV2Mode) adapter.setV2Mode("full_chain");
    adapter.record({
      stage: "context_compiled",
      timestamp: "2026-07-08T00:00:00Z",
      contextHash: "f1-l2-c3",
    });
    adapter.record({
      stage: "candidate_generated",
      timestamp: "2026-07-08T00:00:01Z",
      candidates: [
        { id: "c1", kind: "direct_baseline", text: "a", model: "m", route: "DIRECT", promptProfile: { type: "editorial", tokensIn: 10, containsDialogueRatio: false, containsParagraphLengthConstraint: false, contractIds: [] }, contextHash: "f1-l2-c3", generatedAt: "t", durationMs: 1 },
        { id: "c2", kind: "scene_contract", text: "b", model: "m", route: "AMP", promptProfile: { type: "editorial", tokensIn: 10, containsDialogueRatio: false, containsParagraphLengthConstraint: false, contractIds: [] }, contextHash: "f1-l2-c3", generatedAt: "t", durationMs: 1 },
      ],
      contextHash: "f1-l2-c3",
    });
    adapter.record({
      stage: "candidate_compared",
      timestamp: "2026-07-08T00:00:03Z",
      comparison: {
        winnerId: "c2",
        loserIds: ["c1"],
        confidence: 0.2,
        dimensionScores: {
          c1: { chineseNaturalness: 90, webnovelRhythm: 90, eventProgression: 50, characterAgency: 50, ensembleQuality: 80, payoffQuality: 50, hookQuality: 40, infoRelease: 50, emotionalPayoff: 50, continuity: 100, antiRegression: 100 },
          c2: { chineseNaturalness: 90, webnovelRhythm: 95, eventProgression: 55, characterAgency: 70, ensembleQuality: 85, payoffQuality: 55, hookQuality: 70, infoRelease: 55, emotionalPayoff: 55, continuity: 100, antiRegression: 100 },
        },
        acceptedRepairs: [],
        rejectedRepairs: [],
        reasons: ["winner=c2"],
      },
      contextHash: "f1-l2-c3",
    });
    adapter.record({
      stage: "final_selected",
      timestamp: "2026-07-08T00:00:05Z",
      finalSelection: {
        selectedCandidateId: "c2",
        selectedSource: "v2_amplified",
        projectGain: "positive",
        whySelected: ["amplified 胜出"],
        whyRejected: [],
        acceptedRepairs: [],
        rejectedRepairs: [],
      },
      contextHash: "f1-l2-c3",
    });
    const path = adapter.flush();
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    assert.ok(parsed.v2Summary, "应有 v2Summary");
    assert.equal(parsed.v2Summary.v2Mode, "full_chain");
    assert.equal(parsed.v2Summary.candidateCount, 2);
    // winnerId = comparator 比较胜出候选（c2），finalSelectedId = 最终交付候选（c2）
    assert.equal(parsed.v2Summary.winnerId, "c2");
    assert.equal(parsed.v2Summary.winnerSource, "v2_amplified");
    assert.equal(parsed.v2Summary.comparatorConfidence, 0.2);
    assert.equal(parsed.v2Summary.finalSelectedId, "c2");
    assert.equal(parsed.v2Summary.finalSelectedSource, "v2_amplified");
    assert.equal(parsed.v2Summary.projectGain, "positive");
    assert.equal(parsed.v2Summary.contextHash, "f1-l2-c3");
    assert.equal(parsed.v2Summary.stages.length, 4);
    assert.deepEqual(
      parsed.v2Summary.stages.map((s) => s.stage),
      ["context_compiled", "candidate_generated", "candidate_compared", "final_selected"]
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("P0: v2Summary 区分 comparatorWinner vs finalSelected（ch17 neutral 场景）", () => {
  // 验证 P0 修复：comparator winner (amplified) ≠ finalSelected (rawStage2)
  // 当 amplified 是 comparator winner 但未过 clearWin 门槛时，FinalSelector 保留 rawStage2
  const tmpDir = mkdtempSync(join(tmpdir(), "v2-trace-p0-"));
  try {
    const adapter = createLegacyTraceAdapter({
      workspacePath: tmpDir,
      workspaceId: "ws-p0",
      chapterId: "17",
    });
    if (adapter.setV2Mode) adapter.setV2Mode("full_chain");
    adapter.record({
      stage: "candidate_generated",
      timestamp: "2026-07-08T00:00:01Z",
      candidates: [
        { id: "raw", kind: "context_enhanced", text: "raw", model: "doubao", route: "v2_rawstage2", promptProfile: { type: "editorial", tokensIn: 10, containsDialogueRatio: false, containsParagraphLengthConstraint: false, contractIds: [] }, contextHash: "h", generatedAt: "t", durationMs: 1 },
        { id: "amp", kind: "scene_contract", text: "amp", model: "doubao", route: "v2_amplified", promptProfile: { type: "editorial", tokensIn: 10, containsDialogueRatio: false, containsParagraphLengthConstraint: false, contractIds: [] }, contextHash: "h", generatedAt: "t", durationMs: 1 },
      ],
      contextHash: "h",
    });
    adapter.record({
      stage: "candidate_compared",
      timestamp: "2026-07-08T00:00:03Z",
      comparison: {
        winnerId: "amp",
        loserIds: ["raw"],
        confidence: 0.05, // 未过 0.15 门槛
        dimensionScores: {
          raw: { chineseNaturalness: 98, webnovelRhythm: 100, eventProgression: 31, characterAgency: 30, ensembleQuality: 100, payoffQuality: 50, hookQuality: 1, infoRelease: 52, emotionalPayoff: 43, continuity: 100, antiRegression: 100 },
          amp: { chineseNaturalness: 97, webnovelRhythm: 100, eventProgression: 31, characterAgency: 72, ensembleQuality: 100, payoffQuality: 50, hookQuality: 61, infoRelease: 52, emotionalPayoff: 43, continuity: 100, antiRegression: 80 },
        },
        acceptedRepairs: [],
        rejectedRepairs: [],
        reasons: ["winner=amp confidence=0.050"],
      },
      contextHash: "h",
    });
    adapter.record({
      stage: "final_selected",
      timestamp: "2026-07-08T00:00:05Z",
      finalSelection: {
        selectedCandidateId: "raw", // 保留 rawStage2
        selectedSource: "rawStage2",
        projectGain: "neutral",
        whySelected: ["amplified 未明显胜出（confidence=0.050 < 0.15），保留 rawStage2"],
        whyRejected: ["amplified 未过 clearWin"],
        acceptedRepairs: [],
        rejectedRepairs: [],
      },
      contextHash: "h",
    });
    const path = adapter.flush();
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    // 核心断言：comparator winner ≠ finalSelected
    assert.equal(parsed.v2Summary.winnerId, "amp", "comparator winner 应为 amplified");
    assert.equal(parsed.v2Summary.winnerSource, "v2_amplified");
    assert.equal(parsed.v2Summary.comparatorConfidence, 0.05);
    assert.equal(parsed.v2Summary.finalSelectedId, "raw", "finalSelected 应为 rawStage2");
    assert.equal(parsed.v2Summary.finalSelectedSource, "rawStage2");
    assert.equal(parsed.v2Summary.projectGain, "neutral");
    // 二者必须不同——这正是 confidence 门槛生效的证据
    assert.notEqual(parsed.v2Summary.winnerId, parsed.v2Summary.finalSelectedId,
      "comparatorWinner 与 finalSelected 必须不同（neutral 场景）");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("P15: setV2Mode 区分 full_chain / rawStage2 / direct_baseline", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "v2-trace-mode-"));
  try {
    for (const mode of ["full_chain", "rawStage2", "direct_baseline"]) {
      const adapter = createLegacyTraceAdapter({
        workspacePath: tmpDir,
        workspaceId: "ws-mode",
        chapterId: `1-${mode}`,
      });
      if (adapter.setV2Mode) adapter.setV2Mode(mode);
      adapter.record({ stage: "context_compiled", timestamp: new Date().toISOString() });
      const path = adapter.flush();
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      assert.equal(parsed.v2Summary.v2Mode, mode, `v2Mode 应为 ${mode}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("P15: flush() 自动创建 traces 目录", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "v2-trace-nodir-"));
  const tracesDir = join(tmpDir, "ws-nodir", "traces");
  try {
    if (existsSync(tracesDir)) {
      rmSync(tracesDir, { recursive: true, force: true });
    }
    const adapter = createLegacyTraceAdapter({
      workspacePath: tmpDir,
      workspaceId: "ws-nodir",
      chapterId: "1",
    });
    adapter.record({
      stage: "context_compiled",
      timestamp: new Date().toISOString(),
    });
    const path = adapter.flush();
    assert.ok(path);
    assert.ok(existsSync(tracesDir), "traces 目录应被自动创建");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("P15: 多次 record 后 flush 写入全部 gates", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "v2-trace-multi-"));
  try {
    const adapter = createLegacyTraceAdapter({
      workspacePath: tmpDir,
      workspaceId: "ws-multi",
      chapterId: "1",
    });
    const stages = [
      "context_compiled",
      "scene_contract_planned",
      "candidate_generated",
      "diagnostic_run",
      "candidate_compared",
      "final_selected",
    ];
    for (const stage of stages) {
      adapter.record({ stage, timestamp: new Date().toISOString() });
    }
    assert.equal(adapter.size(), 6);
    const path = adapter.flush();
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(parsed.gates.length, 6);
    assert.deepEqual(
      parsed.gates.map((g) => g.stage),
      stages.map((s) => `v2_${s}`)
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("P15: deriveContextHashFromCompiled 生成稳定签名", () => {
  const ctx = {
    facts: [{ id: "f1" }, { id: "f2" }],
    openLoops: [{ id: "l1" }],
    characterStates: [{ characterId: "c1" }, { characterId: "c2" }, { characterId: "c3" }],
    worldRules: [{ id: "w1" }],
    styleReferences: [{ id: "s1" }, { id: "s2" }],
    sourceMap: [],
  };
  const hash = deriveContextHashFromCompiled(ctx);
  assert.equal(hash, "f2-l1-c3-w1-s2");
});

test("P15: trace 写入失败不抛异常（trace 缺失不阻断生成）", () => {
  const adapter = createLegacyTraceAdapter({
    workspacePath: "/nonexistent/root/path/that/cannot/be/created",
    workspaceId: "ws-fail",
    chapterId: "1",
  });
  adapter.record({
    stage: "context_compiled",
    timestamp: new Date().toISOString(),
  });
  let result;
  assert.doesNotThrow(() => {
    result = adapter.flush();
  });
  // 关键是不抛异常
});

test("P15: candidate_compared gate 记录 winner 与 confidence", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "v2-trace-cmp-"));
  try {
    const adapter = createLegacyTraceAdapter({
      workspacePath: tmpDir,
      workspaceId: "ws-cmp",
      chapterId: "1",
    });
    adapter.record({
      stage: "candidate_compared",
      timestamp: new Date().toISOString(),
      comparison: {
        winnerId: "c2",
        loserIds: ["c1"],
        confidence: 0.75,
        dimensionScores: { c1: {}, c2: {} },
        acceptedRepairs: [],
        rejectedRepairs: [],
        reasons: ["c2 wins"],
      },
    });
    const path = adapter.flush();
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const gate = parsed.gates[0];
    assert.equal(gate.stage, "v2_candidate_compared");
    assert.ok(gate.reason.includes("c2"), `reason 应含 winner id: ${gate.reason}`);
    assert.ok(gate.reason.includes("0.75"), `reason 应含 confidence: ${gate.reason}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("P15: appendExisting 默认追加到已有 trace（不清空 legacy gates）", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "v2-trace-append-"));
  try {
    // 第一次写入
    const adapter1 = createLegacyTraceAdapter({
      workspacePath: tmpDir,
      workspaceId: "ws-append",
      chapterId: "1",
    });
    adapter1.record({ stage: "context_compiled", timestamp: new Date().toISOString() });
    adapter1.flush();
    // 第二次写入（模拟 V2 多阶段各自 create adapter）
    const adapter2 = createLegacyTraceAdapter({
      workspacePath: tmpDir,
      workspaceId: "ws-append",
      chapterId: "1",
    });
    adapter2.record({ stage: "candidate_generated", timestamp: new Date().toISOString() });
    adapter2.flush();
    // 读回：应含两条 gates（append 模式不清空）
    const tracePath = join(tmpDir, "ws-append", "traces", "1-quality-trace.json");
    const parsed = JSON.parse(readFileSync(tracePath, "utf-8"));
    assert.ok(parsed.gates.length >= 2, `append 模式应保留历史 gates，实际 ${parsed.gates.length}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Layer 2 (Task I4): editorial_plan_planned stage 映射 + amplifiedVariantIds 收集
// 验证 Task F 已落地的 adapter 映射逻辑：editorial_plan_planned → v2_editorial_plan_planned
// gate（reason 含 variants 数/degraded/source），degraded=true 时 status=WARN；
// buildV2Summary 从 candidate_generated 的 editorial_amplified 候选收集 amplifiedVariantIds。
// ============================================================================

function makeEditorialPlan(variantCount, source = "llm") {
  const strategies = ["payoff_first", "character_agency_first", "suspense_info_release", "ensemble_layered", "style_native"];
  return {
    readerExperience: "本章最值得强化的读者体验",
    protagonistChoice: "主角本章必须做出的选择",
    expectationAdvancement: "期待/伏笔/信息释放推进",
    chapterEndPressure: "章尾新问题或压力",
    ensembleRoles: "群像角色叙事功能",
    inviolableFacts: ["事实1", "事实2"],
    variantStrategies: strategies.slice(0, variantCount).map((s) => ({
      strategy: s,
      focus: `${s} 焦点`,
      angle: `${s} 切入角度`,
    })),
    _source: source,
  };
}

function makeCandidate(id, kind, route = "v2_amplified") {
  return {
    id,
    kind,
    text: `text-${id}`,
    model: "m",
    route,
    promptProfile: {
      type: "editorial",
      tokensIn: 10,
      containsDialogueRatio: false,
      containsParagraphLengthConstraint: false,
      contractIds: [],
    },
    contextHash: "h",
    generatedAt: "t",
    durationMs: 1,
  };
}

test("Layer 2: editorial_plan_planned stage 映射到 v2_editorial_plan_planned gate", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "v2-trace-edplan-"));
  try {
    const adapter = createLegacyTraceAdapter({
      workspacePath: tmpDir,
      workspaceId: "ws-edplan",
      chapterId: "17",
    });
    adapter.record({
      stage: "editorial_plan_planned",
      timestamp: new Date().toISOString(),
      editorialPlan: makeEditorialPlan(3, "llm"),
      degraded: false,
      contextHash: "h",
    });
    const path = adapter.flush();
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const gate = parsed.gates.find((g) => g.stage === "v2_editorial_plan_planned");
    assert.ok(gate, `应含 v2_editorial_plan_planned gate：${JSON.stringify(parsed.gates.map((g) => g.stage))}`);
    assert.ok(gate.reason.includes("variants=3"), `reason 应含 variants=3：${gate.reason}`);
    assert.ok(gate.reason.includes("degraded=false"), `reason 应含 degraded=false：${gate.reason}`);
    assert.ok(gate.reason.includes("source=llm"), `reason 应含 source=llm：${gate.reason}`);
    // 非降级 → status=PASS（不是 WARN）
    assert.equal(gate.status, "PASS", `非降级应为 PASS，实际 ${gate.status}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Layer 2: amplifiedVariantIds 从 editorial_amplified 候选收集", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "v2-trace-variants-"));
  try {
    const adapter = createLegacyTraceAdapter({
      workspacePath: tmpDir,
      workspaceId: "ws-variants",
      chapterId: "17",
    });
    if (adapter.setV2Mode) adapter.setV2Mode("full_chain");
    // 2 个 editorial_amplified 变体 + 1 个 scene_contract（route 相同但 kind 不同）
    adapter.record({
      stage: "candidate_generated",
      timestamp: new Date().toISOString(),
      candidates: [
        makeCandidate("ed-1", "editorial_amplified"),
        makeCandidate("ed-2", "editorial_amplified"),
        makeCandidate("sc-1", "scene_contract"),
      ],
      contextHash: "h",
    });
    const path = adapter.flush();
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    assert.ok(parsed.v2Summary, "应有 v2Summary");
    const ids = parsed.v2Summary.amplifiedVariantIds;
    assert.ok(Array.isArray(ids), `amplifiedVariantIds 应为数组：${JSON.stringify(ids)}`);
    assert.equal(ids.length, 2, `只应收集 editorial_amplified kind（2 个），不含 scene_contract：${JSON.stringify(ids)}`);
    assert.ok(ids.includes("ed-1") && ids.includes("ed-2"), `应含 ed-1/ed-2：${JSON.stringify(ids)}`);
    assert.ok(!ids.includes("sc-1"), `不应含 scene_contract 候选 sc-1：${JSON.stringify(ids)}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Layer 2: degraded=true 时 editorial_plan_planned gate.status=WARN", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "v2-trace-degraded-"));
  try {
    const adapter = createLegacyTraceAdapter({
      workspacePath: tmpDir,
      workspaceId: "ws-degraded",
      chapterId: "17",
    });
    adapter.record({
      stage: "editorial_plan_planned",
      timestamp: new Date().toISOString(),
      editorialPlan: makeEditorialPlan(4, "fallback_derived"),
      degraded: true,
      degradeReason: "LLM 返回非 JSON，parse 失败",
      contextHash: "h",
    });
    const path = adapter.flush();
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const gate = parsed.gates.find((g) => g.stage === "v2_editorial_plan_planned");
    assert.ok(gate, "应含 v2_editorial_plan_planned gate");
    assert.equal(gate.status, "WARN", `降级应为 WARN，实际 ${gate.status}`);
    assert.ok(gate.reason.includes("degraded=true"), `reason 应含 degraded=true：${gate.reason}`);
    assert.ok(gate.reason.includes("source=fallback_derived"), `reason 应含 source=fallback_derived：${gate.reason}`);
    assert.ok(gate.reason.includes("variants=4"), `reason 应含 variants=4：${gate.reason}`);
    // WARN 不是 BLOCK/ERROR，passed 仍 true（soft 降级，不阻断流程）
    assert.equal(gate.passed, true, "WARN 是 soft，passed 应仍为 true");
    assert.equal(gate.blocked, false, "WARN 不应 blocked");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
