/**
 * CapabilityPackageRegistry — immutable manifest/payload validation, content
 * addressing, and frozen Package Set identity.
 *
 * CPG-1.1 / 1.2 / 1.5. A behavior-field change must change contentHash, then
 * capabilityPackageSetHash, then bundleId. Same input always yields the same hash.
 */

import { createHash } from "node:crypto";
import { canonicalize } from "./evolution-release-schema.js";
import {
  CAPABILITY_PACKAGE_KINDS,
  CAPABILITY_PACKAGE_SCHEMA_VERSION,
  CAPABILITY_PACKAGE_SET_SCHEMA_VERSION,
  CAPABILITY_PACKAGE_STATUSES,
  CAPABILITY_STAGES,
  isLegalKindAuthorityEnforcement,
  type CapabilityPackageEnforcement,
  type CapabilityPackageManifest,
  type CapabilityPackageSet,
  type CapabilityPackageStatus,
  type CapabilityPayloadRecord,
  type CapabilityPredicate,
} from "../core/capability-package-contracts.js";
import type { MethodologyAuthority } from "../core/methodology-policy.js";

const PACKAGE_ID_RE = /^[a-z][a-z0-9_.-]{1,79}$/u;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.]+)?$/u;
const HASH_RE = /^[a-f0-9]{64}$/u;
const SLOT_RE = /^[a-z][a-z0-9_.-]{1,63}$/u;

export interface PackageValidation {
  valid: boolean;
  errors: string[];
}

export interface PackageSetValidation extends PackageValidation {
  capabilityPackageSetHash: string | null;
}

const HASH_EXCLUDED_MANIFEST_FIELDS = new Set(["contentHash"]);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPredicate(value: unknown): value is CapabilityPredicate {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "always":
    case "never":
      return true;
    case "stage_is":
      return typeof value.stage === "string" && (CAPABILITY_STAGES as readonly string[]).includes(value.stage);
    case "chapter_number_gte":
    case "chapter_number_lte":
      return typeof value.value === "number" && Number.isFinite(value.value);
    case "intent_field_equals":
    case "intent_field_includes":
    case "context_meta_equals":
    case "state_summary_equals":
      return typeof value.field === "string" && value.field.length > 0 && typeof value.value === "string";
    default:
      return false;
  }
}

function rejectExecutableExpression(errors: string[], predicates: unknown, label: string): void {
  if (!Array.isArray(predicates)) {
    errors.push(`${label}_not_array`);
    return;
  }
  for (const [index, predicate] of predicates.entries()) {
    if (!isPredicate(predicate)) {
      errors.push(`${label}_${index}_invalid`);
    }
  }
}

export function computePayloadHash(body: unknown): string {
  return sha256(canonicalize(body));
}

export function computePackageContentHash(
  manifest: Omit<CapabilityPackageManifest, "contentHash"> | CapabilityPackageManifest,
): string {
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(manifest).sort()) {
    if (HASH_EXCLUDED_MANIFEST_FIELDS.has(key)) continue;
    clone[key] = (manifest as Record<string, unknown>)[key];
  }
  return sha256(canonicalize(clone));
}

