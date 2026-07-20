/**
 * InformationReleaseEvidenceScanner — 信息释放证据扫描器（QUALITY-8 最小切片）
 *
 * 目标：在 finalText 确定后，扫描章节正文里信息释放是否存在明显灌设定、解释堆叠、
 * 缺少行动/感官承载的问题。只诊断，不改文，不阻断，不生成候选。
 *
 * 核心不变量（QUALITY-8 任务书）：
 * - 只输出 evidence（span/证据/置信度/读者影响/建议 owner），不输出总分。
 * - status 只允许：partial / risk / human_review / not_applicable / skipped。
 * - partial/risk/human_review 必须带有效 sourceSpans；没有 span 不得给这三个状态。
 * - 行动/感官承载的信息释放最多给 partial，不得宣称完全达标（不得 satisfied）。
 * - scanner 异常不能阻断生成，只写 skipped + warning。
 * - 不修改 finalText，不触发 StyleShaper / language patch / candidate rewrite。
 * - 不改 judge/selection，不提交长期状态，不调用模型。
 * - 不含 aggregateQualityScore / totalScore / 文学总分等聚合字段。
 *
 * 复用资产（A-E 分类见历史任务清单，文档已删除）：
 * - A：TextSpan（types.ts:295）直接复用；scanStructuralEvidence 的 findAllSpans /
 *   findPhraseSpans / MIN_VALID_TEXT_LENGTH 模式（structural-evidence-scanner.ts）。
 * - B：ChapterIntent.inviolableFacts / relevantCharacters 作为信息释放语境参考。
 * - C（只读证据，不复用控制权）：
 *   - craft/info-release-detector.ts 的专有名词正则（书名号/组织名/地名/概念术语）、
 *     强新信息定义型正则（叫做/名为/被称为/是一种/所谓）、概念依赖链后缀表。
 *   - structural-evidence-scanner.ts 的 INFO_KEYWORDS（发现/得知/揭露/明白/意识到…）。
 * - D（概念借用，不直接复用 LLM 耦合代码）：
 *   - AI小说生成智能体 历史文档（文档已删除） 第九章"信息倾倒"定义（大段讲解世界观而非通过情节展现）+
 *     渐进揭示原则（按情节进度逐步释放，而非一次性输出）。
 *   - craft/release-planner.ts 的"投放策略/释放节奏"概念（本章只诊断已生成正文，
 *     不恢复跨章释放规划控制权）。
 * - E（退役，不得继承）：info-release-detector.gateCheck 的 blocked 状态、
 *   calculateScore 的 0-1 总分、determineLevel 的 pass/warning/fail、
 *   InfoReleaseDetection.fix 改写建议、Stage0-8 infodump gate 的 block/rewrite 权限。
 *
 * 2 个维度的扫描策略（诚实原则：能找到 span 才给状态，否则 not_applicable）：
 * 1. infodump_block：分段检测"信息灌输段"——长解释 + 设定名词密集 + 缺少角色行动/感官承载。
 *    - 找到疑似灌输段 → risk（span = 该段）
 *    - 有设定名词但均承载行动 → human_review（span = 最密集段，不能确认也无从排除）
 *    - 全文无设定名词 → not_applicable
 * 2. action_bearing_release：信息释放是否通过角色动作/对话/感官/冲突自然出现。
 *    - 信息释放关键词附近有行动/感官承载 → partial（任务书："最多给 partial"）
 *    - 信息释放关键词附近无承载 → human_review（span = 关键词 span）
 *    - 无信息释放关键词 → not_applicable
 *
 * 确定性本地扫描：零 LLM 调用，纯正则 + 关键词匹配。
 */

import type { TextSpan } from "./types.js";
import type { ChapterIntent } from "./chapter-intent-builder.js";

// ============================================================================
// 数据契约
// ============================================================================

