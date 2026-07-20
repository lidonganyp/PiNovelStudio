/**
 * PiNovelStudio — FailureEnvelope 阻断归因结构
 *
 * 治理目标：把"随机阻断"治理成可预检、可诊断、可恢复、可回放的稳定生成系统。
 *
 * 所有 Stage/Gate 失败都归一成 FailureEnvelope，写入 quality trace 并返回给调用方。
 * 不再只返回笼统的"章节生成失败"。
 *
 * 接入范围：Stage 0 / 1.5 Preflight / Stage 2 / Stage 5 / Stage 6.5 / Stage 8 / 顶层 catch。
 *
 * 严禁：
 *  - 把硬门禁简单改成 warning pass
 *  - parser/schema 错误直接触发正文重写（应只 retry_gate）
 *  - patch comparator 拒绝后仍覆盖原文
 *  - 无 trace 的 silent degrade
 */

export type FailureSeverity = "preflight" | "recoverable" | "hard_block";

export type RetryStrategy =
  | "retry_gate"
  | "local_repair"
  | "rewrite_event"
  | "bridge_patch"
  | "style_patch"
  | "user_fix"
  | "chapter_level_retry"
  | "event_level_rewrite_bounded"
  | "terminal_block_no_retry";

export interface RetryPlan {
  strategy: RetryStrategy;
  maxAttempts: number;
  constraints?: unknown;
}

export interface FailureEnvelope {
  /** 阶段标识，如 "0-context-load" / "2-narrator" / "6.5-suspense-density" / "8-final" */
  stage: string;
  /** 门禁标识，如 "seed_readiness" / "preflight" / "anti_ai" / "suspense_density" / "scene_continuity" / "style" / "event_progression" / "segment_contract" / "orchestration" */
  gate: string;
  /** 严重程度：preflight=生成前预检、recoverable=可自动恢复、hard_block=硬阻断需用户介入 */
  severity: FailureSeverity;
  /** 人类可读的阻断原因（中文） */
  reason: string;
  /** 结构化证据：gate 输出、命中片段、metrics 等 */
  evidence: unknown;
  /** 是否可自动恢复（与 retryPlan 配合） */
  recoverable: boolean;
  /** 恢复计划 */
  retryPlan?: RetryPlan;
  /** 需要用户补输入的动作清单 */
  userActionRequired?: string[];
}

/**
 * 创建 FailureEnvelope。
 *
 * 恢复策略约束（与方案 §三 Gate 级恢复策略 对齐）：
 *  - schema/parse → retry_gate（只重试 gate 输出，不重写正文）
 *  - anti_ai → local_repair → rewrite_event（带 detection snippet）→ 仍失败才 hard_block
 *  - segment_contract → rewrite_event（只重写当前事件）
 *  - event_progression → 保留主干硬门禁；类型专项义务按既有规则 warning/pass/block
 *  - scene_continuity → bridge_patch（过 comparator）
 *  - style → style_patch（span 级局部 patch；comparator 拒绝后缩小范围或重做，不覆盖原文）
 *  - suspense_density → local_repair（局部增加 hook beat，再重跑 Stage 6.5）→ 仍低于阈值才 hard_block
 */
export function createFailureEnvelope(input: {
  stage: string;
  gate: string;
  severity: FailureSeverity;
  reason: string;
  evidence?: unknown;
  recoverable?: boolean;
  retryPlan?: RetryPlan;
  userActionRequired?: string[];
}): FailureEnvelope {
  const recoverable = input.recoverable ?? input.severity === "recoverable";
  return {
    stage: input.stage,
    gate: input.gate,
    severity: input.severity,
    reason: input.reason,
    evidence: input.evidence ?? null,
    recoverable,
    retryPlan: input.retryPlan,
    userActionRequired: input.userActionRequired,
  };
}

/**
 * 预检类阻断工厂（生成前预检失败，不可自动恢复，需用户补输入）。
 */
export function preflightBlockEnvelope(
  stage: string,
  gate: string,
  reason: string,
  evidence: unknown,
  userActionRequired: string[],
): FailureEnvelope {
  return createFailureEnvelope({
    stage,
    gate,
    severity: "preflight",
    reason,
    evidence,
    recoverable: false,
    userActionRequired,
  });
}

/**
 * 可恢复阻断工厂（模型随机失败，进入 bounded recovery）。
 */
export function recoverableEnvelope(
  stage: string,
  gate: string,
  reason: string,
  evidence: unknown,
  retryPlan: RetryPlan,
): FailureEnvelope {
  return createFailureEnvelope({
    stage,
    gate,
    severity: "recoverable",
    reason,
    evidence,
    recoverable: true,
    retryPlan,
  });
}

/**
 * 硬阻断工厂（重试耗尽或不可恢复，需用户介入或人工审阅）。
 */
export function hardBlockEnvelope(
  stage: string,
  gate: string,
  reason: string,
  evidence: unknown,
  userActionRequired?: string[],
): FailureEnvelope {
  return createFailureEnvelope({
    stage,
    gate,
    severity: "hard_block",
    reason,
    evidence,
    recoverable: false,
    userActionRequired,
  });
}

/**
 * 把 FailureEnvelope 转成可读的多行消息（用于 return.message 或日志）。
 */
export function formatFailureEnvelopeMessage(envelope: FailureEnvelope): string {
  const lines: string[] = [];
  lines.push(`【阻断归因·${envelope.severity}】stage=${envelope.stage} gate=${envelope.gate}`);
  lines.push(`原因：${envelope.reason}`);
  if (envelope.retryPlan) {
    lines.push(
      `恢复策略：${envelope.retryPlan.strategy}（maxAttempts=${envelope.retryPlan.maxAttempts}）`,
    );
  }
  if (envelope.userActionRequired && envelope.userActionRequired.length > 0) {
    lines.push("需要用户操作：");
    for (const action of envelope.userActionRequired) {
      lines.push(`  - ${action}`);
    }
  }
  return lines.join("\n");
}
