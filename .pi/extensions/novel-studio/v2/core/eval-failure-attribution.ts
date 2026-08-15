/**
 * 失败归因与责任边界（离线回放与生产验收闭环 P4 基础字段）
 *
 * 目标：禁止把所有失败笼统记录为"模型失败"。每条失败必须归因到
 * 统一枚举之一；未分类失败必须为 0（验收门槛）。
 *
 * 归因枚举（责任边界）：
 *  - prompt            ：Prompt 设计缺陷（指令冲突、格式说明错误）；
 *  - model             ：模型行为失败（拒答、空响应、退化输出、幻觉硬伤）；
 *  - provider_network  ：provider / 网络层失败（5xx、连接重置、DNS）；
 *  - context           ：上下文构造缺陷（编译器输出缺失/污染）；
 *  - retrieval         ：检索层失败（证据未命中、检索超时）；
 *  - tool_protocol     ：工具协议失败（schema 不符、parse 失败、非法调用）；
 *  - budget            ：预算截断（模型调用次数 / token / 恢复预算耗尽）；
 *  - timeout           ：超时（单请求 / 整章总时长）；
 *  - concurrency       ：并发冲突（锁竞争、CAS 失败、revision 冲突）；
 *  - release_drift     ：release/bundle/hash 漂移（环境与声明身份不符）；
 *  - state_commit      ：状态提交失败（FinalStateCommit、memory hard conflict）；
 *  - human_approval    ：人工审批缺失 / 拒绝（fail-closed 预期路径）；
 *  - replay_environment：回放环境不等价（fixture 缺失、scratch 损坏）；
 *  - grader_instability：grader 不稳定（评分器自身故障，与被测对象无关）。
 *
 * 分类器为本地确定性规则（关键词 + 字段映射，有序首中）；
 * 同一失败在重复回放中的归因必须保持稳定（除非显式标记随机性）。
 */

// ============================================================================
// 归因枚举
// ============================================================================

export const FAILURE_ATTRIBUTIONS = [
  "prompt",
  "model",
  "provider_network",
  "context",
  "retrieval",
  "tool_protocol",
  "budget",
  "timeout",
  "concurrency",
  "release_drift",
  "state_commit",
  "human_approval",
  "replay_environment",
  "grader_instability",
] as const;

export type FailureAttribution = (typeof FAILURE_ATTRIBUTIONS)[number];

/** 未分类哨兵值（进入汇总报表的 unclassified 计数，必须为 0）。 */
export const UNCLASSIFIED_ATTRIBUTION = "unclassified" as const;
export type UnclassifiedAttribution = typeof UNCLASSIFIED_ATTRIBUTION;
export type FailureAttributionOrUnclassified = FailureAttribution | UnclassifiedAttribution;

export function isFailureAttribution(value: unknown): value is FailureAttribution {
  return (
    typeof value === "string" &&
    (FAILURE_ATTRIBUTIONS as readonly unknown[]).includes(value)
  );
}

/** 声明该失败归因存在随机性（重复回放归因允许不稳定）。 */
export const RANDOMNESS_DECLARED = "randomness_declared" as const;

// ============================================================================
// 归因输入（归一化的失败描述）
// ============================================================================

/**
 * 归一化失败输入。兼容旧 craft FailureEnvelope 与
 * UnifiedProductionFailureEnvelope：调用方提取共同字段填入本结构。
 */
export interface FailureAttributionInput {
  /** 失败阶段（如 "2-narrator" / "final-state-commit"）。 */
  stage?: string;
  /** 门禁标识（如 "preflight" / "anti_ai" / "model_timeout"）。 */
  gate?: string;
  /** 严重程度（preflight / recoverable / hard / fatal / hard_block）。 */
  severity?: string;
  /** 人类可读失败原因（中英文均可，做关键词匹配）。 */
  reason?: string;
  /** 模型调用层错误类（来自 ModelCallEntry.errorClass / failureType）。 */
  errorClass?: string;
  /** 模型调用层失败类型（如 timeout / provider_error / parse_error）。 */
  failureType?: string;
  /** 恢复策略（如 retry_gate / chapter_level_retry）。 */
  retryStrategy?: string;
  /**
   * 观察上下文：
   *  - candidate     ：candidate 本身失败（默认）；
   *  - gate          ：gate 误报分析视角；
   *  - replay        ：回放环境视角（fixture/scratch 层问题优先归 replay_environment）；
   *  - grader        ：grader 视角（评分器自身故障优先归 grader_instability）。
   */
  perspective?: "candidate" | "gate" | "replay" | "grader";
  /** 显式随机性声明（模型随机失败 / 抖动）。 */
  randomnessDeclared?: boolean;
}

