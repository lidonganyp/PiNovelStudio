/**
 * AuthorizationCard — 授权卡类型与校验（EVOLUTION-RELEASE-GOVERNANCE-1C）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6 / Phase G4 / 1C 任务卡
 *
 * 1C 授权边界：无授权卡不得调用真实 gpt5.6-sol 模型。
 * - stub provider 不需要授权卡（本地端到端测试）
 * - real provider 必须提供有效授权卡（未过期 + 覆盖目标 releaseId + 预算充足）
 *
 * 本模块只定义类型、常量与纯函数校验，不含 fs 加载（loadAuthorizationCardFromFile 除外）。
 *
 * 边界（READY_LOCAL）：
 * - 不调用模型、不写文件（除 loadAuthorizationCardFromFile 读文件）
 * - 仅定义类型与校验，可被 dist-test/ / dist/ / dist-eval/ 任意闭包消费
 */

import { readFileSync } from "node:fs";

// ============================================================================
// Schema 常量
// ============================================================================

export const AUTHORIZATION_CARD_SCHEMA_ID = "pinovel.evolution-authorization-card" as const;
export const AUTHORIZATION_CARD_SCHEMA_VERSION = 1 as const;

// ============================================================================
// 类型
// ============================================================================

export type CardType = "stub" | "real_gpt56sol";

export interface AuthorizationCard {
  schemaId: typeof AUTHORIZATION_CARD_SCHEMA_ID;
  schemaVersion: typeof AUTHORIZATION_CARD_SCHEMA_VERSION;
  cardId: string;
  cardType: CardType;
  /** 必须为 "gpt5.6-sol" */
  model: "gpt5.6-sol";
  /** 允许审批的 releaseId 列表；["*"] 表示通配 */
  allowedReleaseIds: string[];
  /** 调用预算 */
  budget: { maxCalls: number; timeoutMs: number };
  /** 精确模型版本 */
  modelVersion: string;
  issuedAt: string;
  expiresAt: string;
  issuer: string;
  /** 授权证明（签名/审计引用；1C 不强校验签名） */
  authorizationProof?: string;
}

export interface AuthorizationCardValidationError {
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

// ============================================================================
// 校验逻辑
// ============================================================================

export type AuthorizationCardValidationResult =
  | { ok: true; card: AuthorizationCard }
  | { ok: false; error: AuthorizationCardValidationError };

/** forward + reverse = 2 calls 是代理审批的最低预算 */
const MIN_REQUIRED_CALLS = 2;

/**
 * 校验授权卡是否符合 schema。
 * 未知 schemaId / 版本不匹配 / 缺字段 / 非法枚举 / 空必填字段一律拒绝。
 * cardType=natural_person 一律拒绝（gpt5.6-sol 不得标记为自然人审批）。
 */
export function validateAuthorizationCard(input: unknown): AuthorizationCardValidationResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      error: { code: "not_object", path: "$", message: "授权卡必须是对象" },
    };
  }

  const obj = input as Record<string, unknown>;

  // schemaId
  if (obj.schemaId !== AUTHORIZATION_CARD_SCHEMA_ID) {
    return {
      ok: false,
      error: {
        code: "unknown_schema",
        path: "$.schemaId",
        message: `schemaId 必须为 "${AUTHORIZATION_CARD_SCHEMA_ID}"，实际为 ${JSON.stringify(obj.schemaId)}`,
      },
    };
  }

  // schemaVersion
  if (obj.schemaVersion !== AUTHORIZATION_CARD_SCHEMA_VERSION) {
    return {
      ok: false,
      error: {
        code: "schema_version_mismatch",
        path: "$.schemaVersion",
        message: `schemaVersion 必须为 ${AUTHORIZATION_CARD_SCHEMA_VERSION}，实际为 ${JSON.stringify(obj.schemaVersion)}`,
      },
    };
  }

  // 必填字符串字段
  const requiredStrings: Array<keyof AuthorizationCard> = [
    "cardId",
    "cardType",
    "model",
    "modelVersion",
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
  }

  // cardType 枚举：stub / real_gpt56sol（natural_person 一律拒绝）
  if (obj.cardType !== "stub" && obj.cardType !== "real_gpt56sol") {
    return {
      ok: false,
      error: {
        code: "invalid_field_value",
        path: "$.cardType",
        message: `cardType 必须为 "stub" 或 "real_gpt56sol"（不得为 natural_person），实际为 ${JSON.stringify(obj.cardType)}`,
      },
    };
  }

  // model 必须为 gpt5.6-sol
  if (obj.model !== "gpt5.6-sol") {
    return {
      ok: false,
      error: {
        code: "invalid_field_value",
        path: "$.model",
        message: `model 必须为 "gpt5.6-sol"，实际为 ${JSON.stringify(obj.model)}`,
      },
    };
  }

  // modelVersion 非空
  if ((obj.modelVersion as string).length === 0) {
    return {
      ok: false,
      error: { code: "empty_field", path: "$.modelVersion", message: "modelVersion 不能为空" },
    };
  }

  // allowedReleaseIds：非空字符串数组
  if (
    !Array.isArray(obj.allowedReleaseIds) ||
    obj.allowedReleaseIds.length === 0 ||
    !obj.allowedReleaseIds.every((s: unknown) => typeof s === "string")
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

  // budget：{ maxCalls: number, timeoutMs: number }
  const bu = obj.budget;
  if (
    bu === null ||
    typeof bu !== "object" ||
    Array.isArray(bu) ||
    typeof (bu as Record<string, unknown>).maxCalls !== "number" ||
    typeof (bu as Record<string, unknown>).timeoutMs !== "number"
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_field_value",
        path: "$.budget",
        message: "budget 必须包含 maxCalls 和 timeoutMs（均为 number）",
      },
    };
  }

  return { ok: true, card: obj as unknown as AuthorizationCard };
}

