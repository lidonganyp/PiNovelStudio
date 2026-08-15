/**
 * RECOVERY-DECISION-ENGINE — 恢复决策引擎（P1）
 *
 * 模型只能提出恢复建议；系统根据失败类型、预算、中断信号决定动作。
 * 生产路径禁止 fallback to one_shot_raw。
 */

import type { FailureClass } from "./failure-types.js";
import { isAutomaticallyRecoverable } from "./failure-types.js";
import { canAffordRetry, snapshotBudget } from "./recovery-budget.js";
import type {
  RecoveryAction,
  RecoveryDecision,
  RecoveryDecisionInput,
  RecoveryLifecycleState,
} from "./recovery-types.js";

function decide(
  action: RecoveryAction,
  input: RecoveryDecisionInput,
  nextState: RecoveryLifecycleState,
  reason: string,
  opts?: {
    allowed?: boolean;
    userActionRequired?: string[];
    nextCondition?: string;
    changesCondition?: boolean;
    maxAttempts?: number;
  },
): RecoveryDecision {
  return {
    recoveryAction: action,
    allowed: opts?.allowed ?? true,
    reason,
    failureClass: input.failureClass,
    nextLifecycleState: nextState,
    maxAttempts: opts?.maxAttempts ?? input.maxAttempts ?? 1,
    attempt: input.attempt,
    userActionRequired: opts?.userActionRequired,
    nextCondition: opts?.nextCondition,
    changesCondition: opts?.changesCondition ?? action.startsWith("retry"),
  };
}

/**
 * 核心决策：根据失败信封上下文选择恢复动作。
 */
export function decideRecovery(input: RecoveryDecisionInput): RecoveryDecision {
  // 0) 中断信号优先
  if (input.interruptSignal) {
    return decide(
      "checkpoint",
      input,
      "interrupted",
      `中断信号：${input.interruptSignal}`,
      {
        changesCondition: false,
        userActionRequired: ["显式 resume 后才能继续"],
      },
    );
  }

  // 1) stale revision / approval
  if (input.staleRevision) {
    return decide("stop", input, "blocked", "stale revision / 审批过期", {
      allowed: false,
      changesCondition: false,
      userActionRequired: ["重新审批或重新生成候选"],
    });
  }

  // 2) 正文保存失败
  if (input.chapterSaveFailed) {
    return decide("stop", input, "blocked", "正文保存失败，不提交状态", {
      allowed: false,
      changesCondition: false,
      userActionRequired: ["检查磁盘/权限后重试定稿"],
    });
  }

  // 3) 状态提交失败 → rollback
  if (input.stateCommitFailed) {
    return decide(
      "rollback",
      input,
      "blocked",
      "状态提交失败：回滚正文与 NarrativeState",
      {
        changesCondition: false,
        userActionRequired: ["检查状态存储后重试"],
      },
    );
  }

  // 4) 确认事实冲突
  if (input.confirmedFactConflict) {
    return decide(
      "user_fix",
      input,
      "blocked",
      "确认事实冲突，需用户修订输入",
      {
        allowed: false,
        changesCondition: false,
        userActionRequired: ["修订 ChapterSeed / 不可违事实后重试"],
      },
    );
  }

  // 5) 预算检查（可恢复类重试前）
  const snap = snapshotBudget(input.budget);
  if (snap.exhausted && isAutomaticallyRecoverable(input.failureClass)) {
    return decide(
      "checkpoint",
      input,
      "checkpoint",
      `恢复预算耗尽：${snap.exhaustedReasons.join(",")}`,
      {
        changesCondition: false,
        userActionRequired: ["提高预算或显式 resume/停止"],
      },
    );
  }

  // 6) schema / parser → retry_gate
  if (input.schemaOrParseError) {
    if (!canAffordRetry(input.budget) || input.attempt >= (input.maxAttempts ?? 1)) {
      return decide("stop", input, "blocked", "schema/parser 重试耗尽", {
        allowed: false,
        changesCondition: false,
      });
    }
    return decide("retry_gate", input, "retrying", "schema/parser 错误：只重试 gate", {
      nextCondition: "repair_schema_output_only",
      changesCondition: true,
      maxAttempts: input.maxAttempts ?? 1,
    });
  }

  // 7) Coverage 不足 → retry_stage（带缺失项）
  if (input.coverageInsufficient) {
    if (!canAffordRetry(input.budget) || input.attempt >= (input.maxAttempts ?? 2)) {
      return decide("checkpoint", input, "checkpoint", "Coverage 不足且预算/次数耗尽", {
        changesCondition: false,
      });
    }
    return decide(
      "retry_stage",
      input,
      "retrying",
      "Coverage 不足：带缺失项继续检索",
      {
        nextCondition: "continue_retrieval_with_missing_items",
        changesCondition: true,
        maxAttempts: input.maxAttempts ?? 2,
      },
    );
  }

  // 8) Story Preservation 不确定 → 降指导强度后 retry
  if (input.storyPreservationUncertain) {
    if (!canAffordRetry(input.budget) || input.attempt >= 1) {
      return decide("stop", input, "blocked", "Story Preservation 重试耗尽", {
        allowed: false,
        changesCondition: false,
      });
    }
    return decide(
      "retry_stage",
      input,
      "retrying",
      "Story Preservation 不确定：降低指导强度后重试一次",
      {
        nextCondition: "reduce_guidance_strength",
        changesCondition: true,
        maxAttempts: 1,
      },
    );
  }

  // 9) 按 failureClass 默认策略
  switch (input.failureClass) {
    case "preflight":
      return decide("user_fix", input, "blocked", "预检失败：需用户补齐配置/种子", {
        allowed: false,
        changesCondition: false,
        userActionRequired: ["补齐配置、角色、风格档案或 ChapterSeed"],
      });

    case "interrupted":
      return decide("checkpoint", input, "interrupted", "用户/系统中断", {
        changesCondition: false,
        userActionRequired: ["显式 resume"],
      });

    case "fatal":
      return decide("stop", input, "blocked", "致命失败，停止", {
        allowed: false,
        changesCondition: false,
      });

    case "blocked":
      return decide("stop", input, "blocked", input.reason || "硬阻断", {
        allowed: false,
        changesCondition: false,
      });

    case "recoverable": {
      // gate 级超时/空结果
      const gate = (input.gate ?? "").toLowerCase();
      if (!canAffordRetry(input.budget) || input.attempt >= (input.maxAttempts ?? 1)) {
        // 生产路径：耗尽后 checkpoint 或 blocked，绝不 one_shot_raw
        return decide(
          "checkpoint",
          input,
          "checkpoint",
          "可恢复失败重试耗尽（禁止静默 raw 降级）",
          {
            changesCondition: false,
            nextCondition: input.forbidOneShotRawFallback
              ? "forbid_silent_raw_degrade"
              : undefined,
          },
        );
      }
      if (gate === "model_timeout" || gate.includes("timeout") || gate.includes("empty")) {
        return decide(
          "retry_stage",
          input,
          "retrying",
          "模型超时/空结果：同阶段有界重试",
          {
            nextCondition: "same_stage_bounded_retry",
            changesCondition: true,
            maxAttempts: input.maxAttempts ?? 1,
          },
        );
      }
      if (gate.includes("style")) {
        return decide(
          "retry_stage",
          input,
          "retrying",
          "风格阶段超时/空结果：风格阶段重试一次",
          {
            nextCondition: "style_stage_retry",
            changesCondition: true,
            maxAttempts: 1,
          },
        );
      }
      return decide("retry_gate", input, "retrying", "可恢复失败：retry_gate", {
        nextCondition: "bounded_retry_changed_condition",
        changesCondition: true,
        maxAttempts: input.maxAttempts ?? 1,
      });
    }

    default:
      return decide("stop", input, "blocked", `未识别 failureClass：${input.failureClass as string}`, {
        allowed: false,
        changesCondition: false,
      });
  }
}

