/**
 * StructuralEvidenceScanner — 结构证据扫描器（QUALITY-3 最小闭环）
 *
 * 职责：从最终正文 + ChapterIntent + CompiledContext 提取结构证据，验证
 * "目标—阻力—选择—结果、不可逆变化、五维推进、因果链"等结构层问题。
 *
 * 设计原则（任务规格 QUALITY-3）：
 * - 纯本地确定性提取，零 LLM 调用。
 * - 只诊断不改文：只输出 span/证据/置信度/读者影响/建议 owner，不修改 finalText。
 * - 不触发 StyleShaper / language patch / candidate rewrite。
 * - 证据不足时 human_review，禁止猜测 satisfied。
 * - source span 缺失时 evidence 不得进入 satisfied。
 * - 不含 aggregateQualityScore / totalScore 等聚合总分。
 *
 * 复用资产：
 * - A：TextSpan（types.ts:295）；ChapterIntent（chapter-intent-builder.ts）；
 *   CompiledContext / ConstitutionSnapshot（types.ts）。
 * - C：judge-types.ts span 边界校验思路（validateVerdictEvidence）；
 *   diagnostic-suite.ts "诊断不能直接改文" 原则。
 * - D（概念借用）：structural-lock-extractor 的 mustPreserveFacts /
 *   requiredProtagonistActions / sceneOutcome.requiredEffects 概念映射到 5 维度。
 *   extractor 是 DAG 耦合，不直接复用。
 * - E（禁止继承）：Diagnostic.suggestedRepair（rewrite kind）、HARD_BLOCK_PROVIDERS、
 *   event-progression-gate gate/block 权限、DimensionScores 总分、配额。
 *
 * 5 个维度的扫描策略（诚实原则：能找到 span 才给状态，否则 human_review）：
 * 1. chapter_function_delivery：chapterFunction 非空时，从 chapterFunction +
 *    concreteDelivery 提取关键词，在正文找 span。找到 → partial（确定性 scanner
 *    不能证明"文学交付"，只能证明关键词出现）；找不到 → risk。
 * 2. goal_resistance_choice_result：focusCharacterGoals + resistance +
 *    choicesAndCosts 全空时 → human_review（无 expectedRef 无法验证）。
 *    否则找选择/阻力关键词 span，找到 → partial。
 * 3. irreversible_change：expectedIrreversibleChange 为空时 → human_review
 *    （任务规格："无可靠 intent 时 human_review"）。非空时找关键词 span。
 * 4. five_axis_progression：逐轴找证据（情节/信息/角色/世界/因果），
 *    统计有效 delta 轴数。≥3 轴有 span → partial；1-2 轴 → partial；
 *    0 轴 → risk。绝不因外部事件少而误判（低情节余震章角色/因果推进仍有效）。
 * 5. end_pressure_causality：causalEndPressure 为空时 → human_review。
 *    非空时检查正文末尾 ~20% 是否有压力关键词 span。
 */

import type {
  Candidate,
  CompiledContext,
  ConstitutionSnapshot,
  TextSpan,
} from "./types.js";
import type { ChapterIntent } from "./chapter-intent-builder.js";
import {
  type ChapterQualityEvidence,
  type StructuralDimension,
  type StructuralEvidence,
  type StructuralEvidenceScanResult,
  type StructuralEvidenceSeverity,
  type StructuralEvidenceStatus,
  validateStructuralEvidence,
} from "./chapter-quality-evidence.js";

// ============================================================================
// 扫描输入
// ============================================================================

export interface StructuralEvidenceScanInput {
  /** 最终交付正文（不可被 scanner 修改） */
  finalText: string;
  /** 最终选中的候选 id */
  finalCandidateId: string;
  /** 章节意图（ChapterIntentBuilder 输出） */
  intent: ChapterIntent;
  /** 编译后的上下文（ContextCompiler 输出） */
  context: CompiledContext;
  /** 作品宪法快照（可空） */
  constitution: ConstitutionSnapshot | null;
}

