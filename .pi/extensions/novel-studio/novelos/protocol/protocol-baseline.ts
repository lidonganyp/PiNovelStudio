/**
 * NovelOS Protocol Baseline Audit（Phase 0）
 *
 * 梳理当前 ReAct 调用、解析、执行、结果回传链路，固定基线指标定义。
 * 本模块是纯数据/类型模块，不产生副作用。
 *
 * 交付物：
 * - ReAct baseline 指标定义
 * - 固定 Eval fixture 定义
 * - 当前链路依赖图
 * - 风险与未决问题清单
 */

// ============================================================================
// ReAct Baseline 指标定义
// ============================================================================

/**
 * 协议层基线指标（ReAct 与 Native 共用同一套指标口径）。
 * 从 trace 自动计算，用于 A/B 对照。
 */
export interface ProtocolBaselineMetrics {
  /** 非法工具调用率（调用了白名单外的工具名） */
  illegalToolCallRate: number;
  /** parser failure 率（<tool_call> JSON 解析失败） */
  parserFailureRate: number;
  /** 参数 schema 错误率（参数类型/缺失不匹配） */
  schemaErrorRate: number;
  /** 未授权调用率（权限校验失败） */
  unauthorizedCallRate: number;
  /** mustVerify 覆盖率（EvidencePlan 中必须验证的事实点被工具覆盖的比例） */
  mustVerifyCoverage: number;
  /** sourceRef 完整率（工具结果中包含 sourceRef 的比例） */
  sourceRefCompleteness: number;
  /** prematureDoneRate（模型在检索预算未耗尽前提前停止检索） */
  prematureDoneRate: number;
  /** 首次有效证据延迟（从首次模型调用到首个有结果工具调用的 ms） */
  firstEvidenceLatencyMs: number;
  /** token 消耗（输入 + 输出） */
  tokenUsage: { input: number; output: number; total: number };
  /** 延迟（总 wall-clock ms） */
  latencyMs: number;
  /** 调用次数（模型调用数 + 工具调用数） */
  callCounts: { modelCalls: number; toolCalls: number };
  /** trace 完整率（有 trace 文件且字段完整的比例） */
  traceCompleteness: number;
}

/**
 * 基线指标零值（用于初始化）。
 */
export function emptyBaselineMetrics(): ProtocolBaselineMetrics {
  return {
    illegalToolCallRate: 0,
    parserFailureRate: 0,
    schemaErrorRate: 0,
    unauthorizedCallRate: 0,
    mustVerifyCoverage: 0,
    sourceRefCompleteness: 0,
    prematureDoneRate: 0,
    firstEvidenceLatencyMs: 0,
    tokenUsage: { input: 0, output: 0, total: 0 },
    latencyMs: 0,
    callCounts: { modelCalls: 0, toolCalls: 0 },
    traceCompleteness: 0,
  };
}

// ============================================================================
// 硬门指标（不得因成本或延迟下降而退化）
// ============================================================================

/**
 * 硬门指标：以下指标不得因成本或延迟下降而退化。
 */
export const HARD_GATE_METRICS: readonly (keyof ProtocolBaselineMetrics)[] = [
  "illegalToolCallRate",
  "schemaErrorRate",
  "unauthorizedCallRate",
  "mustVerifyCoverage",
  "sourceRefCompleteness",
  "prematureDoneRate",
];

// ============================================================================
// 固定 Eval Fixture 定义
// ============================================================================

/**
 * Eval fixture：固定 workspace、章节、上下文、工具集和检索预算。
 * 同一 fixture 可重复回放，ReAct 与 Native 在同一 fixture 上 A/B。
 */
export interface EvalFixture {
  /** fixture 唯一标识 */
  id: string;
  /** workspace ID */
  workspaceId: string;
  /** 章节号 */
  chapterNumber: number;
  /** 章节标题 */
  chapterTitle: string;
  /** 固定的工具白名单 */
  allowedTools: string[];
  /** 检索预算 */
  budget: {
    maxTurns: number;
    maxToolCalls: number;
    maxLatencyMs: number;
  };
  /** 模型路由 */
  route: string;
  /** 超时 ms */
  timeoutMs: number;
  /** 重试策略 */
  retry: {
    maxAttempts: number;
    backoffMs: number;
  };
}

/**
 * 默认 Eval fixture 集（Phase 0 固定）。
 * ReAct 与 Native 使用完全相同的 fixture 进行 A/B。
 */
