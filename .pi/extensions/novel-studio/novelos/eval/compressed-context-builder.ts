/**
 * Phase 6.1 eval-only：长期叙事状态压缩构建器。
 *
 * 从 LongTermStateSnapshot 构建模型可见的上下文文本块，支持 A/B/C 三组压缩参数。
 * 不修改生产 ContextCompiler；仅在 eval runner 中通过 modelFn wrapper 注入。
 *
 * 设计要点：
 * - A 组（完整）：maxItems 24-48，摘要 160 字符/条，全部四类状态
 * - B 组（压缩）：maxItems 12-24，摘要 80 字符/条，排除 PatternMemory + 非相关状态
 * - C 组（无状态）：不注入任何长期状态（当前 eval runner 行为）
 */

import type { LongTermStateSnapshot } from "../../v2/core/types.js";

// ── 压缩参数 ──────────────────────────────────────────────────────────────

export interface CompressionParams {
  /** 摘要字符上限（A=160, B=80） */
  summaryCharLimit: number;
  /** 最大条目数（A=48, B=24） */
  maxItems: number;
  /** 是否注入 CanonState */
  injectCanon: boolean;
  /** 是否注入 CharacterState */
  injectCharacter: boolean;
  /** 是否注入 PromiseLedger */
  injectPromise: boolean;
  /** 是否注入 PatternMemory */
  injectPattern: boolean;
  /** 是否注入 Expectation（读者期待） */
  injectExpectation: boolean;
  /** 是否注入 Planned（计划状态） */
  injectPlanned: boolean;
}

/** A 组：完整上下文（当前生产参数） */
export const FULL_PARAMS: CompressionParams = {
  summaryCharLimit: 160,
  maxItems: 48,
  injectCanon: true,
  injectCharacter: true,
  injectPromise: true,
  injectPattern: true,
  injectExpectation: true,
  injectPlanned: true,
};

/** B 组：压缩上下文 */
export const COMPRESSED_PARAMS: CompressionParams = {
  summaryCharLimit: 80,
  maxItems: 24,
  injectCanon: true,
  injectCharacter: true,
  injectPromise: true,
  injectPattern: false,
  injectExpectation: true,
  injectPlanned: false,
};

/** C 组：无长期状态（不注入） */
export const NONE_PARAMS: CompressionParams = {
  summaryCharLimit: 0,
  maxItems: 0,
  injectCanon: false,
  injectCharacter: false,
  injectPromise: false,
  injectPattern: false,
  injectExpectation: false,
  injectPlanned: false,
};

/** Phase 6.2：逐类单因素消融参数（只排除一类状态，其他参数与 A 组一致） */
export const ABLATION_PARAMS: Record<string, CompressionParams> = {
  "A-Canon":     { summaryCharLimit: 160, maxItems: 48, injectCanon: false, injectCharacter: true,  injectPromise: true,  injectPattern: true,  injectExpectation: true,  injectPlanned: true  },
  "A-Character": { summaryCharLimit: 160, maxItems: 48, injectCanon: true,  injectCharacter: false, injectPromise: true,  injectPattern: true,  injectExpectation: true,  injectPlanned: true  },
  "A-Promise":   { summaryCharLimit: 160, maxItems: 48, injectCanon: true,  injectCharacter: true,  injectPromise: false, injectPattern: true,  injectExpectation: true,  injectPlanned: true  },
  "A-Pattern":   { summaryCharLimit: 160, maxItems: 48, injectCanon: true,  injectCharacter: true,  injectPromise: true,  injectPattern: false, injectExpectation: true,  injectPlanned: true  },
};

// ── 上下文块构建 ──────────────────────────────────────────────────────────

/**
 * 从 LongTermStateSnapshot 构建模型可见的上下文文本块。
 *
 * 格式：
 * ```
 * == 叙事记忆上下文 ==
 * [canon] 事实摘要 (来源: ch12)
 * [character] 角色状态摘要 (来源: ch12)
 * [promise] 伏笔摘要 [status=open, heat=8] (来源: ch10)
 * ...
 * == 叙事记忆上下文结束 ==
 * ```
 *
 * @param snapshot 长期状态快照（null 则返回空字符串）
 * @param params 压缩参数
 * @returns 上下文文本块（空字符串表示不注入）
 */