// ============================================================================
// 关键词表（确定性，无 LLM）
// ============================================================================

/** 选择/决策关键词（goal_resistance_choice_result 用） */
const CHOICE_KEYWORDS = [
  "决定", "选择", "拒绝", "接受", "放弃", "付出", "代价",
  "不得不", "只能", "咬牙", "下定决心", "做出了",
];

/** 阻力/冲突关键词（goal_resistance_choice_result 用） */
const RESISTANCE_KEYWORDS = [
  "阻挡", "阻挠", "阻碍", "反对", "拒绝", "威胁", "逼迫",
  "困境", "陷入", "无法", "难以", "不许", "不准",
];

/** 不可逆变化关键词（irreversible_change 用） */
const IRREVERSIBLE_KEYWORDS = [
  "死去", "死亡", "牺牲", "失去", "永远", "再也无法", "无法挽回",
  "彻底", "破碎", "消失", "毁掉", "改变了", "回不去了",
  "付出代价", "再不能",
];

/** 信息释放关键词（five_axis_progression.info 用） */
const INFO_KEYWORDS = [
  "发现", "得知", "揭露", "明白", "意识到", "原来", "真相",
  "秘密", "知道", "确认", "看穿", "识破",
];

/** 因果关键词（five_axis_progression.causal 用） */
const CAUSAL_KEYWORDS = [
  "因为", "所以", "因此", "导致", "于是", "从而", "使得",
  "引起", "源于", "归咎", "多亏", "幸亏",
];

/** 世界规则关键词（five_axis_progression.world 用） */
const WORLD_KEYWORDS = [
  "规则", "法则", "禁制", "阵法", "境界", "功法", "传承",
  "势力", "组织", "门派", "家族", "界", "域",
];

/** 章末压力关键词（end_pressure_causality 用） */
const END_PRESSURE_KEYWORDS = [
  "压力", "危险", "威胁", "逼近", "危机", "阴影",
  "来袭", "冲来", "包围", "锁定", "杀意", "震动", "巨响",
  "倒吸", "心中一沉", "不妙", "变故", "骤然", "陡然",
];

/** 最小有效正文长度（低于此值视为空文本，所有维度降级） */
const MIN_VALID_TEXT_LENGTH = 50;

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 在 text 中查找所有 keyword 出现位置，返回 TextSpan 列表。
 * 每个 span 包含 start/end/excerpt（excerpt 为 keyword 前后各 10 字符的上下文）。
 *
 * span 边界校验（C 类复用 judge-types.ts validateVerdictEvidence 思路）：
 * - start >= 0
 * - end > start
 * - end <= text.length
 */
function findAllSpans(text: string, keywords: string[]): TextSpan[] {
  const spans: TextSpan[] = [];
  const seen = new Set<number>(); // 去重同一 offset
  for (const kw of keywords) {
    if (!kw) continue;
    let from = 0;
    while (true) {
      const idx = text.indexOf(kw, from);
      if (idx < 0) break;
      if (!seen.has(idx)) {
        seen.add(idx);
        const start = Math.max(0, idx - 10);
        const end = Math.min(text.length, idx + kw.length + 10);
        spans.push({
          start: idx,
          end: idx + kw.length,
          excerpt: text.slice(start, end),
        });
      }
      from = idx + kw.length;
    }
  }
  return spans;
}

/**
 * 在 text 中查找某个具体短语（来自 intent 字段）的所有出现位置。
 * 短语长度 < 2 时跳过（避免单字噪声）。
 */
function findPhraseSpans(text: string, phrases: string[]): TextSpan[] {
  const filtered = phrases.filter((p) => typeof p === "string" && p.trim().length >= 2);
  return findAllSpans(text, filtered);
}

/**
 * 从 intent 字段提取关键词用于正文匹配。
 * 去掉前缀标签（如"推进本章功能："、"核心冲突阻力："），只保留核心内容词。
 */
