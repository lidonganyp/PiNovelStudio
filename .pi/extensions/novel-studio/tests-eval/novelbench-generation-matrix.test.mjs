/**
 * NB-4 Generation Matrix B0-B4 五层生成矩阵测试（Fix-1：主链路 eval layer）
 *
 * Fix-1 架构变更（禁止独立正文生成器）：
 * - B0-B4 全部通过 UnifiedOrchestrator.orchestrate 走主链路（经 eval-pipeline-adapter）
 * - 不再有独立 prompt ladder（buildB0-B4Prompts/callLayer/parseJudgeJson 已删除）
 * - 层级差异由 evalMode 控制（raw 后 return / editorial / judge select）
 * - B4 judge 由 orchestrate 内部 JudgeArbitrator 完成
 *
 * 测试策略（遵循项目约定：依赖注入桩，不依赖实验性 mock.module）：
 * - GenerationMatrixInput.evalLayerRunner 注入 stub runEvalLayer
 * - stub 记录调用参数（layer/route/seed/timeoutMs）并返回受控 EvalLayerOutput
 * - 隔离 runner 逻辑（toLayerResult/judgeDecision 提取/fallback 检测/totalModelCalls）
 *   与 orchestrate 内部行为
 *
 * 测试维度：
 * 1. Happy path：B0-B4 全部成功，B4 judge 选 editorial → winner=B3
 * 2. B4 judge 选 raw → winner=B2, fallbacked=true
 * 3. B3 fallback：B3 selectedSource="raw" → fallbackFrom="B2"
 * 4. B4 orchestrate 失败 → winner=B2, fallbacked=true
 * 5. B4 orchestrate blocked → winner=B2, fallbacked=true
 * 6. anonymizedMapping：seed 偶数→A=B2, 奇数→A=B3, undefined→A=B2
 * 7. totalModelCalls：各层 modelCalls 累加
 * 8. LayerResult 字段完整性
 * 9. runEvalLayer 调用参数验证（layer/generateRoute/judgeRoute/seed/timeoutMs）
 * 10. 架构边界：generation-matrix-runner.js 不 import reference-registry/analyzer 等
 * 11. 可复现性：同 seed → 同 anonymizedMapping
 * 12. finalText = winner 层文本
 * 13. 架构边界：eval-pipeline-adapter.js 只 import v2/core + types（不 import reference 模块）
 *
 * import 自 dist-eval/novelbench/index.js（lab-only）。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runGenerationMatrix,
  runEvalLayer,
} from "../dist-eval/novelbench/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = join(__dirname, "..");
const GENERATION_MATRIX_RUNNER_JS = join(
  EXT_ROOT, "dist-eval", "novelbench", "generation-matrix-runner.js",
);
const EVAL_PIPELINE_ADAPTER_JS = join(
  EXT_ROOT, "dist-eval", "novelbench", "eval-pipeline-adapter.js",
);

// ─────────────────────────────────────────────────────────────────────────────
// Stub 工具
// ─────────────────────────────────────────────────────────────────────────────

/** 构造一个最小 GeneratorCase（sanitized，无 sourcePath/offset/referenceBody） */
function makeStubGeneratorCase(overrides = {}) {
  return {
    caseId: "test-v1-book001-ch4",
    bookId: "book001",
    authorId: "author001",
    genre: "玄幻",
    mode: "continuation",
    targetChapter: 4,
    generationInputPath: "generation-inputs/test-v1-book001-ch4.txt",
    generationInputHash: "abc123",
    split: "test",
    referenceLocator: {
      referenceId: "test-v1-book001-ch4",
      bodyHash: "def456",
    },
    splitConfidence: 0.95,
    ...overrides,
  };
}

const STUB_ROUTES = {
  b0: "nb4_generate_glm",
  b1: "nb4_generate_glm",
  b2: "nb4_generate_glm",
  b3: "nb4_generate_glm",
  b4: "nb4_judge_glm",
};

const STUB_PREFIX = "前文内容：宋霆踏入执法堂，目光如电。";

/**
 * 构造一个成功的 EvalLayerOutput（模拟 runUnifiedPipeline 成功返回 V2Output）。
 *
 * R1 架构变更：result 形状从 UnifiedOrchestratorOutput 改为 V2Output：
 * - selectedSource / selectedCandidateId / warnings / judgeArbitration 移入 stageResults
 * - 顶层不再有 allArbitrationResults / hypotheses / stateCommit / chapterFilePath
 * - 新增 diagnostics: []（V2Output 必填）
 * - stageResults.unifiedPipeline / evalMode = true（证明走了 runUnifiedPipeline 公开入口）
 *
 * DEMO-3-R1 扩展：支持 judgeArbitration.rounds（降级检测）、editorialOpportunity、
 * candidates（editorial 候选预览），以测试 classifyB4Outcome 的所有分支。
 *
 * @param {string} text - 该层输出正文
 * @param {object} opts - {
 *   selectedSource, judgeAuditSummary, judgeDegraded, judgeConflicted, judgeAllFailed,
 *   judgeArbitration (完整覆盖), modelCalls, warnings, model,
 *   hypothesesCount, editorialOpportunity (完整覆盖),
 *   candidates (完整覆盖), editorialCandidateTexts (快捷构造 editorial 候选),
 *   rawCandidateText (快捷构造 raw 候选),
 * }
 */
function makeSuccessEvalOutput(text, opts = {}) {
  const selectedSource = opts.selectedSource ?? "raw";
  const modelCalls = opts.modelCalls ?? [
    { route: "nb4_generate_glm", kind: "v2_rawstage2", model: "stub-glm", durationMs: 10, ts: 1 },
  ];

  // judgeArbitration 构造：优先用 opts.judgeArbitration 完整覆盖，否则按快捷选项构造
  let judgeArbitration = opts.judgeArbitration ?? null;
  if (!judgeArbitration && opts.judgeAuditSummary) {
    judgeArbitration = {
      auditSummary: opts.judgeAuditSummary,
      finalSelectedCandidateId: selectedSource === "editorial" ? "editorial-0" : null,
      conflicted: opts.judgeConflicted === true ? true : undefined,
      error: opts.judgeAllFailed === true ? "全部裁判异常" : undefined,
      rounds: opts.judgeDegraded === true
        ? [{ round: 1, winnerCandidateId: null, degraded: true }]
        : undefined,
    };
    // 清理 undefined 字段
    for (const k of ["conflicted", "error", "rounds"]) {
      if (judgeArbitration[k] === undefined) delete judgeArbitration[k];
    }
  }

  // editorialOpportunity 构造
  const editorialOpportunity = opts.editorialOpportunity ?? {
    hypothesesCount: opts.hypothesesCount ?? 1,
    noOpReason: opts.hypothesesCount === 0 ? "无 hypothesis" : null,
    llmJudged: true,
    llmFallbackReason: null,
    signals: [],
  };

  // candidates 构造：支持快捷选项 editorialCandidateTexts / rawCandidateText
  let candidates = opts.candidates ?? [];
  if (candidates.length === 0 && (opts.editorialCandidateTexts || opts.rawCandidateText)) {
    if (opts.rawCandidateText) {
      candidates.push({
        id: "raw-0",
        kind: "agentic_raw",
        text: opts.rawCandidateText,
        model: "stub-glm",
        route: "nb4_generate_glm",
      });
    }
    if (opts.editorialCandidateTexts) {
      for (let i = 0; i < opts.editorialCandidateTexts.length; i++) {
        candidates.push({
          id: `editorial-${i}`,
          kind: "editorial_amplified",
          text: opts.editorialCandidateTexts[i],
          model: "stub-glm",
          route: "nb4_generate_glm",
        });
      }
    }
  }

  // DEMO-3-R2.1: editorialFactGuard / editorialStoryPreservation stageResults 构造
  //   用于测试 factguard_block / story_preservation_block 分类
  const editorialFactGuard = opts.editorialFactGuard ?? undefined;
  const editorialStoryPreservation = opts.editorialStoryPreservation ?? undefined;

  const stageResults = {
    modelCalls,
    selectedSource,
    selectedCandidateId: selectedSource === "editorial" ? "editorial-0" : "raw-0",
    warnings: opts.warnings ?? [],
    judgeArbitration,
    editorialOpportunity,
    unifiedPipeline: true,
    evalMode: true,
  };
  if (editorialFactGuard !== undefined) {
    stageResults.editorialFactGuard = editorialFactGuard;
  }
  if (editorialStoryPreservation !== undefined) {
    stageResults.editorialStoryPreservation = editorialStoryPreservation;
  }

  return {
    result: {
      status: "ok",
      workspaceId: "eval-test",
      chapterId: "test-ch4",
      chapterNumber: 4,
      text,
      candidates,
      diagnostics: [],
      failureEnvelope: null,
      stageResults,
    },
    route: opts.route ?? "nb4_generate_glm",
    durationMs: opts.durationMs ?? 100,
    success: true,
    model: opts.model ?? "stub-glm",
    text,
  };
}

