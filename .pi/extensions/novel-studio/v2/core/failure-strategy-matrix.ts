/**
 * FAILURE-STRATEGY-MATRIX — 超时/失败/恢复策略固化（WP-04）
 *
 * 将失败类型映射为配置化处理，禁止 silent degrade。
 * 与 recovery-policy / recovery-decision-engine 对齐，不另建冲突规则。
 */

import type { FailureClass } from "./failure-types.js";
import type { RecoveryAction } from "./recovery-types.js";
import { matchRecoveryPolicy } from "./recovery-policy.js";
import { decideRecovery } from "./recovery-decision-engine.js";
import type { RecoveryBudget, RecoveryDecision } from "./recovery-types.js";
import { createRecoveryBudget } from "./recovery-budget.js";

export type FailureType =
  | "network_timeout"
  | "empty_result"
  | "schema_error"
  | "agentic_retrieval_insufficient"
  | "style_optimization_failed"
  | "factguard_failed"
  | "budget_exhausted"
  | "model_version_mismatch"
  | "routing_lock_conflict"
  | "unauthorized_cross_model_switch"
  | "unknown";

export interface FailureStrategyRule {
  failureType: FailureType;
  handling: string;
  recoveryAction: RecoveryAction;
  failureClass: FailureClass;
  maxAttempts: number;
  /** 是否允许自动重试 */
  autoRetry: boolean;
  /** 禁止行为 */
  prohibited: string[];
  description: string;
}

export interface AttemptHistoryEntry {
  attempt: number;
  failureType: FailureType;
  stage: string;
  gate?: string;
  recoveryAction: RecoveryAction;
  reason: string;
  at: string;
  changedCondition: boolean;
}

export interface FailureStrategyDecision {
  rule: FailureStrategyRule;
  decision: RecoveryDecision;
  attemptHistory: AttemptHistoryEntry[];
  /** 中间证据应保留 */
  preserveIntermediateEvidence: true;
  /** 禁止 silent degrade */
  silentDegradeForbidden: true;
}

export const FAILURE_STRATEGY_MATRIX: ReadonlyArray<FailureStrategyRule> = [
  {
    failureType: "network_timeout",
    handling: "同阶段有限重试",
    recoveryAction: "retry_stage",
    failureClass: "recoverable",
    maxAttempts: 1,
    autoRetry: true,
    prohibited: ["cross_model_switch", "deliver_partial_draft"],
    description: "网络暂时超时 → 同阶段有限重试",
  },
  {
    failureType: "empty_result",
    handling: "同阶段重试一次",
    recoveryAction: "retry_stage",
    failureClass: "recoverable",
    maxAttempts: 1,
    autoRetry: true,
    prohibited: ["deliver_empty", "cross_model_switch"],
    description: "空结果 → 同阶段重试一次",
  },
  {
    failureType: "schema_error",
    handling: "只重试 parser/gate",
    recoveryAction: "retry_gate",
    failureClass: "recoverable",
    maxAttempts: 1,
    autoRetry: true,
    prohibited: ["rewrite_prose_for_parser", "cross_model_switch"],
    description: "Schema 错误 → 只重试 parser/gate，不触发正文重写",
  },
  {
    failureType: "agentic_retrieval_insufficient",
    handling: "增加验证或重新检索",
    recoveryAction: "retry_stage",
    failureClass: "recoverable",
    maxAttempts: 2,
    autoRetry: true,
    prohibited: ["deliver_incomplete_agentic_draft"],
    description: "Agentic 检索不足 → 继续检索/验证",
  },
  {
    failureType: "style_optimization_failed",
    handling: "风格阶段重试，耗尽后 hard block",
    recoveryAction: "retry_stage",
    failureClass: "recoverable",
    maxAttempts: 1,
    autoRetry: true,
    prohibited: ["silent_deliver_raw", "skip_style_optimization"],
    description: "风格优化失败 → 重试后 hard block，禁止静默交付 raw",
  },
  {
    failureType: "factguard_failed",
    handling: "阻断，不改写为通过",
    recoveryAction: "user_fix",
    failureClass: "blocked",
    maxAttempts: 0,
    autoRetry: false,
    prohibited: ["downgrade_to_warning", "force_pass_factguard"],
    description: "FactGuard 失败 → blocked，不得降级为 warning",
  },
  {
    failureType: "budget_exhausted",
    handling: "checkpoint 或 blocked",
    recoveryAction: "checkpoint",
    failureClass: "blocked",
    maxAttempts: 0,
    autoRetry: false,
    prohibited: ["infinite_wait", "ignore_budget"],
    description: "预算耗尽 → checkpoint/blocked",
  },
  {
    failureType: "model_version_mismatch",
    handling: "hard block",
    recoveryAction: "stop",
    failureClass: "blocked",
    maxAttempts: 0,
    autoRetry: false,
    prohibited: ["silent_model_switch"],
    description: "模型版本不匹配 → hard block",
  },
  {
    failureType: "routing_lock_conflict",
    handling: "hard block",
    recoveryAction: "stop",
    failureClass: "blocked",
    maxAttempts: 0,
    autoRetry: false,
    prohibited: ["continue_without_lock"],
    description: "路由锁冲突 → hard block",
  },
  {
    failureType: "unauthorized_cross_model_switch",
    handling: "hard block",
    recoveryAction: "stop",
    failureClass: "blocked",
    maxAttempts: 0,
    autoRetry: false,
    prohibited: ["disguise_as_other_model_success"],
    description: "未授权跨模型切换 → hard block",
  },
];

const MATRIX_BY_TYPE = new Map(FAILURE_STRATEGY_MATRIX.map((r) => [r.failureType, r]));

