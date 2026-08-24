/**
 * 作者风格优化必须只改表达，不改事件、动作和因果。
 *
 * 生产失败证据：Gemini 风格优化把关键动作换成另一类动作
 * （交出→看、拿起→放下），故事保持门禁 hard block。
 * 系统 prompt 与 user prompt 都必须把这条边界写死，且出现在初稿之前。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  STYLE_SYSTEM_PROMPT,
  buildAuthorStyleUserPrompt,
  collectAuthorStyleGuidance,
  createAuthorStyleOptimizer,
} from "../dist/v2/core/author-style-optimizer.js";
import { auditPrompt } from "../dist/v2/core/prompt-constraint-audit.js";
import { TEST_STYLE_REFERENCES } from "./test-style-fingerprint.mjs";

const DRAFT = "沈砚推开病房门，走了进去。他接过催缴单，离开了走廊。";

function makeInput(overrides = {}) {
  return {
    sourceCandidate: {
      id: "agentic-1",
      text: DRAFT,
      source: "agentic",
      model: "gemini-3.7-flash",
    },
    chapterNumber: 1,
    intent: {
      chapterFunction: "推进冲突",
      readerExperience: [],
      currentPressure: [],
      meaningfulChoices: [],
      promisesToAdvance: [],
      possibleEndPressure: [],
      relevantCharacters: ["沈砚"],
      inviolableFacts: [],
      sourceRefs: [],
    },
    context: { styleReferences: TEST_STYLE_REFERENCES },
    constitution: null,
    modelGenerate: async () => ({
      text: DRAFT,
      model: "gemini-3.7-flash",
      route: "v2_amplified_gemini31",
      durationMs: 1,
    }),
    ...overrides,
  };
}

test("系统 prompt 明确只改表达，不改事件、动作和因果", () => {
  assert.match(STYLE_SYSTEM_PROMPT, /只改表达/);
  assert.match(STYLE_SYSTEM_PROMPT, /不改事件/);
  assert.match(STYLE_SYSTEM_PROMPT, /不改动作/);
  assert.match(STYLE_SYSTEM_PROMPT, /不改因果/);
  assert.match(STYLE_SYSTEM_PROMPT, /交出≠看/);
  assert.match(STYLE_SYSTEM_PROMPT, /看不见≠看得见/);
  assert.match(STYLE_SYSTEM_PROMPT, /不得重复|只出现一次/);
});

test("首次优化的 user prompt 在初稿之前写入表达硬边界", () => {
  const guidance = collectAuthorStyleGuidance(
    { styleReferences: TEST_STYLE_REFERENCES },
    ["沈砚"],
  );
  const userPrompt = buildAuthorStyleUserPrompt(makeInput(), guidance);
  const boundaryAt = userPrompt.indexOf("【表达优化硬边界】");
  const draftAt = userPrompt.indexOf("【NovelOS Agentic 初稿】");
  assert.ok(boundaryAt >= 0, "必须有表达优化硬边界");
  assert.ok(draftAt >= 0, "必须包含初稿");
  assert.ok(boundaryAt < draftAt, "硬边界必须出现在初稿之前");
  assert.match(userPrompt, /只改表达，不改事件、动作和因果/);
  assert.match(userPrompt, /交出≠看/);
  assert.match(userPrompt, /拿起≠放下/);
  assert.match(userPrompt, /离开≠走进/);
  assert.match(userPrompt, /不得重复|只出现一次/);
});

test("表达硬边界不得被审计成机械控制型 prompt", () => {
  const guidance = collectAuthorStyleGuidance(
    { styleReferences: TEST_STYLE_REFERENCES },
    ["沈砚"],
  );
  const userPrompt = buildAuthorStyleUserPrompt(makeInput(), guidance);
  const profile = auditPrompt(STYLE_SYSTEM_PROMPT, userPrompt);
  assert.equal(profile.type, "editorial");
});

test("optimize 把表达硬边界送进模型，而不是只写在注释里", async () => {
  let captured = null;
  const optimizer = createAuthorStyleOptimizer();
  await optimizer.optimize(makeInput({
    modelGenerate: async (input) => {
      captured = input;
      return {
        text: DRAFT,
        model: "gemini-3.7-flash",
        route: "v2_amplified_gemini31",
        durationMs: 1,
      };
    },
  }));
  assert.ok(captured, "必须调用模型");
  assert.match(captured.systemPrompt, /只改表达/);
  assert.match(captured.systemPrompt, /不改动作/);
  assert.match(captured.userPrompt, /【表达优化硬边界】/);
  assert.ok(
    captured.userPrompt.indexOf("【表达优化硬边界】")
      < captured.userPrompt.indexOf("【NovelOS Agentic 初稿】"),
  );
});
