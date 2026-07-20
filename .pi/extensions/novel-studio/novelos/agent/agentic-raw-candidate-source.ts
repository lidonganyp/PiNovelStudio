/**
 * NovelOS Agentic Raw Candidate Source（OPT-8.13/8.14，Step 5）
 *
 * 把 NovelOS session 包装成候选源：编排器在 raw 候选生成后调用本源，
 * 产出 agentic_raw Candidate（shadow 模式下只进 trace，不影响正式交付）。
 *
 * M1 设计（计划 §Step 5）：
 * - shadow 默认 OFF（env PINOVEL_NOVELOS_SHADOW=1 门控）
 * - agentic_raw 与 one_shot_raw 同跑，但 selectedSource 强制 "raw"
 * - agentic 失败 → 返回 null（编排器回退 one_shot_raw，不 hard block）
 * - 模型调用经传入的 modelGenerate（已被编排器 wrapModelFn 包装）计入章节 SOFT/HARD
 * - NovelOS 自主管理 sessionId，不依赖 PI Host session
 *
 * 依赖方向（无循环）：
 * - 本模块 → novelos/* (runtime/session/trajectory/tools/agent/verification)
 * - 本模块 → v2/core/types.ts (Candidate/ChapterIntent/CompiledContext 类型)
 * - 本模块 → v2/adapters/legacy-model-route-adapter.ts (ModelGenerateFn 类型)
 * - 编排器 import type { AgenticRawCandidateSource }（type-only，无运行时依赖）
 */

import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Candidate, CompiledContext } from "../../v2/core/types.js";
import type { ChapterIntent } from "../../v2/core/chapter-intent-builder.js";
import type { ModelGenerateFn } from "../../v2/adapters/legacy-model-route-adapter.js";
import { createNovelSession } from "../session/novel-session.js";
import { BudgetPolicy, createBudgetConfigFromEnv } from "../runtime/budget-policy.js";
import type { BudgetSnapshot } from "../runtime/budget-policy.js";
import { TrajectoryStore } from "../trajectory/trajectory-store.js";
import { createNovelOSRuntime } from "../runtime/runtime.js";
import type { NovelOSRuntime } from "../runtime/runtime.js";
import { PermissionPolicy } from "../security/permission-policy.js";
import { createNarrativeSearchService } from "./narrative-search-service.js";
import { createNarrativeToolRegistry } from "./narrative-tool-registry.js";
import { createCandidateWorkspace } from "./candidate-workspace.js";
import { createNarrativeAgentLoop } from "./narrative-agent-loop.js";
import type { AgentLoopResult, AgentLoopStopReason } from "./narrative-agent-loop.js";
import { createNarrativeVerifierSuite } from "../verification/narrative-verifier-suite.js";
import { createCandidatePatchService } from "./candidate-patch-service.js";

// ============================================================================
// 公共接口（编排器通过此接口调用，不直接依赖 NovelOS 内部）
// ============================================================================

/**
 * Agentic Raw 候选源输入。
 * 编排器在 raw 候选生成后传入这些参数。
 */
export interface AgenticRawSourceInput {
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  projectRoot: string;
  intent: ChapterIntent;
  context: CompiledContext;
  characterNames: string[];
  /**
   * 模型调用函数。
   * 编排器传入已包装的 modelGenerate（经 wrapModelFn），使 NovelOS 调用计入章节预算。
   */
  modelGenerate: ModelGenerateFn;
  /** 模型路由名（与 raw 候选共用路由，确保公平比较） */
  route: string;
  /** 单次调用超时 ms */
  timeoutMs?: number;
  /**
   * R6 修复：前文（eval 模式续写用）。
   * eval 模式下由编排器传入 evalPrefix，转发给 agent loop 的 userPrompt【前文】段，
   * 确保 agentic 生成续写同一故事而非从 scratch 生成不同故事。
   * 生产模式（非 eval）不传，行为不变。
   */
  evalPrefix?: string;
}

/**
 * Agentic Raw 候选源结果。
 * candidate=null 表示 agentic 失败，编排器回退 one_shot_raw。
 */
