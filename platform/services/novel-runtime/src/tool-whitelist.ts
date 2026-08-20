/**
 * PI 能力白名单（plan §1 T1-2）
 *
 * Novel Runtime 只允许以下 6 个 PiNovelStudio 公开工具：
 * - novel_generate_chapter（统一主链路唯一入口）
 * - novel_preflight_workspace（生成前预检）
 * - novel_workspace_manager（工作区管理）
 * - novel_plan_story_outline（大纲规划）
 * - novel_strategy_policy_view（Phase 6 策略信誉查看）
 * - novel_strategy_feedback（Phase 6 用户反馈）
 *
 * 明确禁止（来自 plan §1 T1-2 / §1 冻结决策 8）：
 * - Shell 和系统命令
 * - 任意代码执行
 * - 任意路径文件访问
 * - Git 操作
 * - 插件安装
 * - 用户指定 MCP
 * - 用户指定模型或接口地址
 * - 任意 URL 抓取
 * - 动态加载扩展
 *
 * 实现：novel-runtime 加载 PiNovelStudio dist 后，只保留白名单中的工具，
 * 其余一律丢弃。同时维护禁止能力名清单，用于运行时校验。
 */

/** 允许的 6 个工具名（唯一真相源，与 PiNovelStudio register-tools.ts 同步） */
export const ALLOWED_TOOL_NAMES = [
  "novel_generate_chapter",
  "novel_preflight_workspace",
  "novel_workspace_manager",
  "novel_plan_story_outline",
  "novel_strategy_policy_view",
  "novel_strategy_feedback",
] as const;

export type AllowedToolName = (typeof ALLOWED_TOOL_NAMES)[number];

const ALLOWED_SET = new Set<string>(ALLOWED_TOOL_NAMES);

/**
 * 禁止能力名清单——这些名字/前缀若出现在加载的工具中，必须拒绝并告警。
 * 用于检测 PiNovelStudio 是否意外暴露了非小说工具（理论上生产构建不会，
 * 但作为深度防御）。
 */
export const FORBIDDEN_TOOL_PATTERNS = [
  /^shell$/,
  /^bash$/,
  /^exec/,
  /^eval$/,
  /^run_/,
  /^git_/,
  /^file_/,
  /^fs_/,
  /^read_.*file/,
  /^write_.*file/,
  /^delete_/,
  /^install_/,
  /^mcp_/,
  /^plugin_/,
  /^fetch_/,
  /^http_/,
  /^url_/,
  /^network_/,
  /^system_/,
  /^process_/,
  /^cmd_/,
  /^command_/,
] as const;

export interface ToolLike {
  name: string;
  description?: string;
  inputSchema?: unknown;
  invoke?: (input: unknown) => Promise<unknown>;
}

export interface WhitelistFilterResult<T extends ToolLike> {
  /** 通过白名单的工具 */
  allowed: T[];
  /** 被丢弃的工具（不在白名单内） */
  dropped: T[];
  /** 命中禁止模式的工具——安全事件，必须告警 */
  forbidden: Array<{ tool: T; matchedPattern: string }>;
}

/**
 * 过滤工具列表，只保留白名单中的 6 个工具。
 * 同时检测是否命中禁止能力模式（深度防御）。
 */
export function filterToWhitelist<T extends ToolLike>(tools: T[]): WhitelistFilterResult<T> {
  const allowed: T[] = [];
  const dropped: T[] = [];
  const forbidden: Array<{ tool: T; matchedPattern: string }> = [];

  for (const tool of tools) {
    // 1. 检测禁止模式（即使工具名在白名单内，若命中禁止模式也拒绝——防止 PiNovelStudio 被篡改）
    const forbiddenMatch = FORBIDDEN_TOOL_PATTERNS.find((pattern) => pattern.test(tool.name));
    if (forbiddenMatch) {
      forbidden.push({ tool, matchedPattern: forbiddenMatch.source });
      continue;
    }

    // 2. 白名单校验
    if (ALLOWED_SET.has(tool.name)) {
      allowed.push(tool);
    } else {
      dropped.push(tool);
    }
  }

  return { allowed, dropped, forbidden };
}

/**
 * 校验工具名是否在白名单内（用于路由层调用前校验）。
 */
export function isAllowedTool(name: string): boolean {
  return ALLOWED_SET.has(name);
}

/**
 * 校验工具名是否命中禁止能力模式。
 */
export function isForbiddenToolName(name: string): boolean {
  return FORBIDDEN_TOOL_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * 严格断言：加载后必须恰好是 6 个工具，且全部在白名单内，零禁止命中。
 * 用于启动时门禁。
 */
export function assertStrictWhitelist<T extends ToolLike>(tools: T[]): WhitelistFilterResult<T> {
  const result = filterToWhitelist(tools);
  if (result.forbidden.length > 0) {
    const names = result.forbidden.map((f) => f.tool.name).join(", ");
    throw new WhitelistViolationError(
      `FAIL_CLOSED: forbidden capability detected in loaded tools: ${names}. ` +
        `Novel Runtime refuses to start.`,
      "FORBIDDEN_TOOL_DETECTED",
    );
  }
  if (result.allowed.length !== ALLOWED_TOOL_NAMES.length) {
    throw new WhitelistViolationError(
      `FAIL_CLOSED: expected exactly ${ALLOWED_TOOL_NAMES.length} allowed tools, got ${result.allowed.length}. ` +
        `Missing: ${missingTools(result.allowed).join(", ") || "(none)"}.`,
      "WHITELIST_COUNT_MISMATCH",
    );
  }
  return result;
}

function missingTools<T extends ToolLike>(allowed: T[]): string[] {
  const present = new Set(allowed.map((t) => t.name));
  return ALLOWED_TOOL_NAMES.filter((name) => !present.has(name));
}

export class WhitelistViolationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "WhitelistViolationError";
  }
}
