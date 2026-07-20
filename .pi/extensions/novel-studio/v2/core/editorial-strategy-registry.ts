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

export interface EditorialStrategyDef {
  strategyId: string;
  opportunityType: EditorialOpportunityType;
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
];

export class EditorialStrategyRegistry {
  private readonly strategies = new Map<string, EditorialStrategyDef>();
  private readonly byOpportunity = new Map<EditorialOpportunityType, EditorialStrategyDef[]>();

  constructor(strategies: EditorialStrategyDef[] = DEFAULT_STRATEGIES) {
    for (const strategy of strategies) this.register(strategy);
  }

  register(strategy: EditorialStrategyDef): void {
    this.strategies.set(strategy.strategyId, strategy);
    const list = this.byOpportunity.get(strategy.opportunityType) ?? [];
    list.push(strategy);
    this.byOpportunity.set(strategy.opportunityType, list);
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
    return this.strategiesForOpportunity(hypothesis.opportunityType)[0] ?? null;
  }
}

export function createEditorialStrategyRegistry(): EditorialStrategyRegistry {
  return new EditorialStrategyRegistry();
}
