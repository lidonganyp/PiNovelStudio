/**
 * HARNESS-LOGGER — 结构化运行日志（HARNESS 套件 5）
 *
 * 定位（与 Trace 的分工，不允许混淆）：
 * - `craft/quality-trace-recorder.ts` 写 `workspaces/{id}/traces/{chapterId}-quality-trace.json`，
 *   是**持久化的章节质量权威证据**；
 * - 本模块只输出**进程级运行日志**（JSON lines 到 stderr），用于排查与运维，
 *   不持久化为章节证据，也**不承载正文**。
 *
 * 不引入 pino/winston：日志只在工具边界等有限位置落地，追加一个重型 logger
 * 依赖与本项目"可回放、零新增依赖"的约束冲突。
 *
 * 正文保护：`text` / `prose` / `draft` 等键一律替换为长度摘要，
 * 防止阻断候选、中间稿或正文通过运行日志外泄。
 */

export type HarnessLogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Readonly<Record<HarnessLogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const BODY_LIKE_KEYS = new Set([
  "text",
  "prose",
  "content",
  "draft",
  "chapterText",
  "rawText",
  "finalText",
  "editedText",
  "userFinalText",
  "deliveredText",
  "candidateText",
  "optimizedText",
]);

/**
 * R05：未知键也可能是正文（例如正文被误填进 `mode` / `writerModel`）。
 * 除正文键名白名单外，任何超长字符串一律降级为长度摘要 + 短预览，
 * 避免 logger 被任意键绕过正文保护。
 */
const MAX_LOG_STRING_CHARS = 512;
const LOG_STRING_PREVIEW = 24;

export interface HarnessLogFields {
  stage?: string;
  gate?: string;
  severity?: string;
  traceId?: string;
  workspaceId?: string;
  chapterId?: string;
  [key: string]: unknown;
}

function resolveThreshold(): HarnessLogLevel {
  const raw = process.env.PINOVEL_HARNESS_LOG_LEVEL?.trim().toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "warn";
}

function redactBodyLike(value: unknown, depth: number): unknown {
  if (depth > 4) return "[depth-limit]";
  if (typeof value === "string") {
    if (value.length <= MAX_LOG_STRING_CHARS) return value;
    const preview = value.slice(0, LOG_STRING_PREVIEW).replace(/\s+/g, " ");
    return `[truncated:length=${value.length},preview=${JSON.stringify(preview)}]`;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactBodyLike(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (BODY_LIKE_KEYS.has(key)) {
      const length = typeof child === "string" ? child.length : Array.isArray(child) ? child.length : 0;
      result[key] = `[redacted:length=${length}]`;
      continue;
    }
    result[key] = redactBodyLike(child, depth + 1);
  }
  return result;
}

/**
 * 输出一条结构化日志。低于阈值直接返回，不产生任何 IO。
 *
 * 日志字段顺序固定为 `ts / level / event`，其后是调用方字段，
 * 便于按 event 名做 grep 与后续聚合。
 */
export function logHarnessEvent(
  level: HarnessLogLevel,
  event: string,
  fields: HarnessLogFields = {},
): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[resolveThreshold()]) return;

  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(redactBodyLike(fields, 0) as Record<string, unknown>),
  };

  try {
    process.stderr.write(`${JSON.stringify(record)}\n`);
  } catch {
    // 日志失败不得影响工具行为。
  }
}
