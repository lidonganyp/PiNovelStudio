/**
 * Author-style recovery feedback must turn final gate failures into a bounded,
 * full-chapter retry prompt without treating the failed editorial draft as canon.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  buildAuthorStyleUserPrompt,
  collectAuthorStyleGuidance,
  createAuthorStyleOptimizer,
} from "../dist/v2/core/author-style-optimizer.js";
import { getInputFieldWhitelist } from "../dist/v2/core/agent-input-whitelist.js";

const AGENTIC_RAW = "叶尘依照既定计划进入石室，确认封印仍然完整。";

function makeInput(recoveryFeedback) {
  return {
    sourceCandidate: { id: "agentic-17", text: AGENTIC_RAW },
    chapterNumber: 17,
    intent: {
      authorEventSummaries: [],
      authorMustInclude: [],
      authorStateChanges: [],
      causalRelations: [],
      endingTarget: [],
      relevantCharacters: ["叶尘"],
      inviolableFacts: ["封印仍然完整"],
    },
    context: { styleReferences: [] },
    constitution: null,
    modelGenerate: async () => ({ text: "", model: "test" }),
    recoveryFeedback,
  };
}

for (const recoveryKind of [undefined, "fact_guard", "completeness"]) {
  test(`append style output contract stays suffix-only during ${recoveryKind ?? "initial optimization"}`, async () => {
    const prefix = "作者已确认的前缀。";
    const input = {
      ...makeInput(recoveryKind ? {
        kind: recoveryKind,
        previousEditorialText: "未通过的优化稿。",
        findings: [{ code: "test_failure", message: "需要定向修复" }],
      } : undefined),
      continuationMode: "append",
      currentChapterDraft: prefix,
      sourceCandidate: { id: "append-source", text: `${prefix}\n\n${AGENTIC_RAW}` },
      context: { styleReferences: [{
        id: "style",
        kind: "fingerprint",
        content: JSON.stringify({ editorialGuidance: ["保持表达自然。"] }),
      }] },
    };
    let request;
    await createAuthorStyleOptimizer().optimize({
      ...input,
      modelGenerate: async (value) => {
        request = value;
        return { text: AGENTIC_RAW, model: "test" };
      },
    });
    assert.ok(request);
    assert.match(request.userPrompt.split("\n\n").at(-1), /只改表达，不改事件、动作和因果。.*只输出.*新正文后缀/);
    for (const prompt of [request.systemPrompt, request.userPrompt]) {
      assert.doesNotMatch(prompt, /只输出优化后的完整章节正文|请优化第 17 章完整正文|生成修复后的完整章节正文|从正文第一段开始写到完整章末/);
    }
    assert.match(request.userPrompt, /主程序|host/i);
  });
}

test("replace style final instruction retains the factual boundary and complete output contract", () => {
  const prompt = buildAuthorStyleUserPrompt(makeInput(), { referenceIds: [], guidance: [] });
  assert.match(prompt.split("\n\n").at(-1), /只改表达，不改事件、动作和因果。.*只输出优化后的完整正文/);
});

test("append style source excludes the protected prefix when the provider normalizes line endings", () => {
  const prompt = buildAuthorStyleUserPrompt({
    ...makeInput(),
    continuationMode: "append",
    currentChapterDraft: "作者第一段。\r\n作者第二段。",
    sourceCandidate: { id: "append-source", text: `作者第一段。\n作者第二段。\n\n${AGENTIC_RAW}` },
  }, { referenceIds: [], guidance: [] });
  const source = prompt.split("【NovelOS Agentic 初稿（仅供表达优化）】")[1].split("【作者风格档案")[0];
  assert.doesNotMatch(source, /作者第一段|作者第二段/);
  assert.match(source, /叶尘/);
});

test("author_style 工作包白名单允许结构化恢复反馈", () => {
  assert.ok(getInputFieldWhitelist("author_style").includes("recoveryFeedback"));
});

test("风格档案中的历史比例/清单指导不会触发机械控制审计", () => {
  const guidance = collectAuthorStyleGuidance({
    styleReferences: [{
      id: "legacy-style",
      kind: "fingerprint",
      content: JSON.stringify({
        editorialGuidance: [
          "对白比例保持在30%",
          "每段不少于80字",
          "用冷静的动作和可见后果承载情绪",
        ],
      }),
    }],
  }, []);
  assert.deepEqual(guidance.guidance, ["[通用] 用冷静的动作和可见后果承载情绪"]);
});

test("fact_guard 恢复提示以 Agentic raw 为事实底稿并要求只返回修复后的完整正文", () => {
  const prompt = buildAuthorStyleUserPrompt(
    makeInput({
      kind: "fact_guard",
      previousEditorialText: "上一稿擅自写成叶尘突破到二级，导致事实硬伤。",
      findings: [{
        code: "unauthorized_high_impact_setting",
        message: "正文出现未授权的境界跃迁",
        evidenceRef: "diag:unauthorized_high_impact_setting:0",
      }],
    }),
    { referenceIds: [], guidance: [] },
  );

  assert.match(prompt, /最终事实复检|事实问题/);
  assert.match(prompt, /unauthorized_high_impact_setting/);
  assert.match(prompt, /正文出现未授权的境界跃迁/);
  assert.match(prompt, /diag:unauthorized_high_impact_setting:0/);
  assert.match(prompt, /上一稿擅自写成叶尘突破到二级/);
  assert.match(prompt, /Agentic 初稿.*事实底稿|基于.*Agentic 初稿/s);
  assert.match(prompt, /完整章节正文|完整正文/);
  assert.match(prompt, /只输出.*正文/s);
  assert.match(prompt, /不得.*补丁|不是补丁/);
  assert.match(prompt, /不得.*解释|不是.*解释/);
  assert.ok(prompt.indexOf("事实问题") < prompt.indexOf("【NovelOS Agentic 初稿】"));
});

test("completeness 恢复提示明确上一稿截断并要求从首段到章末重新输出完整章节", () => {
  const prompt = buildAuthorStyleUserPrompt(
    makeInput({
      kind: "completeness",
      previousEditorialText: "叶尘刚要推开石门，忽然",
      findings: [{
        code: "dangling_ending",
        message: "结尾停在未完成句，疑似输出截断",
        evidenceRef: "final_text_completeness:0",
      }],
    }),
    { referenceIds: [], guidance: [] },
  );

  assert.match(prompt, /输出截断|不完整|悬空结尾/);
  assert.match(prompt, /dangling_ending/);
  assert.match(prompt, /结尾停在未完成句/);
  assert.match(prompt, /从正文第一段.*章末|从首段.*章末/s);
  assert.match(prompt, /不是只续写尾部|不得只.*尾部|不只补写结尾/);
  assert.match(prompt, /只输出.*正文/s);
});

test("恢复反馈最多消费八条且 previousEditorialText/code/message/evidenceRef 均有单字段长度上限", () => {
  const findings = Array.from({ length: 9 }, (_, index) => ({
    code: index === 0
      ? `code-prefix-${"c".repeat(2000)}-CODE-TAIL-MUST-NOT-APPEAR`
      : `finding-${index + 1}`,
    message: index === 0
      ? `message-prefix-${"m".repeat(5000)}-MESSAGE-TAIL-MUST-NOT-APPEAR`
      : `message-${index + 1}`,
    evidenceRef: index === 0
      ? `ref-prefix-${"r".repeat(3000)}-REF-TAIL-MUST-NOT-APPEAR`
      : `evidence-${index + 1}`,
  }));
  const prompt = buildAuthorStyleUserPrompt(
    makeInput({
      kind: "fact_guard",
      previousEditorialText: `previous-prefix-${"p".repeat(30000)}-PREVIOUS-TAIL-MUST-NOT-APPEAR`,
      findings,
    }),
    { referenceIds: [], guidance: [] },
  );

  assert.match(prompt, /previous-prefix/);
  assert.match(prompt, /code-prefix/);
  assert.match(prompt, /message-prefix/);
  assert.match(prompt, /ref-prefix/);
  assert.match(prompt, /finding-8/);
  assert.doesNotMatch(prompt, /finding-9/);
  assert.doesNotMatch(prompt, /CODE-TAIL-MUST-NOT-APPEAR/);
  assert.doesNotMatch(prompt, /MESSAGE-TAIL-MUST-NOT-APPEAR/);
  assert.doesNotMatch(prompt, /REF-TAIL-MUST-NOT-APPEAR/);
  assert.doesNotMatch(prompt, /PREVIOUS-TAIL-MUST-NOT-APPEAR/);
  assert.ok(prompt.length < 20000, `bounded recovery prompt expected, got ${prompt.length} chars`);
});

test("恢复候选 ID 区分首次候选并绑定恢复类型与输出正文 hash", async () => {
  const outputText = "叶尘依照既定计划进入石室，确认封印仍然完整，然后安全离开。";
  const optimizer = createAuthorStyleOptimizer();
  const styleReferences = [{
    id: "style-profile",
    kind: "fingerprint",
    content: JSON.stringify({ editorialGuidance: ["保持叙事克制，动作清晰。"] }),
  }];
  const modelGenerate = async () => ({
    text: outputText,
    model: "test-model",
    route: "v2_amplified_gemini31",
    durationMs: 1,
  });
  const first = await optimizer.optimize({
    ...makeInput(undefined),
    context: { styleReferences },
    modelGenerate,
  });
  const factRecovery = await optimizer.optimize({
    ...makeInput({
      kind: "fact_guard",
      previousEditorialText: "失败稿。",
      findings: [{ code: "fact", message: "事实错误", evidenceRef: "fact:0" }],
    }),
    context: { styleReferences },
    modelGenerate,
  });
  const completenessRecovery = await optimizer.optimize({
    ...makeInput({
      kind: "completeness",
      previousEditorialText: "截断稿。",
      findings: [{ code: "truncated", message: "输出截断", evidenceRef: "complete:0" }],
    }),
    context: { styleReferences },
    modelGenerate,
  });

  assert.ok(first.candidate && factRecovery.candidate && completenessRecovery.candidate);
  const hashPrefix = createHash("sha256").update(outputText, "utf8").digest("hex").slice(0, 16);
  assert.notEqual(factRecovery.candidate.id, first.candidate.id);
  assert.notEqual(factRecovery.candidate.id, completenessRecovery.candidate.id);
  assert.match(factRecovery.candidate.id, /fact_guard/);
  assert.match(completenessRecovery.candidate.id, /completeness/);
  assert.match(factRecovery.candidate.id, new RegExp(hashPrefix));
  assert.match(completenessRecovery.candidate.id, new RegExp(hashPrefix));
});