export interface FailureAttributionResult {
  attribution: FailureAttributionOrUnclassified;
  /** 命中的规则 ID（如 "rule:gate=model_timeout"）；unclassified 时为 "none"。 */
  ruleId: string;
  /** 命中证据（哪个字段 / 哪个关键词触发）。 */
  evidence: string;
  /** 随机性声明透传。 */
  randomnessDeclared: boolean;
}

// ============================================================================
// 规则表（有序，首中即返回）
// ============================================================================

interface AttributionRule {
  ruleId: string;
  attribution: FailureAttribution;
  /** 匹配函数：返回 true 即命中。 */
  match: (input: FailureAttributionInput, text: string) => boolean;
}

function containsAny(text: string, keywords: ReadonlyArray<string>): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

/**
 * 归因规则表。顺序即优先级：
 * 环境类（grader/replay）> 治理类（approval/release/state/concurrency）>
 * 资源类（budget/timeout/provider）> 协议类（tool/prompt/context/retrieval）>
 * 模型类（model）。
 */
const ATTRIBUTION_RULES: ReadonlyArray<AttributionRule> = [
  {
    ruleId: "rule:perspective=grader",
    attribution: "grader_instability",
    match: (input) => input.perspective === "grader",
  },
  {
    ruleId: "rule:perspective=replay",
    attribution: "replay_environment",
    match: (input) => input.perspective === "replay",
  },
  {
    ruleId: "rule:gate=human_approval",
    attribution: "human_approval",
    match: (_input, text) =>
      containsAny(text, [
        "human_approval",
        "humanapproval",
        "approval_missing",
        "approval_refused",
        "人工审批",
        "审批缺失",
        "用户审批",
        "requires_approval",
      ]),
  },
  {
    ruleId: "rule:release_drift",
    attribution: "release_drift",
    match: (_input, text) =>
      containsAny(text, [
        "release_drift",
        "release drift",
        "bundle mismatch",
        "bundle_mismatch",
        "fingerprint mismatch",
        "fingerprint_mismatch",
        "stale release",
        "stale_release",
        "g6_release_gate",
        "发布漂移",
        "指纹不匹配",
      ]),
  },
  {
    ruleId: "rule:concurrency",
    attribution: "concurrency",
    match: (_input, text) =>
      containsAny(text, [
        "concurrency",
        "lock_conflict",
        "lock conflict",
        "cas_failed",
        "cas failed",
        "revision_conflict",
        "revision conflict",
        "epoch mismatch",
        "double_submit",
        "并发冲突",
        "锁竞争",
        "重复提交",
      ]),
  },
  {
    ruleId: "rule:state_commit",
    attribution: "state_commit",
    match: (_input, text) =>
      containsAny(text, [
        "state_commit",
        "state commit",
        "final_state_commit",
        "final state commit",
        "memory_hard_conflict",
        "memory hard conflict",
        "状态提交失败",
        "状态污染",
      ]),
  },
  {
    ruleId: "rule:budget",
    attribution: "budget",
    match: (_input, text) =>
      containsAny(text, [
        "budget_exhausted",
        "budget exhausted",
        "budget_exceeded",
        "max_model_calls",
        "maxmodelcalls",
        "recovery_budget",
        "token_budget",
        "预算耗尽",
        "预算截断",
        "budget exhausted",
      ]),
  },
  {
    ruleId: "rule:timeout",
    attribution: "timeout",
    match: (input, text) =>
      input.retryStrategy === "retry_gate" && containsAny(text, ["timeout", "timed out", "超时"]) === true
        ? true
        : containsAny(text, [
            "model_timeout",
            "model timeout",
            "request_timeout",
            "request timeout",
            "total_timeout",
            "timed_out",
            "timed out",
            "无限等待",
            "超时",
          ]),
  },
  {
    ruleId: "rule:provider_network",
    attribution: "provider_network",
    match: (_input, text) =>
      containsAny(text, [
        "provider_error",
        "provider error",
        "econnreset",
        "econnrefused",
        "enotfound",
        "socket hang up",
        "socket_hang_up",
        "5xx",
        "502 bad gateway",
        "503",
        "504",
        "rate_limit",
        "rate limit",
        "quota_exceeded",
        "quota exceeded",
        "网络错误",
        "连接重置",
        "配额不足",
      ]),
  },
  {
    ruleId: "rule:tool_protocol",
    attribution: "tool_protocol",
    match: (_input, text) =>
      containsAny(text, [
        "schema_error",
        "schema error",
        "schema_validation",
        "parse_error",
        "parse error",
        "invalid_tool_call",
        "invalid tool call",
        "tool_protocol",
        "tool protocol",
        "malformed_json",
        "malformed json",
        "协议错误",
        "解析失败",
      ]),
  },
  {
    ruleId: "rule:retrieval",
    attribution: "retrieval",
    match: (_input, text) =>
      containsAny(text, [
        "retrieval_failed",
        "retrieval failed",
        "retrieval_timeout",
        "no_evidence",
        "no evidence found",
        "evidence_missing",
        "检索失败",
        "证据未命中",
        "coverage_insufficient",
        "coverage 不足",
      ]),
  },
  {
    ruleId: "rule:context",
    attribution: "context",
    match: (_input, text) =>
      containsAny(text, [
        "context_compile",
        "context compile",
        "context_compiler",
        "context compiler",
        "compiled_context_invalid",
        "missing_context",
        "上下文缺失",
        "上下文构造失败",
      ]),
  },
  {
    ruleId: "rule:prompt",
    attribution: "prompt",
    match: (_input, text) =>
      containsAny(text, [
        "prompt_error",
        "prompt defect",
        "instruction_conflict",
        "instruction conflict",
        "prompt_conflict",
        "提示词冲突",
        "指令冲突",
      ]),
  },
  {
    ruleId: "rule:model",
    attribution: "model",
    match: (_input, text) =>
      containsAny(text, [
        "empty_response",
        "empty response",
        "empty candidate",
        "model_refusal",
        "model refusal",
        "degenerated_output",
        "degenerated output",
        "fact_violation",
        "fact violation",
        "entity_hallucination",
        "entity hallucination",
        "worldview_conflict",
        "worldview conflict",
        "continuity_break",
        "continuity break",
        "空响应",
        "拒答",
        "幻觉",
        "连续性断裂",
      ]),
  },
];

