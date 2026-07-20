/**
 * Demo4aPrep — B0/B2 层对预登记与本地 harness（DEMO-4A-PREP）
 *
 * 目标（DEMO-4A-PREP 任务书）：
 * - 冻结 B0/B2 输入、provenance、A/B 反向顺序、审阅 schema、预算和停止条件
 * - 不调用模型
 * - 严格串行：4A B0 vs B2 → 4B B2 vs B3 → 4C B3 vs B4
 * - 每次只跑一个预登记层对；同源 provenance、反向顺序、human span verdict 缺一不可
 *
 * 边界（READY_LOCAL）：
 * - 不调用真实模型、不生成章节、不提交状态
 * - 预登记 artifact 一旦冻结不可变（case/层对/预算事后不可换）
 * - dry-run harness 只校验协议完备性，不执行真实层对运行
 * - DECISION 需 natural_person 或 validated_human_proxy 匿名 span verdict
 * - 反向顺序两轮都必须完成（counter position bias）
 * - 单裁判不算正向；不清晰保留 raw（B0）
 *
 * 与 4A-RUN/DECISION、4B/4C 的关系：
 * - 4A-PREP（本模块）：本地预登记 + dry-run 校验
 * - 4A-RUN（REQUIRES_AUTH）：PREP 通过后，独立任务卡运行一个预登记 B0 vs B2 层对
 * - 4A-DECISION（READY_REVIEW）：natural-human 或 validated_human_proxy 匿名 span verdict；
 *   明确正向才解锁 4B
 * - 4B/4C 严格依赖前一层明确正向
 *
 * 模块为 standalone tooling，由 tsconfig.prod.json files 数组单独编译到 dist/。
 * 不依赖 PI Host、不依赖 legacy Stage0-8、不调用模型。
 */

import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

// ============================================================================
// Schema contract
// ============================================================================

export const DEMO_4A_PREREG_SCHEMA_ID = "pinovel.demo-4a-preregistration" as const;
export const DEMO_4A_PREREG_SCHEMA_VERSION = "v1" as const;

const TASK_ID = "DEMO-4A-PREP";
const FROZEN_BY = "DEMO-4A-PREP";
const MUTATION_POLICY = "immutable-after-freeze";
const ONLY_VARIABLE = "layer";
const LAYER_LOWER = "B0";
const LAYER_UPPER = "B2";
const VALIDATED_PROXY_MODEL = "gpt5.6-sol";
const ALLOWED_REVIEWER_TYPES = ["natural_person", "validated_human_proxy"] as const;
const REQUIRED_REGRESSION_FIELDS = [
  "modelVersion",
  "seed",
  "rawSha256",
  "caseId",
  "orchestratorRunId",
];
const REVIEW_SPAN_FIELDS = ["winningSpans", "losingSpans"];
const REQUIRED_PREFERENCE_ENUM = ["B0", "B2", "tie", "undecided"];
const MAX_RUNS_TOTAL = 2;

// ============================================================================
// 类型
// ============================================================================

export interface Demo4aCaseProvenance {
  caseId: string;
  sourcePath: string;
  sourceSha256: string;
  sizeBytes: number;
  orchestratorRunId: string;
  workspaceId: string;
}

export interface Demo4aArmProvenance {
  orchestratorRunId: string;
  caseId: string;
  workspaceId: string;
}

export interface Demo4aArmConstraint {
  modelVersion: string;
  seed: number;
  rawSourcePath: string;
  rawSha256: string;
  provenance: Demo4aArmProvenance;
}

export interface Demo4aLayerPair {
  lower: string;
  upper: string;
}

export interface Demo4aAnonymousMapping {
  A: string;
  B: string;
}

export interface Demo4aReverseOrder {
  enabled: boolean;
  runA: { anonymousMapping: Demo4aAnonymousMapping };
  runB: { anonymousMapping: Demo4aAnonymousMapping };
  bothRunsRequired: boolean;
  reason: string;
}

export interface Demo4aReviewSchema {
  requiredFields: string[];
  preferenceEnum: string[];
  spanResponseRequired: boolean;
  spanFields: string[];
  allowedReviewerTypes: string[];
  validatedProxyModel: string;
  anonymousVerdictRequired: boolean;
}

export interface Demo4aCallBudget {
  maxCallsPerLayer: number;
  maxRunsTotal: number;
  totalBudgetAcrossLayers: number;
}

