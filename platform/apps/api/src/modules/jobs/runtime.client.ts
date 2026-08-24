/**
 * novel-runtime 调用口：http 模式 POST /v1/invoke；stub 模式由 JobsService 内联。
 */
import { Injectable } from '@nestjs/common';
import { env } from '../../config/env';
import { runtimeInvokeFailure } from './job-failure';

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

  /** 调用 novel-runtime 生成工具。 */
  async invoke(
    token: string,
    tool: string,
    input: Record<string, unknown>,
  ): Promise<RuntimeInvokeResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();
    let response: Response;
    try {
      response = await fetch(
        `${env.NOVEL_RUNTIME_BASE_URL.replace(/\/$/, '')}/v1/invoke`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-novel-task-token': token,
          },
          body: JSON.stringify({ tool, input }),
          signal: controller.signal,
        },
      );
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        throw new Error(`runtime invoke timed out after ${this.requestTimeoutMs}ms`);
      }
      throw new Error(describeRuntimeFetchFailure(env.NOVEL_RUNTIME_BASE_URL, error));
    } finally {
      clearTimeout(timeout);
    }
    const body = (await response.json()) as RuntimeInvokeResult & {
      metering?: { modelCallCount?: number };
    };
    if (!response.ok) {
      throw runtimeInvokeFailure(body, body.metering?.modelCallCount);
    }
    return body;
  }
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
