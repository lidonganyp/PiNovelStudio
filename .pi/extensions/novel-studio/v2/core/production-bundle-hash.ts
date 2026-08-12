/**
 * 生产 Bundle Hash（production-safe，不依赖 eval-only 模块）
 *
 * 从生产常量计算轻量级 bundle hash，写入 trace 作为 bundleId。
 * 这是完整 PromptBundleManifest 的子集（system prompt + toolSchema + budget +
 * modelVersion + route + provider + temperature + maxTokens），不含 renderer/
 * parser/protocol/termination 源码 hash（那些需要读文件，属 eval-only 范畴）。
 *
 * 设计原则：
 * - 零行为变更：只做 hash 计算和 trace 写入，不拦截/修改生产调用
 * - 诚实标注：trace 中同时写入 hash 维度列表，让审计者知道哪些维度被覆盖
 * - 与 eval-only 完整 manifest 兼容：productionBundleId 是完整 bundleId 的前缀
 */

import { createHash } from "node:crypto";
import { NOVELOS_SYSTEM_PROMPT, AGENTIC_RAW_KIND } from "../../novelos/agent/agentic-raw-candidate-source.js";
import { NARRATIVE_TOOL_NAMES } from "../../novelos/tools/narrative-tools.js";

// ============================================================================
// 类型
// ============================================================================

export interface ProductionBundleHashInput {
  /** 模型版本（detectModelVersion 输出） */
  modelVersion: string;
  /** 路由名（如 "novelos_agentic"） */
  route: string;
  /** provider（如 "gemini"） */
  provider: string;
  /** 温度 */
  temperature: number | null;
  /** maxTokens */
  maxTokens: number | null;
  /** NovelOS budget（maxTurns / maxToolCalls） */
  budgetMaxTurns: number;
  budgetMaxToolCalls: number;
  /** Orchestrator 预算（SOFT / HARD） */
  orchestratorSoft: number;
  orchestratorHard: number;
}

export interface ProductionBundleHashResult {
  /** 生产 bundle hash（16 hex） */
  bundleId: string;
  /** hash 覆盖的维度列表 */
  hashDimensions: string[];
  /** 各维度 hash 值（供 trace 审计） */
  dimensionHashes: Record<string, string>;
}

// ============================================================================
// 计算函数
// ============================================================================

function sha256hex(input: string, length = 16): string {
  return createHash("sha256").update(input, "utf-8").digest("hex").slice(0, length);
}

/**
 * 计算生产 Bundle Hash。
 *
 * 从生产常量和运行时身份派生确定性 hash。
 * 同一输入恒产生同一输出；任一维度变化即改变 bundleId。
 */
export function computeProductionBundleHash(
  input: ProductionBundleHashInput,
): ProductionBundleHashResult {
  const systemPromptHash = sha256hex(NOVELOS_SYSTEM_PROMPT);
  const toolSchemaHash = sha256hex(
    Array.from(NARRATIVE_TOOL_NAMES).sort().join(","),
  );
  const budgetHash = sha256hex(
    JSON.stringify({
      maxTurns: input.budgetMaxTurns,
      maxToolCalls: input.budgetMaxToolCalls,
      orchestratorSoft: input.orchestratorSoft,
      orchestratorHard: input.orchestratorHard,
    }),
  );
  const identityHash = sha256hex(
    JSON.stringify({
      modelVersion: input.modelVersion,
      route: input.route,
      provider: input.provider,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
    }),
  );

  const dimensions = {
    systemPrompt: systemPromptHash,
    toolSchema: toolSchemaHash,
    budget: budgetHash,
    identity: identityHash,
  };

  // 合并 hash：把各维度 hash 拼接后再 hash
  const bundleId = sha256hex(
    Object.entries(dimensions)
      .map(([k, v]) => `${k}:${v}`)
      .join("|"),
  );

  return {
    bundleId,
    hashDimensions: ["systemPrompt", "toolSchema", "budget", "identity"],
    dimensionHashes: dimensions,
  };
}
