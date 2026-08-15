/**
 * AGENT-WORK-PACKAGE — 代理调用不可变工作包（MA-1.1）
 *
 * 每次代理调用必须携带：身份、目标、输入白名单、资源/动作边界、
 * 模型锁、预算、输出 schema 与上下文哈希。缺失或越界 fail-closed。
 *
 * 与 NovelTaskPacket 的关系：
 * - NovelTaskPacket = 任务级控制面
 * - AgentWorkPackage = 单次代理调用级边界（挂在 task/run 下）
 */

import { createHash, randomBytes } from "node:crypto";
import type { ActionName, AutonomyLevel } from "./control-types.js";
import type { ModelLock } from "./control-plane.js";
import {
  getAgentRoleProfile,
  isAgentRole,
  roleAllowsAction,
  type AgentRole,
} from "./agent-roles.js";

export const AGENT_WORK_PACKAGE_SCHEMA = "pinovel.agent-work-package" as const;
export const AGENT_WORK_PACKAGE_VERSION = "1.0.0" as const;

export interface AgentBudget {
  maxModelCalls?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface AgentWorkPackage {
  schema: typeof AGENT_WORK_PACKAGE_SCHEMA;
  version: typeof AGENT_WORK_PACKAGE_VERSION;
  /** 稳定内容哈希（不含 packageId 随机部分） */
  packageHash: string;
  packageId: string;
  taskId: string;
  orchestratorRunId: string;
  workspaceId: string;
  chapterId: string;
  agentRole: AgentRole;
  sessionId: string;
  parentCandidateId?: string;
  sourceCandidateId?: string;
  objective: string;
  stage: string;
  /** 允许注入代理的输入字段名 */
  inputFieldWhitelist: readonly string[];
  allowedResources: readonly string[];
  forbiddenResources: readonly string[];
  allowedActions: readonly ActionName[];
  forbiddenActions: readonly ActionName[];
  maxAutonomyLevel: AutonomyLevel;
  modelLock?: ModelLock;
  budget: AgentBudget;
  outputSchemaVersion: string;
  acceptance: readonly string[];
  contextHash: string;
  promptBundleHash?: string;
  constraintManifestHash?: string;
  strategyId?: string;
  strategyBundleId?: string;
  createdAt: string;
}

export interface CreateAgentWorkPackageInput {
  taskId: string;
  orchestratorRunId: string;
  workspaceId: string;
  chapterId: string;
  agentRole: AgentRole | string;
  sessionId: string;
  objective: string;
  stage: string;
  inputFieldWhitelist: readonly string[];
  allowedResources: readonly string[];
  forbiddenResources?: readonly string[];
  /** 覆盖角色默认 allowedActions；必须是角色 profile 子集 */
  allowedActions?: readonly ActionName[];
  forbiddenActions?: readonly ActionName[];
  maxAutonomyLevel?: AutonomyLevel;
  modelLock?: ModelLock;
  budget?: AgentBudget;
  outputSchemaVersion?: string;
  acceptance?: readonly string[];
  contextHash: string;
  promptBundleHash?: string;
  constraintManifestHash?: string;
  parentCandidateId?: string;
  sourceCandidateId?: string;
  strategyId?: string;
  strategyBundleId?: string;
  packageId?: string;
  createdAt?: string;
}

export interface AgentWorkPackageValidation {
  ok: boolean;
  errors: string[];
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload), "utf8").digest("hex");
}

