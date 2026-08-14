/**
 * EvolutionReleaseSchema — Manifest 校验、状态机、frozen 不可变、链校验、hash（EVOLUTION-RELEASE-GOVERNANCE-1A）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §3-§4
 *
 * 纯函数模块，无 fs 依赖。提供：
 * - validateManifest：schema 校验
 * - isStatusTransitionValid / getValidTransitions：状态机
 * - assertFrozenImmutable：frozen manifest 不可原地修改
 * - validateManifestChain：parent / supersedes / rollback 链校验
 * - computeManifestHash：manifest 全字段规范化 hash（用于 manifest 完整性校验、frozen immutability 比对）
 * - computeReleasePayloadHash：排除生命周期字段（status/approvalRef/activatedAt）的 payload hash
 *   （用于审批 artifact 双向绑定，保证状态迁移中 hash 稳定）
 *
 * 设计原则：
 * - 所有校验为纯函数，无副作用
 * - 未知 schema / 损坏输入必须返回结构化错误，不静默通过
 * - frozen 不可变只检查 releaseId 相同时其他字段是否变更
 *
 * 边界（READY_LOCAL）：
 * - 不调用模型、不写文件、不依赖 eval 模块
 */

import { createHash } from "node:crypto";
import {
  EVOLUTION_RELEASE_SCHEMA_ID,
  EVOLUTION_RELEASE_SCHEMA_VERSION,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
} from "./evolution-release-types.js";
// 重新导出 schema 常量，供测试与审批 artifact 直接从 schema 模块消费
// （避免每个消费者都从 types 模块分别 import，降低耦合）
export {
  EVOLUTION_RELEASE_SCHEMA_ID,
  EVOLUTION_RELEASE_SCHEMA_VERSION,
} from "./evolution-release-types.js";
import type {
  EvolutionReleaseManifest,
  ReleaseStatus,
  ChangeClass,
  ReleaseValidationError,
  ManifestChainValidationError,
  FrozenImmutableResult,
} from "./evolution-release-types.js";

// ============================================================================
// 常量
// ============================================================================

const VALID_STATUSES: ReadonlySet<ReleaseStatus> = new Set<ReleaseStatus>([
  "draft",
  "candidate",
  "frozen",
  "evaluated",
  "approved_dev",
  "active_dev",
  "candidate_prod",
  "active_prod",
  "held",
  "rejected",
  "quarantined",
  "revoked",
  "retired",
]);

const VALID_CHANGE_CLASSES: ReadonlySet<ChangeClass> = new Set<ChangeClass>([
  "R0",
  "R1",
  "R2",
  "R3",
]);

/**
 * 合法状态迁移表（from -> 允许的 to 集合）。
 * 依据计划 §4 状态机：
 *   draft -> candidate
 *   candidate -> frozen
 *   frozen -> evaluated
 *   evaluated -> approved_dev | held | rejected | quarantined
 *   approved_dev -> active_dev
 *   active_dev -> candidate_prod | held | revoked | retired
 *   candidate_prod -> active_prod | held | rejected
 *   active_prod -> held | revoked | retired
 *   held -> active_dev | active_prod（恢复 active 必须重新审批；由审批 artifact 守护，
 *     状态机层允许迁移，但 approved_dev → active_dev 才是正常路径，held → active 需新审批）
 */
const TRANSITIONS: Record<ReleaseStatus, ReleaseStatus[]> = {
  draft: ["candidate"],
  candidate: ["frozen"],
  frozen: ["evaluated"],
  evaluated: ["approved_dev", "held", "rejected", "quarantined"],
  approved_dev: ["active_dev"],
  active_dev: ["candidate_prod", "held", "revoked", "retired"],
  candidate_prod: ["active_prod", "held", "rejected"],
  active_prod: ["held", "revoked", "retired"],
  // 终态：不可直接迁回 active；需新 releaseId 重新审批
  held: ["active_dev", "active_prod", "rejected", "retired"],
  rejected: [],
  quarantined: [],
  revoked: [],
  retired: [],
};

// ============================================================================
// 校验：validateManifest
// ============================================================================

