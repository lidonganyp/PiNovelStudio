/**
 * ReviewArtifactSchema - 审阅 artifact v1 只读契约（REVIEW-SCHEMA-FREEZE-1，计划 §6.5）
 *
 * 冻结审阅 artifact 的稳定、可版本化结构：raw/editorial 候选、FactGuard、judge、
 * state summary、human-review focus、span、expected/actual 路由与错误状态。
 *
 * 核心不变量（REVIEW-SCHEMA-FREEZE-1 任务书）：
 * - 固定 schema id/version：pinovel.review-artifact/v1。
 * - expected 与 actual provider/model/route 分字段；禁止合并或用 expected 冒充 actual。
 * - span 必须含 candidateId/start/end；非法 span 返回可读 error，不静默截断。
 * - 支持 editorial/raw-only/blocked/artifact-missing 四种结果。
 * - 未知 schema version 只读降级 + migration hint。
 * - 纯本地解析/渲染；不调用模型、不生成正文、不保存章节、不提交状态、不改 winner。
 *
 * REPAIR 补强（REVIEW-SCHEMA-FREEZE-1-REPAIR）：
 * - schemaId 值不是 pinovel.review-artifact（即便 version=v1）不得构建 typed artifact。
 * - schemaId 存在但 schemaVersion 缺失/空 -> missing_schema_version。
 * - top-level spans 与 judge.winningSpans/losingSpans 统一校验。
 * - 0.5/NaN/Infinity 必须为 invalid_span。
 * - expected/actual 非对象或非法结构不得被静默丢弃并构建 artifact。
 * - 保留 unknown version 只读降级、四种 outcome、零副作用。
 *
 * 边界（L0 契约冻结）：
 * - 纯解析/校验层：不 spawn 进程、不读写 workspace、不调用网络模型。
 * - 不是 gate；不阻断正文生成；不修改 finalText；不提交状态。
 */

// ============================================================================
// schema id/version 常量
// ============================================================================

export const REVIEW_ARTIFACT_SCHEMA_ID = "pinovel.review-artifact" as const;
export const REVIEW_ARTIFACT_SCHEMA_VERSION = "v1" as const;
export const REVIEW_ARTIFACT_SCHEMA_FULL_ID =
  `${REVIEW_ARTIFACT_SCHEMA_ID}/${REVIEW_ARTIFACT_SCHEMA_VERSION}` as const;

const SUPPORTED_VERSIONS = new Set<string>([REVIEW_ARTIFACT_SCHEMA_VERSION]);

const UNSUPPORTED_VERSION_MIGRATION_HINT =
  "review-artifact schema 版本不受支持；请用 pinovel.review-artifact/v1 重新整理 artifact，" +
  "或升级 review-artifact-schema 以支持新版本。降级为只读模式，不阻断查看。";

/** actual 字段用 expected 冒充的 sentinel（字符串或 inherit 标记） */
const ACTUAL_SENTINEL_REGEX = /^(=expected|\$expected|inherit|__inherit.*)$/i;

// ============================================================================
// 数据契约类型
// ============================================================================

export interface RouteDescriptor {
  provider?: string;
  model?: string;
  route?: string;
}

export interface ModelRouting {
  expected?: RouteDescriptor;
  actual?: RouteDescriptor;
}

export interface ArtifactSpan {
  candidateId: string;
  start: number;
  end: number;
}

export interface CandidateArtifact {
  candidateId: string;
  text?: string;
  sourceSha256?: string;
  finishReason?: string;
}

export interface FactGuardArtifact {
  candidateId: string;
  passed: boolean;
  evidence?: string;
  reason?: string;
}

export interface JudgeArtifact {
  winner: "raw" | "editorial" | "tie";
  rationale?: string;
  winningSpans?: ArtifactSpan[];
  losingSpans?: ArtifactSpan[];
}

export interface StateCommitSummary {
  committed: number;
  rejected: number;
  quarantined: number;
}

export type ReviewArtifactOutcome =
  | "editorial"
  | "raw-only"
  | "blocked"
  | "artifact-missing";

