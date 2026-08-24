/**
 * 工具调用路由（内部 API，platform 版）
 *
 * POST /v1/invoke
 * Body: { tool: "novel_generate_chapter", input: {...} }
 * Header: X-Novel-Task-Token: <signed>
 *
 * 流程：
 * 1. 任务令牌认证（中间件已验证，jobId/userId/projectId 来自令牌 payload）
 * 2. 校验 tool 在白名单内
 * 3. 校验 input DTO
 * 4. 物化临时 workspace（从 input.workspaceDocuments 写入 temp 目录）
 * 5. 调用工具 invoke（经 meteringBinder 包装，事后逐次上报 token 用量结算）
 * 6. 失败时释放预占；成功收尾由 platform-api 与章节持久化放在同一数据库事务内完成
 * 7. finally 清理临时 workspace（不污染正式存储）
 * 8. 返回结果（内部调用方 platform-api 可拿完整结果用于状态管理与对账）
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as pino from "pino";
import { z } from "zod";
import type { LoadedTools } from "../../extension-loader.js";
import { isAllowedTool } from "../../tool-whitelist.js";
import type { BillingClient } from "../../billing-client.js";
import type { MeteringBinderInstance } from "../../metering-binder.js";
import type { WorkspaceManager } from "../../workspace-manager.js";
import type { NovelRuntimeConfig } from "../../config.js";

const INVOKE_BODY_SCHEMA = z.object({
  tool: z.string().min(1),
  input: z.record(z.unknown()).default({}),
});

// These fields are runtime/test seams, never client DTO fields.  In
// particular, accepting a client-supplied _projectRoot would let a caller
// redirect the extension's filesystem writes before the runtime overwrites it.
const RESERVED_INTERNAL_INPUT_FIELDS = new Set([
  "_projectRoot",
  "_mockGenerateChapter",
  "_commitAndSaveFn",
  "_registryOverride",
  "callerOverride",
  "__onUpdate",
]);

export function findReservedInternalInputFields(input: Record<string, unknown>): string[] {
  return Object.keys(input).filter((key) => RESERVED_INTERNAL_INPUT_FIELDS.has(key));
}

/**
 * 章节生成的成功契约：HTTP 调用完成不等于章节可交付。
 * 只有统一编排器明确返回 ok 且正文非空，才允许结算为 success。
 */
export function isDeliverableChapterResult(result: unknown): result is {
  status: "ok";
  text: string;
} {
  if (!result || typeof result !== "object") return false;
  const value = result as { status?: unknown; text?: unknown };
  return value.status === "ok" && typeof value.text === "string" && value.text.trim().length > 0;
}

export function describeUndeliverableChapter(result: unknown, modelCallCount: number): string {
  if (result && typeof result === "object") {
    const value = result as {
      failureEnvelope?: { reason?: unknown };
      reason?: unknown;
    };
    const envelope = value.failureEnvelope?.reason;
    if (typeof envelope === "string" && envelope.trim()) {
      return envelope.trim().slice(0, 1000);
    }
    if (typeof value.reason === "string" && value.reason.trim()) {
      return value.reason.trim().slice(0, 1000);
    }
  }
  if (modelCallCount <= 0) {
    return "章节生成未调用模型，未产出可交付正文";
  }
  return "章节生成未产出可交付正文";
}

function extractFailureEnvelope(result: unknown): unknown {
  if (result && typeof result === "object" && "failureEnvelope" in result) {
    return (result as { failureEnvelope?: unknown }).failureEnvelope;
  }
  return undefined;
}

/** A disconnected caller must never reach the durable success path. */
export function assertInvokeNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('invoke request aborted');
  }
}

/**
 * The runtime state is part of the durable chapter-delivery contract.  A
 * missing snapshot is valid for a workspace that has not committed state yet;
 * a present but unreadable snapshot is corruption and must stop delivery.
 */
