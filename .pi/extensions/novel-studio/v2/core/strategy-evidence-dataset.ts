/**
 * StrategyEvidenceDataset — 策略证据数据集（L0 工程闭环，STRATEGY-EVIDENCE-1 任务书）
 *
 * 设计目标：
 * - 模型版本隔离：不同 modelVersion 分区计数，旧模型胜率不迁移为新模型先验
 * - 重复 run 去重：同 (orchestratorRunId, strategyId) 只算一次
 * - 撤销恢复计数：revoked evidence 不计入 effective；revocationCount 按唯一 evidenceId 计数
 * - 无 human/eligible 证据不晋级（canPromote=false）
 * - RQ3 负面/污染样本不得提升策略（polluted=true 不计入 effective）
 * - 证据冲突进入 quarantine，不自动选边
 *
 * 边界（L0 工程闭环）：
 * - 默认只记录与汇总，不改变生产选择概率（无 alpha/beta 修改）
 * - 不自动修改 prompt/constitution/hard facts
 * - 不调用网络模型
 * - 不修改 finalText / 不提交状态
 * - 不是 gate；不阻断正文生成
 *
 * 与 StrategyPolicyStore 的关系：
 * - StrategyPolicyStore 是运行时存储（含 alpha/beta 信誉更新与 Thompson Sampling）
 * - 本模块是事后证据数据集（聚合分析、可撤销、可审计、可冲突隔离）
 * - 本模块输出 canPromote 仅作为晋级建议信号，调用方决定是否调用
 *   StrategyPolicyStore.setStatus("active") 等人工干预动作
 *
 * 模块为 standalone tooling，由 tsconfig.prod.json files 数组单独编译到 dist/。
 */

import { isDeepStrictEqual } from "node:util";
import type { EligiblePair } from "./eligible-sample-registry.js";
import {
  FIXED_REVIEWER_TYPE,
  FIXED_REVIEWER_MODEL,
  FIXED_HUMAN_EQUIVALENT,
} from "./human-proxy-provenance.js";
import type { NormalizedHumanProxyVerdict } from "./human-proxy-provenance.js";

// ============================================================================
// Schema contract
// ============================================================================

export const STRATEGY_EVIDENCE_SCHEMA_ID = "pinovel.strategy-evidence" as const;
export const STRATEGY_EVIDENCE_SCHEMA_VERSION = "v1" as const;

// ============================================================================
// 离线准入阈值（STRATEGY-ADMISSION-1B）
// ============================================================================
//
// 单一真相源：strategy-policy-store.ts 的 evaluateAdmission 与本模块的
// compileAdmissionDecisions 必须消费同一对常量，避免阈值漂移。
// 阈值口径：同一 modelVersion + strategyId 分区至少 5 个 eligible decisions
// 且其中至少 3 个含 human-equivalent verdict 才建议 active。

export const MIN_ADMISSION_ELIGIBLE_DECISIONS = 5;
export const MIN_ADMISSION_HUMAN_VERDICTS = 3;

// ============================================================================
// 类型
// ============================================================================

export type StrategyEvidenceOutcome = "win" | "loss" | "tie";
export type StrategyEvidenceSource = "judge" | "user";

export interface StrategyEvidenceRecord {
  /** 证据唯一 ID */
  evidenceId: string;
  /** 策略 ID */
  strategyId: string;
  /** 模型版本（按版本隔离，旧模型胜率不迁移为新模型先验） */
  modelVersion: string;
  /** 单次 orchestrator 运行 ID（用于重复 run 去重） */
  orchestratorRunId: string;
  /** 来源章节，如 "ch17" */
  sourceChapter: string;
  /** outcome: editorial 胜 / raw 胜 / tie */
  outcome: StrategyEvidenceOutcome;
  /** 信号来源：judge 裁判 / user 用户修改反馈 */
  source: StrategyEvidenceSource;
  /** 权重（user 反馈高权重，多重样本） */
  weight: number;
  /** 时间戳 ISO */
  timestamp: string;
  /** 是否撤销（撤销后不计入 effective） */
  revoked?: boolean;
  /** 撤销原因 */
  revokedReason?: string;
  /** 撤销时间 */
  revokedAt?: string;
  /** 是否含人工裁决（晋级门槛之一） */
  hasHumanVerdict?: boolean;
  /** 是否来自 eligible pair（晋级门槛之一） */
  fromEligiblePair?: boolean;
  /** 是否污染（RQ3 负面样本，不得提升策略） */
  polluted?: boolean;
  /** 污染原因 */
  pollutedReason?: string;
  /** 是否隔离（证据冲突，不自动选边） */
  quarantined?: boolean;
  /** 隔离原因 */
  quarantineReason?: string;
  /** 可选备注 */
  note?: string;
}

