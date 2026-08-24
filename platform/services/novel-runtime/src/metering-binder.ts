/**
 * 计费结算绑定器（platform 版，R6 改造）
 *
 * 把 `billingClient.settle()` 接入生产 invoke 链路。
 *
 * 工作流程：
 *   1. 包装 `tool.invoke(input)`，捕获返回结果中的 `modelCalls` 数组
 *      （PiNovelStudio 统一编排器在 stageResults.modelCalls 中上报每次模型调用）
 *   2. 为每条 modelCall 生成稳定的 callId（jobId + ts + idx），按 ts 序逐条调用
 *      `billingClient.settle()` 上报 token 用量（金额由 platform-api 按费率快照权威计算）
 *   3. 任一 settle 返回 `budgetExhausted=true` 时记录到 meteringResult 并中止后续 settle
 *   4. settle 失败（网络/5xx）记录为 settleError 并拒绝成功交付，避免出现未计费的成功章节
 *
 * 契约对齐 platform-api /internal/billing/settlements（SettleCallDto）：
 *   请求 = {jobId, callId, internalStage, model, tokensIn, tokensOut}（金额不上报）
 *   响应 = {alreadySettled, actualCharge, settledAmount, remainingBudget}（分为单位的字符串）
 *
 * 重要约束：
 *   - 计费失败不得伪装成成功交付：已成功结算的调用保留，整次 invoke 走失败收尾
 *   - budgetExhausted 中止后续 settle（P0-7），本次已生成内容不回滚
 *   - callId 必须幂等：相同 (jobId, modelCall.ts, idx) 重复 settle 不重复扣费
 *   - pricingTable 仅用于日志层诊断粗估（可选），不参与上报金额
 */

import type * as pino from "pino";
import type { BillingClient, BillingSettleRequest, BillingSettleResponse } from "./billing-client.js";
import type { PricingTable } from "./pricing-table.js";
import { estimateActualCharge } from "./pricing-table.js";

/** PiNovelStage → internal_stage 映射（与 platform-api 计费阶段对齐） */
const PI_NOVEL_STAGE_TO_INTERNAL_STAGE: Record<string, string> = {
  chat: "chat",
  outline: "outline",
  // NovelOS Agentic 初稿
  agentic_raw: "agentic_raw",
  // 作者风格整章优化
  style_optimizer: "style_optimizer",
  // 事实复检
  fact_recheck: "fact_recheck",
  // 状态提交与保存
  save_commit: "save_commit",
};

/**
 * PiNovelStudio 上报的 modelCall 条目（与 PiNovelStudio ModelCallEntry 对齐，部分字段可选）
 * 字段定义来自 .pi/extensions/novel-studio/dist/v2/core/orchestrator-types.d.ts
 */
export interface PiNovelModelCallEntry {
  route: string;
  kind: string;
  durationMs: number;
  ts: number;
  tokenUsage?: "unknown" | { in: number; out: number };
  failed?: boolean;
  provider?: string;
  requestedRoute?: string;
  failurePhase?: "model.generate" | "model.judge";
}

