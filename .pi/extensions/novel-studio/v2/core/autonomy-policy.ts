/**
 * AUTONOMY-POLICY — 模型自主性策略与统一授权裁决。
 *
 * 真相源：delete/任务列表/项目计划20260812-2.md §3.1 / §4-P0 / §4-P1 / §4-P6
 *
 * 职责分离：
 * - ModelAutonomyPolicy：模型能否请求/触发某动作
 * - CapabilityPolicy（control-plane.ts）：编排器是否具备执行能力
 * - authorizeAction：两层同时通过 + 审批绑定校验（正式提交）
 *
 * 硬规则：
 * - 模型永远不能拥有 state.commit / chapter.save
 * - 模型输出 confirm/approved/userConfirmed 不参与授权判断
 * - 未知动作默认拒绝
 * - 动作升级只能产生 approval_required，不能自动升级
 */

import { createHash, randomBytes } from "node:crypto";
import {
  getActionCatalogEntry,
  isKnownAction,
  mapToolNameToAction,
} from "./action-catalog.js";
import type { CapabilityName, CapabilityPolicy } from "./control-plane.js";
import type {
  ActionName,
  ActorType,
  AuthorizationDecision,
  AuthorizationRequest,
  AuthorizationResultCode,
  AutonomyLevel,
  ControlDecisionRecord,
} from "./control-types.js";
import {
  AUTONOMY_LEVEL_RANK,
  MODEL_FORBIDDEN_ACTIONS,
  MODEL_MAX_AUTONOMY_LEVEL,
} from "./control-types.js";

// ============================================================================
// Trace sink
// ============================================================================

export type ControlDecisionSink = (record: ControlDecisionRecord) => void;

const globalDecisions: ControlDecisionRecord[] = [];
let externalSink: ControlDecisionSink | null = null;

/** 注册外部 sink（如 stageResults.controlDecisions.push） */
export function setControlDecisionSink(sink: ControlDecisionSink | null): void {
  externalSink = sink;
}

/** 读取本进程累计控制决策（测试/审计） */
export function getControlDecisionRecords(): ReadonlyArray<ControlDecisionRecord> {
  return globalDecisions;
}

/** 清空累计决策（测试隔离） */
export function clearControlDecisionRecords(): void {
  globalDecisions.length = 0;
}

function emitDecision(record: ControlDecisionRecord): void {
  globalDecisions.push(record);
  if (externalSink) {
    try {
      externalSink(record);
    } catch {
      // sink 失败不得影响授权裁决
    }
  }
}

