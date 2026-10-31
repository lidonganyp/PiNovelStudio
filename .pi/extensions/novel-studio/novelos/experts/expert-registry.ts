/**
 * PiNovelStudio — 专家群注册表（EXPERT-GROUP-R10/R11/R12/R13/R18）
 *
 * 目标：把 `.pi/agents/<role>.md` 变成**可发现、可校验、可审计**的角色定义，
 * 供项目内最小派发器（expert-dispatcher.ts）与离线测试消费。
 *
 * 设计约束：
 *  - 不注册任何公开工具、不成为第二章节生成入口；本模块只做磁盘读取与校验。
 *  - 不新增第三方依赖：frontmatter 使用最小 YAML 子集解析（标量 / 列表 / 块字符串 / 单层映射）。
 *  - fail-closed：未知角色、未知工具、写权限工具、路径逃逸、缺失领域资料都是 error，
 *    注册表 `ok=false` 时调用方不得派发。
 *  - 专家 Prompt 必须是项目规定的五要素结构【角色】【指令】【约束】【示例】【输出格式】。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** PI 内置只读工具的实际注册名（小写）。`write/edit/bash` 等写权限工具不在白名单。 */
export const EXPERT_READ_ONLY_PI_TOOLS = ["read", "grep", "find", "ls"] as const;

/** 项目公开的 6 个 novel_* 工具（唯一章节生成入口在内，但对专家一律禁止）。 */
export const NOVEL_PUBLIC_TOOL_NAMES = [
  "novel_generate_chapter",
  "novel_preflight_workspace",
  "novel_workspace_manager",
  "novel_plan_story_outline",
  "novel_strategy_policy_view",
  "novel_strategy_feedback",
] as const;

/** 任何专家都不得持有的工具：写文件、执行命令、以及唯一章节生成入口。 */
export const EXPERT_FORBIDDEN_TOOLS = [
  "write",
  "edit",
  "bash",
  "shell",
  "delete",
  "task",
  "novel_generate_chapter",
] as const;

/**
 * 带写入/落盘语义的 novel_* 工具（R18 权限修正）：专家一律不得持有。
 *  - `novel_plan_story_outline` 会写入 `series/outline.md`；
 *  - `novel_strategy_feedback` 会写入策略信誉库；
 * 专家只产出提案，落盘/提交由父代理执行（pending_parent_action）。
 */
export const EXPERT_WRITE_TOOLS = ["novel_plan_story_outline", "novel_strategy_feedback"] as const;

/** 专家可用工具白名单 = 只读内置工具 + 只读/零写入的 novel_* 工具。 */
export const EXPERT_ALLOWED_TOOLS: ReadonlySet<string> = new Set<string>([
  ...EXPERT_READ_ONLY_PI_TOOLS,
  "novel_preflight_workspace",
  "novel_workspace_manager",
  "novel_strategy_policy_view",
]);

/**
 * 带 action 子操作的工具：专家只允许明确只读/零写入的 action，其余 fail-closed。
 * `novel_workspace_manager` 的 init / switch / proxy_finalization / ingest_reader_feedback /
 * record_return_chapter / handoff_chapter_contract 都会写盘或提交状态，不得由专家执行。
 */
export const EXPERT_ALLOWED_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  novel_workspace_manager: new Set(["list", "info", "chapters", "list_experts", "dispatch_expert"]),
};

/** 专家意见权威（R13/R18）：专家只产出提案/诊断，权威事实与生成动作归编排器与作者。 */
export const EXPERT_AUTHORITY_POLICY = {
  mayWriteFiles: false,
  mayCallGenerationEntry: false,
  mayCommitLongTermState: false,
  mayVoteLiteraryQuality: false,
  opinionAuthority: "proposal_reference" as const,
  requiredEvidence: "source_location_and_confirmation" as const,
} as const;

/** 项目规定的 Prompt 五要素固定顺序。 */
export const EXPERT_PROMPT_SECTIONS = ["角色", "指令", "约束", "示例", "输出格式"] as const;

