/**
 * TOOL-RESULT-TRUST — 工具结果信任边界与消费闸门
 * （PROMPT-INJECTION-TRUST-ARCHITECTURE-1 Phase 2）
 *
 * 规则：
 * - 工具正文默认 reference，canAffectHardGate=false
 * - 只有专门验证器可升级为 system_fact
 * - 未知工具 / final_commit 注册 / 伪造 actor 拒绝
 * - 未验证文本不能进入 CanonState
 */

import { createHash, randomBytes } from "node:crypto";
import type {
  ToolContentTrust,
  TrustedToolResult,
} from "./trust-types.js";
import { toolResultCanAffectHardGate } from "./trust-types.js";

export type ToolResultConsumePurpose =
  | "reference_material"
  | "diagnostic_evidence"
  | "fact_guard_input"
  | "canon_state"
  | "hard_gate"
  | "chapter_intent"
  | "authorization";

export interface ToolResultConsumeDecision {
  allowed: boolean;
  reason: string;
  blockReason?:
    | "untrusted_content"
    | "reference_not_promoted"
    | "unknown_tool"
    | "final_commit_forbidden"
    | "forged_actor"
    | "missing_verification"
    | "purpose_forbidden";
  contentTrust: ToolContentTrust;
  canAffectHardGate: boolean;
}

export interface MakeTrustedToolResultInput<T> {
  ok: boolean;
  toolName: string;
  callId?: string;
  content: T;
  evidenceRefs?: string[];
  /** 默认 reference */
  contentTrust?: ToolContentTrust;
  canAffectHardGate?: boolean;
  verifiedBy?: string;
  error?: TrustedToolResult<T>["error"];
}

