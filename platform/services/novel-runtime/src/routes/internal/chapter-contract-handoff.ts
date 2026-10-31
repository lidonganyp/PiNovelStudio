/**
 * 章纲契约 handoff 路由（EXPERT-HOST-HANDOFF-1 / 作者侧审批闭环）
 *
 * POST /internal/chapter-contract/handoff
 *
 * 唯一调用方是 platform-api（持有 INTERNAL_API_SECRET），且它必须先完成作者 JWT
 * 认证、项目归属校验与投影编辑。本路由把提案文本送进 `novel_workspace_manager`
 * 的 `handoff_chapter_contract` 子操作：
 *   - mode="preview"：只校验并返回规范化后的章纲文本与 proposalHash，不写盘；
 *   - mode="commit"：必须携带宿主审批层签发的一次性 `approvalReceipt`，原子写入
 *     临时 workspace 的 `series/ch{N}-outline-explicit.md` 并落 provenance。
 *
 * 为什么用独立 `/internal` 路由而不是复用 `/v1/invoke`：
 * - `/v1/invoke` 对非生成类工具使用真实项目根目录（`novelStudioProjectRoot`），
 *   会让 commit 写入生产 workspace；本路由只在临时 workspace 内落盘，读完即清理。
 * - 内部端点只接受 platform-api 的 HMAC 签名，agent/工具调用方触达不到。
 *
 * 临时 workspace 只用于“把提案变成可校验的章纲文本与 provenance”；平台侧随后把
 * `outlineMarkdown` 与 `provenance` 持久化为项目文档，生成链路再物化回 workspace。
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Router } from "express";
import { z } from "zod";
import type * as pino from "pino";
import { createInternalRouteAuth, type InternalRouteAuth } from "../../internal-route-auth.js";
import { InternalNonceStore } from "../../internal-nonce-store.js";
import type { LoadedTools } from "../../extension-loader.js";
import type { WorkspaceManager } from "../../workspace-manager.js";

const WORKSPACE_DOCUMENT_TYPE_SCHEMA = z.enum([
  "creative_constitution",
  "worldbuilding",
  "character_profile",
  "story_outline",
  "story_outline_full",
  "style_profile",
  "chapter_seed",
  "explicit_outline",
  "chapter_contract_provenance",
  "narrative_state",
]);

const HANDOFF_BODY_SCHEMA = z.object({
  userId: z.union([z.string().min(1), z.number().int().positive()]),
  projectId: z.union([z.string().min(1), z.number().int().positive()]),
  chapterNumber: z.number().int().positive(),
  mode: z.enum(["preview", "commit"]),
  /** 作者在 web 端编辑/粘贴的专家契约提案 Markdown。 */
  proposalText: z.string().min(1),
  expertRole: z.string().optional(),
  knownFactIds: z.array(z.string()).optional(),
  knownPromiseIds: z.array(z.string()).optional(),
  projectConfig: z
    .object({
      genre: z.string(),
      subGenres: z.array(z.string()).optional(),
      worldKeyTerms: z.array(z.string()).optional(),
      characters: z
        .array(
          z.object({
            name: z.string(),
            role: z.string().optional(),
            description: z.string().optional(),
          }),
        )
        .optional(),
      extra: z.record(z.unknown()).optional(),
    })
    .default({ genre: "未指定" }),
  documents: z
    .array(z.object({ type: WORKSPACE_DOCUMENT_TYPE_SCHEMA, content: z.string() }))
    .default([]),
  confirmedBy: z.string().optional(),
  approvalReceipt: z.string().optional(),
  confirm: z.boolean().optional(),
  overwrite: z.boolean().optional(),
});

export interface ChapterContractHandoffRouterDeps {
  loadedTools: LoadedTools;
  workspaceManager: WorkspaceManager;
  internalApiSecret: string;
  nonceStore?: InternalNonceStore;
  logger?: pino.Logger;
}

