/**
 * ChapterProxyFinalizationHandler — G7 生产入口消费链（计划 §12.2 line 587）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §12.2 / §12.3
 *         docs/remaining-development-dispatch-plan-20260715.md §0.2
 *
 * 用户核验结论（2026-07-17 第二轮）与架构决策（"其他"方案）：
 * - 移除第 7 个公开工具，通过 novel_workspace_manager action="proxy_finalization" 暴露定稿子操作
 * - novel_workspace_manager 内部委托本 handler（handleChapterProxyFinalization）
 * - novel_generate_chapter 遇 pending 仅返回结构化阻断，绝不自动定稿
 * - accept/accept_with_edits/rollback 增加 revision、幂等键和显式确认
 * - 修复 workspace 路径越界（P0）、反馈重复摄入（P1）、保存失败仍记录 accept 反馈（P1）
 *
 * 本 handler 由 tools/workspace-manager-handler.ts import 进入生产闭包（dist/），
 * 不直接注册公开工具（保持 6 工具契约）。调用链：
 * 1. P0 安全解析 workspacePath（resolveWorkspacePath，防目录穿越）
 * 2. 幂等键检查（命中 -> idempotent=true，不执行 finalization）
 * 3. 显式确认检查（accept/accept_with_edits/rollback 必须传 confirm=true）
 * 4. revision 校验（提供时与 pending sentinel.savedAt 比较）
 * 5. 从 config.json 加载 characterNames（含 aliases）-> 构造最小 UnifiedOrchestratorInput
 * 6. inspect 动作：从 createChapterProxyApprovalRegistry 加载 ChapterProxyApprovalArtifact
 * 7. 调用 runFinalization（接入真实 FinalFactRecheck + commitAndSave + feedback 记录）
 * 8. 提供 strategyContext 时调用 ingestProxyApprovalFeedbackToStrategy（持久化摄入游标防重复）
 * 9. 始终调用 aggregateReleaseHealth 返回 release 健康报告
 * 10. 成功执行后记录幂等键（按 action 收紧成功条件：accept/accept_with_edits 需 commit.ok=true；
 *     rollback 需 rolledBack=true；reject/inspect 需 status=ok。失败操作不记录幂等键，允许同 key 重试）
 *
 * 闭包自包含（仅依赖 governance sibling + core/orchestrator sibling + utils/config + utils/fs）：
 * - governance 模块已通过 review-surface-cli.ts prod-binding 进入 dist/
 * - core/orchestrator-types 是 type-only import（编译时擦除）
 * - utils/fs 的 resolveWorkspacePath 是纯本地路径校验（无外部依赖）
 * - 不调用模型（modelGenerate 为 throw stub，finalization 路径不调用）
 *
 * 边界（READY_LOCAL）：
 * - 不生成章节正文（章节生成唯一入口仍是 novel_generate_chapter）
 * - 不绕过统一编排器（仅消费 finalization 调用链 + feedback ingest + health aggregate）
 * - 不修改 config.json / outline.md / 章节生成主链路
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getProjectRoot } from "../utils/config.js";
import { resolveWorkspacePath } from "../utils/fs.js";
import {
  runFinalization,
  type FinalizationEntryAction,
  type FinalizationEntryResult,
  type FinalizationEntryOptions,
} from "../v2/governance/chapter-proxy-approval-finalization-entry.js";
import {
  ingestProxyApprovalFeedbackToStrategy,
  type IngestProxyApprovalFeedbackResult,
  type StrategyContextResolver,
} from "../v2/governance/chapter-proxy-approval-feedback-ingestor.js";
import {
  aggregateReleaseHealth,
  type ReleaseHealthReport,
} from "../v2/governance/release-health-aggregator.js";
import { createChapterProxyApprovalRegistry } from "../v2/governance/chapter-proxy-approval-registry.js";
import type { ChapterProxyApprovalArtifact } from "../v2/governance/chapter-proxy-approval-types.js";
import {
  getPendingSentinel,
  validatePendingBinding,
  loadProxyApprovedDraft,
} from "../v2/governance/chapter-proxy-approval-draft-checkpoint.js";
import {
  authorizeCommitAction,
  consumeApprovalReceipt,
  createActionApprovalReceipt,
  persistConsumedApprovalReceipt,
  saveActionApprovalReceipt,
  type ActionApprovalReceipt,
} from "../v2/governance/action-approval-receipt.js";
import { computeArtifactHash } from "../v2/core/autonomy-policy.js";
import {
  loadIngestCursor,
  saveIngestCursor,
  hasIdempotencyKey,
  recordIdempotencyKey,
} from "../v2/governance/chapter-proxy-approval-feedback-recorder.js";
import type { FinalizationResult } from "../v2/governance/chapter-proxy-approval-finalization.js";
import type { UnifiedOrchestratorInput } from "../v2/core/orchestrator-types.js";
import type {
  ChapterIntent,
} from "../v2/core/chapter-intent-builder.js";
import type { CompiledContext } from "../v2/core/types.js";
import {
  createAuditRunSession,
  type AuditRunSession,
  type AuditStageResultsSummary,
} from "../v2/core/audit/audit-run-session.js";

// ============================================================================
// 类型
// ============================================================================

/** handler 输入 */
export interface HandleChapterProxyFinalizationInput {
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  approvalId: string;
  action: FinalizationEntryAction;
  /** accept_with_edits 时用户修改后的正文 */
  editedText?: string;
  /** 代理推荐的候选来源（未提供时从 pending draft 的 selectedSource 读取） */
  proxyRecommendedSource?: string;
  /**
   * 策略上下文（提供时调用 ingestProxyApprovalFeedbackToStrategy 接入策略证据）。
   * feedback.jsonl 不携带 strategyId/modelVersion/opportunityType，
   * 调用方通过此字段提供。未提供时跳过 ingest（但仍返回 health 报告）。
   */
  strategyContext?: {
    strategyId: string;
    modelVersion: string;
    opportunityType: string;
  };
  /**
   * 显式确认（accept/accept_with_edits/rollback 必须传 true）。
   * 未传或 false 时返回 blocked (confirmation_required)，不执行 finalization。
   * reject/inspect 不需要确认（reject 本身即用户的明确决定，inspect 只读）。
   */
  confirm?: boolean;
  /**
   * pending draft revision（与 sentinel.savedAt 比较）。
   * 提供时若与 pending sentinel 记录的 savedAt 不匹配，返回 blocked (stale_revision)，
   * 防止基于过时 pending 草稿执行定稿（pending 已被新草稿覆盖但调用方仍持旧 revision）。
   * 未提供时跳过 revision 校验。
   */
  revision?: string;
  /**
   * 幂等键（同 key 重调返回 idempotent=true，不重复执行 finalization）。
   * 调用方生成唯一 key（如 UUID），首次调用执行 finalization 并记录 key；
   * 同 key 再次调用直接返回 idempotent=true，不执行任何副作用。
   * 用于网络重试/客户端重放场景，防止重复 commitAndSave + 反馈记录。
   */
  idempotencyKey?: string;
  /**
   * AUTONOMY-P2/P4：正式审批对象（用户定稿）。
   * accept/accept_with_edits 正式提交必须经 authorizeCommitAction。
   * - 调用方显式传入时直接校验
   * - 未传入但 confirm=true 时，由可信宿主根据 pending 绑定签发 user_commit receipt
   * - 仅 confirm / 模型伪造字段不得跳过 receipt 校验
   * 模型输出字段不得构造本对象的 actor=user。
   */
  approvalReceipt?: ActionApprovalReceipt;
  /**
   * 模型输出中的 confirm/approved 等字段。
   * 若出现，明确忽略且不得单独构成用户批准。
   */
  modelClaimedConfirmation?: unknown;
  /** 测试/内部用：注入 commitAndSave mock（模拟 atomicSave/状态提交失败） */
  _commitAndSaveFn?: FinalizationEntryOptions["commitAndSaveFn"];
  /** 测试/内部用：覆盖 project root 解析 */
  _projectRoot?: string;
  /**
   * 测试/内部用：强制审计会话创建失败（验证 accept 路径 fail-closed）。
   * 生产不得设置。
   */
  _forceAuditSessionFailure?: boolean;
}

