/**
 * Production Capability Package wiring — load frozen set, resolve the exact
 * CapabilityKey, plan chapter activations, and fail-close required packages.
 * Not a second generator.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertFrozenProductionPackageSet,
  computeCapabilityPackageSetHash,
  createEmptyCapabilityPackageSet,
} from "../governance/capability-package-registry.js";
import { planCapabilityActivations } from "./capability-activation-planner.js";
import type { ActivationPlannerInput, ActivationPlannerResult } from "./capability-activation-planner.js";
import type {
  CapabilityActivationManifest,
  CapabilityPackageSet,
} from "./capability-package-contracts.js";
import {
  createCapabilityConsumptionLedger,
  recordOptionalCapabilityUnavailable,
} from "./capability-consumption-ledger.js";

export { recordOptionalCapabilityUnavailable };
import { ACTIVATE_CAPABILITY_PACKAGE_TOOL } from "../../novelos/agent/capability-package-runtime.js";
import type { CapabilityKey } from "../../novelos/protocol/capability-registry.js";

export { ACTIVATE_CAPABILITY_PACKAGE_TOOL };

export interface CapabilityPackageFailureEnvelope {
  stage: "capability_package";
  gate: "required_package";
  severity: "preflight";
  reason: string;
  evidence?: unknown;
  recoverable: false;
}

export const DEFAULT_CAPABILITY_PACKAGE_SET_REL = "data/runtime/capability-package-set.json";

export function resolveRouteCapabilityKey(routing: {
  provider: string;
  model: string;
}): CapabilityKey {
  const rawProvider = routing.provider.trim();
  if (rawProvider === "gemini31" || rawProvider === "gemini") {
    return {
      provider: "gemini",
      endpoint: "openai-compat",
      model: routing.model || "gemini-3.7-flash",
      protocol: "react-text",
      adapterVersion: "react-text-v1",
    };
  }
  if (rawProvider === "claude") {
    return {
      provider: "claude",
      endpoint: "anthropic-native",
      model: routing.model || "claude-opus-4-6",
      protocol: "react-text",
      adapterVersion: "react-text-v1",
    };
  }
  return {
    provider: rawProvider,
    endpoint: "openai-compat",
    model: routing.model,
    protocol: "react-text",
    adapterVersion: "react-text-v1",
  };
}

export function resolveChapterCapabilityPackageSet(
  projectRoot: string | undefined,
  options?: { allowMissingInDev?: boolean },
): ReturnType<typeof loadFrozenCapabilityPackageSet> {
  const loaded = loadFrozenCapabilityPackageSet(projectRoot);
  const missingOnly = loaded.errors.length > 0
    && loaded.errors.every((error) => error === "package_set_missing" || error === "project_root_missing");
  if (missingOnly && options?.allowMissingInDev === true && process.env.PINOVEL_DEV_MODE === "1") {
    const set = createEmptyCapabilityPackageSet();
    return {
      set,
      hash: computeCapabilityPackageSetHash(set),
      source: "empty",
      errors: [],
    };
  }
  return loaded;
}

export function loadFrozenCapabilityPackageSet(projectRoot: string | undefined): {
  set: CapabilityPackageSet;
  hash: string;
  source: "frozen_file" | "empty";
  errors: string[];
} {
  if (!projectRoot || projectRoot.trim().length === 0) {
    return { set: { schemaVersion: "capability-package-set-v1", packages: [], payloads: [] }, hash: "", source: "empty", errors: ["project_root_missing"] };
  }
  const filePath = join(projectRoot, DEFAULT_CAPABILITY_PACKAGE_SET_REL);
  if (!existsSync(filePath)) {
    return {
      set: { schemaVersion: "capability-package-set-v1", packages: [], payloads: [] },
      hash: "",
      source: "empty",
      errors: ["package_set_missing"],
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as CapabilityPackageSet;
    const validation = assertFrozenProductionPackageSet(parsed);
    if (!validation.valid || !validation.capabilityPackageSetHash) {
      return {
        set: { schemaVersion: "capability-package-set-v1", packages: [], payloads: [] },
        hash: "",
        source: "frozen_file",
        errors: validation.errors,
      };
    }
    return {
      set: parsed,
      hash: validation.capabilityPackageSetHash,
      source: "frozen_file",
      errors: [],
    };
  } catch (error) {
    return {
      set: { schemaVersion: "capability-package-set-v1", packages: [], payloads: [] },
      hash: "",
      source: "frozen_file",
      errors: [`package_set_unreadable:${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

export function planProductionCapabilityActivations(
  input: ActivationPlannerInput,
): ActivationPlannerResult {
  return planCapabilityActivations({ ...input, mode: input.mode ?? "production" });
}

export function collectRequiredActivationFailures(
  set: CapabilityPackageSet,
  manifest: CapabilityActivationManifest,
): Array<{ packageId: string; version: string; decision: string; reasons: string[] }> {
  const required = new Set(
    set.packages
      .filter((pkg) => pkg.criticality === "required")
      .map((pkg) => `${pkg.packageId}@${pkg.version}`),
  );
  return manifest.decisions
    .filter((decision) => {
      if (!required.has(`${decision.packageId}@${decision.version}`)) return false;
      if (decision.decision === "selected") return false;
      if (decision.decision === "skipped" && decision.reasons.includes("not_applicable")) return false;
      return true;
    })
    .map((decision) => ({
      packageId: decision.packageId,
      version: decision.version,
      decision: decision.decision,
      reasons: [...decision.reasons],
    }));
}

export function requiredPackageFailure(
  reason: string,
  evidence?: unknown,
): CapabilityPackageFailureEnvelope {
  return {
    stage: "capability_package",
    gate: "required_package",
    severity: "preflight",
    reason,
    evidence,
    recoverable: false,
  };
}

export function createChapterConsumptionLedger(): ReturnType<typeof createCapabilityConsumptionLedger> {
  return createCapabilityConsumptionLedger();
}
