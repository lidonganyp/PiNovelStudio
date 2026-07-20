/**
 * EndingCraftEvidenceScanner — 章末收束/钩子证据扫描器（QUALITY-9 最小切片）
 *
 * 目标：在 finalText 确定后，只读扫描章节结尾是否具备继续阅读驱动力。
 * 只诊断，不改文，不阻断，不生成候选。
 *
 * 核心不变量（QUALITY-9 任务书）：
 * - 只输出 evidence（span/证据/置信度/读者影响/建议 owner），不输出总分。
 * - status 只允许：partial / risk / human_review / not_applicable / skipped。
 * - partial/risk/human_review 必须带有效 sourceSpans；没有 span 不得给这三个状态。
 * - 不得返回 satisfied，不宣称质量达标。
 * - scanner 异常不能阻断生成，只写 skipped + warning。
 * - 不修改 finalText，不触发 StyleShaper / language patch / candidate rewrite。
 * - 不改 judge/selection，不提交长期状态，不调用模型。
 * - 不含 aggregateQualityScore / totalScore / 文学总分 / pass|fail 总判定 / 自动改文建议字段。
 *
 * 复用资产（A-E 分类见历史任务清单，文档已删除）：
 * - A：TextSpan（types.ts:295）直接复用；scanStructuralEvidence 的 findAllSpans /
 *   findPhraseSpans / MIN_VALID_TEXT_LENGTH 模式（structural-evidence-scanner.ts）。
 * - B：ChapterIntent.causalEndPressure / possibleEndPressure 作为尾段压力语境参考。
 * - C（只读证据，不复用控制权）：
 *   - structural-evidence-scanner.ts 的 END_PRESSURE_KEYWORDS（压力/危险/威胁/逼近/危机…）。
 *   - craft/ending-quality-checker.ts 的 narrativeSummaryPatterns（从此/之后/最后/终于/
 *     结局/故事/本书/全书/全剧/完/结束/终章）+ last500Chars/lastParagraph 提取模式。
 *   - craft/ending-quality-checker.ts 的 newInfoPatterns（原来/竟然/没想到/突然/立刻/马上）。
 * - D（概念借用，不直接复用 LLM 耦合代码）：
 *   - AI小说生成智能体 历史文档（文档已删除） §4.3 章末钩子五种类型（倒计时/信息炸弹/反转/情感悬置/危机逼近）。
 *   - AI小说生成智能体 历史文档（文档已删除） §11 收尾与结局工艺（余震/钩子/收束）。
 *   - workflow/chapter-end-hook-guidance.ts 的 hookType 概念（question-cut/emotion-suspense/cost）。
 * - E（退役，不得继承）：ending-quality-checker 的 q4_composite_score 0-1 总分、
 *   grade pass|acceptable|warning|critical 总判定、recommendations 改写建议；
 *   closure-completeness-scanner 的 D1-D6 加权 score/weight；
 *   rotting-ending-detector 的 closing gate；Stage0-8 Ending/Hook gate 的 block/rewrite 权限。
 *
 * 3 个维度的扫描策略（诚实原则：能找到 span 才给状态，否则 not_applicable/human_review）：
 * 1. tail_pressure：扫描正文最后 TAIL_SCAN_LENGTH 字（300-500）。
 *    - 尾段有未解决压力/行动中断/危险逼近/承诺牵引/问题悬置信号 → partial
 *    - 尾段完全平收、无下一章牵引 → human_review（无信号也无明确闭合词）或 risk（无信号 + 有闭合词）
 *    - 必须带尾段 span。
 * 2. flat_summary_ending：检测"总结式/交代式/作者说明式"结尾风险。
 *    - 强闭合词（总之/从此/一切结束/他终于明白了全部/本章到此/至此/完结/落幕/总而言之/综上所述/全剧终/故事结束）→ risk
 *    - 弱闭合词（最后/终于/结束/结局/完了/终章）→ human_review
 *    - 无闭合词 → not_applicable
 *    - 必须带 span。
 * 3. hook_or_question：检测是否存在问句、反常细节、未解释现象、人物即将行动、危险/秘密逼近。
 *    - 有证据 → partial
 *    - 没有明确证据 → human_review
 *    - 不得返回 satisfied。
 *
 * 确定性本地扫描：零 LLM 调用，纯正则 + 关键词匹配。
 */

import type { TextSpan } from "./types.js";
import type { ChapterIntent } from "./chapter-intent-builder.js";

// ============================================================================
// 数据契约
// ============================================================================

