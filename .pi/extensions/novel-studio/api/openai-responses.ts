/** Responses transport for text-based orchestration, with bounded body consumption. */
import type { GLMResponse } from "./glm.js";
import { getModelRequestTimeoutMs, withTimeout } from "./request-timeout.js";
import { getProviderDefaultConfig } from "../utils/config.js";

export function usesConfiguredResponsesEndpoint(baseUrl: string): boolean {
  const provider = getProviderDefaultConfig("gpt");
  return provider.request_options?.api === "responses"
    && provider.base_url.replace(/\/+$/, "") === baseUrl.replace(/\/+$/, "");
}

interface ResponsesPayload {
  id?: string;
  model?: string;
  created_at?: number;
  status?: string;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: Array<{
    type: string;
    role?: string;
    content?: Array<{ type: string; text?: string; refusal?: string }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

export async function callOpenAIResponses(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  options?: { max_tokens?: number; jsonMode?: boolean; timeoutMs?: number },
): Promise<GLMResponse> {
  const timeoutMs = options?.timeoutMs ?? getModelRequestTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const request = {
    model,
    input: options?.jsonMode && !messages.some((message) => /json/i.test(message.content))
      ? [...messages, { role: "user", content: "请仅返回合法 JSON 对象。" }]
      : messages,
    max_output_tokens: options?.max_tokens ?? 16384,
    store: false,
    ...(options?.jsonMode ? { text: { format: { type: "json_object" } } } : {}),
  };
  try {
    const payload = await withTimeout((async (): Promise<ResponsesPayload> => {
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Responses API error (${response.status}): ${(await response.text()).slice(0, 200)}`);
      }
      return await response.json() as ResponsesPayload;
    })(), timeoutMs, `Responses:${model}`);
    if (payload.error || payload.status !== "completed") {
      throw new Error(`Responses API ${payload.status ?? "missing status"}: ${payload.error?.message ?? payload.incomplete_details?.reason ?? "response did not complete"}`);
    }
    const content = (payload.output ?? [])
      .filter((item) => item.type === "message" && item.role === "assistant")
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === "output_text")
      .map((part) => part.text ?? "")
      .join("");
    if (!content.trim()) throw new Error("Responses API returned no assistant output text");
    return {
      id: payload.id ?? "",
      object: "chat.completion",
      created: payload.created_at ?? Math.floor(Date.now() / 1000),
      model: payload.model ?? model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: payload.usage?.input_tokens ?? 0,
        completion_tokens: payload.usage?.output_tokens ?? 0,
        total_tokens: payload.usage?.total_tokens ?? 0,
        ...{ prompt_tokens_details: payload.usage?.input_tokens_details, completion_tokens_details: payload.usage?.output_tokens_details },
      },
    };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Responses:${model} timed out after ${timeoutMs}ms`, { cause: error });
    throw error;
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}