interface HandoffToolResult {
  status?: string;
  error?: string;
  expertHandoff?: {
    status?: string;
    error?: string;
    handoffMode?: string;
    chapterNumber?: number;
    outlineMarkdown?: string;
    proposalHash?: string;
    targetPath?: string;
    provenancePath?: string;
    validation?: unknown;
    wrote?: boolean;
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function createChapterContractHandoffRouter(
  deps: ChapterContractHandoffRouterDeps,
): Router {
  const router = Router();
  const auth: InternalRouteAuth = createInternalRouteAuth({
    secret: deps.internalApiSecret,
    nonceStore: deps.nonceStore ?? new InternalNonceStore(),
    logger: deps.logger,
  });

  router.post(
    "/chapter-contract/handoff",
    (req, res, next) => auth.authorize(req, res, "chapter-contract-handoff", next),
    async (req, res) => {
      const parsed = HANDOFF_BODY_SCHEMA.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          code: "INVALID_BODY",
          message: "请求体格式错误",
          issues: parsed.error.issues.map((issue) => issue.path.join(".")),
          requestId: res.locals.requestId,
        });
        return;
      }
      const body = parsed.data;
      const workspaceId = deps.workspaceManager.deriveWorkspaceId(body.userId, body.projectId);
      const tool = deps.loadedTools.byName.get("novel_workspace_manager");
      if (!tool || typeof tool.invoke !== "function") {
        res.status(500).json({
          code: "HANDOFF_TOOL_UNAVAILABLE",
          message: "novel_workspace_manager 不可调用",
          requestId: res.locals.requestId,
        });
        return;
      }

      const jobId = `handoff-${randomUUID()}`;
      let tempProjectRoot: string;
      let workspacePath: string;
      try {
        const materialized = deps.workspaceManager.materializeWorkspace({
          jobId,
          workspaceId,
          projectConfig: body.projectConfig,
          documents: body.documents,
          chapterNumber: body.chapterNumber,
        });
        tempProjectRoot = materialized.tempProjectRoot;
        workspacePath = materialized.workspacePath;
      } catch (error: unknown) {
        deps.logger?.error(
          { jobId, workspaceId, err: error instanceof Error ? error.message : String(error) },
          "chapter contract handoff: workspace materialization failed",
        );
        res.status(500).json({
          code: "HANDOFF_MATERIALIZE_FAILED",
          message: error instanceof Error ? error.message : "临时 workspace 创建失败",
          requestId: res.locals.requestId,
        });
        return;
      }

      try {
        const toolInput: Record<string, unknown> = {
          action: "handoff_chapter_contract",
          workspaceId,
          chapterNumber: body.chapterNumber,
          proposalText: body.proposalText,
          handoffMode: body.mode,
          expertRole: body.expertRole,
          knownFactIds: body.knownFactIds,
          knownPromiseIds: body.knownPromiseIds,
          confirmedBy: body.confirmedBy,
          approvalReceipt: body.approvalReceipt,
          confirm: body.confirm,
          overwrite: body.overwrite,
          _projectRoot: tempProjectRoot,
        };

        let raw: unknown;
        try {
          raw = await tool.invoke(toolInput);
        } catch (error: unknown) {
          deps.logger?.error(
            { jobId, workspaceId, err: error instanceof Error ? error.message : String(error) },
            "chapter contract handoff: tool invocation failed",
          );
          res.status(500).json({
            code: "HANDOFF_INVOKE_FAILED",
            message: error instanceof Error ? error.message : "handoff 工具调用失败",
            requestId: res.locals.requestId,
          });
          return;
        }

        const result = (raw ?? {}) as HandoffToolResult;
        const handoff = result.expertHandoff;
        if (!handoff) {
          res.status(500).json({
            code: "HANDOFF_INVOKE_FAILED",
            message: result.error ?? "handoff 未返回结构化结果",
            requestId: res.locals.requestId,
          });
          return;
        }
        if (handoff.status === "blocked") {
          res.status(400).json({
            code: "HANDOFF_BLOCKED",
            message: handoff.error ?? "handoff 被阻断",
            mode: body.mode,
            chapterNumber: body.chapterNumber,
            validation: handoff.validation,
            requestId: res.locals.requestId,
          });
          return;
        }
        if (handoff.status !== "ok") {
          res.status(400).json({
            code: "HANDOFF_REJECTED",
            message: handoff.error ?? "handoff 被拒绝",
            mode: body.mode,
            chapterNumber: body.chapterNumber,
            validation: handoff.validation,
            requestId: res.locals.requestId,
          });
          return;
        }

        if (body.mode === "preview") {
          res.json({
            status: "ok",
            mode: "preview",
            workspaceId,
            chapterNumber: body.chapterNumber,
            proposalHash: handoff.proposalHash,
            outlineMarkdown: handoff.outlineMarkdown,
            targetPath: handoff.targetPath,
            validation: handoff.validation,
            approvalRequired: {
              proposalHash: handoff.proposalHash,
              issuer: "trusted_host",
            },
            requestId: res.locals.requestId,
          });
          return;
        }

        // commit：以落盘结果为准（而不是只看工具返回值），并核对 hash 与 provenance。
        // 路径必须固定：工具返回的 targetPath 只作为一致性校验，绝不拼接进文件系统，
        // 否则 ../ 一类的异常值会读到 workspace 之外的文件。
        const expectedTarget = `series/ch${body.chapterNumber}-outline-explicit.md`;
        if (handoff.targetPath && handoff.targetPath !== expectedTarget) {
          res.status(500).json({
            code: "HANDOFF_INVALID_TARGET",
            message: "handoff 返回了非预期的章纲路径，已拒绝读取",
            requestId: res.locals.requestId,
          });
          return;
        }
        const workspaceRoot = resolve(workspacePath);
        const outlineFile = resolve(workspaceRoot, expectedTarget);
        const relativeTarget = relative(workspaceRoot, outlineFile);
        if (
          relativeTarget.length === 0 ||
          relativeTarget.startsWith("..") ||
          isAbsolute(relativeTarget)
        ) {
          res.status(500).json({
            code: "HANDOFF_INVALID_TARGET",
            message: "章纲路径越出临时 workspace，已拒绝读取",
            requestId: res.locals.requestId,
          });
          return;
        }
        const provenanceFile = `${outlineFile}.provenance.json`;
        if (!existsSync(outlineFile) || !existsSync(provenanceFile)) {
          res.status(500).json({
            code: "HANDOFF_STATE_INCONSISTENT",
            message: "commit 成功但章纲或 provenance 文件缺失",
            requestId: res.locals.requestId,
          });
          return;
        }
        let outlineMarkdown: string;
        let provenance: unknown;
        try {
          outlineMarkdown = readFileSync(outlineFile, "utf8");
          provenance = JSON.parse(readFileSync(provenanceFile, "utf8")) as unknown;
        } catch (error: unknown) {
          res.status(500).json({
            code: "HANDOFF_STATE_INCONSISTENT",
            message: error instanceof Error ? error.message : "章纲或 provenance 不可读",
            requestId: res.locals.requestId,
          });
          return;
        }
        const proposalHash = sha256(outlineMarkdown);
        if (proposalHash !== handoff.proposalHash) {
          res.status(500).json({
            code: "HANDOFF_STATE_INCONSISTENT",
            message: "落盘章纲的 hash 与工具返回的 proposalHash 不一致",
            requestId: res.locals.requestId,
          });
          return;
        }

        deps.logger?.info(
          {
            workspaceId,
            chapterNumber: body.chapterNumber,
            proposalHash,
            approvedBy: (provenance as { approval?: { approvedBy?: string } }).approval?.approvedBy,
          },
          "chapter contract handoff committed (temporary workspace)",
        );
        res.json({
          status: "ok",
          mode: "commit",
          workspaceId,
          chapterNumber: body.chapterNumber,
          proposalHash,
          outlineMarkdown,
          targetPath: relativeTarget,
          provenancePath: `${relativeTarget}.provenance.json`,
          validation: handoff.validation,
          provenance,
          requestId: res.locals.requestId,
        });
      } finally {
        deps.workspaceManager.cleanupWorkspace(jobId);
      }
    },
  );

  return router;
}