export type ManifestValidationResult =
  | { ok: true; manifest: EvolutionReleaseManifest }
  | { ok: false; error: ReleaseValidationError };

/**
 * 校验 manifest 是否符合 schema。
 * 未知 schemaId / 版本不匹配 / 缺字段 / 非法枚举 / 空必填字段一律拒绝。
 */
export function validateManifest(input: unknown): ManifestValidationResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      error: {
        code: "not_object",
        path: "$",
        message: "manifest 必须是对象",
      },
    };
  }

  const obj = input as Record<string, unknown>;

  // schemaId
  if (obj.schemaId !== EVOLUTION_RELEASE_SCHEMA_ID) {
    return {
      ok: false,
      error: {
        code: "unknown_schema",
        path: "$.schemaId",
        message: `schemaId 必须为 "${EVOLUTION_RELEASE_SCHEMA_ID}"，实际为 ${JSON.stringify(obj.schemaId)}`,
      },
    };
  }

  // schemaVersion
  if (obj.schemaVersion !== EVOLUTION_RELEASE_SCHEMA_VERSION) {
    return {
      ok: false,
      error: {
        code: "schema_version_mismatch",
        path: "$.schemaVersion",
        message: `schemaVersion 必须为 ${EVOLUTION_RELEASE_SCHEMA_VERSION}，实际为 ${JSON.stringify(obj.schemaVersion)}`,
      },
    };
  }

  // 必填字符串字段
  const requiredStrings: Array<keyof EvolutionReleaseManifest> = [
    "releaseId",
    "status",
    "rollbackReleaseId",
    "changeClass",
    "environmentFingerprint",
    "createdAt",
  ];
  for (const field of requiredStrings) {
    const v = obj[field as string];
    if (v === undefined || v === null) {
      return {
        ok: false,
        error: {
          code: "missing_field",
          path: `$.${field}`,
          message: `缺少必填字段 ${field}`,
        },
      };
    }
    if (typeof v !== "string") {
      return {
        ok: false,
        error: {
          code: "invalid_field_value",
          path: `$.${field}`,
          message: `字段 ${field} 必须为字符串`,
        },
      };
    }
  }

  // releaseId 非空
  if ((obj.releaseId as string).length === 0) {
    return {
      ok: false,
      error: {
        code: "empty_field",
        path: "$.releaseId",
        message: "releaseId 不能为空",
      },
    };
  }

  // environmentFingerprint 非空
  if ((obj.environmentFingerprint as string).length === 0) {
    return {
      ok: false,
      error: {
        code: "empty_field",
        path: "$.environmentFingerprint",
        message: "environmentFingerprint 不能为空",
      },
    };
  }

  // status 枚举
  if (!VALID_STATUSES.has(obj.status as ReleaseStatus)) {
    return {
      ok: false,
      error: {
        code: "invalid_status",
        path: "$.status",
        message: `status 值非法：${JSON.stringify(obj.status)}`,
      },
    };
  }

  // changeClass 枚举
  if (!VALID_CHANGE_CLASSES.has(obj.changeClass as ChangeClass)) {
    return {
      ok: false,
      error: {
        code: "invalid_change_class",
        path: "$.changeClass",
        message: `changeClass 值非法：${JSON.stringify(obj.changeClass)}（合法：R0/R1/R2/R3）`,
      },
    };
  }

  // claims 必须为字符串数组
  if (!Array.isArray(obj.claims) || !obj.claims.every((c) => typeof c === "string")) {
    return {
      ok: false,
      error: {
        code: "invalid_field_value",
        path: "$.claims",
        message: "claims 必须为字符串数组",
      },
    };
  }

  // artifactRefs 必须为字符串数组
  if (!Array.isArray(obj.artifactRefs) || !obj.artifactRefs.every((c) => typeof c === "string")) {
    return {
      ok: false,
      error: {
        code: "invalid_field_value",
        path: "$.artifactRefs",
        message: "artifactRefs 必须为字符串数组",
      },
    };
  }

  // parentReleaseId: string | null
  if (obj.parentReleaseId !== null && typeof obj.parentReleaseId !== "string") {
    return {
      ok: false,
      error: {
        code: "invalid_field_value",
        path: "$.parentReleaseId",
        message: "parentReleaseId 必须为 string 或 null",
      },
    };
  }

  // supersedesRef: string | null
  if (obj.supersedesRef !== null && typeof obj.supersedesRef !== "string") {
    return {
      ok: false,
      error: {
        code: "invalid_field_value",
        path: "$.supersedesRef",
        message: "supersedesRef 必须为 string 或 null",
      },
    };
  }

  // approvalRef: string | null
  if (obj.approvalRef !== null && typeof obj.approvalRef !== "string") {
    return {
      ok: false,
      error: {
        code: "invalid_field_value",
        path: "$.approvalRef",
        message: "approvalRef 必须为 string 或 null",
      },
    };
  }

  // activatedAt: string | null
  if (obj.activatedAt !== null && typeof obj.activatedAt !== "string") {
    return {
      ok: false,
      error: {
        code: "invalid_field_value",
        path: "$.activatedAt",
        message: "activatedAt 必须为 string 或 null",
      },
    };
  }

  // ==========================================================================
  // 行为身份可选字段（DG-1，计划 §4）：存在则类型校验。
  // 这些字段在 schema v1 为可选（旧 manifest 未捕获完整行为身份仍可加载），
  // 但一旦出现必须是合法类型，防止损坏 artifact 静默通过。
  // ==========================================================================
  const optionalStringFields: Array<keyof EvolutionReleaseManifest> = [
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
    "evalProtocolVersion",
  ];
  for (const field of optionalStringFields) {
    const v = obj[field as string];
    if (v === undefined) {
      continue;
    }
    if (typeof v !== "string" || v.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalid_field_value",
          path: `$.${field}`,
          message: `字段 ${field} 若存在必须为非空字符串`,
        },
      };
    }
  }

  // strategyEvidencePartition：存在则必须为数组，且每项含四个非空字符串键
  if (obj.strategyEvidencePartition !== undefined) {
    if (!Array.isArray(obj.strategyEvidencePartition)) {
      return {
        ok: false,
        error: {
          code: "invalid_field_value",
          path: "$.strategyEvidencePartition",
          message: "strategyEvidencePartition 若存在必须为数组",
        },
      };
    }
    for (let i = 0; i < (obj.strategyEvidencePartition as unknown[]).length; i++) {
      const p = (obj.strategyEvidencePartition as unknown[])[i] as Record<string, unknown>;
      if (p === null || typeof p !== "object" || Array.isArray(p)) {
        return {
          ok: false,
          error: {
            code: "invalid_field_value",
            path: `$.strategyEvidencePartition[${i}]`,
            message: "strategyEvidencePartition 项必须为对象",
          },
        };
      }
      for (const key of ["modelVersion", "bundleId", "strategyId", "evalProtocolVersion"]) {
        const pv = p[key];
        if (typeof pv !== "string" || pv.length === 0) {
          return {
            ok: false,
            error: {
              code: "invalid_field_value",
              path: `$.strategyEvidencePartition[${i}].${key}`,
              message: `strategyEvidencePartition[${i}].${key} 必须为非空字符串`,
            },
          };
        }
      }
    }
  }

  return { ok: true, manifest: obj as unknown as EvolutionReleaseManifest };
}

