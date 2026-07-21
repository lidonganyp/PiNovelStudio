/**
 * NarrativeFocusStrategy - candidate-only spatial narrative methodology.
 *
 * These strategies are high-level editorial hypotheses, not prose templates.
 * They require a separately admitted, span-backed EditorialHypothesis and
 * never authorize a candidate or enter the raw prompt by themselves.
 */

import type { CraftPhenomenonDomain } from "./craft-phenomenon-report.js";
import type { EditorialOpportunityType } from "./editorial-hypothesis.js";

export const NARRATIVE_FOCUS_STRATEGY_IDS = [
  "transition_compression",
  "spatial_relationship_staging",
  "focal_attention_shift",
] as const;

export type NarrativeFocusStrategyId = typeof NARRATIVE_FOCUS_STRATEGY_IDS[number];

export interface NarrativeFocusStrategyDefinition {
  strategyId: NarrativeFocusStrategyId;
  label: string;
  objective: string;
  compatibleOpportunityTypes: readonly EditorialOpportunityType[];
  compatibleCraftDomains: readonly CraftPhenomenonDomain[];
  candidateOnly: true;
}

export const NARRATIVE_FOCUS_STRATEGIES: readonly NarrativeFocusStrategyDefinition[] = [
  {
    strategyId: "transition_compression",
    label: "过渡压缩",
    objective: "仅处理证据 span 覆盖的低收益过渡，尝试用省略或对比并置强化时间、处境或因果变化；不得省略关键选择、代价与连续性事实。",
    compatibleOpportunityTypes: ["information_dramatization", "reader_payoff"],
    compatibleCraftDomains: ["rhythm_and_climax", "chapter_progression"],
    candidateOnly: true,
  },
  {
    strategyId: "spatial_relationship_staging",
    label: "空间关系调度",
    objective: "仅围绕证据 span，尝试让已有场景中的距离、遮挡、进出路径或物件位置承载既有关系、权力或选择变化；不得新增故事事实。",
    compatibleOpportunityTypes: ["relationship_progress", "character_choice", "ensemble_function"],
    compatibleCraftDomains: ["narrative_focus_and_spatial_staging"],
    candidateOnly: true,
  },
  {
    strategyId: "focal_attention_shift",
    label: "焦点转移",
    objective: "仅围绕证据 span，尝试把概括说明转移到一个与本章因果相关的动作、声音或物件细节；不得为画面感堆砌无因果作用的感官装饰。",
    compatibleOpportunityTypes: ["reader_payoff", "information_dramatization"],
    compatibleCraftDomains: [
      "narrative_focus_and_spatial_staging",
      "world_revelation",
      "ending_and_closure",
    ],
    candidateOnly: true,
  },
] as const;

const STRATEGY_BY_ID = new Map<NarrativeFocusStrategyId, NarrativeFocusStrategyDefinition>(
  NARRATIVE_FOCUS_STRATEGIES.map((strategy) => [strategy.strategyId, strategy]),
);

const STRATEGY_LABEL_TO_ID = new Map<string, NarrativeFocusStrategyId>([
  ...NARRATIVE_FOCUS_STRATEGIES.map((strategy): [string, NarrativeFocusStrategyId] => [
    strategy.label,
    strategy.strategyId,
  ]),
  ...NARRATIVE_FOCUS_STRATEGIES.map((strategy): [string, NarrativeFocusStrategyId] => [
    strategy.strategyId,
    strategy.strategyId,
  ]),
]);

export function parseNarrativeFocusStrategyId(value: string): NarrativeFocusStrategyId | null {
  return STRATEGY_LABEL_TO_ID.get(value.trim()) ?? null;
}

export function getNarrativeFocusStrategy(
  strategyId: NarrativeFocusStrategyId,
): NarrativeFocusStrategyDefinition | null {
  return STRATEGY_BY_ID.get(strategyId) ?? null;
}

export function isNarrativeFocusStrategyCompatible(
  strategyId: NarrativeFocusStrategyId,
  opportunityType: EditorialOpportunityType,
  craftDomain: CraftPhenomenonDomain | undefined,
): boolean {
  const strategy = getNarrativeFocusStrategy(strategyId);
  if (!strategy || !craftDomain) return false;
  return strategy.compatibleOpportunityTypes.includes(opportunityType)
    && strategy.compatibleCraftDomains.includes(craftDomain);
}

