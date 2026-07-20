/**
 * P1-6：最终决策规则。
 *
 * 决策类型：
 * - GO_CANDIDATE：机制评测通过 + required facts 达标 + wrong retrieval 达标
 *   + LLM pairwise 多数决无负收益 + 裁判校准门槛通过
 * - HOLD：机制正确但部分条件未通过
 * - NO_GO：检索无增益或 LLM 判定负收益
 * - NEEDS_HUMAN_REVIEW：LLM 分歧 / 顺序敏感 / 置信度不足 / verifier 与 LLM 冲突
 *
 * 正式 GO 只能由已校准的自动裁判结果加抽样复核产生（10%-20% 样本）。
 * 自动系统最多输出 GO_CANDIDATE，不输出正式 GO。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────────

export type FinalDecisionType =
  | "GO_CANDIDATE"
  | "HOLD"
  | "NO_GO"
  | "NEEDS_HUMAN_REVIEW";

export interface FinalDecisionCondition {
  name: string;
  passed: boolean;
  detail: string;
}

export interface FinalDecision {
  decision: FinalDecisionType;
  reasons: string[];
  conditions: FinalDecisionCondition[];
}

export interface MakeFinalDecisionParams {
  /** 机制评测通过（runFullEval 的 GO 条件全过） */
  mechanismEvalPassed: boolean;
  /** required facts 达标（B2 覆盖率 > B1，B3 >= B2） */
  requiredFactsPassed: boolean;
  /** wrong retrieval 达标（错误检索率 <= 阈值） */
  wrongRetrievalPassed: boolean;
  /** LLM pairwise 多数决无负收益（B2 不输 B1，B3 不输 B2） */
  llmPairwiseNoNegative: boolean;
  /** 裁判校准门槛通过（runCalibration passed=true） */
  calibrationPassed: boolean;

  // ── NEEDS_HUMAN_REVIEW 触发条件 ──────────────────────────────────
  /** LLM 调用分歧（3 轮无多数决） */
  llmDisagreement: boolean;
  /** 顺序敏感（反转复判 winner 变化） */
  positionSensitive: boolean;
  /** 置信度不足（confidence < 阈值） */
  lowConfidence: boolean;
  /** verifier 与 LLM 冲突（mergeFactRisk source=verifier 但 LLM 判无风险，或反之） */
  verifierLlmConflict: boolean;
  /** M1-R3：Judge 有效 verdict 不足 2/3（无效 verdict 排除出多数决后剩余 < 2） */
  insufficientValidVerdicts?: boolean;

  // ── 可选：是否为新类型/新模型版本/新裁判版本 ─────────────────────
  /** 新版本（新模型/新裁判/新 fixture 类型）→ 强制 NEEDS_HUMAN_REVIEW */
  isNewVersion?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// 决策规则
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 产出最终决策。
 *
 * 决策优先级：
 * 1. NEEDS_HUMAN_REVIEW：任何人工复核触发条件为 true
 * 2. GO_CANDIDATE：5 个核心条件全过 + 无触发条件
 * 3. HOLD：机制评测 + LLM 无负收益通过，但其他条件未过
 * 4. NO_GO：LLM 判定负收益或机制评测未过
 *
 * 正式 GO 只能由人工抽样复核产生，自动系统最多 GO_CANDIDATE。
 */
