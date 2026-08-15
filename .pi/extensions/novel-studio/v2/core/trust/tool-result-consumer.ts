/**
 * TOOL-RESULT-CONSUMER — 生产工具结果消费闸门
 * （PROMPT-INJECTION-TRUST-ARCHITECTURE-1 生产闭包）
 *
 * 统一入口：NarrativeToolResult / 任意工具 details → TrustedToolResult
 * → evaluateToolResultConsumption → 审计。
 */

import {
  evaluateToolResultConsumption,
  makeTrustedToolResult,
  wrapNarrativeDetailsAsTrusted,
  type ToolResultConsumePurpose,
} from "./tool-result-trust.js";
import type { TrustedToolResult } from "./trust-types.js";
import { emitTrustAuditEvent } from "./trust-audit.js";

export interface ConsumeToolResultInput {
  toolName: string;
  callId?: string;
  text?: string;
  details?: {
    sourceRef?: string;
    evidenceLevel?: string;
    contentTrust?: string;
    canAffectHardGate?: boolean;
    verifiedBy?: string;
    [key: string]: unknown;
  };
  /** 已包装结果优先 */
  trusted?: TrustedToolResult;
  purpose: ToolResultConsumePurpose;
  workspaceId?: string;
  chapterId?: string;
  taskId?: string;
}

export interface ConsumeToolResultDecision {
  allowed: boolean;
  reason: string;
  blockReason?: string;
  trusted: TrustedToolResult;
  purpose: ToolResultConsumePurpose;
}

/**
 * 强制消费闸门：所有进入 FactGuard / Canon / hard_gate / intent 的工具结果
 * 必须经此函数。默认 reference 不可进硬路径。
 */
export function consumeToolResult(
  input: ConsumeToolResultInput,
): ConsumeToolResultDecision {
  const trusted =
    input.trusted ??
    (input.details
      ? wrapNarrativeDetailsAsTrusted({
          toolName: input.toolName,
          text: input.text ?? "",
          details: input.details,
          callId: input.callId,
        })
      : makeTrustedToolResult({
          ok: true,
          toolName: input.toolName,
          callId: input.callId,
          content: { text: input.text ?? "" },
          contentTrust: "reference",
          canAffectHardGate: false,
        }));

  const decision = evaluateToolResultConsumption({
    result: trusted,
    purpose: input.purpose,
  });

  emitTrustAuditEvent({
    decisionType: decision.allowed ? "tool_result_consume" : "tool_denial",
    allowed: decision.allowed,
    reason: decision.reason,
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    taskId: input.taskId,
    hashes: { contentHash: trusted.contentHash },
    evidence: {
      toolName: trusted.toolName,
      callId: trusted.callId,
      purpose: input.purpose,
      contentTrust: trusted.contentTrust,
      canAffectHardGate: trusted.canAffectHardGate,
      blockReason: decision.blockReason ?? null,
      verifiedBy: trusted.verifiedBy ?? null,
    },
  });

  return {
    allowed: decision.allowed,
    reason: decision.reason,
    blockReason: decision.blockReason,
    trusted,
    purpose: input.purpose,
  };
}

/**
 * 批量：仅允许通过消费闸门的条目进入下游。
 */
export function filterToolResultsForPurpose<T extends ConsumeToolResultInput>(
  items: T[],
  purpose: ToolResultConsumePurpose,
): { allowed: T[]; denied: Array<{ item: T; reason: string }> } {
  const allowed: T[] = [];
  const denied: Array<{ item: T; reason: string }> = [];
  for (const item of items) {
    const d = consumeToolResult({ ...item, purpose });
    if (d.allowed) allowed.push(item);
    else denied.push({ item, reason: d.reason });
  }
  return { allowed, denied };
}

/**
 * Canon/状态提交前：断言工具衍生内容已验证。
 * 未验证 → 抛错（fail-closed）。
 */
export function assertToolResultSafeForCanon(
  input: ConsumeToolResultInput,
): TrustedToolResult {
  const d = consumeToolResult({ ...input, purpose: "canon_state" });
  if (!d.allowed) {
    throw new Error(
      `工具结果不得进入 CanonState：${d.reason}` +
        (d.blockReason ? ` [${d.blockReason}]` : ""),
    );
  }
  return d.trusted;
}
