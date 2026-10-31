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
      model: "gemini-3.8-flash",
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
      model: "gemini-3.8-flash",
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
        model: "gemini-3.8-flash",
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

const FIVE_ELEMENT_HEADINGS = ["【角色】", "【指令】", "【约束】", "【示例】", "【输出格式】"];

/** R07：生产模型实参必须在系统与用户两层按固定顺序出现五要素。 */
function assertFiveElementStructure(prompt, label) {
  const positions = FIVE_ELEMENT_HEADINGS.map((heading) => prompt.indexOf(heading));
  for (let index = 0; index < FIVE_ELEMENT_HEADINGS.length; index += 1) {
    assert.ok(positions[index] >= 0, `${label} 缺少 ${FIVE_ELEMENT_HEADINGS[index]}`);
    assert.equal(
      prompt.lastIndexOf(FIVE_ELEMENT_HEADINGS[index]),
      positions[index],
      `${label} 的 ${FIVE_ELEMENT_HEADINGS[index]} 只能出现一次`,
    );
    if (index > 0) {
      assert.ok(
        positions[index - 1] < positions[index],
        `${label} 的五要素顺序错误：${FIVE_ELEMENT_HEADINGS[index - 1]} 必须在 ${FIVE_ELEMENT_HEADINGS[index]} 之前`,
      );
    }
  }
  return positions;
}

const PREFIX = "作者已确认的前缀。";
const APPEND_SOURCE = `${PREFIX}\n\n${DRAFT}`;

function makeBranchInput(overrides = {}) {
  return makeInput({
    sourceCandidate: { id: "agentic-branch", text: APPEND_SOURCE },
    ...overrides,
  });
}

const PRODUCTION_PROMPT_BRANCHES = [
  ["replace-initial", makeBranchInput()],
  ["append-initial", makeBranchInput({
    continuationMode: "append",
    currentChapterDraft: PREFIX,
  })],
  ["drift-retry", makeBranchInput({
    driftFeedback: {
      replacedEvents: [
        {
          subject: "沈砚",
          rawSentence: "他接过催缴单，离开了走廊。",
          editorialSentence: "他看向催缴单，走进了走廊。",
          reason: "动作类别被替换",
        },
      ],
      stateChangeLosses: [
        {
          subject: "沈砚",
          afterState: "已离开走廊",
          rawSentence: "离开了走廊。",
          reason: "状态变化被漏掉",
        },
      ],
    },
  })],
  ["fact-guard-recovery", makeBranchInput({
    recoveryFeedback: {
      kind: "fact_guard",
      previousEditorialText: "上一轮未通过的优化稿。",
      findings: [{ code: "unauthorized_fact", message: "出现未授权事实" }],
    },
  })],
  ["completeness-recovery-append", makeBranchInput({
    continuationMode: "append",
    currentChapterDraft: PREFIX,
    recoveryFeedback: {
      kind: "completeness",
      previousEditorialText: "上一轮截断的优化稿。",
      findings: [{ code: "truncated_output", message: "输出被截断" }],
    },
  })],
  ["prefix-recovery-append", makeBranchInput({
    continuationMode: "append",
    currentChapterDraft: PREFIX,
    continuationPrefixRecovery: true,
  })],
  ["echo-recovery-replace", makeBranchInput({ completeChapterEchoRecovery: true })],
  ["echo-recovery-append", makeBranchInput({
    continuationMode: "append",
    currentChapterDraft: PREFIX,
    completeChapterEchoRecovery: true,
  })],
  ["strategy-and-word-target", makeBranchInput({
    targetWordCount: { min: 2000, max: 3200 },
    reducedGuidanceRatio: 0.5,
    strategyParams: {
      reducedGuidanceRatio: 0.5,
      voiceEmphasisBlock: "【人物声音强调】保持角色说话习惯，不指定台词内容。",
      rhythmAdjustmentBlock: "【段落节奏调整】按叙事需要自由调节段落长短。",
    },
  })],
];

test("R07：全部生产 prompt 分支按五要素固定顺序组织，恢复与续写指令均为中文", () => {
  assertFiveElementStructure(STYLE_SYSTEM_PROMPT, "system prompt");
  assert.match(STYLE_SYSTEM_PROMPT, /没有逐句替换义务/);
  assert.doesNotMatch(STYLE_SYSTEM_PROMPT, /逐句做同义改写/);

  for (const [label, input] of PRODUCTION_PROMPT_BRANCHES) {
    const userPrompt = buildAuthorStyleUserPrompt(input, {
      referenceIds: [],
      guidance: ["保持表达自然。"],
    });
    assertFiveElementStructure(userPrompt, label);
    assert.doesNotMatch(
      userPrompt,
      /CONTINUATION PREFIX RECOVERY|COMPLETE CHAPTER ECHO RECOVERY|APPEND MODE RULE|OUTPUT CONTRACT|INSTRUCTION/,
      `${label} 仍有英文指令标题`,
    );
    assert.equal(
      auditPrompt(STYLE_SYSTEM_PROMPT, userPrompt).type,
      "editorial",
      `${label} 不得被审计成机械控制型 prompt`,
    );
    const exampleStart = userPrompt.indexOf("【示例】");
    const outputStart = userPrompt.indexOf("【输出格式】");
    const exampleBlock = userPrompt.slice(exampleStart, outputStart);
    assert.ok(exampleBlock.length > 0, `${label} 必须有示例段`);
    assert.ok(
      !exampleBlock.includes("沈砚") && !exampleBlock.includes("催缴单"),
      `${label} 的示例段不得包含可仿写的具体正文`,
    );
  }
});
