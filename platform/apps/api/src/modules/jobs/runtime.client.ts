/**
 * novel-runtime 调用口：http 模式 POST /v1/invoke；stub 模式由 JobsService 内联。
 */
import { Injectable } from '@nestjs/common';
import { request } from 'undici';
import { env } from '../../config/env';
import { JobFailureError, runtimeInvokeFailure } from './job-failure';

export interface RuntimeInvokeResult {
  status: string;
  result: { text?: string; chapterId?: string } | unknown;
  jobId?: string;
  /** Runtime-side authoritative metering summary for the completed invocation. */
  metering?: {
    modelCallCount?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalSettledAmountFen?: number;
  };
}

@Injectable()
export class RuntimeClient {
  private requestTimeoutMs = env.NOVEL_RUNTIME_REQUEST_TIMEOUT_MS;
  /** A runtime restart can leave a short connection-refused window. */
  private maxAttempts = 2;
  private retryDelayMs = 150;

  /** 调用 novel-runtime 生成工具。 */
  async invoke(
    token: string,
    tool: string,
    input: Record<string, unknown>,
    timeoutMs?: number,
    durable = false,
    refreshToken?: () => Promise<string>,
  ): Promise<RuntimeInvokeResult> {
    const deadlineMs = timeoutMs === undefined ? this.requestTimeoutMs : Math.min(this.requestTimeoutMs, Math.max(1, timeoutMs));
    const url = `${env.NOVEL_RUNTIME_BASE_URL.replace(/\/$/, '')}/v1/invoke`;
    const deadlineAt = Date.now() + deadlineMs;
    for (let attempt = 1; durable || attempt <= this.maxAttempts; attempt += 1) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) throw new Error(`runtime invoke timed out after ${deadlineMs}ms`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), remainingMs);
      timeout.unref?.();
      try {
        const requestToken = durable && attempt > 1 && refreshToken ? await refreshToken() : token;
        // Native fetch has a separate 300s header deadline, shorter than a full
        // Agentic + style run. Use the configured budget for every HTTP phase.
        const response = await request(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-novel-task-token': requestToken,
            ...(durable ? { 'x-novel-durable-invoke': '1', 'x-novel-deadline-at': String(deadlineAt) } : {}),
          },
          body: JSON.stringify({ tool, input }),
          signal: controller.signal,
          headersTimeout: remainingMs,
          bodyTimeout: remainingMs,
        });
        const body = (await response.body.json()) as RuntimeInvokeResult & {
          metering?: { modelCallCount?: number };
          code?: string;
        };
        if (durable && response.statusCode === 409 && body.code === 'INVOCATION_RUNNING') {
          await waitFor(Math.min(1000, Math.max(0, deadlineAt - Date.now())));
          continue;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw runtimeInvokeFailure(body, body.metering?.modelCallCount);
        }
        return body;
      } catch (error: unknown) {
        if (controller.signal.aborted) {
          throw new Error(`runtime invoke timed out after ${deadlineMs}ms`);
        }
        if ((durable && !(error instanceof JobFailureError) && isRetryableNetworkFailure(error))
          || (attempt < this.maxAttempts && isRetryableConnectFailure(error))) {
          await waitFor(this.retryDelayMs);
          continue;
        }
        if (error instanceof JobFailureError) throw error;
        throw new Error(describeRuntimeFetchFailure(env.NOVEL_RUNTIME_BASE_URL, error));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error('runtime invoke failed without an attempt');
  }
}

function isRetryableNetworkFailure(error: unknown): boolean {
  const cause = error instanceof Error && 'cause' in error ? error.cause : error;
  const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
  return /^(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/.test(code);
}

function waitFor(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

/** Retrying is safe only when the TCP connection was never established. */
function isRetryableConnectFailure(error: unknown): boolean {
  const cause = error instanceof Error && 'cause' in error
    ? (error as { cause?: unknown }).cause
    : error;
  const code = cause && typeof cause === 'object' && 'code' in cause
    ? (cause as { code?: unknown }).code
    : undefined;
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH';
}

export function describeRuntimeFetchFailure(baseUrl: string, error: unknown): string {
  const cause =
    error instanceof Error && 'cause' in error
      ? (error as { cause?: unknown }).cause
      : undefined;
  const details = [error instanceof Error ? error.message : String(error)];
  if (cause instanceof Error && cause.message) details.push(cause.message);
  const joined = details.join(' ');
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|ECONNRESET/i.test(joined)) {
    return `无法连接章节生成运行时（${baseUrl}）。请确认 novel-runtime 已启动。`;
  }
  return `runtime invoke failed: ${joined}`.slice(0, 1000);
}
