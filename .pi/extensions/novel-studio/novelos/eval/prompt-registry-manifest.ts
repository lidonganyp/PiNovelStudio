/**
 * Phase 9 - 评测 Manifest（eval-only）
 *
 * 定义 Prompt 版本评测的固定场景、seed、模型 route、门禁和报告路径。
 *
 * 设计原则：
 * - **可复现**：同一 manifest 在同一代码版本下可完全复现评测结果。
 * - **预注册**：manifest 在评测前创建并关联到 Prompt 版本，评测后结果写入报告路径。
 * - **固定维度**：场景/seed/模型/工具/上下文/预算全部固定，只变化 prompt。
 * - **门禁含 prematureDoneRate**：Phase 8 P-B 的根因（过早终止）纳入门禁。
 *
 * eval-only：只注册在 tsconfig.eval.json，不进入生产构建。
 */

import type { PromptSlot, PromptVersion } from "./prompt-registry.js";
import type { PromptGate } from "./prompt-ab-gate.js";
import type { PrematureDoneResult } from "./premature-done-diagnostic.js";
import { createHash } from "node:crypto";
import { NARRATIVE_TOOL_NAMES } from "../tools/narrative-tools.js";

// ============================================================================
// 类型
// ============================================================================

/** 评测模式 */
export type EvalMode = "stub" | "real";

/** 评测场景引用（复用 BASELINE_SCENARIOS） */
export interface EvalScenarioRef {
  scenarioId: string;
  category: string;
}

/** 门禁配置 */
export interface EvalGateConfig {
  /** mustVerify 覆盖率不降级容差 */
  coverageTolerance: number;
  /** sourceRef 完整率不降级容差 */
  sourceRefTolerance: number;
  /** 停止率不降级容差 */
  stopRateTolerance: number;
  /** prematureDoneRate 容差（默认 0.0 = 不允许任何过早终止） */
  prematureDoneTolerance: number;
  /** token 成本获益门槛（< A × ratio 为加分项） */
  tokenReductionThreshold: number;
  /** 首证据延迟不恶化容差（ms） */
  latencyToleranceMs: number;
}

/** 评测 Manifest */
export interface EvalManifest {
  /** 唯一 manifest ID（如 "phase9-baseline-replay-001"） */
  manifestId: string;
  /** 关联的 Prompt 版本 ID */
  versionId: string;
  /** 关联的 Prompt slot */
  slot: PromptSlot;
  /** 评测模式 */
  mode: EvalMode;
  /** 模型 route（如 "narrator_primary"） */
  modelRoute: string;
  /** 采样温度 */
  temperature: number;
  /** 最大输出 token */
  maxTokens: number;
  /** 固定场景列表 */
  scenarios: EvalScenarioRef[];
  /** seed 列表 */
  seeds: number[];
  /** 批次数 */
  batches: number;
  /** 每批 seed 数 */
  seedsPerBatch: number;
  /** 门禁配置 */
  gateConfig: EvalGateConfig;
  /**
   * Manifest 版本 hash（SHA-256 前 16 hex）。
   *
   * 由场景 ID + seed + route + 温度 + maxTokens + 门禁配置 + 工具 schema hash 计算。
   * 任一固定维度变更 -> manifestVersion 变更 -> 历史 replay 需重新引用新版本。
   */
  manifestVersion: string;
  /** 报告输出目录（相对 repo root） */
  reportDir: string;
  /** 报告文件名前缀 */
  reportPrefix: string;
  /** 创建时间 ISO */
  createdAt: string;
}

/** 评测结果摘要 */
export interface EvalResultSummary {
  manifestId: string;
  versionId: string;
  /** 评测完成时间 ISO */
  completedAt: string;
  /** 门禁结果 */
  gate: PromptGate;
  /** prematureDoneRate 诊断 */
  prematureDone: PrematureDoneResult;
  /** prematureDoneRate 门禁 */
  prematureDoneGate: {
    passed: boolean;
    tolerance: number;
    actual: number;
    details: string;
  };
  /** 聚合指标快照 */
  metrics: {
    mustVerifyCoverage: number;
    sourceRefCompleteness: number;
    stopRate: number;
    totalCalls: number;
    estimateTokens: number;
    emptyResults: number;
    errors: number;
    timeouts: number;
    invalidToolSelections: number;
    parseErrors: number;
  };
  /** 报告文件路径 */
  reportPath: string;
  /** 是否通过全部门禁（含 prematureDoneRate） */
  allGatesPassed: boolean;
}

