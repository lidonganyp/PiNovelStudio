/**
 * ReleaseHealthActions — G8 auto-hold 执行 + retired 建议生成（EVOLUTION-RELEASE-GOVERNANCE-G8）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §8 Phase G8
 * 计划：.trae/documents/g8-health-monitoring-and-retirement-implementation.md §2.5
 *
 * 执行 `release-health-evaluator` 返回的决策（带副作用）：
 * - executeAutoHold：幂等检查 → 调 transitionStatus("held") → 写 state event
 * - generateRetiredSuggestion：纯函数，只生成建议文本，不调任何 registry 方法
 *   （用户通过 `evolution:promote --target retired` 手动执行）
 *
 * 设计原则：
 * - 幂等优先：alreadyHeld=true 直接跳过，不调 transitionStatus
 * - 不 eligible 跳过：shouldAutoHold=false 直接返回
 * - 错误捕获：transitionStatus / recordStateEvent 抛错时返回 held=false + skippedReason
 * - retired 只建议：generateRetiredSuggestion 是纯函数，绝不自动执行 retired
 * - actor 显式：禁止隐式默认，必须由调用方传入 "system" | "user"
 * - eventId 可注入：默认 "evt-auto-hold-{releaseId}-{ISO}"；测试可显式传入固定值
 *
 * 边界（READY_LOCAL）：
 * - 闭包自包含（仅依赖 governance sibling：release-health-evaluator + evolution-release-registry）
 * - 不调模型、不读写 trace、不写章节
 * - 不接入统一编排器主流程（G8 是离线/CLI 工具）
 */

import type { ReleaseHealthEvaluation } from "./release-health-evaluator.js";
import type { EvolutionReleaseRegistry } from "./evolution-release-registry.js";
import type { ReleaseStateEvent } from "./evolution-release-types.js";
import type { ReleasePointerStore } from "./release-pointer-store.js";

// ============================================================================
// 类型
// ============================================================================

/** auto-hold 执行结果 */
export interface AutoHoldAction {
  releaseId: string;
  /** 是否执行了 auto-hold（status 已迁移到 held + state event 已写入） */
  held: boolean;
  /** 跳过原因（已 held / shouldAutoHold=false / transitionStatus 或 recordStateEvent 抛错） */
  skippedReason?: string;
  /** 状态事件 ID（held=true 时填充） */
  eventId?: string;
  /**
   * pointer 清理结果（仅当 pointerStore 提供且 held=true 时填充）。
   *
   * P1-3 修复：auto-hold 后必须清理指向该 release 的 active pointer，
   * 否则 held release 仍是 active pointer → 生产门禁 hard block。
   * - devPointerRolledBack: dev pointer 是否被自动回滚（system 有权）
   * - productionPointerDangling: production pointer 是否悬挂（system 无权回滚，需用户手动处理）
   * - productionPointerWarning: 悬挂时的人工回滚命令（用户操作指引）
   */
  pointerCleanup?: {
    devPointerRolledBack?: boolean;
    productionPointerDangling?: boolean;
    productionPointerWarning?: string;
  };
}

/** executeAutoHold 选项 */
export interface ExecuteAutoHoldOptions {
  /** 触发者：system 自动 / user 用户手动 */
  actor: "system" | "user";
  /** 可选：跳过原因说明（写入 state event.reason） */
  reason?: string;
  /**
   * 可选：approvalRef 覆盖；未提供时由 transitionStatus 从 existing manifest 继承。
   *
   * held 状态不在 APPROVAL_REQUIRED 集合中，approvalRef 不会被强校验，
   * 但 manifest 字段会保留 existing.approvalRef 以便审计。
   */
  approvalRef?: string | null;
  /**
   * 可选：覆盖 eventId（测试用）；默认 "evt-auto-hold-{releaseId}-{ISO}"。
   *
   * eventId 全局唯一，重复会被 recordStateEvent 拒绝（append-only）。
   */
  eventId?: string;
  /** 可选：覆盖 timestamp（测试用）；默认 new Date().toISOString() */
  timestamp?: string;
  /**
   * 可选：release pointer store，用于 hold 后清理指向该 release 的 active pointer。
   *
   * P1-3 修复：auto-hold 后 held release 不应仍是 active pointer，否则生产门禁 hard block。
   * - dev pointer：system 可直接 rollback（dev pointer 允许所有 actor 写）
   * - production pointer：system 无权 rollback（仅 user）；标记悬挂 + warning 供用户手动处理
   *
   * 未提供时不清理（向后兼容；调用方未接入 pointerStore 时保持原行为）。
   */
  pointerStore?: Pick<ReleasePointerStore, "readActive" | "rollback">;
}

