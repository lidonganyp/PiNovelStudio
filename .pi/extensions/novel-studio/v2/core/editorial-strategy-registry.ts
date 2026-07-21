/**
 * EditorialStrategyRegistry - stable audit labels for editorial opportunities.
 *
 * A strategy identifies why a candidate exists. It deliberately contains no
 * rewrite recipe, prose instruction, or winner rule; the model chooses the
 * concrete edit and every candidate remains subject to chapter-specific review.
 */

import type {
  EditorialHypothesis,
  EditorialOpportunityType,
} from "./editorial-hypothesis.js";
import type { CraftPhenomenonDomain } from "./craft-phenomenon-report.js";
import {
  NARRATIVE_FOCUS_STRATEGIES,
  isNarrativeFocusStrategyCompatible,
  type NarrativeFocusStrategyId,
} from "./narrative-focus-strategy.js";

export interface EditorialStrategyDef {
  strategyId: string;
  opportunityType: EditorialOpportunityType;
  compatibleOpportunityTypes?: readonly EditorialOpportunityType[];
  compatibleCraftDomains?: readonly CraftPhenomenonDomain[];
  label?: string;
  objective?: string;
  candidateOnly?: true;
}

const DEFAULT_STRATEGIES: EditorialStrategyDef[] = [
  { strategyId: "reader_payoff_strengthen", opportunityType: "reader_payoff" },
  { strategyId: "character_agency_focus", opportunityType: "character_choice" },
  { strategyId: "relationship_progress_focus", opportunityType: "relationship_progress" },
  { strategyId: "information_dramatization_focus", opportunityType: "information_dramatization" },
  { strategyId: "promise_advancement_focus", opportunityType: "promise_advancement" },
  { strategyId: "ensemble_function_focus", opportunityType: "ensemble_function" },
  { strategyId: "chapter_end_pressure_focus", opportunityType: "chapter_end_pressure" },
  { strategyId: "voice_and_naturalness_focus", opportunityType: "voice_and_naturalness" },
  ...NARRATIVE_FOCUS_STRATEGIES.map((strategy): EditorialStrategyDef => ({
    strategyId: strategy.strategyId,
    opportunityType: strategy.compatibleOpportunityTypes[0],
    compatibleOpportunityTypes: strategy.compatibleOpportunityTypes,
    compatibleCraftDomains: strategy.compatibleCraftDomains,
    label: strategy.label,
    objective: strategy.objective,
    candidateOnly: true,
  })),
];

export class EditorialStrategyRegistry {
  private readonly strategies = new Map<string, EditorialStrategyDef>();
  private readonly byOpportunity = new Map<EditorialOpportunityType, EditorialStrategyDef[]>();

  constructor(strategies: EditorialStrategyDef[] = DEFAULT_STRATEGIES) {
    for (const strategy of strategies) this.register(strategy);
  }

  register(strategy: EditorialStrategyDef): void {
    this.strategies.set(strategy.strategyId, strategy);
    const opportunityTypes = strategy.compatibleOpportunityTypes ?? [strategy.opportunityType];
    for (const opportunityType of opportunityTypes) {
      const list = this.byOpportunity.get(opportunityType) ?? [];
      list.push(strategy);
      this.byOpportunity.set(opportunityType, list);
    }
  }

  getStrategy(strategyId: string): EditorialStrategyDef | undefined {
    return this.strategies.get(strategyId);
  }

  listStrategies(): EditorialStrategyDef[] {
    return Array.from(this.strategies.values());
  }

  strategiesForOpportunity(
    opportunityType: EditorialOpportunityType,
  ): EditorialStrategyDef[] {
    return this.byOpportunity.get(opportunityType) ?? [];
  }

  pickStrategyForHypothesis(
    hypothesis: EditorialHypothesis,
  ): EditorialStrategyDef | null {
    if (hypothesis.candidateStrategyId) {
      const strategy = this.getStrategy(hypothesis.candidateStrategyId);
      if (!strategy) return null;
      return isNarrativeFocusStrategyCompatible(
        hypothesis.candidateStrategyId as NarrativeFocusStrategyId,
        hypothesis.opportunityType,
        hypothesis.craftDomain,
      ) ? strategy : null;
    }
    return this.strategiesForOpportunity(hypothesis.opportunityType)
      .find((strategy) => strategy.candidateOnly !== true) ?? null;
  }
}

export function createEditorialStrategyRegistry(): EditorialStrategyRegistry {
  return new EditorialStrategyRegistry();
}
