/**
 * RECOVERY-POLICY — 默认恢复策略表（P1）
 *
 * 与 recovery-decision-engine 配合：策略表提供声明式默认，引擎处理预算/中断。
 */

import type { FailureClass } from "./failure-types.js";
import type { RecoveryAction } from "./recovery-types.js";

export interface RecoveryPolicyRule {
  id: string;
  match: {
    failureClass?: FailureClass;
    gateIncludes?: string[];
    stageIncludes?: string[];
  };
  action: RecoveryAction;
  maxAttempts: number;
  nextCondition?: string;
  description: string;
}

/** 默认策略表（计划 §P1 决策规则） */
export const DEFAULT_RECOVERY_POLICY_RULES: ReadonlyArray<RecoveryPolicyRule> = [
  {
    id: "missing-config",
    match: { failureClass: "preflight" },
    action: "user_fix",
    maxAttempts: 0,
    description: "缺少配置、角色、种子 → user_fix",
  },
  {
    id: "schema-parser",
    match: { gateIncludes: ["schema", "parse", "parser"] },
    action: "retry_gate",
    maxAttempts: 1,
    nextCondition: "repair_schema_output_only",
    description: "schema/parser 错误 → retry_gate",
  },
  {
    id: "retrieval-timeout",
    match: { gateIncludes: ["retrieval", "timeout"], stageIncludes: ["retrieval"] },
    action: "retry_stage",
    maxAttempts: 1,
    nextCondition: "bounded_retrieval_retry",
    description: "检索超时 → 有界 retry_stage",
  },
  {
    id: "agentic-timeout",
    match: {
      failureClass: "recoverable",
      gateIncludes: ["model_timeout"],
      stageIncludes: ["agentic", "novelos"],
    },
    action: "retry_stage",
    maxAttempts: 1,
    nextCondition: "same_stage_bounded_retry",
    description: "Agentic timeout/empty → 同阶段重试一次",
  },
  {
    id: "coverage-insufficient",
    match: { gateIncludes: ["coverage", "must_verify"] },
    action: "retry_stage",
    maxAttempts: 2,
    nextCondition: "continue_retrieval_with_missing_items",
    description: "Coverage 不足 → 带缺失项继续检索",
  },
  {
    id: "style-timeout",
    match: {
      failureClass: "recoverable",
      gateIncludes: ["style"],
    },
    action: "retry_stage",
    maxAttempts: 1,
    nextCondition: "style_stage_retry",
    description: "风格优化 timeout/empty → 风格阶段重试一次",
  },
  {
    id: "story-preservation-uncertain",
    match: { gateIncludes: ["story_preservation", "preservation"] },
    action: "retry_stage",
    maxAttempts: 1,
    nextCondition: "reduce_guidance_strength",
    description: "Story Preservation 不确定 → 降指导强度后重试一次",
  },
  {
    id: "fact-conflict",
    match: { gateIncludes: ["fact_guard", "fact_conflict"] },
    action: "user_fix",
    maxAttempts: 0,
    description: "确认事实冲突 → blocked + user_fix",
  },
  {
    id: "budget-exhausted",
    match: { gateIncludes: ["budget"] },
    action: "checkpoint",
    maxAttempts: 0,
    description: "预算耗尽 → checkpoint 或 blocked",
  },
  {
    id: "user-interrupt",
    match: { failureClass: "interrupted" },
    action: "checkpoint",
    maxAttempts: 0,
    description: "用户中断 → interrupted/checkpoint",
  },
  {
    id: "chapter-save-failed",
    match: { gateIncludes: ["atomic_save", "chapter.save", "chapter_save"] },
    action: "stop",
    maxAttempts: 0,
    description: "正文保存失败 → blocked",
  },
  {
    id: "state-commit-failed",
    match: { gateIncludes: ["state_commit", "state.commit"] },
    action: "rollback",
    maxAttempts: 0,
    description: "状态提交失败 → rollback + blocked",
  },
  {
    id: "stale-revision",
    match: { gateIncludes: ["stale_revision", "approval"] },
    action: "stop",
    maxAttempts: 0,
    description: "approval/revision 过期 → blocked(stale_revision)",
  },
];

export function matchRecoveryPolicy(
  input: { failureClass?: FailureClass; gate?: string; stage?: string },
): RecoveryPolicyRule | null {
  const gate = (input.gate ?? "").toLowerCase();
  const stage = (input.stage ?? "").toLowerCase();
  for (const rule of DEFAULT_RECOVERY_POLICY_RULES) {
    if (
      rule.match.failureClass &&
      input.failureClass &&
      rule.match.failureClass !== input.failureClass
    ) {
      continue;
    }
    if (rule.match.gateIncludes?.length) {
      if (!rule.match.gateIncludes.some((g) => gate.includes(g.toLowerCase()))) {
        continue;
      }
    }
    if (rule.match.stageIncludes?.length) {
      if (!rule.match.stageIncludes.some((s) => stage.includes(s.toLowerCase()))) {
        continue;
      }
    }
    // 至少匹配到 failureClass 或 gate/stage 之一
    if (
      rule.match.failureClass ||
      rule.match.gateIncludes?.length ||
      rule.match.stageIncludes?.length
    ) {
      return rule;
    }
  }
  return null;
}
