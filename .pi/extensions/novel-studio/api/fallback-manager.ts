/**
 * PiNovelStudio API fallback manager.
 *
 * The public methods keep the historical wrapper shapes, while provider,
 * model, base URL, protocol, and API key all resolve through model-routing.json
 * plus .env overrides.
 */

import {
  getApiKey,
  getBaseUrl,
  getModelOverride,
  isProviderDisabled,
  loadGlobalConfig,
  type AgentRoutingEntry,
  type ProviderConfig,
  type ProviderProtocol,
  type ProviderRequestOptions,
} from "../utils/config.js";
import { localizeLlmMessages, localizeLlmText } from "../utils/llm-language-guard.js";
import type { ClaudeMessage } from "./claude.js";
import type { GLMMessage, GLMResponse } from "./glm.js";
import type { GPTMessage } from "./gpt.js";
import { fetchWithTimeout } from "./request-timeout.js";
import { parseAnthropicResponse } from "./anthropic-stream.js";
import { parseOpenAIStream } from "./openai-stream.js";
import { createHash, randomUUID } from "node:crypto";
import {
  assertProviderAuthorized,
  filterFallbackChainByProfile,
  shouldDisableFallbackForProfile,
} from "./benchmark-cost-profile.js";

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  totalTimeoutMs?: number;
}

export interface FallbackLogEntry {
  timestamp: string;
  agentName: string;
  primaryProvider: string;
  fallbackProvider: string;
  error: string;
  attempt: number;
  maxRetries: number;
  retryCount: number;
}

export interface FallbackResult {
  response: GLMResponse;
  usedProvider: string;
  usedModel: string;
  retryCount: number;
  fellBack: boolean;
  logs: FallbackLogEntry[];
}

export interface ClaudeFallbackResult {
  response: {
    content: Array<{ type: string; text?: string }>;
    stop_reason: string;
  };
  usedProvider: string;
  usedModel: string;
  retryCount: number;
  fellBack: boolean;
  logs: FallbackLogEntry[];
}

export interface GPTFallbackResult {
  response: {
    content: string;
    finish_reason: string;
  };
  usedProvider: string;
  usedModel: string;
  retryCount: number;
  fellBack: boolean;
  logs: FallbackLogEntry[];
}

type RouteConfig = string | AgentRoutingEntry | undefined;

type ChatCallOptions = {
  temperature?: number;
  max_tokens?: number;
  thinking?: ProviderRequestOptions["thinking"];
  timeoutMs?: number;
  stream?: boolean;
  /** 采样种子（受控复现实验）。仅透传给支持 seed 的 OpenAI 兼容协议；不支持则调用方标记 unsupported。 */
  seed?: number;
};

function supportsSamplingParameters(providerKey: string, model: string): boolean {
  const normalizedProvider = providerKey.toLowerCase();
  if (normalizedProvider === "claude" || normalizedProvider === "claude_backup") {
    return false;
  }
  return !/^claude(?:[-_]|$)/i.test(model);
}

/**
 * 判断是否向 OpenAI 兼容请求透传 seed 采样种子。
 *
 * seed 仅对支持该参数的 OpenAI 兼容 provider 生效（如 glm / doubao / openai /
 * 其他 OpenAI 兼容端点）。Claude 协议不支持 seed，须显式标记 unsupported，
 * 不能静默忽略。此函数只决定「是否写入请求体」，实际是否生效由 provider 决定，
 * 调用方需结合 provider 能力记录 effective sampling 状态。
 */
function supportsSeedParameter(providerKey: string, model: string): boolean {
  return supportsSamplingParameters(providerKey, model);
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  totalTimeoutMs: 120000,
};

// R34: in-process unhealthy provider tracking. When a provider returns a
// permanent error (auth/banned/quota), we skip it for the rest of the run
// instead of burning through the full retry budget.
const UNHEALTHY_PROVIDERS: Set<string> = new Set();

// P43 Task 2：章级 provider timeout 计数。
// 同一 provider 在同一章节内连续超时达到阈值后，本章后续调用直接 unhealthy_skip，
// 避免慢模型每次等满 60-120s timeout。章入口 clearChapterTimeoutCounts() 清零。
// 与 UNHEALTHY_PROVIDERS 区分：后者是跨章 permanent 错误标记；本计数器是章级 scope。
const PROVIDER_TIMEOUT_COUNTS: Map<string, number> = new Map();
const PROVIDER_TIMEOUT_THRESHOLD = 2;
// 已因章级 timeout 阈值标记不健康的 provider 集合（不写入 UNHEALTHY_PROVIDERS）。
// callWithFallback 的 unhealthy 检查同时查 UNHEALTHY_PROVIDERS 和本集合；
// skip emit 时区分 reason: "chapter_timeout_threshold" vs "module_level_unhealthy"。
// 章入口与 PROVIDER_TIMEOUT_COUNTS 一并清零（不清除 UNHEALTHY_PROVIDERS，避免跨章污染）。
const CHAPTER_TIMEOUT_UNHEALTHY: Set<string> = new Set();

// P43 Task 2：Stage 2 正文模型白名单守卫。
// 防御性过滤：即使 config 误配置 fallback.doubao=[gpt]，正文主路由也不会自动 fallback 到 GPT/Claude。
// narrator_testing_* 是显式测试路由，不受此守卫限制（含 narrator_testing_gpt 末位兜底）。
const MAIN_ROUTE_AGENTS: Set<string> = new Set([
  "narrator_primary",
  "narrator_backup",
  "stage2_narrator",
]);
const MAIN_ROUTE_ALLOWED_PROVIDERS: Set<string> = new Set(["doubao"]);

// MODEL-ROUTING-CLAUDE46-1A: 生产 v2 路由 provider allowlist。
// 派工卡 §3 Required Change #4：为生产正文路由增加 provider allowlist。
// 即使 config 误配置 fallback 含未授权 provider，本守卫也会过滤掉。
// - v2_rawstage2 / v2_amplified: 只允许 claude（raw/editorial 正文唯一正式主写）
// - v2_chinese_calibration: 只允许 doubao（仅中文校准，不混入其他 provider）
// - v2_opportunity_judge / v2_literary_judge: 只允许 gpt（异源 judge，Claude/Doubao 不得自审）
// 不在 map 中的路由不受 allowlist 限制（保持向后兼容，如 narrator_testing_* / v2_direct_*）。
const V2_ROUTE_PROVIDER_ALLOWLIST: Record<string, Set<string>> = {
  v2_rawstage2: new Set(["claude"]),
  v2_amplified: new Set(["claude"]),
  v2_chinese_calibration: new Set(["doubao"]),
  v2_opportunity_judge: new Set(["gpt"]),
  v2_literary_judge: new Set(["gpt"]),
};


const PERMANENT_ERROR_PATTERNS: RegExp[] = [
  /User has been banned/i,
  /authentication\s*failed/i,
  /invalid.*api.?key/i,
  /\b401\b|\bunauthorized\b/i,
  /\b403\b|\bforbidden\b/i,
  /quota|insufficient.*balance/i,
  /permission.?denied/i,
  /账户.*禁用|余额不足|无可用资源包|API.*key.*invalid/i,
];

const PERMANENT_NETWORK_ERROR_CODES = new Set([
  "ENOTFOUND",
  "ENETUNREACH",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "EAI_AGAIN",
]);

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : String(error);
}

function getErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);

    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) {
      return code.trim().toUpperCase();
    }

    const cause = (current as { cause?: unknown }).cause;
    if (!cause || cause === current) {
      break;
    }

    current = cause;
  }

  return undefined;
}

