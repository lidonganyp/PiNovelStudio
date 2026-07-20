/**
 * EmotionRhythmCompiler — 事件驱动情绪节拍 advisory 编译（EMOTION-RHYTHM-1，计划 §6.3）
 *
 * 目标：在 raw 生成前 + raw 生成后，从 ChapterIntent.readerExperience（目标情绪）+
 * previousEmotionState（前态）+ rawText（情绪转折扫描）编译出"事件驱动情绪节拍"的
 * compact block + advisory，让 raw prompt 能看到目标情绪与前态（不含机械曲线配额），
 * 并让 editorial opportunity detector 能消费事件驱动的情绪转折 advisory（不直接覆盖 raw）。
 *
 * 核心不变量（EMOTION-RHYTHM-1 任务书）：
 * - 每个情绪转折引用同主体、先于转折的触发事件 span；无可靠归因标 unverified。
 * - prompt 只含目标与前态，不含机械曲线配额（satisfactionInterval/climaxPositionRange/
 *   emotionDensityThreshold/dialogueRatio/curveSmoothness/maxOppressionLength）。
 * - 纯情绪词频变化不能自动算事件驱动（必须有事件触发动词支撑才 verified=true）。
 * - 旧 Stage5 rewrite 回环不得进入生产主链路（advisoryOnly=true；不返回 rewriteRaw/patchRaw）。
 * - 无可靠事件链时只输出 human-review focus（不伪造转折）。
 * - 不调用 LLM；不修改 finalText；不提交状态；不是 gate；不阻断正文生成。
 *
 * 确定性本地编译：零 LLM 调用，纯词典匹配 + span 提取。
 */

import type { ChapterIntent } from "./chapter-intent-builder.js";

// ============================================================================
// 数据契约
// ============================================================================

/**
 * 单条情绪转折 advisory。
 */
export interface EmotionTransition {
  /** 起始情绪（可为 null：首章或无前态） */
  from: string | null;
  /** 转折后情绪 */
  to: string;
  /**
   * 触发事件 span（在 rawText 中的字符区间）。
   * verified=true 时非空，指向事件触发动词位置。
   * verified=false 时为 null（纯情绪词频变化，无事件触发证据）。
   */
  triggerEventSpan: { start: number; end: number; excerpt?: string } | null;
  /** 触发证据（为什么认为这是触发事件；verified=false 时说明为何无法验证） */
  triggerEvidence: string;
  /** 是否已验证为事件驱动（triggerEventSpan 非空且指向事件触发动词） */
  verified: boolean;
  /** 置信度 [0,1]：verified 0.7 / unverified 0.3 */
  confidence: number;
  /** 转折在 rawText 中的大致位置（to 情绪词的 offset） */
  transitionOffset: number;
}

/**
 * 事件驱动情绪节拍编译结果。
 * 写入 stageResults.emotionRhythm 供 trace 审计。
 */
export interface EmotionRhythmContext {
  /** 本章目标情绪（来自 intent.readerExperience） */
  targetEmotions: string[];
  /** 前态情绪（来自 previousEmotionState 入参，可为 null） */
  previousEmotionState: string | null;
  /** 情绪转折列表（仅当 rawText 提供时存在） */
  emotionTransitions: EmotionTransition[];
  /** 章尾情绪落点（从 rawText 末尾检测；rawText 为 null 时为 null） */
  chapterEndEmotion: string | null;
  /** 来源汇总（去重） */
  sourceRefs: string[];
  /** raw prompt 是否实际消费了该 compact block */
  consumedByRawPrompt: boolean;
  /** advisoryOnly 恒为 true：诊断只读，不直接覆盖 raw */
  advisoryOnly: true;
  /** 是否可触发 editorial opportunity（有 verified 转折时 true） */
  canTriggerEditorialOpportunity: boolean;
  /** 人工审阅焦点（无可靠事件链时输出，引导人工检查） */
  humanReviewFocus: string | null;
  /** 空状态原因（不得静默，必须写明） */
  emptyReason?: string;
}

/**
 * 编译输入。
 */
