/**
 * 计费回调客户端（platform 版，R1 改造）
 *
 * 每次 LLM 调用产生上游用量后，Novel Runtime 通过 internal API 向 platform-api 上报，
 * platform-api 在事务中更新 novel_balance_hold / novel_generation_call 账本。
 *
 * 契约对齐 platform-api `modules/internal/internal.controller.ts`（Phase 2）：
 * - POST /internal/billing/settlements  {jobId, callId, internalStage, model, tokensIn, tokensOut}
 *     → {jobId, callId, alreadySettled, actualCharge, settledAmount, remainingBudget}
 *       （金额为「分」的字符串形式，D5 全程整数运算；权威金额由 platform-api 按费率快照计算）
 * - POST /internal/billing/holds/:jobId/finalize  {outcome: "success" | "failure"}
 *     → hold 序列化 {jobId, userId, amount, settledAmount, status, ...}
 * - 认证：x-internal-timestamp / x-internal-signature（HMAC-SHA256，与 HmacGuard 逐字节对齐）
 *
 * 铁律（沿用 02-billing-rules 语义）：
 * - jobId + callId 幂等：重复上报相同 (jobId, callId) 不重复扣费（alreadySettled=true）。
 * - 402 = 预占额度耗尽——返回 budgetExhausted=true（不抛错），调用方据此停止下一次调用。
 * - 网络错误/5xx 抛 SETTLE_FAILED；调用方负责重试（同 jobId+callId 安全）。
 */

import { request } from "undici";
import type { NovelRuntimeConfig } from "./config.js";
import { internalAuthHeaders, stableStringify } from "./internal-hmac.js";

/** 逐调用结算请求（SettleCallDto 契约，字段白名单外字段不上报） */
export interface BillingSettleRequest {
  /** 任务 ID */
  jobId: string;
  /** 调用 ID（幂等键，与模型调用的 callId 一致） */
  callId: string;
  /** 内部 stage 名（chat/agentic_raw/style_optimizer/fact_recheck 等） */
  internalStage: string;
  /** 模型键（model_rates.modelKey；PiNovelStudio 上报的 requestedRoute ?? route） */
  model: string;
  /** 输入 token 用量 */
  tokensIn: number;
  /** 输出 token 用量 */
  tokensOut: number;
}

/** 逐调用结算响应（金额单位：分） */
export interface BillingSettleResponse {
  jobId: string;
  callId: string;
  /** 幂等命中：该 (jobId, callId) 已结算，本次未重复扣费 */
  alreadySettled: boolean;
  /** 本次调用实际扣费（分） */
  actualChargeFen: number;
  /** 任务累计已结算金额（分） */
  settledAmountFen: number;
  /** 预占剩余额度（分） */
  remainingBudgetFen: number;
  /** 预占额度是否耗尽——true 时调用方必须停止下一次模型调用 */
  budgetExhausted: boolean;
}

/** 预占收尾结果 */
export interface BillingFinalizeResult {
  jobId: string;
  userId: number;
  /** 预占总额（分） */
  amountFen: number;
  /** 已结算累计（分） */
  settledAmountFen: number;
  /** active | released | settled */
  status: string;
  /** 重复 finalize 时为 true（幂等，返回当前状态） */
  alreadyFinalized: boolean;
}

/** 计费客户端错误 */
export class BillingClientError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "SETTLE_FAILED"
      | "FINALIZE_FAILED"
      | "BUDGET_EXHAUSTED"
      | "INVALID_RESPONSE"
      | "TIMEOUT",
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = "BillingClientError";
  }
}

export interface BillingClient {
  /**
   * 上报单次模型调用的计费结算。
   * - 幂等：相同 (jobId, callId) 重复上报返回 alreadySettled=true，不重复扣费。
   * - 预占耗尽（402）返回 budgetExhausted=true（不抛错），由调用方决定停止。
   * - 网络错误/5xx 抛 SETTLE_FAILED；调用方负责重试（同 jobId+callId 安全）。
   */
  settle(req: BillingSettleRequest): Promise<BillingSettleResponse>;