export type ExpertPromptSectionName = (typeof EXPERT_PROMPT_SECTIONS)[number];

export interface ExpertFrontmatter {
  name: string;
  description: string;
  model: string | null;
  tools: string[];
  skills: string[];
  knowledge: Array<{ declared: string; resolvedPath: string }>;
  display: Record<string, string | string[]>;
}

export interface ExpertDefinition {
  name: string;
  description: string;
  model: string | null;
  tools: string[];
  skills: string[];
  knowledge: Array<{ declared: string; resolvedPath: string }>;
  display: Record<string, string | string[]>;
  sourceFile: string;
  body: string;
  promptSections: Partial<Record<ExpertPromptSectionName, string>>;
}

export type ExpertIssueSeverity = "error" | "warning";

export interface ExpertRegistryIssue {
  severity: ExpertIssueSeverity;
  code: string;
  role: string | null;
  message: string;
  detail?: unknown;
}

export interface ExpertRegistry {
  agentsDir: string;
  experts: ExpertDefinition[];
  issues: ExpertRegistryIssue[];
  ok: boolean;
  get(name: string): ExpertDefinition | undefined;
  require(name: string): ExpertDefinition;
}

export class ExpertRegistryError extends Error {
  readonly code: string;
  readonly role: string | null;

  constructor(code: string, message: string, role: string | null = null) {
    super(message);
    this.name = "ExpertRegistryError";
    this.code = code;
    this.role = role;
  }
}

// ============================================================================
// frontmatter（最小 YAML 子集）
// ============================================================================

type FrontmatterValue = string | string[] | Record<string, string | string[]>;

function parseScalar(raw: string): string | string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter((item) => item.length > 0);
  }
  return trimmed.replace(/^["']|["']$/g, "");
}

export function parseExpertFrontmatter(raw: string): {
  data: Record<string, FrontmatterValue>;
  body: string;
  errors: string[];
} {
  const lines = raw.split(/\r?\n/);
  const data: Record<string, FrontmatterValue> = {};
  if ((lines[0] ?? "").trim() !== "---") {
    return { data, body: raw, errors: ["missing_frontmatter_delimiter"] };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { data, body: raw, errors: ["unterminated_frontmatter"] };
  }

  let i = 1;
  while (i < end) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i += 1;
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) {
      i += 1;
      continue;
    }
    const key = match[1];
    const rest = match[2].trim();
    if (rest && rest !== "|" && rest !== ">") {
      data[key] = parseScalar(rest);
      i += 1;
      continue;
    }
    const blockLines: string[] = [];
    i += 1;
    while (i < end && (/^\s*$/.test(lines[i]) || /^\s+/.test(lines[i]))) {
      blockLines.push(lines[i]);
      i += 1;
    }
    const meaningful = blockLines.filter((item) => item.trim().length > 0);
    if (meaningful.length === 0) {
      data[key] = [];
      continue;
    }
    if (meaningful.every((item) => /^\s*-\s+/.test(item))) {
      data[key] = meaningful.map((item) => item.replace(/^\s*-\s+/, "").trim()).filter(Boolean);
      continue;
    }
    if (meaningful.every((item) => /^\s*[A-Za-z0-9_-]+\s*:\s*/.test(item))) {
      const map: Record<string, string | string[]> = {};
      for (const item of meaningful) {
        const entry = item.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (entry) map[entry[1]] = parseScalar(entry[2]);
      }
      data[key] = map;
      continue;
    }
    data[key] = meaningful.map((item) => item.trim()).join("\n");
  }

  return { data, body: lines.slice(end + 1).join("\n"), errors: [] };
}

const PROMPT_HEADING_RE = /^##\s+【(角色|指令|约束|示例|输出格式)】\s*$/gmu;

export function extractPromptSections(
  body: string,
): Partial<Record<ExpertPromptSectionName, string>> {
  const matches = [...body.matchAll(PROMPT_HEADING_RE)];
  const sections: Partial<Record<ExpertPromptSectionName, string>> = {};
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const name = match[1] as ExpertPromptSectionName;
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index ?? body.length : body.length;
    sections[name] = body.slice(start, end).trim();
  }
  return sections;
}

