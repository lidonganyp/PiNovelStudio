/**
 * PiNovelStudio — Claude API 封装
 *
 * 用于 Critic Agent 的质量审查
 */

import { getAgentModelConfig, getApiKey, getProviderDefaultConfig } from "../utils/config.js";
import { localizeLlmMessages, localizeLlmText } from "../utils/llm-language-guard.js";
import { fetchWithTimeout } from "./request-timeout.js";

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ClaudeRequest {
  model: string;
  messages: ClaudeMessage[];
  temperature?: number;
  max_tokens?: number;
  system?: string;
}

export interface ClaudeResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{
    type: string;
    text?: string;
  }>;
  model: string;
  stop_reason: string;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export class ClaudeAPI {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private defaultTemperature = 0;
  private defaultMaxTokens = 4096;

  constructor(options?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  }) {
    const defaults = getProviderDefaultConfig("claude");
    this.apiKey = options?.apiKey || defaults.apiKey;
    this.baseUrl = options?.baseUrl || defaults.base_url;
    this.model = options?.model || defaults.model;
  }

  /**
   * 发送消息
   */
  async message(
    messages: ClaudeMessage[],
    options?: {
      temperature?: number;
      max_tokens?: number;
      system?: string;
      model?: string;
    }
  ): Promise<ClaudeResponse> {
    const url = `${this.baseUrl}/messages`;

    const request: ClaudeRequest = {
      model: options?.model || this.model,
      messages: localizeLlmMessages(messages),
      temperature: options?.temperature ?? this.defaultTemperature,
      max_tokens: options?.max_tokens ?? this.defaultMaxTokens,
      system: options?.system ? localizeLlmText(options.system) : undefined,
    };

    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(request),
      },
      { label: `Claude:${request.model}` }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude API error: ${errorText || response.statusText}`);
    }

    return (await response.json()) as ClaudeResponse;
  }

  /**
   * 同步调用（包装器）
   */
  async complete(
    systemPrompt: string,
    userPrompt: string,
    options?: {
      temperature?: number;
      max_tokens?: number;
    }
  ): Promise<string> {
    const messages: ClaudeMessage[] = [
      { role: "user", content: userPrompt },
    ];

    const response = await this.message(messages, {
      temperature: options?.temperature ?? 0,
      max_tokens: options?.max_tokens ?? 4096,
      system: systemPrompt,
    });

    return response.content[0]?.text || "";
  }

  /**
   * 获取当前配置
   */
  getConfig(): { baseUrl: string; model: string } {
    return {
      baseUrl: this.baseUrl,
      model: this.model,
    };
  }
}

/**
 * 创建 Claude API 实例
 */
export async function createClaudeAPI(agentName: string): Promise<ClaudeAPI> {
  const config = await getAgentModelConfig(agentName);
  if (!config) {
    throw new Error(`No model config found for agent: ${agentName}`);
  }

  return new ClaudeAPI({
    apiKey: getApiKey(config.provider) || undefined,
    baseUrl: config.base_url,
    model: config.model,
  });
}
