/**
 * NovelOS Agentic Raw Candidate Source（OPT-8.13/8.14，Step 5）
 *
 * 把 NovelOS session 包装成正式生产候选源，产出 agentic_raw Candidate。
 *
 * M1 设计（计划 §Step 5）：
 * - 正式生产由统一入口强制启用，不依赖 shadow 环境变量
 * - Agentic 初稿必须经过作者风格整章优化后才能交付
 * - agentic 失败 → 返回 null，由生产编排器结构化阻断
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
import { buildChapterContract, renderContract, renderLayeredContract } from "../../v2/core/model-prompt-adapter.js";
import type { WriterPromptProfile } from "../../v2/core/model-prompt-adapter.js";
import type { UnifiedOrchestratorInput } from "../../v2/core/orchestrator-types.js";
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
import { createEvidencePlan } from "./evidence-plan.js";
import { createMustVerifyCoverageGate } from "./must-verify-coverage-gate.js";
import type { CoverageGateResult } from "./must-verify-coverage-gate.js";
import {
  buildFewshotPromptBlock,
  type AgenticFewshotSelection,
} from "./agentic-fewshot-prompt.js";
import { NARRATIVE_TOOL_NAMES, NARRATIVE_TOOL_NAMES_WITH_FACADE, RETRIEVAL_TOOL_NAMES } from "../tools/narrative-tools.js";
import type { NarrativeToolMode } from "./evidence-plan.js";
import {
  createToolVisibilitySnapshot,
  attachToolMetricsTracer,
  recordToolVisibility,
} from "../trajectory/tool-metrics-tracer.js";

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
  /**
   * Phase 2B：本章字数软目标（非硬性约束）。
   * 从 config.json targetWordCount.perChapter.min/max 读取，注入为 prompt 软目标。
   * 模型可自由调整，不作为硬门禁。undefined 时使用默认预算。
   */
  targetWordCount?: { min: number; max: number };
  /**
   * P0-1 修复：完整链路只读预览模式。
   * true 时 CandidateWorkspace 走 dryRun（不创建目录、不写盘），
   * TrajectoryStore 走 persist=false（仅 in-memory）。
   * 预览模式下 agent loop 仍正常运行，只是不落盘。
   */
  fullPipelinePreview?: boolean;
  /**
   * P1 修复：Few-shot 黄金示例（来自 FewshotSelector，经 manifest 准入）。
   *
   * 编排器从 input.fewshotSelection 透传。Agentic prompt 消费 examples 作为
   * 写作参考（非机械配额），帮助模型对齐场景类型/叙事节拍/情绪弧。
   * manifestApproved=false 或 examples 为空时不注入。
   * undefined 时使用默认行为（不注入 few-shot）。
   */
  fewshotSelection?: AgenticFewshotSelection;
  /**
   * CONTRACT-LAYERING-ABLATION-1：写作提示词表达层。
   *
   * 当 profile="gemini_writer_v2_layered" 时，buildContractContextString 使用
   * renderLayeredContract（分层渲染），否则用 renderContract（平铺渲染）。
   * 生产路径不传此字段（undefined），行为不变（用平铺渲染）。
   * 仅 evalMode 隔离评测使用。
   */
  writerPromptProfile?: WriterPromptProfile;
  /**
   * eval-only：覆盖 Agentic loop 的检索决策规则 prompt。
   *
   * Phase 2D（2026-08-06）三缺口修复后：
   * 生产路径不传此字段，loop 默认使用不确定性驱动的检索决策规则
   * （上下文足够则直接生成，缺关键信息才检索）。
   *
   * eval A/B 对照实验中：
   * - A 组（baseline）传入 FORCED_RETRIEVAL_PROMPT，保持旧强制检索行为作为基线。
   * - B 组（treatment）传入 UNCERTAINTY_DRIVEN_RETRIEVAL_PROMPT，与生产默认一致。
   *
   * 不暴露思维链，只改变检索决策规则。
   */
  retrievalPromptOverride?: string;
  /**
   * eval-only：覆盖 NovelOS Agentic 生成所用的系统提示词（Stage P Prompt-A/B 注入）。
   *
   * Phase 8 Stage P（Prompt-only）评测用：P-A 传当前通用 NOVELOS_SYSTEM_PROMPT，
   * P-B 传 Gemini 专属系统提示词（gemini-prompt-library.ts 的 GEMINI_SYSTEM_PROMPT）。
   *
   * fail-closed：本字段仅在 createAgenticRawCandidateSource({ permitSystemPromptOverride: true })
   * 显式授权后可注入；生产调用 createAgenticRawCandidateSource() 未授权，任何调用方
   * （含误传的生产入口）传入本字段都会抛错，无法静默激活。生产不传则行为不变。
   */
  systemPromptOverride?: string;
  /**
   * Phase 5 受控接入：叙事工具暴露模式。
   *
   * - "facade"：canary workspace 显式 opt-in。registry 额外注册 query_narrative_production，
   *   evidencePlan.allowedTools 收窄为该统一入口，runtime 注入白名单用
   *   NARRATIVE_TOOL_NAMES_WITH_FACADE。模型只看到 1 个按 intent 路由的统一入口。
   * - "standard" / 缺省：默认生产行为（9 专用工具执行面不变）。
   *
   * 这是 "guided facade vs 9 工具" 的受控对照，非全量切换；失败即可回退到 9 专用工具。
   */
  toolMode?: NarrativeToolMode;
}

