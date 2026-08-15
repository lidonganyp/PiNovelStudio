/**
 * CONTROL-PLANE-1 — 统一主链路任务包与能力策略。
 *
 * 控制平面只负责边界、授权、模型锁和审计，不参与正文或文学判断。
 *
 * 职责分离（计划 20260812-2）：
 * - CapabilityPolicy / ExecutionCapabilityPolicy：编排器或系统是否具备执行能力
 * - ModelAutonomyPolicy（autonomy-policy.ts）：模型是否可自主请求/触发动作
 * 禁止用 CapabilityPolicy 单独表达模型自主性。
 */

import { createHash } from "node:crypto";
import type {
  ActorType,
  AutonomyLevel,
  ControlDecisionRecord,
} from "./control-types.js";

export type CapabilityName =
  | "network.model_call"
  | "model.generate"
  | "model.judge"
  | "state.read"
  | "state.stage"
  | "state.commit"
  | "chapter.save"
  | "artifact.export";

export type CapabilityMode = "allow" | "deny" | "authorized_once";

/**
 * 执行能力策略别名：明确表达“编排器/系统执行授权”，
 * 与模型自主性策略（ModelAutonomyPolicy）分离。
 */
export type ExecutionCapabilityPolicy = CapabilityPolicy;

export interface ModelLock {
  route: string;
  provider: string;
  model: string;
}

export interface NovelTaskPacket {
  schema: "pinovel.novel-task-packet";
  version: "1.0";
  packetId: string;
  packetHash: string;
  taskId: string;
  objective: string;
  scope: string[];
  allowedResources: string[];
  forbiddenResources: string[];
  modelLocks: {
    generation: ModelLock;
    judge: ModelLock;
  };
  capabilityProfileId: string;
  acceptance: string[];
  negativeVerification: string[];
  recovery: string[];
  reporting: string[];
  source: string;
}

export interface NovelTaskPacketInput {
  taskId: string;
  objective: string;
  scope: string[];
  allowedResources: string[];
  forbiddenResources: string[];
  generationLock: ModelLock;
  judgeLock: ModelLock;
  capabilityProfileId: string;
  acceptance: string[];
  negativeVerification: string[];
  recovery: string[];
  reporting: string[];
  source: string;
}

export interface CapabilityDecisionTrace {
  capability: CapabilityName;
  mode: CapabilityMode;
  source: string;
  scope: string;
  reason: string;
  allowed: boolean;
  consumed: boolean;
  timestamp: string;
  /** P6：可选 actor（默认 orchestrator 执行侧） */
  actor?: ActorType;
  /** P6：可选自主性等级 */
  requestedLevel?: AutonomyLevel;
  effectiveLevel?: AutonomyLevel;
  action?: string;
  blockReason?: string;
  traceId?: string;
}

export interface CapabilityPolicyInput {
  profileId: string;
  decisions: Partial<Record<CapabilityName, CapabilityMode>>;
  source?: string;
  scope?: string;
  reasons?: Partial<Record<CapabilityName, string>>;
}

export interface CapabilityAuthorization {
  allowed: boolean;
  consumed: boolean;
  trace: CapabilityDecisionTrace;
}

export class CapabilityPolicy {
  readonly profileId: string;
  readonly source: string;
  readonly scope: string;
  readonly decisions: CapabilityDecisionTrace[] = [];
  private readonly modes: Partial<Record<CapabilityName, CapabilityMode>>;
  private readonly reasons: Partial<Record<CapabilityName, string>>;
  private readonly consumedOnce = new Set<CapabilityName>();

  constructor(input: CapabilityPolicyInput) {
    this.profileId = input.profileId;
    this.source = input.source ?? "trusted-entry";
    this.scope = input.scope ?? "unified-pipeline";
    this.modes = { ...input.decisions };
    this.reasons = { ...input.reasons };
  }

