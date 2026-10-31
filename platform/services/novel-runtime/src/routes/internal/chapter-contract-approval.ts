/**
 * 宿主审批路由（EXPERT-HOST-APPROVAL-1）
 *
 * POST /internal/chapter-contract/approvals
 * Body: { userId, projectId, chapterNumber, proposalHash, approvedBy }
 * Header: x-internal-timestamp / x-internal-nonce / x-internal-signature（HMAC-SHA256）
 *
 * 唯一调用方是 platform-api（持有 INTERNAL_API_SECRET），且它必须先完成作者 JWT
 * 认证与项目归属校验。agent / 工具调用方触达不到本路由。
 *
 * 作用：用 (userId, projectId) 派生 workspaceId，签发给作者章节契约 commit 用的一次性
 * 凭证（进程内存，15 分钟、单次消费），再由 platform-api 把 receiptId 交回作者侧，
 * 用于 novel_workspace_manager 的 handoff_chapter_contract commit。
 *
 * 鉴权统一走 `createInternalRouteAuth`：验签通过后必须原子消费 nonce，同一份有效签名
 * 在窗口内第二次到达即 401 INTERNAL_AUTH_REPLAY（INTERNAL-NONCE-REPLAY-1）。
 */

import { Router } from "express";
import { z } from "zod";
import type * as pino from "pino";
import { createInternalRouteAuth, type InternalRouteAuth } from "../../internal-route-auth.js";
import { InternalNonceStore } from "../../internal-nonce-store.js";
import type { ChapterContractApprovalIssuer } from "../../host-approval.js";
import type { WorkspaceManager } from "../../workspace-manager.js";

const APPROVAL_BODY_SCHEMA = z.object({
  userId: z.union([z.string().min(1), z.number().int().positive()]),
  projectId: z.union([z.string().min(1), z.number().int().positive()]),
  chapterNumber: z.number().int().positive(),
  proposalHash: z.string().regex(/^[0-9a-f]{64}$/i, "proposalHash 必须是 sha256 hex"),
  /** 服务端从已认证作者取，不接受客户端自填（只作审计）。 */
  approvedBy: z.string().trim().min(1).max(200),
});

export interface ChapterContractApprovalRouterDeps {
  issuer: ChapterContractApprovalIssuer;
  workspaceManager: Pick<WorkspaceManager, "deriveWorkspaceId">;
  internalApiSecret: string;
  /** nonce 消费表；缺省时为本 router 实例私有的 5 分钟 TTL 表（测试可注入假时钟）。 */
  nonceStore?: InternalNonceStore;
  logger?: pino.Logger;
}

export function createChapterContractApprovalRouter(
  deps: ChapterContractApprovalRouterDeps,
): Router {
  const router = Router();
  const auth: InternalRouteAuth = createInternalRouteAuth({
    secret: deps.internalApiSecret,
    nonceStore: deps.nonceStore ?? new InternalNonceStore(),
    logger: deps.logger,
  });

  router.post(
    "/chapter-contract/approvals",
    (req, res, next) => auth.authorize(req, res, "chapter-contract-approval", next),
    (req, res) => {
      const parsed = APPROVAL_BODY_SCHEMA.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          code: "INVALID_BODY",
          message: "请求体格式错误",
          requestId: res.locals.requestId,
        });
        return;
      }

      const workspaceId = deps.workspaceManager.deriveWorkspaceId(
        parsed.data.userId,
        parsed.data.projectId,
      );
      let ticket;
      try {
        ticket = deps.issuer({
          workspaceId,
          chapterNumber: parsed.data.chapterNumber,
          proposalHash: parsed.data.proposalHash,
          approvedBy: parsed.data.approvedBy.trim(),
        });
      } catch (error: unknown) {
        deps.logger?.warn(
          {
            workspaceId,
            chapterNumber: parsed.data.chapterNumber,
            err: error instanceof Error ? error.message : String(error),
          },
          "chapter contract approval rejected by issuer",
        );
        res.status(400).json({
          code: "APPROVAL_REJECTED",
          message: error instanceof Error ? error.message : "签发审批凭证失败",
          requestId: res.locals.requestId,
        });
        return;
      }

      deps.logger?.info(
        {
          workspaceId,
          chapterNumber: parsed.data.chapterNumber,
          proposalHash: parsed.data.proposalHash,
          approvedBy: ticket.approvedBy,
          expiresAt: ticket.expiresAt,
        },
        "chapter contract approval receipt issued",
      );
      res.json({
        status: "ok",
        workspaceId,
        chapterNumber: parsed.data.chapterNumber,
        proposalHash: ticket.proposalHash,
        receiptId: ticket.receiptId,
        approvedBy: ticket.approvedBy,
        expiresAt: ticket.expiresAt,
        requestId: res.locals.requestId,
      });
    },
  );

  return router;
}