/**
 * 章末收束/钩子证据维度（QUALITY-9 最小覆盖 3 维）。
 *
 * 映射关系（C/D 类 legacy 概念借用，不直接复用 LLM 耦合代码）：
 * - tail_pressure ← structural-evidence-scanner 的 end_pressure_causality 的"读者拉力"补充
 *   （QUALITY-3 的 end_pressure_causality 验证 intent.causalEndPressure 对齐；
 *   本维度验证读者继续阅读驱动力，二者互补不重叠）+ ending-quality-checker Q2 afterglow 的尾段信号。
 * - flat_summary_ending ← ending-quality-checker 的 narrativeSummaryPatterns
 *   + AI小说生成智能体 历史文档（文档已删除） §11 "总结式结尾"风险。
 * - hook_or_question ← AI小说生成智能体 历史文档（文档已删除） §4.3 章末钩子五种类型
 *   + workflow/chapter-end-hook-guidance.ts 的 hookType 概念。
 */
export type EndingCraftDimension =
  | "tail_pressure"
  | "flat_summary_ending"
  | "hook_or_question";

/**
 * 章末收束/钩子证据状态（QUALITY-9 任务书规定，无 satisfied）。
 *
 * 语义：
 * - partial：有 span 证明尾段存在继续阅读驱动力（压力/钩子/问句/反常细节等），但不足以宣称完全达标。
 * - risk：有 span 证明存在明显平收/总结式结尾风险（强闭合词 + 无牵引）。
 * - human_review：有 span 但确定性 scanner 无法判定，需人工/LLM 复核。
 * - not_applicable：本章无相关信号（如尾段无闭合词、正文过短）。
 * - skipped：hardBlock / scanner 异常路径，无 finalText 可扫描。
 *
 * 严格禁止 satisfied：任务书"不得返回 satisfied，不宣称质量达标"。
 */
export type EndingCraftStatus =
  | "partial"
  | "risk"
  | "human_review"
  | "not_applicable"
  | "skipped";

/**
 * 单条章末收束/钩子证据（8 个必填字段，QUALITY-9 任务书规定）。
 *
 * 不变量：
 * - status=partial/risk/human_review 时 sourceSpans 必须非空（无 span 不得给这三态）。
 * - sourceSpans 的 start/end 必须在 [0, finalText.length] 范围内，end > start。
 * - confidence ∈ [0, 1]：本地确定性 scanner 通常 0.3-0.6，不假装高置信。
 * - suggestedOwner 只建议归属（如 "human_review" / "craft_judge"），不强制，不含改文指令。
 * - 不含 expectedRef / severity / recommendedAction / fix / score / pass|fail 等字段（任务书契约）。
 */
export interface EndingCraftEvidence {
  /** 维度 id */
  dimensionId: EndingCraftDimension;
  /** 证据状态 */
  status: EndingCraftStatus;
  /** finding id，格式 `endingCraft:{dimension}:{index}` */
  findingId: string;
  /**
   * 支撑该证据的正文 span 列表。
   * status=partial/risk/human_review 时必须非空；
   * status=not_applicable/skipped 时可为空。
   */
  sourceSpans: TextSpan[];
  /** 观察到的事实：scanner 在正文中实际找到的信号描述（不含改文建议）。 */
  evidence: string;
  /** 读者影响：该章末状态对读者体验的潜在影响描述（advisory）。 */
  readerImpact: string;
  /** 建议 owner：谁应该处理这条证据（advisory，不强制，不含改文指令）。 */
  suggestedOwner: string;
  /** 置信度 ∈ [0, 1]，本地确定性 scanner 通常较低 */
  confidence: number;
}

/**
 * 章末收束/钩子证据扫描结果。
 */
export interface EndingCraftScanResult {
  /** 全部章末证据（按 dimension 顺序） */
  evidence: EndingCraftEvidence[];
  /** 被扫描的正文长度（finalText.length） */
  scannedTextLength: number;
  /** 被扫描的候选 id */
  scannedCandidateId: string;
  /** 是否跳过扫描（hardBlock/scanner 异常路径） */
  skipped: boolean;
  /** 跳过原因（skipped=true 时必填） */
  skippedReason?: string;
}

/**
 * 写入 stageResults.endingCraftEvidence 的结构。
 *
 * 严格禁止：
 * - aggregateQualityScore / totalScore / 文学总分 / pass|fail 总判定等聚合字段；
 * - 任何触发改文/重写/候选生成的字段；
 * - 任何 gate/hard_block 权限字段。
 */
