/**
 * OpenAI-compatible SSE response parser for long-form generation.
 */

export async function parseOpenAIStream(
  response: Response,
  model: string,
): Promise<{
  choices: Array<{
    message: { role: "assistant"; content: string; reasoning_content?: string };
    finish_reason: string;
  }>;
}> {
  if (!response.body) throw new Error(`OpenAI stream has no body: ${model}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        let chunk: any;
        try { chunk = JSON.parse(raw); } catch { continue; }
        const choice = chunk?.choices?.[0];
        const delta = choice?.delta;
        if (typeof delta?.content === "string") content += delta.content;
        if (typeof delta?.reasoning_content === "string") reasoning += delta.reasoning_content;
        if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (!content && !reasoning) throw new Error(`OpenAI stream returned no content: ${model}`);
  return {
    choices: [{
      message: {
        role: "assistant",
        content,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      },
      finish_reason: finishReason,
    }],
  };
}