export interface EmotionRhythmCompileInput {
  intent: ChapterIntent;
  /** raw 正文（用于情绪转折 + 事件触发 span 提取）；raw 生成前传 null */
  rawText: string | null;
  /** 前态情绪（来自 longTermState 或 seed.previousChapterContinuation.endingEmotion） */
  previousEmotionState: string | null;
}

/**
 * 编译输出。
 */
export interface EmotionRhythmCompileResult {
  emotionRhythmContext: EmotionRhythmContext;
  /** 格式化后的"本章情绪节拍"prompt 区块；targetEmotions 为空且无前态时返回 null */
  promptBlock: string | null;
}

// ============================================================================
// 常量与词典
// ============================================================================

/** verified 转折的置信度（事件触发证据支撑） */
const CONFIDENCE_VERIFIED = 0.7;
/** unverified 转折的置信度（纯情绪词频变化，无事件触发证据） */
const CONFIDENCE_UNVERIFIED = 0.3;

/**
 * 情绪词词典（保守，只收常见网文情绪词）。
 * 用于在 rawText 中定位情绪出现位置。
 */
const EMOTION_WORDS: readonly string[] = [
  "紧张", "期待", "震撼", "恐惧", "害怕", "愤怒", "怒火", "悲伤", "悲伤",
  "喜悦", "高兴", "快乐", "平静", "安宁", "坚定", "犹豫", "绝望", "希望",
  "惊讶", "震惊", "欣慰", "失落", "孤独", "温暖", "冷酷", "焦虑", "慌张",
  "镇定", "勇敢", "怯懦", "思念", "怀念", "悔恨", "愧疚", "骄傲", "自卑",
];

/**
 * 事件触发动词词典（保守，只收明确的事件/选择/后果动词）。
 * 用于判定情绪转折是否有事件触发证据。
 */
const EVENT_TRIGGER_VERBS: readonly string[] = [
  "决定", "选择", "离开", "留下", "揭露", "坦白", "认罪", "屈服",
  "背叛", "投靠", "放弃", "承担", "跳下", "跳进", "抓住", "推开",
  "拔出", "举起", "放下", "转身", "冲进", "冲出", "逃离", "返回",
  "答应", "拒绝", "进攻", "撤退", "出手", "收手", "开口", "闭嘴",
  "倒下", "站起", "跪下", "拥抱", "推开", "亲吻", "杀死", "救出",
];

/** 转折点向前接受触发事件的最大因果距离（字符） */
const EVENT_TRIGGER_WINDOW = 80;

interface TextSpan {
  start: number;
  end: number;
}

// ============================================================================
// 核心编译逻辑
// ============================================================================

/**
 * 编译事件驱动情绪节拍 advisory。
 *
 * 编译规则（保守）：
 * 1. targetEmotions = intent.readerExperience（空时为 []）。
 * 2. previousEmotionState 直接采用入参（null 表示无前态）。
 * 3. rawText 非空时：
 *    a. 扫描所有情绪词出现位置（offset + word）
 *    b. 检测转折：相邻情绪词不同时记录转折（from=前情绪, to=后情绪）
 *    c. 对每个转折，只在当前句/前一句且位于转折之前的 EVENT_TRIGGER_WINDOW 内搜索事件动词
 *    d. 事件主体与转折主体可归因且一致 → verified=true, span=动词位置
 *    e. 未找到 → verified=false, span=null, evidence=说明无事件触发证据
 * 4. chapterEndEmotion = 最后一个情绪词（无则为 null）
 * 5. canTriggerEditorialOpportunity = any verified
 * 6. humanReviewFocus：有转折但全 unverified 时输出；无 rawText 时输出"待 raw 生成后扫描"
 * 7. 空（无 targetEmotions + 无 previousEmotionState + 无 rawText）→ emptyReason + promptBlock=null
 *
 * 不调用 LLM，不修改 finalText，不提交状态，不是 gate。
 */