export function computeCapabilityPackageSetHash(set: CapabilityPackageSet): string {
  const identities = [...set.packages]
    .map((pkg) => ({
      packageId: pkg.packageId,
      version: pkg.version,
      slot: pkg.slot,
      status: pkg.status,
      contentHash: pkg.contentHash,
      payloadHash: pkg.payloadRef.payloadHash,
    }))
    .sort((a, b) => {
      const left = `${a.packageId}@${a.version}`;
      const right = `${b.packageId}@${b.version}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const payloadHashes = [...set.payloads]
    .map((payload) => payload.payloadHash)
    .sort();
  return sha256(canonicalize({
    schemaVersion: CAPABILITY_PACKAGE_SET_SCHEMA_VERSION,
    packages: identities,
    payloadHashes,
  }));
}

export function validateCapabilityPackageManifest(
  value: unknown,
  payload?: CapabilityPayloadRecord,
): PackageValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["manifest_not_object"] };
  if (value.schemaVersion !== CAPABILITY_PACKAGE_SCHEMA_VERSION) {
    errors.push("unsupported_schema_version");
  }
  if (typeof value.packageId !== "string" || !PACKAGE_ID_RE.test(value.packageId)) {
    errors.push("invalid_package_id");
  }
  if (typeof value.version !== "string" || !VERSION_RE.test(value.version)) {
    errors.push("invalid_version");
  }
  if (typeof value.slot !== "string" || !SLOT_RE.test(value.slot)) {
    errors.push("invalid_slot");
  }
  if (!(CAPABILITY_PACKAGE_KINDS as readonly string[]).includes(String(value.kind))) {
    errors.push("invalid_kind");
  }
  if (typeof value.purpose !== "string" || value.purpose.trim().length === 0 || value.purpose.length > 240) {
    errors.push("invalid_purpose");
  }
  rejectExecutableExpression(errors, value.applicableWhen, "applicableWhen");
  rejectExecutableExpression(errors, value.excludedWhen, "excludedWhen");
  if (!Array.isArray(value.targetStages) || value.targetStages.length === 0) {
    errors.push("target_stages_required");
  } else if (value.targetStages.some((stage) => !(CAPABILITY_STAGES as readonly string[]).includes(String(stage)))) {
    errors.push("invalid_target_stage");
  }
  if (!Array.isArray(value.allowedTools) || value.allowedTools.some((tool) => typeof tool !== "string")) {
    errors.push("invalid_allowed_tools");
  }
  if (!isRecord(value.payloadRef)
    || typeof value.payloadRef.payloadHash !== "string"
    || !HASH_RE.test(value.payloadRef.payloadHash)
    || typeof value.payloadRef.sourceRef !== "string"
    || value.payloadRef.sourceRef.length === 0
  ) {
    errors.push("invalid_payload_ref");
  }
  if (!isRecord(value.budgetPolicy)
    || typeof value.budgetPolicy.maxCalls !== "number"
    || value.budgetPolicy.maxCalls < 0
  ) {
    errors.push("invalid_budget_policy");
  }
  if (!(CAPABILITY_PACKAGE_STATUSES as readonly string[]).includes(String(value.status))) {
    errors.push("invalid_status");
  }
  if (value.criticality !== "required" && value.criticality !== "optional") {
    errors.push("invalid_criticality");
  }
  if (!Array.isArray(value.provenance) || value.provenance.length === 0) {
    errors.push("missing_provenance");
  }
  if (typeof value.evalManifestId !== "string" || value.evalManifestId.length === 0) {
    errors.push("missing_eval_manifest");
  }
  if (!Array.isArray(value.admissionEvidence) || value.admissionEvidence.length === 0) {
    errors.push("missing_admission_evidence");
  }
  if (!Array.isArray(value.dependencies)) errors.push("dependencies_not_array");
  if (!Array.isArray(value.conflicts)) errors.push("conflicts_not_array");
  if (!Array.isArray(value.modelCapabilityRequirements)) {
    errors.push("model_capability_requirements_not_array");
  }
  const kind = value.kind as CapabilityPackageManifest["kind"];
  const authority = value.authority as MethodologyAuthority;
  const enforcement = value.enforcement as CapabilityPackageEnforcement;
  if (!isLegalKindAuthorityEnforcement(kind, authority, enforcement)) {
    errors.push("illegal_kind_authority_enforcement");
  }
  if (payload) {
    const expected = computePayloadHash(payload.body);
    if (payload.payloadHash !== expected) errors.push("payload_hash_mismatch");
    if (isRecord(value.payloadRef) && value.payloadRef.payloadHash !== expected) {
      errors.push("payload_ref_hash_mismatch");
    }
  }
  if (typeof value.contentHash === "string" && HASH_RE.test(value.contentHash)) {
    const recomputed = computePackageContentHash(value as unknown as CapabilityPackageManifest);
    if (recomputed !== value.contentHash) errors.push("content_hash_mismatch");
  } else {
    errors.push("invalid_content_hash");
  }
  return { valid: errors.length === 0, errors };
}

function detectDependencyCycles(packages: CapabilityPackageManifest[]): string[] {
  const byId = new Map(packages.map((pkg) => [pkg.packageId, pkg]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles: string[] = [];

  const walk = (packageId: string, stack: string[]): void => {
    if (visited.has(packageId)) return;
    if (visiting.has(packageId)) {
      cycles.push(`dependency_cycle:${[...stack, packageId].join("->")}`);
      return;
    }
    visiting.add(packageId);
    const pkg = byId.get(packageId);
    for (const dep of pkg?.dependencies ?? []) {
      if (byId.has(dep.packageId)) walk(dep.packageId, [...stack, packageId]);
    }
    visiting.delete(packageId);
    visited.add(packageId);
  };

  for (const pkg of packages) walk(pkg.packageId, []);
  return cycles;
}

export function validateCapabilityPackageSet(set: CapabilityPackageSet): PackageSetValidation {
  const errors: string[] = [];
  if (set.schemaVersion !== CAPABILITY_PACKAGE_SET_SCHEMA_VERSION) {
    errors.push("unsupported_set_schema_version");
  }
  const payloads = new Map(set.payloads.map((payload) => [payload.payloadHash, payload]));
  const seenIdentity = new Set<string>();
  const activeBySlot = new Map<string, string>();
  const byId = new Map<string, CapabilityPackageManifest[]>();

  for (const pkg of set.packages) {
    const identity = `${pkg.packageId}@${pkg.version}`;
    if (seenIdentity.has(identity)) errors.push(`duplicate_package:${identity}`);
    seenIdentity.add(identity);
    const list = byId.get(pkg.packageId) ?? [];
    list.push(pkg);
    byId.set(pkg.packageId, list);

    const payload = payloads.get(pkg.payloadRef.payloadHash);
    if (!payload) errors.push(`missing_payload:${identity}`);
    const validation = validateCapabilityPackageManifest(pkg, payload);
    if (!validation.valid) {
      errors.push(...validation.errors.map((error) => `${identity}:${error}`));
    }
    if (pkg.status === "active") {
      const existing = activeBySlot.get(pkg.slot);
      if (existing) errors.push(`duplicate_active_slot:${pkg.slot}:${existing},${identity}`);
      activeBySlot.set(pkg.slot, identity);
    }
  }

  for (const pkg of set.packages) {
    for (const dep of pkg.dependencies) {
      if (!byId.has(dep.packageId)) {
        errors.push(`unknown_dependency:${pkg.packageId}->${dep.packageId}`);
      } else if (dep.version && !byId.get(dep.packageId)?.some((item) => item.version === dep.version)) {
        errors.push(`unknown_dependency_version:${pkg.packageId}->${dep.packageId}@${dep.version}`);
      }
    }
  }

  errors.push(...detectDependencyCycles(set.packages));

  const requiredActive = set.packages.filter((pkg) => pkg.status === "active" && pkg.criticality === "required");
  for (const pkg of requiredActive) {
    for (const conflict of pkg.conflicts) {
      const other = requiredActive.find((item) => item.packageId === conflict.packageId && item.packageId !== pkg.packageId);
      if (other) errors.push(`required_conflict:${pkg.packageId}<->${other.packageId}`);
    }
  }

  if (errors.length > 0) return { valid: false, errors, capabilityPackageSetHash: null };
  return {
    valid: true,
    errors: [],
    capabilityPackageSetHash: computeCapabilityPackageSetHash(set),
  };
}

export function createEmptyCapabilityPackageSet(): CapabilityPackageSet {
  return {
    schemaVersion: CAPABILITY_PACKAGE_SET_SCHEMA_VERSION,
    packages: [],
    payloads: [],
  };
}

export function sealCapabilityPackage(
  manifest: Omit<CapabilityPackageManifest, "contentHash">,
  payloadBody: unknown,
): { manifest: CapabilityPackageManifest; payload: CapabilityPayloadRecord } {
  const payloadHash = computePayloadHash(payloadBody);
  const payload: CapabilityPayloadRecord = {
    payloadHash,
    mediaType: manifest.payloadRef.mediaType,
    body: payloadBody,
    sourceRef: manifest.payloadRef.sourceRef,
  };
  const withRef: Omit<CapabilityPackageManifest, "contentHash"> = {
    ...manifest,
    payloadRef: {
      ...manifest.payloadRef,
      payloadHash,
    },
  };
  const contentHash = computePackageContentHash(withRef);
  return {
    manifest: { ...withRef, contentHash },
    payload,
  };
}

export function assertFrozenProductionPackageSet(set: CapabilityPackageSet): PackageSetValidation {
  const validation = validateCapabilityPackageSet(set);
  if (!validation.valid) return validation;
  const nonActiveExecutable = set.packages.filter((pkg) => {
    const status: CapabilityPackageStatus = pkg.status;
    return status === "canary" || status === "eval" || status === "draft";
  });
  if (nonActiveExecutable.some((pkg) => pkg.status === "canary" && pkg.criticality === "required")) {
    return {
      valid: false,
      errors: ["canary_cannot_be_required_in_production_set"],
      capabilityPackageSetHash: null,
    };
  }
  return validation;
}