function newPackageId(role: string): string {
  return `awp-${role}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/**
 * 创建不可变工作包。未知角色 / 空必填字段 / 动作越权 → 抛错（fail-closed）。
 */
export function createAgentWorkPackage(
  input: CreateAgentWorkPackageInput,
): AgentWorkPackage {
  if (!isAgentRole(input.agentRole)) {
    throw new AgentWorkPackageError(
      `未知代理角色：${input.agentRole}`,
      "unknown_role",
    );
  }
  const role = input.agentRole;
  const profile = getAgentRoleProfile(role);

  const allowedActions = Object.freeze(
    [...(input.allowedActions ?? profile.allowedActions)],
  ) as readonly ActionName[];
  const forbiddenActions = Object.freeze(
    [
      ...new Set([
        ...(input.forbiddenActions ?? []),
        ...profile.forbiddenActions,
      ]),
    ],
  ) as readonly ActionName[];

  for (const action of allowedActions) {
    if (forbiddenActions.includes(action) || !roleAllowsAction(role, action)) {
      throw new AgentWorkPackageError(
        `角色 ${role} 不允许动作 ${action}`,
        "action_not_allowed",
      );
    }
  }

  const required = [
    ["taskId", input.taskId],
    ["orchestratorRunId", input.orchestratorRunId],
    ["workspaceId", input.workspaceId],
    ["chapterId", input.chapterId],
    ["sessionId", input.sessionId],
    ["objective", input.objective],
    ["stage", input.stage],
    ["contextHash", input.contextHash],
  ] as const;
  for (const [name, value] of required) {
    if (typeof value !== "string" || !value.trim()) {
      throw new AgentWorkPackageError(`工作包缺少 ${name}`, "missing_field");
    }
  }
  if (!Array.isArray(input.inputFieldWhitelist) || input.inputFieldWhitelist.length === 0) {
    throw new AgentWorkPackageError(
      "inputFieldWhitelist 不能为空",
      "missing_field",
    );
  }
  if (!Array.isArray(input.allowedResources)) {
    throw new AgentWorkPackageError(
      "allowedResources 必须是数组",
      "missing_field",
    );
  }

  const maxAutonomyLevel = input.maxAutonomyLevel ?? profile.maxAutonomyLevel;
  const outputSchemaVersion = input.outputSchemaVersion ?? "pinovel.agent-result@1.0.0";
  const createdAt = input.createdAt ?? new Date().toISOString();
  const packageId = input.packageId ?? newPackageId(role);

  const canonical = {
    schema: AGENT_WORK_PACKAGE_SCHEMA,
    version: AGENT_WORK_PACKAGE_VERSION,
    taskId: input.taskId.trim(),
    orchestratorRunId: input.orchestratorRunId.trim(),
    workspaceId: input.workspaceId.trim(),
    chapterId: input.chapterId.trim(),
    agentRole: role,
    sessionId: input.sessionId.trim(),
    parentCandidateId: input.parentCandidateId,
    sourceCandidateId: input.sourceCandidateId,
    objective: input.objective.trim(),
    stage: input.stage.trim(),
    inputFieldWhitelist: [...input.inputFieldWhitelist],
    allowedResources: [...input.allowedResources],
    forbiddenResources: [...(input.forbiddenResources ?? [])],
    allowedActions: [...allowedActions],
    forbiddenActions: [...forbiddenActions],
    maxAutonomyLevel,
    modelLock: input.modelLock ? { ...input.modelLock } : undefined,
    budget: { ...(input.budget ?? {}) },
    outputSchemaVersion,
    acceptance: [
      ...(input.acceptance ??
        (profile.responsibility ? [profile.responsibility] : [])),
    ],
    contextHash: input.contextHash.trim(),
    promptBundleHash: input.promptBundleHash,
    constraintManifestHash: input.constraintManifestHash,
    strategyId: input.strategyId,
    strategyBundleId: input.strategyBundleId,
  };

  const packageHash = hashPayload(canonical);

  const pkg: AgentWorkPackage = Object.freeze({
    ...canonical,
    packageHash,
    packageId,
    createdAt,
    inputFieldWhitelist: Object.freeze([...canonical.inputFieldWhitelist]),
    allowedResources: Object.freeze([...canonical.allowedResources]),
    forbiddenResources: Object.freeze([...canonical.forbiddenResources]),
    allowedActions: Object.freeze([...canonical.allowedActions]) as readonly ActionName[],
    forbiddenActions: Object.freeze([...canonical.forbiddenActions]) as readonly ActionName[],
    acceptance: Object.freeze([...canonical.acceptance]),
    budget: Object.freeze({ ...canonical.budget }),
    modelLock: canonical.modelLock
      ? Object.freeze({ ...canonical.modelLock })
      : undefined,
  });

  const validation = validateAgentWorkPackage(pkg);
  if (!validation.ok) {
    throw new AgentWorkPackageError(
      `工作包校验失败：${validation.errors.join("; ")}`,
      "validation_failed",
    );
  }
  return pkg;
}

/** schema / 哈希 / 角色 / 资源边界校验 */
export function validateAgentWorkPackage(
  pkg: AgentWorkPackage | null | undefined,
): AgentWorkPackageValidation {
  const errors: string[] = [];
  if (!pkg || typeof pkg !== "object") {
    return { ok: false, errors: ["工作包为空"] };
  }
  if (pkg.schema !== AGENT_WORK_PACKAGE_SCHEMA) {
    errors.push(`schema 不匹配：${String(pkg.schema)}`);
  }
  if (pkg.version !== AGENT_WORK_PACKAGE_VERSION) {
    errors.push(`version 不匹配：${String(pkg.version)}`);
  }
  if (!isAgentRole(pkg.agentRole)) {
    errors.push(`未知角色：${String(pkg.agentRole)}`);
  } else {
    for (const action of pkg.allowedActions ?? []) {
      if (!roleAllowsAction(pkg.agentRole, action)) {
        errors.push(`角色不允许动作：${action}`);
      }
      if ((pkg.forbiddenActions ?? []).includes(action)) {
        errors.push(`动作同时在 forbidden：${action}`);
      }
    }
  }
  for (const field of [
    "taskId",
    "orchestratorRunId",
    "workspaceId",
    "chapterId",
    "sessionId",
    "objective",
    "stage",
    "contextHash",
    "packageHash",
    "packageId",
  ] as const) {
    if (typeof pkg[field] !== "string" || !String(pkg[field]).trim()) {
      errors.push(`缺少 ${field}`);
    }
  }
  if (!Array.isArray(pkg.inputFieldWhitelist) || pkg.inputFieldWhitelist.length === 0) {
    errors.push("inputFieldWhitelist 为空");
  }
  if (!Array.isArray(pkg.allowedResources)) {
    errors.push("allowedResources 无效");
  }
  // 哈希自检：重算 canonical 字段
  if (pkg.packageHash && typeof pkg.packageHash === "string") {
    const canonical = {
      schema: pkg.schema,
      version: pkg.version,
      taskId: pkg.taskId,
      orchestratorRunId: pkg.orchestratorRunId,
      workspaceId: pkg.workspaceId,
      chapterId: pkg.chapterId,
      agentRole: pkg.agentRole,
      sessionId: pkg.sessionId,
      parentCandidateId: pkg.parentCandidateId,
      sourceCandidateId: pkg.sourceCandidateId,
      objective: pkg.objective,
      stage: pkg.stage,
      inputFieldWhitelist: [...(pkg.inputFieldWhitelist ?? [])],
      allowedResources: [...(pkg.allowedResources ?? [])],
      forbiddenResources: [...(pkg.forbiddenResources ?? [])],
      allowedActions: [...(pkg.allowedActions ?? [])],
      forbiddenActions: [...(pkg.forbiddenActions ?? [])],
      maxAutonomyLevel: pkg.maxAutonomyLevel,
      modelLock: pkg.modelLock ? { ...pkg.modelLock } : undefined,
      budget: { ...(pkg.budget ?? {}) },
      outputSchemaVersion: pkg.outputSchemaVersion,
      acceptance: [...(pkg.acceptance ?? [])],
      contextHash: pkg.contextHash,
      promptBundleHash: pkg.promptBundleHash,
      constraintManifestHash: pkg.constraintManifestHash,
      strategyId: pkg.strategyId,
      strategyBundleId: pkg.strategyBundleId,
    };
    const expected = hashPayload(canonical);
    if (expected !== pkg.packageHash) {
      errors.push("packageHash 不匹配（工作包可能被篡改）");
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 资源路径是否在工作包允许范围内。
 * 规则：
 * - 路径规范化后不得匹配 forbiddenResources 前缀
 * - 若 allowedResources 非空，必须匹配其一（前缀或精确）
 * - 含 ".." 的相对穿越一律拒绝
 */
export function assertResourceInScope(
  pkg: AgentWorkPackage,
  resourcePath: string,
): void {
  const path = (resourcePath ?? "").replace(/\\/g, "/").trim();
  if (!path) {
    throw new AgentWorkPackageError("资源路径为空", "resource_out_of_scope");
  }
  if (path.includes("..") || path.includes("\0")) {
    throw new AgentWorkPackageError(
      `路径穿越拒绝：${path}`,
      "resource_out_of_scope",
    );
  }
  for (const forbidden of pkg.forbiddenResources) {
    const f = forbidden.replace(/\\/g, "/");
    if (path === f || path.startsWith(f.endsWith("/") ? f : `${f}/`) || path.startsWith(f)) {
      throw new AgentWorkPackageError(
        `资源在禁止列表：${path}`,
        "resource_forbidden",
      );
    }
  }
  if (pkg.allowedResources.length === 0) {
    // 显式空白名单 = 禁止一切资源访问（fail-closed）
    throw new AgentWorkPackageError(
      "allowedResources 为空，拒绝一切资源访问",
      "resource_out_of_scope",
    );
  }
  const allowed = pkg.allowedResources.some((entry) => {
    const a = entry.replace(/\\/g, "/");
    if (a === "*" || a === "**") return true;
    return path === a || path.startsWith(a.endsWith("/") ? a : `${a}/`) || path.startsWith(a);
  });
  if (!allowed) {
    throw new AgentWorkPackageError(
      `资源不在允许范围：${path}`,
      "resource_out_of_scope",
    );
  }
}

/** 动作是否被本工作包授权 */
export function assertActionAllowed(
  pkg: AgentWorkPackage,
  action: ActionName,
): void {
  if (pkg.forbiddenActions.includes(action)) {
    throw new AgentWorkPackageError(
      `动作被工作包禁止：${action}`,
      "action_forbidden",
    );
  }
  if (!pkg.allowedActions.includes(action)) {
    throw new AgentWorkPackageError(
      `动作不在工作包允许列表：${action}`,
      "action_not_allowed",
    );
  }
  if (!roleAllowsAction(pkg.agentRole, action)) {
    throw new AgentWorkPackageError(
      `角色 ${pkg.agentRole} 不允许动作 ${action}`,
      "action_not_allowed",
    );
  }
}

/** 输入对象是否只含白名单字段（额外字段 fail-closed） */
export function assertInputFieldsWhitelisted(
  pkg: AgentWorkPackage,
  input: Record<string, unknown>,
): void {
  const allowed = new Set(pkg.inputFieldWhitelist);
  const extras = Object.keys(input).filter((key) => !allowed.has(key));
  if (extras.length > 0) {
    throw new AgentWorkPackageError(
      `输入字段越权：${extras.join(", ")}`,
      "input_field_not_allowed",
    );
  }
}

export type AgentWorkPackageErrorCode =
  | "unknown_role"
  | "missing_field"
  | "action_not_allowed"
  | "action_forbidden"
  | "resource_out_of_scope"
  | "resource_forbidden"
  | "input_field_not_allowed"
  | "validation_failed";

export class AgentWorkPackageError extends Error {
  readonly code: AgentWorkPackageErrorCode;

  constructor(message: string, code: AgentWorkPackageErrorCode) {
    super(message);
    this.name = "AgentWorkPackageError";
    this.code = code;
  }
}

/** 可序列化摘要（写入 trace，不含原始 prompt） */
export function summarizeAgentWorkPackage(
  pkg: AgentWorkPackage,
): Record<string, unknown> {
  return {
    schema: pkg.schema,
    version: pkg.version,
    packageId: pkg.packageId,
    packageHash: pkg.packageHash,
    taskId: pkg.taskId,
    orchestratorRunId: pkg.orchestratorRunId,
    workspaceId: pkg.workspaceId,
    chapterId: pkg.chapterId,
    agentRole: pkg.agentRole,
    sessionId: pkg.sessionId,
    parentCandidateId: pkg.parentCandidateId ?? null,
    sourceCandidateId: pkg.sourceCandidateId ?? null,
    stage: pkg.stage,
    allowedActions: [...pkg.allowedActions],
    forbiddenActions: [...pkg.forbiddenActions],
    allowedResources: [...pkg.allowedResources],
    forbiddenResources: [...pkg.forbiddenResources],
    maxAutonomyLevel: pkg.maxAutonomyLevel,
    contextHash: pkg.contextHash,
    promptBundleHash: pkg.promptBundleHash ?? null,
    constraintManifestHash: pkg.constraintManifestHash ?? null,
    strategyId: pkg.strategyId ?? null,
    strategyBundleId: pkg.strategyBundleId ?? null,
    outputSchemaVersion: pkg.outputSchemaVersion,
    createdAt: pkg.createdAt,
  };
}