export function compileEmotionRhythmContext(
  input: EmotionRhythmCompileInput
): EmotionRhythmCompileResult {
  const { intent, rawText, previousEmotionState } = input;

  const targetEmotions = [...(intent.readerExperience ?? [])];
  const sourceRefSet = new Set<string>();
  if (targetEmotions.length > 0) {
    sourceRefSet.add("intent:readerExperience");
  }
  if (previousEmotionState) {
    sourceRefSet.add("previousEmotionState");
  }

  // 扫描 rawText
  const emotionTransitions: EmotionTransition[] = [];
  let chapterEndEmotion: string | null = null;
  let humanReviewFocus: string | null = null;

  if (rawText && rawText.length > 0) {
    const emotionHits = scanEmotionHits(rawText);
    if (emotionHits.length > 0) {
      chapterEndEmotion = emotionHits[emotionHits.length - 1].word;
      // 检测转折
      for (let i = 1; i < emotionHits.length; i++) {
        const prev = emotionHits[i - 1];
        const curr = emotionHits[i];
        if (prev.word !== curr.word) {
          const transition = buildTransition(
            prev.word,
            curr.word,
            curr.offset,
            rawText,
            intent.relevantCharacters ?? []
          );
          emotionTransitions.push(transition);
        }
      }
    }

    // humanReviewFocus 逻辑
    const verifiedCount = emotionTransitions.filter((t) => t.verified).length;
    const unverifiedCount = emotionTransitions.length - verifiedCount;
    if (emotionTransitions.length > 0 && verifiedCount === 0) {
      humanReviewFocus = `检测到 ${emotionTransitions.length} 处情绪转折但均无事件触发证据（纯情绪词频变化），需人工确认是否有事件驱动`;
    }
  } else {
    // 无 rawText：raw 生成前阶段
    if (targetEmotions.length > 0 || previousEmotionState) {
      humanReviewFocus = "raw 生成前无正文可扫描；待 raw 生成后再次调用以检测事件驱动转折";
    }
  }

  const canTriggerEditorialOpportunity = emotionTransitions.some((t) => t.verified);

  // 空状态处理
  if (targetEmotions.length === 0 && !previousEmotionState && !rawText) {
    const ctx: EmotionRhythmContext = {
      targetEmotions: [],
      previousEmotionState: null,
      emotionTransitions: [],
      chapterEndEmotion: null,
      sourceRefs: [],
      consumedByRawPrompt: false,
      advisoryOnly: true,
      canTriggerEditorialOpportunity: false,
      humanReviewFocus: null,
      emptyReason: "无 targetEmotions（intent.readerExperience 为空）且无 previousEmotionState 且无 rawText，本章无可用情绪节拍数据（不伪造）",
    };
    return { emotionRhythmContext: ctx, promptBlock: null };
  }

  const ctx: EmotionRhythmContext = {
    targetEmotions,
    previousEmotionState,
    emotionTransitions,
    chapterEndEmotion,
    sourceRefs: Array.from(sourceRefSet),
    consumedByRawPrompt: false,
    advisoryOnly: true,
    canTriggerEditorialOpportunity,
    humanReviewFocus,
  };

  const promptBlock = formatEmotionRhythmPromptBlock(ctx);
  if (promptBlock === null) {
    ctx.consumedByRawPrompt = false;
  }
  return { emotionRhythmContext: ctx, promptBlock };
}

// ============================================================================
// 辅助：扫描情绪词
// ============================================================================

interface EmotionHit {
  word: string;
  offset: number;
}

/**
 * 在 rawText 中扫描所有情绪词出现位置。
 * 按 offset 排序（从前到后）。
 */
function scanEmotionHits(rawText: string): EmotionHit[] {
  const hits: EmotionHit[] = [];
  for (const word of EMOTION_WORDS) {
    let searchFrom = 0;
    while (true) {
      const idx = rawText.indexOf(word, searchFrom);
      if (idx === -1) break;
      hits.push({ word, offset: idx });
      searchFrom = idx + word.length;
    }
  }
  hits.sort((a, b) => a.offset - b.offset);
  return hits;
}

// ============================================================================
// 辅助：构建转折 + 搜索事件触发证据
// ============================================================================