export interface EndingCraftEvidenceReport {
  evidence: EndingCraftEvidence[];
  meta: {
    skipped: boolean;
    skippedReason?: string;
    scannedCandidateId: string;
    scannedTextLength: number;
    /** 扫描时间戳（ms），供 trace 审计 */
    scannedAt: number;
  };
}

// ============================================================================
// 扫描输入
// ============================================================================

export interface EndingCraftScanInput {
  /** 最终交付正文（不可被 scanner 修改） */
  finalText: string;
  /** 最终选中的候选 id */
  finalCandidateId: string;
  /** 章节意图（用于 causalEndPressure/possibleEndPressure 语境参考，可空字段） */
  intent: ChapterIntent;
}

// ============================================================================
// 关键词表 / 正则（确定性，无 LLM）
// ============================================================================
//
// 复用来源（C 类只读证据）：
// - END_PRESSURE_KEYWORDS ← structural-evidence-scanner.ts:118-122
// - narrativeSummaryPatterns ← craft/ending-quality-checker.ts:338-342
// - newInfoPatterns ← craft/ending-quality-checker.ts:330-334
// 改造点：legacy 用 0-1 总分 + pass/fail grade（E 退役），本切片只用关键词做 span 定位，
// 不做 pass/warning/fail 总分判定。

/**
 * 尾段扫描长度（字符）。任务书"最后 300-500 字"，取上限 500 提高召回。
 */
const TAIL_SCAN_LENGTH = 500;

/**
 * 尾段最小有效长度（字符）。低于此值尾段信号不足，降级处理。
 */
const TAIL_MIN_LENGTH = 80;

/**
 * 最小有效正文长度（低于此值视为空文本，所有维度降级）。
 * 复用 structural-evidence-scanner.ts:125 同值。
 */
const MIN_VALID_TEXT_LENGTH = 50;

/**
 * 尾段压力/牵引关键词（tail_pressure 用）。
 * 复用自 structural-evidence-scanner.ts END_PRESSURE_KEYWORDS（C 类只读证据），
 * 补充"行动中断/承诺牵引/问题悬置"三类信号（任务书要求）。
 *
 * 分类：
 * - 未解决压力 / 危险逼近：压力/危险/威胁/逼近/危机/阴影/来袭/冲来/包围/锁定/杀意/震动/巨响/倒吸/心中一沉/不妙/变故/骤然/陡然
 * - 行动中断：还没/尚未/正要/来不及/被打断/未完/话未
 * - 承诺牵引：承诺/答应/约定/誓言/必须去找/得去/要去找
 * - 问题悬置：悬念/谜团/疑问/不知道/究竟是/到底/为何/何人/何故
 */
const TAIL_PRESSURE_KEYWORDS = [
  // 未解决压力 / 危险逼近（← structural-evidence-scanner END_PRESSURE_KEYWORDS）
  "压力", "危险", "威胁", "逼近", "危机", "阴影",
  "来袭", "冲来", "包围", "锁定", "杀意", "震动", "巨响",
  "倒吸", "心中一沉", "不妙", "变故", "骤然", "陡然",
  // 行动中断
  "还没", "尚未", "正要", "来不及", "被打断", "未完", "话未",
  // 承诺牵引
  "承诺", "答应", "约定", "誓言", "必须去找", "得去", "要去找",
  // 问题悬置
  "悬念", "谜团", "疑问", "不知道", "究竟是", "到底", "为何", "何人", "何故",
];

/**
 * 强闭合词（flat_summary_ending 用，命中 → risk）。
 * 这些是典型"作者说明式/总结式"收束，出现且无新压力时是平收强信号。
 * 包含任务书示例：总之/从此/一切结束/他终于明白了全部/本章到此。
 * 补充 ending-quality-checker narrativeSummaryPatterns 中的强信号。
 */
const FLAT_SUMMARY_STRONG_KEYWORDS = [
  "总之", "从此", "从此以后", "一切结束", "他终于明白了全部", "本章到此",
  "至此", "完结", "落幕", "总而言之", "综上所述", "全剧终", "故事结束",
  "就这样结束", "到此结束",
];

/**
 * 弱闭合词（flat_summary_ending 用，命中 → human_review）。
 * 这些词可能出现在叙事中（非必然闭合），确定性 scanner 无法确认，需人工复核。
 * ← craft/ending-quality-checker.ts:338-342 narrativeSummaryPatterns 的弱信号成员。
 */
const FLAT_SUMMARY_WEAK_KEYWORDS = [
  "最后", "终于", "结束了", "结局", "终章", "完了", "全书", "全剧",
];

