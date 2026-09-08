/**
 * novel-runtime config — 服务端环境配置（fail-closed，platform 版）
 *
 * R2 改造（platform 计划 §8.1）：
 * - 移除 sub2api 网关 env（SUB2API_INTERNAL_LLM_*）——新平台 PiNovelStudio 原生 provider 直连
 * - 回调目标改为 platform-api（PLATFORM_API_BASE_URL + INTERNAL_API_SECRET HMAC 签名）
 * - 任务令牌由 platform-api 签发（issuer=platform-api），与 runtime 共享 NOVEL_TASK_TOKEN_HMAC_KEY
 * - 默认路径面向容器卷（R7）：工作区 /var/lib/novel-runtime/workspaces，PiNovelStudio dist /app/novel-studio
 * - provider 直连密钥（GLM_API_KEY / CLAUDE_API_KEY / ARK_API_KEY 等）由容器 env 注入（默认），
 *   或 providerCredentialsSource=platform 时启动拉取（GET /internal/models/credentials）
 * - 所有配置仅来自服务端 env，不出现在前端构建产物；工作区配置与用户输入不得覆盖
 */

const REQUIRED_ENV = [
  "NOVEL_TASK_TOKEN_HMAC_KEY",
  "PLATFORM_API_BASE_URL",
  "INTERNAL_API_SECRET",
] as const;

export interface NovelRuntimeConfig {
  /** HTTP 监听地址（默认 0.0.0.0——容器内网互通；不映射宿主机端口，仅 compose 内网可达） */
  host: string;
  /** HTTP 监听端口（默认 3100） */
  port: number;
  /** platform-api 基础 URL（internal 回调：预占/结算/收尾/凭证/进度） */
  platformApiBaseUrl: string;
  /** 内部 API HMAC 密钥（与 platform-api INTERNAL_API_SECRET 一致） */
  internalApiSecret: string;
  /** 任务令牌 HMAC 密钥（platform-api 签发，runtime 校验，两侧一致） */
  novelTaskTokenHmacKey: string;
  /** Provider 凭证来源：env（容器注入直连密钥，默认）| platform（启动时从 internal API 拉取注入） */
  providerCredentialsSource: "env" | "platform";
  /** 单次 LLM 请求有界超时（毫秒，默认 300000，沿用主链路 PINOVEL_MODEL_REQUEST_TIMEOUT_MS） */
  llmRequestTimeoutMs: number;
  /** 整个 invoke 请求的有界超时，必须覆盖多阶段生成而不是使用 Node 的 5 分钟默认值。 */
  invokeRequestTimeoutMs: number;
  /** PiNovelStudio 编译产物路径（dist/index.js，Docker 构建时 COPY 进镜像） */
  novelStudioDistPath: string;
  /** PiNovelStudio 项目根（用于 workspace 物化；非生成类工具回退 root） */
  novelStudioProjectRoot: string;
  /** 临时 workspace 根目录（容器 volume 挂载点，R7） */
  tempWorkspaceRoot: string;
  /**
   * 失败归档根目录：生成失败时把临时 workspace（含 traces/）rename 到此处，
   * 避免 finally 无条件 cleanup 抹掉失败证据。空串时由 workspace-manager
   * derive 为 tempWorkspaceRoot 同级的 `novel-runtime-archive`。
   */
  workspaceArchiveRoot: string;
  /** Node 环境 */
  nodeEnv: "development" | "production" | "test";
  /** Provider env keys that must be present before production can serve work. */
  requiredProviderEnvKeys: string[];
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    throw new ConfigError(
      `FAIL_CLOSED: required env var ${key} is not set. Novel Runtime refuses to start.`,
      "MISSING_REQUIRED_ENV",
    );
  }
  return value.trim();
}

function optionalEnv(key: string, defaultValue: string): string {
  const value = process.env[key];
  return value && value.trim() !== "" ? value.trim() : defaultValue;
}

function optionalIntEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw || raw.trim() === "") return defaultValue;
  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new ConfigError(
      `Invalid integer for ${key}: ${raw}`,
      "INVALID_ENV",
    );
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ConfigError(
      `Invalid integer for ${key}: ${raw}`,
      "INVALID_ENV",
    );
  }
  return parsed;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * 加载配置。fail-closed：任何必填项缺失时抛出，拒绝启动。
 */
