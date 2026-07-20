/**
 * 生产工具注册定义 — 6 个公开工具
 *
 * 生产入口注册 6 个公开工具：
 * - novel_generate_chapter（统一主链路唯一入口）
 * - novel_preflight_workspace（生成前预检）
 * - novel_workspace_manager（工作区管理）
 * - novel_plan_story_outline（大纲规划）
 * - novel_strategy_policy_view（Phase 6 策略信誉查看）
 * - novel_strategy_feedback（Phase 6 用户反馈）
 *
 * legacy 158 工具 + legacy_test 已在 LEGACY-RUNTIME-REMOVAL-1 中删除，
 * 不再存在 register-lab-tools.ts / lab-entry 等文件，生产入口不再依赖
 * NOVEL_TEST_TOOLS / NOVEL_DEBUG_TOOLS 门控。
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { wrapLegacyTool } from "./legacy-tool-wrapper.js";

/**
 * 生产工具 handler 接口 — 6 个公开工具。
 *
 * legacy ~40 个 handle* 已随 LEGACY-RUNTIME-REMOVAL-1 删除，不再有 LabToolHandlers。
 */
export interface PublicToolHandlers {
  handleGenerateChapter(input: any): Promise<any>;
  handlePreflightWorkspace(input: any): Promise<any>;
  handleWorkspaceManager(input: any): Promise<any>;
  handlePlanStoryOutline(input: any): Promise<any>;
  handleStrategyPolicyView(input: any): Promise<any>;
  handleStrategyFeedback(input: any): Promise<any>;
}

/**
 * 注册 6 个公开工具。无 filter、无环境变量门控。
 *
 * 生产入口始终返回这 6 个工具；legacy_test 与诊断工具已在
 * LEGACY-RUNTIME-REMOVAL-1 中删除，不再由 lab-entry 注册。
 */
