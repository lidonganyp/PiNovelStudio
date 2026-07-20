/**
 * CharacterVoiceCompiler — 本章相关角色声音/状态提示编译（QUALITY-5，计划 §4.2 CharacterState）
 *
 * 目标：在 raw 生成前，从 ChapterIntent.relevantCharacters + focusCharacterGoals +
 * CompiledContext.characterStates 编译出只含"本章相关角色"的 compact block，让 raw prompt
 * 能看到本章出场角色的状态提示（mentality/pendingTension 作为弱代理），并在 stageResults
 * 中证明它被选择、被消费、未污染长期状态。
 *
 * 核心不变量（QUALITY-5 任务书）：
 * - 只包含本章相关角色，不得把全量 characterStates 灌进 raw prompt。
 * - 选择 = focusCharacterGoals.character ∪ relevantCharacters（并集去重，非有序选择）。
 * - voiceHints = mentality + pendingTension（弱代理，非完整 voice fingerprint）。
 * - intent-only（state 无记录）角色进入 trace 但不进入 prompt block（voiceHints 为空时过滤）。
 * - state 命中但 mentality/pendingTension 都缺失 → voiceHints=[]，confidence 仍 0.6（state 命中是事实）。
 * - 本模块只做"生成前相关状态编译"，不提交长期状态，不更新角色档案。
 * - 不修改 finalText，不生成 candidate，不触发 StyleShaper/language patch，
 *   不是 hard gate，不阻断正文生成。
 * - 不含 aggregateQualityScore/totalScore/对白比例/段落长度/固定冲突数等机械指标。
 *
 * 诚实性声明（proxyNote）：
 * - 本最小切片只用 CompiledContext.characterStates 的 mentality/pendingTension 作为弱代理；
 * - 完整 voice fingerprint（句式/词汇/称呼习惯）属于未来增强（D 资产：角色档案 .md 解析）；
 * - confidence 0.6/0.3 低于 QUALITY-4 的 0.7/0.5，反映"状态字段借作声音代理"的间接性。
 *
 * 确定性本地编译：零 LLM 调用，纯结构化字段映射。
 */

import type { ChapterIntent } from "./chapter-intent-builder.js";
import type { CharacterStateFact } from "./types.js";

// ============================================================================
// 数据契约
// ============================================================================

/**
 * 单条本章相关角色的 compact 条目。
 */
export interface CharacterVoiceEntry {
  /** 角色 id，与 CharacterStateFact.characterId 一致（= name） */
  characterId: string;
  /** 角色名 */
  name: string;
  /** 角色定位：protagonist/antagonist/supporting（来自 state.role，可空） */
  role?: string;
  /**
   * 声音/状态提示（弱代理）：
   * - state 命中时 = [mentality, pendingTension].filter(Boolean)
   * - intent-only 时 = []（空数组，formatCharacterVoicePromptBlock 会过滤掉不进入 prompt）
   */
  voiceHints: string[];
  /** 来源引用，如 "characterStates:{name}" 或 "intent-only:{name}" */
  sourceRef: string;
  /** 置信度 [0,1]：state 命中 0.6 / intent-only 0.3 */
  confidence: number;
}

/**
 * 本章相关角色声音/状态编译结果。
 * 写入 stageResults.characterVoiceContext 供 trace 审计。
 */
export interface CharacterVoiceContext {
  /** 本章相关角色条目（只含 focusCharacterGoals ∪ relevantCharacters 命中项，非全量） */
  entries: CharacterVoiceEntry[];
  /** 来源汇总（去重），用于追溯 */
  sourceRefs: string[];
  /** raw prompt 是否实际消费了该 compact block（空或全 intent-only 时 false） */
  consumedByRawPrompt: boolean;
  /** entries 为空时的原因（不得静默，必须写明） */
  emptyReason?: string;
  /** 弱代理性质声明（固定文案，防止下游误用为 voice fingerprint） */
  proxyNote?: string;
}

/**
 * 编译输入：从 orchestrator 传入的 intent + characterStates。
 */
export interface CharacterVoiceCompileInput {
  intent: ChapterIntent;
  /** CompiledContext.characterStates，无角色状态时为空数组或 undefined */
  characterStates?: CharacterStateFact[] | null;
}

/**
 * 编译输出：CharacterVoiceContext + 格式化后的 prompt block（空或全 intent-only 时 null）。
 */
export interface CharacterVoiceCompileResult {
  characterVoiceContext: CharacterVoiceContext;
  /** 格式化后的"本章相关角色状态提示"prompt 区块；无可用 voiceHints 时返回 null（不加入 prompt） */
  promptBlock: string | null;
}

