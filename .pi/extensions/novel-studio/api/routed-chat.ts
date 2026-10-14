/**
 * PiNovelStudio routed chat API.
 *
 * Business stages call this factory with a route name. The concrete provider,
 * model, base URL, protocol, and API key all resolve through model-routing.json
 * plus .env overrides.
 */

import {
  getAgentModelConfig,
  getApiKey,
  type ProviderProtocol,
  type ProviderRequestOptions,
} from "../utils/config.js";
import { localizeLlmMessages } from "../utils/llm-language-guard.js";
import { fetchWithTimeout } from "./request-timeout.js";
import { parseAnthropicResponse } from "./anthropic-stream.js";
import { callOpenAIResponses } from "./openai-responses.js";
import { assertProviderAuthorized } from "./benchmark-cost-profile.js";

export interface RoutedChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RoutedChatOptions {
  temperature?: number;
  max_tokens?: number;
  model?: string;
  top_p?: number;
  response_format?: { type: "json_object" | "text" };
  jsonMode?: boolean;
  thinking?: {
    type: "enabled" | "disabled";
    reasoning_effort?: "high" | "mid" | "low";
  };
}

export interface RoutedChatResponse {
  id?: string;
  object?: string;
  created?: number;
  model: string;
  choices: Array<{
    index: number;
    message: RoutedChatMessage;
    finish_reason: string;
  }>;
  usage?: Record<string, unknown>;
}

export interface RoutedChatConfig {
  agentName: string;
  provider: string;
  baseUrl: string;
  model: string;
  protocol: ProviderProtocol;
  temperature: number;
  maxTokens: number;
  requestOptions?: ProviderRequestOptions;
}

export function supportsJsonResponseFormat(
  config: Pick<RoutedChatConfig, "provider" | "baseUrl" | "protocol" | "model">,
  modelOverride?: string
): boolean {
  if (config.protocol !== "openai" && config.protocol !== "chat") {
    return false;
  }

  const provider = config.provider.toLowerCase();
  const baseUrl = config.baseUrl.toLowerCase();
  const model = (modelOverride || config.model).toLowerCase();

  if (provider === "glm" || model.startsWith("glm-") || model.includes("glm-")) {
    return false;
  }
  if (baseUrl.includes("volces.com") || baseUrl.includes("ark.cn-")) {
    return false;
  }

  return true;
}

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string;
};

function supportsSamplingParameters(provider: string, model: string): boolean {
  if (provider.toLowerCase() === "claude") {
    return false;
  }
  return !/^claude(?:[-_]|$)/i.test(model);
}

export class RoutedChatAPI {
  private readonly apiKey: string;
  private readonly config: RoutedChatConfig;

  constructor(config: RoutedChatConfig, apiKey: string) {
    this.config = config;
    this.apiKey = apiKey;
  }

  async chat(
    messages: RoutedChatMessage[],
    options?: RoutedChatOptions
  ): Promise<RoutedChatResponse> {
    if (!this.isConfigured()) {
      throw new Error(`API key is not configured for provider: ${this.config.provider}`);
    }

    const localizedMessages = localizeLlmMessages(messages);
    if (this.config.protocol === "anthropic" || this.config.protocol === "claude") {
      return this.chatAnthropic(localizedMessages, options);
    }

    return this.chatOpenAI(localizedMessages, options);
  }

