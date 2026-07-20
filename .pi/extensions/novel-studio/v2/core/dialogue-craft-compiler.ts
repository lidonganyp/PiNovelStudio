/**
 * DialogueCraftCompiler — 本章发言角色声音指纹与对白工艺 advisory 编译（DIALOGUE-CRAFT-1，计划 §6.3）
 *
 * 目标：在 raw 生成前 + raw 生成后，从 ChapterIntent.relevantCharacters +
 * VoiceFingerprintV2（带来源样章/接受稿）+ CharacterStateFact（弱代理降级）+
 * DialogueCraftGate 三规则（带 span）编译出"本章发言角色声音指纹 + 对白工艺 advisory"
 * 的 compact block，让 raw prompt 能看到本章发言角色的指纹/弱代理提示，并让
 * editorial opportunity detector 能消费对白工艺诊断 advisory（不直接覆盖 raw）。
 *
 * 核心不变量（DIALOGUE-CRAFT-1 任务书）：
 * - 仅本章发言角色（focusCharacterGoals.character ∪ relevantCharacters 命中）进入 prompt。
 * - 指纹带来源样章/接受稿（sourceChapterRef + sourceType）；sourceChapterRef 缺失不进入 fingerprint。
 * - 对白功能、归属、动作标签诊断带 span（仅当 rawText 提供时；rawText 为 null 时无诊断）。
 * - 诊断可触发机会候选但不直接覆盖 raw（advisoryOnly=true；不返回 rewriteRaw/patchRaw/overrideRaw）。
 * - 无两名已注册发言者（有指纹）时不得伪造盲测（blindTestEligible=false）。
 * - 删除指纹来源（sourceChapterRef 为空）后不得进入 prompt fingerprint（降级为弱代理）。
 * - 对话比例不得成为 gate（不暴露 dialogueRatioGate/threshold/hardBlock/passed/blocked）。
 * - 指纹缺失时退化到现有 CharacterVoice 弱代理（mentality/pendingTension）并写明 confidence。
 * - 不调用 LLM；不修改 finalText；不提交状态；不是 gate；不阻断正文生成。
 *
 * 确定性本地编译：零 LLM 调用，纯结构化字段映射 + 复用 DialogueCraftGate 本地规则。
 */

import type { ChapterIntent } from "./chapter-intent-builder.js";
import type { CharacterStateFact } from "./types.js";
import type { VoiceFingerprintV2 } from "../../craft/voice-fingerprint.js";
import {
  parseDialogueLinesFromText,
  checkRule1Increment,
  checkRule2Attribution,
  checkRule3ActionTagInfo,
  type DialogueLine,
  type DialogueCraftViolation,
} from "../../craft/dialogue-craft-gate.js";

// ============================================================================
// 数据契约
// ============================================================================

/**
 * 输入：本章发言角色声音指纹（来自接受稿/样章抽取）。
 * 来源必填：sourceChapterRef 为空时该指纹不进入 prompt fingerprint（降级为弱代理）。
 */
export interface VoiceFingerprintInput {
  characterId: string;
  characterName: string;
  fingerprint: VoiceFingerprintV2;
  /** 来源样章/接受稿路径，如 "chapters/ch12-accepted.md"；为空则视为指纹来源已删除 */
  sourceChapterRef: string;
  /** 来源类型：accepted_manuscript（接受稿）/ chapter_sample（样章） */
  sourceType: "accepted_manuscript" | "chapter_sample";
}

/**
 * 单条本章发言角色 compact 条目。
 */
