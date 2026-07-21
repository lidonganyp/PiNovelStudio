/**
 * 审计修复专项负向测试（STATE-BRIDGE-TXN-FIX / AXIS-PARSE-FIX / ADVISORY-PATH-FIX /
 * REM-LIFECYCLE-FIX / ADVISORY-SOURCES-FIX）
 *
 * 对应 7 项审计阻断（3 P0 + 4 P1），每项提供至少一条专项负向回归：
 *
 * P0-1 事务边界：bridge/closure/progression 写入 -derived.json（不污染权威状态）
 * P0-2 五维推进：deriveActualAxes 解析"axis=有/无"，partial 报告不再误判为全 true
 * P0-3 路径穿越：handleChapterAdvisory 拒绝 workspaceId=".." / 含 "/" / 含特殊字符
 * P1-4 MCP schema：registerTools 暴露 3 个 advisory action + 参数（contract: 6 工具不变）
 * P1-5 advisory 消费链：methodology-diagnostic-sources 读取 3 个新源 + fallback 路径优先 derived
 * P1-6 ArcStatus 状态机：ClosureTracker 拒绝非法 "closing"；integrateClosureTracker 用 "climaxed"
 * P1-7 REM 生命周期：buildStagedStateUpdate 创建 expectation 时 status=open + overdueWindow +
 *     关联字段留空（不机械全关联）；不在此处推进 advanced/delayed/escalated/fulfilled
 *
 * 测试导入 dist/ 编译产物（与 b234-long-term-state-and-trace.test.mjs 一致）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { handleChapterAdvisory } from "../dist/handlers/chapter-advisory-handler.js";
import {
  deriveActualAxes,
  persistChapterProgressionContract,
} from "../dist/v2/core/chapter-progression-contract.js";
import { integrateClosureTracker } from "../dist/v2/core/closure-tracker-integration.js";
import { buildStagedStateUpdate } from "../dist/v2/core/unified-entry.js";
import { readJsonSource, SOURCES } from "../dist/v2/core/methodology-diagnostic-sources.js";
import { buildAdvisorySignals } from "../dist/v2/core/methodology-diagnostic-advisory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// 辅助：构造最小 ChapterSeed（与 staged-state-realm-transition.test.mjs 对齐）
// ============================================================================

function makeSeed(opts = {}) {
  const {
    chapterFunction = "setup",
    intentPrimary = "foreshadow",
    chapterTheme = "建立伏笔：水下暗流的真实形态",
    targetEmotions = ["紧张", "好奇"],
    chapterNumber = 5,
  } = opts;
  return {
    workspaceId: "audit-fix-test",
    chapterId: String(chapterNumber),
    chapterNumber,
    chapterFunction,
    worldConstraint: { genre: "灵异", subGenres: [], immutableFacts: [] },
    characters: [{ name: "林川", role: "protagonist", aliases: [] }],
    previousChapterContinuation: {
      available: true,
      openHooks: [],
      unresolvedTensions: [],
      introducedCharacters: [],
    },
    currentPressure: { pendingForeshadowing: [] },
    unsettledDetails: [],
    candidateAnchors: [],
    highLevelDirection: { available: false, backgroundNotes: [], immutableFacts: [] },
    intent: {
      primary: intentPrimary,
      secondary: [],
      keywords: [],
      chapterTheme,
      targetEmotions,
      _source: "chapterSeed",
    },
    builtAt: new Date().toISOString(),
  };
}

function makeTempWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "audit-fix-"));
  const workspaceId = "test-ws";
  const wsDir = join(dir, "workspaces", workspaceId);
  mkdirSync(join(wsDir, "series"), { recursive: true });
  return { dir, workspaceId, wsDir };
}

// ============================================================================
// P0-3：路径穿越 — handleChapterAdvisory 拒绝 unsafe workspaceId
// ============================================================================

test("P0-3: handleChapterAdvisory 拒绝 workspaceId='..' (路径穿越)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "traversal-test-"));
  try {
    // 即使 workspaces/.. 存在（指向 tmpdir 自身），也应被 validateWorkspaceId 拒绝
    const result = await handleChapterAdvisory({
      action: "diagnostic",
      workspaceId: "..",
      _projectRoot: dir,
    });
    assert.equal(result.status, "error", `应拒绝 ".."，实际 status=${result.status}`);
    assert.match(result.error ?? "", /Invalid workspaceId|Path traversal/i,
      `error 应说明拒绝原因，实际: ${result.error}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-3: handleChapterAdvisory 拒绝含 '/' 的 workspaceId", async () => {
  const dir = mkdtempSync(join(tmpdir(), "traversal-test-"));
  try {
    const result = await handleChapterAdvisory({
      action: "diagnostic",
      workspaceId: "foo/bar",
      _projectRoot: dir,
    });
    assert.equal(result.status, "error", `应拒绝 "foo/bar"（含 /），实际 status=${result.status}`);
    assert.match(result.error ?? "", /Invalid workspaceId/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-3: handleChapterAdvisory 拒绝含 '\\\\' 的 workspaceId", async () => {
  const dir = mkdtempSync(join(tmpdir(), "traversal-test-"));
  try {
    const result = await handleChapterAdvisory({
      action: "diagnostic",
      workspaceId: "foo\\\\..\\\\evil",
      _projectRoot: dir,
    });
    assert.equal(result.status, "error", `应拒绝含 \\ 的 workspaceId，实际 status=${result.status}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-3: handleChapterAdvisory 拒绝含特殊字符的 workspaceId", async () => {
  const dir = mkdtempSync(join(tmpdir(), "traversal-test-"));
  try {
    const result = await handleChapterAdvisory({
      action: "diagnostic",
      workspaceId: "ws;rm -rf",
      _projectRoot: dir,
    });
    assert.equal(result.status, "error", `应拒绝含特殊字符的 workspaceId，实际 status=${result.status}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-3: handleChapterAdvisory 接受合法 workspaceId 但报告不存在", async () => {
  const dir = mkdtempSync(join(tmpdir(), "traversal-test-"));
  try {
    const result = await handleChapterAdvisory({
      action: "diagnostic",
      workspaceId: "nonexistent-ws",
      _projectRoot: dir,
    });
    // 合法格式但 workspace 不存在 → status=error 但 error 文案不同于路径穿越
    assert.equal(result.status, "error");
    assert.match(result.error ?? "", /不存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-3: ingest_reader_feedback 同样拒绝路径穿越（不写入 series/reader-feedback.json）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "traversal-test-"));
  try {
    const result = await handleChapterAdvisory({
      action: "ingest_reader_feedback",
      workspaceId: "..",
      chapterId: "5",
      chapterNumber: 5,
      feedbackType: "positive",
      feedbackText: "测试反馈",
      sourceRef: "ch5#p1",
      _projectRoot: dir,
    });
    assert.equal(result.status, "error", "应拒绝路径穿越");
    // 关键负向断言：tmpdir 下不应出现 reader-feedback.json
    const evilPath = join(dir, "series", "reader-feedback.json");
    assert.equal(existsSync(evilPath), false,
      `路径穿越应被阻断，不应在 ${evilPath} 创建文件`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// P0-2：五维推进 — deriveActualAxes 解析 "axis=有/无" 而非 includes 轴名
// ============================================================================

test("P0-2: deriveActualAxes 解析 plot=有/info=无/... 只标记 =有 的轴", () => {
  const evidence = [{
    id: "structural:five_axis_progression:0",
    dimension: "five_axis_progression",
    status: "partial",
    sourceSpans: [{ start: 0, end: 10, excerpt: "示例" }],
    expectedRef: "five_axis_progression",
    observation: "五维扫描结果：plot=有/info=无/character=有/world=无/causal=有；有效轴数（非 plot）= 3/4",
    readerImpact: "advisory",
    severity: "info",
    confidence: 0.6,
    recommendedOwner: "judge",
    recommendedAction: "review",
  }];
  const axes = deriveActualAxes(evidence);
  assert.equal(axes.plot, true, "plot=有 → true");
  assert.equal(axes.info, false, "info=无 → false（不应误判为 true）");
  assert.equal(axes.character, true, "character=有 → true");
  assert.equal(axes.world, false, "world=无 → false");
  assert.equal(axes.causal, true, "causal=有 → true");
});

test("P0-2: deriveActualaxes 在 status=satisfied 时同样解析 axis=有/无", () => {
  const evidence = [{
    id: "structural:five_axis_progression:0",
    dimension: "five_axis_progression",
    status: "satisfied",
    sourceSpans: [{ start: 0, end: 5, excerpt: "示例" }],
    expectedRef: "five_axis_progression",
    observation: "plot=无/info=无/character=无/world=无/causal=无",
    readerImpact: "advisory",
    severity: "info",
    confidence: 0.6,
    recommendedOwner: "judge",
    recommendedAction: "review",
  }];
  const axes = deriveActualAxes(evidence);
  // 即使 status=satisfied，所有轴都 =无 时应全部 false（旧 includes 实现会误判为全 true）
  assert.equal(axes.plot, false, "plot=无 → false");
  assert.equal(axes.info, false);
  assert.equal(axes.character, false);
  assert.equal(axes.world, false);
  assert.equal(axes.causal, false);
});

test("P0-2: deriveActualAxes 跳过 status=not_applicable / human_review 的 evidence", () => {
  const evidence = [
    {
      id: "structural:five_axis_progression:0",
      dimension: "five_axis_progression",
      status: "not_applicable",
      sourceSpans: [],
      expectedRef: "",
      observation: "plot=有/info=有/character=有/world=有/causal=有",
      readerImpact: "",
      severity: "info",
      confidence: 0.6,
      recommendedOwner: "",
      recommendedAction: "",
    },
    {
      id: "structural:five_axis_progression:1",
      dimension: "five_axis_progression",
      status: "human_review",
      sourceSpans: [],
      expectedRef: "",
      observation: "plot=有/info=有/character=有/world=有/causal=有",
      readerImpact: "",
      severity: "info",
      confidence: 0.6,
      recommendedOwner: "",
      recommendedAction: "",
    },
  ];
  const axes = deriveActualAxes(evidence);
  // not_applicable / human_review 都不应被采纳
  assert.equal(axes.plot, false);
  assert.equal(axes.info, false);
  assert.equal(axes.character, false);
  assert.equal(axes.world, false);
  assert.equal(axes.causal, false);
});

test("P0-2: deriveActualAxes 兼容中文轴名（情节=有 / 信息=无 ...）", () => {
  const evidence = [{
    id: "structural:five_axis_progression:0",
    dimension: "five_axis_progression",
    status: "partial",
    sourceSpans: [{ start: 0, end: 5, excerpt: "示例" }],
    expectedRef: "five_axis_progression",
    observation: "情节=有/信息=无/角色=有/世界=无/因果=有",
    readerImpact: "",
    severity: "info",
    confidence: 0.6,
    recommendedOwner: "",
    recommendedAction: "",
  }];
  const axes = deriveActualAxes(evidence);
  assert.equal(axes.plot, true, "情节=有 → plot=true");
  assert.equal(axes.info, false, "信息=无 → info=false");
  assert.equal(axes.character, true, "角色=有 → character=true");
  assert.equal(axes.world, false, "世界=无 → world=false");
  assert.equal(axes.causal, true, "因果=有 → causal=true");
});

test("P0-2: deriveActualAxes 不因子串匹配误判（'informer' 不应触发 info 轴）", () => {
  const evidence = [{
    id: "structural:five_axis_progression:0",
    dimension: "five_axis_progression",
    status: "partial",
    sourceSpans: [{ start: 0, end: 5, excerpt: "示例" }],
    expectedRef: "five_axis_progression",
    // 包含 'informer' 但没有 info=有 → info 不应被标记为 true
    observation: "plot=有/informer 提到/info 字段缺失/world=无/causal=有",
    readerImpact: "",
    severity: "info",
    confidence: 0.6,
    recommendedOwner: "",
    recommendedAction: "",
  }];
  const axes = deriveActualAxes(evidence);
  assert.equal(axes.plot, true, "plot=有 → true");
  assert.equal(axes.info, false, "仅出现 'informer' 不应触发 info 轴（必须有 info=有 字面匹配）");
  assert.equal(axes.world, false);
  assert.equal(axes.causal, true);
});

// ============================================================================
// P0-1 + P1-6：事务边界 + ArcStatus 状态机
// integrateClosureTracker 写入 arc-registry-derived.json（不写 arc-registry.json）
// ============================================================================

test("P0-1: integrateClosureTracker 写入 arc-registry-derived.json，不写 arc-registry.json", () => {
  const { dir, workspaceId, wsDir } = makeTempWorkspace();
  try {
    // 预先创建 arc-registry-derived.json（最小 ClosureTracker schema）
    const derivedPath = join(wsDir, "series", "arc-registry-derived.json");
    const legacyPath = join(wsDir, "series", "arc-registry.json");
    writeFileSync(derivedPath, JSON.stringify({
      schemaVersion: 1,
      workspaceId,
      config: { currentChapter: 4, lastUpdated: new Date().toISOString() },
      arcs: [],
      pending_foreshadows: [],
      lastUpdated: new Date().toISOString(),
    }), "utf-8");

    const result = integrateClosureTracker(wsDir, { additions: [], invalidations: [], sourceChapter: "ch5" }, 5);
    assert.equal(result.ok, true, `应成功，实际 ok=${result.ok} error=${result.error}`);
    assert.equal(result.arcRegistryPath, derivedPath,
      `arcRegistryPath 应指向 -derived.json，实际: ${result.arcRegistryPath}`);

    // 关键负向断言：legacy arc-registry.json 不应被创建
    assert.equal(existsSync(legacyPath), false,
      "integrateClosureTracker 不应写入 arc-registry.json（受 STEP-3 守护）");
    // derived 路径仍存在（被覆盖更新）
    assert.equal(existsSync(derivedPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-1: integrateClosureTracker 在 -derived.json 缺失时跳过（不阻断、不写 legacy）", () => {
  const { dir, wsDir } = makeTempWorkspace();
  try {
    // 不创建 -derived.json，也不创建 legacy arc-registry.json
    const result = integrateClosureTracker(wsDir, { additions: [], invalidations: [], sourceChapter: "ch5" }, 5);
    assert.equal(result.ok, true, "缺失 derived 文件应跳过，不报错");
    assert.equal(result.arcUpdates.length, 0);
    assert.equal(result.recalledForeshadowIds.length, 0);
    assert.match(result.skippedReason ?? "", /not found|empty/i);

    // 不应自动创建任何 arc-registry 文件
    assert.equal(existsSync(join(wsDir, "series", "arc-registry.json")), false);
    assert.equal(existsSync(join(wsDir, "series", "arc-registry-derived.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-6: integrateClosureTracker 用合法 'climaxed' 状态推进 arc（不再用 'closing'）", () => {
  const { dir, workspaceId, wsDir } = makeTempWorkspace();
  try {
    const derivedPath = join(wsDir, "series", "arc-registry-derived.json");
    // 注意：Arc 字段为 snake_case（arc_id / arc_type / core_question / chapter_opened /
    // expected_closure_window），优先级为 P0-P4，类型为 primary/secondary/relational/world/debt
    writeFileSync(derivedPath, JSON.stringify({
      arcs: [{
        arc_id: "arc:dark-current",
        name: "暗流真相",
        arc_type: "secondary",
        priority: "P1",
        status: "in_progress", // 合法状态机：in_progress → climaxed
        core_question: "暗流是什么？",
        chapter_opened: 1,
        chapter_climaxed: null,
        chapter_closed: null,
        expected_closure_window: { earliest: 5, optimal: 8, latest: 12 },
        closure_trigger: "explicit",
        milestones: [],
        dependencies: [],
        external_refs: [],
        emotional_payload: { primary: "紧张", secondary: [] },
        metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      }],
      pending_foreshadows: [],
      config: { totalChapters: 20, currentChapter: 4, closureType: "hard" },
      lastUpdated: new Date().toISOString(),
    }), "utf-8");

    const staged = {
      additions: [{
        kind: "expectation",
        id: "expectation:ch5:reveal",
        sourceChapter: "ch5",
        sourceRef: "ch5#finalText:abc123:0-10", // 非 seed:*，触发推进
        confidence: 0.8,
        lastUpdated: new Date().toISOString(),
        expectationId: "expectation:ch5:reveal",
        description: "揭示暗流真相",
        expectationType: "reveal",
        status: "fulfilled", // 触发 arc 推进
        createdChapter: "ch5",
        lastAdvancedChapter: "ch5",
        lastFulfilledChapter: "ch5",
        overdueWindow: null,
        relatedArcIds: ["arc:dark-current"],
        relatedCharacterIds: [],
        relatedForeshadowIds: [],
      }],
      invalidations: [],
      sourceChapter: "ch5",
    };

    const result = integrateClosureTracker(wsDir, staged, 5);
    assert.equal(result.ok, true, `应成功，error=${result.error}`);
    // arcUpdates 应非空（之前用 "closing" as never 时 arcUpdates 总是空，
    // 因为 isLegalTransition 会拒绝 closing 这个不存在的状态）
    assert.equal(result.arcUpdates.length, 1, `应有 1 条 arcUpdate，实际: ${result.arcUpdates.length}`);
    assert.equal(result.arcUpdates[0].arcId, "arc:dark-current");
    assert.equal(result.arcUpdates[0].newStatus, "climaxed",
      `newStatus 应为 climaxed（合法状态机），实际: ${result.arcUpdates[0].newStatus}`);

    // 验证落盘后的 arc 状态确实是 climaxed（而非 closing 或不变）
    const saved = JSON.parse(readFileSync(derivedPath, "utf-8"));
    const arc = saved.arcs.find((a) => a.arc_id === "arc:dark-current");
    assert.equal(arc.status, "climaxed", `落盘后 arc.status 应为 climaxed，实际: ${arc.status}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-6: integrateClosureTracker 不从 'opened' 跳到 'climaxed'（状态机约束：opened→in_progress only）", () => {
  // LEGAL_TRANSITIONS: opened → in_progress（唯一合法流转，不能越级到 climaxed）
  // 此测试守护：integration 不会把 opened 状态的 arc 推进到 climaxed
  const { dir, workspaceId, wsDir } = makeTempWorkspace();
  try {
    const derivedPath = join(wsDir, "series", "arc-registry-derived.json");
    writeFileSync(derivedPath, JSON.stringify({
      arcs: [{
        arc_id: "arc:opened-only",
        name: "刚开的弧",
        arc_type: "secondary",
        priority: "P2",
        status: "opened", // 合法但只能推进到 in_progress，不能到 climaxed
        core_question: "?",
        chapter_opened: 5,
        chapter_climaxed: null,
        chapter_closed: null,
        expected_closure_window: { earliest: 8, optimal: 10, latest: 12 },
        closure_trigger: "explicit",
        milestones: [],
        dependencies: [],
        external_refs: [],
        emotional_payload: { primary: "好奇", secondary: [] },
        metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      }],
      pending_foreshadows: [],
      config: { totalChapters: 20, currentChapter: 4, closureType: "hard" },
      lastUpdated: new Date().toISOString(),
    }), "utf-8");

    // 模拟一个 fulfilled expectation 关联到刚 opened 的 arc
    // 期望 integrateClosureTracker 不会把它越级推到 climaxed（因为 opened→climaxed 非法）
    const staged = {
      additions: [{
        kind: "expectation",
        id: "expectation:ch5:fulfilled",
        sourceChapter: "ch5",
        sourceRef: "ch5#finalText:abc:0-5",
        confidence: 0.8,
        lastUpdated: new Date().toISOString(),
        expectationId: "expectation:ch5:fulfilled",
        description: "兑现",
        expectationType: "reveal",
        status: "fulfilled",
        createdChapter: "ch5",
        lastAdvancedChapter: "ch5",
        lastFulfilledChapter: "ch5",
        overdueWindow: null,
        relatedArcIds: ["arc:opened-only"],
        relatedCharacterIds: [],
        relatedForeshadowIds: [],
      }],
      invalidations: [],
      sourceChapter: "ch5",
    };

    const result = integrateClosureTracker(wsDir, staged, 5);
    assert.equal(result.ok, true);
    // opened→climaxed 非法，arcUpdates 应为 0
    assert.equal(result.arcUpdates.length, 0,
      `opened→climaxed 应被状态机拒绝，arcUpdates 应为 0，实际: ${result.arcUpdates.length}`);
    // 不应出现 resolved/abandoned/closing 等越级状态
    for (const update of result.arcUpdates) {
      assert.notEqual(update.newStatus, "resolved", "不应越级到 resolved");
      assert.notEqual(update.newStatus, "abandoned", "不应越级到 abandoned");
      assert.notEqual(update.newStatus, "closing", "不应使用非法 closing 状态");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// P1-7：REM 生命周期 — buildStagedStateUpdate 创建 expectation 时 seed-only
// ============================================================================

test("P1-7: buildStagedStateUpdate 在 setup+foreshadow 章创建 expectation（status=open + overdueWindow）", () => {
  const seed = makeSeed({
    chapterFunction: "setup",
    intentPrimary: "foreshadow",
    chapterTheme: "建立伏笔：暗流真相",
    chapterNumber: 5,
  });
  const staged = buildStagedStateUpdate(seed, 5);
  const expectations = staged.additions.filter((e) => e.kind === "expectation");
  assert.equal(expectations.length, 1, `应创建恰好 1 条 expectation，实际: ${expectations.length}`);

  const exp = expectations[0];
  assert.equal(exp.status, "open", "seed-only 阶段只创建，status=open");
  assert.ok(exp.overdueWindow, "应有 overdueWindow（章节号窗口）");
  assert.ok(typeof exp.overdueWindow.earliest === "number");
  assert.ok(typeof exp.overdueWindow.optimal === "number");
  assert.ok(typeof exp.overdueWindow.latest === "number");
  // setup 章：最早 3 章后，最佳 5 章后，最晚 8 章后
  assert.equal(exp.overdueWindow.earliest, 8, `setup 章 earliest 应为 5+3=8，实际: ${exp.overdueWindow.earliest}`);
  assert.equal(exp.overdueWindow.optimal, 10, `setup 章 optimal 应为 5+5=10，实际: ${exp.overdueWindow.optimal}`);
  assert.equal(exp.overdueWindow.latest, 13, `setup 章 latest 应为 5+8=13，实际: ${exp.overdueWindow.latest}`);
});

test("P1-7: buildStagedStateUpdate foreshadow 章用 foreshadow 窗口（2/4/7）", () => {
  const seed = makeSeed({
    chapterFunction: "escalation", // 非 setup
    intentPrimary: "foreshadow",
    chapterTheme: "埋设关键伏笔",
    chapterNumber: 10,
  });
  const staged = buildStagedStateUpdate(seed, 10);
  const exp = staged.additions.find((e) => e.kind === "expectation");
  assert.ok(exp, "应创建 expectation");
  // foreshadow 章：最早 2 章后，最佳 4 章后，最晚 7 章后
  assert.equal(exp.overdueWindow.earliest, 12, `foreshadow earliest=10+2=12，实际: ${exp.overdueWindow.earliest}`);
  assert.equal(exp.overdueWindow.optimal, 14, `foreshadow optimal=10+4=14，实际: ${exp.overdueWindow.optimal}`);
  assert.equal(exp.overdueWindow.latest, 17, `foreshadow latest=10+7=17，实际: ${exp.overdueWindow.latest}`);
});

test("P1-7: expectation 关联字段留空（不机械全关联）", () => {
  const seed = makeSeed({
    chapterFunction: "setup",
    intentPrimary: "foreshadow",
    chapterTheme: "建立伏笔",
    chapterNumber: 5,
  });
  // seed 中有 character 林川 + 设想中的 openArcs（虽然 seed.currentPressure.pendingForeshadowing
  // 为空，但即便有，也不应机械关联到 expectation）
  const staged = buildStagedStateUpdate(seed, 5);
  const exp = staged.additions.find((e) => e.kind === "expectation");
  assert.ok(exp);

  // 关键负向断言：relatedArcIds / relatedCharacterIds / relatedForeshadowIds 都不应被机械填充
  // （应留 undefined 或空数组，由 FinalStateCommit.reanchor 或后续 LLM 诊断决定关联）
  const related = (exp.relatedArcIds ?? []).length
    + (exp.relatedCharacterIds ?? []).length
    + (exp.relatedForeshadowIds ?? []).length;
  assert.equal(related, 0,
    `关联字段应留空（不机械全关联），实际 relatedArcIds=${JSON.stringify(exp.relatedArcIds)} ` +
    `relatedCharacterIds=${JSON.stringify(exp.relatedCharacterIds)} ` +
    `relatedForeshadowIds=${JSON.stringify(exp.relatedForeshadowIds)}`);
});

test("P1-7: 无 chapterTheme 时不创建 expectation（保守策略）", () => {
  const seed = makeSeed({
    chapterFunction: "setup",
    intentPrimary: "foreshadow",
    chapterTheme: "", // 空 theme
    chapterNumber: 5,
  });
  const staged = buildStagedStateUpdate(seed, 5);
  const expectations = staged.additions.filter((e) => e.kind === "expectation");
  assert.equal(expectations.length, 0, "无 chapterTheme 不应创建 expectation");
});

test("P1-7: buildStagedStateUpdate 不创建 advanced/delayed/escalated/fulfilled 状态的 expectation", () => {
  // seed-only 阶段只建立 expectation（status=open），不在此处推进生命周期
  // 推进由 FinalStateCommit.reanchor 或 LLM 诊断/手动 feedback 负责
  const seed = makeSeed({
    chapterFunction: "setup",
    intentPrimary: "foreshadow",
    chapterTheme: "建立伏笔",
    chapterNumber: 5,
  });
  const staged = buildStagedStateUpdate(seed, 5);
  for (const e of staged.additions) {
    if (e.kind !== "expectation") continue;
    assert.equal(e.status, "open",
      `seed-only 阶段 expectation.status 必须为 open，实际: ${e.status}（不应为 advanced/delayed/escalated/fulfilled）`);
  }
});

// ============================================================================
// P1-5：advisory 消费链 — readJsonSource fallback + buildAdvisorySignals
// ============================================================================

test("P1-5: SOURCES 包含 3 个新 advisory 源 ID", () => {
  const sourceIds = SOURCES.map((s) => s.sourceId);
  assert.ok(sourceIds.includes("reader_feedback"), "应有 reader_feedback 源");
  assert.ok(sourceIds.includes("return_chapter_provenance"), "应有 return_chapter_provenance 源");
  assert.ok(sourceIds.includes("chapter_progression_contracts"), "应有 chapter_progression_contracts 源");
  // 总源数：6 旧 + 3 新 = 9
  assert.equal(sourceIds.length, 9, `SOURCES 应有 9 个源，实际: ${sourceIds.length}`);
});

test("P0-1 + P1-5: arc_registry 源优先读 -derived.json，fallback 到 legacy", () => {
  const { dir, wsDir } = makeTempWorkspace();
  try {
    const derivedPath = join(wsDir, "series", "arc-registry-derived.json");
    const legacyPath = join(wsDir, "series", "arc-registry.json");

    // Case 1: 只有 derived → 读 derived
    writeFileSync(derivedPath, JSON.stringify({ derived: true, arcs: [] }), "utf-8");
    const descriptor = SOURCES.find((s) => s.sourceId === "arc_registry");
    let result = readJsonSource(wsDir, descriptor);
    assert.equal(result.source.status, "available");
    assert.equal(result.value?.derived, true, "应读到 derived 文件内容");

    // Case 2: 同时有 derived + legacy → 仍读 derived（优先）
    writeFileSync(legacyPath, JSON.stringify({ legacy: true, arcs: [] }), "utf-8");
    result = readJsonSource(wsDir, descriptor);
    assert.equal(result.value?.derived, true, "derived 存在时应优先读 derived，不读 legacy");
    assert.equal(result.value?.legacy, undefined, "不应混入 legacy 内容");

    // Case 3: 只有 legacy（删 derived）→ fallback 读 legacy
    rmSync(derivedPath, { force: true });
    result = readJsonSource(wsDir, descriptor);
    assert.equal(result.source.status, "available");
    assert.equal(result.value?.legacy, true, "无 derived 时应 fallback 到 legacy");

    // Case 4: 都没有 → missing
    rmSync(legacyPath, { force: true });
    result = readJsonSource(wsDir, descriptor);
    assert.equal(result.source.status, "missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-5: buildAdvisorySignals 在所有源缺失时返回 unavailable", () => {
  // 用三个 missing 源构造
  const missing = {
    source: {
      sourceId: "test",
      relativePath: "test.json",
      sourceRef: "test.json",
      status: "missing",
      reason: "file_not_found",
    },
    value: null,
  };
  const result = buildAdvisorySignals(missing, missing, missing, 5, 12);
  assert.equal(result.status, "unavailable", "所有源缺失时整体应 unavailable");
  assert.equal(result.readerFeedback.status, "unavailable");
  assert.equal(result.returnChapter.status, "unavailable");
  assert.equal(result.progressionContract.status, "unavailable");
  assert.equal(result.emptyReason, "all_advisory_sources_missing");
});

test("P1-5: buildAdvisorySignals 消费 reader-feedback.json 并计算 sentimentTrend", () => {
  const { dir, wsDir } = makeTempWorkspace();
  try {
    const feedbackPath = join(wsDir, "series", "reader-feedback.json");
    writeFileSync(feedbackPath, JSON.stringify({
      schemaVersion: 1,
      workspaceId: "test-ws",
      lastUpdated: new Date().toISOString(),
      feedbacks: [
        { id: "f1", chapterId: "1", chapterNumber: 1, feedbackType: "positive", feedbackText: "好", sourceRef: "ch1#p1" },
        { id: "f2", chapterId: "2", chapterNumber: 2, feedbackType: "positive", feedbackText: "好", sourceRef: "ch2#p1" },
        { id: "f3", chapterId: "3", chapterNumber: 3, feedbackType: "positive", feedbackText: "好", sourceRef: "ch3#p1" },
        { id: "f4", chapterId: "4", chapterNumber: 4, feedbackType: "negative", feedbackText: "差", sourceRef: "ch4#p1" },
      ],
    }), "utf-8");

    const descriptor = SOURCES.find((s) => s.sourceId === "reader_feedback");
    const source = readJsonSource(wsDir, descriptor);
    const missing = { source: { ...source.source, status: "missing", reason: "x" }, value: null };

    const result = buildAdvisorySignals(source, missing, missing, 5, 12);
    assert.equal(result.status, "available");
    assert.equal(result.readerFeedback.status, "available");
    assert.equal(result.readerFeedback.totalCount, 4);
    // 4 条中 3 positive → trend=positive
    assert.equal(result.readerFeedback.sentimentTrend, "positive",
      `3 positive / 1 negative 应得 positive trend，实际: ${result.readerFeedback.sentimentTrend}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-5: buildAdvisorySignals 检测 chronic gap（连续 >=2 章 expected=true 但 actual=false）", () => {
  const { dir, wsDir } = makeTempWorkspace();
  try {
    const contractsPath = join(wsDir, "series", "chapter-progression-contracts.json");
    writeFileSync(contractsPath, JSON.stringify({
      schemaVersion: 1,
      workspaceId: "test-ws",
      lastUpdated: new Date().toISOString(),
      contracts: [
        // ch3: expected info, actual info=false → gap
        { chapterNumber: 3, expectedAxes: { plot: true, info: true, character: false, world: false, causal: false }, actualAxes: { plot: true, info: false, character: false, world: false, causal: false }, reviewSignals: [] },
        // ch4: expected info, actual info=false → 连续第 2 次 gap
        { chapterNumber: 4, expectedAxes: { plot: true, info: true, character: false, world: false, causal: false }, actualAxes: { plot: true, info: false, character: false, world: false, causal: false }, reviewSignals: [] },
      ],
    }), "utf-8");

    const descriptor = SOURCES.find((s) => s.sourceId === "chapter_progression_contracts");
    const source = readJsonSource(wsDir, descriptor);
    const missing = { source: { ...source.source, status: "missing", reason: "x" }, value: null };

    const result = buildAdvisorySignals(missing, missing, source, 5, 12);
    assert.equal(result.progressionContract.status, "available");
    assert.ok(
      result.progressionContract.chronicGapAxes.includes("info"),
      `info 连续 2 章 gap 应被标记为 chronic，实际 chronicGapAxes: ${JSON.stringify(result.progressionContract.chronicGapAxes)}`,
    );
    // plot 没连续 gap（actual=true），不应在 chronicGapAxes
    assert.equal(result.progressionContract.chronicGapAxes.includes("plot"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-5: buildAdvisorySignals 不将单次 gap 误判为 chronic（threshold=2）", () => {
  const { dir, wsDir } = makeTempWorkspace();
  try {
    const contractsPath = join(wsDir, "series", "chapter-progression-contracts.json");
    writeFileSync(contractsPath, JSON.stringify({
      schemaVersion: 1,
      workspaceId: "test-ws",
      lastUpdated: new Date().toISOString(),
      contracts: [
        // ch3: expected info, actual=true → 无 gap
        { chapterNumber: 3, expectedAxes: { plot: true, info: true, character: false, world: false, causal: false }, actualAxes: { plot: true, info: true, character: false, world: false, causal: false }, reviewSignals: [] },
        // ch4: expected info, actual=false → 单次 gap（不达 threshold=2）
        { chapterNumber: 4, expectedAxes: { plot: true, info: true, character: false, world: false, causal: false }, actualAxes: { plot: true, info: false, character: false, world: false, causal: false }, reviewSignals: [] },
      ],
    }), "utf-8");

    const descriptor = SOURCES.find((s) => s.sourceId === "chapter_progression_contracts");
    const source = readJsonSource(wsDir, descriptor);
    const missing = { source: { ...source.source, status: "missing", reason: "x" }, value: null };

    const result = buildAdvisorySignals(missing, missing, source, 5, 12);
    assert.equal(
      result.progressionContract.chronicGapAxes.includes("info"),
      false,
      `单次 gap 不应被标记为 chronic（threshold=2），实际 chronicGapAxes: ${JSON.stringify(result.progressionContract.chronicGapAxes)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// P1-4：MCP schema — registerTools 暴露 3 个 advisory action + 6 工具契约不变
// ============================================================================

test("P1-4: registerTools 在 novel_workspace_manager 暴露 3 个 advisory action + 参数", async () => {
  const mod = await import(pathToFileURL(join(__dirname, "..", "dist", "tools", "register-tools.js")).href);
  const registerTools = mod.registerTools;
  const stubHandlers = new Proxy({}, { get: () => async () => ({}) });
  const tools = registerTools(stubHandlers);
  const wsManager = tools.find((t) => t.name === "novel_workspace_manager");
  assert.ok(wsManager, "应注册 novel_workspace_manager");

  // ToolDefinition 在编译后字段名为 parameters（不是 inputSchema）
  const actionProp = wsManager.parameters.properties.action;
  assert.ok(Array.isArray(actionProp.enum), "action 应有 enum");
  for (const expected of ["diagnostic", "ingest_reader_feedback", "record_return_chapter"]) {
    assert.ok(
      actionProp.enum.includes(expected),
      `action enum 应包含 ${expected}，实际: ${JSON.stringify(actionProp.enum)}`,
    );
  }

  const props = wsManager.parameters.properties;
  // ingest_reader_feedback 参数
  assert.ok(props.feedbackType, "应有 feedbackType 参数");
  assert.ok(Array.isArray(props.feedbackType.enum) && props.feedbackType.enum.includes("positive"));
  assert.ok(props.feedbackText, "应有 feedbackText 参数");
  assert.ok(props.sourceRef, "应有 sourceRef 参数");
  assert.ok(props.focusDimensions, "应有 focusDimensions 参数");
  // record_return_chapter 参数
  assert.ok(props.returnType, "应有 returnType 参数");
  assert.ok(Array.isArray(props.returnType.enum) && props.returnType.enum.includes("rewrite"));
  assert.ok(props.sourceChapterIds, "应有 sourceChapterIds 参数");
  assert.ok(props.reason, "应有 reason 参数");
});

test("P1-4: registerTools 仍返回恰好 6 个公开工具（advisory action 不破契约）", async () => {
  const mod = await import(pathToFileURL(join(__dirname, "..", "dist", "tools", "register-tools.js")).href);
  const registerTools = mod.registerTools;
  const stubHandlers = new Proxy({}, { get: () => async () => ({}) });
  const tools = registerTools(stubHandlers);
  assert.equal(tools.length, 6, `应返回恰好 6 个工具，实际: ${tools.length}（${tools.map((t) => t.name).join(", ")}）`);
});

// ============================================================================
// P0-1: persistChapterProgressionContract 原子写入 chapter-progression-contracts.json
// （不在 FinalStateCommit 事务内的 advisory 派生缓存，失败不阻断主链路）
// ============================================================================

test("P0-1: persistChapterProgressionContract 写入 series/chapter-progression-contracts.json（advisory cache）", () => {
  const { dir, wsDir, workspaceId } = makeTempWorkspace();
  try {
    const seed = makeSeed({ chapterNumber: 5 });
    const staged = buildStagedStateUpdate(seed, 5);
    const result = persistChapterProgressionContract(
      wsDir,
      workspaceId,
      5,
      "5",
      seed.intent,
      [], // 无 structural evidence → actualAxes 全 false
      staged,
      "fakehash123",
    );
    assert.ok(result.ok, `应成功，error=${result.error}`);
    assert.ok(result.contract, "应返回 contract");
    const contractsPath = join(wsDir, "series", "chapter-progression-contracts.json");
    assert.ok(existsSync(contractsPath), "应创建 chapter-progression-contracts.json");
    const store = JSON.parse(readFileSync(contractsPath, "utf-8"));
    assert.equal(store.contracts.length, 1);
    assert.equal(store.contracts[0].chapterNumber, 5);
    assert.equal(store.contracts[0].finalTextHash, "fakehash123");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-1: persistChapterProgressionContract 失败不抛异常（返回 ok=false）", () => {
  // 用一个文件（非目录）作为 workspacePath：mkdirSync(workspacePath/series) 会失败
  // 因为 workspacePath 本身是文件，无法在其下创建子目录
  const { dir } = makeTempWorkspace();
  try {
    const fileAsWorkspace = join(dir, "i-am-a-file-not-a-dir");
    writeFileSync(fileAsWorkspace, "not a directory", "utf-8");
    const seed = makeSeed({ chapterNumber: 5 });
    const staged = buildStagedStateUpdate(seed, 5);
    const result = persistChapterProgressionContract(
      fileAsWorkspace,
      "test-ws",
      5,
      "5",
      seed.intent,
      [],
      staged,
      "fakehash123",
    );
    // 关键：失败时返回 ok=false 而非抛异常（advisory cache 不阻断主链路）
    assert.equal(result.ok, false, "失败应返回 ok=false，不抛异常");
    assert.ok(result.error, "应有 error 描述");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
