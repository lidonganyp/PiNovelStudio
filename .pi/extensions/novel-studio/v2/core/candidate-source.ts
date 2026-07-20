/** Candidate source classification shared by trace adapters and historical eval code. */
import type { Candidate, FinalSelectedSource } from "./types.js";

export const RAWSTAGE2_ROUTE = "v2_rawstage2";
export const AMPLIFIED_ROUTE = "v2_amplified";
export const DIRECT_ROUTE_PREFIX = "v2_direct_";

export function classifyCandidateSource(candidate: Candidate): FinalSelectedSource {
  if (candidate.route === RAWSTAGE2_ROUTE) return "rawStage2";
  if (candidate.route === AMPLIFIED_ROUTE) return "v2_amplified";
  if (candidate.route?.startsWith(DIRECT_ROUTE_PREFIX)) return "direct";
  if (candidate.kind === "context_enhanced") return "rawStage2";
  if (candidate.kind === "scene_contract") return "v2_amplified";
  return "direct";
}
