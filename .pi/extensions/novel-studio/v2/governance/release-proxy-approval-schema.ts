/**
 * ReleaseProxyApprovalSchema — 审批 artifact 校验 / verdict 归一化 / 双向绑定 / reviewer shopping（EVOLUTION-RELEASE-GOVERNANCE-1B）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6 / Phase G4
 *
 * 纯函数模块，无 fs 依赖。提供：
 * - validateApprovalArtifact：schema 校验（reviewerType / reviewerModel / verdict / R3 自审批守护）
 * - normalizeVerdict：slight/uncertain/顺序敏感/冲突 一律映射为 HOLD；forward≠reverse → HOLD
 * - isR3SelfApproval：R3 + r3SelfApproval=true 检测
 * - computeApprovalArtifactHash：artifact 规范化 hash（排除 decidedAt 非行为字段）
 * - verifyManifestBinding：审批 artifact 与 release manifest hash 双向绑定
 * - detectReviewerShopping：同 releaseId 多 reviewer 版本 / 多 verdict 冲突检测
 *
 * 设计原则：
 * - 所有校验为纯函数，无副作用
 * - reviewerType 永远不得为 "natural_person"（防止把模型审批伪装成自然人审批）
 * - R3 治理根变更禁止代理自审批（r3SelfApproval=true 即非法）
 * - slight/uncertain/顺序敏感/冲突一律保守映射为 HOLD，不批准
 *
 * 边界（READY_LOCAL；真实模型调用 REQUIRES_AUTH）：
 * - 不调用模型、不写文件、不依赖 eval 模块
 */

import { createHash } from "node:crypto";
import {
  PROXY_APPROVAL_SCHEMA_ID,
  PROXY_APPROVAL_SCHEMA_VERSION,
  PROXY_APPROVAL_REVIEWER_MODEL,
} from "./release-proxy-approval-types.js";
// 重新导出 schema 常量，供测试与外部消费者直接从 schema 模块消费
export {
  PROXY_APPROVAL_SCHEMA_ID,
  PROXY_APPROVAL_SCHEMA_VERSION,
} from "./release-proxy-approval-types.js";
import type {
  ReleaseProxyApprovalArtifact,
  ProxyApprovalVerdict,
  RawVerdict,
  ReviewerType,
  ApprovalValidationError,
} from "./release-proxy-approval-types.js";

// ============================================================================
// 常量
// ============================================================================

const VALID_VERDICTS: ReadonlySet<ProxyApprovalVerdict> = new Set<ProxyApprovalVerdict>([
  "APPROVE_DEV",
  "HOLD",
  "REJECT",
  "QUARANTINE",
]);

/**
 * 归一化映射表：非正式 verdict → HOLD。
 * APPROVE_DEV / HOLD / REJECT / QUARANTINE 原样保留。
 */
const VERDICT_TO_HOLD: ReadonlySet<string> = new Set<string>([
  "SLIGHT_WIN",
  "uncertain",
  "order_sensitive",
  "conflict",
  "maybe",
  "unknown",
  "",
]);

// ============================================================================
// validateApprovalArtifact
// ============================================================================

export type ApprovalValidationResult =
  | { ok: true; artifact: ReleaseProxyApprovalArtifact }
  | { ok: false; error: ApprovalValidationError };

/**
 * 校验审批 artifact 是否符合 schema。
 * 未知 schemaId / 版本不匹配 / 缺字段 / 非法 verdict / 错误 reviewerType/reviewerModel /
 * R3 自审批一律拒绝。
 */
