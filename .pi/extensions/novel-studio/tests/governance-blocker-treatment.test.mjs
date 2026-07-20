/**
 * PiNovelStudio — 治理方案：真实生成阻断治理 测试套件
 *
 * 覆盖治理方案 §三 核心交付物的关键不变量：
 *  1. FailureEnvelope 阻断归因结构（Phase 1）
 *  2. failure-envelope-reporter（withFailureReturn / flushFailureEnvelopeToTraceFile）
 *  3. novel_preflight_workspace 生成前预检（Phase 2）
 *  4. quality-trace-recorder.recordFailureEnvelope 写入 + attemptHistory
 *
 * Phase 7: event-recovery-config / patch-quality-comparator 已作为 legacy dead code 删除，
 * 对应测试块已移除。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..");
const extRoot = resolve(repoRoot, ".pi", "extensions", "novel-studio");
const distRoot = join(extRoot, "dist-test");

// ─────────────────────────────────────────────────────────────────────────────
// 模块加载
// ─────────────────────────────────────────────────────────────────────────────

let failureEnvelopeMod;
let failureEnvelopeReporterMod;
let preflightMod;
let traceRecorderMod;

async function loadModules() {
  failureEnvelopeMod = await import(pathToFileURL(join(distRoot, "craft", "failure-envelope.js")).href);
  failureEnvelopeReporterMod = await import(pathToFileURL(join(distRoot, "craft", "failure-envelope-reporter.js")).href);
  preflightMod = await import(pathToFileURL(join(distRoot, "craft", "workspace-preflight-checker.js")).href);
  traceRecorderMod = await import(pathToFileURL(join(distRoot, "craft", "quality-trace-recorder.js")).href);
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试 workspace 工具
// ─────────────────────────────────────────────────────────────────────────────

const testWorkspaceId = "test-governance-blocker";
let testWorkspacePath;

function setupTestWorkspace(options = {}) {
  const { withConfig = true, withCharacters = true, withSkeleton = false, chapterNumber = 1, configOverride = {} } = options;
  testWorkspacePath = resolve(repoRoot, "workspaces", testWorkspaceId);
  if (existsSync(testWorkspacePath)) {
    rmSync(testWorkspacePath, { recursive: true, force: true });
  }
  const dirs = [
    testWorkspacePath,
    join(testWorkspacePath, "series"),
    join(testWorkspacePath, "characters"),
    join(testWorkspacePath, "chapters"),
    join(testWorkspacePath, "traces"),
  ];
  for (const d of dirs) mkdirSync(d, { recursive: true });

  if (withConfig) {
    const configData = {
      name: "治理测试小说",
      genre: "玄幻",
      subGenres: ["重生"],
      characters: [
        { id: "protagonist", name: "林墨", role: "主角" },
        { id: "mentor", name: "老者", role: "导师" },
      ],
      totalChapters: 20,
      targetWordCount: { perChapter: { min: 2000, max: 3000 } },
      ...configOverride,
    };
    writeFileSync(join(testWorkspacePath, "config.json"), JSON.stringify(configData, null, 2), "utf-8");
  }

  if (withCharacters) {
    writeFileSync(
      join(testWorkspacePath, "characters", "protagonist.md"),
      "# 林墨\n\n主角，重生者。\n",
      "utf-8",
    );
    writeFileSync(
      join(testWorkspacePath, "characters", "mentor.md"),
      "# 老者\n\n神秘导师。\n",
      "utf-8",
    );
  }

  if (withSkeleton) {
    const skeleton = {
      chapterSkeletons: {
        [String(chapterNumber - 1)]: {
          title: `第${chapterNumber - 1}章`,
          facts: ["前章发生了某事"],
          stateChanges: [{ subject: "林墨", after: "心境提升", isReversible: true }],
          activeDilemmas: ["未解之谜"],
        },
      },
    };
    writeFileSync(join(testWorkspacePath, "series", "skeleton.json"), JSON.stringify(skeleton, null, 2), "utf-8");
  }
}

function cleanupTestWorkspace() {
  if (existsSync(testWorkspacePath)) {
    rmSync(testWorkspacePath, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试用例
// ─────────────────────────────────────────────────────────────────────────────

describe("治理方案 Phase 1：FailureEnvelope 阻断归因结构", () => {
  before(async () => { await loadModules(); });

  it("createFailureEnvelope 默认 recoverable 与 severity 对齐", () => {
    const { createFailureEnvelope } = failureEnvelopeMod;
    const env = createFailureEnvelope({
      stage: "2-narrator",
      gate: "anti_ai",
      severity: "recoverable",
      reason: "anti-ai 命中",
      evidence: { hits: ["bare_number_measure"] },
    });
    assert.equal(env.stage, "2-narrator");
    assert.equal(env.gate, "anti_ai");
    assert.equal(env.severity, "recoverable");
    assert.equal(env.recoverable, true);
    assert.equal(env.reason, "anti-ai 命中");
    assert.deepEqual(env.evidence, { hits: ["bare_number_measure"] });
  });

  it("createFailureEnvelope 显式 recoverable=false 优先", () => {
    const { createFailureEnvelope } = failureEnvelopeMod;
    const env = createFailureEnvelope({
      stage: "8-final",
      gate: "style",
      severity: "recoverable",
      reason: "style 偏差",
      recoverable: false,
    });
    assert.equal(env.recoverable, false);
  });

  it("preflightBlockEnvelope 不可自动恢复 + userActionRequired", () => {
    const { preflightBlockEnvelope } = failureEnvelopeMod;
    const env = preflightBlockEnvelope(
      "0-preflight",
      "config_missing",
      "缺少 config.json",
      { workspaceId: "demo" },
      ["创建 workspaces/demo/config.json"],
    );
    assert.equal(env.severity, "preflight");
    assert.equal(env.recoverable, false);
    assert.deepEqual(env.userActionRequired, ["创建 workspaces/demo/config.json"]);
  });

  it("recoverableEnvelope 带 retryPlan", () => {
    const { recoverableEnvelope } = failureEnvelopeMod;
    const env = recoverableEnvelope(
      "2-narrator",
      "anti_ai",
      "anti-ai 命中",
      { hits: ["excessive_ellipsis"] },
      { strategy: "rewrite_event", maxAttempts: 2 },
    );
    assert.equal(env.severity, "recoverable");
    assert.equal(env.recoverable, true);
    assert.equal(env.retryPlan.strategy, "rewrite_event");
    assert.equal(env.retryPlan.maxAttempts, 2);
  });

  it("hardBlockEnvelope 不可自动恢复", () => {
    const { hardBlockEnvelope } = failureEnvelopeMod;
    const env = hardBlockEnvelope(
      "8-final",
      "style",
      "风格修订无实质改写",
      { matchScore: 0.5 },
      ["人工审阅风格修订"],
    );
    assert.equal(env.severity, "hard_block");
    assert.equal(env.recoverable, false);
    assert.deepEqual(env.userActionRequired, ["人工审阅风格修订"]);
  });

  it("formatFailureEnvelopeMessage 包含 stage/gate/reason/strategy", () => {
    const { createFailureEnvelope, formatFailureEnvelopeMessage } = failureEnvelopeMod;
    const env = createFailureEnvelope({
      stage: "6.5-suspense-density",
      gate: "suspense_density",
      severity: "recoverable",
      reason: "悬念密度 0.5 < 阈值 1.0",
      retryPlan: { strategy: "local_repair", maxAttempts: 1 },
      userActionRequired: ["补充 hook beat"],
    });
    const msg = formatFailureEnvelopeMessage(env);
    assert.ok(msg.includes("stage=6.5-suspense-density"));
    assert.ok(msg.includes("gate=suspense_density"));
    assert.ok(msg.includes("悬念密度 0.5"));
    assert.ok(msg.includes("local_repair"));
    assert.ok(msg.includes("补充 hook beat"));
  });
});

describe("治理方案 Phase 1：failure-envelope-reporter", () => {
  before(async () => { await loadModules(); });

  it("withFailureReturn 追加 failureEnvelope 字段，不破坏原字段", () => {
    const { withFailureReturn } = failureEnvelopeReporterMod;
    const { createFailureEnvelope } = failureEnvelopeMod;
    const env = createFailureEnvelope({
      stage: "0-preflight",
      gate: "config_missing",
      severity: "preflight",
      reason: "缺 config",
    });
    const baseReturn = { status: "blocked", stage: "0-preflight", message: "blocked", stageResults: {} };
    const wrapped = withFailureReturn(baseReturn, env);
    assert.equal(wrapped.status, "blocked");
    assert.equal(wrapped.stage, "0-preflight");
    assert.equal(wrapped.message, "blocked");
    assert.deepEqual(wrapped.stageResults, {});
    assert.equal(wrapped.failureEnvelope, env);
    // 原对象不被修改
    assert.equal(baseReturn.failureEnvelope, undefined);
  });

  it("flushFailureEnvelopeToTraceFile 写入 trace 文件（早期阻断场景）", () => {
    const { flushFailureEnvelopeToTraceFile } = failureEnvelopeReporterMod;
    const { createFailureEnvelope } = failureEnvelopeMod;
    setupTestWorkspace();
    const env = createFailureEnvelope({
      stage: "0-preflight",
      gate: "config_missing",
      severity: "preflight",
      reason: "缺 config",
      evidence: { workspaceId: testWorkspaceId },
    });
    flushFailureEnvelopeToTraceFile(
      join(repoRoot, "workspaces"),
      testWorkspaceId,
      "1",
      env,
      [{ attempt: 1, strategy: "user_fix", reason: "等待用户补 config", outcome: "failed" }],
    );
    const tracePath = join(testWorkspacePath, "traces", "1-quality-trace.json");
    assert.ok(existsSync(tracePath), "trace 文件应被创建");
    const trace = JSON.parse(readFileSync(tracePath, "utf-8"));
    assert.ok(Array.isArray(trace.failureEnvelopes), "trace 应有 failureEnvelopes 数组");
    assert.equal(trace.failureEnvelopes.length, 1);
    assert.equal(trace.failureEnvelopes[0].stage, "0-preflight");
    assert.equal(trace.failureEnvelopes[0].gate, "config_missing");
    assert.ok(Array.isArray(trace.failureEnvelopes[0].attemptHistory));
    assert.equal(trace.failureEnvelopes[0].attemptHistory.length, 1);
    cleanupTestWorkspace();
  });
});

describe("治理方案 Phase 2：novel_preflight_workspace 生成前预检", () => {
  before(async () => { await loadModules(); });

  it("缺 config.json 阻断 + 提示创建 config", () => {
    const { preflightWorkspace } = preflightMod;
    setupTestWorkspace({ withConfig: false });
    const report = preflightWorkspace({
      workspacePath: testWorkspacePath,
      workspaceId: testWorkspaceId,
      chapterId: "1",
      chapterNumber: 1,
      skipSeedReadiness: true,
    });
    assert.equal(report.passed, false);
    const configBlock = report.blockingItems.find(b => b.check === "config_missing");
    assert.ok(configBlock, "应有 config_missing 阻断项");
    assert.ok(configBlock.fixInstruction.includes("config.json"));
    cleanupTestWorkspace();
  });

  it("缺角色档案阻断", () => {
    const { preflightWorkspace } = preflightMod;
    setupTestWorkspace({ withCharacters: false });
    const report = preflightWorkspace({
      workspacePath: testWorkspacePath,
      workspaceId: testWorkspaceId,
      chapterId: "1",
      chapterNumber: 1,
      skipSeedReadiness: true,
    });
    assert.equal(report.passed, false);
    // characters 目录存在但为空时 check=characters_empty；目录不存在时 check=characters_dir_missing
    const charBlock = report.blockingItems.find(b => b.check === "characters_empty" || b.check === "characters_dir_missing");
    assert.ok(charBlock, "应有 characters_empty 或 characters_dir_missing 阻断项");
    cleanupTestWorkspace();
  });

  it("第2章及以后缺前章 skeleton 阻断", () => {
    const { preflightWorkspace } = preflightMod;
    setupTestWorkspace({ chapterNumber: 2, withSkeleton: false });
    const report = preflightWorkspace({
      workspacePath: testWorkspacePath,
      workspaceId: testWorkspaceId,
      chapterId: "2",
      chapterNumber: 2,
      skipSeedReadiness: true,
    });
    assert.equal(report.passed, false);
    const skelBlock = report.blockingItems.find(b => b.check === "previous_skeleton_missing");
    assert.ok(skelBlock, "第2章缺前章 skeleton 应阻断");
    cleanupTestWorkspace();
  });

  it("第1章缺前章 skeleton 不阻断（无前章）", () => {
    const { preflightWorkspace } = preflightMod;
    setupTestWorkspace({ chapterNumber: 1, withSkeleton: false });
    const report = preflightWorkspace({
      workspacePath: testWorkspacePath,
      workspaceId: testWorkspaceId,
      chapterId: "1",
      chapterNumber: 1,
      skipSeedReadiness: true,
    });
    const skelBlock = report.blockingItems.find(b => b.check === "previous_skeleton_missing");
    assert.equal(skelBlock, undefined, "第1章不应因缺前章 skeleton 阻断");
    cleanupTestWorkspace();
  });

  it("缺 series/outline.md 不阻断（P22 约束）", () => {
    const { preflightWorkspace } = preflightMod;
    setupTestWorkspace({ withSkeleton: false });
    // 不创建 outline.md
    const report = preflightWorkspace({
      workspacePath: testWorkspacePath,
      workspaceId: testWorkspaceId,
      chapterId: "1",
      chapterNumber: 1,
      skipSeedReadiness: true,
    });
    const outlineBlock = report.blockingItems.find(b => b.check.includes("outline"));
    assert.equal(outlineBlock, undefined, "缺 outline.md 不应阻断");
    cleanupTestWorkspace();
  });

  it("config 缺 genre 字段阻断", () => {
    const { preflightWorkspace } = preflightMod;
    setupTestWorkspace({ configOverride: { genre: undefined } });
    const report = preflightWorkspace({
      workspacePath: testWorkspacePath,
      workspaceId: testWorkspaceId,
      chapterId: "1",
      chapterNumber: 1,
      skipSeedReadiness: true,
    });
    assert.equal(report.passed, false);
    // genre 缺失归入 config_fields_missing，reason 包含 genre
    const fieldsBlock = report.blockingItems.find(b => b.check === "config_fields_missing" && String(b.reason).includes("genre"));
    assert.ok(fieldsBlock, "缺 genre 应触发 config_fields_missing 阻断");
    cleanupTestWorkspace();
  });
});

describe("治理方案 Phase 1/3：quality-trace-recorder.recordFailureEnvelope", () => {
  before(async () => { await loadModules(); });

  it("recordFailureEnvelope 写入 failureEnvelopes 数组 + attemptHistory", () => {
    const { createQualityTraceRecorder } = traceRecorderMod;
    const { createFailureEnvelope } = failureEnvelopeMod;
    setupTestWorkspace();
    const recorder = createQualityTraceRecorder({
      workspacePath: join(repoRoot, "workspaces"),
      workspaceId: testWorkspaceId,
      chapterId: "1",
      appendExisting: false,
    });
    const env = createFailureEnvelope({
      stage: "2-narrator",
      gate: "event_level_rewrite_exhausted",
      severity: "hard_block",
      reason: "事件 e1 重写 2 次后仍 block",
      evidence: { eventId: "e1", attempts: 2 },
      retryPlan: { strategy: "rewrite_event", maxAttempts: 2 },
    });
    const attempts = [
      { attempt: 1, strategy: "rewrite_event", reason: "第一次重写", outcome: "failed", evidence: { failedNodes: "anti-ai" } },
      { attempt: 2, strategy: "rewrite_event", reason: "第二次重写", outcome: "failed", evidence: { failedNodes: "anti-ai" } },
    ];
    recorder.recordFailureEnvelope(env, attempts);
    const tracePath = recorder.flush();
    assert.ok(existsSync(tracePath), "trace 文件应被写入");
    const trace = JSON.parse(readFileSync(tracePath, "utf-8"));
    assert.ok(Array.isArray(trace.failureEnvelopes));
    assert.equal(trace.failureEnvelopes.length, 1);
    const record = trace.failureEnvelopes[0];
    assert.equal(record.stage, "2-narrator");
    assert.equal(record.gate, "event_level_rewrite_exhausted");
    assert.equal(record.severity, "hard_block");
    assert.ok(record.recordedAt, "应有 recordedAt 时间戳");
    assert.ok(Array.isArray(record.attemptHistory));
    assert.equal(record.attemptHistory.length, 2);
    assert.equal(record.attemptHistory[0].attempt, 1);
    assert.equal(record.attemptHistory[1].outcome, "failed");
    cleanupTestWorkspace();
  });

  it("多次 recordFailureEnvelope 累积写入（appendExisting）", () => {
    const { createQualityTraceRecorder } = traceRecorderMod;
    const { createFailureEnvelope } = failureEnvelopeMod;
    setupTestWorkspace();
    // 第一次写入
    const r1 = createQualityTraceRecorder({
      workspacePath: join(repoRoot, "workspaces"),
      workspaceId: testWorkspaceId,
      chapterId: "1",
      appendExisting: false,
    });
    r1.recordFailureEnvelope(createFailureEnvelope({
      stage: "0-preflight", gate: "config_missing", severity: "preflight", reason: "第一次",
    }));
    r1.flush();
    // 第二次追加写入
    const r2 = createQualityTraceRecorder({
      workspacePath: join(repoRoot, "workspaces"),
      workspaceId: testWorkspaceId,
      chapterId: "1",
      appendExisting: true,
    });
    r2.recordFailureEnvelope(createFailureEnvelope({
      stage: "8-final", gate: "style", severity: "hard_block", reason: "第二次",
    }));
    const tracePath = r2.flush();
    const trace = JSON.parse(readFileSync(tracePath, "utf-8"));
    assert.equal(trace.failureEnvelopes.length, 2, "appendExisting 应累积，不覆盖");
    assert.equal(trace.failureEnvelopes[0].gate, "config_missing");
    assert.equal(trace.failureEnvelopes[1].gate, "style");
    cleanupTestWorkspace();
  });
});
