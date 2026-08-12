/**
 * AGENTIC-EVIDENCE-MERGE-1 补验（P1）：replay 脚本阻断分类与恢复率统计单测。
 *
 * 针对评审发现的两个 P1 缺陷做回归保护：
 * 1. 阻断分类重复计数：hardBlocked 原把所有非成功且不可恢复章节计入，已包含 preflight 级联，
 *    报告相加出现重复计数。classifyBlocks 应让三类互斥，且依据 stage 归因。
 * 2. 恢复率仅检查最后一个 FailureEnvelope：extractTraceMetrics 原只返回 lastEnvelope，
 *    非最后一项的可恢复记录被漏掉。hasRecoverableFailure 应遍历全部 envelope。
 *
 * 只 import 脚本的纯函数（extractTraceMetrics / classifyBlocks / computeRecovery），
 * 不触发真实 replay（脚本底部已用 isDirectRun 保护 main()）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = pathToFileURL(join(__dirname, "..", "scripts", "agentic-evidence-merge-replay.mjs")).href;
const {
  extractTraceMetrics,
  classifyBlocks,
  computeRecovery,
} = await import(scriptPath);

// ============================================================================
// P1-1：阻断分类互斥
// ============================================================================

test("classifyBlocks：preflight 级联不再计入 hardBlocked，三类相加等于阻断总数", () => {
  const chapterResults = [
    { status: "ok", failureStage: null, recoverable: false },
    { status: "blocked", failureStage: "preflight", recoverable: false },
    { status: "blocked", failureStage: "preflight", recoverable: false },
    { status: "blocked", failureStage: "story_preservation", recoverable: false },
    { status: "blocked", failureStage: "novelos", recoverable: true },
  ];

  const { hardBlocked, preflightCascade, recoverableBlocks } = classifyBlocks(chapterResults);

  // 关键回归断言：2 个 preflight 不进入 hardBlocked
  assert.equal(hardBlocked, 1, "hardBlocked 应只统计非 preflight 且不可恢复的阻断（1 个 story_preservation）");
  assert.equal(preflightCascade, 2, "preflightCascade 应统计 2 个 preflight 级联");
  assert.equal(recoverableBlocks, 1, "recoverableBlocks 应统计 1 个可恢复阻断");
  assert.equal(
    hardBlocked + preflightCascade + recoverableBlocks,
    4,
    "三类相加应等于阻断总数（4），互斥无重复计数",
  );
});

test("classifyBlocks：无阻断时三类均为 0", () => {
  const { hardBlocked, preflightCascade, recoverableBlocks } = classifyBlocks([
    { status: "ok", failureStage: null, recoverable: false },
    { status: "ok", failureStage: null, recoverable: false },
  ]);
  assert.equal(hardBlocked, 0);
  assert.equal(preflightCascade, 0);
  assert.equal(recoverableBlocks, 0);
});

test("classifyBlocks：非 preflight 的可恢复阻断不会被计入 hardBlocked", () => {
  const { hardBlocked, preflightCascade, recoverableBlocks } = classifyBlocks([
    { status: "blocked", failureStage: "novelos", recoverable: true },
  ]);
  assert.equal(hardBlocked, 0, "可恢复阻断不应计入 hardBlocked");
  assert.equal(preflightCascade, 0);
  assert.equal(recoverableBlocks, 1);
});

// ============================================================================
// P1-2：恢复率遍历全部 FailureEnvelope
// ============================================================================

test("extractTraceMetrics：非最后一项的可恢复 envelope 也被计入 hasRecoverableFailure", () => {
  // 关键回归：可恢复 envelope 在中间，最后一项是不可恢复的 hard envelope。
  // 旧实现只检查 lastEnvelope，会漏掉这条可恢复记录。
  const trace = {
    gates: [{ stage: "v2_novelos_agentic", evidence: { novelos: {} } }],
    failureEnvelopes: [
      { stage: "novelos", gate: "model_timeout", severity: "recoverable", recoverable: true },
      { stage: "v2_amplified", gate: "style_optimization", severity: "hard", recoverable: false },
    ],
  };

  const metrics = extractTraceMetrics(trace);

  assert.equal(metrics.hasRecoverableFailure, true, "存在中间可恢复 envelope 时应为 true");
  assert.equal(metrics.lastEnvelope.gate, "style_optimization", "lastEnvelope 仍是最后一项（不可恢复）");
  assert.equal(metrics.failureEnvelopes.length, 2, "应保留全部 envelope 供审计");
});

test("extractTraceMetrics：无可恢复 envelope 时 hasRecoverableFailure 为 false", () => {
  const trace = {
    gates: [{ stage: "v2_novelos_agentic", evidence: { novelos: {} } }],
    failureEnvelopes: [
      { stage: "story_preservation", severity: "hard", recoverable: false },
    ],
  };
  const metrics = extractTraceMetrics(trace);
  assert.equal(metrics.hasRecoverableFailure, false);
  assert.equal(metrics.failureEnvelopes.length, 1);
});

test("extractTraceMetrics：无 failureEnvelopes 字段时为 false 而非抛错", () => {
  const metrics = extractTraceMetrics({
    gates: [{ stage: "v2_novelos_agentic", evidence: { novelos: {} } }],
  });
  assert.equal(metrics.hasRecoverableFailure, false);
  assert.deepEqual(metrics.failureEnvelopes, []);
  assert.equal(metrics.lastEnvelope, null);
});

test("computeRecovery：成功章节的中间可恢复失败计入恢复率，非仅阻断路径", () => {
  const withTrace = [
    // 成功但 trace 中有可恢复失败（中间发生过 model_timeout 后重试成功）
    { status: "ok", recoverable: false, traceMetrics: { hasRecoverableFailure: true } },
    // 干净成功，无可恢复失败
    { status: "ok", recoverable: false, traceMetrics: { hasRecoverableFailure: false } },
    // 阻断路径可恢复但未恢复成功
    { status: "blocked", recoverable: true, traceMetrics: { hasRecoverableFailure: false } },
    // 真正 hard block
    { status: "blocked", recoverable: false, traceMetrics: { hasRecoverableFailure: false } },
  ];

  const { totalRecoverable, recoveredAfterRetry, recoveryRate } = computeRecovery(withTrace);

  assert.equal(totalRecoverable, 2, "可恢复失败章节 = 成功含可恢复 trace + 阻断可恢复");
  assert.equal(recoveredAfterRetry, 1, "恢复成功 1 章（成功路径）");
  assert.equal(recoveryRate, 50, "恢复率 = 1/2 = 50%");
});

test("computeRecovery：无可恢复失败时 recoveryRate 为 null 且 note 为 N/A", () => {
  const { totalRecoverable, recoveryRate, recoveryRateNote } = computeRecovery([
    { status: "ok", recoverable: false, traceMetrics: { hasRecoverableFailure: false } },
  ]);
  assert.equal(totalRecoverable, 0);
  assert.equal(recoveryRate, null);
  assert.match(recoveryRateNote, /N\/A/);
});