/** handler 输出 */
export interface HandleChapterProxyFinalizationResult {
  status: "ok" | "blocked" | "error";
  workspaceId: string;
  chapterId: string;
  approvalId: string;
  action: FinalizationEntryAction;
  /** status=error 时的错误信息 */
  error?: string;
  /** runFinalization 结果（status=error 时为 undefined） */
  finalization?: FinalizationEntryResult;
  /** ingest 结果（提供 strategyContext 时存在；否则 undefined） */
  feedbackIngest?: IngestProxyApprovalFeedbackResult;
  /** release 健康报告（status=ok/blocked 时存在） */
  releaseHealth?: ReleaseHealthReport;
  /**
   * 幂等键命中标记。
   * - true：同 idempotencyKey 已被记录，本次调用未执行 finalization（idempotent replay）
   * - false/undefined：首次调用，已执行 finalization（或未提供 idempotencyKey）
   */
  idempotent?: boolean;
  /**
   * AUDIT-1：accept/accept_with_edits 正式提交路径的审计摘要。
   * 与 novel_generate_chapter 的 stageResults.auditRun 同形，便于统一查询 events.jsonl。
   */
  auditRun?: AuditStageResultsSummary & { auditWriteFailed?: boolean };
}

// ============================================================================
// 辅助：从 config.json 加载 characterNames（含 aliases）
// ============================================================================

interface WorkspaceConfigCharacter {
  id?: string;
  name: string;
  role?: string;
  aliases?: string[];
}