export interface StrategyEvidenceDatasetResult {
  /** 入参 records（原样保留，含 revoked/quarantined/polluted，供审计） */
  records: StrategyEvidenceRecord[];
  /** 有效证据数（去重 + 过滤 revoked/polluted/quarantined 后） */
  effectiveCount: number;
  /** 有效证据中含人工裁决的数量 */
  humanVerdictCount: number;
  /** 有效证据中来自 eligible pair 的数量 */
  eligiblePairCount: number;
  /** 是否至少有一个 modelVersion 分区满足晋级条件 */
  canPromote: boolean;
  /** 撤销证据数（按唯一 evidenceId 计数，重复 revoke 不重复计数） */
  revocationCount: number;
  /** 隔离证据数（按唯一 evidenceId 计数） */
  quarantineCount: number;
  /** 按 modelVersion 分区的有效证据计数 */
  partitions: Record<string, number>;
  /** 按 modelVersion 独立计算的晋级摘要 */
  partitionSummaries: Record<string, StrategyEvidencePartitionSummary>;
}

export interface StrategyEvidencePartitionSummary {
  effectiveCount: number;
  humanVerdictCount: number;
  eligiblePairCount: number;
  canPromote: boolean;
}

export interface StrategyEvidenceArtifact {
  schemaId: typeof STRATEGY_EVIDENCE_SCHEMA_ID;
  schemaVersion: typeof STRATEGY_EVIDENCE_SCHEMA_VERSION;
  workspaceId: string;
  records: StrategyEvidenceRecord[];
}

export type StrategyEvidenceValidationErrorCode =
  | "invalid_root"
  | "invalid_schema_id"
  | "unsupported_schema_version"
  | "invalid_field"
  | "duplicate_evidence_id"
  | "artifact_identity_changed"
  | "history_truncated"
  | "history_mutated";

export interface StrategyEvidenceValidationError {
  code: StrategyEvidenceValidationErrorCode;
  path: string;
  message: string;
}

export type StrategyEvidenceArtifactValidationResult =
  | { ok: true; artifact: StrategyEvidenceArtifact }
  | { ok: false; error: StrategyEvidenceValidationError };

export type StrategyEvidenceAppendValidationResult =
  | { ok: true; appendedCount: number }
  | { ok: false; error: StrategyEvidenceValidationError };

type InternalValidationResult =
  | { ok: true }
  | { ok: false; error: StrategyEvidenceValidationError };

