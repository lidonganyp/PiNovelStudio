/**
 * PiNovelStudio — 统一显式章纲解析器
 *
 * 设计目标：
 *  - 所有入口（outline-event-coverage / architect / chapter-seed-builder / mock chain）
 *    共用同一个 parser，消除重复正则。
 *  - 支持四种事件头变体：`##/###/#### 事件 1`、`事件1`、`事件 E1`、`事件E1`。
 *  - fail-closed：章纲存在且非空但解析出 0 事件时，返回 `explicit_outline_parse_error`，
 *    不允许 coverageRate=1 / success/details=[] 的假成功。
 *
 * 解析产物：
 *  - events[]：每个事件含 index / outlineEventId / title / section / keywords /
 *    perceptualAnchors / mandatoryElements / characters / sceneType，
 *    以及 P27新增契约字段 summary / conflictLevel / emotionalArc / foreshadowing /
 *    wordCountTarget / forbiddenElements / location / stateDeltas /
 *    relationshipDeltas / acceptanceCriteria。
 *  - parseError：非空章纲但 0 事件时的结构化错误信号。
 *
 * 不变式：
 *  - 章纲为空字符串或全空白 → events=[] 且 parseError=null（视为"无显式契约"）。
 *  - 章纲非空但无任何事件头匹配 → events=[] 且 parseError 非空（视为"显式契约解析失败"）。
 *  - outlineEventId 统一规范化为 `E{index}`，与 DAG eventId 对齐。
 */

/**
 * 解析后的事件结构（即 ChapterEventContract）。
 * 兼容旧 `ExplicitOutlineEvent`（index/title/section/keywords/perceptualAnchors），
 * 同时新增 outlineEventId / mandatoryElements / characters / sceneType，
 * 以及 P27新增的契约字段（summary/forbiddenElements/location/stateDeltas/
 * relationshipDeltas/acceptanceCriteria 等）。
 *
 * P27新增字段全部为 optional，保证旧调用方零破坏。
 * 这些字段供 Stage1 DAG 对账、Stage2 覆盖验收、Preflight 字段校验消费。
 */
export interface ParsedExplicitOutlineEvent {
  /** 事件序号（来自事件头 `事件N` / `事件 EN` 中的 N） */
  index: number;
  /** 规范化事件 ID：`E{index}`，用于 DAG 对账与 trace 追踪 */
  outlineEventId: string;
  /** 事件标题（去掉 `(E1)` 之类的后缀） */
  title: string;
  /** 事件块原文（从事件头到下一事件头/文件末尾） */
  section: string;
  /** 从标题与块内提取的关键词（覆盖判定用） */
  keywords: string[];
  /** `感知锚点` 字段的原始条目，覆盖判定的首要证据 */
  perceptualAnchors: string[];
  /** `必须包含` 字段拆分后的强制元素清单（cleaned，去括号） */
  mandatoryElements: string[];
  /**
   * `必须包含` 字段 bracket-aware 拆分后的原始元素清单（含括号/引号内容）。
   * 与 mandatoryElements 一一对应；供 verify 端提取 verbatim/label token 使用，
   * 消除旧"verify 端二次重拆"的错位 bug（Fix 3）。
   */
  mandatoryElementsOriginal: string[];
  /** `参与角色` 字段拆分后的角色名清单（事件契约对账用） */
  characters: string[];
  /** `类型` / `场景类型` 字段（dialogue/scene/revelation/hook...） */
  sceneType: string;
  // ──────────────────────────────────────────────────────────────
  // P27新增：结构化章节契约字段（全部 optional，旧调用方零破坏）
  // ──────────────────────────────────────────────────────────────
  /** `内容摘要` 字段原文，事件的内容契约（Narrator 生成方向锚定） */
  summary?: string;
  /** `冲突等级` 字段数值（1-5），DAG conflictLevel 对账用 */
  conflictLevel?: number;
  /** `情绪弧` 字段原文，DAG emotionalArc 对账用 */
  emotionalArc?: string;
  /** `伏笔埋设` 字段原文，伏笔追踪器消费 */
  foreshadowing?: string;
  /** `人物动机` 字段拆分后的作者声明，不推断未写明的心理活动 */
  characterMotivations?: string[];
  /** `因果关系` / `因果链` 字段拆分后的作者声明 */
  causalRelations?: string[];
  /** `章末目标` / `章末落点`，事件内声明时保留 */
  endingTarget?: string;
  /** `字数目标` 字段原文（如 "500-700"），事件级字数预算 */
  wordCountTarget?: string;
  /** `禁止` / `禁止包含` 字段拆分后的禁令清单（覆盖验收负向校验） */
  forbiddenElements?: string[];
  /** `地点` / `场景地` 字段，DAG location 对账用 */
  location?: string;
  /** `状态变化` / `状态增量` 字段拆分后的状态 delta 清单 */
  stateDeltas?: string[];
  /** `关系变化` / `关系增量` 字段拆分后的关系 delta 清单 */
  relationshipDeltas?: string[];
  /** `验收标准` 字段拆分后的可验证项清单（Stage2 覆盖验收硬门禁用，cleaned） */
  acceptanceCriteria?: string[];
  /** `验收标准` bracket-aware 拆分后的原始元素清单（含括号/引号内容，与 acceptanceCriteria 一一对应） */
  acceptanceCriteriaOriginal?: string[];
}