// ============================================================================
// 状态机
// ============================================================================

/**
 * 判断状态迁移是否合法。
 * @param from 起始状态；null 表示初始创建（只允许 → draft）
 * @param to 目标状态
 */
export function isStatusTransitionValid(
  from: ReleaseStatus | null,
  to: ReleaseStatus,
): boolean {
  if (from === null) {
    // 初始创建只允许 draft
    return to === "draft";
  }
  // 终态不可迁移（held 除外，held 允许重新进入 active 经审批）
  if (TERMINAL_STATUSES.has(from)) {
    return false;
  }
  const allowed = TRANSITIONS[from] || [];
  return allowed.includes(to);
}

/** 获取某状态的合法后继状态列表。 */
export function getValidTransitions(from: ReleaseStatus | null): ReleaseStatus[] {
  if (from === null) {
    return ["draft"];
  }
  return TRANSITIONS[from] || [];
}

// ============================================================================
// Frozen 不可变
// ============================================================================

/**
 * frozen manifest 不可原地修改。
 * 检查规则：
 * - 若 before.status === "frozen" 且 after.releaseId === before.releaseId（同 releaseId），
 *   则除 releaseId 外所有字段必须相同；否则返回 changedFields。
 * - 若 releaseId 不同，视为新版本，不算 frozen 违规（返回 ok=true）。
 * - 若 before.status !== "frozen"（如 draft/candidate），不触发 frozen 检查，返回 ok=true。
 *
 * 注意：状态机迁移（如 candidate→frozen）由调用方在 writeManifest 时单独放行；
 * 本函数只检查 frozen 后是否被原地篡改。
 */
