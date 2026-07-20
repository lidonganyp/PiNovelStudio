/**
 * End-to-end release proxy review runner.
 *
 * Stub review is local-only. Real review requires a release-scoped authorization
 * card and trusted NOVELOS_JUDGE_* environment configuration.
 */

import { existsSync } from "node:fs";

import type { ProxyApprovalRegistry } from "./release-proxy-approval-registry.js";
import type { EvolutionReleaseRegistry } from "./evolution-release-registry.js";
import type {
  ApprovalPacketInput,
  ProxyApprovalVerdict,
  RawVerdict,
  ReleaseProxyApprovalArtifact,
} from "./release-proxy-approval-types.js";
import {
  createRealGpt56SolReleaseProxyApprovalCallerFromEnv,
  createStubProxyApprovalCaller,
  executeProxyApproval,
  REAL_PROXY_APPROVAL_PROMPT_HASH,
} from "./proxy-approval-caller.js";
import { computeReleasePayloadHash } from "./evolution-release-schema.js";
import {
  assertCardAuthorizes,
  loadAuthorizationCardFromFile,
} from "./authorization-card.js";

export interface ProxyReviewRunnerOptions {
  proxyRegistry: ProxyApprovalRegistry;
  evolutionRegistry: EvolutionReleaseRegistry;
}

export interface StubReviewOptions {
  releaseId: string;
  packetInput: Omit<ApprovalPacketInput, "releaseId" | "releaseManifestHash">;
  forwardVerdict: RawVerdict;
  reverseVerdict: RawVerdict;
  quarantineReason?: string;
  modelVersion?: string;
  promptHash: string;
  budget: { maxCalls: number; timeoutMs: number };
}

export interface RealReviewOptions {
  releaseId: string;
  packetInput: Omit<ApprovalPacketInput, "releaseId" | "releaseManifestHash">;
  authorizationCardPath?: string;
}

export interface ProxyReviewResult {
  finalVerdict: ProxyApprovalVerdict;
  canPromote: boolean;
  artifact: ReleaseProxyApprovalArtifact;
  blockReason?: string;
  reviewerShoppingDetected?: boolean;
}

function buildFullPacketInput(
  evolutionRegistry: EvolutionReleaseRegistry,
  releaseId: string,
  packetInput: Omit<ApprovalPacketInput, "releaseId" | "releaseManifestHash">,
): ApprovalPacketInput {
  const manifest = evolutionRegistry.loadManifest(releaseId);
  if (manifest === null) {
    throw new Error(
      `releaseId ${releaseId} manifest does not exist; capture and freeze it before proxy review`,
    );
  }
  if (packetInput.changeClass !== manifest.changeClass) {
    throw new Error(
      `packet changeClass=${packetInput.changeClass} does not match manifest changeClass=${manifest.changeClass}`,
    );
  }
  return {
    ...packetInput,
    releaseId,
    releaseManifestHash: computeReleasePayloadHash(manifest),
  };
}

/** Run the deterministic local stub. This path never performs network I/O. */
export async function runStubProxyReview(
  options: ProxyReviewRunnerOptions & StubReviewOptions,
): Promise<ProxyReviewResult> {
  const fullPacketInput = buildFullPacketInput(
    options.evolutionRegistry,
    options.releaseId,
    options.packetInput,
  );
  const caller = createStubProxyApprovalCaller({
    forwardVerdict: options.forwardVerdict,
    reverseVerdict: options.reverseVerdict,
    quarantineReason: options.quarantineReason,
    modelVersion: options.modelVersion,
  });
  return executeProxyApproval({
    packetInput: fullPacketInput,
    caller,
    registry: options.proxyRegistry,
    promptHash: options.promptHash,
    modelVersion: options.modelVersion ?? "",
    budget: options.budget,
  });
}

/**
 * Run the real release proxy reviewer.
 *
 * The authorization card controls release scope, model version, timeout, and
 * maximum calls. API credentials are accepted only from trusted environment
 * configuration and are validated before any network request.
 */
export async function runRealProxyReview(
  options: ProxyReviewRunnerOptions & RealReviewOptions,
): Promise<ProxyReviewResult> {
  const cardPath = options.authorizationCardPath;
  if (!cardPath || !existsSync(cardPath)) {
    throw new Error("REQUIRES_AUTH: real gpt5.6-sol release review requires an authorization card");
  }

  let card;
  try {
    card = loadAuthorizationCardFromFile(cardPath);
    if (card.cardType !== "real_gpt56sol") {
      throw new Error(`cardType=${card.cardType} is not valid for real review`);
    }
    assertCardAuthorizes(card, options.releaseId);
  } catch (error) {
    const message = (error as Error).message;
    throw new Error(message.startsWith("REQUIRES_AUTH:") ? message : `REQUIRES_AUTH: ${message}`);
  }

  const fullPacketInput = buildFullPacketInput(
    options.evolutionRegistry,
    options.releaseId,
    options.packetInput,
  );
  const caller = createRealGpt56SolReleaseProxyApprovalCallerFromEnv();
  return executeProxyApproval({
    packetInput: fullPacketInput,
    caller,
    registry: options.proxyRegistry,
    promptHash: REAL_PROXY_APPROVAL_PROMPT_HASH,
    modelVersion: card.modelVersion,
    budget: card.budget,
  });
}