/** 冻结的 v1 artifact（artifact-missing 不在此层产出） */
export interface ReviewArtifactV1 {
  schemaId: typeof REVIEW_ARTIFACT_SCHEMA_ID;
  schemaVersion: typeof REVIEW_ARTIFACT_SCHEMA_VERSION;
  outcome: Exclude<ReviewArtifactOutcome, "artifact-missing">;
  pairId: string;
  chapterNumber?: number;
  candidates: {
    raw?: CandidateArtifact;
    editorial?: CandidateArtifact;
  };
  factGuard?: FactGuardArtifact[];
  judge?: JudgeArtifact;
  stateCommitSummary?: StateCommitSummary;
  humanReviewFocus?: string[];
  modelRouting: ModelRouting;
  spans?: ArtifactSpan[];
  blockReason?: string;
}

export interface ParseError {
  code: string;
  field?: string;
  message: string;
}

export interface ReviewArtifactParseResult {
  schemaFullId: string;
  detectedVersion: string | null;
  supported: boolean;
  degradedReadonly: boolean;
  migrationHint?: string;
  outcome: ReviewArtifactOutcome;
  artifact?: ReviewArtifactV1;
  errors: ParseError[];
}

// ============================================================================
// 内部工具
// ============================================================================

type AnyObject = Record<string, unknown>;