export function assertFrozenImmutable(
  before: EvolutionReleaseManifest,
  after: EvolutionReleaseManifest,
): FrozenImmutableResult {
  // 非 frozen 状态不检查
  if (before.status !== "frozen") {
    return { ok: true, changedFields: [] };
  }
  // releaseId 不同 → 新版本，不算 frozen 违规
  if (before.releaseId !== after.releaseId) {
    return { ok: true, changedFields: [] };
  }
  // 同 releaseId + frozen → 检查所有字段
  const fieldsToCheck: Array<keyof EvolutionReleaseManifest> = [
    "schemaId",
    "schemaVersion",
    "status",
    "parentReleaseId",
    "rollbackReleaseId",
    "supersedesRef",
    "changeClass",
    "claims",
    "environmentFingerprint",
    "artifactRefs",
    "approvalRef",
    "createdAt",
    "activatedAt",
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
  const changedFields: string[] = [];
  for (const field of fieldsToCheck) {
    if (!deepEqual(before[field], after[field])) {
      changedFields.push(field as string);
    }
  }
  return { ok: changedFields.length === 0, changedFields };
}

/** 深比较（处理数组与原始值）。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a === null || b === null) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return a === b;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

// ============================================================================
// 链校验：parent / supersedes / rollback
// ============================================================================

export interface ManifestChainValidationInput {
  /** parentReleaseId 指向的 manifest；parentReleaseId 为 null 时传 null */
  parent: EvolutionReleaseManifest | null;
  /** rollbackReleaseId 指向的 manifest */
  rollback: EvolutionReleaseManifest | null;
  /** supersedesRef 指向的 manifest；supersedesRef 为 null 时传 null（可选） */
  superseded?: EvolutionReleaseManifest | null;
}

export interface ManifestChainValidationResult {
  ok: boolean;
  errors: ManifestChainValidationError[];
}

/**
 * 校验 manifest 的 parent / supersedes / rollback 链。
 * - parentReleaseId 非空时，parent 必须存在
 * - rollbackReleaseId 必须非空且 rollback 必须存在
 * - supersedesRef 非空时，superseded 必须存在
 */
