/**
 * AuthorStyleOptimizer — 对 NovelOS Agentic 初稿执行作品专属作者风格整章优化。
 *
 * 只消费风格档案中的定性指导，不把段长百分位、对白比例等统计值变成机械配额。
 * 输出仍须保留原有事件、人物关系、事实与知识边界，由编排器继续执行确定性门禁。
 */

import type { ModelGenerateFn, ModelGenerateInput } from "../adapters/legacy-model-route-adapter.js";
import type { ChapterIntent } from "./chapter-intent-builder.js";
import { resolveEditorialCandidateRoute } from "./editorial-candidate-generator.js";
import { auditPrompt } from "./prompt-constraint-audit.js";
import type {
  Candidate,
  CompiledContext,
  ConstitutionSnapshot,
  StyleReference,
} from "./types.js";
import type { WriterPromptProfile } from "./model-prompt-adapter.js";
import type { AuthorStyleStrategyParams } from "../learning/author-style-strategy-registry.js";

export const STYLE_SYSTEM_PROMPT = `你是中文长篇小说的作者风格编辑。请在不改变故事事实、事件因果、人物关系、知识边界和章末压力的前提下，把完整初稿优化成指定作者的稳定写作风格。

风格档案只提供定性参考，历史统计不得转成正文配额。你可以重组表达，但不能删改关键事件，也不能补写档案、解释或分析。

【内容完整约束】
- 初稿中的每一句话都是故事内容的组成部分——包括动作、对白、设定说明、内心独白、临别赠言、旁白议论等。
- 严禁以"精简讲述""优化节奏""避免冗余"为由删除对白、设定说明或内心独白。
- 风格优化只调整措辞、句式和节奏；初稿中的每一句话在优化稿中都必须有对应内容（可以改写，但不得删除或用其他事件替换）。
- canary 证据：模型曾系统性删除"通常需要三人以上的战术小队配合才能猎杀""活着回来""是时候去把那1250积分拿回来了"等设定说明/对白/独白——这些是故事骨架的组成部分，删除即阻断。

【输出格式硬约束】
- 只输出优化后的完整章节正文，从正文第一段直接开始。
- 严禁输出构思、计划、大纲、逐段润色说明、思考链、分析、注释、Markdown 标题或列表前缀（如"- 训练室段："）等任何非正文内容。
- 严禁先写"润色计划"再写正文；正文必须是你输出的唯一内容。
- 如果你想规划如何优化，只在心里完成，不要把规划写进输出。`;

const MAX_GUIDANCE_ITEMS = 12;
const MAX_GUIDANCE_CHARS = 1600;
const DEFAULT_TIMEOUT_MS = 600000;

