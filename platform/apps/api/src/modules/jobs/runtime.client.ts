/**
 * novel-runtime 调用口：http 模式 POST /v1/invoke；stub 模式由 JobsService 内联。
 */
import { Injectable } from '@nestjs/common';
import { env } from '../../config/env';

export interface RuntimeInvokeResult {
  status: string;
  result: { text?: string; chapterId?: string } | unknown;
  jobId?: string;
  /** Runtime-side authoritative metering summary for the completed invocation. */
  metering?: {
    modelCallCount?: number;
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
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    const body = (await response.json()) as RuntimeInvokeResult;
    if (!response.ok) {
      throw new Error(
        `runtime invoke ${response.status}: ${JSON.stringify(body).slice(0, 300)}`,
      );
    }
    return body;
  }
}