  authorize(
    capability: CapabilityName,
    reason: string,
    meta?: {
      actor?: ActorType;
      requestedLevel?: AutonomyLevel;
      effectiveLevel?: AutonomyLevel;
      action?: string;
      blockReason?: string;
      traceId?: string;
    },
  ): CapabilityAuthorization {
    const mode = this.modes[capability] ?? "deny";
    const alreadyConsumed = this.consumedOnce.has(capability);
    const allowed = mode === "allow" || (mode === "authorized_once" && !alreadyConsumed);
    const consumed = mode === "authorized_once" && (allowed || alreadyConsumed);
    if (mode === "authorized_once" && allowed) {
      this.consumedOnce.add(capability);
    }
    const actor = meta?.actor ?? "orchestrator";
    // 硬规则：模型 actor 永远不能获得 state.commit / chapter.save
    const modelForbidden =
      actor === "model" &&
      (capability === "state.commit" || capability === "chapter.save");
    const finalAllowed = modelForbidden ? false : allowed;
    const trace: CapabilityDecisionTrace = {
      capability,
      mode: modelForbidden ? "deny" : mode,
      source: this.source,
      scope: this.scope,
      reason: modelForbidden
        ? `模型禁止执行能力：${capability}`
        : (this.reasons[capability] ?? reason),
      allowed: finalAllowed,
      consumed: modelForbidden ? false : consumed,
      timestamp: new Date().toISOString(),
      actor,
      requestedLevel: meta?.requestedLevel,
      effectiveLevel: meta?.effectiveLevel,
      action: meta?.action,
      blockReason: modelForbidden
        ? "actor_forbidden"
        : meta?.blockReason,
      traceId: meta?.traceId,
    };
    this.decisions.push(trace);
    return { allowed: finalAllowed, consumed: trace.consumed, trace };
  }

  summary(): Record<string, unknown> {
    return {
      profileId: this.profileId,
      source: this.source,
      scope: this.scope,
      configured: { ...this.modes },
    };
  }
}

export interface TrustedControlPlaneInput {
  taskId: string;
  objective: string;
  scope: string[];
  allowedResources: string[];
  forbiddenResources: string[];
  generationLock: ModelLock;
  judgeLock: ModelLock;
  executionGenerationLock?: ModelLock;
  executionJudgeLock?: ModelLock;
  modelTransport: "stub" | "network" | "local";
  capabilityOverrides?: Partial<Record<CapabilityName, CapabilityMode>>;
  source?: string;
  enforceModelLocks?: boolean;
}

export interface TrustedControlPlane {
  packet: NovelTaskPacket;
  policy: CapabilityPolicy;
  executionLocks: {
    generation: ModelLock;
    judge: ModelLock;
  };
  modelTransport: "stub" | "network" | "local";
  enforceModelLocks: boolean;
}

const ALL_CAPABILITIES: CapabilityName[] = [
  "network.model_call",
  "model.generate",
  "model.judge",
  "state.read",
  "state.stage",
  "state.commit",
  "chapter.save",
  "artifact.export",
];

export function createNovelTaskPacket(input: NovelTaskPacketInput): NovelTaskPacket {
  const payload = {
    schema: "pinovel.novel-task-packet" as const,
    version: "1.0" as const,
    taskId: input.taskId,
    objective: input.objective,
    scope: [...input.scope],
    allowedResources: [...input.allowedResources],
    forbiddenResources: [...input.forbiddenResources],
    modelLocks: {
      generation: { ...input.generationLock },
      judge: { ...input.judgeLock },
    },
    capabilityProfileId: input.capabilityProfileId,
    acceptance: [...input.acceptance],
    negativeVerification: [...input.negativeVerification],
    recovery: [...input.recovery],
    reporting: [...input.reporting],
    source: input.source,
  };
  const packetHash = stableHash(payload);
  return {
    ...payload,
    packetId: `novel-task:${input.taskId}:${packetHash.slice(0, 16)}`,
    packetHash,
  };
}

