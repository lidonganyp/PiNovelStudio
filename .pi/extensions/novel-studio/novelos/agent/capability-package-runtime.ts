/**
 * Capability Package Runtime — on-demand payload load, tool sandbox, output
 * contract, and stop/budget enforcement.
 *
 * CPG-3.1–3.7. activate_capability_package is an internal NovelOS tool, not a
 * public novel_* entry. Models cannot mutate activation, budget, status, or
 * production pointers.
 */

import { createHash } from "node:crypto";
import { canonicalize } from "../../v2/governance/evolution-release-schema.js";
import { computeActualCost } from "../../v2/core/unit-price-schedule.js";
import {
  CAPABILITY_OUTPUT_KINDS,
  CAPABILITY_OUTPUT_SCHEMA_VERSION,
  FORBIDDEN_METHODOLOGY_OUTPUT_KINDS,
  emptyBudgetUsage,
  type CapabilityActivationDecision,
  type CapabilityActivationManifest,
  type CapabilityOutputEnvelope,
  type CapabilityOutputKind,
  type CapabilityPackageManifest,
  type CapabilityPackageSet,
  type CapabilityPayloadRecord,
} from "../../v2/core/capability-package-contracts.js";
import type { CapabilityConsumptionLedger } from "../../v2/core/capability-consumption-ledger.js";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { makeNarrativeToolResult, type ToolProtocol } from "../tools/tool-protocol.js";

export const ACTIVATE_CAPABILITY_PACKAGE_TOOL = "activate_capability_package";
export const SUBMIT_CAPABILITY_OUTPUT_TOOL = "submit_capability_output";

const FORBIDDEN_TOOL_ACTIONS = [
  "commit_state",
  "save_chapter",
  "switch_production_pointer",
  "modify_registry",
  "modify_status",
  "expand_budget",
] as const;

export interface CapabilityRuntimeSession {
  activationId: string;
  packageId: string;
  version: string;
  workspaceId: string;
  runId: string;
  chapterId: string;
  releaseId: string;
  bundleId: string;
  payload: CapabilityPayloadRecord;
  grantedTools: string[];
  remainingCalls: number;
  remainingInputTokens: number;
  remainingOutputTokens: number;
  remainingLatencyMs: number;
  remainingCost: number;
  used: { calls: number; inputTokens: number; outputTokens: number; latencyMs: number; cost: number };
  outputSchemaIds: string[];
  outputContracts: Array<{ kind: string; schemaId: string }>;
  submittedArtifactCount: number;
  noMatchCount: number;
  stopConditions: CapabilityPackageManifest["stopConditions"];
  enforcement: CapabilityPackageManifest["enforcement"];
  authority: CapabilityPackageManifest["authority"];
  activated: boolean;
  exhausted: boolean;
}

export interface ActivateCapabilityPackageInput {
  activationId: string;
  manifest: CapabilityActivationManifest;
  packageSet: CapabilityPackageSet;
  ledger?: CapabilityConsumptionLedger;
}

export interface RuntimeToolCallInput {
  session: CapabilityRuntimeSession;
  toolName: string;
  args: Record<string, unknown>;
  execute: (toolName: string, args: Record<string, unknown>) => unknown;
  authorizedWorkspaceId?: string;
  toolCallId?: string;
  usage?: { calls?: number; inputTokens?: number; outputTokens?: number; latencyMs?: number; cost?: number };
  ledger?: CapabilityConsumptionLedger;
}

export interface RuntimeOutputInput {
  session: CapabilityRuntimeSession;
  outputKind: string;
  schemaId?: string;
  artifacts: unknown[];
  sourceRefs: string[];
  toolCallIds: string[];
  ledger?: CapabilityConsumptionLedger;
}

export type RuntimeResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; code: string };

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function findDecision(
  manifest: CapabilityActivationManifest,
  activationId: string,
): CapabilityActivationDecision | undefined {
  return manifest.decisions.find((decision) => decision.activationId === activationId);
}

function findPackage(
  set: CapabilityPackageSet,
  packageId: string,
  version: string,
): CapabilityPackageManifest | undefined {
  return set.packages.find((pkg) => pkg.packageId === packageId && pkg.version === version);
}

function findPayload(set: CapabilityPackageSet, payloadHash: string): CapabilityPayloadRecord | undefined {
  return set.payloads.find((payload) => payload.payloadHash === payloadHash);
}

const activatedSessions = new Map<string, CapabilityRuntimeSession>();

export function resetCapabilityRuntimeSessions(): void {
  activatedSessions.clear();
}

