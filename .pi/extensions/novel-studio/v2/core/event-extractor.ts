/**
 * EventExtractor — 结构化事件抽取器（Phase 3A）
 *
 * 从中文小说正文中确定性抽取事件，作为事件账本比对（Phase 3B）的基础。
 *
 * 设计原则（project_memory 约束）：
 * - 事件锚点必须含可解释结构（subject, action/state change, object/location/result, 完整 evidence span）
 * - 不得使用 2-4 字片段（如"到玉衡星"/"一个激灵"）作为独立事件锚点
 * - 区分 eventType: action（真实动作）/ state_change（状态变化）/ state_description（仅状态描述）
 * - 不可靠抽取标记 extractable=false
 * - 不调用 LLM，纯规则驱动
 * - '描述' action 不得用于伪装抽取的动作
 *
 * 与 editorial-story-preservation-gate.ts 的关系：
 * - 复用其 verb tables / antonym pairs / causal connectors（已测试稳定的常量）
 * - 升级 EventAnchor → ExtractedEvent，新增 causalParentIds / location / beforeState / afterState / result 字段
 * - Phase 3C 将让 gate 调用 extractEvents + compareEventLedgers 替换相似度门
 *
 * 来源：DEMO-3-R2.4 事件锚点逻辑 + Phase 3 计划 §3A
 */

import type { TextSpan } from "./types.js";

// ============================================================================
// 常量（与 editorial-story-preservation-gate.ts 同步；可独立演进）
// ============================================================================

/**
 * 中文停用字表。用于内容匹配时过滤无意义字符（不用于实体提取）。
 */
const STOP_CHARS = new Set<string>(
  "的了着过地得是有在到为以和与也都就还又再但而把被让使给对向从我你他她它们其此谁这那哪不没个些呢吧啊呀哦么已曾将正刚才来去起出入回说看听想做走上中里外前后内间很最只仅人事时候大小多少好自己什么怎么可能够要因由于所或者即且并把被让".split(
    "",
  ),
);

/**
 * 动作动词表（含状态变化）。用于识别句子是否含可提取事件。
 *
 * 顺序敏感：否定形式（找不到/未找到/没找到）放在肯定形式（找到）之前，
 * 确保 ACTION_VERBS.find 优先匹配长词，避免"找不到"被误提取为"找到"。
 *
 * 仅收录语义明确的动作/状态变化词，不收录判断动词（是/有/在）。
 */
const ACTION_VERBS: readonly string[] = [
  // 否定形式优先（长词先匹配，避免子串误匹配）
  "找不到",
  "未找到",
  "没找到",
  // 移动类
  "推开门",
  "推开",
  "迈步",
  "走进",
  "走入",
  "进入",
  "离开",
  "出来",
  "回来",
  "上前",
  "退后",
  "走过",
  "走到",
  "跟上",
  "穿过",
  "飞出",
  "飞起",
  "振翅",
  // 取放类（含交付/归还/接物）
  "取出",
  "拿出",
  "放入",
  "封入",
  "压入",
  "塞入",
  "拿起",
  "拾起",
  "放下",
  "端起",
  "折下",
  "交出",
  "交给",
  "递给",
  "交还",
  "归还",
  "退还",
  "接过",
  "接收",
  "接下",
  // 扣押/释放类（P0-1：剧情反转关键动作）
  "扣留",
  "拘留",
  "收押",
  "羁押",
  "扣押",
  "收缴",
  "没收",
  "充公",
  "放行",
  "释放",
  "放走",
  "押送",
  "押解",
  // 查验类（P0-1：与扣留/放行形成反转对）
  "查验",
  "查看",
  "检查",
  "核验",
  "审视",
  // 接触类
  "抓住",
  "拉住",
  "握住",
  "抱住",
  "挡住",
  "抚摸",
  // 战斗/动作类
  "封印",
  "解开",
  "解封",
  "攻击",
  "防御",
  "杀",
  "救",
  // 认知/信息类
  "翻阅",
  "查找",
  "找到",
  "追查",
  "放弃",
  "记下",
  "准备",
  "查证",
  "看到",
  "听见",
  "想到",
  "提醒",
  "嘱咐",
  "指点",
  "点头",
  "摇头",
  // 言语类
  "说",
  "问",
  "答",
  // 日常动作
  "喝",
  "吃",
  "坐",
  "站",
  "躺",
  "睡",
  "醒",
  "叹气",
  "看",
  "听",
  "想",
  "走",
  "跑",
  "跳",
  "爬",
];

/**
 * 状态变化动词表。匹配这些词时 eventType="state_change"。
 */
const STATE_CHANGE_VERBS: readonly string[] = [
  "得到",
  "失去",
  "成功",
  "失败",
  "出现",
  "消失",
  "完成",
];

/**
 * 反义词对（动作反转检测）。用于 Phase 3B 比对器识别事件替换。
 */
const ANTONYM_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["封印", "释放"],
  ["封印", "解开"],
  ["封印", "解封"],
  ["封", "释放"],
  ["死", "复活"],
  ["杀", "救"],
  ["失败", "成功"],
  ["进入", "离开"],
  ["得到", "失去"],
  ["开启", "关闭"],
  ["上升", "下降"],
  ["胜利", "失败"],
  ["聚集", "消散"],
  ["合并", "分裂"],
  ["接受", "拒绝"],
  ["同意", "反对"],
  ["出现", "消失"],
  ["创造", "毁灭"],
  // 结果反转对（同一对象上的获得/追查 vs 否定/放弃）
  ["找到", "找不到"],
  ["找到", "未找到"],
  ["找到", "没找到"],
  ["找到", "放弃"],
  ["追查", "放弃"],
  ["得到", "放弃"],
  // P0-1：交付/扣押/放行反转对（生产探针：交出玉玺并放行 → 只看玉玺并扣留）
  ["交出", "扣留"],
  ["交出", "拘留"],
  ["交出", "收押"],
  ["交出", "羁押"],
  ["交出", "扣押"],
  ["交出", "没收"],
  ["交出", "收缴"],
  ["交给", "扣留"],
  ["交给", "没收"],
  ["递给", "扣留"],
  ["归还", "扣留"],
  ["归还", "没收"],
  ["退还", "扣留"],
  ["退还", "没收"],
  ["放行", "扣留"],
  ["放行", "拘留"],
  ["放行", "收押"],
  ["放行", "羁押"],
  ["放行", "扣押"],
  ["放行", "收缴"],
  ["放行", "没收"],
  ["放走", "扣留"],
  ["放走", "拘留"],
  ["释放", "扣留"],
  ["释放", "拘留"],
  ["释放", "收押"],
  ["释放", "羁押"],
  ["释放", "扣押"],
  // 交付 vs 接收（方向反转）
  ["交出", "接过"],
  ["交出", "接收"],
  ["交出", "接下"],
  // P0-1 第二轮：放行 vs 留下/扣下（生产探针：交出玉玺并放行 → 看玉玺并留下）
  // "留下" 在中文语境中可表示"扣留/不让走"，与"放行"形成反转
  ["放行", "留下"],
  ["放行", "扣下"],
  ["放行", "滞留"],
  ["放行", "截留"],
  ["放走", "留下"],
  ["释放", "留下"],
  // 交出 vs 查看/看（交付 vs 仅查看，关键动作变化）
  ["交出", "查看"],
  ["交出", "查验"],
  ["交出", "检查"],
  ["交给", "查看"],
  ["交给", "检查"],
  ["归还", "查看"],
  ["退还", "查看"],
];