// ============================================================================
// 校验
// ============================================================================

function normalizeStringArray(value: FrontmatterValue | undefined, field: string, role: string, issues: ExpertRegistryIssue[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push({
      severity: "error",
      code: "expert_field_not_list",
      role,
      message: `${role}: frontmatter 字段 ${field} 必须是字符串列表`,
      detail: value,
    });
    return [];
  }
  return value.filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function validateTools(tools: string[], role: string, issues: ExpertRegistryIssue[]): void {
  if (tools.length === 0) {
    issues.push({
      severity: "error",
      code: "expert_tools_empty",
      role,
      message: `${role}: tools 为空，专家无法读取任何输入`,
    });
    return;
  }
  for (const tool of tools) {
    if ((EXPERT_FORBIDDEN_TOOLS as readonly string[]).includes(tool)) {
      issues.push({
        severity: "error",
        code: "expert_tool_forbidden",
        role,
        message: `${role}: 工具 ${tool} 属于写权限/生成入口，专家不得持有`,
        detail: { tool, policy: EXPERT_AUTHORITY_POLICY },
      });
      continue;
    }
    if ((EXPERT_WRITE_TOOLS as readonly string[]).includes(tool)) {
      issues.push({
        severity: "error",
        code: "expert_tool_write_denied",
        role,
        message: `${role}: 工具 ${tool} 有写入/落盘语义，专家不得持有；落盘由父代理执行`,
        detail: { tool, policy: EXPERT_AUTHORITY_POLICY },
      });
      continue;
    }
    if (!EXPERT_ALLOWED_TOOLS.has(tool)) {
      issues.push({
        severity: "error",
        code: "expert_tool_unknown",
        role,
        message: `${role}: 未注册工具 ${tool}（只允许 ${[...EXPERT_ALLOWED_TOOLS].join("/")}）`,
        detail: { tool },
      });
    }
  }
}

function validateKnowledge(
  declaredPath: string,
  agentsDir: string,
  sourceDir: string,
  role: string,
  issues: ExpertRegistryIssue[],
): string | null {
  if (isAbsolute(declaredPath)) {
    issues.push({
      severity: "error",
      code: "expert_knowledge_path_absolute",
      role,
      message: `${role}: knowledge 路径必须相对定义文件目录，禁止绝对路径 ${declaredPath}`,
      detail: { declaredPath },
    });
    return null;
  }
  if (!declaredPath.endsWith(".md")) {
    issues.push({
      severity: "error",
      code: "expert_knowledge_not_markdown",
      role,
      message: `${role}: knowledge 只允许 .md 文件（${declaredPath}）`,
      detail: { declaredPath },
    });
    return null;
  }
  const resolvedPath = resolve(sourceDir, declaredPath);
  const relativeToAgents = relative(agentsDir, resolvedPath);
  if (relativeToAgents.startsWith("..") || isAbsolute(relativeToAgents)) {
    issues.push({
      severity: "error",
      code: "expert_knowledge_path_escape",
      role,
      message: `${role}: knowledge 路径逃逸出 agents 目录（${declaredPath}）`,
      detail: { declaredPath, resolvedPath },
    });
    return null;
  }
  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
    issues.push({
      severity: "error",
      code: "expert_knowledge_missing",
      role,
      message: `${role}: knowledge 文件不存在（${declaredPath} → ${relativeToAgents}）`,
      detail: { declaredPath, resolvedPath },
    });
    return null;
  }
  return resolvedPath;
}

const MARKDOWN_LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/gu;

