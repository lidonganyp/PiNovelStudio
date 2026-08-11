/**
 * MEMORY-4 事务化状态提交（MEMORY-TRANSACTION-1）
 *
 * 目标（任务文档 §八）：
 * - 引入 StagedMemoryUpdate（缓冲，不落盘）
 * - 长期记忆提交绑定最终正文 hash
 * - 生成 MemoryCommitReceipt（记录正文 hash、状态版本、变更列表、冲突处理、提交时间）
 * - 任一步骤失败回滚，不留下部分提交
 *
 * 与现有 FinalStateCommit（final-state-commit.ts）的关系：
 * 现有 commitAndSave 已保证"先原子保存正文 → 后提交状态 → 失败回滚正文"。
 * 本模块在现有事务边界之上附加 MemoryCommitReceipt 生成与 StagedMemoryUpdate
 * 校验，不替代现有提交器。纯函数 + 无副作用。
 */

import type { MemoryRecord } from "./memory-record.js";
import { validateMemoryRecord } from "./memory-record.js";

// ============================================================================
// StagedMemoryUpdate（§8.3 步骤 1）
// ============================================================================

export interface StagedMemoryUpdate {
  /** 缓冲的正式记忆记录（候选生成期间不落盘） */
  records: MemoryRecord[];
  /** 被本章新事实作废的旧 memoryId */
  invalidations: string[];
  sourceChapter: number;
  sourceRunId: string;
  /** 绑定的最终正文 hash（提交时校验） */
  finalTextHash: string | null;
}

// ============================================================================
// 冲突处理结果（§九.3）
// ============================================================================

export type MemoryConflictResolution =
  | "superseded" // 新正文明确改变旧状态 → 新版本 + 旧标记 superseded
  | "hard_conflict_blocked" // 新正文与旧 Canon 硬冲突 → 阻断 + FailureEnvelope
  | "new_text_wins" // 系统推断/计划与正文冲突 → 正文优先，推断标记 superseded
  | "versioned" // 两段最终正文互斥 → 保留版本，阻断自动覆盖
  | "author_conflict_user" // 作者声明与正文冲突 → 生成结构化冲突供用户处理

export interface MemoryConflictRecord {
  memoryType: string;
  key: string;
  existingMemoryId: string;
  incomingMemoryId: string;
  resolution: MemoryConflictResolution;
  reason: string;
}

// ============================================================================
// MemoryCommitReceipt（§8.3 步骤 7）
// ============================================================================

export interface MemoryCommitReceipt {
  receiptId: string;
  workspaceId: string;
  sourceChapter: number;
  finalTextHash: string;
  sourceRunId: string;
  /** 提交后的状态版本（此处为章节号 + 单调递增序号） */
  stateVersion: string;
  committed: number;
  committedIds: string[];
  rejected: Array<{ memoryId: string; errors: string[] }>;
  invalidatedIds: string[];
  conflicts: MemoryConflictRecord[];
  committedAt: string;
}

// ============================================================================
// 校验
// ============================================================================

export interface StagedMemoryValidation {
  ok: boolean;
  errors: string[];
  valid: MemoryRecord[];
  invalid: Array<{ record: MemoryRecord; errors: string[] }>;
}

/**
 * 校验 StagedMemoryUpdate：
 * - 每条记录通过 validateMemoryRecord（非法枚举/缺来源/纯自由摘要被拒）
 * - 计划态/诊断扰动不得作为正式事实进入（由 isFormalFactEvidence 在消费端把关）
 * - finalTextHash 必须已冻结
 */
export function validateStagedMemoryUpdate(
  update: StagedMemoryUpdate
): StagedMemoryValidation {
  const errors: string[] = [];
  if (!update.finalTextHash || update.finalTextHash.length === 0) {
    errors.push("finalTextHash 未冻结：状态更新必须绑定最终正文 hash（§8.1）");
  }
  if (!update.sourceRunId) {
    errors.push("sourceRunId 不能为空（§八.3 每次提交可追溯 sourceRunId）");
  }
  const valid: MemoryRecord[] = [];
  const invalid: Array<{ record: MemoryRecord; errors: string[] }> = [];
  for (const record of update.records) {
    const v = validateMemoryRecord(record);
    if (v.ok) valid.push(record);
    else invalid.push({ record, errors: v.errors });
  }
  return { ok: errors.length === 0 && invalid.length === 0, errors, valid, invalid };
}

// ============================================================================
// 冲突检测（§九.3）
// ============================================================================

/**
 * 结构键提取：用于冲突检测与版本化。
 * 与 memory-compactor 的 memoryKey 对齐：canon/character/promise/expectation。
 */