// ============================================================================
// 常量
// ============================================================================

/** state 命中角色时的置信度（mentality/pendingTension 是状态字段被借用为声音代理，间接性高于 QUALITY-4 的 0.7） */
const CONFIDENCE_STATE_HIT = 0.6;
/** intent-only（state 无记录）时的置信度（略高于 0 以区分"考虑过但无状态"与"根本没考虑"） */
const CONFIDENCE_INTENT_ONLY = 0.3;

/**
 * 弱代理性质声明（固定文案）。
 * 防止下游消费者误以为 voiceHints 是完整 voice fingerprint。
 */
const PROXY_NOTE =
  "本最小切片只用 CompiledContext.characterStates 的 mentality/pendingTension 作为弱代理；完整 voice fingerprint（句式/词汇/称呼习惯）属于未来增强（D 资产：角色档案 .md 解析）";

// ============================================================================
// 核心编译逻辑
// ============================================================================

/**
 * 编译本章相关角色声音/状态提示。
 *
 * 相关性规则（保守）：
 * 1. 选择 = focusCharacterGoals.character ∪ relevantCharacters（并集去重）。
 *    focus 角色即使不在 relevantCharacters 中也进入 entries（并集语义）。
 * 2. 不把 characterStates 中未命中的角色灌入 entries（禁止全量灌入）。
 * 3. state 命中 → voiceHints = [mentality, pendingTension].filter(Boolean)，confidence=0.6。
 * 4. state 未命中（intent-only）→ voiceHints=[]，confidence=0.3，进入 trace 但不进入 prompt block。
 * 5. state 命中但 mentality/pendingTension 都缺失 → voiceHints=[]，confidence 仍 0.6（state 命中是事实）。
 * 6. 空 selectedNames → entries 为空 + emptyReason + proxyNote，不伪造。
 *
 * 不调用 LLM，不修改 finalText，不提交状态，不是 gate。
 */
export function compileCharacterVoiceContext(
  input: CharacterVoiceCompileInput
): CharacterVoiceCompileResult {
  const { intent, characterStates } = input;

  // 选择：focusCharacterGoals.character ∪ relevantCharacters（并集去重）
  const focusChars = (intent.focusCharacterGoals ?? []).map((g) => g.character);
  const relevantChars = intent.relevantCharacters ?? [];
  const selectedNames = dedupeStrings([...focusChars, ...relevantChars]);

  // 构建 state 索引：name → CharacterStateFact
  const stateMap = new Map<string, CharacterStateFact>();
  if (characterStates) {
    for (const cs of characterStates) {
      if (cs.name) {
        stateMap.set(cs.name, cs);
      }
    }
  }

  const entries: CharacterVoiceEntry[] = [];
  const sourceRefSet = new Set<string>();

  for (const name of selectedNames) {
    const stateEntry = stateMap.get(name);
    const entry = buildEntry(name, stateEntry);
    entries.push(entry);
    sourceRefSet.add(entry.sourceRef);
  }

  // 空状态处理：不得静默
  if (entries.length === 0) {
    const emptyReason = deriveEmptyReason(focusChars.length, relevantChars.length, characterStates);
    const characterVoiceContext: CharacterVoiceContext = {
      entries: [],
      sourceRefs: [],
      consumedByRawPrompt: false,
      emptyReason,
      proxyNote: PROXY_NOTE,
    };
    return { characterVoiceContext, promptBlock: null };
  }

  const characterVoiceContext: CharacterVoiceContext = {
    entries,
    sourceRefs: Array.from(sourceRefSet),
    consumedByRawPrompt: true, // 将在 buildRawPrompt 中根据 promptBlock 是否为 null 修正
    proxyNote: PROXY_NOTE,
  };

  const promptBlock = formatCharacterVoicePromptBlock(characterVoiceContext);
  // 若所有 entry 都是 intent-only（voiceHints 全空），promptBlock 为 null，修正 consumedByRawPrompt
  if (promptBlock === null) {
    characterVoiceContext.consumedByRawPrompt = false;
  }
  return { characterVoiceContext, promptBlock };
}

/**
 * 构建单条 CharacterVoiceEntry。
 *
 * state 命中：用 typeof === "string" 防御性从 stateEntry.state ?? {} 取 role/mentality/pendingTension
 * （CharacterStateFact.state 是 Record<string, unknown>，字段类型不确定）。
 * voiceHints = [mentality, pendingTension].filter(Boolean)（不含 recentAction——recentAction 偏情节连续性而非声音）。
 */
