/**
 * CAPABILITY-PACKAGE-GOVERNANCE-1 — Package / Activation / Runtime / Ledger.
 *
 * Covers plan §9 T01–T27, T29–T30. T28 is human A/B evidence and stays
 * recommendation-only in the eval gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_PACKAGE_SCHEMA_VERSION,
  CAPABILITY_OUTPUT_KINDS,
  isLegalKindAuthorityEnforcement,
  mayEnterRawChannel,
} from "../dist-test/v2/core/capability-package-contracts.js";
import {
  computeCapabilityPackageSetHash,
  computePackageContentHash,
  createEmptyCapabilityPackageSet,
  sealCapabilityPackage,
  validateCapabilityPackageSet,
} from "../dist-test/v2/governance/capability-package-registry.js";
import {
  computeActivationManifestHash,
  planCapabilityActivations,
  projectCapabilityCatalog,
} from "../dist-test/v2/core/capability-activation-planner.js";
import {
  createCapabilityConsumptionLedger,
  replayConsumption,
} from "../dist-test/v2/core/capability-consumption-ledger.js";
import {
  activateCapabilityPackage,
  activateCapabilityPackageByPackageId,
  assertNotInjectedIntoRaw,
  invokeCapabilityTool,
  renderAuthorizedPayload,
  requestBudgetExpansion,
  resetCapabilityRuntimeSessions,
  validateCapabilityOutput,
} from "../dist-test/novelos/agent/capability-package-runtime.js";
import {
  evaluateCapabilityAdmission,
  applyEvalRecommendationToPackage,
  PROMPT_PATTERN_MIN_SAMPLE_SIZE,
} from "../dist-test/v2/governance/capability-package-eval-gate.js";
import { computeBehaviorBundleId } from "../dist-test/v2/governance/behavior-bundle.js";
import { createBudgetLedger } from "../dist-test/v2/core/budget-ledger.js";
import {
  CapabilityRegistry,
  createEndpointCapability,
} from "../dist-test/novelos/protocol/capability-registry.js";
import { adaptPromptPatternToPackage } from "../dist-test/v2/core/prompt-pattern-library.js";
import { compileMethodologyApplicationReport } from "../dist-test/v2/core/methodology-policy.js";
import { loadFrozenCapabilityPackageSet } from "../dist-test/v2/core/capability-package-production.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(EXT_ROOT, "..", "..", "..");

function routeKey(overrides = {}) {
  return {
    provider: "gemini",
    endpoint: "google-ai-native",
    model: "gemini-3.1-pro-preview",
    protocol: "react-text",
    adapterVersion: "react-text-v1",
    ...overrides,
  };
}

function registryWith(key, capability) {
  const registry = new CapabilityRegistry();
  registry.register({
    key,
    capability: createEndpointCapability(capability),
    source: "test",
    declaredAt: "2026-08-15T00:00:00Z",
  });
  return registry;
}

function sealWorkflow(overrides = {}, payload = { method: "inspect promises" }) {
  return sealCapabilityPackage({
    schemaVersion: CAPABILITY_PACKAGE_SCHEMA_VERSION,
    packageId: "workflow.promise_inspect",
    version: "1.0.0",
    slot: "workflow.promise",
    kind: "workflow_skill",
    purpose: "Inspect open promises",
    applicableWhen: [{ kind: "stage_is", stage: "agentic_investigation" }],
    excludedWhen: [],
    requiredInputs: [],
    outputArtifacts: [{ kind: "evidence", schemaId: "promise-evidence-v1" }],
    payloadRef: { mediaType: "application/json", payloadHash: "", sourceRef: "test:promise" },
    targetStages: ["agentic_investigation"],
    allowedTools: ["query_promise_ledger"],
    stopConditions: [{ kind: "max_tool_calls", value: 2 }],
    budgetPolicy: { maxCalls: 2, maxInputTokens: 2000, maxOutputTokens: 500, maxLatencyMs: 10_000, maxCost: 0.05 },
    authority: "methodology",
    enforcement: "candidate_only",
    dependencies: [],
    conflicts: [],
    modelCapabilityRequirements: [],
    provenance: [{ sourceId: "t1", sourceType: "test" }],
    evalManifestId: "eval-promise-1",
    admissionEvidence: [{ evalManifestId: "eval-promise-1", sampleSize: 8, validatedWinRate: 0.7, reason: "fixture" }],
    status: "active",
    criticality: "optional",
    ...overrides,
  }, payload);
}

function facts(overrides = {}) {
  return {
    chapterNumber: 3,
    stage: "agentic_investigation",
    intent: { chapterFunction: "advance_promise" },
    contextMeta: {},
    stateSummary: {},
    ...overrides,
  };
}

function plan(packages, options = {}) {
  const set = {
    schemaVersion: "capability-package-set-v1",
    packages: packages.map((item) => item.manifest),
    payloads: packages.map((item) => item.payload),
  };
  const key = options.routeKey ?? routeKey();
  return planCapabilityActivations({
    runId: options.runId ?? "run-1",
    workspaceId: "ws-1",
    chapterId: "ch-03",
    releaseId: "rel-1",
    bundleId: "bundle-1",
    capabilityPackageSetHash: computeCapabilityPackageSetHash(set),
    routeCapabilityKey: key,
    packageSet: set,
    facts: options.facts ?? facts(),
    stageAllowedTools: options.stageTools ?? ["query_promise_ledger", "query_canon"],
    releaseAllowedTools: options.releaseTools ?? ["query_promise_ledger", "query_canon"],
    ledger: options.ledger ?? createBudgetLedger(),
    capabilityRegistry: options.registry ?? registryWith(key, {
      toolResultContinuation: true,
      structuredToolCallParser: true,
    }),
    adapterProbe: options.adapterProbe,
    mode: options.mode ?? "production",
  });
}

test("CPG-0 contracts: eval_only is the single extra enforcement and cannot enter raw", () => {
  assert.equal(mayEnterRawChannel("eval_only"), false);
  assert.equal(isLegalKindAuthorityEnforcement("workflow_skill", "author", "hard_boundary"), false);
  assert.equal(isLegalKindAuthorityEnforcement("diagnostic_module", "methodology", "review_only"), true);
  const report = compileMethodologyApplicationReport(["craftGenes"]);
  assert.ok(report.violations.some((item) => item.startsWith("craft_strategy_hypotheses")));
});

test("T01: active but not applicable stays out of catalog", () => {
  const pkg = sealWorkflow({
    applicableWhen: [{ kind: "chapter_number_gte", value: 10 }],
  });
  const result = plan([pkg]);
  const decision = result.manifest.decisions[0];
  assert.equal(decision.decision, "skipped");
  assert.ok(decision.reasons.includes("not_applicable"));
  assert.equal(result.catalog.length, 0);
});

test("T02: two active versions in one slot fail freeze", () => {
  const a = sealWorkflow();
  const b = sealWorkflow({ version: "1.0.1" });
  const set = {
    schemaVersion: "capability-package-set-v1",
    packages: [a.manifest, b.manifest],
    payloads: [a.payload, b.payload],
  };
  const validation = validateCapabilityPackageSet(set);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.startsWith("duplicate_active_slot")));
});

test("T03: repeated activation returns the same session", () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealWorkflow();
  const planned = plan([pkg]);
  const set = {
    schemaVersion: "capability-package-set-v1",
    packages: [pkg.manifest],
    payloads: [pkg.payload],
  };
  const first = activateCapabilityPackage({
    activationId: planned.catalog[0].activationId,
    manifest: planned.manifest,
    packageSet: set,
  });
  const second = activateCapabilityPackage({
    activationId: planned.catalog[0].activationId,
    manifest: planned.manifest,
    packageSet: set,
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.value.activationId, second.value.activationId);
});

test("T04: unknown packageId is unauthorized", () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealWorkflow();
  const planned = plan([pkg]);
  const denied = activateCapabilityPackageByPackageId("workflow.not_listed", planned.manifest, {
    schemaVersion: "capability-package-set-v1",
    packages: [pkg.manifest],
    payloads: [pkg.payload],
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "unauthorized_activation");
});

test("T05 / T17: unauthorized or pointer-writing tools are rejected", () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealWorkflow();
  const planned = plan([pkg]);
  const set = {
    schemaVersion: "capability-package-set-v1",
    packages: [pkg.manifest],
    payloads: [pkg.payload],
  };
  const session = activateCapabilityPackage({
    activationId: planned.catalog[0].activationId,
    manifest: planned.manifest,
    packageSet: set,
  });
  const ungranted = invokeCapabilityTool({
    session: session.value,
    toolName: "save_chapter",
    args: {},
    execute: () => "nope",
  });
  assert.equal(ungranted.ok, false);
  const forbidden = invokeCapabilityTool({
    session: session.value,
    toolName: "query_promise_ledger",
    args: { action: "switch_production_pointer" },
    execute: () => "nope",
  });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.code, "untrusted_content");
});

test("T06 / T07: budget cannot expand and exhaustion stops the package", () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealWorkflow({
    budgetPolicy: { maxCalls: 1, maxInputTokens: 2000, maxOutputTokens: 500, maxLatencyMs: 10_000, maxCost: 0.05 },
  });
  const planned = plan([pkg]);
  const set = {
    schemaVersion: "capability-package-set-v1",
    packages: [pkg.manifest],
    payloads: [pkg.payload],
  };
  const session = activateCapabilityPackage({
    activationId: planned.catalog[0].activationId,
    manifest: planned.manifest,
    packageSet: set,
  }).value;
  assert.equal(requestBudgetExpansion(session, { calls: 10 }).ok, false);
  const first = invokeCapabilityTool({
    session,
    toolName: "query_promise_ledger",
    args: {},
    execute: () => ({ items: [] }),
  });
  assert.equal(first.ok, true);
  const second = invokeCapabilityTool({
    session,
    toolName: "query_promise_ledger",
    args: {},
    execute: () => ({ items: [] }),
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, "budget_exhausted");
});

test("T08 / T09: unverified ReAct and unregistered endpoint do not inherit capability", () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealWorkflow({
    modelCapabilityRequirements: [{ capability: "nativeFunctionCalling", required: true }],
  });
  const unverified = plan([pkg], { adapterProbe: { nativeFunctionCallingVerified: false, structuredToolLoopVerified: false, toolResultContinuationVerified: false } });
  assert.equal(unverified.manifest.decisions[0].decision, "unavailable");
  assert.ok(unverified.manifest.decisions[0].reasons.includes("unverified_react_adapter"));

  const sameName = routeKey({ endpoint: "openai-compat" });
  const registry = new CapabilityRegistry();
  registry.registerProviderDefault("gemini", createEndpointCapability({ nativeFunctionCalling: true }));
  const planned = plan([pkg], { routeKey: sameName, registry, adapterProbe: { nativeFunctionCallingVerified: true, structuredToolLoopVerified: true, toolResultContinuationVerified: true } });
  assert.equal(planned.manifest.decisions[0].decision, "unavailable");
  assert.ok(planned.manifest.decisions[0].reasons.includes("endpoint_capability_unregistered"));
});

test("T10 / T11: required missing fail-closes; optional missing is traced", () => {
  resetCapabilityRuntimeSessions();
  const required = sealWorkflow({ criticality: "required" });
  const optional = sealWorkflow({ packageId: "workflow.optional_inspect", slot: "workflow.optional", criticality: "optional" });
  const planned = plan([required, optional]);
  const ledger = createCapabilityConsumptionLedger();
  const missingRequired = activateCapabilityPackage({
    activationId: planned.catalog.find((item) => item.packageId === required.manifest.packageId).activationId,
    manifest: planned.manifest,
    packageSet: { schemaVersion: "capability-package-set-v1", packages: [required.manifest], payloads: [] },
    ledger,
  });
  assert.equal(missingRequired.ok, false);
  assert.equal(missingRequired.code, "required_unavailable");
  const missingOptional = activateCapabilityPackage({
    activationId: planned.catalog.find((item) => item.packageId === optional.manifest.packageId).activationId,
    manifest: planned.manifest,
    packageSet: { schemaVersion: "capability-package-set-v1", packages: [optional.manifest], payloads: [] },
    ledger,
  });
  assert.equal(missingOptional.code, "optional_unavailable");
  assert.ok(ledger.events().some((event) => (
    event.event === "optional_capability_unavailable"
    && event.packageId === optional.manifest.packageId
    && event.reason === "payload_missing"
  )));
});

test("T12 / T13: payload or rule changes move contentHash, set hash, and bundleId", () => {
  const original = sealWorkflow();
  const changed = sealWorkflow({}, { method: "inspect promises harder" });
  assert.notEqual(original.manifest.contentHash, changed.manifest.contentHash);
  const setA = { schemaVersion: "capability-package-set-v1", packages: [original.manifest], payloads: [original.payload] };
  const setB = { schemaVersion: "capability-package-set-v1", packages: [changed.manifest], payloads: [changed.payload] };
  const hashA = computeCapabilityPackageSetHash(setA);
  const hashB = computeCapabilityPackageSetHash(setB);
  assert.notEqual(hashA, hashB);
  const base = {
    modelVersion: "gemini-3.1-pro-preview",
    promptBundleHash: "a".repeat(64),
    modelRoutingHash: "b".repeat(64),
    toolSchemaHash: "c".repeat(64),
    contextCompilerHash: "d".repeat(64),
    qualityPolicyHash: "e".repeat(64),
    recoveryPolicyHash: "f".repeat(64),
    knowledgeSnapshotHash: "1".repeat(64),
    runtimeFingerprint: "2".repeat(64),
    evalProtocolVersion: "2026-08-15",
  };
  assert.notEqual(
    computeBehaviorBundleId({ ...base, capabilityPackageSetHash: hashA }),
    computeBehaviorBundleId({ ...base, capabilityPackageSetHash: hashB }),
  );
  const same = computePackageContentHash(original.manifest);
  assert.equal(same, original.manifest.contentHash);
});

test("T14 / T16 / T15: candidate and review packages cannot enter raw or emit facts/patches", () => {
  assert.equal(assertNotInjectedIntoRaw("candidate_only", "raw").ok, false);
  assert.equal(assertNotInjectedIntoRaw("review_only", "raw").ok, false);
  resetCapabilityRuntimeSessions();
  const review = sealWorkflow({
    kind: "diagnostic_module",
    slot: "diagnostic.review",
    packageId: "diagnostic.review_surface",
    enforcement: "review_only",
    targetStages: ["review_surface"],
    applicableWhen: [{ kind: "stage_is", stage: "review_surface" }],
    outputArtifacts: [{ kind: "diagnostic", schemaId: "diag-v1" }],
    allowedTools: [],
  });
  const planned = plan([review], { facts: facts({ stage: "review_surface" }), stageTools: [], releaseTools: [] });
  const session = activateCapabilityPackage({
    activationId: planned.catalog[0].activationId,
    manifest: planned.manifest,
    packageSet: { schemaVersion: "capability-package-set-v1", packages: [review.manifest], payloads: [review.payload] },
  }).value;
  assert.equal(validateCapabilityOutput({
    session,
    outputKind: "fact",
    artifacts: [{ claim: "new fact" }],
    sourceRefs: ["span:1"],
    toolCallIds: [],
  }).ok, false);
  assert.equal(validateCapabilityOutput({
    session,
    outputKind: "diagnostic",
    artifacts: [{ kind: "chapter_patch", text: "rewrite" }],
    sourceRefs: ["span:1"],
    toolCallIds: [],
  }).ok, false);
});

test("T18 / T21: workflow output is evidence with sourceRefs and consumed only after validation", () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealWorkflow();
  const planned = plan([pkg]);
  const ledger = createCapabilityConsumptionLedger();
  const session = activateCapabilityPackage({
    activationId: planned.catalog[0].activationId,
    manifest: planned.manifest,
    packageSet: { schemaVersion: "capability-package-set-v1", packages: [pkg.manifest], payloads: [pkg.payload] },
    ledger,
  }).value;
  const output = validateCapabilityOutput({
    session,
    outputKind: "evidence",
    artifacts: [{ promiseId: "p1", status: "open" }],
    sourceRefs: ["promise:p1"],
    toolCallIds: ["tool-1"],
  });
  assert.equal(output.ok, true);
  ledger.append({
    runId: "run-1",
    chapterId: "ch-03",
    releaseId: "rel-1",
    bundleId: "bundle-1",
    packageId: pkg.manifest.packageId,
    version: pkg.manifest.version,
    activationId: session.activationId,
    targetStage: "agentic_investigation",
    event: "consumed",
    reason: "structured_output_valid",
    payloadHash: session.payload.payloadHash,
    outputArtifactHash: output.value.outputArtifactHash,
    contextPackageHash: "ctx".padEnd(64, "0"),
    modelInputHash: "in".padEnd(64, "1"),
    modelTurnId: "turn-1",
    grantedTools: session.grantedTools,
    toolCallIds: ["tool-1"],
    budgetReserved: null,
    budgetUsed: output.value.budgetUsed,
  });
  assert.ok(replayConsumption(ledger).consumedActivationIds.includes(session.activationId));
});

test("T19 / T20: selected without payload is not consumed; delivery records modelInputHash", () => {
  const pkg = sealWorkflow();
  const planned = plan([pkg]);
  const ledger = createCapabilityConsumptionLedger();
  ledger.append({
    runId: "run-1",
    chapterId: "ch-03",
    releaseId: "rel-1",
    bundleId: "bundle-1",
    packageId: pkg.manifest.packageId,
    version: pkg.manifest.version,
    activationId: planned.catalog[0].activationId,
    targetStage: "agentic_investigation",
    event: "selected",
    reason: "eligible",
    payloadHash: pkg.manifest.payloadRef.payloadHash,
    outputArtifactHash: null,
    contextPackageHash: null,
    modelInputHash: null,
    modelTurnId: null,
    grantedTools: [],
    toolCallIds: [],
    budgetReserved: null,
    budgetUsed: null,
  });
  ledger.append({
    runId: "run-1",
    chapterId: "ch-03",
    releaseId: "rel-1",
    bundleId: "bundle-1",
    packageId: pkg.manifest.packageId,
    version: pkg.manifest.version,
    activationId: planned.catalog[0].activationId,
    targetStage: "agentic_investigation",
    event: "delivered_to_model",
    reason: "catalog_entry_rendered",
    payloadHash: pkg.manifest.payloadRef.payloadHash,
    outputArtifactHash: null,
    contextPackageHash: "ctx".padEnd(64, "a"),
    modelInputHash: "mid".padEnd(64, "b"),
    modelTurnId: "turn-2",
    grantedTools: [],
    toolCallIds: [],
    budgetReserved: null,
    budgetUsed: null,
  });
  const replay = replayConsumption(ledger);
  assert.equal(replay.consumedActivationIds.length, 0);
  assert.deepEqual(replay.deliveredModelInputHashes, ["mid".padEnd(64, "b")]);
});

test("T22: schema retry is package-local", () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealWorkflow();
  const planned = plan([pkg]);
  const session = activateCapabilityPackage({
    activationId: planned.catalog[0].activationId,
    manifest: planned.manifest,
    packageSet: { schemaVersion: "capability-package-set-v1", packages: [pkg.manifest], payloads: [pkg.payload] },
  }).value;
  const failed = validateCapabilityOutput({
    session,
    outputKind: "not_a_kind",
    artifacts: [],
    sourceRefs: [],
    toolCallIds: [],
  });
  assert.equal(failed.code, "schema_invalid");
  assert.ok(CAPABILITY_OUTPUT_KINDS.includes("evidence"));
});

test("T23: missing dependency and required conflict fail-close", () => {
  const dep = sealWorkflow({ packageId: "workflow.dep", slot: "workflow.dep", status: "retired" });
  const child = sealWorkflow({
    packageId: "workflow.child",
    slot: "workflow.child",
    dependencies: [{ packageId: "workflow.dep" }],
  });
  const planned = plan([dep, child]);
  const childDecision = planned.manifest.decisions.find((item) => item.packageId === "workflow.child");
  assert.equal(childDecision.decision, "rejected");
  const a = sealWorkflow({ packageId: "workflow.a", slot: "workflow.a", criticality: "required", conflicts: [{ packageId: "workflow.b" }] });
  const b = sealWorkflow({ packageId: "workflow.b", slot: "workflow.b", criticality: "required", conflicts: [{ packageId: "workflow.a" }] });
  const validation = validateCapabilityPackageSet({
    schemaVersion: "capability-package-set-v1",
    packages: [a.manifest, b.manifest],
    payloads: [a.payload, b.payload],
  });
  assert.ok(validation.errors.some((error) => error.startsWith("required_conflict")));
});

test("T24 / T27: canary and registry mutation stay unauthorized", () => {
  const canary = sealWorkflow({ status: "canary" });
  const planned = plan([canary], { mode: "production" });
  assert.equal(planned.manifest.decisions[0].decision, "skipped");
  assert.throws(() => applyEvalRecommendationToPackage(canary.manifest, {
    recommendation: "admit",
    reasons: [],
    mayChangeStatus: false,
    maySwitchPointer: false,
  }), /eval_gate_cannot_mutate_package_status/);
});

test("T25 / T30: eval gate is not in dist/ and frozen set is single", () => {
  assert.equal(existsSync(join(EXT_ROOT, "dist", "v2", "governance", "capability-package-eval-gate.js")), false);
  const frozen = loadFrozenCapabilityPackageSet(REPO_ROOT);
  assert.equal(frozen.errors.length, 0);
  assert.equal(frozen.set.packages.filter((pkg) => pkg.status === "active").length, 0);
  assert.match(frozen.hash, /^[a-f0-9]{64}$/);
});

test("T26: retired packages are not executable", () => {
  const retired = sealWorkflow({ status: "retired" });
  const planned = plan([retired]);
  assert.equal(planned.catalog.length, 0);
});

test("T29: identical planner inputs reproduce manifestHash; issuedAt is excluded", () => {
  const pkg = sealWorkflow();
  const a = plan([pkg]);
  const b = plan([pkg]);
  assert.equal(a.manifest.manifestHash, b.manifest.manifestHash);
  assert.equal(computeActivationManifestHash(a.manifest), a.manifest.manifestHash);
  const catalog = projectCapabilityCatalog(a.manifest.decisions, [pkg.manifest]);
  assert.equal("payload" in catalog[0], false);
});

test("CPG-1.6 adapters do not create a second status owner", () => {
  const adapted = adaptPromptPatternToPackage({
    id: "payoff_before_spectacle",
    status: "active",
    title: "payoff",
    guidance: "Pay the promise before the spectacle.",
    requiredMoves: ["keep the owed answer visible"],
    avoidPatterns: ["empty spectacle"],
    sources: [{
      sourceId: "exp-1",
      url: "reports/example.json",
      accessedAt: "2026-07-19",
      sourceType: "experiment_report",
      license: "internal",
      evidenceConfidence: "high",
    }],
    admission: { sampleSize: 8, validatedWinRate: 0.7, reason: "fixture" },
  });
  assert.equal(adapted.manifest.kind, "prompt_pattern");
  assert.equal(adapted.manifest.enforcement, "candidate_only");
  assert.equal(adapted.manifest.status, "active");
  assert.equal(assertNotInjectedIntoRaw(adapted.manifest.enforcement, "raw").ok, false);
});

test("CPG-6 eval gate can only recommend and keeps sample floor", () => {
  const pkg = sealWorkflow({ kind: "prompt_pattern", slot: "pattern.x", packageId: "prompt_pattern.x", allowedTools: [] });
  const result = evaluateCapabilityAdmission(pkg.manifest, {
    evalManifestId: "eval-promise-1",
    packageId: pkg.manifest.packageId,
    packageVersion: pkg.manifest.version,
    modelVersion: "gemini-3.1-pro-preview",
    bundleId: "b",
    scenarios: ["T28"],
    minSampleSize: 3,
    minValidatedWinRate: 0.4,
    maxTokenDelta: 100,
    maxLatencyDeltaMs: 100,
    requireHumanAb: true,
  }, {
    sampleSize: 3,
    validatedWinRate: 0.4,
    tokenDelta: 0,
    latencyDeltaMs: 0,
    factSafetyRegressions: 0,
    humanAbPassed: null,
    unnecessaryActivationRate: 0,
  });
  assert.equal(result.mayChangeStatus, false);
  assert.equal(result.maySwitchPointer, false);
  assert.ok(result.reasons.includes("sample_size_floor_regression"));
  assert.ok(result.reasons.includes("human_ab_required"));
  assert.equal(PROMPT_PATTERN_MIN_SAMPLE_SIZE, 8);
});

test("empty package set hash is deterministic", () => {
  assert.equal(
    computeCapabilityPackageSetHash(createEmptyCapabilityPackageSet()),
    computeCapabilityPackageSetHash(createEmptyCapabilityPackageSet()),
  );
});
