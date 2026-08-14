/**
 * ReleaseLifecyclePermissions — 发布生命周期与权限收敛纯函数（DG-5，数据版本与发布治理 §5）
 *
 * 真相源：docs/data-version-release-governance-development-plan-20260813.md §5 DG-5
 *
 * 目标：把候选、冻结、评测、审批、canary、active 与退役的权限写成强约束。
 *
 * 本模块是「权限决策层」的纯函数固化（无 fs / 无模型 / 无副作用），供：
 * - 生产入口（production-release-gate）
 * - evolution-release-registry.transitionStatus（状态推进时校验）
 * - release-pointer-store.switchActive（pointer 切换时校验）
 * - canary 执行层
 * 在运行时接入（DG-6 / DG-7 完成单一基线迁移与演练时显式绑定）。
 *
 * 已由既有运行时强制、本模块仅固化为可测规则的约束（不重复实现）：
 * - 状态机迁移（isStatusTransitionValid）→ evolution-release-schema.ts
 * - frozen 不可变（assertFrozenImmutable）→ evolution-release-schema.ts
 * - production pointer 仅 user 可切换 + manifest 就绪校验 → release-pointer-store.ts
 * - 越权 canary 阻断（workspace 授权 + 时限 + 退出条件 + auto-hold）→ canary-*.ts
 * - 单次用户反馈不得切换生产基线 → strategy-promotion-governance.ts
 *   （singleFeedbackCanSwitchProductionBaseline）
 *
 * 本模块新增固化的缺口约束：
 * 1. 每个状态的可写字段矩阵（frozen 后行为字段锁定；终态不可原地写）
 * 2. 变更风险分级门禁（R2/R3 要求完整 Eval + Replay + 人工批准）
 * 3. active_prod 单例约束（同一时刻只能有一个 active_prod manifest）
 * 4. 代理仅能产生准入建议，不得自行切换 pointer / 晋级生产
 *
 * 边界（READY_LOCAL）：
 * - 纯函数，仅 type-only 依赖 evolution-release-types.js
 * - 不调用模型、不写文件、不依赖 eval 模块，可被任意闭包消费
 */

import type {
  ChangeClass,
  EvolutionReleaseManifest,
  ReleaseStatus,
} from "./evolution-release-types.js";

// ============================================================================
// 1. 每个状态的可写字段矩阵
// ============================================================================

/** 生命周期字段：合法状态推进中唯一允许原地变更的字段。 */
export const LIFECYCLE_FIELDS: readonly string[] = [
  "status",
  "approvalRef",
  "activatedAt",
];

/** 行为字段：frozen 后锁定，任何变更必须新建 releaseId。 */
export const BEHAVIOR_FIELDS: readonly string[] = [
  "schemaId",
  "schemaVersion",
  "releaseId",
  "parentReleaseId",
  "rollbackReleaseId",
  "supersedesRef",
  "changeClass",
  "claims",
  "environmentFingerprint",
  "artifactRefs",
  "createdAt",
  "bundleId",
  "modelVersion",
  "promptBundleHash",
  "modelRoutingHash",
  "toolSchemaHash",
  "contextCompilerHash",
  "qualityPolicyHash",
  "recoveryPolicyHash",
  "knowledgeSnapshotHash",
  "runtimeFingerprint",
  "strategyEvidencePartition",
  "evalProtocolVersion",
];

/**
 * 返回某状态下允许原地写入的 manifest 字段集合。
 *
 * 规则：
 * - draft / candidate：所有字段可写（freeze 前草拟与冻结）。
 * - frozen / evaluated / approved_dev / active_dev / candidate_prod：
 *   仅生命周期字段可写（状态推进 / 审批引用 / 激活时间）。
 * - active_prod / held：仅生命周期字段可写（held 仅可迁往 rejected/retired，
 *   旧 release 仅审计读取，恢复需新 releaseId 重新审批）。
 * - rejected / quarantined / revoked / retired（终态）：不可原地写任何字段，需新 releaseId。
 */
export function getWritableFields(status: ReleaseStatus): string[] {
  switch (status) {
    case "draft":
    case "candidate":
      return [...LIFECYCLE_FIELDS, ...BEHAVIOR_FIELDS];
    case "frozen":
    case "evaluated":
    case "approved_dev":
    case "active_dev":
    case "candidate_prod":
    case "active_prod":
    case "held":
      return [...LIFECYCLE_FIELDS];
    case "rejected":
    case "quarantined":
    case "revoked":
    case "retired":
      return [];
  }
}

export interface FieldWriteCheckResult {
  ok: boolean;
  status: ReleaseStatus;
  /** 被状态拒绝写入的字段（不在可写集合内） */
  blockedFields: string[];
}

/**
 * 校验给定状态是否允许写入指定字段。
 * @param status 当前 manifest 状态
 * @param fieldsBeingWritten 本次拟写入（变更）的字段名列表
 */
export function assertFieldsWritable(
  status: ReleaseStatus,
  fieldsBeingWritten: string[],
): FieldWriteCheckResult {
  const writable = new Set(getWritableFields(status));
  const blockedFields = fieldsBeingWritten.filter((f) => !writable.has(f));
  return { ok: blockedFields.length === 0, status, blockedFields };
}

// ============================================================================
// 2. 变更风险分级门禁（R2/R3 要求完整 Eval + Replay + 人工批准）
// ============================================================================