/**
 * 关键动作集（P0-1 第三轮：单个关键事件替换即阻断）
 *
 * 设计理由：
 * - 某些动作对故事走向有决定性影响，单个被替换即可认定为剧情漂移
 * - 这些动作通常涉及：交付/释放/封印/死亡/获得等不可逆状态变化
 * - 与 antonym 检测互补：antonym 检测特定反义词对，critical 检测关键动作被任意替换
 *
 * 判定规则：
 * - raw 事件的 action 在 CRITICAL_ACTIONS 中
 * - editorial 匹配事件的 action 与 raw action 不同（非包含关系）
 * - → 标记为 critical replacement，单个即阻断（threshold=1）
 *
 * P0-1 第三轮（用户验收反例）：扩充战斗/取放/防御类状态性动作。
 * 实测 "攻击"→"看一眼"、"拿起"→"放下"、"防御攻击"→"主动攻击" 均返回 preserved=true，
 * 原因是关键动作表未覆盖攻击/防御/拿起/放下等状态性动作。
 * 这些动作对故事走向有决定性影响（战斗行为改变、物品控制权变化），
 * 单个被替换即应认定为剧情漂移。
 */
const CRITICAL_ACTIONS: ReadonlySet<string> = new Set([
  // 交付/取回类（改变物品归属）
  "交出", "交给", "递给", "交还", "归还", "退还", "接过", "接收", "接下",
  // 扣押/释放类（改变人身/物品自由）
  "扣留", "拘留", "收押", "羁押", "扣押", "收缴", "没收", "充公",
  "放行", "释放", "放走", "押送", "押解",
  // 封印/解封类（改变力量状态）
  "封印", "解开", "解封",
  // 生死类（不可逆）
  "杀", "救", "死", "复活",
  // 得失类（改变资源归属）
  "得到", "失去", "放弃",
  // 成败类
  "成功", "失败",
  // 进入/离开类（改变位置状态）
  "进入", "离开",
  // P0-1 第三轮：战斗/攻防类（改变战斗状态，对剧情走向决定性影响）
  "攻击", "防御", "防守", "反击", "闪避", "格挡", "抵挡", "还击",
  // P0-1 第三轮：取放类（改变物品控制权）
  "拿起", "放下", "取出", "拿出", "收入", "收回",
  // P0-1 第三轮：移动类（改变位置状态，关键场景）
  "走进", "走入", "出来", "回来", "穿过",
  // P0-1 第三轮：接触类（改变人物关系/状态）
  "抓住", "拉住", "握住", "抱住", "挡住",
]);

/**
 * 代词列表。用于识别代词句并绑定到前句主体。
 */
const PRONOUNS: readonly string[] = [
  "他",
  "她",
  "它",
  "他们",
  "她们",
  "它们",
  "此人",
  "其",
];

/**
 * 因果连接词（顺序违规检测 + causalParentIds 提取）。
 * 只检测显式因果连接词，不查首次出现位置。
 */
const CAUSAL_CONNECTORS: readonly string[] = [
  "完成后",
  "成后",
  "完后",
  "之后",
  "然后",
  "于是",
  "因此",
  "随后",
  "接着",
  "此后",
  "继而",
];

/**
 * 地点介词（location 提取）。
 * 句中出现这些介词 + knownEntity 时，将该实体标记为 location。
 */
const LOCATION_PREPOSITIONS: readonly string[] = [
  "进入",
  "走入",
  "走进",
  "离开",
  "到达",
  "抵达",
  "回到",
  "前往",
  "前去",
  "来自",
  "出自",
  "从",
  "在",
  "至",
];

/** 句子边界标点（句末） */
const SENTENCE_END_PUNCT = ["。", "！", "？", "!", "?"];

/** 子句边界标点（句中 + 句末） */
const CLAUSE_PUNCT = ["，", "。", "！", "？", "；", ";", "!", "?", "\n"];

/**
 * 子句连接词（P0-1：支持一句多事件抽取）。
 * 句中出现这些词时，将句子拆分为多个子句，每个子句独立提取事件。
 * 例如 "他交出玉玺并放行" → ["他交出玉玺", "放行"] → 2 个事件。
 */
const SUBCLAUSE_CONJUNCTIONS: readonly string[] = [
  "并",
  "并且",
  "且",
  "然后",
  "于是",
  "接着",
  "随后",
  "继而",
  "又",
  "同时",
  // P0-1b: 因果连接词也作为子句拆分点，确保因果链前后事件分别抽取
  "之后",
  "此后",
  "因此",
];

/**
 * P0 第四轮：否定标记。出现在动作动词前时，动作被否定。
 * "没有攻击" → negated=true（动作未发生）
 * "未杀死" → negated=true
 * "不曾攻击" → negated=true
 */
const NEGATION_MARKERS: readonly string[] = [
  "没有", "未", "不曾", "未曾", "并无", "并没", "没", "不", "无", "非",
];

/**
 * P0 第四轮：未遂/差点标记。出现在动作动词前时，动作未遂（未实际发生）。
 * "差点杀死" → nearMiss=true（动作未遂，目标未死）
 * "几乎杀死" → nearMiss=true
 * "险些杀死" → nearMiss=true
 */
const NEAR_MISS_MARKERS: readonly string[] = [
  "差点", "差点儿", "差点就", "差点儿就", "几乎", "险些", "近乎", "差一点", "差一点就",
];

/**
 * P0 第四轮：同义动作族。同族动作视为等价改写，不阻断。
 * 用于防止正常风格改写被误阻断：
 * - "交给" → "递给"（同属"交付"族）
 * - "离开" → "走出"（同属"移动离去"族）
 * - "拿出" → "取出"（同属"取物"族）
 *
 * 每组同义词在比对时视为 actionMatch=true。
 */
const SYNONYM_ACTION_FAMILIES: readonly string[][] = [
  // 交付族
  ["交出", "交给", "递给", "递交", "交还", "递过去", "递上"],
  // 取物族（P0 第五轮：补充拿起/拾起/捡起等同义动作）
  ["拿出", "取出", "掏出", "取走", "拿起", "拾起", "捡起", "拾"],
  // 放置族
  ["放下", "搁下", "放下", "置于"],
  // 移动离去族（P0 第五轮：补充迈步出/迈出/步出/迈步 等同义动作）
  // "迈步出了" 会被抽取为 action="迈步"（ACTION_VERBS 移动类），故 "迈步" 也需入族。
  ["离开", "走出", "离去", "走出去", "退出去", "退场", "迈步出", "迈出", "步出", "迈步"],
  // 移动进入族
  ["进入", "走入", "走进", "迈入", "跨入"],
  // 观看族
  ["看", "看到", "看向", "望着", "看着", "注视", "审视"],
  // 说话族
  ["说", "说道", "说道", "开口", "道"],
  // 抓握族
  ["抓住", "握住", "攥住", "抓紧"],
  // 攻击族（攻击方式不同但同属攻击行为）
  ["攻击", "进攻", "出击", "动手"],
  // 防御族
  ["防御", "防守", "抵挡", "格挡"],
];

