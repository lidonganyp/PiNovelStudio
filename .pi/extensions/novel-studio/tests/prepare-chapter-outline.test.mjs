/**
 * novel_prepare_chapter_outline regression tests
 *
 * Verifies:
 * 1. Returns CHAPTER_OUTLINE_NOT_FOUND when chapter section is not in outline
 * 2. Does not fallback to template mode
 * 3. Error handling is correct
 *
 * Note: This is a behavioral test suite. For fast deterministic tests
 * that verify LLM call payloads, see prepare-chapter-outline-mock.test.mjs
 *
 * P22: novel_prepare_chapter_outline 工具已下线（写前章纲硬前置废止）。
 * 该工具不再注册到工具列表，因此本测试套件中的 tool.execute 调用会因
 * fakePi.tools.get("novel_prepare_chapter_outline") 返回 undefined 而失败。
 * 这是预期行为。整个 describe 块已通过 describe.skip 跳过。
 * 旧实现 handlePrepareChapterOutline 保留在 index.ts 作为 archive/reference。
 */

import { afterEach, describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { rmSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import novelStudioExtension from "../dist/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..", "..", "..", "..");
const WORKSPACE_ID = "prepare-outline-test";
const WORKSPACE_PATH = join(PROJECT_ROOT, "workspaces", WORKSPACE_ID);

const INLINE_OUTLINE = `# Test Novel Outline

## Chapter 1: The Beginning
This is the story of cultivation.

## Chapter 2: A New Journey
The protagonist leaves the trial ground.

## Chapter 3: Into the Heart-Demon Realm
The protagonist enters the depths of the heart-demon realm.

## Chapter 50: The Final Battle
The protagonist faces the Heart-Demon Lord in the final showdown.

## Chapter 100: The End
Everything is settled.`;

const INLINE_OUTLINE_NO_CH99 = `# Test Novel Outline

## Chapter 1: The Beginning
This is the story of cultivation.

## Chapter 2: A New Journey
The protagonist leaves the trial ground.

## Chapter 50: The Final Battle
The protagonist faces the Heart-Demon Lord.`;

function createFakePi() {
  const tools = new Map();
  const commands = new Map();
  return {
    tools,
    api: {
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
      registerCommand(command) {
        commands.set(command.name, command);
      },
      on() {},
    },
  };
}

function createWorkspace(outline = INLINE_OUTLINE) {
  rmSync(WORKSPACE_PATH, { recursive: true, force: true });
  mkdirSync(join(WORKSPACE_PATH, "chapters"), { recursive: true });
  mkdirSync(join(WORKSPACE_PATH, "characters"), { recursive: true });
  mkdirSync(join(WORKSPACE_PATH, "series"), { recursive: true });

  writeFileSync(join(WORKSPACE_PATH, "series", "outline.md"), outline, "utf-8");

  const config = {
    name: "Test Novel",
    genre: "Fantasy",
    subGenres: ["Cultivation"],
    totalChapters: 100,
    styleProfile: "default",
    characters: [
      { id: "protagonist", name: "Protagonist", role: "protagonist" },
    ],
  };
  writeFileSync(join(WORKSPACE_PATH, "config.json"), JSON.stringify(config, null, 2), "utf-8");
}

describe.skip("novel_prepare_chapter_outline unit tests [P22: 已下线，保留为 archive]", () => {
  let fakePi;

  beforeEach(() => {
    createWorkspace();
    fakePi = createFakePi();
    novelStudioExtension(fakePi.api);
  });

  afterEach(() => {
    rmSync(WORKSPACE_PATH, { recursive: true, force: true });
  });

  describe("chapter section extraction", () => {
    it("should process chapter 50 request correctly", async () => {
      const tool = fakePi.tools.get("novel_prepare_chapter_outline");
      const result = await tool.execute(
        "test-tool-call",
        { workspaceId: WORKSPACE_ID, chapterNumber: 50 },
        undefined,
        undefined,
        { cwd: PROJECT_ROOT }
      );

      assert.ok(result.details, "should have details field");

      // ?????????LLM??
      // ??????????? LLM ??
      if (result.details.status === "success") {
        assert.ok(result.details.outline, "success should include outline");
        assert.strictEqual(result.details.llmUsed, true, "success should have llmUsed=true");
      } else {
        // ????????????
        assert.ok(
          result.details.errorCode === "CHAPTER_OUTLINE_NOT_FOUND" ||
          result.details.errorCode === "LLM_GENERATION_FAILED",
          "errorCode should be specific: " + result.details.errorCode
        );
      }
    });

    it("should process chapter 100 request correctly", async () => {
      const tool = fakePi.tools.get("novel_prepare_chapter_outline");
      const result = await tool.execute(
        "test-tool-call",
        { workspaceId: WORKSPACE_ID, chapterNumber: 100 },
        undefined,
        undefined,
        { cwd: PROJECT_ROOT }
      );

      assert.ok(result.details, "should have details field");

      if (result.details.status === "success") {
        assert.ok(result.details.outline, "success should include outline");
      } else {
        assert.ok(result.details.errorCode, "error should have errorCode");
      }
    });
  });

  describe("chapter outline not found", () => {
    it("should return CHAPTER_OUTLINE_NOT_FOUND when chapter 99 is missing", async () => {
      createWorkspace(INLINE_OUTLINE_NO_CH99);
      fakePi = createFakePi();
      novelStudioExtension(fakePi.api);

      const tool = fakePi.tools.get("novel_prepare_chapter_outline");
      const result = await tool.execute(
        "test-tool-call",
        { workspaceId: WORKSPACE_ID, chapterNumber: 99 },
        undefined,
        undefined,
        { cwd: PROJECT_ROOT }
      );

      assert.strictEqual(result.details.status, "error", "should return error status");
      assert.strictEqual(
        result.details.errorCode,
        "CHAPTER_OUTLINE_NOT_FOUND",
        "should return CHAPTER_OUTLINE_NOT_FOUND error code"
      );
      assert.ok(result.details.suggestion, "should have fix suggestion");
      assert.ok(
        result.details.suggestion.includes("outline.md"),
        "suggestion should mention outline.md"
      );
    });

    it("should not fallback to template when chapter is not found", async () => {
      createWorkspace(INLINE_OUTLINE_NO_CH99);
      fakePi = createFakePi();
      novelStudioExtension(fakePi.api);

      const tool = fakePi.tools.get("novel_prepare_chapter_outline");
      const result = await tool.execute(
        "test-tool-call",
        { workspaceId: WORKSPACE_ID, chapterNumber: 99 },
        undefined,
        undefined,
        { cwd: PROJECT_ROOT }
      );

      assert.notStrictEqual(
        result.details.status,
        "success_with_template",
        "should not return template success status"
      );
      assert.strictEqual(result.details.status, "error", "should return error status");
      assert.strictEqual(
        result.details.errorCode,
        "CHAPTER_OUTLINE_NOT_FOUND",
        "should return specific error code"
      );
    });
  });

  describe("error handling", () => {
    it("should return error when workspace does not exist", async () => {
      const tool = fakePi.tools.get("novel_prepare_chapter_outline");
      const result = await tool.execute(
        "test-tool-call",
        { workspaceId: "non-existent-workspace", chapterNumber: 1 },
        undefined,
        undefined,
        { cwd: PROJECT_ROOT }
      );

      assert.strictEqual(result.details.status, "error", "should return error status");
    });
  });
});
