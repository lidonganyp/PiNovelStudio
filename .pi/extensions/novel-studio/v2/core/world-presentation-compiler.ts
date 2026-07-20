/**
 * WorldPresentationCompiler — 本章世界约束与类型承诺编译（QUALITY-6，计划 §4.2 WorldRule）
 *
 * 目标：在 raw 生成前，从 CompiledContext.worldRules + ChapterIntent.inviolableFacts +
 * ConstitutionSnapshot.genrePromises 编译出"本章世界约束"的 compact block，让 raw prompt
 * 能看到类型标注的世界规则（genre/power_system/immutable_fact）、本章激活标记（交叉引用
 * intent.inviolableFacts）和类型承诺（constitution.genrePromises，此前未消费的新数据），
 * 并在 stageResults 中证明它被选择、被消费、未污染长期状态。
 *
 * 核心不变量（QUALITY-6 任务书）：
 * - 所有 worldRules 进入 entries（条目少，3-5 条，全部作为背景相关）。
 * - chapterActivated：仅 type=immutable_fact 且 description 被 intent.inviolableFacts 命中
 *   （双向 substring 匹配）时为 true；genre/power_system 恒为 false（结构性背景规则）。
 * - genrePromises：从 constitution.genrePromises 直接取（constitution 为 null 时空数组）。
 * - 不把 worldRules 之外的设定数据灌入 entries（不引入新数据源）。
 * - 本模块只做"生成前相关状态编译"，不提交长期状态，不更新世界设定。
 * - 不修改 finalText，不生成 candidate，不触发 StyleShaper/language patch，
 *   不是 hard gate，不阻断正文生成。
 * - 不含 aggregateQualityScore/totalScore/对白比例/段落长度/固定冲突数等机械指标。
 *
 * 交叉引用说明：
 * - intent.inviolableFacts = seed.worldConstraint.immutableFacts + constitution.forbiddenDrift
 *   （由 chapter-intent-builder.ts:156-164 合并）。
 * - worldRules 中 type=immutable_fact 的条目来自 seed.worldConstraint.immutableFacts。
 * - 因此 intent.inviolableFacts 包含 worldRules.immutable_fact 的 description（可能还有
 *   forbiddenDrift 的额外条目）。chapterActivated 标记让模型知道哪些 immutable_fact
 *   被本章显式激活，而非泛泛的背景规则。
 *
 * 确定性本地编译：零 LLM 调用，纯结构化字段映射。
 */

import type { ChapterIntent } from "./chapter-intent-builder.js";
import type { WorldRuleFact, ConstitutionSnapshot } from "./types.js";

// ============================================================================
// 数据契约
// ============================================================================

/**
 * 单条本章世界约束的 compact 条目。
 */
export interface WorldPresentationEntry {
  /** 规则 id，对应 WorldRuleFact.id */
  ruleId: string;
  /** 规则描述 */
  description: string;
  /** 规则类型：genre / power_system / immutable_fact */
  type: string;
  /** 受影响的角色（来自 WorldRuleFact.affectedCharacters，可空） */
  affectedCharacters?: string[];
  /** 本章是否激活：immutable_fact 类型且 description 被 intent.inviolableFacts 命中时为 true */
  chapterActivated: boolean;
  /** 来源引用，如 "context.worldRules:{id}" */
  sourceRef: string;
  /** 置信度 [0,1]：worldRules 来自 config.json 派生，0.7 */
  confidence: number;
}

/**
 * 本章世界约束与类型承诺编译结果。
 * 写入 stageResults.worldPresentationContext 供 trace 审计。
 */
export interface WorldPresentationContext {
  /** 世界规则条目（全部 worldRules，通常 3-5 条） */
  entries: WorldPresentationEntry[];
  /** 类型承诺（来自 constitution.genrePromises，新数据） */
  genrePromises: string[];
  /** 来源汇总（去重） */
  sourceRefs: string[];
  /** raw prompt 是否实际消费了该 compact block */
  consumedByRawPrompt: boolean;
  /** entries 和 genrePromises 都为空时的原因（不得静默，必须写明） */
  emptyReason?: string;
}

/**
 * 编译输入：从 orchestrator 传入的 intent + worldRules + constitution。
 */