function extractKeywordsFromIntentField(items: string[]): string[] {
  const keywords: string[] = [];
  for (const item of items) {
    if (typeof item !== "string" || !item.trim()) continue;
    // 去掉常见前缀标签
    const cleaned = item.replace(/^[^：:]{2,20}[：:]/, "").trim();
    if (cleaned.length >= 2) {
      keywords.push(cleaned);
      // 也把去掉前缀后的分词片段加入（按顿号/逗号切分）
      const parts = cleaned.split(/[、，,；;]/).map((s) => s.trim()).filter((s) => s.length >= 2);
      keywords.push(...parts);
    } else if (item.trim().length >= 2) {
      keywords.push(item.trim());
    }
  }
  return keywords;
}

/** 生成 evidence id */
function makeId(dimension: StructuralDimension, index: number): string {
  return `structural:${dimension}:${index}`;
}

// ============================================================================
// 5 个维度的扫描器
// ============================================================================

/**
 * 维度 1：chapter_function_delivery
 *
 * 验证：本章功能（intent.chapterFunction + concreteDelivery）是否在正文中有可见结果。
 *
 * 策略：
 * - chapterFunction 为空或"未指定本章功能" → not_applicable
 * - 从 chapterFunction + concreteDelivery 提取关键词，在正文找 span
 * - 找到 span → partial（确定性 scanner 不能证明文学交付，只证明关键词出现）
 * - 找不到 span → risk（chapter function 在正文中无可 见痕迹）
 */
function scanChapterFunctionDelivery(
  text: string,
  intent: ChapterIntent,
  index: number
): StructuralEvidence {
  const dimension: StructuralDimension = "chapter_function_delivery";
  const chapterFunction = intent.chapterFunction ?? "";
  const isUnspecified = !chapterFunction || chapterFunction === "未指定本章功能";

  if (isUnspecified) {
    return {
      id: makeId(dimension, index),
      dimension,
      status: "not_applicable",
      sourceSpans: [],
      expectedRef: "",
      observation: "ChapterIntent.chapterFunction 未指定，无本章功能可验证",
      readerImpact: "本章功能不明确，读者无法判断章节是否达成预期交付",
      severity: "info",
      confidence: 0.9,
      recommendedOwner: "human_review",
      recommendedAction: "补全 ChapterSeed.intent.primary 或 constitution.protagonistCoreConflict",
    };
  }

  const expectedRef = [chapterFunction, ...(intent.concreteDelivery ?? [])]
    .filter(Boolean)
    .join("；");
  const keywords = extractKeywordsFromIntentField([
    chapterFunction,
    ...(intent.concreteDelivery ?? []),
  ]);
  const spans = findPhraseSpans(text, keywords);

  if (spans.length > 0) {
    return {
      id: makeId(dimension, index),
      dimension,
      status: "partial",
      sourceSpans: spans.slice(0, 3), // 最多保留 3 个 span 避免 trace 膨胀
      expectedRef,
      observation: `在正文找到 ${spans.length} 处与本章功能相关的关键词 span（确定性 scanner 只能证明关键词出现，不能证明文学交付质量）`,
      readerImpact: "本章功能在正文中留有痕迹，但是否有效交付需 LLM/人工复核",
      severity: "info",
      confidence: 0.4,
      recommendedOwner: "craft_judge",
      recommendedAction: "LLM 复核本章功能是否真正落地为可见的读者体验",
    };
  }

  return {
    id: makeId(dimension, index),
    dimension,
    status: "risk",
    sourceSpans: [],
    expectedRef,
    observation: "正文中未找到与 chapterFunction / concreteDelivery 相关的关键词 span",
    readerImpact: "本章功能可能未在正文中体现，读者可能感觉章节缺乏明确目的",
    severity: "risk",
    confidence: 0.5,
    recommendedOwner: "human_review",
    recommendedAction: "人工复核正文是否实际交付了 chapterFunction 声明的功能",
  };
}

