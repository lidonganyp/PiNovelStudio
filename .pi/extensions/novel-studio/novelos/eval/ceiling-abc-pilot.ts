/**
 * NOVEL-QUALITY-CEILING A/B/C pilot helpers.
 * Generator arm construction is deliberately reference-blind; only the judge
 * message builder accepts reference text.
 */

import { CEILING_DIMENSION_IDS } from "./ceiling-judge-schema.js";
import type { SceneSolutionCard, SceneSolutionMode, SceneStateKind } from "../../v2/core/scene-solution-search.js";

export interface CeilingExperimentArm<TScene = unknown, TGene = unknown> {
  id: "A" | "B" | "C";
  label: string;
  sceneSolution?: TScene;
  craftGenes?: TGene[];
}

export interface CeilingIsolationInput {
  targetReferenceId: string;
  distillationReferenceIds: string[];
  generatorPayloads: string[];
  forbiddenGeneratorTerms: string[];
}

export interface CeilingIsolationResult {
  valid: boolean;
  errors: string[];
}

export interface CeilingPilotVerdictLike {
  dimensions: Array<{ candidate_level: number; reference_level: number }>;
  overall_candidate_level: number;
  overall_reference_level: number;
  tier_relationship: string;
  needs_human_review: boolean;
}

export interface CeilingPilotSummary {
  bestArm: "A" | "B" | "C";
  anySameTier: boolean;
  sceneSearchDelta: number;
  craftGeneDelta: number;
  referenceAdjustedSceneSearchDelta: number;
  referenceAdjustedCraftGeneDelta: number;
  armAverages: Record<"A" | "B" | "C", number>;
  referenceAverages: Record<"A" | "B" | "C", number>;
  armGaps: Record<"A" | "B" | "C", number>;
  decision:
    | "scene_search_positive_craft_genes_positive"
    | "scene_search_positive_craft_genes_neutral"
    | "scene_search_positive_craft_genes_negative"
    | "scene_search_no_positive_evidence"
    | "scene_search_negative"
    | "uncertain";
}

export interface BoundedJsonRequestInput<T = unknown> {
  request: () => Promise<string>;
  repair: (feedback: string, invalidResponse: string) => Promise<string>;
  parse?: (raw: string) => T;
}

export interface BoundedJsonRequestResult<T = unknown> {
  value: T;
  retryCount: 0 | 1;
  responses: string[];
}

export function buildCeilingExperimentArms<TScene, TGene>(
  sceneSolution: TScene,
  craftGenes: TGene[],
): Array<CeilingExperimentArm<TScene, TGene>> {
  return [
    { id: "A", label: "ordinary_production_raw" },
    { id: "B", label: "scene_solution_search_raw", sceneSolution },
    { id: "C", label: "scene_solution_search_plus_portable_craft_genes", sceneSolution, craftGenes },
  ];
}

export async function runBoundedJsonRequest<T = unknown>(
  input: BoundedJsonRequestInput<T>,
): Promise<BoundedJsonRequestResult<T>> {
  const responses: string[] = [];
  const parse = input.parse ?? ((raw: string): T => JSON.parse(raw) as T);
  const first = await input.request();
  responses.push(first);
  try {
    return { value: parse(first), retryCount: 0, responses };
  } catch (error: unknown) {
    const feedback = error instanceof Error ? error.message : String(error);
    const repaired = await input.repair(feedback, first);
    responses.push(repaired);
    try {
      return { value: parse(repaired), retryCount: 1, responses };
    } catch (repairError: unknown) {
      const reason = repairError instanceof Error ? repairError.message : String(repairError);
      throw new Error(`invalid_json_after_bounded_repair:${reason}`);
    }
  }
}