export function loadConfig(): NovelRuntimeConfig {
  // 校验必填项
  for (const key of REQUIRED_ENV) {
    requireEnv(key);
  }

  const platformApiBaseUrl = requireEnv("PLATFORM_API_BASE_URL");
  let parsedPlatformApiUrl: URL;
  try {
    parsedPlatformApiUrl = new URL(platformApiBaseUrl);
  } catch {
    throw new ConfigError(
      `Invalid URL for PLATFORM_API_BASE_URL: ${platformApiBaseUrl}`,
      "INVALID_ENV",
    );
  }
  if (parsedPlatformApiUrl.protocol !== "http:" && parsedPlatformApiUrl.protocol !== "https:") {
    throw new ConfigError(
      "PLATFORM_API_BASE_URL must use http or https",
      "INVALID_ENV",
    );
  }

  const nodeEnv = optionalEnv("NODE_ENV", "development") as NovelRuntimeConfig["nodeEnv"];
  if (nodeEnv !== "development" && nodeEnv !== "production" && nodeEnv !== "test") {
    throw new ConfigError(
      `Invalid NODE_ENV: ${nodeEnv}`,
      "INVALID_ENV",
    );
  }

  if (nodeEnv === "production" && process.env.PINOVEL_DEV_MODE === "1") {
    throw new ConfigError(
      "Production forbids PINOVEL_DEV_MODE=1; release governance must remain fail-closed.",
      "INVALID_ENV",
    );
  }

  const providerCredentialsSource = optionalEnv("NOVEL_PROVIDER_CREDENTIALS_SOURCE", "env");
  if (providerCredentialsSource !== "env" && providerCredentialsSource !== "platform") {
    throw new ConfigError(
      `Invalid NOVEL_PROVIDER_CREDENTIALS_SOURCE: ${providerCredentialsSource} (env | platform)`,
      "INVALID_ENV",
    );
  }
  const requiredProviderEnvKeys = optionalEnv(
    "NOVEL_REQUIRED_PROVIDER_KEYS",
    nodeEnv === "production" ? "GPT_API_KEY" : "",
  )
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  if (nodeEnv === "production" && requiredProviderEnvKeys.length === 0) {
    throw new ConfigError(
      "Production requires NOVEL_REQUIRED_PROVIDER_KEYS",
      "MISSING_PROVIDER_REQUIREMENTS",
    );
  }

  return {
    host: optionalEnv("NOVEL_RUNTIME_HOST", "0.0.0.0"),
    port: optionalIntEnv("NOVEL_RUNTIME_PORT", 3100),
    platformApiBaseUrl,
    internalApiSecret: requireEnv("INTERNAL_API_SECRET"),
    novelTaskTokenHmacKey: requireEnv("NOVEL_TASK_TOKEN_HMAC_KEY"),
    providerCredentialsSource,
    llmRequestTimeoutMs: optionalIntEnv("PINOVEL_MODEL_REQUEST_TIMEOUT_MS", 300000),
    invokeRequestTimeoutMs: optionalIntEnv("NOVEL_RUNTIME_REQUEST_TIMEOUT_MS", 900000),
    novelStudioDistPath: optionalEnv(
      "NOVEL_STUDIO_DIST_PATH",
      // 默认指向容器内镜像固化的 PiNovelStudio 编译产物（§8.2）
      "/app/novel-studio/dist/index.js",
    ),
    novelStudioProjectRoot: optionalEnv(
      "NOVEL_STUDIO_PROJECT_ROOT",
      "/app/novel-studio",
    ),
    tempWorkspaceRoot: optionalEnv(
      "NOVEL_TEMP_WORKSPACE_ROOT",
      "/var/lib/novel-runtime/workspaces",
    ),
    workspaceArchiveRoot: optionalEnv("NOVEL_WORKSPACE_ARCHIVE_ROOT", ""),
    nodeEnv,
    requiredProviderEnvKeys,
  };
}

/**
 * Bind G6 governance to the real novel-studio tree, not the per-job temp
 * workspace. Local development also opts into PINOVEL_DEV_MODE so a missing
 * production pointer cannot hard-block chat chapter generation.
 */
export function applyRuntimeGovernanceEnv(config: NovelRuntimeConfig): void {
  if (!process.env.PINOVEL_FINGERPRINT_ROOT || process.env.PINOVEL_FINGERPRINT_ROOT.trim() === "") {
    process.env.PINOVEL_FINGERPRINT_ROOT = config.novelStudioProjectRoot;
  }
  if (config.nodeEnv === "development" && process.env.PINOVEL_DEV_MODE !== "0") {
    process.env.PINOVEL_DEV_MODE = "1";
  }
}

/** Validate credentials after env/platform injection, before opening HTTP. */
export function assertRequiredProviderCredentials(config: NovelRuntimeConfig): void {
  if (config.nodeEnv !== "production") return;
  const missing = config.requiredProviderEnvKeys.filter(
    (key) => !process.env[key] || process.env[key]?.trim() === "",
  );
  if (missing.length > 0) {
    throw new ConfigError(
      `Production provider credentials missing: ${missing.join(", ")}`,
      "MISSING_PROVIDER_CREDENTIAL",
    );
  }
}

/**
 * 仅供测试用的工厂：传入显式值构造配置，不走 env。
 */
export function makeConfigForTest(overrides: Partial<NovelRuntimeConfig> = {}): NovelRuntimeConfig {
  return {
    host: "127.0.0.1",
    port: 3100,
    platformApiBaseUrl: "http://platform-api.local",
    internalApiSecret: "test-internal-api-secret",
    novelTaskTokenHmacKey: "test-hmac-key",
    providerCredentialsSource: "env",
    llmRequestTimeoutMs: 300000,
    invokeRequestTimeoutMs: 900000,
    novelStudioDistPath: "/app/novel-studio/dist/index.js",
    novelStudioProjectRoot: "/app/novel-studio",
    tempWorkspaceRoot: "./.tmp/test-workspaces",
    workspaceArchiveRoot: "",
    nodeEnv: "test",
    requiredProviderEnvKeys: [],
    ...overrides,
  };
}
