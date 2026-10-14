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

/**
 * Public MCP/tool calls must not be able to inject handler-only test seams
 * through undeclared JSON properties. Filesystem-root authority
 * is checked earlier by legacy-tool-wrapper, which can distinguish the trusted
 * novel-runtime hand-off from an ordinary tool call. The handlers still accept
 * these fields for in-process tests and for the batch orchestrator; this
 * boundary is where remaining untrusted tool input is rejected.
 */
const INTERNAL_ONLY_PUBLIC_FIELDS = new Set([
  "_mockGenerateChapter",
  "_commitAndSaveFn",
  "_registryOverride",
  "callerOverride",
]);

function rejectInternalPublicFields(input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const forbidden = Object.keys(input as Record<string, unknown>).filter((key) =>
    INTERNAL_ONLY_PUBLIC_FIELDS.has(key),
  );
  if (forbidden.length === 0 || process.env.NOVEL_TEST_TOOLS === "1") return;
  throw new Error(
    `内部字段不得通过生产工具入口传入：${forbidden.join(", ")}。` +
    "请使用已声明的生产参数；测试注入只能在隔离测试环境中使用。",
  );
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
      description: "创建、切换、查询工作区，并承载代理审批与 advisory 子操作。action=\"init\" 创建 workspace；action=\"switch\" 校验并切换到已有 workspace；proxy/advisory 子操作保持原有治理边界。保持 6 工具契约。",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["init", "list", "switch", "info", "chapters", "proxy_finalization", "proxy_review", "diagnostic", "ingest_reader_feedback", "record_return_chapter"],
            description: "操作类型。init 创建 workspace；switch 切换到已有 workspace；proxy_finalization/proxy_review 处理代理审批；diagnostic/ingest_reader_feedback/record_return_chapter 为 advisory-only 子操作。",
          },
          workspaceId: { type: "string", description: "workspace ID（除 list 外通常必填）" },
          novelName: { type: "string", description: "init 必填：小说名称" },
          genre: { type: "string", description: "init 必填：主类型/世界观类型" },
          subGenres: {
            type: "array",
            items: { type: "string" },
            description: "init 可选：子类型列表",
          },
          styleProfile: { type: "string", description: "init 可选：作者风格档案 ID，默认 default" },
          targetWordCount: {
            type: "object",
            description: "init 可选：字数软目标",
            properties: {
              perChapter: {
                type: "object",
                properties: {
                  min: { type: "number" },
                  max: { type: "number" },
                },
                required: ["min", "max"],
              },
              total: { type: "number" },
            },
            required: ["perChapter", "total"],
          },
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
      async invoke(input: {
        action: string;
        workspaceId?: string;
        novelName?: string;
        genre?: string;
        subGenres?: string[];
        styleProfile?: string;
        targetWordCount?: { perChapter: { min: number; max: number }; total: number };
      }) {
        rejectInternalPublicFields(input);
        return handlers.handleWorkspaceManager(input);
      },
    },

    // =========================================================================
    // novel_generate_chapter — 统一主链路唯一入口
    // =========================================================================
    // 【重要】这是章节生成的唯一入口，走统一主链路：
    //   Preflight → ContextCompiler → ChapterIntent → NovelOS Agentic → Agentic FactGuard
    //   → 作者风格整章优化 → StoryPreservation → FinalFactRecheck → Completeness
    //   → FinalStateCommit → AtomicSave + Trace
    // 生产路径不调用 PairwiseJudge / SelectionPolicy / EditorialOpportunityJudge（仅 eval-only）。
    // 严禁绕过此工具直接调用 novel_narrator 等单工具生成章节正文。
    // Stage0-8 legacy 链路已在 LEGACY-RUNTIME-REMOVAL-1 中删除，不再以任何形式保留
    // （lab-entry / novel_generate_chapter_legacy_test 已不存在）。
    {
      name: "novel_generate_chapter",
      description: "统一章节生成编排器 - 唯一公开入口，走统一主链路（NovelOS Agentic → 作者风格整章优化 → 事实复检 → 状态提交/原子保存）。生产不调用机器文学裁判，用户是唯一文学评价权威。严禁绕过此工具直接调用 novel_narrator 等单工具生成章节正文。只有 status=ok 的结果可作为正式章节；blocked/error 结果及 blocked-candidate-evidence 中的正文严禁复制或写入 chapters/。",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string", description: "小说 workspace ID" },
          chapterId: { type: "string", description: "章节 ID（如 12）" },
          chapterNumber: { type: "number", description: "章节编号（用于条件阶段触发判断）" },
          continuationMode: {
            type: "string",
            enum: ["replace", "append"],
            description: "已有正文处理方式；append 必须原样保留当前正文并从末尾续写。",
          },
          currentChapterDraft: {
            type: "string",
            description: "append 模式下的当前章节正文，由受信平台运行时提供。",
          },
          targetWordCount: {
            type: "object",
            properties: {
              min: { type: "number", minimum: 100 },
              max: { type: "number", minimum: 100 },
            },
            required: ["min", "max"],
            description: "本次任务的最终整章目标字数范围；优先于 workspace 默认值。",
          },
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
            description: "正文主写模型：Gemini（默认，具体模型由 .env 的 GEMINI_MODEL 决定）。通常省略本字段或传 gemini31；仅当用户明确要求 Claude 时才允许传 claude。两者 raw/editorial 路由均 fallback=[]，失败时阻断，不静默切换其他正文模型。旧 gpt6astra 选项已按版本收敛原则移除。",
          },
          // PRODUCTION-ROLLOUT-AUDIT-1 P0-1b/P0-10：modelTestRoute 已从公开 schema 移除
          // （eval-only 模型对比路由）。生产路径不接受显式模型对比路由；内部 handler 仍
          // 保留该字段供 eval/评测入口直调，公开工具不再暴露。
          seed: { type: "number", description: "【REAL-QUALITY-1-PREFLIGHT】随机种子（Thompson Sampling 策略筛选可复现；eval-only 路径同时复现 judge 匿名化与 editorial 候选生成，seed=1 时 sample≈0.6271≥0.5，策略被选中→生成 editorial 候选）。生产路径不调用 judge，seed 仅影响策略信誉采样。" },
          candidateTimeoutMs: { type: "number", description: "单次正文候选模型调用的有界超时（毫秒）；未传时使用统一主链路默认值。" },
          previewTotalTimeoutMs: { type: "number", description: "完整只读预览全部模型调用的总时间预算（毫秒）；仅 fullPipelinePreview 生效。" },
          sceneSolution: { type: "object", description: "仅受控评测兼容字段；生产 raw 不消费场景解法卡。" },
          // PRODUCTION-ROLLOUT-AUDIT-1 P0-1b/P0-10：fullPipelinePreview 已从公开 schema 移除
          // （只读预览为 eval/开发能力，生产验收路径拒绝它）。内部 handler/orchestrator 仍
          // 保留该字段供评测入口与测试直调，公开工具不再暴露；预览请走 novel_preflight_workspace。
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
            description: "ChapterSeed 来源（action='start' 可选，默认 workspace_only）。workspace_or_planner 仅为旧调用兼容值；自动章节契约拆分已退役，缺种子时同样阻断且不会生成 chN-outline-explicit.md。",
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
          commandId: {
            type: "string",
            description: "用户命令幂等键（CONCURRENCY-WAVE5）。resume/cancel 必填；start 携带时重复提交返回首次结果，不重复保存或生成。缺省 resume/cancel 会 fail-closed。",
          },
        },
        required: ["workspaceId", "chapterId", "chapterNumber"],
      },
      async invoke(input: {
        workspaceId: string;
        chapterId: string;
        chapterNumber: number;
        continuationMode?: "replace" | "append";
        currentChapterDraft?: string;
        targetWordCount?: { min: number; max: number };
        outline?: string;
        previousChapterSummary?: string;
        styleProfile?: string;
        reviewToken?: string;
        reviewDecision?: "confirm" | "reject";
        reviewFeedback?: string;
        writerModel?: "claude" | "gemini31";
        seed?: number;
        candidateTimeoutMs?: number;
        previewTotalTimeoutMs?: number;
        sceneSolution?: Record<string, unknown>;
        // BATCH-P0-01：批量章节生成模式字段
        mode?: "batch";
        action?: "start" | "resume" | "status" | "cancel";
        startChapter?: number;
        endChapter?: number;
        seedSource?: "workspace_or_planner" | "workspace_only";
        stopOnFailure?: boolean;
        confirmLargeBatch?: boolean;
        jobId?: string;
        commandId?: string;
        _projectRoot?: string;
      }) {
        rejectInternalPublicFields(input);
        const _forbiddenProduction = [
          "modelTestRoute",
          "fullPipelinePreview",
          "qualityExperiment",
          "boundedBestOf3",
          "_mockGenerateChapter",
          "recoverBlockedRaw",
          "previewOnly",
        ].filter((field) => (input as Record<string, unknown>)[field] !== undefined);
        // 批量测试入口可带 _mockGenerateChapter；生产公开调用不得带 mock。
        const _allowTestMock =
          process.env.NOVEL_TEST_TOOLS === "1"
          && _forbiddenProduction.length === 1
          && _forbiddenProduction[0] === "_mockGenerateChapter";
        if (_forbiddenProduction.length > 0 && !_allowTestMock) {
          throw new Error(
            `实验字段在生产入口被拒绝：${_forbiddenProduction.join(", ")}。` +
            `这些字段仅用于 eval/评测，生产 schema 不接受 raw/judge/preview/mock 旁路。`,
          );
        }
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
        // P24-续六 Fix6: Agentic model_timeout 章节级重试（调度层包裹）
        // 作者风格优化的空结果/超时已在编排器阶段内复用 Agentic 候选重试，不进入此分支。
        // 当 handleGenerateChapter 返回的 failureEnvelope 标识为 gate=model_timeout +
        // recoverable=true + severity=recoverable 时，重试一次（带 _modelTimeoutRetryAttempt 标记，
        // 供 index.ts 顶层 catch 区分首次失败与重试耗尽）。非 Agentic model_timeout 失败不重试。
        // =========================================================================
        const chapterFileSnapshot = captureChapterFileSnapshot(input as unknown as Record<string, unknown>);
        const _mtMaxRetries = 1;
        let _mtAttempt = 0;
        let _mtResult: any;
        // P1-6: 记录工具层 model_timeout 重试证据，供 canary runner / metrics 识别恢复路径。
        // 旧 canary 只识别 stageResults.blockedRawRecovery；新增 stageResults.modelTimeoutRetry
        // 覆盖 Phase 1 工具层重试，使恢复率指标可信。
        const _mtRetryTrace: { attempted: boolean; attempts: number; succeeded: boolean; firstFailureEnvelope?: any } = {
          attempted: false,
          attempts: 0,
          succeeded: false,
        };
        // RECOVERY-P2：外层章节重试必须透传累计 RecoveryBudget，禁止每轮重置。
          // BG-01：同步透传累计统一预算账本 _priorBudgetLedger，禁止每轮重置。
          // 同时当 recoveryAction=checkpoint / attempt 耗尽 / recoverable=false 时停止重试。
          let _priorRecoveryBudget: unknown = undefined;
          let _priorBudgetLedger: unknown = undefined;
          try {
          while (_mtAttempt <= _mtMaxRetries) {
            const _mtInput = _mtAttempt === 0
              ? input
              : {
                  ...input,
                  _modelTimeoutRetryAttempt: _mtAttempt,
                  // 延续上一轮已消耗的章节级恢复预算与统一预算账本
                  ...(_priorRecoveryBudget
                    ? { _priorRecoveryBudget }
                    : {}),
                  ...(_priorBudgetLedger
                    ? { _priorBudgetLedger }
                    : {}),
                } as any;
            _mtResult = await handlers.handleGenerateChapter(_mtInput);
            const _mtEnv = _mtResult?.failureEnvelope;
            // 透传本轮累计预算给下一轮
            if (_mtResult?.stageResults?.recoveryBudget) {
              _priorRecoveryBudget = _mtResult.stageResults.recoveryBudget;
            }
            if (_mtResult?.stageResults?.budgetLedger) {
              const { snapshot: _ledgerSnap, ..._ledgerRest } = _mtResult.stageResults.budgetLedger;
              _priorBudgetLedger = _ledgerRest;
            }
            const _mtRecoveryAction =
              _mtEnv?.recoveryAction ??
              _mtResult?.stageResults?.recoveryDecision?.recoveryAction;
            const _mtShouldRetry = (
              _mtEnv?.gate === "model_timeout"
              || _mtEnv?.gate === "continuation_prefix_mismatch"
            )
              && _mtEnv?.recoverable === true
              && _mtEnv?.severity === "recoverable"
              && _mtRecoveryAction !== "checkpoint"
              && _mtRecoveryAction !== "stop"
              && _mtAttempt < _mtMaxRetries;
            if (!_mtShouldRetry) break;
            // 记录首次失败 envelope，attempts+1（即重试次数）
            _mtRetryTrace.attempted = true;
            _mtRetryTrace.attempts += 1;
            _mtRetryTrace.firstFailureEnvelope = _mtEnv;
            _mtAttempt++;
          }
          // 重试后若最终 status=ok，视为恢复成功
          if (_mtRetryTrace.attempted && _mtResult?.status === "ok") {
            _mtRetryTrace.succeeded = true;
          }
        } catch (error: unknown) {
          protectChapterFileAfterNonDeliverableResult(chapterFileSnapshot, { status: "error" });
          throw error;
        }
        // 注入 retry 证据到 stageResults，避免 canary runner 无法识别工具层重试
        if (_mtRetryTrace.attempted) {
          if (!_mtResult) _mtResult = { status: "error" };
          if (!_mtResult.stageResults || typeof _mtResult.stageResults !== "object") {
            _mtResult.stageResults = {};
          }
          _mtResult.stageResults.modelTimeoutRetry = _mtRetryTrace;
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
        rejectInternalPublicFields(input);
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
        rejectInternalPublicFields(input);
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
        rejectInternalPublicFields(input);
        return handlers.handleStrategyPolicyView(input);
      },
    },
    {
      name: "novel_strategy_feedback",
      description: "提交用户反馈到 Phase 6 在线学习策略信誉库。支持 choice/edit/rating/status_override/revert。普通章节反馈推荐传 workspaceId + chapterId + naturalLanguageFeedback（或用户修改稿）；系统会从成功 trace 推断 modelVersion、selectedStrategyIds、sourceChapter。显式提供的上下文优先。策略信誉按模型版本隔离，所有操作可解释、可撤销。",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string", description: "小说 workspace ID" },
          action: {
            type: "string",
            description: "反馈操作类型（提供 naturalLanguageFeedback 时可省略，由编译器推断）",
            enum: ["choice", "edit", "rating", "status_override", "revert"],
          },
          strategyId: { type: "string", description: "策略 id（提供 naturalLanguageFeedback 时可省略，由编译器推断）" },
          modelVersion: { type: "string", description: "模型版本键。可省略：提供 chapterId 时从成功 trace 推断；无法推断则明确报错。" },
          sourceChapter: { type: "string", description: "来源章节（choice/edit/rating 必填，如 ch17）" },
          opportunityType: { type: "string", description: "编辑机会类型（choice/edit/rating 必填）" },
          chosen: { type: "string", description: "choice 操作：用户选择 editorial 还是 raw", enum: ["editorial", "raw"] },
          deliveredSource: { type: "string", description: "edit 操作：实际交付来源", enum: ["editorial", "raw", "fallback"] },
          modified: { type: "boolean", description: "edit 操作：用户是否修改了最终正文（提供 userFinalText 时由系统计算，无需手填）" },
          editDistance: { type: "number", description: "edit 操作：修改幅度 0-1（提供 userFinalText 时由系统计算，无需手填）" },
          userFinalText: { type: "string", description: "Phase 4A：用户最终修改稿（与 deliveredText 对比自动计算 delta）" },
          deliveredText: { type: "string", description: "Phase 4A：系统交付正文（与 userFinalText 对比自动计算 delta）" },
          chapterId: { type: "string", description: "P1 修复：章节 ID（如 \"17\"）。提供 userFinalText + deliveredText + chapterId 时，系统自动把 userModificationDelta 回填到 chapters/{chapterId}.review-package.json sidecar。未提供则跳过 sidecar 回填（仅记录策略信誉）。" },
          naturalLanguageFeedback: { type: "string", description: "Phase 4D（P1-3）：自然语言反馈（规则驱动编译为结构化策略反馈，无需手填 strategyId/action）" },
          selectedStrategyIds: {
            type: "array",
            items: { type: "string" },
            description: "本次生成选中的策略 id 列表（供编译器通用情感归因；可从 trace.stageResults.authorStyleStrategySelection.selectedStrategyIds 读取）",
          },
          rating: { type: "number", description: "rating 操作：1-5 分制评分" },
          candidateSource: { type: "string", description: "rating 操作：评分对象", enum: ["editorial", "raw"] },
          status: { type: "string", description: "status_override 操作：新状态", enum: ["active", "dormant", "retired"] },
          reason: { type: "string", description: "status_override 操作：原因" },
          note: { type: "string", description: "可选备注" },
        },
        required: ["workspaceId"],
        allOf: [
          {
            // 未提供 naturalLanguageFeedback 时，action + strategyId 仍必填（显式反馈路径）
            if: {
              not: {
                properties: { naturalLanguageFeedback: { type: "string", minLength: 1 } },
                required: ["naturalLanguageFeedback"],
              },
            },
            then: { required: ["action", "strategyId"] },
          },
        ],
      },
      async invoke(input: {
        workspaceId: string;
        action?: "choice" | "edit" | "rating" | "status_override" | "revert";
        strategyId?: string;
        modelVersion?: string;
        sourceChapter?: string;
        opportunityType?: string;
        chosen?: "editorial" | "raw";
        deliveredSource?: "editorial" | "raw" | "fallback";
        modified?: boolean;
        editDistance?: number;
        userFinalText?: string;
        deliveredText?: string;
        chapterId?: string;
        naturalLanguageFeedback?: string;
        selectedStrategyIds?: string[];
        rating?: number;
        candidateSource?: "editorial" | "raw";
        status?: "active" | "dormant" | "retired";
        reason?: string;
        note?: string;
      }) {
        rejectInternalPublicFields(input);
        return handlers.handleStrategyFeedback(input);
      },
    },

  ];

  return publicTools.map(wrapLegacyTool);
}