export function registerTools(handlers: PublicToolHandlers): ToolDefinition[] {
  const publicTools: ToolDefinition[] = [
    // =========================================================================
    // novel_workspace_manager — 工作区管理
    // =========================================================================
    {
      name: "novel_workspace_manager",
      description: "管理工作区。action=\"proxy_finalization\" 委托章节代理审批定稿子操作（accept/accept_with_edits/reject/rollback/inspect）；action=\"proxy_review\" 委托真实 gpt5.6-sol 章节代理初审（runRealChapterProxyReview，需独立授权卡）。保持 6 工具契约。",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "switch", "info", "chapters", "proxy_finalization", "proxy_review"],
            description: "操作类型。proxy_finalization 委托章节代理审批定稿子操作；proxy_review 委托真实 gpt5.6-sol 章节代理初审。",
          },
          workspaceId: { type: "string", description: "workspace ID（proxy_finalization / proxy_review 必填）" },
          // ── proxy_finalization 子操作参数（仅 action="proxy_finalization" 时使用） ──
          proxyAction: {
            type: "string",
            enum: ["accept", "accept_with_edits", "reject", "rollback", "inspect"],
            description: "proxy_finalization 子操作类型",
          },
          chapterId: { type: "string", description: "proxy_finalization / proxy_review 必填：章节 ID" },
          chapterNumber: { type: "number", description: "proxy_finalization / proxy_review 必填：章节编号" },
          approvalId: { type: "string", description: "proxy_finalization 必填：审批 ID" },
          editedText: { type: "string", description: "accept_with_edits 时用户修改后的正文" },
          confirm: { type: "boolean", description: "显式确认（accept/accept_with_edits/rollback 必须传 true）" },
          revision: { type: "string", description: "pending draft revision（与 sentinel.savedAt 比较防过时定稿）" },
          idempotencyKey: { type: "string", description: "幂等键（同 key 重调返回 idempotent=true，不重复执行）" },
          strategyContext: {
            type: "object",
            description: "策略上下文（提供时接入策略信誉证据存储）",
            properties: {
              strategyId: { type: "string" },
              modelVersion: { type: "string" },
              opportunityType: { type: "string" },
            },
          },
          // ── proxy_review 子操作参数（仅 action="proxy_review" 时使用） ──
          releaseId: { type: "string", description: "proxy_review 必填：release ID（授权卡覆盖范围校验用）" },
          authorizationCardPath: {
            type: "string",
            description: "proxy_review 授权卡 JSON 路径；未提供或文件不存在 -> status=error + REQUIRES_AUTH。真实 gpt5.6-sol 调用需独立授权卡，不与生产主路由共享 API key。",
          },
          packetInput: {
            type: "object",
            description: "proxy_review 必填：审批包输入（含 releaseId/workspaceId/chapterId/candidates）",
          },
          forwardVerdict: { type: "object", description: "proxy_review 必填：正向顺序原始 verdict（未归一化）" },
          reverseVerdict: { type: "object", description: "proxy_review 必填：反向顺序原始 verdict" },
          recommendedCandidateId: { type: "string", description: "proxy_review 必填：stub 推荐的候选 ID（必须存在于 packetInput.candidates）" },
          recommendedSource: {
            type: "string",
            enum: ["raw", "editorial", "system_selected"],
            description: "proxy_review 必填：推荐候选来源",
          },
          promptHash: { type: "string", description: "proxy_review 必填：审批 prompt hash" },
          budget: {
            type: "object",
            description: "proxy_review 必填：预算（forward+reverse=2 calls）",
            properties: {
              maxCalls: { type: "number" },
              timeoutMs: { type: "number" },
            },
            required: ["maxCalls", "timeoutMs"],
          },
          modelVersion: { type: "string", description: "proxy_review：reviewer 精确模型版本（如 gpt5.6-sol-2026-07）" },
          anonymousSeed: { type: "number", description: "proxy_review：匿名映射种子（默认 Date.now()）" },
          winningSpans: {
            type: "array",
            items: { type: "string" },
            description: "proxy_review：胜出 span 引用（可选）",
          },
          losingSpans: {
            type: "array",
            items: { type: "string" },
            description: "proxy_review：失分 span 引用",
          },
          holdReason: { type: "string", description: "proxy_review：HOLD_FOR_REGENERATION 原因，透传给 caller" },
        },
        required: ["action"],
      },
      async invoke(input: { action: string; workspaceId?: string }) {
        return handlers.handleWorkspaceManager(input);
      },
    },

    // =========================================================================
    // novel_generate_chapter — 统一主链路唯一入口
    // =========================================================================
    // 【重要】这是章节生成的唯一入口，走统一主链路：
    //   raw -> FactGuard -> EditorialOpportunity -> EditorialCandidate -> Judge -> Select -> StateCommit + AtomicSave
    // 严禁绕过此工具直接调用 novel_narrator 等单工具生成章节正文。
    // Stage0-8 legacy 链路已在 LEGACY-RUNTIME-REMOVAL-1 中删除，不再以任何形式保留
    // （lab-entry / novel_generate_chapter_legacy_test 已不存在）。
    {
      name: "novel_generate_chapter",
      description: "统一章节生成编排器 - 唯一公开入口，走统一主链路（raw → editorial → judge → select → commit）。严禁绕过此工具直接调用 novel_narrator 等单工具生成章节正文。",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string", description: "小说 workspace ID" },
          chapterId: { type: "string", description: "章节 ID（如 12）" },
          chapterNumber: { type: "number", description: "章节编号（用于条件阶段触发判断）" },
          outline: { type: "string", description: "章节大纲（可选，workspace 中有则自动加载）" },
          previousChapterSummary: { type: "string", description: "前章摘要（可选）" },
          styleProfile: { type: "string", description: "风格配置（默认从 workspace 加载）" },
          // P11新增：人工审阅点恢复支持
          reviewToken: { type: "string", description: "【恢复用】审阅 token，用于恢复被暂停的章节生成流程" },
          reviewDecision: { type: "string", description: "【恢复用】审阅决定：confirm 或 reject" },
          reviewFeedback: { type: "string", description: "【恢复用】审阅反馈/修改意见" },
          // REAL-QUALITY-1-PREFLIGHT：单次路由锁定 + 可复现种子
          modelTestRoute: { type: "string", enum: ["glm"], description: "【REAL-QUALITY-1-PREFLIGHT】锁定单次生成路由为 GLM5.2（nb4_generate_glm + nb4_judge_glm），fallback=[] 禁回退；用于单章烟测路由闭环验证。未传时走默认生产路由。" },
          seed: { type: "number", description: "【REAL-QUALITY-1-PREFLIGHT】随机种子（judge 匿名化 + Thompson Sampling 策略筛选可复现）；传入使 editorial 候选生成可复现（seed=1 时 sample≈0.6271≥0.5，策略被选中→生成 editorial 候选）。" },
          recoverBlockedRaw: { type: "boolean", description: "Explicitly reuse a strictly verified raw_fact_guard Claude 4.6 raw; disabled by default." },
          previewOnly: { type: "boolean", description: "【已弃用】旧预览短路径开关（FactGuard 后直接返回 raw）。被 fullPipelinePreview 取代，入口处归一化为完整链路预览。" },
          fullPipelinePreview: { type: "boolean", description: "【FULL-PIPELINE-PREVIEW-1】完整链路只读预览：执行完整 raw→FactGuard→editorial→judge→select 链路，但跳过所有副作用（不写章节、不提交状态、不写 trace/策略库/证据文件、不执行代理审批、不记录 Phase 6 学习 outcome）。用于在不污染工作区状态下预览候选与裁判结果。" },
        },
        required: ["workspaceId", "chapterId", "chapterNumber"],
      },
      async invoke(input: {
        workspaceId: string;
        chapterId: string;
        chapterNumber: number;
        outline?: string;
        previousChapterSummary?: string;
        styleProfile?: string;
        // P11新增：人工审阅点恢复支持
        reviewToken?: string;
        reviewDecision?: "confirm" | "reject";
        reviewFeedback?: string;
        // REAL-QUALITY-1-PREFLIGHT：单次路由锁定 + 可复现种子
        modelTestRoute?: "glm" | "doubao" | "gpt56";
        seed?: number;
        recoverBlockedRaw?: boolean;
        previewOnly?: boolean;
        fullPipelinePreview?: boolean;
      }) {
        // =========================================================================
        // P24-续六 Fix6: model_timeout 章节级重试（调度层包裹）
        // 治理方案要求：model_timeout 不应作为整章 hard_block，需 stage-level retry 或模型 fallback。
        // 当 handleGenerateChapter 返回的 failureEnvelope 标识为 gate=model_timeout +
        // recoverable=true + severity=recoverable 时，重试一次（带 _modelTimeoutRetryAttempt 标记，
        // 供 index.ts 顶层 catch 区分首次失败与重试耗尽）。非 model_timeout 失败不重试。
        // =========================================================================
        const _mtMaxRetries = 1;
        let _mtAttempt = 0;
        let _mtResult: any;
        while (_mtAttempt <= _mtMaxRetries) {
          const _mtInput = _mtAttempt === 0
            ? input
            : { ...input, _modelTimeoutRetryAttempt: _mtAttempt } as any;
          _mtResult = await handlers.handleGenerateChapter(_mtInput);
          const _mtEnv = _mtResult?.failureEnvelope;
          const _mtShouldRetry = _mtEnv?.gate === "model_timeout"
            && _mtEnv?.recoverable === true
            && _mtEnv?.severity === "recoverable"
            && _mtAttempt < _mtMaxRetries;
          if (!_mtShouldRetry) break;
          _mtAttempt++;
        }
        return _mtResult;
      },
    },

    // =========================================================================
    // novel_preflight_workspace — 生成前预检
    // =========================================================================
    // 在调用模型生成前执行纯本地预检，把"前置条件缺失"从"模型随机失败"中分离出来。
    // 预检失败不得进入模型生成；缺 series/outline.md 不得阻断。
    {
      name: "novel_preflight_workspace",
      description: "【治理方案Phase2】生成前预检 - 检查 config/角色档案/前章skeleton/ChapterSeed可生长性/manifest/模型timeout/字数预算。预检失败不得进入模型生成。缺 outline.md 不阻断。",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string", description: "小说 workspace ID" },
          chapterId: { type: "string", description: "章节 ID（如 12）" },
          chapterNumber: { type: "number", description: "章节编号" },
          skipSeedReadiness: { type: "boolean", description: "是否跳过 ChapterSeed 可生长性检查（默认 false）" },
        },
        required: ["workspaceId", "chapterId", "chapterNumber"],
      },
      async invoke(input: {
        workspaceId: string;
        chapterId: string;
        chapterNumber: number;
        skipSeedReadiness?: boolean;
      }) {
        return handlers.handlePreflightWorkspace(input);
      },
    },

    // =========================================================================
    // novel_plan_story_outline — 大纲规划
    // =========================================================================
    {
      name: "novel_plan_story_outline",
      description: "从用户创意生成 series/outline.md 高层背景参考文件（总纲/主题/不可违背事实）。\n\n⚠️ P22 重要说明：此工具只生成高层背景参考文件，不生成章节正文，也不生成任何章纲（显式章纲已废止）。outline.md 仅作为高层背景/主题/不可违背事实参考，不作为章节生成前置条件。章节生成唯一入口是 novel_generate_chapter，写前输入为 ChapterSeed + 感知锚点。\n\n模式：\n- idea_to_outline: idea -> series/outline.md（仅高层背景参考）",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string", description: "小说 workspace ID" },
          mode: { type: "string", description: "idea_to_outline（生成总纲/背景参考）。旧模式 outline_to_chapter_outlines / full_pipeline 已下线，不再生成显式章纲。", enum: ["idea_to_outline"] },
          idea: { type: "string", description: "用户创意，idea_to_outline 必填" },
          fullOutlineText: { type: "string", description: "完整总纲文本；不提供时读取 series/outline.md" },
          startChapter: { type: "number", description: "[已下线] 不再生成显式章纲" },
          endChapter: { type: "number", description: "[已下线] 不再生成显式章纲" },
          totalChapters: { type: "number", description: "总章节数；默认读取 config.json totalChapters" },
          eventCount: { type: "number", description: "[已下线] 不再生成显式章纲" },
          writeFiles: { type: "boolean", description: "是否写入文件，默认 true" },
        },
        required: ["workspaceId"],
      },
      async invoke(input: Record<string, unknown>) {
        return handlers.handlePlanStoryOutline(input);
      },
    },

    // =========================================================================
    // P1-7: Phase 6 在线学习用户公开入口
    // =========================================================================
    {
      name: "novel_strategy_policy_view",
      description: "查看 Phase 6 在线学习策略信誉库（Thompson Sampling Beta 分布 alpha/beta、样本数、状态、evidence log）。可按模型版本或策略 id 过滤。策略信誉由统一编排器在每章裁判后自动记录，驱动后续章节的编辑策略选择概率。",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string", description: "小说 workspace ID" },
          modelVersion: { type: "string", description: "按模型版本过滤（可选，不传则返回全部版本）" },
          strategyId: { type: "string", description: "按策略 id 过滤（可选）" },
        },
        required: ["workspaceId"],
      },
      async invoke(input: {
        workspaceId: string;
        modelVersion?: string;
        strategyId?: string;
      }) {
        return handlers.handleStrategyPolicyView(input);
      },
    },
    {
      name: "novel_strategy_feedback",
      description: "提交用户反馈到 Phase 6 在线学习策略信誉库。支持 5 种操作：\n- choice: 用户在 editorial 与 raw 之间明确选择（最高权重）\n- edit: 用户对最终正文做了修改（高权重，视为对策略候选的否定）\n- rating: 用户对 editorial 候选评分 1-5（4-5=win, <3=loss, 3=tie）\n- status_override: 手动覆盖策略状态（active/dormant/retired）\n- revert: 撤销最近一条 evidence\n\n用户反馈权重高于裁判信号，驱动 Thompson Sampling 在线学习。所有操作可解释、可撤销。",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string", description: "小说 workspace ID" },
          action: {
            type: "string",
            description: "反馈操作类型",
            enum: ["choice", "edit", "rating", "status_override", "revert"],
          },
          strategyId: { type: "string", description: "策略 id（所有操作必填）" },
          modelVersion: { type: "string", description: "模型版本键（所有操作必填）" },
          sourceChapter: { type: "string", description: "来源章节（choice/edit/rating 必填，如 ch17）" },
          opportunityType: { type: "string", description: "编辑机会类型（choice/edit/rating 必填）" },
          chosen: { type: "string", description: "choice 操作：用户选择 editorial 还是 raw", enum: ["editorial", "raw"] },
          deliveredSource: { type: "string", description: "edit 操作：实际交付来源", enum: ["editorial", "raw", "fallback"] },
          modified: { type: "boolean", description: "edit 操作：用户是否修改了最终正文" },
          editDistance: { type: "number", description: "edit 操作：修改幅度 0-1（可选）" },
          rating: { type: "number", description: "rating 操作：1-5 分制评分" },
          candidateSource: { type: "string", description: "rating 操作：评分对象", enum: ["editorial", "raw"] },
          status: { type: "string", description: "status_override 操作：新状态", enum: ["active", "dormant", "retired"] },
          reason: { type: "string", description: "status_override 操作：原因" },
          note: { type: "string", description: "可选备注" },
        },
        required: ["workspaceId", "action", "strategyId", "modelVersion"],
      },
      async invoke(input: {
        workspaceId: string;
        action: "choice" | "edit" | "rating" | "status_override" | "revert";
        strategyId: string;
        modelVersion: string;
        sourceChapter?: string;
        opportunityType?: string;
        chosen?: "editorial" | "raw";
        deliveredSource?: "editorial" | "raw" | "fallback";
        modified?: boolean;
        editDistance?: number;
        rating?: number;
        candidateSource?: "editorial" | "raw";
        status?: "active" | "dormant" | "retired";
        reason?: string;
        note?: string;
      }) {
        return handlers.handleStrategyFeedback(input);
      },
    },

  ];

  return publicTools.map(wrapLegacyTool);
}
