/**
 * TOOL-INPUT-CONTRACT — 工具实参运行期契约校验（HARNESS 套件 2）
 *
 * 为什么不用 `Value.Check`：`register-tools.ts` 的 `inputSchema` 是纯 JSON Schema
 * ({ type, properties, required, enum, items })，而 TypeBox 的 Value 模块只识别
 * TypeBox 生成的形态（TEnum 展开为 anyOf/const），纯 JSON Schema 的 `enum`、
 * `items`、嵌套 `properties` 都不会被校验。因此在工具边界按实际使用的 schema
 * 子集做精确校验，且不引入任何新依赖。
 *
 * 设计边界：
 * - 只校验"形态"（type / enum / required / items / nested properties）。
 * - 不校验 `if` / `then` / `allOf` / `additionalProperties` 等条件约束——
 *   那些属于 handler 内的业务校验，本模块不重复实现。
 * - 未声明的额外字段默认放行（JSON Schema 默认 additionalProperties=true），
 *   因此 `_projectRoot` 等运行时注入字段不会被误判。
 * - 返回结构化 violations，不抛异常；调用方负责转成对模型可读的错误文本。
 */

export type ToolInputViolationKeyword = "type" | "enum" | "required" | "items" | "contract";

export interface ToolInputViolation {
  /** 出错字段路径，如 `/action` 或 `/targetWordCount/min` */
  path: string;
  keyword: ToolInputViolationKeyword;
  expected: string;
  actual: string;
}

export type ToolInputValidationResult =
  | { ok: true }
  | { ok: false; violations: ToolInputViolation[] };

const MAX_DEPTH = 8;
const MAX_ACTUAL_CHARS = 96;
const ACTUAL_STRING_PREVIEW = 24;
const MAX_RENDERED_VIOLATIONS = 12;

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

/**
 * R05：错误定位里的 `actual` 必须有界。
 *
 * 正文可能被误填进 `mode` / `writerModel` 等非正文键；校验器若把整串值写进
 * violations，logger 的正文键保护就会被绕过。这里统一做类型 + 长度 + 有界摘要，
 * 只保留定位所需信息（类型、长度、短预览），绝不回显完整长文本或嵌套结构。
 */
function summarizeActual(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    const length = value.length;
    const collapsed = value.replace(/\s+/g, " ").trim();
    if (length === 0) return "string(len=0)";
    const preview = collapsed.slice(0, ACTUAL_STRING_PREVIEW);
    const suffix = collapsed.length > ACTUAL_STRING_PREVIEW ? "…" : "";
    const summary = `string(len=${length}, preview="${preview}${suffix}")`;
    return summary.length > MAX_ACTUAL_CHARS ? summary.slice(0, MAX_ACTUAL_CHARS) : summary;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return `${typeof value}(${String(value).slice(0, 32)})`;
  }
  if (typeof value === "bigint") return "bigint";
  if (typeof value === "symbol") return "symbol";
  if (Array.isArray(value)) return `array(len=${value.length})`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return `object(keys=${keys.slice(0, 5).join(",") || "none"}, keyCount=${keys.length})`;
  }
  return typeof value;
}

function joinPath(parent: string, key: string | number): string {
  return `${parent}/${String(key)}`;
}

function matchesEnum(schema: Record<string, unknown>, value: unknown): boolean {
  const options = schema.enum;
  if (!Array.isArray(options)) return true;
  return options.some((option) => option === value);
}

function validateNode(
  schema: unknown,
  value: unknown,
  path: string,
  depth: number,
  violations: ToolInputViolation[],
): void {
  if (depth > MAX_DEPTH) return;
  if (!schema || typeof schema !== "object") return;
  const node = schema as Record<string, unknown>;

  const declaredType = typeof node.type === "string" ? node.type : null;
  if (declaredType) {
    switch (declaredType) {
      case "string":
        if (typeof value !== "string") {
          violations.push({ path, keyword: "type", expected: "string", actual: describeValue(value) });
          return;
        }
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          violations.push({ path, keyword: "type", expected: "number", actual: describeValue(value) });
          return;
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          violations.push({ path, keyword: "type", expected: "boolean", actual: describeValue(value) });
          return;
        }
        break;
      case "array":
        if (!Array.isArray(value)) {
          violations.push({ path, keyword: "type", expected: "array", actual: describeValue(value) });
          return;
        }
        if (Array.isArray(node.items)) {
          // tuple 形态本项目未使用，忽略。
        } else if (node.items) {
          value.forEach((item, index) => {
            validateNode(node.items, item, joinPath(path, index), depth + 1, violations);
          });
        }
        return;
      case "object":
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          violations.push({ path, keyword: "type", expected: "object", actual: describeValue(value) });
          return;
        }
        validateObject(node, value as Record<string, unknown>, path, depth, violations);
        return;
      default:
        break;
    }
  }

  if (!matchesEnum(node, value)) {
    violations.push({
      path,
      keyword: "enum",
      expected: (node.enum as unknown[]).map((option) => String(option)).join("|").slice(0, MAX_ACTUAL_CHARS),
      // R05：枚举非法值只保留有界摘要，不回显可能被误填的正文。
      actual: summarizeActual(value),
    });
    return;
  }

  if (value && typeof value === "object" && !Array.isArray(value) && node.properties) {
    validateObject(node, value as Record<string, unknown>, path, depth, violations);
  }
}

function validateObject(
  node: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string,
  depth: number,
  violations: ToolInputViolation[],
): void {
  const properties = node.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [key, childSchema] of Object.entries(properties as Record<string, unknown>)) {
      if (!(key in value)) continue;
      validateNode(childSchema, value[key], joinPath(path, key), depth + 1, violations);
    }
  }

  if (Array.isArray(node.required)) {
    for (const key of node.required as unknown[]) {
      if (typeof key !== "string") continue;
      if (value[key] === undefined || value[key] === null) {
        violations.push({
          path: joinPath(path, key),
          keyword: "required",
          expected: "present",
          actual: "missing",
        });
      }
    }
  }
}

/**
 * 按工具 `inputSchema` 校验实参。
 *
 * 顶层 schema 必须是 `{ type: "object" }`；否则视为无可校验契约，直接放行。
 */
export function validateToolInput(
  schema: unknown,
  input: unknown,
): ToolInputValidationResult {
  if (!schema || typeof schema !== "object") return { ok: true };
  const root = schema as Record<string, unknown>;
  if (root.type !== "object") return { ok: true };

  const violations: ToolInputViolation[] = [];
  validateNode(schema, input, "", 0, violations);
  if (violations.length === 0) return { ok: true };
  return { ok: false, violations };
}

/** 把 violations 渲染成给模型可读的中文提示（不含任何正文内容，整体有界）。 */
export function renderToolInputViolations(
  toolName: string,
  violations: readonly ToolInputViolation[],
): string {
  const shown = violations.slice(0, MAX_RENDERED_VIOLATIONS);
  const detail = shown
    .map((item) => `- ${item.path || "/"}：${item.keyword} 期望 ${item.expected}，实际 ${item.actual}`)
    .join("\n");
  const omitted = violations.length - shown.length;
  const omittedNote = omitted > 0 ? `\n- 另有 ${omitted} 条违规未展开（已截断）` : "";
  return `工具 ${toolName} 的入参不符合输入契约，未执行：\n${detail}${omittedNote}\n请按已声明参数修正后重新调用。`;
}
