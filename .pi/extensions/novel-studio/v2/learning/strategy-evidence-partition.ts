/**
 * Strategy Evidence Partition — 策略证据按完整行为环境分区（DG-4，数据版本与发布治理 §5）
 *
 * 真相源：docs/data-version-release-governance-development-plan-20260813.md §5 DG-4
 *
 * 目标：阻止旧 Bundle 或旧评测协议污染新 Bundle 的策略信誉。
 *
 * 分区键从 modelVersion + strategyId 扩展为：
 *   modelVersion + bundleId + strategyId + evalProtocolVersion
 *
 * 语义：
 * - match：stored 与 requested 的 bundleId + evalProtocolVersion 完全一致 → 同一行为分区。
 * - legacy：stored 未捕获 bundleId / evalProtocolVersion（旧证据）→ 仅审计读取，
 *   不得作为新 bundle 的生产准入依据（读取隔离为弱先验）。
 * - mismatch：stored 与 requested 的 bundleId / evalProtocolVersion 不同 → 跨分区污染，
 *   必须拒绝写入 / 不继承。
 *
 * 边界（READY_LOCAL）：
 * - 纯函数，无 fs / 无模型 / 无副作用；可被 dist/ 与 dist-test/ 任意闭包消费。
 */

// ============================================================================
// 类型
// ============================================================================

/** 完整策略证据分区身份（计划 §4 strategyEvidencePartition 四元组）。 */
export interface StrategyEvidencePartition {
  modelVersion: string;
  bundleId: string;
  strategyId: string;
  evalProtocolVersion: string;
}

/**
 * 已存储条目的分区身份（可部分缺失，表示旧证据）。
 * 缺省字段为 undefined 时该维度未捕获，视作 legacy。
 */
export interface StoredPartitionIdentity {
  modelVersion?: string;
  bundleId?: string;
  evalProtocolVersion?: string;
}

/** 请求写入/读取时声明的行为环境身份（bundleId + evalProtocolVersion 必须非空）。 */
export interface RequestedPartitionIdentity {
  bundleId: string;
  evalProtocolVersion: string;
}

export type PartitionMatch = "match" | "legacy" | "mismatch";

export interface PartitionContaminationCheck {
  ok: boolean;
  classification: PartitionMatch;
  reason: string;
}

// ============================================================================
// 分区键派生
// ============================================================================

/**
 * 由完整四元组派生确定性分区键（:: 分隔）。
 * 任何一维变化 → 新分区键 → 新分区。
 */
export function buildStrategyEvidencePartitionKey(
  partition: StrategyEvidencePartition,
): string {
  return [
    partition.modelVersion,
    partition.bundleId,
    partition.strategyId,
    partition.evalProtocolVersion,
  ].join("::");
}

// ============================================================================
// 分区匹配与污染检测
// ============================================================================

/**
 * 分类 stored 与 requested 的分区关系。
 *
 * - stored 无 bundleId 且无 evalProtocolVersion → "legacy"（旧证据，未捕获行为身份）。
 * - stored 的 bundleId + evalProtocolVersion 与 requested 一致 → "match"。
 * - 否则 → "mismatch"（跨 bundle / 跨 eval 协议）。
 */
export function classifyPartitionMatch(
  stored: StoredPartitionIdentity,
  requested: RequestedPartitionIdentity,
): PartitionMatch {
  const storedHasBundle = typeof stored.bundleId === "string" && stored.bundleId.length > 0;
  const storedHasEval = typeof stored.evalProtocolVersion === "string" && stored.evalProtocolVersion.length > 0;

  if (!storedHasBundle && !storedHasEval) {
    return "legacy";
  }
  if (
    stored.bundleId === requested.bundleId &&
    stored.evalProtocolVersion === requested.evalProtocolVersion
  ) {
    return "match";
  }
  return "mismatch";
}

/**
 * 跨分区污染检测（DG-4 拒绝逻辑的纯函数入口）。
 *
 * - match → ok=true（可读写同一分区）。
 * - legacy → ok=false，reason 说明旧证据仅审计读取，不得作为新 bundle 准入依据。
 * - mismatch → ok=false，reason 说明跨 bundle / 跨 eval 协议污染。
 */
export function checkCrossBundleContamination(
  stored: StoredPartitionIdentity,
  requested: RequestedPartitionIdentity,
): PartitionContaminationCheck {
  const classification = classifyPartitionMatch(stored, requested);
  if (classification === "match") {
    return { ok: true, classification, reason: "partition identity 一致" };
  }
  if (classification === "legacy") {
    return {
      ok: false,
      classification,
      reason:
        "旧分区未捕获完整行为身份（bundleId/evalProtocolVersion），仅审计读取，不得作为新 bundle 的生产准入依据",
    };
  }
  return {
    ok: false,
    classification,
    reason:
      `跨分区污染：stored bundleId=${stored.bundleId ?? "(缺失)"}, ` +
      `evalProtocolVersion=${stored.evalProtocolVersion ?? "(缺失)"} 与 requested ` +
      `bundleId=${requested.bundleId}, evalProtocolVersion=${requested.evalProtocolVersion} 不一致`,
  };
}
