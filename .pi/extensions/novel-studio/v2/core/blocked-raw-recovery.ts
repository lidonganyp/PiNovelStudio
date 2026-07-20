/**
 * blocked-raw-recovery — verified reuse of a frozen raw from the selected writer.
 *
 * Recovery is explicit and fail-closed. It only replaces the raw_chapter model
 * call; editorial generation and literary judging continue through normal routes.
 */

import { join } from "node:path";
import type {
  ModelGenerateFn,
  ModelGenerateOutput,
} from "../adapters/legacy-model-route-adapter.js";
import {
  BLOCKED_CANDIDATE_EVIDENCE_SCHEMA_ID,
  computeRawSha256,
  loadBlockedCandidateEvidence,
  resolveBlockedEvidenceArtifactPath,
} from "./blocked-candidate-evidence.js";

export interface BlockedRawRecoveryProvenance {
  recovered: true;
  artifactPath: string;
  storedSha256: string;
  rawModel: string;
  rawFinishReason: string;
  rawMaxTokens: number | null;
}

export interface BlockedRawRecovery {
  generationModelGenerate: ModelGenerateFn;
  provenance: BlockedRawRecoveryProvenance;
}

export function createBlockedRawRecovery(input: {
  projectRoot: string;
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  writerModel?: "claude" | "gemini31";
  generationModelGenerate: ModelGenerateFn;
}): BlockedRawRecovery {
  const tracesDir = join(input.projectRoot, "workspaces", input.workspaceId, "traces");
  const artifactPath = resolveBlockedEvidenceArtifactPath(tracesDir, input.chapterId);
  const evidence = loadBlockedCandidateEvidence(artifactPath);
  if (!evidence) {
    throw new Error(`blocked raw recovery artifact missing or unreadable: ${artifactPath}`);
  }
  if (evidence.schemaId !== BLOCKED_CANDIDATE_EVIDENCE_SCHEMA_ID) {
    throw new Error(`blocked raw recovery schema mismatch: ${String(evidence.schemaId)}`);
  }
  if (evidence.workspaceId !== input.workspaceId) {
    throw new Error(`blocked raw recovery workspace mismatch: ${evidence.workspaceId}`);
  }
  if (evidence.chapterId !== input.chapterId) {
    throw new Error(`blocked raw recovery chapter mismatch: ${evidence.chapterId}`);
  }
  if (evidence.chapterNumber !== input.chapterNumber) {
    throw new Error(`blocked raw recovery chapterNumber mismatch: ${evidence.chapterNumber}`);
  }
  if (evidence.blockedStage !== "raw_fact_guard") {
    throw new Error(`blocked raw recovery requires blockedStage=raw_fact_guard, got ${evidence.blockedStage}`);
  }
  if (evidence.blocked !== true || evidence.deliverable !== false) {
    throw new Error("blocked raw recovery requires blocked=true and deliverable=false");
  }
  if (typeof evidence.storedText !== "string" || evidence.storedText.trim().length === 0) {
    throw new Error("blocked raw recovery storedText is empty");
  }
  const storedSha256 = computeRawSha256(evidence.storedText);
  if (storedSha256 !== evidence.storedSha256) {
    throw new Error("blocked raw recovery storedText SHA-256 mismatch");
  }
  if (evidence.rawSha256 !== evidence.storedSha256 || evidence.redactionLog.length > 0) {
    throw new Error("blocked raw recovery rejects redacted evidence or rawSha256 mismatch");
  }
  if (evidence.rawLength !== evidence.storedText.length) {
    throw new Error("blocked raw recovery rawLength mismatch");
  }
  if (!evidence.rawFinishReason || evidence.rawFinishReason === "max_tokens") {
    throw new Error(`blocked raw recovery rejects truncated finish reason: ${String(evidence.rawFinishReason)}`);
  }
  const writerModel = input.writerModel ?? "claude";
  const expectedModelPattern = writerModel === "gemini31"
    ? /^gemini-3\.1-pro(?:$|[-_.])/i
    : /^claude-opus-4-6(?:$|[-_.])/i;
  const expectedModelLabel = writerModel === "gemini31" ? "Gemini 3.1 Pro" : "Claude 4.6";
  if (!evidence.rawModel || !expectedModelPattern.test(evidence.rawModel)) {
    throw new Error(`blocked raw recovery requires ${expectedModelLabel} raw model, got ${String(evidence.rawModel)}`);
  }

  const recoveredOutput: ModelGenerateOutput = {
    text: evidence.storedText,
    model: evidence.rawModel,
    provider: writerModel === "gemini31" ? "gemini31" : "anthropic",
    route: "v2_rawstage2",
    durationMs: 0,
    finishReason: evidence.rawFinishReason,
    ...(evidence.rawMaxTokens !== null ? { maxTokens: evidence.rawMaxTokens } : {}),
  };
  const generationModelGenerate: ModelGenerateFn = async (modelInput) => {
    if (modelInput.kind === "raw_chapter") {
      return { ...recoveredOutput, route: modelInput.route };
    }
    return input.generationModelGenerate(modelInput);
  };

  return {
    generationModelGenerate,
    provenance: {
      recovered: true,
      artifactPath,
      storedSha256,
      rawModel: evidence.rawModel,
      rawFinishReason: evidence.rawFinishReason,
      rawMaxTokens: evidence.rawMaxTokens,
    },
  };
}
