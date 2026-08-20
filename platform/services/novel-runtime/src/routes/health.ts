/**
 * 健康检查路由
 *
 * 返回服务状态与白名单工具列表（不返回密钥、URL、内部配置）。
 */

import { Router } from "express";
import type { LoadedTools } from "../extension-loader.js";

export function createHealthRouter(loadedTools: LoadedTools): Router {
  const router = Router();

  router.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      service: "novel-runtime",
      tools: loadedTools.filterResult.allowed.map((t) => t.name),
      toolCount: loadedTools.filterResult.allowed.length,
      distPath: loadedTools.distPath,
      // 不暴露任何密钥、URL、Provider 信息
    });
  });

  return router;
}
