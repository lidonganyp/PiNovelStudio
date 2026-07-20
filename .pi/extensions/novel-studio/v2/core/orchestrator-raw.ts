/**
 * orchestrator-raw - 统一主链路"raw 生成"相位
 *
 * 从 unified-orchestrator.ts 抽出（行为保持重构 Step 3）。
 * 包含：generateRaw（空文本有界重试）、buildRawPrompt（编辑型 prompt + 12 个上下文编译）、
 * buildIntentSummary（章卡结构化摘要）。三者均为纯函数，无实例状态依赖。
 */

import {
  RAW_ROUTE,
  DEFAULT_RAW_TIMEOUT_MS,
  MAX_RAW_EMPTY_RETRIES,
  type UnifiedOrchestratorInput,
} from "./orchestrator-types.js";
import type { ModelGenerateInput } from "../adapters/legacy-model-route-adapter.js";
import type { ChapterIntent } from "./chapter-intent-builder.js";
import { compilePromiseContext, type PromiseContext } from "./promise-context-compiler.js";
import { compileExpectationContext, type ExpectationContext } from "./expectation-context-compiler.js";
import { compileGenreContract, type GenreContractContext } from "./genre-contract-compiler.js";
import { compileDialogueCraftContext, type DialogueCraftContext } from "./dialogue-craft-compiler.js";
import { compileEmotionRhythmContext, type EmotionRhythmContext } from "./emotion-rhythm-compiler.js";
import { compileSupportingFunctionContext, type SupportingFunctionContext } from "./supporting-function-compiler.js";
import { compileKnowledgeConsumptionContext, type KnowledgeConsumptionContext } from "./knowledge-consumption-compiler.js";
import { compileCharacterVoiceContext, type CharacterVoiceContext } from "./character-voice-compiler.js";
import { compileWorldPresentationContext, type WorldPresentationContext } from "./world-presentation-compiler.js";
import { compileEnsembleLayeringContext, type EnsembleLayeringContext } from "./ensemble-layering-compiler.js";
import { compileIdentityContract } from "./identity-contract-compiler.js";
import { compileOntologyContract, type OntologyContract } from "./ontology-contract-compiler.js";
import { localizeLlmText } from "../../utils/llm-language-guard.js";
import {
  adaptWriterPrompt,
  buildChapterContract,
  resolveWriterPromptProfile,
  type AdaptedWriterPrompt,
  type ChapterContract,
} from "./model-prompt-adapter.js";
import { compileMethodologyApplicationReport, type MethodologyApplicationReport } from "./methodology-policy.js";
import { auditPrompt } from "./prompt-constraint-audit.js";
import type { CandidatePromptProfile } from "./types.js";

// ==========================================================================
// raw 生成
// ==========================================================================

/**
 * 生成 raw 正文。空文本有界重试（MAX_RAW_EMPTY_RETRIES）。
 * 抛异常表示生成失败（调用方 hard block）。
 *
 * 修复轮：prompt 由调用方预构建（buildRawPrompt 在 orchestrate 的 try 块前调用一次），
 * 避免重复构建，并使异常路径仍能保留实际 consumedFields。
 *
 * 返回 { text, model }：model 用于 Phase 6 按模型版本隔离策略信誉。
 */
export async function generateRaw(
  input: UnifiedOrchestratorInput,
  prebuiltPrompt: { systemPrompt: string; userPrompt: string; promptAdapter?: AdaptedWriterPrompt }
): Promise<{ text: string; model: string; finishReason?: string; maxTokens?: number }> {
  const { systemPrompt, userPrompt } = prebuiltPrompt;
  const route = RAW_ROUTE;
  const timeoutMs = input.timeoutMs ?? DEFAULT_RAW_TIMEOUT_MS;

  let lastText = "";
  let lastModel = "unknown";
  let lastFinishReason: string | undefined;
  let lastMaxTokens: number | undefined;
  for (let attempt = 0; attempt <= MAX_RAW_EMPTY_RETRIES; attempt++) {
    const genInput: ModelGenerateInput = {
      route,
      systemPrompt,
      userPrompt,
      kind: "raw_chapter",
      timeoutMs,
      promptProfile: prebuiltPrompt.promptAdapter?.profile,
    };
    const output = await input.modelGenerate(genInput);
    lastText = output.text ?? "";
    lastModel = output.model ?? "unknown";
    lastFinishReason = output.finishReason;
    lastMaxTokens = output.maxTokens;
    if (lastText.trim().length > 0) {
      return {
        text: lastText,
        model: lastModel,
        finishReason: lastFinishReason,
        maxTokens: lastMaxTokens,
      };
    }
  }
  return {
    text: lastText,
    model: lastModel,
    finishReason: lastFinishReason,
    maxTokens: lastMaxTokens,
  }; // 空文本，调用方 hard block
}