/**
 * 构造一个失败的 EvalLayerOutput（模拟 runUnifiedPipeline blocked 或异常）。
 * R1：result 形状为 V2Output（selectedSource/warnings 在 stageResults 中）。
 */
function makeFailedEvalOutput(reason, opts = {}) {
  return {
    result: {
      status: "blocked",
      workspaceId: "eval-test",
      chapterId: "test-ch4",
      chapterNumber: 4,
      text: "",
      candidates: [],
      diagnostics: [],
      failureEnvelope: {
        stage: "eval_layer",
        severity: "hard",
        reason,
        recoverable: false,
        degradedTo: "hard_block",
      },
      stageResults: {
        modelCalls: [],
        selectedSource: "raw",
        selectedCandidateId: "",
        warnings: [],
        judgeArbitration: null,
        unifiedPipeline: true,
        evalMode: true,
      },
    },
    route: opts.route ?? "nb4_generate_glm",
    durationMs: opts.durationMs ?? 50,
    success: false,
    fallbackReason: reason,
    model: "failed",
    text: "",
  };
}

/**
 * 创建一个 stub evalLayerRunner，记录所有调用并按 layer 返回受控输出。
 * @param {Record<string, object>} outputs - { B0: EvalLayerOutput, B1: ..., ... }
 * @returns {{ runner: Function, calls: Array }}
 */
function createStubEvalRunner(outputs) {
  const calls = [];
  const runner = async (layer, genCase, prefix, modelGenerate, generateRoute, judgeRoute, seed, timeoutMs) => {
    calls.push({ layer, genCase, prefix, generateRoute, judgeRoute, seed, timeoutMs });
    const out = outputs[layer];
    if (!out) {
      throw new Error(`stub evalLayerRunner: no output configured for layer ${layer}`);
    }
    return out;
  };
  return { runner, calls };
}

