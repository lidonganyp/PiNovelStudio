/**
 * 任务令牌认证中间件（plan §2 T2-2）
 *
 * 从请求头 X-Novel-Task-Token 提取令牌，验证签名、过期、nonce、capabilities。
 * 验证通过后将 payload 写入 res.locals.taskToken，供后续路由使用。
 */

import type { NextFunction, Request, Response } from "express";
import { verifyTaskToken } from "../task-token.js";
import type { NovelRuntimeConfig } from "../config.js";

/** 工具名 → 所需 capability 映射 */
const TOOL_CAPABILITY_MAP: Record<string, string> = {
  novel_generate_chapter: "novel.generate",
  novel_preflight_workspace: "novel.access",
  novel_workspace_manager: "novel.access",
  novel_plan_story_outline: "novel.outline.edit",
  novel_strategy_policy_view: "novel.access",
  novel_strategy_feedback: "novel.feedback",
};

export function createTaskTokenAuthMiddleware(config: NovelRuntimeConfig) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    res.locals.requestId = req.headers["x-request-id"] as string | undefined ?? `rt-${Date.now()}`;

    // 健康检查与工具列表路由跳过认证
    // This middleware is mounted at `/v1`, so Express exposes `/v1/tools` as
    // `/tools` here. Keep the full-path form for direct/test mounting too.
    const isPublicHealth = req.method === "GET" && req.path === "/healthz";
    const isPublicTools = req.method === "GET" && (req.path === "/tools" || req.path === "/v1/tools");
    if (isPublicHealth || isPublicTools) {
      next();
      return;
    }

    const authHeader = req.headers["x-novel-task-token"] as string | undefined;
    if (!authHeader) {
      res.status(401).json({
        code: "MISSING_TOKEN",
        message: "缺少任务令牌",
        requestId: res.locals.requestId,
      });
      return;
    }

    // 工具名从路径或 body 提取
    const toolName = (req.body as { tool?: string } | undefined)?.tool ??
      (req.params as { toolName?: string })?.toolName;
    const requiredCapability = toolName ? TOOL_CAPABILITY_MAP[toolName] : undefined;
    if (!requiredCapability) {
      res.status(400).json({
        code: "UNKNOWN_TOOL",
        message: "未知工具或未指定工具",
        requestId: res.locals.requestId,
      });
      return;
    }

    try {
      const verified = await verifyTaskToken(authHeader, config, requiredCapability);
      res.locals.taskToken = verified;
      next();
    } catch (err) {
      const { normalizeError } = await import("./error-handler.js");
      const appError = normalizeError(err);
      res.status(appError.statusCode).json({
        code: appError.code,
        message: appError.message,
        requestId: res.locals.requestId,
      });
    }
  };
}
