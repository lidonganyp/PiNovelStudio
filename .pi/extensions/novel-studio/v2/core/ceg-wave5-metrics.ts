/**
 * CEG-6.2 / CEG-6.4 — 分层 vs 平铺的确定性门槛（不调用模型，不做文学裁判）。
 */
export interface LayeringDeterministicScore {
  inviolableFactsPresentInBoth: boolean;
  missingInviolableInFlat: string[];
  missingInviolableInLayered: string[];
  futureLeakInPrompts: number;
  futureLeakInOutput: number;
  layeredDeclaresAuthorityLayers: boolean;
  flatDeclaresAuthorityLayers: boolean;
  tokenEstimateFlat: number;
  tokenEstimateLayered: number;
  tokenDelta: number;
}

export function estimatePromptTokens(text: string): number {
  return Math.ceil(text.length / 1.6);
}

export function scoreLayeringDeterministic(input: {
  inviolableFacts: readonly string[];
  futureChapterMarkers?: readonly string[];
  flatPrompt: string;
  layeredPrompt: string;
  generatedFlat?: string;
  generatedLayered?: string;
}): LayeringDeterministicScore {
  const missingInviolableInFlat = input.inviolableFacts.filter((fact) => !input.flatPrompt.includes(fact));
  const missingInviolableInLayered = input.inviolableFacts.filter((fact) => !input.layeredPrompt.includes(fact));
  const markers = input.futureChapterMarkers ?? [];
  const leakIn = (text: string): number => markers.filter((marker) => marker && text.includes(marker)).length;
  const generated = `${input.generatedFlat ?? ""}\n${input.generatedLayered ?? ""}`;
  const tokenEstimateFlat = estimatePromptTokens(input.flatPrompt);
  const tokenEstimateLayered = estimatePromptTokens(input.layeredPrompt);
  return {
    inviolableFactsPresentInBoth:
      missingInviolableInFlat.length === 0 && missingInviolableInLayered.length === 0,
    missingInviolableInFlat,
    missingInviolableInLayered,
    futureLeakInPrompts: leakIn(input.flatPrompt) + leakIn(input.layeredPrompt),
    futureLeakInOutput: leakIn(generated),
    layeredDeclaresAuthorityLayers: input.layeredPrompt.includes("【层 1·硬约束"),
    flatDeclaresAuthorityLayers: input.flatPrompt.includes("【层 1·硬约束"),
    tokenEstimateFlat,
    tokenEstimateLayered,
    tokenDelta: tokenEstimateLayered - tokenEstimateFlat,
  };
}
