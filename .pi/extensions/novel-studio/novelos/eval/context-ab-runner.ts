/**
 * Phase 6.1 eval-only：上下文压缩 A/B/C runner（走生产 buildHistoricalContext 注入路径）。
 *
 * 包装 runRealToolAbScenario，通过 modelFn wrapper 在 prompt 中注入生产历史上下文
 * （buildHistoricalContext 输出的 historicalContinuity / historicalCharacterState /
 * recentPatternMemory 三段）。固定使用 A 组（9 专用工具），只变化长期状态注入压缩。
 *
 * 三组对照：
 * - A 组（完整）：生产默认参数（canon 4×2400、character 6×1800、pattern 4×1000）
 * - B 组（压缩）：overrides 压缩（maxEntries 减半、maxChars 减半、排除 PatternMemory）
 * - C 组（无状态）：不注入长期状态（当前 eval runner 行为，基线）
 *
 * 注入方式：走生产 buildHistoricalContext，把三段 boundedEntries 渲染为上下文块，
 * 通过包装 modelFn 在每回合 ctx.prompt 前注入。runRealToolAbScenario 的全部逻辑
 * （工具创建/模型调用/指标采集）原样复用。
 *
 * 红线：schemaTokenCost 与状态注入正交（工具 schema 成本），不作为本轮压缩收益。
 * 压缩收益只度量 contextBlockTokens；质量底线是 mustVerify/sourceRef/empty/errors/
 * timeouts/stopRate 不劣化。
 */

import type { LongTermStateSnapshot } from "../../v2/core/types.js";
import type { UnifiedOrchestratorInput } from "../../v2/core/orchestrator-types.js";
import type { BaselineScenario } from "./tool-interface-baseline.js";
import type { RealToolAbScenarioMetrics, ToolAbModelFn, ToolAbModelFnCtx } from "./tool-ab-real-runner.js";
import { runRealToolAbScenario } from "./tool-ab-real-runner.js";
import { getEnvelopeReplayScenarios } from "./tool-ab-real-runner.js";
import {
  buildHistoricalContext,
  type HistoricalContextOverrides,
} from "../../v2/core/model-prompt-adapter.js";
import { deriveSnapshotFromScenario } from "./context-ab-fixtures.js";

// ── 类型 ──────────────────────────────────────────────────────────────────

export type ContextAbArm = "A" | "B" | "C" | "D_pm" | "D_mi" | "D_sl" | "D_pm_sl";

/** 各状态类别实际保留条目数（走生产注入后 boundedEntries 的真实输出） */
export interface ContextInjectionCounts {
  canon: number;
  character: number;
  pattern: number;
  total: number;
}

export interface ContextAbScenarioMetrics extends RealToolAbScenarioMetrics {
  /** 上下文压缩 arm（A=完整/B=压缩/C=无） */
  contextArm: ContextAbArm;
  /** 上下文块 token 估算（状态注入的压缩收益度量） */
  contextBlockTokens: number;
  /** 上下文块字符数 */
  contextBlockChars: number;
  /** 注入的状态条目总数 */
  contextItemCount: number;
  /** 各状态类别实际保留条目数 */
  injectionCounts: ContextInjectionCounts;
  /** 生产注入三段原始文本（用于 trajectory 输出） */
  historicalContinuity: string[];
  historicalCharacterState: string[];
  recentPatternMemory: string[];
}

export interface ContextAbRunOptions {
  scenario: BaselineScenario;
  arm: ContextAbArm;
  seed: number;
  modelFn: ToolAbModelFn;
  maxModelCalls?: number;
  timeoutMs?: number;
}

// ── arm -> 生产注入 overrides 映射 ───────────────────────────────────────

/**
 * A 组：返回 undefined（生产默认参数，行为与生产完全一致）。
 * B 组：压缩 overrides —— maxEntries 减半、maxChars 减半、排除 PatternMemory（组合方案）。
 * C 组：哨兵 null（不注入）。
 * D_pm 组：单因素消融 —— 保持 A 的 maxItems/摘要长度，只排除 PatternMemory。
 * D_mi 组：单因素消融 —— 只减 maxEntries（canon 4→2、character 6→3），maxChars/PatternMemory 不变。
 * D_sl 组：单因素消融 —— 只减 maxChars（canon 2400→1200、character 1800→900），maxItems/PatternMemory 不变。
 * D_pm_sl 组：组合消融 —— 同时排除 PatternMemory 并缩减 maxChars（D_pm + D_sl 叠加），maxItems 保持生产默认。
 */