/**
 * 钩子/问句信号关键词（hook_or_question 用）。
 * 映射 AI小说生成智能体 历史文档（文档已删除） §4.3 五种钩子类型 + ending-quality-checker newInfoPatterns。
 *
 * 分类：
 * - 反常细节：突然/竟然/居然/意外/想不到/没想到（← ending-quality-checker newInfoPatterns）
 * - 未解释现象：神秘/诡异/奇怪/未知/不可解释/谜团/谜
 * - 人物即将行动：正要/准备/刚要/打算/即将/就要/正欲
 * - 危险/秘密逼近：逼近/靠近/来袭/浮现/露出/现身/悄悄/潜来
 */
const HOOK_QUESTION_KEYWORDS = [
  // 反常细节（← ending-quality-checker newInfoPatterns）
  "突然", "竟然", "居然", "意外", "想不到", "没想到",
  // 未解释现象
  "神秘", "诡异", "奇怪", "未知", "不可解释", "谜团",
  // 人物即将行动
  "正要", "准备", "刚要", "打算", "即将", "就要", "正欲",
  // 危险/秘密逼近
  "逼近", "靠近", "来袭", "浮现", "露出", "现身", "悄悄", "潜来",
];

/** 问号正则（中英文问句标记，hook_or_question 用）。 */
const QUESTION_MARK_PATTERN = /[？?]/g;

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 在 text 中查找所有 keyword 出现位置，返回 TextSpan 列表。
 * 复用自 structural-evidence-scanner.ts:findAllSpans / information-release-evidence-scanner.ts:findAllSpans（A 类基础设施）。
 *
 * span 边界校验：start >= 0, end > start, end <= text.length。
 * 支持 offset 偏移（用于尾段子串扫描时回填全文坐标）。
 */
function findAllSpans(
  text: string,
  keywords: string[],
  offset: number = 0
): TextSpan[] {
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
        const excerptStart = Math.max(0, idx - 10);
        const excerptEnd = Math.min(text.length, idx + kw.length + 10);
        spans.push({
          start: idx + offset,
          end: idx + kw.length + offset,
          excerpt: text.slice(excerptStart, excerptEnd),
        });
      }
      from = idx + kw.length;
    }
  }
  return spans;
}

/**
 * 用正则在 text 中查找所有匹配，返回 TextSpan 列表（去重同 offset）。
 * 支持 offset 偏移（用于尾段子串扫描时回填全文坐标）。
 */
function findAllRegexSpans(
  text: string,
  pattern: RegExp,
  offset: number = 0
): TextSpan[] {
  const spans: TextSpan[] = [];
  const seen = new Set<number>();
  const re = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const idx = match.index;
    const len = match[0].length;
    if (len === 0) {
      re.lastIndex++;
      continue;
    }
    if (!seen.has(idx)) {
      seen.add(idx);
      const excerptStart = Math.max(0, idx - 10);
      const excerptEnd = Math.min(text.length, idx + len + 10);
      spans.push({
        start: idx + offset,
        end: idx + len + offset,
        excerpt: text.slice(excerptStart, excerptEnd),
      });
    }
    if (re.lastIndex === idx) {
      re.lastIndex += len;
    }
  }
  return spans;
}

/**
 * 提取正文尾段子串及其在全文中的起始 offset。
 * 尾段长度 = min(TAIL_SCAN_LENGTH, text.length)。
 * @returns { tail, tailStart }：tail 为尾段子串，tailStart 为其在全文中的起始位置。
 */
function extractTail(text: string): { tail: string; tailStart: number } {
  if (text.length <= TAIL_SCAN_LENGTH) {
    return { tail: text, tailStart: 0 };
  }
  const tailStart = text.length - TAIL_SCAN_LENGTH;
  return { tail: text.slice(tailStart), tailStart };
}

/** 生成 finding id */
function makeFindingId(dimension: EndingCraftDimension, index: number): string {
  return `endingCraft:${dimension}:${index}`;
}

// ============================================================================
// 维度 1：tail_pressure — 尾段继续阅读驱动力
// ============================================================================

/**
 * 扫描正文最后 TAIL_SCAN_LENGTH 字，检测是否存在继续阅读驱动力信号。
 *
 * 策略（诚实原则）：
 * - 正文过短 → not_applicable
 * - 尾段有压力/牵引关键词 → partial（span = 首个信号位置）
 *   （确定性 scanner 只能证明关键词出现，不能证明"文学上有效牵引"）
 * - 尾段无信号 + 有强闭合词 → risk（平收 + 闭合，无下一章牵引）
 * - 尾段无信号 + 无强闭合词 → human_review（无牵引信号但 scanner 不能确认是否真平收，需人工复核）
 * - 尾段过短（< TAIL_MIN_LENGTH）→ human_review（span = 尾段，信号不足无法判定）
 *
 * 不调用 LLM，不修改 finalText。绝不返回 satisfied。
 */