// ============================================================================
// 默认配置
// ============================================================================

/** 默认门禁配置（与 Phase 8 Stage P 门禁一致 + prematureDoneRate） */
export const DEFAULT_GATE_CONFIG: EvalGateConfig = {
  coverageTolerance: 0.05,
  sourceRefTolerance: 0.05,
  stopRateTolerance: 0.05,
  prematureDoneTolerance: 0.0,
  tokenReductionThreshold: 0.9,
  latencyToleranceMs: 1,
};

/** 默认模型参数（与 Phase 8 一致） */
export const DEFAULT_MODEL_ROUTE = "narrator_primary";
export const DEFAULT_TEMPERATURE = 0.72;
export const DEFAULT_MAX_TOKENS = 2048;
export const DEFAULT_BATCHES = 3;
export const DEFAULT_SEEDS_PER_BATCH = 3;

// ============================================================================
// Manifest 版本化
// ============================================================================

/**
 * 计算 manifest 版本 hash。
 *
 * 由以下固定维度的规范化字符串计算 SHA-256（前 16 hex）：
 * - 场景 ID 列表（排序后 join）
 * - seed 列表（join）
 * - 模型 route
 * - 温度
 * - maxTokens
 * - 门禁配置（JSON 序列化）
 * - 工具 schema hash（排序后的工具名 join）
 *
 * 任一固定维度变更 -> manifestVersion 变更，保证历史 replay 可复现。
 */
export function computeManifestVersion(
  scenarios: EvalScenarioRef[],
  seeds: number[],
  modelRoute: string,
  temperature: number,
  maxTokens: number,
  gateConfig: EvalGateConfig,
): string {
  const scenarioIds = scenarios.map((s) => s.scenarioId).sort().join(",");
  const seedStr = seeds.join(",");
  const toolSchemaPart = Array.from(NARRATIVE_TOOL_NAMES).sort().join(",");
  const content = JSON.stringify({
    scenarioIds,
    seeds: seedStr,
    modelRoute,
    temperature,
    maxTokens,
    gateConfig,
    tools: toolSchemaPart,
  });
  return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 16);
}

/**
 * 默认场景列表（复用 BASELINE_SCENARIOS 的 7 类场景）。
 *
 * 在实际运行时从 tool-interface-baseline.ts 的 BASELINE_SCENARIOS 动态读取，
 * 这里只记录引用结构。
 */
export function createDefaultScenarios(): EvalScenarioRef[] {
  // 这些 ID 与 tool-interface-baseline.ts 的 BASELINE_SCENARIOS 一致
  return [
    { scenarioId: "SC1", category: "character_state" },
    { scenarioId: "SC2", category: "canon_lookup" },
    { scenarioId: "SC3", category: "timeline_check" },
    { scenarioId: "SC4", category: "promise_tracker" },
    { scenarioId: "SC5", category: "pattern_memory" },
    { scenarioId: "SC6", category: "voice_evidence" },
    { scenarioId: "SC7", category: "cross_source" },
    { scenarioId: "SC8", category: "high_risk" },
  ];
}

/** 默认 seed 列表（3 批 × 3 seed = seed 0-8） */
export function createDefaultSeeds(batches = DEFAULT_BATCHES, perBatch = DEFAULT_SEEDS_PER_BATCH): number[] {
  const seeds: number[] = [];
  for (let b = 0; b < batches; b++) {
    for (let s = 0; s < perBatch; s++) {
      seeds.push(b * perBatch + s);
    }
  }
  return seeds;
}

// ============================================================================
// Manifest 创建
// ============================================================================

/**
 * 创建基线回放 manifest。
 *
 * 用于证明 registry 版本管理不改变生产行为：
 * - 使用当前生产通用 Prompt
 * - 固定 9 工具 + 完整上下文 + A 组预算
 * - dry-run stub 模式（零模型调用）
 */
