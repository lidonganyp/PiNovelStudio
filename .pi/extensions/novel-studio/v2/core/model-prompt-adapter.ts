/**
 * ModelPromptAdapter - model-specific expression over one narrative contract.
 *
 * The adapter may reorder and phrase the task for a model family, but it must
 * not change chapter facts, choices, costs, state changes, or ending pressure.
 * Sampling remains owned by config/model-routing.json.
 */

import type { UnifiedOrchestratorInput } from "./orchestrator-types.js";

export type WriterPromptProfile =
  | "generic_writer_v1"
  | "claude_writer_v1"
  | "gpt_writer_v1"
  | "chinese_writer_v1"
  | "gemini_writer_v1"
  | "gemini_writer_v2"
  | "gemini_writer_v2_layered";

export interface ChapterContract {
  workIdentity: string[];
  readerPromises: string[];
  genrePromises: string[];
  protagonistCoreConflict: string[];
  thematicQuestions: string[];
  forbiddenDrift: string[];
  overallPlotDirection: string[];
  chapterFunction: string[];
  readerExperience: string[];
  currentPressure: string[];
  previousState: string[];
  relevantCharacters: string[];
  relevantCharacterStates: string[];
  historicalContinuity: string[];
  historicalCharacterState: string[];
  recentPatternMemory: string[];
  characterMotivations: string[];
  focusCharacterGoals: string[];
  resistance: string[];
  choicesAndCosts: string[];
  expectedIrreversibleChange: string[];
  selectedPromisesToAdvance: string[];
  selectedExpectationsToAdvance: string[];
  causalEndPressure: string[];
  eventSummaries: string[];
  mustInclude: string[];
  stateChanges: string[];
  foreshadowing: string[];
  causalRelations: string[];
  endingTarget: string[];
  inviolableFacts: string[];
  stateConstraints: string[];
  wordCountTarget?: { min: number; max: number };
  forbidReferenceLeakage: true;
  preserveEstablishedState: true;
}

export interface WriterPromptRuntimePolicy {
  samplingSource: "model-routing";
  structuredOutput: false;
  outputProtocol: "chapter_prose_only";
  allowMultipleCandidates: false;
  editScope: "chapter";
  retryStrategy: "empty_output_only";
}

export interface AdaptedWriterPrompt {
  profile: WriterPromptProfile;
  systemPrompt: string;
  userPrompt: string;
  chapterContract: ChapterContract;
  runtimePolicy: WriterPromptRuntimePolicy;
}

export interface WriterPromptAdapterInput {
  profile: WriterPromptProfile;
  chapterNumber: number;
  contract: ChapterContract;
  sharedContext: string;
}

const RUNTIME_POLICY: WriterPromptRuntimePolicy = Object.freeze({
  samplingSource: "model-routing",
  structuredOutput: false,
  outputProtocol: "chapter_prose_only",
  allowMultipleCandidates: false,
  editScope: "chapter",
  retryStrategy: "empty_output_only",
});

