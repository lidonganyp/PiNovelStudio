/**
 * PiNovelStudio API request timeout helpers.
 *
 * Model calls must fail with actionable evidence instead of waiting forever.
 */

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

  try {
    // Race the aborting fetch against a caller-side deadline. Some Node/proxy
    // paths ignore AbortSignal and would otherwise wait for Cloudflare 524.
    return await withTimeout(
      fetch(url, {
        ...init,
        signal: controller.signal,
      }),
      timeoutMs,
      options.label,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (controller.signal.aborted || message.includes("timed out after")) {
      throw new Error(`${options.label} timed out after ${timeoutMs}ms`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
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