function scanTailPressure(
  text: string,
  index: number
): EndingCraftEvidence {
  const dimension: EndingCraftDimension = "tail_pressure";

  if (text.length < MIN_VALID_TEXT_LENGTH) {
    return {
      dimensionId: dimension,
      status: "not_applicable",
      findingId: makeFindingId(dimension, index),
      sourceSpans: [],
      evidence: `正文过短（${text.length} < ${MIN_VALID_TEXT_LENGTH}），无尾段压力可检测`,
      readerImpact: "正文过短，不存在尾段牵引问题",
      suggestedOwner: "human_review",
      confidence: 0.8,
    };
  }

  const { tail, tailStart } = extractTail(text);

  // 尾段过短 → human_review（span = 尾段全文）
  if (tail.length < TAIL_MIN_LENGTH) {
    return {
      dimensionId: dimension,
      status: "human_review",
      findingId: makeFindingId(dimension, index),
      sourceSpans: [
        {
          start: tailStart,
          end: text.length,
          excerpt: tail.slice(0, 80) + (tail.length > 80 ? "…" : ""),
        },
      ],
      evidence: `尾段过短（${tail.length} < ${TAIL_MIN_LENGTH}字），压力信号不足，scanner 无法判定是否存在继续阅读牵引`,
      readerImpact: "尾段过短，读者可能感受不到明确的下一章牵引，需人工评估",
      suggestedOwner: "human_review",
      confidence: 0.4,
    };
  }

  // 尾段压力/牵引信号
  const pressureSpans = findAllSpans(tail, TAIL_PRESSURE_KEYWORDS, tailStart);
  if (pressureSpans.length > 0) {
    return {
      dimensionId: dimension,
      status: "partial",
      findingId: makeFindingId(dimension, index),
      sourceSpans: pressureSpans.slice(0, 3),
      evidence: `尾段检测到 ${pressureSpans.length} 处继续阅读牵引信号（未解决压力/行动中断/危险逼近/承诺牵引/问题悬置）。确定性 scanner 只能证明关键词出现，不能证明"文学上有效牵引"，不得宣称完全达标`,
      readerImpact: "尾段存在牵引信号，读者有继续阅读的驱动力，但整体收束工艺需 LLM 复核",
      suggestedOwner: "craft_judge",
      confidence: 0.4,
    };
  }

  // 尾段无牵引信号：检查是否有强闭合词（平收确认）
  const strongClosureSpans = findAllSpans(tail, FLAT_SUMMARY_STRONG_KEYWORDS, tailStart);
  if (strongClosureSpans.length > 0) {
    return {
      dimensionId: dimension,
      status: "risk",
      findingId: makeFindingId(dimension, index),
      sourceSpans: strongClosureSpans.slice(0, 3),
      evidence: `尾段未检测到继续阅读牵引信号，但存在强闭合词（${strongClosureSpans.length} 处：总之/从此/一切结束/本章到此/至此/完结 等）。这是典型平收 + 闭合结尾，无下一章牵引`,
      readerImpact: "章末平收且无牵引信号，读者缺乏继续阅读的驱动力，弃书风险升高",
      suggestedOwner: "human_review",
      confidence: 0.5,
    };
  }

  // 尾段无牵引信号 + 无强闭合词 → human_review（span = 尾段）
  return {
    dimensionId: dimension,
    status: "human_review",
    findingId: makeFindingId(dimension, index),
    sourceSpans: [
      {
        start: tailStart,
        end: text.length,
        excerpt: tail.slice(0, 80) + (tail.length > 80 ? "…" : ""),
      },
    ],
    evidence: `尾段（最后${tail.length}字）未检测到继续阅读牵引信号，也无强闭合词。确定性 scanner 无法确认是否真平收（可能用非关键词方式牵引），需人工复核`,
    readerImpact: "尾段无明显牵引信号，读者可能感受不到下一章驱动力，需人工评估",
    suggestedOwner: "human_review",
    confidence: 0.4,
  };
}

// ============================================================================
// 维度 2：flat_summary_ending — 总结式/交代式/作者说明式结尾风险
// ============================================================================