/** 生产晋级目标状态（candidate_prod / active_prod）。 */
export type ProductionPromotionStatus = "candidate_prod" | "active_prod";

export interface PromotionPermissionInput {
  changeClass: ChangeClass;
  /** 触发者（user / system / gpt5.6-sol-proxy / evaluation） */
  actor: string;
  /** 目标生产晋级状态 */
  targetStatus: ProductionPromotionStatus;
  /** 是否已提供完整 Eval 报告（R2/R3 必需） */
  hasEvalReport: boolean;
  /** 是否已提供完整 Replay 报告（R2/R3 必需） */
  hasReplayReport: boolean;
  /** 是否已完成人工（用户）批准（R2/R3 必需；active_prod 一律必需） */
  hasHumanApproval: boolean;
  /** 审批 artifact 引用（生产晋级一律必需非空） */
  approvalRef: string | null;
}

export interface PromotionPermissionResult {
  ok: boolean;
  /** 缺失的证据项（ok=false 时非空） */
  missingEvidence: string[];
  reason: string;
}

/**
 * 评估生产晋级权限（变更风险分级门禁）。
 *
 * 规则（DG-5 §5）：
 * - 生产晋级（candidate_prod / active_prod）必须由 user 触发。
 * - 必须绑定非空 approvalRef（代理审批 / 用户授权）。
 * - R2/R3 变更额外要求完整 Eval 报告 + Replay 报告 + 人工批准。
 * - R0/R1 低风险变更仅需审批绑定（approvalRef + user），无需额外 Eval/Replay。
 */
export function evaluatePromotionPermission(
  input: PromotionPermissionInput,
): PromotionPermissionResult {
  const missing: string[] = [];
  const { changeClass, actor, targetStatus, approvalRef } = input;

  // 生产晋级一律：user 触发
  if (actor !== "user") {
    missing.push("actor=user");
  }
  // 生产晋级一律：审批引用非空
  if (approvalRef === null || approvalRef.length === 0) {
    missing.push("approvalRef");
  }

  // 变更风险分级：R2/R3 额外要求完整 Eval + Replay + 人工批准
  if (changeClass === "R2" || changeClass === "R3") {
    if (!input.hasEvalReport) missing.push("evalReport");
    if (!input.hasReplayReport) missing.push("replayReport");
    if (!input.hasHumanApproval) missing.push("humanApproval");
  } else if (targetStatus === "active_prod") {
    // R0/R1 晋级 active_prod 也要求人工批准（production 必须用户明确批准）
    if (!input.hasHumanApproval) missing.push("humanApproval");
  }

  const ok = missing.length === 0;
  const reason = ok
    ? `晋级 ${targetStatus} 权限满足（changeClass=${changeClass}, actor=${actor}）`
    : `晋级 ${targetStatus} 权限不足（changeClass=${changeClass}）：缺失 ${missing.join(", ")}`;
  return { ok, missingEvidence: missing, reason };
}

// ============================================================================
// 3. active_prod 单例约束
// ============================================================================

export interface ActiveProdSingletonResult {
  ok: boolean;
  /** 与目标 releaseId 冲突的既有 active_prod 清单（ok=false 时非空） */
  conflictingReleaseIds: string[];
}

/**
 * 校验 active_prod 单例：同一时刻只能有一个 active_prod manifest。
 *
 * 若除 targetReleaseId 外还有其他 manifest 处于 active_prod，返回 ok=false，
 * 阻止第二个 active_prod 产生（「双 active 直接失败」）。
 * 同一 releaseId 的 reaffirm（已 active_prod 再次确认）不视为冲突。
 */
export function assertActiveProdSingleton(
  manifests: ReadonlyArray<Pick<EvolutionReleaseManifest, "releaseId" | "status">>,
  targetReleaseId: string,
): ActiveProdSingletonResult {
  const conflictingReleaseIds = manifests
    .filter((m) => m.status === "active_prod" && m.releaseId !== targetReleaseId)
    .map((m) => m.releaseId);
  return { ok: conflictingReleaseIds.length === 0, conflictingReleaseIds };
}

// ============================================================================
// 4. 代理仅能产生准入建议
// ============================================================================

/** 发布相关动作。 */
export type ReleaseAction = "recommend" | "switch_pointer" | "promote_production";

/** 代理角色标识（与 ReleaseStateEvent.actor 对齐）。 */
export const PROXY_ACTOR = "gpt5.6-sol-proxy" as const;

export interface ProxyPermissionResult {
  ok: boolean;
  reason: string;
}

/**
 * 校验代理权限：gpt5.6-sol-proxy 只能产生准入建议（recommend），
 * 不得自行切换 production pointer 或晋级生产（switch_pointer / promote_production）。
 *
 * 代理的准入建议最终由用户（actor=user）授权后才生效。
 * 非代理角色（user / system / evaluation）不受本函数限制（production 越权
 * 由 release-pointer-store / transitionStatus 的角色守护另行把关）。
 */
export function evaluateProxyPermission(
  actor: string,
  action: ReleaseAction,
): ProxyPermissionResult {
  if (actor === PROXY_ACTOR) {
    if (action === "recommend") {
      return { ok: true, reason: "代理准入建议（需用户授权后才可晋级）" };
    }
    return {
      ok: false,
      reason:
        `gpt5.6-sol-proxy 只能产生准入建议（recommend），` +
        `不得自行 ${action === "switch_pointer" ? "切换 production pointer" : "晋级生产"}`,
    };
  }
  return { ok: true, reason: "" };
}
