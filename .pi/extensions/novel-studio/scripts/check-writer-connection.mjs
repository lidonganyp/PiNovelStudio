/** One bounded live request through the production writer transport; no novel prose or state writes. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { setProjectRoot, reloadProjectEnv, getAgentModelConfig } = await import(
  pathToFileURL(resolve(extensionRoot, 'dist/utils/config.js')).href);
setProjectRoot(resolve(extensionRoot, '../../..'));
reloadProjectEnv();
const { createAPIFallbackManager } = await import(
  pathToFileURL(resolve(extensionRoot, 'dist/api/fallback-manager.js')).href);
const route = 'v2_rawstage2_gemini31';
const started = Date.now();
try {
  const config = await getAgentModelConfig(route);
  if (!config) throw new Error('Writer route is not configured');
  console.log(JSON.stringify({ model: config.model, endpoint: config.base_url, protocol: config.protocol }));
  const result = await createAPIFallbackManager({ maxRetries: 0, totalTimeoutMs: 60000 })
    .callWithFallback(route, [
      { role: 'system', content: '这是接口连通性检查，不生成小说。只回复 OK。' },
      { role: 'user', content: '只回复 OK' },
    ], { max_tokens: 128, timeoutMs: 60000 });
  const text = result.response.choices?.[0]?.message?.content;
  if (!text?.trim()) throw new Error('API returned no usable text');
  console.log(JSON.stringify({ success: true, requestedModel: result.usedModel,
    reportedModel: result.response.model ?? null, durationMs: Date.now() - started,
    finishReason: result.response.choices[0].finish_reason, usage: result.response.usage,
    reply: text.trim().slice(0, 100) }));
} catch (error) {
  // Avoid exposing gateway error bodies or credential-bearing request details.
  const message = String(error instanceof Error ? error.message : error);
  const status = message.match(/\b[45]\d\d\b/)?.[0];
  console.error(JSON.stringify({ success: false, status: status ?? null,
    error: /timeout|timed out/i.test(message) ? 'request_timeout' : 'writer_request_failed',
    durationMs: Date.now() - started }));
  process.exitCode = 1;
}