export function memoryKey(record: MemoryRecord): string {
  const payload = record.payload;
  switch (record.memoryType) {
    case "canon":
    case "chapter_fact":
      return `canon:${normalize((payload.data as { key: string }).key)}`;
    case "character":
      return `character:${normalize((payload.data as { key: string }).key)}`;
    case "promise":
      return `promise:${normalize((payload.data as { promiseId: string }).promiseId)}`;
    default:
      return `${record.memoryType}:${normalize(record.memoryId)}`;
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s，。、；：！？""''（）()【】\[\]《》〈〉—….,;:!?'"\-]+/gu, "");
}

/**
 * 检测新记录与现有记录的冲突（§九.3）。
 *
 * 返回冲突记录数组。硬冲突（canon 同键且内容不同）必须阻断并生成 FailureEnvelope，
 * 由调用方决定（本纯函数只报告，不自动覆盖）。
 */
export function detectMemoryConflicts(
  incoming: MemoryRecord[],
  existing: MemoryRecord[]
): MemoryConflictRecord[] {
  const conflicts: MemoryConflictRecord[] = [];
  const existingByKey = new Map<string, MemoryRecord>();
  for (const e of existing) {
    existingByKey.set(memoryKey(e), e);
  }
  for (const inc of incoming) {
    const key = memoryKey(inc);
    const prev = existingByKey.get(key);
    if (!prev) continue;

    const isCanon =
      inc.memoryType === "canon" || inc.memoryType === "chapter_fact";
    const incValue = (inc.payload.data as { value?: string }).value ?? "";
    const prevValue = (prev.payload.data as { value?: string }).value ?? "";

    // 同一记忆自身更新（supersedes 指向自身旧版）。
    // 注意：canon 是"不可违背事实"，同一 id 被写入不同值 = 静默改写 Canon，
    // 必须阻断（需显式 invalidate/supersede 才允许演进）；同值（如置信度提升）
    // 或非 canon 状态机推进（character/promise）则视为合法 upsert。
    if (prev.memoryId === inc.memoryId) {
      if (isCanon && normalize(incValue) !== normalize(prevValue)) {
        conflicts.push({
          memoryType: inc.memoryType,
          key,
          existingMemoryId: prev.memoryId,
          incomingMemoryId: inc.memoryId,
          resolution: "hard_conflict_blocked",
          reason: `同一 Canon 记录值被改写：${prevValue} → ${incValue}（不可违背事实，禁止静默覆盖，需显式 invalidate/supersede）`,
        });
      }
      continue;
    }

    if (isCanon && normalize(incValue) !== normalize(prevValue)) {
      // 新正文与旧 Canon 硬冲突 → 阻断（除非 incoming 显式 supersedes 旧版）
      const supersedesOld = inc.supersedesMemoryIds.includes(prev.memoryId);
      conflicts.push({
        memoryType: inc.memoryType,
        key,
        existingMemoryId: prev.memoryId,
        incomingMemoryId: inc.memoryId,
        resolution: supersedesOld ? "superseded" : "hard_conflict_blocked",
        reason: supersedesOld
          ? `新正文明确改变旧 Canon，显式 supersedes ${prev.memoryId}`
          : `新正文与旧 Canon 硬冲突：${prevValue} → ${incValue}（未显式 supersedes，阻断）`,
      });
    } else {
      // 非硬冲突（如 character 状态合法变化）→ 新正文优先，旧标记 superseded
      conflicts.push({
        memoryType: inc.memoryType,
        key,
        existingMemoryId: prev.memoryId,
        incomingMemoryId: inc.memoryId,
        resolution: "new_text_wins",
        reason: `新正文合法更新旧状态 ${prev.memoryId}`,
      });
    }
  }
  return conflicts;
}

// ============================================================================
// 构建 MemoryCommitReceipt（§8.3 步骤 7）
// ============================================================================

export function buildMemoryCommitReceipt(input: {
  workspaceId: string;
  sourceChapter: number;
  finalTextHash: string;
  sourceRunId: string;
  stateVersion: string;
  committed: MemoryRecord[];
  rejected: Array<{ memoryId: string; errors: string[] }>;
  invalidatedIds: string[];
  conflicts: MemoryConflictRecord[];
}): MemoryCommitReceipt {
  const receiptId = `receipt-${input.sourceChapter}-${input.finalTextHash}-${Date.now()}`;
  return {
    receiptId,
    workspaceId: input.workspaceId,
    sourceChapter: input.sourceChapter,
    finalTextHash: input.finalTextHash,
    sourceRunId: input.sourceRunId,
    stateVersion: input.stateVersion,
    committed: input.committed.length,
    committedIds: input.committed.map((r) => r.memoryId),
    rejected: input.rejected,
    invalidatedIds: input.invalidatedIds,
    conflicts: input.conflicts,
    committedAt: new Date().toISOString(),
  };
}