/**
 * ChapterProxyApprovalSchema — 章节代理审批 artifact 校验 / verdict 归一化 / hash（EVOLUTION-RELEASE-GOVERNANCE-G7）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 / §7 / Phase G7
 *
 * 纯函数模块，无 fs 依赖。提供：
 * - validateChapterApprovalArtifact：schema 校验（reviewerType / reviewerModel /
 *   forward-reverse 一致性 / 必填字段 / verdict 合法性）
 * - normalizeChapterVerdict：slight/uncertain/顺序敏感/冲突 一律映射为 HOLD_FOR_REGENERATION
 * - computeChapterApprovalArtifactHash：artifact 规范化 hash（排除 decidedAt 非行为字段）
 *
 * 与 ReleaseProxyApprovalSchema 的隔离原则：
 * - 不复用 release 级 schemaId / verdict 枚举 / 校验函数；
 * - 章节级 verdict 为 PROXY_APPROVED | HOLD_FOR_REGENERATION，不判定 release 晋级；
 * - forward≠reverse 时 finalStatus 必须为 HOLD_FOR_REGENERATION（顺序敏感保守）。
 *
 * 设计原则：
 * - 所有校验为纯函数，无副作用
 * - reviewerType 永远不得为 "natural_person"（防止把模型审批伪装成自然人审批）
 * - slight/uncertain/顺序敏感/冲突一律保守映射为 HOLD_FOR_REGENERATION，不输出 proxy_approved_draft
 *
 * 边界（READY_LOCAL；真实模型调用 REQUIRES_AUTH）：
 * - 不调用模型、不写文件、不依赖 eval 模块
 */

import { createHash } from "node:crypto";
import {
  CHAPTER_PROXY_APPROVAL_SCHEMA_ID,
  CHAPTER_PROXY_APPROVAL_SCHEMA_VERSION,
  CHAPTER_PROXY_APPROVAL_REVIEWER_MODEL,
} from "./chapter-proxy-approval-types.js";
// 重新导出 schema 常量，供测试与外部消费者直接从 schema 模块消费
export {
  CHAPTER_PROXY_APPROVAL_SCHEMA_ID,
  CHAPTER_PROXY_APPROVAL_SCHEMA_VERSION,
  CHAPTER_PROXY_APPROVAL_REVIEWER_MODEL,
} from "./chapter-proxy-approval-types.js";
import type {
  ChapterProxyApprovalArtifact,
  ChapterProxyApprovalStatus,
  RawChapterVerdict,
  ChapterApprovalValidationError,
  AnonymousMapping,
  RecommendedSource,
} from "./chapter-proxy-approval-types.js";

// ============================================================================
// 常量
// ============================================================================

const VALID_STATUSES: ReadonlySet<ChapterProxyApprovalStatus> = new Set<ChapterProxyApprovalStatus>([
  "PROXY_APPROVED",
  "HOLD_FOR_REGENERATION",
]);

/**
 * 归一化映射表：非正式 verdict → HOLD_FOR_REGENERATION。
 * PROXY_APPROVED / HOLD_FOR_REGENERATION 原样保留。
 */
const VERDICT_TO_HOLD: ReadonlySet<string> = new Set<string>([
  "slight_win",
  "uncertain",
  "order_sensitive",
  "conflict",
  "maybe",
  "unknown",
  "reject",
  "",
]);

const VALID_RECOMMENDED_SOURCES: ReadonlySet<RecommendedSource> = new Set<RecommendedSource>([
  "raw",
  "editorial",
  "system_selected",
]);

// ============================================================================
// validateChapterApprovalArtifact
// ============================================================================

export type ChapterApprovalValidationResult =
  | { ok: true; artifact: ChapterProxyApprovalArtifact }
  | { ok: false; error: ChapterApprovalValidationError };

/**
 * 校验章节审批 artifact 是否符合 schema。
 * 未知 schemaId / 版本不匹配 / 缺字段 / 非法 status / 错误 reviewerType/reviewerModel /
 * forward≠reverse 但 finalStatus=PROXY_APPROVED 一律拒绝。
 */