export interface AuthorStyleOptimizationInput {
  sourceCandidate: Candidate;
  chapterNumber: number;
  intent: ChapterIntent;
  context: CompiledContext;
  constitution: ConstitutionSnapshot | null;
  writerPromptProfile?: WriterPromptProfile;
  modelGenerate: ModelGenerateFn;
  timeoutMs?: number;
  /**
   * P1 修复（NOVELOS-CONSTRAINT-RELAXATION-1）：风格指导缩减比例。
   *
   * 当 StoryPreservation 返回 unverifiable 时，编排器用 reduced guidance 重试一次，
   * 避免因风格指导过载导致事件抽取失败。reducedGuidanceRatio=0.5 表示只保留
   * 原指导的一半（按 MAX_GUIDANCE_ITEMS 上限再砍半）。
   * 未设置（undefined）= 使用完整指导（默认行为，向后兼容）。
   */
  reducedGuidanceRatio?: number;
  /**
   * Phase 4B：作者风格优化策略参数（由 ContextualStrategySelector Thompson Sampling 选中）。
   *
   * 与 reducedGuidanceRatio 的关系：
   * - 两者可同时存在；reducedGuidanceRatio 优先（retry 路径覆盖 strategy）
   * - strategyParams.reducedGuidanceRatio 仅在 input.reducedGuidanceRatio 未设置时生效
   * - strategyParams.voiceEmphasisBlock / rhythmAdjustmentBlock 追加到 prompt（非替换）
   *
   * 未设置（undefined）= 不应用任何策略参数（默认行为，向后兼容）。
   */
  strategyParams?: AuthorStyleStrategyParams;
  /**
   * Phase P1 修复：本章字数软目标（非硬性约束）。
   *
   * 与 Agentic 的 targetWordCount 同源（从 config.json targetWordCount.perChapter.min/max 读取），
   * 注入为风格优化 prompt 的软目标，使优化稿与 Agentic 初稿保持一致的字数预算。
   * 模型可自由调整，不作为硬门禁。undefined 时不注入字数指导。
   */
  targetWordCount?: { min: number; max: number };
  /**
   * Drift feedback from Story Preservation Gate（drift retry 用）。
   *
   * 当首次风格优化触发 Story Preservation 漂移（replaced_event）时，编排器把检测到的
   * replacedEvents 传入重试，让 prompt 明确告知模型哪些事件被改写了，必须保持不变。
   *
   * 未设置（undefined）= 首次优化，无 drift feedback（默认行为，向后兼容）。
   */
  driftFeedback?: {
    replacedEvents: Array<{
      subject: string;
      rawSentence: string;
      editorialSentence: string;
      reason: string;
    }>;
  };
}

export interface AuthorStyleOptimizationResult {
  candidate: Candidate | null;
  failureReason: string | null;
  /**
   * P0-1 修复（Phase 1 整改）：失败归因分类，供 orchestrator 决定恢复策略。
   *
   * - null：成功（有候选）。
   * - no_guidance：风格档案缺失或无可消费定性指导 → 不可自动恢复，hard block。
   * - prompt_rejected：优化 prompt 被审计为机械控制型 → 不可自动恢复，hard block。
   * - empty_result：模型返回空文本 → 编排器在作者风格阶段内重试一次。
   * - model_timeout：模型调用超时/中断 → 编排器在作者风格阶段内重试一次。
   * - model_error：其他模型错误（非超时） → 不伪装成超时，直接 hard block。
   *
   * orchestrator 据此分类：只有 empty_result/model_timeout 会复用同一 Agentic 候选做
   * 一次 in-stage retry；重试耗尽及其他失败均以 gate=style_optimization 阻断。
   */
  failureKind:
    | "no_guidance"
    | "prompt_rejected"
    | "empty_result"
    | "model_timeout"
    | "model_error"
    | null;
  styleProfileLoaded: boolean;
  styleGuidanceConsumed: boolean;
  styleReferenceIds: string[];
  guidanceCount: number;
  /**
   * P1 修复：标记本次优化是否为缩减指导重试（用于 trace 区分首次优化与 unverifiable 重试）。
   */
  retryWithReducedGuidance: boolean;
}

/**
 * P0-1 修复（Phase 1 整改）：把模型异常归类为 timeout 或一般 model_error。
 *
 * 超时类（含 "timeout"/"timed out"/"超时"/"aborted"/"ETIMEDOUT"）→ model_timeout；
 * 其他 → model_error。timeout 允许编排器做一次阶段内重试；model_error 直接阻断。
 */
function classifyModelFailure(error: unknown): "model_timeout" | "model_error" {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("timeout")
    || lower.includes("timed out")
    || lower.includes("超时")
    || lower.includes("aborted")
    || lower.includes("etimedout")
  ) {
    return "model_timeout";
  }
  return "model_error";
}

interface ParsedStyleGuidance {
  referenceIds: string[];
  guidance: string[];
}

