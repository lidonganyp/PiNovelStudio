/**
 * novel_plan_story_outline tool tests
 *
 * Verifies the planning workflow before chapter generation:
 * 1. Registers a tool for idea -> full outline -> explicit chapter outlines
 * 2. Writes series/outline.md from a user idea
 * 3. Splits a full outline into chapter-level explicit outlines compatible with P20 readiness checks
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import novelStudioExtension from "../dist/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..", "..", "..", "..");
const WORKSPACE_ID = "story-outline-planner-test";
const WORKSPACE_PATH = join(PROJECT_ROOT, "workspaces", WORKSPACE_ID);

const GENERATED_FULL_OUTLINE = `# Test Novel Outline

## Chapter 1: Ash Under the Gate
The protagonist discovers that the city gate tax hides a vanished sect token.

## Chapter 2: Ledger of Borrowed Names
The protagonist follows the token trail into a merchant guild and finds a false identity network.

## Chapter 3: Bell at the River Shrine
The first arc closes when the protagonist trades a secret for a dangerous alliance.`;

function makeChapterOutline(chapterNumber, title) {
  return `# 第${chapterNumber}章：${title}

## 本章功能
把总纲中的第${chapterNumber}章目标拆成可生成的事件链。

#### 事件1：开场锚点
- **类型**：开场
- **内容**：主角在具体场景中发现线索，线索直接连接本章目标，并引出主要阻力。
- **冲突等级**：2
- **情绪弧**：平静 -> 紧张
- **感知锚点**：风声、灯影、湿冷石阶
- **参与角色**：主角、对手
- **伏笔埋设**：隐藏身份留下可追踪痕迹
- **字数目标**：800

#### 事件2：正面阻力
- **类型**：冲突
- **内容**：对手用规则或人情压迫主角，迫使主角做出会带来后果的选择。
- **冲突等级**：4
- **情绪弧**：紧张 -> 压迫
- **感知锚点**：账册纸页、低声盘问、封闭房间
- **参与角色**：主角、对手、旁观角色
- **伏笔埋设**：关键证词被故意说错
- **字数目标**：900

#### 事件3：转折收束
- **类型**：转折
- **内容**：主角利用前一事件中的破绽换取阶段性成果，同时留下下一章必须处理的新问题。
- **冲突等级**：3
- **情绪弧**：压迫 -> 悬疑
- **感知锚点**：铃声、雨痕、远处火光
- **参与角色**：主角、盟友
- **伏笔埋设**：盟友知道不该知道的细节
- **字数目标**：850`;
}

function makeMockGLMResponse(content) {
  return {
    id: "mock-response-id",
    object: "chat.completion",
    created: Date.now(),
    model: "glm-5.2",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    },
  };
}

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

function createWorkspace() {
  rmSync(WORKSPACE_PATH, { recursive: true, force: true });
  mkdirSync(join(WORKSPACE_PATH, "chapters"), { recursive: true });
  mkdirSync(join(WORKSPACE_PATH, "characters"), { recursive: true });
  mkdirSync(join(WORKSPACE_PATH, "series"), { recursive: true });

  const config = {
    name: "Test Novel",
    genre: "Fantasy",
    subGenres: ["Cultivation", "Mystery"],
    totalChapters: 3,
    styleProfile: "default",
    characters: [
      { id: "protagonist", name: "Protagonist", role: "protagonist" },
      { id: "merchant", name: "Merchant", role: "antagonist" },
    ],
  };
  writeFileSync(join(WORKSPACE_PATH, "config.json"), JSON.stringify(config, null, 2), "utf-8");
}

function installFetchQueue(contents) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const queue = [...contents];

  globalThis.fetch = async (url, options) => {
    const content = queue.shift();
    calls.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(makeMockGLMResponse(content ?? "")),
      json: async () => makeMockGLMResponse(content ?? ""),
      headers: {
        get: (name) => name.toLowerCase() === "content-type" ? "application/json" : null,
      },
    };
  };

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("novel_plan_story_outline", () => {
  let fakePi;
  let fetchMock;
  // outline_planner route 用 provider=gpt，RoutedChatAPI.isConfigured() 在 fetch 之前
  // 检查 apiKey.length > 0。干净 checkout 无 .env 时缺 GPT_API_KEY 会直接抛错，
  // 无法被 globalThis.fetch mock 拦截。这里注入 dummy key 让 mock 生效。
  let _originalGptApiKey;

  beforeEach(() => {
    _originalGptApiKey = process.env.GPT_API_KEY;
    process.env.GPT_API_KEY = "test-dummy-key-for-mock";
    createWorkspace();
    fakePi = createFakePi();
    novelStudioExtension(fakePi.api);
  });

  afterEach(() => {
    if (_originalGptApiKey === undefined) {
      delete process.env.GPT_API_KEY;
    } else {
      process.env.GPT_API_KEY = _originalGptApiKey;
    }
    if (fetchMock) {
      fetchMock.restore();
      fetchMock = null;
    }
    rmSync(WORKSPACE_PATH, { recursive: true, force: true });
  });

  it("registers the planning tool", () => {
    assert.ok(fakePi.tools.has("novel_plan_story_outline"), "tool should be registered");
  });

  it("turns a user idea into a persisted full outline", async () => {
    fetchMock = installFetchQueue([GENERATED_FULL_OUTLINE]);

    const tool = fakePi.tools.get("novel_plan_story_outline");
    const result = await tool.execute(
      "test-tool-call",
      {
        workspaceId: WORKSPACE_ID,
        mode: "idea_to_outline",
        idea: "A gate tax clerk discovers a vanished sect token hidden inside city debts.",
        totalChapters: 3,
      },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT }
    );

    const outlinePath = join(WORKSPACE_PATH, "series", "outline.md");
    assert.strictEqual(result.details.status, "success");
    assert.strictEqual(fetchMock.calls.length, 1, "should call LLM once");
    assert.ok(existsSync(outlinePath), "outline.md should be written");
    assert.ok(readFileSync(outlinePath, "utf-8").includes("Ash Under the Gate"));
    assert.strictEqual(result.details.fullOutline.path, outlinePath);
  });

  it("rejects deprecated outline_to_chapter_outlines mode (P22)", async () => {
    writeFileSync(join(WORKSPACE_PATH, "series", "outline.md"), GENERATED_FULL_OUTLINE, "utf-8");
    fetchMock = installFetchQueue([]);

    const tool = fakePi.tools.get("novel_plan_story_outline");
    const result = await tool.execute(
      "test-tool-call",
      {
        workspaceId: WORKSPACE_ID,
        mode: "outline_to_chapter_outlines",
        startChapter: 1,
        endChapter: 2,
        eventCount: 3,
      },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT }
    );

    // P22: 旧模式必须被硬拒绝，不得生成 ch*-outline-explicit.md
    assert.strictEqual(result.details.status, "error");
    assert.strictEqual(result.details.errorCode, "MODE_DEPRECATED");
    assert.strictEqual(result.details.llmUsed, false);
    assert.strictEqual(fetchMock.calls.length, 0, "deprecated mode must not call LLM");

    const chapterOnePath = join(WORKSPACE_PATH, "series", "ch1-outline-explicit.md");
    const chapterTwoPath = join(WORKSPACE_PATH, "series", "ch2-outline-explicit.md");
    assert.ok(!existsSync(chapterOnePath), "deprecated mode must not write ch1-outline-explicit.md");
    assert.ok(!existsSync(chapterTwoPath), "deprecated mode must not write ch2-outline-explicit.md");
    assert.ok(result.details.suggestion.includes("novel_generate_chapter"));
  });

  it("rejects deprecated full_pipeline mode (P22)", async () => {
    fetchMock = installFetchQueue([]);

    const tool = fakePi.tools.get("novel_plan_story_outline");
    const result = await tool.execute(
      "test-tool-call",
      {
        workspaceId: WORKSPACE_ID,
        mode: "full_pipeline",
        idea: "A gate tax clerk discovers a vanished sect token hidden inside city debts.",
        totalChapters: 3,
      },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT }
    );

    assert.strictEqual(result.details.status, "error");
    assert.strictEqual(result.details.errorCode, "MODE_DEPRECATED");
    assert.strictEqual(result.details.llmUsed, false);
    assert.strictEqual(fetchMock.calls.length, 0, "deprecated mode must not call LLM");

    const outlinePath = join(WORKSPACE_PATH, "series", "outline.md");
    assert.ok(!existsSync(outlinePath), "deprecated full_pipeline must not write outline.md");
  });
});
