/** Real-evidence acceptance tests for the 2026-07-18 optimization card. */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  FULL_PREVIEW_STAGES,
  verifyCleanModelBenchmark,
  verifyEndingPressureReal,
  verifyLanguageCalibrationReal,
} from "../dist-test/v2/core/real-quality-acceptance.js";

// ============================================================================
// P1-4 Layer A — 共享 temp trace 文件（GREEN）
//
// 5 个现有 positive 测试默认使用 provenance().tracePath，原默认值
// "reports/traces/real-run.json" 不存在，启用 tracePath 深检后会破坏。
// 解决：模块加载时同步创建一个共享 temp trace 文件，进程退出时清理。
// ============================================================================

const SHARED_TEMP_DIR = join(process.cwd(), "reports", "traces", "shared-temp");
const SHARED_TRACE_PATH = join(SHARED_TEMP_DIR, "real-run.json");

function makeValidTraceJson(overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    workspaceId: "test-ws",
    chapterId: "test-ch",
    createdAt: "2026-07-19T00:00:00.000Z",
    events: [{
      eventId: "e1",
      eventName: "test-event",
      sceneType: "general",
      selectedRuleIds: [],
      selectedFewshotIds: [],
      contractSummary: "test",
      evaluation: { score: 80, passed: true, issueTypes: [] },
      attempts: 1,
      model: "doubao-seed-2.1-pro",
    }],
    patches: [],
    gates: [],
    performanceProfile: {
      totalElapsedMs: 1000,
      stageTimings: {},
      llmTimings: [
        { timestamp: "2026-07-19T00:00:00.000Z", agent: "narrator", provider: "doubao", model: "doubao-seed-2.1-pro", attempt: 1, elapsedMs: 100, status: "ok", route: "v2_chinese_calibration" },
        { timestamp: "2026-07-19T00:00:01.000Z", agent: "judge", provider: "gpt", model: "gpt-5.6-sol", attempt: 1, elapsedMs: 200, status: "ok", route: "v2_literary_judge" },
        { timestamp: "2026-07-19T00:00:02.000Z", agent: "judge", provider: "gpt", model: "gpt-5.6-sol", attempt: 2, elapsedMs: 200, status: "ok", route: "v2_literary_judge" },
        { timestamp: "2026-07-19T00:00:03.000Z", agent: "narrator", provider: "claude", model: "claude-opus-4.6", attempt: 1, elapsedMs: 300, status: "ok", route: "v2_rawstage2" },
        { timestamp: "2026-07-19T00:00:04.000Z", agent: "narrator", provider: "gpt", model: "gpt-5.5", attempt: 1, elapsedMs: 150, status: "ok", route: "v2_rawstage2" },
      ],
      retryCostMs: 0,
      fallbackCostMs: 0,
      loopbackCostMs: 0,
      topSlowStages: [],
      topSlowModelCalls: [],
    },
    ...overrides,
  }, null, 2);
}

// 模块加载时同步创建共享 temp trace（在所有 test 调用前执行）
mkdirSync(SHARED_TEMP_DIR, { recursive: true });
writeFileSync(SHARED_TRACE_PATH, makeValidTraceJson(), "utf-8");