/**
 * 信息释放证据维度（QUALITY-8 最小覆盖 2 维）。
 *
 * 映射关系（C/D 类 legacy 概念借用，不直接复用 LLM 耦合代码）：
 * - infodump_block ← info-release-detector 的"专有名词密度/强新信息上限/概念链深度"
 *   + AI小说生成智能体 历史文档（文档已删除） §9.1"信息倾倒"定义（大段讲解设定而非通过情节展现）。
 * - action_bearing_release ← AI小说生成智能体 历史文档（文档已删除） §9.2"渐进揭示"原则
 *   （信息应通过情节自然展现，而非一次性输出）。
 */
export type InformationReleaseDimension =
  | "infodump_block"
  | "action_bearing_release";

/**
 * 信息释放证据状态（QUALITY-8 任务书规定，无 satisfied）。
 *
 * 语义：
 * - partial：有 span 证明信息释放通过行动/感官承载，但不足以宣称完全达标。
 * - risk：有 span 证明存在疑似信息灌输段（长解释+设定密集+无承载）。
 * - human_review：有 span 但确定性 scanner 无法判定，需人工/LLM 复核。
 * - not_applicable：本章无信息释放相关信号（如无设定名词/无信息释放关键词）。
 * - skipped：hardBlock / scanner 异常路径，无 finalText 可扫描。
 *
 * 严格禁止 satisfied：任务书"行动承载的信息释放最多给 partial，不得宣称完全达标"。
 */
export type InformationReleaseStatus =
  | "partial"
  | "risk"
  | "human_review"
  | "not_applicable"
  | "skipped";

/**
 * 单条信息释放证据（8 个必填字段，QUALITY-8 任务书规定）。
 *
 * 不变量：
 * - status=partial/risk/human_review 时 sourceSpans 必须非空（无 span 不得给这三态）。
 * - sourceSpans 的 start/end 必须在 [0, finalText.length] 范围内，end > start。
 * - confidence ∈ [0, 1]：本地确定性 scanner 通常 0.3-0.6，不假装高置信。
 * - suggestedOwner 只建议归属（如 "human_review" / "craft_judge"），不强制，不含改文指令。
 * - 不含 expectedRef / severity / recommendedAction / fix / score 等字段（任务书契约）。
 */
export interface InformationReleaseEvidence {
  /** 维度 id */
  dimensionId: InformationReleaseDimension;
  /** 证据状态 */
  status: InformationReleaseStatus;
  /** finding id，格式 `infoRelease:{dimension}:{index}` */
  findingId: string;
  /**
   * 支撑该证据的正文 span 列表。
   * status=partial/risk/human_review 时必须非空；
   * status=not_applicable/skipped 时可为空。
   */
  sourceSpans: TextSpan[];
  /** 观察到的事实：scanner 在正文中实际找到的信号描述（不含改文建议）。 */
  evidence: string;
  /** 读者影响：该信息释放状态对读者体验的潜在影响描述（advisory）。 */
  readerImpact: string;
  /** 建议 owner：谁应该处理这条证据（advisory，不强制，不含改文指令）。 */
  suggestedOwner: string;
  /** 置信度 ∈ [0, 1]，本地确定性 scanner 通常较低 */
  confidence: number;
}

/**
 * 信息释放证据扫描结果。
 */