export interface Demo4aStopConditions {
  bothRunsCompleteWithValidVerdict: boolean;
  callBudgetExhausted: boolean;
  modelExceptionOrTimeout: boolean;
  atLeastOneRunPerArm: boolean;
}

export interface Demo4aExclusionRules {
  fallbackRunsExcluded: boolean;
  hardBlockRunsExcluded: boolean;
  noVerdictRunsExcluded: boolean;
  fallbackReason: string;
  hardBlockReason: string;
  noVerdictReason: string;
}

export interface Demo4aRegressionFields {
  mustPreserveAcrossArms: string[];
}

export interface Demo4aPositiveSignalCriteria {
  singleJudgeNotPositive: boolean;
  requiresHumanOrProxy: boolean;
  coSupportRequired: boolean;
  coSupportDefinition: string;
  unclearRetainsRaw: boolean;
}

export interface Demo4aSerialGate {
  currentGate: string;
  nextGate: string;
  nextGateCondition: string;
}

export interface Demo4aPreregistration {
  schemaId: typeof DEMO_4A_PREREG_SCHEMA_ID;
  schemaVersion: typeof DEMO_4A_PREREG_SCHEMA_VERSION;
  taskId: string;
  frozenAt: string;
  frozenBy: string;
  mutationPolicy: string;
  caseProvenance: Demo4aCaseProvenance;
  layerPair: Demo4aLayerPair;
  onlyVariable: string;
  armConstraints: {
    B0: Demo4aArmConstraint;
    B2: Demo4aArmConstraint;
  };
  reverseOrder: Demo4aReverseOrder;
  reviewSchema: Demo4aReviewSchema;
  callBudget: Demo4aCallBudget;
  stopConditions: Demo4aStopConditions;
  exclusionRules: Demo4aExclusionRules;
  regressionFields: Demo4aRegressionFields;
  positiveSignalCriteria: Demo4aPositiveSignalCriteria;
  serialGate: Demo4aSerialGate;
}

// ============================================================================
// 校验错误
// ============================================================================

export type Demo4aValidationErrorCode =
  | "invalid_root"
  | "invalid_schema_id"
  | "unsupported_schema_version"
  | "invalid_field"
  | "arm_constraint_divergence"
  | "budget_inconsistent"
  | "stop_conditions_empty"
  | "regression_fields_incomplete"
  | "reverse_order_not_inverted"
  | "reverse_order_layer_mismatch";

export interface Demo4aValidationError {
  code: Demo4aValidationErrorCode;
  path: string;
  message: string;
}

export type Demo4aValidationResult =
  | { ok: true; artifact: Demo4aPreregistration }
  | { ok: false; error: Demo4aValidationError };

// ============================================================================
// dry-run 类型
// ============================================================================

export interface Demo4aDryRunCheck {
  id: string;
  label: string;
  passed: boolean;
}

export interface Demo4aDryRunGap {
  checkId: string;
  message: string;
}

export interface Demo4aDryRunResult {
  ok: boolean;
  checks: Demo4aDryRunCheck[];
  gaps: Demo4aDryRunGap[];
  /** 恒为 false：dry-run 不调用模型 */
  modelCalled: false;
}

export interface Demo4aDryRunOptions {
  /**
   * 是否检查 case provenance 文件存在性 + hash 匹配。
   * 默认 false：4A-PREP 只冻结协议，不要求 case 文件在本地可访问；
   * 4A-RUN 真实运行时再校验。
   */
  checkCaseProvenanceExists?: boolean;
}

// ============================================================================
// 授权前检查表类型
// ============================================================================

export interface Demo4aChecklistItem {
  id: string;
  label: string;
  passed: boolean;
}