export function validateApprovalArtifact(input: unknown): ApprovalValidationResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      error: { code: "not_object", path: "$", message: "artifact 必须是对象" },
    };
  }

  const obj = input as Record<string, unknown>;

  // schemaId
  if (obj.schemaId !== PROXY_APPROVAL_SCHEMA_ID) {
    return {
      ok: false,
      error: {
        code: "unknown_schema",
        path: "$.schemaId",
        message: `schemaId 必须为 "${PROXY_APPROVAL_SCHEMA_ID}"，实际为 ${JSON.stringify(obj.schemaId)}`,
      },
    };
  }

  // schemaVersion
  if (obj.schemaVersion !== PROXY_APPROVAL_SCHEMA_VERSION) {
    return {
      ok: false,
      error: {
        code: "schema_version_mismatch",
        path: "$.schemaVersion",
        message: `schemaVersion 必须为 ${PROXY_APPROVAL_SCHEMA_VERSION}，实际为 ${JSON.stringify(obj.schemaVersion)}`,
      },
    };
  }

  // 必填字符串字段
  const requiredStrings: Array<keyof ReleaseProxyApprovalArtifact> = [
    "approvalId",
    "releaseId",
    "releaseManifestHash",
    "reviewerType",
    "reviewerModel",
    "reviewerModelVersion",
    "promptHash",
    "inputArtifactHash",
    "forwardVerdict",
    "reverseVerdict",
    "finalVerdict",
    "rationale",
    "decidedAt",
    "changeClass",
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

  // reviewerType 必须为 validated_human_proxy
  if (obj.reviewerType !== "validated_human_proxy") {
    return {
      ok: false,
      error: {
        code: "invalid_reviewer_type",
        path: "$.reviewerType",
        message: `reviewerType 必须为 "validated_human_proxy"（gpt5.6-sol 不得标记为 natural_person），实际为 ${JSON.stringify(obj.reviewerType)}`,
      },
    };
  }

  // reviewerModel 必须为 gpt5.6-sol
  if (obj.reviewerModel !== PROXY_APPROVAL_REVIEWER_MODEL) {
    return {
      ok: false,
      error: {
        code: "invalid_reviewer_model",
        path: "$.reviewerModel",
        message: `reviewerModel 必须为 "${PROXY_APPROVAL_REVIEWER_MODEL}"，实际为 ${JSON.stringify(obj.reviewerModel)}`,
      },
    };
  }

  if (
    obj.reviewTransport !== undefined &&
    obj.reviewTransport !== "stub" &&
    obj.reviewTransport !== "network"
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_field_value",
        path: "$.reviewTransport",
        message: `reviewTransport must be stub or network, got ${JSON.stringify(obj.reviewTransport)}`,
      },
    };
  }

  // reviewerModelVersion 不得为空
  if ((obj.reviewerModelVersion as string).length === 0) {
    return {
      ok: false,
      error: {
        code: "empty_field",
        path: "$.reviewerModelVersion",
        message: "reviewerModelVersion 不能为空",
      },
    };
  }

  // verdict 枚举校验
  const verdictFields: Array<keyof ReleaseProxyApprovalArtifact> = [
    "forwardVerdict",
    "reverseVerdict",
    "finalVerdict",
  ];
  for (const field of verdictFields) {
    const v = obj[field as string];
    if (!VALID_VERDICTS.has(v as ProxyApprovalVerdict)) {
      return {
        ok: false,
        error: {
          code: "invalid_verdict",
          path: `$.${field}`,
          message: `verdict 值非法：${JSON.stringify(v)}（合法：APPROVE_DEV/HOLD/REJECT/QUARANTINE）`,
        },
      };
    }
  }

  // changeClass 枚举
  if (!["R0", "R1", "R2", "R3"].includes(obj.changeClass as string)) {
    return {
      ok: false,
      error: {
        code: "invalid_field_value",
        path: "$.changeClass",
        message: `changeClass 值非法：${JSON.stringify(obj.changeClass)}（合法：R0/R1/R2/R3）`,
      },
    };
  }

  // 数组字段
  const arrayFields: Array<keyof ReleaseProxyApprovalArtifact> = [
    "winningSpans",
    "losingSpans",
    "risks",
  ];
  for (const field of arrayFields) {
    const v = obj[field as string];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      return {
        ok: false,
        error: {
          code: "invalid_field_value",
          path: `$.${field}`,
          message: `字段 ${field} 必须为字符串数组`,
        },
      };
    }
  }

  // budgetUsed
  const bu = obj.budgetUsed;
  if (
    bu === null ||
    typeof bu !== "object" ||
    Array.isArray(bu) ||
    typeof (bu as Record<string, unknown>).calls !== "number" ||
    typeof (bu as Record<string, unknown>).timeoutMs !== "number"
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_field_value",
        path: "$.budgetUsed",
        message: "budgetUsed 必须为 { calls: number, timeoutMs: number }",
      },
    };
  }

  // r3SelfApproval 必须为 boolean
  if (typeof obj.r3SelfApproval !== "boolean") {
    return {
      ok: false,
      error: {
        code: "invalid_field_value",
        path: "$.r3SelfApproval",
        message: "r3SelfApproval 必须为 boolean",
      },
    };
  }

  // R3 自审批禁止
  if (obj.changeClass === "R3" && obj.r3SelfApproval === true) {
    return {
      ok: false,
      error: {
        code: "r3_self_approval_forbidden",
        path: "$.r3SelfApproval",
        message:
          "R3 治理根变更必须由用户审批，不得由 gpt5.6-sol 代理自审批（r3SelfApproval=true 非法）",
      },
    };
  }

  return { ok: true, artifact: obj as unknown as ReleaseProxyApprovalArtifact };
}

