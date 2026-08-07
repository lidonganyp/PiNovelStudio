/**
 * NovelOS Runtime（OPT-8.1）
 *
 * 核心 interfaces 与 NovelOSRuntime 工厂。
 * 根据 spike 结论委托 pi-agent-core（不自建 loop）。不依赖 PI UI 类型。
 *
 * NovelOSRuntime 封装 Agent + BudgetPolicy + TrajectoryStore 的协调：
 * - 事件订阅：turn/tool/message 事件自动记录 trajectory + 追加预算；
 * - prompt 前检查预算耗尽，耗尽时记录 failure 不发起调用；
 * - abort 提供 bounded stop。
 */

import type {
  Agent,
  AgentEvent,
  AgentMessage,
  AgentOptions,
  AgentTool,
  ModelGenerateFn,
} from "../adapters/pi-agent-core-adapter.js";
import { createNovelOSAgent } from "../adapters/pi-agent-core-adapter.js";
import type { BudgetPolicy, BudgetSnapshot } from "./budget-policy.js";
import type { NovelSession } from "../session/novel-session.js";
import type { TrajectoryStore, TrajectoryFailureEnvelope } from "../trajectory/trajectory-store.js";

// ============================================================================
// 常量
// ============================================================================

/**
 * 检索预算用尽时，beforeToolCall 阻断检索工具所返回的 reason 文本。
 * 该阻断结果会作为工具结果回灌给模型，提示其停止检索并基于已有上下文生成最终正文。
 */
const RETRIEVAL_BUDGET_BLOCK_REASON =
  "检索预算已用尽（本轮允许的检索次数已用完）。请停止调用检索工具，" +
  "直接基于已有上下文生成章节正文。";

// ============================================================================
// NovelOS 领域 interfaces
// ============================================================================

/** NovelOS 工具结果详情（统一 sourceRef + evidenceLevel） */
export interface NovelOSToolResultDetails {
  sourceRef: string;
  evidenceLevel: "confirmed" | "inferred" | "profile_only";
  [key: string]: unknown;
}

/** NovelOS Runtime 配置 */
export interface NovelOSRuntimeOptions {
  session: NovelSession;
  systemPrompt: string;
  modelGenerate: ModelGenerateFn;
  route: string;
  tools: AgentTool[];
  /**
   * 工具注入白名单（Phase 2D 缺口一防御纵深，必填）。
   * 透传给 createNovelOSAgent → injectToolSchemas。必填确保注入边界无法被绕过：
   * 任何调用方都必须显式声明允许注入的工具集合，集合外工具 fail-closed 拒绝。
   */
  allowedToolNames: ReadonlySet<string>;
  /**
   * 检索类工具名集合（Phase 2D 缺口三执行）。
   * 提供时，runtime 统计已执行的检索类工具调用次数，并在达到 retrievalBudget 时
   * 通过 beforeToolCall 阻断后续检索调用（而非终止整个 loop）——让检索深度真正进入
   * "工具调用次数"这一系统约束，同时保留最终正文回合。
   */
  retrievalToolNames?: ReadonlySet<string>;
  /**
   * 检索工具调用次数上限（由检索深度推导，0/2/4/6）。
   * 达到后 beforeToolCall 返回 { block: true } 拒绝后续检索调用；模型收到"预算用尽"
   * 的阻断结果后应停止检索并基于已有上下文生成最终正文。不终止 loop。
   */
  retrievalBudget?: number;
  budget: BudgetPolicy;
  trajectory: TrajectoryStore;
  /** 候选 kind 标签（默认 novelos_agentic） */
  kind?: string;
  /** context transform（每轮 LLM 调用前对 messages 变换） */
  transformContext?: AgentOptions["transformContext"];
  /** stop hook（每轮结束后评估是否需要下一轮 / 替换 context） */
  prepareNextTurnWithContext?: AgentOptions["prepareNextTurnWithContext"];
  /**
   * beforeToolCall hook：工具执行前调用，可返回 { block: true } 阻断执行。
   * 若提供，runtime 包装为「先跑自定义 hook，再检查检索预算」。
   */
  beforeToolCall?: AgentOptions["beforeToolCall"];
  /**
   * afterToolCall hook（Task A.4）：工具执行完成后调用。
   * 若不提供，runtime 默认在 budget.isExhausted() 时返回 { terminate: true } 停止 loop。
   * 若提供，runtime 包装为「先跑自定义 hook，再检查预算」。
   * 注意：shouldStopAfterTurn 不在高层 AgentOptions 中，故用 afterToolCall terminate 实现 bounded stop。
   */
  afterToolCall?: AgentOptions["afterToolCall"];
  /** 模型调用超时 ms */
  timeoutMs?: number;
}

