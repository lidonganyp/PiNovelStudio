/**
 * NovelOS Budget Policy（OPT-8.10）
 *
 * turn/tool/token/latency/cost 预算 + 模型升级预算。
 * 与编排器 modelBudget（SOFT/HARD）协调：NovelOS 模型调用经 wrapModelFn
 * 计入章节总数，本 Policy 追加 turn/tool/latency 维度。
 *
 * 设计原则：
 * - 模型调用计数由编排器 wrapModelFn 统一管理（SOFT=6/HARD=10）；
 * - 本 Policy 追加 NovelOS 专属维度：turn / toolCall / latency / token；
 * - 预算耗尽时标记 exhausted + reason，由 agent loop 停止条件消费。
 */

/** 预算配置 */
export interface BudgetConfig {
  /** 最大 turn 数（默认 10） */
  maxTurns: number;
  /** 最大 tool call 数（默认 20） */
  maxToolCalls: number;
  /** 最大累计延迟 ms（默认 300000 = 5min） */
  maxLatencyMs: number;
  /** 最大输入 token（0 = 不限） */
  maxTokensIn: number;
  /** 最大输出 token（0 = 不限） */
  maxTokensOut: number;
}

/** 预算快照（写入 trajectory） */
export interface BudgetSnapshot {
  turns: number;
  toolCalls: number;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  /** 模型调用次数（与编排器 modelBudget.used 协调） */
  modelCalls: number;
  exhausted: boolean;
  exhaustedReason?: string;
}

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  maxTurns: 10,
  maxToolCalls: 20,
  maxLatencyMs: 300_000,
  maxTokensIn: 0,
  maxTokensOut: 0,
};

/**
 * 从环境变量构造预算配置（允许运行时覆盖）。
 * env: PINOVEL_NOVELOS_MAX_TURNS / PINOVEL_NOVELOS_MAX_TOOL_CALLS / PINOVEL_NOVELOS_MAX_LATENCY_MS
 */
export function createBudgetConfigFromEnv(overrides?: Partial<BudgetConfig>): BudgetConfig {
  const env = process.env;
  const config: BudgetConfig = { ...DEFAULT_BUDGET_CONFIG };
  const maxTurns = Number(env.PINOVEL_NOVELOS_MAX_TURNS);
  if (Number.isFinite(maxTurns) && maxTurns > 0) config.maxTurns = maxTurns;
  const maxToolCalls = Number(env.PINOVEL_NOVELOS_MAX_TOOL_CALLS);
  if (Number.isFinite(maxToolCalls) && maxToolCalls > 0) config.maxToolCalls = maxToolCalls;
  const maxLatencyMs = Number(env.PINOVEL_NOVELOS_MAX_LATENCY_MS);
  if (Number.isFinite(maxLatencyMs) && maxLatencyMs > 0) config.maxLatencyMs = maxLatencyMs;
  return { ...config, ...overrides };
}

export class BudgetPolicy {
  private readonly config: BudgetConfig;
  private turns = 0;
  private toolCalls = 0;
  private latencyMs = 0;
  private tokensIn = 0;
  private tokensOut = 0;
  private modelCalls = 0;
  private exhausted = false;
  private exhaustedReason: string | undefined;

  constructor(config?: Partial<BudgetConfig>) {
    this.config = { ...DEFAULT_BUDGET_CONFIG, ...(config ?? {}) };
  }

  recordTurn(): void {
    this.turns++;
    this.checkExhaustion();
  }

  recordToolCall(): void {
    this.toolCalls++;
    this.checkExhaustion();
  }

  recordLatency(ms: number): void {
    this.latencyMs += ms;
    this.checkExhaustion();
  }

  recordTokens(input: number, output: number): void {
    this.tokensIn += input;
    this.tokensOut += output;
    this.checkExhaustion();
  }

  recordModelCall(): void {
    this.modelCalls++;
    this.checkExhaustion();
  }

  isExhausted(): boolean {
    return this.exhausted;
  }

  getSnapshot(): BudgetSnapshot {
    return {
      turns: this.turns,
      toolCalls: this.toolCalls,
      latencyMs: this.latencyMs,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      modelCalls: this.modelCalls,
      exhausted: this.exhausted,
      exhaustedReason: this.exhaustedReason,
    };
  }

  getConfig(): BudgetConfig {
    return this.config;
  }

  private checkExhaustion(): void {
    if (this.exhausted) return;
    if (this.turns >= this.config.maxTurns) {
      this.markExhausted(`maxTurns reached (${this.config.maxTurns})`);
    } else if (this.toolCalls >= this.config.maxToolCalls) {
      this.markExhausted(`maxToolCalls reached (${this.config.maxToolCalls})`);
    } else if (this.latencyMs >= this.config.maxLatencyMs) {
      this.markExhausted(`maxLatencyMs reached (${this.config.maxLatencyMs}ms)`);
    } else if (this.config.maxTokensIn > 0 && this.tokensIn >= this.config.maxTokensIn) {
      this.markExhausted(`maxTokensIn reached (${this.config.maxTokensIn})`);
    } else if (this.config.maxTokensOut > 0 && this.tokensOut >= this.config.maxTokensOut) {
      this.markExhausted(`maxTokensOut reached (${this.config.maxTokensOut})`);
    }
  }

  private markExhausted(reason: string): void {
    this.exhausted = true;
    this.exhaustedReason = reason;
  }
}