export interface InformationReleaseScanResult {
  /** 全部信息释放证据（按 dimension 顺序） */
  evidence: InformationReleaseEvidence[];
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
 * 写入 stageResults.informationReleaseEvidence 的结构。
 *
 * 严格禁止：
 * - aggregateQualityScore / totalScore / 文学总分等聚合字段；
 * - 任何触发改文/重写/候选生成的字段；
 * - 任何 gate/hard_block 权限字段。
 */
export interface InformationReleaseEvidenceReport {
  evidence: InformationReleaseEvidence[];
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

export interface InformationReleaseScanInput {
  /** 最终交付正文（不可被 scanner 修改） */
  finalText: string;
  /** 最终选中的候选 id */
  finalCandidateId: string;
  /** 章节意图（用于 relevantCharacters / inviolableFacts 语境参考，可空字段） */
  intent: ChapterIntent;
}

// ============================================================================
// 关键词表 / 正则（确定性，无 LLM）
// ============================================================================
//
// 复用来源（C 类只读证据）：
// - 专有名词/概念术语正则 ← craft/info-release-detector.ts:475-534
// - INFO_KEYWORDS ← structural-evidence-scanner.ts:99-103
// 改造点：legacy 用密度阈值 gate（E 退役），本切片只用正则做 span 定位，
// 不做 pass/warning/fail 总分判定。

/**
 * 设定名词正则集合（用于识别"设定密集段"）。
 * - 书名号《XX》
 * - 组织/势力名（族|派|宗|教|殿|帮|盟|集团|家族|学院|门派|帮会|教会|宗派）
 * - 地名（市|城|镇|村|山|河|湖|岛|国|域|界|境）
 * - 力量体系/修炼概念术语（境|级|段|功|法|术|诀|阵|符|丹|器|兽|灵|气|魂|血|道）
 *
 * 注：legacy info-release-detector 在 conceptPattern 里含"门/天/地/命"等单字后缀，
 * 实测误匹配率高（如"推门"/"明天"/"地方"/"生命"）。本切片收紧为多字术语后缀，
 * 牺牲召回率换精确率（advisory scanner，宁可漏检不要误报阻断读者判断）。
 */
const SETTING_NOUN_PATTERNS: RegExp[] = [
  /《[^》]{1,20}》/g,
  /(?:[\u4e00-\u9fa5]{2,6})(?:族|派|宗|教|殿|帮|盟|集团|家族|学院|门派|帮会|教会|宗派)/g,
  /(?:[\u4e00-\u9fa5]{2,4})(?:市|城|镇|村|山|河|湖|岛|国|域|界|境)/g,
  /(?:[\u4e00-\u9fa5]{2,6})(?:境界|等级|段位|功法|法术|术法|诀窍|阵法|符箓|丹药|法器|灵兽|灵气|魂力|血脉|道法)/g,
];

/**
 * 强新信息定义型正则（"叫做XX/名为XX/被称为XX/是一种XX/所谓XX"）。
 * 这类句式是典型"主动讲解设定"信号，出现密集时是信息灌输的强信号。
 * ← craft/info-release-detector.ts:495-498, 519-522
 */
const STRONG_NEW_INFO_PATTERNS: RegExp[] = [
  /(?:是一种|叫做|名为|被称为|称为|即|所谓|是一种|被称为|名为)([\u4e00-\u9fa5]{2,15})/g,
];

/**
 * 行动/感官承载关键词（用于判断信息释放是否"通过情节自然展现"）。
 * - 行动动词：抓/推/拉/转身/跳/冲/跑/走/站/坐/挥/劈/挡/退/进/举/放
 * - 对话标记：引号/冒号引语
 * - 感官词：看到/听到/闻到/尝到/感觉/感到/疼痛/冰冷/灼热/刺痛/震动/声音/光芒/气味
 * - 冲突词：冲突/对抗/攻击/防御/怒/斥/喝/威胁/逼迫/阻挡
 */
const ACTION_VERB_KEYWORDS = [
  "抓", "推", "拉", "转身", "跳", "冲", "跑", "走", "站", "坐",
  "挥", "劈", "挡", "退", "进", "举", "放", "推开", "拉住", "抓住",
  "跃", "扑", "蹬", "迈", "握",
];

const SENSORY_KEYWORDS = [
  "看到", "听到", "闻到", "尝到", "感觉", "感到", "疼痛", "冰冷", "灼热",
  "刺痛", "震动", "声音", "光芒", "气味", "刺眼", "刺耳", "颤抖", "晕眩",
];

const CONFLICT_KEYWORDS = [
  "冲突", "对抗", "攻击", "防御", "怒", "斥", "喝", "威胁", "逼迫", "阻挡",
  "厮杀", "搏斗", "交锋", "对峙",
];

/** 对话标记正则（引号包裹的语段） */
const DIALOGUE_PATTERN = /[「」""''‘’]/g;

/**
 * 信息释放关键词（ reused from structural-evidence-scanner.ts INFO_KEYWORDS）。
 * 用于识别"本章出现了信息释放动作"（发现/得知/揭露/明白…）。
 */
const INFO_RELEASE_KEYWORDS = [
  "发现", "得知", "揭露", "明白", "意识到", "原来", "真相",
  "秘密", "知道", "确认", "看穿", "识破",
];

/** 疑似灌输段的最小段落长度（字符）。低于此值不视为"长解释段"。 */
const INFODUMP_PARAGRAPH_MIN_LENGTH = 120;

/** 疑似灌输段的设定名词最小数量（段内）。低于此值不视为"设定密集"。 */
const INFODUMP_PARAGRAPH_MIN_SETTING_NOUNS = 2;

/** 行动承载判定的就近窗口（字符）。信息释放关键词在此窗口内有行动/感官词视为承载。 */
const ACTION_BEARING_WINDOW = 60;

/** 最小有效正文长度（低于此值视为空文本，所有维度降级）。 */
const MIN_VALID_TEXT_LENGTH = 50;

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 在 text 中查找所有 keyword 出现位置，返回 TextSpan 列表。
 * 复用自 structural-evidence-scanner.ts:findAllSpans（A 类基础设施）。
 *
 * span 边界校验：start >= 0, end > start, end <= text.length。
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
 * 用正则集合在 text 中查找所有匹配，返回 TextSpan 列表（去重同 offset）。
 * 用于设定名词/强新信息等多正则匹配。
 */
function findAllRegexSpans(text: string, patterns: RegExp[]): TextSpan[] {
  const spans: TextSpan[] = [];
  const seen = new Set<number>();
  for (const pattern of patterns) {
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
        const start = Math.max(0, idx - 10);
        const end = Math.min(text.length, idx + len + 10);
        spans.push({
          start: idx,
          end: idx + len,
          excerpt: text.slice(start, end),
        });
      }
      fromNext(re, match);
    }
  }
  return spans;
}

