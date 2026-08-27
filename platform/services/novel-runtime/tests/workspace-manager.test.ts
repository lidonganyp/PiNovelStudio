/**
 * 多租户临时 Workspace 管器测试（plan §4 T4-1 / P0-4）
 *
 * 验证 createWorkspaceManager 的核心契约：
 *   1. materializeWorkspace 创建正确的目录结构（workspaces/{id}/ + chapters/series/styles/traces）
 *   2. 写入 config.json，包含 genre/subGenres/worldKeyTerms/characters
 *   3. 按文档类型写入对应文件：
 *        creative_constitution → CORE-WRITING-PRINCIPLES.md
 *        worldbuilding         → WORLDBUILDING-CANON.md
 *        character_profile     → characters/index.md
 *        story_outline         → series/outline.md
 *        style_profile (JSON)  → styles/profile.json
 *        style_profile (MD)    → styles/profile.md
 *        chapter_seed (JSON)   → series/chapter-seed.json
 *        narrative_state (JSON)→ narrative-state-store.json
 *        narrative_state (bad) → narrative-state-store.json = {}
 *   4. previousChapterText + previousChapterNumber → chapter-continuity snapshot, 不写全文文件
 *   5. cleanupWorkspace 删除整个 {jobId}/ 目录
 *   6. cleanupWorkspace 幂等：目录不存在时不报错
 *   7. 路径穿越防护：非法 jobId / workspaceId 被拒
 *   8. deriveWorkspaceId 确定性：同输入同输出
 *   9. 残留 temp 目录会被覆盖（重试场景）
 *  10. materialize 失败时已创建的目录被清理
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createWorkspaceManager, WorkspaceManagerError } from "../src/workspace-manager.js";

const DIST_WORKSPACE_MANAGER = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../dist/workspace-manager.js",
);

// 测试根目录：每次测试套件运行使用独立子目录
const TEST_ROOT = join(tmpdir(), `wm-test-${process.pid}-${Date.now()}`);

before(() => {
  mkdirSync(TEST_ROOT, { recursive: true });
});

after(() => {
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function makeManager(options: { capabilityPackageSourceRoot?: string } = {}) {
  return createWorkspaceManager({ tempWorkspaceRoot: TEST_ROOT, ...options });
}

function readText(path: string): string {
  return readFileSync(path, "utf-8");
}

function readJson<T = unknown>(path: string): T {
  return JSON.parse(readText(path)) as T;
}

describe("P0-4 workspace-manager.materializeWorkspace", () => {
  test("复制 release-bound frozen capability package set 到 job root", () => {
    const sourceRoot = join(TEST_ROOT, "release-source");
    const sourcePath = join(sourceRoot, "data", "runtime", "capability-package-set.json");
    mkdirSync(join(sourceRoot, "data", "runtime"), { recursive: true });
    writeFileSync(sourcePath, JSON.stringify({ schemaVersion: "capability-package-set-v1", packages: [], payloads: [] }));

    const wm = makeManager({ capabilityPackageSourceRoot: sourceRoot });
    const result = wm.materializeWorkspace({
      jobId: "job-capability-set-1",
      workspaceId: "u1_p1",
      projectConfig: { genre: "武侠" },
      documents: [],
    });

    const targetPath = join(result.tempProjectRoot, "data", "runtime", "capability-package-set.json");
    assert.equal(readText(targetPath), readText(sourcePath));
    wm.cleanupWorkspace("job-capability-set-1");
    rmSync(sourceRoot, { recursive: true, force: true });
  });

  test("创建完整目录结构 + config.json", () => {
    const wm = makeManager();
    const result = wm.materializeWorkspace({
      jobId: "job-structure-1",
      workspaceId: "u1_p1",
      projectConfig: {
        genre: "都市玄幻",
        subGenres: ["热血", "悬疑"],
        worldKeyTerms: ["灵气", "宗门"],
      },
      documents: [],
    });

    assert.ok(result.tempProjectRoot.includes("job-structure-1"));
    assert.ok(result.workspacePath.includes("u1_p1"));
    assert.ok(existsSync(join(result.workspacePath, "chapters")));
    assert.ok(existsSync(join(result.workspacePath, "series")));
    assert.ok(existsSync(join(result.workspacePath, "styles")));
    assert.ok(existsSync(join(result.workspacePath, "traces")));

    const cfg = readJson<{
      genre: string;
      subGenres: string[];
      worldKeyTerms: string[];
      characters: unknown[];
    }>(join(result.workspacePath, "config.json"));
    assert.equal(cfg.genre, "都市玄幻");
    assert.deepEqual(cfg.subGenres, ["热血", "悬疑"]);
    assert.deepEqual(cfg.worldKeyTerms, ["灵气", "宗门"]);
    assert.deepEqual(cfg.characters, []);

    wm.cleanupWorkspace("job-structure-1");
  });

  test("creative_constitution → CORE-WRITING-PRINCIPLES.md", () => {
    const wm = makeManager();
    const result = wm.materializeWorkspace({
      jobId: "job-cc-1",
      workspaceId: "u1_p1",
      projectConfig: { genre: "武侠" },
      documents: [
        { type: "creative_constitution", content: "# 创作宪法\n坚持人物驱动" },
      ],
    });

    const text = readText(join(result.workspacePath, "CORE-WRITING-PRINCIPLES.md"));
    assert.ok(text.includes("坚持人物驱动"));
    wm.cleanupWorkspace("job-cc-1");
  });

  test("worldbuilding → WORLDBUILDING-CANON.md", () => {
    const wm = makeManager();
    const result = wm.materializeWorkspace({
      jobId: "job-wb-1",
      workspaceId: "u1_p1",
      projectConfig: { genre: "武侠" },
      documents: [
        { type: "worldbuilding", content: "九重天大陆" },
      ],
    });

    const text = readText(join(result.workspacePath, "WORLDBUILDING-CANON.md"));
    assert.ok(text.includes("九重天大陆"));
    wm.cleanupWorkspace("job-wb-1");
  });

  test("character_profile → characters/index.md", () => {
    const wm = makeManager();
    const result = wm.materializeWorkspace({
      jobId: "job-cp-1",
      workspaceId: "u1_p1",
      projectConfig: { genre: "武侠" },
      documents: [
        { type: "character_profile", content: "李寒山：剑修" },
      ],
    });

    const text = readText(join(result.workspacePath, "characters", "index.md"));
    assert.ok(text.includes("李寒山"));
    wm.cleanupWorkspace("job-cp-1");
  });

  test("story_outline → series/outline.md", () => {
    const wm = makeManager();
    const result = wm.materializeWorkspace({
      jobId: "job-so-1",
      workspaceId: "u1_p1",
      projectConfig: { genre: "武侠" },
      documents: [
        { type: "story_outline", content: "第一卷：登顶之路" },
      ],
    });

    const text = readText(join(result.workspacePath, "series", "outline.md"));
    assert.ok(text.includes("登顶之路"));
    wm.cleanupWorkspace("job-so-1");
  });

  test("story_outline_full → series/outline-full.md（FactGuard 授权全文，不覆盖提示词副本）", () => {
    const wm = makeManager();
    const result = wm.materializeWorkspace({
      jobId: "job-sof-1",
      workspaceId: "u1_p1",
      projectConfig: { genre: "武侠" },
      documents: [
        { type: "story_outline", content: "第一卷：登顶之路" },
        { type: "story_outline_full", content: "第一卷：登顶之路\n魂玉可以封印伤势。" },
      ],
    });

    const full = readText(join(result.workspacePath, "series", "outline-full.md"));
    assert.ok(full.includes("封印"));
    const prompt = readText(join(result.workspacePath, "series", "outline.md"));
    assert.equal(prompt.includes("封印"), false);
    wm.cleanupWorkspace("job-sof-1");
  });

  test("style_profile JSON → styles/profile.json", () => {
    const wm = makeManager();
    const styleJson = JSON.stringify({ rhythm: "fast", vocabulary: "concise" });
    const result = wm.materializeWorkspace({
      jobId: "job-sp-json",
      workspaceId: "u1_p1",
      projectConfig: { genre: "武侠" },
      documents: [
        { type: "style_profile", content: styleJson },
      ],
    });

    const parsed = readJson<{ rhythm: string }>(
      join(result.workspacePath, "styles", "profile.json"),
    );
    assert.equal(parsed.rhythm, "fast");
    wm.cleanupWorkspace("job-sp-json");
  });

  test("style_profile 非 JSON → styles/profile.md", () => {
    const wm = makeManager();
    const result = wm.materializeWorkspace({
      jobId: "job-sp-md",
      workspaceId: "u1_p1",
      projectConfig: { genre: "武侠" },
      documents: [
        { type: "style_profile", content: "节奏明快，词汇简练" },
      ],
    });

    const text = readText(join(result.workspacePath, "styles", "profile.md"));
    assert.ok(text.includes("节奏明快"));
    wm.cleanupWorkspace("job-sp-md");
  });

  test("chapter_seed JSON → series/chapter-seed.json", () => {
    const wm = makeManager();
    const seedJson = JSON.stringify({ intent: "reversal", chapterTheme: "背叛" });
    const result = wm.materializeWorkspace({
      jobId: "job-cs-json",
      workspaceId: "u1_p1",
      projectConfig: { genre: "武侠" },
      documents: [
        { type: "chapter_seed", content: seedJson },
      ],
    });

    const parsed = readJson<{ intent: string }>(
      join(result.workspacePath, "series", "chapter-seed.json"),
    );
    assert.equal(parsed.intent, "reversal");
    wm.cleanupWorkspace("job-cs-json");
  });

  test("narrative_state 合法 JSON → narrative-state-store.json", () => {
    const wm = makeManager();
    const stateJson = JSON.stringify({
      characters: [{ name: "李寒山", hp: 100 }],
      canon: { world: "九重天" },
    });
    const result = wm.materializeWorkspace({
      jobId: "job-ns-ok",
      workspaceId: "u1_p1",
      projectConfig: { genre: "武侠" },
      documents: [
        { type: "narrative_state", content: stateJson },
      ],
    });

    const parsed = readJson<{ characters: Array<{ name: string }> }>(
      join(result.workspacePath, "narrative-state-store.json"),
    );
    assert.equal(parsed.characters[0].name, "李寒山");
    wm.cleanupWorkspace("job-ns-ok");
  });

  test("narrative_state 非法 JSON → materialize 失败", () => {
    const wm = makeManager();
    assert.throws(
      () => wm.materializeWorkspace({
        jobId: "job-ns-bad",
        workspaceId: "u1_p1",
        projectConfig: { genre: "武侠" },
        documents: [
          { type: "narrative_state", content: "不是 JSON" },
        ],
      }),
      /MATERIALIZE_FAILED.*narrative state must be valid JSON/,
    );
  });

  test("previousChapterText is not written as a full chapter file", () => {
    const wm = makeManager();
    const result = wm.materializeWorkspace({
      jobId: "job-prev-1",
      workspaceId: "u1_p1",
      projectConfig: { genre: "武侠" },
      documents: [],
      previousChapterText: `${"很长的前文。".repeat(12)}前一章结尾的悬念。`,
      previousChapterNumber: 4,
    });

    assert.ok(!existsSync(join(result.workspacePath, "chapters", "chapter-4.md")));
    const snapshot = JSON.parse(
      readText(join(result.workspacePath, "chapter-continuity", "4.json")),
    ) as { lastEventSummary: string };
    assert.ok(snapshot.lastEventSummary.includes("前一章结尾的悬念"));
    assert.ok(!snapshot.lastEventSummary.includes("很长的前文。很长的前文。"));
    wm.cleanupWorkspace("job-prev-1");
  });

  test("writes continuation snapshot without silently reanchoring state hashes", () => {
    const wm = makeManager();
    const previousText = "沈砚握紧铜哨：不要相信沈建国。";
    const actualHash = createHash("sha256").update(previousText, "utf8").digest("hex").slice(0, 12);
    const result = wm.materializeWorkspace({
      jobId: "job-reanchor-1",
      workspaceId: "p128",
      projectConfig: { genre: "都市" },
      documents: [
        {
          type: "narrative_state",
          content: JSON.stringify({
            workspaceId: "p128",
            lastCommittedChapter: "ch1",
            canon: [
              {
                sourceChapter: "ch1",
                sourceRef: "ch1#finalText:39e1530b9e06:12-40",
                fact: "铜哨再现",
              },
            ],
            character: [],
            promise: [],
            pattern: [],
          }),
        },
      ],
      previousChapterContinuation: {
        chapterNumber: 1,
        endingState: "沈砚握紧铜哨：不要相信沈建国。",
        lastSceneSummary: "沈砚握紧铜哨：不要相信沈建国。",
        changedCharacters: ["沈砚"],
        unresolvedPromises: ["不要相信沈建国"],
        tailExcerpt: "沈砚握紧铜哨：不要相信沈建国。",
        sourceChapterHash: actualHash,
      },
    });
    const store = JSON.parse(
      readText(join(result.workspacePath, "narrative-state-store.json")),
    ) as { canon: Array<{ sourceRef: string }> };
    assert.equal(store.canon[0].sourceRef, "ch1#finalText:39e1530b9e06:12-40");
    assert.ok(!existsSync(join(result.workspacePath, "chapters", "chapter-1.md")));
    const snapshot = JSON.parse(
      readText(join(result.workspacePath, "chapter-continuity", "1.json")),
    ) as { lastEventSummary: string; finalTextHash: string };
    assert.ok(snapshot.lastEventSummary.includes("不要相信沈建国"));
    assert.equal(snapshot.finalTextHash, actualHash);
    wm.cleanupWorkspace("job-reanchor-1");
  });

  test("previousChapterNumber=0 不写前章", () => {
    const wm = makeManager();
    const result = wm.materializeWorkspace({
      jobId: "job-prev-0",
      workspaceId: "u1_p1",
      projectConfig: { genre: "武侠" },
      documents: [],
      previousChapterText: "应被忽略",
      previousChapterNumber: 0,
    });

    assert.ok(!existsSync(join(result.workspacePath, "chapters", "ch0.md")));
    wm.cleanupWorkspace("job-prev-0");
  });

  test("characters 字段写入 config.json", () => {
    const wm = makeManager();
    const result = wm.materializeWorkspace({
      jobId: "job-chars-1",
      workspaceId: "u1_p1",
      projectConfig: {
        genre: "武侠",
        characters: [
          { name: "李寒山", role: "主角", description: "剑修" },
          { name: "苏婉", role: "女主" },
        ],
      },
      documents: [],
    });

    const cfg = readJson<{ characters: Array<{ name: string; role: string }> }>(
      join(result.workspacePath, "config.json"),
    );
    assert.equal(cfg.characters.length, 2);
    assert.equal(cfg.characters[0].name, "李寒山");
    assert.equal(cfg.characters[1].role, "女主");
    wm.cleanupWorkspace("job-chars-1");
  });

  test("extra 字段合并入 config.json", () => {
    const wm = makeManager();
    const result = wm.materializeWorkspace({
      jobId: "job-extra-1",
      workspaceId: "u1_p1",
      projectConfig: {
        genre: "武侠",
        extra: { customField: "custom-value", chapterBudget: 5000 },
      },
      documents: [],
    });

    const cfg = readJson<{ customField: string; chapterBudget: number }>(
      join(result.workspacePath, "config.json"),
    );
    assert.equal(cfg.customField, "custom-value");
    assert.equal(cfg.chapterBudget, 5000);
    wm.cleanupWorkspace("job-extra-1");
  });

  test("does not invent style, constitution, worldbuilding, or genre", () => {
    const wm = makeManager();
    const result = wm.materializeWorkspace({
      jobId: "job-defaults-1",
      workspaceId: "u1_p1",
      projectConfig: { genre: "  " },
      documents: [],
    });

    const cfg = readJson<{ genre: string }>(join(result.workspacePath, "config.json"));
    assert.equal(cfg.genre, "");
    assert.equal(existsSync(join(result.workspacePath, "styles", "profile.json")), false);
    assert.equal(existsSync(join(result.workspacePath, "CORE-WRITING-PRINCIPLES.md")), false);
    assert.equal(existsSync(join(result.workspacePath, "WORLDBUILDING-CANON.md")), false);
    wm.cleanupWorkspace("job-defaults-1");
  });
});

describe("P0-4 workspace-manager.cleanupWorkspace", () => {
  test("删除整个 {jobId}/ 目录", () => {
    const wm = makeManager();
    const result = wm.materializeWorkspace({
      jobId: "job-clean-1",
      workspaceId: "u1_p1",
      projectConfig: { genre: "武侠" },
      documents: [],
    });

    assert.ok(existsSync(result.tempProjectRoot));
    wm.cleanupWorkspace("job-clean-1");
    assert.ok(!existsSync(result.tempProjectRoot), "temp 目录应被删除");
  });

  test("幂等：目录不存在时不报错", () => {
    const wm = makeManager();
    // 不存在 → 不报错
    assert.doesNotThrow(() => wm.cleanupWorkspace("nonexistent-job"));
  });

  test("残留 temp 目录会被覆盖（重试场景）", () => {
    const wm = makeManager();
    // 第一次物化
    const r1 = wm.materializeWorkspace({
      jobId: "job-retry-1",
      workspaceId: "u1_p1",
      projectConfig: { genre: "武侠" },
      documents: [
        { type: "creative_constitution", content: "v1" },
      ],
    });
    // 模拟上次失败残留：目录已存在
    assert.ok(existsSync(r1.tempProjectRoot));

    // 第二次物化同一 jobId（重试）
    const r2 = wm.materializeWorkspace({
      jobId: "job-retry-1",
      workspaceId: "u1_p1",
      projectConfig: { genre: "武侠" },
      documents: [
        { type: "creative_constitution", content: "v2-retry" },
      ],
    });

    const text = readText(join(r2.workspacePath, "CORE-WRITING-PRINCIPLES.md"));
    assert.ok(text.includes("v2-retry"), "残留目录应被新内容覆盖");
    wm.cleanupWorkspace("job-retry-1");
  });
});

describe("P0-4 workspace-manager 路径穿越防护", () => {
  test("jobId 含 .. 被拒", () => {
    const wm = makeManager();
    assert.throws(
      () =>
        wm.materializeWorkspace({
          jobId: "../escape",
          workspaceId: "u1_p1",
          projectConfig: { genre: "武侠" },
          documents: [],
        }),
      (err: unknown) => {
        assert.ok(err instanceof WorkspaceManagerError);
        assert.equal((err as WorkspaceManagerError).code, "INVALID_JOB_ID");
        return true;
      },
    );
  });

  test("jobId 含 / 被拒（仅允许 [a-zA-Z0-9_-]）", () => {
    const wm = makeManager();
    assert.throws(
      () =>
        wm.materializeWorkspace({
          jobId: "job/sub",
          workspaceId: "u1_p1",
          projectConfig: { genre: "武侠" },
          documents: [],
        }),
      (err: unknown) => err instanceof WorkspaceManagerError && err.code === "INVALID_JOB_ID",
    );
  });

  test("jobId 以 - 开头被拒", () => {
    const wm = makeManager();
    assert.throws(
      () =>
        wm.materializeWorkspace({
          jobId: "-leading-dash",
          workspaceId: "u1_p1",
          projectConfig: { genre: "武侠" },
          documents: [],
        }),
      (err: unknown) => err instanceof WorkspaceManagerError && err.code === "INVALID_JOB_ID",
    );
  });

  test("workspaceId 含 .. 被拒", () => {
    const wm = makeManager();
    assert.throws(
      () =>
        wm.materializeWorkspace({
          jobId: "job-safe-1",
          workspaceId: "../escape",
          projectConfig: { genre: "武侠" },
          documents: [],
        }),
      (err: unknown) => err instanceof WorkspaceManagerError && err.code === "INVALID_WORKSPACE_ID",
    );
  });

  test("workspaceId 含 / 被拒", () => {
    const wm = makeManager();
    assert.throws(
      () =>
        wm.materializeWorkspace({
          jobId: "job-safe-2",
          workspaceId: "u1/p1",
          projectConfig: { genre: "武侠" },
          documents: [],
        }),
      (err: unknown) => err instanceof WorkspaceManagerError && err.code === "INVALID_WORKSPACE_ID",
    );
  });

  test("空 jobId 被拒", () => {
    const wm = makeManager();
    assert.throws(
      () =>
        wm.materializeWorkspace({
          jobId: "",
          workspaceId: "u1_p1",
          projectConfig: { genre: "武侠" },
          documents: [],
        }),
      (err: unknown) => err instanceof WorkspaceManagerError && err.code === "INVALID_JOB_ID",
    );
  });

  test("cleanupWorkspace 对非法 jobId 也拒绝（防清理路径穿越）", () => {
    const wm = makeManager();
    assert.throws(
      () => wm.cleanupWorkspace("../escape"),
      (err: unknown) => err instanceof WorkspaceManagerError && err.code === "INVALID_JOB_ID",
    );
  });
});

describe("P0-4 workspace-manager.deriveWorkspaceId", () => {
  test("同输入同输出（确定性）", () => {
    const wm = makeManager();
    const a = wm.deriveWorkspaceId(1, 100);
    const b = wm.deriveWorkspaceId("1", "100");
    assert.equal(a, b);
    assert.equal(a, "u1_p100");
  });

  test("不同输入不同输出", () => {
    const wm = makeManager();
    assert.notEqual(
      wm.deriveWorkspaceId(1, 100),
      wm.deriveWorkspaceId(2, 100),
    );
    assert.notEqual(
      wm.deriveWorkspaceId(1, 100),
      wm.deriveWorkspaceId(1, 200),
    );
  });

  test("派生的 workspaceId 通过安全校验", () => {
    const wm = makeManager();
    const wid = wm.deriveWorkspaceId(12345, 67890);
    // 应能通过 materializeWorkspace 的安全校验，不抛错
    const result = wm.materializeWorkspace({
      jobId: "job-derive-1",
      workspaceId: wid,
      projectConfig: { genre: "武侠" },
      documents: [],
    });
    assert.ok(result.workspacePath.includes(wid));
    wm.cleanupWorkspace("job-derive-1");
  });
});

describe("P0-4 workspace-manager 综合场景", () => {
  test("全套文档一次性物化（典型生产场景）", () => {
    const wm = makeManager();
    const result = wm.materializeWorkspace({
      jobId: "job-full-1",
      workspaceId: wm.deriveWorkspaceId(42, 7),
      projectConfig: {
        genre: "都市玄幻",
        subGenres: ["热血", "悬疑"],
        worldKeyTerms: ["灵气复苏", "九重天"],
        characters: [
          { name: "李寒山", role: "主角", description: "剑修" },
          { name: "苏婉", role: "女主", description: "医师" },
        ],
      },
      documents: [
        { type: "creative_constitution", content: "# 创作宪法\n核心是人物驱动" },
        { type: "worldbuilding", content: "灵气复苏后九重天降临人间" },
        { type: "character_profile", content: "李寒山：剑修，冷漠外冷内热" },
        { type: "story_outline", content: "第一卷：登顶九重天" },
        { type: "style_profile", content: JSON.stringify({ rhythm: "fast" }) },
        { type: "chapter_seed", content: JSON.stringify({ intent: "tension" }) },
        { type: "narrative_state", content: JSON.stringify({ lastChapter: 5 }) },
      ],
      previousChapterText: "第 5 章结尾的悬念。",
      previousChapterNumber: 5,
    });

    // 验证关键文件都存在
    assert.ok(existsSync(join(result.workspacePath, "config.json")));
    assert.ok(existsSync(join(result.workspacePath, "CORE-WRITING-PRINCIPLES.md")));
    assert.ok(existsSync(join(result.workspacePath, "WORLDBUILDING-CANON.md")));
    assert.ok(existsSync(join(result.workspacePath, "characters", "index.md")));
    assert.ok(existsSync(join(result.workspacePath, "series", "outline.md")));
    assert.ok(existsSync(join(result.workspacePath, "styles", "profile.json")));
    assert.ok(existsSync(join(result.workspacePath, "series", "chapter-seed.json")));
    assert.ok(existsSync(join(result.workspacePath, "narrative-state-store.json")));
    assert.ok(existsSync(join(result.workspacePath, "chapter-continuity", "5.json")));
    assert.ok(!existsSync(join(result.workspacePath, "chapters", "chapter-5.md")));

    wm.cleanupWorkspace("job-full-1");
    assert.ok(!existsSync(result.tempProjectRoot));
  });

  test("相对路径 tempWorkspaceRoot 也正常工作", () => {
    // 临时切到测试根目录下作为相对路径
    const relRoot = join(TEST_ROOT, "rel-sub");
    mkdirSync(relRoot, { recursive: true });
    const wm = createWorkspaceManager({
      tempWorkspaceRoot: "./rel-sub",
      // 不传 logger，验证可选
    });

    // 在测试根目录下运行（cwd 切换模拟）
    const originalCwd = process.cwd();
    try {
      process.chdir(TEST_ROOT);
      const result = wm.materializeWorkspace({
        jobId: "job-rel-1",
        workspaceId: "u1_p1",
        projectConfig: { genre: "武侠" },
        documents: [],
      });
      assert.ok(existsSync(result.tempProjectRoot));
      wm.cleanupWorkspace("job-rel-1");
      assert.ok(!existsSync(result.tempProjectRoot));
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("production dist workspace-manager", () => {
  test("does not ship invented default materials", () => {
    assert.equal(existsSync(DIST_WORKSPACE_MANAGER), true, "runtime dist/workspace-manager.js is missing; run npm run build");
    const js = readFileSync(DIST_WORKSPACE_MANAGER, "utf8");
    assert.equal(js.includes("platform-default"), false);
    assert.equal(js.includes("ensureRequiredWorkspaceMaterials"), false);
    assert.equal(js.includes('|| "都市"'), false);
    assert.equal(js.includes("以项目题材为准，保持内部自洽"), false);
    assert.equal(js.includes("不违背已确立的人物身份、能力与关系"), false);
  });
});