export function releaseCapabilityRuntimeSessions(filter?: {
  workspaceId?: string;
  runId?: string;
}): void {
  if (!filter || (!filter.workspaceId && !filter.runId)) {
    activatedSessions.clear();
    return;
  }
  for (const [activationId, session] of activatedSessions) {
    if (filter.workspaceId && session.workspaceId !== filter.workspaceId) continue;
    if (filter.runId && session.runId !== filter.runId) continue;
    activatedSessions.delete(activationId);
  }
}

export function listActiveCapabilitySessions(): CapabilityRuntimeSession[] {
  return [...activatedSessions.values()].filter((session) => session.activated);
}

export function findActiveCapabilitySession(input: {
  toolName: string;
  workspaceId: string;
  runId?: string;
}): CapabilityRuntimeSession | undefined {
  return listActiveCapabilitySessions().find((session) => (
    session.grantedTools.includes(input.toolName)
    && session.workspaceId === input.workspaceId
    && (input.runId === undefined || session.runId === input.runId)
  ));
}

export function mayDeliverPayloadToAgenticDraft(
  enforcement: CapabilityPackageManifest["enforcement"],
): boolean {
  return enforcement === "hard_boundary" || enforcement === "generation_context";
}

const EVIDENCE_ARTIFACT_KEYS = ["claim", "fact", "statement", "promiseId", "evidence"];

function artifactShapeError(outputKind: string, artifact: unknown): string | null {
  if (!isRecord(artifact)) return "artifact_not_object";
  if (artifact.kind === "chapter_patch") return "chapter_patch_forbidden";
  switch (outputKind) {
    case "evidence":
      return EVIDENCE_ARTIFACT_KEYS.some((key) => typeof artifact[key] === "string" && String(artifact[key]).trim().length > 0)
        ? null
        : "evidence_artifact_missing_claim";
    case "unresolved_questions":
    case "review_question":
      return typeof artifact.question === "string" && artifact.question.trim().length > 0
        ? null
        : "question_artifact_missing_question";
    case "candidate_guidance":
      return typeof artifact.guidance === "string" && artifact.guidance.trim().length > 0
        ? null
        : "guidance_artifact_missing_guidance";
    case "diagnostic":
      return typeof artifact.issue === "string" && artifact.issue.trim().length > 0
        ? null
        : "diagnostic_artifact_missing_issue";
    default:
      return "unknown_output_kind";
  }
}

export function activateCapabilityPackage(
  input: ActivateCapabilityPackageInput,
): RuntimeResult<CapabilityRuntimeSession> {
  const existing = activatedSessions.get(input.activationId);
  if (existing) {
    return { ok: true, value: existing };
  }

  const decision = findDecision(input.manifest, input.activationId);
  if (!decision || decision.decision !== "selected") {
    input.ledger?.append({
      runId: input.manifest.runId,
      chapterId: input.manifest.chapterId,
      releaseId: input.manifest.releaseId,
      bundleId: input.manifest.bundleId,
      packageId: decision?.packageId ?? "unknown",
      version: decision?.version ?? "",
      activationId: input.activationId,
      targetStage: decision?.targetStage ?? null,
      event: "unauthorized_activation",
      reason: "activation_id_not_authorized",
      payloadHash: decision?.payloadHash ?? null,
      outputArtifactHash: null,
      contextPackageHash: null,
      modelInputHash: null,
      modelTurnId: null,
      grantedTools: [],
      toolCallIds: [],
      budgetReserved: null,
      budgetUsed: null,
    });
    return { ok: false, reason: "activation_id_not_authorized", code: "unauthorized_activation" };
  }

  const pkg = findPackage(input.packageSet, decision.packageId, decision.version);
  if (!pkg) {
    return { ok: false, reason: "package_not_in_frozen_set", code: "unauthorized_activation" };
  }
  if (pkg.payloadRef.payloadHash !== decision.payloadHash) {
    return { ok: false, reason: "payload_hash_drift", code: "hash_drift" };
  }
  const payload = findPayload(input.packageSet, decision.payloadHash);
  if (!payload) {
    const optional = pkg.criticality !== "required";
    input.ledger?.append({
      runId: input.manifest.runId,
      chapterId: input.manifest.chapterId,
      releaseId: input.manifest.releaseId,
      bundleId: input.manifest.bundleId,
      packageId: pkg.packageId,
      version: pkg.version,
      activationId: decision.activationId,
      targetStage: decision.targetStage,
      event: optional ? "optional_capability_unavailable" : "failed",
      reason: "payload_missing",
      payloadHash: decision.payloadHash,
      outputArtifactHash: null,
      contextPackageHash: null,
      modelInputHash: null,
      modelTurnId: null,
      grantedTools: [],
      toolCallIds: [],
      budgetReserved: null,
      budgetUsed: null,
    });
    return { ok: false, reason: "payload_missing", code: optional ? "optional_unavailable" : "required_unavailable" };
  }

  const session: CapabilityRuntimeSession = {
    activationId: decision.activationId,
    packageId: pkg.packageId,
    version: pkg.version,
    workspaceId: input.manifest.workspaceId,
    runId: input.manifest.runId,
    chapterId: input.manifest.chapterId,
    releaseId: input.manifest.releaseId,
    bundleId: input.manifest.bundleId,
    payload,
    grantedTools: [...decision.grantedTools],
    remainingCalls: decision.reservedBudget.maxCalls,
    remainingInputTokens: decision.reservedBudget.maxInputTokens,
    remainingOutputTokens: decision.reservedBudget.maxOutputTokens,
    remainingLatencyMs: decision.reservedBudget.maxLatencyMs,
    remainingCost: decision.reservedBudget.maxCost,
    used: emptyBudgetUsage(),
    outputSchemaIds: pkg.outputArtifacts.map((artifact) => artifact.schemaId),
    outputContracts: pkg.outputArtifacts.map((artifact) => ({ kind: artifact.kind, schemaId: artifact.schemaId })),
    submittedArtifactCount: 0,
    noMatchCount: 0,
    stopConditions: pkg.stopConditions,
    enforcement: pkg.enforcement,
    authority: pkg.authority,
    activated: true,
    exhausted: false,
  };
  activatedSessions.set(decision.activationId, session);
  input.ledger?.append({
    runId: input.manifest.runId,
    chapterId: input.manifest.chapterId,
    releaseId: input.manifest.releaseId,
    bundleId: input.manifest.bundleId,
    packageId: pkg.packageId,
    version: pkg.version,
    activationId: decision.activationId,
    targetStage: decision.targetStage,
    event: "activated",
    reason: "payload_loaded",
    payloadHash: payload.payloadHash,
    outputArtifactHash: null,
    contextPackageHash: null,
    modelInputHash: null,
    modelTurnId: null,
    grantedTools: session.grantedTools,
    toolCallIds: [],
    budgetReserved: decision.reservedBudget,
    budgetUsed: emptyBudgetUsage(),
  });
  return { ok: true, value: session };
}