export function validateNovelTaskPacket(packet: NovelTaskPacket): string[] {
  const errors: string[] = [];
  if (!packet.taskId?.trim()) errors.push("packet.taskId 缺失");
  if (!packet.objective?.trim()) errors.push("packet.objective 缺失");
  if (!Array.isArray(packet.scope) || packet.scope.length === 0) errors.push("packet.scope 缺失");
  if (!packet.capabilityProfileId?.trim()) errors.push("packet.capabilityProfileId 缺失");
  for (const [name, lock] of Object.entries(packet.modelLocks ?? {})) {
    if (!lock?.route || !lock.provider || !lock.model) errors.push(`packet.modelLocks.${name} 不完整`);
  }
  const payload = {
    schema: packet.schema,
    version: packet.version,
    taskId: packet.taskId,
    objective: packet.objective,
    scope: packet.scope,
    allowedResources: packet.allowedResources,
    forbiddenResources: packet.forbiddenResources,
    modelLocks: packet.modelLocks,
    capabilityProfileId: packet.capabilityProfileId,
    acceptance: packet.acceptance,
    negativeVerification: packet.negativeVerification,
    recovery: packet.recovery,
    reporting: packet.reporting,
    source: packet.source,
  };
  if (stableHash(payload) !== packet.packetHash) errors.push("packet hash 校验失败");
  return errors;
}

export function createCapabilityPolicy(input: CapabilityPolicyInput): CapabilityPolicy {
  return new CapabilityPolicy(input);
}

export function buildTrustedControlPlane(input: TrustedControlPlaneInput): TrustedControlPlane {
  const profileId = `${input.taskId}:capabilities`;
  const defaults = Object.fromEntries(
    ALL_CAPABILITIES.map((capability) => [capability, "allow"]),
  ) as Record<CapabilityName, CapabilityMode>;
  defaults["network.model_call"] = input.modelTransport === "network" ? "allow" : "deny";
  const policy = createCapabilityPolicy({
    profileId,
    source: input.source ?? "trusted-entry",
    scope: input.scope.join(" | "),
    decisions: { ...defaults, ...(input.capabilityOverrides ?? {}) },
  });
  const packet = createNovelTaskPacket({
    taskId: input.taskId,
    objective: input.objective,
    scope: input.scope,
    allowedResources: input.allowedResources,
    forbiddenResources: input.forbiddenResources,
    generationLock: input.generationLock,
    judgeLock: input.judgeLock,
    capabilityProfileId: profileId,
    acceptance: ["所有副作用前完成 capability 检查", "expected 与 actual 模型证据分离"],
    negativeVerification: ["未授权能力 fail-closed", "公开输入不能提升能力"],
    recovery: ["保留 raw fallback", "控制面冲突时阻断并记录原因"],
    reporting: ["stageResults.controlPlane", "modelCalls expected/actual evidence"],
    source: input.source ?? "trusted-entry",
  });
  return {
    packet,
    policy,
    executionLocks: {
      generation: { ...(input.executionGenerationLock ?? input.generationLock) },
      judge: { ...(input.executionJudgeLock ?? input.judgeLock) },
    },
    modelTransport: input.modelTransport,
    enforceModelLocks: input.enforceModelLocks ?? true,
  };
}

export function validateModelLock(expected: ModelLock, actual: ModelLock): string[] {
  const errors: string[] = [];
  if (expected.route !== actual.route) errors.push(`route expected=${expected.route} actual=${actual.route}`);
  if (expected.provider !== actual.provider) errors.push(`provider expected=${expected.provider} actual=${actual.provider}`);
  if (expected.model !== actual.model) errors.push(`model expected=${expected.model} actual=${actual.model}`);
  return errors;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// 再导出控制协议类型，便于单点 import
export type {
  ActorType,
  AutonomyLevel,
  ControlDecisionRecord,
} from "./control-types.js";
export {
  AUTONOMY_LEVEL_RANK,
  MODEL_FORBIDDEN_ACTIONS,
  MODEL_MAX_AUTONOMY_LEVEL,
} from "./control-types.js";