export function readNarrativeStateSnapshot(
  tempProjectRoot: string,
  workspaceId: string,
): unknown | undefined {
  const statePath = join(
    tempProjectRoot,
    "workspaces",
    workspaceId,
    "narrative-state-store.json",
  );

  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as unknown;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }

    throw new Error(
      `narrative state snapshot is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export interface InvokeRouterDeps {
  billingClient: BillingClient;
  meteringBinder: MeteringBinderInstance;
  /** P0-4：多租户 workspace 管理器 */
  workspaceManager: WorkspaceManager;
  config: NovelRuntimeConfig;
  logger?: pino.Logger;
}

export function createInvokeRouter(
  loadedTools: LoadedTools,
  deps: InvokeRouterDeps,
): Router {
  const router = Router();
  const logger = deps.logger;

  router.post("/invoke", async (req: Request, res: Response, next: NextFunction) => {
    // 临时 workspace 物化与清理状态
    let materializedJobId: string | null = null;

    try {
      const parseResult = INVOKE_BODY_SCHEMA.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          code: "INVALID_BODY",
          message: "请求体格式错误",
          requestId: res.locals.requestId,
        });
        return;
      }

      const { tool: toolName, input } = parseResult.data;

      const injectedFields = findReservedInternalInputFields(input);
      if (injectedFields.length > 0) {
        res.status(400).json({
          code: "INTERNAL_INPUT_FIELD",
          message: `输入包含禁止的内部字段：${injectedFields.join(", ")}`,
          requestId: res.locals.requestId,
        });
        return;
      }

      // 白名单二次校验（深度防御，中间件已校验 capability）
      if (!isAllowedTool(toolName)) {
        res.status(403).json({
          code: "TOOL_NOT_WHITELISTED",
          message: "工具不在白名单内",
          requestId: res.locals.requestId,
        });
        return;
      }

      const tool = loadedTools.byName.get(toolName);
      if (!tool || typeof tool.invoke !== "function") {
        res.status(404).json({
          code: "TOOL_NOT_FOUND",
          message: "工具未加载或不可调用",
          requestId: res.locals.requestId,
        });
        return;
      }

      // 任务令牌已由中间件验证，jobId/userId/projectId 来自令牌 payload（不可被客户端伪造）
      const taskToken = res.locals.taskToken;
      const jobCtx = {
        jobId: taskToken?.payload.jobId ?? "",
        userId: taskToken?.payload.userId ?? "",
        projectId: taskToken?.payload.projectId ?? "",
      };

      // 默认 projectRoot（仅用于非生成类工具；容器内默认来自 config）
      let inputWithMeta: Record<string, unknown> = {
        ...input,
        _projectRoot: deps.config.novelStudioProjectRoot,
      };

      if (
        (toolName === "novel_generate_chapter" || toolName === "novel_plan_story_outline") &&
        jobCtx.jobId
      ) {
        const workspaceId = (input.workspaceId as string | undefined) ??
          deps.workspaceManager.deriveWorkspaceId(jobCtx.userId, jobCtx.projectId);

        // 从 input 提取 platform-api 编排器预物化的文档与配置
        const workspaceDocuments = (input.workspaceDocuments as unknown[] | undefined) ?? [];
        const projectConfig = (input.projectConfig as {
          genre: string;
          subGenres?: string[];
          worldKeyTerms?: string[];
          characters?: Array<{ name: string; role?: string; description?: string }>;
          extra?: Record<string, unknown>;
        } | undefined) ?? { genre: "未指定" };

        // 把 workspaceDocuments 数组转为 WorkspaceDocument[] 类型
        const docs = workspaceDocuments.map((d) => d as {
          type: "creative_constitution" | "worldbuilding" | "character_profile" |
                "story_outline" | "story_outline_full" | "style_profile" | "chapter_seed" |
                "explicit_outline" | "narrative_state";
          content: string;
        });

        const materialized = deps.workspaceManager.materializeWorkspace({
          jobId: jobCtx.jobId,
          workspaceId,
          projectConfig,
          documents: docs,
          chapterNumber: toolName === "novel_generate_chapter"
            ? input.chapterNumber as number | undefined
            : undefined,
          previousChapterText: undefined,
          previousChapterNumber: toolName === "novel_generate_chapter"
            ? input.previousChapterNumber as number | undefined
            : undefined,
          previousChapterContinuation: toolName === "novel_generate_chapter"
            ? input.previousChapterContinuation as {
                chapterNumber: number;
                endingState: string;
                lastSceneSummary: string;
                changedCharacters: string[];
                unresolvedPromises: string[];
                tailExcerpt?: string;
                sourceChapterHash: string;
              } | undefined
            : undefined,
          contextManifest: toolName === "novel_generate_chapter"
            ? input.contextManifest
            : undefined,
        });
        materializedJobId = jobCtx.jobId;

        // 用 temp root 覆盖全局 _projectRoot
        inputWithMeta = {
          ...input,
          // 删除透传字段，避免 PiNovelStudio 把它当未知字段处理
          workspaceDocuments: undefined,
          projectConfig: undefined,
          previousChapterText: undefined,
          previousChapterNumber: undefined,
          previousChapterContinuation: undefined,
          contextManifest: undefined,
          _projectRoot: materialized.tempProjectRoot,
          workspaceId,
        };
      }

      // Propagate client cancellation to the PI execute protocol.
      const abortController = new AbortController();
      const abortOnDisconnect = (): void => {
        if (!res.writableEnded) abortController.abort();
      };
      req.once("aborted", abortOnDisconnect);
      res.once("close", abortOnDisconnect);

      // 经 meteringBinder 包装 invoke，事后结算
      const { result, metering } = await deps.meteringBinder.invokeWithMetering(
        tool,
        inputWithMeta,
        jobCtx,
        abortController.signal,
      );
      assertInvokeNotAborted(abortController.signal);
      let resultForCaller = result;

      const contextMetrics = input.contextManifest && typeof input.contextManifest === "object"
        ? {
            ...(input.contextManifest as Record<string, unknown>),
            actualInputTokens: metering.inputTokens,
            actualOutputTokens: metering.outputTokens,
            settledCostFen: metering.totalSettledAmountFen,
          }
        : undefined;
      if (contextMetrics && result && typeof result === "object") {
        resultForCaller = { ...(result as Record<string, unknown>), contextManifest: contextMetrics };
      }

      if (materializedJobId && input.contextManifest && typeof input.contextManifest === "object") {
        deps.workspaceManager.updateContextManifest?.(materializedJobId, contextMetrics);
      }

      if (toolName === "novel_generate_chapter" && materializedJobId && result && typeof result === "object") {
        const tempProjectRoot = inputWithMeta._projectRoot;
        const workspaceId = inputWithMeta.workspaceId;
        if (typeof tempProjectRoot === "string" && typeof workspaceId === "string") {
          try {
            const runtimeState = readNarrativeStateSnapshot(tempProjectRoot, workspaceId);
            resultForCaller = { ...(resultForCaller as Record<string, unknown>), runtimeState };
          } catch (error: unknown) {
            if (jobCtx.jobId) {
              try {
                const fin = await deps.billingClient.finalize(jobCtx.jobId, "failure");
                logger?.info(
                  { jobId: jobCtx.jobId, holdStatus: fin.status },
                  "billing hold finalized (invalid narrative state)",
                );
              } catch (finalizeError: unknown) {
                logger?.error(
                  {
                    jobId: jobCtx.jobId,
                    err: finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
                  },
                  "billing finalize failed after invalid narrative state (hold left for ops reconcile)",
                );
              }
            }
            res.status(422).json({
              code: "NARRATIVE_STATE_INVALID",
              message: error instanceof Error ? error.message : "narrative state snapshot is invalid",
              status: "error",
              jobId: jobCtx.jobId,
              requestId: res.locals.requestId,
            });
            return;
            // 不伪造状态；没有快照时仍按章节交付契约处理正文。
          }
        }
      }

      // 章节硬门禁/编排错误可能以正常 Promise 返回；不能把这种结果当成
      // 成功交付，否则会错误地把任务定格为 succeeded 并结算成功。
      if (
        toolName === "novel_generate_chapter" &&
        (!isDeliverableChapterResult(resultForCaller) || metering.modelCallCount <= 0)
      ) {
        if (jobCtx.jobId) {
          try {
            const fin = await deps.billingClient.finalize(jobCtx.jobId, "failure");
            logger?.info(
              { jobId: jobCtx.jobId, holdStatus: fin.status },
              "billing hold finalized (non-deliverable chapter)",
            );
          } catch (err) {
            logger?.error(
              { jobId: jobCtx.jobId, err: err instanceof Error ? err.message : String(err) },
              "billing finalize failed after non-deliverable chapter (hold left for ops reconcile)",
            );
          }
        }
        const resultStatus =
          resultForCaller && typeof resultForCaller === "object" && "status" in resultForCaller
            ? String((resultForCaller as { status?: unknown }).status ?? "error")
            : "error";
        res.status(422).json({
          code: "CHAPTER_NOT_DELIVERABLE",
          message: describeUndeliverableChapter(resultForCaller, metering.modelCallCount),
          status: resultStatus === "blocked" ? "blocked" : "error",
          failureEnvelope: extractFailureEnvelope(resultForCaller),
          jobId: jobCtx.jobId,
          requestId: res.locals.requestId,
        });
        return;
      }

      // Do not finalize success here. Only platform-api owns the durable
      // chapter write, so it settles the hold in the same database transaction
      // as that write. Finalizing before the API persists would charge a user
      // for a result lost to a timeout, restart, or optimistic-lock conflict.

      // 返回结果（调用方 platform-api 是内部服务，可拿完整结果用于计费与状态管理）
      res.json({
        status: "ok",
        tool: toolName,
        result: resultForCaller,
        requestId: res.locals.requestId,
        // 任务令牌的 jobId/userId 供 platform-api 对账
        jobId: jobCtx.jobId,
        userId: jobCtx.userId,
        // 计费摘要——platform-api 据此更新任务进度与最终结算金额（分）
        metering: {
          modelCallCount: metering.modelCallCount,
          inputTokens: metering.inputTokens,
          outputTokens: metering.outputTokens,
          settledCount: metering.settledCount,
          alreadySettledCount: metering.alreadySettledCount,
          budgetExhaustedCount: metering.budgetExhaustedCount,
          totalSettledAmountFen: metering.totalSettledAmountFen,
          remainingBudgetFen: metering.remainingBudgetFen,
          settleErrorCount: metering.settleErrors.length,
          budgetExhausted: metering.budgetExhausted,
        },
      });
    } catch (err) {
      // 任务收尾：失败（未结算部分退回余额，hold 转 released）
      const failedJobId: string | undefined = res.locals.taskToken?.payload?.jobId;
      if (failedJobId) {
        try {
          const fin = await deps.billingClient.finalize(failedJobId, "failure");
          logger?.info(
            { jobId: failedJobId, holdStatus: fin.status },
            "billing hold finalized (failure)",
          );
        } catch (finalizeErr) {
          logger?.error(
            {
              jobId: failedJobId,
              err: finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr),
            },
            "billing finalize failed after failed invoke (hold left for ops reconcile)",
          );
        }
      }
      next(err);
    } finally {
      // 无论如何都清理临时 workspace
      // 成功：result 已含章节正文，platform-api 据此 SaveChapter；删除 temp 目录
      // 失败：直接删除 temp 目录，不污染正式存储
      if (materializedJobId) {
        try {
          deps.workspaceManager.cleanupWorkspace(materializedJobId);
        } catch {
          // cleanup 失败不阻断响应——workspace-manager 内部已记录日志
        }
      }
    }
  });

  router.get("/tools", (_req, res) => {
    // 列出可用工具名（仅供 platform-api 调试，不暴露 schema）
    res.json({
      tools: loadedTools.filterResult.allowed.map((t) => ({
        name: t.name,
        description: t.description?.slice(0, 200),
      })),
    });
  });

  return router;
}