  /**
   * 任务收尾：成功（hold 定格 settled）或失败（未结算部分退回余额，hold 转 released）。
   * 幂等：重复 finalize 按 hold 当前状态返回（alreadyFinalized=true）。
   */
  finalize(jobId: string, outcome: "success" | "failure"): Promise<BillingFinalizeResult>;
}

/**
 * 创建计费回调客户端。
 * 单一出口：所有调用只能访问 config.platformApiBaseUrl 的 /internal/*。
 */
export function createBillingClient(
  config: NovelRuntimeConfig,
  options: { maxRetries?: number; timeoutMs?: number } = {},
): BillingClient {
  const baseUrl = config.platformApiBaseUrl;
  if (!baseUrl) {
    throw new BillingClientError(
      "FAIL_CLOSED: PLATFORM_API_BASE_URL not configured",
      "SETTLE_FAILED",
    );
  }
  const maxRetries = options.maxRetries ?? 2;
  const timeoutMs = options.timeoutMs ?? config.llmRequestTimeoutMs;

  /** 带重试的 HMAC 签名 POST（body 用 stableStringify 序列化，签名与发送字节一致） */
  async function signedPost(
    path: string,
    payload: unknown,
    errorCode: "SETTLE_FAILED" | "FINALIZE_FAILED",
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const url = `${baseUrl.replace(/\/$/, "")}${path}`;
    const body = stableStringify(payload);
    const payloadBuf = body === "" ? undefined : body;

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // 每次重试重新签名（时间戳防重放窗口）
        const headers = internalAuthHeaders({
          secret: config.internalApiSecret,
          method: "POST",
          path,
          body,
        });
        const response = await request(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...headers,
          },
          body: payloadBuf,
          signal: controller.signal,
        });
        clearTimeout(timer);
        const parsed = await parseJson(response);
        // 5xx 在循环内重试（HTTP 5xx 不抛网络错误，必须在此判定）；
        // 重试耗尽后返回最后一次响应，由调用方构造带 body 细节的错误。
        if (response.statusCode >= 500 && attempt < maxRetries) {
          lastError = httpError(path, response.statusCode, parsed, errorCode);
          continue;
        }
        return { statusCode: response.statusCode, body: parsed };
      } catch (err: unknown) {
        clearTimeout(timer);
        if (err instanceof BillingClientError) {
          // 仅 5xx 与 TIMEOUT 可重试；4xx 立即抛出
          const retryable = err.code === "TIMEOUT" || err.statusCode >= 500;
          if (retryable && attempt < maxRetries) {
            lastError = err;
            continue;
          }
          throw err;
        }
        if (err instanceof Error && err.name === "AbortError") {
          const timeoutErr = new BillingClientError(
            `TIMEOUT: internal call to ${url} exceeded ${timeoutMs}ms`,
            "TIMEOUT",
            504,
          );
          if (attempt < maxRetries) {
            lastError = timeoutErr;
            continue;
          }
          throw timeoutErr;
        }
        // 其他网络错误可重试
        if (attempt < maxRetries) {
          lastError = err;
          continue;
        }
        throw new BillingClientError(
          `${errorCode}: ${err instanceof Error ? err.message : String(err)}`,
          errorCode,
        );
      }
    }
    throw new BillingClientError(
      `${errorCode}: exhausted ${maxRetries + 1} attempts. Last: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
      errorCode,
    );
  }

  /** 4xx/5xx 统一构造错误（不含 402 耗尽语义，由调用点处理） */
  function httpError(
    path: string,
    statusCode: number,
    body: Record<string, unknown>,
    code: "SETTLE_FAILED" | "FINALIZE_FAILED",
  ): BillingClientError {
    return new BillingClientError(
      `${code}: ${statusCode} from ${path}: ${JSON.stringify(body).slice(0, 300)}`,
      code,
      statusCode,
    );
  }

  return {
    async settle(req: BillingSettleRequest): Promise<BillingSettleResponse> {
      const path = "/internal/billing/settlements";
      const { statusCode, body } = await signedPost(path, req, "SETTLE_FAILED");

      // 402 = 预占额度耗尽——返回耗尽信号，不抛错。
      // 403 必须保留为鉴权/权限失败；把它吞成预算耗尽会掩盖配置错误。
      if (statusCode === 402) {
        return {
          jobId: str(body, "jobId") ?? req.jobId,
          callId: str(body, "callId") ?? req.callId,
          alreadySettled: false,
          actualChargeFen: optionalNum(body, "actualCharge") ?? 0,
          settledAmountFen: optionalNum(body, "settledAmount") ?? 0,
          remainingBudgetFen: optionalNum(body, "remainingBudget") ?? 0,
          budgetExhausted: true,
        };
      }

      if (statusCode >= 400) {
        throw httpError(path, statusCode, body, "SETTLE_FAILED");
      }

      const alreadySettled = bool(body, "alreadySettled") ?? false;
      const responseJobId = str(body, "jobId");
      const responseCallId = str(body, "callId");
      if (responseJobId !== req.jobId || responseCallId !== req.callId) {
        throw new BillingClientError(
          `INVALID_RESPONSE: ${path} response identity does not match request`,
          "INVALID_RESPONSE",
        );
      }
      return {
        jobId: responseJobId,
        callId: responseCallId,
        alreadySettled,
        actualChargeFen: requiredNum(body, "actualCharge", path),
        settledAmountFen: requiredNum(body, "settledAmount", path),
        remainingBudgetFen: requiredNum(body, "remainingBudget", path),
        budgetExhausted: false,
      };
    },

    async finalize(jobId: string, outcome: "success" | "failure"): Promise<BillingFinalizeResult> {
      const path = `/internal/billing/holds/${encodeURIComponent(jobId)}/finalize`;
      const { statusCode, body } = await signedPost(path, { outcome }, "FINALIZE_FAILED");

      if (statusCode >= 400) {
        throw httpError(path, statusCode, body, "FINALIZE_FAILED");
      }

      const responseJobId = str(body, "jobId");
      if (responseJobId !== jobId) {
        throw new BillingClientError(
          `INVALID_RESPONSE: ${path} response jobId does not match request`,
          "INVALID_RESPONSE",
        );
      }
      return {
        jobId: responseJobId,
        userId: requiredNum(body, "userId", path),
        amountFen: requiredNum(body, "amount", path),
        settledAmountFen: requiredNum(body, "settledAmount", path),
        status: str(body, "status") ?? "unknown",
        alreadyFinalized: bool(body, "alreadyFinalized") ?? false,
      };
    },
  };
}

async function parseJson(
  response: Awaited<ReturnType<typeof request>>,
): Promise<Record<string, unknown>> {
  const text = await response.body.text();
  if (!text) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new BillingClientError(
        "INVALID_RESPONSE: internal response must be a JSON object",
        "INVALID_RESPONSE",
      );
    }
    return parsed as Record<string, unknown>;
  } catch {
    if (text.trim() === "null") {
      throw new BillingClientError(
        "INVALID_RESPONSE: internal response must be a JSON object",
        "INVALID_RESPONSE",
      );
    }
    throw new BillingClientError(
      `INVALID_RESPONSE: non-JSON internal response: ${text.slice(0, 300)}`,
      "INVALID_RESPONSE",
    );
  }
}

/** 解析非负安全整数；拒绝部分解析、浮点数、指数和超出安全范围的值。 */
function parseSafeInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

function optionalNum(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key];
  return parseSafeInteger(v);
}

function requiredNum(
  body: Record<string, unknown>,
  key: string,
  path: string,
): number {
  const parsed = optionalNum(body, key);
  if (parsed === undefined) {
    throw new BillingClientError(
      `INVALID_RESPONSE: ${path} field ${key} must be a non-negative safe integer`,
      "INVALID_RESPONSE",
    );
  }
  return parsed;
}

function str(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" ? v : undefined;
}

function bool(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  return typeof v === "boolean" ? v : undefined;
}
