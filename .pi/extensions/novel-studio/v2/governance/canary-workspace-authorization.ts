/**
 * CanaryWorkspaceAuthorization — G5 P1 workspace 级 canary 授权 schema + 校验
 * （EVOLUTION-RELEASE-GOVERNANCE-G5 P1）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §G5 line 380-395
 * 计划：.trae/documents/g5-p1-bounded-canary-implementation-plan.md §workspace 授权设计
 *
 * workspace 级 canary 授权：bounded_canary 策略必须有显式授权才能执行。
 * 授权 schema 与 1C 授权卡（authorization-card.ts）模式一致：
 * - schemaId / schemaVersion 固定
 * - fail-closed：过期 / 未覆盖 releaseId / 预算不足 一律抛 REQUIRES_AUTH
 * - 文件加载：loadCanaryAuthorizationFromFile 读文件 + schema 校验
 *
 * 文件位置：workspaces/{workspaceId}/canary-authorization.json
 *
 * 设计原则：
 * - 纯函数 + 单文件 IO（loadCanaryAuthorizationFromFile 读文件）
 * - 闭包自包含（仅依赖 node:fs）
 * - 校验返回结构化错误（code + path + message）
 *
 * 边界（READY_LOCAL）：
 * - 不调模型、不写文件（除 loadCanaryAuthorizationFromFile 读文件）
 * - 仅定义类型与校验，可被 dist-test/ / dist/ / dist-eval/ 任意闭包消费
 */

import { readFileSync } from "node:fs";

// ============================================================================
// Schema 常量
// ============================================================================

export const CANARY_AUTHORIZATION_SCHEMA_ID = "pinovel.canary-authorization" as const;
export const CANARY_AUTHORIZATION_SCHEMA_VERSION = 1 as const;

// ============================================================================
// 类型
// ============================================================================

/** workspace 级 canary 授权 */
export interface CanaryAuthorization {
  schemaId: typeof CANARY_AUTHORIZATION_SCHEMA_ID;
  schemaVersion: typeof CANARY_AUTHORIZATION_SCHEMA_VERSION;
  /** 授权 ID（唯一标识） */
  authorizationId: string;
  /** 目标 workspace ID */
  workspaceId: string;
  /** 允许 canary 的 releaseId 列表；["*"] 表示通配 */
  allowedReleaseIds: string[];
  /** 调用预算 */
  budget: { maxChapters: number; maxCalls: number };
  /** 签发时间（ISO） */
  issuedAt: string;
  /** 过期时间（ISO）；过期后授权失效 */
  expiresAt: string;
  /** 签发者 */
  issuer: string;
  /** 可选备注 */
  notes?: string;
}

/** 校验错误类型 */
export interface CanaryAuthorizationValidationError {
  code:
    | "unknown_schema"
    | "schema_version_mismatch"
    | "missing_field"
    | "invalid_field_value"
    | "empty_field"
    | "not_object";
  path: string;
  message: string;
}

export type CanaryAuthorizationValidationResult =
  | { ok: true; authorization: CanaryAuthorization }
  | { ok: false; error: CanaryAuthorizationValidationError };

// ============================================================================
// 校验逻辑
// ============================================================================

/**
 * 校验 canary 授权是否符合 schema。
 * 未知 schemaId / 版本不匹配 / 缺字段 / 非法枚举 / 空必填字段一律拒绝。
 */
export function validateCanaryAuthorization(
  input: unknown,
): CanaryAuthorizationValidationResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      error: { code: "not_object", path: "$", message: "canary 授权必须是对象" },
    };
  }

  const obj = input as Record<string, unknown>;

  // schemaId
  if (obj.schemaId !== CANARY_AUTHORIZATION_SCHEMA_ID) {
    return {
      ok: false,
      error: {
        code: "unknown_schema",
        path: "$.schemaId",
        message: `schemaId 必须为 "${CANARY_AUTHORIZATION_SCHEMA_ID}"，实际为 ${JSON.stringify(obj.schemaId)}`,
      },
    };
  }

  // schemaVersion
  if (obj.schemaVersion !== CANARY_AUTHORIZATION_SCHEMA_VERSION) {
    return {
      ok: false,
      error: {
        code: "schema_version_mismatch",
        path: "$.schemaVersion",
        message: `schemaVersion 必须为 ${CANARY_AUTHORIZATION_SCHEMA_VERSION}，实际为 ${JSON.stringify(obj.schemaVersion)}`,
      },
    };
  }

  // 必填字符串字段
  const requiredStrings: Array<keyof CanaryAuthorization> = [
    "authorizationId",
    "workspaceId",
    "issuedAt",
    "expiresAt",
    "issuer",
  ];
  for (const field of requiredStrings) {
    const v = obj[field as string];
    if (v === undefined || v === null) {
      return {
        ok: false,
        error: { code: "missing_field", path: `$.${field}`, message: `缺少必填字段 ${field}` },
      };
    }
    if (typeof v !== "string") {
      return {
        ok: false,
        error: { code: "invalid_field_value", path: `$.${field}`, message: `字段 ${field} 必须为字符串` },
      };
    }
    if ((v as string).length === 0) {
      return {
        ok: false,
        error: { code: "empty_field", path: `$.${field}`, message: `字段 ${field} 不能为空` },
      };
    }
  }

  // allowedReleaseIds：非空字符串数组
  if (
    !Array.isArray(obj.allowedReleaseIds) ||
    obj.allowedReleaseIds.length === 0 ||
    !obj.allowedReleaseIds.every((s: unknown) => typeof s === "string" && (s as string).length > 0)
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_field_value",
        path: "$.allowedReleaseIds",
        message: "allowedReleaseIds 必须为非空字符串数组",
      },
    };
  }

  // budget：{ maxChapters: number, maxCalls: number }
  const bu = obj.budget;
  if (
    bu === null ||
    bu === undefined ||
    typeof bu !== "object" ||
    Array.isArray(bu)
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_field_value",
        path: "$.budget",
        message: "budget 必须为对象",
      },
    };
  }
  const budgetObj = bu as Record<string, unknown>;
  if (
    !Number.isInteger(budgetObj.maxChapters) ||
    Number(budgetObj.maxChapters) <= 0 ||
    !Number.isInteger(budgetObj.maxCalls) ||
    Number(budgetObj.maxCalls) <= 0
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_field_value",
        path: "$.budget",
        message: "budget 必须包含 maxChapters 和 maxCalls（均为 number）",
      },
    };
  }

  return { ok: true, authorization: obj as unknown as CanaryAuthorization };
}

