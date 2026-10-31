/**
 * PiNovelStudio — 项目内最小专家派发器（EXPERT-GROUP-R10/R13/R18）
 *
 * 定位：**离线可验证的派发骨架**，不是第二个章节生成入口。
 *  - 只做角色发现（expert-registry）+ 任务包渲染 + 执行器调用 + 结构化记录。
 *  - 不注册公开工具、不读写章节、不提交长期状态、不调用文学裁判。
 *  - 执行器由调用方注入（测试用替身执行器；真实模型接入需另行授权，见 README）。
 *
 * 强制边界：
 *  1. 未知角色 fail-closed（不猜测、不回退到默认专家）。
 *  2. 专家只能使用自己 frontmatter 声明的只读工具；执行器必须在执行任何工具/action 前调用
 *     `authorizeToolCall`（EXPERT-PREAUTH-1），未预授权调用或上报未预授权调用 → denied。
 *  3. 输入路径经 checkExpertReadPath 校验（`.env` / `chapters/` / 长期状态 / 路由配置一律拒绝）。
 *  4. 专家每次调用都有预算（次数 / 墙钟 / 提示词字符 / 输出字符），耗尽即停并留痕。
 *  5. 专家意见默认为提案/诊断；需要未授权动作时输出 pending_parent_action，不报告“已完成”。
 */

import { randomUUID } from "node:crypto";
import {
  checkExpertReadPath,
  checkExpertToolAllowed,
  ExpertRegistryError,
  type ExpertDefinition,
  type ExpertRegistry,
} from "./expert-registry.js";

export type ExpertDispatchStatus =
  | "ok"
  | "error"
  | "denied"
  | "pending_parent_action"
  | "cancelled"
  | "budget_exhausted";

export interface ExpertTask {
  role: string;
  objective: string;
  inputPaths?: string[];
  constraints?: string[];
  expect?: string;
  workspaceId?: string;
  chapterNumber?: number;
}

export interface ExpertBudget {
  maxExpertCalls: number;
  maxWallClockMs: number;
  maxPromptChars: number;
  maxOutputChars: number;
}

export const DEFAULT_EXPERT_BUDGET: ExpertBudget = {
  maxExpertCalls: 4,
  maxWallClockMs: 120_000,
  maxPromptChars: 6_000,
  maxOutputChars: 20_000,
};

export interface ExpertToolCallAuthorization {
  ok: boolean;
  code?: string;
  message?: string;
}

export interface ExpertToolCallDecision {
  tool: string;
  action?: string;
  ok: boolean;
  code?: string;
  message?: string;
}

export interface ExpertExecutionRequest {
  traceId: string;
  role: string;
  sourceFile: string;
  systemPrompt: string;
  taskMessage: string;
  allowedTools: string[];
  workspaceId?: string;
  chapterNumber?: number;
  inputPaths: string[];
  maxOutputChars: number;
  /**
   * 执行前授权守卫（EXPERT-PREAUTH-1）：执行器在调用任何工具/action 之前必须先调用它，
   * 返回 `ok=false` 时不得执行该动作。dispatcher 记录每次判定；执行后上报的 toolCalls
   * 必须命中已授权判定，否则判 denied（覆盖绕过守卫的执行器）。
   */
  authorizeToolCall: (call: { tool: string; action?: string }) => ExpertToolCallAuthorization;
}

export interface ExpertExecutorResult {
  status: "ok" | "error" | "denied" | "pending_parent_action";
  output: string;
  pendingActions?: string[];
  omitted?: Array<{ path: string; reason: string }>;
  error?: string;
  toolCalls?: Array<{ tool: string; ok: boolean; action?: string }>;
}

export type ExpertExecutor = (
  request: ExpertExecutionRequest,
) => ExpertExecutorResult | Promise<ExpertExecutorResult>;

export interface ExpertDispatchRecord {
  traceId: string;
  role: string;
  objective: string;
  status: ExpertDispatchStatus;
  startedAt: number;
  durationMs: number;
  output: string | null;
  outputChars: number;
  pendingActions: string[];
  omitted: Array<{ path: string; reason: string }>;
  toolCalls: Array<{ tool: string; ok: boolean; action?: string }>;
  /** 执行前授权守卫的全部判定记录（含被拒绝的尝试），用于审计。 */
  toolCallDecisions: ExpertToolCallDecision[];
  error: { code: string; message: string } | null;
}