/**
 * Agentic Raw 候选源结果。
 * candidate=null 表示 agentic 失败，生产编排器将结构化阻断。
 */
export interface AgenticRawSourceResult {
  /** agentic_raw 候选（null = 失败；生产编排器结构化阻断） */
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
  /**
   * P1-3 修复（NOVELOS-CONSTRAINT-RELAXATION-1 验收修复）：
   * 结构化失败分类，供编排器区分可恢复（model_timeout）与硬失败。
   *
   * 原先真实 Agentic source 会捕获异常并返回 candidate:null，
   * 但只通过 failureReason 字符串传递信息，编排器 candidate=null 分支无法
   * 可靠识别超时，导致工具层 model_timeout 重试条件不可达。
   *
   * 现统一由 source 在所有失败路径上设置 failureKind：
   * - "model_timeout"：超时/连接重置/abort → 编排器触发 chapter_level_retry
   * - "model_error"：其他模型异常（解析失败、空响应等）
   * - "runtime_init"：NovelOS runtime 初始化失败
   * - "budget_exhausted"：预算耗尽未产出 draft
   * - "empty_draft"：loop 返回但 draft 为空
   * - "unknown"：未分类（保留兜底，不应出现在生产路径）
   *
   * candidate 非空时 failureKind 可省略。
   */
  failureKind?:
    | "model_timeout"
    | "model_error"
    | "runtime_init"
    | "budget_exhausted"
    | "empty_draft"
    | "must_verify_coverage_failed"
    | "unknown";
  /** 收集的证据 sourceRefs */
  sourceRefs: string[];
  /** 工具调用次数 */
  toolCalls: number;
  /**
   * AGENTIC-EVIDENCE-MERGE-1 可观测性：独立决策回合已合并进 Agentic 首轮。
   * 恒为 "agentic_inline"，标识证据与检索判断在 Agentic ReAct 循环内做出。
   */
  decisionMode: "agentic_inline";
  /** AGENTIC-EVIDENCE-MERGE-1 可观测性：Agentic 首回合实际动作 */
  firstAction: "draft" | "tool_call" | "not_run";
  /** AGENTIC-EVIDENCE-MERGE-1 可观测性：实际检索类工具调用数 */
  actualRetrievalCalls: number;
  /** AGENTIC-EVIDENCE-MERGE-1 可观测性：mustVerify 总数 */
  mustVerifyCount: number;
  /** AGENTIC-EVIDENCE-MERGE-1 可观测性：mustVerify 已覆盖数（来自 coverage gate） */
  mustVerifyCoveredCount: number;
  /** AGENTIC-EVIDENCE-MERGE-1 可观测性：mustVerify 覆盖门结果 */
  coverageResult?: CoverageGateResult;
  /** AGENTIC-EVIDENCE-MERGE-1 可观测性：按阶段聚合的模型调用数 */
  modelCallsByKind: { draft: number; patch: number; verify: number };
  /** verifier 是否清零（无硬失败或 patch 后清零） */
  verifierCleared?: boolean;
  /** 修复轮次（verify/patch 闭环执行了几轮） */
  repairRounds?: number;
  /** verifier 最终剩余的硬失败数量 */
  hardFindingCount?: number;
  /** verifier 最终剩余的硬失败摘要（不含正文） */
  unresolvedFindings?: Array<{
    id: string;
    failureType: string;
    sourceRef: string;
    description: string;
    conflictFact: string;
    /**
     * P0-4 修复（NOVELOS-CONSTRAINT-RELAXATION-1）：确定性等级。
     * 编排器据此区分 system_verifier_uncertain / author_input_conflict /
     * confirmed_content_omission，决定恢复责任归系统还是提示用户修订输入。
     */
    certainty?: "deterministic" | "corroborated" | "heuristic";
    /** P0-4：覆盖状态（uncertain=启发式无法判定，恢复责任归系统） */
    coverageStatus?: "covered" | "uncertain" | "missing";
  }>;
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
  /** 是否启用 mustVerify 覆盖门（离线消融可显式关闭） */
  enableCoverageGate?: boolean;
  /**
   * eval-only 授权开关：允许注入 input.systemPromptOverride。
   *
   * 默认 false（生产 createAgenticRawCandidateSource() 未传 → 未授权）。
   * 仅 Stage P Prompt-A/B 评测 runner 在显式构造候选源时传 true。
   * fail-closed：未授权时任何调用方传入 systemPromptOverride 都会抛错。
   */
  permitSystemPromptOverride?: boolean;
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

/**
 * NovelOS system prompt（Phase 2D 缺口二修复 2026-08-07）。
 *
 * 移除旧 system prompt 中"先检索、再生成正文"的强制语义。
 * 检索决策由 Agentic 在 ReAct 循环内自主判断（AGENTIC-EVIDENCE-MERGE-1），不再有独立 EvidenceDecision 回合。
 */
export const NOVELOS_SYSTEM_PROMPT =
  "你是顶尖网文作家。你将基于本章意图、种子上下文与叙事证据生成章节正文。" +
  "仅当现有上下文不足以保证事实、人物状态或因果关系正确时，才调用叙事证据工具查证。" +
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
  const enableCoverageGate = capabilities?.enableCoverageGate ?? true;
  const permitSystemPromptOverride = capabilities?.permitSystemPromptOverride ?? false;

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
        targetWordCount,
        fullPipelinePreview,
        fewshotSelection,
        writerPromptProfile,
        retrievalPromptOverride,
        systemPromptOverride,
        toolMode,
      } = input;

      // ── 0b. Phase 8 Stage P eval-only fail-closed 守卫 ─────────────────
      // systemPromptOverride 仅允许经 createAgenticRawCandidateSource({permitSystemPromptOverride:true})
      // 显式授权后注入。生产 createAgenticRawCandidateSource() 未授权（permit=false），
      // 任何调用方（含误传该系统提示词的生产入口）传入 override 都会抛错，无法静默激活。
      if (systemPromptOverride !== undefined && !permitSystemPromptOverride) {
        throw new Error(
          "systemPromptOverride 是 eval-only 覆盖字段；创建候选源时未传 permitSystemPromptOverride:true，" +
          "禁止注入（fail-closed）。生产路径不得设置系统提示词覆盖，请移除该系统提示词覆盖。",
        );
      }
      const effectiveSystemPrompt = systemPromptOverride ?? NOVELOS_SYSTEM_PROMPT;

      // ── 0. P1-5 修复：包装 modelGenerate 捕获真实模型名 ──────────────
      // 原先 candidate.model 固定为 "novelos_agentic"，导致 detectModelVersion
      // 无法区分 Gemini / Claude / 模型升级，策略信誉隔离失效。
      // 现在通过 wrapper 捕获最后一次成功调用的 ModelGenerateOutput.model，
      // 用于 candidate.model，保证版本键反映真实 provider/model。
      let lastActualModel: string | null = null;
      let lastActualProvider: string | null = null;
      const modelGenerateWithCapture: ModelGenerateFn = async (modelInput) => {
        const output = await modelGenerate(modelInput);
        // 捕获最后一次成功调用的真实模型名（覆盖 draft / patch / verify 所有调用）
        if (output?.model) {
          lastActualModel = output.model;
        }
        if (output?.provider) {
          lastActualProvider = output.provider;
        }
        return output;
      };

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

      const facadeEnabled = toolMode === "facade";

      const registry = createNarrativeToolRegistry({
        searchService,
        permissionPolicy,
        // Phase 5 受控接入：仅 canary workspace opt-in（toolMode="facade"）时
        // 额外注册 query_narrative_production facade runtime 变体；默认不注册。
        enableFacade: facadeEnabled,
      });

      const candidateWorkspace = createCandidateWorkspace({
        workspaceRoot,
        sessionId,
        dryRun: fullPipelinePreview === true,
      });

      const budget = new BudgetPolicy(createBudgetConfigFromEnv());

      const trajectory = new TrajectoryStore({
        projectRoot,
        workspaceId,
        sessionId,
        persist: !fullPipelinePreview,
      });

      trajectory.recordSessionStart(session);

      // ── 3. 构建 chapterIntentStr + seedContextStr（P0-2 修复） ──────────
      // P0-2 修复（NOVELOS-CONSTRAINT-RELAXATION-1 验收修复）：
      // 原先用自定义 buildChapterIntentString + buildGenerationPacketString 拼接，
      // 遗漏 characterMotivations / focusCharacterGoals / resistance / choicesAndCosts /
      // expectedIrreversibleChange / selectedExpectationsToAdvance / causalRelations 等
      // canonical contract 字段；且 buildGenerationPacketString 向 raw 注入风格指纹，
      // 违反"风格指纹不得作为 raw 正文执行指令"的规则。
      //
      // 修复：
      // - seedContextStr 改由 buildChapterContract + renderContract 生成，完整覆盖 canonical 字段
      // - 风格指纹不再注入 raw（renderContract 不渲染 styleReferences）
      // - openLoops / worldRules / bridgeContext 等运行时上下文追加到 contract 末尾
      //   （这些是运行时检索上下文，不在 ChapterContract canonical 字段中，但 Agentic 需要感知）
      // - targetWordCount 覆盖 contract.wordCountTarget
      // Phase 2C：在 runtime 创建前构建，以便 createEvidencePlan 消费 seedContext，
      // 再用 plan.allowedTools 过滤工具集。
      const chapterIntentStr = buildChapterIntentString(intent);
      const seedContextStr = buildContractContextString(intent, context, characterNames, targetWordCount, fewshotSelection, writerPromptProfile);

      // ── 4. EvidencePlan（Phase 2C + Phase 2D 三缺口修复） ───────────
      // 在 runtime 创建前创建 plan，用 plan.allowedTools 过滤工具集，
      // 同时把 plan 传给 loop 供 mustVerify 注入 + stopConditions 驱动停止。
      //
      // Phase 2D 三缺口修复（2026-08-06）：
      // 缺口一：传入结构化 intent，让 inferAllowedToolsFromIntent 收窄工具集
      //         （不再默认全量 9 工具，避免 prompt 过载与工具差异稀释）。
      // 缺口三：传入 compiledContext + bridgeContextAvailable，让 EvidencePlan
      //         - 从 intent 结构化字段提取 mustVerify（替代字符串启发式）
      //         - 从 context 提取 known 摘要行（≤80字/条，≤12条）
      //         - 根据 bridgeContextAvailable 判断是否需要 search_chapter_span
      // 不传 intent 时回退到 M1 启发式（向后兼容，但生产路径始终传 intent）。
      const evidencePlanBase = createEvidencePlan({
        chapterIntent: chapterIntentStr,
        seedContext: seedContextStr,
        intent,
        compiledContext: context,
        bridgeContextAvailable: context.bridgeContext?.available ?? false,
        // Phase 5 受控接入：facade 模式下将 allowedTools 收窄为 [query_narrative_production]，
        // 模型只看到 1 个按 intent 路由的统一入口；standard 不影响 intent 推断。
        toolMode,
      });

      // ── 4b. AGENTIC-EVIDENCE-MERGE-1：独立 EvidenceDecision 回合已删除 ──
      // 系统直接使用 EvidencePlan 的安全边界（allowedTools / mustVerify / retrievalCallLimit）。
      // Agentic 在 ReAct 循环内自主决定是否检索、检索什么、何时停止。
      // 不再发起独立证据决策模型调用。
      const evidencePlan = evidencePlanBase;

      // ── 5. 构造 NovelOS Runtime + Agent ──────────────────────────────
      // 工具列表从 registry 按 agent 角色获取（只读工具 + project_propose）
      // enableRetrieval=false 时传空数组（B1 无检索工具，agent 无法调工具）
      // Phase 2C：用 plan.allowedTools 过滤工具集（限定工具防无界遍历）
      const allTools = enableRetrieval ? registry.getToolsForRole("agent") : [];
      const allowedToolSet = new Set(evidencePlan.allowedTools);
      const tools = allTools.filter((tool) => allowedToolSet.has(tool.name));

      // ── 5b. 记录工具可见性快照 ──────────────────────────────────────
      // AGENTIC-EVIDENCE-MERGE-1：快照只记录「系统允许边界 / 最终可见」两者
      // （systemAllowedTools / visibleTools）。独立证据决策回合已删除，
      // 不再记录模型选择/被拒绝工具。在 runtime 创建前记录，确保真实可见集被留存。
      recordToolVisibility(
        trajectory,
        createToolVisibilitySnapshot({
          systemAllowedTools: evidencePlan.allowedTools,
          visibleTools: tools.map((tool) => tool.name),
        }),
      );

      let runtime: NovelOSRuntime;
      try {
        runtime = createNovelOSRuntime({
          session,
          systemPrompt: effectiveSystemPrompt,
          // P1-5：使用带捕获的 modelGenerate，记录真实模型名用于版本隔离
          modelGenerate: modelGenerateWithCapture,
          route,
          tools,
          // 缺口一防御纵深：注入边界白名单 = 全部叙事工具。
          // 即使未来绕过 evidencePlan.allowedTools 过滤，集合外工具也无法注入。
          // Phase 5 受控接入：facade 模式下白名单扩为 {9 专用工具, query_narrative_production}，
          // 使统一入口可被注入；默认生产仍为 NARRATIVE_TOOL_NAMES（9 工具），行为不变。
          allowedToolNames: facadeEnabled ? NARRATIVE_TOOL_NAMES_WITH_FACADE : NARRATIVE_TOOL_NAMES,
          // AGENTIC-EVIDENCE-MERGE-1：把系统检索调用上限传给 runtime。
          // runtime 统计检索工具调用并在达到预算时经 afterToolCall 停止 loop，
          // 使"retrievalCallLimit -> 工具调用次数/停止逻辑"成为系统强制约束（非仅 prompt 建议）。
          // Phase 5 受控接入：facade 模式下 query_narrative_production 也是检索工具，
          // 需计入检索预算（否则统一入口调用次数不受 budget 约束）；standard 用 9 工具集合。
          retrievalToolNames: facadeEnabled ? NARRATIVE_TOOL_NAMES_WITH_FACADE : RETRIEVAL_TOOL_NAMES,
          retrievalBudget: evidencePlan.retrievalCallLimit,
          budget,
          trajectory,
          kind: AGENTIC_RAW_KIND,
          timeoutMs,
        });
      } catch (err) {
        // Runtime 创建失败 → fallback
        // P1-3：runtime 初始化失败通常是配置/环境问题，归类为 runtime_init。
        // 但若错误信息包含超时模式（极罕见），仍归 model_timeout 以触发重试。
        const reason = err instanceof Error ? err.message : String(err);
        const failureKind = classifyFailureKind(reason, "not_run", "runtime_init");
        trajectory.recordFailure({
          stage: "novelos_runtime_init",
          severity: "soft",
          reason: `Runtime 创建失败：${reason}`,
          recoverable: true,
          retryPlan: "fallback to one_shot_raw",
        });
        await trajectory.flush();
        return makeFallbackResult(
          sessionId, trajectory.getOutputPath(), budget, "not_run",
          `Runtime 创建失败：${reason}`, failureKind,
        );
      }

      // ── 5c. Phase 0：挂载工具调用指标追踪器 ──────────────────────────
      // 订阅 runtime 事件流，按 toolCallId 匹配 start/end，计算每次调用的
      // latency / resultChars / evidenceLevel / sourceRefs / 空结果 / 超时 / 异常 / 重复 query，
      // 并写入 trajectory tool_call_metrics 条目。loop 结束后卸载，避免事件流泄漏。
      const unsubscribeMetrics = attachToolMetricsTracer({
        runtime,
        trajectory,
      });

      // ── 6. 运行 NarrativeAgentLoop ───────────────────────────────────
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
        ...(enableCoverageGate && fullPipelinePreview !== true
          ? { coverageGate: createMustVerifyCoverageGate() }
          : {}),
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
          // Phase 2C：传入预创建的 plan（allowedTools 已在 runtime 创建前过滤，
          // loop 不再内部 createEvidencePlan，直接消费此 plan 的 mustVerify + stopConditions）
          evidencePlan,
          // eval-only：A/B 对照实验用，覆盖默认强制检索 prompt（生产不传，行为不变）
          retrievalPromptOverride,
        });
      } catch (err) {
        // loop 异常 → fallback
        // P1-3：异常被 source 内部捕获，编排器只能看到 candidate=null。
        // 必须由 source 在此处分类 failureKind，否则编排器无法识别超时。
        // loop 抛出的异常 message 通常包含底层模型错误（timeout / connection reset 等），
        // 由 classifyFailureKind 解析后映射为 model_timeout 或 model_error。
        const reason = err instanceof Error ? err.message : String(err);
        const failureKind = classifyFailureKind(reason, "model_error", "model_error");
        trajectory.recordFailure({
          stage: "novelos_agent_loop",
          severity: "soft",
          reason: `agent loop 异常：${reason}`,
          recoverable: true,
          retryPlan: "fallback to one_shot_raw",
        });
        unsubscribeMetrics();
        await trajectory.flush();
        return makeFallbackResult(
          sessionId, trajectory.getOutputPath(), budget, "model_error",
          `agent loop 异常：${reason}`, failureKind,
        );
      }

      // Phase 0：loop 结束（无论成败）卸载工具指标追踪器，避免事件流泄漏
      unsubscribeMetrics();

      // ── 6. flush trajectory ─────────────────────────────────────────
      trajectory.recordSessionEnd({
        ...session,
        status: loopResult.fallback ? "failed" : "completed",
      });
      await trajectory.flush();

      // ── 7. 构造结果 ──────────────────────────────────────────────────
      if (loopResult.fallback || !loopResult.text || loopResult.text.trim().length === 0) {
        // fallback → 返回 null candidate
        // P1-3：loop 内部已捕获模型异常并返回 fallback=true + stopReason="model_error"。
        // failureReason 包含底层错误信息（由 loop 写入 trajectory）。
        // 这里需要根据 stopReason + failureReason 推断 failureKind：
        // - stopReason="model_error" 且 failureReason 含超时模式 → model_timeout
        // - stopReason="model_error" 其他 → model_error
        // - stopReason="budget_exhausted" → budget_exhausted
        // - stopReason="stagnant"/"verifier_cleared" 但文本空 → empty_draft
        // - 其他 → unknown
        //
        // AGENTIC-EVIDENCE-MERGE-1 修复：loop catch 块现在通过 lineage.failureReason
        // 传递底层错误消息。若存在，附加到 fallbackReason，让 classifyFailureKind
        // 能识别 "timed out" / "超时" 等超时模式 → failureKind=model_timeout。
        // 之前 fallbackReason 只是 "agent loop fallback: model_error"，
        // 不含超时关键词，导致所有模型异常都被归为 model_error。
        const loopFailureReason = loopResult.lineage.failureReason;
        const fallbackReason = loopResult.fallback
          ? (loopFailureReason
              ? `agent loop fallback: ${loopResult.lineage.stopReason}（${loopFailureReason}）`
              : `agent loop fallback: ${loopResult.lineage.stopReason}`)
          : "agent loop 返回空文本";
        const fallbackKind = classifyFailureKind(
          fallbackReason,
          loopResult.lineage.stopReason,
          loopResult.lineage.stopReason === "budget_exhausted"
            ? "budget_exhausted"
            : loopResult.lineage.stopReason === "must_verify_coverage_failed"
              ? "must_verify_coverage_failed"
              : "empty_draft",
        );
        return makeFallbackResult(
          sessionId, trajectory.getOutputPath(), budget,
          loopResult.lineage.stopReason,
          fallbackReason,
          fallbackKind,
          {
            firstAction: loopResult.lineage.firstAction,
            actualRetrievalCalls: loopResult.lineage.actualRetrievalCalls,
            mustVerifyCount: loopResult.lineage.evidencePlan.mustVerify.length,
            mustVerifyCoveredCount:
              loopResult.lineage.coverageGate?.confirmedItems.length ?? 0,
            coverageResult: loopResult.lineage.coverageGate,
            modelCallsByKind: loopResult.lineage.modelCallsByKind,
            sourceRefs: loopResult.lineage.sourceRefs,
            toolCalls: loopResult.lineage.toolCalls,
          },
        );
      }

      // 成功 → 构造 agentic_raw Candidate
      // P1-5 修复：candidate.model 使用真实模型名（从 modelGenerate 输出捕获），
      // 不再固定为 "novelos_agentic"。这样 detectModelVersion 能正确区分
      // Gemini / Claude / 模型升级，策略信誉按真实版本隔离。
      // 回退：若捕获失败（理论上不应发生，loop 成功至少有一次模型调用），
      // 使用 route 作为 model（比固定占位符更能反映路由差异）。
      const candidateModel = lastActualModel ?? route;
      const candidate: Candidate = {
        id: `candidate:agentic_raw:${chapterId}`,
        text: loopResult.text,
        kind: AGENTIC_RAW_KIND,
        model: candidateModel,
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
        // AGENTIC-EVIDENCE-MERGE-1 可观测性
        decisionMode: "agentic_inline",
        firstAction: loopResult.lineage.firstAction,
        actualRetrievalCalls: loopResult.lineage.actualRetrievalCalls,
        mustVerifyCount: loopResult.lineage.evidencePlan.mustVerify.length,
        mustVerifyCoveredCount:
          loopResult.lineage.coverageGate?.confirmedItems.length ?? 0,
        ...(loopResult.lineage.coverageGate
          ? { coverageResult: loopResult.lineage.coverageGate }
          : {}),
        modelCallsByKind: loopResult.lineage.modelCallsByKind,
        verifierCleared: loopResult.lineage.verifierCleared,
        repairRounds: loopResult.repairRounds,
        hardFindingCount: loopResult.lineage.hardFindingCount,
        unresolvedFindings: (loopResult.verifierReport?.hardFindings ?? []).map((finding) => ({
          id: finding.id,
          failureType: finding.failureType,
          sourceRef: finding.sourceRef,
          description: finding.description,
          conflictFact: finding.conflictFact,
          // P0-4：传播 certainty / coverageStatus，供编排器区分恢复责任
          certainty: finding.certainty,
          coverageStatus: finding.coverageStatus,
        })),
      };
    },
  };
}

