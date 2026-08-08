/**
 * PRODUCTION-AGENTIC-STYLE-FLOW-1
 *
 * 生产章节必须走 NovelOS Agentic → 作者风格整章优化 → 事实复检 → 保存。
 * 机器裁判与 one-shot raw 不得进入生产调用，最终文学评价权归用户。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createUnifiedOrchestrator } from "../dist/v2/core/unified-orchestrator.js";

const AGENTIC_TEXT = [
  "雨水顺着旧仓库的铁皮檐滴下来。李一凡站在门外，没有立刻进去。",
  "门缝里透出一线白光，里面的人压低声音，说采样箱少了一只。",
  "他抬手碰了碰门把，指腹沾到一层细灰。灰里有新鲜的拖痕，一直向墙角延伸。",
  "李一凡收回手，先给研究员发了消息，又侧身让开门口。脚步声从楼梯下方逼近，他没有回头。",
].join("\n\n");

const STYLED_TEXT = [
  "雨沿着旧仓库的铁皮檐往下滴。",
  "李一凡站在门外。没进去。",
  "门缝漏出一线白光。里面有人压着声音，说采样箱少了一只。",
  "他碰了碰门把。指腹一层细灰。灰里却有道新鲜拖痕，一直拖向墙角。",
  "李一凡把手收回来，先给研究员发了消息。然后侧开半步，让出门口。",
  "楼梯下面，脚步声正往上来。",
  "他没回头。",
].join("\n\n");

function makeIntent() {
  return {
    chapterFunction: "发现采样任务中的人为异常并主动预警",
    authorEventSummaries: ["林一凡在仓库门外确认采样箱异常", "脚步声逼近后他选择先通知研究员"],
    authorMustInclude: ["采样箱少了一只", "脚步声从楼梯下方逼近"],
    authorStateChanges: ["林一凡从观察转为主动预警"],
    causalRelations: ["采样箱缺失导致林一凡暂缓进门并发送消息"],
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
      id: "style:xinmo",
      kind: "fingerprint",
      content: JSON.stringify({
        id: "xinmo",
        usagePolicy: {
          rawPrompt: "excluded",
          fullChapterOptimization: "required",
        },
        editorialGuidance: [
          "情绪优先通过身体反应、静默或动作呈现，不直接替人物命名。",
          "短句用于压力落点，长句只在动作链或信息递进时展开。",
          "章末优先留白，不替读者总结危险。",
        ],
        characterVoiceGuidance: {
          李一凡: ["普通穷学生的生活感，警惕时先观察再开口。"],
        },
      }),
      sourceIds: ["workspaces/test/styles/profile.json"],
    }],
    sourceMap: [],
  };
}

test("生产主链路强制执行 Agentic + 作者风格优化，且不调用机器裁判或 one-shot raw", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-agentic-style-"));
  let agenticCalls = 0;
  const modelCalls = [];
  let stylePrompt = "";

  const agenticCandidateSource = {
    async generate() {
      agenticCalls += 1;
      return {
        candidate: {
          id: "candidate:agentic_raw:ch-17",
          text: AGENTIC_TEXT,
          kind: "agentic_raw",
          model: "novelos_agentic",
          route: "novelos_agentic",
          contextHash: "context-test",
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
        },
        sessionId: "session-test",
        trajectoryPath: join(projectRoot, "trajectory.jsonl"),
        budgetSnapshot: { usedCalls: 1 },
        stopReason: "completed",
        sourceRefs: ["chapter:16", "narrative-state-store"],
        toolCalls: 3,
        verifierCleared: true,
        repairRounds: 1,
      };
    },
  };

  const modelGenerate = async (input) => {
    modelCalls.push({ route: input.route, kind: input.kind });
    if (input.kind !== "author_style_optimization") {
      throw new Error(`生产路径出现未授权模型调用：${input.kind}`);
    }
    stylePrompt = input.userPrompt;
    return {
      text: STYLED_TEXT,
      model: "gemini-3.1-pro-preview",
      route: input.route,
      durationMs: 2,
      finishReason: "stop",
      maxTokens: 16384,
    };
  };

  try {
    const result = await createUnifiedOrchestrator().orchestrate({
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
      modelGenerate,
      generationModelGenerate: modelGenerate,
      judgeModelGenerate: async () => {
        throw new Error("生产路径不得调用机器裁判");
      },
      agenticCandidateSource,
    });

    assert.equal(result.status, "ok", JSON.stringify(result.failureEnvelope));
    assert.equal(agenticCalls, 1);
    assert.deepEqual(modelCalls, [{
      route: "v2_amplified_gemini31",
      kind: "author_style_optimization",
    }]);
    assert.equal(result.text, STYLED_TEXT);
    assert.equal(result.selectedSource, "editorial");
    assert.equal(result.judgeResult, null);
    assert.deepEqual(result.allArbitrationResults, []);
    assert.deepEqual(result.hypotheses, []);
    assert.equal(result.candidates.some((candidate) => candidate.kind === "context_enhanced"), false);
    assert.equal(result.candidates.some((candidate) => candidate.kind === "agentic_raw"), true);
    assert.equal(result.candidates.some((candidate) => candidate.kind === "editorial_amplified"), true);

    assert.equal(result.stageResults.productionFlow.mode, "agentic_style_full_pipeline");
    assert.equal(result.stageResults.productionFlow.literaryAuthority, "user_feedback");
    assert.equal(result.stageResults.productionFlow.oneShotRawCalled, false);
    assert.equal(result.stageResults.productionFlow.machineJudgeCalled, false);
    assert.equal(result.stageResults.novelos.shadowEnabled, false);
    assert.equal(result.stageResults.novelos.required, true);
    assert.equal(result.stageResults.authorStyleOptimization.styleProfileLoaded, true);
    assert.equal(result.stageResults.authorStyleOptimization.styleGuidanceConsumed, true);
    assert.equal(result.stageResults.judgeArbitration.skipped, true);
    assert.match(stylePrompt, /作者风格档案/);
    assert.match(stylePrompt, /情绪优先通过身体反应、静默或动作呈现/);
    assert.match(stylePrompt, /本章事件与因果契约/);
    assert.match(stylePrompt, /林一凡在仓库门外确认采样箱异常/);
    assert.match(stylePrompt, /不得调换、删除或合并导致事件结果变化/);
    assert.doesNotMatch(stylePrompt, /medianCnChars|p75CnChars|observedRatio|对白比例/);

    assert.ok(result.chapterFilePath);
    assert.ok(existsSync(result.chapterFilePath));
    assert.equal(readFileSync(result.chapterFilePath, "utf8"), STYLED_TEXT);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("公开统一入口默认启用 agentic_style，不再受 shadow 开关控制", () => {
  const source = readFileSync(
    join(process.cwd(), "v2", "core", "unified-entry.ts"),
    "utf8",
  );
  assert.match(source, /const agenticCandidateSource = createAgenticRawCandidateSource\(\)/);
  assert.match(source, /PINOVEL_TEST_LEGACY_PRODUCTION_FLOW/);
  assert.match(source, /NOVEL_TEST_TOOLS/);
  assert.match(source, /:\s*"agentic_style"\s+as const/);
  assert.doesNotMatch(source, /PINOVEL_NOVELOS_SHADOW\s*===\s*"1"\s*\?\s*createAgenticRawCandidateSource/);
});

test("NovelOS 验证未清零时生产流程阻断且不保存", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-agentic-verify-block-"));
  let downstreamCalls = 0;
  try {
    const result = await createUnifiedOrchestrator().orchestrate({
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
      modelGenerate: async () => {
        downstreamCalls += 1;
        throw new Error("验证失败后不得继续调用模型");
      },
      agenticCandidateSource: {
        async generate() {
          return {
            candidate: {
              id: "candidate:agentic_raw:ch-17",
              text: AGENTIC_TEXT,
              kind: "agentic_raw",
              model: "novelos_agentic",
              route: "novelos_agentic",
              contextHash: "context-test",
              generatedAt: new Date().toISOString(),
              durationMs: 1,
            },
            sessionId: "session-test",
            trajectoryPath: join(projectRoot, "trajectory.jsonl"),
            budgetSnapshot: { usedCalls: 3 },
            stopReason: "model_declares_sufficient",
            sourceRefs: [],
            toolCalls: 2,
            verifierCleared: false,
            repairRounds: 2,
            hardFindingCount: 2,
            unresolvedFindings: [
              {
                id: "verifier:intent_omission:anchor-1",
                failureType: "intent_omission",
                sourceRef: "author-outline:anchor-1",
                description: "作者章纲必须包含项遗漏：anchor-1",
                conflictFact: "作者章纲必须包含项 anchor-1 在正文中遗漏",
              },
              {
                id: "verifier:event_omission:5",
                failureType: "intent_omission",
                sourceRef: "author-outline:event:5",
                description: "作者章纲事件遗漏：回程时木心微亮但墨老仍未醒",
                conflictFact: "作者章纲事件 5 在正文中缺少事件级覆盖",
              },
            ],
          };
        },
      },
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.failureEnvelope?.stage, "novelos_agentic_verification");
    assert.equal(result.failureEnvelope?.recoverable, true);
    assert.equal(result.failureEnvelope?.candidateDisposition, "blocked_evidence_only");
    assert.deepEqual(result.failureEnvelope?.prohibitedActions, [
      "accept_or_deliver_blocked_candidate",
      "save_blocked_candidate_as_chapter",
      "skip_to_next_chapter",
    ]);
    assert.match(result.failureEnvelope?.userActionRequired?.join("\n") ?? "", /重试当前第 17 章/);
    assert.match(result.failureEnvelope?.reason ?? "", /2 个硬失败/);
    assert.match(result.failureEnvelope?.reason ?? "", /2 轮修复/);
    assert.equal(result.stageResults.pipelineProgress.authorStyleOptimizationExecuted, false);
    assert.equal(result.stageResults.pipelineProgress.finalFactRecheckExecuted, false);
    assert.equal(result.stageResults.pipelineProgress.chapterSaveExecuted, false);
    assert.equal(result.stageResults.novelos.hardFindingCount, 2);
    assert.equal(result.stageResults.novelos.unresolvedFindings.length, 2);
    assert.equal(result.text, "");
    assert.deepEqual(result.candidates, []);
    assert.equal(downstreamCalls, 0);
    assert.equal(result.chapterFilePath, null);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