// 进程退出时清理（覆盖正常退出）
process.on("exit", () => {
  try { unlinkSync(SHARED_TRACE_PATH); } catch { /* ignore */ }
  try { rmSync(SHARED_TEMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function provenance(overrides = {}) {
  return {
    mode: "real",
    generatorModel: "doubao-seed-2.1-pro",
    judgeModel: "gpt-5.6-sol",
    generationRequestId: "gen-request-1",
    judgeRequestIds: ["judge-forward-1", "judge-reverse-1"],
    providerResponseHashes: ["a".repeat(64), "b".repeat(64), "c".repeat(64)],
    tracePath: SHARED_TRACE_PATH,
    fallbackUsed: false,
    ...overrides,
  };
}

function judge(candidateWins = true) {
  return {
    forward: { candidateLabel: "B", winner: candidateWins ? "B" : "A", confidence: "clear" },
    reverse: { candidateLabel: "A", winner: candidateWins ? "A" : "B", confidence: "clear" },
  };
}

function languageSample(index, candidateWins = index < 3) {
  const raw = `第${index}章。他感到一阵寒意。门外风声未停。`;
  const candidate = `第${index}章。他察觉到一阵寒意。门外风声未停。`;
  return {
    chapterId: `ch${index + 1}`,
    rawText: raw,
    candidateText: candidate,
    allowedEdits: [{
      raw: { start: raw.indexOf("感到"), end: raw.indexOf("感到") + 2 },
      candidate: { start: candidate.indexOf("察觉到"), end: candidate.indexOf("察觉到") + 3 },
    }],
    factGuardPassed: true,
    storyPreservationPassed: true,
    judge: judge(candidateWins),
    finalSelectedSource: candidateWins ? "candidate" : "raw",
    provenance: provenance({ generationRequestId: `gen-${index}` }),
  };
}

test("LANGUAGE-CALIBRATION-REAL-1 拒绝 stub provenance", () => {
  const samples = Array.from({ length: 5 }, (_, index) => languageSample(index));
  samples[0].provenance.mode = "stub";
  const result = verifyLanguageCalibrationReal(samples);
  assert.equal(result.accepted, false);
  assert.ok(result.blockers.some((blocker) => blocker.includes("真实模型")));
});

test("LANGUAGE-CALIBRATION-REAL-1 需要 5 章真实样本且候选净胜", () => {
  const result = verifyLanguageCalibrationReal(Array.from({ length: 5 }, (_, index) => languageSample(index)));
  assert.equal(result.accepted, true, result.blockers.join("; "));
  assert.equal(result.candidateClearWins, 3);
  assert.equal(result.rawRetained, 2);
});

test("LANGUAGE-CALIBRATION-REAL-1 拒绝目标 span 外改文", () => {
  const samples = Array.from({ length: 5 }, (_, index) => languageSample(index));
  samples[0].candidateText += "新增组织计划。";
  const result = verifyLanguageCalibrationReal(samples);
  assert.equal(result.accepted, false);
  assert.ok(result.blockers.some((blocker) => blocker.includes("span")));
});

function endingSample(index, candidateWins = index < 3) {
  const raw = `第${index}章。众人退入门后。风声渐弱。`;
  const candidate = `第${index}章。众人退入门后。门外的脚步声却停在了门槛前。`;
  return {
    chapterId: `ch${index + 1}`,
    rawText: raw,
    candidateText: candidate,
    allowedEdits: [{
      raw: { start: raw.indexOf("风声"), end: raw.length },
      candidate: { start: candidate.indexOf("门外"), end: candidate.length },
    }],
    causalEndPressure: { value: "门外追兵沿本章撤退因果逼近", sourceRef: `seed:ch${index + 1}:pressure` },
    currentHookType: index % 2 === 0 ? "approaching_threat" : "suspended_action",
    recentHookTypes: index % 2 === 0 ? ["cost_reveal"] : ["approaching_threat"],
    factGuardPassed: true,
    storyPreservationPassed: true,
    judge: judge(candidateWins),
    finalSelectedSource: candidateWins ? "candidate" : "raw",
    provenance: provenance({ generationRequestId: `ending-gen-${index}` }),
  };
}

test("ENDING-PRESSURE-REAL-1 检测 PatternMemory 近期钩子重复", () => {
  const samples = Array.from({ length: 5 }, (_, index) => endingSample(index));
  samples[0].recentHookTypes = ["approaching_threat", "approaching_threat"];
  const result = verifyEndingPressureReal(samples);
  assert.equal(result.accepted, false);
  assert.ok(result.blockers.some((blocker) => blocker.includes("PatternMemory")));
});

test("ENDING-PRESSURE-REAL-1 通过 5 章因果压力候选反向 A/B 验收", () => {
  const result = verifyEndingPressureReal(Array.from({ length: 5 }, (_, index) => endingSample(index)));
  assert.equal(result.accepted, true, result.blockers.join("; "));
  assert.equal(result.candidateClearWins, 3);
});

function benchmark(chapterCount) {
  const models = ["claude-opus-4.6", "gpt-5.5"];
  const scenes = ["combat", "emotion", "transition", "reveal", "ensemble"];
  const runs = [];
  for (let chapterIndex = 0; chapterIndex < chapterCount; chapterIndex += 1) {
    for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
      runs.push({
        chapterId: `ch${chapterIndex + 1}`,
        sceneType: scenes[chapterIndex % scenes.length],
        rawModel: models[modelIndex],
        frontierHash: `frontier-${chapterIndex}`,
        chapterIntentHash: `intent-${chapterIndex}`,
        contextBudget: 24000,
        outputRange: { min: 2500, max: 3500 },
        fullPipelinePreview: true,
        executedStages: [...FULL_PREVIEW_STAGES],
        stateHashBefore: `state-${chapterIndex}`,
        stateHashAfter: `state-${chapterIndex}`,
        anonymousOrder: modelIndex % 2 === 0 ? ["A", "B"] : ["B", "A"],
        fallbackUsed: false,
        provenance: provenance({ generatorModel: models[modelIndex], generationRequestId: `bench-${chapterIndex}-${modelIndex}` }),
      });
    }
  }
  return { models, runs };
}

test("CLEAN-MODEL-BENCHMARK-1 拒绝同章 frontier 不一致", () => {
  const input = benchmark(5);
  input.runs[1].frontierHash = "polluted-frontier";
  const result = verifyCleanModelBenchmark(input);
  assert.equal(result.accepted, false);
  assert.ok(result.blockers.some((blocker) => blocker.includes("frontier")));
});

test("CLEAN-MODEL-BENCHMARK-1 五章只能形成初筛", () => {
  const result = verifyCleanModelBenchmark(benchmark(5));
  assert.equal(result.accepted, true, result.blockers.join("; "));
  assert.equal(result.status, "screening_only");
});

test("CLEAN-MODEL-BENCHMARK-1 十章且覆盖五类场景才允许临时路由建议", () => {
  const result = verifyCleanModelBenchmark(benchmark(10));
  assert.equal(result.accepted, true, result.blockers.join("; "));
  assert.equal(result.status, "temporary_routing_recommendation_eligible");
});

// ============================================================================
// P1-4 Layer A — provenance 防伪深检（5 测试用例 + 共享 temp trace fixture）
//
// 历史：现有 `validateRealProvenance` 只做字符串格式校验（.trim() 非空 + 正则 + length），
// 用户测试证明 5 条不存在 trace + 虚假模型名 + 伪 request ID + 伪响应 hash 的样本
// 会被 `accepted: true` 通过。这违反项目硬约束：
// "Provenance guard must return 'unverifiable_provenance' for path traversal,
//  missing files, hash mismatch, or identity inconsistency"
//
// Layer A 关闭 4 类伪造向量：tracePath 不存在 / 路径穿越 / 坏 JSON / 模型名不一致。
// Layer B（requestId/responseHash 落盘 + 集合 membership 校验）推迟到 REQUIRES_AUTH 切片。
// ============================================================================

const RED_TEMP_DIR = join(process.cwd(), "reports", "traces", "red-temp");

function ensureRedTempDir() {
  mkdirSync(RED_TEMP_DIR, { recursive: true });
}

function writeRedTraceFile(fileName, content) {
  ensureRedTempDir();
  const filePath = join(RED_TEMP_DIR, fileName);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// `makeValidTraceJson` 已提前到文件顶部（与共享 temp trace 一起使用）

test("LANGUAGE-CALIBRATION-REAL-1 拒绝不存在的 tracePath (Layer A)", () => {
  const samples = Array.from({ length: 5 }, (_, index) => languageSample(index));
  const nonexistentPath = join(RED_TEMP_DIR, `nonexistent-${Date.now()}.json`);
  for (const sample of samples) {
    sample.provenance.tracePath = nonexistentPath;
  }
  const result = verifyLanguageCalibrationReal(samples);
  assert.equal(result.accepted, false);
  assert.ok(
    result.blockers.some((blocker) => blocker.includes("tracePath") && (blocker.includes("不存在") || blocker.includes("not exist"))),
    `expected tracePath 不存在 blocker; got: ${result.blockers.join("; ")}`,
  );
});

test("LANGUAGE-CALIBRATION-REAL-1 拒绝路径穿越攻击 (Layer A, Unix + Windows)", () => {
  const escapePaths = [
    "../../../etc/passwd",
    "..\\..\\..\\Windows\\System32\\drivers\\etc\\hosts",
  ];
  for (const escapePath of escapePaths) {
    const samples = Array.from({ length: 5 }, (_, index) => languageSample(index));
    for (const sample of samples) {
      sample.provenance.tracePath = escapePath;
    }
    const result = verifyLanguageCalibrationReal(samples);
    assert.equal(result.accepted, false, `tracePath=${escapePath} 应被拒绝`);
    assert.ok(
      result.blockers.some((blocker) => blocker.includes("路径越界")),
      `tracePath=${escapePath} 应有 路径越界 blocker; got: ${result.blockers.join("; ")}`,
    );
  }
});

test("LANGUAGE-CALIBRATION-REAL-1 拒绝无法解析的 trace 文件 (Layer A)", () => {
  const badJsonPath = writeRedTraceFile(`bad-json-${Date.now()}.txt`, "{ this is not valid json");
  try {
    const samples = Array.from({ length: 5 }, (_, index) => languageSample(index));
    for (const sample of samples) {
      sample.provenance.tracePath = badJsonPath;
    }
    const result = verifyLanguageCalibrationReal(samples);
    assert.equal(result.accepted, false);
    assert.ok(
      result.blockers.some((blocker) => blocker.includes("JSON") || blocker.includes("schema") || blocker.includes("解析")),
      `expected JSON/schema/解析 blocker; got: ${result.blockers.join("; ")}`,
    );
  } finally {
    unlinkSync(badJsonPath);
  }
});

test("LANGUAGE-CALIBRATION-REAL-1 拒绝 generator model 与 trace 不一致 (Layer A)", () => {
  const mismatchPath = writeRedTraceFile(`mismatch-${Date.now()}.json`, makeValidTraceJson({
    performanceProfile: {
      totalElapsedMs: 1000,
      stageTimings: {},
      llmTimings: [
        { timestamp: "2026-07-19T00:00:00.000Z", agent: "narrator", provider: "claude", model: "claude-opus-4.6", attempt: 1, elapsedMs: 100, status: "ok", route: "v2_rawstage2" },
      ],
      retryCostMs: 0,
      fallbackCostMs: 0,
      loopbackCostMs: 0,
      topSlowStages: [],
      topSlowModelCalls: [],
    },
    events: [{
      eventId: "e1",
      eventName: "test-event",
      sceneType: "general",
      selectedRuleIds: [],
      selectedFewshotIds: [],
      contractSummary: "test",
      evaluation: { score: 80, passed: true, issueTypes: [] },
      attempts: 1,
      model: "claude-opus-4.6",
    }],
  }));
  try {
    const samples = Array.from({ length: 5 }, (_, index) => languageSample(index));
    for (const sample of samples) {
      sample.provenance.tracePath = mismatchPath;
    }
    const result = verifyLanguageCalibrationReal(samples);
    assert.equal(result.accepted, false);
    assert.ok(
      result.blockers.some((blocker) => blocker.includes("generatorModel")),
      `expected generatorModel blocker; got: ${result.blockers.join("; ")}`,
    );
  } finally {
    unlinkSync(mismatchPath);
  }
});

test("LANGUAGE-CALIBRATION-REAL-1 接受合法 trace 文件 + 模型一致 + hash 格式正确 (Layer A golden path)", () => {
  const validPath = writeRedTraceFile(`valid-${Date.now()}.json`, makeValidTraceJson());
  try {
    const samples = Array.from({ length: 5 }, (_, index) => languageSample(index));
    for (const sample of samples) {
      sample.provenance.tracePath = validPath;
    }
    const result = verifyLanguageCalibrationReal(samples);
    assert.equal(result.accepted, true, result.blockers.join("; "));
  } finally {
    unlinkSync(validPath);
  }
});