function contentHashOf(value: unknown): string {
  const payload =
    typeof value === "string" ? value : JSON.stringify(value ?? null);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function newCallId(): string {
  return `toolcall-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/**
 * 构造受信任元数据包装的工具结果。
 * 默认 contentTrust=reference、canAffectHardGate=false。
 * system_fact 必须同时提供 verifiedBy，否则强制降级。
 */
export function makeTrustedToolResult<T>(
  input: MakeTrustedToolResultInput<T>,
): TrustedToolResult<T> {
  let contentTrust: ToolContentTrust = input.contentTrust ?? "reference";
  let canAffectHardGate = input.canAffectHardGate ?? false;
  let verifiedBy = input.verifiedBy;

  if (contentTrust === "system_fact") {
    if (!verifiedBy?.trim()) {
      // 无验证器不得自称 system_fact
      contentTrust = "reference";
      canAffectHardGate = false;
      verifiedBy = undefined;
    } else if (!canAffectHardGate) {
      // system_fact 但未声明 hard gate → 保持 system_fact 但不进硬门禁
      canAffectHardGate = false;
    }
  } else {
    // reference / untrusted 永远不能 affect hard gate
    canAffectHardGate = false;
  }

  if (contentTrust === "untrusted") {
    canAffectHardGate = false;
    verifiedBy = undefined;
  }

  return {
    ok: input.ok,
    toolName: input.toolName,
    callId: input.callId ?? newCallId(),
    evidenceRefs: input.evidenceRefs ? [...input.evidenceRefs] : [],
    content: input.content,
    contentTrust,
    canAffectHardGate,
    verifiedBy,
    contentHash: contentHashOf(input.content),
    error: input.error,
  };
}

/**
 * 消费闸门：按用途决定是否允许使用工具结果。
 */
export function evaluateToolResultConsumption(input: {
  result: TrustedToolResult;
  purpose: ToolResultConsumePurpose;
}): ToolResultConsumeDecision {
  const { result, purpose } = input;
  const base = {
    contentTrust: result.contentTrust,
    canAffectHardGate: result.canAffectHardGate,
  };

  if (!result.toolName?.trim()) {
    return {
      ...base,
      allowed: false,
      reason: "工具名为空",
      blockReason: "unknown_tool",
    };
  }

  if (result.toolName === "final_commit" || purpose === "authorization") {
    if (result.toolName === "final_commit") {
      return {
        ...base,
        allowed: false,
        reason: "final_commit 不是可注册/可消费工具副作用",
        blockReason: "final_commit_forbidden",
      };
    }
  }

  switch (purpose) {
    case "reference_material":
    case "diagnostic_evidence":
      return {
        ...base,
        allowed: true,
        reason: `允许作为 ${purpose}`,
      };

    case "fact_guard_input":
    case "hard_gate":
    case "canon_state": {
      if (
        !toolResultCanAffectHardGate(
          result.contentTrust,
          result.canAffectHardGate,
        )
      ) {
        return {
          ...base,
          allowed: false,
          reason: `未验证工具文本不能进入 ${purpose}（contentTrust=${result.contentTrust}）`,
          blockReason:
            result.contentTrust === "untrusted"
              ? "untrusted_content"
              : "reference_not_promoted",
        };
      }
      if (!result.verifiedBy?.trim()) {
        return {
          ...base,
          allowed: false,
          reason: `缺少 verifiedBy，不能进入 ${purpose}`,
          blockReason: "missing_verification",
        };
      }
      return {
        ...base,
        allowed: true,
        reason: `已验证 system_fact 允许进入 ${purpose}`,
      };
    }

    case "chapter_intent":
      // 工具结果永远不能直接改写 ChapterIntent
      return {
        ...base,
        allowed: false,
        reason: "工具结果不能修改 ChapterIntent",
        blockReason: "purpose_forbidden",
      };

    case "authorization":
      return {
        ...base,
        allowed: false,
        reason: "工具结果不能产生授权",
        blockReason: "purpose_forbidden",
      };

    default:
      return {
        ...base,
        allowed: false,
        reason: `未知消费目的：${purpose as string}`,
        blockReason: "purpose_forbidden",
      };
  }
}

/** 验证器升级：仅可信宿主调用 */
export function promoteToolResultToSystemFact<T>(
  result: TrustedToolResult<T>,
  input: { verifiedBy: string; canAffectHardGate?: boolean },
): TrustedToolResult<T> {
  if (!input.verifiedBy?.trim()) {
    throw new Error("promoteToolResultToSystemFact: verifiedBy 必填");
  }
  return {
    ...result,
    contentTrust: "system_fact",
    canAffectHardGate: input.canAffectHardGate ?? true,
    verifiedBy: input.verifiedBy,
  };
}

/** 注册时拒绝 final_commit / 未知权限 */
export function assertToolRegistrationAllowed(input: {
  toolName: string;
  requiredPermission?: string;
  knownToolNames?: ReadonlySet<string>;
}): { ok: true } | { ok: false; reason: string } {
  const name = (input.toolName ?? "").trim();
  if (!name) {
    return { ok: false, reason: "工具名为空" };
  }
  if (name === "final_commit" || input.requiredPermission === "final_commit") {
    return {
      ok: false,
      reason: `禁止注册 final_commit 工具：${name}`,
    };
  }
  if (input.knownToolNames && !input.knownToolNames.has(name)) {
    return {
      ok: false,
      reason: `未知工具拒绝注册：${name}`,
    };
  }
  return { ok: true };
}

/** 拒绝伪造 actor（模型自称 user/system） */
export function assertTrustedActor(input: {
  claimedActor: string;
  hostInjectedActor: string;
}): { ok: true } | { ok: false; reason: string } {
  if (input.claimedActor !== input.hostInjectedActor) {
    return {
      ok: false,
      reason: `actor 伪造拒绝：claimed=${input.claimedActor} host=${input.hostInjectedActor}`,
    };
  }
  if (input.hostInjectedActor === "model" && input.claimedActor === "user") {
    return {
      ok: false,
      reason: "模型不能伪造 user actor",
    };
  }
  return { ok: true };
}

/** 将 NarrativeToolResultDetails 包装为 TrustedToolResult（默认 reference） */
export function wrapNarrativeDetailsAsTrusted(input: {
  toolName: string;
  text: string;
  details: {
    sourceRef?: string;
    evidenceLevel?: string;
    [key: string]: unknown;
  };
  callId?: string;
}): TrustedToolResult<Record<string, unknown>> {
  const evidenceRefs = input.details.sourceRef
    ? [input.details.sourceRef]
    : [];
  // confirmed_state 来自长期状态查询，仍默认 reference（消费闸门再决定能否进 hard gate）
  // 只有显式验证器 promote 后才是 system_fact
  return makeTrustedToolResult({
    ok: true,
    toolName: input.toolName,
    callId: input.callId,
    content: {
      text: input.text,
      ...input.details,
    },
    evidenceRefs,
    contentTrust: "reference",
    canAffectHardGate: false,
  });
}
