/**
 * MEMORY-5 遗忘、衰减与冲突处理（MEMORY-LIFECYCLE-1）
 *
 * 目标（任务文档 §九）：
 * - 状态版本 + supersede 关系（§9.3）
 * - 临时推断与诊断 TTL/衰减（§6.4 / §9.2）
 * - 永久/活跃/归档分层（§9.1 / §9.2）
 * - 硬冲突不静默覆盖，生成结构化 FailureEnvelope
 *
 * 本模块纯函数、无副作用。TTL 判定基于注入的 now（可测）。
 */

import type { MemoryRecord, MemoryType } from "./memory-record.js";

// ============================================================================
// 分层
// ============================================================================

export type MemoryTier = "permanent" | "active" | "archived" | "expired";

/** 永久保留类型（§9.1）：不得衰减/过期 */
const PERMANENT_TYPES: readonly MemoryType[] = [
  "canon", // 世界观硬规则/不可违背事实
  "promise", // PromiseLedger 创建/推进/兑现/废弃
  "source_text", // 最终正文来源索引
];

/** 可衰减类型（§9.2） */
const DECAY_TYPES: readonly MemoryType[] = [
  "working",
  "diagnostic",
];

export function tierForMemory(record: MemoryRecord, now: number): MemoryTier {
  // 生命周期状态优先于类型分层：被取代/归档/过期的记录不得再作为永久活跃事实
  if (record.lifecycleStatus === "archived") return "archived";
  if (record.lifecycleStatus === "expired") return "expired";
  if (record.lifecycleStatus === "superseded") return "archived";
  if (PERMANENT_TYPES.includes(record.memoryType)) return "permanent";
  if (DECAY_TYPES.includes(record.memoryType)) {
    if (record.expiresAt && Date.parse(record.expiresAt) <= now) return "expired";
  }
  return "active";
}

/**
 * 判定记录是否应参与默认检索。
 *
 * MEMORY-5 验收：过期诊断不会进入后续章节事实上下文。
 * 衰减不删除来源，只降低默认检索权重或转入归档层（§9.2）。
 */
export function shouldDefaultRetrieve(record: MemoryRecord, now: number): boolean {
  const tier = tierForMemory(record, now);
  if (tier === "expired" || tier === "archived") return false;
  if (record.lifecycleStatus === "conflicted") {
    // 冲突状态被明确标识，模型不能静默选边（§6 验收）
    return false;
  }
  return true;
}

// ============================================================================
// TTL 判定
// ============================================================================

export interface TtlDecision {
  expired: boolean;
  reason: string;
  expiresAt: string | null;
}

/**
 * 递归检查诊断记忆的 TTL 是否已到期。
 * 诊断记忆必须带 ttlSeconds（validateMemoryRecord 已强制）。
 */
export function evaluateTtl(record: MemoryRecord, now: number): TtlDecision {
  if (record.memoryType !== "diagnostic") {
    return { expired: false, reason: "非诊断记忆，无 TTL 约束", expiresAt: record.expiresAt };
  }
  if (!record.expiresAt) {
    return { expired: false, reason: "无 expiresAt（应由创建端设置 TTL）", expiresAt: null };
  }
  const expired = Date.parse(record.expiresAt) <= now;
  return {
    expired,
    reason: expired ? "诊断 TTL 已到期，转入过期层" : "诊断 TTL 未到期",
    expiresAt: record.expiresAt,
  };
}

// ============================================================================
// 版本化 + supersede
// ============================================================================

export interface VersionedMemory {
  /** 新版本记录 */
  record: MemoryRecord;
  /** 被取代的旧 memoryId */
  supersedesMemoryId: string | null;
}

/**
 * 为新记录创建版本化条目：若与现有记录同结构键，则新记录标记 supersedes 旧记录。
 * 保留历史（不删除旧记录），仅表达替代关系（§七.4 / §9.3）。
 */
export function versionizeMemory(
  incoming: MemoryRecord,
  existing: MemoryRecord | null
): VersionedMemory {
  if (!existing || existing.memoryId === incoming.memoryId) {
    return { record: incoming, supersedesMemoryId: null };
  }
  const supersedes = existing.supersedesMemoryIds.includes(incoming.memoryId)
    ? incoming
    : {
        ...incoming,
        supersedesMemoryIds: [
          ...new Set([...incoming.supersedesMemoryIds, existing.memoryId]),
        ],
      };
  return { record: supersedes, supersedesMemoryId: existing.memoryId };
}

// ============================================================================
// 硬冲突 FailureEnvelope（§9.3 / AGENTS.md 失败治理）
// ============================================================================

export type HardConflictSeverity = "hard" | "preflight";

export interface MemoryConflictEnvelope {
  stage: "final_state_commit";
  gate: "memory_hard_conflict";
  severity: HardConflictSeverity;
  reason: string;
  evidence: {
    memoryType: string;
    key: string;
    existingMemoryId: string;
    incomingMemoryId: string;
    existingValue: string | null;
    incomingValue: string | null;
  };
  recoverable: false;
  retryPlan: null;
  userActionRequired: boolean;
}

/**
 * 从硬冲突记录生成 FailureEnvelope。
 * 硬冲突不得静默覆盖：可恢复=false，要求修复或用户裁决（§9.3）。
 */
export function buildMemoryHardConflictEnvelope(input: {
  memoryType: string;
  key: string;
  existingMemoryId: string;
  incomingMemoryId: string;
  existingRecord?: MemoryRecord;
  incomingRecord?: MemoryRecord;
}): MemoryConflictEnvelope {
  return {
    stage: "final_state_commit",
    gate: "memory_hard_conflict",
    severity: "hard",
    reason: `Memory 硬冲突：${input.memoryType}（${input.key}）${input.existingMemoryId} vs ${input.incomingMemoryId}，新正文与旧 Canon 冲突，禁止静默覆盖`,
    evidence: {
      memoryType: input.memoryType,
      key: input.key,
      existingMemoryId: input.existingMemoryId,
      incomingMemoryId: input.incomingMemoryId,
      existingValue: input.existingRecord
        ? (input.existingRecord.payload.data as { value?: string })?.value ?? null
        : null,
      incomingValue: input.incomingRecord
        ? (input.incomingRecord.payload.data as { value?: string })?.value ?? null
        : null,
    },
    recoverable: false,
    retryPlan: null,
    userActionRequired: true,
  };
}