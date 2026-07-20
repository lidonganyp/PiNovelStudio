/** Production promotion gate for completed, release-bound canary evidence. */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type { ChangeClass } from "./evolution-release-types.js";
import type { CanaryRunTrace } from "./canary-trace-store.js";

export type CanaryPromotionBlockCode =
  | "CANARY_EVIDENCE_REQUIRED"
  | "CANARY_NOT_COMPLETED"
  | "CANARY_BINDING_MISMATCH"
  | "CANARY_RESULT_INVALID"
  | "CANARY_POLICY_MISMATCH";

export type CanaryPromotionGateResult =
  | { ok: true; evidenceRunId: string | null }
  | { ok: false; code: CanaryPromotionBlockCode; reason: string };

export interface CanaryPromotionGateInput {
  releaseId: string;
  changeClass: ChangeClass;
  environmentFingerprint: string;
  approvalRef: string;
  workspaceId: string;
  trace: CanaryRunTrace | null;
}

export type CanaryArtifactVerificationResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "CANARY_ARTIFACT_UNSAFE"
        | "CANARY_ARTIFACT_MISSING"
        | "CANARY_ARTIFACT_MISMATCH";
      reason: string;
    };

export type CanaryCompletionLinkResult =
  | { ok: true }
  | { ok: false; code: "CANARY_SOURCE_INVALID"; reason: string };

function blocked(
  code: CanaryPromotionBlockCode,
  reason: string,
): CanaryPromotionGateResult {
  return { ok: false, code, reason };
}

function hasCompletedTiming(trace: CanaryRunTrace): boolean {
  if (trace.status !== "completed" || trace.shadowPendingRealRun !== false) {
    return false;
  }
  if (trace.completedAt === null) {
    return false;
  }
  const startedAt = Date.parse(trace.startedAt);
  const completedAt = Date.parse(trace.completedAt);
  return Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt;
}

function hasValidResult(trace: CanaryRunTrace): boolean {
  const { evidence } = trace;
  const refs = evidence.resultArtifactRefs;
  const hashes = evidence.resultArtifactHashes;
  return (
    evidence.verdict === "pass" &&
    typeof evidence.sourceRunId === "string" &&
    evidence.sourceRunId.length > 0 &&
    Number.isInteger(evidence.observedChapters) &&
    Number(evidence.observedChapters) > 0 &&
    Number.isInteger(evidence.observedCalls) &&
    Number(evidence.observedCalls) > 0 &&
    Array.isArray(refs) &&
    refs.length > 0 &&
    refs.every(
      (artifactRef) => typeof artifactRef === "string" && artifactRef.length > 0,
    ) &&
    hashes !== null &&
    typeof hashes === "object" &&
    refs.every(
      (artifactRef) =>
        typeof hashes[artifactRef] === "string" &&
        /^[0-9a-f]{64}$/i.test(hashes[artifactRef]),
    )
  );
}

export function evaluateCanaryCompletionLink(
  source: CanaryRunTrace | null,
  completion: CanaryRunTrace,
): CanaryCompletionLinkResult {
  if (
    source === null ||
    completion.evidence.sourceRunId !== source.runId ||
    completion.runId === source.runId ||
    (source.status !== "canary_started" && source.status !== "shadow_started") ||
    source.shadowPendingRealRun !== true ||
    source.releaseId !== completion.releaseId ||
    source.workspaceId !== completion.workspaceId ||
    source.strategy !== completion.strategy ||
    source.startedAt !== completion.startedAt ||
    source.evidence.changeClass !== completion.evidence.changeClass ||
    source.evidence.currentStatus !== completion.evidence.currentStatus ||
    source.evidence.authorizationId !== completion.evidence.authorizationId
  ) {
    return {
      ok: false,
      code: "CANARY_SOURCE_INVALID",
      reason: `completed trace ${completion.runId} is not bound to its source trace`,
    };
  }
  return { ok: true };
}

