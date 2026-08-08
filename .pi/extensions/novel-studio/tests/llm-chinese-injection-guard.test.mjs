/**
 * LLM 中文注入硬门禁回归。
 *
 * 所有送入模型的 system/user/tool 文本不得含 ASCII 英文字母。内部类型、路由名、
 * trace 字段可继续使用英文标识，但必须在模型边界前转换为中文视图。
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildRawPrompt } from "../dist/v2/core/orchestrator-raw.js";
import {
  formatPromiseContextPromptBlock,
} from "../dist/v2/core/promise-context-compiler.js";
import {
  formatDialogueCraftPromptBlock,
} from "../dist/v2/core/dialogue-craft-compiler.js";
import {
  buildJudgePrompt,
  parseJudgeVerdict,
} from "../dist/v2/core/judge-prompt-builder.js";
import {
  EditorialOpportunityJudge,
} from "../dist/v2/core/editorial-opportunity-judge.js";
import {
  injectToolSchemas,
} from "../dist/novelos/adapters/tool-schema-injector.js";
import {
  formatToolResultsForPrompt,
  parseToolCallDirectives,
} from "../dist/novelos/adapters/react-tool-call-parser.js";
import {
  createRealGpt56SolReleaseProxyApprovalCallerFromEnv,
} from "../dist-test/v2/governance/proxy-approval-caller.js";
import { RoutedChatAPI } from "../dist/api/routed-chat.js";
import { GPTAPI } from "../dist/api/gpt.js";
import { GLMAPI } from "../dist/api/glm.js";
import { ClaudeAPI } from "../dist/api/claude.js";
import { callJudgeModel } from "../dist-eval/novelos/eval/judge-model-adapter.js";
import {
  callOpenAIChatCompletions,
  createOpenAIChatCompletionsFn,
} from "../dist-test/v2/governance/chapter-proxy-approval-caller.js";
import { createPairwiseLiteraryJudge } from "../dist/v2/core/pairwise-literary-judge.js";
import {
  localizeLlmText,
  locateLlmExcerpt,
} from "../dist/utils/llm-language-guard.js";

const LATIN_LETTER = /[A-Za-z]/;
const originalFetch = globalThis.fetch;
const originalJudgeEnv = {
  key: process.env.NOVELOS_JUDGE_API_KEY,
  base: process.env.NOVELOS_JUDGE_BASE_URL,
  model: process.env.NOVELOS_JUDGE_MODEL,
};

function assertNoEnglish(label, ...texts) {
  const joined = texts.filter((value) => typeof value === "string").join("\n");
  const match = joined.match(LATIN_LETTER);
  assert.equal(
    match,
    null,
    `${label} 含英文字母 ${match?.[0] ?? ""}：${joined.slice(Math.max(0, (match?.index ?? 0) - 40), (match?.index ?? 0) + 80)}`,
  );
}

function makeIntent(overrides = {}) {
  return {
    chapterFunction: "推进核心冲突",
    readerExperience: ["紧张", "期待"],
    currentPressure: ["暗流逼近"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["林川"],
    inviolableFacts: ["暗流不能凭空消失"],
    sourceRefs: [],
    concreteDelivery: [],
    focusCharacterGoals: [],
    resistance: [],
    choicesAndCosts: [],
    expectedIrreversibleChange: [],
    selectedPromisesToAdvance: [],
    causalEndPressure: [],
    factAndCharacterKnowledgeForbiddenZones: [],
    ...overrides,
  };
}

function makeCandidate(id, kind, text) {
  return {
    id,
    kind,
    text,
    model: "测试模型",
    route: "测试路由",
    promptProfile: {
      type: kind === "editorial_amplified" ? "editorial" : "control",
      tokensIn: 0,
      containsDialogueRatio: false,
      containsParagraphLengthConstraint: false,
      containsControlChecklist: false,
      containsMechanicalMetric: false,
      contractIds: [],
    },
    contextHash: "测试摘要",
    generatedAt: "2026-07-18T00:00:00.000Z",
    durationMs: 1,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalJudgeEnv.key === undefined) delete process.env.NOVELOS_JUDGE_API_KEY;
  else process.env.NOVELOS_JUDGE_API_KEY = originalJudgeEnv.key;
  if (originalJudgeEnv.base === undefined) delete process.env.NOVELOS_JUDGE_BASE_URL;
  else process.env.NOVELOS_JUDGE_BASE_URL = originalJudgeEnv.base;
  if (originalJudgeEnv.model === undefined) delete process.env.NOVELOS_JUDGE_MODEL;
  else process.env.NOVELOS_JUDGE_MODEL = originalJudgeEnv.model;
});

test("承诺与对白上下文注入只使用中文状态、动作和诊断元数据", () => {
  const promiseBlock = formatPromiseContextPromptBlock({
    entries: [{
      promiseId: "承诺一",
      description: "暗流来源",
      status: "advancing",
      relevanceReason: "本章继续推进",
      expectedAction: "advance",
      sourceRef: "内部来源",
      confidence: 0.7,
    }],
    sourceRefs: [],
    consumedByRawPrompt: true,
  });
  const dialogueBlock = formatDialogueCraftPromptBlock({
    speakingCharacters: [{
      characterId: "角色一",
      name: "林川",
      hasFingerprint: true,
      fingerprintSummary: "短句；克制；先行动后解释",
      fingerprintSourceRef: "第十二章接受稿",
      fingerprintSourceType: "accepted_manuscript",
      recoveryMode: "fingerprint",
      sourceRef: "声音指纹来源",
      confidence: 0.7,
    }],
    blindTestEligible: false,
    dialogueCraftAdvisory: [{
      rule: 1,
      ruleName: "对白增量",
      severity: "critical",
      evidence: "连续对白没有新增信息",
      lineIndex: 1,
    }],
    sourceRefs: [],
    consumedByRawPrompt: true,
    advisoryOnly: true,
    canTriggerEditorialOpportunity: true,
  });

  assertNoEnglish("承诺上下文", promiseBlock);
  assertNoEnglish("对白上下文", dialogueBlock);
});

test("默认原始正文提示词在中文输入下不泄漏内部英文术语", () => {
  const intent = makeIntent({
    selectedPromisesToAdvance: [{ promiseId: "承诺一", description: "暗流来源" }],
  });
  const prompt = buildRawPrompt({
    workspaceId: "工作区一",
    chapterId: "第一章",
    chapterNumber: 1,
    projectRoot: ".",
    intent,
    context: {
      facts: [{ id: "事实一", content: "河道下存在暗流", sourceIds: [], kind: "事实" }],
      characterStates: [],
      openLoops: [],
      worldRules: [],
      styleReferences: [],
      sourceMap: [],
      constitution: null,
      longTermState: {
        canon: [],
        character: [],
        promise: [{ promiseId: "承诺一", description: "暗流来源", status: "advancing" }],
        pattern: [],
      },
    },
    constitution: null,
    characterNames: [],
    modelGenerate: async () => ({ text: "", model: "测试模型", route: "测试路由", durationMs: 0 }),
  });

  assertNoEnglish("原始正文系统提示词", prompt.systemPrompt);
  assertNoEnglish("原始正文用户提示词", prompt.userPrompt);
});

test("机会裁判发送中文协议，并能解析中文键值响应", async () => {
  const calls = [];
  const rawText = "林川推开门，发现桌上压着一封没有署名的信。他伸手拿起信，门外忽然响起脚步声。";
  const judge = new EditorialOpportunityJudge();
  const result = await judge.judge({
    rawText,
    intent: makeIntent(),
    longTermState: null,
    constitution: null,
    characterNames: ["林川"],
    modelGenerate: async (input) => {
      calls.push(input);
      return {
        text: JSON.stringify({
          工艺现象: [],
          编辑机会: [{
            机会类型: "章末压力",
            工艺领域: "收尾闭合",
            问题诊断: "脚步声之后缺少更强因果压力",
            证据原文: "门外忽然响起脚步声",
            预期收益: "增强翻页牵引力",
            损伤风险: ["避免凭空增加人物"],
            置信度: 0.8,
          }],
          无操作原因: null,
        }),
        model: "测试模型",
        route: "测试路由",
        durationMs: 0,
      };
    },
  });

  assert.equal(calls.length, 1);
  assertNoEnglish("机会裁判系统提示词", calls[0].systemPrompt);
  assertNoEnglish("机会裁判用户提示词", calls[0].userPrompt);
  assert.equal(result.llmJudged, true);
  assert.equal(result.hypotheses[0]?.opportunityType, "chapter_end_pressure");
});

test("文学裁判发送并解析全中文结构化协议", () => {
  const prompt = buildJudgePrompt({
    candidateAText: "林川推门而入，屋里没有人。",
    candidateBText: "林川推开门，桌上的信还在滴水。",
    mapping: { leftLabel: "A", rightLabel: "B", leftCandidateId: "候选一", rightCandidateId: "候选二" },
    intent: makeIntent(),
    constitution: null,
  });
  assertNoEnglish("文学裁判系统提示词", prompt.systemPrompt);
  assertNoEnglish("文学裁判用户提示词", prompt.userPrompt);

  const verdict = parseJudgeVerdict(JSON.stringify({
    胜者: "乙",
    置信程度: "明确",
    决定性理由: [{
      比较维度: "悬念",
      较优候选: "乙",
      甲方证据: [{ 起点: 0, 终点: 4, 原文: "林川推门" }],
      乙方证据: [{ 起点: 5, 终点: 12, 原文: "桌上的信还在滴水" }],
      说明: "乙方留下更具体的异常信息",
    }],
    事实风险: [],
    退化风险: [],
    宪法对齐: "均未破坏事实",
  }));
  assert.equal(verdict?.winner, "B");
  assert.equal(verdict?.confidence, "clear");
  assert.equal(verdict?.decisiveReasons[0]?.betterCandidate, "B");
});

test("发布代理审批实际网络载荷只含中文协议", async () => {
  process.env.NOVELOS_JUDGE_API_KEY = "测试密钥";
  process.env.NOVELOS_JUDGE_BASE_URL = "https://judge.example.test/v1";
  process.env.NOVELOS_JUDGE_MODEL = "测试模型";
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({
      model: "测试模型",
      choices: [{ message: { content: JSON.stringify({
        verdict: "APPROVE_DEV",
        rationale: "候选明确胜出",
        winningSpans: [],
        losingSpans: [],
        risks: [],
      }) } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const caller = createRealGpt56SolReleaseProxyApprovalCallerFromEnv();
  await caller.call({
    schemaId: "内部模式",
    schemaVersion: 1,
    forward: {
      labelA: "A",
      labelB: "B",
      textA: "候选正文",
      textB: "当前正文",
      spans: [{ id: "片段一", text: "候选正文", side: "A" }],
    },
    reverse: {
      labelA: "A",
      labelB: "B",
      textA: "当前正文",
      textB: "候选正文",
      spans: [{ id: "片段一", text: "候选正文", side: "B" }],
    },
    rawBaseline: { text: "原始基线正文" },
    fixedCase: "固定样例一",
    fixedModel: "固定模型",
    fixedSeed: 1,
    budgetMaxCalls: 2,
    timeoutMs: 1000,
    factGuard: { 通过: true },
    stateConsistency: { 一致: true },
    costProfile: { 调用次数: 2 },
    uniqueVariableDeclared: { hasUniqueVariable: true },
  }, {
    promptHash: "提示摘要",
    modelVersion: "模型版本",
    budget: { maxCalls: 2, timeoutMs: 1000 },
  });

  assert.equal(requests.length, 2);
  for (const [index, request] of requests.entries()) {
    for (const message of request.messages) {
      assertNoEnglish(`发布代理审批第 ${index + 1} 次 ${message.role} 消息`, message.content);
    }
  }
});

test("工具循环向模型展示中文工具协议并把中文调用映射回内部名称", () => {
  // allowedToolNames 为必填白名单（缺口一防御纵深）：仅允许注入叙事白名单内工具。
  const injected = injectToolSchemas("你是网文作家。", [{
    name: "search_narrative_evidence",
    description: "跨源检索结构化叙事证据。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        maxResults: { type: "number", description: "最大返回数", default: 10 },
      },
      required: ["query"],
    },
  }], new Set(["search_narrative_evidence"]));
  assertNoEnglish("工具系统提示词", injected);

  const evidence = formatToolResultsForPrompt([{
    toolName: "search_chapter_span",
    content: [{ type: "text", text: "找到上一章中的原文片段。" }],
    details: { sourceRef: "chapter:1", evidenceLevel: "confirmed" },
  }]);
  assertNoEnglish("工具结果回灌", evidence);

  const parsed = parseToolCallDirectives(
    '<工具调用>{"工具":"跨源叙事证据检索","参数":{"查询词":"暗流","最大结果数":5}}</工具调用>',
  );
  assert.equal(parsed.hasToolCall, true);
  assert.equal(parsed.toolCalls[0]?.name, "search_narrative_evidence");
  assert.deepEqual(parsed.toolCalls[0]?.arguments, { query: "暗流", maxResults: 5 });
});

test("可选章节检索循环的显式提示不再注入英文工具术语", () => {
  const sourceRoot = resolve(process.cwd());
  const candidateSource = readFileSync(
    resolve(sourceRoot, "novelos/agent/agentic-raw-candidate-source.ts"),
    "utf8",
  );
  const loopSource = readFileSync(
    resolve(sourceRoot, "novelos/agent/narrative-agent-loop.ts"),
    "utf8",
  );
  const systemPromptSection = candidateSource.match(/const NOVELOS_SYSTEM_PROMPT\s*=([\s\S]*?);/)?.[0] ?? "";
  const userInstructionSection = loopSource.match(/promptParts\.push\(([\s\S]*?)\);\s*const userPrompt/)?.[0] ?? "";

  assert.doesNotMatch(systemPromptSection, /EvidencePlan|NovelOS|agent loop/);
  assert.doesNotMatch(userInstructionSection, /search_narrative_evidence|search_chapter_span|canon|span/);
});

test("OpenAI 兼容网络边界会清除所有消息正文中的英文字母", async () => {
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({
      model: "测试模型",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "完成" },
        finish_reason: "stop",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const api = new RoutedChatAPI({
    agentName: "测试路由",
    provider: "测试提供方",
    baseUrl: "https://example.test/v1",
    model: "测试模型",
    protocol: "openai",
    temperature: 0,
    maxTokens: 64,
  }, "测试密钥");

  await api.chat([
    { role: "system", content: "System prompt: inspect raw span and return JSON." },
    { role: "user", content: "Candidate A is verified; Candidate B is unverified." },
  ]);

  assert.equal(requests.length, 1);
  for (const message of requests[0].messages) {
    assertNoEnglish(`OpenAI 网络边界 ${message.role} 消息`, message.content);
  }
});

test("Anthropic 网络边界会清除系统提示和消息正文中的英文字母", async () => {
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({
      model: "测试模型",
      content: [{ type: "text", text: "完成" }],
      stop_reason: "stop",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const api = new RoutedChatAPI({
    agentName: "测试路由",
    provider: "测试提供方",
    baseUrl: "https://example.test/v1",
    model: "测试模型",
    protocol: "anthropic",
    temperature: 0,
    maxTokens: 64,
  }, "测试密钥");

  await api.chat([
    { role: "system", content: "System prompt: inspect EvidencePlan and raw span." },
    { role: "user", content: "Call search_chapter_span before final answer." },
    { role: "assistant", content: "Advisory result is unverified." },
  ]);

  assert.equal(requests.length, 1);
  assertNoEnglish("Anthropic 网络边界系统提示", requests[0].system);
  for (const message of requests[0].messages) {
    assertNoEnglish(`Anthropic 网络边界 ${message.role} 消息`, message.content);
  }
});

test("独立模型适配器在网络出口统一清除消息正文中的英文字母", async () => {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    if (String(url).endsWith("/messages")) {
      return new Response(JSON.stringify({
        model: "测试模型",
        content: [{ type: "text", text: "完成" }],
        stop_reason: "stop",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      model: "测试模型",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "完成" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  await new GPTAPI({
    apiKey: "测试密钥",
    baseUrl: "https://example.test/v1",
    model: "测试模型",
  }).chat([{ role: "user", content: "Inspect raw span and return JSON." }]);
  await new GLMAPI({
    apiKey: "测试密钥",
    baseUrl: "https://example.test/v1",
    model: "测试模型",
  }).chat([{ role: "system", content: "System advisory gate." }]);
  await new ClaudeAPI({
    apiKey: "测试密钥",
    baseUrl: "https://example.test/v1",
    model: "测试模型",
  }).message(
    [{ role: "user", content: "Call search_narrative_evidence." }],
    { system: "EvidencePlan must be verified." },
  );
  await callJudgeModel({
    apiKey: "测试密钥",
    baseUrl: "https://example.test/v1",
    model: "测试模型",
  }, [{ role: "user", content: "Candidate A wins with clear confidence." }]);

  assert.equal(requests.length, 4);
  for (const [index, request] of requests.entries()) {
    if (typeof request.body.system === "string") {
      assertNoEnglish(`独立适配器第 ${index + 1} 次系统提示`, request.body.system);
    }
    for (const message of request.body.messages) {
      assertNoEnglish(`独立适配器第 ${index + 1} 次 ${message.role} 消息`, message.content);
    }
  }
});

test("治理模型适配器在直接调用时也会清除消息正文中的英文字母", async () => {
  process.env.NOVELOS_JUDGE_API_KEY = "测试密钥";
  process.env.NOVELOS_JUDGE_BASE_URL = "https://example.test/v1";
  process.env.NOVELOS_JUDGE_MODEL = "测试模型";
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({
      model: "测试模型",
      choices: [{ message: { content: "{}" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const messages = [{ role: "user", content: "Return winner and evidenceExcerpt." }];
  await callOpenAIChatCompletions(messages);
  await createOpenAIChatCompletionsFn({
    apiKey: "测试密钥",
    apiBaseUrl: "https://example.test/v1",
    modelId: "测试模型",
  })(messages);

  assert.equal(requests.length, 2);
  for (const [index, request] of requests.entries()) {
    for (const message of request.messages) {
      assertNoEnglish(`治理适配器第 ${index + 1} 次 ${message.role} 消息`, message.content);
    }
  }
});

test("中文化视图清除英文时严格保持原文字符长度", () => {
  const source = "控制台显示 ARC SECOND STAGE，警报未停。";
  const localized = localizeLlmText(source);

  assertNoEnglish("保长中文化视图", localized);
  assert.equal(localized.length, source.length);
  assert.equal(localized.indexOf("，警报"), source.indexOf("，警报"));
});

test("机会证据存在重叠重复位置时拒绝猜测坐标", () => {
  assert.equal(locateLlmExcerpt("甲甲甲", "甲甲"), null);
});

test("机会裁判可把中文化英文专名证据定位并恢复到原始正文", async () => {
  const rawText = "控制台显示 ARC SECOND STAGE，警报未停。林川按住总闸，没有后退。";
  const localizedExcerpt = localizeLlmText("ARC SECOND STAGE");
  const judge = new EditorialOpportunityJudge();
  const result = await judge.judge({
    rawText,
    intent: makeIntent(),
    longTermState: null,
    constitution: null,
    characterNames: ["林川"],
    modelGenerate: async () => ({
      text: JSON.stringify({
        工艺现象: [],
        编辑机会: [{
          机会类型: "声音与自然度",
          工艺领域: "对话工艺",
          问题诊断: "专名周围表达生硬",
          证据原文: localizedExcerpt,
          预期收益: "保持事实同时改善语气",
          损伤风险: ["不得改动专名"],
          置信度: 0.9,
        }],
        无操作原因: null,
      }),
      model: "测试模型",
      route: "测试路由",
      durationMs: 1,
    }),
  });

  const span = result.hypotheses[0]?.evidenceSpans[0];
  assert.ok(span, "中文化证据应能映射回原始正文");
  assert.equal(span.start, rawText.indexOf("ARC SECOND STAGE"));
  assert.equal(span.end, span.start + "ARC SECOND STAGE".length);
  assert.equal(span.excerpt, "ARC SECOND STAGE");
});

test("文学裁判按中文化正文返回的坐标和片段会恢复为原始英文专名", async () => {
  const rawText = "控制台显示 ARC SECOND STAGE，警报未停。";
  const editorialText = "控制台只剩红光，警报仍未停。";
  const localizedRaw = localizeLlmText(rawText);
  const localizedExcerpt = localizeLlmText("ARC SECOND STAGE");
  const start = localizedRaw.indexOf(localizedExcerpt);
  const end = start + localizedExcerpt.length;
  const judge = createPairwiseLiteraryJudge();
  const result = await judge.judge({
    rawCandidate: makeCandidate("原始候选", "context_enhanced", rawText),
    editorialCandidate: makeCandidate("编辑候选", "editorial_amplified", editorialText),
    intent: makeIntent(),
    constitution: null,
    mapping: {
      leftCandidateId: "原始候选",
      rightCandidateId: "编辑候选",
      leftLabel: "A",
      rightLabel: "B",
      orderRandomized: false,
      seed: 1,
    },
    modelGenerate: async () => ({
      text: JSON.stringify({
        胜者: "乙",
        置信程度: "明确",
        决定性理由: [{
          比较维度: "事实表达",
          较优候选: "乙",
          甲方证据: [{ 起点: start, 终点: end, 原文: localizedExcerpt }],
          乙方证据: [],
          说明: "甲方专名周围表达突兀",
        }],
        事实风险: [],
        退化风险: [],
        宪法对齐: "均未破坏事实",
      }),
      model: "测试模型",
      route: "测试路由",
      durationMs: 1,
    }),
  });

  assert.equal(result.degraded, false);
  const span = result.verdict?.decisiveReasons[0]?.evidenceA[0];
  assert.ok(span);
  assert.equal(span.start, rawText.indexOf("ARC SECOND STAGE"));
  assert.equal(span.end, span.start + "ARC SECOND STAGE".length);
  assert.equal(span.excerpt, "ARC SECOND STAGE");
});