// ============================================================================
// 内部工具
// ============================================================================

/**
 * P1-3 修复：用于匹配底层模型超时/连接异常的错误模式。
 *
 * 这些模式与 unified-orchestrator.ts 中 catch 分支的超时识别保持一致，
 * 确保无论异常在 source 内部被捕获（返回 candidate=null）还是冒泡到
 * 编排器 catch，都能统一识别为 model_timeout 并触发 chapter_level_retry。
 */
const TIMEOUT_PATTERNS = [
  "timeout",
  "timed out",
  "超时",
  "aborted",
  "etimedout",
  "econnreset",
];

/**
 * P1-3 修复：把 source 失败归因为结构化 failureKind。
 *
 * 判定优先级：
 * 1. 若 reason 字符串命中 TIMEOUT_PATTERNS → "model_timeout"
 *    （无论 stopReason 是什么；底层错误信息优先于 loop 的 stopReason 分类，
 *    因为 loop 在 catch 中统一标记 model_error，但 message 可能是 timeout）
 * 2. 否则返回 defaultKind（由调用方根据上下文提供）
 *
 * @param reason 错误消息（来自异常 message 或 failureReason）
 * @param _stopReason loop 停止原因（保留参数，便于未来扩展更细分类）
 * @param defaultKind 默认 failureKind（当未命中超时模式时使用）
 */