export function verifyCanaryResultArtifacts(
  workspacePath: string,
  trace: CanaryRunTrace,
  expected?: {
    releaseId: string;
    environmentFingerprint: string;
    approvalRef: string;
  },
): CanaryArtifactVerificationResult {
  const workspaceRoot = resolve(workspacePath);
  const refs = trace.evidence.resultArtifactRefs ?? [];
  const hashes = trace.evidence.resultArtifactHashes ?? {};

  // P0 修复：收集所有引用的 chapter trace 的统计信息，用于与 trace.evidence.observed* 交叉校验
  const observedChapterIds = new Set<string>();
  let totalModelCalls = 0;

  for (const artifactRef of refs) {
    const artifactPath = resolve(workspaceRoot, artifactRef);
    const relativePath = relative(workspaceRoot, artifactPath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      return {
        ok: false,
        code: "CANARY_ARTIFACT_UNSAFE",
        reason: `canary artifact escapes workspace: ${artifactRef}`,
      };
    }
    if (!existsSync(artifactPath)) {
      return {
        ok: false,
        code: "CANARY_ARTIFACT_MISSING",
        reason: `canary artifact does not exist: ${artifactRef}`,
      };
    }
    const actualHash = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
    if (actualHash !== hashes[artifactRef]) {
      return {
        ok: false,
        code: "CANARY_ARTIFACT_MISMATCH",
        reason: `canary artifact hash mismatch: ${artifactRef}`,
      };
    }

    // P0 修复：校验 artifact 是真实 chapter trace（traces/{chapterId}-quality-trace.json）
    const traceMatch = relativePath.match(/^traces[\\/](.+)-quality-trace\.json$/);
    if (!traceMatch) {
      return {
        ok: false,
        code: "CANARY_ARTIFACT_MISMATCH",
        reason: `canary artifact is not a chapter trace (expected traces/{chapterId}-quality-trace.json): ${artifactRef}`,
      };
    }
    const chapterId = traceMatch[1];
    observedChapterIds.add(chapterId);

    // P0 修复：校验 trace 文件结构与统计一致性
    let traceDoc: unknown;
    try {
      traceDoc = JSON.parse(readFileSync(artifactPath, "utf-8"));
    } catch {
      return {
        ok: false,
        code: "CANARY_ARTIFACT_MISMATCH",
        reason: `canary artifact is not valid JSON: ${artifactRef}`,
      };
    }
    const modelCalls = extractModelCallsFromTraceDoc(traceDoc);
    if (modelCalls === null) {
      return {
        ok: false,
        code: "CANARY_ARTIFACT_MISMATCH",
        reason: `canary artifact has no v2_final_selected gate with evidence.modelCalls array: ${artifactRef}`,
      };
    }
    totalModelCalls += modelCalls.length;

    // P0 修复（第四轮）：校验 chapter trace 的 releaseGovernance 与目标 release 绑定一致
    if (expected) {
      const releaseGov = extractReleaseGovernanceFromTraceDoc(traceDoc);
      if (releaseGov === null) {
        return {
          ok: false,
          code: "CANARY_ARTIFACT_MISMATCH",
          reason: `chapter trace missing releaseGovernance in v2_final_selected gate evidence: ${artifactRef}`,
        };
      }
      if (
        releaseGov.releaseId !== expected.releaseId ||
        releaseGov.environmentFingerprint !== expected.environmentFingerprint ||
        releaseGov.approvalRef !== expected.approvalRef
      ) {
        return {
          ok: false,
          code: "CANARY_ARTIFACT_MISMATCH",
          reason: `chapter trace releaseGovernance does not match target release: ${artifactRef} (trace=${releaseGov.releaseId}/${releaseGov.environmentFingerprint}/${releaseGov.approvalRef}, expected=${expected.releaseId}/${expected.environmentFingerprint}/${expected.approvalRef})`,
        };
      }
    }
  }

  // P0 修复：统计一致性校验
  // observedChapters 必须等于引用的不同 chapterId 数量
  // observedCalls 必须等于所有 trace 的 modelCalls 总条数
  const declaredObservedChapters = trace.evidence.observedChapters ?? 0;
  const declaredObservedCalls = trace.evidence.observedCalls ?? 0;
  if (declaredObservedChapters !== observedChapterIds.size) {
    return {
      ok: false,
      code: "CANARY_ARTIFACT_MISMATCH",
      reason: `observedChapters (${declaredObservedChapters}) does not match unique chapter count in result artifacts (${observedChapterIds.size})`,
    };
  }
  if (declaredObservedCalls !== totalModelCalls) {
    return {
      ok: false,
      code: "CANARY_ARTIFACT_MISMATCH",
      reason: `observedCalls (${declaredObservedCalls}) does not match total model calls in result artifacts (${totalModelCalls})`,
    };
  }

  return { ok: true };
}

/**
 * 从 trace 文档中提取 v2_final_selected gate 的 evidence.modelCalls。
 *
 * 与 release-health-aggregator.ts 的 extractModelCallsFromTrace 同构，
 * 但本模块不依赖 release-health-aggregator（避免反向依赖）。
 *
 * 返回 null 表示 trace 结构不符合预期（无 gates 数组 / 无 v2_final_selected gate /
 * evidence.modelCalls 非数组）。
 */