/**
 * P27新增：结构化章节事件契约类型别名。
 * 与 ParsedExplicitOutlineEvent 同义，供 Stage1/Stage2/Preflight 表达"契约"语义。
 * 所有模块禁止再各写正则解析章纲，统一通过 parseChapterEventContract 入口消费。
 */
export type ChapterEventContract = ParsedExplicitOutlineEvent;

/**
 * fail-closed 错误信号。
 * 章纲非空但 0 事件时必须填充，上游据此返回 `explicit_outline_parse_error`。
 */
export interface ExplicitOutlineParseError {
  code: "explicit_outline_parse_error";
  reason: string;
  /** 章纲原文长度（用于诊断） */
  outlineLength: number;
  /** 章纲前 200 字符预览（用于 trace / 用户提示） */
  preview: string;
}

/**
 * 统一解析产物。
 */
export interface ParsedExplicitOutline {
  events: ParsedExplicitOutlineEvent[];
  parseError: ExplicitOutlineParseError | null;
  /** 事件总数（=== events.length） */
  outlineEventCount: number;
  /** 章纲是否非空（用于上游区分"无显式契约"与"契约解析失败"） */
  hasNonEmptyOutline: boolean;
}

/**
 * 统一事件头正则：
 *  - 2~4 个 `#`（##/###/####）
 *  - `事件`
 *  - 可选空白
 *  - 可选 `E`/`e` 前缀（支持 `事件 E1` / `事件E1`）
 *  - 数字
 *  - 可选冒号（`:` 或 `：`）
 *  - 可选标题（行尾剩余）
 *
 * 四种变体全部覆盖：
 *   `## 事件 1` / `### 事件1` / `#### 事件 E1` / `#### 事件E1`
 */
const EVENT_HEADER_PATTERN = /^#{2,4}\s*事件\s*[Ee]?(\d+)\s*[：:]?\s*(.*)$/gm;

/**
 * 从事件块 section 中提取指定字段值。
 * 兼容两种格式：
 *  - `- **字段名**：值`（markdown 加粗）
 *  - `字段名：值`（纯文本）
 * 多行字段值会被合并（直到下一个字段头或事件头）。
 */
