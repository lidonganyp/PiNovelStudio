/** ExpectationLedger production consumption stays selective, read-only, and outside the raw prompt. */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(testDir, "..");
const projectRoot = resolve(extensionRoot, "..", "..", "..");
const workspaceId = "expectation-ledger-production-consumer-test";
const workspacePath = join(projectRoot, "workspaces", workspaceId);

function expectation(id, status, description, targetReaderExperience, sourceChapter = "ch0") {
  return {
    id: `expectation:${id}`,
    kind: "expectation",
    expectationId: id,
    description,
    targetReaderExperience,
    status,
    ...(status === "delayed" ? { delayReason: "等待本章压力成熟" } : {}),
    sourceChapter,
    sourceRef: `${sourceChapter}#finalText:0123456789ab:0-8`,
    confidence: 0.9,
    lastUpdated: "2026-07-20T00:00:00.000Z",
  };
}

function writeWorkspace(expectations) {
  rmSync(workspacePath, { recursive: true, force: true });
  mkdirSync(join(workspacePath, "characters"), { recursive: true });
  mkdirSync(join(workspacePath, "series"), { recursive: true });
  mkdirSync(join(workspacePath, "chapters"), { recursive: true });

  writeFileSync(join(workspacePath, "config.json"), JSON.stringify({
    name: "期待账本生产消费测试",
    genre: "都市恐怖",
    subGenres: ["悬疑"],
    totalChapters: 20,
    targetWordCount: { perChapter: { min: 1800, max: 2600 } },
    characters: [{ id: "protagonist", name: "林默", role: "protagonist" }],
    chapterSeeds: {
      default: {
        choicesAndCosts: [{ choice: "进入异常走廊", cost: "暴露自己的调查意图" }],
        expectedIrreversibleChange: ["林默确认异常会主动模仿活人"],
        causalEndPressure: ["模仿者开始使用林默的声音"],
      },
    },
  }, null, 2), "utf-8");
  writeFileSync(
    join(workspacePath, "characters", "protagonist.md"),
    "# 林默\n\n主角，正在调查会模仿活人的异常走廊。\n",
    "utf-8",
  );
  writeFileSync(
    join(workspacePath, "series", "outline.md"),
    "# 故事方向\n\n林默调查异常走廊，并承担主动验证规则的代价。\n",
    "utf-8",
  );
  writeFileSync(join(workspacePath, "narrative-state-store.json"), JSON.stringify({
    schemaVersion: 1,
    workspaceId,
    canon: [{
      id: "canon:setup",
      kind: "canon",
      fact: "异常走廊会模仿活人的声音",
      category: "ability_rule",
      sourceChapter: "ch0",
      sourceRef: "ch0#finalText:0123456789ab:0-8",
      confidence: 0.9,
      lastUpdated: "2026-07-20T00:00:00.000Z",
    }],
    character: [],
    promise: [],
    pattern: [],
    expectation: expectations,
    updatedAt: "2026-07-20T00:00:00.000Z",
  }, null, 2), "utf-8");
}

async function runEntry() {
  process.env.V2_FORCE_STUB = "1";
  const { runUnifiedPipeline } = await import(
    pathToFileURL(join(extensionRoot, "dist", "v2", "core", "unified-entry.js")).href
  );
  return runUnifiedPipeline({
    workspaceId,
    chapterId: "expectation-consumer-1",
    chapterNumber: 1,
    projectRoot,
    fullPipelinePreview: true,
  });
}

before(() => {
  process.env.PINOVEL_DEV_MODE = "1";
});

after(() => {
  rmSync(workspacePath, { recursive: true, force: true });
  delete process.env.V2_FORCE_STUB;
});

test("unified entry selects at most three active relevant expectations without raw-prompt consumption", async () => {
  writeWorkspace([
    expectation("exp-escalated", "escalated", "异常走廊的规则压力升级", "好奇"),
    expectation("exp-delayed", "delayed", "验证模仿者身份的期待延期", "好奇"),
    expectation("exp-advanced", "advanced", "林默主动验证规则后获得认知变化", "温馨"),
    expectation("exp-advanced-irrelevant", "advanced", "远方商队的价格变化", "轻松"),
    expectation("exp-open", "open", "走廊尽头还有什么", "好奇"),
    expectation("exp-fulfilled", "fulfilled", "已经兑现的旧门牌谜题", "好奇"),
    expectation("exp-future", "escalated", "未来章节才出现的期待", "好奇", "ch1"),
  ]);

  const result = await runEntry();
  assert.equal(result.status, "ok");

  const expectationContext = result.stageResults.expectationContext;
  assert.deepEqual(
    expectationContext.entries.map((entry) => entry.expectationId),
    ["exp-escalated", "exp-delayed", "exp-advanced"],
  );
  assert.ok(expectationContext.entries.length <= 3);
  assert.equal(expectationContext.entries.some((entry) => entry.expectationId === "exp-fulfilled"), false);
  assert.equal(expectationContext.entries.some((entry) => entry.expectationId === "exp-future"), false);
  assert.equal(expectationContext.consumedByRawPrompt, false);
  assert.equal(
    result.stageResults.chapterIntent.consumedFields.includes("expectationContext"),
    false,
  );
  assert.deepEqual(
    result.stageResults.chapterIntent.fieldSourceRefs.selectedExpectationsToAdvance,
    ["chapter-seed:openExpectations", "narrative-state:expectation"],
  );
});

test("fulfilled-only ExpectationLedger remains an explicit no-op", async () => {
  writeWorkspace([
    expectation("exp-fulfilled-a", "fulfilled", "旧期待已经兑现", "好奇"),
    expectation("exp-fulfilled-b", "fulfilled", "另一条旧期待已经兑现", "温馨"),
  ]);

  const result = await runEntry();
  assert.equal(result.status, "ok");
  assert.deepEqual(result.stageResults.expectationContext.entries, []);
  assert.match(result.stageResults.expectationContext.emptyReason, /期待|selectedExpectationsToAdvance/);
  assert.equal(result.stageResults.expectationContext.consumedByRawPrompt, false);
});