export function activateCapabilityPackageByPackageId(
  packageId: string,
  manifest: CapabilityActivationManifest,
  packageSet: CapabilityPackageSet,
): RuntimeResult<CapabilityRuntimeSession> {
  const decision = manifest.decisions.find((item) => item.packageId === packageId && item.decision === "selected");
  if (!decision) {
    return { ok: false, reason: "package_not_in_activation_manifest", code: "unauthorized_activation" };
  }
  return activateCapabilityPackage({ activationId: decision.activationId, manifest, packageSet });
}

function stopConditionValue(
  session: CapabilityRuntimeSession,
  kind: "max_tool_calls" | "max_output_artifacts" | "no_match",
): number | undefined {
  const found = session.stopConditions.find((item) => item.kind === kind);
  if (!found) return undefined;
  if (kind === "no_match") return found.value ?? 1;
  return found.value;
}

function noMatchStopReached(session: CapabilityRuntimeSession): boolean {
  const limit = stopConditionValue(session, "no_match");
  return limit !== undefined && session.noMatchCount >= limit;
}

function markBudgetExhausted(session: CapabilityRuntimeSession): void {
  session.exhausted = true;
}

function consumeBudget(
  session: CapabilityRuntimeSession,
  usage: { calls?: number; inputTokens?: number; outputTokens?: number; latencyMs?: number; cost?: number },
): RuntimeResult<CapabilityRuntimeSession> {
  const calls = usage.calls ?? 0;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const latencyMs = usage.latencyMs ?? 0;
  const cost = usage.cost ?? 0;
  if (session.exhausted) {
    return { ok: false, reason: "budget_exhausted", code: "budget_exhausted" };
  }
  if (calls > 0 && noMatchStopReached(session)) {
    return { ok: false, reason: "stop_condition_no_match", code: "budget_exhausted" };
  }
  const maxToolCalls = stopConditionValue(session, "max_tool_calls");
  if (maxToolCalls !== undefined && session.used.calls + calls > maxToolCalls) {
    markBudgetExhausted(session);
    return { ok: false, reason: "stop_condition_max_tool_calls", code: "budget_exhausted" };
  }
  if (
    session.remainingCalls - calls < 0
    || session.remainingInputTokens - inputTokens < 0
    || session.remainingOutputTokens - outputTokens < 0
    || session.remainingLatencyMs - latencyMs < 0
    || session.remainingCost - cost < 0
  ) {
    markBudgetExhausted(session);
    return { ok: false, reason: "budget_exhausted", code: "budget_exhausted" };
  }
  session.remainingCalls -= calls;
  session.remainingInputTokens -= inputTokens;
  session.remainingOutputTokens -= outputTokens;
  session.remainingLatencyMs -= latencyMs;
  session.remainingCost -= cost;
  session.used = {
    calls: session.used.calls + calls,
    inputTokens: session.used.inputTokens + inputTokens,
    outputTokens: session.used.outputTokens + outputTokens,
    latencyMs: session.used.latencyMs + latencyMs,
    cost: session.used.cost + cost,
  };
  return { ok: true, value: session };
}