function isObject(value: unknown): value is AnyObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegativeInt(value: unknown): value is number {
  // REPAIR-4: 拒绝非整数（0.5）；Number.isFinite 已拒绝 NaN/Infinity。
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function describeKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// ============================================================================
// parseReviewArtifact
// ============================================================================

/**
 * 解析审阅 artifact 为冻结的 v1 契约。
 *
 * - null/非对象 -> outcome=artifact-missing
 * - schemaId 存在但 version 缺失 -> missing_schema_version
 * - schemaId/version 均缺失 -> missing_schema_version
 * - schemaId 值不匹配 -> schema_id_mismatch（即便 version=v1）
 * - 未知 version -> 只读降级（supported=false, degradedReadonly=true, migrationHint）
 * - modelRouting 合并/actual 冒充/expected|actual 非对象 -> error
 * - 非法 span（含 judge spans）-> error（不截断）
 * - 合法 -> 构建 ReviewArtifactV1
 *
 * 纯本地，无副作用：不调用模型、不保存章节、不提交状态、不改 winner。
 */
export function parseReviewArtifact(raw: unknown): ReviewArtifactParseResult {
  const base: ReviewArtifactParseResult = {
    schemaFullId: REVIEW_ARTIFACT_SCHEMA_FULL_ID,
    detectedVersion: null,
    supported: true,
    degradedReadonly: false,
    outcome: "artifact-missing",
    errors: [],
  };

  // 1. artifact-missing：null/undefined/非对象/数组
  if (!isObject(raw)) {
    return {
      ...base,
      outcome: "artifact-missing",
      errors: [
        {
          code: "artifact_missing",
          message: "artifact 为空或非对象，无法解析",
        },
      ],
    };
  }

  const obj = raw;

  // 2. schema id/version 检测
  const detectedSchemaId = readSchemaId(obj);
  const detectedVersion = readVersion(obj);
  base.detectedVersion = detectedVersion;

  const hasSchemaIdKey = detectedSchemaId !== null;
  const hasVersion = detectedVersion !== null;

  // schemaId 与 version 任一缺失 -> missing_schema_version（两者必须同时存在）
  // REPAIR-2: schemaId 存在但 version 缺失
  // REPAIR-1: version 存在但 schemaId 缺失（不得仅凭 version 放行）
  if (!hasSchemaIdKey || !hasVersion) {
    const missingField = !hasSchemaIdKey && !hasVersion
      ? "schemaId/schemaVersion"
      : !hasSchemaIdKey
        ? "schemaId"
        : "schemaVersion";
    return {
      ...base,
      supported: false,
      outcome: "blocked",
      errors: [
        {
          code: "missing_schema_version",
          field: missingField,
          message: `缺少 ${missingField}，无法判定 artifact 契约版本`,
        },
      ],
    };
  }

  const errors: ParseError[] = [];

  // REPAIR-1: schemaId 存在但值不是 pinovel.review-artifact -> schema_id_mismatch
  // （即便 version=v1 也不得构建 typed artifact）
  if (hasSchemaIdKey && detectedSchemaId !== REVIEW_ARTIFACT_SCHEMA_ID) {
    errors.push({
      code: "schema_id_mismatch",
      field: "schemaId",
      message: `schemaId="${detectedSchemaId}" 与冻结契约 "${REVIEW_ARTIFACT_SCHEMA_ID}" 不匹配，不得构建 typed artifact`,
    });
  }

  const supported = SUPPORTED_VERSIONS.has(detectedVersion as string);
  base.supported = supported;
  if (!supported) {
    base.degradedReadonly = true;
    base.migrationHint = UNSUPPORTED_VERSION_MIGRATION_HINT;
  }

  // 3. modelRouting：expected/actual 分字段校验
  const routing = obj.modelRouting;
  if (routing !== undefined) {
    if (!isObject(routing)) {
      errors.push({
        code: "invalid_model_routing",
        field: "modelRouting",
        message: "modelRouting 必须是对象",
      });
    } else {
      const hasDirectRouteKeys =
        "provider" in routing || "model" in routing || "route" in routing;
      const hasSplitKeys = "expected" in routing || "actual" in routing;
      // 合并：直接 provider/model/route 且未拆分 expected/actual
      if (hasDirectRouteKeys && !hasSplitKeys) {
        errors.push({
          code: "expected_actual_merged",
          field: "modelRouting",
          message:
            "modelRouting 合并了 provider/model/route，必须拆分为 expected 与 actual 两个独立字段",
        });
      }
      // REPAIR-5: expected/actual 存在但非对象 -> error，不静默丢弃
      const expected = (routing as AnyObject).expected;
      const actual = (routing as AnyObject).actual;
      if ("expected" in routing && !isObject(expected)) {
        errors.push({
          code: "invalid_model_routing_expected",
          field: "modelRouting.expected",
          message: `expected 必须是对象，实际为 ${describeKind(expected)}，不得静默丢弃`,
        });
      }
      if ("actual" in routing && !isObject(actual)) {
        errors.push({
          code: "invalid_model_routing_actual",
          field: "modelRouting.actual",
          message: `actual 必须是对象，实际为 ${describeKind(actual)}，不得静默丢弃`,
        });
      }
      // actual 用 expected 冒充（sentinel 字符串或 inherit 标记）
      if (typeof actual === "string" && ACTUAL_SENTINEL_REGEX.test(actual)) {
        errors.push({
          code: "expected_actual_confused",
          field: "modelRouting.actual",
          message: `actual 使用 sentinel "${actual}" 冒充 expected，actual 必须独立观测或留空`,
        });
      } else if (
        isObject(actual) &&
        (actual as AnyObject).inherit === true
      ) {
        errors.push({
          code: "expected_actual_confused",
          field: "modelRouting.actual",
          message: "actual 标记 inherit=true 冒充 expected，actual 必须独立观测或留空",
        });
      }
    }
  }

  // 4. spans 校验（candidateId/start/end；非法 -> error，不截断）
  // REPAIR-3: top-level spans 与 judge.winningSpans/losingSpans 统一校验。
  const validatedSpans = validateSpanArray(obj.spans, "spans", errors);

  // REPAIR-3: judge spans 统一校验
  let validatedJudge:
    | {
        winner: JudgeArtifact["winner"];
        rationale?: string;
        winningSpans?: ArtifactSpan[];
        losingSpans?: ArtifactSpan[];
      }
    | undefined;
  const judgeSrc = obj.judge;
  if (judgeSrc !== undefined) {
    if (!isObject(judgeSrc)) {
      errors.push({
        code: "invalid_judge",
        field: "judge",
        message: "judge 必须是对象",
      });
    } else {
      const winner = (judgeSrc as AnyObject).winner;
      if (winner !== "raw" && winner !== "editorial" && winner !== "tie") {
        errors.push({
          code: "invalid_judge",
          field: "judge.winner",
          message: `judge.winner 必须是 raw/editorial/tie，实际为 ${describeKind(winner)}`,
        });
      }
      const winningSpans = validateSpanArray(
        (judgeSrc as AnyObject).winningSpans,
        "judge.winningSpans",
        errors,
      );
      const losingSpans = validateSpanArray(
        (judgeSrc as AnyObject).losingSpans,
        "judge.losingSpans",
        errors,
      );
      const rationale = (judgeSrc as AnyObject).rationale;
      validatedJudge = {
        winner: winner as JudgeArtifact["winner"],
        rationale: typeof rationale === "string" ? rationale : undefined,
        winningSpans,
        losingSpans,
      };
    }
  }

  // 5. 确定 outcome
  const declaredOutcome = typeof obj.outcome === "string" ? obj.outcome : null;
  let outcome: ReviewArtifactOutcome;
  if (
    declaredOutcome === "editorial" ||
    declaredOutcome === "raw-only" ||
    declaredOutcome === "blocked"
  ) {
    outcome = declaredOutcome;
  } else {
    // 推断：raw+editorial -> editorial；仅 raw -> raw-only；否则 blocked
    const candidates = isObject(obj.candidates) ? (obj.candidates as AnyObject) : {};
    const hasRaw = isObject(candidates.raw);
    const hasEd = isObject(candidates.editorial);
    if (hasRaw && hasEd) {
      outcome = "editorial";
    } else if (hasRaw) {
      outcome = "raw-only";
    } else {
      outcome = "blocked";
    }
  }

  // 6. 有结构 error -> 强制 blocked（不冒充成功；artifact-missing 已在步骤 1 提前返回）
  if (errors.length > 0) {
    outcome = "blocked";
  }

  // 7. 仅当无 error 且版本受支持才构建 typed artifact
  const buildArtifact = errors.length === 0 && supported;

  const artifact: ReviewArtifactV1 | undefined = buildArtifact
    ? buildV1Artifact(obj, validatedSpans, validatedJudge, outcome)
    : undefined;

  return {
    ...base,
    outcome,
    artifact,
    errors,
  };
}

// ============================================================================
// 内部：读取 schemaId
// ============================================================================

function readSchemaId(obj: AnyObject): string | null {
  const id = obj.schemaId as unknown;
  if (typeof id === "string" && id.length > 0) {
    return id;
  }
  return null;
}

// ============================================================================
// 内部：读取 version
// ============================================================================

function readVersion(obj: AnyObject): string | null {
  const v = obj.schemaVersion as unknown;
  if (typeof v === "string" && v.length > 0) {
    return v;
  }
  return null;
}

// ============================================================================
// 内部：统一 span 数组校验（top-level spans 与 judge spans 共用）
// ============================================================================

/**
 * 校验 span 数组。非法 span -> invalid_span error，不截断、不静默丢弃。
 * 返回通过校验的 span 数组（无合法项时返回 undefined）。
 */
function validateSpanArray(
  raw: unknown,
  fieldPrefix: string,
  errors: ParseError[],
): ArtifactSpan[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    errors.push({
      code: "invalid_span",
      field: fieldPrefix,
      message: `${fieldPrefix} 必须是数组`,
    });
    return undefined;
  }
  const validated: ArtifactSpan[] = [];
  for (let i = 0; i < raw.length; i++) {
    const span = raw[i];
    if (!isObject(span)) {
      errors.push({
        code: "invalid_span",
        field: `${fieldPrefix}[${i}]`,
        message: `${fieldPrefix}[${i}] 不是对象`,
      });
      continue;
    }
    const candidateId = (span as AnyObject).candidateId;
    const start = (span as AnyObject).start;
    const end = (span as AnyObject).end;
    if (typeof candidateId !== "string" || candidateId === "") {
      errors.push({
        code: "invalid_span",
        field: `${fieldPrefix}[${i}].candidateId`,
        message: `${fieldPrefix}[${i}] 缺少 candidateId`,
      });
      continue;
    }
    if (!isFiniteNonNegativeInt(start)) {
      errors.push({
        code: "invalid_span",
        field: `${fieldPrefix}[${i}].start`,
        message: `${fieldPrefix}[${i}] start 不是非负整数`,
      });
      continue;
    }
    if (!isFiniteNonNegativeInt(end)) {
      errors.push({
        code: "invalid_span",
        field: `${fieldPrefix}[${i}].end`,
        message: `${fieldPrefix}[${i}] end 不是非负整数`,
      });
      continue;
    }
    if (start > end) {
      errors.push({
        code: "invalid_span",
        field: `${fieldPrefix}[${i}].start/end`,
        message: `${fieldPrefix}[${i}] start(${start}) 大于 end(${end})，不得越界`,
      });
      continue;
    }
    validated.push({ candidateId, start, end });
  }
  return validated.length > 0 ? validated : undefined;
}