export function validateManifestChain(
  manifest: EvolutionReleaseManifest,
  refs: ManifestChainValidationInput,
): ManifestChainValidationResult {
  const errors: ManifestChainValidationError[] = [];

  // rollback 必须非空且存在
  if (!manifest.rollbackReleaseId || manifest.rollbackReleaseId.length === 0) {
    errors.push({
      message: "rollbackReleaseId 不能为空（freeze 前必须指定回滚目标）",
      field: "rollbackReleaseId",
    });
  } else if (refs.rollback === null) {
    errors.push({
      message: `rollbackReleaseId "${manifest.rollbackReleaseId}" 指向的 manifest 不存在`,
      field: "rollbackReleaseId",
    });
  } else if (refs.rollback.releaseId !== manifest.rollbackReleaseId) {
    errors.push({
      message: `rollback manifest releaseId 不匹配：期望 ${manifest.rollbackReleaseId}，实际 ${refs.rollback.releaseId}`,
      field: "rollbackReleaseId",
    });
  }

  // parent 非空时必须存在
  if (manifest.parentReleaseId !== null) {
    if (refs.parent === null) {
      errors.push({
        message: `parentReleaseId "${manifest.parentReleaseId}" 指向的 manifest 不存在`,
        field: "parentReleaseId",
      });
    } else if (refs.parent.releaseId !== manifest.parentReleaseId) {
      errors.push({
        message: `parent manifest releaseId 不匹配：期望 ${manifest.parentReleaseId}，实际 ${refs.parent.releaseId}`,
        field: "parentReleaseId",
      });
    }
  }

  // supersedes 非空时必须存在
  if (manifest.supersedesRef !== null && manifest.supersedesRef.length > 0) {
    const superseded = refs.superseded ?? null;
    if (superseded === null) {
      errors.push({
        message: `supersedesRef "${manifest.supersedesRef}" 指向的 manifest 不存在`,
        field: "supersedesRef",
      });
    } else if (superseded.releaseId !== manifest.supersedesRef) {
      errors.push({
        message: `superseded manifest releaseId 不匹配：期望 ${manifest.supersedesRef}，实际 ${superseded.releaseId}`,
        field: "supersedesRef",
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

// ============================================================================
// Manifest hash（用于审批 artifact 双向绑定）
// ============================================================================

/**
 * 计算 manifest 的规范化 SHA-256 hash（全字段，含生命周期字段）。
 * 用于 manifest 完整性校验、frozen immutability 比对等场景。
 *
 * 注意：此 hash 包含 status / approvalRef / activatedAt 生命周期字段，
 * 状态迁移会改变 hash。**不得**用于审批 artifact 双向绑定（用 computeReleasePayloadHash）。
 *
 * 规范化：按字段名排序后 JSON 序列化，保证字段顺序不影响 hash。
 */
export function computeManifestHash(manifest: EvolutionReleaseManifest): string {
  const canonical = canonicalize(manifest);
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

/**
 * 生命周期字段集合：这些字段在合法状态迁移中会改变（status / approvalRef / activatedAt），
 * 不属于 release payload 不可变内容。审批 artifact 不得绑定这些字段。
 */
const LIFECYCLE_FIELDS: ReadonlySet<string> = new Set<string>([
  "status",
  "approvalRef",
  "activatedAt",
]);

/**
 * 计算 release payload 的规范化 SHA-256 hash（排除生命周期字段）。
 *
 * 用于审批 artifact 与 manifest 双向绑定（计划 §6.4 / §11 / Phase G4 / G6）。
 *
 * 设计理由（P0 生命周期 hash 绑定修复）：
 * - computeManifestHash 对全字段计算 hash，含 status / approvalRef / activatedAt。
 * - 状态迁移 evaluated → approved_dev → ... → active_prod 必然改变这些生命周期字段，
 *   导致在 evaluated 状态生成的 artifact hash 与 active_prod 状态的 manifest hash 永远不一致。
 * - 真实审批版本无法通过 G6（合法审批链被错误阻断）。
 *
 * 修复：审批 artifact 绑定不可变 release payload（排除生命周期字段），而非可变生命周期状态。
 * 这样 evaluated 状态生成的 artifact hash 在后续所有状态迁移中保持稳定，G6 可正确验证绑定。
 *
 * 排除字段：status / approvalRef / activatedAt
 * 保留字段：schemaId / schemaVersion / releaseId / parentReleaseId / rollbackReleaseId /
 *           supersedesRef / changeClass / claims / environmentFingerprint / artifactRefs / createdAt
 */
export function computeReleasePayloadHash(manifest: EvolutionReleaseManifest): string {
  const full = manifest as unknown as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  for (const key of Object.keys(full)) {
    if (!LIFECYCLE_FIELDS.has(key)) {
      payload[key] = full[key];
    }
  }
  const canonical = canonicalize(payload);
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

/** 递归规范化对象：按 key 排序。 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

// ============================================================================
// 辅助：状态集合查询
// ============================================================================

export function isTerminalStatus(status: ReleaseStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isActiveStatus(status: ReleaseStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}