/** 推进 lastIndex（避免零宽匹配死循环） */
function fromNext(re: RegExp, match: RegExpExecArray): void {
  if (re.lastIndex === match.index) {
    re.lastIndex += match[0].length || 1;
  }
}

/**
 * 把正文按段落切分（空行/换行分段），返回段落 { start, end, text } 列表。
 * 段落边界保留原文 offset，便于回填 span。
 */
interface Paragraph {
  start: number;
  end: number;
  text: string;
}

function splitParagraphs(text: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const lines = text.split(/(\r?\n)/);
  let offset = 0;
  let currentStart = -1;
  let currentText = "";

  for (const part of lines) {
    if (part === "") {
      offset += 0;
      continue;
    }
    const isNewline = /^\r?\n$/.test(part);
    if (isNewline) {
      // 换行：结束当前段
      if (currentText.trim().length > 0) {
        paragraphs.push({
          start: currentStart,
          end: currentStart + currentText.length,
          text: currentText,
        });
      }
      offset += part.length;
      currentStart = -1;
      currentText = "";
    } else {
      // 内容
      if (currentStart < 0) {
        currentStart = offset;
        currentText = part;
      } else {
        currentText += part;
      }
      offset += part.length;
    }
  }
  // 收尾
  if (currentText.trim().length > 0 && currentStart >= 0) {
    paragraphs.push({
      start: currentStart,
      end: currentStart + currentText.length,
      text: currentText,
    });
  }
  return paragraphs;
}

/**
 * 统计段内某 keyword 集合的出现次数（粗略计数，不返回 span）。
 */