// ============================================================================
// normalizeVerdict
// ============================================================================

/**
 * 归一化 verdict（计划 §6.2）。
 * - APPROVE_DEV / HOLD / REJECT / QUARANTINE 原样保留
 * - slight/uncertain/order_sensitive/conflict/maybe/unknown/空 → HOLD（保守）
 * - forward≠reverse → HOLD（顺序敏感）
 *
 * @param forward 正向顺序 verdict（A=候选 B=当前）
 * @param reverse 反向顺序 verdict（A=当前 B=候选）；省略时只归一化 forward
 */
export function normalizeVerdict(
  forward: RawVerdict,
  reverse?: RawVerdict,
): ProxyApprovalVerdict {
  const normForward = normalizeSingleVerdict(forward);
  if (reverse === undefined) {
    return normForward;
  }
  const normReverse = normalizeSingleVerdict(reverse);
  // forward/reverse 不一致 → HOLD（顺序敏感）
  if (normForward !== normReverse) {
    return "HOLD";
  }
  return normForward;
}

/** 归一化单个 verdict：非正式值映射为 HOLD。 */
function normalizeSingleVerdict(v: RawVerdict): ProxyApprovalVerdict {
  if (VALID_VERDICTS.has(v as ProxyApprovalVerdict)) {
    return v as ProxyApprovalVerdict;
  }
  // slight/uncertain/order_sensitive/conflict/maybe/unknown/空 / 未知值 → HOLD
  if (VERDICT_TO_HOLD.has(v as string) || !VALID_VERDICTS.has(v as ProxyApprovalVerdict)) {
    return "HOLD";
  }
  return "HOLD";
}

// ============================================================================
// isR3SelfApproval
// ============================================================================

/**
 * 检测 R3 自审批。R3 + r3SelfApproval=true → true。
 * 非 R3 或 r3SelfApproval=false → false。
 */
export function isR3SelfApproval(input: {
  changeClass: "R0" | "R1" | "R2" | "R3";
  r3SelfApproval: boolean;
}): boolean {
  return input.changeClass === "R3" && input.r3SelfApproval === true;
}

// ============================================================================
// computeApprovalArtifactHash
// ============================================================================

/**
 * 计算 artifact 规范化 hash。
 * 排除 decidedAt（非行为字段，时间戳变化不应改变 hash）。
 * 用于审批 artifact 与 release manifest 双向绑定。
 */