function appendSessionEvent(
  ledger: CapabilityConsumptionLedger | undefined,
  session: CapabilityRuntimeSession,
  event: "activated" | "rendered" | "delivered_to_model" | "consumed" | "budget_exhausted",
  reason: string,
  extras?: { outputArtifactHash?: string | null; modelInputHash?: string | null; toolCallIds?: string[] },
): void {
  ledger?.append({
    runId: session.runId,
    chapterId: session.chapterId,
    releaseId: session.releaseId,
    bundleId: session.bundleId,
    packageId: session.packageId,
    version: session.version,
    activationId: session.activationId,
    targetStage: "agentic_investigation",
    event,
    reason,
    payloadHash: session.payload.payloadHash,
    outputArtifactHash: extras?.outputArtifactHash ?? null,
    contextPackageHash: null,
    modelInputHash: extras?.modelInputHash ?? null,
    modelTurnId: extras?.modelInputHash ? session.activationId : null,
    grantedTools: session.grantedTools,
    toolCallIds: extras?.toolCallIds ?? [],
    budgetReserved: null,
    budgetUsed: { ...session.used },
  });
}

export function requestBudgetExpansion(
  _session: CapabilityRuntimeSession,
  _extra: { calls?: number; tokens?: number; cost?: number },
): RuntimeResult<never> {
  return { ok: false, reason: "package_cannot_expand_budget", code: "budget_expansion_denied" };
}

export function authorizeCapabilityToolCall(input: {
  session: CapabilityRuntimeSession;
  toolName: string;
  args: Record<string, unknown>;
  authorizedWorkspaceId?: string;
}): RuntimeResult<true> {
  const { session, toolName, args } = input;
  if (!session.grantedTools.includes(toolName)) {
    return { ok: false, reason: `tool_not_granted:${toolName}`, code: "unauthorized_tool" };
  }
  const action = typeof args.action === "string" ? args.action : toolName;
  if ((FORBIDDEN_TOOL_ACTIONS as readonly string[]).includes(action)
    || (FORBIDDEN_TOOL_ACTIONS as readonly string[]).includes(toolName)
  ) {
    return { ok: false, reason: `forbidden_action:${action}`, code: "untrusted_content" };
  }
  const path = typeof args.path === "string" ? args.path : "";
  if (path.includes("..") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    return { ok: false, reason: "path_escape_denied", code: "untrusted_content" };
  }
  const requestedWorkspace = typeof args.workspaceId === "string"
    ? args.workspaceId
    : typeof args.requestedWorkspaceId === "string"
      ? args.requestedWorkspaceId
      : input.authorizedWorkspaceId;
  if (requestedWorkspace && requestedWorkspace !== session.workspaceId) {
    return { ok: false, reason: "cross_workspace_denied", code: "untrusted_content" };
  }
  if (noMatchStopReached(session)) {
    return { ok: false, reason: "stop_condition_no_match", code: "budget_exhausted" };
  }
  return { ok: true, value: true };
}

export function invokeCapabilityTool(input: RuntimeToolCallInput): RuntimeResult<unknown> {
  const { session, toolName, args } = input;
  const authorized = authorizeCapabilityToolCall({
    session,
    toolName,
    args,
    authorizedWorkspaceId: input.authorizedWorkspaceId,
  });
  if (!authorized.ok) {
    return authorized;
  }
  const budget = consumeBudget(session, { calls: 1, ...input.usage });
  if (!budget.ok) {
    appendSessionEvent(input.ledger, session, "budget_exhausted", budget.reason);
    return budget;
  }
  const value = input.execute(toolName, args);
  if (isNoMatchResult(value)) {
    session.noMatchCount += 1;
  }
  appendSessionEvent(input.ledger, session, "consumed", "authorized_tool_call", {
    toolCallIds: [input.toolCallId ?? toolName],
  });
  return { ok: true, value };
}

