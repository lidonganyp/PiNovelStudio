/**
 * Novel Runtime — HTTP 服务入口（platform 版，R7 改造）
 *
 * 加载流程（fail closed on any error）：
 * 1. loadConfig() — 校验必填 env（NOVEL_TASK_TOKEN_HMAC_KEY / PLATFORM_API_BASE_URL / INTERNAL_API_SECRET）
 * 2. loadNovelStudioExtension() — 加载 PiNovelStudio dist，捕获 6 工具，白名单过滤
 * 3. provider 凭证 — providerCredentialsSource=env（默认，容器注入直连密钥）
 *    或 platform（启动时 GET /internal/models/credentials 拉取并注入 process.env）
 * 4. createBillingClient() — platform-api 内部计费客户端（HMAC 签名，逐调用结算 + 收尾）
 * 5. loadPricingTable() — 可选本地诊断费率表（仅日志粗估，权威金额归 platform-api）
 * 6. createMeteringBinder() — 包装 tool.invoke 实现事后结算
 * 7. 启动 HTTP 服务（默认 0.0.0.0:3100，仅 compose 内网可达，不映射宿主机端口）
 *
 * 内部 API：
 * - GET  /healthz        — 健康检查（无认证）
 * - GET  /v1/tools       — 工具列表（无认证，仅供 platform-api 调试）
 * - POST /v1/invoke      — 调用工具（需 X-Novel-Task-Token）
 */

import express from "express";
import pino from "pino";
import { assertRequiredProviderCredentials, loadConfig, ConfigError } from "./config.js";
import { loadNovelStudioExtension, ExtensionLoadError } from "./extension-loader.js";
import {
  createProviderCredentialsClient,
  ProviderCredentialsError,
} from "./provider-credentials.js";
import { createBillingClient } from "./billing-client.js";
import { loadPricingTable, PricingTableError } from "./pricing-table.js";
import { createMeteringBinder } from "./metering-binder.js";
import { createWorkspaceManager } from "./workspace-manager.js";
import { createTaskTokenAuthMiddleware } from "./middleware/task-token-auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { createHealthRouter } from "./routes/health.js";
import { createInvokeRouter } from "./routes/v1/invoke.js";
import type { LoadedTools } from "./extension-loader.js";

