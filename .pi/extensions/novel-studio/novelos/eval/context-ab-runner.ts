/**
 * Phase 6.1 eval-only：上下文压缩 A/B/C runner。
 *
 * 包装 runRealToolAbScenario，通过 modelFn wrapper 在 prompt 中注入长期状态上下文块。
 * 固定使用 A 组（9 专用工具），只变化上下文注入量。
 *
 * 三组对照：
 * - A 组（完整）：完整 LongTermStateSnapshot，摘要 160 字符/条，maxItems 48
 * - B 组（压缩）：压缩快照，摘要 80 字符/条，maxItems 24，排除 PatternMemory/Planned
 * - C 组（无状态）：不注入长期状态（当前 eval runner 行为，基线）
 *
 * 注入方式：通过包装 modelFn，在 ctx.prompt 前添加上下文块。
 * runRealToolAbScenario 的全部逻辑（工具创建/模型调用/指标采集）原样复用。
 */

import type { LongTermStateSnapshot } from "../../v2/core/types.js";
import type { BaselineScenario } from "./tool-interface-baseline.js";
import type { RealToolAbScenarioMetrics, ToolAbModelFn, ToolAbModelFnCtx } from "./tool-ab-real-runner.js";
import { runRealToolAbScenario } from "./tool-ab-real-runner.js";
import { getEnvelopeReplayScenarios } from "./tool-ab-real-runner.js";
import {
  buildContextBlock,
  breakdownContextTokens,
  estimateContextBlockTokens,
  FULL_PARAMS,
  COMPRESSED_PARAMS,
  NONE_PARAMS,
  ABLATION_PARAMS,
  type CompressionParams,
  type ContextTokenBreakdown,
} from "./compressed-context-builder.js";
import { deriveSnapshotFromScenario } from "./context-ab-fixtures.js";

// ── 类型 ──────────────────────────────────────────────────────────────────

export type ContextAbArm = "A" | "B" | "C" | "A-Canon" | "A-Character" | "A-Promise" | "A-Pattern";

/** Phase 6.2 消融 arm 列表 */
export const ABLATION_ARMS: ContextAbArm[] = ["A-Canon", "A-Character", "A-Promise", "A-Pattern"];

export interface ContextAbScenarioMetrics extends RealToolAbScenarioMetrics {
  /** 上下文压缩 arm（A=完整/B=压缩/C=无） */
  contextArm: ContextAbArm;
  /** 上下文块 token 估算 */
  contextBlockTokens: number;
  /** 逐类 token 明细 */
  contextTokenBreakdown: ContextTokenBreakdown;
  /** 上下文块字符数 */
  contextBlockChars: number;
  /** 注入的状态条目数 */
  contextItemCount: number;
}

export interface ContextAbRunOptions {
  scenario: BaselineScenario;
  arm: ContextAbArm;
  seed: number;
  modelFn: ToolAbModelFn;
  maxModelCalls?: number;
  timeoutMs?: number;
}

// ── arm -> 压缩参数映射 ──────────────────────────────────────────────────

export function compressionParamsOfArm(arm: ContextAbArm): CompressionParams {
  switch (arm) {
    case "A": return FULL_PARAMS;
    case "B": return COMPRESSED_PARAMS;
    case "C": return NONE_PARAMS;
    case "A-Canon": return ABLATION_PARAMS["A-Canon"];
    case "A-Character": return ABLATION_PARAMS["A-Character"];
    case "A-Promise": return ABLATION_PARAMS["A-Promise"];
    case "A-Pattern": return ABLATION_PARAMS["A-Pattern"];
  }
}

// ── modelFn wrapper ───────────────────────────────────────────────────────

/**
 * 包装 modelFn，在每回合的 prompt 前注入上下文块。
 * runRealToolAbScenario 内部每回合都调用 modelFn(ctx)，ctx.prompt 是固定的基础 prompt。
 * wrapper 在 ctx.prompt 前面拼接上下文块，使模型每回合都能看到长期状态。
 */
function wrapModelFnWithContext(
  modelFn: ToolAbModelFn,
  contextBlock: string,
): ToolAbModelFn {
  if (!contextBlock) return modelFn;
  return async (ctx: ToolAbModelFnCtx) => {
    const augmentedCtx: ToolAbModelFnCtx = {
      ...ctx,
      prompt: `${contextBlock}\n\n${ctx.prompt}`,
    };
    return modelFn(augmentedCtx);
  };
}

// ── 主运行函数 ─────────────────────────────────────────────────────────────

export async function runContextAbScenario(
  options: ContextAbRunOptions,
): Promise<ContextAbScenarioMetrics> {
  const { scenario, arm, seed, modelFn } = options;

  // 1. 从场景派生 LongTermStateSnapshot
  const snapshot = deriveSnapshotFromScenario(scenario);

  // 2. 按 arm 选择压缩参数并构建上下文块
  const params = compressionParamsOfArm(arm);
  const contextBlock = buildContextBlock(snapshot, params);

  // 3. 采集 token 成本指标
  const contextBlockTokens = estimateContextBlockTokens(contextBlock);
  const contextBlockChars = contextBlock.length;
  const contextTokenBreakdown = breakdownContextTokens(snapshot, params);
  // 注入的状态条目数（Phase 6.2：使用完整注入控制字段）
  const contextItemCount =
    (arm === "C" || !snapshot) ? 0 : Math.min(
      params.maxItems,
      (params.injectCanon ? snapshot.canon.length : 0) +
        (params.injectCharacter ? snapshot.character.length : 0) +
        (params.injectPromise ? snapshot.promise.length : 0) +
        (params.injectPattern ? snapshot.pattern.length : 0) +
        (params.injectExpectation && snapshot.expectation ? snapshot.expectation.length : 0) +
        (params.injectPlanned && snapshot.planned ? snapshot.planned.length : 0),
    );

  // 4. 包装 modelFn 注入上下文块
  const wrappedModelFn = wrapModelFnWithContext(modelFn, contextBlock);

  // 5. 调用 runRealToolAbScenario（固定 arm="A"，9 专用工具）
  const baseMetrics = await runRealToolAbScenario({
    scenario,
    arm: "A",
    seed,
    modelFn: wrappedModelFn,
    maxModelCalls: options.maxModelCalls,
    timeoutMs: options.timeoutMs,
  });

  // 6. 附加上下文压缩指标
  return {
    ...baseMetrics,
    contextArm: arm,
    contextBlockTokens,
    contextTokenBreakdown,
    contextBlockChars,
    contextItemCount,
  };
}

// ── 场景获取（复用 Phase 5.3 的 SC2/SC5/SC7） ────────────────────────────

export function getContextAbScenarios(): BaselineScenario[] {
  return getEnvelopeReplayScenarios();
}
