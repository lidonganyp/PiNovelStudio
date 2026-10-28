/**
 * Production chapter recovery must finish recoverable generation work inside
 * the unified pipeline instead of returning the first model/gate failure.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildCandidateId, hashText } from "../dist/v2/core/candidate-revision-store.js";
import { createUnifiedOrchestrator } from "../dist/v2/core/unified-orchestrator.js";

const FIRST_DRAFT = [
  "雨水顺着旧仓库的铁皮檐滴下来。李一凡站在门外，没有立刻进去。",
  "门缝里透出一线白光，里面的人压低声音，说采样箱少了一只。",
  "他抬手碰了碰门把，指腹沾到一层细灰。灰里有新鲜的拖痕，一直向墙角延伸。",
].join("\n\n");

const COMPLETE_DRAFT = [
  FIRST_DRAFT,
  "李一凡收回手，先给研究员发了消息，又侧身让开门口。脚步声从楼梯下方逼近，他没有回头。",
  "那脚步在拐角停了一瞬。门内的白光也跟着暗下去，他按住手机，等着来人先露面。",
].join("\n\n");

const EXPANDED_DRAFT = [
  COMPLETE_DRAFT,
  "李一凡等脚步声越过楼梯转角，才看清来人手里也拎着一只沾灰的采样箱。",
  "他没有让开仓门，只把研究员的回复亮在屏幕上。来人停住脚，视线第一次从门缝移到他脸上。",
].join("\n\n");

const DUPLICATE_BLOCK = "李一凡把三颗千年木心和五颗百年木心放在身侧的一块平石上。";
const DEDUPE_RAW = `${COMPLETE_DRAFT}\n\n${DUPLICATE_BLOCK}`;
const DUPLICATED_STYLE = [
  DEDUPE_RAW,
  "他又检查了一遍仓库门口的拖痕，确认来人没有从正门经过。",
  DUPLICATE_BLOCK,
].join("\n\n");

function makeIntent() {
  return {
    chapterFunction: "发现采样任务中的人为异常并主动预警",
    authorEventSummaries: ["李一凡在仓库门外确认采样箱异常", "脚步声逼近后他选择先通知研究员"],
    authorMustInclude: ["采样箱少了一只", "脚步声从楼梯下方逼近"],
    authorStateChanges: ["李一凡从观察转为主动预警"],
    causalRelations: ["采样箱缺失导致李一凡暂缓进门并发送消息"],
    endingTarget: ["脚步声逼近，下一章必须承接危险压力"],
    readerExperience: ["安静压力逐步逼近"],
    currentPressure: ["采样箱失踪，楼下有人接近"],
    meaningfulChoices: ["先预警研究员，再留在门口观察"],
    promisesToAdvance: [],
    possibleEndPressure: ["未知来者已经上楼"],
    relevantCharacters: ["李一凡"],
    inviolableFacts: ["李一凡仍在旧仓库门外", "研究员已经知道采样箱少了一只"],
    factAndCharacterKnowledgeForbiddenZones: [],
    sourceRefs: ["chapter-seed:test"],
    focusCharacterGoals: [{ character: "李一凡", goal: "确认异常来源" }],
    choicesAndCosts: [{ choice: "留在门口观察", cost: "可能暴露自己" }],
    expectedIrreversibleChange: ["李一凡确认任务并非普通采样"],
    selectedPromisesToAdvance: [],
    causalEndPressure: ["脚步声逼近"],
  };
}

function makeContext() {
  return {
    facts: [],
    characterStates: [{
      characterId: "li-yifan",
      name: "李一凡",
      state: { role: "主角", mentality: "警惕但不外露" },
      sourceIds: ["character:li-yifan"],
    }],
    openLoops: [],
    worldRules: [],
    styleReferences: [{
      id: "style:test",
      kind: "fingerprint",
      content: JSON.stringify({
        editorialGuidance: [
          "情绪优先通过动作和静默呈现。",
          "短句只用于压力落点，章末不替读者总结。",
        ],
      }),
      sourceIds: ["styles/profile.json"],
    }],
    sourceMap: [],
  };
}

function makeCandidate(text, sequence) {
  const sessionId = `recovery-session-${sequence}`;
  return {
    id: buildCandidateId({
      runId: sessionId,
      derivationType: "agentic_generation",
      textHash: hashText(text),
      sequence,
    }),
    text,
    kind: "agentic_raw",
    model: "gemini-recovery-test",
    route: "novelos_agentic",
    contextHash: "context-recovery-test",
    generatedAt: new Date().toISOString(),
    durationMs: 1,
    promptProfile: {
      type: "editorial",
      tokensIn: 0,
      containsDialogueRatio: false,
      containsParagraphLengthConstraint: false,
      containsControlChecklist: false,
      containsMechanicalMetric: false,
      contractIds: [],
    },
  };
}

function makeAgenticResult(text, sequence, overrides = {}) {
  return {
    candidate: makeCandidate(text, sequence),
    sessionId: `recovery-session-${sequence}`,
    trajectoryPath: `trajectory-${sequence}.jsonl`,
    budgetSnapshot: { usedCalls: 1 },
    stopReason: "completed",
    sourceRefs: ["chapter:16"],
    toolCalls: 1,
    verifierCleared: true,
    repairRounds: 0,
    ...overrides,
  };
}

function makeInput(projectRoot, overrides = {}) {
  return {
    workspaceId: "test",
    chapterId: "ch-17",
    chapterNumber: 17,
    projectRoot,
    productionFlow: "agentic_style",
    intent: makeIntent(),
    context: makeContext(),
    constitution: null,
    characterNames: ["李一凡"],
    rawPromptProfile: "gemini_writer_v2",
    ...overrides,
  };
}

test('a verified draft survives style failure and is invalidated by changed author materials', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'pinovel-verified-draft-'));
  let draftCalls = 0;
  let failStyle = true;
  const source = { async generate() { draftCalls++; return makeAgenticResult(COMPLETE_DRAFT, draftCalls); } };
  const generate = async (input) => {
    if (failStyle) throw new Error('fixture style unavailable');
    return { text: COMPLETE_DRAFT, model: 'gemini-recovery-test', route: input.route, durationMs: 1, finishReason: 'stop' };
  };
  try {
    const run = (binding) => createUnifiedOrchestrator().orchestrate(makeInput(projectRoot, {
      verifiedDraftBinding: binding, agenticCandidateSource: source, modelGenerate: generate,
    }));
    const failed = await run('materials-model-A');
    assert.equal(failed.status, 'blocked');
    assert.equal(draftCalls, 1);
    failStyle = false;
    const recovered = await run('materials-model-A');
    assert.equal(recovered.status, 'ok', JSON.stringify(recovered.failureEnvelope));
    assert.equal(draftCalls, 1);
    assert.equal(recovered.stageResults.verifiedDraftCheckpoint.reused, true);
    const changed = await run('materials-model-B');
    assert.equal(changed.status, 'ok', JSON.stringify(changed.failureEnvelope));
    assert.equal(draftCalls, 2);
    assert.equal(changed.stageResults.verifiedDraftCheckpoint.reused, false);
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
});

test("production recovery continues an undersized Agentic draft before style optimization", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-length-recovery-"));
  const agenticInputs = [];
  let styleCalls = 0;
  const minimum = FIRST_DRAFT.replace(/\s+/gu, "").length + 20;

  try {
    const result = await createUnifiedOrchestrator().orchestrate(makeInput(projectRoot, {
      targetWordCount: { min: minimum, max: minimum + 200 },
      agenticCandidateSource: {
        async generate(input) {
          agenticInputs.push(input);
          return agenticInputs.length === 1
            ? makeAgenticResult(FIRST_DRAFT, 1)
            : makeAgenticResult(COMPLETE_DRAFT, 2);
        },
      },
      modelGenerate: async (input) => {
        assert.equal(input.kind, "author_style_optimization");
        styleCalls += 1;
        return {
          text: COMPLETE_DRAFT,
          model: "gemini-recovery-test",
          route: input.route,
          durationMs: 1,
          finishReason: "stop",
        };
      },
    }));

    assert.equal(result.status, "ok", JSON.stringify(result.failureEnvelope));
    assert.equal(agenticInputs.length, 2);
    assert.equal(agenticInputs[1].continuationMode, "append");
    assert.equal(agenticInputs[1].currentChapterDraft, FIRST_DRAFT);
    assert.deepEqual(agenticInputs[1].targetWordCount, { min: minimum, max: minimum + 200 });
    assert.equal(styleCalls, 1);
    assert.equal(result.text, COMPLETE_DRAFT);
    assert.equal(result.stageResults.generationRecovery.attempts[0].reason, "target_length");
    assert.ok(result.chapterFilePath && existsSync(result.chapterFilePath));
    assert.equal(readFileSync(result.chapterFilePath, "utf8"), COMPLETE_DRAFT);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("append mode accepts a suffix-only style result and prepends the protected draft exactly once", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-continuation-suffix-"));
  const suffix = COMPLETE_DRAFT.slice(FIRST_DRAFT.length).trim();

  try {
    const result = await createUnifiedOrchestrator().orchestrate(makeInput(projectRoot, {
      continuationMode: "append",
      currentChapterDraft: FIRST_DRAFT,
      agenticCandidateSource: {
        async generate(input) {
          assert.equal(input.continuationMode, "append");
          assert.equal(input.currentChapterDraft, FIRST_DRAFT);
          return makeAgenticResult(COMPLETE_DRAFT, 1);
        },
      },
      modelGenerate: async (input) => {
        assert.equal(input.kind, "author_style_optimization");
        return {
          text: suffix,
          model: "gemini-recovery-test",
          route: input.route,
          durationMs: 1,
          finishReason: "stop",
        };
      },
    }));

    assert.equal(result.status, "ok", JSON.stringify(result.failureEnvelope));
    assert.equal(result.text, COMPLETE_DRAFT);
    assert.equal(result.text.indexOf(FIRST_DRAFT), 0);
    assert.equal(result.text.split(FIRST_DRAFT).length - 1, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("append mode preserves CRLF author text through optimization and final save", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-continuation-newlines-"));
  const protectedDraft = FIRST_DRAFT.replace(/\n/g, "\r\n");
  const expected = protectedDraft + COMPLETE_DRAFT.slice(FIRST_DRAFT.length);
  try {
    const result = await createUnifiedOrchestrator().orchestrate(makeInput(projectRoot, {
      continuationMode: "append",
      currentChapterDraft: protectedDraft,
      agenticCandidateSource: { async generate() { return makeAgenticResult(COMPLETE_DRAFT, 1); } },
      modelGenerate: async () => ({
        text: COMPLETE_DRAFT,
        model: "gemini-recovery-test",
        durationMs: 1,
        finishReason: "stop",
      }),
    }));
    assert.equal(result.status, "ok", JSON.stringify(result.failureEnvelope));
    assert.equal(result.text, expected);
    assert.equal(readFileSync(result.chapterFilePath, "utf8"), expected);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("append mode blocks after repeated prefix rewrites without delivering an unoptimized draft", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-prefix-retry-exhausted-"));
  let styleCalls = 0;
  try {
    const result = await createUnifiedOrchestrator().orchestrate(makeInput(projectRoot, {
      continuationMode: "append",
      currentChapterDraft: FIRST_DRAFT,
      agenticCandidateSource: { async generate() { return makeAgenticResult(COMPLETE_DRAFT, 1); } },
      modelGenerate: async () => {
        styleCalls += 1;
        return { text: `X${COMPLETE_DRAFT.slice(1)}`, model: "test", durationMs: 1 };
      },
    }));
    assert.equal(styleCalls, 2);
    assert.equal(result.status, "blocked");
    assert.equal(result.selectedSource, null);
    assert.ok(!result.chapterFilePath);
    assert.equal(result.stageResults.authorStyleOptimizationRetry.retryFailureKind, "continuation_prefix_mismatch");
    assert.equal(result.stageResults.authorStyleOptimizationRetry.succeeded, false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("append mode retries a rewritten prefix and succeeds with the strict suffix-only recovery contract", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-continuation-prefix-recovery-"));
  const suffix = COMPLETE_DRAFT.slice(FIRST_DRAFT.length).trim();
  const rewrittenPrefix = `X${FIRST_DRAFT.slice(1)}`;
  const stylePrompts = [];

  try {
    const result = await createUnifiedOrchestrator().orchestrate(makeInput(projectRoot, {
      continuationMode: "append",
      currentChapterDraft: FIRST_DRAFT,
      agenticCandidateSource: {
        async generate(input) {
          assert.equal(input.continuationMode, "append");
          assert.equal(input.currentChapterDraft, FIRST_DRAFT);
          return makeAgenticResult(COMPLETE_DRAFT, 1);
        },
      },
      modelGenerate: async (input) => {
        stylePrompts.push(input.userPrompt);
        return {
          text: stylePrompts.length === 1 ? `${rewrittenPrefix}\n\n${suffix}` : suffix,
          model: "gemini-recovery-test",
          route: input.route,
          durationMs: 1,
          finishReason: "stop",
        };
      },
    }));

    assert.equal(result.status, "ok", JSON.stringify(result.failureEnvelope));
    assert.equal(stylePrompts.length, 2);
    assert.match(stylePrompts[1], /CONTINUATION PREFIX RECOVERY/);
    assert.equal(result.text, COMPLETE_DRAFT);
    assert.equal(result.text.split(FIRST_DRAFT).length - 1, 1);
    assert.equal(result.stageResults.authorStyleOptimizationRetry.succeeded, true);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("repeated author-style echo blocks without relabeling the Agentic draft as optimized", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-author-style-echo-recovery-"));
  const echoedRewrite = "\n\n这是风格模型追加的整章改写段落，不能与原始章节同时保留。".repeat(80);
  const echoedChapter = `${COMPLETE_DRAFT}${echoedRewrite}`;
  const stylePrompts = [];

  try {
    const result = await createUnifiedOrchestrator().orchestrate(makeInput(projectRoot, {
      agenticCandidateSource: {
        async generate() {
          return makeAgenticResult(COMPLETE_DRAFT, 1);
        },
      },
      modelGenerate: async (input) => {
        stylePrompts.push(input.userPrompt);
        return {
          text: echoedChapter,
          model: "gemini-recovery-test",
          route: input.route,
          durationMs: 1,
          finishReason: "stop",
        };
      },
    }));

    assert.equal(result.status, "blocked", JSON.stringify(result.failureEnvelope));
    assert.equal(stylePrompts.length, 2);
    assert.match(stylePrompts[1], /COMPLETE CHAPTER ECHO RECOVERY/);
    assert.equal(result.selectedSource, null);
    assert.ok(!result.chapterFilePath, "failed optimization must not save a chapter");
    assert.equal(result.stageResults.authorStyleOptimizationRetry.succeeded, false);
    assert.equal(result.stageResults.authorStyleOptimizationRetry.retryFailureKind, "complete_chapter_echo");
    assert.equal(result.stageResults.authorStyleOptimizationNoopRecovery, undefined);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("production recovery retries when the first Agentic call throws", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-agentic-throw-recovery-"));
  let agenticCalls = 0;

  try {
    const result = await createUnifiedOrchestrator().orchestrate(makeInput(projectRoot, {
      agenticCandidateSource: {
        async generate() {
          agenticCalls += 1;
          if (agenticCalls === 1) {
            throw new Error("request timed out before Agentic returned a result");
          }
          return makeAgenticResult(COMPLETE_DRAFT, 2);
        },
      },
      modelGenerate: async (input) => ({
        text: COMPLETE_DRAFT,
        model: "gemini-recovery-test",
        route: input.route,
        durationMs: 1,
        finishReason: "stop",
      }),
    }));

    assert.equal(result.status, "ok", JSON.stringify(result.failureEnvelope));
    assert.equal(agenticCalls, 2);
    assert.equal(result.stageResults.generationRecovery.attempts[0].reason, "empty_result");
    assert.equal(result.stageResults.generationRecovery.attempts[0].outcome, "candidate");
    assert.equal(result.text, COMPLETE_DRAFT);
    assert.ok(result.chapterFilePath && existsSync(result.chapterFilePath));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("production recovery feeds Agentic FactGuard findings into a new verified candidate", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-fact-recovery-"));
  const polluted = `${COMPLETE_DRAFT}\n\n李一凡突然突破到二级，气息骤然暴涨。`;
  const agenticInputs = [];

  try {
    const result = await createUnifiedOrchestrator().orchestrate(makeInput(projectRoot, {
      ontologyLevels: ["一级"],
      agenticCandidateSource: {
        async generate(input) {
          agenticInputs.push(input);
          return agenticInputs.length === 1
            ? makeAgenticResult(polluted, 1)
            : makeAgenticResult(COMPLETE_DRAFT, 2);
        },
      },
      modelGenerate: async (input) => ({
        text: COMPLETE_DRAFT,
        model: "gemini-recovery-test",
        route: input.route,
        durationMs: 1,
        finishReason: "stop",
      }),
    }));

    assert.equal(result.status, "ok", JSON.stringify(result.failureEnvelope));
    assert.equal(agenticInputs.length, 2);
    assert.equal(agenticInputs[1].recoveryDirective.kind, "fact_guard");
    assert.equal(agenticInputs[1].recoveryDirective.previousCandidateText, polluted);
    assert.ok(agenticInputs[1].recoveryDirective.findings.some((finding) =>
      /unauthorized_high_impact_setting/u.test(`${finding.code} ${finding.message}`)
    ));
    assert.equal(result.stageResults.agenticFactGuard.ok, true);
    assert.equal(result.text, COMPLETE_DRAFT);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("production recovery removes an exact final duplicate and reruns every final gate", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-duplicate-recovery-"));

  try {
    const result = await createUnifiedOrchestrator().orchestrate(makeInput(projectRoot, {
      agenticCandidateSource: {
        async generate() {
          return makeAgenticResult(DEDUPE_RAW, 1);
        },
      },
      modelGenerate: async (input) => ({
        text: DUPLICATED_STYLE,
        model: "gemini-recovery-test",
        route: input.route,
        durationMs: 1,
        finishReason: "stop",
      }),
    }));

    assert.equal(result.status, "ok", JSON.stringify(result.failureEnvelope));
    assert.equal(result.text.split(DUPLICATE_BLOCK).length - 1, 1);
    assert.equal(result.stageResults.finalDuplicateRepair.changed, true);
    assert.equal(result.stageResults.storyPreservation.preserved, true);
    assert.equal(result.stageResults.finalFactRecheck.ok, true);
    assert.equal(result.stageResults.finalTextCompleteness.passed, true);
    assert.ok(result.chapterFilePath && existsSync(result.chapterFilePath));
    assert.equal(readFileSync(result.chapterFilePath, "utf8"), result.text);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("production recovery expands the Agentic source when the styled chapter is undersized", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-final-length-recovery-"));
  const agenticInputs = [];
  let styleCalls = 0;
  const minimum = FIRST_DRAFT.replace(/\s+/gu, "").length + 20;
  const maximum = EXPANDED_DRAFT.replace(/\s+/gu, "").length + 100;

  try {
    const result = await createUnifiedOrchestrator().orchestrate(makeInput(projectRoot, {
      targetWordCount: { min: minimum, max: maximum },
      agenticCandidateSource: {
        async generate(input) {
          agenticInputs.push(input);
          return agenticInputs.length === 1
            ? makeAgenticResult(COMPLETE_DRAFT, 1)
            : makeAgenticResult(EXPANDED_DRAFT, 2);
        },
      },
      modelGenerate: async (input) => {
        styleCalls += 1;
        return {
          text: styleCalls === 1 ? FIRST_DRAFT : EXPANDED_DRAFT,
          model: "gemini-recovery-test",
          route: input.route,
          durationMs: 1,
          finishReason: "stop",
        };
      },
    }));

    assert.equal(result.status, "ok", JSON.stringify(result.failureEnvelope));
    assert.equal(agenticInputs.length, 2);
    assert.equal(styleCalls, 2);
    assert.equal(agenticInputs[1].continuationMode, "append");
    assert.equal(agenticInputs[1].currentChapterDraft, COMPLETE_DRAFT);
    assert.equal(result.stageResults.finalGenerationRecovery.attempts[0].reason, "target_length");
    assert.equal(result.text, EXPANDED_DRAFT);
    assert.ok(result.chapterFilePath && existsSync(result.chapterFilePath));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

for (const continuationMode of ["replace", "append"]) {
test(`${continuationMode} recovery feeds final FactGuard findings back into style optimization`, async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-final-fact-recovery-"));
  const pollutedStyle = `${COMPLETE_DRAFT}\n\n李一凡突然突破到二级，气息随之暴涨。`;
  const stylePrompts = [];

  try {
    const result = await createUnifiedOrchestrator().orchestrate(makeInput(projectRoot, {
      continuationMode,
      ...(continuationMode === "append" ? { currentChapterDraft: FIRST_DRAFT } : {}),
      ontologyLevels: ["一级"],
      agenticCandidateSource: {
        async generate() {
          return makeAgenticResult(COMPLETE_DRAFT, 1);
        },
      },
      modelGenerate: async (input) => {
        stylePrompts.push(input.userPrompt);
        const text = stylePrompts.length === 1 ? pollutedStyle : COMPLETE_DRAFT;
        return {
          text: continuationMode === "append" ? text.slice(FIRST_DRAFT.length).trim() : text,
          model: "gemini-recovery-test",
          route: input.route,
          durationMs: 1,
          finishReason: "stop",
        };
      },
    }));

    assert.equal(result.status, "ok", JSON.stringify(result.failureEnvelope));
    assert.equal(stylePrompts.length, 2);
    assert.match(stylePrompts[1], /unauthorized_high_impact_setting/u);
    assert.match(stylePrompts[1], /突破到二级/u);
    assert.equal(result.stageResults.finalGenerationRecovery.attempts[0].reason, "fact_guard");
    assert.equal(result.stageResults.finalFactRecheck.ok, true);
    assert.equal(result.text, COMPLETE_DRAFT);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test(`${continuationMode} recovery regenerates styled content after truncation`, async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-final-completeness-recovery-"));
  const truncatedStyle = `${COMPLETE_DRAFT}\n\n李一凡望向门外，那里只剩下`;
  const stylePrompts = [];

  try {
    const result = await createUnifiedOrchestrator().orchestrate(makeInput(projectRoot, {
      continuationMode,
      ...(continuationMode === "append" ? { currentChapterDraft: FIRST_DRAFT } : {}),
      agenticCandidateSource: {
        async generate() {
          return makeAgenticResult(COMPLETE_DRAFT, 1);
        },
      },
      modelGenerate: async (input) => {
        stylePrompts.push(input.userPrompt);
        const text = stylePrompts.length === 1 ? truncatedStyle : COMPLETE_DRAFT;
        return {
          text: continuationMode === "append" ? text.slice(FIRST_DRAFT.length).trim() : text,
          model: "gemini-recovery-test",
          route: input.route,
          durationMs: 1,
          finishReason: stylePrompts.length === 1 ? "length" : "stop",
        };
      },
    }));

    assert.equal(result.status, "ok", JSON.stringify(result.failureEnvelope));
    assert.equal(stylePrompts.length, 2);
    assert.match(stylePrompts[1], /输出截断|完整章节/u);
    assert.equal(result.stageResults.finalGenerationRecovery.attempts[0].reason, "completeness");
    assert.equal(result.stageResults.finalTextCompleteness.passed, true);
    assert.equal(result.text, COMPLETE_DRAFT);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
}