function extractModelCallsFromTraceDoc(traceDoc: unknown): unknown[] | null {
  if (!traceDoc || typeof traceDoc !== "object") return null;
  const doc = traceDoc as { gates?: unknown };
  if (!Array.isArray(doc.gates)) return null;

  for (const gate of doc.gates) {
    if (!gate || typeof gate !== "object") continue;
    const g = gate as { stage?: unknown; evidence?: unknown };
    if (g.stage !== "v2_final_selected") continue;
    if (!g.evidence || typeof g.evidence !== "object") continue;
    const evidence = g.evidence as { modelCalls?: unknown };
    if (!Array.isArray(evidence.modelCalls)) return null;
    return evidence.modelCalls as unknown[];
  }
  return null;
}

/**
 * 从 trace 文档中提取 v2_final_selected gate 的 evidence.releaseGovernance。
 *
 * 与 extractModelCallsFromTraceDoc 同构，但提取 releaseGovernance 绑定字段。
 * 返回 null 表示 trace 结构不符合预期或无 releaseGovernance 字段。
 */
function extractReleaseGovernanceFromTraceDoc(traceDoc: unknown): {
  releaseId: string | null;
  environmentFingerprint: string | null;
  approvalRef: string | null;
} | null {
  if (!traceDoc || typeof traceDoc !== "object") return null;
  const doc = traceDoc as { gates?: unknown };
  if (!Array.isArray(doc.gates)) return null;

  for (const gate of doc.gates) {
    if (!gate || typeof gate !== "object") continue;
    const g = gate as { stage?: unknown; evidence?: unknown };
    if (g.stage !== "v2_final_selected") continue;
    if (!g.evidence || typeof g.evidence !== "object") continue;
    const evidence = g.evidence as { releaseGovernance?: unknown };
    if (!evidence.releaseGovernance || typeof evidence.releaseGovernance !== "object") return null;
    const rg = evidence.releaseGovernance as {
      releaseId?: unknown;
      environmentFingerprint?: unknown;
      approvalRef?: unknown;
    };
    return {
      releaseId: typeof rg.releaseId === "string" ? rg.releaseId : null,
      environmentFingerprint: typeof rg.environmentFingerprint === "string" ? rg.environmentFingerprint : null,
      approvalRef: typeof rg.approvalRef === "string" ? rg.approvalRef : null,
    };
  }
  return null;
}

export function evaluateCanaryPromotionGate(
  input: CanaryPromotionGateInput,
): CanaryPromotionGateResult {
  if (input.changeClass === "R0" || input.changeClass === "R1") {
    return { ok: true, evidenceRunId: null };
  }

  const trace = input.trace;
  if (trace === null) {
    return blocked(
      "CANARY_EVIDENCE_REQUIRED",
      `${input.changeClass} release requires completed canary evidence before active_prod`,
    );
  }
  if (!hasCompletedTiming(trace)) {
    return blocked(
      "CANARY_NOT_COMPLETED",
      `canary trace ${trace.runId} is not a completed real run`,
    );
  }
  if (
    trace.releaseId !== input.releaseId ||
    trace.workspaceId !== input.workspaceId ||
    trace.evidence.environmentFingerprint !== input.environmentFingerprint ||
    trace.evidence.approvalRef !== input.approvalRef
  ) {
    return blocked(
      "CANARY_BINDING_MISMATCH",
      `canary trace ${trace.runId} is not bound to the target release, workspace, fingerprint, and approval`,
    );
  }
  const policyMatches =
    trace.evidence.changeClass === input.changeClass &&
    (trace.evidence.currentStatus === "evaluated" ||
      trace.evidence.currentStatus === "candidate_prod") &&
    (input.changeClass === "R2"
      ? trace.strategy === "bounded_canary" || trace.strategy === "shadow_required"
      : trace.strategy === "shadow_required") &&
    (trace.strategy !== "bounded_canary" ||
      (typeof trace.evidence.authorizationId === "string" &&
        trace.evidence.authorizationId.length > 0));
  if (!policyMatches) {
    return blocked(
      "CANARY_POLICY_MISMATCH",
      `canary trace ${trace.runId} does not match ${input.changeClass} promotion policy`,
    );
  }
  if (!hasValidResult(trace)) {
    return blocked(
      "CANARY_RESULT_INVALID",
      `canary trace ${trace.runId} lacks a passing result, observed work, or result artifacts`,
    );
  }
  return { ok: true, evidenceRunId: trace.runId };
}