export function classifyFailureKind(
  reason: string,
  stopReason: AgentLoopStopReason | "not_run",
  defaultKind:
    | "model_timeout"
    | "model_error"
    | "runtime_init"
    | "budget_exhausted"
    | "empty_draft"
    | "must_verify_coverage_failed"
    | "unknown",
): "model_timeout" | "model_error" | "runtime_init" | "budget_exhausted" | "empty_draft" | "must_verify_coverage_failed" | "unknown" {
  const lower = reason.toLowerCase();
  for (const pattern of TIMEOUT_PATTERNS) {
    if (lower.includes(pattern)) {
      return "model_timeout";
    }
  }
  if (stopReason === "must_verify_coverage_failed") {
    return "must_verify_coverage_failed";
  }
  return defaultKind;
}

/**
 * 构造 fallback 结果（candidate=null）。
 *
 * P1-3：新增 failureKind 参数，由调用方通过 classifyFailureKind 推断。
 * 编排器据此在 candidate=null 分支区分可恢复（model_timeout）与硬失败。
 *
 * AGENTIC-EVIDENCE-MERGE-1：若 loop 已产生 lineage（coverage 负例 / 空 draft 等），
 * 必须保留 firstAction / actualRetrievalCalls / mustVerify* / coverageResult，
 * 禁止把已发生的检索与覆盖门结果清零为 not_run/0。
 * 仅 runtime_init / loop 异常等“未进入 turns”路径才使用 not_run 默认值。
 */