const RECORD_KEYS = new Set<string>([
  "evidenceId",
  "strategyId",
  "modelVersion",
  "orchestratorRunId",
  "sourceChapter",
  "outcome",
  "source",
  "weight",
  "timestamp",
  "revoked",
  "revokedReason",
  "revokedAt",
  "hasHumanVerdict",
  "fromEligiblePair",
  "polluted",
  "pollutedReason",
  "quarantined",
  "quarantineReason",
  "note",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validationError(
  code: StrategyEvidenceValidationErrorCode,
  path: string,
  message: string
): { ok: false; error: StrategyEvidenceValidationError } {
  return { ok: false, error: { code, path, message } };
}

function validateRequiredString(
  record: Record<string, unknown>,
  field: string,
  path: string
): { ok: false; error: StrategyEvidenceValidationError } | undefined {
  if (typeof record[field] !== "string" || record[field].trim().length === 0) {
    return validationError("invalid_field", `${path}.${field}`, `${field} 必须是非空字符串`);
  }
  return undefined;
}

function validateEvidenceRecord(
  input: unknown,
  path: string
): InternalValidationResult {
  if (!isRecord(input)) {
    return validationError("invalid_field", path, "evidence record 必须是对象");
  }

  for (const key of Object.keys(input)) {
    if (!RECORD_KEYS.has(key)) {
      return validationError("invalid_field", `${path}.${key}`, `未知 evidence 字段: ${key}`);
    }
  }

  for (const field of [
    "evidenceId",
    "strategyId",
    "modelVersion",
    "orchestratorRunId",
    "sourceChapter",
    "timestamp",
  ]) {
    const error = validateRequiredString(input, field, path);
    if (error) return error;
  }

  if (input.outcome !== "win" && input.outcome !== "loss" && input.outcome !== "tie") {
    return validationError("invalid_field", `${path}.outcome`, "outcome 必须是 win/loss/tie");
  }
  if (input.source !== "judge" && input.source !== "user") {
    return validationError("invalid_field", `${path}.source`, "source 必须是 judge/user");
  }
  if (typeof input.weight !== "number" || !Number.isFinite(input.weight) || input.weight < 0) {
    return validationError("invalid_field", `${path}.weight`, "weight 必须是有限非负数");
  }
  if (!Number.isFinite(Date.parse(input.timestamp as string))) {
    return validationError("invalid_field", `${path}.timestamp`, "timestamp 必须是有效 ISO 时间");
  }

  for (const field of [
    "revoked",
    "hasHumanVerdict",
    "fromEligiblePair",
    "polluted",
    "quarantined",
  ]) {
    if (input[field] !== undefined && typeof input[field] !== "boolean") {
      return validationError("invalid_field", `${path}.${field}`, `${field} 必须是 boolean`);
    }
  }
  for (const field of [
    "revokedReason",
    "revokedAt",
    "pollutedReason",
    "quarantineReason",
    "note",
  ]) {
    if (input[field] !== undefined && typeof input[field] !== "string") {
      return validationError("invalid_field", `${path}.${field}`, `${field} 必须是 string`);
    }
  }

  return { ok: true };
}

/**
 * Parse and validate a frozen pinovel.strategy-evidence/v1 artifact.
 * The function is pure and never writes StrategyPolicyStore.
 */
export function validateStrategyEvidenceArtifact(
  input: unknown
): StrategyEvidenceArtifactValidationResult {
  if (!isRecord(input)) {
    return validationError("invalid_root", "$", "strategy evidence artifact 必须是对象");
  }
  if (input.schemaId !== STRATEGY_EVIDENCE_SCHEMA_ID) {
    return validationError("invalid_schema_id", "schemaId", `schemaId 必须是 ${STRATEGY_EVIDENCE_SCHEMA_ID}`);
  }
  if (input.schemaVersion !== STRATEGY_EVIDENCE_SCHEMA_VERSION) {
    return validationError(
      "unsupported_schema_version",
      "schemaVersion",
      `仅支持 ${STRATEGY_EVIDENCE_SCHEMA_VERSION}`
    );
  }
  if (typeof input.workspaceId !== "string" || input.workspaceId.trim().length === 0) {
    return validationError("invalid_field", "workspaceId", "workspaceId 必须是非空字符串");
  }
  if (!Array.isArray(input.records)) {
    return validationError("invalid_field", "records", "records 必须是数组");
  }

  const seenEvidenceIds = new Set<string>();
  for (let index = 0; index < input.records.length; index += 1) {
    const recordResult = validateEvidenceRecord(input.records[index], `records[${index}]`);
    if (!recordResult.ok) return recordResult;
    const evidenceId = (input.records[index] as Record<string, unknown>).evidenceId as string;
    if (seenEvidenceIds.has(evidenceId)) {
      return validationError(
        "duplicate_evidence_id",
        `records[${index}].evidenceId`,
        `evidenceId 重复: ${evidenceId}`
      );
    }
    seenEvidenceIds.add(evidenceId);
  }

  return { ok: true, artifact: input as unknown as StrategyEvidenceArtifact };
}

/**
 * Validate an append-only artifact transition.
 * Existing records must remain structurally equal and in the same order;
 * revocation/quarantine in later slices must therefore be represented by new
 * events instead of rewriting prior evidence.
 */
export function validateStrategyEvidenceAppend(
  previousInput: unknown,
  nextInput: unknown
): StrategyEvidenceAppendValidationResult {
  const previous = validateStrategyEvidenceArtifact(previousInput);
  if (!previous.ok) return previous;
  const next = validateStrategyEvidenceArtifact(nextInput);
  if (!next.ok) return next;

  if (previous.artifact.workspaceId !== next.artifact.workspaceId) {
    return {
      ok: false,
      error: {
        code: "artifact_identity_changed",
        path: "workspaceId",
        message: "append 不能改变 workspaceId",
      },
    };
  }
  if (next.artifact.records.length < previous.artifact.records.length) {
    return {
      ok: false,
      error: {
        code: "history_truncated",
        path: "records",
        message: "append 不能删除历史 evidence",
      },
    };
  }
  for (let index = 0; index < previous.artifact.records.length; index += 1) {
    if (!isDeepStrictEqual(previous.artifact.records[index], next.artifact.records[index])) {
      return {
        ok: false,
        error: {
          code: "history_mutated",
          path: `records[${index}]`,
          message: "append 不能修改或重排历史 evidence",
        },
      };
    }
  }

  return {
    ok: true,
    appendedCount: next.artifact.records.length - previous.artifact.records.length,
  };
}

// ============================================================================
// 编译：去重 + 过滤 + 汇总
// ============================================================================

/**
 * 编译策略证据数据集。
 *
 * 步骤：
 * 1. 重复 run 去重：同 (modelVersion, orchestratorRunId, strategyId) 只保留首条
 * 2. effective 过滤：剔除 revoked / polluted / quarantined
 * 3. 汇总：effectiveCount / humanVerdictCount / eligiblePairCount / canPromote /
 *    revocationCount（按唯一 evidenceId 计数）/ quarantineCount / partitions
 *
 * 不变量：
 * - 不修改 alpha/beta（不改变生产选择概率）
 * - 不修改 prompt/constitution/hard facts
 * - 不调用模型
 * - 不是 gate；不阻断正文生成
 */
export function compileStrategyEvidenceDataset(
  records: StrategyEvidenceRecord[]
): StrategyEvidenceDatasetResult {
  // 1. 重复 run 去重：同 (modelVersion, orchestratorRunId, strategyId) 只保留首条
  const seenRunStrategy = new Set<string>();
  const deduped: StrategyEvidenceRecord[] = [];
  for (const r of records) {
    const key = `${r.modelVersion}::${r.orchestratorRunId}::${r.strategyId}`;
    if (seenRunStrategy.has(key)) continue;
    seenRunStrategy.add(key);
    deduped.push(r);
  }

  // 2. effective 过滤：剔除 revoked / polluted / quarantined
  const effective = deduped.filter(
    (r) => !r.revoked && !r.polluted && !r.quarantined
  );

  // 3. 汇总
  const humanVerdictCount = effective.filter(
    (r) => r.hasHumanVerdict === true
  ).length;
  const eligiblePairCount = effective.filter(
    (r) => r.fromEligiblePair === true
  ).length;
  const effectiveCount = effective.length;

  // revocationCount：按唯一 evidenceId 计数（重复 revoke 不重复计数）
  const revokedIds = new Set<string>();
  for (const r of records) {
    if (r.revoked === true) {
      revokedIds.add(r.evidenceId);
    }
  }
  const revocationCount = revokedIds.size;

  // quarantineCount：按唯一 evidenceId 计数
  const quarantinedIds = new Set<string>();
  for (const r of records) {
    if (r.quarantined === true) {
      quarantinedIds.add(r.evidenceId);
    }
  }
  const quarantineCount = quarantinedIds.size;

  // partitions：按 modelVersion 分区计数（仅 effective，体现模型版本隔离）
  const partitions: Record<string, number> = {};
  const partitionSummaries: Record<string, StrategyEvidencePartitionSummary> = {};
  for (const r of effective) {
    partitions[r.modelVersion] = (partitions[r.modelVersion] ?? 0) + 1;
    const summary = partitionSummaries[r.modelVersion] ?? {
      effectiveCount: 0,
      humanVerdictCount: 0,
      eligiblePairCount: 0,
      canPromote: false,
    };
    summary.effectiveCount += 1;
    if (r.hasHumanVerdict === true) summary.humanVerdictCount += 1;
    if (r.fromEligiblePair === true) summary.eligiblePairCount += 1;
    partitionSummaries[r.modelVersion] = summary;
  }
  for (const summary of Object.values(partitionSummaries)) {
    summary.canPromote =
      summary.effectiveCount > 0 &&
      summary.humanVerdictCount >= 1 &&
      summary.eligiblePairCount >= 1;
  }
  const canPromote = Object.values(partitionSummaries).some(
    (summary) => summary.canPromote
  );

  return {
    records,
    effectiveCount,
    humanVerdictCount,
    eligiblePairCount,
    canPromote,
    revocationCount,
    quarantineCount,
    partitions,
    partitionSummaries,
  };
}

// ============================================================================
// 冲突检测：同 strategy 同源 win+loss → quarantined
// ============================================================================

/**
 * 检测证据冲突并标记 quarantined。
 *
 * 冲突定义：同 strategyId + 同 source（judge/user）+ 同时出现 win 和 loss outcome
 *   → 该 (strategyId, source) 组下所有冲突 evidence 标记为 quarantined
 *
 * 不冲突：
 * - 不同 strategyId（正常不同策略）
 * - 同 strategyId 不同 source（user 可推翻 judge，是正常机制）
 *
 * 不变量：
 * - quarantineReason 不指定胜方（不自动选边）
 * - 返回新数组，不修改入参
 */
export function detectEvidenceConflicts(
  records: StrategyEvidenceRecord[]
): StrategyEvidenceRecord[] {
  // 按 (modelVersion, strategyId, source) 分组，检测同时存在 win 和 loss
  const groups = new Map<string, { hasWin: boolean; hasLoss: boolean }>();
  for (const r of records) {
    const key = `${r.modelVersion}::${r.strategyId}::${r.source}`;
    const g = groups.get(key) ?? { hasWin: false, hasLoss: false };
    if (r.outcome === "win") g.hasWin = true;
    if (r.outcome === "loss") g.hasLoss = true;
    groups.set(key, g);
  }

  // 找出冲突组
  const conflictKeys = new Set<string>();
  for (const [key, g] of groups) {
    if (g.hasWin && g.hasLoss) {
      conflictKeys.add(key);
    }
  }

  // 标记冲突组下的 evidence 为 quarantined（保留原 quarantineReason 若已存在）
  return records.map((r) => {
    const key = `${r.modelVersion}::${r.strategyId}::${r.source}`;
    if (!conflictKeys.has(key)) return r;
    return {
      ...r,
      quarantined: true,
      quarantineReason:
        r.quarantineReason ??
        `evidence conflict: 同策略同源同时存在 win 与 loss（strategy=${r.strategyId}, source=${r.source}），进入隔离不自动选边`,
    };
  });
}

// ============================================================================
// 撤销：把指定 evidenceId 标记为 revoked
// ============================================================================

/**
 * 撤销指定 evidenceId 的证据。
 *
 * 行为：
 * - 匹配 evidenceId 且未 revoked 的 record：revoked=true, revokedReason=reason, revokedAt=now
 * - 已 revoked 的 record：保持 revoked=true，保留首个原因与时间（不重复计数）
 * - 其他 record：不变
 *
 * 返回新数组，不修改入参。
 */
export function revokeEvidence(
  records: StrategyEvidenceRecord[],
  evidenceId: string,
  reason: string
): StrategyEvidenceRecord[] {
  const revokedAt = new Date().toISOString();
  return records.map((r) => {
    if (r.evidenceId !== evidenceId) return r;
    if (r.revoked === true) {
      // 已 revoked：保留首个原因与时间，不重复计数
      return {
        ...r,
        revokedReason: r.revokedReason ?? reason,
        revokedAt: r.revokedAt ?? revokedAt,
      };
    }
    return {
      ...r,
      revoked: true,
      revokedReason: reason,
      revokedAt,
    };
  });
}

// ============================================================================
// STRATEGY-ADMISSION-1B：分区 evidence 驱动的状态建议
// ============================================================================
//
// 设计目标（docs/remaining-development-dispatch-plan-20260715.md §7 STRATEGY-ADMISSION-1B）：
// - 消费 evidence artifact（records），显式产生 candidate/active 建议
// - 按 modelVersion + strategyId 分区；同一 modelVersion 不同 strategyId 互不汇总
// - 阈值：每分区 eligible decisions >=5 且 human-equivalent verdicts >=3 才建议 active
// - rollback/reverse：revoke evidence 后重算，active 建议应降回 candidate
// - 不自动改生产（不调用 StrategyPolicyStore.setStatus、不写 alpha/beta、不写文件）
//
// 与 StrategyPolicyStore.evaluateAdmission 的关系：
// - evaluateAdmission 接受调用方预先聚合的 summary（单分区）
// - compileAdmissionDecisions 直接消费 records，一次性产出全部分区的建议
// - 两者共享同一对阈值常量，语义一致；调用方决定是否显式 setStatus

export interface StrategyAdmissionEvaluation {
  /** 策略 ID */
  strategyId: string;
  /** 模型版本键 */
  modelVersion: string;
  /** 建议状态：未达阈值 candidate / 达阈值 active */
  recommendedStatus: "candidate" | "active";
  /** 有效 eligible decisions 数（fromEligiblePair=true 且未撤销/污染/隔离） */
  eligibleDecisionCount: number;
  /** 含 human-equivalent verdict 的有效证据数（hasHumanVerdict=true 且未撤销/污染/隔离） */
  humanVerdictCount: number;
  /** 建议原因（可解释性） */
  reason: string;
}

/**
 * 编译每个 (modelVersion, strategyId) 分区的离线准入建议。
 *
 * 步骤：
 * 1. 重复 run 去重：同 (modelVersion, orchestratorRunId, strategyId) 只保留首条
 *    （与 compileStrategyEvidenceDataset 同一去重口径）
 * 2. effective 过滤：剔除 revoked / polluted / quarantined
 * 3. 按 (modelVersion, strategyId) 分区
 * 4. 每分区累计 effectiveCount / humanVerdictCount / eligibleDecisionCount
 * 5. 应用 MIN_ADMISSION_ELIGIBLE_DECISIONS (5) + MIN_ADMISSION_HUMAN_VERDICTS (3) 阈值
 * 6. 按 (modelVersion, strategyId) 字典序排序，保证输出确定性
 *
 * 不变量：
 * - 纯函数：不修改入参 records，不调用任何 store，不写文件
 * - 不修改 alpha/beta（不改变生产选择概率）
 * - 不修改 prompt/constitution/hard facts
 * - 不调用模型
 * - 不是 gate；不阻断正文生成
 * - 跨模型/跨策略污染不可能：每个 (modelVersion, strategyId) 独立评估
 * - 返回纯读建议；调用方必须显式 setStatus 才能改变生产状态
 */
export function compileAdmissionDecisions(
  records: StrategyEvidenceRecord[]
): StrategyAdmissionEvaluation[] {
  // 1. 重复 run 去重：同 (modelVersion, orchestratorRunId, strategyId) 只保留首条
  const seenRunStrategy = new Set<string>();
  const deduped: StrategyEvidenceRecord[] = [];
  for (const r of records) {
    const key = `${r.modelVersion}::${r.orchestratorRunId}::${r.strategyId}`;
    if (seenRunStrategy.has(key)) continue;
    seenRunStrategy.add(key);
    deduped.push(r);
  }

  // 2. effective 过滤：剔除 revoked / polluted / quarantined
  const effective = deduped.filter(
    (r) => !r.revoked && !r.polluted && !r.quarantined
  );

  // 3-4. 按 (modelVersion, strategyId) 分区并累计计数
  interface PartitionAccumulator {
    strategyId: string;
    modelVersion: string;
    humanVerdictCount: number;
    eligibleDecisionCount: number;
  }
  const partitions = new Map<string, PartitionAccumulator>();
  for (const r of effective) {
    const key = `${r.modelVersion}::${r.strategyId}`;
    let p = partitions.get(key);
    if (!p) {
      p = {
        strategyId: r.strategyId,
        modelVersion: r.modelVersion,
        humanVerdictCount: 0,
        eligibleDecisionCount: 0,
      };
      partitions.set(key, p);
    }
    if (r.hasHumanVerdict === true) p.humanVerdictCount += 1;
    if (r.fromEligiblePair === true) p.eligibleDecisionCount += 1;
  }

  // 5. 应用阈值 → recommendedStatus
  const decisions: StrategyAdmissionEvaluation[] = [];
  for (const p of partitions.values()) {
    let recommendedStatus: "candidate" | "active";
    let reason: string;
    if (p.eligibleDecisionCount < MIN_ADMISSION_ELIGIBLE_DECISIONS) {
      recommendedStatus = "candidate";
      reason = `eligible decisions ${p.eligibleDecisionCount}/${MIN_ADMISSION_ELIGIBLE_DECISIONS}，保持 candidate`;
    } else if (p.humanVerdictCount < MIN_ADMISSION_HUMAN_VERDICTS) {
      recommendedStatus = "candidate";
      reason = `human verdicts ${p.humanVerdictCount}/${MIN_ADMISSION_HUMAN_VERDICTS}，保持 candidate`;
    } else {
      recommendedStatus = "active";
      reason = `admission threshold satisfied: eligible=${p.eligibleDecisionCount}, human=${p.humanVerdictCount}`;
    }
    decisions.push({
      strategyId: p.strategyId,
      modelVersion: p.modelVersion,
      recommendedStatus,
      eligibleDecisionCount: p.eligibleDecisionCount,
      humanVerdictCount: p.humanVerdictCount,
      reason,
    });
  }

  // 6. 字典序排序，保证输出确定性
  decisions.sort((a, b) => {
    if (a.modelVersion !== b.modelVersion) {
      return a.modelVersion < b.modelVersion ? -1 : 1;
    }
    if (a.strategyId !== b.strategyId) {
      return a.strategyId < b.strategyId ? -1 : 1;
    }
    return 0;
  });

  return decisions;
}

// ============================================================================
// STRATEGY-EVIDENCE-1B：append 操作 + eligible pair 导入
// ============================================================================
//
// 设计目标（docs/remaining-development-dispatch-plan-20260715.md §3 P0-D）：
// - appendEvidence：实际 append 操作，返回新 artifact（append-only 校验由
//   validateStrategyEvidenceAppend 承载）
// - importEligiblePairAsEvidence：从 EligiblePair + NormalizedHumanProxyVerdict
//   导入为 StrategyEvidenceRecord；严格 human provenance 校验
//
// 不变量：
// - 纯函数：不读写文件、不调用模型、不修改 alpha/beta、不提交状态
// - 只有 validated_human_proxy + humanEquivalent=true 才设 hasHumanVerdict=true
// - 普通 machine-review / natural_person 不得冒充 human
// - fallback 样本（no_editorial/factguard_block/story_preservation_block）不得导入
// - 跨 modelVersion/strategyId/orchestratorRunId 不得汇总

/**
 * 实际 append 操作：在 artifact 末尾追加 newRecords，返回新 artifact。
 *
 * 步骤：
 * 1. 构造 next = { ...artifact, records: [...artifact.records, ...newRecords] }
 * 2. 调用 validateStrategyEvidenceAppend(artifact, next) 校验 append-only 转换
 * 3. 校验通过 → 返回新 artifact + appendedCount
 * 4. 校验失败 → 返回 error（duplicate_evidence_id / invalid_field / ...）
 *
 * 不变量：
 * - 不修改入参 artifact（不可变）
 * - 不写文件（持久化由 StrategyEvidenceStore 承载）
 * - 不调用模型、不提交状态
 */
export function appendEvidence(
  artifact: StrategyEvidenceArtifact,
  newRecords: StrategyEvidenceRecord[]
):
  | { ok: true; artifact: StrategyEvidenceArtifact; appendedCount: number }
  | { ok: false; error: StrategyEvidenceValidationError } {
  const next: StrategyEvidenceArtifact = {
    ...artifact,
    records: [...artifact.records, ...newRecords],
  };
  const validation = validateStrategyEvidenceAppend(artifact, next);
  if (!validation.ok) return validation;
  return {
    ok: true,
    artifact: next,
    appendedCount: validation.appendedCount,
  };
}

// ----------------------------------------------------------------------------
// importEligiblePairAsEvidence
// ----------------------------------------------------------------------------

/**
 * 导入上下文（调用方提供 workspaceId + timestamp + 可选 evidenceId/weight）。
 */
export interface ImportEligiblePairContext {
  /** workspace 标识（写入 record 的 audit 上下文，不进入 record 字段） */
  workspaceId: string;
  /** 导入时间戳 ISO */
  timestamp: string;
  /** 可选自定义 evidenceId（默认从 pairId + verdictId 派生） */
  evidenceId?: string;
  /** 可选权重覆盖（默认 2.0：user 反馈高权重） */
  weight?: number;
}

export type ImportEligiblePairResult =
  | { ok: true; record: StrategyEvidenceRecord }
  | { ok: false; reasons: string[] };

/**
 * 从 EligiblePair + NormalizedHumanProxyVerdict 导入为 StrategyEvidenceRecord。
 *
 * 严格 human provenance 校验：
 * - verdict.reviewerType 必须为 validated_human_proxy（natural_person 不得冒充；
 *   普通机器审阅不得 humanEquivalent）
 * - verdict.humanEquivalent 必须为 true
 * - verdict.reviewerModel 必须为 gpt5.6-sol
 *
 * eligible pair 校验：
 * - pair.outcomeType 必须为 editorial_win / judge_raw_win（fallback 样本不得冒充）
 *
 * provenance 一致性（防跨源污染）：
 * - pair.runProvenance.modelVersion === verdict.modelVersion
 * - pair.runProvenance.orchestratorRunId === verdict.provenance.orchestratorRunId
 * - pair.runProvenance.caseId === verdict.provenance.caseId
 *
 * preference 映射：
 * - editorial → outcome=win
 * - raw → outcome=loss
 * - tie → outcome=tie
 * - undecided → 拒绝（无策略信号）
 *
 * 不变量：
 * - 纯函数：不读写文件、不调用模型、不修改 alpha/beta、不提交状态
 * - 只有 validated_human_proxy + humanEquivalent=true 才设 hasHumanVerdict=true
 * - 导入即 fromEligiblePair=true（pair 已通过 registry 校验）
 * - source="user"（human verdict 是 user 反馈源）
 */
export function importEligiblePairAsEvidence(
  pair: EligiblePair,
  verdict: NormalizedHumanProxyVerdict,
  context: ImportEligiblePairContext
): ImportEligiblePairResult {
  const reasons: string[] = [];

  // 1. pair 必须是 eligible（outcomeType 只允许 editorial_win / judge_raw_win）
  //    运行时防御：篡改 outcomeType 为 fallback 类型应拒绝
  if (
    pair.outcomeType !== "editorial_win" &&
    pair.outcomeType !== "judge_raw_win"
  ) {
    reasons.push(
      `pair.outcomeType=${pair.outcomeType} 非 eligible（只允许 editorial_win/judge_raw_win；fallback 样本不得冒充 eligible evidence）`,
    );
  }

  // 2. 严格 human provenance
  //    防御性读取：运行时 verdict 可能被篡改（JS 调用方），按字符串比较保留 natural_person 检测
  const reviewerType = verdict.reviewerType as string;
  if (reviewerType === "natural_person") {
    reasons.push(
      `reviewerType=natural_person 不得冒充；只允许 ${FIXED_REVIEWER_TYPE}（gpt5.6-sol 经用户实测与真人审阅一致），普通自然人身份不写入策略证据`,
    );
  } else if (reviewerType !== FIXED_REVIEWER_TYPE) {
    reasons.push(
      `reviewerType 必须为 ${FIXED_REVIEWER_TYPE}（当前：${reviewerType}）；普通机器审阅不得冒充 human-equivalent`,
    );
  }

  const humanEquivalent = verdict.humanEquivalent as unknown;
  if (humanEquivalent !== FIXED_HUMAN_EQUIVALENT) {
    reasons.push(
      `humanEquivalent 必须为 true（当前：${String(humanEquivalent)}）；普通机器审阅不得冒充 human-equivalent`,
    );
  }

  const reviewerModel = verdict.reviewerModel as string;
  if (reviewerModel !== FIXED_REVIEWER_MODEL) {
    reasons.push(
      `reviewerModel 必须为 ${FIXED_REVIEWER_MODEL}（当前：${reviewerModel}）`,
    );
  }

  // 3. preference != undecided
  if (verdict.preference === "undecided") {
    reasons.push(
      "preference=undecided 无策略信号，不得作为 evidence（reviewer 须给出明确偏好或记 tie）",
    );
  }

  // 4. provenance 一致性：pair 与 verdict 必须同源
  const pairModelVersion = pair.runProvenance?.modelVersion;
  if (pairModelVersion !== verdict.modelVersion) {
    reasons.push(
      `pair.runProvenance.modelVersion=${pairModelVersion} !== verdict.modelVersion=${verdict.modelVersion}（跨模型污染：旧模型证据不得污染新模型分区）`,
    );
  }
  const pairRunId = pair.runProvenance?.orchestratorRunId;
  const verdictRunId = verdict.provenance?.orchestratorRunId;
  if (pairRunId !== verdictRunId) {
    reasons.push(
      `pair.runProvenance.orchestratorRunId=${pairRunId} !== verdict.provenance.orchestratorRunId=${verdictRunId}（跨 run 污染：pair 与 verdict 必须来自同一次 orchestrate 运行）`,
    );
  }
  const pairCaseId = pair.runProvenance?.caseId;
  const verdictCaseId = verdict.provenance?.caseId;
  if (pairCaseId !== verdictCaseId) {
    reasons.push(
      `pair.runProvenance.caseId=${pairCaseId} !== verdict.provenance.caseId=${verdictCaseId}（跨 case 污染）`,
    );
  }

  // 5. context 必填校验
  if (
    typeof context.workspaceId !== "string" ||
    context.workspaceId.trim().length === 0
  ) {
    reasons.push("context.workspaceId 必须为非空字符串");
  }
  if (
    typeof context.timestamp !== "string" ||
    !Number.isFinite(Date.parse(context.timestamp))
  ) {
    reasons.push("context.timestamp 必须为有效 ISO 时间");
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  // 6. outcome 映射
  const outcome: StrategyEvidenceOutcome =
    verdict.preference === "editorial"
      ? "win"
      : verdict.preference === "raw"
        ? "loss"
        : "tie";

  // 7. 构造 record
  const record: StrategyEvidenceRecord = {
    evidenceId:
      context.evidenceId ?? `${pair.pairId}::${verdict.verdictId}`,
    strategyId: verdict.strategyId,
    modelVersion: verdict.modelVersion,
    orchestratorRunId: pair.runProvenance!.orchestratorRunId,
    sourceChapter: verdict.sourceChapter,
    outcome,
    source: "user",
    weight: context.weight ?? 2.0,
    timestamp: context.timestamp,
    hasHumanVerdict: true,
    fromEligiblePair: true,
  };

  return { ok: true, record };
}