export interface AgenticRawSourceResult {
  /** agentic_raw 候选（null = 失败，回退 one_shot_raw） */
  candidate: Candidate | null;
  /** NovelOS session ID（供 trace 关联） */
  sessionId: string;
  /** trajectory 文件路径（供 trace 回放） */
  trajectoryPath: string;
  /** 预算快照 */
  budgetSnapshot: BudgetSnapshot;
  /** agent loop 停止原因 */
  stopReason: AgentLoopStopReason | "not_run";
  /** fallback 原因（candidate=null 时填充） */
  failureReason?: string;
  /** 收集的证据 sourceRefs */
  sourceRefs: string[];
  /** 工具调用次数 */
  toolCalls: number;
  /** verifier 是否清零（无硬失败或 patch 后清零） */
  verifierCleared?: boolean;
  /** 修复轮次（verify/patch 闭环执行了几轮） */
  repairRounds?: number;
}

/**
 * Agentic Raw 候选源接口。
 * 编排器通过此接口调用 NovelOS agentic 生成，不直接依赖 NovelOS 内部模块。
 */
export interface AgenticRawCandidateSource {
  generate(input: AgenticRawSourceInput): Promise<AgenticRawSourceResult>;
}

/**
 * 候选源能力开关（用于 B1/B2/B3 分层消融）。
 *
 * - enableRetrieval：是否启用检索工具。false 时 runtime.tools=[]，agent 无法调工具（B1）。
 * - enableVerification：是否启用 verify/patch 闭环。false 时不传 verifier/patchService 给 loop（B2）。
 *
 * 默认两者 true（生产路径行为不变）。
 */
export interface AgenticRawSourceCapabilities {
  /** 是否启用检索工具（B1=false, B2/B3=true） */
  enableRetrieval?: boolean;
  /** 是否启用验证 + patch 闭环（B1/B2=false, B3=true） */
  enableVerification?: boolean;
}

// ============================================================================
// 内部常量
// ============================================================================

/** agentic_raw 候选路由名 */
const AGENTIC_RAW_ROUTE = "novelos_agentic";

/**
 * agentic_raw 候选 kind。
 *
 * 导出为共享常量：编排器（unified-orchestrator）SOFT 预算过滤器需用此 kind
 * 排除 agentic 调用，使其只计入 HARD 总预算、不占用 non-agentic SOFT 预算。
 * 与 AGENTIC_RAW_ROUTE（路由名 "novelos_agentic"）区分，二者不可混用。
 */
export const AGENTIC_RAW_KIND = "agentic_raw";

/** NovelOS system prompt */
const NOVELOS_SYSTEM_PROMPT =
  "你是顶尖网文作家。你将通过 NovelOS agent loop 收集证据并生成章节正文。" +
  "先根据 EvidencePlan 检索历史章节和叙事状态，再基于证据生成正文。" +
  "只输出正文，不要写大纲、注释或分析。";

// ============================================================================
// 工厂
// ============================================================================

/**
 * 创建 Agentic Raw 候选源。
 *
 * 返回的对象实现 AgenticRawCandidateSource 接口，供编排器调用。
 * 每次调用 generate() 创建独立的 NovelOS session + trajectory。
 *
 * @param capabilities 能力开关（用于 B1/B2/B3 分层消融）；默认两者 true（生产路径行为不变）
 */