function buildTransition(
  from: string,
  to: string,
  toOffset: number,
  rawText: string,
  relevantCharacters: string[]
): EmotionTransition {
  const trigger = findCausallyRelatedTrigger(
    rawText,
    toOffset,
    relevantCharacters
  );

  if (trigger) {
    // verified：事件触发证据找到
    return {
      from,
      to,
      triggerEventSpan: {
        start: trigger.start,
        end: trigger.end,
        excerpt: rawText.slice(trigger.start, Math.min(trigger.end + 20, rawText.length)),
      },
      triggerEvidence: `情绪转折 "${from}→${to}" 的同主体相邻语境检测到事件触发动词"${trigger.verb}"，判定为事件驱动`,
      verified: true,
      confidence: CONFIDENCE_VERIFIED,
      transitionOffset: toOffset,
    };
  }

  // unverified：纯情绪词频变化，无事件触发证据
  return {
    from,
    to,
    triggerEventSpan: null,
    triggerEvidence: `情绪转折 "${from}→${to}" 未找到可归因且先于转折的事件触发证据，标 unverified`,
    verified: false,
    confidence: CONFIDENCE_UNVERIFIED,
    transitionOffset: toOffset,
  };
}

function findCausallyRelatedTrigger(
  rawText: string,
  transitionOffset: number,
  relevantCharacters: string[]
): { verb: string; start: number; end: number } | null {
  const sentenceSpans = splitTextSpans(rawText, /[。！？!?；;\n]/u);
  const transitionSentenceIndex = sentenceSpans.findIndex(
    (span) => transitionOffset >= span.start && transitionOffset < span.end
  );
  if (transitionSentenceIndex < 0) {
    return null;
  }

  const transitionSentence = sentenceSpans[transitionSentenceIndex];
  const candidateSpans = [
    transitionSentence,
    sentenceSpans[transitionSentenceIndex - 1],
  ].filter((span): span is TextSpan => Boolean(span));

  const candidates: Array<{ verb: string; start: number; end: number; sentence: TextSpan }> = [];
  for (const sentence of candidateSpans) {
    for (const verb of EVENT_TRIGGER_VERBS) {
      let searchFrom = sentence.start;
      while (searchFrom < sentence.end) {
        const start = rawText.indexOf(verb, searchFrom);
        if (start < 0 || start >= sentence.end) break;
        candidates.push({ verb, start, end: start + verb.length, sentence });
        searchFrom = start + verb.length;
      }
    }
  }

  candidates.sort(
    (a, b) => Math.abs(a.start - transitionOffset) - Math.abs(b.start - transitionOffset)
  );
  for (const candidate of candidates) {
    if (
      candidate.end <= transitionOffset &&
      Math.abs(candidate.start - transitionOffset) <= EVENT_TRIGGER_WINDOW &&
      hasCompatibleActorEvidence(
        rawText,
        candidate.start,
        candidate.sentence,
        transitionOffset,
        transitionSentence,
        relevantCharacters
      )
    ) {
      return { verb: candidate.verb, start: candidate.start, end: candidate.end };
    }
  }
  return null;
}

function hasCompatibleActorEvidence(
  rawText: string,
  triggerOffset: number,
  triggerSentence: TextSpan,
  transitionOffset: number,
  transitionSentence: TextSpan,
  relevantCharacters: string[]
): boolean {
  const characters = relevantCharacters.filter((name) => name.trim().length > 0);
  if (characters.length === 0) return false;

  const triggerActor = resolveNarrativeActor(
    rawText,
    triggerSentence,
    triggerOffset,
    characters
  );
  const transitionActor = resolveNarrativeActor(
    rawText,
    transitionSentence,
    transitionOffset,
    characters
  );

  return Boolean(triggerActor && transitionActor && triggerActor === transitionActor);
}

function splitTextSpans(
  rawText: string,
  delimiter: RegExp,
  bounds: TextSpan = { start: 0, end: rawText.length }
): TextSpan[] {
  const spans: TextSpan[] = [];
  let start = bounds.start;
  for (let index = bounds.start; index < bounds.end; index++) {
    if (!delimiter.test(rawText[index])) continue;
    if (rawText.slice(start, index).trim().length > 0) {
      spans.push({ start, end: index + 1 });
    }
    start = index + 1;
  }
  if (rawText.slice(start, bounds.end).trim().length > 0) {
    spans.push({ start, end: bounds.end });
  }
  return spans;
}