/** retired 建议结果（只读，不自动执行） */
export interface RetiredSuggestion {
  releaseId: string;
  /** 建议文本（人类可读，包含证据摘要与手动执行命令） */
  suggestion: string;
  /** 触发建议的证据摘要 */
  evidence: {
    longTermAlignmentRate: number;
    sampleCount: number;
  };
  /** 用户手动执行 retired 的命令 */
  manualCommand: string;
}

// ============================================================================
// 实现
// ============================================================================

/**
 * 执行 auto-hold 决策（带副作用）。
 *
 * 幂等优先级：
 * 1. evaluation.decision.alreadyHeld=true -> held=false, skippedReason="already_held"
 * 2. evaluation.decision.shouldAutoHold=false -> held=false, skippedReason="not_eligible"
 * 3. 调 registry.transitionStatus(releaseId, "held", { actor, approvalRef })
 * 4. 调 registry.recordStateEvent({ eventId, releaseId, fromStatus, toStatus: "held", ... })
 * 5. transitionStatus 抛错 -> held=false, skippedReason=error.message（manifest 未变更，无需回滚）
 * 6. recordStateEvent 抛错 -> 尝试回滚 transitionStatus(releaseId, fromStatus)：
 *    - 回滚成功：held=false, skippedReason（manifest 恢复原状态，原子性保证）
 *    - 回滚失败：held=true, skippedReason（manifest 保持 held，与返回值一致；
 *      无法回滚的场景如 held→candidate_prod 不在 TRANSITIONS 中；
 *      state event 未写入但 manifest 已 held，需人工补写 state event 或手动回滚）
 *
 * P1 修复（用户第三轮核验）：原实现 transitionStatus 成功后 recordStateEvent 抛错时
 * 外层 catch 直接返回 held:false，但 manifest 实际已 held（非原子性 BUG）。
 * 修复后明确分离 transitionStatus 与 recordStateEvent 的失败处理，
 * 并在 recordStateEvent 失败时尝试回滚 manifest 状态。
 *
 * @param registry EvolutionReleaseRegistry 实例
 * @param evaluation 健康判定结果（来自 evaluateReleaseHealth）
 * @param options { actor, reason?, approvalRef?, eventId?, timestamp? }
 * @returns AutoHoldAction
 */