export interface ExpertDispatcherOptions {
  registry: ExpertRegistry;
  executor: ExpertExecutor;
  agentsDir: string;
  workspaceRoot?: string;
  extraRoots?: string[];
  budget?: Partial<ExpertBudget>;
  now?: () => number;
  newTraceId?: () => string;
}

export interface ExpertDispatchTicket {
  expert: string;
  objective: string;
  inputPaths: string[];
  expect?: string;
}

export interface ExpertHandoffResult {
  director: ExpertDispatchRecord;
  ticket: ExpertDispatchTicket | null;
  expert: ExpertDispatchRecord | null;
  errors: string[];
}

const FENCED_JSON_RE = /```json\s*([\s\S]*?)```/iu;

/** 从 director 输出中提取派发单（第一个 ```json 代码块）。 */
export function parseDispatchTicket(output: string): { ticket: ExpertDispatchTicket | null; error: string | null } {
  const match = output.match(FENCED_JSON_RE);
  if (!match) return { ticket: null, error: "dispatch_ticket_missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return { ticket: null, error: "dispatch_ticket_not_json" };
  }
  if (!parsed || typeof parsed !== "object") return { ticket: null, error: "dispatch_ticket_not_object" };
  const candidate = parsed as Record<string, unknown>;
  const expert = typeof candidate.expert === "string" ? candidate.expert.trim() : "";
  const objective = typeof candidate.objective === "string" ? candidate.objective.trim() : "";
  if (!expert || !objective) return { ticket: null, error: "dispatch_ticket_missing_fields" };
  const inputPaths = Array.isArray(candidate.inputPaths)
    ? candidate.inputPaths.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const expect = typeof candidate.expect === "string" ? candidate.expect.trim() : undefined;
  return { ticket: { expert, objective, inputPaths, ...(expect ? { expect } : {}) }, error: null };
}

/** 渲染专家 system prompt：使用定义正文（已按五要素组织），不追加机械规则。 */
export function renderExpertSystemPrompt(expert: ExpertDefinition): string {
  return expert.body;
}

/**
 * 渲染专家任务包。任务包本身也按五要素组织，便于统一审计。
 * `omittedInputs` 记录因提示词预算被省略的输入路径，不静默丢弃。
 */