/**
 * 维度 2：goal_resistance_choice_result
 *
 * 验证：目标、阻力、选择、结果是否形成因果链。
 *
 * 策略：
 * - focusCharacterGoals + resistance + choicesAndCosts 全空 → human_review
 *   （无 expectedRef 无法验证因果链）
 * - 找选择关键词 span + 阻力关键词 span
 * - 两类都找到 → partial（有因果链痕迹）
 * - 只找到一类 → partial（链条不完整）
 * - 都没找到 → risk（文字可能流畅但无目标—阻力—选择—结果推进）
 *
 * 注意（任务规格场景 1）："文字流畅但无推进 → risk 或 human_review"。
 */
function scanGoalResistanceChoiceResult(
  text: string,
  intent: ChapterIntent,
  index: number
): StructuralEvidence {
  const dimension: StructuralDimension = "goal_resistance_choice_result";
  const goals = intent.focusCharacterGoals ?? [];
  const resistance = intent.resistance ?? [];
  const choices = intent.choicesAndCosts ?? [];
  const hasExpectedRef = goals.length > 0 || resistance.length > 0 || choices.length > 0;

  const expectedRef = [
    ...goals.map((g) => `${g.character}: ${g.goal}`),
    ...resistance,
    ...choices.map((c) => `${c.choice}（代价：${c.cost}）`),
  ].join("；");

  if (!hasExpectedRef) {
    return {
      id: makeId(dimension, index),
      dimension,
      status: "human_review",
      sourceSpans: [],
      expectedRef: "",
      observation:
        "ChapterIntent 的 focusCharacterGoals/resistance/choicesAndCosts 均为空，无法验证目标—阻力—选择—结果因果链",
      readerImpact: "本章角色目标与选择不明，因果链无法自动验证",
      severity: "info",
      confidence: 0.8,
      recommendedOwner: "human_review",
      recommendedAction: "人工或 LLM 复核正文是否存在清晰的目标—阻力—选择—结果链条",
    };
  }

  const choiceSpans = findAllSpans(text, CHOICE_KEYWORDS);
  const resistanceSpans = findAllSpans(text, RESISTANCE_KEYWORDS);
  // 也从 intent.resistance 提取具体短语找 span
  const resistancePhraseSpans = findPhraseSpans(text, extractKeywordsFromIntentField(resistance));
  const allResistanceSpans = [...resistanceSpans, ...resistancePhraseSpans];

  const hasChoice = choiceSpans.length > 0;
  const hasResistance = allResistanceSpans.length > 0;

  if (hasChoice && hasResistance) {
    return {
      id: makeId(dimension, index),
      dimension,
      status: "partial",
      sourceSpans: [...choiceSpans.slice(0, 2), ...allResistanceSpans.slice(0, 1)],
      expectedRef,
      observation: `正文同时出现选择关键词（${choiceSpans.length} 处）和阻力关键词（${allResistanceSpans.length} 处），有因果链痕迹`,
      readerImpact: "角色面临阻力并做出选择，但选择—结果环节需 LLM 复核",
      severity: "info",
      confidence: 0.4,
      recommendedOwner: "craft_judge",
      recommendedAction: "LLM 复核选择是否真正对应阻力，结果是否由选择自然推出",
    };
  }

  if (hasChoice || hasResistance) {
    const found = hasChoice ? "选择" : "阻力";
    const missing = hasChoice ? "阻力" : "选择";
    return {
      id: makeId(dimension, index),
      dimension,
      status: "partial",
      sourceSpans: hasChoice ? choiceSpans.slice(0, 2) : allResistanceSpans.slice(0, 2),
      expectedRef,
      observation: `正文只找到 ${found} 关键词，未找到 ${missing} 关键词，因果链不完整`,
      readerImpact: `章节可能缺少 ${missing} 环节，读者可能感觉推进不够扎实`,
      severity: "review",
      confidence: 0.4,
      recommendedOwner: "craft_judge",
      recommendedAction: `LLM 复核正文中 ${missing} 环节是否被其他表达方式覆盖`,
    };
  }

  // 文字可能流畅但无推进
  return {
    id: makeId(dimension, index),
    dimension,
    status: "risk",
    sourceSpans: [],
    expectedRef,
    observation:
      "正文未找到任何选择/阻力关键词，存在文字流畅但无目标—阻力—选择—结果推进的风险",
    readerImpact: "读者可能感觉章节流畅但缺乏实质推进，像填充章",
    severity: "risk",
    confidence: 0.5,
    recommendedOwner: "human_review",
    recommendedAction: "人工复核正文是否实际存在目标—阻力—选择—结果链条（可能用非关键词表达）",
  };
}