export function getFailureStrategyRule(failureType: FailureType): FailureStrategyRule {
  return (
    MATRIX_BY_TYPE.get(failureType) ?? {
      failureType: "unknown",
      handling: "保守阻断",
      recoveryAction: "stop",
      failureClass: "blocked",
      maxAttempts: 0,
      autoRetry: false,
      prohibited: ["silent_degrade"],
      description: "未知失败 → blocked",
    }
  );
}

/**
 * 从 gate/stage/reason 启发式映射 FailureType。
 */
export function classifyFailureType(input: {
  gate?: string;
  stage?: string;
  reason?: string;
  failureClass?: FailureClass;
}): FailureType {
  const gate = (input.gate ?? "").toLowerCase();
  const stage = (input.stage ?? "").toLowerCase();
  const reason = (input.reason ?? "").toLowerCase();
  const blob = `${gate} ${stage} ${reason}`;

  if (blob.includes("lock") && blob.includes("conflict")) return "routing_lock_conflict";
  if (blob.includes("cross_model") || blob.includes("unauthorized") && blob.includes("model")) {
    return "unauthorized_cross_model_switch";
  }
  if (blob.includes("model_version") || blob.includes("version_mismatch")) return "model_version_mismatch";
  if (blob.includes("budget")) return "budget_exhausted";
  if (blob.includes("fact_guard") || blob.includes("factguard") || blob.includes("fact_conflict")) {
    return "factguard_failed";
  }
  if (blob.includes("style") && (blob.includes("fail") || blob.includes("empty") || blob.includes("timeout"))) {
    return "style_optimization_failed";
  }
  if (blob.includes("schema") || blob.includes("parse")) return "schema_error";
  if (blob.includes("coverage") || blob.includes("retrieval") || blob.includes("must_verify")) {
    return "agentic_retrieval_insufficient";
  }
  if (blob.includes("empty")) return "empty_result";
  if (blob.includes("timeout") || blob.includes("network")) return "network_timeout";
  return "unknown";
}

export function appendAttemptHistory(
  history: readonly AttemptHistoryEntry[],
  entry: Omit<AttemptHistoryEntry, "at"> & { at?: string },
): AttemptHistoryEntry[] {
  return [
    ...history,
    {
      ...entry,
      at: entry.at ?? new Date().toISOString(),
    },
  ];
}

/**
 * 综合策略矩阵 + recovery decision engine。
 * 始终 preserveIntermediateEvidence，禁止 silent degrade。
 */
export function decideFailureStrategy(input: {
  failureType?: FailureType;
  gate?: string;
  stage: string;
  reason: string;
  attempt: number;
  budget?: RecoveryBudget;
  attemptHistory?: readonly AttemptHistoryEntry[];
  confirmedFactConflict?: boolean;
  schemaOrParseError?: boolean;
  coverageInsufficient?: boolean;
  storyPreservationUncertain?: boolean;
}): FailureStrategyDecision {
  const failureType =
    input.failureType ??
    classifyFailureType({
      gate: input.gate,
      stage: input.stage,
      reason: input.reason,
    });
  const rule = getFailureStrategyRule(failureType);

  // 风格优化耗尽：升级 blocked，禁止交付 raw
  let effectiveRule = rule;
  if (
    failureType === "style_optimization_failed" &&
    input.attempt >= rule.maxAttempts
  ) {
    effectiveRule = {
      ...rule,
      recoveryAction: "stop",
      failureClass: "blocked",
      autoRetry: false,
      handling: "风格阶段重试耗尽 → hard block，禁止 silent 交付 raw",
    };
  }

  const policy = matchRecoveryPolicy({
    failureClass: effectiveRule.failureClass,
    gate: input.gate,
    stage: input.stage,
  });

  const decision = decideRecovery({
    failureClass: effectiveRule.failureClass,
    stage: input.stage,
    gate: input.gate,
    reason: input.reason,
    attempt: input.attempt,
    maxAttempts: policy?.maxAttempts ?? effectiveRule.maxAttempts,
    budget: input.budget ?? createRecoveryBudget(),
    confirmedFactConflict:
      input.confirmedFactConflict ?? failureType === "factguard_failed",
    schemaOrParseError: input.schemaOrParseError ?? failureType === "schema_error",
    coverageInsufficient:
      input.coverageInsufficient ?? failureType === "agentic_retrieval_insufficient",
    storyPreservationUncertain: input.storyPreservationUncertain,
    forbidOneShotRawFallback: true,
  });

  const history = appendAttemptHistory(input.attemptHistory ?? [], {
    attempt: input.attempt,
    failureType,
    stage: input.stage,
    gate: input.gate,
    recoveryAction: decision.recoveryAction,
    reason: input.reason,
    changedCondition: decision.changesCondition,
  });

  return {
    rule: effectiveRule,
    decision,
    attemptHistory: history,
    preserveIntermediateEvidence: true,
    silentDegradeForbidden: true,
  };
}

/** 断言：不得把生产失败伪装成另一模型成功 */
export function assertNoCrossModelDisguise(input: {
  lockedProvider: string;
  actualProvider?: string;
  authorizedCrossModel: boolean;
}): { ok: boolean; failureType?: FailureType; reason?: string } {
  if (!input.actualProvider) return { ok: true };
  if (input.actualProvider === input.lockedProvider) return { ok: true };
  if (input.authorizedCrossModel) return { ok: true };
  return {
    ok: false,
    failureType: "unauthorized_cross_model_switch",
    reason: `未授权跨模型：locked=${input.lockedProvider} actual=${input.actualProvider}`,
  };
}
