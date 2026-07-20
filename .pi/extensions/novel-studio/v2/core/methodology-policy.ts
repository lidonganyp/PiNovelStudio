/**
 * MethodologyPolicy - keeps story knowledge separate from prose execution.
 *
 * The methodology may shape author intent, candidate strategies, and review,
 * but only author-owned story context and established facts may reach raw.
 */

export type MethodologyAuthority = "author" | "accepted_text" | "methodology" | "heuristic";
export type MethodologyRole = "fact" | "intent" | "strategy" | "diagnostic";
export type MethodologyEnforcement =
  | "hard_boundary"
  | "generation_context"
  | "candidate_only"
  | "review_only"
  | "excluded_from_raw";

export interface MethodologyRule {
  id: string;
  source: string;
  authority: MethodologyAuthority;
  role: MethodologyRole;
  enforcement: MethodologyEnforcement;
  runtimeFields: string[];
}

export interface MethodologyRuleApplication extends MethodologyRule {
  matchedFields: string[];
  consumedByRawPrompt: boolean;
}

export interface MethodologyApplicationReport {
  policyVersion: "1.0";
  rules: MethodologyRuleApplication[];
  violations: string[];
}

const RULES: MethodologyRule[] = [
  {
    id: "author_story_contract",
    source: "author chapter outline and story direction",
    authority: "author",
    role: "intent",
    enforcement: "generation_context",
    runtimeFields: [
      "overallPlotDirection", "chapterFunction", "previousState", "relevantCharacters",
      "characterMotivations", "authorEventSummaries", "authorMustInclude",
      "authorStateChanges", "foreshadowing", "causalRelations", "endingTarget",
    ],
  },
  {
    id: "established_story_state",
    source: "accepted text and validated narrative state",
    authority: "accepted_text",
    role: "fact",
    enforcement: "hard_boundary",
    runtimeFields: [
      "inviolableFacts", "factAndCharacterKnowledgeForbiddenZones",
      "identityContract", "ontologyContract",
    ],
  },
  {
    id: "creative_constitution",
    source: "author creative constitution",
    authority: "author",
    role: "intent",
    enforcement: "generation_context",
    runtimeFields: [
      "constitution.workIdentity", "constitution.readerPromise", "constitution.genrePromises",
      "constitution.protagonistCoreConflict", "constitution.thematicQuestions",
      "constitution.forbiddenDrift",
    ],
  },
  {
    id: "scene_solution_strategy",
    source: "methodology scene-solution hypothesis",
    authority: "methodology",
    role: "strategy",
    enforcement: "candidate_only",
    runtimeFields: ["sceneSolution"],
  },
  {
    id: "craft_strategy_hypotheses",
    source: "validated or experimental craft strategies",
    authority: "methodology",
    role: "strategy",
    enforcement: "candidate_only",
    runtimeFields: ["craftGenes", "promptPatterns"],
  },
  {
    id: "craft_diagnostics",
    source: "methodology review and evidence scanners",
    authority: "methodology",
    role: "diagnostic",
    enforcement: "review_only",
    runtimeFields: [
      "promiseContext", "expectationContext", "genreContract", "dialogueCraft",
      "emotionRhythm", "supportingFunction", "knowledgeConsumption",
      "characterVoiceContext", "worldPresentationContext", "ensembleLayeringContext",
      "craftPhenomenonReport",
    ],
  },
  {
    id: "prose_execution_heuristics",
    source: "sensory, sentence, dialogue, paragraph, and style heuristics",
    authority: "heuristic",
    role: "strategy",
    enforcement: "excluded_from_raw",
    runtimeFields: [
      "candidateAnchors", "aestheticDirection", "voiceFingerprint",
      "styleFingerprint", "proseTemplate",
    ],
  },
];

/** Build a traceable report and identify any raw-prompt authority violation. */
export function compileMethodologyApplicationReport(
  consumedFields: ReadonlyArray<string>,
): MethodologyApplicationReport {
  const consumed = new Set(consumedFields);
  const rules = RULES.map((rule): MethodologyRuleApplication => {
    const matchedFields = rule.runtimeFields.filter((field) => consumed.has(field));
    return {
      ...rule,
      runtimeFields: [...rule.runtimeFields],
      matchedFields,
      consumedByRawPrompt: matchedFields.length > 0,
    };
  });
  const violations = rules
    .filter((rule) => rule.consumedByRawPrompt && (
      rule.enforcement === "candidate_only"
      || rule.enforcement === "review_only"
      || rule.enforcement === "excluded_from_raw"
    ))
    .map((rule) => `${rule.id}:${rule.matchedFields.join(",")}`);

  return { policyVersion: "1.0", rules, violations };
}