export function validateCapabilityOutput(input: RuntimeOutputInput): RuntimeResult<CapabilityOutputEnvelope> {
  if ((FORBIDDEN_METHODOLOGY_OUTPUT_KINDS as readonly string[]).includes(input.outputKind)) {
    return { ok: false, reason: `forbidden_output_kind:${input.outputKind}`, code: "authority_channel_violation" };
  }
  if (!(CAPABILITY_OUTPUT_KINDS as readonly string[]).includes(input.outputKind)) {
    return { ok: false, reason: `invalid_output_kind:${input.outputKind}`, code: "schema_invalid" };
  }
  if (input.outputKind === "candidate_guidance" && input.session.enforcement === "review_only") {
    return { ok: false, reason: "review_only_cannot_emit_guidance_patch", code: "authority_channel_violation" };
  }
  if (input.session.enforcement === "review_only" && input.outputKind !== "diagnostic" && input.outputKind !== "review_question") {
    return { ok: false, reason: "review_only_output_mismatch", code: "authority_channel_violation" };
  }
  if (input.artifacts.some((artifact) => isRecord(artifact) && artifact.kind === "chapter_patch")) {
    return { ok: false, reason: "review_only_cannot_patch_prose", code: "authority_channel_violation" };
  }
  if (input.sourceRefs.length === 0) {
    return { ok: false, reason: "source_ref_required", code: "schema_invalid" };
  }
  for (const artifact of input.artifacts) {
    const shapeError = artifactShapeError(input.outputKind, artifact);
    if (shapeError) {
      return { ok: false, reason: `artifact_schema_invalid:${shapeError}`, code: "schema_invalid" };
    }
  }
  const contracts = input.session.outputContracts ?? [];
  if (contracts.length > 0) {
    const contractsForKind = contracts.filter((contract) => contract.kind === input.outputKind);
    if (contractsForKind.length === 0) {
      return { ok: false, reason: `output_kind_not_declared:${input.outputKind}`, code: "schema_invalid" };
    }
    const schemaId = input.schemaId
      ?? (isRecord(input.artifacts[0]) && typeof input.artifacts[0].schemaId === "string"
        ? input.artifacts[0].schemaId
        : contractsForKind.length === 1
          ? contractsForKind[0].schemaId
          : undefined);
    if (!schemaId || !contractsForKind.some((contract) => contract.schemaId === schemaId)) {
      return { ok: false, reason: `output_schema_mismatch:${schemaId ?? "missing"}`, code: "schema_invalid" };
    }
  }
  const maxOutputArtifacts = stopConditionValue(input.session, "max_output_artifacts");
  if (
    maxOutputArtifacts !== undefined
    && input.session.submittedArtifactCount + input.artifacts.length > maxOutputArtifacts
  ) {
    return { ok: false, reason: "stop_condition_max_output_artifacts", code: "budget_exhausted" };
  }
  const envelope: CapabilityOutputEnvelope = {
    schemaVersion: CAPABILITY_OUTPUT_SCHEMA_VERSION,
    activationId: input.session.activationId,
    packageId: input.session.packageId,
    outputKind: input.outputKind as CapabilityOutputKind,
    artifacts: input.artifacts,
    sourceRefs: input.sourceRefs,
    toolCallIds: input.toolCallIds,
    budgetUsed: { ...input.session.used },
    stopReason: noMatchStopReached(input.session) ? "no_match" : "completed",
    outputArtifactHash: sha256(canonicalize({
      activationId: input.session.activationId,
      outputKind: input.outputKind,
      artifacts: input.artifacts,
      sourceRefs: input.sourceRefs,
    })),
  };
  input.session.submittedArtifactCount += input.artifacts.length;
  appendSessionEvent(input.ledger, input.session, "consumed", "structured_output_valid", {
    outputArtifactHash: envelope.outputArtifactHash,
    toolCallIds: input.toolCallIds,
  });
  return { ok: true, value: envelope };
}

export function renderAuthorizedPayload(session: CapabilityRuntimeSession): RuntimeResult<{ text: string; payloadHash: string }> {
  if (!session.activated) {
    return { ok: false, reason: "not_activated", code: "unauthorized_activation" };
  }
  return {
    ok: true,
    value: {
      text: typeof session.payload.body === "string"
        ? session.payload.body
        : canonicalize(session.payload.body),
      payloadHash: session.payload.payloadHash,
    },
  };
}

