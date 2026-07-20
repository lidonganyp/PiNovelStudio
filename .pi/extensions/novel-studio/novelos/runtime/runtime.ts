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
  budget: BudgetPolicy;
  trajectory: TrajectoryStore;
  /** 候选 kind 标签（默认 novelos_agentic） */
  kind?: string;
  /** context transform（每轮 LLM 调用前对 messages 变换） */
  transformContext?: AgentOptions["transformContext"];
  /** stop hook（每轮结束后评估是否需要下一轮 / 替换 context） */
  prepareNextTurnWithContext?: AgentOptions["prepareNextTurnWithContext"];
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
    budget,
    trajectory,
    kind,
    transformContext,
    prepareNextTurnWithContext,
    afterToolCall: customAfterToolCall,
    timeoutMs,
  } = options;

  // 构造默认 afterToolCall：预算耗尽时返回 { terminate: true } 停止 loop。
  // shouldStopAfterTurn 不在高层 AgentOptions 中，故用 afterToolCall terminate 实现 bounded stop。
  // 若调用方提供自定义 hook，包装为「先跑自定义、再检查预算」。
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
    sessionId: session.sessionId,
    kind,
    transformContext,
    prepareNextTurnWithContext,
    afterToolCall,
    timeoutMs,
  });

  // 内部订阅：trajectory 记录 + budget 追踪
  agent.subscribe((event: AgentEvent) => {
    trajectory.recordToolEvent(event);

    switch (event.type) {
      case "turn_start":
        budget.recordTurn();
        break;
      case "tool_execution_start":
        budget.recordToolCall();
        break;
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
