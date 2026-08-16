/**
 * Capability Activation Planner — Catalog projection, declarative eligibility,
 * and system-issued Activation Manifests.
 *
 * CPG-2.1–2.7. Models cannot enlarge grants, budgets, or status. Active is
 * not the same as relevant: only applicable packages enter the catalog.
 */

import { createHash } from "node:crypto";
import { canonicalize } from "../governance/evolution-release-schema.js";
import {
  CapabilityRegistry,
  emptyEndpointCapability,
  type CapabilityKey,
  type EndpointCapability,
} from "../../novelos/protocol/capability-registry.js";
import { reserveBudget, type BudgetLedger } from "./budget-ledger.js";
import {
  recordOptionalCapabilityUnavailable,
  type CapabilityConsumptionLedger,
} from "./capability-consumption-ledger.js";
import type { BudgetStage } from "./budget-types.js";
import {
  CAPABILITY_ACTIVATION_SCHEMA_VERSION,
  emptyBudgetReservation,
  isExecutableProductionStatus,
  isIsolatedEvalStatus,
  type CapabilityActivationDecision,
  type CapabilityActivationManifest,
  type CapabilityBudgetPolicy,
  type CapabilityBudgetReservation,
  type CapabilityCatalogEntry,
  type CapabilityChapterFacts,
  type CapabilityPackageManifest,
  type CapabilityPackageSet,
  type CapabilityPredicate,
  type CapabilityStage,
} from "./capability-package-contracts.js";

export interface ActivationPlannerInput {
  runId: string;
  workspaceId: string;
  chapterId: string;
  releaseId: string;
  bundleId: string;
  capabilityPackageSetHash: string;
  routeCapabilityKey: CapabilityKey;
  packageSet: CapabilityPackageSet;
  facts: CapabilityChapterFacts;
  stageAllowedTools: readonly string[];
  releaseAllowedTools: readonly string[];
  ledger: BudgetLedger;
  capabilityRegistry: CapabilityRegistry;
  adapterProbe?: AdapterCompatibilityProbe;
  mode?: "production" | "eval" | "canary";
  consumptionLedger?: CapabilityConsumptionLedger;
}

export interface AdapterCompatibilityProbe {
  nativeFunctionCallingVerified: boolean;
  structuredToolLoopVerified: boolean;
  toolResultContinuationVerified: boolean;
}