/**
 * P43 Task 2：分类错误为 permanent / transient / timeout。
 *
 * - permanent: auth/quota/banned → markProviderUnhealthy，本章不再尝试
 * - timeout: 超时/AbortError → 不 markProviderUnhealthy，由 Task 2 章级计数器单独追踪
 * - transient: 其他临时错误 → 重试
 *
 * 注意：原返回类型 "permanent" | "transient" 已扩展为三元。现有调用方
 * `classifyError(error) === "permanent"` 仍正确（timeout 不匹配 permanent）。
 */
export function classifyError(error: unknown): "permanent" | "transient" | "timeout" {
  const errorMessage = getErrorMessage(error);
  const errorCode = getErrorCode(error);
  const matchesPermanentPattern = PERMANENT_ERROR_PATTERNS.some((re) =>
    re.test(errorMessage)
  );
  const isPermanentNetworkError =
    errorCode !== undefined && PERMANENT_NETWORK_ERROR_CODES.has(errorCode);

  if (matchesPermanentPattern || isPermanentNetworkError) {
    return "permanent";
  }

  // P43 Task 2：超时分类（在 permanent 之后、transient 之前）
  const matchesTimeoutPattern = TIMEOUT_ERROR_PATTERNS.some((re) =>
    re.test(errorMessage)
  );
  const isTimeoutErrorCode =
    errorCode !== undefined && TIMEOUT_ERROR_CODES.has(errorCode);
  if (matchesTimeoutPattern || isTimeoutErrorCode) {
    return "timeout";
  }

  return "transient";
}

export function markProviderUnhealthy(providerKey: string): void {
  UNHEALTHY_PROVIDERS.add(providerKey.toLowerCase());
}

export function isProviderUnhealthy(providerKey: string): boolean {
  return UNHEALTHY_PROVIDERS.has(providerKey.toLowerCase());
}

export function clearUnhealthyProviders(): void {
  UNHEALTHY_PROVIDERS.clear();
}

// ============================================================================
// P43 Task 2：Provider SLA 快退 — 章级 timeout 计数与白名单守卫
// ============================================================================

/**
 * P43 Task 2：记录 provider 超时，返回是否达到章级阈值。
 * 调用点：handleAttemptFailure 内 errorKind==="timeout" 分支。
 * 达到阈值时调用方应 add 到 CHAPTER_TIMEOUT_UNHEALTHY（不调用 markProviderUnhealthy，
 * 后者语义是跨章 permanent error；章级 timeout 由 CHAPTER_TIMEOUT_UNHEALTHY 单独追踪，
 * 章入口 clearChapterTimeoutCounts 清零，不污染下一章）。
 */
export function recordProviderTimeout(providerKey: string): boolean {
  const key = providerKey.toLowerCase();
  const next = (PROVIDER_TIMEOUT_COUNTS.get(key) || 0) + 1;
  PROVIDER_TIMEOUT_COUNTS.set(key, next);
  return next >= PROVIDER_TIMEOUT_THRESHOLD;
}

/**
 * P43 Task 2：provider 是否因章级 timeout 阈值被标记不健康。
 * 用于 skip emit 时区分 reason: "chapter_timeout_threshold" vs "module_level_unhealthy"。
 */
export function isChapterTimeoutUnhealthy(providerKey: string): boolean {
  return CHAPTER_TIMEOUT_UNHEALTHY.has(providerKey.toLowerCase());
}

/**
 * P43 Task 2：章入口清零 timeout 计数。
 * 不清除 UNHEALTHY_PROVIDERS（跨章 permanent 标记，既有行为）。
 * 调用点：handleGenerateChapter / resumeFromStage5 入口（与 createChapterPerformanceTracker 同位点）。
 */
export function clearChapterTimeoutCounts(): void {
  PROVIDER_TIMEOUT_COUNTS.clear();
  CHAPTER_TIMEOUT_UNHEALTHY.clear();
}

/**
 * P43 Task 2：是否为 Stage 2 正文主路由 agent。
 * 主路由 agent 的 fallback chain 只允许 doubao/ernie（白名单守卫）。
 * narrator_testing_* 是显式测试路由，不受限（含 loopback 末位兜底 narrator_testing_gpt）。
 */
export function isMainRouteAgent(agentName: string): boolean {
  return MAIN_ROUTE_AGENTS.has(agentName);
}

/** P43 Task 2：测试用 — 读取 provider 当前章级 timeout 计数 */
export function getProviderTimeoutCount(providerKey: string): number {
  return PROVIDER_TIMEOUT_COUNTS.get(providerKey.toLowerCase()) || 0;
}

/** P43 Task 2：测试用 — PROVIDER_TIMEOUT_THRESHOLD 常量暴露 */
export const PROVIDER_TIMEOUT_THRESHOLD_VALUE = PROVIDER_TIMEOUT_THRESHOLD;

// ============================================================================
// P43 Task 1：LLM 调用耗时结构化收集
// ============================================================================
//
// 采用模块级 listener 而非构造函数选项，覆盖所有 7+ 个 new APIFallbackManager()
// 站点（narrator/critic/anti-ai/style-shaper/reader-hook/chinese-editor 等），
// 无需改构造函数签名。orchestrator（index.ts handleGenerateChapter）在入口
// setLLMAttemptListener 收集到 _llmTimings 数组，组装进 PerformanceProfile。
//
// buffer-swap 方案：每章入口覆盖旧 listener，无需每个 return 都 clear；
// 顺序执行无竞态（handleGenerateChapter 不并发）。

export interface LLMTimingEntry {
  timestamp: string;
  agent: string;
  provider: string;
  model: string;
  attempt: number;
  elapsedMs: number;
  status: "ok" | "transient_error" | "permanent_error" | "timeout" | "unhealthy_skip";
  /** 模型路由标识（如 narrator_primary / narrator_testing_ernie），便于 Task 2 SLA 分流 */
  route?: string;
  /** skip/失败原因，便于 trace 诊断 */
  reason?: string;
  /** NB-4.0: trace 标准化字段 — 请求的路由名（= agent 的语义别名） */
  requestedRoute?: string;
  /** NB-4.0: trace 标准化字段 — 实际调用的 provider（= provider 的语义别名） */
  actualProvider?: string;
  /** NB-4.0: trace 标准化字段 — 实际调用的 model（= model 的语义别名） */
  actualModel?: string;
  /** Stable identifier binding start/failure/success telemetry for one provider attempt. */
  requestId?: string;
  /** SHA-256 of the exact assistant text returned by a successful attempt. */
  responseHash?: string;
  /** 输入 token（仅 OpenAI-compatible 路径可精确取自 usage；Claude streaming 路径无 usage，留空） */
  inputTokens?: number;
  /** 输出 token（仅 OpenAI-compatible 路径可精确取自 usage；Claude streaming 路径无 usage，留空） */
  outputTokens?: number;
  /**
   * 推理 token（reasoning/thinking token），从 OpenAI-compatible `completion_tokens_details.reasoning_tokens` 提取。
   * Gemini 3.x 是推理模型，`completion_tokens` 包含 reasoning tokens；此字段如果存在可用于区分推理与可见输出。
   * 不存在时留空（provider 未返回细分）。
   */
  reasoningTokens?: number;
  /**
   * 缓存命中 token，从 OpenAI-compatible `prompt_tokens_details.cached_tokens` 提取。
   * Gemini 隐式缓存命中时 > 0。不存在时留空（provider 未返回细分）。
   */
  cachedTokens?: number;
}

function createAttemptRequestId(): string {
  return `llm-${randomUUID()}`;
}

function hashResponseText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

type LLMTimingListener = (entry: LLMTimingEntry) => void;

let _llmAttemptListener: LLMTimingListener | null = null;