export interface WorldPresentationCompileInput {
  intent: ChapterIntent;
  /** CompiledContext.worldRules，无世界规则时为空数组 */
  worldRules: WorldRuleFact[];
  /** ConstitutionSnapshot，无宪法文件时为 null */
  constitution: ConstitutionSnapshot | null;
}

/**
 * 编译输出：WorldPresentationContext + 格式化后的 prompt block（空时 null）。
 */
export interface WorldPresentationCompileResult {
  worldPresentationContext: WorldPresentationContext;
  /** 格式化后的"本章世界约束"prompt 区块；entries 和 genrePromises 都为空时返回 null */
  promptBlock: string | null;
}

// ============================================================================
// 常量
// ============================================================================

/** worldRules 来自 config.json 派生（genre/power_system/immutable_facts），高置信度 */
const CONFIDENCE_CONFIG_DERIVED = 0.7;
/** genrePromises 来自作品宪法，高置信度 */
const CONFIDENCE_CONSTITUTION = 0.7;

/** immutable_fact 类型标记（chapterActivated 只对此类型生效） */
const TYPE_IMMUTABLE_FACT = "immutable_fact";

// ============================================================================
// 核心编译逻辑
// ============================================================================

/**
 * 编译本章世界约束与类型承诺。
 *
 * 编译规则（保守）：
 * 1. 所有 worldRules 进入 entries（条目少，3-5 条，全部作为背景相关）。
 * 2. chapterActivated：仅 type=immutable_fact 且 description 被 intent.inviolableFacts
 *    命中（双向 substring 匹配）时为 true；genre/power_system 恒为 false。
 * 3. genrePromises：从 constitution.genrePromises 直接取（constitution 为 null 时空数组）。
 * 4. 空（无 worldRules 且无 genrePromises）→ emptyReason + promptBlock=null，不伪造。
 *
 * 不调用 LLM，不修改 finalText，不提交状态，不是 gate。
 */
export function compileWorldPresentationContext(
  input: WorldPresentationCompileInput
): WorldPresentationCompileResult {
  const { intent, worldRules, constitution } = input;

  // 构建 inviolableFacts 索引（用于交叉引用）
  const inviolableFacts = intent.inviolableFacts ?? [];

  const entries: WorldPresentationEntry[] = [];
  const sourceRefSet = new Set<string>();

  for (const rule of worldRules) {
    const entry = buildEntry(rule, inviolableFacts);
    entries.push(entry);
    sourceRefSet.add(entry.sourceRef);
  }

  // genrePromises：从 constitution 直接取
  const genrePromises = constitution?.genrePromises ?? [];
  if (genrePromises.length > 0) {
    sourceRefSet.add("constitution:genrePromises");
  }

  // 空状态处理：不得静默
  if (entries.length === 0 && genrePromises.length === 0) {
    const emptyReason = deriveEmptyReason(worldRules.length, constitution);
    const worldPresentationContext: WorldPresentationContext = {
      entries: [],
      genrePromises: [],
      sourceRefs: [],
      consumedByRawPrompt: false,
      emptyReason,
    };
    return { worldPresentationContext, promptBlock: null };
  }

  const worldPresentationContext: WorldPresentationContext = {
    entries,
    genrePromises,
    sourceRefs: Array.from(sourceRefSet),
    consumedByRawPrompt: true, // 将在 buildRawPrompt 中根据 promptBlock 是否为 null 修正
  };

  const promptBlock = formatWorldPresentationPromptBlock(worldPresentationContext);
  // 若 promptBlock 为 null（理论上不会，因为 entries 或 genrePromises 至少一个非空），修正 consumedByRawPrompt
  if (promptBlock === null) {
    worldPresentationContext.consumedByRawPrompt = false;
  }
  return { worldPresentationContext, promptBlock };
}

/**
 * 构建单条 WorldPresentationEntry。
 *
 * chapterActivated 判定：
 * - 仅 type=immutable_fact 时检查
 * - 双向 substring 匹配：rule.description 包含 inviolableFact，或 inviolableFact 包含 rule.description
 *   （应对 description 可能有细微措辞差异）
 * - genre/power_system 恒为 false（结构性背景规则，不按章节激活）
 */