/**
 * 从 workspaces/{id}/config.json 的 characters 字段加载角色名。
 *
 * WorkspaceConfig 接口未声明 characters 字段，但实际 config.json（如 xinmo）
 * 含 characters: [{ id, name, role, aliases }]。此处宽松解析：
 * - characters 不存在或非数组 -> 返回空数组
 * - 每个角色贡献 name + aliases（去重保留顺序）
 */
function loadCharacterNames(workspacePath: string): string[] {
  const configPath = join(workspacePath, "config.json");
  if (!existsSync(configPath)) {
    return [];
  }
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return [];
  }
  const characters = (config as { characters?: unknown }).characters;
  if (!Array.isArray(characters)) {
    return [];
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const c of characters as WorkspaceConfigCharacter[]) {
    if (!c || typeof c.name !== "string" || c.name.length === 0) continue;
    if (!seen.has(c.name)) {
      seen.add(c.name);
      names.push(c.name);
    }
    const aliases = Array.isArray(c.aliases) ? c.aliases : [];
    for (const alias of aliases) {
      if (typeof alias === "string" && alias.length > 0 && !seen.has(alias)) {
        seen.add(alias);
        names.push(alias);
      }
    }
  }
  return names;
}

// ============================================================================
// 辅助：构造最小 UnifiedOrchestratorInput
// ============================================================================

/**
 * 构造 finalization 路径所需的最小 UnifiedOrchestratorInput。
 *
 * finalization 路径不调用 raw/editorial/judge 生成（modelGenerate 为 throw stub），
 * 只用 orchestratorInput 满足以下调用方：
 * - checkCandidateFactGuard（accept_with_edits）：读 characterNames + context.characterStates（空时 fallback 到 characterNames）
 * - commitAndSave（accept/accept_with_edits）：读 workspaceId/projectRoot/chapterId/chapterNumber/characterNames/stagedStateUpdate
 *
 * stagedStateUpdate=null：runFinalization 内部会注入空 StagedStateUpdate
 * （计划 §12.2 缺口二：基于最终正文重新派生 pattern entries）。
 */
function buildMinimalOrchestratorInput(
  input: HandleChapterProxyFinalizationInput,
  projectRoot: string,
  characterNames: string[],
  auditSession?: AuditRunSession | null,
): UnifiedOrchestratorInput {
  const intent: ChapterIntent = {
    chapterFunction: "proxy-approval-finalization",
    readerExperience: [],
    currentPressure: [],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: [],
    inviolableFacts: [],
    sourceRefs: [],
  };

  const context: CompiledContext = {
    facts: [],
    characterStates: [],
    openLoops: [],
    worldRules: [],
    styleReferences: [],
    sourceMap: [],
    constitution: null,
    longTermState: null,
    bridgeContext: null,
  };

  return {
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    chapterNumber: input.chapterNumber,
    projectRoot,
    intent,
    context,
    constitution: null,
    characterNames,
    // finalization 路径不调用模型生成；modelGenerate 为 throw stub 防止误用
    modelGenerate: async () => {
      throw new Error(
        "chapter-proxy-finalization-handler: finalization 路径不应调用 modelGenerate（章节生成唯一入口是 novel_generate_chapter）",
      );
    },
    // AUDIT-1：accept/accept_with_edits 经 commitAndSave 写 events.jsonl
    ...(auditSession ? { auditSink: auditSession } : {}),
    // runFinalization 内部：stagedStateUpdate 缺失（undefined）时注入空 update，
    // 使 commitAndSave 进入状态提交分支并从 finalText 提取 pattern entries
    // （计划 §12.2 缺口二：基于最终正文重新派生 pattern entries）
  };
}

// ============================================================================
// 辅助：构建 StrategyContextResolver
// ============================================================================

/**
 * 从调用方提供的 strategyContext 派生 StrategyContextResolver。
 *
 * feedback.jsonl 不携带 strategyId/modelVersion/opportunityType，
 * 调用方通过 strategyContext 提供；sourceChapter 从 chapterNumber 派生（ch{N}）。
 *
 * 返回的 resolver 对所有 feedback 记录返回同一 StrategyContext
 * （finalization 路径下，单次调用只产生一条 feedback 记录）。
 */
function buildStrategyContextResolver(
  strategyContext: HandleChapterProxyFinalizationInput["strategyContext"],
  chapterNumber: number,
): StrategyContextResolver {
  const sourceChapter = `ch${chapterNumber}`;
  return () => ({
    sourceChapter,
    modelVersion: strategyContext!.modelVersion,
    strategyId: strategyContext!.strategyId,
    opportunityType: strategyContext!.opportunityType,
  });
}

// ============================================================================
// handleChapterProxyFinalization — 生产入口消费链
// ============================================================================