/**
 * 维度 3：irreversible_change
 *
 * 验证：是否能找到不可逆变化证据。
 *
 * 策略（任务规格场景 2）："有气氛但无不可逆变化 → irreversible_change 不得 satisfied"。
 * - expectedIrreversibleChange 为空 → human_review（任务规格："无可靠 intent 时 human_review"）
 * - 非空时找不可逆关键词 span
 * - 找到 → partial（确定性 scanner 不能证明"不可逆"，只证明关键词出现）
 * - 找不到 → risk（有 expectedRef 但正文无证据，可能是气氛章无实质变化）
 */
function scanIrreversibleChange(
  text: string,
  intent: ChapterIntent,
  index: number
): StructuralEvidence {
  const dimension: StructuralDimension = "irreversible_change";
  const expected = intent.expectedIrreversibleChange ?? [];

  if (expected.length === 0) {
    return {
      id: makeId(dimension, index),
      dimension,
      status: "human_review",
      sourceSpans: [],
      expectedRef: "",
      observation:
        "ChapterIntent.expectedIrreversibleChange 为空（INTENT-1 修复后 pendingCosts 无 irreversible 标志），无可靠 intent 可验证",
      readerImpact: "本章是否造成不可逆变化无法自动判断",
      severity: "info",
      confidence: 0.8,
      recommendedOwner: "human_review",
      recommendedAction: "人工或 LLM 复核正文是否存在不可逆状态变化",
    };
  }

  const expectedRef = expected.join("；");
  const phraseSpans = findPhraseSpans(text, extractKeywordsFromIntentField(expected));
  const keywordSpans = findAllSpans(text, IRREVERSIBLE_KEYWORDS);
  const allSpans = [...phraseSpans, ...keywordSpans];

  if (allSpans.length > 0) {
    return {
      id: makeId(dimension, index),
      dimension,
      status: "partial",
      sourceSpans: allSpans.slice(0, 3),
      expectedRef,
      observation: `正文找到 ${allSpans.length} 处与不可逆变化相关的关键词 span（确定性 scanner 不能证明真正的不可逆性，只证明关键词出现）`,
      readerImpact: "正文留有不可逆变化痕迹，但是否真正不可逆需 LLM 复核",
      severity: "info",
      confidence: 0.4,
      recommendedOwner: "craft_judge",
      recommendedAction: "LLM 复核该变化是否真正不可逆，是否对后续章节产生约束",
    };
  }

  return {
    id: makeId(dimension, index),
    dimension,
    status: "risk",
    sourceSpans: [],
    expectedRef,
    observation: "expectedIrreversibleChange 非空但正文中未找到任何不可逆变化关键词 span",
    readerImpact: "章节可能有气氛但无实质不可逆变化，读者可能感觉推进不扎实",
    severity: "risk",
    confidence: 0.5,
    recommendedOwner: "human_review",
    recommendedAction: "人工复核正文是否实际产生了不可逆变化（可能用非关键词表达）",
  };
}

