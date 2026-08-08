/**
 * NB-4 Eval Pipeline Adapter — 把 GeneratorCase 转换为 eval 参数，
 * 通过 `runUnifiedPipeline`（`novel_generate_chapter` 公开入口）进入主链路，
 * 让 B0-B4 五层共享同一公开入口，禁止直接实例化 UnifiedOrchestrator。
 *
 * 设计原则（R1，冻结计划 §8.1）：
 * - B0-B4 全部通过 `runUnifiedPipeline` → `UnifiedOrchestrator.orchestrate` 走主链路
 * - 层级差异由 `evalMode` 控制（agentic 消融 + FactGuard 消融 + editorial/judge 消融）
 * - 信息量差异由调用方传入的 intent/context 字段丰富度决定
 * - route 通过 wrapped modelGenerate 强制注入（覆盖 orchestrate 内部的 v2_rawstage2/v2_amplified）
 * - agenticCandidateSource 由 runUnifiedPipeline 按 evalMode 自动构造（B2/B3/B4 启用 agentic）
 *
 * 层级映射（冻结计划 §8.1）：
 * - B0 PureModel: evalMode="B0"，空 intent + 空 context（裸模型 + 前文），raw 后直接交付
 * - B1 CompiledContext: evalMode="B1"，空 intent + 基础 context（genre worldRule），raw 后直接交付
 * - B2 AgenticRetrieval: evalMode="B2"，完整 intent + 完整 context + agentic(retrieval=true, verify=false)
 * - B3 VerifiedAgenticRaw: evalMode="B3"，B2 输入 + agentic(retrieval=true, verify=true) + FactGuard
 * - B4 EditorialSelection: evalMode="B4"，B3 输入 + editorial candidates + pairwise judge + select
 *
 * 架构边界（generator 进程隔离）：
 * - 本模块是 generator 进程，只读 GeneratorCase（无 sourcePath/offset/referenceBody）
 * - 只 import v2/core（主链路入口）+ types.js（纯类型）+ v2 ModelGenerateFn 类型
 * - 严禁 import reference-registry / reference-analyzer / dataset-builder / leakage-scanner / chapter-splitter
 *
 * 本模块为 eval-only，由 tsconfig.eval.json 编译到 dist-eval/，不进 dist/。
 */

import type { GeneratorCase } from "./types.js";
import type {
  ModelGenerateFn,
  ModelGenerateInput,
} from "../v2/adapters/legacy-model-route-adapter.js";
import { runUnifiedPipeline } from "../v2/core/unified-entry.js";
import type { V2Output } from "../v2/core/types.js";
import type { ChapterIntent } from "../v2/core/chapter-intent-builder.js";
import type {
  CompiledContext,
  WorldRuleFact,
} from "../v2/core/types.js";
import { resolveWriterPromptProfile } from "../v2/core/model-prompt-adapter.js";
import type { WriterPromptProfile } from "../v2/core/model-prompt-adapter.js";

// ─────────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────────

/** Layer 名（与 generation-matrix-runner.LayerName 一致） */
export type EvalLayerName = "B0" | "B1" | "B2" | "B3" | "B4";