// ============================================================================
// 内部：构建 ReviewArtifactV1
// ============================================================================

function buildV1Artifact(
  obj: AnyObject,
  spans: ArtifactSpan[] | undefined,
  judge:
    | {
        winner: JudgeArtifact["winner"];
        rationale?: string;
        winningSpans?: ArtifactSpan[];
        losingSpans?: ArtifactSpan[];
      }
    | undefined,
  outcome: Exclude<ReviewArtifactOutcome, "artifact-missing">,
): ReviewArtifactV1 {
  const candidatesSrc = isObject(obj.candidates) ? (obj.candidates as AnyObject) : {};
  const routingSrc = isObject(obj.modelRouting) ? (obj.modelRouting as AnyObject) : {};

  const artifact: ReviewArtifactV1 = {
    schemaId: REVIEW_ARTIFACT_SCHEMA_ID,
    schemaVersion: REVIEW_ARTIFACT_SCHEMA_VERSION,
    outcome,
    pairId: typeof obj.pairId === "string" ? obj.pairId : "",
    candidates: {
      raw: isObject(candidatesSrc.raw)
        ? (candidatesSrc.raw as unknown as CandidateArtifact)
        : undefined,
      editorial: isObject(candidatesSrc.editorial)
        ? (candidatesSrc.editorial as unknown as CandidateArtifact)
        : undefined,
    },
    modelRouting: {
      expected: isObject(routingSrc.expected)
        ? (routingSrc.expected as unknown as RouteDescriptor)
        : undefined,
      actual: isObject(routingSrc.actual)
        ? (routingSrc.actual as unknown as RouteDescriptor)
        : undefined,
    },
  };

  if (typeof obj.chapterNumber === "number") {
    artifact.chapterNumber = obj.chapterNumber;
  }
  if (Array.isArray(obj.factGuard)) {
    artifact.factGuard = obj.factGuard as unknown as FactGuardArtifact[];
  }
  // REPAIR-3: 使用校验后的 judge（含校验过的 winningSpans/losingSpans）
  if (judge) {
    const judgeArtifact: JudgeArtifact = { winner: judge.winner };
    if (judge.rationale !== undefined) {
      judgeArtifact.rationale = judge.rationale;
    }
    if (judge.winningSpans) {
      judgeArtifact.winningSpans = judge.winningSpans;
    }
    if (judge.losingSpans) {
      judgeArtifact.losingSpans = judge.losingSpans;
    }
    artifact.judge = judgeArtifact;
  }
  if (isObject(obj.stateCommitSummary)) {
    artifact.stateCommitSummary = obj.stateCommitSummary as unknown as StateCommitSummary;
  }
  if (Array.isArray(obj.humanReviewFocus)) {
    artifact.humanReviewFocus = obj.humanReviewFocus as string[];
  }
  if (spans && spans.length > 0) {
    artifact.spans = spans;
  }
  if (typeof obj.blockReason === "string") {
    artifact.blockReason = obj.blockReason;
  }

  return artifact;
}