function buildEntry(
  rule: WorldRuleFact,
  inviolableFacts: string[]
): WorldPresentationEntry {
  const chapterActivated =
    rule.type === TYPE_IMMUTABLE_FACT &&
    inviolableFacts.some(
      (f) =>
        f.includes(rule.description) || rule.description.includes(f)
    );

  return {
    ruleId: rule.id,
    description: rule.description,
    type: rule.type,
    affectedCharacters: rule.affectedCharacters.length > 0 ? rule.affectedCharacters : undefined,
    chapterActivated,
    sourceRef: `context.worldRules:${rule.id}`,
    confidence: CONFIDENCE_CONFIG_DERIVED,
  };
}

/**
 * 推导空状态原因（不得静默）。
 */
function deriveEmptyReason(
  worldRulesCount: number,
  constitution: ConstitutionSnapshot | null
): string {
  if (worldRulesCount === 0) {
    if (!constitution || !constitution.genrePromises || constitution.genrePromises.length === 0) {
      return "无 worldRules 且无 constitution.genrePromises，本章无可用世界约束数据";
    }
    return "worldRules 为空但 constitution.genrePromises 非空（不应到达此分支，请检查编译逻辑）";
  }
  // 理论上不会到达（worldRules 非空时 entries 非空），防御性兜底
  return "worldRules 非空但编译后 entries 为空（异常状态，请检查 WorldRuleFact 字段）";
}

// ============================================================================
// Prompt block 格式化
// ============================================================================

/**
 * 把 WorldPresentationContext 格式化为 raw prompt 的"本章世界约束"区块。
 *
 * 格式（确定性，无 LLM）：
 * ```
 * 本章世界约束（类型标注 + 本章激活标记，非全量设定集）：
 * - [genre] 玄幻 / 修仙
 * - [power_system] 灵气修炼体系
 * - [immutable_fact] 水下暗流不可消除（本章激活）（影响角色：林川、苏婉）
 * - [immutable_fact] 灵气浓度随海拔递减
 * 类型承诺：读者期待硬核修仙体系；世界观自洽
 * ```
 *
 * affectedCharacters 渲染规则（QUALITY-6-REPAIR-1）：
 * - entry.affectedCharacters 非空时，在该规则行追加`（影响角色：A、B）`标签，
 *   使 compact block 真正成为旧 flat worldRules 注入的超集。
 * - 空 affectedCharacters（undefined 或空数组）不输出该段，保持规则行简洁。
 * - 标签顺序：`（本章激活）`在前，`（影响角色：...）`在后，二者互斥可共存。
 *
 * entries 为空但 genrePromises 非空时，只输出"类型承诺："行。
 * genrePromises 为空但 entries 非空时，只输出规则列表。
 * 两者都为空时返回 null（不加入 prompt，空原因只写 stageResults）。
 * 不含 aggregateQualityScore / totalScore / 对白比例 / 段落长度 / 固定冲突数等机械指标。
 */
export function formatWorldPresentationPromptBlock(context: WorldPresentationContext): string | null {
  if (context.entries.length === 0 && context.genrePromises.length === 0) {
    return null;
  }

  const lines: string[] = [];
  lines.push("本章世界约束（类型标注 + 本章激活标记，非全量设定集）：");

  for (const entry of context.entries) {
    const activatedTag = entry.chapterActivated ? "（本章激活）" : "";
    const affectedTag =
      entry.affectedCharacters && entry.affectedCharacters.length > 0
        ? `（影响角色：${entry.affectedCharacters.join("、")}）`
        : "";
    lines.push(`- [${entry.type}] ${entry.description}${activatedTag}${affectedTag}`);
  }

  if (context.genrePromises.length > 0) {
    lines.push(`类型承诺：${context.genrePromises.join("；")}`);
  }

  return lines.join("\n");
}

// ============================================================================
// Skipped 构造（用于 hardBlock / 异常路径，保证 stageResults 不静默）
// ============================================================================

/**
 * 构造 skipped WorldPresentationContext（用于 hardBlock / raw 生成失败路径）。
 * 与 QUALITY-4/5 skipped 构造同模式：失败路径写 reason，不静默。
 */
export function skippedWorldPresentationContext(reason: string): WorldPresentationContext {
  return {
    entries: [],
    genrePromises: [],
    sourceRefs: [],
    consumedByRawPrompt: false,
    emptyReason: `skipped: ${reason}`,
  };
}
