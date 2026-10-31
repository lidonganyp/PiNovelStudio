/**
 * 内部 HMAC 路由统一鉴权（INTERNAL-NONCE-REPLAY-1）
 *
 * `/internal/*` 路由只允许 platform-api 调用。鉴权分三步：
 *   1. 三个签名头必须齐全；
 *   2. 签名覆盖完整请求路径（含 `/internal` 前缀）与 stableStringify(body)；
 *   3. 验签通过后必须在有 TTL 的表里原子消费 nonce，重复即重放。
 *
 * 抽成共享模块的原因：审批路由与 handoff 路由都是“验签 + 防重放 + 结构化 401”，
 * 任何一处漏掉 nonce 消费都会让同一份有效签名被重复使用。
 */

import type { NextFunction, Request, Response } from "express";
import type * as pino from "pino";
import { verifyInternalSignature } from "./internal-verify.js";
import { InternalNonceStore } from "./internal-nonce-store.js";

export interface InternalRouteAuthDeps {
  secret: string;
  nonceStore?: InternalNonceStore;
  logger?: pino.Logger;
}

/** 路由需要持有的鉴权依赖（nonce 表在 router 创建时固定，便于测试注入假时钟）。 */
export interface InternalRouteAuth {
  nonceStore: InternalNonceStore;
  authorize(req: Request, res: Response, label: string, next: NextFunction): void;
}

export function createInternalRouteAuth(deps: InternalRouteAuthDeps): InternalRouteAuth {
  const nonceStore = deps.nonceStore ?? new InternalNonceStore();

  return {
    nonceStore,
    authorize(req: Request, res: Response, label: string, next: NextFunction): void {
      const timestamp = req.header("x-internal-timestamp");
      const signature = req.header("x-internal-signature");
      const nonce = req.header("x-internal-nonce");
      if (!timestamp || !signature || !nonce) {
        res.status(401).json({
          code: "INTERNAL_AUTH_REQUIRED",
          message: "缺少内部签名",
          requestId: res.locals.requestId,
        });
        return;
      }

      // 签名覆盖完整请求路径（含 /internal 前缀），与 platform-api 签名侧一致。
      const path = (req.originalUrl ?? req.url).split("?")[0] ?? "";
      const verified = verifyInternalSignature({
        secret: deps.secret,
        timestamp,
        method: req.method,
        path,
        body: req.body,
        nonce,
        signature,
      });
      if (!verified.ok) {
        deps.logger?.warn(
          { reason: verified.reason, path, label },
          "internal request rejected: invalid signature",
        );
        res.status(401).json({
          code: "INTERNAL_AUTH_INVALID",
          message: "内部签名无效",
          requestId: res.locals.requestId,
        });
        return;
      }

      // 验签通过后必须消费 nonce：同一份有效签名在窗口内第二次到达即视为重放。
      if (!nonceStore.consume(nonce)) {
        deps.logger?.warn({ path, label }, "internal request rejected: replayed signature");
        res.status(401).json({
          code: "INTERNAL_AUTH_REPLAY",
          message: "内部签名已被使用（重放被拒绝）",
          requestId: res.locals.requestId,
        });
        return;
      }

      next();
    },
  };
}
