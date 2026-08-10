/**
 * Phase 9 - Prompt Registry Hash Drift 检查（eval-only）
 *
 * CI 和生产发布门禁用：校验生产 Prompt、工具 schema、上下文、预算 hash
 * 是否与 registry 中 active 版本记录的 hash 一致。
 *
 * 发现漂移 -> hard block，不允许静默运行。
 *
 * eval-only：只注册在 tsconfig.eval.json，不进入生产构建。
 * CI 用法：node scripts/prompt-registry-drift-check.mjs
 */

import {
  loadRegistry,
  getActiveVersion,
  computePromptHash,
  computeProductionToolSchemaHash,
  computeProductionContextHash,
  computeProductionBudgetHash,
  PRODUCTION_NOVELOS_PROMPT,
  PRODUCTION_STYLE_PROMPT,
  PRODUCTION_WRITER_PROMPT,
  EVAL_BASELINE_RETRIEVAL_PROMPT,
  type PromptSlot,
  type PromptRegistry,
} from "./prompt-registry.js";

// ============================================================================
// 类型
// ============================================================================

/** 单个 slot 的漂移检查结果 */
export interface SlotDriftResult {
  slot: PromptSlot;
  versionId: string;
  passed: boolean;
  drifts: HashDriftDetail[];
}

/** 单项 hash 漂移详情 */
export interface HashDriftDetail {
  hashName: "promptHash" | "toolSchemaHash" | "contextHash" | "budgetHash";
  expected: string;
  actual: string;
  drift: boolean;
}

/** 整体漂移检查结果 */
export interface DriftCheckResult {
  passed: boolean;
  checkedSlots: SlotDriftResult[];
  timestamp: string;
  /** 漂移摘要（人类可读） */
  summary: string;
}

// ============================================================================
// 漂移检查逻辑
// ============================================================================

/** 每个 slot 对应的生产 Prompt 内容 */
const SLOT_PROMPTS: Record<PromptSlot, string> = {
  novelos_agentic: PRODUCTION_NOVELOS_PROMPT,
  style_optimizer: PRODUCTION_STYLE_PROMPT,
  writer_adapter: PRODUCTION_WRITER_PROMPT,
  retrieval_eval: EVAL_BASELINE_RETRIEVAL_PROMPT,
};

/**
 * 检查单个 slot 的 hash 漂移。
 *
 * 从当前生产常量重新计算 4 类 hash，与 registry 中 active 版本的 hash 对比。
 */
export function checkSlotDrift(
  registry: PromptRegistry,
  slot: PromptSlot,
): SlotDriftResult {
  const activeVersion = getActiveVersion(registry, slot);

  if (!activeVersion) {
    return {
      slot,
      versionId: "(none)",
      passed: false,
      drifts: [],
    };
  }

  const promptContent = SLOT_PROMPTS[slot];
  const actualHashes = {
    promptHash: computePromptHash(promptContent),
    toolSchemaHash: computeProductionToolSchemaHash(),
    contextHash: computeProductionContextHash(),
    budgetHash: computeProductionBudgetHash(),
  };

  const drifts: HashDriftDetail[] = [
    {
      hashName: "promptHash",
      expected: activeVersion.hashes.promptHash,
      actual: actualHashes.promptHash,
      drift: activeVersion.hashes.promptHash !== actualHashes.promptHash,
    },
    {
      hashName: "toolSchemaHash",
      expected: activeVersion.hashes.toolSchemaHash,
      actual: actualHashes.toolSchemaHash,
      drift: activeVersion.hashes.toolSchemaHash !== actualHashes.toolSchemaHash,
    },
    {
      hashName: "contextHash",
      expected: activeVersion.hashes.contextHash,
      actual: actualHashes.contextHash,
      drift: activeVersion.hashes.contextHash !== actualHashes.contextHash,
    },
    {
      hashName: "budgetHash",
      expected: activeVersion.hashes.budgetHash,
      actual: actualHashes.budgetHash,
      drift: activeVersion.hashes.budgetHash !== actualHashes.budgetHash,
    },
  ];

  return {
    slot,
    versionId: activeVersion.versionId,
    passed: drifts.every((d) => !d.drift),
    drifts,
  };
}

/**
 * 执行全量 hash 漂移检查。
 *
 * @param registryPath registry JSON 文件路径
 * @returns 漂移检查结果（passed=false 时应阻断发布）
 */
export function runDriftCheck(registryPath: string): DriftCheckResult {
  let registry: PromptRegistry;

  try {
    registry = loadRegistry(registryPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      checkedSlots: [],
      timestamp: new Date().toISOString(),
      summary: `[drift-check] FAIL: registry 加载失败（fail-closed）：${message}`,
    };
  }

  const slots: PromptSlot[] = [
    "novelos_agentic",
    "style_optimizer",
    "writer_adapter",
    "retrieval_eval",
  ];

  const checkedSlots = slots.map((slot) => checkSlotDrift(registry, slot));
  const allPassed = checkedSlots.every((s) => s.passed);

  const driftedSlots = checkedSlots.filter((s) => !s.passed);
  const summary = allPassed
    ? `[drift-check] PASS: 全部 ${slots.length} 个 slot hash 一致，无漂移`
    : `[drift-check] FAIL: ${driftedSlots.length}/${slots.length} 个 slot 存在 hash 漂移：${driftedSlots.map((s) => s.slot).join(", ")}`;

  return {
    passed: allPassed,
    checkedSlots,
    timestamp: new Date().toISOString(),
    summary,
  };
}
