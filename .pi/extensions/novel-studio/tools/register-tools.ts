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
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { wrapLegacyTool } from "./legacy-tool-wrapper.js";
import { atomicSave } from "../v2/core/orchestrator-commit-save.js";

interface ChapterFileSnapshot {
  path: string;
  existed: boolean;
  text: string | null;
}

function captureChapterFileSnapshot(input: Record<string, unknown>): ChapterFileSnapshot | null {
  const projectRoot = typeof input._projectRoot === "string" ? input._projectRoot : null;
  const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId : null;
  const chapterId = typeof input.chapterId === "string" ? input.chapterId : null;
  if (!projectRoot || !workspaceId || !chapterId) return null;

  const workspacesRoot = resolve(projectRoot, "workspaces");
  const path = resolve(workspacesRoot, workspaceId, "chapters", `${chapterId}.md`);
  const relativePath = relative(workspacesRoot, path);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return null;
  const existed = existsSync(path);
  return {
    path,
    existed,
    text: existed ? readFileSync(path, "utf8") : null,
  };
}

function protectChapterFileAfterNonDeliverableResult(
  snapshot: ChapterFileSnapshot | null,
  result: any,
): any {
  if (!snapshot || result?.status === "ok") return result;
  try {
    let action = "unchanged";
    if (snapshot.existed && snapshot.text !== null) {
      const currentText = existsSync(snapshot.path) ? readFileSync(snapshot.path, "utf8") : null;
      if (currentText !== snapshot.text) {
        atomicSave(snapshot.path, snapshot.text);
        action = "restored_previous_chapter";
      }
    } else if (existsSync(snapshot.path)) {
      unlinkSync(snapshot.path);
      action = "removed_blocked_draft";
    }
    return {
      ...result,
      chapterWriteProtection: {
        protected: true,
        action,
        chapterFilePath: snapshot.path,
      },
    };
  } catch (error: unknown) {
    return {
      ...result,
      chapterWriteProtection: {
        protected: false,
        action: "restore_failed",
        chapterFilePath: snapshot.path,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

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
  /**
   * BATCH-P0-01：批量章节生成入口。
   * 由 novel_generate_chapter 工具在 mode === "batch" 时调用。
   * 内部逐章调用 handleGenerateChapter（统一主链路），禁止直接调用模型。
   */
  handleBatchGeneration(input: any): Promise<any>;
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
      description: "管理工作区。action=\"proxy_finalization\" 委托章节代理审批定稿子操作（accept/accept_with_edits/reject/rollback/inspect）；action=\"proxy_review\" 委托真实 gpt5.6-sol 章节代理初审（runRealChapterProxyReview，需独立授权卡）；action=\"diagnostic\"/\"ingest_reader_feedback\"/\"record_return_chapter\" 委托 advisory 子操作（仅产出 advisory 证据，不进入 raw prompt，不阻断生成，不决定文学胜负）。保持 6 工具契约。",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "switch", "info", "chapters", "proxy_finalization", "proxy_review", "diagnostic", "ingest_reader_feedback", "record_return_chapter"],
            description: "操作类型。proxy_finalization 委托章节代理审批定稿子操作；proxy_review 委托真实 gpt5.6-sol 章节代理初审；diagnostic 聚合当前 chapter advisory 信号；ingest_reader_feedback 写入读者反馈；record_return_chapter 记录回流章 provenance。后三个为 advisory-only 子操作。",
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
          // ── advisory 子操作参数（仅 action="diagnostic"/"ingest_reader_feedback"/"record_return_chapter" 时使用） ──
          // advisory-only：不进入 raw prompt，不阻断生成，不决定文学胜负；只产出诊断证据。
          // APPENDIX-FG-1（2026-07-21）：P1-4 修复——补齐 MCP schema，使三个 advisory action 实际可调用。
          feedbackType: {
            type: "string",
            enum: ["positive", "negative", "neutral"],
            description: "ingest_reader_feedback 必填：反馈类型",
          },
          feedbackText: {
            type: "string",
            description: "ingest_reader_feedback 必填：反馈正文",
          },
          sourceRef: {
            type: "string",
            description: "ingest_reader_feedback / record_return_chapter 必填：来源引用（必须可追溯，如章节 ID + 段落定位）",
          },
          focusDimensions: {
            type: "array",
            items: { type: "string" },
            description: "ingest_reader_feedback 可选：聚焦维度（如 plot/character/pacing/style 等）",
          },
          returnType: {
            type: "string",
            enum: ["rewrite", "recap", "reveal"],
            description: "record_return_chapter 必填：回流章类型",
          },
          sourceChapterIds: {
            type: "array",
            items: { type: "string" },
            description: "record_return_chapter 必填：源章节 ID 列表（非空数组）",
          },
          reason: {
            type: "string",
            description: "record_return_chapter 必填：回流章触发原因",
          },
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
      description: "统一章节生成编排器 - 唯一公开入口，走统一主链路（raw → editorial → judge → select → commit）。严禁绕过此工具直接调用 novel_narrator 等单工具生成章节正文。只有 status=ok 的结果可作为正式章节；blocked/error 结果及 blocked-candidate-evidence 中的正文严禁复制或写入 chapters/。",
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
          writerModel: {
            type: "string",
            enum: ["gemini31", "claude"],
            default: "gemini31",
            description: "正文主写模型：Gemini 3.1 Pro（默认）。通常省略本字段或传 gemini31；仅当用户明确要求 Claude 时才允许传 claude。两者 raw/editorial 路由均 fallback=[]，失败时阻断，不静默切换其他正文模型。",
          },
          modelTestRoute: { type: "string", enum: ["glm", "gemini31", "claude48"], description: "显式模型对比路由：glm 锁定 GLM5.2；gemini31 锁定 Gemini 3.1 Pro；claude48 锁定 Claude Opus 4.8。正文实验路由均 fallback=[]，未传时走默认生产路由。" },
          seed: { type: "number", description: "【REAL-QUALITY-1-PREFLIGHT】随机种子（judge 匿名化 + Thompson Sampling 策略筛选可复现）；传入使 editorial 候选生成可复现（seed=1 时 sample≈0.6271≥0.5，策略被选中→生成 editorial 候选）。" },
          candidateTimeoutMs: { type: "number", description: "单次正文候选模型调用的有界超时（毫秒）；未传时使用统一主链路默认值。" },
          previewTotalTimeoutMs: { type: "number", description: "完整只读预览全部模型调用的总时间预算（毫秒）；仅 fullPipelinePreview 生效。" },
          sceneSolution: { type: "object", description: "仅受控评测兼容字段；生产 raw 不消费场景解法卡。" },
          recoverBlockedRaw: { type: "boolean", description: "显式复用经 hash/完整性校验的 raw_fact_guard 冻结 raw；必须同时显式指定相同 writerModel，默认关闭。" },
          previewOnly: { type: "boolean", description: "【已弃用】旧预览短路径开关（FactGuard 后直接返回 raw）。被 fullPipelinePreview 取代，入口处归一化为完整链路预览。" },
          fullPipelinePreview: { type: "boolean", description: "【FULL-PIPELINE-PREVIEW-1】完整链路只读预览：执行完整 raw→FactGuard→editorial→judge→select 链路，但跳过所有副作用（不写章节、不提交状态、不写 trace/策略库/证据文件、不执行代理审批、不记录 Phase 6 学习 outcome）。用于在不污染工作区状态下预览候选与裁判结果。" },
          boundedBestOf3: { type: "boolean", description: "仅历史评测兼容字段；固定场景多候选已退出生产主链路。" },
          qualityExperiment: {
            type: "object",
            description: "Read-only quality ceiling sample isolated from production candidate expansion.",
            properties: {
              arm: { type: "string", enum: ["raw", "scene", "oracle_scene"] },
              sampleIndex: { type: "number", minimum: 1, maximum: 3 },
            },
            required: ["arm", "sampleIndex"],
          },
          // ── BATCH-P0-01：批量章节生成模式 ──
          // 不新增第二个正文生成工具；批量能力作为 novel_generate_chapter 的 mode="batch" 分支。
          // 内部仍逐章调用统一主链路（handleGenerateChapter），禁止直接调用模型。
          // 机器文学裁判 / pairwise judge / 旧 raw/editorial 双链路不得进入批量生产流程。
          mode: {
            type: "string",
            enum: ["batch"],
            description: "批量章节生成模式。传入 mode='batch' 时走批量分支，需同时传 action/startChapter/endChapter 等批量参数。不传 mode 时走单章生成（默认行为，向后兼容）。",
          },
          action: {
            type: "string",
            enum: ["start", "resume", "status", "cancel"],
            description: "批量操作类型（mode='batch' 时必填）。start：创建并执行批量任务；resume：从 checkpoint 继续；status：查询进度；cancel：请求停止。",
          },
          startChapter: {
            type: "number",
            minimum: 1,
            description: "批量起始章节号（action='start' 必填，≥1）。",
          },
          endChapter: {
            type: "number",
            minimum: 1,
            description: "批量结束章节号（action='start' 必填，≥startChapter）。默认上限 100；confirmLargeBatch=true 放宽到 1000。",
          },
          seedSource: {
            type: "string",
            enum: ["workspace_or_planner", "workspace_only"],
            description: "ChapterSeed 来源（action='start' 可选，默认 workspace_or_planner）。",
          },
          stopOnFailure: {
            type: "boolean",
            default: true,
            description: "章节失败时是否暂停任务（默认 true；false 时失败转为 error 状态）。",
          },
          confirmLargeBatch: {
            type: "boolean",
            default: false,
            description: "确认大批量任务。默认 false（上限 100 章）；传 true 放宽到 1000 章。",
          },
          jobId: {
            type: "string",
            description: "批量任务 ID（action='resume'/'status'/'cancel' 必填）。action='start' 时可选，未传则自动生成。",
          },
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
        writerModel?: "claude" | "gemini31";
        modelTestRoute?: "glm" | "doubao" | "gpt56" | "gemini31" | "claude48";
        seed?: number;
        candidateTimeoutMs?: number;
        previewTotalTimeoutMs?: number;
        sceneSolution?: Record<string, unknown>;
        recoverBlockedRaw?: boolean;
        previewOnly?: boolean;
        fullPipelinePreview?: boolean;
        boundedBestOf3?: boolean;
        qualityExperiment?: { arm: "raw" | "scene" | "oracle_scene"; sampleIndex: number };
        // BATCH-P0-01：批量章节生成模式字段
        mode?: "batch";
        action?: "start" | "resume" | "status" | "cancel";
        startChapter?: number;
        endChapter?: number;
        seedSource?: "workspace_or_planner" | "workspace_only";
        stopOnFailure?: boolean;
        confirmLargeBatch?: boolean;
        jobId?: string;
        _projectRoot?: string;
        _mockGenerateChapter?: (input: any) => Promise<any>;
      }) {
        // =========================================================================
        // BATCH-P0-01：批量章节生成分支
        // mode === "batch" 时走批量分支，委托 handleBatchGeneration。
        // 跳过单章快照保护（批量有自己的 checkpoint 保护与幂等性双校验）。
        // 不新增第二个正文生成工具；批量内部仍逐章调用统一主链路。
        // =========================================================================
        if ((input as any).mode === "batch") {
          return handlers.handleBatchGeneration(input);
        }
        // =========================================================================
        // P24-续六 Fix6: model_timeout 章节级重试（调度层包裹）
        // 治理方案要求：model_timeout 不应作为整章 hard_block，需 stage-level retry 或模型 fallback。
        // 当 handleGenerateChapter 返回的 failureEnvelope 标识为 gate=model_timeout +
        // recoverable=true + severity=recoverable 时，重试一次（带 _modelTimeoutRetryAttempt 标记，
        // 供 index.ts 顶层 catch 区分首次失败与重试耗尽）。非 model_timeout 失败不重试。
        // =========================================================================
        const chapterFileSnapshot = captureChapterFileSnapshot(input as unknown as Record<string, unknown>);
        const _mtMaxRetries = input.fullPipelinePreview || input.previewOnly ? 0 : 1;
        let _mtAttempt = 0;
        let _mtResult: any;
        try {
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
        } catch (error: unknown) {
          protectChapterFileAfterNonDeliverableResult(chapterFileSnapshot, { status: "error" });
          throw error;
        }
        return protectChapterFileAfterNonDeliverableResult(chapterFileSnapshot, _mtResult);
      },
    },

    // =========================================================================
    // novel_preflight_workspace — 生成前预检
    // =========================================================================
    // 在调用模型生成前执行纯本地预检，把"前置条件缺失"从"模型随机失败"中分离出来。
    // 预检失败不得进入模型生成；缺 series/outline.md 不得阻断。
    {
      name: "novel_preflight_workspace",
      description: "生成前预检：检查 config、角色档案、前章状态、作者章节契约解析、模型 timeout 与字数预算。感知锚点和正文写法不作为阻断条件。",
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
      description: "从用户创意生成 series/outline.md 整体剧情方向。作者维护的 ch{N}-outline-explicit.md 可作为章节功能、事件内容、状态变化、伏笔、因果和章末目标的权威写前输入；本工具不生成正文。章节生成唯一入口是 novel_generate_chapter。\n\n模式：\n- idea_to_outline: idea -> series/outline.md",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string", description: "小说 workspace ID" },
          mode: { type: "string", description: "idea_to_outline（生成整体剧情方向）。旧批量拆章模式已下线。", enum: ["idea_to_outline"] },
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