/**
 * 维度 4：five_axis_progression
 *
 * 验证：情节/信息/角色/世界/因果五维中哪些有有效 delta。
 *
 * 策略（任务规格场景 3）："低情节余震章仍有角色/因果推进 → 不得因外部事件少而误判失败"。
 * - 逐轴找证据：
 *   - plot：text 长度 > MIN_VALID_TEXT_LENGTH（粗略代理，不作为硬指标）
 *   - info：INFO_KEYWORDS 出现 span
 *   - character：intent.relevantCharacters 中角色名在正文出现 span
 *   - world：WORLD_KEYWORDS 或 context.worldRules 描述词出现 span
 *   - causal：CAUSAL_KEYWORDS 出现 span
 * - 统计有效轴数（不计 plot，因为 plot 只验证非空）
 * - ≥2 轴有 span → partial（有推进痕迹）
 * - 1 轴有 span → partial（低情节章但仍有某维推进，不误判失败）
 * - 0 轴 → risk
 *
 * 重要：不因外部事件少（plot 轴弱）而把角色/因果推进也判为失败。
 */
function scanFiveAxisProgression(
  text: string,
  intent: ChapterIntent,
  context: CompiledContext,
  index: number
): StructuralEvidence {
  const dimension: StructuralDimension = "five_axis_progression";

  const axes: Array<{
    axis: string;
    spans: TextSpan[];
    note: string;
  }> = [];

  // 情节轴：用文本长度作粗略代理（不作为硬指标，只记录 observation）
  const plotSpan: TextSpan[] =
    text.length >= MIN_VALID_TEXT_LENGTH
      ? [{ start: 0, end: Math.min(text.length, 50), excerpt: text.slice(0, 50) }]
      : [];
  axes.push({
    axis: "plot",
    spans: plotSpan,
    note: plotSpan.length > 0 ? `正文长度 ${text.length} 字符（>= ${MIN_VALID_TEXT_LENGTH}）` : `正文过短（${text.length} < ${MIN_VALID_TEXT_LENGTH}）`,
  });

  // 信息轴
  const infoSpans = findAllSpans(text, INFO_KEYWORDS);
  axes.push({
    axis: "info",
    spans: infoSpans,
    note: infoSpans.length > 0 ? `找到 ${infoSpans.length} 处信息释放关键词` : "未找到信息释放关键词",
  });

  // 角色轴：relevantCharacters 角色名在正文出现
  const charSpans = intent.relevantCharacters.length > 0
    ? findPhraseSpans(text, intent.relevantCharacters)
    : [];
  axes.push({
    axis: "character",
    spans: charSpans,
    note: charSpans.length > 0
      ? `找到 ${charSpans.length} 处角色名出现`
      : intent.relevantCharacters.length === 0
        ? "ChapterIntent.relevantCharacters 为空"
        : "relevantCharacters 角色名未在正文出现",
  });

  // 世界轴：WORLD_KEYWORDS + context.worldRules 描述词
  const worldKeywordSpans = findAllSpans(text, WORLD_KEYWORDS);
  const worldRuleSpans = findPhraseSpans(
    text,
    context.worldRules.map((r) => r.description).filter(Boolean)
  );
  const worldSpans = [...worldKeywordSpans, ...worldRuleSpans];
  axes.push({
    axis: "world",
    spans: worldSpans,
    note: worldSpans.length > 0 ? `找到 ${worldSpans.length} 处世界规则关键词` : "未找到世界规则关键词",
  });

  // 因果轴
  const causalSpans = findAllSpans(text, CAUSAL_KEYWORDS);
  axes.push({
    axis: "causal",
    spans: causalSpans,
    note: causalSpans.length > 0 ? `找到 ${causalSpans.length} 处因果关键词` : "未找到因果关键词",
  });

  // 统计有效轴数（plot 不计入硬性统计，只作 observation）
  const nonPlotAxes = axes.filter((a) => a.axis !== "plot");
  const effectiveAxes = nonPlotAxes.filter((a) => a.spans.length > 0);
  const effectiveCount = effectiveAxes.length;

  // 收集所有 span（每轴最多 1 个，避免膨胀）
  const allSpans: TextSpan[] = [];
  for (const a of effectiveAxes) {
    allSpans.push(a.spans[0]);
  }

  const expectedRef = `五维推进：情节(长度代理)/信息(${INFO_KEYWORDS.length}关键词)/角色(${intent.relevantCharacters.length}个)/世界(${context.worldRules.length}条规则)/因果(${CAUSAL_KEYWORDS.length}关键词)`;
  const observation = `五维扫描结果：${axes.map((a) => `${a.axis}=${a.spans.length > 0 ? "有" : "无"}`).join("/")}；有效轴数（非 plot）= ${effectiveCount}/4`;

  // 低情节余震章保护：只要 ≥1 轴有推进，就不判 risk
  if (effectiveCount >= 2) {
    return {
      id: makeId(dimension, index),
      dimension,
      status: "partial",
      sourceSpans: allSpans.slice(0, 3),
      expectedRef,
      observation,
      readerImpact: `${effectiveCount} 个维度有推进痕迹（${effectiveAxes.map((a) => a.axis).join("/")}），章节有实质 delta`,
      severity: "info",
      confidence: 0.4,
      recommendedOwner: "craft_judge",
      recommendedAction: "LLM 复核各轴推进是否有效且服务于本章功能",
    };
  }

  if (effectiveCount === 1) {
    return {
      id: makeId(dimension, index),
      dimension,
      status: "partial",
      sourceSpans: allSpans.slice(0, 1),
      expectedRef,
      observation,
      readerImpact: `仅 ${effectiveAxes[0].axis} 轴有推进痕迹（低情节余震章仍可能有角色/因果推进，不误判失败）`,
      severity: "review",
      confidence: 0.4,
      recommendedOwner: "craft_judge",
      recommendedAction: "LLM 复核其余维度是否用非关键词方式推进",
    };
  }

  return {
    id: makeId(dimension, index),
    dimension,
    status: "risk",
    sourceSpans: [],
    expectedRef,
    observation: `${observation}；非 plot 四轴均无 span，章节可能无实质推进`,
    readerImpact: "章节可能在五个维度上都缺乏推进，读者可能感觉填充",
    severity: "risk",
    confidence: 0.5,
    recommendedOwner: "human_review",
    recommendedAction: "人工复核正文是否实际存在任一维度推进（可能用非关键词表达）",
  };
}