export function createBaselineReplayManifest(
  versionId: string,
  slot: PromptSlot,
  mode: EvalMode = "stub",
): EvalManifest {
  const scenarios = createDefaultScenarios();
  const seeds = createDefaultSeeds();
  return {
    manifestId: `phase9-baseline-${versionId}-${Date.now()}`,
    versionId,
    slot,
    mode,
    modelRoute: DEFAULT_MODEL_ROUTE,
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: DEFAULT_MAX_TOKENS,
    scenarios,
    seeds,
    batches: DEFAULT_BATCHES,
    seedsPerBatch: DEFAULT_SEEDS_PER_BATCH,
    gateConfig: DEFAULT_GATE_CONFIG,
    manifestVersion: computeManifestVersion(
      scenarios, seeds, DEFAULT_MODEL_ROUTE, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, DEFAULT_GATE_CONFIG,
    ),
    reportDir: "reports/phase9-prompt-registry",
    reportPrefix: `baseline-${versionId}`,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 创建 Prompt A/B 对比 manifest。
 *
 * 用于新 Prompt 候选 vs 基线的门禁评测。
 */
export function createPromptAbManifest(
  baselineVersionId: string,
  candidateVersionId: string,
  slot: PromptSlot,
  mode: EvalMode = "real",
): { baseline: EvalManifest; candidate: EvalManifest } {
  const scenarios = createDefaultScenarios();
  const seeds = createDefaultSeeds();
  const manifestVersion = computeManifestVersion(
    scenarios, seeds, DEFAULT_MODEL_ROUTE, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, DEFAULT_GATE_CONFIG,
  );

  const base: EvalManifest = {
    manifestId: `phase9-ab-baseline-${baselineVersionId}-${Date.now()}`,
    versionId: baselineVersionId,
    slot,
    mode,
    modelRoute: DEFAULT_MODEL_ROUTE,
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: DEFAULT_MAX_TOKENS,
    scenarios,
    seeds,
    batches: DEFAULT_BATCHES,
    seedsPerBatch: DEFAULT_SEEDS_PER_BATCH,
    gateConfig: DEFAULT_GATE_CONFIG,
    manifestVersion,
    reportDir: "reports/phase9-prompt-registry",
    reportPrefix: `ab-baseline-${baselineVersionId}`,
    createdAt: new Date().toISOString(),
  };

  const candidate: EvalManifest = {
    ...base,
    manifestId: `phase9-ab-candidate-${candidateVersionId}-${Date.now()}`,
    versionId: candidateVersionId,
    reportPrefix: `ab-candidate-${candidateVersionId}`,
  };

  return { baseline: base, candidate };
}

// ============================================================================
// 结果摘要创建
// ============================================================================

/**
 * 从评测数据创建结果摘要。
 *
 * @param manifest 评测 manifest
 * @param gate Prompt 门禁结果
 * @param prematureDone prematureDoneRate 诊断
 * @param prematureDoneGate prematureDoneRate 门禁
 * @param metrics 聚合指标
 * @param reportPath 报告路径
 */
export function createEvalResultSummary(
  manifest: EvalManifest,
  gate: PromptGate,
  prematureDone: PrematureDoneResult,
  prematureDoneGate: { passed: boolean; tolerance: number; actual: number; details: string },
  metrics: EvalResultSummary["metrics"],
  reportPath: string,
): EvalResultSummary {
  return {
    manifestId: manifest.manifestId,
    versionId: manifest.versionId,
    completedAt: new Date().toISOString(),
    gate,
    prematureDone,
    prematureDoneGate,
    metrics,
    reportPath,
    allGatesPassed: gate.allHardPassed && prematureDoneGate.passed,
  };
}

// ============================================================================
// 版本与 manifest 关联
// ============================================================================

/**
 * 将评测结果关联到 Prompt 版本。
 *
 * 返回更新后的版本（添加 evalManifestId 和 evalReportPath）。
 */
export function linkEvalResultToVersion(
  version: PromptVersion,
  manifest: EvalManifest,
  reportPath: string,
): PromptVersion {
  return {
    ...version,
    evalManifestId: manifest.manifestId,
    evalReportPath: reportPath,
    updatedAt: new Date().toISOString(),
  };
}