// ============================================================================
// 类型定义
// ============================================================================

export type EventType = "action" | "state_change" | "state_description";

/**
 * 结构化事件：从文本中抽取的事件锚点。
 *
 * 与 editorial-story-preservation-gate.ts 的 EventAnchor 相比，新增：
 * - causalParentIds：通过因果连接词关联的前置事件 ID
 * - location：句中位置实体（来自 knownEntities + 地点介词）
 * - result / beforeState / afterState：状态变化事件的语义字段
 *
 * 不可提取的句子也记录（extractable=false），用于 trace 审计。
 */
export interface ExtractedEvent {
  /** 稳定 ID（基于位置：evt-{indexInText}） */
  id: string;
  /** 主体（句中第一个实体，或代词绑定到的前句主体；不可绑定时为空字符串） */
  subject: string;
  /** 动作或状态变化动词（state_description / 不可提取时为空字符串） */
  action: string;
  /** 事件类型 */
  eventType: EventType;
  /** 对象或结果（动作后的实体或关键片段；不可提取时为空字符串） */
  object: string;
  /** 地点（句中位置实体，无则空字符串） */
  location: string;
  /** 动作结果（state_change 时为新状态；其他事件为空字符串） */
  result: string;
  /** 动作前状态（罕见，仅在明确语义时填；否则空字符串） */
  beforeState: string;
  /** 动作后状态（state_change 时为新状态；其他事件为空字符串） */
  afterState: string;
  /** 因果父事件 ID 列表（通过因果连接词关联的前置事件） */
  causalParentIds: string[];
  /** 证据 span（含完整 excerpt） */
  evidenceSpan: TextSpan;
  /** 原文句子 */
  sentence: string;
  /** 句中所有已知实体 */
  entities: string[];
  /** 是否可提取为事件（只有含动作/状态变化/状态描述且主体明确时为 true） */
  extractable: boolean;
  /** 不可提取原因（extractable=false 时填，用于 trace 审计） */
  skipReason?: string;
  /**
   * P0 第四轮：动作是否被否定（没有攻击/未攻击/不曾攻击 等）。
   * 否定动作与肯定动作互为反转：raw "没有攻击" → editorial "攻击" = 语义反转。
   */
  negated?: boolean;
  /**
   * P0 第四轮：动作是否为未遂/差点（差点杀死/几乎杀死/险些杀死 等）。
   * 未遂动作与实际动作互为反转：raw "差点杀死" → editorial "杀死" = 语义反转。
   */
  nearMiss?: boolean;
}

/**
 * 事件抽取结果：含可提取与不可提取的锚点。
 * 不可提取的锚点用于 trace 审计事件提取决策。
 */
export interface EventExtractionResult {
  /** 抽取到的事件列表（含 extractable=false 的锚点） */
  events: ExtractedEvent[];
  /** 文本中检测到的因果链（用于 Phase 3B 顺序违规检测） */
  causalChains: ExtractedCausalChain[];
  /** 实体覆盖范围标记 */
  entityCoverage: "characters_only" | "full_entities";
}

/**
 * 因果链：显式因果连接词连接的前后子句。
 * 与 editorial-story-preservation-gate.ts 的 CausalChain 相比，新增 span 字段，
 * 用于将因果链关联到具体事件。
 */
export interface ExtractedCausalChain {
  /** 因果连接词前的子句（原因/前置事件） */
  beforeClause: string;
  /** 因果连接词后的子句（结果/后置事件） */
  afterClause: string;
  /** 连接词 */
  connector: string;
  /** 连接词在原文中的位置 */
  connectorPosition: number;
  /** before clause 的字符 span */
  beforeSpan: TextSpan;
  /** after clause 的字符 span */
  afterSpan: TextSpan;
}

// ============================================================================
// 文本工具函数
// ============================================================================

/** 检查字符是否为汉字 */
function isHan(ch: string): boolean {
  return /[\u4e00-\u9fa5]/.test(ch);
}

/** 检查字符是否为非停用汉字 */
function isSignificantHan(ch: string): boolean {
  return isHan(ch) && !STOP_CHARS.has(ch);
}

/**
 * 提取字符串中所有非停用汉字（去重）。
 * 用于内容匹配（不用于实体提取）。
 */
export function extractSignificantChars(text: string): Set<string> {
  const result = new Set<string>();
  for (const ch of text) {
    if (isSignificantHan(ch)) {
      result.add(ch);
    }
  }
  return result;
}

/**
 * P0 第五轮 P1 修复：将实体名规范化到规范名（alias → canonical）。
 *
 * 用于 Story Preservation 抽取阶段：raw 文本可能用 "叶尘"，editorial 文本用
 * "小尘"（别名），若不规范化，subject 比对会因字符串不等而误判为不同主体，
 * 导致同义改写被 hard block。
 *
 * 传入 aliasToCanonical 映射时，把别名替换为规范名；映射缺失或值为空时原样返回。
 *
 * @param entity 文本中匹配到的实体名（可能是规范名或别名）
 * @param aliasToCanonical 别名→规范名映射；未传入时原样返回
 */
function normalizeEntity(
  entity: string,
  aliasToCanonical: Map<string, string> | undefined,
): string {
  if (!aliasToCanonical || entity === "") return entity;
  const canonical = aliasToCanonical.get(entity);
  return canonical && canonical.length > 0 ? canonical : entity;
}

/**
 * 提取字符串中所有 2 字非停用汉字片段（去重）。
 * 用于内容匹配（不用于实体提取）。
 */
export function extractSignificantBigrams(text: string): Set<string> {
  const result = new Set<string>();
  const hanChars: string[] = [];
  for (const ch of text) {
    if (isHan(ch)) hanChars.push(ch);
  }
  for (let i = 0; i < hanChars.length - 1; i++) {
    const a = hanChars[i]!;
    const b = hanChars[i + 1]!;
    if (!STOP_CHARS.has(a) && !STOP_CHARS.has(b)) {
      result.add(a + b);
    }
  }
  return result;
}

// ============================================================================
// 句子切分
// ============================================================================

interface SentenceSpan {
  sentence: string;
  start: number;
  end: number;
}

/**
 * 按句末标点切分文本，保留每个句子的 span。
 */
function splitSentences(text: string): SentenceSpan[] {
  const result: SentenceSpan[] = [];
  const regex = /[^。！？!?]+[。！？!?]?/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const raw = m[0];
    const sentence = raw.trim();
    if (sentence.length > 0) {
      result.push({
        sentence,
        start: m.index,
        end: m.index + raw.length,
      });
    }
  }
  return result;
}

/**
 * 子句 span（P0-1：支持一句多事件支持）。
 */
interface SubClauseSpan {
  clause: string;
  start: number; // 相对原文的偏移
  end: number;
}

/**
 * P0-1 第三轮：在句子中查找最早出现的动词（按句中位置，而非数组顺序）。
 *
 * 修复 "防御攻击" 被 ACTION_VERBS.find 抽取为 "攻击"（数组靠前）而非 "防御"（句中靠前）的 bug。
 * "防御攻击" 语义是"防御对方的攻击"，主动作是"防御"；按数组顺序会先匹配 "攻击" 导致语义反转。
 *
 * @param sentence 句子文本
 * @param verbs 动词表
 * @returns 句中最早出现的动词；无匹配返回 undefined
 */
