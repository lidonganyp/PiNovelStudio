/**
 * Phase 1 整改：风格失败矩阵测试
 *
 * 审计 P0/P1 要求：
 * - 风格优化失败时禁止把 Agentic 初稿伪装成优化稿保存（selectedSource 造假）
 * - Story Preservation 不能放过"保留人名但整章换剧情"
 * - 模型超时/空结果必须可恢复（severity=recoverable, gate=model_timeout）
 * - 缺风格档案必须在模型调用前阻断（severity=preflight）
 *
 * Phase 2A 更新（2026-07-28）：
 * - 缺风格档案的阻断从 orchestrator 内 preflight hardBlock 迁移到 runUnifiedPipeline
 *   的完整 Preflight（见 tests/phase2-preflight-integration.test.mjs）。
 * - 直接调 orchestrate 时，orchestrator 兜底检查降级为 advisory warning；
 *   缺风格档案由作者风格优化阶段自身的 no_guidance hard block 处理（用例 1 更新）。
 * - 其余用例（2-12）行为不变。
 *
 * 12 个用例覆盖：
 *   1.  缺风格档案 → advisory warning + style_optimization hard block（Phase 2A）
 *   2.  风格档案存在但无可消费指导 → hard block, selectedSource=null
 *   3.  风格优化返回空文本 → recoverable, gate=model_timeout
 *   4.  风格优化超时 → recoverable, gate=model_timeout
 *   5.  风格优化模型错误 → recoverable, gate=model_timeout
 *   6.  Story Preservation 通过 → 成功交付 editorial
 *   7.  Story Preservation unverifiable → 缩减指导重试通过 → 成功
 *   8.  Story Preservation unverifiable → 重试仍不可验证 → hard block
 *   9.  Story Preservation 明确漂移 → 缩减指导重试通过 → 成功
 *   10. Story Preservation 明确漂移 → 重试仍漂移 → hard block
 *   11. 保留人名但整章换剧情 → hard block（审计回归用例）
 *   12. Agentic 生成超时 → recoverable, gate=model_timeout
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createUnifiedOrchestrator } from "../dist/v2/core/unified-orchestrator.js";
import { TEST_STYLE_REFERENCES } from "./test-style-fingerprint.mjs";

// ============================================================================
// 测试夹具
// ============================================================================

const AGENTIC_TEXT = [
  "李一凡推开旧仓库的铁门，走了进去。",
  "门缝里透出一线白光，里面的人压低声音说采样箱少了一只。",
  "他抬手碰了碰门把，指腹沾到一层细灰，灰里有新鲜的拖痕向墙角延伸。",
  "李一凡收回手，先给研究员发了消息，又侧身让开门口。",
  "脚步声从楼梯下方逼近，他没有回头，快步从侧门离开了仓库。",
].join("\n\n");

/** 风格优化稿：保留全部事件，只调整文笔 → preservation 通过 */
const STYLED_PRESERVED = [
  "李一凡推开旧仓库的铁门，走了进去。",
  "门缝漏出一线白光。里面有人压着声音，说采样箱少了一只。",
  "他碰了碰门把。指腹一层细灰，灰里有道新鲜拖痕，一直拖向墙角。",
  "李一凡把手收回来，先给研究员发了消息，然后侧开半步，让出门口。",
  "楼梯下面，脚步声正往上来。他没回头，快步从侧门离开了仓库。",
].join("\n\n");

/** 风格优化稿：保留人名但删除全部事件，替换为完全不同的剧情 → preservation 漂移 */
const STYLED_DRIFTED = [
  "李一凡坐在茶馆里，慢慢喝着一杯龙井。",
  "窗外的园林里，几个客人正在赏花。",
  "他想起了昨晚的灯会，街上挤满了看灯的人群。",
  "研究员走过来，给他续了一杯茶，两人聊起了最近的天气。",
  "李一凡付了茶钱，走出茶馆，沿着河边散步回家。",
].join("\n\n");