/**
 * G7 章节代理审批生产入口消费链。
 *
 * 调用链（计划 §12.2）：
 * 1. workspaceId 安全解析（P0 路径越界防护：reject "..", "/", "\", 绝对路径）
 * 2. 幂等键检查（命中 -> idempotent=true，不执行 finalization）
 * 3. workspace 存在性检查（不存在 -> status=error，不调用 runFinalization）
 * 4. 显式确认校验（accept/accept_with_edits/rollback 需 confirm=true，否则 blocked）
 * 5. revision 校验（accept/accept_with_edits 需 revision 匹配 pending sentinel.savedAt，否则 blocked）
 * 6. 加载 characterNames -> 构造最小 UnifiedOrchestratorInput
 * 7. inspect 动作：从 registry 加载 ChapterProxyApprovalArtifact
 * 8. 调用 runFinalization（接入真实 FinalFactRecheck + commitAndSave + feedback 记录）
 *    - commit 失败时不记录 accept 成功反馈（P1 失败反馈污染防护，由 finalization-entry 处理）
 * 9. 提供 strategyContext 时调用 ingestProxyApprovalFeedbackToStrategy
 *    - 加载持久化 ingest cursor（P1 重复摄入防护），传入已摄入 approvalId 集合
 *    - ingest 后保存更新后的 cursor
 * 10. 始终调用 aggregateReleaseHealth 返回 release 健康报告
 * 11. 成功执行后记录幂等键（便于同 key 重放返回 idempotent=true）
 *
 * status 语义：
 * - "ok"：finalization 成功（accept/accept_with_edits 通过、reject、rollback、inspect）
 * - "blocked"：finalization 因 confirmation_required / stale_revision / approvalId/chapterId 不匹配或 FactGuard 失败被阻断
 * - "error"：workspace 不存在 / inspect 无法加载 artifact / 内部异常
 */