export function assertNotInjectedIntoRaw(
  enforcement: CapabilityPackageManifest["enforcement"],
  channel: "raw" | "candidate" | "review" | "eval",
): RuntimeResult<true> {
  if (channel === "raw" && (
    enforcement === "candidate_only"
    || enforcement === "review_only"
    || enforcement === "eval_only"
    || enforcement === "excluded_from_raw"
  )) {
    return { ok: false, reason: `raw_injection_forbidden:${enforcement}`, code: "raw_channel_violation" };
  }
  if (channel !== "eval" && enforcement === "eval_only") {
    return { ok: false, reason: "eval_only_outside_eval", code: "eval_isolation_violation" };
  }
  return { ok: true, value: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractToolUsage(value: unknown): {
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  cost?: number;
} {
  if (!isRecord(value)) return {};
  const details = isRecord(value.details) ? value.details : {};
  const usage = isRecord(details.usage) ? details.usage : isRecord(value.usage) ? value.usage : {};
  return {
    inputTokens: asFiniteNumber(usage.inputTokens ?? usage.tokensIn ?? details.inputTokens),
    outputTokens: asFiniteNumber(usage.outputTokens ?? usage.tokensOut ?? details.outputTokens),
    latencyMs: asFiniteNumber(usage.latencyMs ?? usage.durationMs ?? details.latencyMs),
    cost: asFiniteNumber(usage.cost ?? usage.actualCost ?? details.cost),
  };
}

function isNoMatchResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const details = isRecord(value.details) ? value.details : value;
  return details.resultKind === "no_match";
}

export interface ActivateCapabilityPackageToolContext {
  manifest: CapabilityActivationManifest;
  packageSet: CapabilityPackageSet;
  ledger?: CapabilityConsumptionLedger;
}

export function createActivateCapabilityPackageTool(
  context: ActivateCapabilityPackageToolContext,
): ToolProtocol<TSchema> {
  return {
    name: ACTIVATE_CAPABILITY_PACKAGE_TOOL,
    description:
      "Load an already-authorized capability package by activationId. Only IDs from the system-issued Activation Manifest are accepted. Does not grant extra tools, budget, or write authority.",
    label: "Activate Capability Package",
    parameters: Type.Object({
      activationId: Type.String({ description: "System-issued activationId from this chapter catalog" }),
    }),
    requiredPermission: "workspace_read",
    sideEffect: "read_only",
    timeoutMs: 10_000,
    async execute(_toolCallId, params) {
      const activationId = String((params as { activationId?: string }).activationId ?? "");
      const activated = activateCapabilityPackage({
        activationId,
        manifest: context.manifest,
        packageSet: context.packageSet,
        ledger: context.ledger,
      });
      if (!activated.ok) {
        return makeNarrativeToolResult(activated.reason, {
          sourceRef: "capability:denied",
          evidenceLevel: "inferred",
          resultKind: "no_match",
          returnedCount: 0,
          truncated: false,
          nextQueryHint: null,
        });
      }
      const session = activated.value;
      const rendered = renderAuthorizedPayload(session);
      if (rendered.ok) {
        appendSessionEvent(context.ledger, session, "rendered", "payload_held_for_authorized_stage");
      }
      const receipt = JSON.stringify({
        activated: true,
        activationId: session.activationId,
        packageId: session.packageId,
        version: session.version,
        grantedTools: session.grantedTools,
        outputSchemaIds: session.outputSchemaIds,
        payloadHash: session.payload.payloadHash,
        payloadDeliveredToDraft: mayDeliverPayloadToAgenticDraft(session.enforcement),
        note: mayDeliverPayloadToAgenticDraft(session.enforcement)
          ? "Authoritative payload may enter generation context after eligibility."
          : "Candidate/review/eval payload is reserved. Use granted tools to collect evidence. This receipt is not a story fact.",
      });
      if (mayDeliverPayloadToAgenticDraft(session.enforcement) && rendered.ok) {
        return makeNarrativeToolResult(rendered.value.text, {
          sourceRef: `capability:${activationId}`,
          evidenceLevel: "confirmed",
          resultKind: "ranked_evidence",
          returnedCount: 1,
          truncated: false,
          nextQueryHint: null,
          payloadHash: session.payload.payloadHash,
          activationId,
          workspaceId: session.workspaceId,
        });
      }
      return makeNarrativeToolResult(receipt, {
        sourceRef: `capability:${activationId}`,
        evidenceLevel: "inferred",
        resultKind: "ranked_evidence",
        returnedCount: 1,
        truncated: false,
        nextQueryHint: null,
        payloadHash: session.payload.payloadHash,
        activationId,
        workspaceId: session.workspaceId,
        payloadDeliveredToDraft: false,
      });
    },
  };
}

export function wrapToolsWithCapabilitySandbox<T extends { name: string; execute: (...args: never[]) => unknown }>(
  tools: T[],
  options: { workspaceId: string; runId?: string; ledger?: CapabilityConsumptionLedger },
): T[] {
  return tools.map((tool) => {
    if (tool.name === ACTIVATE_CAPABILITY_PACKAGE_TOOL || tool.name === SUBMIT_CAPABILITY_OUTPUT_TOOL) {
      return tool;
    }
    const rawExecute = tool.execute as (...args: unknown[]) => unknown;
    return {
      ...tool,
      execute: async (toolCallId: string, params: Record<string, unknown>, ...rest: unknown[]) => {
        const session = findActiveCapabilitySession({
          toolName: tool.name,
          workspaceId: options.workspaceId,
          runId: options.runId,
        });
        if (!session) {
          return rawExecute(toolCallId, params, ...rest);
        }
        const args = (params ?? {}) as Record<string, unknown>;
        const authorized = authorizeCapabilityToolCall({
          session,
          toolName: tool.name,
          args,
          authorizedWorkspaceId: options.workspaceId,
        });
        if (!authorized.ok) {
          return makeNarrativeToolResult(authorized.reason, {
            sourceRef: "capability:denied",
            evidenceLevel: "inferred",
            resultKind: "no_match",
            returnedCount: 0,
            truncated: false,
            nextQueryHint: null,
          });
        }
        const reserved = consumeBudget(session, { calls: 1 });
        if (!reserved.ok) {
          appendSessionEvent(options.ledger, session, "budget_exhausted", reserved.reason);
          return makeNarrativeToolResult(reserved.reason, {
            sourceRef: "capability:denied",
            evidenceLevel: "inferred",
            resultKind: "no_match",
            returnedCount: 0,
            truncated: false,
            nextQueryHint: null,
          });
        }
        const started = Date.now();
        const value = await rawExecute(toolCallId, params, ...rest);
        const extracted = extractToolUsage(value);
        const settled = consumeBudget(session, {
          inputTokens: extracted.inputTokens,
          outputTokens: extracted.outputTokens,
          latencyMs: extracted.latencyMs ?? Math.max(1, Date.now() - started),
          cost: extracted.cost,
        });
        if (!settled.ok) {
          markBudgetExhausted(session);
          appendSessionEvent(options.ledger, session, "budget_exhausted", settled.reason);
          return makeNarrativeToolResult(settled.reason, {
            sourceRef: "capability:denied",
            evidenceLevel: "inferred",
            resultKind: "no_match",
            returnedCount: 0,
            truncated: false,
            nextQueryHint: null,
          });
        }
        if (isNoMatchResult(value)) {
          session.noMatchCount += 1;
        }
        appendSessionEvent(options.ledger, session, "consumed", "authorized_tool_call", {
          toolCallIds: [toolCallId],
        });
        return value;
      },
    } as T;
  });
}

export function createSubmitCapabilityOutputTool(
  context: { ledger?: CapabilityConsumptionLedger; workspaceId?: string; runId?: string },
): ToolProtocol<TSchema> {
  return {
    name: SUBMIT_CAPABILITY_OUTPUT_TOOL,
    description:
      "Submit structured capability output for the current activation. Artifacts must match the package Output Contract. Cannot emit facts, hard constraints, or chapter patches.",
    label: "Submit Capability Output",
    parameters: Type.Object({
      activationId: Type.String({ description: "System-issued activationId" }),
      outputKind: Type.String({ description: "evidence | unresolved_questions | candidate_guidance | diagnostic | review_question" }),
      artifacts: Type.Array(Type.Any()),
      sourceRefs: Type.Array(Type.String()),
    }),
    requiredPermission: "workspace_read",
    sideEffect: "read_only",
    timeoutMs: 10_000,
    async execute(_toolCallId, params) {
      const input = params as {
        activationId?: string;
        outputKind?: string;
        schemaId?: string;
        artifacts?: unknown[];
        sourceRefs?: string[];
      };
      const session = activatedSessions.get(String(input.activationId ?? ""));
      if (!session) {
        return makeNarrativeToolResult("activation_id_not_authorized", {
          sourceRef: "capability:denied",
          evidenceLevel: "inferred",
          resultKind: "no_match",
          returnedCount: 0,
          truncated: false,
          nextQueryHint: null,
        });
      }
      if (context.workspaceId && session.workspaceId !== context.workspaceId) {
        return makeNarrativeToolResult("cross_workspace_denied", {
          sourceRef: "capability:denied",
          evidenceLevel: "inferred",
          resultKind: "no_match",
          returnedCount: 0,
          truncated: false,
          nextQueryHint: null,
        });
      }
      if (context.runId && session.runId !== context.runId) {
        return makeNarrativeToolResult("cross_run_denied", {
          sourceRef: "capability:denied",
          evidenceLevel: "inferred",
          resultKind: "no_match",
          returnedCount: 0,
          truncated: false,
          nextQueryHint: null,
        });
      }
      const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];
      const schemaId = typeof input.schemaId === "string"
        ? input.schemaId
        : isRecord(artifacts[0]) && typeof artifacts[0].schemaId === "string"
          ? artifacts[0].schemaId
          : undefined;
      const validated = validateCapabilityOutput({
        session,
        outputKind: String(input.outputKind ?? ""),
        schemaId,
        artifacts,
        sourceRefs: Array.isArray(input.sourceRefs) ? input.sourceRefs : [],
        toolCallIds: [_toolCallId],
        ledger: context.ledger,
      });
      if (!validated.ok) {
        return makeNarrativeToolResult(validated.reason, {
          sourceRef: "capability:denied",
          evidenceLevel: "inferred",
          resultKind: "no_match",
          returnedCount: 0,
          truncated: false,
          nextQueryHint: null,
        });
      }
      return makeNarrativeToolResult(`ok consumed ${validated.value.outputArtifactHash}`, {
        sourceRef: `capability:${session.activationId}`,
        evidenceLevel: "confirmed",
        resultKind: "ranked_evidence",
        returnedCount: validated.value.artifacts.length,
        truncated: false,
        nextQueryHint: null,
        outputArtifactHash: validated.value.outputArtifactHash,
      });
    },
  };
}

