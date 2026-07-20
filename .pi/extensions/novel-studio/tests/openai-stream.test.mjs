/** OpenAI-compatible SSE parsing regression test. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOpenAIStream } from "../dist/api/openai-stream.js";

test("parseOpenAIStream aggregates content and reasoning deltas", async () => {
  const payload = [
    'data: {"choices":[{"delta":{"reasoning_content":"思考"},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"content":"第一段"},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"content":"第二段"},"finish_reason":"stop"}]}',
    "data: [DONE]",
    "",
  ].join("\n");
  const response = new Response(payload, { headers: { "content-type": "text/event-stream" } });
  assert.deepEqual(await parseOpenAIStream(response, "gpt-5.6-sol"), {
    choices: [{ message: { role: "assistant", content: "第一段第二段", reasoning_content: "思考" }, finish_reason: "stop" }],
  });
});
