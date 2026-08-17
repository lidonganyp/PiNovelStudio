/**
 * REPAIR-BUDGET — 多维修订预算（REASONING-REPAIR-BOUNDARY-1 Wave 4A / RRB-4.6）
 *
 * 修订循环同时约束四个维度：模型调用、授权次数、候选数量、validator runs，
 * 防止只限制其中一个维度（例如只限制轮次导致 patch 模型调用无界）。
 *
 * 计数职责划分（尊重 RRB-4.3「唯一计数点」）：
 * - modelCalls / validatorRuns 由 ModelCallMeter / ValidatorRunMeter 唯一计数，
 *   本模块只读取它们的累计值，不重复计数。
 * - authorizations / candidates 没有独立 meter，由 loop 在签发授权 / 创建子候选
 *   的计数点本地累加后传入。
 *
 * 默认天花板由 maxRepairRounds 派生（每轮至多 1 次 patch 调用、1 个子候选、
 * 2 次 validator run），保证向后兼容；调用方可通过
 * NarrativeAgentLoopOptions.repairBudget 覆盖任意维度。
 */

// ============================================================================
// 类型
// ============================================================================

/** 修订预算四维天花板。 */
export interface RepairBudgetConfig {
  /** 修订阶段的模型调用上限（patch 调用，不含 draft 初稿） */
  maxModelCalls: number;
  /** 累计签发的修订授权上限（按 finding 计） */
  maxAuthorizations: number;
  /** 累计创建的子候选上限 */
  maxCandidates: number;
  /** 累计本地验证器运行上限（narrative_verifier + patch_comparator + ...） */
  maxValidatorRuns: number;
}

/** 修订预算维度名（用于标注首个耗尽维度）。 */
export type RepairBudgetDimension = keyof RepairBudgetConfig;

/** 修订预算快照（写入 VerifyPatchResult / lineage，供 trace 解释退出原因）。 */
export interface RepairBudgetSnapshot {
  modelCalls: number;
  authorizations: number;
  candidates: number;
  validatorRuns: number;
  exhausted: boolean;
  exhaustedDimension?: RepairBudgetDimension;
}

/** 修订预算的累计计数输入（由 loop 从 meter + 本地计数器组装）。 */
export interface RepairBudgetCounts {
  modelCalls: number;
  authorizations: number;
  candidates: number;
  validatorRuns: number;
}

// ============================================================================
// 派生与检查
// ============================================================================

/**
 * 从 maxRepairRounds 派生默认修订预算天花板（保持向后兼容）。
 * 每轮至多：1 次 patch 模型调用、1 个子候选、2 次 validator run（comparator + reverify），
 * 另加初始 1 次 narrative_verifier；授权上限按批大小 × 轮次估计。
 */
export function deriveRepairBudgetConfig(
  maxRepairRounds: number,
  batchSize: number,
): RepairBudgetConfig {
  return {
    maxModelCalls: maxRepairRounds,
    maxAuthorizations: maxRepairRounds * batchSize,
    maxCandidates: maxRepairRounds,
    maxValidatorRuns: 2 * maxRepairRounds + 1,
  };
}

/**
 * 检查修订预算是否任一维度耗尽（fail-closed：任一维度触顶即返回 exhausted）。
 * 返回首个耗尽维度，供 loop 给出单一、可解释的 budget_exhausted 退出原因。
 */
export function checkRepairBudget(
  counts: RepairBudgetCounts,
  config: RepairBudgetConfig,
): { exhausted: boolean; exhaustedDimension?: RepairBudgetDimension } {
  if (counts.modelCalls >= config.maxModelCalls) {
    return { exhausted: true, exhaustedDimension: "maxModelCalls" };
  }
  if (counts.authorizations >= config.maxAuthorizations) {
    return { exhausted: true, exhaustedDimension: "maxAuthorizations" };
  }
  if (counts.candidates >= config.maxCandidates) {
    return { exhausted: true, exhaustedDimension: "maxCandidates" };
  }
  if (counts.validatorRuns >= config.maxValidatorRuns) {
    return { exhausted: true, exhaustedDimension: "maxValidatorRuns" };
  }
  return { exhausted: false };
}

/** 构建修订预算快照（计数 + 耗尽状态）。 */
export function buildRepairBudgetSnapshot(
  counts: RepairBudgetCounts,
  config: RepairBudgetConfig,
): RepairBudgetSnapshot {
  const { exhausted, exhaustedDimension } = checkRepairBudget(counts, config);
  return {
    modelCalls: counts.modelCalls,
    authorizations: counts.authorizations,
    candidates: counts.candidates,
    validatorRuns: counts.validatorRuns,
    exhausted,
    ...(exhaustedDimension ? { exhaustedDimension } : {}),
  };
}