export function recordDeliveredCapabilityCatalog(input: {
  ledger: CapabilityConsumptionLedger;
  manifest: CapabilityActivationManifest;
  systemPrompt: string;
  userPrompt: string;
  workspaceId?: string;
  runId?: string;
}): string {
  const sent = `${input.systemPrompt}\n${input.userPrompt}`;
  const modelInputHash = sha256(sent);
  for (const decision of input.manifest.decisions.filter((item) => item.decision === "selected")) {
    const session = activatedSessions.get(decision.activationId);
    if (!session?.activated) continue;
    if (input.workspaceId && session.workspaceId !== input.workspaceId) continue;
    if (input.runId && session.runId !== input.runId) continue;
    const rendered = renderAuthorizedPayload(session);
    const payloadText = rendered.ok ? rendered.value.text : "";
    const payloadInSent = payloadText.length > 0 && sent.includes(payloadText);
    const receiptInSent = sent.includes(session.activationId) && sent.includes(session.payload.payloadHash);
    if (!payloadInSent && !receiptInSent) continue;
    const already = input.ledger.events().some((event) => (
      event.event === "delivered_to_model"
      && event.activationId === session.activationId
      && event.modelInputHash === modelInputHash
    ));
    if (already) continue;
    input.ledger.append({
      runId: input.manifest.runId,
      chapterId: input.manifest.chapterId,
      releaseId: input.manifest.releaseId,
      bundleId: input.manifest.bundleId,
      packageId: decision.packageId,
      version: decision.version,
      activationId: decision.activationId,
      targetStage: decision.targetStage,
      event: "delivered_to_model",
      reason: payloadInSent ? "payload_in_sent_model_input" : "receipt_in_sent_model_input",
      payloadHash: decision.payloadHash,
      outputArtifactHash: null,
      contextPackageHash: null,
      modelInputHash,
      modelTurnId: decision.activationId,
      grantedTools: decision.grantedTools,
      toolCallIds: [],
      budgetReserved: decision.reservedBudget,
      budgetUsed: { ...session.used },
    });
  }
  return modelInputHash;
}

export function estimateCapabilityModelTurnCost(input: {
  provider?: string;
  inputTokens: number;
  outputTokens: number;
}): number {
  return computeActualCost({
    provider: input.provider ?? "unknown",
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
  }).actualCost;
}

export function failClosedIfCapabilityBudgetExhausted(result: RuntimeResult<true>): void {
  if (!result.ok) {
    throw new Error(`capability_package_budget_exhausted:${result.reason}`);
  }
}

export function applyCapabilityModelTurnUsage(input: {
  workspaceId: string;
  runId: string;
  usage: { inputTokens?: number; outputTokens?: number; latencyMs?: number; cost?: number };
  ledger?: CapabilityConsumptionLedger;
}): RuntimeResult<true> {
  const sessions = listActiveCapabilitySessions().filter((session) => (
    session.workspaceId === input.workspaceId && session.runId === input.runId
  ));
  let lastFailure: RuntimeResult<true> | null = null;
  for (const session of sessions) {
    const budget = consumeBudget(session, input.usage);
    if (!budget.ok) {
      appendSessionEvent(input.ledger, session, "budget_exhausted", budget.reason);
      lastFailure = budget;
    }
  }
  return lastFailure ?? { ok: true, value: true };
}