/**
 * 检测"总结式/交代式/作者说明式"结尾风险。
 *
 * 策略（任务书："命中 → risk 或 human_review"）：
 * - 正文过短 → not_applicable
 * - 尾段有强闭合词（总之/从此/一切结束/他终于明白了全部/本章到此/至此/完结/落幕/总而言之/综上所述/全剧终/故事结束）→ risk
 * - 尾段有弱闭合词（最后/终于/结束了/结局/终章/完了/全书/全剧）→ human_review
 * - 无闭合词 → not_applicable
 *
 * 强闭合词是典型"作者说明式"收束（作者直接跳出来总结），命中即风险。
 * 弱闭合词可能出现在叙事中（如"最后他走了"是叙事不是总结），scanner 无法确认，需人工复核。
 *
 * 不调用 LLM，不修改 finalText。
 */
function scanFlatSummaryEnding(
  text: string,
  index: number
): EndingCraftEvidence {
  const dimension: EndingCraftDimension = "flat_summary_ending";

  if (text.length < MIN_VALID_TEXT_LENGTH) {
    return {
      dimensionId: dimension,
      status: "not_applicable",
      findingId: makeFindingId(dimension, index),
      sourceSpans: [],
      evidence: `正文过短（${text.length} < ${MIN_VALID_TEXT_LENGTH}），无总结式结尾可检测`,
      readerImpact: "正文过短，不存在总结式结尾风险",
      suggestedOwner: "human_review",
      confidence: 0.8,
    };
  }

  const { tail, tailStart } = extractTail(text);

  // 强闭合词 → risk
  const strongSpans = findAllSpans(tail, FLAT_SUMMARY_STRONG_KEYWORDS, tailStart);
  if (strongSpans.length > 0) {
    return {
      dimensionId: dimension,
      status: "risk",
      findingId: makeFindingId(dimension, index),
      sourceSpans: strongSpans.slice(0, 3),
      evidence: `尾段检测到 ${strongSpans.length} 处强闭合词（总之/从此/一切结束/他终于明白了全部/本章到此/至此/完结/落幕/总而言之/综上所述/全剧终/故事结束）。这是典型"总结式/交代式/作者说明式"收束，没有新压力`,
      readerImpact: `作者直接总结收束会打断叙事沉浸，读者感到"故事讲完了"而非"被牵引到下一章"`,
      suggestedOwner: "human_review",
      confidence: 0.5,
    };
  }

  // 弱闭合词 → human_review
  const weakSpans = findAllSpans(tail, FLAT_SUMMARY_WEAK_KEYWORDS, tailStart);
  if (weakSpans.length > 0) {
    return {
      dimensionId: dimension,
      status: "human_review",
      findingId: makeFindingId(dimension, index),
      sourceSpans: weakSpans.slice(0, 3),
      evidence: `尾段检测到 ${weakSpans.length} 处弱闭合词（最后/终于/结束了/结局/终章/完了/全书/全剧）。这些词可能出现在叙事中（如"最后他走了"是叙事不是总结），确定性 scanner 无法确认是否为总结式收束，需人工复核`,
      readerImpact: "尾段含可能用于总结的词，但无法确认是否为作者说明式收束，读者体验需人工评估",
      suggestedOwner: "human_review",
      confidence: 0.4,
    };
  }

  // 无闭合词 → not_applicable
  return {
    dimensionId: dimension,
    status: "not_applicable",
    findingId: makeFindingId(dimension, index),
    sourceSpans: [],
    evidence: "尾段未检测到总结式/交代式闭合词，无明显作者说明式结尾信号",
    readerImpact: "本章未呈现总结式结尾风险，读者不会被作者直接收束打断",
    suggestedOwner: "human_review",
    confidence: 0.7,
  };
}

// ============================================================================
// 维度 3：hook_or_question — 章末钩子/问句/反常细节
// ============================================================================

/**
 * 检测是否存在问句、反常细节、未解释现象、人物即将行动、危险/秘密逼近。
 *
 * 策略（任务书："有证据 → partial；没有明确证据 → human_review；不得返回 satisfied"）：
 * - 正文过短 → not_applicable
 * - 尾段有钩子信号关键词 或 问号 → partial（span = 信号位置）
 *   （确定性 scanner 只能证明信号出现，不能证明"文学上有效钩子"）
 * - 尾段无钩子信号 → human_review（span = 尾段，scanner 不能确认无钩子，可能用非关键词方式）
 *
 * 映射 AI小说生成智能体 历史文档（文档已删除） §4.3 五种钩子：
 * - 倒计时/信息炸弹 → 反常细节 + 未解释现象关键词
 * - 反转 → 反常细节（突然/竟然/居然）
 * - 情感悬置 → 人物即将行动（正要/准备/刚要）
 * - 危机逼近 → 危险/秘密逼近（逼近/靠近/来袭/浮现/露出）
 *
 * 不调用 LLM，不修改 finalText。绝不返回 satisfied。
 */
