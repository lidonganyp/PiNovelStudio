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
  /**
   * 最大累计延迟 ms（默认 900000 = 15min）。
   * 由 runtime 在 turn_start/turn_end 上累计墙钟耗时（含模型调用与工具执行）。
   * 取值必须明显大于单次模型请求超时（PINOVEL_MODEL_REQUEST_TIMEOUT_MS 默认 300000），
   * 否则一次正常的整章生成就会触顶；旧默认 300000 与该超时同值，接线后会误杀正常生成。
   */
  maxLatencyMs: number;
  /**
   * 连续工具调用失败上限（默认 3）。
   * 工具结果连续返回 isError 且期间没有任何成功调用时，达到该值即退出 loop，
   * 避免模型在同一个坏工具/坏参数上反复空转（错误次数退出机制）。
   * 成功调用会把连续计数清零，只惩罚"连续"失败。
   */
  maxConsecutiveToolErrors: number;
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
  /** 当前连续工具调用失败次数（成功调用后归零） */
  consecutiveToolErrors: number;
  exhausted: boolean;
  exhaustedReason?: string;
}

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  maxTurns: 10,
  maxToolCalls: 20,
  maxLatencyMs: 900_000,
  maxConsecutiveToolErrors: 3,
  maxTokensIn: 0,
  maxTokensOut: 0,
};

/**
 * 从环境变量构造预算配置（允许运行时覆盖）。
 * env: PINOVEL_NOVELOS_MAX_TURNS / PINOVEL_NOVELOS_MAX_TOOL_CALLS / PINOVEL_NOVELOS_MAX_LATENCY_MS /
 *      PINOVEL_NOVELOS_MAX_CONSECUTIVE_TOOL_ERRORS
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
  const maxConsecutiveToolErrors = Number(env.PINOVEL_NOVELOS_MAX_CONSECUTIVE_TOOL_ERRORS);
  if (Number.isFinite(maxConsecutiveToolErrors) && maxConsecutiveToolErrors > 0) {
    config.maxConsecutiveToolErrors = maxConsecutiveToolErrors;
  }
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
  private consecutiveToolErrors = 0;
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

  /**
   * 记录一次失败的工具调用（错误次数退出机制）。
   * 连续失败达到 maxConsecutiveToolErrors 时标记预算耗尽，由 afterToolCall 终止 loop。
   */
  recordToolError(): void {
    this.consecutiveToolErrors++;
    this.checkExhaustion();
  }

  /** 记录一次成功的工具调用：连续失败计数归零（只惩罚连续失败） */
  recordToolSuccess(): void {
    this.consecutiveToolErrors = 0;
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

  /**
   * 由 runtime 在真实模型调用边界强制标记耗尽（运行级墙钟截止）。
   * 与 checkExhaustion 的区别：后者只由计数器触发；这里把"墙钟已超时"这类
   * 没有单点计数事件的原因也收敛进同一 exhausted 状态，保证停止原因可归因。
   * 已有耗尽原因时不覆盖（保留最早的真实原因）。
   */
  exhaust(reason: string): void {
    if (this.exhausted) return;
    this.markExhausted(reason);
  }

  getSnapshot(): BudgetSnapshot {
    return {
      turns: this.turns,
      toolCalls: this.toolCalls,
      latencyMs: this.latencyMs,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      modelCalls: this.modelCalls,
      consecutiveToolErrors: this.consecutiveToolErrors,
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
    } else if (this.consecutiveToolErrors >= this.config.maxConsecutiveToolErrors) {
      this.markExhausted(
        `maxConsecutiveToolErrors reached (${this.config.maxConsecutiveToolErrors})`,
      );
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