function findEarliestVerb(
  sentence: string,
  verbs: readonly string[],
): string | undefined {
  let earliest: string | undefined;
  let earliestPos = Number.MAX_SAFE_INTEGER;
  for (const v of verbs) {
    const pos = sentence.indexOf(v);
    if (pos >= 0 && pos < earliestPos) {
      earliestPos = pos;
      earliest = v;
    }
  }
  return earliest;
}

/**
 * 将一个句子拆分为多个子句（P0-1：支持一句多事件抽取）。
 *
 * 拆分规则：
 * 1. 按子句标点（，；）拆分
 * 2. 按子句连接词（并/且/然后/于是...）拆分，连接词归到后一子句
 * 3. 长度 < 2 的子句丢弃
 *
 * 例如："他交出玉玺并放行" → ["他交出玉玺", "并放行"] → 去连接词 → ["他交出玉玺", "放行"]
 *
 * @param sentence 句子文本
 * @param sentenceStart 句子在原文中的起始偏移
 */
function splitSubClauses(sentence: string, sentenceStart: number): SubClauseSpan[] {
  // 先按标点切分
  const punctSplit: SubClauseSpan[] = [];
  let cursor = 0;
  for (let i = 0; i < sentence.length; i++) {
    const ch = sentence[i]!;
    if (CLAUSE_PUNCT.includes(ch)) {
      const clause = sentence.slice(cursor, i);
      if (clause.trim().length >= 2) {
        punctSplit.push({
          clause: clause.trim(),
          start: sentenceStart + cursor,
          end: sentenceStart + i,
        });
      }
      cursor = i + 1;
    }
  }
  // 末尾子句
  const tail = sentence.slice(cursor);
  if (tail.trim().length >= 2) {
    punctSplit.push({
      clause: tail.trim(),
      start: sentenceStart + cursor,
      end: sentenceStart + sentence.length,
    });
  }

  // 若标点切分只产生 1 个子句，尝试按连接词切分
  if (punctSplit.length <= 1) {
    const conjSplit: SubClauseSpan[] = [];
    for (const sub of punctSplit.length === 1 ? punctSplit : [{
      clause: sentence.trim(),
      start: sentenceStart,
      end: sentenceStart + sentence.length,
    }]) {
      // 找句中第一个子句连接词（不在句首的）
      let splitIdx = -1;
      let conjLen = 0;
      for (const conj of SUBCLAUSE_CONJUNCTIONS) {
        // 从第 2 个字符开始查找，避免句首连接词
        const idx = sub.clause.indexOf(conj, 1);
        if (idx > 0 && (splitIdx === -1 || idx < splitIdx)) {
          splitIdx = idx;
          conjLen = conj.length;
        }
      }
      if (splitIdx > 0) {
        const beforeClause = sub.clause.slice(0, splitIdx).trim();
        // 连接词归到后一子句，但去掉连接词本身
        const afterClause = sub.clause.slice(splitIdx + conjLen).trim();
        if (beforeClause.length >= 2) {
          conjSplit.push({
            clause: beforeClause,
            start: sub.start,
            end: sub.start + splitIdx,
          });
        }
        if (afterClause.length >= 2) {
          conjSplit.push({
            clause: afterClause,
            start: sub.start + splitIdx + conjLen,
            end: sub.end,
          });
        }
        // 若 afterClause 还含连接词，递归切分（最多再切一次，避免过度拆分）
        if (afterClause.length >= 2) {
          let innerSplitIdx = -1;
          let innerConjLen = 0;
          for (const conj of SUBCLAUSE_CONJUNCTIONS) {
            const idx = afterClause.indexOf(conj, 1);
            if (idx > 0 && (innerSplitIdx === -1 || idx < innerSplitIdx)) {
              innerSplitIdx = idx;
              innerConjLen = conj.length;
            }
          }
          // 已经切出的子句不再二次切分，避免过度拆分
          void innerSplitIdx;
          void innerConjLen;
        }
      } else {
        conjSplit.push(sub);
      }
    }
    return conjSplit.length > 0 ? conjSplit : punctSplit;
  }

  return punctSplit;
}

// ============================================================================
// 事件结构分析
// ============================================================================

interface EventStructureAnalysis {
  subject: string;
  action: string;
  eventType: EventType;
  objectOrResult: string;
  location: string;
  result: string;
  beforeState: string;
  afterState: string;
  extractable: boolean;
  skipReason?: string;
  /** P0 第四轮：动作是否被否定 */
  negated?: boolean;
  /** P0 第四轮：动作是否为未遂/差点 */
  nearMiss?: boolean;
}

/**
 * 分析句子的事件结构：识别主体、动作、对象/结果、地点、状态变化，判断是否可提取。
 *
 * 主体识别规则：
 * 1. 句中以代词开头（他/她/它...）且有前句主体 → subject = lastSubject（代词绑定）
 * 2. 句中含已知实体 → subject = 第一个实体
 * 3. 句中以代词开头但无前句主体 → extractable=false（不可绑定）
 *
 * 动作识别（优先级：state_change > action > state_description）：
 * - 优先匹配 STATE_CHANGE_VERBS（得到/失去/出现/消失等）→ eventType="state_change"
 * - 其次匹配 ACTION_VERBS（推开门/抓住/封印等）→ eventType="action"
 * - 无匹配但含实体且非纯判断/指认/单独名字 → eventType="state_description"
 *
 * 不可提取条件（extractable=false，eventType 仍为 "state_description" 占位但 extractable=false）：
 * - 代词无前句主体可绑定
 * - 单独名字句（去标点后只剩实体名）
 * - 纯判断/指认句（含"是"/"不是"，无动作动词）
 */