function countKeywordsInParagraph(paraText: string, keywords: string[]): number {
  let count = 0;
  for (const kw of keywords) {
    if (!kw) continue;
    let from = 0;
    while (true) {
      const idx = paraText.indexOf(kw, from);
      if (idx < 0) break;
      count++;
      from = idx + kw.length;
    }
  }
  return count;
}

/**
 * 统计段内正则集合的匹配次数。
 */
function countRegexInParagraph(paraText: string, patterns: RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(paraText)) !== null) {
      if (match[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      count++;
      fromNext(re, match);
    }
  }
  return count;
}

/** 生成 finding id */
function makeFindingId(dimension: InformationReleaseDimension, index: number): string {
  return `infoRelease:${dimension}:${index}`;
}

// ============================================================================
// 维度 1：infodump_block — 信息灌输段检测
// ============================================================================

/**
 * 检测疑似"信息灌输段"：长解释 + 设定名词密集 + 缺少角色行动/感官承载。
 *
 * 策略（诚实原则）：
 * - 全文无设定名词（书名号/组织名/地名/概念术语）且无强新信息定义 → not_applicable
 * - 找到段：长度 >= INFODUMP_PARAGRAPH_MIN_LENGTH
 *   且 设定名词数 >= INFODUMP_PARAGRAPH_MIN_SETTING_NOUNS（或强新信息 >= 2）
 *   且 行动/感官/冲突/对话承载计数 == 0
 *   → risk（span = 该段全文）
 * - 有设定名词段但每段都有行动/感官承载 → human_review（span = 最密集段，
 *   确定性 scanner 不能确认也无从排除灌输嫌疑）
 * - 有设定名词段但段过短（< 阈值）→ human_review（span = 最密集段，
 *   短段也可能是灌输，scanner 无法判定）
 *
 * 不调用 LLM，不修改 finalText。
 */