function parseStyleReference(reference: StyleReference): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(reference.content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean)
    : [];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function appendQualitativeField(
  guidance: string[],
  section: string,
  label: string,
  value: unknown,
): void {
  if (typeof value === "string" && value.trim()) {
    guidance.push(`[${section}] ${label}：${value.trim()}`);
    return;
  }
  for (const item of stringList(value)) {
    guidance.push(`[${section}] ${label}：${item}`);
  }
}

/**
 * Shared profiles created before explicit editorialGuidance used a structured
 * fingerprint schema. Convert only its qualitative fields into advisory
 * guidance; observed ratios, densities, lengths, and other numeric metrics are
 * intentionally excluded from the model prompt.
 */
function collectLegacyQualitativeGuidance(payload: Record<string, unknown>): string[] {
  const guidance: string[] = [];
  const sentence = recordValue(payload.sentence);
  const narrative = recordValue(payload.narrative);
  const emotion = recordValue(payload.emotion);
  const imagery = recordValue(payload.imagery);
  const rhythm = recordValue(payload.rhythm);
  const lexicon = recordValue(payload.lexicon);

  if (sentence) {
    appendQualitativeField(guidance, "句法", "签名模式", sentence.signaturePatterns);
  }
  if (narrative) {
    for (const [key, label] of [
      ["povStyle", "视角"],
      ["viewpoint", "视点"],
      ["viewpointAnchor", "视点锚定"],
      ["expositionStyle", "信息揭示"],
      ["timeFlow", "时间流动"],
      ["sceneTransitionStyle", "场景转场"],
      ["coreEmotionAnchors", "核心情绪锚点"],
    ] as const) {
      appendQualitativeField(guidance, "叙事", label, narrative[key]);
    }
  }
  if (emotion) {
    for (const [key, label] of [
      ["baseline", "情绪基线"],
      ["peakType", "情绪峰值"],
      ["valleyType", "情绪低谷"],
      ["escalationPattern", "升级方式"],
      ["coolDownPattern", "冷却方式"],
      ["behavioralOverVerbal", "行为优先于直白解释"],
    ] as const) {
      appendQualitativeField(guidance, "情绪", label, emotion[key]);
    }
  }
  if (imagery) {
    for (const [key, label] of [
      ["primaryMetaphors", "主要隐喻"],
      ["visualStyle", "视觉质感"],
      ["spatialSense", "空间感"],
      ["timeImagery", "时间意象"],
      ["powerVisualization", "力量呈现"],
      ["environmentStyle", "环境写法"],
      ["fightChoreography", "动作编排"],
      ["metaphorSource", "隐喻来源"],
      ["sensoryEmphasis", "感官重点"],
    ] as const) {
      appendQualitativeField(guidance, "意象", label, imagery[key]);
    }
  }
  if (rhythm) {
    for (const [key, label] of [
      ["sentenceRhythm", "句子节奏"],
      ["paragraphRhythm", "段落节奏"],
      ["chapterRhythm", "章节节奏"],
      ["breathPoints", "呼吸点"],
      ["accelerationTriggers", "加速触发"],
      ["decelerationTriggers", "减速触发"],
      ["actionScenePace", "动作场景速度"],
      ["dialogueScenePace", "对话场景速度"],
      ["descriptionScenePace", "描写场景速度"],
    ] as const) {
      appendQualitativeField(guidance, "节奏", label, rhythm[key]);
    }
  }
  if (lexicon) {
    appendQualitativeField(guidance, "词汇", "标志性短语", lexicon.signaturePhrases);
    appendQualitativeField(guidance, "词汇", "避免用语", lexicon.avoidWords);
    appendQualitativeField(guidance, "词汇", "偏好过渡", lexicon.preferredTransitions);
    appendQualitativeField(guidance, "词汇", "专业词汇", lexicon.specializedTerms);
  }

  return guidance;
}

