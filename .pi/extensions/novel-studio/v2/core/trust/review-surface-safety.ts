/**
 * REVIEW-SURFACE-SAFETY — Review Surface 脱敏与只读降级
 * （PROMPT-INJECTION-TRUST-ARCHITECTURE-1 Phase 6）
 *
 * - 过滤 <think>、API key、Bearer token、内部思维、敏感路径
 * - 损坏/未知 artifact 只读降级，不自动修复或提交
 * - 不把 judge winner / 总分渲染为客观答案
 */

export type ReviewDegradeReason =
  | "unknown_schema"
  | "corrupt_artifact"
  | "missing_candidate_text"
  | "invalid_span"
  | "blocked_artifact"
  | "hash_mismatch";

export interface ReviewDegradeResult {
  mode: "readonly_degraded";
  reason: ReviewDegradeReason;
  migrationHint: string;
  /** 是否允许提交（永远 false） */
  canSubmit: false;
  /** 是否允许执行模型（永远 false） */
  canRunModel: false;
  displayMessage: string;
}

export interface SanitizeResult {
  text: string;
  redacted: string[];
  secretLeakCount: number;
}

const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  {
    re: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?([a-zA-Z0-9_\-]{16,})/gi,
    label: "api_key",
  },
  {
    re: /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi,
    label: "bearer_token",
  },
  {
    re: /sk-[a-zA-Z0-9]{20,}/g,
    label: "sk_token",
  },
  {
    re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    label: "private_key",
  },
  {
    re: /(?:password|passwd|secret)\s*[:=]\s*['"][^'"]{6,}['"]/gi,
    label: "password_secret",
  },
];

const THINK_PATTERNS: RegExp[] = [
  /<think>[\s\S]*?<\/think>/gi,
  /<thinking>[\s\S]*?<\/thinking>/gi,
  /```thinking[\s\S]*?```/gi,
];

const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(?:^|[\s"'`])(?:\/home\/|\/Users\/|[A-Z]:\\Users\\)[^\s"'`]+/g,
  /\.env(?:\.[a-zA-Z0-9_-]+)?/g,
];

/**
 * 脱敏 Review Surface 展示文本。
 * 秘密泄露计数用于验收指标（目标 0）。
 */
export function sanitizeReviewSurfaceText(input: string): SanitizeResult {
  let text = input ?? "";
  const redacted: string[] = [];
  let secretLeakCount = 0;

  for (const re of THINK_PATTERNS) {
    if (re.test(text)) {
      redacted.push("think_block");
      text = text.replace(re, "[REDACTED_THINK]");
    }
    re.lastIndex = 0;
  }

  for (const { re, label } of SECRET_PATTERNS) {
    const matches = text.match(re);
    if (matches?.length) {
      secretLeakCount += matches.length;
      redacted.push(label);
      text = text.replace(re, `[REDACTED_${label.toUpperCase()}]`);
    }
    re.lastIndex = 0;
  }

  for (const re of SENSITIVE_PATH_PATTERNS) {
    if (re.test(text)) {
      redacted.push("sensitive_path");
      text = text.replace(re, "[REDACTED_PATH]");
    }
    re.lastIndex = 0;
  }

  return { text, redacted: [...new Set(redacted)], secretLeakCount };
}

/** 构造只读降级结果（不可提交、不可跑模型） */
export function degradeReviewSurface(
  reason: ReviewDegradeReason,
  detail?: string,
): ReviewDegradeResult {
  const hints: Record<ReviewDegradeReason, string> = {
    unknown_schema:
      "未知 schema：请使用 pinovel.review-artifact/v1 重新导出，或升级 review-surface。",
    corrupt_artifact:
      "artifact 损坏：请从原始 trace 重新构建，禁止猜测修复后提交。",
    missing_candidate_text:
      "缺少候选正文：仅可查看元数据，不可提交。",
    invalid_span: "非法 span：已忽略该 span，不静默截断正文。",
    blocked_artifact:
      "blocked artifact：不得进入正式章节，仅只读证据展示。",
    hash_mismatch:
      "hash 不匹配：pending artifact 与当前正文不一致，阻断提交。",
  };

  return {
    mode: "readonly_degraded",
    reason,
    migrationHint: hints[reason],
    canSubmit: false,
    canRunModel: false,
    displayMessage: detail
      ? `${hints[reason]} 详情：${detail}`
      : hints[reason],
  };
}

/**
 * 渲染审阅层时禁止把 judge winner 当客观答案。
 * 返回展示标签，明确标注为机器建议。
 */
export function formatJudgeWinnerForDisplay(
  winner: string | undefined | null,
): string {
  if (!winner) return "（无机器建议）";
  return `机器建议（非客观答案）：${winner}`;
}

/** 检查文本是否仍含应脱敏内容（验收用） */
export function containsForbiddenReviewSecrets(text: string): boolean {
  const { secretLeakCount } = sanitizeReviewSurfaceText(text);
  // 若输入未脱敏前能检出，说明含秘密
  // 对已脱敏文本再扫一次原始模式
  for (const { re } of SECRET_PATTERNS) {
    if (re.test(text)) {
      re.lastIndex = 0;
      return true;
    }
    re.lastIndex = 0;
  }
  for (const re of THINK_PATTERNS) {
    if (re.test(text)) {
      re.lastIndex = 0;
      return true;
    }
    re.lastIndex = 0;
  }
  return secretLeakCount > 0 && /sk-[a-zA-Z0-9]{20,}|Bearer\s+/i.test(text);
}

/** blocked candidate 不得交付 */
export function assertBlockedCandidateNotDeliverable(input: {
  outcome?: string;
  blocked?: boolean;
}): { deliverable: boolean; reason: string } {
  if (input.blocked === true || input.outcome === "blocked") {
    return {
      deliverable: false,
      reason: "blocked candidate 不得进入正式章节",
    };
  }
  return { deliverable: true, reason: "候选可进入审阅交付路径" };
}