function analyzeEventStructure(
  sentence: string,
  entityTable: string[],
  lastSubject: string | null,
  aliasToCanonical?: Map<string, string>,
): EventStructureAnalysis {
  const entities = entityTable.filter((e) => sentence.includes(e));
  const startsWithPronoun = PRONOUNS.some((p) => sentence.startsWith(p));

  // P0-1b: 检测子句是否以动词开头（无显式主语）
  // 例如 "走入密室" 以 "走入" 开头 → subject 应为 lastSubject，而非首个实体 "密室"
  const startsWithVerb =
    ACTION_VERBS.some((v) => sentence.startsWith(v)) ||
    STATE_CHANGE_VERBS.some((v) => sentence.startsWith(v));

  // ── 主体识别 ──────────────────────────────────────────────────────
  let subject = "";
  if (startsWithPronoun && lastSubject) {
    subject = lastSubject;
  } else if (startsWithVerb && lastSubject) {
    // P0-1b: 动词开头的子句 → 主语为 lastSubject（隐式主语绑定）
    // 子句中的实体是对象/位置，不是主语
    subject = lastSubject;
  } else if (entities.length > 0) {
    // P0 第四轮：主体按句中位置选择（最早的实体），而非实体表顺序。
    //
    // 用户验收反例："叶尘攻击林默" → entities=["林默","叶尘"]（表顺序），
    // 旧逻辑选 entities[0]="林默" 作为主体，但实际主体是 "叶尘"（句中最早）。
    // 这导致主客体反转检测失效："叶尘攻击林默"→"林默攻击叶尘" 被误判为同主体同动作。
    //
    // 修复：按 sentence.indexOf(e) 升序选择最早出现的实体作为主体。
    let earliestEntity = entities[0]!;
    let earliestPos = sentence.indexOf(earliestEntity);
    for (const e of entities) {
      const pos = sentence.indexOf(e);
      if (pos < earliestPos) {
        earliestPos = pos;
        earliestEntity = e;
      }
    }
    // P0 第五轮 P1 修复：把别名规范化到规范名（"小尘"→"叶尘"），
    // 使 raw/editorial 用不同称呼时 subject 比对仍命中。
    subject = normalizeEntity(earliestEntity, aliasToCanonical);
  } else if (startsWithPronoun && !lastSubject) {
    return {
      subject: "",
      action: "",
      eventType: "state_description",
      objectOrResult: "",
      location: "",
      result: "",
      beforeState: "",
      afterState: "",
      extractable: false,
      skipReason: "代词无前句主体可绑定",
    };
  } else if (lastSubject) {
    // P0-1：无实体无代词但有 lastSubject → 隐式主语绑定
    // 例如 "李天行交出玉玺并放行" → 第二子句 "放行" 绑定到 "李天行"
    subject = lastSubject;
  }

  // ── 单独名字句检测 ────────────────────────────────────────────────
  const stripped = sentence.replace(/[，。！？；,.!?;\s\n]/g, "");
  if (entityTable.some((e) => stripped === e)) {
    return {
      subject,
      action: "",
      eventType: "state_description",
      objectOrResult: "",
      location: "",
      result: "",
      beforeState: "",
      afterState: "",
      extractable: false,
      skipReason: "单独名字，无动作或状态变化",
    };
  }

  // ── 动作动词识别（先查状态变化，再查动作）─────────────────────
  // P0-1 第三轮：按句中位置选择最早出现的动词，而非数组顺序。
  // 修复 "防御攻击" 抽取为 "攻击"（数组靠前）而非 "防御"（句中靠前）的 bug：
  // "防御攻击" 语义是"防御对方的攻击"，主动作是"防御"，"攻击"是对象。
  // 旧逻辑 ACTION_VERBS.find 按 array order 返回 "攻击"，导致 "防御攻击"→"主动攻击"
  // 被误判为 action 相同（都是"攻击"），不触发 critical replacement。
  const stateChangeVerb = findEarliestVerb(sentence, STATE_CHANGE_VERBS);
  const actionVerb = findEarliestVerb(sentence, ACTION_VERBS);

  // ── 纯判断/指认句检测 ─────────────────────────────────────────────
  if (!actionVerb && !stateChangeVerb) {
    const hasJudgmentMarker = /不是/.test(sentence) || /(^|，)是/.test(sentence) || /^是/.test(sentence);
    if (hasJudgmentMarker) {
      return {
        subject,
        action: "",
        eventType: "state_description",
        objectOrResult: "",
        location: "",
        result: "",
        beforeState: "",
        afterState: "",
        extractable: false,
        skipReason: "纯判断/指认句，无动作或状态变化",
      };
    }
    // 含已知实体的描述性句子作为 state_description 事件锚点。
    return {
      subject,
      action: "",
      eventType: "state_description",
      objectOrResult: entities.length > 0 ? normalizeEntity(entities[0]!, aliasToCanonical) : subject,
      location: normalizeEntity(extractLocation(sentence, entityTable), aliasToCanonical),
      result: "",
      beforeState: "",
      afterState: "",
      extractable: true,
    };
  }

  // ── 对象/结果、状态、地点提取 ─────────────────────────────────────
  const verb = stateChangeVerb ?? actionVerb!;
  const eventType: "action" | "state_change" = stateChangeVerb ? "state_change" : "action";

  // 对象：动作后的第一个实体，或动作后的关键片段（前 10 字符去标点）
  const actionIdx = sentence.indexOf(verb);
  const afterAction = sentence.slice(actionIdx + verb.length);
  const objectEntity = entityTable.find((e) => afterAction.includes(e));
  let objectOrResult: string;
  if (objectEntity) {
    // P0 第五轮 P1 修复：对象实体规范化到规范名
    objectOrResult = normalizeEntity(objectEntity, aliasToCanonical);
  } else {
    const fragment = afterAction
      .slice(0, 10)
      .replace(/[，。！？；,.!?;\s\n]/g, "");
    objectOrResult = fragment;
  }

  // 状态变化语义字段
  let result = "";
  let beforeState = "";
  let afterState = "";
  if (eventType === "state_change") {
    // state_change 事件的 verb 本身描述了新状态（如"成功"/"失败"/"出现"/"消失"）
    afterState = verb;
    result = objectOrResult || verb;
    // 反义推断 beforeState（如"成功" → beforeState="未成功"）
    beforeState = inferBeforeState(verb);
  }

  // 地点提取（P0 第五轮 P1 修复：规范化到规范名）
  const location = normalizeEntity(extractLocation(sentence, entityTable), aliasToCanonical);

  // P0 第四轮：否定/未遂检测
  // 检查动词前是否有否定标记（没有/未/不曾 等）或未遂标记（差点/几乎/险些 等）
  // "没有攻击" → negated=true；"差点杀死" → nearMiss=true
  const beforeVerb = sentence.slice(0, actionIdx);
  const negated = NEGATION_MARKERS.some((m) => beforeVerb.includes(m));
  const nearMiss = NEAR_MISS_MARKERS.some((m) => beforeVerb.includes(m));

  return {
    subject,
    action: verb,
    eventType,
    objectOrResult,
    location,
    result,
    beforeState,
    afterState,
    extractable: true,
    negated,
    nearMiss,
  };
}

/**
 * 从句子中提取地点实体。
 *
 * 算法：扫描 LOCATION_PREPOSITIONS，找到介词后紧跟的 knownEntity。
 * 只在 entityCoverage=full_entities 时有意义（characters_only 时无地点实体）。
 *
 * 优先匹配长介词（如"进入"优先于"在"），避免误匹配。
 */
function extractLocation(sentence: string, entityTable: string[]): string {
  // 按 length 降序匹配，长介词优先
  const sortedPreps = [...LOCATION_PREPOSITIONS].sort((a, b) => b.length - a.length);
  for (const prep of sortedPreps) {
    const prepIdx = sentence.indexOf(prep);
    if (prepIdx === -1) continue;
    const afterPrep = sentence.slice(prepIdx + prep.length);
    // 找介词后的第一个实体
    for (const entity of entityTable) {
      // 实体必须紧跟介词（允许中间最多 1 个字符的连接词如"了"）
      if (afterPrep.startsWith(entity)) return entity;
      if (afterPrep.length > 1 && afterPrep[0] === "了" && afterPrep.slice(1).startsWith(entity)) {
        return entity;
      }
    }
  }
  return "";
}

