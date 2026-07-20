/**
 * SCENE-SOLUTION-SEARCH-1: evaluator-safe scene solution cards.
 *
 * The search phase proposes short structural alternatives before prose. It
 * never writes chapter text and it is opt-in; callers can fall back to raw
 * generation when cards fail local fact/open-promise checks.
 */

export type SceneSolutionMode = "evidence_investigation" | "active_probe" | "relationship_cost";
export type SceneStateKind =
  | "position"
  | "relationship"
  | "resource"
  | "knowledge"
  | "danger"
  | "promise"
  | "ability_boundary";

export interface SceneSolutionCard {
  id: string;
  mode: SceneSolutionMode;
  surfaceGoal: string;
  trueDanger: string;
  knownFacts: string[];
  unknowns: string[];
  activeTestAction: string;
  alternatives: string[];
  choice: string;
  cost: string;
  newRuleOrInformation: string;
  irreversibleChange: string;
  stateKind: SceneStateKind;
  endingPressure: string;
  causalSource: string;
  nextChoice: string;
  templateAvoidance: string[];
  sourceFactIds: string[];
  openPromiseIds: string[];
}

export interface SceneSolutionSearchInput {
  sceneId: string;
  existingFactIds: string[];
  openPromiseIds: string[];
  cards: SceneSolutionCard[];
  maxCards?: number;
}

export interface SceneSolutionValidation {
  valid: boolean;
  errors: string[];
}

export interface SceneSolutionSearchResult {
  status: "selected" | "fallback_raw";
  selected: SceneSolutionCard | null;
  candidates: SceneSolutionCard[];
  validation: Record<string, SceneSolutionValidation>;
  fallbackReason?: string;
}

export function validateSceneSolutionCard(card: SceneSolutionCard, input: Pick<SceneSolutionSearchInput, "existingFactIds" | "openPromiseIds">): SceneSolutionValidation {
  const errors: string[] = [];
  const required: Array<keyof SceneSolutionCard> = ["id"];
  for (const key of required) if (typeof card[key] !== "string" || String(card[key]).trim() === "") errors.push(`missing:${key}`);
  if (!Array.isArray(card.knownFacts) || !Array.isArray(card.unknowns) || !Array.isArray(card.alternatives) || !Array.isArray(card.templateAvoidance)) errors.push("invalid:arrays");
  if (!Array.isArray(card.sourceFactIds) || card.sourceFactIds.some((id) => !input.existingFactIds.includes(id))) errors.push("unknown:sourceFactId");
  if (!Array.isArray(card.openPromiseIds) || card.openPromiseIds.some((id) => !input.openPromiseIds.includes(id))) errors.push("unknown:openPromiseId");
  return { valid: errors.length === 0, errors };
}

export function searchSceneSolutions(input: SceneSolutionSearchInput): SceneSolutionSearchResult {
  const validation: Record<string, SceneSolutionValidation> = {};
  const valid = input.cards.filter((card) => {
    const result = validateSceneSolutionCard(card, input);
    validation[card.id] = result;
    return result.valid;
  });
  const maxCards = input.maxCards ?? 3;
  const candidates = valid.slice(0, Math.max(1, Math.min(3, maxCards)));
  if (candidates.length === 0) {
    return { status: "fallback_raw", selected: null, candidates: [], validation, fallbackReason: "no_valid_scene_solution" };
  }
  if (candidates.length > 1) {
    return { status: "fallback_raw", selected: null, candidates, validation, fallbackReason: "multiple_solutions_require_chapter_specific_selection" };
  }
  return { status: "selected", selected: candidates[0], candidates, validation };
}

export function renderSceneSolutionPrompt(card: SceneSolutionCard): string {
  return [
    "【退休的场景方案实验元数据：不得注入生产 raw】",
    `方案编号：${card.id}`,
    `来源事实：${card.sourceFactIds.join(" / ") || "无"}`,
    `关联承诺：${card.openPromiseIds.join(" / ") || "无"}`,
  ].join("\n");
}