function makeFallbackResult(
  sessionId: string,
  trajectoryPath: string,
  budget: BudgetPolicy,
  stopReason: AgentLoopStopReason | "not_run",
  failureReason: string,
  failureKind:
    | "model_timeout"
    | "model_error"
    | "runtime_init"
    | "budget_exhausted"
    | "empty_draft"
    | "must_verify_coverage_failed"
    | "unknown",
  observed?: {
    firstAction?: "draft" | "tool_call" | "not_run";
    actualRetrievalCalls?: number;
    mustVerifyCount?: number;
    mustVerifyCoveredCount?: number;
    coverageResult?: CoverageGateResult;
    modelCallsByKind?: { draft: number; patch: number; verify: number };
    sourceRefs?: string[];
    toolCalls?: number;
  },
): AgenticRawSourceResult {
  return {
    candidate: null,
    sessionId,
    trajectoryPath,
    budgetSnapshot: budget.getSnapshot(),
    stopReason,
    failureReason,
    failureKind,
    sourceRefs: observed?.sourceRefs ?? [],
    toolCalls: observed?.toolCalls ?? 0,
    decisionMode: "agentic_inline",
    firstAction: observed?.firstAction ?? "not_run",
    actualRetrievalCalls: observed?.actualRetrievalCalls ?? 0,
    mustVerifyCount: observed?.mustVerifyCount ?? 0,
    mustVerifyCoveredCount: observed?.mustVerifyCoveredCount ?? 0,
    ...(observed?.coverageResult ? { coverageResult: observed.coverageResult } : {}),
    modelCallsByKind: observed?.modelCallsByKind ?? { draft: 0, patch: 0, verify: 0 },
    verifierCleared: false,
    repairRounds: 0,
    hardFindingCount: 0,
    unresolvedFindings: [],
  };
}