export function extractOutlineField(section: string, fieldName: string): string {
  const lines = section.split(/\r?\n/);
  const parts: string[] = [];
  let collecting = false;

  for (const line of lines) {
    const boldFieldMatch = line.match(/^- \*\*([^*]+)\*\*[：:](.*)$/);
    if (boldFieldMatch) {
      if (collecting) {
        break;
      }
      collecting = boldFieldMatch[1].trim() === fieldName;
      if (collecting && boldFieldMatch[2].trim()) {
        parts.push(boldFieldMatch[2].trim());
      }
      continue;
    }

    const plainFieldMatch = line.match(new RegExp(`^\\s*${escapeRegExp(fieldName)}\\*{0,2}\\s*[：:]\\s*(.+)$`));
    if (plainFieldMatch) {
      if (collecting) {
        break;
      }
      collecting = true;
      parts.push(plainFieldMatch[1].trim());
      continue;
    }

    if (collecting) {
      // P27修复（用户验收第3项）：遇到任意 Markdown 标题 `^#{1,6}\s+` 都应停止字段采集。
      // 旧实现只停在 `#{2,4} 事件` / `### ` 头，导致真实 E4 的 `必须包含` 字段
      // 被紧随其后的 `## 情绪曲线` 污染（如 "章末主题句 ## 情绪曲线"）。
      if (/^#{1,6}\s+/.test(line)) {
        break;
      }
      parts.push(line.trim());
    }
  }

  return parts.join(" ").trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 拆分字段值为条目清单。
 * 支持 `、` / `，` / `,` / `/` / `+` 分隔符；去除括号说明。
 * 非 mandatory 字段（感知锚点/角色/验收标准等）使用此函数。
 */
function splitFieldItems(raw: string): string[] {
  if (!raw) return [];
  const cleaned = raw
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .trim();
  if (!cleaned) return [];
  return cleaned
    .split(/[、,，/+]/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * bracket-aware 拆分：对 `+` / `、` / `,` / `，` 始终分割；
 * 对 `/` 仅在**括号/引号外**分割，避免 `（从床上摔下/闷响）`、
 * `「这条路不是温柔/用真的自己去换信任」` 内部的 `/` 错误分割元素。
 *
 * 返回每个元素的**原始文本**（含括号/引号，供 verify 端提取 verbatim/label token）。
 * 调用方若需 cleaned 版本，再用 cleanMandatoryElement 去括号。
 */
export function splitMandatoryFieldBracketAware(raw: string): string[] {
  if (!raw) return [];
  const parts: string[] = [];
  let current = "";
  let depth = 0;    // （）() 括号嵌套深度
  let inLabel = false; // 「」『』 书名号深度
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "（" || ch === "(") { depth++; current += ch; continue; }
    if (ch === "）" || ch === ")") { depth = Math.max(0, depth - 1); current += ch; continue; }
    if (ch === "「" || ch === "『") { inLabel = true; current += ch; continue; }  // 「 『
    if (ch === "」" || ch === "』") { inLabel = false; current += ch; continue; } // 」 』
    if ((ch === "/" || ch === "+" || ch === "、" || ch === "," || ch === "，")
        && depth === 0 && !inLabel) {
      const t = current.trim();
      if (t) parts.push(t);
      current = "";
    } else {
      current += ch;
    }
  }
  const t = current.trim();
  if (t) parts.push(t);
  return parts;
}

/** 去除全角/半角括号及其内容，保留外部文字；供 mandatory cleaned 版本生成 */
function cleanMandatoryElement(raw: string): string {
  return raw
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .trim();
}

/**
 * 解析 mandatory 元素的类型标签前缀（Fix 1）。
 * 支持 `[verbatim]content` / `[fact]content` / `[anchor]content` / `[semantic]content`。
 * 无标签时 tag=null，content=原字符串。
 *
 * - verbatim：正文必须逐字出现引号内台词，缺失即阻断
 * - fact：正文必须包含具体事实内容，缺失即阻断，跳过 isDescriptiveElement 豁免
 * - anchor：正文必须包含「」标签动作（fuzzy match），缺失即阻断
 * - semantic：仅语义警告，不阻断（对应纯描述性要求）
 */
export function parseMandatoryElementTag(raw: string): {
  tag: "verbatim" | "fact" | "anchor" | "semantic" | null;
  content: string;
} {
  const m = raw.match(/^\[([a-z]+)\]\s*/i);
  if (!m) return { tag: null, content: raw };
  const tag = m[1].toLowerCase();
  const content = raw.slice(m[0].length).trim();
  if (tag === "verbatim" || tag === "fact" || tag === "anchor" || tag === "semantic") {
    return { tag, content };
  }
  return { tag: null, content: raw };
}

/**
 * 从标题中提取关键词（粗粒度，用于覆盖判定的弱锚点）。
 * 实际强锚点由 outline-event-coverage.ts 的 extractOutlineEventKeywordsWithWeight 负责。
 */
function extractTitleKeywords(title: string): string[] {
  return title
    .split(/[\s,，。.、：:；;！!？?（）()【】「」""''`]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 2);
}

/**
 * 统一解析显式章纲。
 *
 * @param outline ch{N}-outline-explicit.md 的完整文本
 * @returns ParsedExplicitOutline，含 events / parseError / outlineEventCount
 */
export function parseExplicitOutline(outline: string): ParsedExplicitOutline {
  const trimmed = (outline || "").trim();
  const hasNonEmptyOutline = trimmed.length > 0;

  if (!hasNonEmptyOutline) {
    return {
      events: [],
      parseError: null,
      outlineEventCount: 0,
      hasNonEmptyOutline: false,
    };
  }

  const matches = Array.from(outline.matchAll(EVENT_HEADER_PATTERN));
  const events: ParsedExplicitOutlineEvent[] = [];

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const next = matches[i + 1];
    const index = Number(match[1]);
    const rawTitle = (match[2] || "").trim();
    const sectionStart = match.index ?? 0;
    const sectionEnd = next?.index ?? outline.length;
    const section = outline.slice(sectionStart, sectionEnd).trim();
    // 去掉标题尾部的 `(E1)` / `（E1）` 括号后缀
    const title = rawTitle.replace(/[（(]\s*[Ee]\d+\s*[）)]/g, "").trim();

    if (!Number.isFinite(index)) {
      continue;
    }

    const anchorRaw = extractOutlineField(section, "感知锚点");
    const mandatoryRaw = extractOutlineField(section, "必须包含");
    const charactersRaw = extractOutlineField(section, "参与角色");
    const sceneType =
      extractOutlineField(section, "类型") ||
      extractOutlineField(section, "场景类型");

    // P27新增：结构化契约字段提取（全部 optional，缺失则对应字段为 undefined/[]）
    // Legacy explicit outlines often put the narrative contract in 必须包含
    // or 事件结果 without a separate 内容摘要 field. Preserve fail-closed
    // behavior for truly empty events while accepting those equivalent sources.
    const summaryRaw =
      extractOutlineField(section, "内容摘要") ||
      extractOutlineField(section, "事件结果") ||
      extractOutlineField(section, "必须包含");
    const conflictLevelRaw = extractOutlineField(section, "冲突等级");
    const emotionalArcRaw = extractOutlineField(section, "情绪弧");
    const foreshadowingRaw = extractOutlineField(section, "伏笔埋设");
    const characterMotivationsRaw = extractOutlineField(section, "人物动机");
    const causalRelationsRaw =
      extractOutlineField(section, "因果关系") ||
      extractOutlineField(section, "因果链");
    const endingTargetRaw =
      extractOutlineField(section, "章末目标") ||
      extractOutlineField(section, "章末落点");
    const wordCountTargetRaw = extractOutlineField(section, "字数目标");
    const forbiddenRaw =
      extractOutlineField(section, "禁止包含") ||
      extractOutlineField(section, "禁止");
    const locationRaw =
      extractOutlineField(section, "地点") ||
      extractOutlineField(section, "场景地");
    const stateDeltasRaw =
      extractOutlineField(section, "状态变化") ||
      extractOutlineField(section, "状态增量");
    const relationshipDeltasRaw =
      extractOutlineField(section, "关系变化") ||
      extractOutlineField(section, "关系增量");
    const acceptanceCriteriaRaw = extractOutlineField(section, "验收标准");

    // 冲突等级解析为数值（容错："3" / "3（情感张力 4）" / "冲突等级：2"）
    let conflictLevel: number | undefined;
    const conflictNumMatch = conflictLevelRaw.match(/\d+/);
    if (conflictNumMatch) {
      conflictLevel = Number(conflictNumMatch[0]);
    }

    // Fix 3: bracket-aware split 保留原始 per-element 文本（含括号/引号内容），
    // 供 verify 端提取 verbatim/label token，消除旧"verify 端二次重拆"错位 bug。
    const mandatoryOriginals = splitMandatoryFieldBracketAware(mandatoryRaw);
    const mandatoryCleaned = mandatoryOriginals.map(cleanMandatoryElement).filter(s => s.length > 0);
    const acceptanceOriginals = acceptanceCriteriaRaw ? splitMandatoryFieldBracketAware(acceptanceCriteriaRaw) : [];
    const acceptanceCleaned = acceptanceOriginals.map(cleanMandatoryElement).filter(s => s.length > 0);

    events.push({
      index,
      outlineEventId: `E${index}`,
      title,
      section,
      keywords: extractTitleKeywords(title),
      perceptualAnchors: splitFieldItems(anchorRaw),
      mandatoryElements: mandatoryCleaned,
      mandatoryElementsOriginal: mandatoryOriginals,
      characters: splitFieldItems(charactersRaw),
      sceneType: sceneType.trim(),
      // P27新增契约字段（空字符串视为缺失，不写入数组字段以保持 undefined 语义）
      summary: summaryRaw || undefined,
      conflictLevel,
      emotionalArc: emotionalArcRaw || undefined,
      foreshadowing: foreshadowingRaw || undefined,
      characterMotivations: characterMotivationsRaw ? splitFieldItems(characterMotivationsRaw) : undefined,
      causalRelations: causalRelationsRaw ? splitFieldItems(causalRelationsRaw) : undefined,
      endingTarget: endingTargetRaw || undefined,
      wordCountTarget: wordCountTargetRaw || undefined,
      forbiddenElements: forbiddenRaw ? splitFieldItems(forbiddenRaw) : undefined,
      location: locationRaw || undefined,
      stateDeltas: stateDeltasRaw ? splitFieldItems(stateDeltasRaw) : undefined,
      relationshipDeltas: relationshipDeltasRaw ? splitFieldItems(relationshipDeltasRaw) : undefined,
      acceptanceCriteria: acceptanceCleaned.length > 0 ? acceptanceCleaned : undefined,
      acceptanceCriteriaOriginal: acceptanceOriginals.length > 0 ? acceptanceOriginals : undefined,
    });
  }

  if (events.length === 0) {
    return {
      events: [],
      parseError: {
        code: "explicit_outline_parse_error",
        reason: "显式章纲非空但未解析出任何事件头（期望 `##/###/#### 事件 N` / `事件 EN` 格式）",
        outlineLength: outline.length,
        preview: trimmed.slice(0, 200),
      },
      outlineEventCount: 0,
      hasNonEmptyOutline: true,
    };
  }

  return {
    events,
    parseError: null,
    outlineEventCount: events.length,
    hasNonEmptyOutline: true,
  };
}