export async function handleChapterProxyFinalization(
  input: HandleChapterProxyFinalizationInput,
): Promise<HandleChapterProxyFinalizationResult> {
  const projectRoot = input._projectRoot || getProjectRoot();

  const baseResult = {
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    approvalId: input.approvalId,
    action: input.action,
  };

  // ── 1. workspaceId 安全解析（P0 路径越界防护） ──────────────────────
  // resolveWorkspacePath 内部调用 validateWorkspaceId：
  // - 仅允许字母数字、underscore、hyphen
  // - 拒绝 "..", "/", "\", 绝对路径
  // - 二次防线：resolve 后检查结果路径在 basePath 之下
  // workspaceId=".." 等非法值会抛错，被外层 catch 捕获为 status=error
  let workspacePath: string;
  try {
    workspacePath = resolveWorkspacePath(
      join(projectRoot, "workspaces"),
      input.workspaceId,
    );
  } catch (e: unknown) {
    return {
      ...baseResult,
      status: "error",
      error: `workspaceId 安全校验失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // ── 2. 幂等键检查（命中 -> idempotent=true，不执行） ─────────────────
  if (input.idempotencyKey) {
    if (hasIdempotencyKey(workspacePath, input.idempotencyKey)) {
      return {
        ...baseResult,
        status: "ok",
        idempotent: true,
      };
    }
  }

  // ── 3. workspace 存在性检查 ──────────────────────────────────────────
  if (!existsSync(workspacePath) || !existsSync(join(workspacePath, "config.json"))) {
    return {
      ...baseResult,
      status: "error",
      error: `workspace 不存在或 config.json 缺失：${workspacePath}`,
    };
  }

  // AUDIT-1：会话提升到 try 外层，外层 catch 可写 run_interrupted，避免缺终止事件
  const needsPersistenceAudit =
    input.action === "accept" || input.action === "accept_with_edits";
  let auditSession: AuditRunSession | null = null;

  try {
    // ── 4. 显式确认校验（accept/accept_with_edits/rollback 需要 confirm=true） ──
    // reject/inspect 不需要确认（reject 本身即用户明确决定，inspect 只读）
    const requiresConfirm =
      input.action === "accept" ||
      input.action === "accept_with_edits" ||
      input.action === "rollback";
    if (requiresConfirm && input.confirm !== true) {
      return {
        ...baseResult,
        status: "blocked",
        finalization: {
          finalization: {
            action: input.action,
            clearedPending: false,
            canCommit: false,
            blockReason: "confirmation_required",
          },
        },
      };
    }

    // ── 5. revision 校验（accept/accept_with_edits 需要 revision 匹配 pending sentinel.savedAt） ──
    // 提供时若与 pending sentinel 记录的 savedAt 不匹配，返回 blocked (stale_revision)
    // 未提供 revision 时跳过校验（向后兼容）
    if (
      input.revision !== undefined &&
      (input.action === "accept" || input.action === "accept_with_edits")
    ) {
      const sentinel = getPendingSentinel(workspacePath, input.chapterId);
      const effectiveRevision = sentinel?.revision ?? sentinel?.savedAt;
      if (sentinel !== null && effectiveRevision !== input.revision) {
        return {
          ...baseResult,
          status: "blocked",
          finalization: {
            finalization: {
              action: input.action,
              clearedPending: false,
              canCommit: false,
              blockReason: "stale_revision",
            },
          },
        };
      }
    }

    // ── 5b. AUTONOMY-P2/P3/P4：正式提交强制审批对象 + pending 版本绑定 ──
    // - modelClaimedConfirmation 永不单独构成用户批准
    // - accept/accept_with_edits 必须经 authorizeCommitAction（无 receipt 兼容旁路）
    // - confirm=true 仅表示可信宿主收到用户意图；由宿主签发 user_commit receipt
    // - pending 绑定：workspace/chapter/approvalId/revision/artifactHash
    let effectiveApprovalReceipt: ActionApprovalReceipt | undefined =
      input.approvalReceipt;

    if (input.action === "accept" || input.action === "accept_with_edits") {
      // 模型伪造确认字段且无宿主 confirm / 显式 receipt → 阻断
      if (
        input.modelClaimedConfirmation === true &&
        input.confirm !== true &&
        !input.approvalReceipt
      ) {
        return {
          ...baseResult,
          status: "blocked",
          finalization: {
            finalization: {
              action: input.action,
              clearedPending: false,
              canCommit: false,
              blockReason: "confirmation_required",
            },
          },
        };
      }

      const sentinel = getPendingSentinel(workspacePath, input.chapterId);
      if (sentinel === null) {
        return {
          ...baseResult,
          status: "blocked",
          finalization: {
            finalization: {
              action: input.action,
              clearedPending: false,
              canCommit: false,
              blockReason: "no_pending_draft",
            },
          },
        };
      }
      // 错误 approvalId：优先返回 approval_id_mismatch（先于 draft 加载）
      if (sentinel.approvalId !== input.approvalId) {
        return {
          ...baseResult,
          status: "blocked",
          finalization: {
            finalization: {
              action: input.action,
              clearedPending: false,
              canCommit: false,
              blockReason: "approval_id_mismatch",
            },
          },
        };
      }

      const pendingDraft = loadProxyApprovedDraft(workspacePath, input.approvalId);
      if (!pendingDraft) {
        return {
          ...baseResult,
          status: "blocked",
          finalization: {
            finalization: {
              action: input.action,
              clearedPending: false,
              canCommit: false,
              blockReason: "no_pending_draft",
            },
          },
        };
      }

      const effectiveRevision =
        input.revision ??
        input.approvalReceipt?.revision ??
        sentinel.revision ??
        sentinel.savedAt ??
        pendingDraft.revision ??
        pendingDraft.savedAt;

      // pending 身份绑定：始终校验（不再是“提供 revision 时才校验”）
      const bind = validatePendingBinding({
        workspacePath,
        workspaceId: input.workspaceId,
        chapterId: input.chapterId,
        approvalId: input.approvalId,
        revision: effectiveRevision,
        // accept 绑定 pending 正文；accept_with_edits 先校验 pending 版本身份
        finalText: pendingDraft.finalText,
      });
      if (!bind.ok) {
        return {
          ...baseResult,
          status: "blocked",
          finalization: {
            finalization: {
              action: input.action,
              clearedPending: false,
              canCommit: false,
              blockReason: bind.blockReason ?? "stale_revision",
            },
          },
        };
      }

      // 提交正文：accept=pending 正文；accept_with_edits=用户修改后正文
      const textForReceipt =
        input.action === "accept_with_edits" && typeof input.editedText === "string"
          ? input.editedText
          : pendingDraft.finalText;
      const artifactHashForReceipt = computeArtifactHash(textForReceipt);

      // 无显式 receipt 时：仅当 confirm=true（可信宿主用户意图）才签发
      if (!effectiveApprovalReceipt) {
        if (input.confirm !== true) {
          return {
            ...baseResult,
            status: "blocked",
            finalization: {
              finalization: {
                action: input.action,
                clearedPending: false,
                canCommit: false,
                blockReason: "confirmation_required",
              },
            },
          };
        }
        try {
          effectiveApprovalReceipt = createActionApprovalReceipt({
            workspaceId: input.workspaceId,
            chapterId: input.chapterId,
            action: "chapter.save",
            kind: "user_commit",
            artifactHash: artifactHashForReceipt,
            revision: effectiveRevision,
            actor: "user",
            taskId: `proxy-finalization:${input.workspaceId}:${input.chapterId}:${input.approvalId}`,
            decision: "approve",
            requiredChecks: [
              "fact_guard",
              "story_preservation",
              "completeness",
              "pending_bound",
              "revision_match",
              "artifact_hash_match",
            ],
          });
          // append-only 落盘（同 approvalId 冲突时忽略——测试重入可发生）
          try {
            saveActionApprovalReceipt(workspacePath, effectiveApprovalReceipt);
          } catch {
            // 已存在同 id 时不阻断；authorizeCommitAction 仍会校验内存对象
          }
        } catch (e: unknown) {
          return {
            ...baseResult,
            status: "blocked",
            finalization: {
              finalization: {
                action: input.action,
                clearedPending: false,
                canCommit: false,
                blockReason: "approval_required",
              },
            },
            error: `签发审批对象失败：${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }

      // 正式提交必须经过 authorizeCommitAction（无旁路）
      const auth = authorizeCommitAction({
        receipt: effectiveApprovalReceipt,
        finalText: textForReceipt,
        workspaceId: input.workspaceId,
        chapterId: input.chapterId,
        action: "chapter.save",
        revision: effectiveApprovalReceipt.revision,
        completedChecks: [
          "fact_guard",
          "story_preservation",
          "completeness",
          "pending_bound",
          "revision_match",
          "artifact_hash_match",
        ],
        modelClaimedConfirmation: input.modelClaimedConfirmation,
        executorActor: "orchestrator",
      });
      if (!auth.allowed) {
        return {
          ...baseResult,
          status: "blocked",
          finalization: {
            finalization: {
              action: input.action,
              clearedPending: false,
              canCommit: false,
              blockReason: auth.blockReason ?? "denied",
            },
          },
        };
      }
    }

    // ── 6. 加载 characterNames + 构造最小 orchestratorInput ──────────
    // AUDIT-1：创建 AuditRunSession。
    // accept/accept_with_edits：fail-closed —— 审计会话创建失败则阻断正式提交，禁止无审计提交。
    // reject/inspect/rollback：审计失败降级为无 auditRun（无正文副作用，可放行业务决策）。
    try {
      if (input._forceAuditSessionFailure) {
        throw new Error("forced audit session failure (test)");
      }
      auditSession = createAuditRunSession({
        projectRoot,
        workspaceId: input.workspaceId,
        chapterId: input.chapterId,
        chapterNumber: input.chapterNumber,
        persist: true,
      });
      auditSession.start({
        path: "proxy_finalization",
        action: input.action,
        approvalId: input.approvalId,
        revision: input.revision ?? null,
        needsPersistenceAudit,
      });
    } catch (auditCreateErr) {
      auditSession = null;
      if (needsPersistenceAudit) {
        const msg =
          auditCreateErr instanceof Error
            ? auditCreateErr.message
            : String(auditCreateErr);
        return {
          ...baseResult,
          status: "blocked",
          finalization: {
            finalization: {
              action: input.action,
              clearedPending: false,
              canCommit: false,
              blockReason: "audit_session_unavailable",
            },
          },
          error: `审计会话创建失败，正式提交已阻断（禁止无审计提交）：${msg}`,
          auditRun: {
            enabled: true,
            schemaVersion: "1.0.0",
            traceId: "",
            runId: "",
            eventsPath: null,
            eventCount: 0,
            sequence: 0,
            runTerminal: false,
            lastEventType: null,
            completenessOk: false,
            completenessIssues: [
              {
                code: "missing_run_started",
                message: `audit session create failed: ${msg}`,
              },
            ],
            writeError: msg,
            persisted: false,
            auditWriteFailed: true,
          },
        };
      }
    }

    const characterNames = loadCharacterNames(workspacePath);
    const orchestratorInput = buildMinimalOrchestratorInput(
      input,
      projectRoot,
      characterNames,
      auditSession,
    );

    // ── 7. inspect 动作：从 registry 加载 artifact ───────────────────
    let approvalArtifact: ChapterProxyApprovalArtifact | undefined;
    if (input.action === "inspect") {
      const registry = createChapterProxyApprovalRegistry({
        approvalsDir: join(workspacePath, "chapter-approvals"),
      });
      approvalArtifact = registry.loadArtifact(input.approvalId) ?? undefined;
      if (!approvalArtifact) {
        if (auditSession) {
          try {
            auditSession.finalizeInterrupted(
              `inspect approval artifact missing: ${input.approvalId}`,
            );
          } catch {
            /* ignore */
          }
        }
        return {
          ...baseResult,
          status: "error",
          error: `inspect 动作无法加载 approval artifact：approvalId=${input.approvalId}（registry 中不存在或损坏）`,
          auditRun: auditSession?.toStageResultsSummary(),
        };
      }
    }

    // RUN-LIFECYCLE-P4：用户决策事件（commandId = idempotencyKey 或派生）
    // 须在 runFinalization 副作用前写入，便于崩溃恢复识别命令意图
    const commandId =
      input.idempotencyKey ??
      `finalization:${input.action}:${input.approvalId}:${input.revision ?? "latest"}`;
    if (auditSession) {
      const userEventType =
        input.action === "accept"
          ? ("user_accepted" as const)
          : input.action === "accept_with_edits"
            ? ("user_modified" as const)
            : input.action === "reject"
              ? ("user_rejected" as const)
              : input.action === "rollback"
                ? ("user_rollback" as const)
                : null;
      if (userEventType) {
        try {
          const { event } = auditSession.getEventStore().append({
            actor: "user",
            stage: "user_revision",
            eventType: userEventType,
            status: "completed",
            evidenceLevel: "observed",
            approvalId: input.approvalId,
            revision: input.revision,
            decisionReason: `proxy_finalization ${input.action}`,
            payload: {
              commandId,
              action: input.action,
              chapterId: input.chapterId,
              hasEditedText: Boolean(input.editedText),
            },
          });
          auditSession.getAggregateRepository().applyAppendedEvent(event);
        } catch {
          // 用户事件写失败不阻断业务；seal 摘要会暴露 writeError/foldError
        }
      }
    }

    // ── 8. 调用 runFinalization（真实调用链入口） ────────────────────
    // _commitAndSaveFn 注入：测试用于模拟 commitAndSave 失败场景
    // AUDIT/FEEDBACK lineage：有 strategyContext 时写入完整策略血缘，供 ingest 通过 isCompleteLineage
    const feedbackLineage = input.strategyContext
      ? {
          orchestratorRunId:
            auditSession?.runId ??
            `proxy-finalization:${input.workspaceId}:${input.chapterId}:${input.approvalId}`,
          strategyId: input.strategyContext.strategyId,
          strategyBundleId: `proxy-strategy-bundle:${input.strategyContext.strategyId}`,
          modelVersion: input.strategyContext.modelVersion,
          promptBundleId: "proxy-finalization-prompt",
          exposureId: `proxy-exposure:${input.approvalId}`,
          feedbackEventId: `proxy-feedback:${input.approvalId}:${input.action}`,
          sourceChapter: `ch${input.chapterNumber}`,
        }
      : auditSession
        ? {
            orchestratorRunId: auditSession.runId,
            sourceChapter: `ch${input.chapterNumber}`,
          }
        : undefined;
    const finalizationResult = runFinalization({
      workspacePath,
      chapterId: input.chapterId,
      approvalId: input.approvalId,
      action: input.action,
      editedText: input.editedText,
      orchestratorInput,
      proxyRecommendedSource: input.proxyRecommendedSource,
      approvalArtifact,
      commitAndSaveFn: input._commitAndSaveFn,
      feedbackLineage,
    });

    // ── 9. 提供 strategyContext 时调用 ingestProxyApprovalFeedbackToStrategy ──
    // P1 重复摄入防护：加载持久化 ingest cursor，传入已摄入 approvalId 集合，
    // ingest 后保存更新后的 cursor（防止同一 approvalId 被重复摄入策略证据）
    let feedbackIngest: IngestProxyApprovalFeedbackResult | undefined;
    if (input.strategyContext) {
      const contextResolver = buildStrategyContextResolver(input.strategyContext, input.chapterNumber);
      const alreadyIngested = loadIngestCursor(workspacePath);
      feedbackIngest = ingestProxyApprovalFeedbackToStrategy({
        workspacePath,
        workspaceId: input.workspaceId,
        projectRoot,
        contextResolver,
        alreadyIngestedApprovalIds: alreadyIngested,
      });
      // 保存更新后的 cursor（ingestProxyApprovalFeedbackToStrategy 返回 ingestedApprovalIds 包含新增）
      const updatedSet = new Set<string>(feedbackIngest.ingestedApprovalIds);
      saveIngestCursor(workspacePath, updatedSet);
    }

    // ── 10. 始终调用 aggregateReleaseHealth 返回 release 健康报告 ──────
    const releaseHealth = aggregateReleaseHealth(workspacePath, {
      workspaceId: input.workspaceId,
      projectRoot,
    });

    // ── 11. 决定 status ───────────────────────────────────────────────
    // blockReason 存在（confirmation_required / stale_revision / approval_id_mismatch /
    // chapter_id_mismatch / no_pending_draft / factguard_failed 等）-> blocked
    // P0-1 修复（用户阻断项）：accept/accept_with_edits 的 commitAndSave 失败
    // （commit.ok=false）也必须 -> blocked，不得误报 ok 让调用方无法区分
    // "成功定稿"与"提交失败待重试"。
    // reject/rollback/inspect 的 canCommit=false 是正常状态（无 blockReason）-> ok
    // （rollback rolledBack=false 是"章节未提交，无需回滚"的合法路径，仍为 ok）
    const blockReason = finalizationResult.finalization.blockReason;
    const commitFailed =
      (input.action === "accept" || input.action === "accept_with_edits") &&
      finalizationResult.commit !== undefined &&
      !finalizationResult.commit.ok;
    const status: "ok" | "blocked" = blockReason || commitFailed ? "blocked" : "ok";

    // ── 12. 成功执行后记录幂等键（便于同 key 重放返回 idempotent=true） ──
    // P1 修复（用户阻断项）：失败操作不得记录幂等键，否则同 key 重试会直接返回
    // idempotent=true 而跳过执行，导致章节始终未写入。
    // 成功条件按 action 收紧（不再仅凭顶层 status==="ok"）：
    // - accept/accept_with_edits：commitAndSave 必须成功（commit?.ok === true）。
    //   commit 失败/pending 已恢复时不算成功，允许同 key 重试。
    // - rollback：必须实际回滚（rollbackResult.rolledBack === true）。
    //   chapter_not_committed 等未发生回滚的情形不算成功，允许同 key 重试。
    // - reject/inspect：无 commit/rollback，status==="ok"（无 blockReason）即视为成功。
    const idempotencySuccess =
      status === "ok" &&
      (input.action === "accept" || input.action === "accept_with_edits"
        ? finalizationResult.commit?.ok === true
        : input.action === "rollback"
          ? finalizationResult.finalization.rollbackResult?.rolledBack === true
          : true);
    if (input.idempotencyKey && idempotencySuccess) {
      recordIdempotencyKey(workspacePath, input.idempotencyKey, {
        approvalId: input.approvalId,
        processedAt: new Date().toISOString(),
        action: input.action,
      });
    }

    // AUTONOMY-P4：提交成功后才消费审批对象；失败不消费
    if (
      idempotencySuccess &&
      effectiveApprovalReceipt &&
      (input.action === "accept" || input.action === "accept_with_edits")
    ) {
      try {
        const consumed = consumeApprovalReceipt(effectiveApprovalReceipt);
        persistConsumedApprovalReceipt(workspacePath, consumed);
      } catch {
        // 消费落盘失败不回滚已成功提交；审计侧可从 missing consumed 发现
      }
    }

    // AUDIT-1：根据 finalization 结果写终止事件
    // - accept/accept_with_edits：commitAndSave 已写 chapter_save/state_commit/final_submission
    // - reject/inspect/rollback：无正文提交，仅 run 生命周期 + decisionReason
    let auditRun: (AuditStageResultsSummary & { auditWriteFailed?: boolean }) | undefined;
    if (auditSession) {
      try {
        if (needsPersistenceAudit) {
          if (status === "ok" && !commitFailed) {
            auditSession.finalizeFromV2Output({
              status: "ok",
              selectedCandidateId: "proxy-finalized",
              selectedSource: null,
            });
          } else {
            auditSession.finalizeFromV2Output({
              status: "blocked",
              failureEnvelope: {
                stage: "proxy_finalization",
                gate: blockReason ?? (commitFailed ? "commit_failed" : "blocked"),
                severity: "hard",
                reason:
                  blockReason ??
                  finalizationResult.commit?.error ??
                  `proxy_finalization ${input.action} blocked`,
                recoverable: Boolean(finalizationResult.pendingRestored),
                failureClass: "blocked",
              },
            });
          }
        } else if (status === "ok") {
          auditSession.finishRun("run_finished", {
            decisionReason: `proxy_finalization action=${input.action}`,
            payload: {
              action: input.action,
              approvalId: input.approvalId,
              blockReason: blockReason ?? null,
            },
          });
        } else {
          auditSession.finalizeFromV2Output({
            status: "blocked",
            failureEnvelope: {
              stage: "proxy_finalization",
              gate: blockReason ?? "blocked",
              severity: "hard",
              reason:
                blockReason ?? `proxy_finalization ${input.action} blocked`,
              recoverable: false,
              failureClass: "blocked",
            },
          });
        }
        auditRun = {
          ...auditSession.toStageResultsSummary(),
          auditWriteFailed: false,
        };
      } catch (auditErr) {
        auditRun = {
          ...auditSession.toStageResultsSummary(),
          auditWriteFailed: true,
          writeError:
            auditErr instanceof Error ? auditErr.message : String(auditErr),
        };
      }
    }

    return {
      ...baseResult,
      status,
      finalization: finalizationResult,
      feedbackIngest,
      releaseHealth,
      idempotent: false,
      auditRun,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // AUDIT-1：外层异常必须尽量写终止事件，避免 run 悬空
    let auditRun: (AuditStageResultsSummary & { auditWriteFailed?: boolean }) | undefined;
    if (auditSession) {
      try {
        auditSession.finalizeInterrupted(
          `finalization handler exception: ${msg}`,
          e,
        );
        auditRun = {
          ...auditSession.toStageResultsSummary(),
          auditWriteFailed: false,
        };
      } catch (auditErr) {
        auditRun = {
          ...auditSession.toStageResultsSummary(),
          auditWriteFailed: true,
          writeError:
            auditErr instanceof Error ? auditErr.message : String(auditErr),
        };
      }
    }
    return {
      ...baseResult,
      status: "error",
      error: `finalization handler 执行异常：${msg}`,
      auditRun,
    };
  }
}
