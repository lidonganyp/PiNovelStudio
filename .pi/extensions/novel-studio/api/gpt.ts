/**
 * PiNovelStudio — GPT API 封装
 *
 * 用于 Anti-AI Detector 的结构化检查
 */

import { getAgentModelConfig, getApiKey, getProviderDefaultConfig } from "../utils/config.js";
import { fetchWithTimeout } from "./request-timeout.js";
import { callOpenAIResponses } from "./openai-responses.js";
import { localizeLlmMessages } from "../utils/llm-language-guard.js";

export interface GPTMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GPTRequest {
  model: string;
  messages: GPTMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  response_format?: { type: "json_object" | "text" };
}

export interface GPTResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: GPTMessage;
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface GPTError {
  error: {
    message: string;
    type: string;
    code: string;
  };
}

export class GPTAPI {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private readonly api?: "responses";
  private defaultTemperature = 0;
  private defaultMaxTokens = 2048;

  constructor(options?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    api?: "responses";
  }) {
    const defaults = getProviderDefaultConfig("gpt");
    this.apiKey = options?.apiKey || defaults.apiKey;
    this.baseUrl = options?.baseUrl || defaults.base_url;
    this.model = options?.model || defaults.model;
    this.api = options?.api ?? (this.baseUrl === defaults.base_url ? defaults.request_options?.api : undefined);
  }

  /**
   * 发送聊天补全请求
   */
  async chat(
    messages: GPTMessage[],
    options?: {
      temperature?: number;
      max_tokens?: number;
      model?: string;
      response_format?: { type: "json_object" | "text" };
    }
  ): Promise<GPTResponse> {
    if (this.api === "responses") {
      return callOpenAIResponses(this.baseUrl, this.apiKey, options?.model || this.model, localizeLlmMessages(messages), {
        max_tokens: options?.max_tokens ?? this.defaultMaxTokens,
        jsonMode: options?.response_format?.type === "json_object",
      });
    }
    const url = `${this.baseUrl}/chat/completions`;

    const request: GPTRequest = {
      model: options?.model || this.model,
      messages: localizeLlmMessages(messages),
      temperature: options?.temperature ?? this.defaultTemperature,
      max_tokens: options?.max_tokens ?? this.defaultMaxTokens,
      top_p: 0.95,
      response_format: options?.response_format,
    };

    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(request),
      },
      { label: `GPT:${request.model}` }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      let errorMessage = response.statusText;
      try {
        const errorData = JSON.parse(errorText) as GPTError;
        errorMessage = errorData.error?.message || response.statusText;
      } catch {
        errorMessage = errorText.substring(0, 200) || response.statusText;
      }
      throw new Error(`GPT API error: ${errorMessage}`);
    }

    return (await response.json()) as GPTResponse;
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
      jsonMode?: boolean;
    }
  ): Promise<string> {
    const messages: GPTMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const response = await this.chat(messages, {
      temperature: options?.temperature ?? 0,
      max_tokens: options?.max_tokens ?? 2048,
      response_format: options?.jsonMode ? { type: "json_object" } : undefined,
    });

    return response.choices[0]?.message?.content || "";
  }

  /**
   * 提取结构化 JSON
   */
  async extractJSON<T>(
    systemPrompt: string,
    userPrompt: string,
    options?: {
      temperature?: number;
      max_tokens?: number;
    }
  ): Promise<T> {
    const content = await this.complete(systemPrompt, userPrompt, {
      ...options,
      jsonMode: true,
    });

    try {
      const cleaned = content.replace(/```json\n?|```\n?/g, "").trim();
      return JSON.parse(cleaned) as T;
    } catch {
      throw new Error(`Failed to parse JSON response: ${content.substring(0, 200)}`);
    }
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
 * 创建 GPT API 实例
 */
export async function createGPTAPI(agentName: string): Promise<GPTAPI> {
  const config = await getAgentModelConfig(agentName);
  if (!config) {
    throw new Error(`No model config found for agent: ${agentName}`);
  }

  return new GPTAPI({
    apiKey: getApiKey(config.provider) || undefined,
    baseUrl: config.base_url,
    model: config.model,
    api: config.request_options?.api,
  });
}