/**
 * 推断 state_change 事件的前置状态（beforeState）。
 *
 * 基于 state_change verb 的反义推断：
 * - "成功" → beforeState="未成功"
 * - "失败" → beforeState="未失败"（保留中性）
 * - "出现" → beforeState="未出现"
 * - "消失" → beforeState="存在"
 * - "得到" → beforeState="未得到"
 * - "失去" → beforeState="拥有"
 * - "完成" → beforeState="未完成"
 *
 * 这只是启发式推断，不保证准确；trace 中会标注。
 */
function inferBeforeState(stateChangeVerb: string): string {
  const mapping: Record<string, string> = {
    "成功": "未成功",
    "失败": "未失败",
    "出现": "未出现",
    "消失": "存在",
    "得到": "未得到",
    "失去": "拥有",
    "完成": "未完成",
  };
  return mapping[stateChangeVerb] ?? "";
}

// ============================================================================
// 因果链提取（含 span）
// ============================================================================

/**
 * 从文本中提取因果链：显式因果连接词连接的前后子句。
 *
 * - before clause: 从上一个子句边界标点到连接词
 * - after clause: 从连接词到下一个句末标点（含中间逗号，捕获完整后续事件）
 * - 同时记录 beforeSpan / afterSpan，用于关联事件 ID
 */
function extractCausalChainsWithSpans(text: string): ExtractedCausalChain[] {
  const chains: ExtractedCausalChain[] = [];
  for (const connector of CAUSAL_CONNECTORS) {
    let idx = text.indexOf(connector);
    while (idx !== -1) {
      // P0-1b: before clause — 跳过紧邻连接词的标点，找到真正的前置子句
      // 例如 "叶尘推开石门，然后走入密室" 中 "然后" 前面是 "，"，
      // 需要跳过逗号找到 "叶尘推开石门" 作为 beforeClause
      let scanEnd = idx;
      while (scanEnd > 0 && CLAUSE_PUNCT.includes(text[scanEnd - 1]!)) {
        scanEnd--;
      }
      let beforeStart = -1;
      for (const p of CLAUSE_PUNCT) {
        const i = text.lastIndexOf(p, scanEnd - 1);
        if (i > beforeStart) beforeStart = i;
      }
      beforeStart = beforeStart === -1 ? 0 : beforeStart + 1;
      const beforeClause = text.slice(beforeStart, idx).trim();
      const beforeSpan: TextSpan = {
        start: beforeStart,
        end: idx,
        excerpt: beforeClause,
      };

      // P0-1b: after clause — afterSpan 从连接词位置开始（而非之后），
      // 因为 splitSubClauses 会把连接词归入后一子句，
      // 事件 span 从连接词位置开始，需要 overlap 匹配
      const afterContentStart = idx + connector.length;
      let afterEnd = text.length;
      for (const p of SENTENCE_END_PUNCT) {
        const i = text.indexOf(p, afterContentStart);
        if (i !== -1 && i < afterEnd) afterEnd = i;
      }
      const afterClause = text.slice(afterContentStart, afterEnd).trim();
      // afterSpan 从连接词位置开始，覆盖包含连接词的子句事件
      const afterSpan: TextSpan = {
        start: idx,
        end: afterEnd,
        excerpt: afterClause,
      };

      if (beforeClause.length > 0 && afterClause.length > 0) {
        chains.push({
          beforeClause,
          afterClause,
          connector,
          connectorPosition: idx,
          beforeSpan,
          afterSpan,
        });
      }
      idx = text.indexOf(connector, idx + 1);
    }
  }
  return chains;
}

// ============================================================================
// 核心抽取函数
// ============================================================================

/**
 * 从文本中抽取结构化事件。
 *
 * 算法：
 * 1. 构建实体表（仅 knownEntities，不靠频率提取）
 * 2. 切分句子
 * 3. 对每个句子分析事件结构（subject/action/object/location/state）
 * 4. 维护 lastSubject 指针，支持代词绑定
 * 5. 提取因果链（含 span）
 * 6. 根据 span 重叠关系，为每个事件计算 causalParentIds
 * 7. 为每个事件生成稳定 ID（evt-{index}）
 *
 * 不可提取的句子也记录（extractable=false），用于 trace 审计。
 *
 * @param text 原文（raw 或 editorial）
 * @param knownEntities 已知实体列表（角色/地点/组织/物品）
 * @param options.entityCoverage 实体覆盖范围标记，默认 "characters_only"
 * @param options.aliasToCanonical 别名→规范名映射（P0 第五轮 P1 修复）。
 *   传入时，抽取出的 subject/object/location/entities 字段会被规范化到同一角色名，
 *   使 raw 用 "叶尘" 与 editorial 用 "小尘"（别名）时 subject 比对仍命中，避免误阻断。
 *   未传入时不做规范化（向后兼容）。
 */