export interface SpeakingCharacterEntry {
  /** 角色 id（与 CharacterStateFact.characterId / VoiceFingerprintInput.characterId 一致） */
  characterId: string;
  /** 角色名 */
  name: string;
  /** 是否有可用指纹（sourceChapterRef 非空且 fingerprint 校验通过） */
  hasFingerprint: boolean;
  /**
   * 指纹摘要（仅 hasFingerprint=true 时存在）：
   * - vocabularyLevel / infoPattern / 自称习惯 / 称呼习惯
   * 用于 prompt 让模型感知本章发言角色的声音特征。
   */
  fingerprintSummary?: string;
  /** 指纹来源引用（hasFingerprint=true 时非空） */
  fingerprintSourceRef: string | null;
  /** 指纹来源类型（hasFingerprint=true 时存在） */
  fingerprintSourceType?: "accepted_manuscript" | "chapter_sample";
  /**
   * 降级模式：
   * - "fingerprint"：有指纹（hasFingerprint=true）
   * - "character_voice_weak_proxy"：无指纹但有 characterState（mentality/pendingTension 弱代理）
   * - "intent_only_no_voice"：无指纹且无 state（仅 intent 提及，无任何声音线索）
   */
  recoveryMode: "fingerprint" | "character_voice_weak_proxy" | "intent_only_no_voice";
  /** 弱代理提示（recoveryMode=character_voice_weak_proxy 时存在，含 mentality/pendingTension） */
  weakProxyHints?: string[];
  /** 来源引用，如 "voice-fingerprint:ch12-accepted" 或 "characterStates:林川" 或 "intent-only:林川" */
  sourceRef: string;
  /** 置信度 [0,1]：fingerprint 0.7 / weak_proxy 0.3 / intent_only 0.2 */
  confidence: number;
}

/**
 * 对白工艺诊断 advisory（rule 1/2/3 命中时产生；仅当 rawText 提供时存在）。
 */
export interface DialogueCraftAdvisoryItem {
  /** 规则编号：1=3 轮纯对白必证增量 / 2=标签删除归属清楚 / 3=动作标签有信息量 */
  rule: 1 | 2 | 3;
  /** 规则名 */
  ruleName: string;
  /** 严重度：warning / critical（来自 DialogueCraftViolation） */
  severity: "warning" | "critical";
  /** 证据（来自 DialogueCraftViolation.evidence） */
  evidence: string;
  /** 行号（来自 DialogueCraftViolation.lineIndex） */
  lineIndex: number;
  /** span（在 rawText 中的字符区间）；rawText 为 null 时不存在 */
  span?: { start: number; end: number; excerpt?: string };
}

/**
 * 本章发言角色声音指纹 + 对白工艺编译结果。
 * 写入 stageResults.dialogueCraft 供 trace 审计。
 */
export interface DialogueCraftContext {
  /** 本章发言角色条目（仅 focusCharacterGoals ∪ relevantCharacters 命中项） */
  speakingCharacters: SpeakingCharacterEntry[];
  /** 是否可盲测（≥2 名 speakingCharacters 有指纹） */
  blindTestEligible: boolean;
  /** 对白工艺诊断 advisory（仅当 rawText 提供时存在） */
  dialogueCraftAdvisory: DialogueCraftAdvisoryItem[];
  /** 来源汇总（去重） */
  sourceRefs: string[];
  /** raw prompt 是否实际消费了该 compact block */
  consumedByRawPrompt: boolean;
  /** advisoryOnly 恒为 true：诊断只读，不直接覆盖 raw */
  advisoryOnly: true;
  /** 是否可触发 editorial opportunity（有 advisory 命中时 true） */
  canTriggerEditorialOpportunity: boolean;
  /** 弱代理性质声明（任一 speakingCharacters 为弱代理时存在） */
  proxyNote?: string;
  /** 空状态原因（不得静默，必须写明） */
  emptyReason?: string;
}

/**
 * 编译输入：从 orchestrator 传入的 intent + voiceFingerprints + characterStates + rawText。
 */
export interface DialogueCraftCompileInput {
  intent: ChapterIntent;
  /** 本章可用指纹（来自外部加载器，L0 阶段调用方可传空数组） */
  voiceFingerprints: VoiceFingerprintInput[];
  /** CompiledContext.characterStates，用于无指纹时弱代理降级 */
  characterStates?: CharacterStateFact[] | null;
  /** raw 正文（用于对白工艺诊断 span 提取）；raw 生成前传 null */
  rawText: string | null;
}

/**
 * 编译输出：DialogueCraftContext + 格式化后的 prompt block（空时 null）。
 */
export interface DialogueCraftCompileResult {
  dialogueCraftContext: DialogueCraftContext;
  /** 格式化后的"本章发言角色声音指纹"prompt 区块；speakingCharacters 为空时返回 null */
  promptBlock: string | null;
}

// ============================================================================
// 常量
// ============================================================================