/**
 * 兼容包装：返回事件数组，供旧调用方（extractExplicitOutlineEvents）使用。
 * 新代码应直接调用 parseExplicitOutline 以获取 parseError。
 */
export function parseExplicitOutlineEvents(outline: string): ParsedExplicitOutlineEvent[] {
  return parseExplicitOutline(outline).events;
}

/**
 * P27新增：统一章节事件契约解析入口。
 *
 * 所有需要消费显式章纲的模块（Stage1 DAG 对账 / Stage2 覆盖验收 / Preflight 字段校验 /
 * Architect / ChapterSeedBuilder）应通过此入口获取 ChapterEventContract[]，
 * 禁止再各写正则解析章纲。
 *
 * 返回值包含：
 *  - contracts：ChapterEventContract[]（=== parsed.events，语义化命名）
 *  - parseError：非空章纲但 0 事件时的结构化错误信号（fail-closed）
 *  - hasNonEmptyOutline：章纲是否非空（区分"无显式契约"与"契约解析失败"）
 *  - contractEventCount：契约事件总数
 *
 * @param outline ch{N}-outline-explicit.md 的完整文本
 */
export function parseChapterEventContract(outline: string): {
  contracts: ChapterEventContract[];
  parseError: ExplicitOutlineParseError | null;
  hasNonEmptyOutline: boolean;
  contractEventCount: number;
} {
  const parsed = parseExplicitOutline(outline);
  return {
    contracts: parsed.events,
    parseError: parsed.parseError,
    hasNonEmptyOutline: parsed.hasNonEmptyOutline,
    contractEventCount: parsed.outlineEventCount,
  };
}