  async complete(
    systemPrompt: string,
    userPrompt: string,
    options?: RoutedChatOptions
  ): Promise<string> {
    const response = await this.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      options
    );
    return response.choices[0]?.message?.content || "";
  }

  async generate(
    systemPrompt: string,
    userPrompt: string,
    options?: RoutedChatOptions
  ): Promise<string> {
    return this.complete(systemPrompt, userPrompt, options);
  }

  async extractJSON<T>(
    systemPrompt: string,
    userPrompt: string,
    options?: RoutedChatOptions
  ): Promise<T> {
    const content = await this.complete(systemPrompt, userPrompt, {
      ...options,
      jsonMode: true,
    });
    // [FIX 2026-06-26] Claude advisory JSON 解析失败修复：
    // Claude 偶尔在 JSON 前输出对话性前导文本（如 "我注意到这条消息看起来..."），
    // 或在 JSON 后追加解释。仅剥离 markdown fence 不足以处理这种情况。
    // 修复：先用 fence 剥离，再提取第一个完整 JSON 对象（{ 到匹配的 }）。
    let cleaned = content.replace(/```json\n?|```\n?/g, "").trim();
    // 若整体不是合法 JSON，尝试提取第一个 {...} 块
    if (!this.looksLikeJson(cleaned)) {
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start >= 0 && end > start) {
        cleaned = cleaned.slice(start, end + 1).trim();
      }
    }
    return JSON.parse(cleaned) as T;
  }

  private looksLikeJson(s: string): boolean {
    const t = s.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) return false;
    try {
      JSON.parse(t);
      return true;
    } catch {
      return false;
    }
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  getConfig(): RoutedChatConfig {
    return { ...this.config };
  }

  getModel(): string {
    return this.config.model;
  }

  private async chatOpenAI(
    messages: RoutedChatMessage[],
    options?: RoutedChatOptions
  ): Promise<RoutedChatResponse> {
    const model = options?.model || this.config.model;
    if (this.config.requestOptions?.api === "responses") {
      return callOpenAIResponses(this.config.baseUrl, this.apiKey, model, messages, {
        max_tokens: options?.max_tokens ?? this.config.maxTokens,
        temperature: options?.temperature ?? this.config.temperature,
        jsonMode: options?.jsonMode || options?.response_format?.type === "json_object",
      });
    }
    const request: Record<string, unknown> = {
      model,
      messages,
      temperature: options?.temperature ?? this.config.temperature,
      max_tokens: options?.max_tokens ?? this.config.maxTokens,
      top_p: options?.top_p ?? 0.95,
    };

    const responseFormat = options?.response_format ||
      (options?.jsonMode ? { type: "json_object" as const } : undefined);
    if (responseFormat && supportsJsonResponseFormat(this.config, model)) {
      request.response_format = responseFormat;
    }

    const thinking = options?.thinking ?? this.config.requestOptions?.thinking;
    if (thinking) {
      request.thinking = thinking;
    }

    const response = await fetchWithTimeout(
      joinUrl(this.config.baseUrl, "chat/completions"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(request),
      },
      { label: `${this.config.provider}:${model}` }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `${this.config.provider} API error (${response.status}): ${errorText || response.statusText}`
      );
    }

    const data = (await response.json()) as RoutedChatResponse & {
      choices?: Array<{
        index?: number;
        message?: { role?: string; content?: string; reasoning_content?: string };
        finish_reason?: string;
      }>;
    };

    if (data.choices?.[0]?.message) {
      const message = data.choices[0].message;
      if ((!message.content || message.content.trim() === "") && message.reasoning_content) {
        message.content = message.reasoning_content;
      }
    }

    return data as RoutedChatResponse;
  }

  private async chatAnthropic(
    messages: RoutedChatMessage[],
    options?: RoutedChatOptions
  ): Promise<RoutedChatResponse> {
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const anthropicMessages: AnthropicMessage[] = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      }));

    const model = options?.model || this.config.model;
    const request: Record<string, unknown> = {
      model,
      messages: anthropicMessages.length > 0
        ? anthropicMessages
        : [{ role: "user", content: "" }],
      max_tokens: options?.max_tokens ?? this.config.maxTokens,
      stream: true,
    };
    if (supportsSamplingParameters(this.config.provider, model)) {
      request.temperature = options?.temperature ?? this.config.temperature;
    }
    if (system) {
      request.system = system;
    }
    // Claude Opus 4.8 默认启用 extended thinking，会返回 thinking/tool_use blocks 而非 text。
    // advisory 调用需要纯 JSON 文本输出，显式禁用 thinking 避免空 content。
    const thinking = options?.thinking ?? this.config.requestOptions?.thinking ?? { type: "disabled" as const };
    if (thinking) {
      request.thinking = thinking;
    }

    const response = await fetchWithTimeout(
      joinUrl(this.config.baseUrl, "messages"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
          ...(this.config.requestOptions?.auth === "bearer"
            ? { Authorization: `Bearer ${this.apiKey}` }
            : { "x-api-key": this.apiKey }),
        },
        body: JSON.stringify(request),
      },
      { label: `${this.config.provider}:${model}` }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `${this.config.provider} API error (${response.status}): ${errorText || response.statusText}`
      );
    }

    const data = await parseAnthropicResponse(response, this.config.model);

    return {
      id: data.id,
      model: data.model || this.config.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: data.content?.map((block) => block.text || "").join("") || "",
          },
          finish_reason: data.stop_reason || "stop",
        },
      ],
      usage: data.usage,
    };
  }

}

export async function createRoutedChatAPI(
  agentName: string
): Promise<RoutedChatAPI> {
  const route = await getAgentModelConfig(agentName);
  if (!route) {
    throw new Error(`No model config found for agent route: ${agentName}`);
  }

  // NB-4.0: BenchmarkCostProfile 路由隔离守卫。
  // 在构造 API 前检查 provider 是否被授权，未授权时 hard block。
  assertProviderAuthorized(route.provider, agentName);

  return new RoutedChatAPI(
    {
      agentName,
      provider: route.provider,
      baseUrl: route.base_url,
      model: route.model,
      protocol: route.protocol,
      temperature: route.temperature,
      maxTokens: route.max_tokens,
      requestOptions: route.request_options,
    },
    getApiKey(route.provider) || ""
  );
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
