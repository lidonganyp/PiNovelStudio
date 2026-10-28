/**
 * PiNovelStudio API request timeout helpers.
 *
 * Model calls must fail with actionable evidence instead of waiting forever.
 */

import { createHash, randomUUID } from 'node:crypto';
import { currentModelTransport } from './transport-scope.js';
export { runWithModelTransportHooks } from './transport-scope.js';
const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 300_000;

export interface RequestTimeoutOptions {
  label: string;
  timeoutMs?: number;
}

export function getModelRequestTimeoutMs(): number {
  const forced = process.env.PINOVEL_FORCE_REQUEST_TIMEOUT_MS;
  if (forced) {
    const forcedParsed = Number.parseInt(forced, 10);
    if (Number.isFinite(forcedParsed) && forcedParsed > 0) {
      return forcedParsed;
    }
  }

  const raw = process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
  }

  return parsed;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  options: RequestTimeoutOptions
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? getModelRequestTimeoutMs();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const scope = currentModelTransport();
  const signals = [controller.signal, init.signal, scope.hooks?.signal].filter((s): s is AbortSignal => Boolean(s));
  const signal = AbortSignal.any(signals);
  let callId: string | undefined;
  let accounted = false;
  let reserved = false;
  try {
    if (scope.hooks) {
      const body = typeof init.body === 'string' ? init.body : '';
      const request = JSON.parse(body) as Record<string, unknown>;
      const outputTokenLimit = Number(request.max_tokens ?? request.max_completion_tokens ?? request.max_output_tokens);
      if (!scope.route || !Number.isSafeInteger(outputTokenLimit) || outputTokenLimit <= 0) throw new Error('model transport requires an explicit route and output limit');
      signal.throwIfAborted();
      callId = randomUUID();
      await scope.hooks.reserve({ callId, route: scope.route, model: String(request.model),
        requestHash: createHash('sha256').update(`${url}\n${body}`).digest('hex'),
          inputTokenLimit: Buffer.byteLength(body, 'utf8') + 8192, outputTokenLimit, recovery: scope.recovery });
      reserved = true;
    }
    signal.throwIfAborted();
    // Race the aborting fetch against a caller-side deadline. Some Node/proxy
    // paths ignore AbortSignal and would otherwise wait for Cloudflare 524.
    return await withTimeout((async () => {
      const response = await fetch(url, {
        ...init,
        signal,
      });
      // Keep the same deadline through SSE/JSON body consumption. Backend
      // parsers still receive an ordinary Response with the original bytes.
      const body = await response.arrayBuffer();
      if (scope.hooks && callId) {
        const usage = readTransportUsage(new TextDecoder().decode(body));
        await scope.hooks.settle({ callId, ...usage, status: response.status });
        accounted = true;
        if (response.ok && !usage) throw new Error('provider returned no authoritative token usage');
      }
      return new Response(response.body === null ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
    })(),
      timeoutMs,
      options.label,
    );
  } catch (error) {
    if (scope.hooks && callId && reserved && !accounted) await scope.hooks.settle({ callId, status: 0 });
    const message = error instanceof Error ? error.message : String(error);
    if (controller.signal.aborted || message.includes("timed out after")) {
      throw new Error(`${options.label} timed out after ${timeoutMs}ms`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    controller.abort();
    clearTimeout(timeoutId);
  }
}

function readTransportUsage(body: string): { tokensIn: number; tokensOut: number } | undefined {
  let tokensIn: number | undefined; let tokensOut: number | undefined;
  const values: unknown[] = [];
  try { values.push(JSON.parse(body)); } catch {
    for (const line of body.split(/\r?\n/)) {
      if (line.startsWith('data:')) { try { values.push(JSON.parse(line.slice(5).trim())); } catch { /* SSE sentinel or non-data event */ } }
    }
  }
  for (const value of values) {
    const row = value as { usage?: Record<string, unknown>; message?: { usage?: Record<string, unknown> }; response?: { usage?: Record<string, unknown> } };
    const usage = row?.usage ?? row?.message?.usage ?? row?.response?.usage;
    if (!usage) continue;
    const input = usage.prompt_tokens ?? usage.input_tokens;
    const output = usage.completion_tokens ?? usage.output_tokens;
    if (typeof input === 'number') tokensIn = input;
    if (typeof output === 'number') tokensOut = output;
  }
  return Number.isSafeInteger(tokensIn) && Number.isSafeInteger(tokensOut) && tokensIn! >= 0 && tokensOut! >= 0
    ? { tokensIn: tokensIn!, tokensOut: tokensOut! } : undefined;
}

/**
 * P40-T12-D: 通用 Promise 超时包装。
 *
 * 用于给单次 LLM 调用（或聚合操作）加 bounded timeout，避免章节级 600s timeout
 * 在 in-flight fetch 期间 fire 产生粗粒度合成 envelope。底层 Promise 不会被真正
 * abort（需 AbortSignal 透传，v1 不做），但本函数会尽早 reject 并释放调用方，
 * 让上层 catch 抛出结构化 Stage2BlockError 走 event-level rewrite / bounded abort 链路。
 *
 * 注意：timeout fire 后底层 Promise 仍可能 pending，调用方不应依赖其副作用。
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