function scanInfodumpBlock(
  text: string,
  index: number
): InformationReleaseEvidence {
  const dimension: InformationReleaseDimension = "infodump_block";

  if (text.length < MIN_VALID_TEXT_LENGTH) {
    return {
      dimensionId: dimension,
      status: "not_applicable",
      findingId: makeFindingId(dimension, index),
      sourceSpans: [],
      evidence: `正文过短（${text.length} < ${MIN_VALID_TEXT_LENGTH}），无信息灌输可检测`,
      readerImpact: "正文过短，读者不会感受到信息灌输负担",
      suggestedOwner: "human_review",
      confidence: 0.8,
    };
  }

  const paragraphs = splitParagraphs(text);

  // 全文设定名词 + 强新信息总数（决定是否 not_applicable）
  let totalSettingNouns = 0;
  let totalStrongNew = 0;
  for (const p of paragraphs) {
    totalSettingNouns += countRegexInParagraph(p.text, SETTING_NOUN_PATTERNS);
    totalStrongNew += countRegexInParagraph(p.text, STRONG_NEW_INFO_PATTERNS);
  }

  if (totalSettingNouns === 0 && totalStrongNew === 0) {
    return {
      dimensionId: dimension,
      status: "not_applicable",
      findingId: makeFindingId(dimension, index),
      sourceSpans: [],
      evidence: "全文未检测到设定名词（书名号/组织名/地名/概念术语）或强新信息定义句式，无信息灌输信号",
      readerImpact: "本章未呈现密集设定投放，读者不会感受到信息灌输负担",
      suggestedOwner: "human_review",
      confidence: 0.7,
    };
  }

  // 逐段评估
  const infodumpSuspects: Paragraph[] = [];
  const settingBearingParas: Array<{ para: Paragraph; settingCount: number; hasBearing: boolean }> = [];

  for (const p of paragraphs) {
    const settingCount = countRegexInParagraph(p.text, SETTING_NOUN_PATTERNS);
    const strongNewCount = countRegexInParagraph(p.text, STRONG_NEW_INFO_PATTERNS);
    const isSettingDense = settingCount >= INFODUMP_PARAGRAPH_MIN_SETTING_NOUNS || strongNewCount >= 2;
    if (!isSettingDense) continue;

    const actionCount = countKeywordsInParagraph(p.text, ACTION_VERB_KEYWORDS);
    const sensoryCount = countKeywordsInParagraph(p.text, SENSORY_KEYWORDS);
    const conflictCount = countKeywordsInParagraph(p.text, CONFLICT_KEYWORDS);
    const dialogueCount = (p.text.match(DIALOGUE_PATTERN) || []).length;
    const bearingCount = actionCount + sensoryCount + conflictCount + dialogueCount;
    const hasBearing = bearingCount > 0;

    settingBearingParas.push({ para: p, settingCount, hasBearing });

    const isLong = p.text.length >= INFODUMP_PARAGRAPH_MIN_LENGTH;
    if (isLong && !hasBearing) {
      infodumpSuspects.push(p);
    }
  }

  // 找到疑似灌输段 → risk
  if (infodumpSuspects.length > 0) {
    const suspect = infodumpSuspects[0];
    const span: TextSpan = {
      start: suspect.start,
      end: suspect.end,
      excerpt: suspect.text.slice(0, 80) + (suspect.text.length > 80 ? "…" : ""),
    };
    return {
      dimensionId: dimension,
      status: "risk",
      findingId: makeFindingId(dimension, index),
      sourceSpans: [span],
      evidence: `检测到 ${infodumpSuspects.length} 段疑似信息灌输段：长度>=${INFODUMP_PARAGRAPH_MIN_LENGTH}字 + 设定名词密集 + 无行动/感官/对话承载。首段 span 见 sourceSpans（确定性 scanner 只能证明段内无行动承载关键词，不能证明必然是灌输，建议人工复核）`,
      readerImpact: "大段纯设定讲解会打断叙事节奏，读者难以消化密集信息，降低后续探索期待",
      suggestedOwner: "human_review",
      confidence: 0.5,
    };
  }

  // 有设定名词段但全部有承载 或 段过短 → human_review（取最密集段作 span）
  if (settingBearingParas.length > 0) {
    const densest = settingBearingParas.reduce((a, b) =>
      b.settingCount > a.settingCount ? b : a
    );
    const span: TextSpan = {
      start: densest.para.start,
      end: densest.para.end,
      excerpt: densest.para.text.slice(0, 80) + (densest.para.text.length > 80 ? "…" : ""),
    };
    const allBearing = settingBearingParas.every((s) => s.hasBearing);
    const evidenceDesc = allBearing
      ? `检测到 ${settingBearingParas.length} 段含设定名词，但每段都有行动/感官/对话承载。确定性 scanner 无法确认是否仍存在隐蔽灌输（如非关键词式讲解），建议人工复核最密集段`
      : `检测到 ${settingBearingParas.length} 段含设定名词，但段长 < ${INFODUMP_PARAGRAPH_MIN_LENGTH}字，未达"长解释段"阈值。短段也可能是灌输，scanner 无法判定，建议人工复核最密集段`;
    return {
      dimensionId: dimension,
      status: "human_review",
      findingId: makeFindingId(dimension, index),
      sourceSpans: [span],
      evidence: evidenceDesc,
      readerImpact: "设定名词出现但未明确判定为灌输，读者理解负担需人工评估",
      suggestedOwner: "human_review",
      confidence: 0.4,
    };
  }

  // 理论上不会到达（totalSettingNouns/totalStrongNew > 0 但 settingBearingParas 为空，
  // 说明设定名词出现在 splitParagraphs 之外的换行/空白中），防御性 not_applicable
  return {
    dimensionId: dimension,
    status: "not_applicable",
    findingId: makeFindingId(dimension, index),
    sourceSpans: [],
    evidence: "设定名词总数非零但段落级评估未命中（可能出现在段边界），无可用灌输证据",
    readerImpact: "无明显信息灌输段",
    suggestedOwner: "human_review",
    confidence: 0.3,
  };
}

// ============================================================================
// 维度 2：action_bearing_release — 行动承载的信息释放
// ============================================================================

