/**
 * EnsembleLayeringCompiler — 本章角色层次编译（QUALITY-7，计划 §4.4 ensemble_function / §6.2 CraftEvidenceLibrary）
 *
 * 目标：在 raw 生成前，从 ChapterIntent.focusCharacterGoals + relevantCharacters 编译出
 * "焦点/在场"分层 compact block，让 raw prompt 能看到多个角色在本章的叙事功能层次
 * （谁是焦点驱动本章、谁只是在场），并在 stageResults 中证明它被选择、被消费、未污染长期状态。
 *
 * 核心不变量（QUALITY-7 任务书）：
 * - 只包含本章相关角色（focusCharacterGoals.character ∪ relevantCharacters 并集去重），不灌全量角色档案。
 * - 唯一新增信息：每角色的"焦点"/"在场"层级标签（焦点 = 在 focusCharacterGoals 中）。
 *   这是其他 compact block（CharacterVoice 给 mentality/pendingTension，不含焦点/在场）都不提供的信号。
 * - 不引入 staticRole：role 唯一来源是 characterStates.state.role，与 CharacterVoice 同源；
 *   对 state-hit 角色冗余（CharacterVoice 已显示【role】），对 intent-only 角色不可得，
 *   且需 protagonist→主角 翻译表增加不一致风险。role 交给 CharacterVoice，本切片只做焦点/在场分层。
 * - 本模块只做"生成前相关状态编译"，不提交长期状态，不更新角色档案。
 * - 不修改 finalText，不生成 candidate，不触发 StyleShaper/language patch，
 *   不是 hard gate，不阻断正文生成。
 * - 不含 aggregateQualityScore/totalScore/对白比例/段落长度/固定冲突数/人数配额等机械指标。
 *
 * 诚实性声明（proxyNote）：
 * - 本最小切片只做焦点/在场分层（直接结构事实：是否在 focusCharacterGoals 中）；
 * - 完整群像功能（foil/witness/obstacle/角色交互/轮转调度）属于未来增强
 *   （D 资产：legacy EnsembleDirector/EnsembleDetector 为 LLM-based C/D，replay-only）；
 * - 不恢复固定轮转、人数配额、群像硬门（E 退役）；
 * - confidence 0.7 同 worldPresentation（intent-derived 直接结构事实，非代理）。
 *
 * 确定性本地编译：零 LLM 调用，纯结构化字段映射。
 */

import type { ChapterIntent } from "./chapter-intent-builder.js";

// ============================================================================
// 数据契约
// ============================================================================

/**
 * 单条本章角色的层次条目。
 */
export interface EnsembleLayeringEntry {
  /** 角色 id（= name） */
  characterId: string;
  /** 角色名 */
  name: string;
  /** 是否焦点角色（在 focusCharacterGoals 中） */
  isFocus: boolean;
  /** 层级标签：焦点 / 在场（derived from isFocus） */
  layeringTag: "焦点" | "在场";
  /** 来源引用，如 "intent:focusCharacterGoals:{name}" 或 "intent:relevantCharacters:{name}" */
  sourceRef: string;
  /** 置信度 [0,1]：intent-derived 直接结构事实，0.7 */
  confidence: number;
}

/**
 * 本章角色层次编译结果。
 * 写入 stageResults.ensembleLayeringContext 供 trace 审计。
 */
export interface EnsembleLayeringContext {
  /** 本章相关角色条目（focusCharacterGoals ∪ relevantCharacters 命中项，非全量） */
  entries: EnsembleLayeringEntry[];
  /** 来源汇总（去重），用于追溯 */
  sourceRefs: string[];
  /** raw prompt 是否实际消费了该 compact block（空时 false） */
  consumedByRawPrompt: boolean;
  /** entries 为空时的原因（不得静默，必须写明） */
  emptyReason?: string;
  /** 切片范围声明（固定文案，防止下游误用为完整群像功能判断） */
  proxyNote?: string;
}

/**
 * 编译输入：从 orchestrator 传入的 intent。
 * 不需要 characterStates（不读 role）；保持入参形状与 CharacterVoice 一致便于未来扩展时按需加。
 */
export interface EnsembleLayeringCompileInput {
  intent: ChapterIntent;
}

/**
 * 编译输出：EnsembleLayeringContext + 格式化后的 prompt block（空时 null）。
 */
export interface EnsembleLayeringCompileResult {
  ensembleLayeringContext: EnsembleLayeringContext;
  /** 格式化后的"本章角色层次"prompt 区块；无可用角色时返回 null（不加入 prompt） */
  promptBlock: string | null;
}

// ============================================================================
// 常量
// ============================================================================

/** intent-derived 直接结构事实的置信度（同 worldPresentation 的 config-derived 0.7 直接性层级） */
const CONFIDENCE_INTENT_DERIVED = 0.7;

/**
 * 切片范围声明（固定文案）。
 * 防止下游消费者误以为本 block 是完整群像功能判断（foil/witness/obstacle/轮转调度）。
 */
const PROXY_NOTE =
  "本最小切片只做焦点/在场分层（是否在 focusCharacterGoals 中）；完整群像功能（foil/witness/obstacle/角色交互/轮转调度）属于未来增强（D 资产：legacy EnsembleDirector/EnsembleDetector 为 LLM-based C/D，replay-only）；不恢复固定轮转、人数配额、群像硬门（E 退役）";

// ============================================================================
// 核心编译逻辑
// ============================================================================