/** PiNovelStudio 工具返回结果的最小契约（只关心 modelCalls 字段） */
export interface PiNovelInvokeResult {
  status?: string;
  stageResults?: {
    modelCalls?: PiNovelModelCallEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** meteringBinder 处理单次 invoke 的结算结果摘要 */
export interface MeteringResult {
  /** 本次 invoke 触发的模型调用数 */
  modelCallCount: number;
  /** Sum of provider-reported usage for this invocation. */
  inputTokens: number;
  outputTokens: number;
  /** 成功 settle 的数量（含幂等命中） */
  settledCount: number;
  /** 幂等命中（alreadySettled）的数量 */
  alreadySettledCount: number;
  /** 预占耗尽（budgetExhausted）的数量 */
  budgetExhaustedCount: number;
  /** 本次 invoke 累计结算金额（分，platform-api 权威值） */
  totalSettledAmountFen: number;
  /** 预占剩余额度（分，最后一次 settle 响应值） */
  remainingBudgetFen: number;
  /** 结算失败的调用列表（最终会阻断成功交付，并写入日志供运营复核） */
  settleErrors: Array<{
    callId: string;
    route: string;
    error: string;
  }>;
  /** 是否触发预算耗尽（platform-api 下次预占校验据此拒绝） */
  budgetExhausted: boolean;
}

/** 内部零参初始值 */
function emptyMeteringResult(): MeteringResult {
  return {
    modelCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    settledCount: 0,
    alreadySettledCount: 0,
    budgetExhaustedCount: 0,
    totalSettledAmountFen: 0,
    remainingBudgetFen: 0,
    settleErrors: [],
    budgetExhausted: false,
  };
}

/** MeteringBinder 构造参数 */
export interface MeteringBinderDeps {
  billingClient: BillingClient;
  /** 可选诊断费率表：仅用于日志层粗估，不参与上报（权威金额归 platform-api） */
  pricingTable?: PricingTable;
  logger?: pino.Logger;
}

/**
 * MeteringBinder 实例接口。
 * 调用方式：`const { result, metering } = await binder.invokeWithMetering(tool, input, jobCtx);`
 */
export interface MeteringBinderInstance {
  invokeWithMetering(
    tool: { name: string; invoke?: (input: unknown, signal?: AbortSignal) => Promise<unknown> },
    input: unknown,
    jobCtx: { jobId: string; userId: string; projectId: string },
    signal?: AbortSignal,
  ): Promise<{ result: unknown; metering: MeteringResult }>;
}

/**
 * 创建 metering binder：包装 tool.invoke 实现"事后结算"。
 */
export function createMeteringBinder(deps: MeteringBinderDeps): MeteringBinderInstance {
  const { billingClient, pricingTable, logger } = deps;

  return {
    /**
     * 包装 tool.invoke，捕获 modelCalls 并逐条结算。
     *
     * @param tool PiNovelStudio 工具对象
     * @param input invoke 输入（包含 _projectRoot 等）
     * @param jobCtx 任务上下文（jobId / userId / projectId）
     * @returns 原始 result + metering 摘要
     */
    async invokeWithMetering(
      tool: { name: string; invoke?: (input: unknown, signal?: AbortSignal) => Promise<unknown> },
      input: unknown,
      jobCtx: { jobId: string; userId: string; projectId: string },
      signal?: AbortSignal,
    ): Promise<{ result: unknown; metering: MeteringResult }> {
      const metering = emptyMeteringResult();

      // ── 1. 调用 PiNovelStudio 工具 ──
      // 注意：此处不预检 maxCharge——PiNovelStudio 内部已有 SOFT/HARD 模型调用预算门控
      // （unified-orchestrator.ts Step 1d），超限会自动 deliverRaw 退出。
      // metering 是事后结算，不参与运行时阻断。
      let result: unknown;
      result = await tool.invoke?.(input, signal);

      // ── 2. 提取 modelCalls ──
      const piResult = result as PiNovelInvokeResult | undefined;
      const modelCalls = piResult?.stageResults?.modelCalls ?? [];
      metering.modelCallCount = modelCalls.length;
      metering.inputTokens = modelCalls.reduce((sum, call) =>
        sum + (call.tokenUsage && typeof call.tokenUsage === "object" ? call.tokenUsage.in : 0), 0);
      metering.outputTokens = modelCalls.reduce((sum, call) =>
        sum + (call.tokenUsage && typeof call.tokenUsage === "object" ? call.tokenUsage.out : 0), 0);

      if (modelCalls.length === 0) {
        const looksDeliverableChapter =
          tool.name === "novel_generate_chapter" &&
          piResult?.status === "ok" &&
          typeof piResult.text === "string" &&
          piResult.text.trim().length > 0;
        if (looksDeliverableChapter) {
          throw new Error(
            "chapter metering modelCalls missing; refusing unmetered delivery",
          );
        }
        logger?.debug(
          { tool: tool.name, jobId: jobCtx.jobId },
          "no modelCalls reported by tool; nothing to settle",
        );
        return { result, metering };
      }

      // ── 3. 逐条结算 ──
      // 同步逐条调用：避免并发 settle 触发 FOR UPDATE 死锁
      // 调用顺序保持 PiNovelStudio 上报的 ts 序
      const sortedCalls = [...modelCalls].sort((a, b) => a.ts - b.ts);

      for (let i = 0; i < sortedCalls.length; i++) {
        const call = sortedCalls[i];
        const callId = buildCallId(jobCtx.jobId, call.ts, i);

        // token 用量：PiNovelStudio 可能上报 "unknown"；此时按 0 上报，但 settle 仍要执行
        let tokensIn = 0;
        let tokensOut = 0;
        if (call.tokenUsage && typeof call.tokenUsage === "object") {
          tokensIn = call.tokenUsage.in ?? 0;
          tokensOut = call.tokenUsage.out ?? 0;
        }

        // internalStage 映射：从 route/kind 反推内部阶段名
        const internalStage = mapRouteToInternalStage(call.route, call.kind);

        // model 键：费率表 modelKey（requestedRoute 优先，回退 route）
        const model = call.requestedRoute ?? call.route;

        const settleReq: BillingSettleRequest = {
          jobId: jobCtx.jobId,
          callId,
          internalStage,
          model,
          tokensIn,
          tokensOut,
        };

        try {
          const resp: BillingSettleResponse = await billingClient.settle(settleReq);
          metering.settledCount++;
          metering.totalSettledAmountFen += resp.actualChargeFen;
          metering.remainingBudgetFen = resp.remainingBudgetFen;
          if (resp.alreadySettled) {
            metering.alreadySettledCount++;
          }
          if (resp.budgetExhausted) {
            metering.budgetExhaustedCount++;
            metering.budgetExhausted = true;
            logger?.warn(
              {
                jobId: jobCtx.jobId,
                callId,
                route: call.route,
                actualChargeFen: resp.actualChargeFen,
                settledAmountFen: resp.settledAmountFen,
                remainingBudgetFen: resp.remainingBudgetFen,
              },
              "budget exhausted during settle; breaking settle loop to prevent further charges",
            );
            // P0-7：中止后续 settle，避免余额继续下降；
            // 已 settle 的部分账本完整；未 settle 的 modelCalls 不再扣费。
            break;
          }
        } catch (err) {
          // settle 失败不阻断交付——用户已付费的模型调用必须返回章节
          const errMsg = err instanceof Error ? err.message : String(err);
          metering.settleErrors.push({
            callId,
            route: call.route,
            error: errMsg,
          });
          logger?.error(
            {
              jobId: jobCtx.jobId,
              callId,
              route: call.route,
              err: errMsg,
            },
            "billing settle failed; recorded for ops review (delivery not blocked)",
          );
        }
      }

      // 可选诊断：本地费率粗估（仅日志，不参与扣费）
      if (metering.budgetExhausted) {
        throw new Error('billing budget exhausted before chapter delivery');
      }

      if (metering.settleErrors.length > 0) {
        throw new Error(
          `billing settlement failed for ${metering.settleErrors.length} model call(s)`,
        );
      }

      if (pricingTable) {
        let estimateCny = 0;
        for (const call of sortedCalls) {
          const t = call.tokenUsage;
          estimateCny += estimateActualCharge(pricingTable, {
            provider: call.provider,
            routeHint: call.requestedRoute ?? call.route,
            inputTokens: t && typeof t === "object" ? (t.in ?? 0) : 0,
            outputTokens: t && typeof t === "object" ? (t.out ?? 0) : 0,
          });
        }
        logger?.debug(
          {
            jobId: jobCtx.jobId,
            tool: tool.name,
            localEstimateCny: estimateCny,
            authoritativeFen: metering.totalSettledAmountFen,
          },
          "diagnostic cost estimate (authoritative amount comes from platform-api)",
        );
      }

      logger?.info(
        {
          jobId: jobCtx.jobId,
          tool: tool.name,
          modelCallCount: metering.modelCallCount,
          inputTokens: metering.inputTokens,
          outputTokens: metering.outputTokens,
          settledCount: metering.settledCount,
          alreadySettledCount: metering.alreadySettledCount,
          budgetExhaustedCount: metering.budgetExhaustedCount,
          totalSettledAmountFen: metering.totalSettledAmountFen,
          remainingBudgetFen: metering.remainingBudgetFen,
          settleErrorCount: metering.settleErrors.length,
        },
        "metering settle complete",
      );

      return { result, metering };
    },
  };
}

/**
 * 根据 (jobId, ts, idx) 生成稳定的 callId。
 * 同一 invoke 重复结算时，相同 (jobId, ts, idx) 命中幂等键。
 */
function buildCallId(jobId: string, ts: number, idx: number): string {
  return `${jobId}-${ts}-${idx}`;
}

/**
 * PiNovelStudio route/kind → internalStage 映射。
 * 与 platform-api 计费阶段常量对齐。
 */
function mapRouteToInternalStage(route: string, kind: string): string {
  // 精确匹配
  if (PI_NOVEL_STAGE_TO_INTERNAL_STAGE[route]) {
    return PI_NOVEL_STAGE_TO_INTERNAL_STAGE[route];
  }
  if (PI_NOVEL_STAGE_TO_INTERNAL_STAGE[kind]) {
    return PI_NOVEL_STAGE_TO_INTERNAL_STAGE[kind];
  }
  // 前缀启发式
  if (route.startsWith("v2_rawstage") || route.includes("agentic_raw")) {
    return "agentic_raw";
  }
  if (route.startsWith("v2_amplified") || route.includes("style_optimizer")) {
    return "style_optimizer";
  }
  if (route.includes("judge") || route.includes("arbiter") || route.includes("arbitrator")) {
    return "fact_recheck";
  }
  if (route.startsWith("nb4_generate")) {
    return "agentic_raw";
  }
  if (route.startsWith("nb4_style")) {
    return "style_optimizer";
  }
  if (route.startsWith("nb4_judge")) {
    return "fact_recheck";
  }
  // 兜底：未知路由归到 save_commit（最不危险的归类，让运营复核）
  return "save_commit";
}