export function collectAuthorStyleGuidance(
  context: CompiledContext,
  relevantCharacters: string[],
  reducedGuidanceRatio?: number,
): ParsedStyleGuidance {
  const referenceIds: string[] = [];
  const guidance: string[] = [];

  for (const reference of context.styleReferences.filter((entry) => entry.kind === "fingerprint")) {
    const payload = parseStyleReference(reference);
    if (!payload) continue;
    referenceIds.push(reference.id);
    const explicitGuidance = stringList(payload.editorialGuidance);
    guidance.push(...explicitGuidance.map((item) => `[通用] ${item}`));
    if (explicitGuidance.length === 0) {
      guidance.push(...collectLegacyQualitativeGuidance(payload));
    }

    const voices = payload.characterVoiceGuidance;
    if (voices && typeof voices === "object" && !Array.isArray(voices)) {
      const voiceMap = voices as Record<string, unknown>;
      for (const character of relevantCharacters) {
        guidance.push(...stringList(voiceMap[character]).map((item) => `[${character}] ${item}`));
      }
    }
  }

  // P1 修复：unverifiable 重试时缩减指导上限，避免风格指导过载导致事件抽取失败
  const effectiveMaxItems = reducedGuidanceRatio !== undefined && reducedGuidanceRatio > 0 && reducedGuidanceRatio < 1
    ? Math.max(1, Math.floor(MAX_GUIDANCE_ITEMS * reducedGuidanceRatio))
    : MAX_GUIDANCE_ITEMS;
  const effectiveMaxChars = reducedGuidanceRatio !== undefined && reducedGuidanceRatio > 0 && reducedGuidanceRatio < 1
    ? Math.max(200, Math.floor(MAX_GUIDANCE_CHARS * reducedGuidanceRatio))
    : MAX_GUIDANCE_CHARS;

  const uniqueGuidance = [...new Set(guidance)]
    .slice(0, effectiveMaxItems)
    .reduce<string[]>((items, item) => {
      const nextLength = [...items, item].join("\n").length;
      return nextLength <= effectiveMaxChars ? [...items, item] : items;
    }, []);

  return { referenceIds: [...new Set(referenceIds)], guidance: uniqueGuidance };
}