async function main(): Promise<void> {
  const logger = pino({ name: "novel-runtime", level: process.env.LOG_LEVEL ?? "info" });

  // ── 1. 加载配置（fail closed） ──────────────────────────────────
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.fatal({ code: err.code }, "config load failed (fail closed)");
    }
    throw err;
  }
  logger.info({ host: config.host, port: config.port, nodeEnv: config.nodeEnv }, "config loaded");

  // ── 2. 加载 PiNovelStudio 扩展（fail closed） ───────────────────
  let loadedTools: LoadedTools;
  try {
    loadedTools = await loadNovelStudioExtension(config);
  } catch (err) {
    if (err instanceof ExtensionLoadError) {
      logger.fatal({ code: err.code, distPath: config.novelStudioDistPath }, "extension load failed (fail closed)");
    }
    throw err;
  }
  logger.info(
    {
      toolCount: loadedTools.filterResult.allowed.length,
      droppedCount: loadedTools.filterResult.dropped.length,
      forbiddenCount: loadedTools.filterResult.forbidden.length,
      tools: loadedTools.filterResult.allowed.map((t) => t.name),
    },
    "PiNovelStudio extension loaded (6-tool whitelist enforced)",
  );

  // ── 3. Provider 凭证（R4：PiNovelStudio 原生 provider 直连） ────
  // env 模式（默认）：容器 env 已注入直连密钥（GLM_API_KEY 等），零网络依赖。
  // platform 模式：启动时从 platform-api 拉取启用 Provider 的解密凭证并注入
  // process.env（已存在的 env 不覆盖——容器注入优先，fail-safe）。
  if (config.providerCredentialsSource === "platform") {
    const credentialsClient = createProviderCredentialsClient(config);
    try {
      const credentials = await credentialsClient.fetchCredentials();
      const { injected, skipped } = credentialsClient.injectIntoEnv(credentials);
      logger.info(
        { injected, skipped, providerCount: credentials.length },
        "provider credentials fetched from platform-api and injected into env",
      );
    } catch (err) {
      if (err instanceof ProviderCredentialsError) {
        logger.fatal(
          { code: err.code, statusCode: err.statusCode },
          "provider credentials fetch failed (fail closed)",
        );
      }
      throw err;
    }
  } else {
    logger.info(
      "provider credentials from container env (direct provider access, no fetch)",
    );
  }
  try {
    assertRequiredProviderCredentials(config);
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.fatal({ code: err.code }, "provider credential validation failed (fail closed)");
    }
    throw err;
  }

  // ── 4. 创建计费客户端（platform-api /internal/billing/*） ───────
  const billingClient = createBillingClient(config, {
    maxRetries: 2,
    timeoutMs: config.llmRequestTimeoutMs,
  });
  logger.info(
    { platformApiBaseUrl: maskUrl(config.platformApiBaseUrl) },
    "billing client initialized (settle + finalize wired into invoke path)",
  );

  // ── 5. 加载诊断费率表（可选；权威金额由 platform-api 计算） ────
  let pricingTable;
  try {
    pricingTable = loadPricingTable(
      process.env.NOVEL_RUNTIME_PRICING_TABLE_PATH,
      logger,
    );
  } catch (err) {
    if (err instanceof PricingTableError) {
      logger.fatal({ code: err.code }, "pricing table load failed (fail closed)");
    }
    throw err;
  }
  logger.info(
    { providerCount: Object.keys(pricingTable.providers).length },
    "diagnostic pricing table loaded (log-level estimate only; authoritative amounts come from platform-api)",
  );

  // ── 6. 创建 metering binder（事后结算） ─────────────────────────
  const meteringBinder = createMeteringBinder({
    billingClient,
    pricingTable,
    logger,
  });
  logger.info("metering binder initialized (per-model-call settle wired into invoke)");

  // ── 7. 创建 workspace manager（多租户隔离） ─────────────────────
  const workspaceManager = createWorkspaceManager({
    tempWorkspaceRoot: config.tempWorkspaceRoot,
    logger,
  });
  logger.info(
    { tempWorkspaceRoot: workspaceManager._rootPath() },
    "workspace manager initialized (per-job temp workspace + materialize/cleanup)",
  );

  // ── 8. 启动 HTTP 服务 ──────────────────────────────────────────
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  // 请求 ID 注入
  app.use((req, res, next) => {
    res.locals.requestId = (req.headers["x-request-id"] as string | undefined) ??
      `rt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    next();
  });

  // 路由
  app.use(createHealthRouter(loadedTools));
  app.use(
    "/v1",
    createTaskTokenAuthMiddleware(config),
    createInvokeRouter(loadedTools, { billingClient, meteringBinder, workspaceManager, config, logger }),
  );

  // 全局错误处理
  app.use(errorHandler);

  const server = app.listen(config.port, config.host, () => {
    logger.info({ host: config.host, port: config.port }, "Novel Runtime listening (compose-internal only)");
  });
  // Node's default request timeout is five minutes, shorter than a legitimate
  // multi-stage chapter generation. Keep the server boundary explicit and in
  // sync with platform-api's client timeout instead of allowing an implicit
  // socket close to decide job outcome.
  server.requestTimeout = config.invokeRequestTimeoutMs;
  server.headersTimeout = Math.min(60_000, config.invokeRequestTimeoutMs);

  // 优雅关闭
  const shutdown = (signal: string): void => {
    logger.info({ signal }, "shutting down...");
    server.close(() => {
      logger.info("closed");
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

/** 脱敏 URL：保留 host，掩盖 path */
function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/***`;
  } catch {
    return "***";
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("FATAL: novel-runtime failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
