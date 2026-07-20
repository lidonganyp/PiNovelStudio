/**
 * PiNovelStudio — GLM API 封装
 *
 * 用于 Narrator 主力模型和 CharacterAgent 的文学化生成
 * 基于 OpenAI 兼容接口协议（智谱AI）
 */

import {
  getAgentModelConfig,
  getApiKey,
  getProviderDefaultConfig,
  type ProviderRequestOptions,
} from "../utils/config.js";
import { localizeLlmMessages } from "../utils/llm-language-guard.js";
import { fetchWithTimeout } from "./request-timeout.js";

export interface GLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GLMRequest {
  model: string;
  messages: GLMMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  thinking?: {
    type: "enabled" | "disabled";
    reasoning_effort?: "high" | "mid" | "low";
  };
}

export interface GLMResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: GLMMessage;
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface GLMError {
  error: {
    message: string;
    type: string;
    code: string;
  };
}

export class GLMAPI {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private requestOptions?: ProviderRequestOptions;
  private defaultTemperature = 0.7;
  private defaultMaxTokens = 8192;

  constructor(options?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  }) {
    const defaults = getProviderDefaultConfig("glm");
    this.apiKey = options?.apiKey || defaults.apiKey;
    this.baseUrl = options?.baseUrl || defaults.base_url;
    this.model = options?.model || defaults.model;
    this.requestOptions = defaults.request_options;
  }

  async chat(
    messages: GLMMessage[],
    options?: {
      temperature?: number;
      max_tokens?: number;
      model?: string;
      thinking?: ProviderRequestOptions["thinking"];
    }
  ): Promise<GLMResponse> {
    const url = `${this.baseUrl}/chat/completions`;

    const request: GLMRequest = {
      model: options?.model || this.model,
      messages: localizeLlmMessages(messages),
      temperature: options?.temperature ?? this.defaultTemperature,
      max_tokens: options?.max_tokens ?? this.defaultMaxTokens,
    };

    // 默认禁用思考模式（快速响应）
    const thinking = options?.thinking ?? this.requestOptions?.thinking;
    if (thinking) {
      request.thinking = thinking;
    }

    try {
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
        { label: `GLM:${request.model}` }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage = `GLM API 请求失败 (${response.status})`;
        try {
          const parsed = JSON.parse(errorBody) as GLMError;
          errorMessage = parsed.error?.message || errorMessage;
        } catch {
          errorMessage += `: ${errorBody.substring(0, 200)}`;
        }
        throw new Error(errorMessage);
      }

      const data = (await response.json()) as GLMResponse;
      return data;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`GLM API 调用异常: ${String(error)}`);
    }
  }

  async generate(
    systemPrompt: string,
    userPrompt: string,
    options?: {
      temperature?: number;
      max_tokens?: number;
    }
  ): Promise<string> {
    const messages: GLMMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const response = await this.chat(messages, options);

    if (response.choices && response.choices.length > 0) {
      return response.choices[0].message.content;
    }

    throw new Error("GLM API 返回空响应");
  }

  getModel(): string {
    return this.model;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }
}

export function createGLMAPI(options?: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}): GLMAPI {
  return new GLMAPI(options);
}