/**
 * 检测信息释放是否通过角色动作/对话/感官/冲突自然出现。
 *
 * 策略（任务书："最多给 partial，不得宣称完全达标"）：
 * - 无信息释放关键词（发现/得知/揭露/明白…）→ not_applicable
 * - 信息释放关键词附近（ACTION_BEARING_WINDOW 字符内）有行动/感官/冲突/对话 → partial
 *   （确定性 scanner 只能证明关键词与承载词共现，不能证明"文学上自然"）
 * - 信息释放关键词附近无承载 → human_review（span = 关键词 span，信息释放了但 scanner
 *   未检测到行动承载，可能用非关键词方式承载，需人工复核）
 *
 * 不调用 LLM，不修改 finalText。绝不返回 satisfied。
 */
function scanActionBearingRelease(
  text: string,
  index: number
): InformationReleaseEvidence {
  const dimension: InformationReleaseDimension = "action_bearing_release";

  if (text.length < MIN_VALID_TEXT_LENGTH) {
    return {
      dimensionId: dimension,
      status: "not_applicable",
      findingId: makeFindingId(dimension, index),
      sourceSpans: [],
      evidence: `正文过短（${text.length} < ${MIN_VALID_TEXT_LENGTH}），无信息释放可检测`,
      readerImpact: "正文过短，不存在信息释放承载问题",
      suggestedOwner: "human_review",
      confidence: 0.8,
    };
  }

  const infoSpans = findAllSpans(text, INFO_RELEASE_KEYWORDS);
  if (infoSpans.length === 0) {
    return {
      dimensionId: dimension,
      status: "not_applicable",
      findingId: makeFindingId(dimension, index),
      sourceSpans: [],
      evidence: "全文未检测到信息释放关键词（发现/得知/揭露/明白/意识到…），无信息释放动作可验证",
      readerImpact: "本章未呈现明确的信息释放动作，读者不会感受到信息投放方式问题",
      suggestedOwner: "human_review",
      confidence: 0.7,
    };
  }

  // 行动/感官/冲突/对话承载 span
  const actionSpans = findAllSpans(text, ACTION_VERB_KEYWORDS);
  const sensorySpans = findAllSpans(text, SENSORY_KEYWORDS);
  const conflictSpans = findAllSpans(text, CONFLICT_KEYWORDS);
  const dialogueSpans = findAllRegexSpans(text, [DIALOGUE_PATTERN]);
  const bearingSpans = [...actionSpans, ...sensorySpans, ...conflictSpans, ...dialogueSpans];

  // 对每个信息释放关键词，检查就近窗口内是否有承载
  let bearingCount = 0;
  const bearingEvidenceSpans: TextSpan[] = [];
  const noBearingSpans: TextSpan[] = [];

  for (const infoSpan of infoSpans) {
    const windowStart = Math.max(0, infoSpan.start - ACTION_BEARING_WINDOW);
    const windowEnd = Math.min(text.length, infoSpan.end + ACTION_BEARING_WINDOW);
    const hasBearingNearby = bearingSpans.some(
      (b) => b.start >= windowStart && b.end <= windowEnd
    );
    if (hasBearingNearby) {
      bearingCount++;
      bearingEvidenceSpans.push(infoSpan);
    } else {
      noBearingSpans.push(infoSpan);
    }
  }

  // 至少一个信息释放关键词附近有承载 → partial（任务书："最多给 partial"）
  if (bearingCount > 0) {
    return {
      dimensionId: dimension,
      status: "partial",
      findingId: makeFindingId(dimension, index),
      sourceSpans: bearingEvidenceSpans.slice(0, 3),
      evidence: `检测到 ${infoSpans.length} 处信息释放关键词，其中 ${bearingCount} 处附近（${ACTION_BEARING_WINDOW}字窗口内）有行动/感官/冲突/对话承载。确定性 scanner 只能证明共现，不能证明"文学上自然展现"，不得宣称完全达标`,
      readerImpact: "部分信息释放通过角色行动/感官/对话承载，读者较易消化，但整体释放工艺需 LLM 复核",
      suggestedOwner: "craft_judge",
      confidence: 0.4,
    };
  }

  // 信息释放关键词存在但附近均无承载 → human_review
  return {
    dimensionId: dimension,
    status: "human_review",
    findingId: makeFindingId(dimension, index),
    sourceSpans: noBearingSpans.slice(0, 3),
    evidence: `检测到 ${infoSpans.length} 处信息释放关键词，但附近（${ACTION_BEARING_WINDOW}字窗口内）均未找到行动/感官/冲突/对话承载。信息可能通过非关键词方式承载，或确实存在纯讲解式释放，需人工复核`,
    readerImpact: "信息释放可能未通过行动/感官自然展现，读者可能感觉是设定讲解而非情节推进",
    suggestedOwner: "human_review",
    confidence: 0.4,
  };
}