/**
 * 构建 raw 生成 prompt（编辑型，非控制型）。
 * 给模型章节意图、不可破坏事实、角色压力，要求完整章节初稿。
 *
 * Eval 模式（NB-4 Generation Matrix）：
 * - 若传入 evalPrefix，作为"【前文】"段插入 userPrompt 开头（续写评估用）。
 * - B0/B1/B2/B3/B4 共用同一 buildRawPrompt，层级差异由调用方传入的
 *   intent/context 字段丰富度决定（B0=空 intent/context，B1=仅 context，
 *   B2=完整 intent+context），主链路流程差异由 evalMode 控制。
 */
export function buildRawPrompt(input: UnifiedOrchestratorInput): { systemPrompt: string; userPrompt: string; consumedFields: string[]; constitutionConsumedFields: string[]; promptConstraintAudit: CandidatePromptProfile; methodologyPolicy: MethodologyApplicationReport; promiseContext: PromiseContext; expectationContext: ExpectationContext; genreContract: GenreContractContext; dialogueCraft: DialogueCraftContext; emotionRhythm: EmotionRhythmContext; supportingFunction: SupportingFunctionContext; knowledgeConsumption: KnowledgeConsumptionContext; characterVoiceContext: CharacterVoiceContext; worldPresentationContext: WorldPresentationContext; ensembleLayeringContext: EnsembleLayeringContext; identityContract: import("./identity-contract-compiler.js").IdentityContract; ontologyContract: OntologyContract; chapterContract: ChapterContract; promptAdapter: AdaptedWriterPrompt } {
  const { intent, context, constitution } = input;
  const parts: string[] = [];
  // INTENT-1：实际进入 prompt 的章卡字段清单，写入 stageResults.chapterIntent 供 trace 审计。
  // 只记录"内容确实被拼进 userPrompt"的字段，缺失/空数组不算消费。
  const consumedFields: string[] = [];

  // ── QUALITY-4：本章相关承诺状态编译（在 prompt 构建前编译，空时写 emptyReason 不静默） ──
  // 只编译 selectedPromisesToAdvance 命中项，不灌全量 PromiseLedger；
  // 已 fulfilled/broken 降级为 inspect；不调用 LLM；不提交状态；不是 gate。
  const promiseContextResult = compilePromiseContext({
    intent,
    longTermState: context.longTermState,
  });
  const promiseContext = promiseContextResult.promiseContext;

  // ── EXPECTATION-LEDGER-1：本章相关读者期待状态编译（在 prompt 构建前编译，空时写 emptyReason 不静默） ──
  // 只编译 selectedExpectationsToAdvance 命中项，不灌全量 ExpectationLedger；
  // fulfilled 降级为 inspect；escalated → escalate；delayed 保留 delayReason；
  // 不调用 LLM；不提交状态；不是 gate；不阻断正文生成。
  const expectationContextResult = compileExpectationContext({
    intent,
    longTermState: context.longTermState,
  });
  const expectationContext = expectationContextResult.expectationContext;

  // ── GENRE-CONTRACT-1：本章类型读者承诺编译（在 prompt 构建前编译，空时写 emptyReason 不静默） ──
  // 声明类型从 worldRules.type=genre 派生；driftGenre 来自 TypeRouter advisory（L0 阶段 null）；
  // constitution.genrePromises 默认激活；type-dataset（清洗后本地 dataset）按本章功能命中激活；
  // 不调用 LLM；不接管 immutable_fact（仍由 P0/WorldPresentationContext 管理）；不是 gate；不阻断正文。
  const genreContractResult = compileGenreContract({
    intent,
    worldRules: context.worldRules,
    constitution,
    driftGenre: null, // L0 阶段 TypeRouter 未接入；保留接口供后续 advisory 注入
    driftGenreSourceRef: null,
  });
  const genreContract = genreContractResult.genreContractContext;

  // ── DIALOGUE-CRAFT-1：本章发言角色声音指纹 + 对白工艺 advisory 编译（在 prompt 构建前编译，空时写 emptyReason 不静默） ──
  // 仅本章发言角色（focusCharacterGoals ∪ relevantCharacters 命中）进入 prompt；
  // 指纹带来源样章/接受稿（sourceChapterRef）；指纹缺失时降级为 CharacterVoice 弱代理（写明 confidence）；
  // raw 生成前 rawText=null，对白工艺 advisory 为空（无诊断对象）；raw 生成后可二次调用以扫描诊断；
  // 不调用 LLM；不强制对白比例；不是 gate；不阻断正文；advisory 不直接覆盖 raw。
  const dialogueCraftResult = compileDialogueCraftContext({
    intent,
    voiceFingerprints: input.voiceFingerprints ?? [], // L0 阶段调用方可传空数组（无指纹加载器）
    characterStates: context.characterStates,
    rawText: null, // raw 生成前无正文；advisory 在 raw 生成后由 opportunity detector 二次扫描
  });
  const dialogueCraft = dialogueCraftResult.dialogueCraftContext;

  // ── EMOTION-RHYTHM-1：事件驱动情绪节拍 advisory 编译（在 prompt 构建前编译，空时写 emptyReason 不静默） ──
  // 目标情绪来自 intent.readerExperience；前态来自 input.previousEmotionState（longTermState/seed）；
  // raw 生成前 rawText=null，只编译目标与前态；不含机械曲线配额（satisfactionInterval/climaxPositionRange/
  // emotionDensityThreshold/dialogueRatio/curveSmoothness/maxOppressionLength）；
  // 不调用 LLM；不是 gate；不阻断正文；advisory 不直接覆盖 raw；不接管 finalText。
  const emotionRhythmResult = compileEmotionRhythmContext({
    intent,
    rawText: null, // raw 生成前无正文；转折扫描在 raw 生成后由 opportunity detector 二次调用
    previousEmotionState: input.previousEmotionState ?? null,
  });
  const emotionRhythm = emotionRhythmResult.emotionRhythmContext;

  // ── SUPPORTING-FUNCTION-1：配角章节功能层 advisory 编译（在 prompt 构建前编译，空时写 emptyReason 不静默） ──
  // 激活配角 = relevantCharacters - focusCharacterGoals（非焦点相关角色）；
  // 每个激活配角最多一个主功能（foil/witness/obstacle/helper/cost-bearer）；
  // raw 生成前 rawText=null，功能 hypothesis 为空（primaryFunction=null, verified=false）；
  // raw 生成后由 opportunity detector 二次调用以扫描正文行为 span；
  // 不调用 LLM；不是 gate；不阻断正文；advisory 不直接覆盖 raw；不更新永久角色身份；
  // 不恢复固定群像人数配额；"companion/supporting"等静态 role 不冒充本章叙事功能。
  const supportingFunctionResult = compileSupportingFunctionContext({
    intent,
    rawText: null, // raw 生成前无正文；功能行为扫描在 raw 生成后由 opportunity detector 二次调用
  });
  const supportingFunction = supportingFunctionResult.supportingFunctionContext;

  // ── KNOWLEDGE-CONSUMPTION-1：few-shot/contrastive 生产消费审计（在 prompt 构建前编译，空时写 emptyReason 不静默） ──
  // 包装 FewshotSelector 检索结果为带 provenance/score/reason/tokenCost 的审计条目；
  // manifestApproved=false 强制 empty（不得静默加载未批准索引）；
  // 无匹配示例返回 empty selection（emptyReason="FewshotSelector 无匹配示例"），不伪造示例；
  // P0/P1 不因示例被淘汰（advisoryOnly=true；不强制模仿模板；不含 forcedImitation/mandatoryTemplate/requiredExamples）；
  // 不调用 LLM；不修改 finalText；不提交状态；不是 gate；不阻断正文生成。
  const fewshotSel = input.fewshotSelection;
  const knowledgeConsumptionResult = compileKnowledgeConsumptionContext({
    examples: fewshotSel?.examples ?? [],
    query: fewshotSel?.query ?? {},
    channel: fewshotSel?.channel ?? "empty",
    sources: fewshotSel?.sources ?? [],
    manifestApproved: fewshotSel?.manifestApproved ?? false,
    maxCharsPerExample: 520, // 与 FewshotSelector DEFAULT_OPTIONS.maxCharsPerExample 一致
  });
  const knowledgeConsumption = knowledgeConsumptionResult.knowledgeConsumptionContext;
  // 调用方未提供 fewshotSelection 时，覆写 emptyReason 为更准确的"未提供"原因
  // （compileKnowledgeConsumptionContext 在 manifestApproved=false 时已写"manifest 未批准"，
  // 但 L0 调用方未传 fewshotSelection 与 manifest 未批准是不同情况，需区分）。
  if (!fewshotSel && knowledgeConsumption.emptyReason) {
    knowledgeConsumption.emptyReason = "未提供 fewshot 检索结果（L0 阶段无 fewshot 加载器或调用方未传 fewshotSelection）";
  }

  // ── QUALITY-5：本章相关角色声音/状态提示编译（在 prompt 构建前编译，空时写 emptyReason 不静默） ──
  // 只编译 focusCharacterGoals ∪ relevantCharacters 命中项，不灌全量 characterStates；
  // voiceHints = mentality + pendingTension（弱代理，非完整 voice fingerprint）；
  // intent-only 进入 trace 但不进入 prompt block；不调用 LLM；不提交状态；不是 gate。
  const characterVoiceResult = compileCharacterVoiceContext({
    intent,
    characterStates: context.characterStates,
  });
  const characterVoiceContext = characterVoiceResult.characterVoiceContext;

  // ── QUALITY-6：本章世界约束与类型承诺编译（在 prompt 构建前编译，空时写 emptyReason 不静默） ──
  // 所有 worldRules 进入 entries（3-5 条背景规则）；immutable_fact 交叉引用 intent.inviolableFacts
  // 标记 chapterActivated；genrePromises 从 constitution 取（新数据）；不调用 LLM；不提交状态；不是 gate。
  const worldPresentationResult = compileWorldPresentationContext({
    intent,
    worldRules: context.worldRules,
    constitution,
  });
  const worldPresentationContext = worldPresentationResult.worldPresentationContext;

  // ── QUALITY-7：本章角色层次编译（焦点/在场分层，在 prompt 构建前编译，空时写 emptyReason 不静默） ──
  // 只编译 focusCharacterGoals ∪ relevantCharacters 命中项，不灌全量角色档案；
  // layeringTag = 焦点（在 focusCharacterGoals 中）/ 在场（仅 relevantCharacters）；
  // 不引入 staticRole（与 CharacterVoice 同源，冗余）；不调用 LLM；不提交状态；不是 gate。
  const ensembleLayeringResult = compileEnsembleLayeringContext({
    intent,
  });
  const ensembleLayeringContext = ensembleLayeringResult.ensembleLayeringContext;

  // Eval prefix（NB-4 续写评估用）：作为"【前文】"段
  if (input.evalPrefix) {
    parts.push(`【前文】\n${input.evalPrefix}`);
  }

  // Diagnostic and experiment modules are compiled for trace/evaluation only.
  // They must not prescribe how the raw chapter is written.
  promiseContext.consumedByRawPrompt = false;
  expectationContext.consumedByRawPrompt = false;
  genreContract.consumedByRawPrompt = false;
  dialogueCraft.consumedByRawPrompt = false;
  emotionRhythm.consumedByRawPrompt = false;
  supportingFunction.consumedByRawPrompt = false;
  knowledgeConsumption.consumedByRawPrompt = false;
  characterVoiceContext.consumedByRawPrompt = false;
  worldPresentationContext.consumedByRawPrompt = false;
  ensembleLayeringContext.consumedByRawPrompt = false;

  // ── CANON-IDENTITY-1：角色身份契约 compact block ──
  // 从 characterStates 编译身份契约；raw prompt 与 FactGuard 消费同一 contract（id/hash 一致）。
  // 只含结构性身份（name/role/aliases/stableIdentity），不含性格偏好。
  const identityInputs = (context.characterStates ?? []).length > 0
    ? (context.characterStates ?? []).map((c) => ({
      name: c.name,
      role: typeof c.state?.role === "string" ? c.state.role : undefined,
      aliases: Array.isArray(c.state?.aliases) ? c.state.aliases as string[] : [],
      characterId: c.characterId,
    }))
    : Array.from(new Set(input.characterNames ?? [])).map((name) => ({ name }));
  const identityContract = compileIdentityContract(identityInputs);
  if (identityContract.entries.length > 0) {
    const identityLines = identityContract.entries
      .filter((e) => {
        const focusChars = (intent.focusCharacterGoals ?? []).map((g) => g.character);
        const relevantChars = intent.relevantCharacters ?? [];
        const selected = [...new Set([...focusChars, ...relevantChars])];
        return selected.length === 0 || selected.some((s) => s === e.name || e.aliases.includes(s));
      })
      .map((e) => `- ${e.name}【${e.role}】${e.aliases.length > 0 ? `（别名：${e.aliases.join("、")}）` : ""} ${e.stableIdentity}`);
    if (identityLines.length > 0) {
      parts.push(`角色身份契约（${identityContract.contractId}）：\n${identityLines.join("\n")}`);
      consumedFields.push("identityContract");
    }
  }

  // WORLD-ONTOLOGY-1：只注入明确声明的闭世界术语序列；来源缺失时保留 unavailable 证据，
  // 不凭空补造境界体系，也不把开放名词硬化为门禁。
  const ontologyContract = compileOntologyContract(input.ontologyLevels ?? []);
  if (ontologyContract.entries.length > 0) {
    const ontologyLines = ontologyContract.entries.map((entry) =>
      `- ${entry.category}：${entry.terms.join(" → ")}`
    );
    parts.push(`封闭世界本体契约（${ontologyContract.contractId}）：\n${ontologyLines.join("\n")}`);
    consumedFields.push("ontologyContract");
  }

  const sharedContext = parts.join("\n\n");
  const chapterContract = buildChapterContract(input);
  const contractFields: Array<[keyof ChapterContract, string]> = [
    ["overallPlotDirection", "overallPlotDirection"],
    ["chapterFunction", "chapterFunction"],
    ["previousState", "previousState"],
    ["relevantCharacters", "relevantCharacters"],
    ["characterMotivations", "characterMotivations"],
    ["eventSummaries", "authorEventSummaries"],
    ["mustInclude", "authorMustInclude"],
    ["stateChanges", "authorStateChanges"],
    ["foreshadowing", "foreshadowing"],
    ["causalRelations", "causalRelations"],
    ["endingTarget", "endingTarget"],
    ["inviolableFacts", "inviolableFacts"],
    ["stateConstraints", "factAndCharacterKnowledgeForbiddenZones"],
  ];
  for (const [field, traceName] of contractFields) {
    const value = chapterContract[field];
    if (Array.isArray(value) && value.length > 0 && !consumedFields.includes(traceName)) {
      consumedFields.push(traceName);
    }
  }
  const promptAdapter = adaptWriterPrompt({
    profile: input.rawPromptProfile ?? resolveWriterPromptProfile({
      route: "v2_rawstage2_gemini31",
      provider: "gemini31",
      model: "gemini-3.1-pro-preview",
    }),
    chapterNumber: input.chapterNumber,
    contract: chapterContract,
    sharedContext,
  });
  const userPrompt = localizeLlmText(promptAdapter.userPrompt);
  const systemPrompt = localizeLlmText(promptAdapter.systemPrompt);
  const constitutionConsumedFields = collectConstitutionFieldsInPrompt(userPrompt, constitution);
  // Audit only system-authored instructions plus ChapterContract. evalPrefix is
  // accepted prose and may legitimately quote wording that resembles a rule.
  const auditAdapter = adaptWriterPrompt({
    profile: promptAdapter.profile,
    chapterNumber: input.chapterNumber,
    contract: chapterContract,
    sharedContext: "",
  });
  const promptConstraintAudit = auditPrompt(
    localizeLlmText(auditAdapter.systemPrompt),
    localizeLlmText(auditAdapter.userPrompt),
  );
  if (promptConstraintAudit.type === "control") {
    throw new Error("raw_prompt_prose_freedom_violation: 检测到机械正文执行约束");
  }
  const methodologyPolicy = compileMethodologyApplicationReport([
    ...consumedFields,
    ...constitutionConsumedFields,
  ]);
  if (methodologyPolicy.violations.length > 0) {
    throw new Error(`raw_prompt_methodology_authority_violation: ${methodologyPolicy.violations.join(";")}`);
  }

  return {
    systemPrompt,
    userPrompt,
    consumedFields,
    constitutionConsumedFields,
    promptConstraintAudit,
    methodologyPolicy,
    promiseContext,
    expectationContext,
    genreContract,
    dialogueCraft,
    emotionRhythm,
    supportingFunction,
    knowledgeConsumption,
    characterVoiceContext,
    worldPresentationContext,
    ensembleLayeringContext,
    identityContract,
    ontologyContract,
    chapterContract,
    promptAdapter,
  };
}

