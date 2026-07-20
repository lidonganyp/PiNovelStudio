/**
 * Anthropic streaming response parser.
 *
 * Long Claude generations use SSE so proxies receive response bytes before
 * their non-streaming gateway timeout. JSON responses remain supported for
 * providers that ignore the stream flag.
 */

import { getModelRequestTimeoutMs } from "./request-timeout.js";

export interface AnthropicParsedResponse {
  id?: string;
  model?: string;
  content: Array<{ type: string; text?: string }>;
  stop_reason: string;
  usage?: Record<string, unknown>;
}

type AnthropicStreamEvent = {
  type?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: Record<string, unknown>;
  };
  content_block?: { type?: string; text?: string };
  delta?: { type?: string; text?: string; stop_reason?: string };
  usage?: Record<string, unknown>;
  error?: { message?: string; type?: string };
};

export async function parseAnthropicResponse(
  response: Response,
  fallbackModel: string,
): Promise<AnthropicParsedResponse> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream")) {
    return (await response.json()) as AnthropicParsedResponse;
  }

  if (!response.body) {
    throw new Error("Anthropic streaming response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const timeoutMs = getModelRequestTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  let buffer = "";
  let id: string | undefined;
  let model = fallbackModel;
  let stopReason = "stop";
  let usage: Record<string, unknown> | undefined;
  let text = "";

  const applyEvent = (event: AnthropicStreamEvent): void => {
    if (event.type === "error") {
      throw new Error(`Anthropic stream error: ${event.error?.message || event.error?.type || "unknown error"}`);
    }
    if (event.type === "message_start") {
      id = event.message?.id ?? id;
      model = event.message?.model ?? model;
      usage = event.message?.usage ?? usage;
      return;
    }
    if (event.type === "content_block_start" && event.content_block?.type === "text") {
      text += event.content_block.text ?? "";
      return;
    }
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      text += event.delta.text ?? "";
      return;
    }
    if (event.type === "message_delta") {
      stopReason = event.delta?.stop_reason ?? stopReason;
      usage = { ...(usage ?? {}), ...(event.usage ?? {}) };
    }
  };

  const drainBuffer = (flush: boolean): void => {
    buffer = buffer.replace(/\r\n/g, "\n");
    const blocks = buffer.split("\n\n");
    buffer = flush ? "" : blocks.pop() ?? "";
    for (const block of blocks) {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!data || data === "[DONE]") continue;
      applyEvent(JSON.parse(data) as AnthropicStreamEvent);
    }
  };

  try {
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`Anthropic stream timed out after ${timeoutMs}ms`);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Anthropic stream timed out after ${timeoutMs}ms`)),
          remainingMs,
        );
      });
      try {
        const { done, value } = await Promise.race([reader.read(), timeout]);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        drainBuffer(false);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      buffer += "\n\n";
      drainBuffer(true);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  return {
    ...(id ? { id } : {}),
    model,
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    ...(usage ? { usage } : {}),
  };
}