export function buildExpertTaskMessage(
  expert: ExpertDefinition,
  task: ExpertTask,
  options: { omittedInputs?: string[]; maxOutputChars?: number } = {},
): string {
  const inputPaths = task.inputPaths ?? [];
  const constraints = task.constraints ?? [];
  const omitted = options.omittedInputs ?? [];
  const inputBlock = inputPaths.length > 0 ? inputPaths.map((path) => `- ${path}`).join("\n") : "- 无（仅基于任务目标作答）";
  const omittedBlock = omitted.length > 0 ? `\n已省略输入（提示词预算不足，必须声明未读取）：\n${omitted.map((path) => `- ${path}`).join("\n")}` : "";

  return [
    "## 【角色】",
    `你是 PiNovelStudio 的 ${expert.name} 专家，向父代理（PiNovelStudio 主代理）交付提案或诊断，不向读者直接交付成品。`,
    "",
    "## 【指令】",
    `任务目标：${task.objective}`,
    task.chapterNumber !== undefined ? `章节编号：${task.chapterNumber}` : "",
    task.workspaceId ? `workspace：${task.workspaceId}` : "",
    "可读输入：",
    inputBlock + omittedBlock,
    "请按你正文【指令】一节的工作流程执行，并严格使用【输出格式】一节的模板。",
    constraints.length > 0 ? `附加约束：\n${constraints.map((item) => `- ${item}`).join("\n")}` : "",
    "",
    "## 【约束】",
    `- 只能使用以下工具：${expert.tools.join("、")}；未声明的工具一律不得调用。`,
    "- 你的输出是提案/诊断，不是权威事实；作者确认与机器事实检查仍是权威。",
    "- 禁止撰写或改写章节正文，禁止调用 novel_generate_chapter，禁止写 chapters/、narrative-state-store.json、.env。",
    "- 任何需要未授权动作（例如落盘 canon、记录用户反馈、触发章节生成）的步骤，必须写入“请求父代理执行”清单，并标 pending_parent_action，不得写成已完成。",
    "- 不得做文学质量裁决；文学评价权归作者。",
    `- 输出不超过 ${options.maxOutputChars ?? DEFAULT_EXPERT_BUDGET.maxOutputChars} 字符；任何省略必须显式声明省略内容与原因。`,
    "",
    "## 【示例】",
    "正例：给出结论、证据定位（文件#小节 或 章节#段落）与建议动作，缺证据时明确写“未确认”。",
    "反例：把尚未执行的落盘/生成写成已完成；用“整体感觉”“应该可以”替代可定位证据；输出大段新写的替代表达。",
    "",
    "## 【输出格式】",
    `严格按你正文【输出格式】一节的模板输出${task.expect ? `，本次期望产物：${task.expect}` : ""}。`,
    "只输出该模板内容；不要在模板之外追加解释、寒暄或思考过程。",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export class ExpertDispatcher {
  private readonly registry: ExpertRegistry;
  private readonly executor: ExpertExecutor;
  private readonly agentsDir: string;
  private readonly workspaceRoot?: string;
  private readonly extraRoots: string[];
  private readonly budget: ExpertBudget;
  private readonly now: () => number;
  private readonly newTraceId: () => string;
  private readonly records: ExpertDispatchRecord[] = [];
  private callCount = 0;
  private readonly startedAt: number;
  private cancelled = false;
  private cancelReason: string | null = null;

  constructor(options: ExpertDispatcherOptions) {
    this.registry = options.registry;
    this.executor = options.executor;
    this.agentsDir = options.agentsDir;
    this.workspaceRoot = options.workspaceRoot;
    this.extraRoots = options.extraRoots ?? [];
    this.budget = { ...DEFAULT_EXPERT_BUDGET, ...(options.budget ?? {}) };
    this.now = options.now ?? (() => Date.now());
    this.newTraceId = options.newTraceId ?? (() => randomUUID());
    this.startedAt = this.now();
  }

  getRecords(): ExpertDispatchRecord[] {
    return this.records.map((record) => ({
      ...record,
      pendingActions: [...record.pendingActions],
      omitted: [...record.omitted],
      toolCalls: [...record.toolCalls],
      toolCallDecisions: [...record.toolCallDecisions],
    }));
  }

  cancel(reason = "parent_cancelled"): void {
    this.cancelled = true;
    this.cancelReason = reason;
  }

async dispatch(task: ExpertTask): Promise<ExpertDispatchRecord> {
    const traceId = this.newTraceId();
    const startedAt = this.now();
    const base = {
      traceId,
      role: task.role,
      objective: task.objective,
      startedAt,
      durationMs: 0,
      output: null,
      outputChars: 0,
      pendingActions: [] as string[],
      omitted: [] as Array<{ path: string; reason: string }>,
      toolCalls: [] as Array<{ tool: string; ok: boolean; action?: string }>,
      toolCallDecisions: [] as ExpertToolCallDecision[],
      error: null as { code: string; message: string } | null,
    };

    const finish = (status: ExpertDispatchStatus, patch: Partial<ExpertDispatchRecord> = {}): ExpertDispatchRecord => {
      const record: ExpertDispatchRecord = {
        ...base,
        ...patch,
        status,
        durationMs: Math.max(0, this.now() - startedAt),
      };
      this.records.push(record);
      return record;
    };

    if (this.cancelled) {
      return finish("cancelled", { error: { code: "cancelled", message: this.cancelReason ?? "parent_cancelled" } });
    }
    if (this.callCount >= this.budget.maxExpertCalls) {
      return finish("budget_exhausted", {
        error: { code: "max_expert_calls", message: `专家调用次数达到上限 ${this.budget.maxExpertCalls}` },
      });
    }
    if (this.now() - this.startedAt > this.budget.maxWallClockMs) {
      return finish("budget_exhausted", {
        error: { code: "max_wall_clock", message: `专家运行耗时达到上限 ${this.budget.maxWallClockMs}ms` },
      });
    }

    let expert: ExpertDefinition;
    try {
      expert = this.registry.require(task.role);
    } catch (error) {
      const registryError = error as ExpertRegistryError;
      return finish("error", { error: { code: registryError.code ?? "unknown_expert", message: registryError.message } });
    }

    const inputPaths: string[] = [];
    for (const inputPath of task.inputPaths ?? []) {
      const check = checkExpertReadPath(inputPath, {
        agentsDir: this.agentsDir,
        workspaceRoot: this.workspaceRoot,
        extraRoots: this.extraRoots,
      });
      if (!check.ok) {
        return finish("denied", {
          error: { code: check.code ?? "path_denied", message: check.message ?? `输入路径被拒绝：${inputPath}` },
        });
      }
      inputPaths.push(check.resolvedPath ?? inputPath);
    }

    const systemPrompt = renderExpertSystemPrompt(expert);
    const omittedInputs: string[] = [];
    let keptInputs = [...inputPaths];
    let taskMessage = buildExpertTaskMessage(expert, { ...task, inputPaths: keptInputs }, { omittedInputs, maxOutputChars: this.budget.maxOutputChars });
    while (systemPrompt.length + taskMessage.length > this.budget.maxPromptChars && keptInputs.length > 0) {
      omittedInputs.push(keptInputs[keptInputs.length - 1]);
      keptInputs = keptInputs.slice(0, -1);
      taskMessage = buildExpertTaskMessage(expert, { ...task, inputPaths: keptInputs }, { omittedInputs, maxOutputChars: this.budget.maxOutputChars });
    }
    if (systemPrompt.length + taskMessage.length > this.budget.maxPromptChars) {
      return finish("error", {
        omitted: omittedInputs.map((path) => ({ path, reason: "prompt_budget" })),
        error: {
          code: "prompt_budget_exceeded",
          message: `系统提示词与任务包超过上限 ${this.budget.maxPromptChars} 字符`,
        },
      });
    }

    this.callCount += 1;

    // EXPERT-PREAUTH-1：执行前授权守卫。执行器必须在执行任何工具/action 之前调用它；
    // dispatcher 记录全部判定（含被拒绝的尝试），执行后再校验上报调用必须命中已授权判定。
    const toolCallDecisions: ExpertToolCallDecision[] = [];
    const authorizeToolCall = (call: { tool: string; action?: string }): ExpertToolCallAuthorization => {
      const tool = typeof call?.tool === "string" ? call.tool.trim() : "";
      const action = typeof call?.action === "string" ? call.action.trim() : call?.action;
      if (!tool) {
        const decision: ExpertToolCallDecision = { tool: "", action, ok: false, code: "tool_missing", message: "工具名为空，拒绝执行" };
        toolCallDecisions.push(decision);
        return { ok: false, code: decision.code, message: decision.message };
      }
      // R18：工具名与 action 双重校验；带子操作的工具只放行只读/零写入 action。
      const allowed = checkExpertToolAllowed(expert, tool, action);
      toolCallDecisions.push({ tool, action, ok: allowed.ok, code: allowed.code, message: allowed.message });
      return { ok: allowed.ok, code: allowed.code, message: allowed.message };
    };

    let result: ExpertExecutorResult;
    try {
      result = await this.executor({
        traceId,
        role: expert.name,
        sourceFile: expert.sourceFile,
        systemPrompt,
        taskMessage,
        allowedTools: [...expert.tools],
        workspaceId: task.workspaceId,
        chapterNumber: task.chapterNumber,
        inputPaths: keptInputs,
        maxOutputChars: this.budget.maxOutputChars,
        authorizeToolCall,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return finish("error", {
        omitted: omittedInputs.map((path) => ({ path, reason: "prompt_budget" })),
        toolCallDecisions,
        error: { code: "executor_threw", message },
      });
    }

    const toolCalls = result.toolCalls ?? [];
    const findDecision = (call: { tool: string; action?: string }): ExpertToolCallDecision | null => {
      const tool = call.tool.trim();
      const action = call.action?.trim();
      for (let index = toolCallDecisions.length - 1; index >= 0; index -= 1) {
        const decision = toolCallDecisions[index];
        if (decision.tool === tool && decision.action === action) return decision;
      }
      return null;
    };
    const deniedPatch = (code: string, message: string): Partial<ExpertDispatchRecord> => ({
      toolCalls,
      toolCallDecisions,
      omitted: omittedInputs.map((path) => ({ path, reason: "prompt_budget" })),
      error: { code, message },
    });
    for (const call of toolCalls) {
      const decision = findDecision(call);
      if (decision?.ok) continue;
      if (decision) {
        return finish("denied", deniedPatch(decision.code ?? "tool_denied", decision.message ?? `未授权工具：${call.tool}`));
      }
      // 未调用守卫就上报执行：先按注册表判断具体违规原因；能通过则视为绕过守卫。
      const check = checkExpertToolAllowed(expert, call.tool, call.action);
      if (!check.ok) {
        return finish("denied", deniedPatch(check.code ?? "tool_denied", check.message ?? `未授权工具：${call.tool}`));
      }
      return finish(
        "denied",
        deniedPatch(
          "tool_call_not_preeuthorized",
          `执行器未在授权守卫中预先声明 ${call.tool}${call.action ? `/${call.action}` : ""} 就上报了已执行调用`,
        ),
      );
    }
    // 执行器尝试过但被守卫拒绝的动作（即使未上报为 toolCalls）也按 fail-closed 处理。
    const rejectedAttempt = toolCallDecisions.find((decision) => !decision.ok);
    if (rejectedAttempt) {
      return finish(
        "denied",
        deniedPatch(rejectedAttempt.code ?? "tool_denied", rejectedAttempt.message ?? `未授权工具：${rejectedAttempt.tool}`),
      );
    }

    let output = result.output ?? "";
    const omitted = [
      ...omittedInputs.map((path) => ({ path, reason: "prompt_budget" })),
      ...(result.omitted ?? []),
    ];
    let outputTruncated = false;
    if (output.length > this.budget.maxOutputChars) {
      output = `${output.slice(0, this.budget.maxOutputChars)}\n[truncated: length=${output.length} budget=${this.budget.maxOutputChars}]`;
      outputTruncated = true;
    }

    const patch: Partial<ExpertDispatchRecord> = {
      output,
      outputChars: output.length,
      pendingActions: result.pendingActions ?? [],
      omitted: outputTruncated ? [...omitted, { path: "(output)", reason: "output_budget_truncated" }] : omitted,
      toolCalls,
      toolCallDecisions,
    };

    if (result.status === "ok" || result.status === "pending_parent_action") {
      return finish(result.status, patch);
    }
    return finish(result.status === "denied" ? "denied" : "error", {
      ...patch,
      error: { code: result.status === "denied" ? "executor_denied" : "executor_error", message: result.error ?? result.status },
    });
  }

  /**
   * director → 单个专家 → 结构化回传。
   * director 只产出派发单（JSON）；派发单非法或指向未知角色时 fail-closed。
   */
  async runDirectorHandoff(task: Omit<ExpertTask, "role"> & { directorRole?: string }): Promise<ExpertHandoffResult> {
    const directorTask: ExpertTask = {
      role: task.directorRole ?? "novel-director",
      objective: task.objective,
      inputPaths: task.inputPaths,
      constraints: task.constraints,
      expect: "输出「派发单」：一个 ```json 代码块，字段 expert / objective / inputPaths / expect（仅派发给一个专家）",
      workspaceId: task.workspaceId,
      chapterNumber: task.chapterNumber,
    };
    const director = await this.dispatch(directorTask);
    if (director.status !== "ok" && director.status !== "pending_parent_action") {
      return { director, ticket: null, expert: null, errors: [director.error?.code ?? director.status] };
    }
    const parsed = parseDispatchTicket(director.output ?? "");
    if (!parsed.ticket || parsed.error) {
      return { director, ticket: null, expert: null, errors: [parsed.error ?? "dispatch_ticket_invalid"] };
    }
    const ticket = parsed.ticket;
    if (ticket.expert === directorTask.role) {
      return { director, ticket, expert: null, errors: ["dispatch_ticket_self_dispatch"] };
    }
    if (!this.registry.get(ticket.expert)) {
      return { director, ticket, expert: null, errors: ["dispatch_ticket_unknown_expert"] };
    }
    const expert = await this.dispatch({
      role: ticket.expert,
      objective: ticket.objective,
      inputPaths: ticket.inputPaths,
      expect: ticket.expect,
      workspaceId: task.workspaceId,
      chapterNumber: task.chapterNumber,
    });
    const errors = expert.status === "ok" || expert.status === "pending_parent_action"
      ? []
      : [expert.error?.code ?? expert.status];
    return { director, ticket, expert, errors };
  }
}