// ============================================================================
// 过期 / 覆盖 / 预算断言
// ============================================================================

/**
 * 检测 canary 授权是否过期。
 * expiresAt <= now 视为过期（边界：刚好到过期时间点算过期）。
 */
export function isCanaryAuthExpired(
  authorization: CanaryAuthorization,
  now: Date | string = new Date(),
): boolean {
  const expiresAtMs = new Date(authorization.expiresAt).getTime();
  if (Number.isNaN(expiresAtMs)) {
    // 无法解析的过期时间视为已过期（保守拒绝）
    return true;
  }
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return Number.isNaN(nowMs) || expiresAtMs <= nowMs;
}

/**
 * 检测 canary 授权是否覆盖指定 releaseId。
 * allowedReleaseIds 包含 "*" 表示通配，覆盖所有 releaseId。
 * 否则要求 releaseId 精确匹配 allowedReleaseIds 中的某一项。
 */
export function isCanaryAuthValidForRelease(
  authorization: CanaryAuthorization,
  releaseId: string,
): boolean {
  if (authorization.allowedReleaseIds.includes("*")) return true;
  return authorization.allowedReleaseIds.includes(releaseId);
}

/** assertCanaryAuthorizes 选项 */
export interface AssertCanaryAuthorizesOptions {
  /** 所需章节数（默认 1） */
  requiredChapters?: number;
  /** 所需调用数（默认 1） */
  requiredCalls?: number;
  /** 可选：覆盖当前时间（测试用） */
  now?: Date | string;
}

/**
 * 授权断言：过期 / 未覆盖 releaseId / 预算不足 一律抛 REQUIRES_AUTH 错误。
 *
 * @param authorization 已通过 schema 校验的授权
 * @param releaseId 目标 release ID
 * @param options { requiredChapters?, requiredCalls?, now? }
 * @throws Error（消息以 "REQUIRES_AUTH:" 开头）
 */
export function assertCanaryAuthorizes(
  authorization: CanaryAuthorization,
  releaseId: string,
  options: AssertCanaryAuthorizesOptions = {},
): void {
  const now = options.now ?? new Date();
  const requiredChapters = options.requiredChapters ?? 1;
  const requiredCalls = options.requiredCalls ?? 1;

  if (isCanaryAuthExpired(authorization, now)) {
    throw new Error(
      `REQUIRES_AUTH: canary 授权已过期（expiresAt=${authorization.expiresAt}）`,
    );
  }
  if (!isCanaryAuthValidForRelease(authorization, releaseId)) {
    throw new Error(
      `REQUIRES_AUTH: canary 授权不覆盖 releaseId=${releaseId}（allowedReleaseIds=${authorization.allowedReleaseIds.join(",")}）`,
    );
  }
  if (authorization.budget.maxChapters < requiredChapters) {
    throw new Error(
      `REQUIRES_AUTH: canary 授权预算不足（maxChapters=${authorization.budget.maxChapters}，需要 ${requiredChapters}）`,
    );
  }
  if (authorization.budget.maxCalls < requiredCalls) {
    throw new Error(
      `REQUIRES_AUTH: canary 授权预算不足（maxCalls=${authorization.budget.maxCalls}，需要 ${requiredCalls}）`,
    );
  }
}

// ============================================================================
// 文件加载
// ============================================================================

/**
 * 从文件加载 canary 授权并校验 schema。
 * 文件不存在 / 损坏 JSON / schema 校验失败 一律抛错。
 */
export function loadCanaryAuthorizationFromFile(filePath: string): CanaryAuthorization {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (e) {
    throw new Error(`REQUIRES_AUTH: 读取 canary 授权文件失败（${filePath}）：${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`REQUIRES_AUTH: canary 授权 JSON 解析失败（${filePath}）：${(e as Error).message}`);
  }
  const validation = validateCanaryAuthorization(parsed);
  if (!validation.ok) {
    throw new Error(
      `REQUIRES_AUTH: canary 授权校验失败（${filePath}）：${validation.error.code} at ${validation.error.path} — ${validation.error.message}`,
    );
  }
  return validation.authorization;
}
