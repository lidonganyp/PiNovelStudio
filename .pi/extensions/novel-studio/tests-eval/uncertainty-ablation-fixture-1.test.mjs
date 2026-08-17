/**
 * UNCERTAINTY-ABLATION-FIXTURE-1：高风险 case workspace fixture 正向召回测试
 *
 * Step 2 of 4: 验证高风险 case 的 workspaceFixture 能被 NarrativeSearchService
 * 正向检索命中 confirmed 证据，避免所有检索返回 no-match。
 *
 * 测试层次：
 * 1. r2.json fixture 数据完整性（high case 必须有 workspaceFixture，authorMustInclude 3 项
 *    都有对应的 canon/character 关键短语）
 * 2. setupAblationWorkspace 函数存在并创建临时 workspace 目录
 * 3. NarrativeSearchService 直接读取 fixture workspace，searchRanked 命中 confirmed_state
 * 4. cleanupAblationWorkspace 清理临时目录
 *
 * RED 阶段：测试 2-4 失败（setupAblationWorkspace / cleanupAblationWorkspace 未实现）
 * GREEN 阶段：实现 uncertainty-fixture-workspace.ts 后全部通过
 *
 * 授权边界：
 * - 本测试不调用真实模型 API
 * - 直接用 NarrativeSearchService（已存在的类）+ 临时 workspace 验证 fixture 数据可被检索
 * - 不依赖 runUnifiedPipeline，避免引入 agentic loop 噪声
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
const FIXTURE_MODULE_PATH = join(
  EXTENSION_ROOT,
  "dist-eval",
  "novelos",
  "eval",
  "uncertainty-fixture-workspace.js",
);
const SEARCH_SERVICE_MODULE_PATH = join(
  EXTENSION_ROOT,
  "dist-eval",
  "novelos",
  "agent",
  "narrative-search-service.js",
);
const R2_CASES_PATH = join(
  EXTENSION_ROOT,
  "..",
  "..",
  "..",
  "scripts",
  "novelbench",
  "uncertainty-ablation-cases-r2.json",
);

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：动态 import 模块
// ─────────────────────────────────────────────────────────────────────────────

async function importFixtureModule() {
  return import(`file://${FIXTURE_MODULE_PATH}`);
}

async function importSearchService() {
  return import(`file://${SEARCH_SERVICE_MODULE_PATH}`);
}

function loadR2Cases() {
  const content = readFileSync(R2_CASES_PATH, "utf-8");
  return JSON.parse(content);
}

function findCase(cases, caseId) {
  const c = cases.find((x) => x.caseId === caseId);
  if (!c) throw new Error(`case ${caseId} not found in r2.json`);
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试 1：r2.json fixture 数据完整性
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-ABLATION-FIXTURE-1：r2.json fixture 数据完整性", () => {
  it("high-xuanhuan-1 有 workspaceFixture 字段", () => {
    const cases = loadR2Cases();
    const c = findCase(cases.cases, "high-xuanhuan-1");
    assert.ok(c.workspaceFixture, "high-xuanhuan-1 应有 workspaceFixture");
    assert.ok(Array.isArray(c.workspaceFixture.historicalChapters));
    assert.ok(c.workspaceFixture.historicalChapters.length > 0);
  });

  it("high-suspense-1 有 workspaceFixture 字段", () => {
    const cases = loadR2Cases();
    const c = findCase(cases.cases, "high-suspense-1");
    assert.ok(c.workspaceFixture, "high-suspense-1 应有 workspaceFixture");
    assert.ok(Array.isArray(c.workspaceFixture.historicalChapters));
    assert.ok(c.workspaceFixture.historicalChapters.length > 0);
  });

  it("high-xuanhuan-1 fixture 含 3 个 authorMustInclude 的关键短语", () => {
    const cases = loadR2Cases();
    const c = findCase(cases.cases, "high-xuanhuan-1");
    const fixture = c.workspaceFixture;
    // 3 个 authorMustInclude 都应在 canonEvents 或 characterStates 中有对应关键短语
    const allFacts = fixture.canonEvents.map((e) => e.fact);
    const allValues = fixture.characterStates.map((e) => e.value);
    const allPhrases = [...allFacts, ...allValues];
    for (const item of c.authorMustInclude) {
      // mustVerify 项必须包含某个 fixture 关键短语（作为 query 时 query.includes(phrase) 命中）
      const matched = allPhrases.some((p) => item.includes(p));
      assert.ok(
        matched,
        `authorMustInclude "${item}" 应在 fixture 中找到对应关键短语（canon.fact 或 character.value）`,
      );
    }
  });

  it("high-suspense-1 fixture 含 3 个 authorMustInclude 的关键短语", () => {
    const cases = loadR2Cases();
    const c = findCase(cases.cases, "high-suspense-1");
    const fixture = c.workspaceFixture;
    const allFacts = fixture.canonEvents.map((e) => e.fact);
    const allValues = fixture.characterStates.map((e) => e.value);
    const allPhrases = [...allFacts, ...allValues];
    for (const item of c.authorMustInclude) {
      const matched = allPhrases.some((p) => item.includes(p));
      assert.ok(
        matched,
        `authorMustInclude "${item}" 应在 fixture 中找到对应关键短语`,
      );
    }
  });

  it("high-xuanhuan-1 historicalChapters 含林默/噬魂印/云岚/血玉关键词", () => {
    const cases = loadR2Cases();
    const c = findCase(cases.cases, "high-xuanhuan-1");
    const text = c.workspaceFixture.historicalChapters[0].text;
    assert.ok(text.includes("林默"), "fixture chapter text 应含林默");
    assert.ok(text.includes("噬魂印"), "fixture chapter text 应含噬魂印");
    assert.ok(text.includes("云岚"), "fixture chapter text 应含云岚");
    assert.ok(text.includes("血玉"), "fixture chapter text 应含血玉");
  });

  it("high-suspense-1 historicalChapters 含陈警官/苏明/张医生关键词", () => {
    const cases = loadR2Cases();
    const c = findCase(cases.cases, "high-suspense-1");
    const text = c.workspaceFixture.historicalChapters[0].text;
    assert.ok(text.includes("陈警官"), "fixture chapter text 应含陈警官");
    assert.ok(text.includes("苏明"), "fixture chapter text 应含苏明");
    assert.ok(text.includes("张医生"), "fixture chapter text 应含张医生");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 2：setupAblationWorkspace 函数存在
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-ABLATION-FIXTURE-1：setupAblationWorkspace 函数导出", () => {
  it("模块文件存在且可导入", async () => {
    const mod = await importFixtureModule();
    assert.ok(mod, "uncertainty-fixture-workspace 模块应可导入");
  });

  it("导出 setupAblationWorkspace / cleanupAblationWorkspace 函数", async () => {
    const mod = await importFixtureModule();
    assert.equal(typeof mod.setupAblationWorkspace, "function");
    assert.equal(typeof mod.cleanupAblationWorkspace, "function");
  });

  it("导出 AblationWorkspaceFixture 类型守卫（isAblationWorkspaceFixture）", async () => {
    const mod = await importFixtureModule();
    // 类型守卫可选，但如果导出了应为函数
    if (mod.isAblationWorkspaceFixture !== undefined) {
      assert.equal(typeof mod.isAblationWorkspaceFixture, "function");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 3：setupAblationWorkspace 创建临时 workspace 目录
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-ABLATION-FIXTURE-1：setupAblationWorkspace 创建临时目录", () => {
  let tempProjectRoot;

  beforeEach(() => {
    tempProjectRoot = mkdtempSync(join(tmpdir(), "ablation-fixture-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tempProjectRoot, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  });

  it("setupAblationWorkspace 返回 { projectRoot, workspaceId }", async () => {
    const mod = await importFixtureModule();
    const cases = loadR2Cases();
    const c = findCase(cases.cases, "high-xuanhuan-1");
    const result = mod.setupAblationWorkspace({
      caseData: c,
      arm: "A",
      parentProjectRoot: tempProjectRoot,
    });
    assert.ok(result.projectRoot, "应返回 projectRoot");
    assert.ok(result.workspaceId, "应返回 workspaceId");
    assert.notEqual(result.projectRoot, tempProjectRoot, "projectRoot 应为新建子目录");
  });

  it("创建 workspaces/{workspaceId}/chapters/chapter-N/final.md", async () => {
    const mod = await importFixtureModule();
    const cases = loadR2Cases();
    const c = findCase(cases.cases, "high-xuanhuan-1");
    const { projectRoot, workspaceId } = mod.setupAblationWorkspace({
      caseData: c,
      arm: "A",
      parentProjectRoot: tempProjectRoot,
    });
    const chapterPath = join(
      projectRoot,
      "workspaces",
      workspaceId,
      "chapters",
      "chapter-6",
      "final.md",
    );
    assert.ok(existsSync(chapterPath), `应创建 ${chapterPath}`);
    const text = readFileSync(chapterPath, "utf-8");
    assert.ok(text.includes("林默"), "chapter-6/final.md 应含林默");
  });

  it("创建 workspaces/{workspaceId}/narrative-state-store.json 含 canon", async () => {
    const mod = await importFixtureModule();
    const cases = loadR2Cases();
    const c = findCase(cases.cases, "high-xuanhuan-1");
    const { projectRoot, workspaceId } = mod.setupAblationWorkspace({
      caseData: c,
      arm: "A",
      parentProjectRoot: tempProjectRoot,
    });
    const storePath = join(projectRoot, "workspaces", workspaceId, "narrative-state-store.json");
    assert.ok(existsSync(storePath), "应创建 narrative-state-store.json");
    const store = JSON.parse(readFileSync(storePath, "utf-8"));
    assert.ok(Array.isArray(store.canon), "state store 应有 canon 数组");
    assert.ok(store.canon.length > 0, "canon 应非空");
  });

  it("创建 workspaces/{workspaceId}/narrative-state-store.json 含 character", async () => {
    const mod = await importFixtureModule();
    const cases = loadR2Cases();
    const c = findCase(cases.cases, "high-xuanhuan-1");
    const { projectRoot, workspaceId } = mod.setupAblationWorkspace({
      caseData: c,
      arm: "A",
      parentProjectRoot: tempProjectRoot,
    });
    const storePath = join(projectRoot, "workspaces", workspaceId, "narrative-state-store.json");
    const store = JSON.parse(readFileSync(storePath, "utf-8"));
    assert.ok(Array.isArray(store.character), "state store 应有 character 数组");
    assert.ok(store.character.length > 0, "character 应非空");
  });

  it("创建 workspaces/{workspaceId}/narrative-state-store.json 含 promise", async () => {
    const mod = await importFixtureModule();
    const cases = loadR2Cases();
    const c = findCase(cases.cases, "high-xuanhuan-1");
    const { projectRoot, workspaceId } = mod.setupAblationWorkspace({
      caseData: c,
      arm: "A",
      parentProjectRoot: tempProjectRoot,
    });
    const storePath = join(projectRoot, "workspaces", workspaceId, "narrative-state-store.json");
    const store = JSON.parse(readFileSync(storePath, "utf-8"));
    assert.ok(Array.isArray(store.promise), "state store 应有 promise 数组");
    assert.ok(store.promise.length > 0, "promise 应非空");
  });

  it("workspaceId 含 caseId 和 arm（A/B 隔离）", async () => {
    const mod = await importFixtureModule();
    const cases = loadR2Cases();
    const c = findCase(cases.cases, "high-xuanhuan-1");
    const resultA = mod.setupAblationWorkspace({
      caseData: c,
      arm: "A",
      parentProjectRoot: tempProjectRoot,
    });
    const resultB = mod.setupAblationWorkspace({
      caseData: c,
      arm: "B",
      parentProjectRoot: tempProjectRoot,
    });
    assert.notEqual(resultA.workspaceId, resultB.workspaceId, "A/B workspace 应不同");
    assert.ok(resultA.workspaceId.includes("A"), "workspaceId 应含 arm=A");
    assert.ok(resultB.workspaceId.includes("B"), "workspaceId 应含 arm=B");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 4：NarrativeSearchService 直接读取 fixture workspace，正向命中 confirmed 证据
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-ABLATION-FIXTURE-1：NarrativeSearchService 正向命中 confirmed 证据", () => {
  let tempProjectRoot;

  beforeEach(() => {
    tempProjectRoot = mkdtempSync(join(tmpdir(), "ablation-fixture-search-"));
  });

  afterEach(() => {
    try {
      rmSync(tempProjectRoot, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  });

  it("high-xuanhuan-1：searchRanked('林默左臂噬魂印伤势') 命中 confirmed_state", async () => {
    const fixtureMod = await importFixtureModule();
    const searchMod = await importSearchService();
    const cases = loadR2Cases();
    const c = findCase(cases.cases, "high-xuanhuan-1");
    const { projectRoot, workspaceId } = fixtureMod.setupAblationWorkspace({
      caseData: c,
      arm: "A",
      parentProjectRoot: tempProjectRoot,
    });
    const service = searchMod.createNarrativeSearchService({
      projectRoot,
      workspaceId,
      sourceChapter: `ch${c.targetChapter}`,
    });
    const results = service.searchRanked("林默左臂噬魂印伤势");
    assert.ok(results.length > 0, "searchRanked 应有命中");
    // 至少有一条 evidenceLevel=confirmed_state（来自 canon 或 character）
    const confirmed = results.filter((r) => r.evidenceLevel === "confirmed_state");
    assert.ok(confirmed.length > 0, "应有 confirmed_state 证据（canon 或 character）");
  });

  it("high-xuanhuan-1：3 个 authorMustInclude 作为 query 都能命中 confirmed 证据", async () => {
    const fixtureMod = await importFixtureModule();
    const searchMod = await importSearchService();
    const cases = loadR2Cases();
    const c = findCase(cases.cases, "high-xuanhuan-1");
    const { projectRoot, workspaceId } = fixtureMod.setupAblationWorkspace({
      caseData: c,
      arm: "A",
      parentProjectRoot: tempProjectRoot,
    });
    const service = searchMod.createNarrativeSearchService({
      projectRoot,
      workspaceId,
      sourceChapter: `ch${c.targetChapter}`,
    });
    for (const query of c.authorMustInclude) {
      const results = service.searchRanked(query);
      assert.ok(
        results.length > 0,
        `query="${query}" 应有命中（不应返回 no-match）`,
      );
      const confirmed = results.filter(
        (r) => r.evidenceLevel === "confirmed_state" || r.evidenceLevel === "exact_chapter_span",
      );
      assert.ok(
        confirmed.length > 0,
        `query="${query}" 应命中 confirmed_state 或 exact_chapter_span`,
      );
    }
  });

  it("high-suspense-1：3 个 authorMustInclude 作为 query 都能命中 confirmed 证据", async () => {
    const fixtureMod = await importFixtureModule();
    const searchMod = await importSearchService();
    const cases = loadR2Cases();
    const c = findCase(cases.cases, "high-suspense-1");
    const { projectRoot, workspaceId } = fixtureMod.setupAblationWorkspace({
      caseData: c,
      arm: "A",
      parentProjectRoot: tempProjectRoot,
    });
    const service = searchMod.createNarrativeSearchService({
      projectRoot,
      workspaceId,
      sourceChapter: `ch${c.targetChapter}`,
    });
    for (const query of c.authorMustInclude) {
      const results = service.searchRanked(query);
      assert.ok(
        results.length > 0,
        `query="${query}" 应有命中（不应返回 no-match）`,
      );
      const confirmed = results.filter(
        (r) => r.evidenceLevel === "confirmed_state" || r.evidenceLevel === "exact_chapter_span",
      );
      assert.ok(
        confirmed.length > 0,
        `query="${query}" 应命中 confirmed_state 或 exact_chapter_span`,
      );
    }
  });

  it("high-xuanhuan-1：searchChapterSpan('林默') 命中 exact_chapter_span", async () => {
    const fixtureMod = await importFixtureModule();
    const searchMod = await importSearchService();
    const cases = loadR2Cases();
    const c = findCase(cases.cases, "high-xuanhuan-1");
    const { projectRoot, workspaceId } = fixtureMod.setupAblationWorkspace({
      caseData: c,
      arm: "A",
      parentProjectRoot: tempProjectRoot,
    });
    const service = searchMod.createNarrativeSearchService({
      projectRoot,
      workspaceId,
      sourceChapter: `ch${c.targetChapter}`,
    });
    const spans = service.searchChapterSpan("林默");
    assert.ok(spans.length > 0, "searchChapterSpan('林默') 应有命中");
    assert.equal(spans[0].evidenceLevel, "exact_chapter_span");
  });

  it("high-xuanhuan-1：queryCanon 返回 canon events", async () => {
    const fixtureMod = await importFixtureModule();
    const searchMod = await importSearchService();
    const cases = loadR2Cases();
    const c = findCase(cases.cases, "high-xuanhuan-1");
    const { projectRoot, workspaceId } = fixtureMod.setupAblationWorkspace({
      caseData: c,
      arm: "A",
      parentProjectRoot: tempProjectRoot,
    });
    const service = searchMod.createNarrativeSearchService({
      projectRoot,
      workspaceId,
      sourceChapter: `ch${c.targetChapter}`,
    });
    const canon = service.queryCanon();
    assert.ok(canon.length > 0, "queryCanon 应返回非空 canon events");
    // canon 条目来自 narrative-state-store.json，category 字段保留（timeline/location/entity/ability_rule）
    const categories = new Set(canon.map((e) => e.category));
    assert.ok(categories.has("timeline") || categories.has("location"),
      "canon 应含 timeline 或 location 类别");
  });

  it("high-xuanhuan-1：queryCharacterState('林默') 返回 character states", async () => {
    const fixtureMod = await importFixtureModule();
    const searchMod = await importSearchService();
    const cases = loadR2Cases();
    const c = findCase(cases.cases, "high-xuanhuan-1");
    const { projectRoot, workspaceId } = fixtureMod.setupAblationWorkspace({
      caseData: c,
      arm: "A",
      parentProjectRoot: tempProjectRoot,
    });
    const service = searchMod.createNarrativeSearchService({
      projectRoot,
      workspaceId,
      sourceChapter: `ch${c.targetChapter}`,
    });
    const chars = service.queryCharacterState("林默");
    assert.ok(chars.length > 0, "queryCharacterState('林默') 应返回非空");
    assert.ok(chars.every((e) => e.characterId === "林默"), "所有 entry 应 characterId=林默");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 5：cleanupAblationWorkspace 清理临时目录
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-ABLATION-FIXTURE-1：cleanupAblationWorkspace 清理", () => {
  it("cleanupAblationWorkspace 删除临时 projectRoot", async () => {
    const mod = await importFixtureModule();
    const tempRoot = mkdtempSync(join(tmpdir(), "ablation-cleanup-test-"));
    const cases = loadR2Cases();
    const c = findCase(cases.cases, "high-xuanhuan-1");
    const { projectRoot } = mod.setupAblationWorkspace({
      caseData: c,
      arm: "A",
      parentProjectRoot: tempRoot,
    });
    assert.ok(existsSync(projectRoot), "setup 后 projectRoot 应存在");
    mod.cleanupAblationWorkspace(projectRoot);
    assert.ok(!existsSync(projectRoot), "cleanup 后 projectRoot 应被删除");
    // 清理 tempRoot
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("cleanupAblationWorkspace 对不存在路径不抛错", async () => {
    const mod = await importFixtureModule();
    // 不存在的路径应安全跳过，不抛异常
    assert.doesNotThrow(() => {
      mod.cleanupAblationWorkspace(join(tmpdir(), "nonexistent-ablation-path-12345"));
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 6：fixture 数据格式与 setupAblationWorkspace 兼容
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-ABLATION-FIXTURE-1：fixture 与 setupAblationWorkspace 兼容", () => {
  it("无 workspaceFixture 的 case（如 real-xuanhuan-1）setupAblationWorkspace 返回默认 projectRoot", async () => {
    const mod = await importFixtureModule();
    const cases = loadR2Cases();
    const c = findCase(cases.cases, "real-xuanhuan-1");
    // 无 fixture 时应回退到 parentProjectRoot（process.cwd() 等价行为）
    const tempRoot = mkdtempSync(join(tmpdir(), "ablation-no-fixture-"));
    const result = mod.setupAblationWorkspace({
      caseData: c,
      arm: "A",
      parentProjectRoot: tempRoot,
    });
    // 无 fixture 时 projectRoot 应等于 parentProjectRoot（不创建新目录）
    assert.equal(result.projectRoot, tempRoot, "无 fixture 时 projectRoot 应等于 parent");
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("A/B 两组用相同 fixture 数据（不引入额外变量）", async () => {
    const mod = await importFixtureModule();
    const cases = loadR2Cases();
    const c = findCase(cases.cases, "high-xuanhuan-1");
    const tempRoot = mkdtempSync(join(tmpdir(), "ablation-ab-compat-"));
    const resultA = mod.setupAblationWorkspace({
      caseData: c,
      arm: "A",
      parentProjectRoot: tempRoot,
    });
    const resultB = mod.setupAblationWorkspace({
      caseData: c,
      arm: "B",
      parentProjectRoot: tempRoot,
    });
    // A/B workspaceId 不同（隔离），但 fixture 数据应相同
    const chapterA = readFileSync(
      join(resultA.projectRoot, "workspaces", resultA.workspaceId, "chapters", "chapter-6", "final.md"),
      "utf-8",
    );
    const chapterB = readFileSync(
      join(resultB.projectRoot, "workspaces", resultB.workspaceId, "chapters", "chapter-6", "final.md"),
      "utf-8",
    );
    assert.equal(chapterA, chapterB, "A/B fixture 数据应相同");
    mod.cleanupAblationWorkspace(resultA.projectRoot);
    mod.cleanupAblationWorkspace(resultB.projectRoot);
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