/** 指纹来源接受稿/样章，高置信度（与 constitution 同档） */
const CONFIDENCE_FINGERPRINT = 0.7;
/** CharacterVoice 弱代理（mentality/pendingTension 借作声音代理，间接性高） */
const CONFIDENCE_WEAK_PROXY = 0.3;
/** intent-only（无任何声音线索） */
const CONFIDENCE_INTENT_ONLY = 0.2;

/** 盲测最少发言者数（≥2 才可盲测） */
const BLIND_TEST_MIN_SPEAKERS = 2;

/**
 * 弱代理性质声明（固定文案）。
 * 防止下游消费者误以为 weakProxyHints 是完整 voice fingerprint。
 */
const PROXY_NOTE =
  "本 compact block 中 recoveryMode=character_voice_weak_proxy 的角色仅用 CharacterStateFact 的 mentality/pendingTension 作为弱代理；" +
  "完整 voice fingerprint（句式/词汇/称呼习惯）需从接受稿/样章抽取，本编译器不调用模型抽取";

// ============================================================================
// 核心编译逻辑
// ============================================================================

/**
 * 编译本章发言角色声音指纹 + 对白工艺 advisory。
 *
 * 编译规则（保守）：
 * 1. 选择 = focusCharacterGoals.character ∪ relevantCharacters（并集去重）。
 * 2. 每个角色查 voiceFingerprints：
 *    a. characterId 命中且 sourceChapterRef 非空 → hasFingerprint=true, recoveryMode=fingerprint
 *    b. characterId 命中但 sourceChapterRef 空 → 视为指纹来源已删除，降级到弱代理
 *    c. characterId 未命中 → 降级到 characterStates 弱代理（mentality/pendingTension）
 *    d. characterStates 也未命中 → recoveryMode=intent_only_no_voice
 * 3. blindTestEligible = count(hasFingerprint=true) >= 2
 * 4. rawText 非空时，parseDialogueLinesFromText + 三规则检测，violations → advisory with span
 * 5. canTriggerEditorialOpportunity = dialogueCraftAdvisory.length > 0
 * 6. 空（无 speakingCharacters）→ emptyReason + promptBlock=null，不伪造。
 *
 * 不调用 LLM，不修改 finalText，不提交状态，不是 gate。
 */
