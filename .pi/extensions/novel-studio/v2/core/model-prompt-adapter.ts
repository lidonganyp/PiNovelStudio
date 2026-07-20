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
  | "gemini_writer_v2";

export interface ChapterContract {
  workIdentity: string[];
  readerPromises: string[];
  genrePromises: string[];
  protagonistCoreConflict: string[];
  thematicQuestions: string[];
  forbiddenDrift: string[];
  overallPlotDirection: string[];
  chapterFunction: string[];
  previousState: string[];
  relevantCharacters: string[];
  characterMotivations: string[];
  eventSummaries: string[];
  mustInclude: string[];
  stateChanges: string[];
  foreshadowing: string[];
  causalRelations: string[];
  endingTarget: string[];
  inviolableFacts: string[];
  stateConstraints: string[];
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

/** Compile the model-independent narrative requirements for one chapter. */
export function buildChapterContract(input: UnifiedOrchestratorInput): ChapterContract {
  const contextFacts = (input.context.facts ?? [])
    .filter((fact) => fact.kind === "fact")
    .map((fact) => fact.content);
  const forbiddenDrift = compact(input.constitution?.forbiddenDrift ?? []);
  const inviolableFacts = compact([
    ...(input.intent.inviolableFacts ?? []),
    ...contextFacts,
  ]).filter((fact) => !forbiddenDrift.includes(fact));

  return {
    workIdentity: compact([input.constitution?.workIdentity]),
    readerPromises: compact(input.constitution?.readerPromise ?? []),
    genrePromises: compact(input.constitution?.genrePromises ?? []),
    protagonistCoreConflict: compact([input.constitution?.protagonistCoreConflict]),
    thematicQuestions: compact(input.constitution?.thematicQuestions ?? []),
    forbiddenDrift,
    overallPlotDirection: compact(input.intent.overallPlotDirection ?? []),
    chapterFunction: compact([input.intent.chapterFunction]),
    previousState: compact(input.intent.previousState ?? []),
    relevantCharacters: compact(input.intent.relevantCharacters ?? []),
    characterMotivations: compact((input.intent.characterMotivations ?? []).map((entry) => `${entry.character}：${entry.motivation}`)),
    eventSummaries: compact(input.intent.authorEventSummaries ?? []),
    mustInclude: compact(input.intent.authorMustInclude ?? []),
    stateChanges: compact(input.intent.authorStateChanges ?? []),
    foreshadowing: compact(input.intent.foreshadowing ?? []),
    causalRelations: compact(input.intent.causalRelations ?? []),
    endingTarget: compact(input.intent.endingTarget ?? []),
    inviolableFacts,
    stateConstraints: compact(input.intent.factAndCharacterKnowledgeForbiddenZones ?? []),
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

function renderContract(contract: ChapterContract): string {
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
    renderList("前文状态", contract.previousState),
    renderList("本章相关角色", contract.relevantCharacters),
    renderList("人物动机", contract.characterMotivations),
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

/** Apply model-specific ordering and language without mutating the contract. */
export function adaptWriterPrompt(input: WriterPromptAdapterInput): AdaptedWriterPrompt {
  const contractBlock = renderContract(input.contract);
  const outputBoundary = `只输出第${input.chapterNumber}章完整正文，不解释思路，不输出大纲、清单、JSON 或创作说明。`;
  return {
    profile: input.profile,
    systemPrompt: "你是中文长篇小说作者。遵守作者提供的叙事内容、事实和人物知识边界，完成本章正文。",
    userPrompt: [
      input.sharedContext,
      contractBlock,
      "请自行决定具体表达；未在内容契约中声明的写法不构成约束。",
      outputBoundary,
    ].join("\n\n"),
    chapterContract: input.contract,
    runtimePolicy: RUNTIME_POLICY,
  };
}
