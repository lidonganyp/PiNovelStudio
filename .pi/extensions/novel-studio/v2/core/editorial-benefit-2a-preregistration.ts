/**
 * EditorialBenefit2aPreregistration — advisory on/off 消融预登记与本地 harness
 *
 * 目标（EDITORIAL-BENEFIT-2A 任务书）：
 * - 在不调用模型的前提下冻结单 case evidence advisory on/off 消融协议
 * - 预登记 case、唯一变量、停止条件、最大调用数、排除规则、judge + human 决策 schema
 * - 一旦冻结不可变（case/阈值/预算事后不可换）
 *
 * 边界（READY_LOCAL）：
 * - 不调用真实模型、不生成章节、不提交状态
 * - dry-run harness 只校验协议完备性，不执行真实消融
 * - 单裁判不算正向；2C 必须有自然人或 validated_human_proxy verdict
 * - harness 校验失败不调用模型；结果不清晰保留 raw
 *
 * 与 2B/2C 的关系：
 * - 2A：本地预登记（本模块）—— 冻结协议，dry-run 校验
 * - 2B（REQUIRES_AUTH）：2A 预登记通过后，单 case 真实 on/off 消融
 * - 2C（READY_REVIEW）：对 2B 结果做匿名自然人或 validated_human_proxy + judge 双证据；
 *   共同支持才算正向，否则保留 raw
 *
 * 模块为 standalone tooling，由 tsconfig.prod.json files 数组单独编译到 dist/。
 * 不依赖 PI Host、不依赖 legacy Stage0-8、不调用模型。
 */