function validateBodyLinks(body: string, sourceDir: string, agentsDir: string, role: string, issues: ExpertRegistryIssue[]): number {
  let checked = 0;
  for (const match of body.matchAll(MARKDOWN_LINK_RE)) {
    const target = match[1];
    if (/^(?:https?:|mailto:|#)/u.test(target)) continue;
    checked += 1;
    const resolvedPath = resolve(sourceDir, target);
    const relativeToAgents = relative(agentsDir, resolvedPath);
    if (relativeToAgents.startsWith("..") || isAbsolute(relativeToAgents)) {
      issues.push({
        severity: "error",
        code: "expert_body_link_escape",
        role,
        message: `${role}: 正文链接逃逸出 agents 目录（${target}）`,
        detail: { target },
      });
      continue;
    }
    if (!existsSync(resolvedPath)) {
      issues.push({
        severity: "error",
        code: "expert_body_link_broken",
        role,
        message: `${role}: 正文链接指向不存在的文件（${target} → ${relativeToAgents}）`,
        detail: { target, resolvedPath },
      });
    }
  }
  return checked;
}

function validatePromptSections(
  sections: Partial<Record<ExpertPromptSectionName, string>>,
  body: string,
  role: string,
  issues: ExpertRegistryIssue[],
): void {
  const indices: number[] = [];
  for (const name of EXPERT_PROMPT_SECTIONS) {
    const content = sections[name];
    if (typeof content !== "string" || content.trim().length === 0) {
      issues.push({
        severity: "error",
        code: "expert_prompt_section_missing",
        role,
        message: `${role}: 缺少 Prompt 五要素小标题【${name}】或内容为空`,
        detail: { section: name },
      });
      continue;
    }
    const index = body.indexOf(`## 【${name}】`);
    indices.push(index);
  }
  for (let i = 1; i < indices.length; i += 1) {
    if (indices[i] < indices[i - 1]) {
      issues.push({
        severity: "error",
        code: "expert_prompt_section_order",
        role,
        message: `${role}: Prompt 五要素顺序错误，必须是【角色】【指令】【约束】【示例】【输出格式】`,
        detail: { indices },
      });
      break;
    }
  }
}

// ============================================================================
// 加载
// ============================================================================

function listExpertFiles(agentsDir: string): string[] {
  return readdirSync(agentsDir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .filter((name) => {
      const fullPath = join(agentsDir, name);
      try {
        return statSync(fullPath).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

export function loadExpertRegistry(agentsDir: string): ExpertRegistry {
  const resolvedAgentsDir = resolve(agentsDir);
  const issues: ExpertRegistryIssue[] = [];
  const experts: ExpertDefinition[] = [];

  if (!existsSync(resolvedAgentsDir) || !statSync(resolvedAgentsDir).isDirectory()) {
    issues.push({
      severity: "error",
      code: "expert_agents_dir_missing",
      role: null,
      message: `专家目录不存在：${resolvedAgentsDir}`,
      detail: { agentsDir: resolvedAgentsDir },
    });
    return buildRegistry(resolvedAgentsDir, experts, issues);
  }

  const seen = new Set<string>();
  let knowledgeRefCount = 0;
  let bodyLinkCount = 0;

  for (const fileName of listExpertFiles(resolvedAgentsDir)) {
    const sourceFile = join(resolvedAgentsDir, fileName);
    const sourceDir = dirname(sourceFile);
    const raw = readFileSync(sourceFile, "utf-8");
    const parsed = parseExpertFrontmatter(raw);
    const role = typeof parsed.data.name === "string" && parsed.data.name.trim()
      ? parsed.data.name.trim()
      : fileName.replace(/\.md$/u, "");

    for (const error of parsed.errors) {
      issues.push({
        severity: "error",
        code: `expert_frontmatter_${error}`,
        role,
        message: `${role}: frontmatter 解析失败（${error}）`,
        detail: { sourceFile },
      });
    }

    if (typeof parsed.data.name !== "string" || !parsed.data.name.trim()) {
      issues.push({
        severity: "error",
        code: "expert_name_missing",
        role,
        message: `${role}: frontmatter 缺少 name`,
        detail: { sourceFile },
      });
    }
    if (seen.has(role)) {
      issues.push({
        severity: "error",
        code: "expert_name_duplicate",
        role,
        message: `${role}: 角色名重复`,
        detail: { sourceFile },
      });
      continue;
    }
    seen.add(role);

    const modelValue = typeof parsed.data.model === "string" ? parsed.data.model.trim() : "";
    if (modelValue === "inherit") {
      issues.push({
        severity: "error",
        code: "expert_model_inherit_rejected",
        role,
        message: `${role}: 不得写 model: inherit；省略 model 字段才表示继承父会话模型`,
        detail: { sourceFile },
      });
    }

    const description = typeof parsed.data.description === "string" ? parsed.data.description.trim() : "";
    if (!description) {
      issues.push({
        severity: "warning",
        code: "expert_description_empty",
        role,
        message: `${role}: description 为空，宿主无法据其判断何时派发`,
      });
    }

    const tools = normalizeStringArray(parsed.data.tools, "tools", role, issues);
    validateTools(tools, role, issues);

    const skills = normalizeStringArray(parsed.data.skills, "skills", role, issues);

    const knowledgeDeclarations = normalizeStringArray(parsed.data.knowledge, "knowledge", role, issues);
    const knowledge: Array<{ declared: string; resolvedPath: string }> = [];
    if (knowledgeDeclarations.length === 0) {
      issues.push({
        severity: "warning",
        code: "expert_knowledge_empty",
        role,
        message: `${role}: 未声明领域资料（knowledge），按需参考能力不可用`,
      });
    }
    for (const declared of knowledgeDeclarations) {
      const resolvedPath = validateKnowledge(declared, resolvedAgentsDir, sourceDir, role, issues);
      if (resolvedPath) {
        knowledge.push({ declared, resolvedPath });
        knowledgeRefCount += 1;
      }
    }

    const display = (typeof parsed.data.display === "object" && parsed.data.display !== null && !Array.isArray(parsed.data.display))
      ? parsed.data.display as Record<string, string | string[]>
      : {};

    const promptSections = extractPromptSections(parsed.body);
    validatePromptSections(promptSections, parsed.body, role, issues);
    bodyLinkCount += validateBodyLinks(parsed.body, sourceDir, resolvedAgentsDir, role, issues);

    experts.push({
      name: role,
      description,
      model: modelValue || null,
      tools,
      skills,
      knowledge,
      display,
      sourceFile,
      body: parsed.body.trim(),
      promptSections,
    });
  }

  if (experts.length !== 10) {
    issues.push({
      severity: "warning",
      code: "expert_role_count",
      role: null,
      message: `专家数量为 ${experts.length}，项目基线是恰好 10 个（新增/删除需同步 README 与覆盖表）`,
      detail: { count: experts.length },
    });
  }

  return buildRegistry(resolvedAgentsDir, experts, issues, { knowledgeRefCount, bodyLinkCount });
}

function buildRegistry(
  agentsDir: string,
  experts: ExpertDefinition[],
  issues: ExpertRegistryIssue[],
  counters?: { knowledgeRefCount: number; bodyLinkCount: number },
): ExpertRegistry {
  const byName = new Map(experts.map((expert) => [expert.name, expert]));
  if (counters) {
    issues.push({
      severity: "warning",
      code: "expert_registry_summary",
      role: null,
      message: `发现 ${experts.length} 个专家、${counters.knowledgeRefCount} 条 knowledge 声明、${counters.bodyLinkCount} 条正文资料链接`,
      detail: counters,
    });
  }
  return {
    agentsDir,
    experts,
    issues,
    ok: issues.every((issue) => issue.severity !== "error"),
    get(name: string) {
      return byName.get(name);
    },
    require(name: string) {
      const found = byName.get(name);
      if (!found) {
        throw new ExpertRegistryError(
          "unknown_expert",
          `未知专家角色：${name}（已注册：${[...byName.keys()].join("、")}）`,
          name,
        );
      }
      return found;
    },
  };
}

// ============================================================================
// 权限 / 路径边界（R18）
// ============================================================================

export function checkExpertToolAllowed(
  expert: ExpertDefinition,
  tool: string,
  action?: string,
): { ok: boolean; code?: string; message?: string } {
  if (!expert.tools.includes(tool)) {
    return {
      ok: false,
      code: "tool_not_declared",
      message: `${expert.name} 未声明工具 ${tool}，不得调用`,
    };
  }
  if ((EXPERT_FORBIDDEN_TOOLS as readonly string[]).includes(tool)) {
    return {
      ok: false,
      code: "tool_forbidden",
      message: `${expert.name} 不得持有写权限/生成入口工具 ${tool}`,
    };
  }
  if ((EXPERT_WRITE_TOOLS as readonly string[]).includes(tool)) {
    return {
      ok: false,
      code: "tool_write_denied",
      message: `${expert.name} 不得调用有写入/落盘语义的工具 ${tool}；落盘由父代理执行`,
    };
  }
  if (!EXPERT_ALLOWED_TOOLS.has(tool)) {
    return {
      ok: false,
      code: "tool_unknown",
      message: `${expert.name} 不得调用未注册工具 ${tool}`,
    };
  }
  const actionPolicy = EXPERT_ALLOWED_ACTIONS[tool];
  if (actionPolicy) {
    const normalized = (action ?? "").trim();
    if (!normalized) {
      return {
        ok: false,
        code: "tool_action_required",
        message: `${expert.name} 调用 ${tool} 必须显式声明 action（允许：${[...actionPolicy].join("/")}）`,
      };
    }
    if (!actionPolicy.has(normalized)) {
      return {
        ok: false,
        code: "tool_action_not_allowed",
        message: `${expert.name} 不得执行 ${tool} 的写入/状态 action=${normalized}（允许：${[...actionPolicy].join("/")}）`,
      };
    }
  }
  return { ok: true };
}

/** 专家读取路径禁止项（R18：`.env`、正式章节、长期状态、模型路由不向专家开放）。 */
export const EXPERT_READ_DENY_BASENAMES = [".env", "narrative-state-store.json", "model-routing.json"] as const;
export const EXPERT_READ_DENY_SEGMENTS = ["chapters", ".git", "node_modules"] as const;

export interface ExpertPathCheckResult {
  ok: boolean;
  resolvedPath?: string;
  code?: string;
  message?: string;
}

export function checkExpertReadPath(
  inputPath: string,
  options: { agentsDir: string; workspaceRoot?: string; extraRoots?: string[] },
): ExpertPathCheckResult {
  const raw = (inputPath ?? "").trim();
  if (!raw) return { ok: false, code: "path_empty", message: "输入路径为空" };

  const roots = [resolve(options.agentsDir), ...(options.workspaceRoot ? [resolve(options.workspaceRoot)] : []), ...(options.extraRoots ?? []).map((root) => resolve(root))];
  const resolvedPath = isAbsolute(raw)
    ? resolve(raw)
    : resolve(options.workspaceRoot ?? options.agentsDir, raw);

  const segments = resolvedPath.split(sep).map((segment) => segment.toLowerCase());
  const base = segments[segments.length - 1] ?? "";

  if (base === ".env" || base.startsWith(".env.")) {
    return { ok: false, code: "path_env_denied", message: `禁止专家读取环境变量文件：${raw}`, resolvedPath };
  }
  if ((EXPERT_READ_DENY_BASENAMES as readonly string[]).some((name) => name !== ".env" && base === name.toLowerCase())) {
    return { ok: false, code: "path_state_denied", message: `禁止专家读取长期状态/路由配置：${raw}`, resolvedPath };
  }
  if (segments.some((segment) => (EXPERT_READ_DENY_SEGMENTS as readonly string[]).includes(segment))) {
    return { ok: false, code: "path_scope_denied", message: `禁止专家读取受保护目录：${raw}`, resolvedPath };
  }

  const withinRoot = roots.some((root) => {
    const relativePath = relative(root, resolvedPath);
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
  });
  if (!withinRoot) {
    return { ok: false, code: "path_outside_root", message: `专家只允许读取项目 agents 目录或 workspace 目录内的文件：${raw}`, resolvedPath };
  }

  return { ok: true, resolvedPath };
}