function findNearestNamedCharacterBefore(
  rawText: string,
  span: TextSpan,
  offset: number,
  characters: string[]
): string | null {
  const text = rawText.slice(span.start, Math.min(offset, span.end));
  let nearestCharacter: string | null = null;
  let nearestOffset = -1;
  for (const character of characters) {
    const characterOffset = text.lastIndexOf(character);
    if (
      characterOffset > nearestOffset ||
      (characterOffset === nearestOffset && characterOffset >= 0 &&
        character.length > (nearestCharacter?.length ?? 0))
    ) {
      nearestCharacter = character;
      nearestOffset = characterOffset;
    }
  }
  return nearestCharacter;
}

function resolveNarrativeActor(
  rawText: string,
  sentence: TextSpan,
  offset: number,
  characters: string[]
): string | null {
  const explicitActor = findNearestNamedCharacterBefore(
    rawText,
    sentence,
    offset,
    characters
  );
  if (explicitActor) return explicitActor;

  const sentencePrefix = rawText.slice(sentence.start, Math.min(offset, sentence.end));
  const hasThirdPersonPronoun = /(?:^|[，,。！？!?；;：:\s])(?:他们|她们|他|她)/u.test(
    sentencePrefix
  );
  if (!hasThirdPersonPronoun || sentence.start === 0) return null;

  return findNearestNamedCharacterBefore(
    rawText,
    { start: 0, end: sentence.start },
    sentence.start,
    characters
  );
}

// ============================================================================
// Prompt block 格式化
// ============================================================================

/**
 * 把 EmotionRhythmContext 格式化为 raw prompt 的"本章情绪节拍"区块。
 *
 * 格式（确定性，无 LLM）：
 * ```
 * 本章情绪节拍（advisory 非硬门；不含机械曲线配额）：
 * 目标情绪：紧张、期待
 * 前态情绪：平静
 * 章尾情绪落点：希望（待 raw 生成后扫描验证）
 * ```
 *
 * targetEmotions 为空且无 previousEmotionState 时返回 null。
 * raw 生成前（rawText=null）只输出目标与前态，不输出转折（无 rawText 可扫描）。
 * 不含 satisfactionInterval/climaxPositionRange/emotionDensityThreshold/dialogueRatio 等机械指标。
 */
export function formatEmotionRhythmPromptBlock(context: EmotionRhythmContext): string | null {
  if (context.targetEmotions.length === 0 && !context.previousEmotionState) {
    return null;
  }

  const lines: string[] = [];
  lines.push("本章情绪节拍（advisory 非硬门；不含机械曲线配额）：");

  if (context.targetEmotions.length > 0) {
    lines.push(`目标情绪：${context.targetEmotions.join("、")}`);
  }
  if (context.previousEmotionState) {
    lines.push(`前态情绪：${context.previousEmotionState}`);
  }
  if (context.chapterEndEmotion) {
    lines.push(`章尾情绪落点：${context.chapterEndEmotion}`);
  } else {
    lines.push("章尾情绪落点：待 raw 生成后扫描验证");
  }

  if (context.emotionTransitions.length > 0) {
    const verified = context.emotionTransitions.filter((t) => t.verified).length;
    const unverified = context.emotionTransitions.length - verified;
    lines.push(`情绪转折：${context.emotionTransitions.length} 处（${verified} 事件驱动 verified, ${unverified} unverified）`);
  }

  if (context.humanReviewFocus) {
    lines.push(`人工审阅焦点：${context.humanReviewFocus}`);
  }

  return lines.join("\n");
}

// ============================================================================
// Skipped 构造（用于 hardBlock / 异常路径，保证 stageResults 不静默）
// ============================================================================

/**
 * 构造 skipped EmotionRhythmContext（用于 hardBlock / raw 生成失败路径）。
 * 与 QUALITY-4/5/6 skipped 构造同模式：失败路径写 reason，不静默。
 */
export function skippedEmotionRhythm(reason: string): EmotionRhythmContext {
  return {
    targetEmotions: [],
    previousEmotionState: null,
    emotionTransitions: [],
    chapterEndEmotion: null,
    sourceRefs: [],
    consumedByRawPrompt: false,
    advisoryOnly: true,
    canTriggerEditorialOpportunity: false,
    humanReviewFocus: null,
    emptyReason: `skipped: ${reason}`,
  };
}
