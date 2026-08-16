/**
 * CapabilityConsumptionLedger — append-only package lifecycle events.
 *
 * CPG-5.1–5.3 / 5.5. Consumption is only recorded when the 4.3 evidence
 * conditions are met. This ledger references ContextDeliveryLedger hashes
 * and does not copy model input.
 */

import {
  CAPABILITY_CONSUMPTION_LEDGER_SCHEMA_VERSION,
  type CapabilityActivationManifest,
  type CapabilityConsumptionEvent,
  type CapabilityConsumptionEventName,
  type CapabilityPackageSet,
} from "./capability-package-contracts.js";

export const OPTIONAL_CAPABILITY_UNAVAILABLE = "optional_capability_unavailable" as const;
export const UNAUTHORIZED_ACTIVATION = "unauthorized_activation" as const;

const CONSUMED_ALLOWED: ReadonlySet<CapabilityConsumptionEventName> = new Set(["consumed"]);

export function createCapabilityConsumptionLedger(): {
  append: (
    event: Omit<CapabilityConsumptionEvent, "schemaVersion" | "timestamp"> & { timestamp?: string },
  ) => CapabilityConsumptionEvent;
  events: () => readonly CapabilityConsumptionEvent[];
  eventsFor: (packageId: string) => readonly CapabilityConsumptionEvent[];
} {
  const events: CapabilityConsumptionEvent[] = [];
  return {
    append(event) {
      if (CONSUMED_ALLOWED.has(event.event)) {
        const hasTool = event.toolCallIds.length > 0;
        const hasOutput = typeof event.outputArtifactHash === "string" && event.outputArtifactHash.length === 64;
        if (!hasTool && !hasOutput) {
          throw new Error("consumed_requires_tool_or_validated_output");
        }
        if (!event.activationId) {
          throw new Error("consumed_requires_activation_id");
        }
      }
      const recorded: CapabilityConsumptionEvent = {
        ...event,
        schemaVersion: CAPABILITY_CONSUMPTION_LEDGER_SCHEMA_VERSION,
        timestamp: event.timestamp ?? new Date().toISOString(),
      };
      events.push(recorded);
      return recorded;
    },
    events: () => events,
    eventsFor: (packageId: string) => events.filter((event) => event.packageId === packageId),
  };
}

export type CapabilityConsumptionLedger = ReturnType<typeof createCapabilityConsumptionLedger>;

export function hasEvent(
  ledger: CapabilityConsumptionLedger,
  packageId: string,
  event: CapabilityConsumptionEventName,
): boolean {
  return ledger.eventsFor(packageId).some((item) => item.event === event);
}

export function recordOptionalCapabilityUnavailable(
  ledger: CapabilityConsumptionLedger,
  set: CapabilityPackageSet,
  manifest: CapabilityActivationManifest,
): number {
  const packages = new Map(
    set.packages.map((pkg) => [`${pkg.packageId}@${pkg.version}`, pkg]),
  );
  let written = 0;
  for (const decision of manifest.decisions) {
    const pkg = packages.get(`${decision.packageId}@${decision.version}`);
    if (!pkg || pkg.criticality !== "optional") continue;
    if (decision.decision !== "unavailable") continue;
    const reason = decision.reasons.join(",") || "unavailable";
    const already = ledger.events().some((event) => (
      event.event === OPTIONAL_CAPABILITY_UNAVAILABLE
      && event.packageId === pkg.packageId
      && event.version === pkg.version
      && event.reason === reason
    ));
    if (already) continue;
    ledger.append({
      runId: manifest.runId,
      chapterId: manifest.chapterId,
      releaseId: manifest.releaseId,
      bundleId: manifest.bundleId,
      packageId: pkg.packageId,
      version: pkg.version,
      activationId: decision.activationId,
      targetStage: decision.targetStage,
      event: OPTIONAL_CAPABILITY_UNAVAILABLE,
      reason,
      payloadHash: decision.payloadHash || null,
      outputArtifactHash: null,
      contextPackageHash: null,
      modelInputHash: null,
      modelTurnId: null,
      grantedTools: [],
      toolCallIds: [],
      budgetReserved: null,
      budgetUsed: null,
    });
    written += 1;
  }
  return written;
}

export function replayConsumption(ledger: CapabilityConsumptionLedger): {
  catalogActivationIds: string[];
  deliveredModelInputHashes: string[];
  consumedActivationIds: string[];
  stopReasons: string[];
} {
  const events = ledger.events();
  return {
    catalogActivationIds: events
      .filter((event) => event.event === "selected" && event.activationId)
      .map((event) => event.activationId as string),
    deliveredModelInputHashes: events
      .filter((event) => event.event === "delivered_to_model" && event.modelInputHash)
      .map((event) => event.modelInputHash as string),
    consumedActivationIds: events
      .filter((event) => event.event === "consumed" && event.activationId)
      .map((event) => event.activationId as string),
    stopReasons: events
      .filter((event) => (
        event.event === "budget_exhausted"
        || event.event === "skipped"
        || event.event === "rejected"
        || event.event === "failed"
      ))
      .map((event) => event.reason),
  };
}