export function normalizeChineseSceneSolutionPayload(payload: unknown): SceneSolutionCard[] {
  if (!isRecord(payload) || !Array.isArray(payload.方案列表)) {
    throw new Error("invalid_chinese_scene_solution_root");
  }
  return payload.方案列表.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`invalid_chinese_scene_solution_${index}`);
    const choiceValue = firstAliasedValue(raw, ["选择", "最终选择", "方案选择"]);
    const explicitAlternatives = requireAliasedAlternativeList(raw, ["替代方案", "可选方案"], index, "替代方案");
    const branchAlternatives = recordTextEntries(choiceValue).slice(1);
    return {
      id: typeof raw.编号 === "string" && raw.编号.trim().length > 0
        ? raw.编号.trim()
        : `scene-${index + 1}`,
      mode: mapSceneMode(requireAliasedText(raw, ["模式"], index, "模式")),
      surfaceGoal: requireAliasedText(raw, ["表层目标", "目标"], index, "表层目标"),
      trueDanger: requireAliasedText(raw, ["真实危险", "真正危险", "阻力"], index, "真实危险"),
      knownFacts: requireAliasedTextArray(raw, ["已知事实", "已知信息"], index, "已知事实"),
      unknowns: requireAliasedTextArray(raw, ["未知事项", "未知信息"], index, "未知事项"),
      activeTestAction: requireAliasedText(raw, ["主动试探", "主动试探动作"], index, "主动试探"),
      alternatives: [...explicitAlternatives, ...branchAlternatives],
      choice: requireAliasedTextOrFirstRecordEntry(raw, ["选择", "最终选择", "方案选择"], index, "选择"),
      cost: requireAliasedTextArrayOrFirstRecordEntry(raw, ["代价", "选择代价"], index, "代价"),
      newRuleOrInformation: requireAliasedText(raw, ["新规则或信息", "新信息", "信息增量", "规则信息增量"], index, "新规则或信息"),
      irreversibleChange: requireAliasedTextOrArray(raw, ["不可逆变化", "场景不可逆变化"], index, "不可逆变化"),
      stateKind: mapStateKind(requireAliasedFirstText(raw, ["状态类型"], index, "状态类型")),
      endingPressure: requireAliasedText(raw, ["章末因果压力", "结尾因果压力"], index, "章末因果压力"),
      causalSource: requireAliasedText(raw, ["因果来源", "压力因果来源"], index, "因果来源"),
      nextChoice: requireAliasedTextOrArray(raw, ["下一步选择", "下章选择"], index, "下一步选择"),
      templateAvoidance: requireAliasedStringArray(raw, ["避免模板", "模板规避"], index, "避免模板"),
      sourceFactIds: [],
      openPromiseIds: [],
    };
  });
}