/**
 * P27新增：判断 mandatoryElements 是否形成可验证项。
 *
 * 用于 Preflight (P2) 与 Stage2 覆盖验收 (P4)：
 * 如果 mandatoryElements 全部是停用词/泛化术语（如"主角"、"场景"、"情绪"），
 * 则无法形成可验证的事件契约，应阻断。
 *
 * 判定规则：
 *  - 数组为空 → 不可验证（false）
 *  - 每个元素剥离标点后，若全部命中停用词集合 → 不可验证（false）
 *  - 至少有一个非停用词元素 → 可验证（true）
 */
const MANDATORY_ELEMENT_STOPWORDS = new Set([
  "事件", "场景", "类型", "内容", "角色", "情绪", "字数", "目标", "章节", "核心",
  "主题", "要求", "备注", "大纲", "功能", "状态", "设计", "伏笔", "清单", "风格",
  "众人", "自己", "主角", "配角", "时候", "理由", "离开", "继续", "以后",
  "一个", "一些", "表示", "告诉", "讨论", "开始", "长期", "过程",
  "必须", "包含", "需要", "应当", "应该", "可以",
]);

export function hasVerifiableMandatoryElements(mandatoryElements: string[] | undefined): boolean {
  if (!mandatoryElements || mandatoryElements.length === 0) {
    return false;
  }
  for (const raw of mandatoryElements) {
    // 剥离标点与括号说明，取核心词
    const core = raw
      .replace(/[（(][^）)]*[）)]/g, "")
      .replace(/[、,，。.；;：:！!？?""''「」【】`]+/g, " ")
      .trim();
    if (!core) continue;
    // 拆分为子词，任一非停用词即视为可验证
    const tokens = core.split(/\s+/).filter(t => t.length > 0);
    const hasNonStopword = tokens.some(t => !MANDATORY_ELEMENT_STOPWORDS.has(t));
    if (hasNonStopword) {
      return true;
    }
  }
  return false;
}