function buildUserPrompt(input: AuthorStyleOptimizationInput, guidance: ParsedStyleGuidance): string {
  const parts: string[] = [];
  parts.push(`请优化第 ${input.chapterNumber} 章完整正文。`);
  const contractLines: string[] = [];
  const eventSummaries = input.intent.authorEventSummaries ?? [];
  const mustInclude = input.intent.authorMustInclude ?? [];
  const stateChanges = input.intent.authorStateChanges ?? [];
  const causalRelations = input.intent.causalRelations ?? [];
  const endingTarget = input.intent.endingTarget ?? [];
  if (eventSummaries.length > 0) {
    contractLines.push("事件顺序：");
    contractLines.push(...eventSummaries.slice(0, 8).map((item, index) => `${index + 1}. ${item}`));
  }
  if (mustInclude.length > 0) {
    contractLines.push(`必须保留：${mustInclude.slice(0, 8).join("；")}`);
  }
  if (stateChanges.length > 0) {
    contractLines.push(`状态变化：${stateChanges.slice(0, 8).join("；")}`);
  }
  if (causalRelations.length > 0) {
    contractLines.push(`因果关系：${causalRelations.slice(0, 8).join("；")}`);
  }
  if (endingTarget.length > 0) {
    contractLines.push(`章末承接：${endingTarget.slice(0, 8).join("；")}`);
  }
  if (contractLines.length > 0) {
    parts.push(
      "【本章事件与因果契约（只允许改写表达）】\n" +
      contractLines.join("\n") + "\n" +
      "不得调换、删除或合并导致事件结果变化；必须保持每个事件的先后顺序、因果关系和状态变化。",
    );
  }
  // Drift retry：把事件保持约束放在 prompt 最前面（初稿之前），提高模型对约束的注意力。
  // canary 证据（canary-real-drift-feedback-20260730）：driftFeedback 块放在 prompt 中段时，
  // Gemini 3.1 Pro Preview 忽略约束，重试稿与首次漂移完全相同（ch1: "看向万永福" 被替换为
  // "他看着父亲碗里的白菜"，首次和重试 editorialSentence 完全一致）。
  // 修复：移到开头 + 改用正向措辞（"必须保留「X」"，而非"被改写为「Y」"）+ 给出具体例子。
  if (input.driftFeedback?.replacedEvents?.length) {
    const eventList = input.driftFeedback.replacedEvents
      .slice(0, 5) // 最多 5 条，避免 prompt 过长
      .map(
        (e, i) =>
          `${i + 1}. 主体"${e.subject}"的事件「${e.rawSentence}」必须原样保留，不得删除、替换或改写为其他事件（上一轮错误地改成了「${e.editorialSentence}」）。`,
      )
      .join("\n");
    parts.push(
      `【事件保持硬约束（重试）】\n` +
      `上一轮风格优化把以下关键事件改写了，本轮必须保留初稿中的原始事件：\n${eventList}\n` +
      `只允许调整措辞、句式、节奏和感官描写；主体、动作、对象、结果和事件顺序必须与初稿完全一致。` +
      `例如：初稿中"他看不见"，优化稿也必须是"看不见"，不能改成"看得见"；初稿中"看向万永福"，优化稿也必须有"看向万永福"这个动作。`,
    );
  }
  parts.push(`【NovelOS Agentic 初稿】\n${input.sourceCandidate.text}`);
  parts.push(`【作者风格档案（定性指导）】\n${guidance.guidance.map((item) => `- ${item}`).join("\n")}`);
  if (input.intent.inviolableFacts.length > 0) {
    parts.push(`【不可改变的事实】\n${input.intent.inviolableFacts.map((item) => `- ${item}`).join("\n")}`);
  }
  const forbiddenZones = input.intent.factAndCharacterKnowledgeForbiddenZones ?? [];
  if (forbiddenZones.length > 0) {
    parts.push(`【人物知识与事实禁区】\n${forbiddenZones.map((item) => `- ${item}`).join("\n")}`);
  }
  if (input.constitution?.forbiddenDrift.length) {
    parts.push(`【作品禁止漂移】\n${input.constitution.forbiddenDrift.map((item) => `- ${item}`).join("\n")}`);
  }
  // Phase 4B：注入策略参数块（voice_emphasis / rhythm_adjustment）
  // 这些块是定性指导，不是机械配额；模型可自由决定如何应用
  if (input.strategyParams?.voiceEmphasisBlock) {
    parts.push(input.strategyParams.voiceEmphasisBlock);
  }
  if (input.strategyParams?.rhythmAdjustmentBlock) {
    parts.push(input.strategyParams.rhythmAdjustmentBlock);
  }
  // P1 修复：注入字数软目标（与 Agentic 初稿保持一致的字数预算）
  if (input.targetWordCount) {
    parts.push(
      `【字数软目标】本章目标字数 ${input.targetWordCount.min}-${input.targetWordCount.max} 字（软目标，可自由调整，不作为硬门禁）。`,
    );
  }
  // driftFeedback 块已移到 prompt 开头（初稿之前），见上方。
  parts.push(
    "保留初稿中的关键事件、因果顺序、人物行动结果与章末压力。" +
    "只输出优化后的完整正文，从正文第一段直接开始；严禁输出构思、计划、大纲、逐段润色说明或任何非正文内容。",
  );
  return parts.join("\n\n");
}