function newTraceId(): string {
  return `ctrl-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function levelAtMost(requested: AutonomyLevel, max: AutonomyLevel): boolean {
  return AUTONOMY_LEVEL_RANK[requested] <= AUTONOMY_LEVEL_RANK[max];
}

// ============================================================================
// ModelAutonomyPolicy
// ============================================================================

export interface ModelAutonomyPolicyOptions {
  /** 模型最高自主性；默认 bounded_execute */
  maxLevel?: AutonomyLevel;
  /** 额外禁止的动作 */
  forbiddenActions?: ReadonlySet<ActionName>;
}

/**
 * 模型自主性策略：只回答“模型是否可以请求/触发该动作”。
 * 不回答“编排器是否有执行能力”（那是 CapabilityPolicy）。
 */
export class ModelAutonomyPolicy {
  readonly maxLevel: AutonomyLevel;
  private readonly forbidden: ReadonlySet<ActionName>;

  constructor(options: ModelAutonomyPolicyOptions = {}) {
    this.maxLevel = options.maxLevel ?? MODEL_MAX_AUTONOMY_LEVEL;
    this.forbidden = options.forbiddenActions ?? MODEL_FORBIDDEN_ACTIONS;
  }

  /**
   * 评估模型对某动作的自主性请求。
   * 返回决策；不产生副作用（除审计 trace）。
   */
  evaluate(request: AuthorizationRequest): AuthorizationDecision {
    const timestamp = nowIso();
    const traceId = newTraceId();
    const actor = request.actor;

    // 非 model actor：本策略不裁决，交由上层
    if (actor !== "model") {
      return this.finish({
        request,
        allowed: true,
        effectiveLevel: request.requestedLevel,
        requiresApproval: false,
        reason: `actor=${actor} 不由 ModelAutonomyPolicy 限制`,
        result: "allowed",
        consumed: false,
        traceId,
        timestamp,
      });
    }

    if (!isKnownAction(request.action)) {
      return this.finish({
        request,
        allowed: false,
        effectiveLevel: "observe",
        requiresApproval: false,
        reason: `未知动作拒绝：${request.action}`,
        result: "unknown_action",
        blockReason: "unknown_action",
        consumed: false,
        traceId,
        timestamp,
      });
    }

    if (this.forbidden.has(request.action) || MODEL_FORBIDDEN_ACTIONS.has(request.action)) {
      return this.finish({
        request,
        allowed: false,
        effectiveLevel: "observe",
        requiresApproval: false,
        reason: `模型禁止动作：${request.action}`,
        result: "actor_forbidden",
        blockReason: "actor_forbidden",
        consumed: false,
        traceId,
        timestamp,
      });
    }

    const entry = getActionCatalogEntry(request.action)!;
    if (!entry.modelMayRequest) {
      return this.finish({
        request,
        allowed: false,
        effectiveLevel: entry.defaultAutonomyLevel,
        requiresApproval: entry.requiresUserApproval,
        reason: `模型不可请求动作：${request.action}`,
        result: "actor_forbidden",
        blockReason: "actor_forbidden",
        consumed: false,
        traceId,
        timestamp,
      });
    }

    // 请求等级超过模型上限：不自动升级，返回 approval_required 或 deny
    if (!levelAtMost(request.requestedLevel, this.maxLevel)) {
      const needsApproval =
        AUTONOMY_LEVEL_RANK[request.requestedLevel] >= AUTONOMY_LEVEL_RANK.checkpoint;
      return this.finish({
        request,
        allowed: false,
        effectiveLevel: this.maxLevel,
        requiresApproval: needsApproval,
        reason: needsApproval
          ? `动作升级需要审批：requested=${request.requestedLevel} max=${this.maxLevel}`
          : `请求等级超过模型上限：requested=${request.requestedLevel} max=${this.maxLevel}`,
        result: needsApproval ? "approval_required" : "denied",
        blockReason: needsApproval ? "approval_required" : "actor_forbidden",
        consumed: false,
        traceId,
        timestamp,
      });
    }

    // 请求等级高于动作默认等级：只能 approval_required，不自动升级
    if (
      AUTONOMY_LEVEL_RANK[request.requestedLevel] >
      AUTONOMY_LEVEL_RANK[entry.defaultAutonomyLevel]
    ) {
      return this.finish({
        request,
        allowed: false,
        effectiveLevel: entry.defaultAutonomyLevel,
        requiresApproval: true,
        reason: `动作升级需要审批：${request.action} requested=${request.requestedLevel} default=${entry.defaultAutonomyLevel}`,
        result: "approval_required",
        blockReason: "approval_required",
        consumed: false,
        traceId,
        timestamp,
      });
    }

    return this.finish({
      request,
      allowed: true,
      effectiveLevel: request.requestedLevel,
      requiresApproval: entry.requiresUserApproval,
      reason: `模型自主性允许：${request.action}@${request.requestedLevel}`,
      result: "allowed",
      consumed: false,
      traceId,
      timestamp,
    });
  }

  /**
   * 工具调用前守护：将工具名映射为动作并按 model actor 评估。
   * 供 NovelOS Runtime beforeToolCall 接入。
   * 未知工具名 fail-closed（unknown_action），不得默认放行。
   */
  authorizeToolCall(input: {
    toolName: string;
    taskId: string;
    workspaceId: string;
    chapterId?: string;
  }): AuthorizationDecision {
    const action = mapToolNameToAction(input.toolName);
    if (action === null) {
      const timestamp = nowIso();
      const traceId = newTraceId();
      const request: AuthorizationRequest = {
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        chapterId: input.chapterId,
        // 占位动作仅用于审计结构；真实阻断原因是 unknown_action
        action: "retrieval.execute",
        requestedLevel: "observe",
        actor: "model",
        scope: {
          workspaceId: input.workspaceId,
          chapterId: input.chapterId,
          taskId: input.taskId,
        },
        resource: input.toolName,
        reason: `beforeToolCall:unknown_tool:${input.toolName}`,
      };
      return this.finish({
        request,
        allowed: false,
        effectiveLevel: "observe",
        requiresApproval: false,
        reason: `未知工具拒绝：${input.toolName}`,
        result: "unknown_action",
        blockReason: "unknown_action",
        consumed: false,
        traceId,
        timestamp,
      });
    }
    const entry = getActionCatalogEntry(action);
    const requestedLevel = entry?.defaultAutonomyLevel ?? "bounded_execute";
    return this.evaluate({
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      chapterId: input.chapterId,
      action,
      requestedLevel,
      actor: "model",
      scope: {
        workspaceId: input.workspaceId,
        chapterId: input.chapterId,
        taskId: input.taskId,
      },
      resource: input.toolName,
      reason: `beforeToolCall:${input.toolName}`,
    });
  }

  private finish(args: {
    request: AuthorizationRequest;
    allowed: boolean;
    effectiveLevel: AutonomyLevel;
    requiresApproval: boolean;
    reason: string;
    result: AuthorizationResultCode;
    blockReason?: AuthorizationResultCode;
    consumed: boolean;
    traceId: string;
    timestamp: string;
  }): AuthorizationDecision {
    const decision: AuthorizationDecision = {
      allowed: args.allowed,
      effectiveLevel: args.effectiveLevel,
      requiresApproval: args.requiresApproval,
      reason: args.reason,
      blockReason: args.blockReason,
      consumed: args.consumed,
      traceId: args.traceId,
      result: args.result,
      timestamp: args.timestamp,
    };
    emitDecision({
      timestamp: args.timestamp,
      taskId: args.request.taskId,
      workspaceId: args.request.workspaceId,
      chapterId: args.request.chapterId,
      actor: args.request.actor,
      action: args.request.action,
      requestedLevel: args.request.requestedLevel,
      effectiveLevel: args.effectiveLevel,
      scope: args.request.scope,
      resource: args.request.resource,
      allowed: args.allowed,
      consumed: args.consumed,
      approvalId: args.request.approvalId,
      artifactHash: args.request.artifactHash,
      revision: args.request.revision,
      result: args.result,
      blockReason: args.blockReason,
      reason: args.reason,
      traceId: args.traceId,
    });
    return decision;
  }
}

export function createModelAutonomyPolicy(
  options?: ModelAutonomyPolicyOptions,
): ModelAutonomyPolicy {
  return new ModelAutonomyPolicy(options);
}

// ============================================================================
// Unified authorizeAction (autonomy + execution capability)
// ============================================================================

export interface AuthorizeActionInput {
  request: AuthorizationRequest;
  /** 执行能力策略（编排器侧） */
  executionPolicy?: CapabilityPolicy;
  /** 模型自主性策略；缺省使用默认策略 */
  autonomyPolicy?: ModelAutonomyPolicy;
  /**
   * 模型输出中的 confirm/approved/userConfirmed 等字段。
   * 明确传入时会被忽略并记入 reason，绝不参与授权。
   */
  modelClaimedConfirmation?: unknown;
}

/**
 * 统一授权入口：
 * model request -> autonomy policy -> execution capability policy
 *
 * 注意：正式提交的审批对象校验见 authorizeCommitAction（governance 层）。
 */
export function authorizeAction(input: AuthorizeActionInput): AuthorizationDecision {
  const autonomy = input.autonomyPolicy ?? createModelAutonomyPolicy();
  const request = input.request;
  const timestamp = nowIso();
  const ignoreNote =
    input.modelClaimedConfirmation !== undefined
      ? "（忽略模型输出的确认字段，不参与授权）"
      : "";

  // 1) 模型 actor：先过自主性
  if (request.actor === "model") {
    const autoDecision = autonomy.evaluate(request);
    if (!autoDecision.allowed) {
      return {
        ...autoDecision,
        reason: `${autoDecision.reason}${ignoreNote}`,
      };
    }
  }

  // 2) 执行能力（若提供 CapabilityPolicy）
  if (input.executionPolicy) {
    const entry = isKnownAction(request.action)
      ? getActionCatalogEntry(request.action)
      : null;
    const capability = entry?.executionCapability as CapabilityName | undefined;
    if (capability) {
      const auth = input.executionPolicy.authorize(
        capability,
        request.reason ?? `authorizeAction:${request.action}`,
      );
      if (!auth.allowed) {
        const decision: AuthorizationDecision = {
          allowed: false,
          effectiveLevel: request.requestedLevel,
          requiresApproval: entry?.requiresUserApproval ?? false,
          reason: `执行能力拒绝：${capability}${ignoreNote}`,
          blockReason: "capability_denied",
          consumed: auth.consumed,
          traceId: newTraceId(),
          result: "capability_denied",
          timestamp,
        };
        emitDecision({
          timestamp,
          taskId: request.taskId,
          workspaceId: request.workspaceId,
          chapterId: request.chapterId,
          actor: request.actor,
          action: request.action,
          capability,
          requestedLevel: request.requestedLevel,
          effectiveLevel: request.requestedLevel,
          scope: request.scope,
          resource: request.resource,
          allowed: false,
          consumed: auth.consumed,
          approvalId: request.approvalId,
          artifactHash: request.artifactHash,
          revision: request.revision,
          result: "capability_denied",
          blockReason: "capability_denied",
          reason: decision.reason,
          traceId: decision.traceId,
        });
        return decision;
      }
    }
  }

  // 3) 模型禁止动作的第二道守护（即使 actor 被伪造为 orchestrator 也不放行模型侧工具）
  // 仅当 actor=model 时强制；orchestrator/user/system 由执行策略与审批对象守护。
  if (request.actor === "model" && MODEL_FORBIDDEN_ACTIONS.has(request.action)) {
    const decision: AuthorizationDecision = {
      allowed: false,
      effectiveLevel: "observe",
      requiresApproval: false,
      reason: `模型第二道守护拒绝：${request.action}${ignoreNote}`,
      blockReason: "actor_forbidden",
      consumed: false,
      traceId: newTraceId(),
      result: "actor_forbidden",
      timestamp,
    };
    emitDecision({
      timestamp,
      taskId: request.taskId,
      workspaceId: request.workspaceId,
      chapterId: request.chapterId,
      actor: "model",
      action: request.action,
      requestedLevel: request.requestedLevel,
      effectiveLevel: "observe",
      scope: request.scope,
      resource: request.resource,
      allowed: false,
      consumed: false,
      result: "actor_forbidden",
      blockReason: "actor_forbidden",
      reason: decision.reason,
      traceId: decision.traceId,
    });
    return decision;
  }

  const entry = isKnownAction(request.action)
    ? getActionCatalogEntry(request.action)
    : null;
  if (!entry && request.actor === "model") {
    // 未知动作对模型默认拒绝（evaluate 已覆盖，这里兜底）
    return autonomy.evaluate(request);
  }

  const decision: AuthorizationDecision = {
    allowed: true,
    effectiveLevel: request.requestedLevel,
    requiresApproval: entry?.requiresUserApproval ?? false,
    reason: `授权通过：actor=${request.actor} action=${request.action}${ignoreNote}`,
    consumed: false,
    traceId: newTraceId(),
    result: "allowed",
    timestamp,
  };
  emitDecision({
    timestamp,
    taskId: request.taskId,
    workspaceId: request.workspaceId,
    chapterId: request.chapterId,
    actor: request.actor,
    action: request.action,
    capability: entry?.executionCapability,
    requestedLevel: request.requestedLevel,
    effectiveLevel: request.requestedLevel,
    scope: request.scope,
    resource: request.resource,
    allowed: true,
    consumed: false,
    approvalId: request.approvalId,
    artifactHash: request.artifactHash,
    revision: request.revision,
    result: "allowed",
    reason: decision.reason,
    traceId: decision.traceId,
  });
  return decision;
}

/**
 * 模型身份第二道守护：编排器在 state.commit / chapter.save 前调用。
 * 若 actor 被标记为 model，或请求携带模型伪造确认字段，一律拒绝。
 */
export function assertOrchestratorCommitActor(input: {
  actor: ActorType;
  action: ActionName;
  taskId: string;
  workspaceId: string;
  chapterId?: string;
  modelClaimedConfirmation?: unknown;
}): AuthorizationDecision {
  return authorizeAction({
    request: {
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      chapterId: input.chapterId,
      action: input.action,
      requestedLevel: "commit",
      actor: input.actor,
      scope: {
        workspaceId: input.workspaceId,
        chapterId: input.chapterId,
        taskId: input.taskId,
      },
      reason: "orchestrator-commit-guard",
    },
    modelClaimedConfirmation: input.modelClaimedConfirmation,
  });
}

/** 稳定内容 hash（审批/正文绑定用；完整 sha256 hex） */
export function computeArtifactHash(text: string): string {
  return createHash("sha256").update(text ?? "", "utf8").digest("hex");
}