/** 默认 happy-path 输出：B0-B3 各返回不同文本，B4 judge 选 editorial */
function makeDefaultOutputs() {
  return {
    B0: makeSuccessEvalOutput("B0 基线正文。", {
      selectedSource: "raw",
      modelCalls: [{ route: "nb4_generate_glm", kind: "v2_rawstage2", model: "stub-glm", durationMs: 10, ts: 1 }],
    }),
    B1: makeSuccessEvalOutput("B1 上下文增强正文。", {
      selectedSource: "raw",
      modelCalls: [{ route: "nb4_generate_glm", kind: "v2_rawstage2", model: "stub-glm", durationMs: 10, ts: 2 }],
    }),
    B2: makeSuccessEvalOutput("B2 意图增强正文，含悬念。", {
      selectedSource: "raw",
      modelCalls: [{ route: "nb4_generate_glm", kind: "v2_rawstage2", model: "stub-glm", durationMs: 10, ts: 3 }],
    }),
    B3: makeSuccessEvalOutput("B3 编辑改写正文，文学性更强。", {
      selectedSource: "editorial",
      modelCalls: [
        { route: "nb4_generate_glm", kind: "v2_rawstage2", model: "stub-glm", durationMs: 10, ts: 4 },
        { route: "nb4_generate_glm", kind: "v2_amplified", model: "stub-glm", durationMs: 10, ts: 5 },
      ],
    }),
    B4: makeSuccessEvalOutput("B3 编辑改写正文，文学性更强。", {
      selectedSource: "editorial",
      judgeAuditSummary: "editorial 候选在文学性与信息释放维度胜出",
      modelCalls: [
        { route: "nb4_generate_glm", kind: "v2_rawstage2", model: "stub-glm", durationMs: 10, ts: 6 },
        { route: "nb4_generate_glm", kind: "v2_amplified", model: "stub-glm", durationMs: 10, ts: 7 },
        { route: "nb4_judge_glm", kind: "v2_judge", model: "stub-glm", durationMs: 10, ts: 8 },
      ],
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Happy path：B0-B4 全部成功，judge 选 editorial
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-4 Generation Matrix Happy Path（主链路 evalMode）", () => {
  test("B0-B4 全部成功，B4 judge 选 editorial → winner=B3，finalText=B3 文本", async () => {
    const { runner, calls } = createStubEvalRunner(makeDefaultOutputs());
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    // 五层全部成功
    assert.equal(result.layers.B0.success, true, "B0 应成功");
    assert.equal(result.layers.B1.success, true, "B1 应成功");
    assert.equal(result.layers.B2.success, true, "B2 应成功");
    assert.equal(result.layers.B3.success, true, "B3 应成功");
    assert.equal(result.layers.B4.success, true, "B4 应成功");

    // 各层文本可区分
    assert.equal(result.layers.B0.text, "B0 基线正文。");
    assert.equal(result.layers.B1.text, "B1 上下文增强正文。");
    assert.equal(result.layers.B2.text, "B2 意图增强正文，含悬念。");
    assert.equal(result.layers.B3.text, "B3 编辑改写正文，文学性更强。");

    // judge 选 editorial → winner=B3
    assert.equal(result.judgeDecision.winner, "B3");
    assert.equal(result.judgeDecision.fallbacked, false);
    assert.equal(result.judgeDecision.outcomeType, "editorial_win",
      "editorial 胜出应分类为 editorial_win");
    assert.equal(
      result.judgeDecision.reason,
      "editorial 候选在文学性与信息释放维度胜出",
    );

    // finalText = B3 文本（winner=B3）
    assert.equal(result.finalSource, "B3");
    assert.equal(result.finalText, "B3 编辑改写正文，文学性更强。");

    // 5 次 evalLayerRunner 调用（B0+B1+B2+B3+B4）
    assert.equal(calls.length, 5);

    // totalModelCalls = 各层 modelCalls 累加（1+1+1+2+3=8）
    assert.equal(result.totalModelCalls, 8);
  });

  test("runner 调用 evalLayerRunner 时传入正确的 layer/generateRoute/judgeRoute", async () => {
    const { runner, calls } = createStubEvalRunner(makeDefaultOutputs());
    await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 42,
      timeoutMs: 8000,
      evalLayerRunner: runner,
    });

    // 验证每层调用参数
    assert.equal(calls[0].layer, "B0");
    assert.equal(calls[0].generateRoute, "nb4_generate_glm");
    assert.equal(calls[0].judgeRoute, "nb4_judge_glm");
    assert.equal(calls[0].seed, 42);
    assert.equal(calls[0].timeoutMs, 8000);

    assert.equal(calls[1].layer, "B1");
    assert.equal(calls[2].layer, "B2");
    assert.equal(calls[3].layer, "B3");
    assert.equal(calls[4].layer, "B4");

    // B4 的 generateRoute 用 routes.b3（editorial 生成路由），judgeRoute 用 routes.b4
    assert.equal(calls[4].generateRoute, "nb4_generate_glm");
    assert.equal(calls[4].judgeRoute, "nb4_judge_glm");

    // prefix 正确传递
    for (const call of calls) {
      assert.equal(call.prefix, STUB_PREFIX);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. B4 结果分类（DEMO-3-R1：classifyB4Outcome 全分支覆盖）
//
//    DEMO-3-R1 语义变更：fallbacked = (outcomeType !== "editorial_win")。
//    所有非 editorial 胜出的结果（judge 选 raw、judge 降级、FactGuard 阻断、
//    预算回退、无编辑机会、orchestrate 失败）都是 fallback。
//    这确保 pairOutcomesPure 只含 editorial_win，pairOutcomesWithFallback 含其余所有。
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-4 B4 结果分类（DEMO-3-R1 classifyB4Outcome）", () => {
  test("editorial_win: B4 selectedSource=editorial → winner=B3, fallbacked=false, outcomeType=editorial_win", async () => {
    const outputs = makeDefaultOutputs();
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    assert.equal(result.judgeDecision.winner, "B3");
    assert.equal(result.judgeDecision.fallbacked, false);
    assert.equal(result.judgeDecision.outcomeType, "editorial_win");
    assert.equal(result.layers.B4.fallbackFrom, undefined, "editorial_win 不标记 fallbackFrom");
    assert.equal(result.layers.B4.b4Details.outcomeType, "editorial_win");
    assert.equal(result.layers.B4.b4Details.selectedSource, "editorial");
  });

  test("judge_raw: B4 selectedSource=raw + judgeArbitration 存在且正常 → fallbacked=true, outcomeType=judge_raw", async () => {
    const outputs = makeDefaultOutputs();
    outputs.B4 = makeSuccessEvalOutput("B2 意图增强正文，含悬念。", {
      selectedSource: "raw",
      judgeAuditSummary: "raw 基线在自然度维度胜出",
      warnings: ["editorial 候选未明确胜出 raw"],
      modelCalls: [
        { route: "nb4_generate_glm", kind: "v2_rawstage2", model: "stub-glm", durationMs: 10, ts: 6 },
        { route: "nb4_generate_glm", kind: "v2_amplified", model: "stub-glm", durationMs: 10, ts: 7 },
        { route: "nb4_judge_glm", kind: "v2_judge", model: "stub-glm", durationMs: 10, ts: 8 },
      ],
    });
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    // DEMO-3-R1：judge 正常选 raw 也是 fallback（未产出有效 editorial 胜出）
    assert.equal(result.judgeDecision.winner, "B2");
    assert.equal(result.judgeDecision.fallbacked, true, "judge 选 raw 是 fallback（非 editorial_win）");
    assert.equal(result.judgeDecision.outcomeType, "judge_raw");
    assert.equal(result.judgeDecision.reason, "raw 基线在自然度维度胜出");
    assert.equal(result.finalSource, "B2");
    assert.equal(result.finalText, "B2 意图增强正文，含悬念。");

    // B4 层标记 fallbackFrom=B2
    assert.equal(result.layers.B4.fallbackFrom, "B2", "B4 应标记 fallbackFrom=B2");
    assert.ok(result.layers.B4.fallbackReason, "B4 应有 fallbackReason");
    assert.equal(result.layers.B4.b4Details.outcomeType, "judge_raw");
    assert.equal(result.layers.B4.b4Details.judgeDegraded, false);
    assert.equal(result.layers.B4.b4Details.judgeConflicted, false);
  });

  test("judge_degraded: B4 judge 降级（rounds[0].degraded=true）→ fallbacked=true, outcomeType=judge_degraded", async () => {
    const outputs = makeDefaultOutputs();
    outputs.B4 = makeSuccessEvalOutput("B4 内部 raw 正文。", {
      selectedSource: "raw",
      judgeAuditSummary: "首轮裁判降级（LLM 输出 parse 失败或字段缺失），保留 raw，不反向复判",
      judgeDegraded: true, // 构造 rounds: [{ round:1, winnerCandidateId:null, degraded:true }]
      warnings: ["裁判降级（LLM 输出 parse 失败），保留 raw"],
      modelCalls: [
        { route: "nb4_generate_glm", kind: "v2_rawstage2", model: "stub-glm", durationMs: 10, ts: 6 },
        { route: "nb4_generate_glm", kind: "v2_amplified", model: "stub-glm", durationMs: 10, ts: 7 },
        { route: "nb4_judge_glm", kind: "v2_judge", model: "stub-glm", durationMs: 10, ts: 8 },
      ],
    });
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    // DEMO-3-R1 核心修复：judge 降级必须正确标为 fallback（旧逻辑误判为 fallbacked=false）
    assert.equal(result.judgeDecision.winner, "B2");
    assert.equal(result.judgeDecision.fallbacked, true,
      "judge 降级必须标为 fallback（DEMO-3-R1 核心修复）");
    assert.equal(result.judgeDecision.outcomeType, "judge_degraded");
    assert.ok(
      result.judgeDecision.reason.includes("降级"),
      `reason 应提及降级，实际：${result.judgeDecision.reason}`,
    );
    assert.equal(result.layers.B4.fallbackFrom, "B2");
    assert.equal(result.layers.B4.b4Details.outcomeType, "judge_degraded");
    assert.equal(result.layers.B4.b4Details.judgeDegraded, true,
      "b4Details.judgeDegraded 应为 true");
  });

  test("judge_degraded: auditSummary 含'降级'但无 rounds 字段 → 仍正确识别为 judge_degraded", async () => {
    // 模拟旧 mapOrchResultToV2Output 行为（rounds 被剥离），仅靠 auditSummary 检测降级
    const outputs = makeDefaultOutputs();
    outputs.B4 = makeSuccessEvalOutput("B4 内部 raw 正文。", {
      selectedSource: "raw",
      judgeArbitration: {
        // 无 rounds 字段（模拟旧 V2Output 映射），但 auditSummary 含"降级"
        auditSummary: "首轮裁判降级（parse 失败），保留 raw",
        finalSelectedCandidateId: null,
      },
      warnings: ["裁判降级（parse 失败），保留 raw"],
      modelCalls: [
        { route: "nb4_generate_glm", kind: "v2_rawstage2", model: "stub-glm", durationMs: 10, ts: 6 },
      ],
    });
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    assert.equal(result.judgeDecision.outcomeType, "judge_degraded",
      "auditSummary 含'降级'应识别为 judge_degraded（即使无 rounds 字段）");
    assert.equal(result.judgeDecision.fallbacked, true);
    assert.equal(result.layers.B4.b4Details.judgeDegraded, true);
  });

  test("judge_conflict: B4 两轮裁判冲突 → fallbacked=true, outcomeType=judge_conflict", async () => {
    const outputs = makeDefaultOutputs();
    outputs.B4 = makeSuccessEvalOutput("B4 内部 raw 正文。", {
      selectedSource: "raw",
      judgeAuditSummary: "两轮裁判冲突，保留 raw",
      judgeConflicted: true,
      warnings: ["两轮裁判冲突，保留 raw"],
      modelCalls: [
        { route: "nb4_generate_glm", kind: "v2_rawstage2", model: "stub-glm", durationMs: 10, ts: 6 },
      ],
    });
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    assert.equal(result.judgeDecision.outcomeType, "judge_conflict");
    assert.equal(result.judgeDecision.fallbacked, true);
    assert.equal(result.layers.B4.b4Details.judgeConflicted, true);
  });

  test("judge_all_failed: B4 所有裁判异常 → fallbacked=true, outcomeType=judge_all_failed", async () => {
    const outputs = makeDefaultOutputs();
    outputs.B4 = makeSuccessEvalOutput("B4 内部 raw 正文。", {
      selectedSource: "raw",
      judgeAuditSummary: undefined,
      judgeAllFailed: true,
      judgeArbitration: { error: "全部裁判异常" },
      warnings: ["所有 editorial 候选裁判均异常，交付 raw"],
      modelCalls: [
        { route: "nb4_generate_glm", kind: "v2_rawstage2", model: "stub-glm", durationMs: 10, ts: 6 },
      ],
    });
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    assert.equal(result.judgeDecision.outcomeType, "judge_all_failed");
    assert.equal(result.judgeDecision.fallbacked, true);
    assert.equal(result.layers.B4.b4Details.judgeAllFailed, true);
  });

  test("no_editorial: B4 无编辑机会（hypothesesCount=0, judgeArbitration=null）→ fallbacked=true, outcomeType=no_editorial", async () => {
    const outputs = makeDefaultOutputs();
    outputs.B4 = makeSuccessEvalOutput("B4 内部 raw 正文。", {
      selectedSource: "raw",
      judgeAuditSummary: undefined, // judgeArbitration=null
      hypothesesCount: 0,
      warnings: ["无编辑机会（无 hypothesis），交付 raw"],
      modelCalls: [
        { route: "nb4_generate_glm", kind: "v2_rawstage2", model: "stub-glm", durationMs: 10, ts: 6 },
      ],
    });
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    assert.equal(result.judgeDecision.outcomeType, "no_editorial");
    assert.equal(result.judgeDecision.fallbacked, true);
    assert.equal(result.layers.B4.b4Details.hypothesesCount, 0);
    assert.equal(result.layers.B4.b4Details.editorialCandidateCount, 0);
  });

  test("budget_fallback: B4 模型调用达软上限 → fallbacked=true, outcomeType=budget_fallback", async () => {
    const outputs = makeDefaultOutputs();
    outputs.B4 = makeSuccessEvalOutput("B4 内部 raw 正文。", {
      selectedSource: "raw",
      judgeAuditSummary: undefined,
      warnings: ["模型调用达软上限（非 agentic 6/6，总 8），跳过 editorial 候选生成，交付 raw"],
      modelCalls: [
        { route: "nb4_generate_glm", kind: "v2_rawstage2", model: "stub-glm", durationMs: 10, ts: 6 },
      ],
    });
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    assert.equal(result.judgeDecision.outcomeType, "budget_fallback");
    assert.equal(result.judgeDecision.fallbacked, true);
  });

  test("factguard_block: B4 FactGuard 阻断（judgeArbitration=null + warning 含 FactGuard）→ fallbacked=true, outcomeType=factguard_block", async () => {
    const outputs = makeDefaultOutputs();
    outputs.B4 = makeSuccessEvalOutput("B2 意图增强正文，含悬念。", {
      selectedSource: "raw",
      judgeAuditSummary: undefined, // judgeArbitration=null
      warnings: ["FactGuard 阻断 editorial 候选"],
      modelCalls: [
        { route: "nb4_generate_glm", kind: "v2_rawstage2", model: "stub-glm", durationMs: 10, ts: 6 },
      ],
    });
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    assert.equal(result.judgeDecision.winner, "B2");
    assert.equal(result.judgeDecision.fallbacked, true);
    assert.equal(result.judgeDecision.outcomeType, "factguard_block");
    assert.ok(
      result.judgeDecision.reason.includes("FactGuard 阻断"),
      `reason 应提及 FactGuard 阻断，实际：${result.judgeDecision.reason}`,
    );
    assert.equal(result.finalSource, "B2");
    assert.equal(result.finalText, "B2 意图增强正文，含悬念。");
    assert.equal(result.layers.B4.fallbackFrom, "B2");
    assert.ok(result.layers.B4.fallbackReason);
  });

  // DEMO-3-R2.1: factguard_block 匹配修正 — orchestrator 实际 warning 字符串
  //   "所有 editorial 候选均未通过 FactGuard，交付 raw"（不含"阻断"二字）
  //   旧匹配 w.includes("FactGuard 阻断") 会漏判 → fall-through 到 no_editorial
  test("factguard_block（R2.1 修正）: orchestrator 实际 warning '所有 editorial 候选均未通过 FactGuard，交付 raw' → outcomeType=factguard_block", async () => {
    const outputs = makeDefaultOutputs();
    outputs.B4 = makeSuccessEvalOutput("B2 意图增强正文，含悬念。", {
      selectedSource: "raw",
      judgeAuditSummary: undefined, // judgeArbitration=null
      hypothesesCount: 1,
      editorialCandidateTexts: ["漂移 editorial 正文。"],
      rawCandidateText: "B2 意图增强正文，含悬念。",
      warnings: ["所有 editorial 候选均未通过 FactGuard，交付 raw"],
      editorialFactGuard: [
        { candidateId: "editorial-0", passed: false, errors: ["duplicate_scan: 大段重复"] },
      ],
      modelCalls: [
        { route: "nb4_generate_glm", kind: "v2_rawstage2", model: "stub-glm", durationMs: 10, ts: 6 },
      ],
    });
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    assert.equal(result.judgeDecision.outcomeType, "factguard_block",
      "orchestrator warning '未通过 FactGuard' 应分类为 factguard_block（R2.1 修正）");
    assert.equal(result.judgeDecision.fallbacked, true);
    assert.equal(result.layers.B4.b4Details.factGuardRejectionCount, 1,
      "b4Details 应持久化 factGuardRejectionCount=1");
  });

  // DEMO-3-R2.1 新增: story_preservation_block 分类
  //   editorial 候选已通过 FactGuard，但全部被 StoryPreservationGate 拒绝
  test("story_preservation_block（R2.1 新增）: editorial 通过 FactGuard 但被 StoryPreservationGate 拒绝 → outcomeType=story_preservation_block", async () => {
    const outputs = makeDefaultOutputs();
    outputs.B4 = makeSuccessEvalOutput("B2 意图增强正文，含悬念。", {
      selectedSource: "raw",
      judgeAuditSummary: undefined, // judgeArbitration=null（judge 未运行）
      hypothesesCount: 1,
      editorialCandidateTexts: ["漂移 editorial 正文，删除 raw 关键事件。"],
      rawCandidateText: "B2 意图增强正文，含悬念。",
      warnings: ["所有 editorial 候选均未通过 StoryPreservationGate（故事骨架漂移），交付 raw"],
      editorialFactGuard: [
        { candidateId: "editorial-0", passed: true, errors: [] },
      ],
      editorialStoryPreservation: [
        {
          candidateId: "editorial-0",
          preserved: false,
          unverifiable: false,
          rejectionType: "replaced_event",
          missingEventCount: 0,
          replacedEventCount: 3,
          orderViolationCount: 0,
          reason: "故事骨架漂移：新增 3 个替换实体（阈值 1）",
        },
      ],
      modelCalls: [
        { route: "nb4_generate_glm", kind: "v2_rawstage2", model: "stub-glm", durationMs: 10, ts: 6 },
      ],
    });
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    // 1. 分类为 story_preservation_block（不是 no_editorial 也不是 factguard_block）
    assert.equal(result.judgeDecision.outcomeType, "story_preservation_block",
      "StoryPreservationGate 拒绝应分类为 story_preservation_block");
    assert.equal(result.judgeDecision.winner, "B2");
    assert.equal(result.judgeDecision.fallbacked, true,
      "story_preservation_block 是 fallback（不进入 pairOutcomesPure）");

    // 2. b4Details 持久化各阶段拒绝原因
    assert.equal(result.layers.B4.b4Details.storyPreservationRejectionCount, 1,
      "b4Details 应持久化 storyPreservationRejectionCount=1");
    assert.equal(result.layers.B4.b4Details.factGuardRejectionCount, 0,
      "FactGuard 通过，factGuardRejectionCount=0");
    assert.ok(result.layers.B4.b4Details.storyPreservationReports.length > 0,
      "b4Details 应持久化 storyPreservationReports");
    const spr = result.layers.B4.b4Details.storyPreservationReports[0];
    assert.equal(spr.rejectionType, "replaced_event");
    assert.equal(spr.replacedEventCount, 3);

    // 3. fallbacked=true → 不进入 pairOutcomesPure
    assert.equal(result.judgeDecision.fallbacked, true);

    // 4. reason 提及 StoryPreservationGate
    assert.ok(
      result.judgeDecision.reason.includes("StoryPreservationGate"),
      `reason 应提及 StoryPreservationGate，实际：${result.judgeDecision.reason}`,
    );
  });

  // DEMO-3-R2.1: no_editorial 收紧 — 必须是 0 hypothesis 且无 FactGuard/StoryPreservation warning
  //   若有 FactGuard warning，应分类为 factguard_block 而非 no_editorial
  test("no_editorial（R2.1 收紧）: 0 hypothesis + 无 FactGuard/StoryPreservation warning → outcomeType=no_editorial", async () => {
    const outputs = makeDefaultOutputs();
    outputs.B4 = makeSuccessEvalOutput("B4 内部 raw 正文。", {
      selectedSource: "raw",
      judgeAuditSummary: undefined,
      hypothesesCount: 0,
      warnings: ["无编辑机会（无 hypothesis），交付 raw"],
      modelCalls: [
        { route: "nb4_generate_glm", kind: "v2_rawstage2", model: "stub-glm", durationMs: 10, ts: 6 },
      ],
    });
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    assert.equal(result.judgeDecision.outcomeType, "no_editorial");
    assert.equal(result.judgeDecision.fallbacked, true);
    assert.equal(result.layers.B4.b4Details.hypothesesCount, 0);
    assert.equal(result.layers.B4.b4Details.factGuardRejectionCount, 0);
    assert.equal(result.layers.B4.b4Details.storyPreservationRejectionCount, 0);
  });

  test("orchestrate_failed: B4 orchestrate 失败 → fallbacked=true, outcomeType=orchestrate_failed", async () => {
    const outputs = makeDefaultOutputs();
    outputs.B4 = makeFailedEvalOutput("orchestrate 内部异常：model timeout");
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    assert.equal(result.judgeDecision.winner, "B2");
    assert.equal(result.judgeDecision.fallbacked, true);
    assert.equal(result.judgeDecision.outcomeType, "orchestrate_failed");
    assert.ok(result.judgeDecision.reason.includes("保守回退"));
    assert.equal(result.finalSource, "B2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2b. DEMO-3-R1 阶段1：B4 b4Details trace 持久化验证
//     editorial 候选预览 + raw 候选预览 + judge 状态
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-4 B4 b4Details trace 持久化（DEMO-3-R1 阶段1）", () => {
  test("editorial_win 时 b4Details 含 editorial 候选预览和 raw 候选预览", async () => {
    const outputs = makeDefaultOutputs();
    // 为 B4 构造带 editorial 候选和 raw 候选的输出
    outputs.B4 = makeSuccessEvalOutput("B3 编辑改写正文，文学性更强。", {
      selectedSource: "editorial",
      judgeAuditSummary: "editorial 候选在文学性维度胜出",
      rawCandidateText: "B4 内部 raw 正文，处决洪逸后梦堂缺位。",
      editorialCandidateTexts: ["B3 编辑改写正文，文学性更强。"],
      modelCalls: [
        { route: "nb4_generate_glm", kind: "v2_rawstage2", model: "stub-glm", durationMs: 10, ts: 6 },
        { route: "nb4_generate_glm", kind: "v2_amplified", model: "stub-glm", durationMs: 10, ts: 7 },
        { route: "nb4_judge_glm", kind: "v2_judge", model: "stub-glm", durationMs: 10, ts: 8 },
      ],
    });
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    const details = result.layers.B4.b4Details;
    assert.ok(details, "B4 应有 b4Details");
    assert.equal(details.outcomeType, "editorial_win");
    assert.equal(details.selectedSource, "editorial");
    assert.equal(details.editorialCandidateCount, 1);
    assert.equal(details.editorialCandidatePreviews.length, 1);
    assert.equal(details.editorialCandidatePreviews[0].id, "editorial-0");
    assert.ok(details.editorialCandidatePreviews[0].preview.length > 0,
      "editorial 候选预览应非空");
    assert.ok(details.rawCandidatePreview.length > 0,
      "raw 候选预览应非空");
    // 验证 editorial 候选和 raw 候选不是同一文本（增量编辑，非复制）
    assert.notEqual(
      details.editorialCandidatePreviews[0].preview,
      details.rawCandidatePreview,
      "editorial 候选和 raw 候选应为不同文本",
    );
  });

  test("judge_degraded 时 b4Details 记录 judgeDegraded=true 和 auditSummary", async () => {
    const outputs = makeDefaultOutputs();
    outputs.B4 = makeSuccessEvalOutput("B4 内部 raw 正文。", {
      selectedSource: "raw",
      judgeAuditSummary: "首轮裁判降级（parse 失败），保留 raw",
      judgeDegraded: true,
      warnings: ["裁判降级（parse 失败），保留 raw"],
      rawCandidateText: "B4 内部 raw 正文。",
      editorialCandidateTexts: ["editorial 候选文本。"],
      modelCalls: [
        { route: "nb4_generate_glm", kind: "v2_rawstage2", model: "stub-glm", durationMs: 10, ts: 6 },
      ],
    });
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    const details = result.layers.B4.b4Details;
    assert.equal(details.outcomeType, "judge_degraded");
    assert.equal(details.judgeDegraded, true);
    assert.ok(details.judgeAuditSummary.includes("降级"));
    assert.equal(details.editorialCandidateCount, 1,
      "judge 降级前应已生成 editorial 候选");
    assert.ok(details.editorialCandidatePreviews[0].preview.length > 0,
      "editorial 候选预览应持久化，用于事后验证是否基于 raw 增量编辑");
  });

  test("b4Details.editorialCandidatePreviews 截断为 500 字符", async () => {
    const longEditorialText = "editorial 候选。".repeat(100); // > 500 字符
    const outputs = makeDefaultOutputs();
    outputs.B4 = makeSuccessEvalOutput("B3 编辑改写正文。", {
      selectedSource: "editorial",
      judgeAuditSummary: "editorial 胜出",
      rawCandidateText: "raw 正文。",
      editorialCandidateTexts: [longEditorialText],
      modelCalls: [
        { route: "nb4_generate_glm", kind: "v2_rawstage2", model: "stub-glm", durationMs: 10, ts: 6 },
      ],
    });
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    const details = result.layers.B4.b4Details;
    assert.ok(details.editorialCandidatePreviews[0].preview.length <= 500,
      `预览应截断为 ≤500 字符，实际：${details.editorialCandidatePreviews[0].preview.length}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. B3 正常交付 verified agentic_raw（selectedSource=raw，无 fallback）
//    R5 修正：B3 交付 verified agentic_raw（selectedSource="raw"，FactGuard 通过）
//    是正常行为，不是 fallback。B3 层不再检测 fallback。
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-4 B3 正常交付 verified agentic_raw（无 fallback）", () => {
  test("B3 selectedSource=raw（FactGuard 通过）→ 无 fallback，B3 文本=verified agentic_raw", async () => {
    const outputs = makeDefaultOutputs();
    // B3 正常交付 verified agentic_raw（FactGuard 通过，无 editorial/judge）
    outputs.B3 = makeSuccessEvalOutput("B3 verified agentic_raw 正文，FactGuard 通过。", {
      selectedSource: "raw",
      warnings: [],
      modelCalls: [
        { route: "nb4_generate_glm", kind: "v2_rawstage2", model: "stub-glm", durationMs: 10, ts: 4 },
      ],
    });
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    // R5 修正：B3 正常交付 verified agentic_raw，不标记 fallback
    assert.equal(result.layers.B3.success, true, "B3 orchestrate 成功（status=ok）");
    assert.equal(result.layers.B3.fallbackFrom, undefined, "B3 不应标记 fallbackFrom");
    assert.equal(result.layers.B3.fallbackReason, undefined, "B3 不应有 fallbackReason");
    assert.equal(result.layers.B3.text, "B3 verified agentic_raw 正文，FactGuard 通过。");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. B4 orchestrate 失败 → winner=B2, fallbacked=true
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-4 B4 orchestrate 失败", () => {
  test("B4 orchestrate 抛异常 → success=false, winner=B2, fallbacked=true", async () => {
    const outputs = makeDefaultOutputs();
    outputs.B4 = makeFailedEvalOutput("orchestrate 内部异常：model timeout");
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    // B4 失败
    assert.equal(result.layers.B4.success, false);
    assert.equal(result.layers.B4.text, "");
    assert.ok(result.layers.B4.fallbackReason.includes("model timeout"));

    // judge 回退 B2
    assert.equal(result.judgeDecision.winner, "B2");
    assert.equal(result.judgeDecision.fallbacked, true);
    assert.ok(
      result.judgeDecision.reason.includes("保守回退 B2"),
      `reason 应提及保守回退，实际：${result.judgeDecision.reason}`,
    );

    // finalText = B2 文本
    assert.equal(result.finalSource, "B2");
    assert.equal(result.finalText, "B2 意图增强正文，含悬念。");
  });

  test("B4 orchestrate 返回 blocked → success=false, winner=B2", async () => {
    const outputs = makeDefaultOutputs();
    outputs.B4 = makeFailedEvalOutput("raw 生成失败，hard block");
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    assert.equal(result.layers.B4.success, false);
    assert.equal(result.judgeDecision.winner, "B2");
    assert.equal(result.judgeDecision.fallbacked, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. 匿名映射（seed 决定 A/B 顺序）
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-4 匿名映射（seed 决定 A/B 顺序）", () => {
  test("seed=0（偶数）→ A=B2, B=B3", async () => {
    const { runner } = createStubEvalRunner(makeDefaultOutputs());
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    assert.deepEqual(result.judgeDecision.anonymizedMapping, { A: "B2", B: "B3" });
  });

  test("seed=1（奇数）→ A=B3, B=B2", async () => {
    const { runner } = createStubEvalRunner(makeDefaultOutputs());
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 1,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    assert.deepEqual(result.judgeDecision.anonymizedMapping, { A: "B3", B: "B2" });
  });

  test("seed=2（偶数）→ A=B2, B=B3", async () => {
    const { runner } = createStubEvalRunner(makeDefaultOutputs());
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 2,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    assert.deepEqual(result.judgeDecision.anonymizedMapping, { A: "B2", B: "B3" });
  });

  test("seed=undefined → A=B2, B=B3（默认）", async () => {
    const { runner } = createStubEvalRunner(makeDefaultOutputs());
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      // seed 未传
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    assert.deepEqual(result.judgeDecision.anonymizedMapping, { A: "B2", B: "B3" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. totalModelCalls 累加
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-4 totalModelCalls 累加", () => {
  test("各层 modelCalls 数量正确累加", async () => {
    const outputs = makeDefaultOutputs();
    // B0=1 call, B1=1 call, B2=1 call, B3=2 calls, B4=3 calls → total=8
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    assert.equal(result.totalModelCalls, 8);
  });

  test("B4 失败时 modelCalls=0（blocked 无 modelCalls）", async () => {
    const outputs = makeDefaultOutputs();
    outputs.B4 = makeFailedEvalOutput("B4 失败");
    // B0=1 + B1=1 + B2=1 + B3=2 + B4=0 = 5
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    assert.equal(result.totalModelCalls, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. LayerResult 字段完整性
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-4 LayerResult 字段完整性", () => {
  test("成功层含 layer/text/model/route/durationMs/success/promptHash", async () => {
    const { runner } = createStubEvalRunner(makeDefaultOutputs());
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    const b0 = result.layers.B0;
    assert.equal(b0.layer, "B0");
    assert.equal(typeof b0.text, "string");
    assert.equal(typeof b0.model, "string");
    assert.equal(typeof b0.route, "string");
    assert.equal(typeof b0.durationMs, "number");
    assert.equal(b0.success, true);
    assert.ok(b0.promptHash, "成功层应有 promptHash");
    assert.equal(b0.fallbackFrom, undefined);
  });

  test("失败层含 fallbackReason", async () => {
    const outputs = makeDefaultOutputs();
    outputs.B2 = makeFailedEvalOutput("B2 raw 生成失败");
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    assert.ok(result.layers.B2.fallbackReason, "B2 失败层应有 fallbackReason");
    assert.equal(result.layers.B2.success, false);
  });

  test("result 含 caseId/totalDurationMs/totalModelCalls", async () => {
    const { runner } = createStubEvalRunner(makeDefaultOutputs());
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase({ caseId: "my-case-id" }),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    assert.equal(result.caseId, "my-case-id");
    assert.equal(typeof result.totalDurationMs, "number");
    assert.ok(result.totalDurationMs >= 0);
    assert.equal(typeof result.totalModelCalls, "number");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. finalText = winner 层文本
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-4 finalText 与 winner 一致", () => {
  test("winner=B3 时 finalText=B3 层文本", async () => {
    const { runner } = createStubEvalRunner(makeDefaultOutputs());
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    assert.equal(result.judgeDecision.winner, "B3");
    assert.equal(result.finalText, result.layers.B3.text);
  });

  test("winner=B2 时 finalText=B2 层文本", async () => {
    const outputs = makeDefaultOutputs();
    outputs.B4 = makeSuccessEvalOutput("B2 意图增强正文，含悬念。", {
      selectedSource: "raw",
      judgeAuditSummary: "raw 胜出",
    });
    const { runner } = createStubEvalRunner(outputs);
    const result = await runGenerationMatrix({
      case: makeStubGeneratorCase(),
      prefix: STUB_PREFIX,
      modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
      routes: STUB_ROUTES,
      seed: 0,
      timeoutMs: 5000,
      evalLayerRunner: runner,
    });

    assert.equal(result.judgeDecision.winner, "B2");
    assert.equal(result.finalText, result.layers.B2.text);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. 可复现性（同 seed 同输入 → 同匿名映射）
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-4 可复现性", () => {
  test("同 seed 两次运行 → 匿名映射一致", async () => {
    const runOnce = async () => {
      const { runner } = createStubEvalRunner(makeDefaultOutputs());
      return runGenerationMatrix({
        case: makeStubGeneratorCase(),
        prefix: STUB_PREFIX,
        modelGenerate: async () => ({ text: "stub", model: "stub-glm", route: "stub", durationMs: 1 }),
        routes: STUB_ROUTES,
        seed: 7, // 奇数
        timeoutMs: 5000,
        evalLayerRunner: runner,
      });
    };

    const r1 = await runOnce();
    const r2 = await runOnce();

    assert.deepEqual(
      r1.judgeDecision.anonymizedMapping,
      r2.judgeDecision.anonymizedMapping,
      "同 seed 应产生相同匿名映射",
    );
    assert.equal(r1.judgeDecision.winner, r2.judgeDecision.winner);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. 架构边界：generation-matrix-runner.js import 隔离
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-4 架构边界：generation-matrix-runner.js import 隔离", () => {
  test("不 import reference-registry / reference-analyzer / dataset-builder / leakage-scanner / chapter-splitter", () => {
    assert.ok(
      existsSync(GENERATION_MATRIX_RUNNER_JS),
      "generation-matrix-runner.js 应存在（需先 build）",
    );
    const src = readFileSync(GENERATION_MATRIX_RUNNER_JS, "utf-8");
    const forbiddenImports = [
      'from "./reference-registry',
      'from "./reference-analyzer',
      'from "./dataset-builder',
      'from "./leakage-scanner',
      'from "./chapter-splitter',
      'from "./corpus-auditor',
      'from "./partition',
      'from "./generator-bundle',  // generator-bundle 是 case 读写工具，runner 不需要（CLI 处理 FS）
    ];
    for (const pat of forbiddenImports) {
      assert.ok(
        !src.includes(pat),
        `generation-matrix-runner.js 不得 import ${pat}（generator 进程隔离）`,
      );
    }
  });

  test("不含 ReferenceRegistry / .resolve( 调用", () => {
    assert.ok(existsSync(GENERATION_MATRIX_RUNNER_JS));
    const src = readFileSync(GENERATION_MATRIX_RUNNER_JS, "utf-8");
    assert.ok(
      !src.includes("ReferenceRegistry"),
      "generation-matrix-runner.js 不得引用 ReferenceRegistry",
    );
    assert.ok(
      !src.includes(".resolve("),
      "generation-matrix-runner.js 不得含 .resolve( 调用",
    );
  });

  test("不访问 sourcePath / referenceBody / startOffset 属性（generator schema 禁止字段）", () => {
    assert.ok(existsSync(GENERATION_MATRIX_RUNNER_JS));
    const src = readFileSync(GENERATION_MATRIX_RUNNER_JS, "utf-8");
    const forbiddenAccess = [
      /\.sourcePath\b/,
      /\.referenceBody\b/,
      /\.startOffset\b/,
      /\.endOffset\b/,
    ];
    for (const pat of forbiddenAccess) {
      assert.ok(
        !pat.test(src),
        `generation-matrix-runner.js 不得访问 ${pat}（generator schema 禁止字段）`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. 架构边界：eval-pipeline-adapter.js import 隔离
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-4 架构边界：eval-pipeline-adapter.js import 隔离", () => {
  test("eval-pipeline-adapter.js 存在（Fix-1 新增主链路 adapter）", () => {
    assert.ok(
      existsSync(EVAL_PIPELINE_ADAPTER_JS),
      "eval-pipeline-adapter.js 应存在（需先 build）",
    );
  });

  test("不 import reference-registry / reference-analyzer / dataset-builder / leakage-scanner / chapter-splitter", () => {
    assert.ok(existsSync(EVAL_PIPELINE_ADAPTER_JS));
    const src = readFileSync(EVAL_PIPELINE_ADAPTER_JS, "utf-8");
    const forbiddenImports = [
      'from "./reference-registry',
      'from "./reference-analyzer',
      'from "./dataset-builder',
      'from "./leakage-scanner',
      'from "./chapter-splitter',
      'from "./corpus-auditor',
      'from "./partition',
      'from "./generator-bundle',
    ];
    for (const pat of forbiddenImports) {
      assert.ok(
        !src.includes(pat),
        `eval-pipeline-adapter.js 不得 import ${pat}（generator 进程隔离）`,
      );
    }
  });

  test("import v2/core/unified-entry（runUnifiedPipeline 公开入口，R1）", () => {
    assert.ok(existsSync(EVAL_PIPELINE_ADAPTER_JS));
    const src = readFileSync(EVAL_PIPELINE_ADAPTER_JS, "utf-8");
    // R1：adapter 通过 runUnifiedPipeline 公开入口进入主链路，
    // 不再直接实例化 UnifiedOrchestrator（用户 P0 阻断项修复）
    assert.ok(
      src.includes("unified-entry"),
      "eval-pipeline-adapter.js 应 import v2/core/unified-entry（公开入口）",
    );
    assert.ok(
      src.includes("runUnifiedPipeline"),
      "eval-pipeline-adapter.js 应调用 runUnifiedPipeline（公开入口）",
    );
    // 不得直接实例化 UnifiedOrchestrator（P0 阻断项：必须通过公开入口）
    assert.ok(
      !src.includes("new UnifiedOrchestrator"),
      "eval-pipeline-adapter.js 不得直接实例化 UnifiedOrchestrator（R1：必须通过 runUnifiedPipeline）",
    );
  });

  test("不含 ReferenceRegistry / .resolve( 调用", () => {
    assert.ok(existsSync(EVAL_PIPELINE_ADAPTER_JS));
    const src = readFileSync(EVAL_PIPELINE_ADAPTER_JS, "utf-8");
    assert.ok(
      !src.includes("ReferenceRegistry"),
      "eval-pipeline-adapter.js 不得引用 ReferenceRegistry",
    );
    assert.ok(
      !src.includes(".resolve("),
      "eval-pipeline-adapter.js 不得含 .resolve( 调用",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. 默认 evalLayerRunner（不注入时走真实 runEvalLayer）
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-4 默认 evalLayerRunner（生产路径）", () => {
  test("不传 evalLayerRunner 时，runner.js 含 runEvalLayer import（生产路径走主链路）", () => {
    assert.ok(existsSync(GENERATION_MATRIX_RUNNER_JS));
    const src = readFileSync(GENERATION_MATRIX_RUNNER_JS, "utf-8");
    assert.ok(
      src.includes("eval-pipeline-adapter"),
      "generation-matrix-runner.js 应 import eval-pipeline-adapter（默认 evalLayerRunner）",
    );
    assert.ok(
      src.includes("runEvalLayer"),
      "generation-matrix-runner.js 应引用 runEvalLayer（默认 evalLayerRunner）",
    );
    // 确认 fallback 逻辑：input.evalLayerRunner ?? runEvalLayer
    assert.ok(
      src.includes("evalLayerRunner"),
      "generation-matrix-runner.js 应含 evalLayerRunner 注入逻辑",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. 真实 adapter 集成测试（R3：runEvalLayer → runUnifiedPipeline → orchestrate）
//    使用 stub model，禁止网络调用。证明 B0/B1 通过公开入口进入主链路。
//    B2/B3/B4 需要 workspace 基础设施（agentic source 创建 trajectory 文件），
//    由真实 matrix 重跑（R5）覆盖，此处不测。
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-4 真实 adapter 集成（runEvalLayer → runUnifiedPipeline → orchestrate）", () => {
  // stub model：返回非空占位正文，禁止网络调用
  const stubModelGenerate = async (input) => ({
    text: `[stub-${input.route}] 这是测试用的占位正文，模拟模型生成。章节内容。`,
    model: "stub-test-model",
    route: input.route,
    durationMs: 1,
  });

  test("B0：runEvalLayer 走 runUnifiedPipeline 公开入口，返回 V2Output 形状", async () => {
    const output = await runEvalLayer(
      "B0",
      makeStubGeneratorCase(),
      STUB_PREFIX,
      stubModelGenerate,
      "nb4_generate_glm",
      "nb4_judge_glm",
      0,
      5000,
    );

    // 1. 成功返回（stub model 返回非空文本，B0 交付 one_shot_raw）
    assert.equal(output.success, true, "B0 应成功（stub model 返回非空文本）");
    assert.ok(output.text.length > 0, "B0 文本应非空");

    // 2. result 是 V2Output 形状（不是 UnifiedOrchestratorOutput）
    //    V2Output: selectedSource/warnings 在 stageResults 中，顶层无 selectedSource
    const result = output.result;
    assert.equal(result.status, "ok");
    assert.equal(typeof result.stageResults, "object");
    assert.equal(result.stageResults.unifiedPipeline, true,
      "stageResults.unifiedPipeline=true 证明走了 runUnifiedPipeline 公开入口");
    assert.equal(result.stageResults.evalMode, true,
      "stageResults.evalMode=true 证明走了 eval 模式路径");

    // 3. 顶层无 UnifiedOrchestratorOutput 专属字段（V2Output 不含这些）
    assert.equal(result.selectedSource, undefined,
      "V2Output 顶层不应有 selectedSource（在 stageResults 中）");
    assert.equal(result.judgeResult, undefined,
      "V2Output 顶层不应有 judgeResult");
    assert.equal(result.allArbitrationResults, undefined,
      "V2Output 顶层不应有 allArbitrationResults");
    assert.equal(result.stateCommit, undefined,
      "V2Output 顶层不应有 stateCommit");

    // 4. stageResults 含 selectedSource / warnings（V2Output 映射）
    assert.equal(result.stageResults.selectedSource, "raw",
      "B0 selectedSource=raw（one_shot_raw 直接交付）");
    assert.ok(Array.isArray(result.stageResults.warnings),
      "stageResults.warnings 应为数组");
    assert.ok(Array.isArray(result.stageResults.modelCalls),
      "stageResults.modelCalls 应为数组");
    assert.ok(result.stageResults.modelCalls.length >= 1,
      "B0 应至少有 1 次模型调用（raw 生成）");

    // 5. eval 模式不写章节文件、不提交状态
    assert.equal(result.stageResults.stateCommit, null,
      "eval 模式 stateCommit=null");
    assert.equal(result.stageResults.chapterFilePath, null,
      "eval 模式 chapterFilePath=null");
  });

  test("B1：runEvalLayer 传入 context，走 runUnifiedPipeline 返回 V2Output", async () => {
    const output = await runEvalLayer(
      "B1",
      makeStubGeneratorCase({ genre: "玄幻" }),
      STUB_PREFIX,
      stubModelGenerate,
      "nb4_generate_glm",
      "nb4_judge_glm",
      0,
      5000,
    );

    assert.equal(output.success, true, "B1 应成功");
    assert.ok(output.text.length > 0, "B1 文本应非空");

    const result = output.result;
    assert.equal(result.status, "ok");
    assert.equal(result.stageResults.unifiedPipeline, true,
      "B1 也应走 runUnifiedPipeline 公开入口");
    assert.equal(result.stageResults.evalMode, true);
    assert.equal(result.stageResults.selectedSource, "raw",
      "B1 selectedSource=raw（one_shot_raw + context，直接交付）");
  });

  test("runEvalLayer 调用参数：layer/genCase/prefix 正确传递", async () => {
    const genCase = makeStubGeneratorCase({ caseId: "integration-test-b0", targetChapter: 7 });
    const output = await runEvalLayer(
      "B0",
      genCase,
      "自定义前文内容。",
      stubModelGenerate,
      "nb4_generate_glm",
      "nb4_judge_glm",
      42,
      8000,
    );

    // 验证 caseId/targetChapter 正确传递到 V2Output
    assert.equal(output.result.workspaceId, `eval-${genCase.caseId}`,
      "workspaceId 应从 caseId 派生");
    assert.equal(output.result.chapterNumber, 7,
      "chapterNumber 应从 genCase.targetChapter 传递");
    // 验证 route 正确传递（wrapped modelGenerate 强制用 generateRoute）
    assert.equal(output.route, "nb4_generate_glm",
      "route 应为传入的 generateRoute");
  });
});