export function buildContextBlock(
  snapshot: LongTermStateSnapshot | null,
  params: CompressionParams,
): string {
  if (!snapshot || params.maxItems === 0) return "";

  const lines: string[] = ["== 叙事记忆上下文 =="];
  let itemCount = 0;

  const truncate = (s: string): string => s.slice(0, params.summaryCharLimit);

  // CanonState（Phase 6.2：消融时可排除）
  if (params.injectCanon) {
    for (const entry of snapshot.canon) {
      if (itemCount >= params.maxItems) break;
      lines.push(`[canon] ${truncate(entry.fact)} (来源: ${entry.sourceChapter})`);
      itemCount++;
    }
  }

  // CharacterState（Phase 6.2：消融时可排除）
  if (params.injectCharacter) {
    for (const entry of snapshot.character) {
      if (itemCount >= params.maxItems) break;
      lines.push(
        `[character] ${entry.characterId}.${entry.field}=${truncate(entry.value)} (来源: ${entry.sourceChapter})`,
      );
      itemCount++;
    }
  }

  // PromiseLedger（Phase 6.2：消融时可排除）
  if (params.injectPromise) {
    for (const entry of snapshot.promise) {
      if (itemCount >= params.maxItems) break;
      lines.push(
        `[promise] ${truncate(entry.description)} [status=${entry.status}, heat=${entry.currentHeat}] (来源: ${entry.sourceChapter})`,
      );
      itemCount++;
    }
  }

  // PatternMemory（P3 可丢弃，B 组排除）
  if (params.injectPattern) {
    for (const entry of snapshot.pattern) {
      if (itemCount >= params.maxItems) break;
      lines.push(
        `[pattern] ${truncate(entry.description)} [type=${entry.patternType}, count=${entry.occurrenceCount}] (来源: ${entry.sourceChapter})`,
      );
      itemCount++;
    }
  }

  // Expectation（读者期待）
  if (params.injectExpectation && snapshot.expectation) {
    for (const entry of snapshot.expectation) {
      if (itemCount >= params.maxItems) break;
      lines.push(
        `[expectation] ${truncate(entry.description)} [status=${entry.status}] (来源: ${entry.sourceChapter})`,
      );
      itemCount++;
    }
  }

  // Planned（计划状态）
  if (params.injectPlanned && snapshot.planned) {
    for (const entry of snapshot.planned) {
      if (itemCount >= params.maxItems) break;
      lines.push(
        `[planned] ${truncate(entry.plannedContent)} [kind=${entry.plannedKind}, verified=${entry.verified}] (来源: ${entry.sourceChapter})`,
      );
      itemCount++;
    }
  }

  lines.push("== 叙事记忆上下文结束 ==");

  // 上下文块 token 估算（用于指标采集）
  const tokenEstimate = Math.ceil(lines.join("\n").length / 2);

  return lines.join("\n");
}

// ── token 成本估算 ────────────────────────────────────────────────────────

/**
 * 估算上下文块的 token 成本。
 * 中文按约 2 字符/token 估算（与 context-safety.ts 一致）。
 */
export function estimateContextBlockTokens(block: string): number {
  if (!block) return 0;
  return Math.ceil(block.length / 2) + 8;
}

// ── 逐类 token 明细 ───────────────────────────────────────────────────────

export interface ContextTokenBreakdown {
  canon: number;
  character: number;
  promise: number;
  pattern: number;
  expectation: number;
  planned: number;
  total: number;
}

/**
 * 按状态类别估算 token 成本明细。
 */
export function breakdownContextTokens(
  snapshot: LongTermStateSnapshot | null,
  params: CompressionParams,
): ContextTokenBreakdown {
  if (!snapshot) {
    return { canon: 0, character: 0, promise: 0, pattern: 0, expectation: 0, planned: 0, total: 0 };
  }

  const estimate = (s: string): number => Math.ceil(s.length / 2) + 8;

  const canonTokens = params.injectCanon
    ? snapshot.canon.reduce((sum, e) => sum + estimate(e.fact), 0)
    : 0;
  const characterTokens = params.injectCharacter
    ? snapshot.character.reduce(
        (sum, e) => sum + estimate(`${e.characterId}.${e.field}=${e.value}`),
        0,
      )
    : 0;
  const promiseTokens = params.injectPromise
    ? snapshot.promise.reduce(
        (sum, e) => sum + estimate(`${e.description}[${e.status},${e.currentHeat}]`),
        0,
      )
    : 0;
  const patternTokens = params.injectPattern
    ? snapshot.pattern.reduce((sum, e) => sum + estimate(`${e.description}[${e.patternType}]`), 0)
    : 0;
  const expectationTokens = params.injectExpectation && snapshot.expectation
    ? snapshot.expectation.reduce((sum, e) => sum + estimate(`${e.description}[${e.status}]`), 0)
    : 0;
  const plannedTokens = params.injectPlanned && snapshot.planned
    ? snapshot.planned.reduce((sum, e) => sum + estimate(e.plannedContent), 0)
    : 0;

  return {
    canon: canonTokens,
    character: characterTokens,
    promise: promiseTokens,
    pattern: patternTokens,
    expectation: expectationTokens,
    planned: plannedTokens,
    total: canonTokens + characterTokens + promiseTokens + patternTokens + expectationTokens + plannedTokens,
  };
}