export const DEFAULT_EVAL_FIXTURES: readonly EvalFixture[] = [
  {
    id: "fixture-ch1-gemini",
    workspaceId: "eval-workspace-1",
    chapterNumber: 1,
    chapterTitle: "第一章（Gemini ReAct vs Native A/B）",
    allowedTools: [
      "search_narrative_evidence",
      "search_chapter_span",
      "query_canon",
      "query_character_state",
      "query_timeline",
      "query_character_knowledge_boundary",
      "query_promise_ledger",
      "query_pattern_memory",
      "query_voice_evidence",
    ],
    budget: { maxTurns: 6, maxToolCalls: 12, maxLatencyMs: 120_000 },
    route: "v2_rawstage2_gemini31",
    timeoutMs: 300_000,
    retry: { maxAttempts: 1, backoffMs: 0 },
  },
  {
    id: "fixture-ch3-gemini",
    workspaceId: "eval-workspace-1",
    chapterNumber: 3,
    chapterTitle: "第三章（续写连续性验证）",
    allowedTools: [
      "search_narrative_evidence",
      "search_chapter_span",
      "query_canon",
      "query_character_state",
      "query_timeline",
      "query_character_knowledge_boundary",
      "query_promise_ledger",
      "query_pattern_memory",
      "query_voice_evidence",
    ],
    budget: { maxTurns: 6, maxToolCalls: 12, maxLatencyMs: 120_000 },
    route: "v2_rawstage2_gemini31",
    timeoutMs: 300_000,
    retry: { maxAttempts: 1, backoffMs: 0 },
  },
];

// ============================================================================
// 当前链路依赖图
// ============================================================================

/**
 * 当前 ReAct 链路依赖图（代码化记录）。
 */
export const REACT_PIPELINE_DEPENDENCY_GRAPH = {
  steps: [
    {
      step: 1,
      name: "工具 schema 注入",
      module: "novelos/adapters/tool-schema-injector.ts",
      function: "injectToolSchemas",
      input: "systemPrompt + tools + allowedToolNames",
      output: "systemPromptWithTools",
    },
    {
      step: 2,
      name: "模型调用（text-only）",
      module: "novelos/adapters/pi-agent-core-adapter.ts",
      function: "createProjectStreamFn",
      input: "systemPrompt + userPrompt + route",
      output: "ModelGenerateOutput { text, model }",
    },
    {
      step: 3,
      name: "ReAct 指令解析",
      module: "novelos/adapters/react-tool-call-parser.ts",
      function: "parseToolCallDirectives",
      input: "model output text",
      output: "ParsedToolCallOutput { textBlocks, toolCalls, parseFailures }",
    },
    {
      step: 4,
      name: "工具执行",
      module: "pi-agent-core Agent",
      function: "tool dispatch",
      input: "toolCalls",
      output: "toolResult messages",
    },
    {
      step: 5,
      name: "toolResult 回传",
      module: "novelos/adapters/react-tool-call-parser.ts",
      function: "formatToolResultsForPrompt",
      input: "toolResult messages",
      output: "证据文本块（追加到 userPrompt）",
    },
    {
      step: 6,
      name: "下一轮模型调用",
      module: "novelos/adapters/pi-agent-core-adapter.ts",
      function: "buildUserPromptWithContext",
      input: "basePrompt + 证据块",
      output: "userPrompt（含证据回灌）",
    },
  ],
  knownIssues: [
    "模型仍需生成 XML/JSON 格式化工具调用",
    "parser 需要容错和 salvage",
    "toolResult 重新拼接到 user prompt，增加上下文成本",
    "工具调用协议与正文共享同一文本通道",
    "provider 的原生工具调用能力尚未真正进入生产路径",
    "capability 当前按 provider 声明，无法准确反映 endpoint、route 和 adapter 差异",
  ],
} as const;

// ============================================================================
// 风险与未决问题清单
// ============================================================================

/**
 * 风险与控制措施。
 */
export const PROTOCOL_RISKS = [
  {
    risk: "Native 工具调用成功，但检索质量下降",
    control: "必须检查 mustVerify、sourceRef 和 prematureDoneRate，不能只看调用成功率和成本",
  },
  {
    risk: "provider 能力被错误复用",
    control: "所有 capability 必须绑定 provider、endpoint、model、protocol、adapterVersion",
  },
  {
    risk: "协议层侵入业务编排",
    control: "编排器只消费 ModelTurn，不得读取 XML、JSON 或 provider 私有字段",
  },
  {
    risk: "Native 失败后静默降级",
    control: "统一 FailureEnvelope；Native Eval 失败必须显式失败，不得自动交付 raw 或未优化正文",
  },
  {
    risk: "ReAct 与 Native 使用不同测试条件",
    control: "Stage N 固定 Prompt、上下文、工具集、预算、模型和 endpoint，仅切换协议",
  },
  {
    risk: "形成双套生产协议",
    control: "Native 在评估通过并完成发布决策前，只允许存在于 Eval-only；正式发布后仅保留唯一当前生产协议",
  },
] as const;
