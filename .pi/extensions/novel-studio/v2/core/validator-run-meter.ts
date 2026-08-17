/**
 * VALIDATOR-RUN-METER — 验证器运行计量（REASONING-REPAIR-BOUNDARY-1 Wave 2C / RRB-4.2~4.3）
 *
 * 把本地验证器运行（非模型调用）按种类分账。至少区分以下种类（RRB-4.2）：
 *   coverage_gate / narrative_verifier / patch_comparator / span_immutability /
 *   story_preservation / final_fact_recheck / completeness
 *
 * 不变量：
 * - validator runner 是 validator run 唯一计数点（recordValidatorRun）；
 * - 禁止调用方手工 `+= 1`（RRB-4.3）；
 * - 本地 verifier 运行增加时 modelCalls 不变。
 */

// ============================================================================
// 类型
// ============================================================================

/** 验证器种类（RRB-4.2）。 */
export type ValidatorKind =
  | "coverage_gate"
  | "narrative_verifier"
  | "patch_comparator"
  | "span_immutability"
  | "story_preservation"
  | "final_fact_recheck"
  | "completeness";

/** 按种类分账的验证器运行计数。 */
export type ValidatorRunsByKind = Readonly<Record<ValidatorKind, number>>;

/** 单次验证器运行记录。 */
export interface ValidatorRunRecord {
  kind: ValidatorKind;
  timestamp: string;
  /** 关联的 candidateId */
  candidateId?: string;
  /** 运行结果：passed / failed / error */
  outcome: "passed" | "failed" | "error";
  /** 运行耗时（毫秒） */
  durationMs?: number;
}

// ============================================================================
// ValidatorRunMeter
// ============================================================================

export class ValidatorRunMeter {
  private runs: ValidatorRunRecord[] = [];
  private counters: Record<ValidatorKind, number> = {
    coverage_gate: 0,
    narrative_verifier: 0,
    patch_comparator: 0,
    span_immutability: 0,
    story_preservation: 0,
    final_fact_recheck: 0,
    completeness: 0,
  };

  /** 记录一次验证器运行。仅 validator runner 调用（RRB-4.3）。 */
  recordValidatorRun(input: {
    kind: ValidatorKind;
    candidateId?: string;
    outcome: "passed" | "failed" | "error";
    durationMs?: number;
  }): void {
    const record: ValidatorRunRecord = {
      kind: input.kind,
      timestamp: new Date().toISOString(),
      candidateId: input.candidateId,
      outcome: input.outcome,
      durationMs: input.durationMs,
    };
    this.runs.push(record);
    this.counters[input.kind] += 1;
  }

  /** 获取按种类分账的验证器运行计数。 */
  getValidatorRunsByKind(): ValidatorRunsByKind {
    return { ...this.counters };
  }

  /** 获取总验证器运行次数。 */
  getTotalValidatorRuns(): number {
    return Object.values(this.counters).reduce((a, b) => a + b, 0);
  }

  /** 获取失败（含 error）的运行次数。 */
  getFailedRuns(): number {
    return this.runs.filter((r) => r.outcome !== "passed").length;
  }

  /** 获取全部运行记录（只读快照）。 */
  getRunRecords(): readonly ValidatorRunRecord[] {
    return [...this.runs];
  }

  /** 重置计量（仅用于测试）。 */
  reset(): void {
    this.runs = [];
    this.counters = {
      coverage_gate: 0,
      narrative_verifier: 0,
      patch_comparator: 0,
      span_immutability: 0,
      story_preservation: 0,
      final_fact_recheck: 0,
      completeness: 0,
    };
  }
}

// ============================================================================
// 工厂
// ============================================================================

export function createValidatorRunMeter(): ValidatorRunMeter {
  return new ValidatorRunMeter();
}

// ============================================================================
// 纯函数
// ============================================================================

/** 零值 validatorRunsByKind（用于初始化）。 */
export const ZERO_VALIDATOR_RUNS: ValidatorRunsByKind = {
  coverage_gate: 0,
  narrative_verifier: 0,
  patch_comparator: 0,
  span_immutability: 0,
  story_preservation: 0,
  final_fact_recheck: 0,
  completeness: 0,
};

/** 合并多次 validatorRunsByKind 快照 */
export function mergeValidatorRunsByKind(
  ...snapshots: ValidatorRunsByKind[]
): ValidatorRunsByKind {
  const result: Record<ValidatorKind, number> = {
    coverage_gate: 0,
    narrative_verifier: 0,
    patch_comparator: 0,
    span_immutability: 0,
    story_preservation: 0,
    final_fact_recheck: 0,
    completeness: 0,
  };
  for (const s of snapshots) {
    for (const key of Object.keys(result) as ValidatorKind[]) {
      result[key] += s[key];
    }
  }
  return result;
}

/** 检查 validatorRuns 是否包含旧计量字段（如 verify）。 */
export function hasLegacyValidatorKey(runs: Record<string, number>): boolean {
  return "verify" in runs;
}