export function extractEvents(
  text: string,
  knownEntities: string[] | undefined,
  options?: {
    entityCoverage?: "characters_only" | "full_entities";
    aliasToCanonical?: Map<string, string>;
  },
): EventExtractionResult {
  const entityCoverage = options?.entityCoverage ?? "characters_only";
  const aliasToCanonical = options?.aliasToCanonical;

  // 边界：空文本
  if (!text || text.trim().length === 0) {
    return {
      events: [],
      causalChains: [],
      entityCoverage,
    };
  }

  // 1. 构建实体表（仅 knownEntities，不靠频率提取）
  const entityTable = (knownEntities ?? [])
    .filter((e) => e && e.trim().length >= 2)
    .filter((e, i, arr) => arr.indexOf(e) === i); // 去重，保留顺序

  // 2. 切分句子
  const sentences = splitSentences(text);

  // 边界：无句子
  if (sentences.length === 0) {
    return {
      events: [],
      causalChains: [],
      entityCoverage,
    };
  }

  // 3. 对每个句子分析事件结构（P0-1：按子句拆分，支持一句多事件）
  const events: ExtractedEvent[] = [];
  let lastSubject: string | null = null;
  let eventIndex = 0;
  for (const { sentence, start } of sentences) {
    // P0-1：将句子按标点和连接词拆分为子句，每个子句独立提取事件
    // 例如 "他交出玉玺并放行" → ["他交出玉玺", "放行"] → 2 个事件
    const subClauses = splitSubClauses(sentence, start);
    for (const { clause: rawClause, start: rawStart, end: clauseEnd } of subClauses) {
      // P0-1b: 剥离子句开头的关系连接词（然后/于是/接着...）
      // 这些是因果标记，不是事件文本；剥离后确保正确识别主语（lastSubject 而非首个实体）
      let clause = rawClause;
      let clauseStart = rawStart;
      for (const conj of SUBCLAUSE_CONJUNCTIONS) {
        if (clause.startsWith(conj)) {
          clause = clause.slice(conj.length).trim();
          clauseStart += conj.length;
          break;
        }
      }
      if (clause.length < 2) continue;

      const clauseEntitiesRaw = entityTable.filter((e) => clause.includes(e));
      // P0 第五轮 P1 修复：子句实体规范化到规范名（别名→canonical）。
      // 规范化后的 clauseEntities 既用于事件 entities 字段，也用于共享实体检测，
      // 使 raw 用 "小尘" 与 editorial 用 "叶尘" 时 hasCommonEntity 仍命中。
      const clauseEntities = aliasToCanonical
        ? clauseEntitiesRaw.map((e) => normalizeEntity(e, aliasToCanonical))
        : clauseEntitiesRaw;
      const clauseStartsWithPronoun = PRONOUNS.some((p) => clause.startsWith(p));

      // P0-1：跳过完全无信号子句（无实体、无代词、无动作动词）
      // 但如果子句含动作动词且 lastSubject 已设置，不跳过（隐式主语绑定）
      // 例如 "李天行交出玉玺并放行" → 第二子句 "放行" 无实体但应绑定到 "李天行"
      //
      // P0-1 第三轮：含动作动词的子句即使无 lastSubject 也应抽取（隐式主体）。
      // 用户验收反例："攻击"→"看一眼"、"拿起"→"放下" 等短文本因 lastSubject=null 被跳过，
      // 导致 0 个可提取事件 → unverifiable → 放过剧情反转。
      // 修复：含动作动词的子句即使无 lastSubject 也抽取，subject="" 表示隐式主体。
      // 比对器通过位置匹配处理两个隐式主体事件的对应关系。
      if (clauseEntitiesRaw.length === 0 && !clauseStartsWithPronoun) {
        const hasActionVerb =
          ACTION_VERBS.some((v) => clause.includes(v)) ||
          STATE_CHANGE_VERBS.some((v) => clause.includes(v));
        if (!hasActionVerb) continue;
        // hasActionVerb=true → 允许抽取（隐式主体，subject="" 由 analyzeEventStructure 设置）
      }

      const analysis = analyzeEventStructure(clause, entityTable, lastSubject, aliasToCanonical);

      // 更新 lastSubject：子句中含实体时更新为句中最早出现的实体（P0 第四轮：按句中位置）
      // P0 第五轮 P1 修复：lastSubject 也规范化到规范名，保证后续代词/隐式主语绑定一致。
      if (clauseEntitiesRaw.length > 0) {
        let earliestEnt = clauseEntitiesRaw[0]!;
        let earliestPos = clause.indexOf(earliestEnt);
        for (const e of clauseEntitiesRaw) {
          const pos = clause.indexOf(e);
          if (pos < earliestPos) {
            earliestPos = pos;
            earliestEnt = e;
          }
        }
        lastSubject = normalizeEntity(earliestEnt, aliasToCanonical);
      }

      const eventId = `evt-${String(eventIndex).padStart(3, "0")}`;
      eventIndex++;

      events.push({
        id: eventId,
        subject: analysis.subject,
        action: analysis.action,
        eventType: analysis.eventType,
        object: analysis.objectOrResult,
        location: analysis.location,
        result: analysis.result,
        beforeState: analysis.beforeState,
        afterState: analysis.afterState,
        causalParentIds: [], // 稍后填充
        evidenceSpan: {
          start: clauseStart,
          end: clauseEnd,
          excerpt: clause,
        },
        sentence: clause,
        entities: clauseEntities,
        extractable: analysis.extractable,
        skipReason: analysis.skipReason,
        // P0 第四轮：传播否定/未遂标记
        negated: analysis.negated,
        nearMiss: analysis.nearMiss,
      });
    }
  }

  // 4. 提取因果链（含 span）
  const causalChains = extractCausalChainsWithSpans(text);

  // 5. 根据 span 重叠关系，为每个事件计算 causalParentIds
  // P0-1b: 使用 overlap 匹配（而非严格包含），因为子句事件 span 可能与
  //         因果链 beforeSpan/afterSpan 部分重叠（如连接词归入后一子句）
  // 规则：若事件 E 的 span 与某因果链的 afterSpan 重叠，
  //       则该因果链 beforeSpan 内的事件为 E 的因果父事件。
  for (const event of events) {
    for (const chain of causalChains) {
      const eventStart = event.evidenceSpan.start;
      const eventEnd = event.evidenceSpan.end;
      const afterStart = chain.afterSpan.start;
      const afterEnd = chain.afterSpan.end;
      // P0-1b: overlap 检查 — 事件 span 与 afterSpan 有重叠
      if (eventStart < afterEnd && eventEnd > afterStart) {
        // 找 beforeSpan 内的事件（overlap 匹配）
        for (const parentEvent of events) {
          if (parentEvent.id === event.id) continue;
          const parentStart = parentEvent.evidenceSpan.start;
          const parentEnd = parentEvent.evidenceSpan.end;
          const beforeStart = chain.beforeSpan.start;
          const beforeEnd = chain.beforeSpan.end;
          // P0-1b: overlap 检查 — 父事件 span 与 beforeSpan 有重叠
          if (parentStart < beforeEnd && parentEnd > beforeStart) {
            if (!event.causalParentIds.includes(parentEvent.id)) {
              event.causalParentIds.push(parentEvent.id);
            }
          }
        }
      }
    }
  }

  return {
    events,
    causalChains,
    entityCoverage,
  };
}

// ============================================================================
// 公开工具函数（供 Phase 3B 比对器使用）
// ============================================================================

/**
 * 检测动作反转：raw 句与 editorial 句是否含反义词对。
 * 复用 editorial-story-preservation-gate.ts 的逻辑，保持一致性。
 */
export function detectActionReversal(
  rawSentence: string,
  editorialSentence: string,
): { reversed: boolean; pair: readonly [string, string] | null } {
  for (const [left, right] of ANTONYM_PAIRS) {
    const rawHasLeft = rawSentence.includes(left);
    const rawHasRight = rawSentence.includes(right);
    const edHasLeft = editorialSentence.includes(left);
    const edHasRight = editorialSentence.includes(right);
    // raw 含左、editorial 含右（或 raw 含右、editorial 含左）→ 反转
    if ((rawHasLeft && edHasRight && !rawHasRight) ||
        (rawHasRight && edHasLeft && !rawHasLeft)) {
      return { reversed: true, pair: [left, right] };
    }
  }
  return { reversed: false, pair: null };
}

/**
 * 判断动作是否为关键动作（P0-1 第二轮）。
 *
 * 关键动作的替换单个即阻断，不需要累积到 lowSimilarityReplacementThreshold。
 * 这防止"交出玉玺→看玉玺"这类单个关键事件反转被放行。
 *
 * @param action - 事件动作（已抽取的 action 字段）
 * @returns 是否为关键动作
 */
export function isCriticalAction(action: string): boolean {
  if (!action || action.length === 0) return false;
  // 精确匹配
  if (CRITICAL_ACTIONS.has(action)) return true;
  // 长词包含短词：如 "交出玉玺" 包含 "交出"
  for (const critical of CRITICAL_ACTIONS) {
    if (action.includes(critical) && critical.length >= 2) return true;
  }
  return false;
}

/**
 * 检测关键动作替换（P0-1 第二轮）。
 *
 * 当 raw 事件的动作是关键动作（如"交出""放行""封印"），
 * 而 editorial 匹配事件的动作与之显著不同（非包含关系），
 * 则视为关键事件替换，单个即阻断。
 *
 * 与 detectActionReversal 的区别：
 * - detectActionReversal 检测特定反义词对（如"封印"↔"释放"）
 * - detectCriticalReplacement 检测关键动作被任意不同动作替换（如"交出"→"看"）
 *
 * @param rawAction - raw 事件的动作
 * @param editorialAction - editorial 匹配事件的动作
 * @returns 是否为关键动作替换
 */