function scanHookOrQuestion(
  text: string,
  index: number
): EndingCraftEvidence {
  const dimension: EndingCraftDimension = "hook_or_question";

  if (text.length < MIN_VALID_TEXT_LENGTH) {
    return {
      dimensionId: dimension,
      status: "not_applicable",
      findingId: makeFindingId(dimension, index),
      sourceSpans: [],
      evidence: `正文过短（${text.length} < ${MIN_VALID_TEXT_LENGTH}），无钩子可检测`,
      readerImpact: "正文过短，不存在钩子问题",
      suggestedOwner: "human_review",
      confidence: 0.8,
    };
  }

  const { tail, tailStart } = extractTail(text);

  // 钩子信号关键词
  const hookSpans = findAllSpans(tail, HOOK_QUESTION_KEYWORDS, tailStart);
  // 问号
  const questionSpans = findAllRegexSpans(tail, QUESTION_MARK_PATTERN, tailStart);
  const allHookSpans = [...hookSpans, ...questionSpans];

  if (allHookSpans.length > 0) {
    const hasQuestion = questionSpans.length > 0;
    const hasHook = hookSpans.length > 0;
    const evidenceDesc = hasHook && hasQuestion
      ? `尾段检测到 ${hookSpans.length} 处钩子信号（反常细节/未解释现象/人物即将行动/危险秘密逼近）+ ${questionSpans.length} 处问句`
      : hasHook
        ? `尾段检测到 ${hookSpans.length} 处钩子信号（反常细节/未解释现象/人物即将行动/危险秘密逼近）`
        : `尾段检测到 ${questionSpans.length} 处问句`;
    return {
      dimensionId: dimension,
      status: "partial",
      findingId: makeFindingId(dimension, index),
      sourceSpans: allHookSpans.slice(0, 3),
      evidence: `${evidenceDesc}。确定性 scanner 只能证明信号出现，不能证明"文学上有效钩子"，不得宣称完全达标`,
      readerImpact: "尾段存在钩子/问句信号，读者有继续阅读的牵引，但钩子工艺质量需 LLM 复核",
      suggestedOwner: "craft_judge",
      confidence: 0.4,
    };
  }

  // 尾段无钩子信号 → human_review（span = 尾段）
  // 任务书："没有明确证据 → human_review"
  return {
    dimensionId: dimension,
    status: "human_review",
    findingId: makeFindingId(dimension, index),
    sourceSpans: [
      {
        start: tailStart,
        end: text.length,
        excerpt: tail.slice(0, 80) + (tail.length > 80 ? "…" : ""),
      },
    ],
    evidence: `尾段（最后${tail.length}字）未检测到钩子信号（反常细节/未解释现象/人物即将行动/危险秘密逼近）或问句。确定性 scanner 不能确认无钩子（可能用非关键词方式承载钩子），需人工复核`,
    readerImpact: "尾段无明显钩子信号，读者可能缺乏继续阅读的明确牵引，需人工评估",
    suggestedOwner: "human_review",
    confidence: 0.4,
  };
}

// ============================================================================
// 不变量校验（供 scanner 自检 + 测试断言）
// ============================================================================

/**
 * 校验单条 EndingCraftEvidence 不变量。
 *
 * 规则：
 * - 必填字段 dimensionId/status/findingId/evidence/readerImpact/suggestedOwner/confidence 非空。
 * - status=partial/risk/human_review 时 sourceSpans 必须非空（任务书："没有 span 不得给 partial/risk/human_review"）。
 * - sourceSpans 的 start/end 必须 >=0 且 end>start 且 end<=maxLen。
 * - confidence ∈ [0, 1]。
 * - status 不得为 satisfied（任务书禁止）。
 *
 * @returns 校验通过返回 null，失败返回错误描述。
 */
