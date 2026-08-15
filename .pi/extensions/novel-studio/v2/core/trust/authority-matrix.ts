/**
 * AUTHORITY-MATRIX — 权限来源矩阵（PROMPT-INJECTION-TRUST-ARCHITECTURE-1 Phase 0）
 *
 * 系统规则、作者契约、已提交状态、资料、模型输出、用户反馈
 * 分别允许影响哪些生产阶段。矩阵可被测试读取，是 fail-closed 真相源。
 */

import type {
  Authority,
  FeedbackAllowedEffect,
  FeedbackTrustCategory,
  TrustAffectedStage,
  TrustClass,
  TrustSourceKind,
} from "./trust-types.js";

export interface AuthorityMatrixRow {
  source: TrustSourceKind;
  trustClass: TrustClass;
  defaultAuthority: Authority;
  /** 允许影响的阶段 */
  allowedStages: readonly TrustAffectedStage[];
  /** 明确禁止的阶段 */
  forbiddenStages: readonly TrustAffectedStage[];
  notes: string;
}

/**
 * 权限来源矩阵（计划 §3 / Phase 0 任务 3）。
 * 未知来源默认无权限。
 */
export const AUTHORITY_MATRIX: readonly AuthorityMatrixRow[] = [
  {
    source: "system_rule",
    trustClass: "system_authority",
    defaultAuthority: "hard_constraint",
    allowedStages: [
      "context_compile",
      "chapter_intent",
      "tool_authorization",
      "fact_guard",
      "hard_gate",
      "approval",
      "chapter_save",
      "state_commit",
      "review_surface",
      "model_routing",
      "security_boundary",
    ],
    forbiddenStages: [],
    notes: "系统策略与事务规则，可形成硬约束",
  },
  {
    source: "author_contract",
    trustClass: "author_authority",
    defaultAuthority: "hard_constraint",
    allowedStages: [
      "context_compile",
      "chapter_intent",
      "fact_guard",
      "hard_gate",
      "candidate_selection",
      "state_commit",
      "review_surface",
    ],
    forbiddenStages: ["tool_authorization", "security_boundary", "model_routing"],
    notes: "CreativeConstitution / ChapterIntent / 作者明确契约",
  },
  {
    source: "committed_state",
    trustClass: "committed_state",
    defaultAuthority: "hard_constraint",
    allowedStages: [
      "context_compile",
      "chapter_intent",
      "fact_guard",
      "hard_gate",
      "state_commit",
      "review_surface",
    ],
    forbiddenStages: [
      "tool_authorization",
      "security_boundary",
      "model_routing",
      "approval",
    ],
    notes: "已确认章节派生的 Canon/Character/Promise/Pattern，必须可回源",
  },
  {
    source: "reference_material",
    trustClass: "retrieved_reference",
    defaultAuthority: "reference_only",
    allowedStages: ["context_compile", "review_surface"],
    forbiddenStages: [
      "chapter_intent",
      "tool_authorization",
      "fact_guard",
      "hard_gate",
      "approval",
      "chapter_save",
      "state_commit",
      "security_boundary",
      "model_routing",
      "strategy_learning",
    ],
    notes: "历史正文/检索/风格示例只能作为资料，不产生指令权",
  },
  {
    source: "model_output",
    trustClass: "model_or_user_untrusted",
    defaultAuthority: "no_authority",
    allowedStages: ["candidate_selection", "review_surface"],
    forbiddenStages: [
      "context_compile",
      "chapter_intent",
      "tool_authorization",
      "fact_guard",
      "hard_gate",
      "approval",
      "chapter_save",
      "state_commit",
      "security_boundary",
      "model_routing",
      "strategy_learning",
    ],
    notes: "模型输出默认不可信；confirm/approved 永不授权",
  },
  {
    source: "user_feedback",
    trustClass: "model_or_user_untrusted",
    defaultAuthority: "no_authority",
    allowedStages: ["strategy_learning", "review_surface"],
    forbiddenStages: [
      "chapter_save",
      "state_commit",
      "hard_gate",
      "fact_guard",
      "security_boundary",
      "model_routing",
      "approval",
      "tool_authorization",
    ],
    notes: "反馈 next-request-only；不能改当前正文/安全边界",
  },
] as const;