export function compileDialogueCraftContext(
  input: DialogueCraftCompileInput
): DialogueCraftCompileResult {
  const { intent, voiceFingerprints, characterStates, rawText } = input;

  // 1. 本章发言角色 = focusCharacterGoals.character ∪ relevantCharacters
  const focusChars = (intent.focusCharacterGoals ?? []).map((g) => g.character);
  const relevantChars = intent.relevantCharacters ?? [];
  const speakingCharNames = Array.from(new Set([...focusChars, ...relevantChars]));

  // 2. 构建指纹索引：characterId → VoiceFingerprintInput
  const fingerprintMap = new Map<string, VoiceFingerprintInput>();
  for (const fp of voiceFingerprints) {
    // 同一角色多条指纹：取第一条有效（sourceChapterRef 非空）的；后续覆盖不阻塞
    fingerprintMap.set(fp.characterId, fp);
  }

  // 3. 构建 characterStates 索引：characterId/name → CharacterStateFact
  const stateMap = new Map<string, CharacterStateFact>();
  for (const cs of characterStates ?? []) {
    stateMap.set(cs.characterId, cs);
    // 也按 name 索引（characterId 通常等于 name，但防御性）
    if (cs.name && cs.name !== cs.characterId) {
      stateMap.set(cs.name, cs);
    }
  }

  // 4. 构建 speakingCharacters
  const speakingCharacters: SpeakingCharacterEntry[] = [];
  const sourceRefSet = new Set<string>();
  let fingerprintCount = 0;
  let weakProxyCount = 0;

  for (const charName of speakingCharNames) {
    const fp = fingerprintMap.get(charName);
    const state = stateMap.get(charName);

    // 指纹有效条件：fp 存在 且 sourceChapterRef 非空 且 fingerprint 字段存在
    const hasValidFingerprint = !!fp && !!fp.sourceChapterRef && !!fp.fingerprint;

    if (hasValidFingerprint && fp) {
      // 模式 A：有指纹
      const summary = summarizeFingerprint(fp.fingerprint, fp.characterName);
      speakingCharacters.push({
        characterId: fp.characterId,
        name: fp.characterName,
        hasFingerprint: true,
        fingerprintSummary: summary,
        fingerprintSourceRef: fp.sourceChapterRef,
        fingerprintSourceType: fp.sourceType,
        recoveryMode: "fingerprint",
        sourceRef: `voice-fingerprint:${fp.sourceChapterRef}`,
        confidence: CONFIDENCE_FINGERPRINT,
      });
      sourceRefSet.add(`voice-fingerprint:${fp.sourceChapterRef}`);
      fingerprintCount++;
    } else if (state) {
      // 模式 B：无指纹但有 state，降级为 CharacterVoice 弱代理
      const mentality = typeof state.state?.mentality === "string" ? state.state.mentality : "";
      const pendingTension = typeof state.state?.pendingTension === "string" ? state.state.pendingTension : "";
      const role = typeof state.state?.role === "string" ? state.state.role : "";
      const weakProxyHints = [mentality, pendingTension].filter((s) => !!s);
      speakingCharacters.push({
        characterId: state.characterId,
        name: state.name,
        hasFingerprint: false,
        fingerprintSourceRef: null,
        recoveryMode: "character_voice_weak_proxy",
        weakProxyHints,
        sourceRef: `characterStates:${state.characterId}`,
        confidence: CONFIDENCE_WEAK_PROXY,
      });
      sourceRefSet.add(`characterStates:${state.characterId}`);
      weakProxyCount++;
      // role 单独记录到 sourceRefs（便于追溯）
      if (role) sourceRefSet.add(`characterStates:${state.characterId}:role`);
    } else {
      // 模式 C：无指纹且无 state
      speakingCharacters.push({
        characterId: charName,
        name: charName,
        hasFingerprint: false,
        fingerprintSourceRef: null,
        recoveryMode: "intent_only_no_voice",
        sourceRef: `intent-only:${charName}`,
        confidence: CONFIDENCE_INTENT_ONLY,
      });
      sourceRefSet.add(`intent-only:${charName}`);
    }
  }

  // 5. blindTestEligible
  const blindTestEligible = fingerprintCount >= BLIND_TEST_MIN_SPEAKERS;

  // 6. 对白工艺诊断 advisory（仅当 rawText 提供时）
  const dialogueCraftAdvisory = rawText
    ? scanDialogueCraftAdvisory(rawText)
    : [];

  // 7. canTriggerEditorialOpportunity
  const canTriggerEditorialOpportunity = dialogueCraftAdvisory.length > 0;

  // 8. 空状态处理：不得静默
  if (speakingCharacters.length === 0) {
    const emptyReason = deriveEmptyReason(intent);
    const ctx: DialogueCraftContext = {
      speakingCharacters: [],
      blindTestEligible: false,
      dialogueCraftAdvisory,
      sourceRefs: [],
      consumedByRawPrompt: false,
      advisoryOnly: true,
      canTriggerEditorialOpportunity,
      emptyReason,
    };
    return { dialogueCraftContext: ctx, promptBlock: null };
  }

  // 9. 构建 promptBlock
  const ctx: DialogueCraftContext = {
    speakingCharacters,
    blindTestEligible,
    dialogueCraftAdvisory,
    sourceRefs: Array.from(sourceRefSet),
    consumedByRawPrompt: false, // 将在 buildRawPrompt 中根据 promptBlock 是否非 null 修正
    advisoryOnly: true,
    canTriggerEditorialOpportunity,
    proxyNote: weakProxyCount > 0 ? PROXY_NOTE : undefined,
  };

  const promptBlock = formatDialogueCraftPromptBlock(ctx);
  if (promptBlock === null) {
    ctx.consumedByRawPrompt = false;
  }
  return { dialogueCraftContext: ctx, promptBlock };
}

// ============================================================================
// 辅助：指纹摘要
// ============================================================================

/**
 * 把 VoiceFingerprintV2 摘要为 prompt 友好的字符串。
 * 只取对生成有指导意义的高层特征，不暴露机械指标（如 lengthAvg/invertedSentenceRatio 数值）。
 */