/**
 * 设置章级 LLM 调用监听器。传 null 清除。
 * orchestrator 在 handleGenerateChapter 入口调用，覆盖上一章残留 listener。
 */
export function setLLMAttemptListener(fn: LLMTimingListener | null): void {
  _llmAttemptListener = fn;
}

/**
 * 内部 emit 函数：listener 异常不影响主流程（fallback-manager 不能因观测层崩溃）。
 *
 * P43 Task 1.4：导出供测试直接调用（验证 listener 异常隔离 / null listener 无副作用）。
 * 导出后零行为变化，仅可见性提升。
 */
export function emitLLMAttempt(entry: LLMTimingEntry): void {
  if (_llmAttemptListener) {
    try {
      // NB-4.0: trace 标准化 — 确保 requestedRoute/actualProvider/actualModel 始终存在。
      // 从现有 agent/provider/model 字段派生，避免每个调用点都手动填写。
      const enrichedEntry: LLMTimingEntry = {
        ...entry,
        requestedRoute: entry.requestedRoute ?? entry.agent,
        actualProvider: entry.actualProvider ?? entry.provider,
        actualModel: entry.actualModel ?? entry.model,
      };
      _llmAttemptListener(enrichedEntry);
    } catch {
      // listener 异常静默吞掉，不污染主流程
    }
  }
}

// ============================================================================
// P43 Task 2 预备：classifyError 增加 timeout 分类
// ============================================================================

const TIMEOUT_ERROR_PATTERNS: RegExp[] = [
  /timeout|timed?\s*out/i,
  /ETIMEDOUT|ESOCKETTIMEDOUT/i,
  /AbortError/i,
  /request\s*expired/i,
  /deadline\s*exceeded/i,
];

const TIMEOUT_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNRESET", // 常由对端超时断开
]);

export class APIFallbackManager {
  private retryOptions: RetryOptions;
  private retryOverrides: Partial<RetryOptions>;
  private logs: FallbackLogEntry[] = [];