// ============================================================================
// 不变量校验（供 scanner 自检 + 测试断言）
// ============================================================================

/**
 * 校验单条 InformationReleaseEvidence 不变量。
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
export function validateInformationReleaseEvidence(
  e: InformationReleaseEvidence,
  maxLen: number
): string | null {
  if (!e.dimensionId || !e.status || !e.findingId || !e.evidence || !e.readerImpact || !e.suggestedOwner) {
    return `evidence 缺少必填字段 dimensionId/status/findingId/evidence/readerImpact/suggestedOwner`;
  }
  // 注：status 类型 InformationReleaseStatus 已在类型层排除 "satisfied"
  // （任务书禁止，行动承载信息释放最多给 partial），类型系统即第一道防线。
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
 * 从最终正文生成 informationReleaseEvidence。
 *
 * 纯本地确定性提取，零 LLM 调用。不修改 finalText，不触发改文/重写/候选生成。
 *
 * @returns InformationReleaseScanResult，含 2 条 evidence（每维度一条）。
 */
export function scanInformationReleaseEvidence(
  input: InformationReleaseScanInput
): InformationReleaseScanResult {
  const { finalText, finalCandidateId } = input;
  const evidence: InformationReleaseEvidence[] = [];

  evidence.push(scanInfodumpBlock(finalText, 0));
  evidence.push(scanActionBearingRelease(finalText, 1));

  // 不变量自检：每条 evidence 必须通过 validateInformationReleaseEvidence
  for (const e of evidence) {
    const err = validateInformationReleaseEvidence(e, finalText.length);
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
 * 将 InformationReleaseScanResult 转为 InformationReleaseEvidenceReport（写入 stageResults 用）。
 */
export function toInformationReleaseEvidenceReport(
  result: InformationReleaseScanResult
): InformationReleaseEvidenceReport {
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
 * 构造 skipped InformationReleaseEvidenceReport（hardBlock / raw 生成失败 / scanner 异常路径用）。
 *
 * 任务书："hardBlock 路径写 skipped reason" + "scanner 异常不能阻断生成，只写 skipped/warning"。
 * skipped 路径必须有 evidence 条目（status=skipped），不静默。
 */
export function skippedInformationReleaseEvidence(
  candidateId: string | "",
  reason: string
): InformationReleaseEvidenceReport {
  const skippedEvidence: InformationReleaseEvidence[] = [
    {
      dimensionId: "infodump_block",
      status: "skipped",
      findingId: "infoRelease:infodump_block:0",
      sourceSpans: [],
      evidence: `skipped: ${reason}`,
      readerImpact: "扫描跳过，无信息释放证据可提供",
      suggestedOwner: "human_review",
      confidence: 0.0,
    },
    {
      dimensionId: "action_bearing_release",
      status: "skipped",
      findingId: "infoRelease:action_bearing_release:1",
      sourceSpans: [],
      evidence: `skipped: ${reason}`,
      readerImpact: "扫描跳过，无行动承载证据可提供",
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