/**
 * 对归一化失败输入做确定性归因。
 * 无规则命中 → "unclassified"（必须进入未分类检测器，验收要求 0）。
 */
export function classifyFailureAttribution(
  input: FailureAttributionInput,
): FailureAttributionResult {
  const gateText = `${input.gate ?? ""} ${input.stage ?? ""}`.toLowerCase();
  const text = [
    input.reason ?? "",
    input.errorClass ?? "",
    input.failureType ?? "",
    input.retryStrategy ?? "",
    gateText,
    input.severity ?? "",
  ]
    .join(" \n ")
    .toLowerCase();

  for (const rule of ATTRIBUTION_RULES) {
    if (rule.match(input, text)) {
      return {
        attribution: rule.attribution,
        ruleId: rule.ruleId,
        evidence: `规则 ${rule.ruleId} 命中（gate=${input.gate ?? "?"}, stage=${input.stage ?? "?"}）`,
        randomnessDeclared: input.randomnessDeclared === true,
      };
    }
  }

  return {
    attribution: UNCLASSIFIED_ATTRIBUTION,
    ruleId: "none",
    evidence: `无规则命中（gate=${input.gate ?? "?"}, stage=${input.stage ?? "?"}, reason=${(input.reason ?? "").slice(0, 120)}）`,
    randomnessDeclared: input.randomnessDeclared === true,
  };
}

// ============================================================================
// 稳定性校验（同一失败重复回放归因一致性）
// ============================================================================

/**
 * 校验同一失败在重复回放中的归因是否稳定。
 * 任一次显式声明随机性 → 允许不稳定；否则归因必须一致。
 */
export function isAttributionStable(
  results: ReadonlyArray<FailureAttributionResult>,
): boolean {
  if (results.length <= 1) {
    return true;
  }
  if (results.some((r) => r.randomnessDeclared)) {
    return true;
  }
  const first = results[0].attribution;
  return results.every((r) => r.attribution === first);
}

// ============================================================================
// 汇总
// ============================================================================

export interface AttributionSummary {
  total: number;
  classified: number;
  unclassified: number;
  counts: Record<FailureAttributionOrUnclassified, number>;
}

const EMPTY_COUNTS = (): Record<FailureAttributionOrUnclassified, number> => {
  const counts = {} as Record<FailureAttributionOrUnclassified, number>;
  for (const key of FAILURE_ATTRIBUTIONS) {
    counts[key] = 0;
  }
  counts[UNCLASSIFIED_ATTRIBUTION] = 0;
  return counts;
};

/**
 * 汇总归因计数。unclassified > 0 时调用方必须阻断结果统计（验收门槛：0）。
 */
export function summarizeAttributions(
  results: ReadonlyArray<FailureAttributionResult>,
): AttributionSummary {
  const counts = EMPTY_COUNTS();
  for (const result of results) {
    counts[result.attribution] += 1;
  }
  return {
    total: results.length,
    classified: results.length - counts[UNCLASSIFIED_ATTRIBUTION],
    unclassified: counts[UNCLASSIFIED_ATTRIBUTION],
    counts,
  };
}

/**
 * 未分类失败检测器：列出全部 unclassified 条目（验收要求清零）。
 */
export function detectUnclassifiedFailures(
  results: ReadonlyArray<FailureAttributionResult>,
): FailureAttributionResult[] {
  return results.filter((r) => r.attribution === UNCLASSIFIED_ATTRIBUTION);
}