/**
 * 检测授权卡是否过期。
 * expiresAt <= now 视为过期（边界：刚好到过期时间点算过期）。
 */
export function isCardExpired(card: AuthorizationCard, now: Date = new Date()): boolean {
  const expiresAtMs = new Date(card.expiresAt).getTime();
  if (Number.isNaN(expiresAtMs)) {
    // 无法解析的过期时间视为已过期（保守拒绝）
    return true;
  }
  return expiresAtMs <= now.getTime();
}

/**
 * 检测授权卡是否覆盖指定 releaseId。
 * allowedReleaseIds 包含 "*" 表示通配，覆盖所有 releaseId。
 * 否则要求 releaseId 精确匹配 allowedReleaseIds 中的某一项。
 */
export function isCardValidForRelease(card: AuthorizationCard, releaseId: string): boolean {
  if (card.allowedReleaseIds.includes("*")) return true;
  return card.allowedReleaseIds.includes(releaseId);
}

/**
 * 授权断言：过期 / 未覆盖 releaseId / 预算不足 一律抛 REQUIRES_AUTH 错误。
 * 预算阈值：forward + reverse = 2 calls，maxCalls < 2 视为预算不足。
 */
export function assertCardAuthorizes(card: AuthorizationCard, releaseId: string): void {
  if (isCardExpired(card)) {
    throw new Error(
      `REQUIRES_AUTH: 授权卡已过期（expiresAt=${card.expiresAt}）`,
    );
  }
  if (!isCardValidForRelease(card, releaseId)) {
    throw new Error(
      `REQUIRES_AUTH: 授权卡不覆盖 releaseId=${releaseId}（allowedReleaseIds=${card.allowedReleaseIds.join(",")}）`,
    );
  }
  if (card.budget.maxCalls < MIN_REQUIRED_CALLS) {
    throw new Error(
      `REQUIRES_AUTH: 授权卡预算不足（maxCalls=${card.budget.maxCalls}，forward+reverse 至少需要 ${MIN_REQUIRED_CALLS} 次调用）`,
    );
  }
}

/**
 * 从文件加载授权卡并校验 schema。
 * 文件不存在 / 损坏 JSON / schema 校验失败 一律抛错。
 */
export function loadAuthorizationCardFromFile(filePath: string): AuthorizationCard {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (e) {
    throw new Error(`读取授权卡文件失败（${filePath}）：${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`授权卡 JSON 解析失败（${filePath}）：${(e as Error).message}`);
  }
  const validation = validateAuthorizationCard(parsed);
  if (!validation.ok) {
    throw new Error(
      `授权卡校验失败（${filePath}）：${validation.error.code} at ${validation.error.path} — ${validation.error.message}`,
    );
  }
  return validation.card;
}
