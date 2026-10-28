/** Structured recovery evidence must reach the first Agentic draft prompt. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = join(__dirname, "..");

async function importDist(relativePath) {
  return import(pathToFileURL(join(EXT_ROOT, "dist", relativePath)).href);
}

function makeLoop(NarrativeAgentLoop) {
  const prompts = [];
  const runtime = {
    agent: { state: { messages: [] } },
    subscribe() {},
    async prompt(prompt) {
      prompts.push(prompt);
      this.agent.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "修复后的完整章节正文。" }],
      });
    },
    async waitForIdle() {},
  };
  const noOp = new Proxy({}, { get: () => () => {} });
  const loop = new NarrativeAgentLoop({
    runtime,
    registry: {},
    searchService: {},
    candidateWorkspace: noOp,
    permissionPolicy: {},
    budget: {
      isExhausted: () => false,
      getSnapshot: () => ({ turns: prompts.length, toolCalls: 0 }),
    },
    trajectory: noOp,
  });
  return { loop, prompts };
}

describe("Agentic recoveryDirective", () => {
  for (const recover of [false, true]) {
    it(`requests only the new suffix for append${recover ? ' recovery' : ''}`, async () => {
      const { NarrativeAgentLoop } = await importDist("novelos/agent/narrative-agent-loop.js");
      const { loop, prompts } = makeLoop(NarrativeAgentLoop);
      await loop.run({
        chapterIntent: "承接已有正文。", seedContext: "seed", context: {},
        continuationMode: "append", currentChapterDraft: "作者第一段。\r\n作者第二段。",
        ...(recover ? { recoveryDirective: {
          kind: "fact_guard", previousCandidateText: "上一候选。",
          findings: [{ code: "prefix_mismatch", message: "前缀已改写" }],
        } } : {}),
      });
      assert.match(prompts[0], /只输出新增后缀正文/);
      assert.doesNotMatch(prompts[0], /如输出完整本章正文|只输出修复后的完整章节正文/);
      assert.match(prompts[0], /作者第一段。\r\n作者第二段。/);
    });
  }

  it("is shared by AgenticRawSourceInput and AgentLoopInput and forwarded to the loop", () => {
    const source = readFileSync(
      join(EXT_ROOT, "novelos", "agent", "agentic-raw-candidate-source.ts"),
      "utf8",
    );
    const loopTypes = readFileSync(
      join(EXT_ROOT, "novelos", "agent", "narrative-agent-loop-types.ts"),
      "utf8",
    );

    assert.match(source, /recoveryDirective\?\s*:\s*RecoveryDirective/);
    assert.match(loopTypes, /recoveryDirective\?\s*:\s*RecoveryDirective/);
    assert.match(source, /loop\.run\(\{[\s\S]*?recoveryDirective[\s\S]*?\}\)/);
  });

  it("injects bounded FactGuard evidence into the first prompt and requests a complete new candidate", async () => {
    const { NarrativeAgentLoop } = await importDist("novelos/agent/narrative-agent-loop.js");
    const { loop, prompts } = makeLoop(NarrativeAgentLoop);
    const findings = Array.from({ length: 9 }, (_, index) => ({
      code: `FG-${index + 1}`,
      message: index === 0 ? "未授权高影响新设定：深处的二级" : `结构化问题 ${index + 1}`,
      evidenceRef: `diag:fact_guard:${index + 1}`,
      ignoredInternalField: `不得进入提示词-${index + 1}`,
    }));

    await loop.run({
      chapterIntent: "完成第十七章冲突。",
      seedContext: "只使用已确认设定。",
      context: {},
      recoveryDirective: {
        kind: "fact_guard",
        previousCandidateText: "上一候选正文第一段。\n\n上一候选正文第二段。",
        findings,
      },
    });

    assert.equal(prompts.length, 1);
    const prompt = prompts[0];
    assert.match(prompt, /【候选恢复任务：FactGuard】/);
    assert.match(prompt, /修复上一候选并输出完整新候选/);
    assert.match(prompt, /上一候选正文第一段。[\s\S]*上一候选正文第二段。/);
    assert.match(prompt, /FG-1[\s\S]*未授权高影响新设定：深处的二级[\s\S]*diag:fact_guard:1/);
    assert.match(prompt, /FG-8/);
    assert.doesNotMatch(prompt, /FG-9/);
    assert.doesNotMatch(prompt, /不得进入提示词/);
  });

  it("labels verifier recovery separately while preserving the same complete-candidate contract", async () => {
    const { NarrativeAgentLoop } = await importDist("novelos/agent/narrative-agent-loop.js");
    const { loop, prompts } = makeLoop(NarrativeAgentLoop);

    await loop.run({
      chapterIntent: "承接前章。",
      seedContext: "seed",
      context: {},
      recoveryDirective: {
        kind: "verifier",
        previousCandidateText: "待修复候选。",
        findings: [{ code: "duplicate_pollution", message: "存在大段重复" }],
      },
    });

    assert.match(prompts[0], /【候选恢复任务：Narrative Verifier】/);
    assert.match(prompts[0], /修复上一候选并输出完整新候选/);
  });
});