/**
 * 编译本章角色层次（焦点/在场分层）。
 *
 * 相关性规则（保守）：
 * 1. 选择 = focusCharacterGoals.character ∪ relevantCharacters（并集去重，与 CharacterVoice 同选择集）。
 *    focus 角色即使不在 relevantCharacters 中也进入 entries（并集语义）。
 * 2. isFocus = 在 focusCharacterGoals 中；layeringTag = isFocus ? "焦点" : "在场"。
 * 3. 不把 characterStates 中未命中的角色灌入 entries（禁止全量灌入）。
 * 4. 空（无 relevantCharacters 且无 focusCharacterGoals）→ emptyReason + promptBlock=null，不伪造。
 *
 * 不调用 LLM，不修改 finalText，不提交状态，不是 gate。
 */
export function compileEnsembleLayeringContext(
  input: EnsembleLayeringCompileInput
): EnsembleLayeringCompileResult {
  const { intent } = input;

  // 选择：focusCharacterGoals.character ∪ relevantCharacters（并集去重）
  const focusChars = (intent.focusCharacterGoals ?? []).map((g) => g.character);
  const relevantChars = intent.relevantCharacters ?? [];
  const selectedNames = dedupeStrings([...focusChars, ...relevantChars]);

  // focus 名字集合（O(1) 查 isFocus）；focus 优先 → 用 focusChars 去重结果建集合
  const focusSet = new Set<string>(dedupeStrings(focusChars));

  const entries: EnsembleLayeringEntry[] = [];
  const sourceRefSet = new Set<string>();

  for (const name of selectedNames) {
    const isFocus = focusSet.has(name);
    const entry = buildEntry(name, isFocus);
    entries.push(entry);
    sourceRefSet.add(entry.sourceRef);
  }

  // 空状态处理：不得静默
  if (entries.length === 0) {
    const emptyReason = deriveEmptyReason(focusChars.length, relevantChars.length);
    const ensembleLayeringContext: EnsembleLayeringContext = {
      entries: [],
      sourceRefs: [],
      consumedByRawPrompt: false,
      emptyReason,
      proxyNote: PROXY_NOTE,
    };
    return { ensembleLayeringContext, promptBlock: null };
  }

  const ensembleLayeringContext: EnsembleLayeringContext = {
    entries,
    sourceRefs: Array.from(sourceRefSet),
    consumedByRawPrompt: true, // 将在 buildRawPrompt 中根据 promptBlock 是否为 null 修正
    proxyNote: PROXY_NOTE,
  };

  const promptBlock = formatEnsembleLayeringPromptBlock(ensembleLayeringContext);
  // 若 promptBlock 为 null（理论上不会，因为 entries 非空时总有标签可输出），修正 consumedByRawPrompt
  if (promptBlock === null) {
    ensembleLayeringContext.consumedByRawPrompt = false;
  }
  return { ensembleLayeringContext, promptBlock };
}

/**
 * 构建单条 EnsembleLayeringEntry。
 *
 * isFocus 决定 layeringTag 与 sourceRef：
 * - isFocus=true → "焦点"，sourceRef = "intent:focusCharacterGoals:{name}"
 * - isFocus=false → "在场"，sourceRef = "intent:relevantCharacters:{name}"
 */
function buildEntry(name: string, isFocus: boolean): EnsembleLayeringEntry {
  return {
    characterId: name,
    name,
    isFocus,
    layeringTag: isFocus ? "焦点" : "在场",
    sourceRef: isFocus
      ? `intent:focusCharacterGoals:${name}`
      : `intent:relevantCharacters:${name}`,
    confidence: CONFIDENCE_INTENT_DERIVED,
  };
}

/**
 * 推导空状态原因（不得静默）。
 */
function deriveEmptyReason(focusCount: number, relevantCount: number): string {
  if (focusCount === 0 && relevantCount === 0) {
    return "无 focusCharacterGoals 且无 relevantCharacters，本章无可用角色层次数据";
  }
  // 理论上不会到达（selectedNames 非空时 entries 非空），防御性兜底
  return "focusCharacterGoals/relevantCharacters 非空但编译后 entries 为空（异常状态，请检查去重逻辑）";
}

// ============================================================================
// Prompt block 格式化
// ============================================================================

/**
 * 把 EnsembleLayeringContext 格式化为 raw prompt 的"本章角色层次"区块。
 *
 * 格式（确定性，无 LLM）：
 * ```
 * 本章角色层次（焦点/在场分层，非全量角色档案；非固定轮转/人数配额）：
 * - 林川【焦点】
 * - 苏婉【在场】
 * - 老周【在场】
 * ```
 *
 * 标签恒在（焦点 或 在场）；无 role 标签（不与 CharacterVoice 重复）。
 * entries 为空时返回 null（不加入 prompt，空原因只写 stageResults）。
 * 不含 aggregateQualityScore / totalScore / 对白比例 / 段落长度 / 固定冲突数 / 人数配额等机械指标。
 */
export function formatEnsembleLayeringPromptBlock(context: EnsembleLayeringContext): string | null {
  if (context.entries.length === 0) {
    return null;
  }
  const lines = context.entries.map((e) => `- ${e.name}【${e.layeringTag}】`);
  return `本章角色层次（焦点/在场分层，非全量角色档案；非固定轮转/人数配额）：\n${lines.join("\n")}`;
}

// ============================================================================
// Skipped 构造（用于 hardBlock / 异常路径，保证 stageResults 不静默）
// ============================================================================

/**
 * 构造 skipped EnsembleLayeringContext（用于 hardBlock / raw 生成失败路径）。
 * 与 QUALITY-4/5/6 skipped 构造同模式：失败路径写 reason，不静默。
 */
export function skippedEnsembleLayeringContext(reason: string): EnsembleLayeringContext {
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