export function validateChapterApprovalArtifact(
  input: unknown,
): ChapterApprovalValidationResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      error: { code: "not_object", path: "$", message: "artifact 必须是对象" },
    };
  }

  const obj = input as Record<string, unknown>;

  // schemaId
  if (obj.schemaId !== CHAPTER_PROXY_APPROVAL_SCHEMA_ID) {
    return {
      ok: false,
      error: {
        code: "unknown_schema",
        path: "$.schemaId",
        message: `schemaId 必须为 "${CHAPTER_PROXY_APPROVAL_SCHEMA_ID}"，实际为 ${JSON.stringify(obj.schemaId)}`,
      },
    };
  }

  // schemaVersion
  if (obj.schemaVersion !== CHAPTER_PROXY_APPROVAL_SCHEMA_VERSION) {
    return {
      ok: false,
      error: {
        code: "schema_version_mismatch",
        path: "$.schemaVersion",
        message: `schemaVersion 必须为 ${CHAPTER_PROXY_APPROVAL_SCHEMA_VERSION}，实际为 ${JSON.stringify(obj.schemaVersion)}`,
      },
    };
  }

  // 必填字符串字段
  const requiredStrings: Array<keyof ChapterProxyApprovalArtifact> = [
    "approvalId",
    "releaseId",
    "workspaceId",
    "chapterId",
    "forwardVerdict",
    "reverseVerdict",
    "finalStatus",
    "recommendedCandidateId",
    "recommendedSource",
    "rationale",
    "reviewerType",
    "reviewerModel",
    "reviewerModelVersion",
    "promptHash",
    "inputArtifactHash",
    "decidedAt",
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

  // reviewerType 必须为 validated_human_proxy（永远不得为 natural_person）
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
  if (obj.reviewerModel !== CHAPTER_PROXY_APPROVAL_REVIEWER_MODEL) {
    return {
      ok: false,
      error: {
        code: "invalid_reviewer_model",
        path: "$.reviewerModel",
        message: `reviewerModel 必须为 "${CHAPTER_PROXY_APPROVAL_REVIEWER_MODEL}"，实际为 ${JSON.stringify(obj.reviewerModel)}`,
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

  // verdict / status 枚举校验
  const verdictFields: Array<keyof ChapterProxyApprovalArtifact> = [
    "forwardVerdict",
    "reverseVerdict",
    "finalStatus",
  ];
  for (const field of verdictFields) {
    const v = obj[field as string];
    if (!VALID_STATUSES.has(v as ChapterProxyApprovalStatus)) {
      return {
        ok: false,
        error: {
          code: "invalid_status",
          path: `$.${field}`,
          message: `${field} 值非法：${JSON.stringify(v)}（合法：PROXY_APPROVED/HOLD_FOR_REGENERATION）`,
        },
      };
    }
  }

  // recommendedSource 枚举
  if (!VALID_RECOMMENDED_SOURCES.has(obj.recommendedSource as RecommendedSource)) {
    return {
      ok: false,
      error: {
        code: "invalid_field_value",
        path: "$.recommendedSource",
        message: `recommendedSource 值非法：${JSON.stringify(obj.recommendedSource)}（合法：raw/editorial/system_selected）`,
      },
    };
  }

  // forward/reverse 一致性：forward≠reverse 时 finalStatus 必须为 HOLD_FOR_REGENERATION
  if (obj.forwardVerdict !== obj.reverseVerdict && obj.finalStatus !== "HOLD_FOR_REGENERATION") {
    return {
      ok: false,
      error: {
        code: "forward_reverse_mismatch",
        path: "$.finalStatus",
        message: `forward/reverse verdict 不一致（forward=${obj.forwardVerdict}, reverse=${obj.reverseVerdict}）时 finalStatus 必须为 HOLD_FOR_REGENERATION，实际为 ${JSON.stringify(obj.finalStatus)}`,
      },
    };
  }

  // P0: PROXY_APPROVED 必须要求两轮均明确批准（forward===reverse===PROXY_APPROVED）
  // 防止两轮均为 HOLD_FOR_REGENERATION 时伪造 PROXY_APPROVED 通过
  if (obj.finalStatus === "PROXY_APPROVED" && (obj.forwardVerdict !== "PROXY_APPROVED" || obj.reverseVerdict !== "PROXY_APPROVED")) {
    return {
      ok: false,
      error: {
        code: "proxy_approved_requires_both_approve",
        path: "$.finalStatus",
        message: `finalStatus=PROXY_APPROVED 要求 forwardVerdict 和 reverseVerdict 均为 PROXY_APPROVED（实际：forward=${obj.forwardVerdict}, reverse=${obj.reverseVerdict}）`,
      },
    };
  }

  // candidateIds 必须为非空字符串数组
  const candidateIds = obj.candidateIds;
  if (!Array.isArray(candidateIds) || candidateIds.length === 0 || !candidateIds.every((x) => typeof x === "string")) {
    return {
      ok: false,
      error: {
        code: "invalid_field_value",
        path: "$.candidateIds",
        message: "candidateIds 必须为非空字符串数组",
      },
    };
  }

  // anonymousMapping 结构校验
  const mappingError = validateAnonymousMapping(obj.anonymousMapping);
  if (mappingError) {
    return { ok: false, error: mappingError };
  }

  // P0: recommendedCandidateId 必须属于 candidateIds（防止 ghost 候选伪造审批）
  // 类型注：recommendedCandidateId 已在上方 requiredStrings 循环校验为 string，此处 cast 安全
  const recommendedCandidateId = obj.recommendedCandidateId as string;
  if (!candidateIds.includes(recommendedCandidateId)) {
    return {
      ok: false,
      error: {
        code: "recommended_candidate_not_in_list",
        path: "$.recommendedCandidateId",
        message: `recommendedCandidateId=${obj.recommendedCandidateId} 不在 candidateIds 中`,
      },
    };
  }

  // P0: anonymousMapping 的 A/B 值必须属于 candidateIds，且 reverse 必须真正交换 forward 的 A/B
  const fwdMap = (obj.anonymousMapping as { forward: { A: string; B: string } }).forward;
  const revMap = (obj.anonymousMapping as { reverse: { A: string; B: string } }).reverse;
  for (const v of [fwdMap.A, fwdMap.B, revMap.A, revMap.B]) {
    if (!candidateIds.includes(v)) {
      return {
        ok: false,
        error: {
          code: "anonymous_mapping_candidate_not_in_list",
          path: "$.anonymousMapping",
          message: `anonymousMapping 中的候选 ID=${v} 不在 candidateIds 中`,
        },
      };
    }
  }
  // reverse 必须真正交换 forward 的 A/B（reverse.A===forward.B && reverse.B===forward.A）
  if (revMap.A !== fwdMap.B || revMap.B !== fwdMap.A) {
    return {
      ok: false,
      error: {
        code: "anonymous_mapping_not_reversed",
        path: "$.anonymousMapping.reverse",
        message: `reverse 匿名映射必须交换 forward 的 A/B（期望 reverse.A=forward.B=${fwdMap.B}, reverse.B=forward.A=${fwdMap.A}，实际 reverse.A=${revMap.A}, reverse.B=${revMap.B}）`,
      },
    };
  }

  // 数组字段
  const arrayFields: Array<keyof ChapterProxyApprovalArtifact> = [
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

  return { ok: true, artifact: obj as unknown as ChapterProxyApprovalArtifact };
}

/** 校验 anonymousMapping 结构：forward/reverse 各含 A/B 字符串，seed 为非负数。 */
function validateAnonymousMapping(input: unknown): ChapterApprovalValidationError | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      code: "invalid_anonymous_mapping",
      path: "$.anonymousMapping",
      message: "anonymousMapping 必须为对象",
    };
  }
  const m = input as Record<string, unknown>;
  for (const side of ["forward", "reverse"] as const) {
    const s = m[side];
    if (s === null || typeof s !== "object" || Array.isArray(s)) {
      return {
        code: "invalid_anonymous_mapping",
        path: `$.anonymousMapping.${side}`,
        message: `anonymousMapping.${side} 必须为对象`,
      };
    }
    const sideObj = s as Record<string, unknown>;
    if (typeof sideObj.A !== "string" || typeof sideObj.B !== "string") {
      return {
        code: "invalid_anonymous_mapping",
        path: `$.anonymousMapping.${side}`,
        message: `anonymousMapping.${side}.A 和 .B 必须为字符串（候选 ID）`,
      };
    }
  }
  if (typeof m.seed !== "number" || !Number.isFinite(m.seed) || m.seed < 0) {
    return {
      code: "invalid_anonymous_mapping",
      path: "$.anonymousMapping.seed",
      message: "anonymousMapping.seed 必须为非负数",
    };
  }
  return null;
}

// ============================================================================
// normalizeChapterVerdict
// ============================================================================

/**
 * 归一化章节审批 verdict（计划 §6.3）。
 * - PROXY_APPROVED / HOLD_FOR_REGENERATION 原样保留
 * - slight_win/uncertain/order_sensitive/conflict/maybe/unknown/reject/空 → HOLD_FOR_REGENERATION（保守）
 * - 未知值 → HOLD_FOR_REGENERATION
 *
 * @param v 模型原始输出 verdict
 */
export function normalizeChapterVerdict(v: RawChapterVerdict): ChapterProxyApprovalStatus {
  if (VALID_STATUSES.has(v as ChapterProxyApprovalStatus)) {
    return v as ChapterProxyApprovalStatus;
  }
  // 已知非正式值 / 未知值 一律映射为 HOLD_FOR_REGENERATION
  if (VERDICT_TO_HOLD.has(v as string) || !VALID_STATUSES.has(v as ChapterProxyApprovalStatus)) {
    return "HOLD_FOR_REGENERATION";
  }
  return "HOLD_FOR_REGENERATION";
}

// ============================================================================
// computeChapterApprovalArtifactHash
// ============================================================================

/**
 * 计算 artifact 规范化 hash。
 * 排除 decidedAt（非行为字段，时间戳变化不应改变 hash）。
 * 返回 64 位小写 hex（无 "sha256:" 前缀）。
 *
 * 用于章节审批 artifact 与后续 ChapterReviewEvent 双向绑定，防止事后篡改审批结果。
 */
export function computeChapterApprovalArtifactHash(
  artifact: ChapterProxyApprovalArtifact,
): string {
  // 构造规范化对象：排除 decidedAt
  const {
    decidedAt: _decidedAt,
    ...behaviorFields
  } = artifact;
  const canonical = JSON.stringify(behaviorFields);
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

// ============================================================================
// 内部辅助：暴露给 registry 使用的类型守卫（避免循环导入时类型丢失）
// ============================================================================

export type { AnonymousMapping, RecommendedSource };