import {
  readFileSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";

// ============================================================================
// Schema contract
// ============================================================================

export const EDITORIAL_BENEFIT_PREREG_SCHEMA_ID =
  "pinovel.editorial-benefit-preregistration" as const;
export const EDITORIAL_BENEFIT_PREREG_SCHEMA_VERSION = "v1" as const;

const TASK_ID = "EDITORIAL-BENEFIT-2A";
const MUTATION_POLICY = "immutable-after-freeze";
const FROZEN_BY = "EDITORIAL-BENEFIT-2A";
const ONLY_VARIABLE = "advisory_on_off";
const VALIDATED_PROXY_MODEL = "gpt5.6-sol";
const ALLOWED_REVIEWER_TYPES = ["natural_person", "validated_human_proxy"] as const;
const ALLOWED_LAYERS = ["B0", "B1", "B2", "B3", "B4"] as const;
const REQUIRED_REGRESSION_FIELDS = ["modelVersion", "seed", "rawSha256", "caseId"];
const JUDGE_SPAN_FIELDS = ["winningSpans", "losingSpans"];
const MIN_JUDGE_DIMENSIONS = 5;
const MAX_EDITORIAL_CANDIDATES_PER_ARM = 2;

// ============================================================================
// 类型
// ============================================================================

export interface CaseProvenance {
  caseId: string;
  sourcePath: string;
  sourceSha256: string;
  sizeBytes: number;
  orchestratorRunId: string;
  workspaceId: string;
  layer: string;
}

export interface ArmProvenance {
  orchestratorRunId: string;
  caseId: string;
  layer: string;
  workspaceId: string;
}

export interface ArmConstraint {
  modelVersion: string;
  seed: number;
  rawSourcePath: string;
  rawSha256: string;
  provenance: ArmProvenance;
}

export interface Arm {
  advisoryEnabled: boolean;
  constraint: ArmConstraint;
}

export interface CallBudget {
  maxCallsPerArm: number;
  maxRawCallsPerArm: number;
  maxEditorialCandidatesPerArm: number;
  totalBudgetAcrossArms: number;
}

export interface ExclusionRules {
  fallbackRunsExcluded: boolean;
  noCandidateRunsExcluded: boolean;
  hardBlockRunsExcluded: boolean;
  fallbackReason: string;
  noCandidateReason: string;
  hardBlockReason: string;
}

export interface StopConditions {
  bothArmsCompleteWithValidCandidate: boolean;
  callBudgetExhausted: boolean;
  modelExceptionOrTimeout: boolean;
  hardBlockOnBothArms: boolean;
}

export interface JudgeDecisionSchema {
  requiredFields: string[];
  preferenceEnum: string[];
  spanResponseRequired: boolean;
  spanFields: string[];
  dimensionsRequired: number;
  reverseReviewRequired: boolean;
}

export interface HumanDecisionSchema {
  requiredFields: string[];
  allowedReviewerTypes: string[];
  validatedProxyModel: string;
  spanResponseRequired: boolean;
}

export interface DecisionSchema {
  judge: JudgeDecisionSchema;
  human: HumanDecisionSchema;
}

export interface RegressionFields {
  mustPreserveAcrossArms: string[];
}

export interface PositiveSignalCriteria {
  singleJudgeNotPositive: boolean;
  requiresHumanOrProxy: boolean;
  coSupportRequired: boolean;
  coSupportDefinition: string;
  unclearRetainsRaw: boolean;
}

export interface EditorialBenefitPreregistration {
  schemaId: typeof EDITORIAL_BENEFIT_PREREG_SCHEMA_ID;
  schemaVersion: typeof EDITORIAL_BENEFIT_PREREG_SCHEMA_VERSION;
  taskId: string;
  frozenAt: string;
  frozenBy: string;
  mutationPolicy: string;
  caseProvenance: CaseProvenance;
  onlyVariable: string;
  arms: {
    advisory_on: Arm;
    advisory_off: Arm;
  };
  callBudget: CallBudget;
  exclusionRules: ExclusionRules;
  stopConditions: StopConditions;
  decisionSchema: DecisionSchema;
  regressionFields: RegressionFields;
  positiveSignalCriteria: PositiveSignalCriteria;
}

// ============================================================================
// 校验错误
// ============================================================================

export type PreregValidationErrorCode =
  | "invalid_root"
  | "invalid_schema_id"
  | "unsupported_schema_version"
  | "invalid_field"
  | "arm_constraint_divergence"
  | "budget_inconsistent"
  | "stop_conditions_empty"
  | "regression_fields_incomplete";

export interface PreregValidationError {
  code: PreregValidationErrorCode;
  path: string;
  message: string;
}

export type PreregValidationResult =
  | { ok: true; artifact: EditorialBenefitPreregistration }
  | { ok: false; error: PreregValidationError };

// ============================================================================
// dry-run 类型
// ============================================================================

export interface DryRunCheck {
  id: string;
  label: string;
  passed: boolean;
}

export interface DryRunGap {
  checkId: string;
  message: string;
}

export interface DryRunResult {
  ok: boolean;
  checks: DryRunCheck[];
  gaps: DryRunGap[];
  /** 恒为 false：dry-run 不调用模型（任务书 recovery 约束） */
  modelCalled: false;
}

export interface DryRunOptions {
  /**
   * 是否检查 case provenance 文件存在性 + hash 匹配。
   * 默认 false：2A 只冻结协议，不要求 case 文件在本地可访问；
   * 2B 真实运行时再校验。
   */
  checkCaseProvenanceExists?: boolean;
}

// ============================================================================
// 授权前检查表类型
// ============================================================================

export interface ChecklistItem {
  id: string;
  label: string;
  passed: boolean;
}

export interface PreAuthorizationChecklist {
  items: ChecklistItem[];
  summary: {
    allPassed: boolean;
    failedCount: number;
  };
}

// ============================================================================
// 内部工具
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(
  code: PreregValidationErrorCode,
  path: string,
  message: string
): PreregValidationError {
  return { code, path, message };
}

function requireString(
  record: Record<string, unknown>,
  field: string,
  path: string
): PreregValidationError | undefined {
  if (typeof record[field] !== "string" || (record[field] as string).trim().length === 0) {
    return error("invalid_field", `${path}.${field}`, `${field} 必须是非空字符串`);
  }
  return undefined;
}

function requireBoolean(
  record: Record<string, unknown>,
  field: string,
  path: string
): PreregValidationError | undefined {
  if (typeof record[field] !== "boolean") {
    return error("invalid_field", `${path}.${field}`, `${field} 必须是 boolean`);
  }
  return undefined;
}

function requirePositiveInt(
  record: Record<string, unknown>,
  field: string,
  path: string
): PreregValidationError | undefined {
  if (
    typeof record[field] !== "number" ||
    !Number.isFinite(record[field]) ||
    !Number.isInteger(record[field]) ||
    record[field] <= 0
  ) {
    return error("invalid_field", `${path}.${field}`, `${field} 必须是正整数`);
  }
  return undefined;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

// ============================================================================
// 校验：case provenance
// ============================================================================

function validateCaseProvenance(
  input: unknown,
  path: string
): PreregValidationError | undefined {
  if (!isRecord(input)) {
    return error("invalid_field", path, "caseProvenance 必须是对象");
  }
  for (const field of ["caseId", "sourcePath", "orchestratorRunId", "workspaceId"]) {
    const e = requireString(input, field, path);
    if (e) return e;
  }
  if (typeof input.sourceSha256 !== "string" || !HEX64.test(input.sourceSha256)) {
    return error("invalid_field", `${path}.sourceSha256`, "sourceSha256 必须是 64 位 hex");
  }
  if (
    typeof input.sizeBytes !== "number" ||
    !Number.isFinite(input.sizeBytes) ||
    !Number.isInteger(input.sizeBytes) ||
    input.sizeBytes <= 0
  ) {
    return error("invalid_field", `${path}.sizeBytes`, "sizeBytes 必须是正整数");
  }
  if (typeof input.layer !== "string" || !ALLOWED_LAYERS.includes(input.layer as (typeof ALLOWED_LAYERS)[number])) {
    return error("invalid_field", `${path}.layer`, `layer 必须是 ${ALLOWED_LAYERS.join("/")} 之一`);
  }
  return undefined;
}

// ============================================================================
// 校验：arm constraint
// ============================================================================

function validateArmConstraint(
  input: unknown,
  path: string
): PreregValidationError | undefined {
  if (!isRecord(input)) {
    return error("invalid_field", path, "arm constraint 必须是对象");
  }
  for (const field of ["modelVersion", "rawSourcePath", "rawSha256"]) {
    const e = requireString(input, field, path);
    if (e) return e;
  }
  if (typeof input.rawSha256 !== "string" || !HEX64.test(input.rawSha256)) {
    return error("invalid_field", `${path}.rawSha256`, "rawSha256 必须是 64 位 hex");
  }
  if (typeof input.seed !== "number" || !Number.isFinite(input.seed) || !Number.isInteger(input.seed) || input.seed < 0) {
    return error("invalid_field", `${path}.seed`, "seed 必须是非负整数");
  }
  if (!isRecord(input.provenance)) {
    return error("invalid_field", `${path}.provenance`, "provenance 必须是对象");
  }
  for (const field of ["orchestratorRunId", "caseId", "layer", "workspaceId"]) {
    const e = requireString(input.provenance as Record<string, unknown>, field, `${path}.provenance`);
    if (e) return e;
  }
  if (!ALLOWED_LAYERS.includes((input.provenance as Record<string, unknown>).layer as (typeof ALLOWED_LAYERS)[number])) {
    return error("invalid_field", `${path}.provenance.layer`, `provenance.layer 必须是 ${ALLOWED_LAYERS.join("/")} 之一`);
  }
  return undefined;
}

function validateArm(input: unknown, path: string, expectedAdvisoryEnabled: boolean): PreregValidationError | undefined {
  if (!isRecord(input)) {
    return error("invalid_field", path, `${path} 必须是对象`);
  }
  if (typeof input.advisoryEnabled !== "boolean" || input.advisoryEnabled !== expectedAdvisoryEnabled) {
    return error("invalid_field", `${path}.advisoryEnabled`, `advisoryEnabled 必须为 ${expectedAdvisoryEnabled}`);
  }
  return validateArmConstraint(input.constraint, `${path}.constraint`);
}

// ============================================================================
// 校验：两臂约束一致性（同 raw/model/seed/provenance）
// ============================================================================

function checkArmConstraintDivergence(
  onConstraint: ArmConstraint,
  offConstraint: ArmConstraint
): PreregValidationError | undefined {
  if (onConstraint.modelVersion !== offConstraint.modelVersion) return error("arm_constraint_divergence", "arms", "两臂 modelVersion 必须一致");
  if (onConstraint.seed !== offConstraint.seed) return error("arm_constraint_divergence", "arms", "两臂 seed 必须一致");
  if (onConstraint.rawSha256 !== offConstraint.rawSha256) return error("arm_constraint_divergence", "arms", "两臂 rawSha256 必须一致");
  if (onConstraint.provenance.orchestratorRunId !== offConstraint.provenance.orchestratorRunId) return error("arm_constraint_divergence", "arms", "两臂 provenance.orchestratorRunId 必须一致");
  if (onConstraint.provenance.caseId !== offConstraint.provenance.caseId) return error("arm_constraint_divergence", "arms", "两臂 provenance.caseId 必须一致");
  if (onConstraint.provenance.workspaceId !== offConstraint.provenance.workspaceId) return error("arm_constraint_divergence", "arms", "两臂 provenance.workspaceId 必须一致");
  if (onConstraint.provenance.layer !== offConstraint.provenance.layer) return error("arm_constraint_divergence", "arms", "两臂 provenance.layer 必须一致");
  return undefined;
}

// ============================================================================
// 校验：call budget
// ============================================================================

function validateCallBudget(input: unknown, path: string): PreregValidationError | undefined {
  if (!isRecord(input)) {
    return error("invalid_field", path, "callBudget 必须是对象");
  }
  for (const field of ["maxCallsPerArm", "maxRawCallsPerArm", "totalBudgetAcrossArms"]) {
    const e = requirePositiveInt(input, field, path);
    if (e) return e;
  }
  if (
    typeof input.maxEditorialCandidatesPerArm !== "number" ||
    !Number.isInteger(input.maxEditorialCandidatesPerArm) ||
    input.maxEditorialCandidatesPerArm < 0 ||
    input.maxEditorialCandidatesPerArm > MAX_EDITORIAL_CANDIDATES_PER_ARM
  ) {
    return error(
      "budget_inconsistent",
      `${path}.maxEditorialCandidatesPerArm`,
      `maxEditorialCandidatesPerArm 必须 0..${MAX_EDITORIAL_CANDIDATES_PER_ARM}（单章 hard cap）`
    );
  }
  const maxPerArm = input.maxCallsPerArm as number;
  const total = input.totalBudgetAcrossArms as number;
  if (total < 2 * maxPerArm) {
    return error(
      "budget_inconsistent",
      `${path}.totalBudgetAcrossArms`,
      `totalBudgetAcrossArms(${total}) 必须 >= 2 * maxCallsPerArm(${maxPerArm})`
    );
  }
  return undefined;
}

// ============================================================================
// 校验：exclusion rules
// ============================================================================

function validateExclusionRules(input: unknown, path: string): PreregValidationError | undefined {
  if (!isRecord(input)) {
    return error("invalid_field", path, "exclusionRules 必须是对象");
  }
  for (const field of ["fallbackRunsExcluded", "noCandidateRunsExcluded", "hardBlockRunsExcluded"]) {
    const e = requireBoolean(input, field, path);
    if (e) return e;
    if (input[field] !== true) {
      return error("invalid_field", `${path}.${field}`, `${field} 必须为 true（acceptance 强制）`);
    }
  }
  for (const field of ["fallbackReason", "noCandidateReason", "hardBlockReason"]) {
    const e = requireString(input, field, path);
    if (e) return e;
  }
  return undefined;
}

// ============================================================================
// 校验：stop conditions
// ============================================================================

function validateStopConditions(input: unknown, path: string): PreregValidationError | undefined {
  if (!isRecord(input)) {
    return error("invalid_field", path, "stopConditions 必须是对象");
  }
  const fields = ["bothArmsCompleteWithValidCandidate", "callBudgetExhausted", "modelExceptionOrTimeout", "hardBlockOnBothArms"];
  for (const field of fields) {
    const e = requireBoolean(input, field, path);
    if (e) return e;
  }
  const anyTrue = fields.some((f) => input[f] === true);
  if (!anyTrue) {
    return error("stop_conditions_empty", path, "stopConditions 至少一个为 true，否则永不停止");
  }
  return undefined;
}

// ============================================================================
// 校验：decision schema
// ============================================================================

function validateJudgeSchema(input: unknown, path: string): PreregValidationError | undefined {
  if (!isRecord(input)) {
    return error("invalid_field", path, "decisionSchema.judge 必须是对象");
  }
  if (!Array.isArray(input.requiredFields) || input.requiredFields.length === 0) {
    return error("invalid_field", `${path}.requiredFields`, "requiredFields 必须是非空数组");
  }
  for (const spanField of JUDGE_SPAN_FIELDS) {
    if (!(input.requiredFields as string[]).includes(spanField)) {
      return error("invalid_field", `${path}.requiredFields`, `requiredFields 必须含 span response 字段：${spanField}`);
    }
  }
  if (input.spanResponseRequired !== true) {
    return error("invalid_field", `${path}.spanResponseRequired`, "spanResponseRequired 必须为 true");
  }
  if (
    typeof input.dimensionsRequired !== "number" ||
    !Number.isInteger(input.dimensionsRequired) ||
    input.dimensionsRequired < MIN_JUDGE_DIMENSIONS
  ) {
    return error("invalid_field", `${path}.dimensionsRequired`, `dimensionsRequired 必须 >= ${MIN_JUDGE_DIMENSIONS}`);
  }
  return undefined;
}

function validateHumanSchema(input: unknown, path: string): PreregValidationError | undefined {
  if (!isRecord(input)) {
    return error("invalid_field", path, "decisionSchema.human 必须是对象");
  }
  if (!Array.isArray(input.allowedReviewerTypes) || input.allowedReviewerTypes.length === 0) {
    return error("invalid_field", `${path}.allowedReviewerTypes`, "allowedReviewerTypes 必须是非空数组");
  }
  const types = input.allowedReviewerTypes as string[];
  for (const required of ALLOWED_REVIEWER_TYPES) {
    if (!types.includes(required)) {
      return error("invalid_field", `${path}.allowedReviewerTypes`, `allowedReviewerTypes 必须含 ${required}`);
    }
  }
  for (const t of types) {
    if (!ALLOWED_REVIEWER_TYPES.includes(t as (typeof ALLOWED_REVIEWER_TYPES)[number])) {
      return error("invalid_field", `${path}.allowedReviewerTypes`, `allowedReviewerTypes 不允许 ${t}（机器审阅不得冒充 human）`);
    }
  }
  if (input.validatedProxyModel !== VALIDATED_PROXY_MODEL) {
    return error("invalid_field", `${path}.validatedProxyModel`, `validatedProxyModel 必须是 ${VALIDATED_PROXY_MODEL}`);
  }
  if (input.spanResponseRequired !== true) {
    return error("invalid_field", `${path}.spanResponseRequired`, "spanResponseRequired 必须为 true");
  }
  return undefined;
}

function validateDecisionSchema(input: unknown, path: string): PreregValidationError | undefined {
  if (!isRecord(input)) {
    return error("invalid_field", path, "decisionSchema 必须是对象");
  }
  const judgeErr = validateJudgeSchema(input.judge, `${path}.judge`);
  if (judgeErr) return judgeErr;
  const humanErr = validateHumanSchema(input.human, `${path}.human`);
  if (humanErr) return humanErr;
  return undefined;
}

// ============================================================================
// 校验：regression fields
// ============================================================================

function validateRegressionFields(input: unknown, path: string): PreregValidationError | undefined {
  if (!isRecord(input)) {
    return error("invalid_field", path, "regressionFields 必须是对象");
  }
  if (!Array.isArray(input.mustPreserveAcrossArms) || input.mustPreserveAcrossArms.length === 0) {
    return error("invalid_field", `${path}.mustPreserveAcrossArms`, "mustPreserveAcrossArms 必须是非空数组");
  }
  const fields = input.mustPreserveAcrossArms as string[];
  for (const required of REQUIRED_REGRESSION_FIELDS) {
    if (!fields.includes(required)) {
      return error("regression_fields_incomplete", `${path}.mustPreserveAcrossArms`, `mustPreserveAcrossArms 必须含 ${required}`);
    }
  }
  return undefined;
}

// ============================================================================
// 校验：positive signal criteria
// ============================================================================

function validatePositiveSignalCriteria(input: unknown, path: string): PreregValidationError | undefined {
  if (!isRecord(input)) {
    return error("invalid_field", path, "positiveSignalCriteria 必须是对象");
  }
  for (const field of ["singleJudgeNotPositive", "requiresHumanOrProxy", "coSupportRequired", "unclearRetainsRaw"]) {
    const e = requireBoolean(input, field, path);
    if (e) return e;
    if (input[field] !== true) {
      return error("invalid_field", `${path}.${field}`, `${field} 必须为 true`);
    }
  }
  const e = requireString(input, "coSupportDefinition", path);
  if (e) return e;
  return undefined;
}

// ============================================================================
// 主校验函数
// ============================================================================

export function validatePreregistrationArtifact(
  input: unknown
): PreregValidationResult {
  if (!isRecord(input)) {
    return { ok: false, error: error("invalid_root", "$", "preregistration artifact 必须是对象") };
  }
  if (input.schemaId !== EDITORIAL_BENEFIT_PREREG_SCHEMA_ID) {
    return { ok: false, error: error("invalid_schema_id", "schemaId", `schemaId 必须是 ${EDITORIAL_BENEFIT_PREREG_SCHEMA_ID}`) };
  }
  if (input.schemaVersion !== EDITORIAL_BENEFIT_PREREG_SCHEMA_VERSION) {
    return { ok: false, error: error("unsupported_schema_version", "schemaVersion", `仅支持 ${EDITORIAL_BENEFIT_PREREG_SCHEMA_VERSION}`) };
  }
  if (input.taskId !== TASK_ID) {
    return { ok: false, error: error("invalid_field", "taskId", `taskId 必须是 ${TASK_ID}`) };
  }
  if (input.mutationPolicy !== MUTATION_POLICY) {
    return { ok: false, error: error("invalid_field", "mutationPolicy", `mutationPolicy 必须是 ${MUTATION_POLICY}`) };
  }
  if (input.frozenBy !== FROZEN_BY) {
    return { ok: false, error: error("invalid_field", "frozenBy", `frozenBy 必须是 ${FROZEN_BY}`) };
  }
  if (typeof input.frozenAt !== "string" || !Number.isFinite(Date.parse(input.frozenAt))) {
    return { ok: false, error: error("invalid_field", "frozenAt", "frozenAt 必须是有效 ISO 时间") };
  }
  if (input.onlyVariable !== ONLY_VARIABLE) {
    return { ok: false, error: error("invalid_field", "onlyVariable", `onlyVariable 必须是 ${ONLY_VARIABLE}`) };
  }

  const caseErr = validateCaseProvenance(input.caseProvenance, "caseProvenance");
  if (caseErr) return { ok: false, error: caseErr };

  if (!isRecord(input.arms)) {
    return { ok: false, error: error("invalid_field", "arms", "arms 必须是对象") };
  }
  const armKeys = Object.keys(input.arms);
  for (const k of armKeys) {
    if (k !== "advisory_on" && k !== "advisory_off") {
      return { ok: false, error: error("invalid_field", `arms.${k}`, "arms 只允许 advisory_on + advisory_off，不得有第三臂") };
    }
  }
  if (!isRecord(input.arms.advisory_on)) {
    return { ok: false, error: error("invalid_field", "arms.advisory_on", "arms.advisory_on 必须是对象") };
  }
  if (!isRecord(input.arms.advisory_off)) {
    return { ok: false, error: error("invalid_field", "arms.advisory_off", "arms.advisory_off 必须是对象") };
  }
  const onErr = validateArm(input.arms.advisory_on, "arms.advisory_on", true);
  if (onErr) return { ok: false, error: onErr };
  const offErr = validateArm(input.arms.advisory_off, "arms.advisory_off", false);
  if (offErr) return { ok: false, error: offErr };

  const divergenceErr = checkArmConstraintDivergence(
    (input.arms.advisory_on as unknown as Arm).constraint,
    (input.arms.advisory_off as unknown as Arm).constraint
  );
  if (divergenceErr) return { ok: false, error: divergenceErr };

  const budgetErr = validateCallBudget(input.callBudget, "callBudget");
  if (budgetErr) return { ok: false, error: budgetErr };

  const exclErr = validateExclusionRules(input.exclusionRules, "exclusionRules");
  if (exclErr) return { ok: false, error: exclErr };

  const stopErr = validateStopConditions(input.stopConditions, "stopConditions");
  if (stopErr) return { ok: false, error: stopErr };

  const decisionErr = validateDecisionSchema(input.decisionSchema, "decisionSchema");
  if (decisionErr) return { ok: false, error: decisionErr };

  const regressionErr = validateRegressionFields(input.regressionFields, "regressionFields");
  if (regressionErr) return { ok: false, error: regressionErr };

  const positiveErr = validatePositiveSignalCriteria(input.positiveSignalCriteria, "positiveSignalCriteria");
  if (positiveErr) return { ok: false, error: positiveErr };

  return { ok: true, artifact: input as unknown as EditorialBenefitPreregistration };
}

// ============================================================================
// dry-run harness
// ============================================================================

/**
 * 本地 dry-run harness：校验预登记协议完备性，不调用模型。
 *
 * - 默认只校验 artifact schema（不检查 case 文件存在性）
 * - options.checkCaseProvenanceExists=true 时额外校验 case 文件存在 + hash + size 匹配
 * - 任何校验失败都不调用模型（modelCalled 恒为 false）
 *
 * recovery 约束：harness 校验失败不调用模型；结果不清晰保留 raw。
 */
export function runEditorialBenefit2aDryRun(
  input: unknown,
  options: DryRunOptions = {}
): DryRunResult {
  const checks: DryRunCheck[] = [];
  const gaps: DryRunGap[] = [];

  // 1. schema 校验
  const validation = validatePreregistrationArtifact(input);
  checks.push({
    id: "schema_valid",
    label: "预登记 artifact schema 合法",
    passed: validation.ok,
  });
  if (!validation.ok) {
    gaps.push({ checkId: "schema_valid", message: `${validation.error.code}: ${validation.error.message} (path: ${validation.error.path})` });
    return { ok: false, checks, gaps, modelCalled: false };
  }

  const artifact = validation.artifact;

  // 2. case provenance 文件存在性 + hash 匹配（可选）
  if (options.checkCaseProvenanceExists) {
    const casePath = artifact.caseProvenance.sourcePath;
    let fileExists = false;
    let actualSha: string | null = null;
    let actualSize: number | null = null;
    try {
      const stat = statSync(casePath);
      fileExists = true;
      actualSize = stat.size;
      const content = readFileSync(casePath);
      actualSha = createHash("sha256").update(content).digest("hex");
    } catch {
      fileExists = false;
    }
    checks.push({
      id: "case_provenance_exists",
      label: "case provenance 文件存在",
      passed: fileExists,
    });
    if (!fileExists) {
      gaps.push({ checkId: "case_provenance_exists", message: `case provenance 文件不存在：${casePath}` });
      return { ok: false, checks, gaps, modelCalled: false };
    }
    const hashMatch = actualSha === artifact.caseProvenance.sourceSha256;
    checks.push({
      id: "case_provenance_hash",
      label: "case provenance SHA-256 匹配",
      passed: hashMatch,
    });
    if (!hashMatch) {
      gaps.push({
        checkId: "case_provenance_hash",
        message: `case provenance SHA-256 不匹配：expected=${artifact.caseProvenance.sourceSha256}, actual=${actualSha}`,
      });
    }
    if (actualSize !== null && actualSize !== artifact.caseProvenance.sizeBytes) {
      checks.push({
        id: "case_provenance_size",
        label: "case provenance size 匹配",
        passed: false,
      });
      gaps.push({
        checkId: "case_provenance_size",
        message: `case provenance size 不匹配：expected=${artifact.caseProvenance.sizeBytes}, actual=${actualSize}`,
      });
    }
  }

  // 3. 两臂约束一致性（已由 schema 校验覆盖，这里冗余确认）
  const onC = artifact.arms.advisory_on.constraint;
  const offC = artifact.arms.advisory_off.constraint;
  const constraintConsistent =
    onC.modelVersion === offC.modelVersion &&
    onC.seed === offC.seed &&
    onC.rawSha256 === offC.rawSha256 &&
    onC.provenance.orchestratorRunId === offC.provenance.orchestratorRunId;
  checks.push({
    id: "arm_constraint_consistent",
    label: "两臂共享同 raw/model/seed/provenance",
    passed: constraintConsistent,
  });
  if (!constraintConsistent) {
    gaps.push({ checkId: "arm_constraint_consistent", message: "两臂约束不一致（违反唯一变量原则）" });
  }

  const ok = gaps.length === 0;
  return { ok, checks, gaps, modelCalled: false };
}

// ============================================================================
// 授权前检查表
// ============================================================================

/**
 * 构建授权前检查表（reporting 约束）。
 *
 * 8 项检查：case_frozen / only_variable / stop_conditions / call_budget /
 * exclusion_rules / decision_schema / regression_fields / positive_signal_criteria。
 * 任一失败 → allPassed=false，不得授权进入 2B。
 */
export function buildPreAuthorizationChecklist(
  input: unknown
): PreAuthorizationChecklist {
  const validation = validatePreregistrationArtifact(input);
  const items: ChecklistItem[] = [];

  // 用 schema 校验结果 + 字段级检查构建检查表
  const artifact = validation.ok ? validation.artifact : null;

  const caseFrozen = artifact !== null;
  items.push({ id: "case_frozen", label: "case provenance 已冻结（不可事后换 case）", passed: caseFrozen });

  const onlyVariable = artifact !== null && artifact.onlyVariable === ONLY_VARIABLE;
  items.push({ id: "only_variable", label: "唯一变量 = advisory on/off", passed: onlyVariable });

  // stop_conditions：检查 artifact 中 stopConditions 至少一个 true
  let stopConditionsOk = false;
  if (artifact) {
    const sc = artifact.stopConditions;
    stopConditionsOk =
      sc.bothArmsCompleteWithValidCandidate ||
      sc.callBudgetExhausted ||
      sc.modelExceptionOrTimeout ||
      sc.hardBlockOnBothArms;
  }
  items.push({ id: "stop_conditions", label: "停止条件完备", passed: stopConditionsOk });

  // call_budget：检查预算一致（total >= 2*maxPerArm，editorial <= 2）
  let callBudgetOk = false;
  if (artifact) {
    const cb = artifact.callBudget;
    callBudgetOk =
      cb.maxCallsPerArm > 0 &&
      cb.totalBudgetAcrossArms >= 2 * cb.maxCallsPerArm &&
      cb.maxEditorialCandidatesPerArm <= MAX_EDITORIAL_CANDIDATES_PER_ARM;
  }
  items.push({ id: "call_budget", label: "调用预算一致且有界", passed: callBudgetOk });

  // exclusion_rules：检查三类排除规则全部 true
  let exclusionRulesOk = false;
  if (artifact) {
    const er = artifact.exclusionRules;
    exclusionRulesOk =
      er.fallbackRunsExcluded === true &&
      er.noCandidateRunsExcluded === true &&
      er.hardBlockRunsExcluded === true &&
      er.fallbackReason.trim().length > 0 &&
      er.noCandidateReason.trim().length > 0 &&
      er.hardBlockReason.trim().length > 0;
  }
  items.push({ id: "exclusion_rules", label: "排除规则完备（fallback/no-candidate/hard-block）", passed: exclusionRulesOk });

  // decision_schema：检查 judge + human schema
  let decisionSchemaOk = false;
  if (artifact) {
    const j = artifact.decisionSchema.judge;
    const h = artifact.decisionSchema.human;
    decisionSchemaOk =
      j.spanResponseRequired === true &&
      JUDGE_SPAN_FIELDS.every((f) => j.requiredFields.includes(f)) &&
      j.dimensionsRequired >= MIN_JUDGE_DIMENSIONS &&
      h.spanResponseRequired === true &&
      h.validatedProxyModel === VALIDATED_PROXY_MODEL &&
      ALLOWED_REVIEWER_TYPES.every((t) => h.allowedReviewerTypes.includes(t));
  }
  items.push({ id: "decision_schema", label: "judge + human 决策 schema 含 span response", passed: decisionSchemaOk });

  // regression_fields：检查 mustPreserveAcrossArms 含必需字段
  let regressionFieldsOk = false;
  if (artifact) {
    const rf = artifact.regressionFields;
    regressionFieldsOk =
      rf.mustPreserveAcrossArms.length > 0 &&
      REQUIRED_REGRESSION_FIELDS.every((f) => rf.mustPreserveAcrossArms.includes(f));
  }
  items.push({ id: "regression_fields", label: "regression 字段齐全（跨臂不变量）", passed: regressionFieldsOk });

  // positive_signal_criteria：检查四项准则全 true
  let positiveSignalOk = false;
  if (artifact) {
    const p = artifact.positiveSignalCriteria;
    positiveSignalOk =
      p.singleJudgeNotPositive === true &&
      p.requiresHumanOrProxy === true &&
      p.coSupportRequired === true &&
      p.unclearRetainsRaw === true;
  }
  items.push({ id: "positive_signal_criteria", label: "正向信号准则（单裁判不算正向；需 human/proxy）", passed: positiveSignalOk });

  const failedCount = items.filter((i) => !i.passed).length;
  return {
    items,
    summary: {
      allPassed: failedCount === 0,
      failedCount,
    },
  };
}
