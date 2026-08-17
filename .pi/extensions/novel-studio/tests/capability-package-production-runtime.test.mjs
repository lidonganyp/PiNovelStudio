/**
 * CPG production-runtime wiring — non-empty Package public-entry E2E.
 *
 * Covers the audit P1 gaps: exact CapabilityKey, required fail-closed,
 * Agentic tool registration, shared BudgetLedger, automatic consumption
 * ledger, output schema, workspace binding, and missing set fail-closed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectRequiredActivationFailures,
  loadFrozenCapabilityPackageSet,
  recordOptionalCapabilityUnavailable,
  resolveRouteCapabilityKey,
} from "../dist-test/v2/core/capability-package-production.js";
import {
  computeCapabilityPackageSetHash,
  sealCapabilityPackage,
} from "../dist-test/v2/governance/capability-package-registry.js";
import { planCapabilityActivations } from "../dist-test/v2/core/capability-activation-planner.js";
import { createBudgetLedger } from "../dist-test/v2/core/budget-ledger.js";
import {
  defaultCapabilityRegistry,
} from "../dist-test/novelos/protocol/capability-registry.js";
import {
  ACTIVATE_CAPABILITY_PACKAGE_TOOL,
  SUBMIT_CAPABILITY_OUTPUT_TOOL,
  activateCapabilityPackage,
  createActivateCapabilityPackageTool,
  createSubmitCapabilityOutputTool,
  invokeCapabilityTool,
  mayDeliverPayloadToAgenticDraft,
  applyCapabilityModelTurnUsage,
  estimateCapabilityModelTurnCost,
  failClosedIfCapabilityBudgetExhausted,
  recordDeliveredCapabilityCatalog,
  releaseCapabilityRuntimeSessions,
  resetCapabilityRuntimeSessions,
  validateCapabilityOutput,
  wrapToolsWithCapabilitySandbox,
} from "../dist-test/novelos/agent/capability-package-runtime.js";
import { createCapabilityConsumptionLedger } from "../dist-test/v2/core/capability-consumption-ledger.js";
import { createNarrativeToolRegistry } from "../dist-test/novelos/agent/narrative-tool-registry.js";
import { PermissionPolicy } from "../dist-test/novelos/security/permission-policy.js";
import { captureBehaviorSnapshot } from "../dist-test/v2/governance/behavior-snapshot.js";

function geminiRouting() {
  return { provider: "gemini31", model: "gemini-3.1-pro" };
}

function sealActiveWorkflow(overrides = {}) {
  return sealCapabilityPackage({
    schemaVersion: "capability-package-v1",
    packageId: "workflow.promise_inspect",
    version: "1.0.0",
    slot: "workflow.promise",
    kind: "workflow_skill",
    purpose: "Inspect open promises",
    applicableWhen: [{ kind: "always" }],
    excludedWhen: [],
    requiredInputs: [],
    outputArtifacts: [{ kind: "evidence", schemaId: "promise-evidence-v1" }],
    payloadRef: { mediaType: "application/json", payloadHash: "", sourceRef: "test:promise" },
    targetStages: ["agentic_investigation"],
    allowedTools: ["query_promise_ledger"],
    stopConditions: [{ kind: "max_tool_calls", value: 2 }],
    budgetPolicy: { maxCalls: 2, maxInputTokens: 2000, maxOutputTokens: 500, maxLatencyMs: 8_000, maxCost: 0.02 },
    authority: "methodology",
    enforcement: "candidate_only",
    dependencies: [],
    conflicts: [],
    modelCapabilityRequirements: [],
    provenance: [{ sourceId: "t1", sourceType: "test" }],
    evalManifestId: "eval-promise-1",
    admissionEvidence: [{ evalManifestId: "eval-promise-1", sampleSize: 8, validatedWinRate: 0.7, reason: "fixture" }],
    status: "active",
    criticality: "required",
    ...overrides,
  }, { method: "inspect promises" });
}

function planWith(pkg, extras = {}) {
  const set = {
    schemaVersion: "capability-package-set-v1",
    packages: [pkg.manifest],
    payloads: [pkg.payload],
  };
  const key = extras.key ?? resolveRouteCapabilityKey(geminiRouting());
  return {
    set,
    key,
    planned: planCapabilityActivations({
      runId: extras.runId ?? "run-e2e",
      workspaceId: extras.workspaceId ?? "ws-authorized",
      chapterId: "ch-03",
      releaseId: "rel-1",
      bundleId: "bundle-1",
      capabilityPackageSetHash: computeCapabilityPackageSetHash(set),
      routeCapabilityKey: key,
      packageSet: set,
      facts: {
        chapterNumber: 3,
        stage: "agentic_investigation",
        intent: { chapterFunction: "advance_promise" },
        contextMeta: {},
        stateSummary: {},
      },
      stageAllowedTools: extras.stageTools ?? ["query_promise_ledger", ACTIVATE_CAPABILITY_PACKAGE_TOOL],
      releaseAllowedTools: extras.releaseTools ?? ["query_promise_ledger", ACTIVATE_CAPABILITY_PACKAGE_TOOL],
      ledger: extras.ledger ?? createBudgetLedger(),
      capabilityRegistry: extras.registry ?? defaultCapabilityRegistry,
      consumptionLedger: extras.consumptionLedger,
      mode: "production",
    }),
  };
}

test("E2E CapabilityKey: gemini31 and claude resolve to registered endpoints", () => {
  const gemini = resolveRouteCapabilityKey(geminiRouting());
  assert.equal(gemini.provider, "gemini");
  assert.equal(gemini.endpoint, "openai-compat");
  assert.equal(gemini.model, "gemini-3.1-pro");
  assert.equal(gemini.protocol, "react-text");
  assert.equal(gemini.adapterVersion, "react-text-v1");
  assert.equal(defaultCapabilityRegistry.hasEndpointEntry(gemini), true);

  const claude = resolveRouteCapabilityKey({ provider: "claude", model: "claude-opus-4-6" });
  assert.equal(claude.provider, "claude");
  assert.equal(claude.endpoint, "anthropic-native");
  assert.equal(defaultCapabilityRegistry.hasEndpointEntry(claude), true);
});

test("E2E required Package: unregistered endpoint fail-closes instead of skipping", () => {
  const pkg = sealActiveWorkflow();
  const { planned, set } = planWith(pkg, {
    key: {
      provider: "gemini31",
      endpoint: "gemini31-default",
      model: "gemini-3.1-pro",
      protocol: "react-text",
      adapterVersion: "react-text-v1",
    },
    registry: defaultCapabilityRegistry,
  });
  const failures = collectRequiredActivationFailures(set, planned.manifest);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].decision, "unavailable");
  assert.ok(failures[0].reasons.some((reason) => reason.includes("endpoint_capability_unregistered")));
});

test("E2E required Package: registered Gemini key can select an active workflow", () => {
  const pkg = sealActiveWorkflow();
  const { planned } = planWith(pkg);
  assert.equal(planned.manifest.decisions[0].decision, "selected");
  assert.ok(planned.catalog.some((entry) => entry.packageId === pkg.manifest.packageId));
});

test("E2E missing Package Set file is fail-closed, not an empty set", () => {
  const root = mkdtempSync(join(tmpdir(), "cpg-missing-set-"));
  try {
    const loaded = loadFrozenCapabilityPackageSet(root);
    assert.ok(loaded.errors.some((error) => error.includes("package_set_missing")));
    assert.equal(loaded.hash, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E2E Agentic registry registers activate_capability_package for selected packages", () => {
  const pkg = sealActiveWorkflow();
  const { planned, set } = planWith(pkg);
  const registry = createNarrativeToolRegistry({
    searchService: {
      getSnapshotId: () => null,
    },
    permissionPolicy: new PermissionPolicy({ workspaceRoot: "/tmp/ws", sessionId: "s1" }),
    capabilityPackages: {
      manifest: planned.manifest,
      packageSet: set,
      ledger: createCapabilityConsumptionLedger(),
    },
  });
  assert.ok(registry.getToolNames().includes(ACTIVATE_CAPABILITY_PACKAGE_TOOL));
  const tool = registry.getToolProtocol(ACTIVATE_CAPABILITY_PACKAGE_TOOL);
  assert.ok(tool);
  assert.equal(tool.requiredPermission, "workspace_read");
});

test("E2E workspace sandbox uses Activation Manifest workspace, not caller-supplied ids", () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealActiveWorkflow();
  const { planned, set } = planWith(pkg, { workspaceId: "ws-authorized" });
  const ledger = createCapabilityConsumptionLedger();
  const session = activateCapabilityPackage({
    activationId: planned.catalog[0].activationId,
    manifest: planned.manifest,
    packageSet: set,
    ledger,
  }).value;
  assert.equal(session.workspaceId, "ws-authorized");
  const denied = invokeCapabilityTool({
    session,
    toolName: "query_promise_ledger",
    args: { workspaceId: "ws-other" },
    execute: () => "leaked",
    authorizedWorkspaceId: "ws-authorized",
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "untrusted_content");
});

test("E2E output schema and stop/cost/latency are enforced; consumed is written automatically", () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealActiveWorkflow();
  const { planned, set } = planWith(pkg);
  const ledger = createCapabilityConsumptionLedger();
  const session = activateCapabilityPackage({
    activationId: planned.catalog[0].activationId,
    manifest: planned.manifest,
    packageSet: set,
    ledger,
  }).value;
  assert.ok(ledger.events().some((event) => event.event === "activated"));
  const badSchema = validateCapabilityOutput({
    session,
    outputKind: "evidence",
    schemaId: "not-the-declared-schema",
    artifacts: [{ promiseId: "p1" }],
    sourceRefs: ["promise:p1"],
    toolCallIds: [],
    ledger,
  });
  assert.equal(badSchema.ok, false);
  assert.equal(badSchema.code, "schema_invalid");
  const overCost = invokeCapabilityTool({
    session,
    toolName: "query_promise_ledger",
    args: {},
    execute: () => ({ items: [] }),
    usage: { cost: 1, latencyMs: 1 },
    ledger,
  });
  assert.equal(overCost.ok, false);
  assert.equal(overCost.code, "budget_exhausted");
  const ok = validateCapabilityOutput({
    session,
    outputKind: "evidence",
    schemaId: "promise-evidence-v1",
    artifacts: [{ promiseId: "p1" }],
    sourceRefs: ["promise:p1"],
    toolCallIds: ["tool-1"],
    ledger,
  });
  assert.equal(ok.ok, true);
  assert.ok(ledger.events().some((event) => event.event === "consumed"));
});

test("E2E snapshot parse failure does not collapse to empty-set hash", () => {
  const root = mkdtempSync(join(tmpdir(), "cpg-bad-set-"));
  writeFileSync(join(root, "capability-package-set.json"), "{not-json", "utf8");
  try {
    assert.throws(() => captureBehaviorSnapshot({
      projectRoot: root,
      modelVersion: "gemini-3.1-pro",
      evalProtocolVersion: "2026-08-01",
      capabilityPackageSetPaths: ["capability-package-set.json"],
      mockRuntimeVersions: { node: "v25.2.1", npm: "10.9.0" },
    }), /capability_package_set_unreadable|JSON|package_set/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E2E shared BudgetLedger: planner reservation is visible on the same ledger instance", () => {
  const pkg = sealActiveWorkflow();
  const ledger = createBudgetLedger();
  const before = Object.keys(ledger.reservations).length;
  const { planned } = planWith(pkg, { ledger });
  assert.equal(planned.manifest.decisions[0].decision, "selected");
  assert.ok(Object.keys(planned.ledger.reservations).length > before);
  assert.equal(planned.ledger.runIdentity.runId, ledger.runIdentity.runId);
});

test("E2E activate tool returns a receipt and keeps candidate-only payload out of draft input", async () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealActiveWorkflow();
  assert.equal(mayDeliverPayloadToAgenticDraft(pkg.manifest.enforcement), false);
  const { planned, set } = planWith(pkg);
  const ledger = createCapabilityConsumptionLedger();
  const tool = createActivateCapabilityPackageTool({
    manifest: planned.manifest,
    packageSet: set,
    ledger,
  });
  const result = await tool.execute("call-1", { activationId: planned.catalog[0].activationId });
  const text = String(result.content[0].text);
  assert.equal(text.includes("inspect promises"), false);
  assert.ok(text.includes("activationId") || text.includes(planned.catalog[0].activationId));
  assert.ok(ledger.events().some((event) => event.event === "activated"));
  assert.equal(ledger.events().some((event) => event.event === "delivered_to_model"), false);
});

test("E2E required + not_applicable does not fail-close the chapter", () => {
  const pkg = sealActiveWorkflow({
    applicableWhen: [{ kind: "chapter_number_gte", value: 99 }],
  });
  const { planned, set } = planWith(pkg);
  assert.equal(planned.manifest.decisions[0].decision, "skipped");
  assert.ok(planned.manifest.decisions[0].reasons.includes("not_applicable"));
  assert.equal(collectRequiredActivationFailures(set, planned.manifest).length, 0);
});

test("E2E snapshot missing Package Set file does not collapse to empty-set hash", () => {
  const root = mkdtempSync(join(tmpdir(), "cpg-missing-snap-"));
  try {
    assert.throws(() => captureBehaviorSnapshot({
      projectRoot: root,
      modelVersion: "gemini-3.1-pro",
      evalProtocolVersion: "2026-08-01",
      capabilityPackageSetPaths: ["data/runtime/capability-package-set.json"],
      mockRuntimeVersions: { node: "v25.2.1", npm: "10.9.0" },
    }), /capability_package_set_missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E2E production tool wrap applies grantedTools/workspace/budget; output validates artifact shape", async () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealActiveWorkflow();
  const { planned, set } = planWith(pkg);
  const ledger = createCapabilityConsumptionLedger();
  activateCapabilityPackage({
    activationId: planned.catalog[0].activationId,
    manifest: planned.manifest,
    packageSet: set,
    ledger,
  });
  let executed = false;
  const wrapped = wrapToolsWithCapabilitySandbox([{
    name: "query_promise_ledger",
    description: "query",
    label: "Query",
    parameters: {},
    requiredPermission: "workspace_read",
    sideEffect: "read_only",
    execute: async () => {
      executed = true;
      return { content: [{ type: "text", text: "ok" }] };
    },
  }], { workspaceId: "ws-authorized", ledger });
  const denied = await wrapped[0].execute("c1", { workspaceId: "ws-other" });
  assert.equal(String(denied.content[0].text).includes("cross_workspace") || denied.details?.resultKind === "no_match", true);
  assert.equal(executed, false);
  const ok = await wrapped[0].execute("c2", {});
  assert.equal(ok.content[0].text, "ok");
  assert.equal(executed, true);

  const submit = createSubmitCapabilityOutputTool({ ledger });
  const badShape = await submit.execute("c3", {
    activationId: planned.catalog[0].activationId,
    outputKind: "evidence",
    artifacts: [{ notAClaim: true }],
    sourceRefs: ["promise:p1"],
  });
  assert.ok(String(badShape.content[0].text).includes("artifact") || String(badShape.content[0].text).includes("schema"));
  const good = await submit.execute("c4", {
    activationId: planned.catalog[0].activationId,
    outputKind: "evidence",
    artifacts: [{ promiseId: "p1", claim: "open promise remains" }],
    sourceRefs: ["promise:p1"],
  });
  assert.ok(String(good.content[0].text).includes("consumed") || String(good.content[0].text).includes("ok") || good.details?.resultKind === "ranked_evidence");
  assert.ok(ledger.events().some((event) => event.event === "consumed"));
});

test("E2E catalog-only first model turn does not write delivered_to_model", () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealActiveWorkflow();
  const { planned } = planWith(pkg);
  const ledger = createCapabilityConsumptionLedger();
  const systemPrompt = "system catalog " + planned.catalog[0].activationId;
  const userPrompt = "write the chapter";
  const hash = recordDeliveredCapabilityCatalog({
    ledger,
    manifest: planned.manifest,
    systemPrompt,
    userPrompt,
  });
  assert.match(hash, /^[a-f0-9]{64}$/);
  const delivered = ledger.events().filter((event) => event.event === "delivered_to_model");
  assert.equal(delivered.length, 0);
});

test("E2E delivered_to_model requires activation and payload or receipt in sent input", () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealActiveWorkflow();
  const { planned, set } = planWith(pkg);
  const ledger = createCapabilityConsumptionLedger();
  const session = activateCapabilityPackage({
    activationId: planned.catalog[0].activationId,
    manifest: planned.manifest,
    packageSet: set,
    ledger,
  }).value;
  const systemPrompt = `activated receipt activationId=${session.activationId} payloadHash=${session.payload.payloadHash}`;
  const userPrompt = "continue with authorized evidence";
  const hash = recordDeliveredCapabilityCatalog({
    ledger,
    manifest: planned.manifest,
    systemPrompt,
    userPrompt,
    workspaceId: session.workspaceId,
    runId: session.runId,
  });
  const delivered = ledger.events().filter((event) => event.event === "delivered_to_model");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].modelInputHash, hash);
  assert.notEqual(delivered[0].modelInputHash, session.payload.payloadHash);
  assert.match(delivered[0].reason, /payload_in_sent_model_input|receipt_in_sent_model_input/);
});

test("P1 sequential workspaces do not let the first session intercept the second", async () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealActiveWorkflow();
  const first = planWith(pkg, { workspaceId: "ws-1", runId: "run-ws-1" });
  const second = planWith(pkg, { workspaceId: "ws-2", runId: "run-ws-2" });
  activateCapabilityPackage({
    activationId: first.planned.catalog[0].activationId,
    manifest: first.planned.manifest,
    packageSet: first.set,
  });
  activateCapabilityPackage({
    activationId: second.planned.catalog[0].activationId,
    manifest: second.planned.manifest,
    packageSet: second.set,
  });
  let executed = false;
  const wrapped = wrapToolsWithCapabilitySandbox([{
    name: "query_promise_ledger",
    execute: async () => {
      executed = true;
      return { content: [{ type: "text", text: "ws-2-ok" }] };
    },
  }], { workspaceId: "ws-2", runId: "run-ws-2" });
  const result = await wrapped[0].execute("c-ws2", {});
  assert.equal(executed, true);
  assert.equal(String(result.content[0].text), "ws-2-ok");
  assert.equal(String(result.content[0].text).includes("cross_workspace_denied"), false);
});

test("P1 production wrap releases the prior workspace session so later runs stay isolated", async () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealActiveWorkflow();
  const first = planWith(pkg, { workspaceId: "ws-1", runId: "run-ws-1" });
  activateCapabilityPackage({
    activationId: first.planned.catalog[0].activationId,
    manifest: first.planned.manifest,
    packageSet: first.set,
  });
  releaseCapabilityRuntimeSessions({ workspaceId: "ws-1", runId: "run-ws-1" });
  const second = planWith(pkg, { workspaceId: "ws-2", runId: "run-ws-2" });
  activateCapabilityPackage({
    activationId: second.planned.catalog[0].activationId,
    manifest: second.planned.manifest,
    packageSet: second.set,
  });
  let executed = false;
  const wrapped = wrapToolsWithCapabilitySandbox([{
    name: "query_promise_ledger",
    execute: async () => {
      executed = true;
      return { content: [{ type: "text", text: "after-release" }] };
    },
  }], { workspaceId: "ws-2", runId: "run-ws-2" });
  const result = await wrapped[0].execute("c-after", {});
  assert.equal(executed, true);
  assert.equal(String(result.content[0].text), "after-release");
});

test("P1 outputKind cannot reuse another artifact schema; max_output_artifacts stops extra artifacts", () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealActiveWorkflow({
    outputArtifacts: [{ kind: "evidence", schemaId: "evidence-v1" }],
    stopConditions: [
      { kind: "max_tool_calls", value: 2 },
      { kind: "max_output_artifacts", value: 1 },
    ],
  });
  const { planned, set } = planWith(pkg);
  const session = activateCapabilityPackage({
    activationId: planned.catalog[0].activationId,
    manifest: planned.manifest,
    packageSet: set,
  }).value;
  const wrongKind = validateCapabilityOutput({
    session,
    outputKind: "diagnostic",
    schemaId: "evidence-v1",
    artifacts: [{ issue: "borrowed schema" }],
    sourceRefs: ["span:1"],
    toolCallIds: ["t1"],
  });
  assert.equal(wrongKind.ok, false);
  assert.match(wrongKind.reason, /output_kind_not_declared|output_schema_mismatch/);
  const tooMany = validateCapabilityOutput({
    session,
    outputKind: "evidence",
    schemaId: "evidence-v1",
    artifacts: [{ claim: "one" }, { claim: "two" }],
    sourceRefs: ["span:1"],
    toolCallIds: ["t2"],
  });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.reason, /max_output_artifacts|stop_condition/);
  const one = validateCapabilityOutput({
    session,
    outputKind: "evidence",
    schemaId: "evidence-v1",
    artifacts: [{ claim: "one" }],
    sourceRefs: ["span:1"],
    toolCallIds: ["t3"],
  });
  assert.equal(one.ok, true);
  const secondSubmit = validateCapabilityOutput({
    session,
    outputKind: "evidence",
    schemaId: "evidence-v1",
    artifacts: [{ claim: "two" }],
    sourceRefs: ["span:2"],
    toolCallIds: ["t4"],
  });
  assert.equal(secondSubmit.ok, false);
  assert.match(secondSubmit.reason, /max_output_artifacts|stop_condition/);
});

test("P1 no_match stop condition and production wrap meter actual usage", async () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealActiveWorkflow({
    stopConditions: [
      { kind: "max_tool_calls", value: 4 },
      { kind: "no_match", value: 1 },
    ],
    budgetPolicy: { maxCalls: 4, maxInputTokens: 2000, maxOutputTokens: 500, maxLatencyMs: 8_000, maxCost: 0.02 },
  });
  const { planned, set } = planWith(pkg);
  const session = activateCapabilityPackage({
    activationId: planned.catalog[0].activationId,
    manifest: planned.manifest,
    packageSet: set,
  }).value;
  const wrapped = wrapToolsWithCapabilitySandbox([{
    name: "query_promise_ledger",
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        content: [{ type: "text", text: "empty" }],
        details: {
          resultKind: "no_match",
          returnedCount: 0,
          usage: { inputTokens: 12, outputTokens: 3, cost: 0.01 },
        },
      };
    },
  }], { workspaceId: "ws-authorized", runId: planned.manifest.runId });
  const first = await wrapped[0].execute("c-empty", {});
  assert.equal(String(first.content[0].text), "empty");
  assert.ok(session.used.latencyMs > 0, "production wrap must measure latency");
  assert.equal(session.used.inputTokens, 12);
  assert.equal(session.used.outputTokens, 3);
  assert.equal(session.used.cost, 0.01);
  const second = await wrapped[0].execute("c-empty-2", {});
  assert.equal(String(second.content[0].text).includes("no_match") || second.details?.resultKind === "no_match", true);
});

test("P1 production model-turn usage consumes reserved token and cost budget", () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealActiveWorkflow({
    budgetPolicy: { maxCalls: 2, maxInputTokens: 100, maxOutputTokens: 40, maxLatencyMs: 8_000, maxCost: 0.02 },
  });
  const { planned, set } = planWith(pkg);
  const session = activateCapabilityPackage({
    activationId: planned.catalog[0].activationId,
    manifest: planned.manifest,
    packageSet: set,
  }).value;
  const first = applyCapabilityModelTurnUsage({
    workspaceId: session.workspaceId,
    runId: session.runId,
    usage: { inputTokens: 80, outputTokens: 20, latencyMs: 120, cost: 0.01 },
  });
  assert.equal(first.ok, true);
  assert.equal(session.used.inputTokens, 80);
  assert.equal(session.used.cost, 0.01);
  const over = applyCapabilityModelTurnUsage({
    workspaceId: session.workspaceId,
    runId: session.runId,
    usage: { inputTokens: 30, outputTokens: 1, latencyMs: 10, cost: 0.02 },
  });
  assert.equal(over.ok, false);
  assert.equal(over.code, "budget_exhausted");
});

test("P1 submit_capability_output cannot consume another run's activation", async () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealActiveWorkflow();
  const first = planWith(pkg, { workspaceId: "ws-1", runId: "run-1" });
  const second = planWith(pkg, { workspaceId: "ws-2", runId: "run-2" });
  activateCapabilityPackage({
    activationId: first.planned.catalog[0].activationId,
    manifest: first.planned.manifest,
    packageSet: first.set,
  });
  activateCapabilityPackage({
    activationId: second.planned.catalog[0].activationId,
    manifest: second.planned.manifest,
    packageSet: second.set,
  });
  const ws2Ledger = createCapabilityConsumptionLedger();
  const submit = createSubmitCapabilityOutputTool({
    ledger: ws2Ledger,
    workspaceId: "ws-2",
    runId: "run-2",
  });
  const leaked = await submit.execute("cross-run", {
    activationId: first.planned.catalog[0].activationId,
    outputKind: "evidence",
    artifacts: [{ claim: "from ws-1" }],
    sourceRefs: ["promise:p1"],
  });
  assert.equal(String(leaked.content[0].text).includes("ok"), false);
  assert.equal(
    String(leaked.content[0].text).includes("cross_run")
      || String(leaked.content[0].text).includes("cross_workspace")
      || leaked.details?.resultKind === "no_match",
    true,
  );
  assert.equal(ws2Ledger.events().some((event) => event.event === "consumed"), false);
  assert.equal(ws2Ledger.events().some((event) => event.runId === "run-1"), false);
});

test("P1 actual cost overspend stops later tool execution", async () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealActiveWorkflow({
    stopConditions: [{ kind: "max_tool_calls", value: 3 }],
    budgetPolicy: { maxCalls: 3, maxInputTokens: 2000, maxOutputTokens: 500, maxLatencyMs: 8_000, maxCost: 0.01 },
  });
  const { planned, set } = planWith(pkg);
  const ledger = createCapabilityConsumptionLedger();
  activateCapabilityPackage({
    activationId: planned.catalog[0].activationId,
    manifest: planned.manifest,
    packageSet: set,
    ledger,
  });
  let executed = 0;
  const wrapped = wrapToolsWithCapabilitySandbox([{
    name: "query_promise_ledger",
    execute: async () => {
      executed += 1;
      return {
        content: [{ type: "text", text: `ran-${executed}` }],
        details: { usage: { cost: 0.02 } },
      };
    },
  }], { workspaceId: "ws-authorized", runId: planned.manifest.runId, ledger });
  const first = await wrapped[0].execute("call-cost-1", {});
  assert.match(String(first.content[0].text), /budget_exhausted/);
  assert.equal(executed, 1);
  const second = await wrapped[0].execute("call-cost-2", {});
  assert.match(String(second.content[0].text), /budget_exhausted/);
  assert.equal(executed, 1);
});

test("P2 consumed ledger keeps the real toolCallId, not the tool name", async () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealActiveWorkflow();
  const { planned, set } = planWith(pkg);
  const ledger = createCapabilityConsumptionLedger();
  activateCapabilityPackage({
    activationId: planned.catalog[0].activationId,
    manifest: planned.manifest,
    packageSet: set,
    ledger,
  });
  const wrapped = wrapToolsWithCapabilitySandbox([{
    name: "query_promise_ledger",
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  }], { workspaceId: "ws-authorized", runId: planned.manifest.runId, ledger });
  await wrapped[0].execute("tool-call-abc", {});
  await wrapped[0].execute("tool-call-def", {});
  const consumed = ledger.events().filter((event) => event.event === "consumed");
  assert.ok(consumed.some((event) => event.toolCallIds.includes("tool-call-abc")));
  assert.ok(consumed.some((event) => event.toolCallIds.includes("tool-call-def")));
  assert.equal(consumed.some((event) => event.toolCallIds.includes("query_promise_ledger")), false);
});

test("P1 wrap reserves tool-call budget before executing", async () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealActiveWorkflow({
    stopConditions: [{ kind: "max_tool_calls", value: 1 }],
    budgetPolicy: { maxCalls: 1, maxInputTokens: 2000, maxOutputTokens: 500, maxLatencyMs: 8_000, maxCost: 0.02 },
  });
  const { planned, set } = planWith(pkg);
  activateCapabilityPackage({
    activationId: planned.catalog[0].activationId,
    manifest: planned.manifest,
    packageSet: set,
  });
  let executed = 0;
  const wrapped = wrapToolsWithCapabilitySandbox([{
    name: "query_promise_ledger",
    execute: async () => {
      executed += 1;
      return { content: [{ type: "text", text: `ran-${executed}` }] };
    },
  }], { workspaceId: "ws-authorized", runId: planned.manifest.runId });
  const first = await wrapped[0].execute("c1", {});
  assert.equal(String(first.content[0].text), "ran-1");
  assert.equal(executed, 1);
  const second = await wrapped[0].execute("c2", {});
  assert.match(String(second.content[0].text), /max_tool_calls|budget_exhausted/);
  assert.equal(executed, 1);
});

test("P1 model-turn usage meters every activated turn with cost and fail-closes", () => {
  resetCapabilityRuntimeSessions();
  const pkg = sealActiveWorkflow({
    budgetPolicy: { maxCalls: 2, maxInputTokens: 200, maxOutputTokens: 80, maxLatencyMs: 8_000, maxCost: 0.05 },
  });
  const { planned, set } = planWith(pkg);
  const session = activateCapabilityPackage({
    activationId: planned.catalog[0].activationId,
    manifest: planned.manifest,
    packageSet: set,
  }).value;
  const firstUsage = estimateCapabilityModelTurnCost({
    provider: "gemini31",
    inputTokens: 40,
    outputTokens: 10,
  });
  assert.ok(firstUsage > 0);
  const first = applyCapabilityModelTurnUsage({
    workspaceId: session.workspaceId,
    runId: session.runId,
    usage: { inputTokens: 40, outputTokens: 10, latencyMs: 20, cost: firstUsage },
  });
  assert.equal(first.ok, true);
  const second = applyCapabilityModelTurnUsage({
    workspaceId: session.workspaceId,
    runId: session.runId,
    usage: { inputTokens: 40, outputTokens: 10, latencyMs: 20, cost: firstUsage },
  });
  assert.equal(second.ok, true);
  assert.equal(session.used.inputTokens, 80);
  assert.ok(session.used.cost > firstUsage);
  const blocked = applyCapabilityModelTurnUsage({
    workspaceId: session.workspaceId,
    runId: session.runId,
    usage: { inputTokens: 200, outputTokens: 80, latencyMs: 20, cost: 1 },
  });
  assert.equal(blocked.ok, false);
  assert.throws(
    () => failClosedIfCapabilityBudgetExhausted(blocked),
    /capability_package_budget_exhausted/,
  );
});

test("P2 optional unavailable is written by planner and runtime, not by the test", () => {
  resetCapabilityRuntimeSessions();
  const optional = sealActiveWorkflow({
    packageId: "workflow.optional_inspect",
    slot: "workflow.optional",
    criticality: "optional",
  });
  const ledger = createCapabilityConsumptionLedger();
  const { planned, set } = planWith(optional, {
    key: {
      provider: "gemini31",
      endpoint: "gemini31-default",
      model: "gemini-3.1-pro",
      protocol: "react-text",
      adapterVersion: "react-text-v1",
    },
    consumptionLedger: ledger,
  });
  assert.equal(planned.manifest.decisions[0].decision, "unavailable");
  assert.ok(ledger.events().some((event) => event.event === "optional_capability_unavailable"));

  const payloadMissingLedger = createCapabilityConsumptionLedger();
  const selected = planWith(optional);
  const missing = activateCapabilityPackage({
    activationId: selected.planned.catalog[0].activationId,
    manifest: selected.planned.manifest,
    packageSet: { schemaVersion: "capability-package-set-v1", packages: [optional.manifest], payloads: [] },
    ledger: payloadMissingLedger,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "optional_unavailable");
  assert.ok(payloadMissingLedger.events().some((event) => event.event === "optional_capability_unavailable"));

  const entryLedger = createCapabilityConsumptionLedger();
  recordOptionalCapabilityUnavailable(entryLedger, set, planned.manifest);
  assert.ok(entryLedger.events().some((event) => (
    event.event === "optional_capability_unavailable"
    && event.reason.includes("endpoint_capability_unregistered")
  )));
});
