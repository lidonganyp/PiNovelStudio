/**
 * NB-2R：GeneratorCase schema 校验器（生成器进程启动时校验输入无泄漏字段）。
 *
 * 核心原则（任务要求）：
 * - Generator schema must not contain sourcePath, offset, or reference asset paths
 * - uncertain information must be marked unknown; conflicts must be marked conflict
 * - no model补写 or guessing of missing facts
 *
 * 本模块供生成器进程（NB-4）在加载 GeneratorCase JSON 时校验：
 * 1. 必填字段存在且类型正确
 * 2. 无禁止字段（sourcePath / startOffset / endOffset / referenceBody / body / referenceAssetPath / priorChapterRefs / referenceHash / leakageAudit）
 * 3. generationInputPath 为相对路径（不含盘符 / 不以 / 开头）
 * 4. referenceLocator 仅含 referenceId + bodyHash（无 sourcePath）
 *
 * 本模块为 eval-only，由 tsconfig.eval.json 编译到 dist-eval/，不进 dist/。
 * 不得 import reference-registry / reference-analyzer / dataset-builder（架构边界）。
 */

import type {
  GeneratorCase,
  GeneratorSchemaValidation,
  ReferenceLocator,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 禁止字段：generator-facing schema 不得含以下字段。
 * - sourcePath / startOffset / endOffset：reference 定位信息
 * - referenceBody / body：正文
 * - referenceAssetPath：evaluator 资产路径
 * - priorChapterRefs：前章元数据（含 sourcePath）
 * - referenceHash：evaluator 校验用
 * - leakageAudit：dataset-builder 审计结果
 * - datasetVersion：evaluator 元数据
 */
export const FORBIDDEN_FIELDS: readonly string[] = [
  "sourcePath",
  "startOffset",
  "endOffset",
  "referenceBody",
  "body",
  "referenceAssetPath",
  "priorChapterRefs",
  "referenceHash",
  "leakageAudit",
  "datasetVersion",
] as const;

/** GeneratorCase 必填字段 */
const REQUIRED_FIELDS: readonly string[] = [
  "caseId",
  "bookId",
  "genre",
  "mode",
  "targetChapter",
  "generationInputPath",
  "generationInputHash",
  "split",
  "referenceLocator",
  "splitConfidence",
] as const;

/** 合法 split 值 */
const VALID_SPLITS = new Set(["train", "validation", "test"]);

/** 合法 mode 值 */
const VALID_MODES = new Set(["continuation", "realization"]);

// ─────────────────────────────────────────────────────────────────────────────
// 公开 API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 校验对象是否为合法 GeneratorCase（无禁止字段 + 必填字段完整 + 类型正确）。
 *
 * @returns {valid, errors}；valid=true 时 errors 为空
 */
export function validateGeneratorSchema(obj: unknown): GeneratorSchemaValidation {
  const errors: string[] = [];

  if (typeof obj !== "object" || obj === null) {
    return { valid: false, errors: ["root: 必须为对象"] };
  }

  const record = obj as Record<string, unknown>;

  // 1. 禁止字段检查
  for (const forbidden of FORBIDDEN_FIELDS) {
    if (forbidden in record) {
      errors.push(
        `forbidden_field: '${forbidden}' 不得出现在 GeneratorCase（reference-locating / body / evaluator-only）`,
      );
    }
  }

  // 2. 必填字段检查
  for (const required of REQUIRED_FIELDS) {
    if (!(required in record)) {
      errors.push(`missing_field: '${required}' 必填`);
    }
  }

  // 3. 类型与值校验（仅在字段存在时）
  if (typeof record.caseId !== "string" || record.caseId.length === 0) {
    errors.push("invalid_field: caseId 必须为非空字符串");
  }
  if (typeof record.bookId !== "string" || record.bookId.length === 0) {
    errors.push("invalid_field: bookId 必须为非空字符串");
  }
  if (typeof record.genre !== "string" || record.genre.length === 0) {
    errors.push("invalid_field: genre 必须为非空字符串");
  }
  if (typeof record.mode !== "string" || !VALID_MODES.has(record.mode as string)) {
    errors.push(`invalid_field: mode 必须为 continuation|realization，实际 ${JSON.stringify(record.mode)}`);
  }
  if (typeof record.targetChapter !== "number" || !Number.isInteger(record.targetChapter) || record.targetChapter < 0) {
    errors.push(`invalid_field: targetChapter 必须为非负整数，实际 ${JSON.stringify(record.targetChapter)}`);
  }
  if (typeof record.generationInputPath !== "string" || record.generationInputPath.length === 0) {
    errors.push("invalid_field: generationInputPath 必须为非空字符串");
  } else if (!isRelativePath(record.generationInputPath)) {
    errors.push(
      `invalid_field: generationInputPath 必须为相对路径（不含盘符 / 不以 / 开头），实际 ${JSON.stringify(record.generationInputPath)}`,
    );
  }
  if (typeof record.generationInputHash !== "string" || record.generationInputHash.length === 0) {
    errors.push("invalid_field: generationInputHash 必须为非空字符串");
  }
  if (typeof record.split !== "string" || !VALID_SPLITS.has(record.split as string)) {
    errors.push(`invalid_field: split 必须为 train|validation|test，实际 ${JSON.stringify(record.split)}`);
  }
  if (typeof record.splitConfidence !== "number" || record.splitConfidence < 0 || record.splitConfidence > 1) {
    errors.push(`invalid_field: splitConfidence 必须为 0-1 数字，实际 ${JSON.stringify(record.splitConfidence)}`);
  }

  // 4. referenceLocator 校验（仅含 referenceId + bodyHash，无 sourcePath）
  if ("referenceLocator" in record) {
    const locatorErrors = validateReferenceLocator(record.referenceLocator);
    errors.push(...locatorErrors);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 断言对象无禁止字段（不检查必填字段，仅扫描泄漏字段）。
 *
 * 用于生成器进程启动时快速校验输入 JSON 不含 reference-locating 信息。
 * @throws 若含任何禁止字段
 */
export function assertNoLeakageFields(obj: unknown): void {
  if (typeof obj !== "object" || obj === null) return;
  const record = obj as Record<string, unknown>;
  const found: string[] = [];
  for (const forbidden of FORBIDDEN_FIELDS) {
    if (forbidden in record) {
      found.push(forbidden);
    }
  }
  if (found.length > 0) {
    throw new Error(
      `GeneratorCase 泄漏禁止字段：${found.join(", ")}（reference-locating / body / evaluator-only 信息不得进入生成器进程）`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 校验 referenceLocator 仅含 referenceId + bodyHash（无 sourcePath）。
 */
function validateReferenceLocator(locator: unknown): string[] {
  const errors: string[] = [];
  if (typeof locator !== "object" || locator === null) {
    errors.push("invalid_field: referenceLocator 必须为对象");
    return errors;
  }
  const record = locator as Record<string, unknown>;
  if (!("referenceId" in record) || typeof record.referenceId !== "string") {
    errors.push("invalid_field: referenceLocator.referenceId 必须为字符串");
  }
  if (!("bodyHash" in record) || typeof record.bodyHash !== "string") {
    errors.push("invalid_field: referenceLocator.bodyHash 必须为字符串");
  }
  // 严格字段集：仅 referenceId + bodyHash
  const allowed = new Set(["referenceId", "bodyHash"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      errors.push(
        `forbidden_field: referenceLocator.${key} 不得出现（仅允许 referenceId + bodyHash）`,
      );
    }
  }
  return errors;
}

/**
 * 判断路径是否为相对路径（不含盘符 / 不以 / 开头 / 不以 \ 开头）。
 *
 * Windows 绝对路径如 "D:\..." 或 "D:/..." → false
 * Unix 绝对路径如 "/foo/bar" → false
 * 相对路径如 "generation-inputs/case.txt" → true
 */
function isRelativePath(p: string): boolean {
  if (p.length === 0) return false;
  // Windows 盘符：D:\ 或 D:/
  if (/^[a-zA-Z]:[\\/]/.test(p)) return false;
  // Unix 绝对路径
  if (p.startsWith("/")) return false;
  // Windows UNC
  if (p.startsWith("\\\\")) return false;
  return true;
}