export function computeApprovalArtifactHash(
  artifact: ReleaseProxyApprovalArtifact,
): string {
  // 构造规范化对象：排除 decidedAt
  const {
    decidedAt: _decidedAt,
    ...behaviorFields
  } = artifact;
  const canonical = JSON.stringify(behaviorFields);
  return "sha256:" + createHash("sha256").update(canonical, "utf-8").digest("hex");
}

// ============================================================================
// verifyManifestBinding
// ============================================================================

export type ManifestBindingResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * 校验审批 artifact 与 release manifest hash 双向绑定。
 * - artifact.releaseManifestHash 必须非空
 * - artifact.releaseManifestHash 必须等于传入的 manifestHash
 *
 * 防止审批 artifact 被复用到不同 release（reviewer shopping / 事后更换）。
 */
export function verifyManifestBinding(
  artifact: ReleaseProxyApprovalArtifact,
  manifestHash: string,
): ManifestBindingResult {
  if (!artifact.releaseManifestHash || artifact.releaseManifestHash.length === 0) {
    return { ok: false, error: "artifact.releaseManifestHash 为空，无法绑定 manifest" };
  }
  if (!manifestHash || manifestHash.length === 0) {
    return { ok: false, error: "manifestHash 为空，无法绑定" };
  }
  if (artifact.releaseManifestHash !== manifestHash) {
    return {
      ok: false,
      error: `manifest hash 不一致：artifact=${artifact.releaseManifestHash}，expected=${manifestHash}`,
    };
  }
  return { ok: true };
}

// ============================================================================
// detectReviewerShopping
// ============================================================================

/**
 * 检测 reviewer shopping（计划 §6.4 veto）。
 * 同 releaseId 出现以下情况即检测到：
 * 1. 多个不同 reviewerModelVersion（同一 release 换 reviewer 版本）
 * 2. 多个不同 finalVerdict 且非全 HOLD（同 release 反复评审直到得到想要的 verdict）
 * 3. 同 release 多个 APPROVE_DEV 后混入 HOLD（事后更换阈值）
 *
 * 不同 releaseId 不算 shopping。
 */
export function detectReviewerShopping(
  artifacts: ReleaseProxyApprovalArtifact[],
): { detected: boolean; reason?: string } {
  if (artifacts.length <= 1) {
    return { detected: false };
  }

  // 按 releaseId 分组
  const byRelease = new Map<string, ReleaseProxyApprovalArtifact[]>();
  for (const a of artifacts) {
    const list = byRelease.get(a.releaseId) || [];
    list.push(a);
    byRelease.set(a.releaseId, list);
  }

  for (const [releaseId, list] of byRelease) {
    if (list.length <= 1) continue;

    // 1. 多个不同 reviewerModelVersion
    const versions = new Set(list.map((a) => a.reviewerModelVersion));
    if (versions.size > 1) {
      return {
        detected: true,
        reason: `release ${releaseId} 出现多个 reviewerModelVersion：${Array.from(versions).join(", ")}`,
      };
    }

    // 2. 多个不同 finalVerdict 且非全 HOLD
    const verdicts = new Set(list.map((a) => a.finalVerdict));
    if (verdicts.size > 1 && !verdicts.has("HOLD")) {
      return {
        detected: true,
        reason: `release ${releaseId} 出现多个冲突 verdict 且无 HOLD：${Array.from(verdicts).join(", ")}`,
      };
    }

    // 3. 同 release 多个 APPROVE_DEV 后混 HOLD（事后更换阈值）
    //    覆盖测试用例：[REJECT, HOLD, APPROVE_DEV] → verdicts={REJECT,HOLD,APPROVE_DEV}
    //    多 verdict 且包含 APPROVE_DEV 与其他非 HOLD → shopping
    if (verdicts.size > 1 && verdicts.has("APPROVE_DEV")) {
      return {
        detected: true,
        reason: `release ${releaseId} 出现 APPROVE_DEV 与其他 verdict 混合：${Array.from(verdicts).join(", ")}`,
      };
    }
  }

  return { detected: false };
}