function summarizeFingerprint(fp: VoiceFingerprintV2, name: string): string {
  const parts: string[] = [];
  // 词汇层级
  const vocabMap: Record<string, string> = {
    colloquial: "口语化",
    mixed: "口语与书面混合",
    formal: "书面/文言",
  };
  if (fp.vocabularyLevel) {
    parts.push(vocabMap[fp.vocabularyLevel] ?? fp.vocabularyLevel);
  }
  // 信息处理模式
  const infoMap: Record<string, string> = {
    direct: "直述",
    hint: "暗示",
    question: "反问",
  };
  if (fp.infoPattern) {
    parts.push(infoMap[fp.infoPattern] ?? fp.infoPattern);
  }
  // 称呼习惯
  if (fp.addressHabits) {
    const habits: string[] = [];
    if (fp.addressHabits.selfAddress) habits.push(`自称"${fp.addressHabits.selfAddress}"`);
    if (fp.addressHabits.toPeer) habits.push(`称同辈"${fp.addressHabits.toPeer}"`);
    if (fp.addressHabits.toSuperior) habits.push(`称上级"${fp.addressHabits.toSuperior}"`);
    if (fp.addressHabits.toSubordinate) habits.push(`称下级"${fp.addressHabits.toSubordinate}"`);
    if (fp.addressHabits.toEnemy) habits.push(`称敌人"${fp.addressHabits.toEnemy}"`);
    if (habits.length > 0) parts.push(habits.join("、"));
  }
  // 言语动作耦合（保留前 3 个）
  if (fp.speechActionCoupling && fp.speechActionCoupling.length > 0) {
    const coupling = fp.speechActionCoupling.slice(0, 3).join("、");
    parts.push(`常配动作：${coupling}`);
  }
  return parts.length > 0 ? `${name}：${parts.join("；")}` : name;
}

// ============================================================================
// 辅助：对白工艺诊断 advisory + span 提取
// ============================================================================

/**
 * 从 rawText 中解析 DialogueLine[]，运行三规则，转换为带 span 的 advisory。
 */
function scanDialogueCraftAdvisory(rawText: string): DialogueCraftAdvisoryItem[] {
  const lines = parseDialogueLinesFromText(rawText);
  if (lines.length === 0) return [];

  const violations: DialogueCraftViolation[] = [
    ...checkRule1Increment(lines),
    ...checkRule2Attribution(lines),
    ...checkRule3ActionTagInfo(lines),
  ];

  // 把每条 violation 的 lineIndex 映射到 rawText 中的 span
  return violations.map((v) => {
    const span = computeSpan(rawText, lines, v.lineIndex);
    return {
      rule: v.rule,
      ruleName: v.ruleName,
      severity: v.severity,
      evidence: v.evidence,
      lineIndex: v.lineIndex,
      span,
    };
  });
}

/**
 * 根据 lineIndex 计算 violation 在 rawText 中的 span。
 * 策略：用 lines[lineIndex].rawLine 在 rawText 中查找首个出现位置；
 * 找不到时返回 lineIndex 行起始-结束（按 \n 切分定位）。
 */
function computeSpan(
  rawText: string,
  lines: readonly DialogueLine[],
  lineIndex: number
): { start: number; end: number; excerpt?: string } {
  if (lineIndex < 0 || lineIndex >= lines.length) {
    return { start: 0, end: 0 };
  }
  const rawLine = lines[lineIndex].rawLine;
  const idx = rawText.indexOf(rawLine);
  if (idx >= 0) {
    return {
      start: idx,
      end: idx + rawLine.length,
      excerpt: rawLine.slice(0, 40),
    };
  }
  // 退化：用 lineIndex 找第 N 行
  const lineStarts: number[] = [];
  let pos = 0;
  for (let i = 0; i <= lineIndex && pos <= rawText.length; i++) {
    lineStarts.push(pos);
    const nextNewline = rawText.indexOf("\n", pos);
    if (nextNewline === -1) {
      pos = rawText.length;
    } else {
      pos = nextNewline + 1;
    }
  }
  const start = lineStarts[lineIndex] ?? 0;
  const nextNewline = rawText.indexOf("\n", start);
  const end = nextNewline === -1 ? rawText.length : nextNewline;
  return {
    start,
    end,
    excerpt: rawText.slice(start, Math.min(end, start + 40)),
  };
}

// ============================================================================
// 辅助：空状态原因
// ============================================================================