export function createAgenticRawCandidateSource(
  capabilities?: AgenticRawSourceCapabilities,
): AgenticRawCandidateSource {
  const enableRetrieval = capabilities?.enableRetrieval ?? true;
  const enableVerification = capabilities?.enableVerification ?? true;

  return {
    async generate(input: AgenticRawSourceInput): Promise<AgenticRawSourceResult> {
      const {
        workspaceId,
        chapterId,
        chapterNumber,
        projectRoot,
        intent,
        context,
        characterNames,
        modelGenerate,
        route,
        timeoutMs,
        evalPrefix,
      } = input;

      // ── 1. 创建 NovelOS session ──────────────────────────────────────
      const sessionId = `novelos-${chapterId}-${randomUUID().slice(0, 8)}`;
      const sourceChapter = `ch${chapterNumber}`;
      const session = createNovelSession({
        sessionId,
        workspaceId,
        chapterId,
        requestSummary: `agentic_raw 生成：${intent.chapterFunction}`,
        route,
      });

      // ── 2. 构造 NovelOS 组件 ─────────────────────────────────────────
      const workspaceRoot = join(projectRoot, "workspaces", workspaceId);

      const searchService = createNarrativeSearchService({
        projectRoot,
        workspaceId,
        sourceChapter,
      });

      const permissionPolicy = new PermissionPolicy({
        workspaceRoot,
        sessionId,
      });

      const registry = createNarrativeToolRegistry({
        searchService,
        permissionPolicy,
      });

      const candidateWorkspace = createCandidateWorkspace({
        workspaceRoot,
        sessionId,
      });

      const budget = new BudgetPolicy(createBudgetConfigFromEnv());

      const trajectory = new TrajectoryStore({
        projectRoot,
        workspaceId,
        sessionId,
        persist: true,
      });

      trajectory.recordSessionStart(session);

      // ── 3. 构造 NovelOS Runtime + Agent ──────────────────────────────
      // 工具列表从 registry 按 agent 角色获取（只读工具 + project_propose）
      // enableRetrieval=false 时传空数组（B1 无检索工具，agent 无法调工具）
      const tools = enableRetrieval ? registry.getToolsForRole("agent") : [];

      let runtime: NovelOSRuntime;
      try {
        runtime = createNovelOSRuntime({
          session,
          systemPrompt: NOVELOS_SYSTEM_PROMPT,
          modelGenerate,
          route,
          tools,
          budget,
          trajectory,
          kind: AGENTIC_RAW_KIND,
          timeoutMs,
        });
      } catch (err) {
        // Runtime 创建失败 → fallback
        const reason = err instanceof Error ? err.message : String(err);
        trajectory.recordFailure({
          stage: "novelos_runtime_init",
          severity: "soft",
          reason: `Runtime 创建失败：${reason}`,
          recoverable: true,
          retryPlan: "fallback to one_shot_raw",
        });
        await trajectory.flush();
        return makeFallbackResult(sessionId, trajectory.getOutputPath(), budget, "not_run", `Runtime 创建失败：${reason}`);
      }

      // ── 4. 构建 AgentLoopInput ───────────────────────────────────────
      const chapterIntentStr = buildChapterIntentString(intent);
      const seedContextStr = buildSeedContextString(context, characterNames);

      // ── 5. 运行 NarrativeAgentLoop ───────────────────────────────────
      // enableVerification=false 时不传 verifier/patchService（B2 无验证闭环）
      // loop 已支持 undefined verifier/patchService（见 narrative-agent-loop.ts if (this.verifier && this.patchService)）
      const verifier = enableVerification ? createNarrativeVerifierSuite() : undefined;
      const patchService = enableVerification ? createCandidatePatchService() : undefined;

      const loop = createNarrativeAgentLoop({
        runtime,
        registry,
        searchService,
        candidateWorkspace,
        permissionPolicy,
        budget,
        trajectory,
        ...(verifier ? { verifier } : {}),
        ...(patchService ? { patchService } : {}),
      });

      let loopResult: AgentLoopResult;
      try {
        loopResult = await loop.run({
          chapterIntent: chapterIntentStr,
          seedContext: seedContextStr,
          context,
          knownCharacterNames: characterNames,
          inviolableFacts: intent.inviolableFacts,
          evalPrefix,
        });
      } catch (err) {
        // loop 异常 → fallback
        const reason = err instanceof Error ? err.message : String(err);
        trajectory.recordFailure({
          stage: "novelos_agent_loop",
          severity: "soft",
          reason: `agent loop 异常：${reason}`,
          recoverable: true,
          retryPlan: "fallback to one_shot_raw",
        });
        await trajectory.flush();
        return makeFallbackResult(
          sessionId, trajectory.getOutputPath(), budget, "model_error",
          `agent loop 异常：${reason}`,
        );
      }

      // ── 6. flush trajectory ─────────────────────────────────────────
      trajectory.recordSessionEnd({
        ...session,
        status: loopResult.fallback ? "failed" : "completed",
      });
      await trajectory.flush();

      // ── 7. 构造结果 ──────────────────────────────────────────────────
      if (loopResult.fallback || !loopResult.text || loopResult.text.trim().length === 0) {
        // fallback → 返回 null candidate
        return makeFallbackResult(
          sessionId, trajectory.getOutputPath(), budget,
          loopResult.lineage.stopReason,
          loopResult.fallback
            ? `agent loop fallback: ${loopResult.lineage.stopReason}`
            : "agent loop 返回空文本",
        );
      }

      // 成功 → 构造 agentic_raw Candidate
      const candidate: Candidate = {
        id: `candidate:agentic_raw:${chapterId}`,
        text: loopResult.text,
        kind: AGENTIC_RAW_KIND,
        model: "novelos_agentic",
        route: AGENTIC_RAW_ROUTE,
        contextHash: `hash-${chapterId}-agentic_raw`,
        generatedAt: new Date().toISOString(),
        durationMs: 0,
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

      return {
        candidate,
        sessionId,
        trajectoryPath: trajectory.getOutputPath(),
        budgetSnapshot: budget.getSnapshot(),
        stopReason: loopResult.lineage.stopReason,
        sourceRefs: loopResult.lineage.sourceRefs,
        toolCalls: loopResult.lineage.toolCalls,
        verifierCleared: loopResult.lineage.verifierCleared,
        repairRounds: loopResult.repairRounds,
      };
    },
  };
}

// ============================================================================
// 内部工具
// ============================================================================

/**
 * 构造 fallback 结果（candidate=null）。
 */
function makeFallbackResult(
  sessionId: string,
  trajectoryPath: string,
  budget: BudgetPolicy,
  stopReason: AgentLoopStopReason | "not_run",
  failureReason: string,
): AgenticRawSourceResult {
  return {
    candidate: null,
    sessionId,
    trajectoryPath,
    budgetSnapshot: budget.getSnapshot(),
    stopReason,
    failureReason,
    sourceRefs: [],
    toolCalls: 0,
    verifierCleared: false,
    repairRounds: 0,
  };
}

/**
 * 把 ChapterIntent 序列化为 agent loop 可读的字符串。
 */
function buildChapterIntentString(intent: ChapterIntent): string {
  const parts: string[] = [];
  if (intent.chapterFunction) {
    parts.push(`本章功能：${intent.chapterFunction}`);
  }
  if (intent.readerExperience.length > 0) {
    parts.push(`读者体验目标：${intent.readerExperience.join("、")}`);
  }
  if (intent.currentPressure.length > 0) {
    parts.push(`当前压力：${intent.currentPressure.join("；")}`);
  }
  if (intent.meaningfulChoices.length > 0) {
    parts.push(`有意义的选择：${intent.meaningfulChoices.join("；")}`);
  }
  if (intent.promisesToAdvance.length > 0) {
    parts.push(`需推进的伏笔：${intent.promisesToAdvance.join("；")}`);
  }
  if (intent.possibleEndPressure.length > 0) {
    parts.push(`章末压力：${intent.possibleEndPressure.join("；")}`);
  }
  if (intent.relevantCharacters.length > 0) {
    parts.push(`相关角色：${intent.relevantCharacters.join("、")}`);
  }
  if (intent.inviolableFacts.length > 0) {
    parts.push(`不可破坏的事实：${intent.inviolableFacts.join("；")}`);
  }
  return parts.join("\n") || "（无明确章节意图）";
}

/**
 * 把 CompiledContext 序列化为 agent loop 可读的种子上下文字符串。
 * 只取关键信息（facts/characterStates/openLoops/worldRules），避免上下文过长。
 */
function buildSeedContextString(context: CompiledContext, characterNames: string[]): string {
  const parts: string[] = [];

  // 事实（最多 10 条）
  if (context.facts.length > 0) {
    const facts = context.facts.slice(0, 10).map((f) => f.content);
    parts.push(`已确立事实：\n${facts.map((f) => `  - ${f}`).join("\n")}`);
  }

  // 角色状态（最多 5 个角色）
  if (context.characterStates.length > 0) {
    const chars = context.characterStates.slice(0, 5).map((c) => {
      const stateStr = Object.entries(c.state)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      return `  - ${c.name}: ${stateStr}`;
    });
    parts.push(`角色状态：\n${chars.join("\n")}`);
  }

  // 开放伏笔（最多 5 条）
  if (context.openLoops.length > 0) {
    const loops = context.openLoops.slice(0, 5).map((l) => `  - ${l.description}`);
    parts.push(`未结伏笔：\n${loops.join("\n")}`);
  }

  // 世界规则（最多 5 条）
  if (context.worldRules.length > 0) {
    const rules = context.worldRules.slice(0, 5).map((r) => `  - ${r.description}`);
    parts.push(`世界规则：\n${rules.join("\n")}`);
  }

  // 角色名列表
  if (characterNames.length > 0) {
    parts.push(`本章角色：${characterNames.join("、")}`);
  }

  return parts.join("\n\n") || "（无种子上下文）";
}