export interface Demo4aPreAuthorizationChecklist {
  items: Demo4aChecklistItem[];
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

function err(
  code: Demo4aValidationErrorCode,
  path: string,
  message: string
): Demo4aValidationError {
  return { code, path, message };
}

function requireString(
  record: Record<string, unknown>,
  field: string,
  path: string
): Demo4aValidationError | undefined {
  if (typeof record[field] !== "string" || (record[field] as string).trim().length === 0) {
    return err("invalid_field", `${path}.${field}`, `${field} 必须是非空字符串`);
  }
  return undefined;
}

function requireBoolean(
  record: Record<string, unknown>,
  field: string,
  path: string
): Demo4aValidationError | undefined {
  if (typeof record[field] !== "boolean") {
    return err("invalid_field", `${path}.${field}`, `${field} 必须是 boolean`);
  }
  return undefined;
}

function requirePositiveInt(
  record: Record<string, unknown>,
  field: string,
  path: string
): Demo4aValidationError | undefined {
  if (
    typeof record[field] !== "number" ||
    !Number.isFinite(record[field]) ||
    !Number.isInteger(record[field]) ||
    record[field] <= 0
  ) {
    return err("invalid_field", `${path}.${field}`, `${field} 必须是正整数`);
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
): Demo4aValidationError | undefined {
  if (!isRecord(input)) {
    return err("invalid_field", path, "caseProvenance 必须是对象");
  }
  for (const field of ["caseId", "sourcePath", "orchestratorRunId", "workspaceId"]) {
    const e = requireString(input, field, path);
    if (e) return e;
  }
  if (typeof input.sourceSha256 !== "string" || !HEX64.test(input.sourceSha256)) {
    return err("invalid_field", `${path}.sourceSha256`, "sourceSha256 必须是 64 位 hex");
  }
  if (
    typeof input.sizeBytes !== "number" ||
    !Number.isFinite(input.sizeBytes) ||
    !Number.isInteger(input.sizeBytes) ||
    input.sizeBytes <= 0
  ) {
    return err("invalid_field", `${path}.sizeBytes`, "sizeBytes 必须是正整数");
  }
  return undefined;
}

// ============================================================================
// 校验：arm constraint
// ============================================================================

function validateArmConstraint(
  input: unknown,
  path: string
): Demo4aValidationError | undefined {
  if (!isRecord(input)) {
    return err("invalid_field", path, "arm constraint 必须是对象");
  }
  for (const field of ["modelVersion", "rawSourcePath", "rawSha256"]) {
    const e = requireString(input, field, path);
    if (e) return e;
  }
  if (typeof input.rawSha256 !== "string" || !HEX64.test(input.rawSha256)) {
    return err("invalid_field", `${path}.rawSha256`, "rawSha256 必须是 64 位 hex");
  }
  if (
    typeof input.seed !== "number" ||
    !Number.isFinite(input.seed) ||
    !Number.isInteger(input.seed) ||
    input.seed < 0
  ) {
    return err("invalid_field", `${path}.seed`, "seed 必须是非负整数");
  }
  if (!isRecord(input.provenance)) {
    return err("invalid_field", `${path}.provenance`, "provenance 必须是对象");
  }
  for (const field of ["orchestratorRunId", "caseId", "workspaceId"]) {
    const e = requireString(
      input.provenance as Record<string, unknown>,
      field,
      `${path}.provenance`
    );
    if (e) return e;
  }
  return undefined;
}

// ============================================================================
// 校验：两臂约束一致性（同源 provenance）
// ============================================================================

function checkArmConstraintDivergence(
  b0: Demo4aArmConstraint,
  b2: Demo4aArmConstraint
): Demo4aValidationError | undefined {
  if (b0.modelVersion !== b2.modelVersion) return err("arm_constraint_divergence", "armConstraints", "两臂 modelVersion 必须一致（同源 provenance）");
  if (b0.seed !== b2.seed) return err("arm_constraint_divergence", "armConstraints", "两臂 seed 必须一致");
  if (b0.rawSha256 !== b2.rawSha256) return err("arm_constraint_divergence", "armConstraints", "两臂 rawSha256 必须一致");
  if (b0.provenance.orchestratorRunId !== b2.provenance.orchestratorRunId) return err("arm_constraint_divergence", "armConstraints", "两臂 provenance.orchestratorRunId 必须一致（同源 provenance）");
  if (b0.provenance.caseId !== b2.provenance.caseId) return err("arm_constraint_divergence", "armConstraints", "两臂 provenance.caseId 必须一致（同源 provenance）");
  if (b0.provenance.workspaceId !== b2.provenance.workspaceId) return err("arm_constraint_divergence", "armConstraints", "两臂 provenance.workspaceId 必须一致");
  return undefined;
}

// ============================================================================
// 校验：reverse order（A/B 反向顺序）
// ============================================================================

function validateAnonymousMapping(
  input: unknown,
  path: string
): Demo4aValidationError | undefined {
  if (!isRecord(input)) {
    return err("invalid_field", path, "anonymousMapping 必须是对象");
  }
  if (typeof input.A !== "string" || typeof input.B !== "string") {
    return err("invalid_field", path, "anonymousMapping.A 和 .B 必须是字符串");
  }
  return undefined;
}

function validateReverseOrder(
  input: unknown,
  path: string
): Demo4aValidationError | undefined {
  if (!isRecord(input)) {
    return err("invalid_field", path, "reverseOrder 必须是对象");
  }
  const enabledErr = requireBoolean(input, "enabled", path);
  if (enabledErr) return enabledErr;
  if (input.enabled !== true) {
    return err("invalid_field", `${path}.enabled`, "enabled 必须为 true（反向顺序缺一不可）");
  }
  const bothErr = requireBoolean(input, "bothRunsRequired", path);
  if (bothErr) return bothErr;
  if (input.bothRunsRequired !== true) {
    return err("invalid_field", `${path}.bothRunsRequired`, "bothRunsRequired 必须为 true（两轮缺一不可）");
  }
  const reasonErr = requireString(input, "reason", path);
  if (reasonErr) return reasonErr;
  if (!isRecord(input.runA)) {
    return err("invalid_field", `${path}.runA`, "runA 必须是对象");
  }
  if (!isRecord(input.runB)) {
    return err("invalid_field", `${path}.runB`, "runB 必须是对象");
  }
  const runAErr = validateAnonymousMapping(input.runA.anonymousMapping, `${path}.runA.anonymousMapping`);
  if (runAErr) return runAErr;
  const runBErr = validateAnonymousMapping(input.runB.anonymousMapping, `${path}.runB.anonymousMapping`);
  if (runBErr) return runBErr;

  const mapA = input.runA.anonymousMapping as Demo4aAnonymousMapping;
  const mapB = input.runB.anonymousMapping as Demo4aAnonymousMapping;

  // 必须覆盖 B0 + B2
  const valuesA = [mapA.A, mapA.B];
  const valuesB = [mapB.A, mapB.B];
  const layerSet = new Set([LAYER_LOWER, LAYER_UPPER]);
  const coversB0B2 = (vals: string[]) =>
    vals.length === 2 &&
    vals.includes(LAYER_LOWER) &&
    vals.includes(LAYER_UPPER) &&
    vals[0] !== vals[1];
  if (!coversB0B2(valuesA) || !coversB0B2(valuesB)) {
    return err("reverse_order_layer_mismatch", path, "anonymousMapping 必须覆盖 B0 和 B2");
  }

  // 互为反向：runB.A = runA.B, runB.B = runA.A
  if (mapB.A !== mapA.B || mapB.B !== mapA.A) {
    return err("reverse_order_not_inverted", path, "runA 和 runB 的 anonymousMapping 必须互为反向（counter position bias）");
  }
  return undefined;
}

// ============================================================================
// 校验：review schema
// ============================================================================

function validateReviewSchema(
  input: unknown,
  path: string
): Demo4aValidationError | undefined {
  if (!isRecord(input)) {
    return err("invalid_field", path, "reviewSchema 必须是对象");
  }
  if (!Array.isArray(input.requiredFields) || input.requiredFields.length === 0) {
    return err("invalid_field", `${path}.requiredFields`, "requiredFields 必须是非空数组");
  }
  for (const spanField of REVIEW_SPAN_FIELDS) {
    if (!(input.requiredFields as string[]).includes(spanField)) {
      return err("invalid_field", `${path}.requiredFields`, `requiredFields 必须含 span response 字段：${spanField}`);
    }
  }
  if (input.spanResponseRequired !== true) {
    return err("invalid_field", `${path}.spanResponseRequired`, "spanResponseRequired 必须为 true");
  }
  if (!Array.isArray(input.preferenceEnum)) {
    return err("invalid_field", `${path}.preferenceEnum`, "preferenceEnum 必须是数组");
  }
  for (const p of REQUIRED_PREFERENCE_ENUM) {
    if (!(input.preferenceEnum as string[]).includes(p)) {
      return err("invalid_field", `${path}.preferenceEnum`, `preferenceEnum 必须含 ${p}`);
    }
  }
  if (!Array.isArray(input.allowedReviewerTypes) || input.allowedReviewerTypes.length === 0) {
    return err("invalid_field", `${path}.allowedReviewerTypes`, "allowedReviewerTypes 必须是非空数组");
  }
  const types = input.allowedReviewerTypes as string[];
  for (const required of ALLOWED_REVIEWER_TYPES) {
    if (!types.includes(required)) {
      return err("invalid_field", `${path}.allowedReviewerTypes`, `allowedReviewerTypes 必须含 ${required}`);
    }
  }
  for (const t of types) {
    if (!ALLOWED_REVIEWER_TYPES.includes(t as (typeof ALLOWED_REVIEWER_TYPES)[number])) {
      return err("invalid_field", `${path}.allowedReviewerTypes`, `allowedReviewerTypes 不允许 ${t}（机器审阅不得冒充 human）`);
    }
  }
  if (input.validatedProxyModel !== VALIDATED_PROXY_MODEL) {
    return err("invalid_field", `${path}.validatedProxyModel`, `validatedProxyModel 必须是 ${VALIDATED_PROXY_MODEL}`);
  }
  if (input.anonymousVerdictRequired !== true) {
    return err("invalid_field", `${path}.anonymousVerdictRequired`, "anonymousVerdictRequired 必须为 true（匿名裁决）");
  }
  return undefined;
}

// ============================================================================
// 校验：call budget
// ============================================================================

function validateCallBudget(
  input: unknown,
  path: string
): Demo4aValidationError | undefined {
  if (!isRecord(input)) {
    return err("invalid_field", path, "callBudget 必须是对象");
  }
  const maxErr = requirePositiveInt(input, "maxCallsPerLayer", path);
  if (maxErr) return maxErr;
  const totalErr = requirePositiveInt(input, "totalBudgetAcrossLayers", path);
  if (totalErr) return totalErr;
  if (
    typeof input.maxRunsTotal !== "number" ||
    !Number.isInteger(input.maxRunsTotal) ||
    input.maxRunsTotal !== MAX_RUNS_TOTAL
  ) {
    return err(
      "budget_inconsistent",
      `${path}.maxRunsTotal`,
      `maxRunsTotal 必须 = ${MAX_RUNS_TOTAL}（runA + runB）`
    );
  }
  const maxPerLayer = input.maxCallsPerLayer as number;
  const total = input.totalBudgetAcrossLayers as number;
  if (total < 2 * maxPerLayer) {
    return err(
      "budget_inconsistent",
      `${path}.totalBudgetAcrossLayers`,
      `totalBudgetAcrossLayers(${total}) 必须 >= 2 * maxCallsPerLayer(${maxPerLayer})`
    );
  }
  return undefined;
}

// ============================================================================
// 校验：stop conditions
// ============================================================================

function validateStopConditions(
  input: unknown,
  path: string
): Demo4aValidationError | undefined {
  if (!isRecord(input)) {
    return err("invalid_field", path, "stopConditions 必须是对象");
  }
  const fields = [
    "bothRunsCompleteWithValidVerdict",
    "callBudgetExhausted",
    "modelExceptionOrTimeout",
    "atLeastOneRunPerArm",
  ];
  for (const field of fields) {
    const e = requireBoolean(input, field, path);
    if (e) return e;
  }
  const anyTrue = fields.some((f) => input[f] === true);
  if (!anyTrue) {
    return err("stop_conditions_empty", path, "stopConditions 至少一个为 true，否则永不停止");
  }
  return undefined;
}

// ============================================================================
// 校验：exclusion rules
// ============================================================================

function validateExclusionRules(
  input: unknown,
  path: string
): Demo4aValidationError | undefined {
  if (!isRecord(input)) {
    return err("invalid_field", path, "exclusionRules 必须是对象");
  }
  for (const field of [
    "fallbackRunsExcluded",
    "hardBlockRunsExcluded",
    "noVerdictRunsExcluded",
  ]) {
    const e = requireBoolean(input, field, path);
    if (e) return e;
    if (input[field] !== true) {
      return err("invalid_field", `${path}.${field}`, `${field} 必须为 true`);
    }
  }
  for (const field of ["fallbackReason", "hardBlockReason", "noVerdictReason"]) {
    const e = requireString(input, field, path);
    if (e) return e;
  }
  return undefined;
}

// ============================================================================
// 校验：regression fields
// ============================================================================

function validateRegressionFields(
  input: unknown,
  path: string
): Demo4aValidationError | undefined {
  if (!isRecord(input)) {
    return err("invalid_field", path, "regressionFields 必须是对象");
  }
  if (!Array.isArray(input.mustPreserveAcrossArms) || input.mustPreserveAcrossArms.length === 0) {
    return err("invalid_field", `${path}.mustPreserveAcrossArms`, "mustPreserveAcrossArms 必须是非空数组");
  }
  const fields = input.mustPreserveAcrossArms as string[];
  for (const required of REQUIRED_REGRESSION_FIELDS) {
    if (!fields.includes(required)) {
      return err("regression_fields_incomplete", `${path}.mustPreserveAcrossArms`, `mustPreserveAcrossArms 必须含 ${required}`);
    }
  }
  return undefined;
}

// ============================================================================
// 校验：positive signal criteria
// ============================================================================

function validatePositiveSignalCriteria(
  input: unknown,
  path: string
): Demo4aValidationError | undefined {
  if (!isRecord(input)) {
    return err("invalid_field", path, "positiveSignalCriteria 必须是对象");
  }
  for (const field of [
    "singleJudgeNotPositive",
    "requiresHumanOrProxy",
    "coSupportRequired",
    "unclearRetainsRaw",
  ]) {
    const e = requireBoolean(input, field, path);
    if (e) return e;
    if (input[field] !== true) {
      return err("invalid_field", `${path}.${field}`, `${field} 必须为 true`);
    }
  }
  const defErr = requireString(input, "coSupportDefinition", path);
  if (defErr) return defErr;
  if (!/B2\s*>\s*B0/.test(input.coSupportDefinition as string)) {
    return err("invalid_field", `${path}.coSupportDefinition`, "coSupportDefinition 必须含 B2 > B0");
  }
  return undefined;
}

// ============================================================================
// 校验：serial gate
// ============================================================================

function validateSerialGate(
  input: unknown,
  path: string
): Demo4aValidationError | undefined {
  if (!isRecord(input)) {
    return err("invalid_field", path, "serialGate 必须是对象");
  }
  if (input.currentGate !== "DEMO-4A") {
    return err("invalid_field", `${path}.currentGate`, "currentGate 必须是 DEMO-4A");
  }
  if (input.nextGate !== "DEMO-4B-PREP") {
    return err("invalid_field", `${path}.nextGate`, "nextGate 必须是 DEMO-4B-PREP");
  }
  const condErr = requireString(input, "nextGateCondition", path);
  if (condErr) return condErr;
  return undefined;
}

// ============================================================================
// 主校验函数
// ============================================================================

export function validateDemo4aPreregistration(
  input: unknown
): Demo4aValidationResult {
  if (!isRecord(input)) {
    return { ok: false, error: err("invalid_root", "$", "preregistration artifact 必须是对象") };
  }
  if (input.schemaId !== DEMO_4A_PREREG_SCHEMA_ID) {
    return { ok: false, error: err("invalid_schema_id", "schemaId", `schemaId 必须是 ${DEMO_4A_PREREG_SCHEMA_ID}`) };
  }
  if (input.schemaVersion !== DEMO_4A_PREREG_SCHEMA_VERSION) {
    return { ok: false, error: err("unsupported_schema_version", "schemaVersion", `仅支持 ${DEMO_4A_PREREG_SCHEMA_VERSION}`) };
  }
  if (input.taskId !== TASK_ID) {
    return { ok: false, error: err("invalid_field", "taskId", `taskId 必须是 ${TASK_ID}`) };
  }
  if (input.mutationPolicy !== MUTATION_POLICY) {
    return { ok: false, error: err("invalid_field", "mutationPolicy", `mutationPolicy 必须是 ${MUTATION_POLICY}`) };
  }
  if (input.frozenBy !== FROZEN_BY) {
    return { ok: false, error: err("invalid_field", "frozenBy", `frozenBy 必须是 ${FROZEN_BY}`) };
  }
  if (typeof input.frozenAt !== "string" || !Number.isFinite(Date.parse(input.frozenAt))) {
    return { ok: false, error: err("invalid_field", "frozenAt", "frozenAt 必须是有效 ISO 时间") };
  }
  if (input.onlyVariable !== ONLY_VARIABLE) {
    return { ok: false, error: err("invalid_field", "onlyVariable", `onlyVariable 必须是 ${ONLY_VARIABLE}`) };
  }

  const caseErr = validateCaseProvenance(input.caseProvenance, "caseProvenance");
  if (caseErr) return { ok: false, error: caseErr };

  if (!isRecord(input.layerPair)) {
    return { ok: false, error: err("invalid_field", "layerPair", "layerPair 必须是对象") };
  }
  if (input.layerPair.lower !== LAYER_LOWER) {
    return { ok: false, error: err("invalid_field", "layerPair.lower", `layerPair.lower 必须是 ${LAYER_LOWER}`) };
  }
  if (input.layerPair.upper !== LAYER_UPPER) {
    return { ok: false, error: err("invalid_field", "layerPair.upper", `layerPair.upper 必须是 ${LAYER_UPPER}（4A 只冻结 B0 vs B2）`) };
  }

  if (!isRecord(input.armConstraints)) {
    return { ok: false, error: err("invalid_field", "armConstraints", "armConstraints 必须是对象") };
  }
  const armKeys = Object.keys(input.armConstraints);
  for (const k of armKeys) {
    if (k !== "B0" && k !== "B2") {
      return { ok: false, error: err("invalid_field", `armConstraints.${k}`, "armConstraints 只允许 B0 + B2，不得有第三层") };
    }
  }
  if (!isRecord(input.armConstraints.B0)) {
    return { ok: false, error: err("invalid_field", "armConstraints.B0", "armConstraints.B0 必须是对象") };
  }
  if (!isRecord(input.armConstraints.B2)) {
    return { ok: false, error: err("invalid_field", "armConstraints.B2", "armConstraints.B2 必须是对象") };
  }
  const b0Err = validateArmConstraint(input.armConstraints.B0, "armConstraints.B0");
  if (b0Err) return { ok: false, error: b0Err };
  const b2Err = validateArmConstraint(input.armConstraints.B2, "armConstraints.B2");
  if (b2Err) return { ok: false, error: b2Err };

  const divergenceErr = checkArmConstraintDivergence(
    (input.armConstraints.B0 as unknown as Demo4aArmConstraint),
    (input.armConstraints.B2 as unknown as Demo4aArmConstraint)
  );
  if (divergenceErr) return { ok: false, error: divergenceErr };

  const reverseErr = validateReverseOrder(input.reverseOrder, "reverseOrder");
  if (reverseErr) return { ok: false, error: reverseErr };

  const reviewErr = validateReviewSchema(input.reviewSchema, "reviewSchema");
  if (reviewErr) return { ok: false, error: reviewErr };

  const budgetErr = validateCallBudget(input.callBudget, "callBudget");
  if (budgetErr) return { ok: false, error: budgetErr };

  const stopErr = validateStopConditions(input.stopConditions, "stopConditions");
  if (stopErr) return { ok: false, error: stopErr };

  const exclErr = validateExclusionRules(input.exclusionRules, "exclusionRules");
  if (exclErr) return { ok: false, error: exclErr };

  const regressionErr = validateRegressionFields(input.regressionFields, "regressionFields");
  if (regressionErr) return { ok: false, error: regressionErr };

  const positiveErr = validatePositiveSignalCriteria(input.positiveSignalCriteria, "positiveSignalCriteria");
  if (positiveErr) return { ok: false, error: positiveErr };

  const gateErr = validateSerialGate(input.serialGate, "serialGate");
  if (gateErr) return { ok: false, error: gateErr };

  return { ok: true, artifact: input as unknown as Demo4aPreregistration };
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
 */
export function runDemo4aDryRun(
  input: unknown,
  options: Demo4aDryRunOptions = {}
): Demo4aDryRunResult {
  const checks: Demo4aDryRunCheck[] = [];
  const gaps: Demo4aDryRunGap[] = [];

  const validation = validateDemo4aPreregistration(input);
  checks.push({
    id: "schema_valid",
    label: "预登记 artifact schema 合法",
    passed: validation.ok,
  });
  if (!validation.ok) {
    gaps.push({
      checkId: "schema_valid",
      message: `${validation.error.code}: ${validation.error.message} (path: ${validation.error.path})`,
    });
    return { ok: false, checks, gaps, modelCalled: false };
  }

  const artifact = validation.artifact;

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

  const ok = gaps.length === 0;
  return { ok, checks, gaps, modelCalled: false };
}

// ============================================================================
// 授权前检查表
// ============================================================================

/**
 * 构建授权前检查表（reporting 约束）。
 *
 * 8 项检查：case_frozen / layer_pair_frozen / reverse_order / review_schema /
 * call_budget / stop_conditions / exclusion_rules / positive_signal_criteria。
 * 任一失败 → allPassed=false，不得授权进入 4A-RUN。
 */
export function buildDemo4aPreAuthorizationChecklist(
  input: unknown
): Demo4aPreAuthorizationChecklist {
  const validation = validateDemo4aPreregistration(input);
  const items: Demo4aChecklistItem[] = [];
  const artifact = validation.ok ? validation.artifact : null;

  items.push({
    id: "case_frozen",
    label: "case provenance 已冻结（不可事后换 case）",
    passed: artifact !== null,
  });

  const layerPairOk =
    artifact !== null &&
    artifact.layerPair.lower === LAYER_LOWER &&
    artifact.layerPair.upper === LAYER_UPPER;
  items.push({
    id: "layer_pair_frozen",
    label: "层对冻结 = B0 vs B2",
    passed: layerPairOk,
  });

  const reverseOk =
    artifact !== null &&
    artifact.reverseOrder.enabled === true &&
    artifact.reverseOrder.bothRunsRequired === true &&
    artifact.reverseOrder.runA.anonymousMapping.A === artifact.reverseOrder.runB.anonymousMapping.B &&
    artifact.reverseOrder.runA.anonymousMapping.B === artifact.reverseOrder.runB.anonymousMapping.A;
  items.push({
    id: "reverse_order",
    label: "A/B 反向顺序（两轮互为反向，缺一不可）",
    passed: reverseOk,
  });

  const reviewOk =
    artifact !== null &&
    artifact.reviewSchema.spanResponseRequired === true &&
    REVIEW_SPAN_FIELDS.every((f) => artifact.reviewSchema.requiredFields.includes(f)) &&
    artifact.reviewSchema.anonymousVerdictRequired === true &&
    artifact.reviewSchema.validatedProxyModel === VALIDATED_PROXY_MODEL &&
    ALLOWED_REVIEWER_TYPES.every((t) => artifact.reviewSchema.allowedReviewerTypes.includes(t));
  items.push({
    id: "review_schema",
    label: "审阅 schema 含匿名 span verdict",
    passed: reviewOk,
  });

  const budgetOk =
    artifact !== null &&
    artifact.callBudget.maxCallsPerLayer > 0 &&
    artifact.callBudget.maxRunsTotal === MAX_RUNS_TOTAL &&
    artifact.callBudget.totalBudgetAcrossLayers >= 2 * artifact.callBudget.maxCallsPerLayer;
  items.push({
    id: "call_budget",
    label: "调用预算一致且有界",
    passed: budgetOk,
  });

  const stopOk =
    artifact !== null &&
    (artifact.stopConditions.bothRunsCompleteWithValidVerdict ||
      artifact.stopConditions.callBudgetExhausted ||
      artifact.stopConditions.modelExceptionOrTimeout ||
      artifact.stopConditions.atLeastOneRunPerArm);
  items.push({
    id: "stop_conditions",
    label: "停止条件完备",
    passed: stopOk,
  });

  const exclOk =
    artifact !== null &&
    artifact.exclusionRules.fallbackRunsExcluded === true &&
    artifact.exclusionRules.hardBlockRunsExcluded === true &&
    artifact.exclusionRules.noVerdictRunsExcluded === true &&
    artifact.exclusionRules.fallbackReason.trim().length > 0 &&
    artifact.exclusionRules.hardBlockReason.trim().length > 0 &&
    artifact.exclusionRules.noVerdictReason.trim().length > 0;
  items.push({
    id: "exclusion_rules",
    label: "排除规则完备（fallback/hardBlock/noVerdict）",
    passed: exclOk,
  });

  const positiveOk =
    artifact !== null &&
    artifact.positiveSignalCriteria.singleJudgeNotPositive === true &&
    artifact.positiveSignalCriteria.requiresHumanOrProxy === true &&
    artifact.positiveSignalCriteria.coSupportRequired === true &&
    artifact.positiveSignalCriteria.unclearRetainsRaw === true;
  items.push({
    id: "positive_signal_criteria",
    label: "正向信号准则（单裁判不算正向；需 human/proxy；不清晰保留 raw）",
    passed: positiveOk,
  });

  const failedCount = items.filter((i) => !i.passed).length;
  return {
    items,
    summary: {
      allPassed: failedCount === 0,
      failedCount,
    },
  };
}