export function historicalOverridesOfArm(arm: ContextAbArm): HistoricalContextOverrides | "none" | null {
  switch (arm) {
    case "A": return undefined as unknown as HistoricalContextOverrides | "none" | null;
    case "B": {
      return {
        canon: { maxEntries: 2, maxChars: 1200 },
        character: { maxEntries: 3, maxChars: 900 },
        pattern: { inject: false },
      };
    }
    case "C": return null;
    case "D_pm": {
      return {
        pattern: { inject: false },
      };
    }
    case "D_mi": {
      return {
        canon: { maxEntries: 2 },
        character: { maxEntries: 3 },
      };
    }
    case "D_sl": {
      return {
        canon: { maxChars: 1200 },
        character: { maxChars: 900 },
      };
    }
    case "D_pm_sl": {
      return {
        canon: { maxChars: 1200 },
        character: { maxChars: 900 },
        pattern: { inject: false },
      };
    }
  }
}

/** 是否注入（A/B/D_pm/D_mi/D_sl/D_pm_sl 注入，C 不注入） */
function shouldInject(arm: ContextAbArm): boolean {
  return arm !== "C";
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

// ── 上下文块渲染与 token 估算 ─────────────────────────────────────────────

/** 估算文本 token（中文约 2 字符/token，与 context-safety.ts 一致） */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 2) + 8;
}

/** 把生产 buildHistoricalContext 三段 boundedEntries 渲染为上下文文本块 */
function renderHistoricalContext(block: {
  continuity: string[];
  character: string[];
  pattern: string[];
}): string {
  const lines: string[] = ["== 叙事记忆上下文 =="];
  for (const entry of block.continuity) lines.push(`[canon] ${entry}`);
  for (const entry of block.character) lines.push(`[character] ${entry}`);
  for (const entry of block.pattern) lines.push(`[pattern] ${entry}`);
  lines.push("== 叙事记忆上下文结束 ==");
  return lines.join("\n");
}

// ── 主运行函数 ─────────────────────────────────────────────────────────────

export async function runContextAbScenario(
  options: ContextAbRunOptions,
): Promise<ContextAbScenarioMetrics> {
  const { scenario, arm, seed, modelFn } = options;

  // 1. 从场景派生 LongTermStateSnapshot
  const snapshot = deriveSnapshotFromScenario(scenario);

  // 2. 构造生产 UnifiedOrchestratorInput 的最小形态，走 buildHistoricalContext
  //    注：relevantNames 取全部 character characterId，确保 A/B 组的 character 注入
  //    与冻结基线口径可对比（生产也是按相关角色过滤，evall 场景角色全集即"相关"）。
  const relevantNames = snapshot?.character.map((c) => c.characterId) ?? [];
  const overrides = historicalOverridesOfArm(arm);
  let continuity: string[] = [];
  let character: string[] = [];
  let pattern: string[] = [];

  if (shouldInject(arm) && snapshot) {
    const input = {
      context: { longTermState: snapshot },
      intent: { relevantCharacters: relevantNames, focusCharacterGoals: [] },
    } as unknown as UnifiedOrchestratorInput;
    // 生产注入路径：overrides 为 "none" 时传 undefined（保持生产默认参数）
    const prod = buildHistoricalContext(input, overrides === "none" ? undefined : overrides ?? undefined);
    continuity = prod.historicalContinuity;
    character = prod.historicalCharacterState;
    pattern = prod.recentPatternMemory;
  }

  // 3. 渲染上下文块并采集 token / 条目数指标
  const contextBlock = renderHistoricalContext({ continuity, character, pattern });
  const contextBlockTokens = estimateTokens(contextBlock);
  const contextBlockChars = contextBlock.length;
  const injectionCounts: ContextInjectionCounts = {
    canon: continuity.length,
    character: character.length,
    pattern: pattern.length,
    total: continuity.length + character.length + pattern.length,
  };
  const contextItemCount = injectionCounts.total;

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
    contextBlockChars,
    contextItemCount,
    injectionCounts,
    historicalContinuity: continuity,
    historicalCharacterState: character,
    recentPatternMemory: pattern,
  };
}

// ── 场景获取（复用 Phase 5.3 的 SC2/SC5/SC7） ────────────────────────────

export function getContextAbScenarios(): BaselineScenario[] {
  return getEnvelopeReplayScenarios();
}