/**
 * 维度 5：end_pressure_causality
 *
 * 验证：章末压力是否由本章结果自然推出。
 *
 * 策略：
 * - causalEndPressure 为空 → human_review（无 expectedRef 无法验证因果性）
 * - 非空时检查正文末尾 ~20% 是否有压力关键词 span
 * - 找到 → partial（有章末压力痕迹，但因果性需 LLM 复核）
 * - 找不到 → risk（章末无压力信号）
 */
function scanEndPressureCausality(
  text: string,
  intent: ChapterIntent,
  index: number
): StructuralEvidence {
  const dimension: StructuralDimension = "end_pressure_causality";
  const expected = intent.causalEndPressure ?? [];

  if (expected.length === 0) {
    return {
      id: makeId(dimension, index),
      dimension,
      status: "human_review",
      sourceSpans: [],
      expectedRef: "",
      observation:
        "ChapterIntent.causalEndPressure 为空（INTENT-1 修复后 thematicQuestions/openArcs 不自动等于因果章末压力），无可靠 intent 可验证",
      readerImpact: "章末压力的因果性无法自动判断",
      severity: "info",
      confidence: 0.8,
      recommendedOwner: "human_review",
      recommendedAction: "人工或 LLM 复核章末是否存在由本章结果自然推出的压力",
    };
  }

  const expectedRef = expected.join("；");
  // 检查正文末尾 ~20%
  const tailStart = Math.floor(text.length * 0.8);
  const tailText = text.slice(tailStart);
  const pressureSpans = findAllSpans(tailText, END_PRESSURE_KEYWORDS);
  // 调整 span offset 到全文坐标
  const adjustedSpans: TextSpan[] = pressureSpans.map((s) => ({
    start: s.start + tailStart,
    end: s.end + tailStart,
    excerpt: s.excerpt,
  }));

  if (adjustedSpans.length > 0) {
    return {
      id: makeId(dimension, index),
      dimension,
      status: "partial",
      sourceSpans: adjustedSpans.slice(0, 2),
      expectedRef,
      observation: `正文末尾 20% 找到 ${adjustedSpans.length} 处压力关键词 span（确定性 scanner 不能证明因果性，只证明压力信号出现）`,
      readerImpact: "章末留有压力痕迹，但是否由本章结果自然推出需 LLM 复核",
      severity: "info",
      confidence: 0.4,
      recommendedOwner: "craft_judge",
      recommendedAction: "LLM 复核章末压力是否由本章结果因果推出，而非随机钩子",
    };
  }

  return {
    id: makeId(dimension, index),
    dimension,
    status: "risk",
    sourceSpans: [],
    expectedRef,
    observation: "expected causalEndPressure 非空但正文末尾 20% 未找到任何压力关键词 span",
    readerImpact: "章节可能缺乏章末压力，读者可能没有继续阅读的拉力",
    severity: "risk",
    confidence: 0.5,
    recommendedOwner: "human_review",
    recommendedAction: "人工复核正文末尾是否存在由本章结果推出的压力（可能用非关键词表达）",
  };
}