  constructor(options?: Partial<RetryOptions>) {
    this.retryOverrides = { ...options };
    this.retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options };
  }

  async callWithFallback(
    agentName: string,
    messages: GLMMessage[],
    callOptions?: ChatCallOptions
  ): Promise<FallbackResult> {
    const { routing, primaryProvider, fallbackChain, providers, retryOptions } =
      await this.loadFallbackContext(agentName);
    this.retryOptions = retryOptions;
    this.logs = [];

    // P34-T09: 矩阵评测模式。若 PINOVEL_DISABLE_FALLBACK=1，只尝试 primaryProvider，
    // 不走 fallback chain。这样每个模型的真实质量可见，不会因 fallback 到其他 provider 而失真。
    // NB-4.0: package_screening profile 也强制禁用 fallback（套餐模型失败即失败，不回退）。
    const disableFallback = process.env.PINOVEL_DISABLE_FALLBACK === "1"
      || shouldDisableFallbackForProfile();
    const baseChain = disableFallback ? [primaryProvider] : fallbackChain;
    const whitelistFiltered = (!disableFallback && isMainRouteAgent(agentName))
      ? baseChain.filter((p) => MAIN_ROUTE_ALLOWED_PROVIDERS.has(p))
      : baseChain;
    const effectiveChain = filterFallbackChainByProfile(whitelistFiltered, agentName)
      .filter((providerKey) => !isProviderDisabled(providerKey));

    // P0: 总超时预算
    const chainStartTime = Date.now();
    const totalTimeoutMs = this.retryOptions.totalTimeoutMs;

    let retryCount = 0;
    let fellBack = false;

    for (const providerKey of effectiveChain) {
      if (totalTimeoutMs && (Date.now() - chainStartTime) >= totalTimeoutMs) {
        console.warn(`[FallbackTimeout] agent=${agentName} elapsedMs=${Date.now() - chainStartTime} totalTimeoutMs=${totalTimeoutMs}`);
        throw new Error(`Fallback chain timeout: exceeded ${totalTimeoutMs}ms total budget`);
      }

      assertProviderAuthorized(providerKey, agentName);

      const provider = providers[providerKey];
      if (!provider) continue;

      const routeEntry = typeof routing === "object" ? routing : undefined;
      // The internal Sub2API gateway is the only production egress. Route-level
      // provider credentials must not bypass the gateway when it is configured.
      const gatewayConfigured = Boolean(process.env.SUB2API_INTERNAL_LLM_BASE_URL);
      const apiKey = gatewayConfigured
        ? getApiKey(providerKey)
        : (routeEntry?.api_key_env ? process.env[routeEntry.api_key_env] || null : getApiKey(providerKey));
      if (!apiKey) continue;

      if (isProviderUnhealthy(providerKey) || isChapterTimeoutUnhealthy(providerKey)) {
        console.warn(`[LLMAttemptSkip] agent=${agentName} provider=${providerKey} status=unhealthy_skip`);
        // P43 Task 1：emit unhealthy_skip 条目（model 未知，attempt=0，elapsedMs=0）
        emitLLMAttempt({
          timestamp: new Date().toISOString(),
          agent: agentName,
          provider: providerKey,
          model: "",
          attempt: 0,
          elapsedMs: 0,
          status: "unhealthy_skip",
          reason: isChapterTimeoutUnhealthy(providerKey) ? "chapter_timeout_threshold" : "module_level_unhealthy",
        });
        continue;
      }

      const modelToUse = this.resolveProviderModel(providerKey, provider, routing);
      const baseUrl = normalizeProviderBaseUrl(providerKey, gatewayConfigured
        ? process.env.SUB2API_INTERNAL_LLM_BASE_URL!
        : (routeEntry?.base_url_env ? process.env[routeEntry.base_url_env] || provider.base_url : this.resolveProviderBaseUrl(providerKey, provider.base_url)));
      // Sub2API exposes one OpenAI-compatible chat-completions endpoint. Do not
      // let Claude/Gemini provider metadata select a direct Anthropic/Google path.
      const protocol = gatewayConfigured ? "openai" : (provider.protocol || this.inferProtocol(providerKey));
      const resolvedCallOptions: ChatCallOptions = {
        ...callOptions,
        temperature: callOptions?.temperature ?? provider.temperature?.[agentName],
        max_tokens: callOptions?.max_tokens ?? provider.max_tokens?.[agentName],
      };

      let providerPermanentlyFailed = false;
      for (let attempt = 0; attempt <= this.retryOptions.maxRetries; attempt++) {
        // 检查总超时
        if (totalTimeoutMs && (Date.now() - chainStartTime) >= totalTimeoutMs) {
          console.warn(`[FallbackTimeout] agent=${agentName} elapsedMs=${Date.now() - chainStartTime} totalTimeoutMs=${totalTimeoutMs}`);
          throw new Error(`Fallback chain timeout: exceeded ${totalTimeoutMs}ms total budget`);
        }

        process.stderr.write(
          `[LLMAttemptStart] agent=${agentName} provider=${providerKey} model=${modelToUse} attempt=${attempt + 1}/${this.retryOptions.maxRetries + 1} protocol=${protocol}\n`
        );
        const startMs = Date.now();
        const requestId = createAttemptRequestId();
        try {
          let response: GLMResponse;
          if (protocol === "anthropic" || protocol === "claude") {
            // Claude/Anthropic 协议分流：过滤 system 消息到顶层 system 参数
            // （Anthropic API 不允许 messages 数组含 role="system"）
            const systemFromMessages: string[] = [];
            const anthropicMessages: ClaudeMessage[] = [];
            for (const msg of messages) {
              if (msg.role === "system") {
                systemFromMessages.push(msg.content);
              } else {
                anthropicMessages.push({
                  role: msg.role === "assistant" ? "assistant" : "user",
                  content: msg.content,
                });
              }
            }
            const combinedSystem = systemFromMessages.join("\n\n") || undefined;
            const claudeResp = await this.makeClaudeAPICall(
              baseUrl,
              apiKey,
              modelToUse,
              anthropicMessages,
              {
                temperature: resolvedCallOptions.temperature,
                max_tokens: resolvedCallOptions.max_tokens,
                system: combinedSystem,
                auth: provider.request_options?.auth,
                timeoutMs: resolvedCallOptions.timeoutMs,
              }
            );
            // 适配 Claude 响应到 GLMResponse 结构
            const textContent = claudeResp.content
              .map((block) => block.text || "")
              .join("");
            response = {
              id: `claude-${Date.now()}`,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: modelToUse,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: textContent },
                  finish_reason: claudeResp.stop_reason || "stop",
                },
              ],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            };
          } else {
            response = await this.makeOpenAIChatCall(
              baseUrl,
              apiKey,
              providerKey,
              modelToUse,
              messages,
              resolvedCallOptions,
              provider.request_options
            );
          }
          fellBack = providerKey !== primaryProvider;
          const _okElapsedMs = Date.now() - startMs;
          process.stderr.write(
            `[LLMAttemptEnd] agent=${agentName} provider=${providerKey} attempt=${attempt + 1} status=ok elapsedMs=${_okElapsedMs}\n`
          );
          // P43 Task 1：emit ok 条目，orchestrator 收集进 PerformanceProfile.llmTimings
          // 提取 usage 细分：reasoning_tokens（Gemini 3.x 推理模型在 completion_tokens 中包含）
          // 和 cached_tokens（Gemini 隐式缓存命中）。provider 未返回时留 undefined。
          const _usage = response.usage as {
            prompt_tokens?: number;
            completion_tokens?: number;
            completion_tokens_details?: { reasoning_tokens?: number };
            prompt_tokens_details?: { cached_tokens?: number };
          } | undefined;
          emitLLMAttempt({
            timestamp: new Date().toISOString(),
            agent: agentName,
            provider: providerKey,
            model: modelToUse,
            attempt: attempt + 1,
            elapsedMs: _okElapsedMs,
            status: "ok",
            requestId,
            responseHash: hashResponseText(response.choices[0]?.message?.content ?? ""),
            inputTokens: _usage?.prompt_tokens,
            outputTokens: _usage?.completion_tokens,
            reasoningTokens: _usage?.completion_tokens_details?.reasoning_tokens,
            cachedTokens: _usage?.prompt_tokens_details?.cached_tokens,
          });

          return {
            response,
            usedProvider: providerKey,
            usedModel: modelToUse,
            retryCount,
            fellBack,
            logs: this.getLogs(),
          };
        } catch (error) {
          const outcome = await this.handleAttemptFailure(
            error,
            attempt,
            retryCount,
            agentName,
            primaryProvider,
            providerKey,
            modelToUse,
            startMs,
            requestId,
          );
          retryCount = outcome.retryCount;
          fellBack = providerKey !== primaryProvider;
          if (outcome.isPermanent) {
            providerPermanentlyFailed = true;
            break;
          }
        }
      }
      if (providerPermanentlyFailed) continue;
    }

    throw this.createAllCallsFailedError(agentName, fallbackChain);
  }

  async callClaudeWithFallback(
    agentName: string,
    messages: ClaudeMessage[],
    options?: {
      temperature?: number;
      max_tokens?: number;
      system?: string;
    }
  ): Promise<ClaudeFallbackResult> {
    const { routing, primaryProvider, fallbackChain, providers, retryOptions } =
      await this.loadFallbackContext(agentName);
    this.retryOptions = retryOptions;
    this.logs = [];

    // P0: 总超时预算
    const chainStartTime = Date.now();
    const totalTimeoutMs = this.retryOptions.totalTimeoutMs;

    let retryCount = 0;
    let fellBack = false;

    const _disableFallback = process.env.PINOVEL_DISABLE_FALLBACK === "1"
      || shouldDisableFallbackForProfile();
    const _baseChain = _disableFallback ? [primaryProvider] : fallbackChain;
    const _whitelistFiltered = (!_disableFallback && isMainRouteAgent(agentName))
      ? _baseChain.filter((p) => MAIN_ROUTE_ALLOWED_PROVIDERS.has(p))
      : _baseChain;
    const _effectiveChain = filterFallbackChainByProfile(_whitelistFiltered, agentName)
      .filter((providerKey) => !isProviderDisabled(providerKey));

    for (const providerKey of _effectiveChain) {
      if (totalTimeoutMs && (Date.now() - chainStartTime) >= totalTimeoutMs) {
        console.warn(`[FallbackTimeout] agent=${agentName} elapsedMs=${Date.now() - chainStartTime} totalTimeoutMs=${totalTimeoutMs}`);
        throw new Error(`Fallback chain timeout: exceeded ${totalTimeoutMs}ms total budget`);
      }

      assertProviderAuthorized(providerKey, agentName);

      const provider = providers[providerKey];
      if (!provider) continue;

      const routeEntry = typeof routing === "object" ? routing : undefined;
      const apiKey = routeEntry?.api_key_env ? process.env[routeEntry.api_key_env] || null : getApiKey(providerKey);
      if (!apiKey) continue;

      if (isProviderUnhealthy(providerKey) || isChapterTimeoutUnhealthy(providerKey)) {
        console.warn(`[LLMAttemptSkip] agent=${agentName} provider=${providerKey} status=unhealthy_skip`);
        // P43 Task 1：emit unhealthy_skip 条目（model 未知，attempt=0，elapsedMs=0）
        emitLLMAttempt({
          timestamp: new Date().toISOString(),
          agent: agentName,
          provider: providerKey,
          model: "",
          attempt: 0,
          elapsedMs: 0,
          status: "unhealthy_skip",
          reason: isChapterTimeoutUnhealthy(providerKey) ? "chapter_timeout_threshold" : "module_level_unhealthy",
        });
        continue;
      }

      const modelToUse = this.resolveProviderModel(providerKey, provider, routing);
      const baseUrl = normalizeProviderBaseUrl(providerKey, routeEntry?.base_url_env ? process.env[routeEntry.base_url_env] || provider.base_url : this.resolveProviderBaseUrl(providerKey, provider.base_url));
      const protocol = provider.protocol || this.inferProtocol(providerKey);
      const resolvedTemperature = options?.temperature ?? provider.temperature?.[agentName];
      const resolvedMaxTokens = options?.max_tokens ?? provider.max_tokens?.[agentName];

      let providerPermanentlyFailed = false;
      for (let attempt = 0; attempt <= this.retryOptions.maxRetries; attempt++) {
        // 检查总超时
        if (totalTimeoutMs && (Date.now() - chainStartTime) >= totalTimeoutMs) {
          console.warn(`[FallbackTimeout] agent=${agentName} elapsedMs=${Date.now() - chainStartTime} totalTimeoutMs=${totalTimeoutMs}`);
          throw new Error(`Fallback chain timeout: exceeded ${totalTimeoutMs}ms total budget`);
        }

        process.stderr.write(
          `[LLMAttemptStart] agent=${agentName} provider=${providerKey} model=${modelToUse} attempt=${attempt + 1}/${this.retryOptions.maxRetries + 1} protocol=${protocol}\n`
        );
        const startMs = Date.now();
        const requestId = createAttemptRequestId();
        try {
          let response: ClaudeFallbackResult["response"];

          if (protocol === "anthropic" || protocol === "claude") {
            // 过滤 system role 消息，合并到顶层 system 参数
            // （Anthropic API 不允许 messages 数组含 role="system"）
            // 注意：callClaudeWithFallback 签名是 ClaudeMessage[]（不含 system），
            // 但运行时调用方可能传入含 system 的消息，用类型断言防御性处理。
            const systemFromMessages: string[] = [];
            const anthropicMessages: ClaudeMessage[] = [];
            for (const msg of messages) {
              const role = (msg as { role: string }).role;
              if (role === "system") {
                systemFromMessages.push(msg.content);
              } else {
                anthropicMessages.push({
                  role: role === "assistant" ? "assistant" : "user",
                  content: msg.content,
                });
              }
            }
            const combinedSystem = [
              options?.system,
              ...systemFromMessages,
            ].filter(Boolean).join("\n\n") || undefined;
            response = await this.makeClaudeAPICall(
              baseUrl,
              apiKey,
              modelToUse,
              anthropicMessages,
              {
                temperature: resolvedTemperature,
                max_tokens: resolvedMaxTokens,
                system: combinedSystem,
                auth: provider.request_options?.auth,
              }
            );
          } else {
            const systemMsg = options?.system
              ? [{ role: "system" as const, content: options.system }, ...messages]
              : messages;
            const result = await this.makeGPTAPICall(
              baseUrl,
              apiKey,
              providerKey,
              modelToUse,
              systemMsg,
              {
                temperature: resolvedTemperature,
                max_tokens: resolvedMaxTokens,
                thinking: provider.request_options?.thinking,
              }
            );
            response = {
              content: [{ type: "text", text: result.content }],
              stop_reason: result.finish_reason,
            };
          }

          fellBack = providerKey !== primaryProvider;
          const _okElapsedMs = Date.now() - startMs;
          process.stderr.write(
            `[LLMAttemptEnd] agent=${agentName} provider=${providerKey} attempt=${attempt + 1} status=ok elapsedMs=${_okElapsedMs}\n`
          );
          // P43 Task 1：emit ok 条目，orchestrator 收集进 PerformanceProfile.llmTimings
          emitLLMAttempt({
            timestamp: new Date().toISOString(),
            agent: agentName,
            provider: providerKey,
            model: modelToUse,
            attempt: attempt + 1,
            elapsedMs: _okElapsedMs,
            status: "ok",
            requestId,
            responseHash: hashResponseText(
              response.content.map((block) => block.text ?? "").join(""),
            ),
          });
          return {
            response,
            usedProvider: providerKey,
            usedModel: modelToUse,
            retryCount,
            fellBack,
            logs: this.getLogs(),
          };
        } catch (error) {
          const outcome = await this.handleAttemptFailure(
            error,
            attempt,
            retryCount,
            agentName,
            primaryProvider,
            providerKey,
            modelToUse,
            startMs,
            requestId,
          );
          retryCount = outcome.retryCount;
          fellBack = providerKey !== primaryProvider;
          if (outcome.isPermanent) {
            providerPermanentlyFailed = true;
            break;
          }
        }
      }
      if (providerPermanentlyFailed) continue;
    }

    throw this.createAllCallsFailedError(agentName, fallbackChain);
  }

  async callGPTWithFallback(
    agentName: string,
    messages: GPTMessage[],
    options?: {
      temperature?: number;
      max_tokens?: number;
      responseFormat?: { type: "json_object" | "text" };
    }
  ): Promise<GPTFallbackResult> {
    const { routing, primaryProvider, fallbackChain, providers, retryOptions } =
      await this.loadFallbackContext(agentName);
    this.retryOptions = retryOptions;
    this.logs = [];

    // P0: 总超时预算
    const chainStartTime = Date.now();
    const totalTimeoutMs = this.retryOptions.totalTimeoutMs;

    let retryCount = 0;
    let fellBack = false;

    const _disableFallback = process.env.PINOVEL_DISABLE_FALLBACK === "1"
      || shouldDisableFallbackForProfile();
    const _baseChain = _disableFallback ? [primaryProvider] : fallbackChain;
    const _whitelistFiltered = (!_disableFallback && isMainRouteAgent(agentName))
      ? _baseChain.filter((p) => MAIN_ROUTE_ALLOWED_PROVIDERS.has(p))
      : _baseChain;
    const _effectiveChain = filterFallbackChainByProfile(_whitelistFiltered, agentName)
      .filter((providerKey) => !isProviderDisabled(providerKey));

    for (const providerKey of _effectiveChain) {
      if (totalTimeoutMs && (Date.now() - chainStartTime) >= totalTimeoutMs) {
        console.warn(`[FallbackTimeout] agent=${agentName} elapsedMs=${Date.now() - chainStartTime} totalTimeoutMs=${totalTimeoutMs}`);
        throw new Error(`Fallback chain timeout: exceeded ${totalTimeoutMs}ms total budget`);
      }

      assertProviderAuthorized(providerKey, agentName);

      const provider = providers[providerKey];
      if (!provider) continue;

      const routeEntry = typeof routing === "object" ? routing : undefined;
      const apiKey = routeEntry?.api_key_env ? process.env[routeEntry.api_key_env] || null : getApiKey(providerKey);
      if (!apiKey) continue;

      if (isProviderUnhealthy(providerKey) || isChapterTimeoutUnhealthy(providerKey)) {
        console.warn(`[LLMAttemptSkip] agent=${agentName} provider=${providerKey} status=unhealthy_skip`);
        // P43 Task 1：emit unhealthy_skip 条目（model 未知，attempt=0，elapsedMs=0）
        emitLLMAttempt({
          timestamp: new Date().toISOString(),
          agent: agentName,
          provider: providerKey,
          model: "",
          attempt: 0,
          elapsedMs: 0,
          status: "unhealthy_skip",
          reason: isChapterTimeoutUnhealthy(providerKey) ? "chapter_timeout_threshold" : "module_level_unhealthy",
        });
        continue;
      }

      const modelToUse = this.resolveProviderModel(providerKey, provider, routing);
      const baseUrl = normalizeProviderBaseUrl(providerKey, routeEntry?.base_url_env ? process.env[routeEntry.base_url_env] || provider.base_url : this.resolveProviderBaseUrl(providerKey, provider.base_url));
      const protocol = provider.protocol || this.inferProtocol(providerKey);
      const resolvedTemperature = options?.temperature ?? provider.temperature?.[agentName];
      const resolvedMaxTokens = options?.max_tokens ?? provider.max_tokens?.[agentName];

      let providerPermanentlyFailed = false;
      for (let attempt = 0; attempt <= this.retryOptions.maxRetries; attempt++) {
        // 检查总超时
        if (totalTimeoutMs && (Date.now() - chainStartTime) >= totalTimeoutMs) {
          console.warn(`[FallbackTimeout] agent=${agentName} elapsedMs=${Date.now() - chainStartTime} totalTimeoutMs=${totalTimeoutMs}`);
          throw new Error(`Fallback chain timeout: exceeded ${totalTimeoutMs}ms total budget`);
        }

        process.stderr.write(
          `[LLMAttemptStart] agent=${agentName} provider=${providerKey} model=${modelToUse} attempt=${attempt + 1}/${this.retryOptions.maxRetries + 1} protocol=${protocol}\n`
        );
        const startMs = Date.now();
        const requestId = createAttemptRequestId();
        try {
          let response: GPTFallbackResult["response"];

          if (protocol === "openai" || protocol === "chat") {
            response = await this.makeGPTAPICall(
              baseUrl,
              apiKey,
              providerKey,
              modelToUse,
              messages,
              {
                ...options,
                temperature: resolvedTemperature,
                max_tokens: resolvedMaxTokens,
                responseFormat: options?.responseFormat ?? { type: "json_object" },
                thinking: provider.request_options?.thinking,
              }
            );
          } else {
            const systemMessages: GPTMessage[] = [];
            const nonSystemMessages: ClaudeMessage[] = [];
            for (const msg of messages) {
              if (msg.role === "system") {
                systemMessages.push(msg);
              } else {
                nonSystemMessages.push({
                  role: msg.role === "assistant" ? "assistant" : "user",
                  content: msg.content,
                });
              }
            }
            const systemPrompt = systemMessages.map((msg) => msg.content).join("\n");
            const result = await this.makeClaudeAPICall(
              baseUrl,
              apiKey,
              modelToUse,
              nonSystemMessages,
              {
                temperature: resolvedTemperature,
                max_tokens: resolvedMaxTokens,
                system: systemPrompt,
                auth: provider.request_options?.auth,
              }
            );
            response = {
              content: result.content.map((block) => block.text || "").join(""),
              finish_reason: result.stop_reason,
            };
          }

          fellBack = providerKey !== primaryProvider;
          const _okElapsedMs = Date.now() - startMs;
          process.stderr.write(
            `[LLMAttemptEnd] agent=${agentName} provider=${providerKey} attempt=${attempt + 1} status=ok elapsedMs=${_okElapsedMs}\n`
          );
          // P43 Task 1：emit ok 条目，orchestrator 收集进 PerformanceProfile.llmTimings
          emitLLMAttempt({
            timestamp: new Date().toISOString(),
            agent: agentName,
            provider: providerKey,
            model: modelToUse,
            attempt: attempt + 1,
            elapsedMs: _okElapsedMs,
            status: "ok",
            requestId,
            responseHash: hashResponseText(response.content),
          });
          return {
            response,
            usedProvider: providerKey,
            usedModel: modelToUse,
            retryCount,
            fellBack,
            logs: this.getLogs(),
          };
        } catch (error) {
          const outcome = await this.handleAttemptFailure(
            error,
            attempt,
            retryCount,
            agentName,
            primaryProvider,
            providerKey,
            modelToUse,
            startMs,
            requestId,
          );
          retryCount = outcome.retryCount;
          fellBack = providerKey !== primaryProvider;
          if (outcome.isPermanent) {
            providerPermanentlyFailed = true;
            break;
          }
        }
      }
      if (providerPermanentlyFailed) continue;
    }

    throw this.createAllCallsFailedError(agentName, fallbackChain);
  }

  private async loadFallbackContext(agentName: string): Promise<{
    routing: RouteConfig;
    primaryProvider: string;
    fallbackChain: string[];
    providers: Record<string, ProviderConfig>;
    retryOptions: RetryOptions;
  }> {
    const config = await loadGlobalConfig();
    const routing = config.modelRouting.agent_routing[agentName];
    // MODEL-ROUTING-CLAUDE46-1A: fail-closed on unknown route.
    // 派工卡 §3 Required Change #3：未知 route、缺失 agent_routing、缺 provider 或缺 model
    // 时必须返回结构化配置错误并 fail closed；禁止再默认返回 GLM。
    const primaryProvider = this.resolvePrimaryProviderOrThrow(agentName, routing);
    // MODEL-ROUTING-CLAUDE46-1A: route-level fallback overrides provider-level.
    // 派工卡 §3 Required Change #2：fallback-manager 必须优先消费 route-level `fallback`；
    // 只有路由未声明该字段时才能继承 provider-level fallback。
    const routeLevelFallback = typeof routing === "object" ? routing.fallback : undefined;
    const fallbackChain = this.buildFallbackChain(
      primaryProvider,
      config.modelRouting.fallback,
      routeLevelFallback,
      agentName,
    );
    return {
      routing,
      primaryProvider,
      fallbackChain,
      providers: config.modelRouting.providers,
      retryOptions: this.resolveRuntimeRetryOptions(config.modelRouting.retry),
    };
  }

  private resolveRuntimeRetryOptions(retryConfig?: {
    max_retries?: number;
    retry_delay_ms?: number;
    total_timeout_ms?: number;
  }): RetryOptions {
    const configOptions: Partial<RetryOptions> = {};
    if (Number.isFinite(retryConfig?.max_retries) && retryConfig!.max_retries! >= 0) {
      configOptions.maxRetries = retryConfig!.max_retries!;
    }
    if (Number.isFinite(retryConfig?.retry_delay_ms) && retryConfig!.retry_delay_ms! >= 0) {
      configOptions.baseDelayMs = retryConfig!.retry_delay_ms!;
    }
    if (Number.isFinite(retryConfig?.total_timeout_ms) && retryConfig!.total_timeout_ms! > 0) {
      configOptions.totalTimeoutMs = retryConfig!.total_timeout_ms!;
    }

    const envOptions: Partial<RetryOptions> = {};
    const envMaxRetries = parseNonNegativeInteger(process.env.PINOVEL_MODEL_MAX_RETRIES);
    const envRetryDelayMs = parseNonNegativeInteger(process.env.PINOVEL_MODEL_RETRY_DELAY_MS);
    const envTotalTimeoutMs = parseNonNegativeInteger(process.env.PINOVEL_MODEL_TOTAL_TIMEOUT_MS);
    if (envMaxRetries !== undefined) {
      envOptions.maxRetries = envMaxRetries;
    }
    if (envRetryDelayMs !== undefined) {
      envOptions.baseDelayMs = envRetryDelayMs;
    }
    if (envTotalTimeoutMs !== undefined) {
      envOptions.totalTimeoutMs = envTotalTimeoutMs;
    }

    return {
      ...DEFAULT_RETRY_OPTIONS,
      ...configOptions,
      ...envOptions,
      ...this.retryOverrides,
    };
  }

  /**
   * MODEL-ROUTING-CLAUDE46-1A: fail-closed primary provider resolution.
   *
   * 派工卡 §3 Required Change #3：未知 route、缺失 agent_routing、缺 provider 或缺 model
   * 时必须返回结构化配置错误并 fail closed；禁止再默认返回 GLM。
   *
   * 旧版 `resolvePrimaryProvider` 在 routing 缺失时默认返回 "glm"，导致未知 route
   * 隐式落 GLM（生产风险）。本方法在调用前抛结构化错误，使 unknown route
   * fetch 调用次数为 0。
   *
   * `pi_default` 仍是合法 routing（向后兼容 legacy 调用），保留旧"glm"行为；
   * 但 v2 生产路由（v2_*）和未知 route 不再 fall open 到 GLM。
   */
  private resolvePrimaryProviderOrThrow(agentName: string, routing: RouteConfig): string {
    if (routing === "pi_default") {
      // pi_default 是 legacy 显式默认值（部分旧测试 fixture 使用），保留旧行为。
      // 生产 v2 路由不使用 pi_default；本分支仅为向后兼容。
      return "glm";
    }
    if (!routing) {
      throw new Error(
        `Unknown route "${agentName}": agent_routing entry is missing. ` +
        `MODEL-ROUTING-CLAUDE46-1A fail-closed: unknown route must not fall back to GLM. ` +
        `Add an explicit agent_routing entry for "${agentName}" in config/model-routing.json.`
      );
    }
    const provider = typeof routing === "string" ? routing : routing.provider;
    if (!provider || typeof provider !== "string" || provider.trim() === "") {
      throw new Error(
        `Unknown route "${agentName}": agent_routing entry is missing "provider" field. ` +
        `MODEL-ROUTING-CLAUDE46-1A fail-closed: route must declare an explicit provider.`
      );
    }
    // MODEL-ROUTING-CLAUDE46-1A: object-form routing 必须显式声明 model
    // （string-form 视为 provider-only 别名，model 由 provider 默认值解析）。
    if (typeof routing === "object" && (!routing.model || routing.model.trim() === "")) {
      throw new Error(
        `Unknown route "${agentName}": agent_routing entry is missing "model" field. ` +
        `MODEL-ROUTING-CLAUDE46-1A fail-closed: route must declare an explicit model.`
      );
    }
    return provider;
  }

  /**
   * @deprecated MODEL-ROUTING-CLAUDE46-1A: 使用 resolvePrimaryProviderOrThrow 替代。
   * 保留私有方法仅供内部向后兼容调用（如 pi_default 路径）；不再用于 unknown route 解析。
   */
  private resolvePrimaryProvider(routing: RouteConfig): string {
    if (!routing || routing === "pi_default") {
      return "glm";
    }
    return typeof routing === "string" ? routing : routing.provider;
  }

  private inferProtocol(providerKey: string): ProviderProtocol {
    return providerKey === "claude" ? "anthropic" : "openai";
  }

  private resolveProviderBaseUrl(providerKey: string, baseUrl: string): string {
    return getBaseUrl(providerKey, baseUrl);
  }

  private resolveProviderModel(
    providerKey: string,
    provider: Pick<ProviderConfig, "model" | "models">,
    routing: RouteConfig
  ): string {
    const routingModel = typeof routing === "object" ? routing.model : undefined;
    const isPrimary = typeof routing === "object"
      ? routing.provider === providerKey
      : routing === providerKey;

    let resolvedModel: string | undefined;

    if (isPrimary && routingModel) {
      resolvedModel = routingModel;
    }

    if (!resolvedModel && provider.model) {
      resolvedModel = provider.model;
    }

    if (!resolvedModel && provider.models) {
      const firstModelKey = Object.keys(provider.models)[0];
      resolvedModel = provider.models[firstModelKey]?.id || firstModelKey;
    }

    if (!resolvedModel) {
      throw new Error(`Unable to resolve model for provider ${providerKey}`);
    }

    const routeModelEnv = typeof routing === "object" ? routing.model_env : undefined;
    if (routeModelEnv && process.env[routeModelEnv]) return process.env[routeModelEnv] as string;
    return getModelOverride(providerKey, resolvedModel) || resolvedModel;
  }

  /**
   * MODEL-ROUTING-CLAUDE46-1A: build fallback chain with route-level override.
   */
  private buildFallbackChain(
    primaryProvider: string,
    fallbackConfig: Record<string, string[]>,
    routeLevelFallback?: string[],
    agentName?: string,
  ): string[] {
    const disabledProviders = getDisabledProviders();
    const chain: string[] = [primaryProvider];

    if (routeLevelFallback !== undefined) {
      for (const fallback of routeLevelFallback) {
        if (!chain.includes(fallback)) chain.push(fallback);
      }
    } else {
      const fallbacks = fallbackConfig[primaryProvider] || [];
      for (const fallback of fallbacks) {
        if (!chain.includes(fallback)) chain.push(fallback);
      }
    }

    const allowlist = agentName ? V2_ROUTE_PROVIDER_ALLOWLIST[agentName] : undefined;
    const filteredByAllowlist = allowlist
      ? chain.filter((providerKey) => allowlist.has(providerKey))
      : chain;

    return filteredByAllowlist.filter(
      (providerKey) =>
        !disabledProviders.has(providerKey.toLowerCase()) && !isProviderDisabled(providerKey),
    );
  }

  private async makeOpenAIChatCall(
    baseUrl: string,
    apiKey: string,
    providerKey: string,
    model: string,
    messages: GLMMessage[],
    options?: ChatCallOptions,
    requestOptions?: ProviderRequestOptions
  ): Promise<GLMResponse> {
    const streamResponse = options?.stream === true
      || (providerKey === "gpt" && model === "gpt-5.6-sol" && Boolean(options?.max_tokens && options.max_tokens >= 8192));
    const request = this.buildOpenAIRequest(
      providerKey,
      model,
      localizeLlmMessages(messages),
      options,
      requestOptions,
    );
    if (streamResponse) request.stream = true;
    const response = await fetchWithTimeout(
      joinUrl(baseUrl, "chat/completions"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(request),
      },
      { label: `OpenAI-compatible:${model}`, timeoutMs: options?.timeoutMs }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`API call failed (${response.status}): ${errorBody.substring(0, 200)}`);
    }

    if (streamResponse && response.headers.get("content-type")?.includes("text/event-stream")) {
      return await parseOpenAIStream(response, model) as GLMResponse;
    }
    const data = await response.json();
    if ((data as { error?: { message?: string; code?: string } }).error) {
      const error = (data as { error: { message?: string; code?: string } }).error;
      throw new Error(`API returned error: ${error.message || error.code || JSON.stringify(error)}`);
    }

    const result = data as GLMResponse & {
      choices?: Array<{ message?: GLMMessage & { reasoning_content?: string } }>;
    };
    const message = result.choices?.[0]?.message;
    if (message && (!message.content || message.content.trim() === "") && message.reasoning_content) {
      message.content = message.reasoning_content;
    }

    return result as GLMResponse;
  }

  private async makeClaudeAPICall(
    baseUrl: string,
    apiKey: string,
    model: string,
    messages: ClaudeMessage[],
    options?: {
      temperature?: number;
      max_tokens?: number;
      system?: string;
      auth?: ProviderRequestOptions["auth"];
      timeoutMs?: number;
    }
  ): Promise<{ content: Array<{ type: string; text?: string }>; stop_reason: string }> {
    // Claude Opus 4.8 等模型已弃用 temperature 参数，传参会触发 400 错误。
    // 对包含 "opus-4" 或 "opus-4.8" 的模型省略 temperature。
    const supportsTemperature = !/opus-4/i.test(model);
    const requestBody: Record<string, unknown> = {
      model,
      messages: localizeLlmMessages(messages),
      max_tokens: options?.max_tokens ?? 4096,
      stream: true,
    };
    if (supportsTemperature) {
      requestBody.temperature = options?.temperature ?? 0;
    }
    if (options?.system) {
      requestBody.system = localizeLlmText(options.system);
    }
    // Claude Opus 4.8 默认启用 extended thinking，会返回 thinking/tool_use blocks 而非 text。
    // 显式禁用 thinking 确保返回纯 text content。
    requestBody.thinking = { type: "disabled" };
    const response = await fetchWithTimeout(
      joinUrl(baseUrl, "messages"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
          ...(options?.auth === "bearer"
            ? { Authorization: `Bearer ${apiKey}` }
            : { "x-api-key": apiKey }),
        },
        body: JSON.stringify(requestBody),
      },
      { label: `Anthropic-compatible:${model}`, timeoutMs: options?.timeoutMs }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude API error: ${errorText || response.statusText}`);
    }

    return await parseAnthropicResponse(response, model) as {
      content: Array<{ type: string; text?: string }>;
      stop_reason: string;
    };
  }

  private async makeGPTAPICall(
    baseUrl: string,
    apiKey: string,
    providerKey: string,
    model: string,
    messages: GPTMessage[] | ClaudeMessage[],
    options?: {
      temperature?: number;
      max_tokens?: number;
      responseFormat?: { type: "json_object" | "text" };
      thinking?: ProviderRequestOptions["thinking"];
    }
  ): Promise<{ content: string; finish_reason: string }> {
    const request: Record<string, unknown> = {
      model,
      messages: localizeLlmMessages(messages),
      max_tokens: options?.max_tokens ?? 2048,
    };

    if (supportsSamplingParameters(providerKey, model)) {
      request.temperature = options?.temperature ?? 0;
      request.top_p = 0.95;
    }

    if (options?.responseFormat) {
      request.response_format = options.responseFormat;
    }

    if (options?.thinking) {
      request.thinking = options.thinking;
    }

    const response = await fetchWithTimeout(
      joinUrl(baseUrl, "chat/completions"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(request),
      },
      { label: `GPT-compatible:${model}` }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        `GPT API error: ${(errorData as { error?: { message?: string } })?.error?.message || response.statusText}`
      );
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    };
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error("GPT API returned no choices");
    }
    return {
      content: choice.message.content,
      finish_reason: choice.finish_reason,
    };
  }

  private buildOpenAIRequest(
    providerKey: string,
    model: string,
    messages: GLMMessage[],
    options?: ChatCallOptions,
    requestOptions?: ProviderRequestOptions
  ): Record<string, unknown> {
    const request: Record<string, unknown> = {
      model,
      messages,
      max_tokens: options?.max_tokens ?? 4096,
    };

    if (supportsSamplingParameters(providerKey, model)) {
      request.temperature = options?.temperature ?? 0.7;
    }

    // 受控采样种子：仅对支持 seed 的 OpenAI 兼容 provider 透传。
    if (options?.seed !== undefined && supportsSeedParameter(providerKey, model)) {
      request.seed = options.seed;
    }

    const thinking = options?.thinking ?? requestOptions?.thinking;
    if (thinking) {
      request.thinking = thinking;
    }

    return request;
  }

  private async handleAttemptFailure(
    error: unknown,
    attempt: number,
    retryCount: number,
    agentName: string,
    primaryProvider: string,
    fallbackProvider: string,
    modelToUse: string,
    startMs: number,
    requestId: string,
  ): Promise<{ retryCount: number; isPermanent: boolean }> {
    const nextRetryCount = retryCount + 1;
    const errorMessage = getErrorMessage(error);
    const errorKind = classifyError(error);
    const isPermanent = errorKind === "permanent";

    // P43 Task 1：emit 失败条目（transient_error / permanent_error / timeout）
    const _failElapsedMs = Date.now() - startMs;
    const _emitStatus: "transient_error" | "permanent_error" | "timeout" =
      errorKind === "permanent" ? "permanent_error"
      : errorKind === "timeout" ? "timeout"
      : "transient_error";
    emitLLMAttempt({
      timestamp: new Date().toISOString(),
      agent: agentName,
      provider: fallbackProvider,
      model: modelToUse,
      attempt: attempt + 1,
      elapsedMs: _failElapsedMs,
      status: _emitStatus,
      reason: errorMessage.substring(0, 200),
      requestId,
    });

    this.logs.push({
      timestamp: new Date().toISOString(),
      agentName,
      primaryProvider,
      fallbackProvider,
      error: errorMessage,
      attempt: attempt + 1,
      maxRetries: this.retryOptions.maxRetries,
      retryCount: nextRetryCount,
    });

    if (isPermanent) {
      markProviderUnhealthy(fallbackProvider);
      console.warn(
        `[LLMAttemptEnd] agent=${agentName} provider=${fallbackProvider} attempt=${attempt + 1} status=permanent_error error=${errorMessage.substring(0, 200)} action=mark_unhealthy_skip`
      );
      return { retryCount: nextRetryCount, isPermanent: true };
    }

    // P43 Task 2：章级 timeout 快退。同一 provider 在本章累计超时达到阈值后，
    // add 到 CHAPTER_TIMEOUT_UNHEALTHY 使本章后续调用直接 unhealthy_skip，避免继续等满 timeout。
    // 不调用 markProviderUnhealthy：UNHEALTHY_PROVIDERS 语义是跨章 permanent error，
    // 章级 timeout 不应跨章污染；章入口 clearChapterTimeoutCounts 清零 CHAPTER_TIMEOUT_UNHEALTHY。
    // 注意：返回 isPermanent=true 以 break 当前 provider 的 attempt 循环、跳到 fallback chain 下一项；
    // 变量名 providerPermanentlyFailed 是历史命名，此处语义是"停止重试本 provider"。
    if (errorKind === "timeout") {
      const reachedThreshold = recordProviderTimeout(fallbackProvider);
      if (reachedThreshold && !isProviderUnhealthy(fallbackProvider)) {
        // 不调用 markProviderUnhealthy：UNHEALTHY_PROVIDERS 语义是跨章 permanent error，
        // 章级 timeout 用 CHAPTER_TIMEOUT_UNHEALTHY 单独追踪，章入口 clearChapterTimeoutCounts 清零。
        CHAPTER_TIMEOUT_UNHEALTHY.add(fallbackProvider.toLowerCase());
        console.warn(
          `[ProviderSLA] agent=${agentName} provider=${fallbackProvider} timeouts=${PROVIDER_TIMEOUT_THRESHOLD} action=mark_chapter_timeout_unhealthy`
        );
        return { retryCount: nextRetryCount, isPermanent: true };
      }
      // 未达阈值：仍按既有 transient 路径重试（落入下方 attempt < maxRetries 分支）
    }

    console.warn(
      `[LLMAttemptEnd] agent=${agentName} provider=${fallbackProvider} attempt=${attempt + 1}/${this.retryOptions.maxRetries + 1} status=transient_error error=${errorMessage.substring(0, 200)}`
    );

    if (attempt < this.retryOptions.maxRetries) {
      await this.sleep(this.calculateDelay(attempt));
      return { retryCount: nextRetryCount, isPermanent: false };
    }

    console.warn(
      `[Fallback:${agentName}] provider=${fallbackProvider} failed after ${attempt + 1}/${this.retryOptions.maxRetries + 1} attempts: ${errorMessage}`
    );

    return { retryCount: nextRetryCount, isPermanent: false };
  }

  private createAllCallsFailedError(agentName: string, fallbackChain: string[]): Error {
    const summary = this.summarizeFailureLogs();
    const suffix = summary ? `; failure summary: ${summary}` : "";
    return new Error(
      `All model calls failed for ${agentName}; tried providers: ${fallbackChain.join(" -> ")}${suffix}`
    );
  }

  private summarizeFailureLogs(): string {
    return this.logs
      .map((entry) =>
        `${entry.fallbackProvider} attempt ${entry.attempt}/${entry.maxRetries + 1}: ${entry.error}`
      )
      .join(" | ");
  }

  private calculateDelay(attempt: number): number {
    const delay =
      this.retryOptions.baseDelayMs *
      Math.pow(this.retryOptions.backoffMultiplier, attempt);
    return Math.min(delay, this.retryOptions.maxDelayMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getLogs(): FallbackLogEntry[] {
    return [...this.logs];
  }

  clearLogs(): void {
    this.logs = [];
  }
}

export function createAPIFallbackManager(
  options?: Partial<RetryOptions>
): APIFallbackManager {
  return new APIFallbackManager(options);
}

/** Normalize only Gemini OpenAI-compatible root URLs; preserve explicit API paths. */
export function normalizeProviderBaseUrl(providerKey: string, baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (providerKey !== "gemini31") return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname === "" || parsed.pathname === "/") {
      parsed.pathname = "/v1";
      return parsed.toString().replace(/\/+$/, "");
    }
  } catch {
    // Keep invalid/custom values unchanged so the request layer returns its normal diagnostic.
  }
  return trimmed;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function parseNonNegativeInteger(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function getDisabledProviders(): Set<string> {
  const raw = process.env.PINOVEL_DISABLED_PROVIDERS;
  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(/[,\s;]+/)
      .map((provider) => provider.trim().toLowerCase())
      .filter((provider) => provider.length > 0)
  );
}