/**
 * 把 ChapterIntent 序列化为 agent loop 可读的字符串。
 *
 * P0-2 修复（NOVELOS-CONSTRAINT-RELAXATION-1 验收修复）：
 * - 使用 selectedPromisesToAdvance（≤3）替代全量 promisesToAdvance，避免上下文过载。
 *   全量开放伏笔继续留在状态存储和检索层，按需回源，不直接进入初始 prompt。
 * - **移除全量回退路径**：selectedPromisesToAdvance 为空时不再回退到 promisesToAdvance。
 *   调用方必须显式选中本章要推进的伏笔；未选中 = 本章不推进任何伏笔（不灌入全量）。
 * - 章末输入只使用 causalEndPressure（本章因果性章末压力）。
 * - **移除 possibleEndPressure 回退路径**：causalEndPressure 为空时不再回退到 possibleEndPressure。
 *   调用方必须显式提供本章因果性章末压力；未提供 = 本章不注入章末压力（不灌入全量主题问题）。
 *
 * 这两条回退路径是上下文过载的根因：60 条开放伏笔 + 6 条主题问题曾被直接灌入 prompt。
 * 移除后，未选中即不注入，由上游 ChapterIntentBuilder 负责正确的选择。
 */
export function buildChapterIntentString(intent: ChapterIntent): string {
  const parts: string[] = [];
  const authorEventSummaries = intent.authorEventSummaries ?? [];
  const authorMustInclude = intent.authorMustInclude ?? [];
  const authorStateChanges = intent.authorStateChanges ?? [];
  const endingTarget = intent.endingTarget ?? [];
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
  // P0-2：只注入 selectedPromisesToAdvance（≤3），不回退全量 promisesToAdvance
  // 未选中 = 本章不推进任何伏笔（全量伏笔留在状态层按需回源）
  const selectedPromises = intent.selectedPromisesToAdvance ?? [];
  if (selectedPromises.length > 0) {
    const promiseLines = selectedPromises
      .slice(0, 3)
      .map((p) => `${p.promiseId}：${p.description}`);
    parts.push(`本章推进的伏笔：${promiseLines.join("；")}`);
  }
  // P0-2：只注入 causalEndPressure（本章因果性章末压力），不回退全量 possibleEndPressure
  // 未提供 = 本章不注入章末压力（全量主题问题不进入初始 prompt）
  const causalEndPressure = intent.causalEndPressure ?? [];
  if (causalEndPressure.length > 0) {
    parts.push(`章末因果压力：${causalEndPressure.join("；")}`);
  }
  if (intent.relevantCharacters.length > 0) {
    parts.push(`相关角色：${intent.relevantCharacters.join("、")}`);
  }
  if (intent.inviolableFacts.length > 0) {
    parts.push(`不可破坏的事实：${intent.inviolableFacts.join("；")}`);
  }
  if (authorEventSummaries.length > 0) {
    parts.push(`作者章纲事件顺序：\n${authorEventSummaries.map((event, index) => `  ${index + 1}. ${event}`).join("\n")}`);
  }
  if (authorMustInclude.length > 0) {
    parts.push(`作者章纲必须包含：${authorMustInclude.join("；")}`);
  }
  if (authorStateChanges.length > 0) {
    parts.push(`作者章纲状态变化：${authorStateChanges.join("；")}`);
  }
  if (endingTarget.length > 0) {
    parts.push(`作者章纲章末目标：${endingTarget.join("；")}`);
  }
  return parts.join("\n") || "（无明确章节意图）";
}

