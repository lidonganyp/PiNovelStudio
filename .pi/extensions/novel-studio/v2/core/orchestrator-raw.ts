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
  prebuiltPrompt: { systemPrompt: string; userPrompt: string }
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
export function buildRawPrompt(input: UnifiedOrchestratorInput): { systemPrompt: string; userPrompt: string; consumedFields: string[]; promiseContext: PromiseContext; expectationContext: ExpectationContext; genreContract: GenreContractContext; dialogueCraft: DialogueCraftContext; emotionRhythm: EmotionRhythmContext; supportingFunction: SupportingFunctionContext; knowledgeConsumption: KnowledgeConsumptionContext; characterVoiceContext: CharacterVoiceContext; worldPresentationContext: WorldPresentationContext; ensembleLayeringContext: EnsembleLayeringContext; identityContract: import("./identity-contract-compiler.js").IdentityContract; ontologyContract: OntologyContract } {
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

  parts.push(`你是顶尖网文作家。请写第${input.chapterNumber}章完整正文。标题中的章节号必须是第${input.chapterNumber}章，不得写成其他章节。`);
  parts.push("格式硬边界：不得重复输出相同段落或列表项；如需回顾同一信息，只概述一次。");
  consumedFields.push("format.noExactDuplicate");
  if (input.contextSafety) {
    parts.push(`约束清单：${input.contextSafety.manifest.manifestId} / ${input.contextSafety.manifest.manifestHash}`);
    consumedFields.push("constraintManifest");
  }

  if (intent.chapterFunction) {
    parts.push(`本章功能：${intent.chapterFunction}`);
    consumedFields.push("chapterFunction");
  }
  if (intent.readerExperience.length > 0) {
    parts.push(`读者体验目标：${intent.readerExperience.join("、")}`);
    consumedFields.push("readerExperience");
  }
  if (intent.currentPressure.length > 0) {
    parts.push(`当前压力：${intent.currentPressure.join("；")}`);
    consumedFields.push("currentPressure");
  }
  if (intent.inviolableFacts.length > 0) {
    parts.push(`不可破坏的事实（必须遵守）：${intent.inviolableFacts.join("；")}`);
    consumedFields.push("inviolableFacts");
  }
  // QUALITY-7：原 flat `本章相关角色：${relevantCharacters.join("、")}` 注入已移除，
  // 由下方 QUALITY-7 compact block（含 焦点/在场 层级标签）取代（compact block 是其严格超集）。
  if (constitution?.protagonistCoreConflict) {
    parts.push(`主角核心冲突：${constitution.protagonistCoreConflict}`);
    consumedFields.push("constitution.protagonistCoreConflict");
  }
  // QUALITY-6：原 flat worldRules.slice(0,5).map(r=>r.description) 注入已移除，
  // 由下方 QUALITY-6 compact block（含 type/chapterActivated/affectedCharacters/genrePromises）取代。
  // REAL-QUALITY-4：前章悬置状态桥接上下文（不可跳过，独立 block，不参与 facts.slice(0,10) 截断）。
  // 必须位于"已确立事实参考"之前，让模型优先承接前章末状态，避免跨章因果断裂。
  if (context.bridgeContext && context.bridgeContext.available) {
    const bc = context.bridgeContext;
    const bridgeParts: string[] = [];
    if (bc.lastEventSummary) bridgeParts.push(`前章末事件：${bc.lastEventSummary}`);
    if (bc.endingEmotion) bridgeParts.push(`结尾情绪：${bc.endingEmotion}`);
    if (bc.openHooks.length > 0) bridgeParts.push(`开放钩子：${bc.openHooks.join(" / ")}`);
    if (bc.unresolvedTensions.length > 0) bridgeParts.push(`未解张力：${bc.unresolvedTensions.join(" / ")}`);
    if (bc.introducedCharacters.length > 0) bridgeParts.push(`新登场角色：${bc.introducedCharacters.join(" / ")}`);
    if (bridgeParts.length > 0) {
      parts.push(`前章悬置状态（本章必须承接，不得跳过）：${bridgeParts.join("；")}`);
      consumedFields.push("context.bridgeContext");
    }
  }
  if (context.facts.length > 0) {
    const factStrs = context.facts.slice(0, 10).map((f) => f.content);
    parts.push(`已确立事实参考：${factStrs.join("；")}`);
    consumedFields.push("context.facts");
  }

  // ── INTENT-1：8 个新章卡字段消费（编辑型方向，非机械配额） ──
  // 每项用 optional chaining defensive 消费：stub intent（无新字段）不受影响；
  // builder 产出的真实 intent 在对应内容非空时拼入 prompt，并记入 consumedFields。
  if (intent.concreteDelivery && intent.concreteDelivery.length > 0) {
    parts.push(`本章具体交付：${intent.concreteDelivery.join("；")}`);
    consumedFields.push("concreteDelivery");
  }
  if (intent.focusCharacterGoals && intent.focusCharacterGoals.length > 0) {
    const goalStrs = intent.focusCharacterGoals.map((g) => `${g.character}——${g.goal}`);
    parts.push(`焦点角色目标：${goalStrs.join("；")}`);
    consumedFields.push("focusCharacterGoals");
  }
  if (intent.resistance && intent.resistance.length > 0) {
    parts.push(`本章阻力：${intent.resistance.join("；")}`);
    consumedFields.push("resistance");
  }
  if (intent.choicesAndCosts && intent.choicesAndCosts.length > 0) {
    const ccStrs = intent.choicesAndCosts.map((c) => `${c.choice} → 代价：${c.cost}`);
    parts.push(`选择与代价：${ccStrs.join("；")}`);
    consumedFields.push("choicesAndCosts");
  }
  if (intent.expectedIrreversibleChange && intent.expectedIrreversibleChange.length > 0) {
    parts.push(`预期不可逆变化：${intent.expectedIrreversibleChange.join("；")}`);
    consumedFields.push("expectedIrreversibleChange");
  }
  if (intent.selectedPromisesToAdvance && intent.selectedPromisesToAdvance.length > 0) {
    const paStrs = intent.selectedPromisesToAdvance.map((p) => `${p.promiseId}——${p.description}`);
    parts.push(`本章选中的承诺：${paStrs.join("；")}`);
    consumedFields.push("selectedPromisesToAdvance");
  }
  if (intent.causalEndPressure && intent.causalEndPressure.length > 0) {
    parts.push(`章末因果压力方向：${intent.causalEndPressure.join("；")}`);
    consumedFields.push("causalEndPressure");
  }
  if (intent.factAndCharacterKnowledgeForbiddenZones && intent.factAndCharacterKnowledgeForbiddenZones.length > 0) {
    parts.push(`事实与人物知识禁区：${intent.factAndCharacterKnowledgeForbiddenZones.join("；")}`);
    consumedFields.push("factAndCharacterKnowledgeForbiddenZones");
  }

  // ── QUALITY-4：本章相关承诺状态 compact block（只含 selectedPromisesToAdvance 命中项） ──
  // 非 full PromiseLedger；已 fulfilled/broken 降级为 inspect；空时不加入 prompt（emptyReason 写 stageResults）。
  // 不含 aggregateQualityScore/totalScore/对白比例/段落长度/固定冲突数等机械指标。
  if (promiseContextResult.promptBlock) {
    parts.push(promiseContextResult.promptBlock);
    consumedFields.push("promiseContext");
    promiseContext.consumedByRawPrompt = true;
  } else {
    promiseContext.consumedByRawPrompt = false;
  }

  // ── EXPECTATION-LEDGER-1：本章相关读者期待 compact block（只含 selectedExpectationsToAdvance 命中项） ──
  // 非 full ExpectationLedger；fulfilled 降级为 inspect；escalated → escalate；
  // delayed 保留 delayReason；空时不加入 prompt（emptyReason 写 stageResults）。
  // 不含 aggregateQualityScore/totalScore/固定兑现章数等机械指标。
  if (expectationContextResult.promptBlock) {
    parts.push(expectationContextResult.promptBlock);
    consumedFields.push("expectationContext");
    expectationContext.consumedByRawPrompt = true;
  } else {
    expectationContext.consumedByRawPrompt = false;
  }

  // ── GENRE-CONTRACT-1：本章类型读者承诺 compact block ──
  // 含 declaredGenre/driftGenre、entries（constitution + type-dataset 命中）、fulfillmentEvidence；
  // 空（无类型数据）时不加入 prompt（emptyReason 写 stageResults）。
  // 不含 aggregateQualityScore/totalScore/固定冲突数/固定兑现章数等机械指标；advisory 非硬门。
  if (genreContractResult.promptBlock) {
    parts.push(genreContractResult.promptBlock);
    consumedFields.push("genreContract");
    genreContract.consumedByRawPrompt = true;
  } else {
    genreContract.consumedByRawPrompt = false;
  }

  // ── DIALOGUE-CRAFT-1：本章发言角色声音指纹 compact block ──
  // 仅本章发言角色（focusCharacterGoals ∪ relevantCharacters 命中）；
  // 指纹带来源样章/接受稿；缺失时降级为 CharacterVoice 弱代理（写明 confidence + proxyNote）；
  // raw 生成前 rawText=null，对白工艺 advisory 为空（无诊断对象），canTriggerEditorialOpportunity=false；
  // 空时不加入 prompt（emptyReason 写 stageResults）。
  // 不含 aggregateQualityScore/totalScore/dialogueRatioGate/dialogueRatioThreshold/passed/blocked 等机械指标；advisory 非硬门。
  const hasReliableDialogueFingerprint = dialogueCraft.speakingCharacters.some(
    (entry) => entry.hasFingerprint && entry.recoveryMode === "fingerprint",
  );
  if (dialogueCraftResult.promptBlock && hasReliableDialogueFingerprint) {
    parts.push(dialogueCraftResult.promptBlock);
    consumedFields.push("dialogueCraft");
    dialogueCraft.consumedByRawPrompt = true;
  } else {
    dialogueCraft.consumedByRawPrompt = false;
  }

  // ── EMOTION-RHYTHM-1：本章情绪节拍 compact block ──
  // 含目标情绪（intent.readerExperience）+ 前态情绪 + 章尾情绪落点；
  // raw 生成前 rawText=null，只输出目标与前态（无转折扫描）；空时不加入 prompt（emptyReason 写 stageResults）。
  // 不含 satisfactionInterval/climaxPositionRange/emotionDensityThreshold/dialogueRatio/curveSmoothness/
  // maxOppressionLength 等机械指标；advisory 非硬门；不接管 finalText。
  if (emotionRhythmResult.promptBlock) {
    parts.push(emotionRhythmResult.promptBlock);
    consumedFields.push("emotionRhythm");
    emotionRhythm.consumedByRawPrompt = true;
  } else {
    emotionRhythm.consumedByRawPrompt = false;
  }

  // ── SUPPORTING-FUNCTION-1：配角章节功能 compact block ──
  // 含激活配角（relevantCharacters - focusCharacterGoals）的功能 hypothesis（foil/witness/obstacle/helper/cost-bearer）；
  // raw 生成前 rawText=null，功能待扫描（primaryFunction=null, verified=false）；空时不加入 prompt（emptyReason 写 stageResults）。
  // 不含 aggregateQualityScore/totalScore/minSupportingCount/maxSupportingCount/headcountQuota/rotationQuota 等机械指标；
  // 不更新永久角色身份；"companion/supporting"等静态 role 不冒充本章叙事功能；advisory 非硬门。
  if (supportingFunctionResult.promptBlock) {
    parts.push(supportingFunctionResult.promptBlock);
    consumedFields.push("supportingFunction");
    supportingFunction.consumedByRawPrompt = true;
  } else {
    supportingFunction.consumedByRawPrompt = false;
  }

  // ── KNOWLEDGE-CONSUMPTION-1：参考示例 compact block ──
  // 含每条示例的 provenance(source)/qualityScore/selectionReason(匹配维度)/tokenCost 估算；
  // manifestApproved=false 或无匹配示例时不加入 prompt（emptyReason 写 stageResults）。
  // 不含 forcedImitation/mandatoryTemplate/requiredExamples 等强制字段；
  // advisory 非强制模仿；不接管 finalText；不阻断正文生成。
  if (knowledgeConsumptionResult.promptBlock) {
    parts.push(knowledgeConsumptionResult.promptBlock);
    consumedFields.push("knowledgeConsumption");
    knowledgeConsumption.consumedByRawPrompt = true;
  } else {
    knowledgeConsumption.consumedByRawPrompt = false;
  }

  // ── QUALITY-5：本章相关角色状态提示 compact block ──
  // 非 full characterStates；intent-only 不进入 prompt（voiceHints 为空时过滤）；
  // 空时不加入 prompt（emptyReason 写 stageResults）。
  // 不含 aggregateQualityScore/totalScore/对白比例/段落长度/固定冲突数等机械指标。
  if (characterVoiceResult.promptBlock) {
    parts.push(characterVoiceResult.promptBlock);
    consumedFields.push("characterVoiceContext");
    characterVoiceContext.consumedByRawPrompt = true;
  } else {
    characterVoiceContext.consumedByRawPrompt = false;
  }

  // ── QUALITY-6：本章世界约束 compact block（类型标注 + 本章激活标记 + 类型承诺） ──
  // 取代原 flat first-5 description 注入（compact block 是其严格超集，含 type/chapterActivated/affectedCharacters/genrePromises）；
  // 空时不加入 prompt（emptyReason 写 stageResults）。
  // 不含 aggregateQualityScore/totalScore/对白比例/段落长度/固定冲突数等机械指标。
  if (worldPresentationResult.promptBlock) {
    parts.push(worldPresentationResult.promptBlock);
    consumedFields.push("worldPresentationContext");
    worldPresentationContext.consumedByRawPrompt = true;
  } else {
    worldPresentationContext.consumedByRawPrompt = false;
  }

  // ── QUALITY-7：本章角色层次 compact block（焦点/在场分层） ──
  // 取代原 flat `本章相关角色：` 名字注入（compact block 是其严格超集，含 焦点/在场 层级标签）；
  // 空时不加入 prompt（emptyReason 写 stageResults）。
  // 不含 aggregateQualityScore/totalScore/对白比例/段落长度/固定冲突数/人数配额等机械指标。
  if (ensembleLayeringResult.promptBlock) {
    parts.push(ensembleLayeringResult.promptBlock);
    consumedFields.push("ensembleLayeringContext");
    ensembleLayeringContext.consumedByRawPrompt = true;
  } else {
    ensembleLayeringContext.consumedByRawPrompt = false;
  }

  parts.push("要求：写出自然流畅的中文网文章节正文，有完整的情节推进、角色行动和章末钩子。不要写大纲或注释，直接输出正文。");

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

  return {
    systemPrompt: "你是顶尖网文作家，擅长写出自然流畅、有张力的中文网文章节。",
    userPrompt: parts.join("\n\n"),
    consumedFields,
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
  };
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