export interface ActivationPlannerResult {
  catalog: CapabilityCatalogEntry[];
  catalogHash: string;
  manifest: CapabilityActivationManifest;
  ledger: BudgetLedger;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function readNested(source: Record<string, unknown>, field: string): unknown {
  return field.split(".").reduce<unknown>((acc, part) => {
    if (!acc || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[part];
  }, source);
}

export function evaluateCapabilityPredicate(
  predicate: CapabilityPredicate,
  facts: CapabilityChapterFacts,
): boolean {
  switch (predicate.kind) {
    case "always":
      return true;
    case "never":
      return false;
    case "stage_is":
      return facts.stage === predicate.stage;
    case "chapter_number_gte":
      return facts.chapterNumber >= predicate.value;
    case "chapter_number_lte":
      return facts.chapterNumber <= predicate.value;
    case "intent_field_equals":
      return String(readNested(facts.intent, predicate.field) ?? "") === predicate.value;
    case "intent_field_includes": {
      const value = readNested(facts.intent, predicate.field);
      return typeof value === "string" && value.includes(predicate.value);
    }
    case "context_meta_equals":
      return String(readNested(facts.contextMeta, predicate.field) ?? "") === predicate.value;
    case "state_summary_equals":
      return String(readNested(facts.stateSummary, predicate.field) ?? "") === predicate.value;
    default:
      return false;
  }
}

function applicable(pkg: CapabilityPackageManifest, facts: CapabilityChapterFacts): boolean {
  const include = pkg.applicableWhen.length === 0
    || pkg.applicableWhen.every((predicate) => evaluateCapabilityPredicate(predicate, facts));
  const excluded = pkg.excludedWhen.some((predicate) => evaluateCapabilityPredicate(predicate, facts));
  return include && !excluded;
}

function stageAllowed(pkg: CapabilityPackageManifest, stage: CapabilityStage): boolean {
  return pkg.targetStages.includes(stage);
}

function intersectTools(
  packageTools: readonly string[],
  stageTools: readonly string[],
  releaseTools: readonly string[],
): string[] {
  const stage = new Set(stageTools);
  const release = new Set(releaseTools);
  return packageTools.filter((tool) => stage.has(tool) && release.has(tool));
}

function capabilitySatisfied(
  required: EndpointCapability[keyof EndpointCapability],
): boolean {
  return required === true;
}

function lookupEndpointCapability(
  registry: CapabilityRegistry,
  key: CapabilityKey,
): { registered: boolean; capability: EndpointCapability } {
  const registered = registry.hasEndpointEntry(key);
  return {
    registered,
    capability: registered ? registry.lookupStrict(key) : emptyEndpointCapability(),
  };
}

function adapterCompatible(
  pkg: CapabilityPackageManifest,
  probe: AdapterCompatibilityProbe | undefined,
): string | null {
  const needsNativeFc = pkg.modelCapabilityRequirements.some(
    (req) => req.capability === "nativeFunctionCalling",
  );
  if (!needsNativeFc) return null;
  if (!probe || !probe.nativeFunctionCallingVerified || !probe.structuredToolLoopVerified) {
    return "unverified_react_adapter";
  }
  return null;
}

function mapBudgetStage(stage: CapabilityStage): BudgetStage {
  if (stage === "style_optimization") return "styleOptimization";
  if (stage === "agentic_draft" || stage === "agentic_investigation") return "agenticDraft";
  return "other";
}

function reservePackageBudget(
  ledger: BudgetLedger,
  pkg: CapabilityPackageManifest,
  stage: CapabilityStage,
): { ok: true; ledger: BudgetLedger; reserved: CapabilityBudgetReservation } | { ok: false; ledger: BudgetLedger; reason: string } {
  const policy: CapabilityBudgetPolicy = pkg.budgetPolicy;
  const reserved = reserveBudget(ledger, {
    stage: mapBudgetStage(stage),
    budgetType: "normal",
    modelCalls: policy.maxCalls,
    inputTokens: policy.maxInputTokens,
    outputTokens: policy.maxOutputTokens,
    latencyMs: policy.maxLatencyMs,
    reservationId: `pkg_${pkg.packageId}_${pkg.version}`,
  });
  if (!reserved.ok || !reserved.reservationId) {
    return { ok: false, ledger, reason: reserved.reason ?? "budget_reservation_failed" };
  }
  return {
    ok: true,
    ledger: reserved.ledger,
    reserved: {
      reservationId: reserved.reservationId,
      maxCalls: policy.maxCalls,
      maxInputTokens: policy.maxInputTokens,
      maxOutputTokens: policy.maxOutputTokens,
      maxLatencyMs: policy.maxLatencyMs,
      maxCost: policy.maxCost,
    },
  };
}

function makeActivationId(runId: string, packageId: string, version: string, stage: CapabilityStage): string {
  return sha256(`${runId}:${packageId}@${version}:${stage}`).slice(0, 32);
}

function catalogHashOf(entries: CapabilityCatalogEntry[]): string {
  return sha256(canonicalize(entries.map((entry) => ({
    packageId: entry.packageId,
    version: entry.version,
    targetStage: entry.targetStage,
    activationId: entry.activationId,
    outputKinds: entry.outputKinds,
  }))));
}

export function computeActivationManifestHash(
  manifest: Omit<CapabilityActivationManifest, "issuedAt" | "manifestHash"> | CapabilityActivationManifest,
): string {
  const { issuedAt: _issuedAt, manifestHash: _manifestHash, ...rest } = manifest as CapabilityActivationManifest;
  return sha256(canonicalize(rest));
}

export function projectCapabilityCatalog(
  selected: CapabilityActivationDecision[],
  packages: CapabilityPackageManifest[],
): CapabilityCatalogEntry[] {
  const byId = new Map(packages.map((pkg) => [`${pkg.packageId}@${pkg.version}`, pkg]));
  return selected
    .filter((decision) => decision.decision === "selected")
    .map((decision) => {
      const pkg = byId.get(`${decision.packageId}@${decision.version}`);
      return {
        packageId: decision.packageId,
        version: decision.version,
        purpose: pkg?.purpose ?? "",
        targetStage: decision.targetStage,
        estimatedCost: {
          estimatedCalls: decision.reservedBudget.maxCalls,
          estimatedTokens: decision.reservedBudget.maxInputTokens + decision.reservedBudget.maxOutputTokens,
        },
        outputKinds: (pkg?.outputArtifacts ?? []).map((artifact) => artifact.kind),
        activationId: decision.activationId,
      };
    });
}

export function planCapabilityActivations(input: ActivationPlannerInput): ActivationPlannerResult {
  const mode = input.mode ?? "production";
  const facts = input.facts;
  const packagesById = new Map(input.packageSet.packages.map((pkg) => [pkg.packageId, pkg]));
  const decisions: CapabilityActivationDecision[] = [];
  let ledger = input.ledger;

  const statusAllowed = (pkg: CapabilityPackageManifest): boolean => {
    if (mode === "production") return isExecutableProductionStatus(pkg.status);
    if (mode === "eval") return isIsolatedEvalStatus(pkg.status) || pkg.status === "active";
    return pkg.status === "canary" || pkg.status === "active";
  };

  for (const pkg of input.packageSet.packages) {
    const activationId = makeActivationId(input.runId, pkg.packageId, pkg.version, facts.stage);
    const base = {
      activationId,
      packageId: pkg.packageId,
      version: pkg.version,
      targetStage: facts.stage,
      grantedTools: [] as string[],
      reservedBudget: emptyBudgetReservation(),
      payloadHash: pkg.payloadRef.payloadHash,
    };

    if (!statusAllowed(pkg)) {
      decisions.push({ ...base, decision: "skipped", reasons: [`status_not_admitted:${pkg.status}`] });
      continue;
    }
    if (!applicable(pkg, facts)) {
      decisions.push({ ...base, decision: "skipped", reasons: ["not_applicable"] });
      continue;
    }
    if (!stageAllowed(pkg, facts.stage)) {
      decisions.push({ ...base, decision: "rejected", reasons: [`stage_mismatch:${facts.stage}`] });
      continue;
    }
    if (pkg.enforcement === "eval_only" && mode === "production") {
      decisions.push({ ...base, decision: "rejected", reasons: ["eval_only_forbidden_in_production"] });
      continue;
    }
    const payloadPresent = input.packageSet.payloads.some(
      (payload) => payload.payloadHash === pkg.payloadRef.payloadHash,
    );
    if (!payloadPresent) {
      decisions.push({ ...base, decision: "unavailable", reasons: ["payload_missing"] });
      continue;
    }

    const missingDeps = pkg.dependencies.filter((dep) => {
      const target = packagesById.get(dep.packageId);
      return !target || !statusAllowed(target);
    });
    if (missingDeps.length > 0) {
      decisions.push({
        ...base,
        decision: "rejected",
        reasons: missingDeps.map((dep) => `missing_dependency:${dep.packageId}`),
      });
      continue;
    }

    const conflict = pkg.conflicts.find((item) => {
      const other = packagesById.get(item.packageId);
      return Boolean(other && statusAllowed(other) && applicable(other, facts) && other.packageId !== pkg.packageId);
    });
    if (conflict) {
      decisions.push({ ...base, decision: "rejected", reasons: [`conflict:${conflict.packageId}`] });
      continue;
    }

    const { registered, capability } = lookupEndpointCapability(
      input.capabilityRegistry,
      input.routeCapabilityKey,
    );
    if (!registered) {
      decisions.push({ ...base, decision: "unavailable", reasons: ["endpoint_capability_unregistered"] });
      continue;
    }
    const adapterReason = adapterCompatible(pkg, input.adapterProbe);
    if (adapterReason) {
      decisions.push({ ...base, decision: "unavailable", reasons: [adapterReason] });
      continue;
    }
    const missingCaps = pkg.modelCapabilityRequirements.filter(
      (req) => !capabilitySatisfied(capability[req.capability]),
    );
    if (missingCaps.length > 0) {
      decisions.push({
        ...base,
        decision: "unavailable",
        reasons: missingCaps.map((req) => `missing_model_capability:${req.capability}`),
      });
      continue;
    }

    const grantedTools = intersectTools(pkg.allowedTools, input.stageAllowedTools, input.releaseAllowedTools);
    if (pkg.allowedTools.length > 0 && grantedTools.length === 0) {
      decisions.push({ ...base, decision: "unavailable", reasons: ["tool_grant_empty"] });
      continue;
    }

    const reserved = reservePackageBudget(ledger, pkg, facts.stage);
    if (!reserved.ok) {
      decisions.push({ ...base, decision: "rejected", reasons: [`budget_unsatisfiable:${reserved.reason}`] });
      continue;
    }
    ledger = reserved.ledger;
    decisions.push({
      ...base,
      decision: "selected",
      reasons: ["eligible"],
      grantedTools,
      reservedBudget: reserved.reserved,
    });
  }

  const catalog = projectCapabilityCatalog(decisions, input.packageSet.packages);
  const catalogHash = catalogHashOf(catalog);
  const unsigned = {
    schemaVersion: CAPABILITY_ACTIVATION_SCHEMA_VERSION,
    runId: input.runId,
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    releaseId: input.releaseId,
    bundleId: input.bundleId,
    capabilityPackageSetHash: input.capabilityPackageSetHash,
    routeCapabilityKey: input.routeCapabilityKey,
    catalogHash,
    decisions,
  };
  const issuedAt = new Date(0).toISOString();
  const manifestHash = computeActivationManifestHash(unsigned);
  const manifest = {
    ...unsigned,
    issuedAt,
    manifestHash,
  };
  if (input.consumptionLedger) {
    recordOptionalCapabilityUnavailable(input.consumptionLedger, input.packageSet, manifest);
  }
  return {
    catalog,
    catalogHash,
    ledger,
    manifest,
  };
}

export function catalogContainsPayload(catalog: CapabilityCatalogEntry[]): boolean {
  return catalog.some((entry) => {
    const record = entry as unknown as Record<string, unknown>;
    return "payload" in record || "guidance" in record || "admissionReport" in record;
  });
}