/** NovelOS Runtime 实例 */
export interface NovelOSRuntime {
  readonly session: NovelSession;
  readonly agent: Agent;
  readonly budget: BudgetPolicy;
  readonly trajectory: TrajectoryStore;
  /** 发起一轮 prompt（预算耗尽时不发起，记录 failure） */
  prompt(text: string): Promise<void>;
  /** 等待运行结束 */
  waitForIdle(): Promise<void>;
  /** bounded stop */
  abort(): Promise<void>;
  /** 订阅事件流（与内部 trajectory/budget 订阅并行） */
  subscribe(listener: (event: AgentEvent) => void): () => void;
  /** 预算快照 */
  getBudgetSnapshot(): BudgetSnapshot;
}

// ============================================================================
// 工厂
// ============================================================================

/**
 * 创建 NovelOS Runtime。
 *
 * 内部自动：
 * 1. 用 createNovelOSAgent 创建 Agent（桥接 project ModelGenerateFn）；
 * 2. 订阅事件流 → trajectory 记录 + budget 追踪（turn/tool/token/modelCall）；
 * 3. prompt 前检查预算耗尽。
 */
export function createNovelOSRuntime(options: NovelOSRuntimeOptions): NovelOSRuntime {
  const {
    session,
    systemPrompt,
    modelGenerate,
    route,
    tools,
    allowedToolNames,
    retrievalToolNames,
    retrievalBudget,
    budget,
    trajectory,
    kind,
    transformContext,
    prepareNextTurnWithContext,
    beforeToolCall: customBeforeToolCall,
    afterToolCall: customAfterToolCall,
    timeoutMs,
  } = options;

  // Phase 2D 缺口三执行：统计已计划的检索类工具调用次数，达到 retrievalBudget 时
  // 用 beforeToolCall 阻断后续检索调用（不终止 loop），让"检索深度 → 工具调用次数"
  // 成为系统强制约束，同时保留最终正文回合。
  //
  // 对比旧实现（用 afterToolCall terminate）：
  // - terminate 在工具执行后才检查 → budget=0 仍放行 1 次（应为 0）；
  // - terminate 会终止整个 loop → budget=2 用尽后没有最终正文回合（应继续生成正文）。
  // beforeToolCall 在执行前阻断，两处缺陷一并修复。
  //
  // 计数位置说明：在 beforeToolCall 内计数（而非 tool_execution_start 事件），
  // 因为 pi-agent-core 默认 parallel 模式会对同一 assistant 消息内的多个工具调用
  // 先顺序 preflight（全部 beforeToolCall），再并发执行。若在 tool_execution_start
  // 计数，同一批内的多个检索调用 preflight 时计数均为 0，会全部放行、超预算。
  // 在 beforeToolCall 内计数可对同一批检索调用逐个判断并阻断超限部分。
  let retrievalCallCount = 0;
  const hasRetrievalBudget =
    retrievalToolNames && retrievalBudget !== undefined && retrievalBudget >= 0;
  const handleRetrieval = (
    ctx: { toolCall: { name?: string } },
  ): { block?: boolean; reason?: string } | undefined => {
    const toolName = ctx.toolCall.name ?? "";
    if (!retrievalToolNames || !retrievalToolNames.has(toolName)) {
      return undefined; // 非检索工具放行
    }
    // 已执行（或已计划执行）的检索调用达到预算 → 阻断，提示模型改生成正文
    if (hasRetrievalBudget && retrievalCallCount >= (retrievalBudget as number)) {
      return { block: true, reason: RETRIEVAL_BUDGET_BLOCK_REASON };
    }
    retrievalCallCount += 1; // 记录本次计划执行的检索调用
    return undefined;
  };

  // 构造默认 beforeToolCall：检索预算用尽时阻断检索工具执行（发出阻断工具结果，
  // 提示模型停止检索并生成正文）；非检索工具或预算未用尽时放行。
  const beforeToolCall: AgentOptions["beforeToolCall"] = customBeforeToolCall
    ? async (ctx, signal) => {
        const customResult = await customBeforeToolCall(ctx, signal);
        if (customResult?.block) return customResult;
        return handleRetrieval(ctx);
      }
    : async (ctx) => handleRetrieval(ctx);

  // 构造默认 afterToolCall：仅在整体预算耗尽时返回 { terminate: true } 停止 loop。
  // 检索预算由 beforeToolCall 阻断处理，不再通过 terminate 终止（避免吞掉最终正文回合）。
  const afterToolCall: AgentOptions["afterToolCall"] = customAfterToolCall
    ? async (ctx, signal) => {
        const customResult = await customAfterToolCall(ctx, signal);
        if (budget.isExhausted()) {
          return { ...(customResult ?? {}), terminate: true };
        }
        return customResult;
      }
    : async (_ctx, _signal) => {
        if (budget.isExhausted()) {
          return { terminate: true };
        }
        return undefined;
      };

  const agent = createNovelOSAgent({
    systemPrompt,
    route,
    modelGenerate,
    tools,
    allowedToolNames,
    sessionId: session.sessionId,
    kind,
    transformContext,
    prepareNextTurnWithContext,
    beforeToolCall,
    afterToolCall,
    timeoutMs,
  });

  // 内部订阅：trajectory 记录 + budget 追踪 + 检索调用计数
  agent.subscribe((event: AgentEvent) => {
    trajectory.recordToolEvent(event);

    switch (event.type) {
      case "turn_start":
        budget.recordTurn();
        break;
      case "tool_execution_start": {
        budget.recordToolCall();
        break;
      }
      case "message_end": {
        // 从 assistant message 提取 usage（token/cost）
        const usage = (event as { message?: { usage?: { input?: number; output?: number } } })
          .message?.usage;
        if (usage) {
          budget.recordTokens(usage.input ?? 0, usage.output ?? 0);
          budget.recordModelCall();
        }
        break;
      }
      default:
        break;
    }
  });

  const runtime: NovelOSRuntime = {
    session,
    agent,
    budget,
    trajectory,

    async prompt(text: string): Promise<void> {
      if (budget.isExhausted()) {
        const snapshot = budget.getSnapshot();
        const envelope: TrajectoryFailureEnvelope = {
          stage: "novelos_prompt",
          severity: "soft",
          reason: `budget exhausted: ${snapshot.exhaustedReason ?? "unknown"}`,
          recoverable: true,
          retryPlan: "fallback to one_shot_raw",
        };
        trajectory.recordFailure(envelope);
        return;
      }
      // 记录 user 消息到 trajectory
      trajectory.recordMessage({
        role: "user",
        content: text,
        timestamp: Date.now(),
      } as AgentMessage);
      await agent.prompt(text);
    },

    waitForIdle(): Promise<void> {
      return agent.waitForIdle();
    },

    async abort(): Promise<void> {
      await agent.abort();
    },

    subscribe(listener: (event: AgentEvent) => void): () => void {
      return agent.subscribe(listener);
    },

    getBudgetSnapshot(): BudgetSnapshot {
      return budget.getSnapshot();
    },
  };

  return runtime;
}