export function detectCriticalReplacement(
  rawAction: string,
  editorialAction: string,
): { critical: boolean; rawCriticalAction: string | null } {
  if (!rawAction || !editorialAction) return { critical: false, rawCriticalAction: null };

  // 检查 raw 动作是否为关键动作
  let rawCriticalAction: string | null = null;
  for (const critical of CRITICAL_ACTIONS) {
    if (critical.length >= 2 && rawAction.includes(critical)) {
      rawCriticalAction = critical;
      break;
    }
  }
  if (!rawCriticalAction) return { critical: false, rawCriticalAction: null };

  // editorial 动作是否与 raw 关键动作相同或包含关系
  // 包含关系允许 "交出" 匹配 "交出玉玺"（同动作，不同粒度）
  const actionsSimilar =
    rawAction === editorialAction ||
    rawAction.includes(editorialAction) ||
    editorialAction.includes(rawAction) ||
    editorialAction.includes(rawCriticalAction);

  if (actionsSimilar) return { critical: false, rawCriticalAction };

  // P0 第四轮：同义动作族检查 —— 同族动作不视为关键替换
  // 防止 "交给→递给" 等正常风格改写被误阻断
  if (areActionsSynonymous(rawAction, editorialAction)) {
    return { critical: false, rawCriticalAction };
  }

  // raw 是关键动作，editorial 动作显著不同 → 关键替换
  return { critical: true, rawCriticalAction };
}

/**
 * P0 第四轮：检查两个动作是否属于同一同义动作族。
 * 同族动作视为等价改写（如 "交给"→"递给"、"离开"→"走出"），不阻断。
 *
 * @param actionA - 动作 A
 * @param actionB - 动作 B
 * @returns true 表示同族（等价改写）
 */
export function areActionsSynonymous(actionA: string, actionB: string): boolean {
  if (!actionA || !actionB) return false;
  if (actionA === actionB) return true;
  // 包含关系（同动作不同粒度）
  if (actionA.includes(actionB) || actionB.includes(actionA)) return true;
  // 同族检查
  for (const family of SYNONYM_ACTION_FAMILIES) {
    const aInFamily = family.some((m) => actionA.includes(m) || m.includes(actionA));
    const bInFamily = family.some((m) => actionB.includes(m) || m.includes(actionB));
    if (aInFamily && bInFamily) return true;
  }
  return false;
}

/**
 * P0 第四轮：检测主客体反转。
 *
 * "叶尘攻击林默" → "林默攻击叶尘"：同一动作，但主体和客体交换了位置。
 * 这是攻击方向的反转，等同于事件反转，应单个即阻断。
 *
 * @param rawSubject - raw 事件主体
 * @param rawObject - raw 事件客体
 * @param edSubject - editorial 事件主体
 * @param edObject - editorial 事件客体
 * @returns true 表示主客体反转
 */
export function detectSubjectObjectSwap(
  rawSubject: string,
  rawObject: string,
  edSubject: string,
  edObject: string,
): boolean {
  // 两方都必须有非空主体和客体才能检测反转
  if (!rawSubject || !rawObject || !edSubject || !edObject) return false;
  // 防误报：raw 主体和客体相同（如 "梦堂→梦堂"）时不应判定为反转
  // （同体自匹配会让 rawSubject===edObject 且 rawObject===edSubject 恒真）
  if (rawSubject === rawObject) return false;
  // raw 主体 == editorial 客体 AND raw 客体 == editorial 主体 → 主客体反转
  return rawSubject === edObject && rawObject === edSubject;
}

/**
 * P0 第四轮：检测否定语义反转。
 *
 * "没有攻击" → "攻击"：raw 否定 + editorial 肯定 = 语义反转（否定被移除）。
 * "攻击" → "没有攻击"：raw 肯定 + editorial 否定 = 语义反转（动作被否定）。
 *
 * @param rawNegated - raw 事件是否否定
 * @param edNegated - editorial 事件是否否定
 * @returns true 表示否定语义反转
 */
export function detectNegationReversal(
  rawNegated: boolean | undefined,
  edNegated: boolean | undefined,
): boolean {
  // 一方否定，一方肯定 → 反转
  return (rawNegated === true && edNegated !== true) ||
         (edNegated === true && rawNegated !== true);
}

/**
 * P0 第四轮：检测未遂→实际语义反转。
 *
 * "差点杀死" → "杀死"：raw 未遂 + editorial 实际 = 语义反转（未遂变成实际发生）。
 * "杀死" → "差点杀死"：raw 实际 + editorial 未遂 = 语义反转（实际变成未遂）。
 *
 * @param rawNearMiss - raw 事件是否未遂
 * @param edNearMiss - editorial 事件是否未遂
 * @returns true 表示未遂语义反转
 */
export function detectNearMissReversal(
  rawNearMiss: boolean | undefined,
  edNearMiss: boolean | undefined,
): boolean {
  // 一方未遂，一方实际 → 反转
  return (rawNearMiss === true && edNearMiss !== true) ||
         (edNearMiss === true && rawNearMiss !== true);
}

/**
 * 计算两个字符集合的 Jaccard 相似度。
 * |A ∩ B| / |A ∪ B|
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const ch of a) {
    if (b.has(ch)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 检查两个字符串是否共享至少 1 个 2 字非停用、非实体内部片段。
 * 用于排除同义改写。
 */
export function hasSharedSignificantBigram(
  a: string,
  b: string,
  entityTable: string[],
): boolean {
  const aBigrams = extractSignificantBigrams(a);
  const bBigrams = extractSignificantBigrams(b);
  const entityFragments = new Set<string>();
  for (const entity of entityTable) {
    for (let i = 0; i < entity.length - 1; i++) {
      const frag = entity.slice(i, i + 2);
      if (frag.length === 2) entityFragments.add(frag);
    }
  }
  for (const bg of aBigrams) {
    if (entityFragments.has(bg)) continue;
    if (bBigrams.has(bg)) return true;
  }
  return false;
}

/**
 * 检查两个字符串是否共享足够内容（用于因果对匹配）。
 * 共享条件（满足任一）：
 * - 共享至少 1 个已知实体
 * - 共享至少 1 个 2 字非停用片段
 * - 共享至少 2 个非停用汉字
 */
export function shareSignificantContent(
  a: string,
  b: string,
  entityTable: string[],
): boolean {
  for (const e of entityTable) {
    if (a.includes(e) && b.includes(e)) return true;
  }
  const aBigrams = extractSignificantBigrams(a);
  const bBigrams = extractSignificantBigrams(b);
  for (const bg of aBigrams) {
    if (bBigrams.has(bg)) return true;
  }
  const aChars = extractSignificantChars(a);
  const bChars = extractSignificantChars(b);
  let shared = 0;
  for (const ch of aChars) {
    if (bChars.has(ch)) {
      shared++;
      if (shared >= 2) return true;
    }
  }
  return false;
}

/**
 * 获取事件的可提取子集（extractable=true）。
 * 用于 Phase 3B 比对器只比较可提取事件。
 */
export function getExtractableEvents(events: ExtractedEvent[]): ExtractedEvent[] {
  return events.filter((e) => e.extractable);
}
