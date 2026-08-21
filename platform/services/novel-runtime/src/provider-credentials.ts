/**
 * Provider 凭证客户端（R4 改造，替代原 sub2api 网关 llm-client）
 *
 * 新架构（platform 计划 §4.4）：PiNovelStudio 原生 provider 直连，不经任何网关。
 * 原网关代理客户端（强制 SUB2API_INTERNAL_LLM_BASE_URL 单一出口）已删除。
 *
 * 凭证来源二选一（config.providerCredentialsSource，默认 env）：
 * - env：容器 env 直接注入直连密钥（GLM_API_KEY / CLAUDE_API_KEY / ARK_API_KEY 等，
 *   与主仓库 .env 同名同义）——零网络依赖，默认模式
 * - platform：启动时从 platform-api 拉取（GET /internal/models/credentials，HMAC 签名），
 *   注入 process.env 供 PiNovelStudio 读取（runtime 与 PiNovelStudio dist 同进程）
 *
 * 原llm-client的「出口白名单/计量头/METERING_MISSING」逻辑随网关角色一并移除：
 * 计量改由 metering-binder 从 PiNovelStudio stageResults.modelCalls 取数上报。
 */

import { request } from "undici";
import type { NovelRuntimeConfig } from "./config.js";
import { internalAuthHeaders } from "./internal-hmac.js";

/** 内部凭证下发条目（对齐 platform-api rates.listEnabledCredentials） */
export interface ProviderCredential {
  providerKey: string;
  apiKey: string;
  apiBaseUrl?: string;
}

/** providerKey → PiNovelStudio 直连 env 名映射（与主仓库 utils/config.ts 读取的变量同名同义） */
const PROVIDER_ENV_KEY_MAP: Record<string, { key: string; baseUrlKey?: string }> = {
  glm: { key: "GLM_API_KEY", baseUrlKey: "GLM_BASE_URL" },
  claude: { key: "CLAUDE_API_KEY", baseUrlKey: "CLAUDE_BASE_URL" },
  ark: { key: "ARK_API_KEY", baseUrlKey: "ARK_BASE_URL" },
  doubao: { key: "ARK_API_KEY", baseUrlKey: "ARK_BASE_URL" },
  gemini: { key: "GEMINI_API_KEY", baseUrlKey: "GOOGLE_GEMINI_BASE_URL" },
  gpt: { key: "GPT_API_KEY", baseUrlKey: "GPT_BASE_URL" },
};

export function resolveProviderEnvMapping(
  providerKey: string,
): { key: string; baseUrlKey?: string } | undefined {
  const lower = providerKey.toLowerCase();
  if (PROVIDER_ENV_KEY_MAP[lower]) return PROVIDER_ENV_KEY_MAP[lower];
  if (lower.includes("gemini") || lower.includes("aimagic")) return PROVIDER_ENV_KEY_MAP.gemini;
  if (lower.includes("gpt") || lower.includes("openai")) return PROVIDER_ENV_KEY_MAP.gpt;
  if (lower.includes("claude") || lower.includes("anthropic")) return PROVIDER_ENV_KEY_MAP.claude;
  if (lower.includes("glm")) return PROVIDER_ENV_KEY_MAP.glm;
  if (lower.includes("ark") || lower.includes("doubao")) return PROVIDER_ENV_KEY_MAP.ark;
  return undefined;
}

export class ProviderCredentialsError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "FETCH_FAILED"
      | "INVALID_RESPONSE",
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = "ProviderCredentialsError";
  }
}

export interface ProviderCredentialsClient {
  /** 拉取启用 Provider 的解密凭证（仅 providerCredentialsSource=platform 时调用） */
  fetchCredentials(): Promise<ProviderCredential[]>;
  /** 将凭证注入 process.env（已存在的 env 不覆盖——容器 env 优先，fail-safe） */
  injectIntoEnv(credentials: ProviderCredential[]): { injected: string[]; skipped: string[] };
}

export function createProviderCredentialsClient(
  config: NovelRuntimeConfig,
  options: { timeoutMs?: number } = {},
): ProviderCredentialsClient {
  const timeoutMs = options.timeoutMs ?? config.llmRequestTimeoutMs;

  return {
    async fetchCredentials(): Promise<ProviderCredential[]> {
      const path = "/internal/models/credentials";
      const url = `${config.platformApiBaseUrl.replace(/\/$/, "")}${path}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers = internalAuthHeaders({
          secret: config.internalApiSecret,
          method: "GET",
          path,
          body: "",
        });
        const response = await request(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            ...headers,
          },
          signal: controller.signal,
        });
        if (response.statusCode >= 400) {
          const errBody = await response.body.text().catch(() => "");
          throw new ProviderCredentialsError(
            `FETCH_FAILED: ${response.statusCode} from ${path}: ${errBody.slice(0, 300)}`,
            "FETCH_FAILED",
            response.statusCode,
          );
        }
        const text = await response.body.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new ProviderCredentialsError(
            `INVALID_RESPONSE: non-JSON credentials response: ${text.slice(0, 300)}`,
            "INVALID_RESPONSE",
          );
        }
        const providers = (parsed as { providers?: unknown }).providers;
        if (!Array.isArray(providers)) {
          throw new ProviderCredentialsError(
            "INVALID_RESPONSE: credentials response missing providers array",
            "INVALID_RESPONSE",
          );
        }
        return providers.filter(
          (item): item is ProviderCredential =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as ProviderCredential).providerKey === "string" &&
            typeof (item as ProviderCredential).apiKey === "string",
        );
      } catch (err: unknown) {
        if (err instanceof ProviderCredentialsError) throw err;
        if (err instanceof Error && err.name === "AbortError") {
          throw new ProviderCredentialsError(
            `FETCH_FAILED: credentials fetch exceeded ${timeoutMs}ms`,
            "FETCH_FAILED",
            504,
          );
        }
        throw new ProviderCredentialsError(
          `FETCH_FAILED: ${err instanceof Error ? err.message : String(err)}`,
          "FETCH_FAILED",
        );
      } finally {
        clearTimeout(timer);
      }
    },

    injectIntoEnv(credentials: ProviderCredential[]): { injected: string[]; skipped: string[] } {
      const injected: string[] = [];
      const skipped: string[] = [];
      for (const cred of credentials) {
        const mapping = resolveProviderEnvMapping(cred.providerKey);
        if (!mapping) {
          skipped.push(cred.providerKey);
          continue;
        }
        // env 模式：容器已注入的直连密钥优先。platform 模式：以后台配置为准。
        if (process.env[mapping.key] && config.providerCredentialsSource !== "platform") {
          skipped.push(mapping.key);
          continue;
        }
        process.env[mapping.key] = cred.apiKey;
        if (cred.apiBaseUrl && mapping.baseUrlKey && !process.env[mapping.baseUrlKey]) {
          process.env[mapping.baseUrlKey] = cred.apiBaseUrl;
        }
        injected.push(mapping.key);
      }
      return { injected, skipped };
    },
  };
}