function buildEntry(
  name: string,
  stateEntry: CharacterStateFact | undefined
): CharacterVoiceEntry {
  if (stateEntry) {
    const state = (stateEntry.state ?? {}) as Record<string, unknown>;
    const role = typeof state.role === "string" ? state.role : undefined;
    const mentality = typeof state.mentality === "string" ? state.mentality : undefined;
    const pendingTension = typeof state.pendingTension === "string" ? state.pendingTension : undefined;
    const voiceHints = [mentality, pendingTension].filter((s): s is string => Boolean(s));
    return {
      characterId: stateEntry.characterId ?? name,
      name,
      role,
      voiceHints,
      sourceRef: `characterStates:${name}`,
      confidence: CONFIDENCE_STATE_HIT,
    };
  }

  // state 中未找到 → intent-only（进入 trace 但不进入 prompt block）
  return {
    characterId: name,
    name,
    role: undefined,
    voiceHints: [],
    sourceRef: `intent-only:${name}`,
    confidence: CONFIDENCE_INTENT_ONLY,
  };
}

/**
 * 推导空状态原因（不得静默）。
 */
function deriveEmptyReason(
  focusCount: number,
  relevantCount: number,
  characterStates: CharacterStateFact[] | null | undefined
): string {
  const hasState = characterStates && characterStates.length > 0;
  if (focusCount === 0 && relevantCount === 0) {
    if (!hasState) {
      return "无 focusCharacterGoals 且无 relevantCharacters，且 characterStates 为空，本章无可用角色状态";
    }
    return "无 focusCharacterGoals 且无 relevantCharacters，本章未选中任何角色，不灌入全量 characterStates（保守相关性规则）";
  }
  // 理论上不会到达（selectedNames 非空时 entries 非空），防御性兜底
  return "focusCharacterGoals/relevantCharacters 非空但编译后 entries 为空（异常状态，请检查去重逻辑）";
}

// ============================================================================
// Prompt block 格式化
// ============================================================================

/**
 * 把 CharacterVoiceContext 格式化为 raw prompt 的"本章相关角色状态提示"区块。
 *
 * 格式（确定性，无 LLM）：
 * ```
 * 本章相关角色状态提示（只含本章出场角色，非全量角色档案；基于角色状态派生，非完整声音指纹）：
 * - 林觉【protagonist】冷静、克制、对措辞极度敏感；情绪越重话越少；未解决张力：对沈游的情感会变成判断盲区
 * - 苏念【supporting】谨慎合作态度
 * ```
 *
 * intent-only 角色（voiceHints 为空）不进入 prompt block，但保留在 entries 供 trace 审计。
 * 所有 entry 的 voiceHints 都为空时返回 null（不加入 prompt，空原因只写 stageResults）。
 * 不含 aggregateQualityScore / totalScore / 对白比例 / 段落长度 / 固定冲突数等机械指标。
 */
export function formatCharacterVoicePromptBlock(context: CharacterVoiceContext): string | null {
  // 只含 voiceHints 非空的 entry（intent-only 不进入 prompt）
  const promptEntries = context.entries.filter((e) => e.voiceHints.length > 0);
  if (promptEntries.length === 0) {
    return null;
  }
  const lines = promptEntries.map((e) => {
    const roleTag = e.role ? `【${e.role}】` : "";
    return `- ${e.name}${roleTag}${e.voiceHints.join("；")}`;
  });
  return `本章相关角色状态提示（只含本章出场角色，非全量角色档案；基于角色状态派生，非完整声音指纹）：\n${lines.join("\n")}`;
}

// ============================================================================
// Skipped 构造（用于 hardBlock / 异常路径，保证 stageResults 不静默）
// ============================================================================

/**
 * 构造 skipped CharacterVoiceContext（用于 hardBlock / raw 生成失败路径）。
 * 与 QUALITY-4 skippedPromiseContext 同模式：失败路径写 reason，不静默。
 */
export function skippedCharacterVoiceContext(reason: string): CharacterVoiceContext {
  return {
    entries: [],
    sourceRefs: [],
    consumedByRawPrompt: false,
    emptyReason: `skipped: ${reason}`,
    proxyNote: PROXY_NOTE,
  };
}

// ============================================================================
// 工具函数
// ============================================================================

/** 字符串数组去重（保序） */
function dedupeStrings(arr: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const s of arr) {
    if (s && !seen.has(s)) {
      seen.add(s);
      result.push(s);
    }
  }
  return result;
}