export class AuthorStyleOptimizer {
  async optimize(input: AuthorStyleOptimizationInput): Promise<AuthorStyleOptimizationResult> {
    // Phase 4B：合并 reducedGuidanceRatio
    // 优先级：input.reducedGuidanceRatio（retry 路径）> strategyParams.reducedGuidanceRatio（策略）
    const effectiveReducedRatio = input.reducedGuidanceRatio ?? input.strategyParams?.reducedGuidanceRatio;
    const isRetry = input.reducedGuidanceRatio !== undefined
      && input.reducedGuidanceRatio > 0
      && input.reducedGuidanceRatio < 1;
    const styleGuidance = collectAuthorStyleGuidance(
      input.context,
      input.intent.relevantCharacters,
      effectiveReducedRatio,
    );
    if (styleGuidance.referenceIds.length === 0 || styleGuidance.guidance.length === 0) {
      return {
        candidate: null,
        failureReason: "作者风格档案缺失或没有可消费的定性指导",
        failureKind: "no_guidance",
        styleProfileLoaded: styleGuidance.referenceIds.length > 0,
        styleGuidanceConsumed: false,
        styleReferenceIds: styleGuidance.referenceIds,
        guidanceCount: styleGuidance.guidance.length,
        retryWithReducedGuidance: isRetry,
      };
    }

    const userPrompt = buildUserPrompt(input, styleGuidance);
    const promptProfile = auditPrompt(STYLE_SYSTEM_PROMPT, userPrompt);
    if (promptProfile.type === "control") {
      return {
        candidate: null,
        failureReason: "作者风格优化 prompt 被审计为机械控制型",
        failureKind: "prompt_rejected",
        styleProfileLoaded: true,
        styleGuidanceConsumed: false,
        styleReferenceIds: styleGuidance.referenceIds,
        guidanceCount: styleGuidance.guidance.length,
        retryWithReducedGuidance: isRetry,
      };
    }

    const route = resolveEditorialCandidateRoute(input.writerPromptProfile);
    const modelInput: ModelGenerateInput = {
      route,
      systemPrompt: STYLE_SYSTEM_PROMPT,
      userPrompt,
      kind: "author_style_optimization",
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      promptProfile: input.writerPromptProfile,
    };

    try {
      const output = await input.modelGenerate(modelInput);
      if (!output.text?.trim()) {
        return {
          candidate: null,
          failureReason: "作者风格优化返回空文本",
          failureKind: "empty_result",
          styleProfileLoaded: true,
          styleGuidanceConsumed: true,
          styleReferenceIds: styleGuidance.referenceIds,
          guidanceCount: styleGuidance.guidance.length,
          retryWithReducedGuidance: isRetry,
        };
      }
      return {
        candidate: {
          id: `candidate:author_style:${input.sourceCandidate.id}${isRetry ? ":retry" : ""}`,
          text: output.text,
          kind: "editorial_amplified",
          model: output.model,
          route: output.route,
          contextHash: input.sourceCandidate.contextHash,
          generatedAt: new Date().toISOString(),
          durationMs: output.durationMs,
          promptProfile,
          sourceCandidateId: input.sourceCandidate.id,
          editorialStrategy: "author_style_full_chapter" as Candidate["editorialStrategy"],
          ...(output.finishReason !== undefined ? { finishReason: output.finishReason } : {}),
          ...(output.maxTokens !== undefined ? { maxTokens: output.maxTokens } : {}),
        },
        failureReason: null,
        failureKind: null,
        styleProfileLoaded: true,
        styleGuidanceConsumed: true,
        styleReferenceIds: styleGuidance.referenceIds,
        guidanceCount: styleGuidance.guidance.length,
        retryWithReducedGuidance: isRetry,
      };
    } catch (error: unknown) {
      return {
        candidate: null,
        failureReason: error instanceof Error ? error.message : String(error),
        failureKind: classifyModelFailure(error),
        styleProfileLoaded: true,
        styleGuidanceConsumed: true,
        styleReferenceIds: styleGuidance.referenceIds,
        guidanceCount: styleGuidance.guidance.length,
        retryWithReducedGuidance: isRetry,
      };
    }
  }
}

export function createAuthorStyleOptimizer(): AuthorStyleOptimizer {
  return new AuthorStyleOptimizer();
}