export function makeFinalDecision(
  params: MakeFinalDecisionParams,
): FinalDecision {
  const conditions: FinalDecisionCondition[] = [
    {
      name: "mechanism_eval_passed",
      passed: params.mechanismEvalPassed,
      detail: params.mechanismEvalPassed
        ? "runFullEval GO 条件全过"
        : "runFullEval GO 条件未全过",
    },
    {
      name: "required_facts_passed",
      passed: params.requiredFactsPassed,
      detail: params.requiredFactsPassed
        ? "B2 覆盖率 > B1，B3 >= B2"
        : "required facts 覆盖率未达标",
    },
    {
      name: "wrong_retrieval_passed",
      passed: params.wrongRetrievalPassed,
      detail: params.wrongRetrievalPassed
        ? "错误检索率 <= 阈值"
        : "错误检索率超阈值",
    },
    {
      name: "llm_pairwise_no_negative",
      passed: params.llmPairwiseNoNegative,
      detail: params.llmPairwiseNoNegative
        ? "LLM pairwise 多数决 B2 不输 B1，B3 不输 B2"
        : "LLM pairwise 判定存在负收益",
    },
    {
      name: "calibration_passed",
      passed: params.calibrationPassed,
      detail: params.calibrationPassed
        ? "裁判校准门槛全过"
        : "裁判校准门槛未过",
    },
  ];

  const reasons: string[] = [];

  // ── 1. NEEDS_HUMAN_REVIEW 触发条件检查 ────────────────────────────
  const humanReviewTriggers: string[] = [];
  if (params.llmDisagreement) {
    humanReviewTriggers.push("LLM 调用分歧（3 轮无多数决）");
  }
  if (params.positionSensitive) {
    humanReviewTriggers.push("顺序敏感（反转复判 winner 变化）");
  }
  if (params.lowConfidence) {
    humanReviewTriggers.push("置信度不足");
  }
  if (params.verifierLlmConflict) {
    humanReviewTriggers.push("verifier 与 LLM 冲突");
  }
  if (params.insufficientValidVerdicts) {
    humanReviewTriggers.push("Judge 有效 verdict 不足 2/3");
  }
  if (params.isNewVersion) {
    humanReviewTriggers.push("新版本（新模型/新裁判/新 fixture 类型）");
  }

  if (humanReviewTriggers.length > 0) {
    return {
      decision: "NEEDS_HUMAN_REVIEW",
      reasons: [
        "触发人工复核条件：",
        ...humanReviewTriggers.map((t) => `  - ${t}`),
        "需人工抽样复核后决定是否进入 GO_CANDIDATE。",
      ],
      conditions,
    };
  }

  // ── 2. GO_CANDIDATE：5 个核心条件全过 ─────────────────────────────
  const allCorePassed = conditions.every((c) => c.passed);
  if (allCorePassed) {
    return {
      decision: "GO_CANDIDATE",
      reasons: [
        "5 个核心条件全过：",
        ...conditions.map((c) => `  - ${c.name}: ${c.detail}`),
        "自动系统最多输出 GO_CANDIDATE，正式 GO 需人工抽样复核（10%-20% 样本）。",
      ],
      conditions,
    };
  }

  // ── 3. HOLD：机制 + LLM 无负收益通过，但其他条件未过 ───────────────
  if (params.mechanismEvalPassed && params.llmPairwiseNoNegative) {
    const failedConditions = conditions.filter((c) => !c.passed);
    return {
      decision: "HOLD",
      reasons: [
        "机制评测与 LLM pairwise 无负收益通过，但部分条件未过：",
        ...failedConditions.map((c) => `  - ${c.name}: ${c.detail}`),
        "建议继续优化后重新评测。",
      ],
      conditions,
    };
  }

  // ── 4. NO_GO：LLM 判定负收益或机制评测未过 ─────────────────────────
  const noGoReasons: string[] = [];
  if (!params.llmPairwiseNoNegative) {
    noGoReasons.push("LLM pairwise 判定存在负收益（B2 输 B1 或 B3 输 B2）");
  }
  if (!params.mechanismEvalPassed) {
    noGoReasons.push("机制评测未过（runFullEval GO 条件未满足）");
  }
  return {
    decision: "NO_GO",
    reasons: noGoReasons,
    conditions,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 格式化
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 格式化最终决策为 Markdown 报告。
 */
export function formatFinalDecisionAsMarkdown(
  decision: FinalDecision,
): string {
  const lines: string[] = [];
  lines.push("# NovelOS M1 最终决策（P1-6）");
  lines.push("");
  lines.push(`## 决策：${decision.decision}`);
  lines.push("");
  lines.push("## 理由");
  lines.push("");
  for (const r of decision.reasons) {
    lines.push(r);
  }
  lines.push("");
  lines.push("## 条件检查");
  lines.push("");
  lines.push("| 条件 | 结果 | 详情 |");
  lines.push("|------|------|------|");
  for (const c of decision.conditions) {
    lines.push(`| ${c.name} | ${c.passed ? "✓" : "✗"} | ${c.detail} |`);
  }
  lines.push("");
  if (decision.decision === "GO_CANDIDATE") {
    lines.push("> 正式 GO 需人工抽样复核（10%-20% 样本）。自动系统最多输出 GO_CANDIDATE。");
  }
  return lines.join("\n");
}