export function auditCeilingPilotIsolation(input: CeilingIsolationInput): CeilingIsolationResult {
  const errors: string[] = [];
  if (input.distillationReferenceIds.includes(input.targetReferenceId)) {
    errors.push("target_reference_used_for_distillation");
  }
  for (const [payloadIndex, payload] of input.generatorPayloads.entries()) {
    for (const term of input.forbiddenGeneratorTerms) {
      if (term && payload.includes(term)) {
        errors.push(`generator_reference_leak:${payloadIndex}:${term}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function buildCeilingJudgeMessages(
  candidate: string,
  reference: string,
): Array<{ role: "system" | "user"; content: string }> {
  const dimensionGuide = [
    "active_protagonist: 主角是否主动观察、试探、判断、选择并承担代价",
    "rule_information_gain: 是否产生可验证且改变选择的新规则或信息",
    "scene_state_delta: 位置、关系、资源、认知、危险或承诺是否发生不可逆变化",
    "terror_escalation: 恐怖是否沿异常证据、解释失败、规则缺口、试探代价递进",
    "dialogue_function: 对白是否承担人物、关系、信息、误导、试探或决策功能",
    "information_asymmetry: 读者、主角、配角的信息差是否制造判断压力",
    "chapter_end_causal_pressure: 章末压力是否由本章因果推出并改变下一步选择",
    "native_chinese: 中文叙述与对白是否自然、具体、无翻译腔和生成模板",
  ].join("\n");
  return [
    {
      role: "system",
      content: [
        "你是中文商业小说绝对质量裁判。参考章只用于 evaluator，不是候选章的正确答案。",
        "独立给原创候选与参考章的八个维度评 1-5 级，并为双方提供正文中的连续原文 span。",
        "不得按题材、角色、设定或剧情相似度评分，只评价可迁移叙事能力。",
        "总体关系只能是 candidate_below_reference、same_tier、candidate_above_reference、uncertain。",
        "每个维度对候选和参考各引用恰好一个最强连续 span；reason 不超过120个汉字；largest_bottlenecks 最多三项。",
        "证据不足时必须 uncertain 且 needs_human_review=true。只输出符合 JSON schema 的对象。",
        dimensionGuide,
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "【原创候选章】",
        candidate,
        "【evaluator-only 参考章】",
        reference,
        `必须完整返回这 8 个 id，顺序不限：${CEILING_DIMENSION_IDS.join(", ")}`,
      ].join("\n\n"),
    },
  ];
}

export function summarizeCeilingPilot(
  verdicts: Record<"A" | "B" | "C", CeilingPilotVerdictLike>,
): CeilingPilotSummary {
  const armAverages = {
    A: averageCandidateLevel(verdicts.A),
    B: averageCandidateLevel(verdicts.B),
    C: averageCandidateLevel(verdicts.C),
  };
  const referenceAverages = {
    A: averageReferenceLevel(verdicts.A),
    B: averageReferenceLevel(verdicts.B),
    C: averageReferenceLevel(verdicts.C),
  };
  const armGaps = {
    A: round(armAverages.A - referenceAverages.A),
    B: round(armAverages.B - referenceAverages.B),
    C: round(armAverages.C - referenceAverages.C),
  };
  const bestArm = (["A", "B", "C"] as const).reduce((best, arm) => (
    armGaps[arm] > armGaps[best] ? arm : best
  ), "A" as "A" | "B" | "C");
  const sceneSearchDelta = round(armAverages.B - armAverages.A);
  const craftGeneDelta = round(armAverages.C - armAverages.B);
  const referenceAdjustedSceneSearchDelta = round(armGaps.B - armGaps.A);
  const referenceAdjustedCraftGeneDelta = round(armGaps.C - armGaps.B);
  const uncertain = Object.values(verdicts).some((verdict) => (
    verdict.tier_relationship === "uncertain" || verdict.needs_human_review
  ));
  let decision: CeilingPilotSummary["decision"];
  if (uncertain) decision = "uncertain";
  else if (referenceAdjustedSceneSearchDelta < 0) decision = "scene_search_negative";
  else if (referenceAdjustedSceneSearchDelta === 0) decision = "scene_search_no_positive_evidence";
  else if (referenceAdjustedCraftGeneDelta > 0) decision = "scene_search_positive_craft_genes_positive";
  else if (referenceAdjustedCraftGeneDelta < 0) decision = "scene_search_positive_craft_genes_negative";
  else decision = "scene_search_positive_craft_genes_neutral";

  return {
    bestArm,
    anySameTier: Object.values(verdicts).some((verdict) => verdict.tier_relationship === "same_tier"),
    sceneSearchDelta,
    craftGeneDelta,
    referenceAdjustedSceneSearchDelta,
    referenceAdjustedCraftGeneDelta,
    armAverages,
    referenceAverages,
    armGaps,
    decision,
  };
}

function averageCandidateLevel(verdict: CeilingPilotVerdictLike): number {
  if (verdict.dimensions.length === 0) return 0;
  return round(verdict.dimensions.reduce((sum, item) => sum + item.candidate_level, 0) / verdict.dimensions.length);
}

function averageReferenceLevel(verdict: CeilingPilotVerdictLike): number {
  if (verdict.dimensions.length === 0) return 0;
  return round(verdict.dimensions.reduce((sum, item) => sum + item.reference_level, 0) / verdict.dimensions.length);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function mapSceneMode(value: string): SceneSolutionMode {
  const modes: Record<string, SceneSolutionMode> = {
    证据调查: "evidence_investigation",
    主动试探: "active_probe",
    关系代价: "relationship_cost",
  };
  const mode = modes[value];
  if (!mode) throw new Error(`invalid_chinese_scene_mode:${value}`);
  return mode;
}

function mapStateKind(value: string): SceneStateKind {
  const kinds: Record<string, SceneStateKind> = {
    位置: "position",
    关系: "relationship",
    资源: "resource",
    认知: "knowledge",
    危险: "danger",
    承诺: "promise",
    能力边界: "ability_boundary",
  };
  const kind = kinds[value];
  if (!kind) throw new Error(`invalid_chinese_state_kind:${value}`);
  return kind;
}

function requireText(value: unknown, index: number, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`invalid_chinese_scene_solution_${index}:${field}`);
  }
  return value.trim();
}

function requireTextArray(value: unknown, index: number, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`invalid_chinese_scene_solution_${index}:${field}`);
  }
  return value.map((item) => String(item).trim());
}

function requireAliasedText(
  record: Record<string, unknown>,
  aliases: string[],
  index: number,
  field: string,
): string {
  for (const alias of aliases) {
    const value = record[alias];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return requireText(undefined, index, field);
}

function requireAliasedTextArray(
  record: Record<string, unknown>,
  aliases: string[],
  index: number,
  field: string,
): string[] {
  for (const alias of aliases) {
    const value = record[alias];
    if (Array.isArray(value) && value.length > 0) return requireTextArray(value, index, field);
  }
  return requireTextArray(undefined, index, field);
}

function requireAliasedAlternativeList(
  record: Record<string, unknown>,
  aliases: string[],
  index: number,
  field: string,
): string[] {
  const value = firstAliasedValue(record, aliases);
  if (Array.isArray(value)) return requireTextArray(value, index, field);
  const entries = recordTextEntries(value);
  if (entries.length >= 2 && entries.length <= 5) return entries;
  return requireTextArray(undefined, index, field);
}

function requireAliasedTextOrFirstRecordEntry(
  record: Record<string, unknown>,
  aliases: string[],
  index: number,
  field: string,
): string {
  const value = firstAliasedValue(record, aliases);
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  const entries = recordTextEntries(value);
  if (entries.length > 0) return entries[0];
  return requireText(undefined, index, field);
}

function requireAliasedTextArrayOrFirstRecordEntry(
  record: Record<string, unknown>,
  aliases: string[],
  index: number,
  field: string,
): string {
  const value = firstAliasedValue(record, aliases);
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (Array.isArray(value) && value.length > 0) {
    return requireTextArray(value, index, field).join("；");
  }
  const entries = recordTextEntries(value);
  if (entries.length > 0) return entries[0];
  return requireText(undefined, index, field);
}

function requireAliasedTextOrArray(
  record: Record<string, unknown>,
  aliases: string[],
  index: number,
  field: string,
): string {
  const value = firstAliasedValue(record, aliases);
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (Array.isArray(value) && value.length > 0) {
    return requireTextArray(value, index, field).join("；");
  }
  return requireText(undefined, index, field);
}

function requireAliasedFirstText(
  record: Record<string, unknown>,
  aliases: string[],
  index: number,
  field: string,
): string {
  const value = firstAliasedValue(record, aliases);
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (Array.isArray(value) && value.length > 0) return requireText(value[0], index, field);
  return requireText(undefined, index, field);
}

function requireAliasedStringArray(
  record: Record<string, unknown>,
  aliases: string[],
  index: number,
  field: string,
): string[] {
  const value = firstAliasedValue(record, aliases);
  if (typeof value === "string" && value.trim().length > 0) return [value.trim()];
  return requireTextArray(value, index, field);
}

function firstAliasedValue(record: Record<string, unknown>, aliases: string[]): unknown {
  for (const alias of aliases) if (record[alias] !== undefined) return record[alias];
  return undefined;
}

function recordTextEntries(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([, item]) => typeof item === "string" && item.trim().length > 0)
    .map(([key, item]) => `${key}：${String(item).trim()}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