export function executeAutoHold(
  registry: EvolutionReleaseRegistry,
  evaluation: ReleaseHealthEvaluation,
  options: ExecuteAutoHoldOptions,
): AutoHoldAction {
  const { releaseId } = evaluation;
  const { actor } = options;

  // 1. 幂等：已 held 不重复触发
  if (evaluation.decision.alreadyHeld) {
    return {
      releaseId,
      held: false,
      skippedReason: "already_held",
    };
  }

  // 2. 不 eligible：shouldAutoHold=false 跳过
  if (!evaluation.decision.shouldAutoHold) {
    return {
      releaseId,
      held: false,
      skippedReason: "not_eligible",
    };
  }

  // 3. 生成 eventId / timestamp（可被 options 覆盖）
  const timestamp = options.timestamp ?? new Date().toISOString();
  const eventId =
    options.eventId ?? `evt-auto-hold-${releaseId}-${timestamp}`;

  // 4. 加载 existing manifest 以获取 fromStatus（用于 state event + 失败回滚）
  //    transitionStatus 内部也会加载，但这里需要 fromStatus 写 state event 和回滚目标。
  const existing = registry.loadManifest(releaseId);
  if (!existing) {
    return {
      releaseId,
      held: false,
      skippedReason: `transitionStatus 失败：releaseId ${releaseId} 的 manifest 不存在`,
    };
  }
  const fromStatus = existing.status;

  // 5. 执行状态迁移（transitionStatus 失败时 manifest 未变更，无需回滚）
  try {
    // transitionStatus：校验状态迁移合法性 + 审批绑定 + 角色守护
    // held 不在 APPROVAL_REQUIRED 集合，approvalRef 不会被强校验。
    // approvalRef 未传入时由 transitionStatus 从 existing 继承。
    registry.transitionStatus(releaseId, "held", {
      actor,
      approvalRef: options.approvalRef ?? undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      releaseId,
      held: false,
      skippedReason: `transitionStatus failed: ${message}`,
    };
  }

  // 6. 写 state event（失败时尝试回滚 manifest，保证原子性）
  const event: ReleaseStateEvent = {
    eventId,
    releaseId,
    fromStatus,
    toStatus: "held",
    reason:
      options.reason ??
      `auto-hold triggered: alignmentRate=${evaluation.evidence.alignmentRate.toFixed(2)}, ` +
        `consecutiveNegative=${evaluation.evidence.consecutiveNegative}, ` +
        `rollbackRate=${evaluation.evidence.rollbackRate.toFixed(2)}`,
    actor,
    evidenceRefs: [],
    timestamp,
  };

  try {
    registry.recordStateEvent(event);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // P1 修复：state event 写入失败时尝试回滚 manifest 状态，保证原子性。
    // held → fromStatus 必须在 TRANSITIONS 中允许：
    //   - held → active_dev ✓（可回滚）
    //   - held → active_prod ✓（需 actor="user"，system 无权）
    //   - held → candidate_prod ✗（不在 TRANSITIONS，无法回滚）
    //   - held → evaluated ✗（不在 TRANSITIONS）
    //   - held → rejected/retired ✓（语义错误，不尝试）
    try {
      registry.transitionStatus(releaseId, fromStatus, {
        actor,
        approvalRef: options.approvalRef ?? undefined,
      });
      // 回滚成功：manifest 恢复为 fromStatus，返回 held:false + 跳过原因
      return {
        releaseId,
        held: false,
        skippedReason:
          `recordStateEvent failed (reverted transition to held): ${message}`,
      };
    } catch (revertError) {
      // 回滚失败：manifest 仍是 held，但 state event 未写入。
      // 返回 held:true + warning（manifest 状态与返回值一致，避免非原子性）。
      // 调用方需人工介入：补写 state event 或手动回滚 manifest。
      const revertMessage =
        revertError instanceof Error ? revertError.message : String(revertError);
      return {
        releaseId,
        held: true,
        skippedReason:
          `recordStateEvent failed and revert failed: ${message}; ` +
          `revert error: ${revertMessage}; ` +
          `manifest remains held but state event was not recorded`,
      };
    }
  }

  // 7. 清理指向该 release 的 active pointer（P1-3 修复）
  // held release 不应仍是 active pointer，否则生产门禁 hard block。
  // 仅当 pointerStore 提供时执行；未提供时保持原行为（向后兼容）。
  let pointerCleanup: AutoHoldAction["pointerCleanup"] | undefined;
  if (options.pointerStore) {
    pointerCleanup = cleanupPointersAfterHold(
      options.pointerStore,
      releaseId,
      actor,
      timestamp,
    );
  }

  return {
    releaseId,
    held: true,
    eventId,
    ...(pointerCleanup ? { pointerCleanup } : {}),
  };
}

/**
 * 清理指向 held release 的 active pointer（P1-3 修复 helper）。
 *
 * 清理规则：
 * - dev pointer 指向 held release：system 可直接 rollback（dev pointer 允许所有 actor 写）
 * - production pointer 指向 held release：
 *   - actor="user" 时尝试 rollback（user 有权操作 production pointer）
 *   - actor="system" 时无权 rollback，标记悬挂 + warning 供用户手动处理
 *   （强制回滚会破坏 G6 P0-2 的 actor 权限模型）
 *
 * 不指向 held release 的 pointer 不受影响。
 */
function cleanupPointersAfterHold(
  store: Pick<ReleasePointerStore, "readActive" | "rollback">,
  heldReleaseId: string,
  actor: "system" | "user",
  timestamp: string,
): NonNullable<AutoHoldAction["pointerCleanup"]> {
  const result: NonNullable<AutoHoldAction["pointerCleanup"]> = {};
  const reason = `auto-hold: release ${heldReleaseId} transitioned to held at ${timestamp}`;

  // dev pointer：system 可直接 rollback（dev pointer 允许所有 actor 写）
  const devActive = store.readActive("development");
  if (devActive?.releaseId === heldReleaseId) {
    try {
      store.rollback("development", { actor, reason });
      result.devPointerRolledBack = true;
    } catch {
      result.devPointerRolledBack = false;
    }
  }

  // production pointer：system 无权 rollback（仅 user）
  const prodActive = store.readActive("production");
  if (prodActive?.releaseId === heldReleaseId) {
    if (actor === "user") {
      try {
        store.rollback("production", { actor, reason });
        result.productionPointerDangling = false;
      } catch {
        result.productionPointerDangling = true;
        result.productionPointerWarning =
          `production pointer 仍指向 held release ${heldReleaseId}（回滚失败）；` +
          `请用户手动执行：evolution rollback --kind production --reason "held release cleanup"`;
      }
    } else {
      // system 无权操作 production pointer（G6 P0-2 actor 权限守护）
      result.productionPointerDangling = true;
      result.productionPointerWarning =
        `production pointer 仍指向 held release ${heldReleaseId}（system 无权回滚）；` +
        `请用户手动执行：evolution rollback --kind production --reason "held release cleanup"`;
    }
  }

  return result;
}

/**
 * 生成 retired 建议（纯函数，不自动执行）。
 *
 * 仅当 evaluation.decision.shouldSuggestRetired=true 时返回建议；
 * 否则返回 null。
 *
 * 建议文本包含：
 * - releaseId
 * - longTermAlignmentRate 证据
 * - sampleCount 证据
 * - 用户手动执行命令：`evolution:promote --target retired --release-id <id>`
 *
 * @param evaluation 健康判定结果
 * @returns RetiredSuggestion 或 null
 */
export function generateRetiredSuggestion(
  evaluation: ReleaseHealthEvaluation,
): RetiredSuggestion | null {
  if (!evaluation.decision.shouldSuggestRetired) {
    return null;
  }

  const { releaseId, evidence } = evaluation;
  const longTermAlignmentRate = evidence.longTermAlignmentRate;
  const sampleCount = evidence.sampleCount;

  const suggestion =
    `Release ${releaseId} 建议退役（retired）：\n` +
    `  长期 alignmentRate=${longTermAlignmentRate.toFixed(2)} < RETIRED_ALIGNMENT_RATE=0.30\n` +
    `  样本数 sampleCount=${sampleCount}（>= MIN_SAMPLE_SIZE=3）\n` +
    `  当前 status=${evaluation.decision.currentStatus}\n` +
    `  \n` +
    `  退役不会自动执行——retired 是人工决策。\n` +
    `  请人工 review 后通过 manualCommand 手动执行：\n` +
    `    ${`evolution:promote --target retired --release-id ${releaseId}`}`;

  const manualCommand = `evolution:promote --target retired --release-id ${releaseId}`;

  return {
    releaseId,
    suggestion,
    evidence: {
      longTermAlignmentRate,
      sampleCount,
    },
    manualCommand,
  };
}
