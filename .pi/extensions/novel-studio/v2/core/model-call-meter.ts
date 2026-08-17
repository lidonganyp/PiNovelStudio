/**
 * MODEL-CALL-METER — 模型调用计量（REASONING-REPAIR-BOUNDARY-1 Wave 2C / RRB-4.1~4.3）
 *
 * 把模型调用按种类（draft / patch / newCandidate / authorStyle）分账。
 * 本地 verifier 运行不得计入 modelCalls（应走 ValidatorRunMeter）。
 *
 * 不变量：
 * - 模型 wrapper 是 model call 唯一计数点（recordModelCall）；
 * - 禁止调用方手工 `+= 1`（RRB-4.3）；
 * - 旧 `modelCallsByKind.verify` 口径已删除，历史 trace 如需读取只在只读投影层映射。
 */

// ============================================================================
// 类型
// ============================================================================

/** 生产模型调用种类（RRB-4.1）。旧 verify 字段已删除。 */
export type ModelCallKind = "draft" | "patch" | "newCandidate" | "authorStyle";

/** 按种类分账的模型调用计数。 */
export type ModelCallsByKind = Readonly<Record<ModelCallKind, number>>;

/** 单次模型调用记录。 */
export interface ModelCallRecord {
  kind: ModelCallKind;
  timestamp: string;
  /** 调用关联的 candidateId（如有） */
  candidateId?: string;
  /** 调用是否成功（error 不计入成功调用） */
  success: boolean;
}

// ============================================================================
// ModelCallMeter
// ============================================================================

export class ModelCallMeter {
  private calls: ModelCallRecord[] = [];
  private counters: Record<ModelCallKind, number> = {
    draft: 0,
    patch: 0,
    newCandidate: 0,
    authorStyle: 0,
  };

  /** 记录一次模型调用。仅模型 wrapper 调用（RRB-4.3）。 */
  recordModelCall(input: {
    kind: ModelCallKind;
    candidateId?: string;
    success: boolean;
  }): void {
    const record: ModelCallRecord = {
      kind: input.kind,
      timestamp: new Date().toISOString(),
      candidateId: input.candidateId,
      success: input.success,
    };
    this.calls.push(record);
    this.counters[input.kind] += 1;
  }

  /** 获取按种类分账的调用计数。 */
  getModelCallsByKind(): ModelCallsByKind {
    return { ...this.counters };
  }

  /** 获取总模型调用次数。 */
  getTotalModelCalls(): number {
    return (
      this.counters.draft +
      this.counters.patch +
      this.counters.newCandidate +
      this.counters.authorStyle
    );
  }

  /** 获取成功调用次数。 */
  getSuccessfulCalls(): number {
    return this.calls.filter((c) => c.success).length;
  }

  /** 获取全部调用记录（只读快照）。 */
  getCallRecords(): readonly ModelCallRecord[] {
    return [...this.calls];
  }

  /** 重置计量（仅用于测试）。 */
  reset(): void {
    this.calls = [];
    this.counters = { draft: 0, patch: 0, newCandidate: 0, authorStyle: 0 };
  }
}

// ============================================================================
// 工厂
// ============================================================================

export function createModelCallMeter(): ModelCallMeter {
  return new ModelCallMeter();
}

// ============================================================================
// 纯函数
// ============================================================================

/** 零值 modelCallsByKind（用于初始化）。 */
export const ZERO_MODEL_CALLS: ModelCallsByKind = {
  draft: 0,
  patch: 0,
  newCandidate: 0,
  authorStyle: 0,
};

/** 合并多次 modelCallsByKind 快照 */
export function mergeModelCallsByKind(
  ...snapshots: ModelCallsByKind[]
): ModelCallsByKind {
  const result: Record<ModelCallKind, number> = {
    draft: 0,
    patch: 0,
    newCandidate: 0,
    authorStyle: 0,
  };
  for (const s of snapshots) {
    result.draft += s.draft;
    result.patch += s.patch;
    result.newCandidate += s.newCandidate;
    result.authorStyle += s.authorStyle;
  }
  return result;
}

/** 旧计量字段名（供只读投影层映射，不得写入生产 trace）。 */
export const LEGACY_MODEL_CALL_KINDS = [
  "verify",
  "draft",
  "patch",
  "newCandidate",
  "authorStyle",
] as const;

/** 检查 modelCallsByKind 是否不含旧 verify 口径（RRB-4.1 / RRB-4.7）。 */
export function hasLegacyVerifyKey(calls: Record<string, number>): boolean {
  return "verify" in calls;
}