/** 反馈分类 → 允许效果 */
export const FEEDBACK_CATEGORY_EFFECTS: Readonly<
  Record<FeedbackTrustCategory, readonly FeedbackAllowedEffect[]>
> = {
  literary_preference: ["strategy_sampling", "diagnostic_evidence"],
  context_correction: ["recompile_context", "diagnostic_evidence"],
  fact_correction: ["author_confirm_required", "diagnostic_evidence"],
  workflow_preference: ["strategy_sampling"],
  security_sensitive_request: ["reject", "quarantine"],
};

/** 查询某来源是否允许影响某阶段 */
export function sourceMayAffectStage(
  source: TrustSourceKind,
  stage: TrustAffectedStage,
): boolean {
  const row = AUTHORITY_MATRIX.find((entry) => entry.source === source);
  if (!row) return false;
  if (row.forbiddenStages.includes(stage)) return false;
  return row.allowedStages.includes(stage);
}

/** 查询来源默认信任层 */
export function getSourceTrustClass(source: TrustSourceKind): TrustClass {
  const row = AUTHORITY_MATRIX.find((entry) => entry.source === source);
  return row?.trustClass ?? "model_or_user_untrusted";
}

/** 查询来源默认权限 */
export function getSourceAuthority(source: TrustSourceKind): Authority {
  const row = AUTHORITY_MATRIX.find((entry) => entry.source === source);
  return row?.defaultAuthority ?? "no_authority";
}

/**
 * 安全敏感反馈关键词（启发式分类，不作为唯一防御）。
 * 命中后分类为 security_sensitive_request。
 */
const SECURITY_SENSITIVE_PATTERNS: readonly RegExp[] = [
  /关闭\s*FactGuard/i,
  /disable\s*fact\s*guard/i,
  /跳过\s*审批/,
  /bypass\s*approval/i,
  /忽略\s*(系统|之前|以上)?\s*规则/,
  /ignore\s*(all\s*)?(previous|prior|system)\s*(rules|instructions)/i,
  /你现在是/,
  /you\s+are\s+now/i,
  /修改\s*安全\s*边界/,
  /改写\s*(系统|权限|路由)/,
  /override\s*(security|policy|routing)/i,
  /grant\s*(admin|root|commit)/i,
];

/**
 * 对自然语言反馈做信任分类（启发式 + 可测试）。
 * 安全敏感请求优先；事实修正次之；默认文学偏好。
 */
export function classifyFeedbackTrust(
  text: string,
  hints?: {
    isFactCorrection?: boolean;
    isContextCorrection?: boolean;
    isWorkflowPreference?: boolean;
  },
): FeedbackTrustCategory {
  const normalized = (text ?? "").trim();
  if (!normalized) return "literary_preference";

  for (const pattern of SECURITY_SENSITIVE_PATTERNS) {
    if (pattern.test(normalized)) {
      return "security_sensitive_request";
    }
  }

  if (hints?.isFactCorrection) return "fact_correction";
  if (hints?.isContextCorrection) return "context_correction";
  if (hints?.isWorkflowPreference) return "workflow_preference";

  if (/事实错误|设定冲突|时间线不对|人物已死|名字错了/.test(normalized)) {
    return "fact_correction";
  }
  if (/补充背景|上下文不足|漏了前章|需要重编上下文/.test(normalized)) {
    return "context_correction";
  }
  if (/下次少用|偏好|节奏|文风|口吻/.test(normalized)) {
    return "literary_preference";
  }

  return "literary_preference";
}

/** 反馈是否允许写入策略信誉（文学偏好且非安全敏感） */
export function feedbackMayUpdateLiteraryReputation(
  category: FeedbackTrustCategory,
): boolean {
  return category === "literary_preference";
}

/** 反馈是否被拒绝（安全敏感） */
export function feedbackIsRejected(category: FeedbackTrustCategory): boolean {
  return category === "security_sensitive_request";
}

/** 导出矩阵供测试/仪表盘读取 */
export function listAuthorityMatrix(): readonly AuthorityMatrixRow[] {
  return AUTHORITY_MATRIX;
}