/**
 * P0-2 修复：构建完整的 ChapterContract 字符串 + 运行时上下文。
 *
 * 替代原 buildGenerationPacketString。核心改动：
 * 1. 使用 buildChapterContract + renderContract 生成 canonical contract 字符串，
 *    完整覆盖 characterMotivations / focusCharacterGoals / resistance /
 *    choicesAndCosts / expectedIrreversibleChange / selectedExpectationsToAdvance /
 *    causalRelations 等原先遗漏的 canonical 字段。
 * 2. 不再注入风格指纹（风格编辑指导 / 角色声音指导），
 *    风格指导留到必经 editorial 阶段。
 * 3. openLoops / worldRules / bridgeContext 等运行时上下文追加到 contract 末尾
 *    （这些不在 ChapterContract canonical 字段中，但 Agentic 需要感知）。
 *
 * 设计原则：
 * - canonical 字段由统一 contract renderer 生成，不自行拼接
 * - 风格指纹不得作为 raw 正文执行指令
 * - 运行时检索上下文（openLoops/worldRules/bridgeContext）保留，供 Agentic 按需检索
 */
function buildContractContextString(
  intent: ChapterIntent,
  context: CompiledContext,
  characterNames: string[],
  targetWordCount?: { min: number; max: number },
  fewshotSelection?: AgenticFewshotSelection,
  profile?: WriterPromptProfile,
): string {
  // ── 1. 构建 canonical ChapterContract ──────────────────────────────
  // buildChapterContract 需要 UnifiedOrchestratorInput 的子集（intent + context + constitution）。
  // AgenticRawSourceInput 只含 intent + context，constitution 从 context.constitution 获取。
  const contractInput = {
    intent,
    context,
    constitution: context.constitution ?? null,
  } as UnifiedOrchestratorInput;
  const contract = buildChapterContract(contractInput);

  // P0-2：用实际 targetWordCount 覆盖 contract 中的默认 wordCountTarget
  if (targetWordCount) {
    contract.wordCountTarget = targetWordCount;
  }

  // CONTRACT-LAYERING-ABLATION-1：根据 profile 选择渲染策略
  // - "gemini_writer_v2_layered" → renderLayeredContract（分层渲染）
  // - 其他 / undefined → renderContract（平铺渲染，生产默认）

  // ── 2. 渲染 canonical contract 字符串 ──────────────────────────────
  const contractRenderer = profile === "gemini_writer_v2_layered" ? renderLayeredContract : renderContract;
  const parts: string[] = [contractRenderer(contract)];

  // ── 3. 追加运行时检索上下文（非 canonical，但 Agentic 需要感知） ────

  // 开放伏笔（不截断，Agentic 可按需检索详情）
  if (context.openLoops.length > 0) {
    const loops = context.openLoops.map((l) => `  - ${l.id}：${l.description}`);
    parts.push(`【未结伏笔】（共 ${context.openLoops.length} 条，可按需检索详情）\n${loops.join("\n")}`);
  }

  // 世界规则（不截断）
  if (context.worldRules.length > 0) {
    const rules = context.worldRules.map((r) => `  - ${r.description}`);
    parts.push(`【世界规则】（共 ${context.worldRules.length} 条）\n${rules.join("\n")}`);
  }

  // 前章悬置状态（bridgeContext）
  const bridge = context.bridgeContext;
  if (bridge && bridge.available) {
    const bridgeParts: string[] = [];
    if (bridge.lastEventSummary) {
      bridgeParts.push(`  前章最后事件：${bridge.lastEventSummary}`);
    }
    if (bridge.endingEmotion) {
      bridgeParts.push(`  前章结尾情绪：${bridge.endingEmotion}`);
    }
    if (bridge.openHooks.length > 0) {
      bridgeParts.push(`  开放钩子（本章必须承接）：`);
      for (const hook of bridge.openHooks) {
        bridgeParts.push(`    - ${hook}`);
      }
    }
    if (bridge.unresolvedTensions.length > 0) {
      bridgeParts.push(`  未解张力（本章必须回应）：`);
      for (const tension of bridge.unresolvedTensions) {
        bridgeParts.push(`    - ${tension}`);
      }
    }
    if (bridge.introducedCharacters.length > 0) {
      bridgeParts.push(`  前章引入角色：${bridge.introducedCharacters.join("、")}`);
    }
    if (bridgeParts.length > 0) {
      parts.push(`【前章悬置状态】\n${bridgeParts.join("\n")}`);
    }
  }

  // 本章角色（补充 characterNames，contract.relevantCharacters 已从 intent 派生）
  if (characterNames.length > 0) {
    parts.push(`【本章角色】：${characterNames.join("、")}`);
  }

  // 字数软目标（renderContract 不输出 wordCountTarget，单独追加）
  if (targetWordCount) {
    parts.push(`【字数软目标】：${targetWordCount.min}-${targetWordCount.max} 字（非硬性约束，可自由调整）`);
  }

  // P1 修复：注入 few-shot 黄金示例（经 manifest 准入，作为写作参考而非机械配额）
  const fewshotBlock = buildFewshotPromptBlock(fewshotSelection);
  if (fewshotBlock) {
    parts.push(fewshotBlock);
  }

  return parts.join("\n\n") || "（无种子上下文）";
}