export function validateEndingCraftEvidence(
  e: EndingCraftEvidence,
  maxLen: number
): string | null {
  if (!e.dimensionId || !e.status || !e.findingId || !e.evidence || !e.readerImpact || !e.suggestedOwner) {
    return `evidence 缺少必填字段 dimensionId/status/findingId/evidence/readerImpact/suggestedOwner`;
  }
  // 注：status 类型 EndingCraftStatus 已在类型层排除 "satisfied"
  // （任务书禁止，不得返回 satisfied，不宣称质量达标），类型系统即第一道防线。
  if (
    (e.status === "partial" || e.status === "risk" || e.status === "human_review") &&
    e.sourceSpans.length === 0
  ) {
    return `status=${e.status} 但 sourceSpans 为空（没有 span 不得给 partial/risk/human_review）`;
  }
  for (const span of e.sourceSpans) {
    if (
      typeof span.start !== "number" ||
      typeof span.end !== "number" ||
      span.start < 0 ||
      span.end <= span.start ||
      span.end > maxLen
    ) {
      return `span 越界或非法：start=${span.start}, end=${span.end}, maxLen=${maxLen}`;
    }
  }
  if (typeof e.confidence !== "number" || e.confidence < 0 || e.confidence > 1) {
    return `confidence 越界：${e.confidence}`;
  }
  return null;
}

// ============================================================================
// 主扫描函数
// ============================================================================

/**
 * 从最终正文生成 endingCraftEvidence。
 *
 * 纯本地确定性提取，零 LLM 调用。不修改 finalText，不触发改文/重写/候选生成。
 *
 * @returns EndingCraftScanResult，含 3 条 evidence（每维度一条）。
 */
export function scanEndingCraftEvidence(
  input: EndingCraftScanInput
): EndingCraftScanResult {
  const { finalText, finalCandidateId } = input;
  const evidence: EndingCraftEvidence[] = [];

  evidence.push(scanTailPressure(finalText, 0));
  evidence.push(scanFlatSummaryEnding(finalText, 1));
  evidence.push(scanHookOrQuestion(finalText, 2));

  // 不变量自检：每条 evidence 必须通过 validateEndingCraftEvidence
  for (const e of evidence) {
    const err = validateEndingCraftEvidence(e, finalText.length);
    if (err) {
      // 不变量违反：降级为 human_review 并保留错误信息（不抛异常，scanner 不阻断生成）
      // 注意：若降级后 human_review 仍无 span，则进一步降级 not_applicable 以满足不变量
      e.status = "human_review";
      e.evidence = `[scanner 不变量自检失败：${err}] ${e.evidence}`;
      e.confidence = 0.1;
      if (e.sourceSpans.length === 0) {
        // 无 span 时不得 human_review，降级 not_applicable
        e.status = "not_applicable";
      }
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
 * 将 EndingCraftScanResult 转为 EndingCraftEvidenceReport（写入 stageResults 用）。
 */
export function toEndingCraftEvidenceReport(
  result: EndingCraftScanResult
): EndingCraftEvidenceReport {
  return {
    evidence: result.evidence,
    meta: {
      skipped: result.skipped,
      skippedReason: result.skippedReason,
      scannedCandidateId: result.scannedCandidateId,
      scannedTextLength: result.scannedTextLength,
      scannedAt: Date.now(),
    },
  };
}

/**
 * 构造 skipped EndingCraftEvidenceReport（hardBlock / raw 生成失败 / scanner 异常路径用）。
 *
 * 任务书："hardBlock 路径写 skipped reason" + "scanner 异常不能阻断生成，只写 skipped/warning"。
 * skipped 路径必须有 evidence 条目（status=skipped），不静默。
 */
export function skippedEndingCraftEvidence(
  candidateId: string | "",
  reason: string
): EndingCraftEvidenceReport {
  const skippedEvidence: EndingCraftEvidence[] = [
    {
      dimensionId: "tail_pressure",
      status: "skipped",
      findingId: "endingCraft:tail_pressure:0",
      sourceSpans: [],
      evidence: `skipped: ${reason}`,
      readerImpact: "扫描跳过，无尾段压力证据可提供",
      suggestedOwner: "human_review",
      confidence: 0.0,
    },
    {
      dimensionId: "flat_summary_ending",
      status: "skipped",
      findingId: "endingCraft:flat_summary_ending:1",
      sourceSpans: [],
      evidence: `skipped: ${reason}`,
      readerImpact: "扫描跳过，无总结式结尾证据可提供",
      suggestedOwner: "human_review",
      confidence: 0.0,
    },
    {
      dimensionId: "hook_or_question",
      status: "skipped",
      findingId: "endingCraft:hook_or_question:2",
      sourceSpans: [],
      evidence: `skipped: ${reason}`,
      readerImpact: "扫描跳过，无钩子证据可提供",
      suggestedOwner: "human_review",
      confidence: 0.0,
    },
  ];
  return {
    evidence: skippedEvidence,
    meta: {
      skipped: true,
      skippedReason: reason,
      scannedCandidateId: candidateId,
      scannedTextLength: 0,
      scannedAt: Date.now(),
    },
  };
}