/**
 * 将恢复动作映射为 FailureEnvelope.retryPlan.strategy 兼容值。
 */
export function recoveryActionToRetryStrategy(
  action: RecoveryAction,
): "retry_gate" | "chapter_level_retry" | "revise_inputs_and_retry_same_chapter" | "terminal_block_no_retry" {
  switch (action) {
    case "retry_gate":
      return "retry_gate";
    case "retry_stage":
    case "regenerate_candidate":
      return "chapter_level_retry";
    case "user_fix":
      return "revise_inputs_and_retry_same_chapter";
    default:
      return "terminal_block_no_retry";
  }
}

/** 生产路径禁止的恢复文案 */
export const FORBIDDEN_PRODUCTION_FALLBACK = "fallback to one_shot_raw";

export function isForbiddenProductionFallback(text: string | undefined | null): boolean {
  if (!text) return false;
  return text.toLowerCase().includes("one_shot_raw") || text.includes(FORBIDDEN_PRODUCTION_FALLBACK);
}

/**
 * 从 gate/reason 粗分类 FailureClass（供 hardBlock 统一出口）。
 */
export function classifyFailureFromGate(input: {
  gate?: string;
  stage?: string;
  severityOverride?: string;
  recoverable?: boolean;
}): FailureClass {
  const gate = (input.gate ?? "").toLowerCase();
  const stage = (input.stage ?? "").toLowerCase();
  if (input.severityOverride === "preflight" || gate === "preflight" || stage.includes("preflight")) {
    return "preflight";
  }
  if (input.severityOverride === "recoverable" || input.recoverable === true) {
    return "recoverable";
  }
  if (input.severityOverride === "fatal" || stage === "raw_generation") {
    return "fatal";
  }
  if (gate.includes("interrupt") || stage.includes("interrupt")) {
    return "interrupted";
  }
  return "blocked";
}
