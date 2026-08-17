/**
 * Capability Package Eval Gate — admit / hold / reject recommendation only.
 *
 * CPG-6.2 / 6.6. This module never mutates Package status, release manifests,
 * or the production pointer. Human release approval is the only promotion path.
 */

import type { CapabilityPackageManifest } from "../core/capability-package-contracts.js";

export type CapabilityEvalRecommendation = "admit" | "hold" | "reject";

export interface CapabilityEvalManifest {
  evalManifestId: string;
  packageId: string;
  packageVersion: string;
  modelVersion: string;
  bundleId: string;
  scenarios: string[];
  minSampleSize: number;
  minValidatedWinRate: number;
  maxTokenDelta: number;
  maxLatencyDeltaMs: number;
  requireHumanAb: boolean;
}

export interface CapabilityEvalEvidence {
  sampleSize: number;
  validatedWinRate: number | null;
  tokenDelta: number;
  latencyDeltaMs: number;
  factSafetyRegressions: number;
  humanAbPassed: boolean | null;
  unnecessaryActivationRate: number;
}

export interface CapabilityEvalGateResult {
  recommendation: CapabilityEvalRecommendation;
  reasons: string[];
  mayChangeStatus: false;
  maySwitchPointer: false;
}

export const PROMPT_PATTERN_MIN_SAMPLE_SIZE = 8;
export const PROMPT_PATTERN_MIN_VALIDATED_WIN_RATE = 0.55;

export function evaluateCapabilityAdmission(
  pkg: CapabilityPackageManifest,
  evalManifest: CapabilityEvalManifest,
  evidence: CapabilityEvalEvidence,
): CapabilityEvalGateResult {
  const reasons: string[] = [];
  if (evalManifest.packageId !== pkg.packageId || evalManifest.packageVersion !== pkg.version) {
    return {
      recommendation: "reject",
      reasons: ["eval_manifest_identity_mismatch"],
      mayChangeStatus: false,
      maySwitchPointer: false,
    };
  }
  if (pkg.kind === "prompt_pattern") {
    if (evalManifest.minSampleSize < PROMPT_PATTERN_MIN_SAMPLE_SIZE) {
      reasons.push("sample_size_floor_regression");
    }
    if (evalManifest.minValidatedWinRate < PROMPT_PATTERN_MIN_VALIDATED_WIN_RATE) {
      reasons.push("win_rate_floor_regression");
    }
  }
  if (evidence.sampleSize < evalManifest.minSampleSize) reasons.push("insufficient_sample_size");
  if (evidence.validatedWinRate === null || evidence.validatedWinRate < evalManifest.minValidatedWinRate) {
    reasons.push("win_rate_below_threshold");
  }
  if (evidence.tokenDelta > evalManifest.maxTokenDelta) reasons.push("token_delta_over_budget");
  if (evidence.latencyDeltaMs > evalManifest.maxLatencyDeltaMs) reasons.push("latency_delta_over_budget");
  if (evidence.factSafetyRegressions > 0) reasons.push("fact_safety_regression");
  if (evalManifest.requireHumanAb && evidence.humanAbPassed !== true) {
    reasons.push("human_ab_required");
  }
  if (evidence.unnecessaryActivationRate > 0.25) reasons.push("unnecessary_activation_rate");

  const recommendation: CapabilityEvalRecommendation = reasons.length === 0
    ? "admit"
    : reasons.includes("fact_safety_regression") || reasons.includes("eval_manifest_identity_mismatch")
      ? "reject"
      : "hold";
  return {
    recommendation,
    reasons,
    mayChangeStatus: false,
    maySwitchPointer: false,
  };
}

export function applyEvalRecommendationToPackage(
  _pkg: CapabilityPackageManifest,
  _result: CapabilityEvalGateResult,
): never {
  throw new Error("eval_gate_cannot_mutate_package_status");
}