function deriveEmptyReason(intent: ChapterIntent): string {
  const focusCount = (intent.focusCharacterGoals ?? []).length;
  const relevantCount = (intent.relevantCharacters ?? []).length;
  if (focusCount === 0 && relevantCount === 0) {
    return "无 focusCharacterGoals 且无 relevantCharacters，本章无可用发言角色数据（不伪造）";
  }
  // 理论上不会到达（有角色名时 speakingCharacters 非空），防御性兜底
  return "focusCharacterGoals/relevantCharacters 非空但编译后 speakingCharacters 为空（异常状态，请检查角色名是否与 fingerprints/characterStates 匹配）";
}

// ============================================================================
// Prompt block 格式化
// ============================================================================

/**
 * 把 DialogueCraftContext 格式化为 raw prompt 的"本章发言角色声音指纹"区块。
 *
 * 格式（确定性，无 LLM）：
 * ```
 * 本章发言角色声音指纹（仅本章发言角色；advisory 非硬门；对白比例不作为 gate）：
 * - 林川【指纹·接受稿：chapters/ch12-accepted.md】林川：口语与书面混合；直述；自称"在下"、称同辈"道友"；常配动作：皱眉、摇头
 * - 苏婉【弱代理·CharacterState】mentality：害怕；pendingTension：未知
 *   弱代理声明：本 compact block 中 recoveryMode=character_voice_weak_proxy 的角色仅用 ...
 * 盲测资格：否（仅 1 名发言者有指纹，需 ≥2 名）
 * 对白工艺诊断：3 处 advisory（1 critical, 2 warning）；可触发 editorial opportunity，但不直接覆盖 raw
 * ```
 *
 * 无可靠 fingerprint 条目时返回 null；weak proxy 只留在 trace，raw prompt 由
 * CharacterVoiceContext 独占，避免同一 mentality/pendingTension 重复注入。
 * 不含 aggregateQualityScore / totalScore / dialogueRatioGate / dialogueRatioThreshold / passed / blocked。
 */
export function formatDialogueCraftPromptBlock(context: DialogueCraftContext): string | null {
  const fingerprintCharacters = context.speakingCharacters.filter(
    (entry) => entry.recoveryMode === "fingerprint" && entry.hasFingerprint,
  );
  if (fingerprintCharacters.length === 0) {
    return null;
  }

  const lines: string[] = [];
  lines.push("本章发言角色声音指纹（仅本章发言角色；advisory 非硬门；对白比例不作为 gate）：");

  for (const sp of fingerprintCharacters) {
    const typeLabel = sp.fingerprintSourceType === "accepted_manuscript" ? "接受稿" : "样章";
    lines.push(`- ${sp.name}【指纹·${typeLabel}：${sp.fingerprintSourceRef}】${sp.fingerprintSummary ?? ""}`);
  }

  lines.push(`盲测资格：${context.blindTestEligible ? "是" : "否"}（${fingerprintCharacters.length} 名发言者有指纹，需 ≥${BLIND_TEST_MIN_SPEAKERS} 名）`);

  if (context.dialogueCraftAdvisory.length > 0) {
    const critical = context.dialogueCraftAdvisory.filter((a) => a.severity === "critical").length;
    const warning = context.dialogueCraftAdvisory.filter((a) => a.severity === "warning").length;
    lines.push(`对白工艺诊断：${context.dialogueCraftAdvisory.length} 处 advisory（${critical} critical, ${warning} warning）；可触发 editorial opportunity，但不直接覆盖 raw`);
  } else {
    lines.push("对白工艺诊断：无 advisory");
  }

  return lines.join("\n");
}

// ============================================================================
// Skipped 构造（用于 hardBlock / 异常路径，保证 stageResults 不静默）
// ============================================================================

/**
 * 构造 skipped DialogueCraftContext（用于 hardBlock / raw 生成失败路径）。
 * 与 QUALITY-4/5/6 skipped 构造同模式：失败路径写 reason，不静默。
 */
export function skippedDialogueCraft(reason: string): DialogueCraftContext {
  return {
    speakingCharacters: [],
    blindTestEligible: false,
    dialogueCraftAdvisory: [],
    sourceRefs: [],
    consumedByRawPrompt: false,
    advisoryOnly: true,
    canTriggerEditorialOpportunity: false,
    emptyReason: `skipped: ${reason}`,
  };
}
