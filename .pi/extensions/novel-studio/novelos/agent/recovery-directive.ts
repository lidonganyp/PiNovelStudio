/**
 * Structured, bounded feedback for regenerating a complete Agentic candidate.
 *
 * Only the fields declared here are rendered into the model prompt. This keeps
 * verifier internals out of the prompt while preserving the full prior draft.
 */

export type RecoveryDirectiveKind = "verifier" | "fact_guard";

export interface RecoveryDirectiveFinding {
  code: string;
  message: string;
  evidenceRef?: string;
}

export interface RecoveryDirective {
  kind: RecoveryDirectiveKind;
  previousCandidateText: string;
  findings: RecoveryDirectiveFinding[];
}

const MAX_RECOVERY_FINDINGS = 8;
const MAX_CODE_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 800;
const MAX_EVIDENCE_REF_LENGTH = 300;

/** Render only the allowlisted recovery fields into the first draft prompt. */
export function renderRecoveryDirective(directive: RecoveryDirective, append = false): string {
  const label = directive.kind === "fact_guard" ? "FactGuard" : "Narrative Verifier";
  const findings = directive.findings
    .slice(0, MAX_RECOVERY_FINDINGS)
    .map((finding, index) => {
      const code = normalizePromptLine(finding.code, MAX_CODE_LENGTH) || `finding_${index + 1}`;
      const message = normalizePromptLine(finding.message, MAX_MESSAGE_LENGTH) || "未提供可读原因";
      const evidenceRef = normalizePromptLine(
        finding.evidenceRef ?? "",
        MAX_EVIDENCE_REF_LENGTH,
      );
      return evidenceRef
        ? `${index + 1}. [${code}] ${message}（证据：${evidenceRef}）`
        : `${index + 1}. [${code}] ${message}`;
    });

  return [
    `【候选恢复任务：${label}】`,
    append
      ? "修复上一候选的新增部分，作者前缀是只读上下文。必须保留未被问题证据指向的有效情节、事实与作者内容契约。"
      : "修复上一候选并输出完整新候选。必须保留未被问题证据指向的有效情节、事实与作者内容契约。",
    append
      ? "只输出新增后缀正文；不得复制作者前缀，也不得只输出补丁、差异说明、修改清单或解释。"
      : "只输出修复后的完整章节正文；不得只输出补丁、差异说明、修改清单或解释。",
    "待修复问题：",
    ...(findings.length > 0 ? findings : ["1. [unspecified] 修复上一候选中的验证失败"]),
    "",
    "【上一候选正文】",
    directive.previousCandidateText,
    "【上一候选正文结束】",
  ].join("\n");
}

function normalizePromptLine(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}