// ============================================================================
// 主扫描函数
// ============================================================================

/**
 * 从最终正文生成 structuralEvidence。
 *
 * 纯本地确定性提取，零 LLM 调用。不修改 finalText，不触发改文/重写/候选生成。
 *
 * @returns StructuralEvidenceScanResult，含 5 条 evidence（每维度一条）。
 */
export function scanStructuralEvidence(
  input: StructuralEvidenceScanInput
): StructuralEvidenceScanResult {
  const { finalText, finalCandidateId, intent, context } = input;
  const evidence: StructuralEvidence[] = [];

  evidence.push(scanChapterFunctionDelivery(finalText, intent, 0));
  evidence.push(scanGoalResistanceChoiceResult(finalText, intent, 1));
  evidence.push(scanIrreversibleChange(finalText, intent, 2));
  evidence.push(scanFiveAxisProgression(finalText, intent, context, 3));
  evidence.push(scanEndPressureCausality(finalText, intent, 4));

  // 不变量自检：每条 evidence 必须通过 validateStructuralEvidence
  for (const e of evidence) {
    const err = validateStructuralEvidence(e, finalText.length);
    if (err) {
      // 不变量违反：降级为 human_review 并保留错误信息（不抛异常，scanner 不阻断生成）
      e.status = "human_review";
      e.sourceSpans = [];
      e.observation = `[scanner 不变量自检失败：${err}] ${e.observation}`;
      e.severity = "review";
      e.confidence = 0.1;
    }
  }

  return {
    evidence,
    scannedTextLength: finalText.length,
    scannedCandidateId: finalCandidateId,
    skipped: false,
  };
}

/**
 * 将 StructuralEvidenceScanResult 转为 ChapterQualityEvidence（写入 stageResults 用）。
 */
export function toChapterQualityEvidence(
  result: StructuralEvidenceScanResult
): ChapterQualityEvidence {
  return {
    structuralEvidence: result.evidence,
    structuralEvidenceMeta: {
      skipped: result.skipped,
      skippedReason: result.skippedReason,
      scannedCandidateId: result.scannedCandidateId,
      scannedTextLength: result.scannedTextLength,
      scannedAt: Date.now(),
    },
  };
}

/**
 * 构造 skipped ChapterQualityEvidence（hardBlock/raw 生成失败路径用）。
 *
 * 任务规格："hardBlock/raw 生成失败路径可跳过，但要写清 skipped reason"。
 */
export function skippedChapterQualityEvidence(
  candidateId: string | "",
  reason: string
): ChapterQualityEvidence {
  return {
    structuralEvidence: [],
    structuralEvidenceMeta: {
      skipped: true,
      skippedReason: reason,
      scannedCandidateId: candidateId,
      scannedTextLength: 0,
      scannedAt: Date.now(),
    },
  };
}