function compact(values: ReadonlyArray<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function isMechanicalOrOperationalDirective(value: string): boolean {
  return /(?:感知锚点|对白比例|句式|段落|标点|感叹号|句号|短句|长句|比喻|修辞|视角|镜头|章纲|CONTRACT|AI\s*生成|用户重写|阻断级|写作约束|抒情陈词|声明.{0,3}执行|五步链路|蓄水.{0,8}爆发|至少出三件|语言精英化|网文常见词)/iu.test(value);
}

function narrativeConstitutionValues(values: ReadonlyArray<string | undefined>): string[] {
  return compact(values).filter((value) => !isMechanicalOrOperationalDirective(value));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? compact(value.filter((entry): entry is string => typeof entry === "string"))
    : [];
}

function clip(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function buildRelevantCharacterStates(input: UnifiedOrchestratorInput): string[] {
  const selectedNames = new Set(compact([
    ...(input.intent.relevantCharacters ?? []),
    ...(input.intent.focusCharacterGoals ?? []).map((entry) => entry.character),
  ]));
  if (selectedNames.size === 0) return [];

  const entries: string[] = [];
  let remainingBudget = 3200;
  for (const character of input.context.characterStates ?? []) {
    const aliases = stringArray(character.state?.aliases);
    if (!selectedNames.has(character.name) && !aliases.some((alias) => selectedNames.has(alias))) continue;

    const profile = character.state?.narrativeProfile;
    const narrativeProfile = profile && typeof profile === "object"
      ? profile as Record<string, unknown>
      : {};
    const details = compact([
      typeof character.state?.role === "string" ? `身份：${character.state.role}` : undefined,
      typeof character.state?.mentality === "string" ? `当前心态：${character.state.mentality}` : undefined,
      typeof character.state?.recentAction === "string" ? `近期行动：${character.state.recentAction}` : undefined,
      typeof character.state?.pendingTension === "string" ? `未解张力：${character.state.pendingTension}` : undefined,
      ...stringArray(narrativeProfile.personality).map((value) => `性格：${value}`),
      ...stringArray(narrativeProfile.desires).map((value) => `欲望：${value}`),
      ...stringArray(narrativeProfile.fears).map((value) => `恐惧：${value}`),
      ...stringArray(narrativeProfile.decisionLogic).map((value) => `决策逻辑：${value}`),
      ...stringArray(narrativeProfile.voice).map((value) => `表达特征：${value}`),
      ...stringArray(narrativeProfile.relationships).map((value) => `关系：${value}`),
      ...stringArray(narrativeProfile.knowledgeBoundaries).map((value) => `知识边界：${value}`),
      ...stringArray(narrativeProfile.capabilityCosts).map((value) => `能力限制与代价：${value}`),
      ...stringArray(narrativeProfile.unfinishedChoices).map((value) => `未完成选择：${value}`),
      ...stringArray(narrativeProfile.establishedHistory).map((value) => `已发生事件：${value}`),
      ...stringArray(narrativeProfile.boundaries).map((value) => `人物边界：${value}`),
    ]);
    if (details.length === 0) continue;
    const rendered = clip(`${character.name}｜${details.join("；")}`, Math.min(900, remainingBudget));
    if (!rendered || remainingBudget <= 0) break;
    entries.push(rendered);
    remainingBudget -= rendered.length;
  }
  return entries;
}

function boundedEntries(values: ReadonlyArray<string>, maxEntries: number, maxChars: number): string[] {
  const entries: string[] = [];
  let remaining = maxChars;
  for (const value of compact(values).slice(0, maxEntries)) {
    if (remaining <= 0) break;
    const rendered = clip(value, remaining);
    if (!rendered) continue;
    entries.push(rendered);
    remaining -= rendered.length;
  }
  return entries;
}

function chapterNumber(value: string): number {
  const match = value.match(/(\d+)/u);
  return match ? Number(match[1]) : 0;
}

/**
 * Phase 6.1 eval-only：历史上下文注入的压缩覆盖参数。
 *
 * 生产默认不传（undefined），保持当前生产行为（canon 4×2400、character 6×1800、
 * pattern 4×1000）。eval 压缩研究通过 overrides 在走生产 buildHistoricalContext
 * 注入路径的前提下调整各状态类别的条目上限 / 字符预算 / 是否注入。
 * schemaTokenCost 与状态注入正交，不随 overrides 变化。
 */
export interface HistoricalContextOverrides {
  /** CanonState/historicalContinuity 覆盖 */
  canon?: { maxEntries?: number; maxChars?: number; inject?: boolean };
  /** CharacterState/historicalCharacterState 覆盖 */
  character?: { maxEntries?: number; maxChars?: number; inject?: boolean };
  /** PatternMemory/recentPatternMemory 覆盖（B 方案排除） */
  pattern?: { maxEntries?: number; maxChars?: number; inject?: boolean };
}

export function buildHistoricalContext(
  input: UnifiedOrchestratorInput,
  overrides?: HistoricalContextOverrides,
): Pick<
  ChapterContract,
  "historicalContinuity" | "historicalCharacterState" | "recentPatternMemory"
> {
  const state = input.context.longTermState;
  if (!state) {
    return { historicalContinuity: [], historicalCharacterState: [], recentPatternMemory: [] };
  }
  const relevantNames = new Set(compact([
    ...(input.intent.relevantCharacters ?? []),
    ...(input.intent.focusCharacterGoals ?? []).map((entry) => entry.character),
  ]));
  const newestFirst = <T extends { sourceChapter: string }>(entries: ReadonlyArray<T>): T[] =>
    [...entries].sort((left, right) => chapterNumber(right.sourceChapter) - chapterNumber(left.sourceChapter));

  const canonCfg = overrides?.canon ?? {};
  const characterCfg = overrides?.character ?? {};
  const patternCfg = overrides?.pattern ?? {};

  return {
    historicalContinuity:
      canonCfg.inject === false
        ? []
        : boundedEntries(
            newestFirst(state.canon).map((entry) => `${entry.sourceChapter}｜${entry.fact}`),
            canonCfg.maxEntries ?? 4,
            canonCfg.maxChars ?? 2400,
          ),
    historicalCharacterState:
      characterCfg.inject === false
        ? []
        : boundedEntries(
            newestFirst(state.character)
              .filter((entry) => relevantNames.has(entry.characterId))
              .map((entry) => `${entry.sourceChapter}｜${entry.characterId}.${entry.field}：${entry.value}`),
            characterCfg.maxEntries ?? 6,
            characterCfg.maxChars ?? 1800,
          ),
    recentPatternMemory:
      patternCfg.inject === false
        ? []
        : boundedEntries(
            newestFirst(state.pattern).map((entry) =>
              `${entry.sourceChapter}｜${entry.patternType}：${entry.description}（累计 ${entry.occurrenceCount} 次）`),
            patternCfg.maxEntries ?? 4,
            patternCfg.maxChars ?? 1000,
          ),
  };
}

/** Compile the model-independent narrative requirements for one chapter. */
export function buildChapterContract(input: UnifiedOrchestratorInput): ChapterContract {
  const contextFacts = (input.context.facts ?? [])
    .filter((fact) => fact.kind === "fact")
    .map((fact) => fact.content);
  const forbiddenDrift = narrativeConstitutionValues(input.constitution?.forbiddenDrift ?? []);
  const inviolableFacts = compact([
    ...(input.intent.inviolableFacts ?? []),
    ...contextFacts,
  ]).filter((fact) => !forbiddenDrift.includes(fact) && !isMechanicalOrOperationalDirective(fact));
  const historicalContext = buildHistoricalContext(input);

  return {
    workIdentity: compact([input.constitution?.workIdentity]),
    readerPromises: narrativeConstitutionValues(input.constitution?.readerPromise ?? []),
    genrePromises: narrativeConstitutionValues(input.constitution?.genrePromises ?? []),
    protagonistCoreConflict: compact([input.constitution?.protagonistCoreConflict]),
    thematicQuestions: narrativeConstitutionValues(input.constitution?.thematicQuestions ?? []),
    forbiddenDrift,
    overallPlotDirection: compact(input.intent.overallPlotDirection ?? []),
    chapterFunction: compact([input.intent.chapterFunction]),
    readerExperience: compact(input.intent.readerExperience ?? []),
    currentPressure: compact(input.intent.currentPressure ?? []),
    previousState: compact(input.intent.previousState ?? []),
    relevantCharacters: compact(input.intent.relevantCharacters ?? []),
    relevantCharacterStates: buildRelevantCharacterStates(input),
    ...historicalContext,
    characterMotivations: compact((input.intent.characterMotivations ?? []).map((entry) => `${entry.character}：${entry.motivation}`)),
    focusCharacterGoals: compact((input.intent.focusCharacterGoals ?? []).map((entry) => `${entry.character}：${entry.goal}`)),
    resistance: compact(input.intent.resistance ?? []),
    choicesAndCosts: compact((input.intent.choicesAndCosts ?? []).map((entry) => `${entry.choice}（代价：${entry.cost}）`)),
    expectedIrreversibleChange: compact(input.intent.expectedIrreversibleChange ?? []),
    selectedPromisesToAdvance: compact((input.intent.selectedPromisesToAdvance ?? []).map((entry) => `${entry.promiseId}：${entry.description}`)),
    selectedExpectationsToAdvance: compact((input.intent.selectedExpectationsToAdvance ?? []).map((entry) =>
      `${entry.expectationId}：${entry.description}${entry.targetReaderExperience ? `（目标体验：${entry.targetReaderExperience}）` : ""}`)),
    causalEndPressure: compact(input.intent.causalEndPressure ?? []),
    eventSummaries: compact(input.intent.authorEventSummaries ?? []),
    mustInclude: compact(input.intent.authorMustInclude ?? []),
    stateChanges: compact(input.intent.authorStateChanges ?? []),
    foreshadowing: compact(input.intent.foreshadowing ?? []),
    causalRelations: compact(input.intent.causalRelations ?? []),
    endingTarget: compact(input.intent.endingTarget ?? []),
    inviolableFacts,
    stateConstraints: compact(input.intent.factAndCharacterKnowledgeForbiddenZones ?? [])
      .filter((value) => !isMechanicalOrOperationalDirective(value)),
    wordCountTarget: { min: 2000, max: 3000 },
    forbidReferenceLeakage: true,
    preserveEstablishedState: true,
  };
}

export function resolveWriterPromptProfile(input: {
  route?: string;
  provider?: string;
  model?: string;
}): WriterPromptProfile {
  const fingerprint = [input.provider, input.model, input.route]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/gemini/.test(fingerprint)) return "gemini_writer_v2";
  if (/claude|anthropic|fable/.test(fingerprint)) return "claude_writer_v1";
  if (/doubao|qwen|ernie|glm|deepseek/.test(fingerprint)) return "chinese_writer_v1";
  if (/gpt|openai|grok/.test(fingerprint)) return "gpt_writer_v1";
  if (input.route === "v2_rawstage2") return "claude_writer_v1";

  throw new Error(`无法为生成模型解析 prompt profile：${fingerprint || "missing model identity"}`);
}

function renderList(label: string, values: string[]): string {
  return values.length > 0 ? `${label}：${values.join("；")}` : "";
}

/**
 * P0-2 修复（NOVELOS-CONSTRAINT-RELAXATION-1 验收修复）：
 * 导出 renderContract 供 Agentic raw candidate source 消费完整 ChapterContract。
 *
 * 原先 Agentic source 用自定义字符串拼接替代 renderContract，遗漏了
 * characterMotivations / focusCharacterGoals / resistance / choicesAndCosts /
 * expectedIrreversibleChange / selectedExpectationsToAdvance / causalRelations 等
 * canonical contract 字段。现在统一通过 renderContract 渲染，确保所有 canonical
 * 字段进入 Agentic 输入。
 *
 * 同时：风格指纹不再由 raw 阶段注入（renderContract 不渲染 styleReferences），
 * 符合计划"风格指纹不得作为 raw 正文执行指令"的规则。
 */
export function renderContract(contract: ChapterContract): string {
  return [
    "【本章叙事契约：所有模型共用，不得改写其事实含义】",
    renderList("作品身份", contract.workIdentity),
    renderList("长期读者承诺", contract.readerPromises),
    renderList("类型承诺", contract.genrePromises),
    renderList("主角核心冲突", contract.protagonistCoreConflict),
    renderList("长期主题问题", contract.thematicQuestions),
    renderList("禁止偏离", contract.forbiddenDrift),
    renderList("整体剧情方向", contract.overallPlotDirection),
    renderList("本章功能", contract.chapterFunction),
    renderList("目标读者体验", contract.readerExperience),
    renderList("当前压力", contract.currentPressure),
    renderList("前文状态", contract.previousState),
    renderList("本章相关角色", contract.relevantCharacters),
    renderList("相关人物状态", contract.relevantCharacterStates),
    renderList("已接受正文中的历史连续性", contract.historicalContinuity),
    renderList("相关人物的历史状态", contract.historicalCharacterState),
    renderList("近期已出现的叙事模式", contract.recentPatternMemory),
    renderList("人物动机", contract.characterMotivations),
    renderList("焦点角色目标", contract.focusCharacterGoals),
    renderList("本章阻力", contract.resistance),
    renderList("选择与代价", contract.choicesAndCosts),
    renderList("预期不可逆变化", contract.expectedIrreversibleChange),
    renderList("本章选中承诺", contract.selectedPromisesToAdvance),
    renderList("本章选中读者期待", contract.selectedExpectationsToAdvance),
    renderList("因果章末压力", contract.causalEndPressure),
    renderList("事件内容", contract.eventSummaries),
    renderList("必须包含", contract.mustInclude),
    renderList("状态变化", contract.stateChanges),
    renderList("伏笔与承诺", contract.foreshadowing),
    renderList("因果关系", contract.causalRelations),
    renderList("章末目标", contract.endingTarget),
    renderList("不可违背事实", contract.inviolableFacts),
    renderList("人物知识与状态禁区", contract.stateConstraints),
    "禁止泄漏、复述或仿写参考文本；禁止改变既定人物与世界状态。",
  ].filter(Boolean).join("\n");
}

/**
 * CONTRACT-LAYERING-ABLATION-1: 分层渲染 ChapterContract。
 *
 * 与 renderContract（平铺）相同的字段内容，但明确分为四层权威级别：
 *   1. 硬约束层（硬事实：不可违背，违反即阻断）
 *   2. 叙事目标层（章节义务：本章要达成的功能、体验与必须包含的结构性要素）
 *   3. 历史证据层（按需参考，非强制消费）
 *   4. 模型决策空间层（表达决策：创作指引，可自行决定表达方式）
 *
 * 假设 H1：明确权威层级后，模型会更少机械执行清单，同时保持事实安全和章节功能。
 * 实验路径：evalMode=B3 + evalPromptProfile=gemini_writer_v2_layered，与 gemini_writer_v2 对照。
 * 生产路径不使用此渲染（生产用 renderContract 平铺）；仅 eval 隔离评测使用。
 */
export function renderLayeredContract(contract: ChapterContract): string {
  const layers: string[] = [];

  // ── 层 1：硬约束层（不可违背）──
  const hardConstraints: string[] = [];
  hardConstraints.push(...(contract.inviolableFacts ?? []).map((v) => `  - ${v}`));
  hardConstraints.push(...(contract.stateConstraints ?? []).map((v) => `  - ${v}`));
  hardConstraints.push(...(contract.forbiddenDrift ?? []).map((v) => `  - ${v}`));
  hardConstraints.push("  - 禁止泄漏、复述或仿写参考文本");
  hardConstraints.push("  - 禁止改变既定人物与世界状态");
  if (hardConstraints.length > 2) {
    layers.push([
      "【层 1·硬约束｜违反即阻断，不得变通】",
      "以下为不可违背的事实与边界，任何表达都不得与之冲突：",
      ...hardConstraints,
    ].join("\n"));
  }

  // ── 层 2：叙事目标层（本章要达成什么）──
  const narrativeGoals: string[] = [];
  if (contract.workIdentity?.length) narrativeGoals.push(`  - 作品身份：${contract.workIdentity.join("；")}`);
  if (contract.readerPromises?.length) narrativeGoals.push(`  - 长期读者承诺：${contract.readerPromises.join("；")}`);
  if (contract.genrePromises?.length) narrativeGoals.push(`  - 类型承诺：${contract.genrePromises.join("；")}`);
  if (contract.protagonistCoreConflict?.length) narrativeGoals.push(`  - 主角核心冲突：${contract.protagonistCoreConflict.join("；")}`);
  if (contract.thematicQuestions?.length) narrativeGoals.push(`  - 长期主题问题：${contract.thematicQuestions.join("；")}`);
  if (contract.overallPlotDirection?.length) narrativeGoals.push(`  - 整体剧情方向：${contract.overallPlotDirection.join("；")}`);
  if (contract.chapterFunction?.length) narrativeGoals.push(`  - 本章功能：${contract.chapterFunction.join("；")}`);
  if (contract.readerExperience?.length) narrativeGoals.push(`  - 目标读者体验：${contract.readerExperience.join("；")}`);
  if (contract.endingTarget?.length) narrativeGoals.push(`  - 章末目标：${contract.endingTarget.join("；")}`);
  // 章节义务字段：作者明确要求本章必须包含的事件、元素、状态变化、伏笔与因果，
  // 违反即章节功能缺失，属于义务而非模型可自由决定的表达方式。
  if (contract.eventSummaries?.length) narrativeGoals.push(`  - 事件内容：${contract.eventSummaries.join("；")}`);
  if (contract.mustInclude?.length) narrativeGoals.push(`  - 必须包含：${contract.mustInclude.join("；")}`);
  if (contract.stateChanges?.length) narrativeGoals.push(`  - 状态变化：${contract.stateChanges.join("；")}`);
  if (contract.foreshadowing?.length) narrativeGoals.push(`  - 伏笔与承诺：${contract.foreshadowing.join("；")}`);
  if (contract.causalRelations?.length) narrativeGoals.push(`  - 因果关系：${contract.causalRelations.join("；")}`);
  if (narrativeGoals.length > 0) {
    layers.push([
      "【层 2·叙事目标｜本章必须达成的功能与体验】",
      "以下定义本章在长篇结构中的功能位置与目标读者体验：",
      ...narrativeGoals,
    ].join("\n"));
  }

  // ── 层 3：历史证据层（按需参考，非强制消费）──
  const evidence: string[] = [];
  if (contract.historicalContinuity?.length) evidence.push(`  - 历史连续性：${contract.historicalContinuity.join("；")}`);
  if (contract.historicalCharacterState?.length) evidence.push(`  - 相关人物历史状态：${contract.historicalCharacterState.join("；")}`);
  if (contract.recentPatternMemory?.length) evidence.push(`  - 近期叙事模式：${contract.recentPatternMemory.join("；")}`);
  if (evidence.length > 0) {
    layers.push([
      "【层 3·历史证据｜按需参考，非强制消费】",
      "以下为已发生章节的证据摘要；仅在你判断需要保持连续性时参考，不必逐条复述或对齐：",
      ...evidence,
    ].join("\n"));
  }

  // ── 层 4：模型决策空间层（创作指引，可自行决定表达）──
  const decisionSpace: string[] = [];
  if (contract.currentPressure?.length) decisionSpace.push(`  - 当前压力：${contract.currentPressure.join("；")}`);
  if (contract.previousState?.length) decisionSpace.push(`  - 前文状态：${contract.previousState.join("；")}`);
  if (contract.relevantCharacters?.length) decisionSpace.push(`  - 本章相关角色：${contract.relevantCharacters.join("；")}`);
  if (contract.relevantCharacterStates?.length) decisionSpace.push(`  - 相关人物状态：${contract.relevantCharacterStates.join("；")}`);
  if (contract.characterMotivations?.length) decisionSpace.push(`  - 人物动机：${contract.characterMotivations.join("；")}`);
  if (contract.focusCharacterGoals?.length) decisionSpace.push(`  - 焦点角色目标：${contract.focusCharacterGoals.join("；")}`);
  if (contract.resistance?.length) decisionSpace.push(`  - 本章阻力：${contract.resistance.join("；")}`);
  if (contract.choicesAndCosts?.length) decisionSpace.push(`  - 选择与代价：${contract.choicesAndCosts.join("；")}`);
  if (contract.expectedIrreversibleChange?.length) decisionSpace.push(`  - 预期不可逆变化：${contract.expectedIrreversibleChange.join("；")}`);
  if (contract.selectedPromisesToAdvance?.length) decisionSpace.push(`  - 本章选中承诺：${contract.selectedPromisesToAdvance.join("；")}`);
  if (contract.selectedExpectationsToAdvance?.length) decisionSpace.push(`  - 本章选中读者期待：${contract.selectedExpectationsToAdvance.join("；")}`);
  if (contract.causalEndPressure?.length) decisionSpace.push(`  - 因果章末压力：${contract.causalEndPressure.join("；")}`);
  if (decisionSpace.length > 0) {
    layers.push([
      "【层 4·模型决策空间｜创作指引，可自行决定表达方式】",
      "以下为创作方向与情节要素指引；具体场景、对白、心理、节奏、修辞由你自行决定，",
      "未在此层列出的写法不构成约束。请避免逐条清单式执行，应有机融入叙事：",
      ...decisionSpace,
    ].join("\n"));
  }

  return [
    "【本章叙事契约（分层版）：所有模型共用，不得改写其事实含义】",
    ...layers,
  ].join("\n\n");
}

/**
 * Writer adapter system prompt（Phase 9 registry 导出）。
 *
 * 生产 raw/editorial 候选共用此 system prompt；模型专属差异由 WriterPromptProfile
 * 在 user prompt 的 contract 渲染层（renderContract vs renderLayeredContract）处理，
 * system prompt 保持模型无关。
 */
export const WRITER_ADAPTER_SYSTEM_PROMPT =
  "你是中文长篇小说作者。遵守作者提供的叙事内容、事实和人物知识边界，完成本章正文。";

/** Apply model-specific ordering and language without mutating the contract. */
export function adaptWriterPrompt(input: WriterPromptAdapterInput): AdaptedWriterPrompt {
  const useLayered = input.profile === "gemini_writer_v2_layered";
  const contractBlock = useLayered
    ? renderLayeredContract(input.contract)
    : renderContract(input.contract);
  const wordCountHint = input.contract.wordCountTarget
    ? `本章正文字数目标：${input.contract.wordCountTarget.min}-${input.contract.wordCountTarget.max} 字。请充分展开场景、对话与心理描写，确保内容饱满。`
    : "本章正文字数目标：2000-3000 字。请充分展开场景、对话与心理描写，确保内容饱满。";
  const outputBoundary = `只输出第${input.chapterNumber}章完整正文，不解释思路，不输出大纲、清单、JSON 或创作说明。`;
  return {
    profile: input.profile,
    systemPrompt: WRITER_ADAPTER_SYSTEM_PROMPT,
    userPrompt: [
      input.sharedContext,
      contractBlock,
      wordCountHint,
      "请自行决定具体表达；未在内容契约中声明的写法不构成约束。",
      outputBoundary,
    ].join("\n\n"),
    chapterContract: input.contract,
    runtimePolicy: RUNTIME_POLICY,
  };
}