function makeIntent() {
  return {
    chapterFunction: "发现采样任务中的人为异常并主动预警",
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

function makeContext(styleRefs = TEST_STYLE_REFERENCES) {
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
    styleReferences: styleRefs,
    sourceMap: [],
  };
}

function makeAgenticSource(text = AGENTIC_TEXT) {
  return {
    async generate() {
      return {
        candidate: {
          id: "candidate:agentic_raw:ch-test",
          text,
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
        trajectoryPath: null,
        budgetSnapshot: { usedCalls: 1 },
        stopReason: "completed",
        sourceRefs: [],
        toolCalls: 2,
        verifierCleared: true,
        repairRounds: 0,
      };
    },
  };
}

function makeBaseInput(overrides = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-phase1-"));
  return {
    workspaceId: "test",
    chapterId: "ch-test",
    chapterNumber: 1,
    projectRoot,
    productionFlow: "agentic_style",
    intent: makeIntent(),
    context: makeContext(),
    constitution: null,
    characterNames: ["李一凡"],
    // P0-2 修复：传入完整实体表（角色 + 故事关键术语），
    // 使 Story Preservation 门禁使用 full_entities 覆盖，能检测"保留人名但整章换剧情"。
    knownEntities: ["李一凡", "旧仓库", "采样箱", "拖痕", "脚步声", "铁门", "研究员"],
    rawPromptProfile: "gemini_writer_v2",
    agenticCandidateSource: makeAgenticSource(),
    ...overrides,
  };
}

// ============================================================================
// 1. 缺风格档案 → Phase 2A：orchestrator 兜底 advisory + style_optimization hard block
//    Phase 2A 起，runUnifiedPipeline 的 Preflight 负责在模型调用前阻断；
//    直接调 orchestrate 时，orchestrator 兜底检查降级为 advisory warning，
//    缺风格档案由作者风格优化阶段自身的 no_guidance hard block 处理。
// ============================================================================

test("P1-preflight: 缺风格档案 → advisory warning + style_optimization hard block（Phase 2A）", async () => {
  const input = makeBaseInput({
    context: makeContext([]), // 无风格指纹
  });
  let modelCallCount = 0;
  input.modelGenerate = async () => { modelCallCount += 1; throw new Error("不应调用模型"); };
  input.generationModelGenerate = input.modelGenerate;
  try {
    const result = await createUnifiedOrchestrator().orchestrate(input);
    assert.equal(result.status, "blocked");
    assert.equal(result.selectedSource, null, "blocked 不带 selectedSource");
    assert.equal(modelCallCount, 0, "不得调用任何模型（no_guidance 在模型调用前返回）");
    assert.equal(result.chapterFilePath, null, "不保存章节");
    // Phase 2A：orchestrator 兜底检查降级为 advisory
    assert.equal(result.stageResults.preflightStyleProfile?.passed, false, "preflightStyleProfile.passed=false");
    assert.equal(result.stageResults.preflightStyleProfile?.advisory, true, "advisory=true（不再 hardBlock）");
    // 实际阻断由作者风格优化阶段的 no_guidance 触发
    assert.equal(result.failureEnvelope?.severity, "hard");
    assert.equal(result.failureEnvelope?.gate, "style_optimization");
    assert.match(result.failureEnvelope?.reason ?? "", /no_guidance|未产出候选|无可消费/);
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. 风格档案存在但无可消费指导 → hard block
// ============================================================================

test("P0-style: 风格档案存在但无可消费指导 → hard block, selectedSource=null", async () => {
  const emptyGuidanceFingerprint = [{
    id: "style:empty",
    kind: "fingerprint",
    content: JSON.stringify({
      id: "empty",
      editorialGuidance: [], // 空指导
      characterVoiceGuidance: {},
    }),
  }];
  const input = makeBaseInput({
    context: makeContext(emptyGuidanceFingerprint),
  });
  input.modelGenerate = async () => { throw new Error("不应调用模型"); };
  input.generationModelGenerate = input.modelGenerate;
  try {
    const result = await createUnifiedOrchestrator().orchestrate(input);
    assert.equal(result.status, "blocked");
    assert.equal(result.selectedSource, null, "blocked 不带 selectedSource");
    assert.equal(result.failureEnvelope?.severity, "hard");
    assert.equal(result.failureEnvelope?.gate, "style_optimization");
    assert.match(result.failureEnvelope?.reason ?? "", /no_guidance|未产出候选/);
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. 风格优化返回空文本 → 风格阶段内重试并成功
// ============================================================================

test("P0-style: 风格优化首次返回空文本 → 仅重试风格阶段并成功", async () => {
  const input = makeBaseInput();
  let styleCallCount = 0;
  input.modelGenerate = async (modelInput) => {
    if (modelInput.kind === "author_style_optimization") {
      styleCallCount += 1;
      return {
        text: styleCallCount === 1 ? "" : STYLED_PRESERVED,
        model: "stub",
        route: modelInput.route,
        durationMs: 1,
      };
    }
    throw new Error(`未授权调用：${modelInput.kind}`);
  };
  input.generationModelGenerate = input.modelGenerate;
  try {
    const result = await createUnifiedOrchestrator().orchestrate(input);
    assert.equal(result.status, "ok", JSON.stringify(result.failureEnvelope));
    assert.equal(result.selectedSource, "editorial");
    assert.equal(styleCallCount, 2, "只应重试作者风格优化阶段一次");
    assert.equal(result.stageResults.authorStyleOptimizationRetry?.attempted, true);
    assert.equal(result.stageResults.authorStyleOptimizationRetry?.succeeded, true);
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. 风格优化超时 → 风格阶段重试耗尽后精确阻断
// ============================================================================

test("P0-style: 风格优化持续超时 → 阶段内重试一次后 hard block", async () => {
  const input = makeBaseInput();
  let styleCallCount = 0;
  input.modelGenerate = async (modelInput) => {
    if (modelInput.kind === "author_style_optimization") {
      styleCallCount += 1;
      throw new Error("Request timed out after 600000ms");
    }
    throw new Error(`未授权调用：${modelInput.kind}`);
  };
  input.generationModelGenerate = input.modelGenerate;
  try {
    const result = await createUnifiedOrchestrator().orchestrate(input);
    assert.equal(result.status, "blocked");
    assert.equal(result.selectedSource, null, "blocked 不带 selectedSource");
    assert.equal(result.failureEnvelope?.severity, "hard");
    assert.equal(result.failureEnvelope?.gate, "style_optimization");
    assert.equal(styleCallCount, 2, "超时只应在风格阶段重试一次");
    assert.equal(result.stageResults.authorStyleOptimizationRetry?.attempted, true);
    assert.equal(result.stageResults.authorStyleOptimizationRetry?.succeeded, false);
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. 风格优化普通模型错误 → 非超时 hard block
// ============================================================================

test("P0-style: 风格优化普通模型错误 → hard block，不伪装成 model_timeout", async () => {
  const input = makeBaseInput();
  let styleCallCount = 0;
  input.modelGenerate = async (modelInput) => {
    if (modelInput.kind === "author_style_optimization") {
      styleCallCount += 1;
      throw new Error("Internal server error from model provider");
    }
    throw new Error(`未授权调用：${modelInput.kind}`);
  };
  input.generationModelGenerate = input.modelGenerate;
  try {
    const result = await createUnifiedOrchestrator().orchestrate(input);
    assert.equal(result.status, "blocked");
    assert.equal(result.selectedSource, null, "blocked 不带 selectedSource");
    assert.equal(result.failureEnvelope?.severity, "hard");
    assert.equal(result.failureEnvelope?.gate, "style_optimization");
    assert.equal(styleCallCount, 1, "非超时模型错误不应自动重试整章或风格阶段");
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

test("P0-style: ECONNRESET is model_error and does not retry as a timeout", async () => {
  const input = makeBaseInput();
  let styleCallCount = 0;
  input.modelGenerate = async (modelInput) => {
    if (modelInput.kind === "author_style_optimization") {
      styleCallCount += 1;
      throw new Error("read ECONNRESET from upstream model provider");
    }
    throw new Error(`unauthorized call: ${modelInput.kind}`);
  };
  input.generationModelGenerate = input.modelGenerate;
  try {
    const result = await createUnifiedOrchestrator().orchestrate(input);
    assert.equal(result.status, "blocked");
    assert.equal(result.failureEnvelope?.gate, "style_optimization");
    assert.equal(result.failureEnvelope?.severity, "hard");
    assert.equal(styleCallCount, 1, "connection reset must not be retried as a true timeout");
    assert.equal(result.stageResults.authorStyleOptimizationRetry, undefined);
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 6. Story Preservation 通过 → 成功交付 editorial
// ============================================================================

test("P0-preservation: 风格优化保留全部事件 → 成功交付 editorial", async () => {
  const input = makeBaseInput();
  input.modelGenerate = async (modelInput) => {
    if (modelInput.kind === "author_style_optimization") {
      return { text: STYLED_PRESERVED, model: "stub", route: modelInput.route, durationMs: 1 };
    }
    throw new Error(`未授权调用：${modelInput.kind}`);
  };
  input.generationModelGenerate = input.modelGenerate;
  try {
    const result = await createUnifiedOrchestrator().orchestrate(input);
    assert.equal(result.status, "ok", JSON.stringify(result.failureEnvelope));
    assert.equal(result.selectedSource, "editorial");
    assert.equal(result.text, STYLED_PRESERVED);
    assert.ok(result.chapterFilePath, "应保存章节文件");
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 7. Story Preservation 首次事件缺失 → 缩减指导重试通过 → 成功
//    （审计 P0-1：失败不回退 raw，而是缩减指导重试一次；通过则正常交付）
// ============================================================================

test("P0-preservation: 首次事件缺失 → 缩减指导重试通过 → 成功交付", async () => {
  const input = makeBaseInput();
  let styleCallCount = 0;
  input.modelGenerate = async (modelInput) => {
    if (modelInput.kind === "author_style_optimization") {
      styleCallCount += 1;
      if (styleCallCount === 1) {
        // 首次返回极短文本（只含角色名，缺失全部故事实体）→ 事件缺失/漂移
        return { text: "李一凡站在那里。", model: "stub", route: modelInput.route, durationMs: 1 };
      }
      // 重试返回保留事件的优化稿 → 通过
      return { text: STYLED_PRESERVED, model: "stub", route: modelInput.route, durationMs: 1 };
    }
    throw new Error(`未授权调用：${modelInput.kind}`);
  };
  input.generationModelGenerate = input.modelGenerate;
  try {
    const result = await createUnifiedOrchestrator().orchestrate(input);
    assert.equal(result.status, "ok", JSON.stringify(result.failureEnvelope));
    assert.equal(result.selectedSource, "editorial");
    assert.equal(styleCallCount, 2, "应有 2 次风格优化调用（首次 + 缩减指导重试）");
    assert.ok(
      result.stageResults.retryStoryPreservation || result.stageResults.retryStoryPreservationDrift,
      "应记录重试 preservation 结果",
    );
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 8. Story Preservation 首次事件缺失 → 重试仍缺失 → hard block
//    （审计 P0-1：重试耗尽后 hard block，不回退 raw）
// ============================================================================

test("P0-preservation: 首次事件缺失 → 重试仍缺失 → hard block", async () => {
  const input = makeBaseInput();
  let styleCallCount = 0;
  input.modelGenerate = async (modelInput) => {
    if (modelInput.kind === "author_style_optimization") {
      styleCallCount += 1;
      // 两次都返回极短文本（缺失故事实体）
      return { text: "李一凡站在那里。", model: "stub", route: modelInput.route, durationMs: 1 };
    }
    throw new Error(`未授权调用：${modelInput.kind}`);
  };
  input.generationModelGenerate = input.modelGenerate;
  try {
    const result = await createUnifiedOrchestrator().orchestrate(input);
    assert.equal(result.status, "blocked");
    assert.equal(result.selectedSource, null, "blocked 不带 selectedSource");
    assert.equal(result.failureEnvelope?.severity, "hard");
    assert.equal(result.failureEnvelope?.gate, "story_preservation");
    assert.equal(styleCallCount, 2, "应有 2 次风格优化调用");
    assert.equal(result.chapterFilePath, null, "不保存章节");
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 9. Story Preservation 明确漂移 → 缩减指导重试通过 → 成功
// ============================================================================

test("P0-preservation: 首次明确漂移 → 缩减指导重试通过 → 成功交付", async () => {
  const input = makeBaseInput();
  let styleCallCount = 0;
  input.modelGenerate = async (modelInput) => {
    if (modelInput.kind === "author_style_optimization") {
      styleCallCount += 1;
      if (styleCallCount === 1) {
        // 首次返回漂移文本 → 明确漂移
        return { text: STYLED_DRIFTED, model: "stub", route: modelInput.route, durationMs: 1 };
      }
      // 重试返回保留事件的优化稿 → 通过
      return { text: STYLED_PRESERVED, model: "stub", route: modelInput.route, durationMs: 1 };
    }
    throw new Error(`未授权调用：${modelInput.kind}`);
  };
  input.generationModelGenerate = input.modelGenerate;
  try {
    const result = await createUnifiedOrchestrator().orchestrate(input);
    assert.equal(result.status, "ok", JSON.stringify(result.failureEnvelope));
    assert.equal(result.selectedSource, "editorial");
    assert.equal(styleCallCount, 2, "应有 2 次风格优化调用");
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 10. Story Preservation 明确漂移 → 重试仍漂移 → hard block
// ============================================================================

test("P0-preservation: 首次明确漂移 → 重试仍漂移 → hard block", async () => {
  const input = makeBaseInput();
  let styleCallCount = 0;
  input.modelGenerate = async (modelInput) => {
    if (modelInput.kind === "author_style_optimization") {
      styleCallCount += 1;
      // 两次都返回漂移文本
      return { text: STYLED_DRIFTED, model: "stub", route: modelInput.route, durationMs: 1 };
    }
    throw new Error(`未授权调用：${modelInput.kind}`);
  };
  input.generationModelGenerate = input.modelGenerate;
  try {
    const result = await createUnifiedOrchestrator().orchestrate(input);
    assert.equal(result.status, "blocked");
    assert.equal(result.selectedSource, null, "blocked 不带 selectedSource");
    assert.equal(result.failureEnvelope?.severity, "hard");
    assert.equal(result.failureEnvelope?.gate, "story_preservation");
    assert.equal(styleCallCount, 2, "应有 2 次风格优化调用");
    assert.equal(result.chapterFilePath, null, "不保存章节");
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 11. 保留人名但整章换剧情 → hard block（审计回归用例）
// ============================================================================

test("P0-preservation: 保留人名但整章换剧情 → hard block（审计回归用例）", async () => {
  const input = makeBaseInput();
  // 风格优化稿保留"李一凡"名字但把全部事件替换为无关剧情
  input.modelGenerate = async (modelInput) => {
    if (modelInput.kind === "author_style_optimization") {
      return { text: STYLED_DRIFTED, model: "stub", route: modelInput.route, durationMs: 1 };
    }
    throw new Error(`未授权调用：${modelInput.kind}`);
  };
  input.generationModelGenerate = input.modelGenerate;
  try {
    const result = await createUnifiedOrchestrator().orchestrate(input);
    // 审计回归：旧阈值 0.15/8 会放过此场景；修复后 0.25/3 必须阻断
    assert.equal(result.status, "blocked", "保留人名但整章换剧情必须被阻断");
    assert.equal(result.selectedSource, null, "blocked 不带 selectedSource");
    assert.equal(result.failureEnvelope?.gate, "story_preservation");
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 12. Agentic 生成超时 → recoverable, gate=model_timeout
// ============================================================================

test("P1-agentic: Agentic 生成超时 → recoverable, gate=model_timeout", async () => {
  const input = makeBaseInput({
    agenticCandidateSource: {
      async generate() {
        throw new Error("Agentic session timed out after 300000ms");
      },
    },
  });
  input.modelGenerate = async () => { throw new Error("不应调用风格优化"); };
  input.generationModelGenerate = input.modelGenerate;
  try {
    const result = await createUnifiedOrchestrator().orchestrate(input);
    assert.equal(result.status, "blocked");
    assert.equal(result.selectedSource, null, "blocked 不带 selectedSource");
    assert.equal(result.failureEnvelope?.severity, "recoverable");
    assert.equal(result.failureEnvelope?.gate, "model_timeout");
    assert.equal(result.failureEnvelope?.retryPlan?.strategy, "chapter_level_retry");
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 13. P1-3 生产探针：source 返回 candidate=null + failureKind=model_timeout
//     真实 Agentic source 会捕获底层异常并返回 candidate=null，
//     而不是让 generate() 抛异常。原先此形态走 generic hardBlock，
//     导致工具层 model_timeout 重试条件不可达。
// ============================================================================

test("P1-3 生产探针: candidate=null + failureKind=model_timeout → recoverable, gate=model_timeout", async () => {
  const input = makeBaseInput({
    agenticCandidateSource: {
      async generate() {
        // 真实 source 形态：捕获异常并返回 candidate=null + failureKind
        return {
          candidate: null,
          sessionId: "session-timeout",
          trajectoryPath: null,
          budgetSnapshot: { usedCalls: 1 },
          stopReason: "model_error",
          failureReason: "agent loop 异常：Agentic session timed out after 300000ms",
          failureKind: "model_timeout",
          sourceRefs: [],
          toolCalls: 0,
          verifierCleared: false,
          repairRounds: 0,
          hardFindingCount: 0,
          unresolvedFindings: [],
        };
      },
    },
  });
  input.modelGenerate = async () => { throw new Error("不应调用风格优化"); };
  input.generationModelGenerate = input.modelGenerate;
  try {
    const result = await createUnifiedOrchestrator().orchestrate(input);
    assert.equal(result.status, "blocked");
    assert.equal(result.selectedSource, null, "blocked 不带 selectedSource");
    // P1-3 关键断言：candidate=null + model_timeout 必须触发 recoverable + chapter_level_retry
    assert.equal(result.failureEnvelope?.severity, "recoverable",
      `failureKind=model_timeout 应触发 recoverable，实际 severity=${result.failureEnvelope?.severity}`);
    assert.equal(result.failureEnvelope?.gate, "model_timeout",
      `gate 应为 model_timeout，实际=${result.failureEnvelope?.gate}`);
    assert.equal(result.failureEnvelope?.retryPlan?.strategy, "chapter_level_retry",
      `retryPlan.strategy 应为 chapter_level_retry，实际=${result.failureEnvelope?.retryPlan?.strategy}`);
    // failureKind 应传播到 trace
    assert.equal(result.stageResults?.novelos?.failureKind, "model_timeout",
      "stageResults.novelos.failureKind 应为 model_timeout");
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 14. P1-3 生产探针：candidate=null + failureKind=model_error → hard block（不可恢复）
//     非超时的模型错误不应触发 chapter_level_retry，避免无限重试非超时错误。
// ============================================================================

test("P1-3 生产探针: candidate=null + failureKind=model_error → hard block", async () => {
  const input = makeBaseInput({
    agenticCandidateSource: {
      async generate() {
        return {
          candidate: null,
          sessionId: "session-error",
          trajectoryPath: null,
          budgetSnapshot: { usedCalls: 1 },
          stopReason: "model_error",
          failureReason: "agent loop 异常：模型返回无效 JSON 响应",
          failureKind: "model_error",
          sourceRefs: [],
          toolCalls: 0,
          verifierCleared: false,
          repairRounds: 0,
          hardFindingCount: 0,
          unresolvedFindings: [],
        };
      },
    },
  });
  input.modelGenerate = async () => { throw new Error("不应调用风格优化"); };
  input.generationModelGenerate = input.modelGenerate;
  try {
    const result = await createUnifiedOrchestrator().orchestrate(input);
    assert.equal(result.status, "blocked");
    assert.equal(result.selectedSource, null, "blocked 不带 selectedSource");
    // P1-3：非超时错误保持 hard block，不触发 chapter_level_retry
    assert.equal(result.failureEnvelope?.severity, "hard",
      `failureKind=model_error 应保持 hard，实际 severity=${result.failureEnvelope?.severity}`);
    assert.notEqual(result.failureEnvelope?.gate, "model_timeout",
      `gate 不应为 model_timeout，实际=${result.failureEnvelope?.gate}`);
    assert.notEqual(result.failureEnvelope?.retryPlan?.strategy, "chapter_level_retry",
      `非超时错误不应触发 chapter_level_retry，实际=${result.failureEnvelope?.retryPlan?.strategy}`);
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 15. P1-3 生产探针：candidate=null 无 failureKind + failureReason 含超时模式 → 向后兼容
//     旧 mock 或第三方 source 实现可能不设置 failureKind，
//     编排器应回退到 failureReason 字符串匹配识别超时。
// ============================================================================

test("P1-3 生产探针: candidate=null 无 failureKind + 超时模式 → 向后兼容 recoverable", async () => {
  const input = makeBaseInput({
    agenticCandidateSource: {
      async generate() {
        // 故意不设置 failureKind（模拟旧 mock / 第三方实现）
        return {
          candidate: null,
          sessionId: "session-legacy",
          trajectoryPath: null,
          budgetSnapshot: { usedCalls: 1 },
          stopReason: "model_error",
          failureReason: "agent loop 异常：ETIMEDOUT 连接上游模型超时",
          sourceRefs: [],
          toolCalls: 0,
          verifierCleared: false,
          repairRounds: 0,
          hardFindingCount: 0,
          unresolvedFindings: [],
        };
      },
    },
  });
  input.modelGenerate = async () => { throw new Error("不应调用风格优化"); };
  input.generationModelGenerate = input.modelGenerate;
  try {
    const result = await createUnifiedOrchestrator().orchestrate(input);
    assert.equal(result.status, "blocked");
    assert.equal(result.selectedSource, null, "blocked 不带 selectedSource");
    // P1-3 向后兼容：无 failureKind 时回退到 failureReason 字符串匹配
    assert.equal(result.failureEnvelope?.severity, "recoverable",
      `failureReason 含超时模式应回退识别为 recoverable，实际 severity=${result.failureEnvelope?.severity}`);
    assert.equal(result.failureEnvelope?.gate, "model_timeout",
      `gate 应为 model_timeout，实际=${result.failureEnvelope?.gate}`);
    assert.equal(result.failureEnvelope?.retryPlan?.strategy, "chapter_level_retry",
      `应触发 chapter_level_retry，实际=${result.failureEnvelope?.retryPlan?.strategy}`);
  } finally {
    rmSync(input.projectRoot, { recursive: true, force: true });
  }
});