function collectConstitutionFieldsInPrompt(
  prompt: string,
  constitution: UnifiedOrchestratorInput["constitution"]
): string[] {
  if (!constitution) return [];
  const fields: string[] = [];
  const includesAny = (values: string[] | undefined): boolean =>
    Array.isArray(values) && values.some((value) => value.length > 0 && prompt.includes(value));

  if (constitution.workIdentity && prompt.includes(constitution.workIdentity)) {
    fields.push("constitution.workIdentity");
  }

  if (includesAny(constitution.readerPromise)) fields.push("constitution.readerPromise");
  if (includesAny(constitution.genrePromises)) fields.push("constitution.genrePromises");
  if (
    constitution.protagonistCoreConflict &&
    prompt.includes(constitution.protagonistCoreConflict)
  ) {
    fields.push("constitution.protagonistCoreConflict");
  }
  if (includesAny(constitution.thematicQuestions)) fields.push("constitution.thematicQuestions");
  if (includesAny(constitution.aestheticDirection)) fields.push("constitution.aestheticDirection");
  if (includesAny(constitution.forbiddenDrift)) fields.push("constitution.forbiddenDrift");
  return fields;
}

/**
 * INTENT-1：从 ChapterIntent 派生结构化摘要，写入 stageResults.chapterIntent.summary。
 *
 * 摘要只取方向性信息（功能/交付/焦点角色/承诺推进数量），不复制正文级细节，
 * 供 trace 快速辨识"本章 intent 指向什么"。缺失字段降级为"未指定"，不伪造内容。
 *
 * 返回结构化对象（而非字符串），便于 trace 消费方按字段读取，而非解析字符串。
 */
export function buildIntentSummary(intent: ChapterIntent): {
  chapterFunction: string;
  concreteDelivery: string[];
  focusCharacters: string[];
  selectedPromisesCount: number;
  irreversibleChangeCount: number;
} {
  return {
    chapterFunction: intent.chapterFunction || "未指定本章功能",
    concreteDelivery: intent.concreteDelivery ?? [],
    focusCharacters: (intent.focusCharacterGoals ?? []).map((g) => g.character),
    selectedPromisesCount: intent.selectedPromisesToAdvance?.length ?? 0,
    irreversibleChangeCount: intent.expectedIrreversibleChange?.length ?? 0,
  };
}