/** 单层 eval 输出（generation-matrix-runner 负责转换为 LayerResult） */
export interface EvalLayerOutput {
  /** runUnifiedPipeline 返回的 V2Output（含 stageResults 供 trace 审计） */
  result: V2Output;
  /** 实际使用的主 route（forced generate route） */
  route: string;
  /** 耗时 ms */
  durationMs: number;
  /** 是否成功（status=ok 且 text 非空） */
  success: boolean;
  /** 失败原因（success=false 时填） */
  fallbackReason?: string;
  /** 主模型名（从 stageResults.modelCalls 提取，第一个非 failed 调用） */
  model: string;
  /** 该层输出文本（= result.text） */
  text: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把指定 route 强制注入 modelGenerate（覆盖 orchestrate 内部的 RAW_ROUTE/EDITORIAL_ROUTE）。
 * eval 模式下，orchestrate 内部用 v2_rawstage2/v2_amplified route，但实际调用时
 * 被 wrapped fn 强制覆盖为 eval route（如 nb4_generate_glm / nb4_judge_glm）。
 */
function wrapModelGenerateWithRoute(
  modelGenerate: ModelGenerateFn,
  forcedRoute: string,
): ModelGenerateFn {
  return async (input: ModelGenerateInput) => {
    return modelGenerate({ ...input, route: forcedRoute });
  };
}

/** 构造空 ChapterIntent（B0/B1 用：无章节意图信息） */
function buildEmptyIntent(): ChapterIntent {
  return {
    chapterFunction: "",
    readerExperience: [],
    currentPressure: [],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: [],
    inviolableFacts: [],
    sourceRefs: [],
  };
}

/**
 * 构造完整 ChapterIntent（B2/B3/B4 用：意图增强）。
 * 字段对应 buildRawPrompt 的章节目标/读者体验/压力段落。
 */
function buildFullIntent(): ChapterIntent {
  return {
    chapterFunction: "推进核心情节，让事件有实质进展",
    readerExperience: ["悬念", "张力", "章末钩子"],
    currentPressure: ["主角面临关键挑战", "事件即将升级"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: [],
    inviolableFacts: [],
    sourceRefs: [],
  };
}

/** 构造空 CompiledContext（B0 用：无上下文信息） */
function buildEmptyContext(): CompiledContext {
  return {
    facts: [],
    characterStates: [],
    openLoops: [],
    worldRules: [],
    styleReferences: [],
    sourceMap: [],
    constitution: null,
    longTermState: null,
  };
}

/** 构造基础 CompiledContext（B1 用：仅 worldRules 含 genre，测量上下文增强边际贡献） */
function buildBaseContext(genCase: GeneratorCase): CompiledContext {
  const worldRules: WorldRuleFact[] = [
    {
      id: "eval-genre",
      description: `类型：${genCase.genre}`,
      type: "genre",
      affectedCharacters: [],
      sourceIds: ["eval"],
    },
  ];
  return {
    facts: [],
    characterStates: [],
    openLoops: [],
    worldRules,
    styleReferences: [],
    sourceMap: [],
    constitution: null,
    longTermState: null,
  };
}

/** 构造完整 CompiledContext（B2/B3/B4 用：含 genre worldRule） */
function buildFullContext(genCase: GeneratorCase): CompiledContext {
  const worldRules: WorldRuleFact[] = [
    {
      id: "eval-genre",
      description: `类型：${genCase.genre}`,
      type: "genre",
      affectedCharacters: [],
      sourceIds: ["eval"],
    },
  ];
  return {
    facts: [],
    characterStates: [],
    openLoops: [],
    worldRules,
    styleReferences: [],
    sourceMap: [],
    constitution: null,
    longTermState: null,
  };
}

/** 从 V2Output.stageResults.modelCalls 提取主模型名（第一个非 failed 调用） */
function extractModelName(result: V2Output): string {
  const modelCalls = (result.stageResults?.modelCalls as Array<{ model: string; failed?: boolean }>) ?? [];
  for (const call of modelCalls) {
    if (!call.failed && call.model !== "unknown") {
      return call.model;
    }
  }
  return "unknown";
}

/** 构造 blocked V2Output（异常时用） */
function buildBlockedV2Output(
  workspaceId: string,
  chapterId: string,
  chapterNumber: number,
  reason: string,
): V2Output {
  return {
    status: "blocked",
    workspaceId,
    chapterId,
    chapterNumber,
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
      unifiedPipeline: true,
      evalMode: true,
      selectedSource: "raw",
      selectedCandidateId: "",
      warnings: [reason],
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 主函数：runEvalLayer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 执行单层 eval（通过 runUnifiedPipeline 公开入口进入主链路）。
 *
 * 冻结计划 §8.1 层级差异（由 orchestrate 内部 evalMode 控制）：
 * - B0/B1: one_shot_raw 后直接交付（无 agentic / FactGuard / editorial / judge）
 * - B2: agentic(retrieval=true, verify=false)，交付 agentic_raw（无 FactGuard / editorial / judge）
 * - B3: agentic(retrieval=true, verify=true) + FactGuard，交付 verified agentic_raw（无 editorial / judge）
 * - B4: B3 + editorial candidates + pairwise judge + select（FactGuard 启用）
 *
 * route 注入：
 * - generateRoute 用于 raw + editorial + opp judge + agentic（通过 modelGenerate 注入）
 * - judgeRoute 仅 B4 用，通过 arbitratorModelGenerate 注入（JudgeArbitrator 仲裁用）
 *
 * 公开入口：本函数调用 runUnifiedPipeline（= novel_generate_chapter 内部入口），
 * 而非直接实例化 UnifiedOrchestrator。runUnifiedPipeline 在 eval 模式下自动构造
 * agenticCandidateSource（B2/B3/B4）并传给编排器。
 */
export async function runEvalLayer(
  layer: EvalLayerName,
  genCase: GeneratorCase,
  prefix: string,
  modelGenerate: ModelGenerateFn,
  generateRoute: string,
  judgeRoute: string,
  seed?: number,
  timeoutMs?: number,
  /** DEMO-3-R2.4：已知角色名，传入 StoryPreservationGate 的 knownEntities */
  characterNames?: string[],
  /** MODEL-PROMPT-ADAPTER-1：显式覆盖为 generic 或模型专用 profile，供消融实验。 */
  promptProfile?: WriterPromptProfile,
  /**
   * eval-only：覆盖 Agentic loop 的"强制跨源检索"prompt 决策规则。
   * undefined = A 组（默认强制检索 prompt）；传入决策规则文本 = B 组（不确定性驱动）。
   */
  retrievalPromptOverride?: string,
): Promise<EvalLayerOutput> {
  const start = Date.now();
  const workspaceId = `eval-${genCase.caseId}`;
  const chapterId = `${genCase.caseId}-${layer}`;

  // 构造 intent/context（按 layer 层级填字段）
  let intent: ChapterIntent;
  let context: CompiledContext;
  if (layer === "B0") {
    intent = buildEmptyIntent();
    context = buildEmptyContext();
  } else if (layer === "B1") {
    intent = buildEmptyIntent();
    context = buildBaseContext(genCase);
  } else {
    // B2/B3/B4 用完整 intent + context
    intent = buildFullIntent();
    context = buildFullContext(genCase);
  }

  // wrapped modelGenerate：强制用 generateRoute（覆盖 orchestrate 内部的 RAW_ROUTE/EDITORIAL_ROUTE）
  const wrappedModelGenerate = wrapModelGenerateWithRoute(modelGenerate, generateRoute);
  // B4 的 judge 仲裁用 judgeRoute（通过 arbitratorModelGenerate 注入）
  const wrappedArbitratorModelGenerate = layer === "B4"
    ? wrapModelGenerateWithRoute(modelGenerate, judgeRoute)
    : undefined;

  try {
    // 通过公开入口 runUnifiedPipeline 进入主链路（不直接实例化 UnifiedOrchestrator）
    // runUnifiedPipeline 在 eval 模式下自动构造 agenticCandidateSource（B2/B3/B4）
    // 并传给内部 UnifiedOrchestrator.orchestrate
    const result = await runUnifiedPipeline({
      workspaceId,
      chapterId,
      chapterNumber: genCase.targetChapter,
      projectRoot: process.cwd(),
      candidateTimeoutMs: timeoutMs,
      // Eval 参数（UnifiedPipelineEvalInput）
      evalMode: layer,
      evalPrefix: prefix,
      evalIntent: intent,
      evalContext: context,
      evalModelGenerate: wrappedModelGenerate,
      evalArbitratorModelGenerate: wrappedArbitratorModelGenerate,
      evalPromptProfile: promptProfile ?? resolveWriterPromptProfile({ route: generateRoute }),
      // DEMO-3-R2.4：传入已知角色名，使 StoryPreservationGate 的 knownEntities 非空
      evalCharacterNames: characterNames,
      // eval-only：A/B 对照实验用，覆盖 Agentic 检索决策规则（undefined = A 组默认强制检索）
      retrievalPromptOverride,
      // seed 通过环境变量传递（orchestrate 不直接接受 seed 参数在 V2Input 中）
      // 注意：seed 用于 judge 匿名化映射，由 orchestrate 内部处理
    });

    const text = result.text ?? "";
    const success = result.status === "ok" && text.length > 0;
    // 从 stageResults 提取 fallbackReason（warnings 或 failureEnvelope）
    const warnings = (result.stageResults?.warnings as string[]) ?? [];
    const failureEnvelope = result.failureEnvelope as { reason?: string } | undefined;
    const fallbackReason = success
      ? undefined
      : (failureEnvelope?.reason ?? warnings[0] ?? "runUnifiedPipeline 返回空文本");

    return {
      result,
      route: generateRoute,
      durationMs: Date.now() - start,
      success,
      fallbackReason,
      model: extractModelName(result),
      text,
    };
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      result: buildBlockedV2Output(workspaceId, chapterId, genCase.targetChapter, reason),
      route: generateRoute,
      durationMs: Date.now() - start,
      success: false,
      fallbackReason: reason,
      model: "failed",
      text: "",
    };
  }
}
