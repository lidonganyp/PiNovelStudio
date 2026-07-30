/**
 * EditorialStoryPreservationGate — editorial 故事骨架保持门禁（DEMO-3-R2.2）
 *
 * R2.2 修复 R2.1 的高误杀问题，把门禁从"词频/人物位置检测"收敛为真正的事件保真检查：
 *
 * 一、实体来源（不再靠频率提取）
 * - 删除 extractEntitiesByFrequency / extractCandidateFragments（2字滑动窗口产生伪实体）
 * - 实体仅来自 knownEntities（运行输入提供的角色/地点/组织/物品或专名）
 * - 不确定内容宁可不作实体，不得靠任意字窗补齐
 * - knownEntities 不能只传 characterNames 而假装已覆盖地点/组织/物品；
 *   通过 entityCoverage 字段标记能力边界（characters_only / full_entities）
 *
 * 二、事件模型（结构化事件，不是"含实体的整句"）
 * - 事件锚点 = 含至少 1 个已知实体的句子
 * - 结构：主体（实体）+ 句子全文 + span
 * - 比较时区分：实体缺失 / 动作反转（反义词对）/ 低相似度替换 / 仅措辞变化
 * - 不能以"某个实体在全文仍出现"证明事件被保留（需比较事件结构）
 *
 * 三、顺序判定（只查显式因果链，不查首次出现位置）
 * - 删除"人物首次出现位置顺序 = 因果顺序"的实现
 * - 只检测显式因果连接词（完成后/之后/然后/于是/因此/随后/接着/此后）
 * - 检查 raw 的因果对 (A→B) 是否在 editorial 中变为 (B→A)
 * - 人物/地点/物品首次提及顺序变化不触发
 *
 * 四、阻断规则（事件级证据，不基于词项计数）
 * - 不得因一个普通新增词或新增细节直接拒绝整章
 * - 新增事件只有在替换、否定或挤掉 raw 关键事件时才能形成阻断证据
 * - 允许新增章末压力、环境细节、局部动作和对话
 * - replacedEventThreshold 不再基于词项计数，而是基于事件级比较（相似度+反义词）
 * - 阻断必须有至少一个可解释的事件级证据
 * - unverifiable 可以保守回退，但必须与明确漂移分开统计
 *
 * 本地确定性，无 LLM 调用。
 */

import type { TextSpan } from "./types.js";
import { extractEvents } from "./event-extractor.js";
import {
  compareEventLedgers,
  type LedgerComparison,
  type CausalBreakEvidence,
  type StateChangeLossEvidence,
  type AdvisorySimilarityEvidence,
} from "./event-ledger-comparator.js";

// ============================================================================
// 常量
// ============================================================================

/**
 * 中文停用字表。用于内容匹配时过滤无意义字符（不用于实体提取）。
 * 这些字在中文中是语法/虚词/常用动词/方位词，单独或组合不构成故事实体。
 */
const STOP_CHARS = new Set<string>(
  "的了着过地得是有在到为以和与也都就还又再但而把被让使给对向从我你他她它们其此谁这那哪不没个些呢吧啊呀哦么已曾将正刚才来去起出入回说看听想做走上中里外前后内间很最只仅人事时候大小多少好自己什么怎么可能够要因由于所或者即且并把被让".split(
    "",
  ),
);

/**
 * 反义词对（动作反转检测）。
 * 当 raw 句含左词、editorial 句含右词（或反之）时，判定动作反转。
 * 仅收录语义明确对立的成对词，避免误判。
 *
 * R2.3 新增结果反转对：
 * - ["找到", "找不到"] / ["找到", "未找到"] / ["找到", "没找到"]：
 *   同一对象上"获得"被否定为"未获得"，是结果反转（不是反义词，但语义对立）
 * - ["找到", "放弃"] / ["追查", "放弃"] / ["得到", "放弃"]：
 *   同一对象上"获得/追查"被改写为"放弃"，是结果反转
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
  // R2.3 结果反转对（同一对象上的获得/追查 vs 否定/放弃）
  ["找到", "找不到"],
  ["找到", "未找到"],
  ["找到", "没找到"],
  ["找到", "放弃"],
  ["追查", "放弃"],
  ["得到", "放弃"],
];

/**
 * R2.3 动作动词表（含状态变化）。用于识别句子是否含可提取事件。
 *
 * 顺序敏感：否定形式（找不到/未找到/没找到）放在肯定形式（找到）之前，
 * 确保 ACTION_VERBS.find 优先匹配长词，避免"找不到"被误提取为"找到"。
 *
 * 仅收录语义明确的动作/状态变化词，不收录判断动词（是/有/在）。
 *
 * DEMO-3-R2.4：拆分为 ACTION_VERBS（动作）和 STATE_CHANGE_VERBS（状态变化），
 * 用于区分 eventType="action" 和 eventType="state_change"。
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
  // 取放类
  "取出",
  "拿出",
  "放入",
  "封入",
  "压入",
  "塞入",
  "拿起",
  "放下",
  "端起",
  "折下",
  // 接触类
  "抓住",
  "拉住",
  "握住",
  "抱住",
  "挡住",
  "抚摸",
  // 战斗/动作类
  "封印",
  "释放",
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
 * DEMO-3-R2.4：状态变化动词表。
 *
 * 这些词表示状态的变化（得到/失去/出现/消失等），区别于具体物理动作。
 * 匹配这些词时 eventType="state_change"，而非 eventType="action"。
 * 状态变化可以作为事件证据，但与物理动作语义不同。
 */
const STATE_CHANGE_VERBS: readonly string[] = [
  // 状态变化类
  "得到",
  "失去",
  "成功",
  "失败",
  "出现",
  "消失",
  "完成",
];

/**
 * R2.3 代词列表。用于识别代词句并绑定到前句主体。
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
 * 因果连接词（顺序违规检测）。
 * 只检测显式因果连接词，不查首次出现位置。
 * 仅收录 2 字以上的明确连接词，避免单字误匹配。
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

/** 句子边界标点（句末） */
const SENTENCE_END_PUNCT = ["。", "！", "？", "!", "?"];

/** 子句边界标点（句中 + 句末） */
const CLAUSE_PUNCT = ["，", "。", "！", "？", "；", ";", "!", "?", "\n"];

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
function extractSignificantChars(text: string): Set<string> {
  const result = new Set<string>();
  for (const ch of text) {
    if (isSignificantHan(ch)) {
      result.add(ch);
    }
  }
  return result;
}

/**
 * 提取字符串中所有 2 字非停用汉字片段（去重）。
 * 用于内容匹配（不用于实体提取）。
 */
function extractSignificantBigrams(text: string): Set<string> {
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

// ============================================================================
// 事件锚点（结构化事件）
// ============================================================================

/**
 * 事件锚点：含至少 1 个已知实体或可绑定代词的句子。
 *
 * R2.3 结构升级：
 * - subject: 主体（句中第一个实体，或代词绑定到的前句主体）
 * - action: 动作或状态变化（从 ACTION_VERBS/STATE_CHANGE_VERBS 匹配，如"取出"/"封印"/"找到"）
 * - objectOrResult: 对象或结果（动作后的实体或关键片段）
 * - sentence: 句子全文
 * - span: 在原文中的位置
 * - entities: 句中所有已知实体
 * - significantChars: 句中所有非停用汉字（用于相似度比较）
 * - extractable: 是否可提取为事件（只有含动作/状态变化/状态描述且主体明确时为 true）
 * - skipReason: 不可提取原因（extractable=false 时填，用于 trace 审计）
 *
 * DEMO-3-R2.4 事件类型语义升级：
 * - eventType: 明确区分动作/状态变化/状态描述，取代旧的 action="描述" 伪装
 *   - "action": 存在真实动作（ACTION_VERBS 匹配，如推开门/抓住/封印）
 *   - "state_change": 存在状态变化（STATE_CHANGE_VERBS 匹配，如得到/失去/出现/消失）
 *   - "state_description": 仅描述状态（无动作/状态变化动词，但含实体）
 *   - extractable=false 时 eventType 为空字符串
 *
 * 不可提取的情况（extractable=false）：
 * - 纯判断句（"X是Y"/"X不是Y"，无动作动词）
 * - 指认句（"是Y"，无主语）
 * - 单独名字（句子去掉标点后只剩实体名）
 * - 代词句无前句主体可绑定
 *
 * 可提取但 eventType="state_description" 的情况：
 * - 含已知实体但无 ACTION_VERBS/STATE_CHANGE_VERBS 匹配，且非纯判断/指认/单独名字句
 * - 故事关键节点常以描述句呈现（"指尖沾了黑色雾气"/"星图标注禁星渊"），
 *   这类句子需作为事件锚点参与 missing_event 检测
 * - 但 state_description 不可作为动作反转证据（replaced_event reversal 检测跳过此类型）
 */
interface EventAnchor {
  subject: string;
  action: string;
  /**
   * DEMO-3-R2.4：事件类型，明确区分动作/状态变化/状态描述。
   * - "action": 真实动作（ACTION_VERBS 匹配）
   * - "state_change": 状态变化（STATE_CHANGE_VERBS 匹配）
   * - "state_description": 仅描述状态（无动作/状态变化动词但含实体）
   * - "": 不可提取（extractable=false）
   */
  eventType: "action" | "state_change" | "state_description" | "";
  objectOrResult: string;
  sentence: string;
  span: TextSpan;
  entities: string[];
  significantChars: Set<string>;
  extractable: boolean;
  skipReason?: string;
}

/**
 * R2.3 分析句子的事件结构：识别主体、动作、对象/结果，判断是否可提取。
 *
 * DEMO-3-R2.4 事件类型语义升级：
 * - 返回 eventType 字段，明确区分 action/state_change/state_description
 * - 不再用 action="描述" 伪装状态描述为已提取动作
 * - state_description 仍 extractable=true（可参与 missing_event 检测），
 *   但不参与动作反转检测（replaced_event reversal）
 *
 * 主体识别规则：
 * 1. 句中以代词开头（他/她/它...）且有前句主体 → subject = lastSubject（代词绑定）
 * 2. 句中含已知实体 → subject = 第一个实体
 * 3. 句中以代词开头但无前句主体 → extractable=false（不可绑定）
 *
 * 动作识别：
 * - 优先匹配 STATE_CHANGE_VERBS（得到/失去/出现/消失等）→ eventType="state_change"
 * - 其次匹配 ACTION_VERBS（推开门/抓住/封印等）→ eventType="action"
 * - 无匹配但含实体且非纯判断/指认/单独名字 → eventType="state_description"
 *
 * 不可提取条件（extractable=false，eventType=""）：
 * - 代词无前句主体可绑定
 * - 单独名字句（去标点后只剩实体名）
 * - 纯判断/指认句（含"是"/"不是"，无动作动词）
 */
function analyzeEventStructure(
  sentence: string,
  entityTable: string[],
  lastSubject: string | null,
): {
  subject: string;
  action: string;
  eventType: "action" | "state_change" | "state_description" | "";
  objectOrResult: string;
  extractable: boolean;
  skipReason?: string;
} {
  const entities = entityTable.filter((e) => sentence.includes(e));
  const startsWithPronoun = PRONOUNS.some((p) => sentence.startsWith(p));

  // ── 主体识别 ──────────────────────────────────────────────────────
  let subject = "";
  if (startsWithPronoun && lastSubject) {
    // 代词绑定到前句主体
    subject = lastSubject;
  } else if (entities.length > 0) {
    // 句中第一个实体作为主体
    subject = entities[0]!;
  } else if (startsWithPronoun && !lastSubject) {
    // 代词在首句且无前句主体 → 不可提取
    return {
      subject: "",
      action: "",
      eventType: "",
      objectOrResult: "",
      extractable: false,
      skipReason: "代词无前句主体可绑定",
    };
  }

  // ── 单独名字句检测 ────────────────────────────────────────────────
  // 句子去掉标点/空白后只剩一个实体名 → 单独名字，无动作
  const stripped = sentence.replace(/[，。！？；,.!?;\s\n]/g, "");
  if (entityTable.some((e) => stripped === e)) {
    return {
      subject,
      action: "",
      eventType: "",
      objectOrResult: "",
      extractable: false,
      skipReason: "单独名字，无动作或状态变化",
    };
  }

  // ── 动作动词识别（DEMO-3-R2.4：先查状态变化，再查动作）─────────────
  // 状态变化动词优先：同一句可能同时含"得到"和"抓住"，优先归为 state_change
  // 因为状态变化比物理动作更抽象，优先匹配可避免误分类。
  const stateChangeVerb = STATE_CHANGE_VERBS.find((v) => sentence.includes(v));
  const actionVerb = ACTION_VERBS.find((v) => sentence.includes(v));

  // ── 纯判断/指认句检测 ─────────────────────────────────────────────
  // 含"是"/"不是"但无动作动词和状态变化动词 → 判断句
  if (!actionVerb && !stateChangeVerb) {
    const hasJudgmentMarker = /不是/.test(sentence) || /(^|，)是/.test(sentence) || /^是/.test(sentence);
    if (hasJudgmentMarker) {
      return {
        subject,
        action: "",
        eventType: "",
        objectOrResult: "",
        extractable: false,
        skipReason: "纯判断/指认句，无动作或状态变化",
      };
    }
    // DEMO-3-R2.4：含已知实体的描述性句子作为 state_description 事件锚点。
    //
    // 故事关键节点常以描述句呈现（"指尖沾了黑色雾气"/"星图标注禁星渊"），
    // 若一律判 extractable=false 会漏掉这些关键事件，导致 missing_event 检测失效。
    //
    // 用 eventType="state_description" 明确标记这类句子（不再用 action="描述" 伪装）。
    // action 字段留空（无动作动词可提取），objectOrResult 取句中第一个实体（或绑定的主体）。
    //
    // state_description 句子：
    // - 可参与 missing_event 检测（实体缺失仍是事件缺失）
    // - 可参与低相似度替换检测（措辞大幅变化仍是替换证据）
    // - 不可参与动作反转检测（无动作，反义词对不适用）
    //
    // 纯判断句/指认句/单独名字已在上方分支拒绝，不会到这里。
    return {
      subject,
      action: "",
      eventType: "state_description",
      objectOrResult: entities.length > 0 ? entities[0]! : subject,
      extractable: true,
    };
  }

  // ── 对象/结果提取 ─────────────────────────────────────────────────
  // 确定使用的动词和 eventType
  const verb = stateChangeVerb ?? actionVerb!;
  const eventType: "action" | "state_change" = stateChangeVerb ? "state_change" : "action";

  // 动作后的第一个实体，或动作后的关键片段（前 10 字符去标点）
  const actionIdx = sentence.indexOf(verb);
  const afterAction = sentence.slice(actionIdx + verb.length);
  const objectEntity = entityTable.find((e) => afterAction.includes(e));
  let objectOrResult: string;
  if (objectEntity) {
    objectOrResult = objectEntity;
  } else {
    // 取动作后的关键片段（前 10 字符，去标点）
    const fragment = afterAction
      .slice(0, 10)
      .replace(/[，。！？；,.!?;\s\n]/g, "");
    objectOrResult = fragment;
  }

  return {
    subject,
    action: verb,
    eventType,
    objectOrResult,
    extractable: true,
  };
}

/**
 * 从句子列表中提取事件锚点：含至少 1 个已知实体或可绑定代词的句子。
 *
 * R2.3 升级：
 * - 维护 lastSubject 指针，支持代词绑定
 * - 每个锚点含 action/objectOrResult/extractable/skipReason
 * - 不可提取的句子也记录（用于 trace 审计），但 extractable=false
 * - 调用方按 extractable=true 过滤做 missing/replaced 比较
 *
 * 实体来源仅限 knownEntities（运行输入），不靠频率提取。
 */
function extractEventAnchors(
  sentences: SentenceSpan[],
  entityTable: string[],
): EventAnchor[] {
  const anchors: EventAnchor[] = [];
  let lastSubject: string | null = null;
  for (const { sentence, start, end } of sentences) {
    const entities = entityTable.filter((e) => sentence.includes(e));
    const startsWithPronoun = PRONOUNS.some((p) => sentence.startsWith(p));

    // 跳过完全无信号句（无实体、无代词）
    if (entities.length === 0 && !startsWithPronoun) continue;

    const analysis = analyzeEventStructure(sentence, entityTable, lastSubject);

    // 更新 lastSubject：句中含实体时更新为第一个实体
    if (entities.length > 0) {
      lastSubject = entities[0]!;
    }
    // 代词绑定成功时，lastSubject 保持（已在上次实体句更新）

    anchors.push({
      subject: analysis.subject,
      action: analysis.action,
      eventType: analysis.eventType,
      objectOrResult: analysis.objectOrResult,
      sentence,
      span: { start, end, excerpt: sentence },
      entities,
      significantChars: extractSignificantChars(sentence),
      extractable: analysis.extractable,
      skipReason: analysis.skipReason,
    });
  }
  return anchors;
}

// ============================================================================
// 相似度与内容匹配
// ============================================================================

/**
 * 计算两个字符集合的 Jaccard 相似度。
 * |A ∩ B| / |A ∪ B|
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
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
 * 检查两个字符串是否共享足够内容（用于因果对匹配）。
 * 共享条件（满足任一）：
 * - 共享至少 1 个已知实体
 * - 共享至少 1 个 2 字非停用片段
 * - 共享至少 2 个非停用汉字
 */
function shareSignificantContent(
  a: string,
  b: string,
  entityTable: string[],
): boolean {
  // 共享已知实体
  for (const e of entityTable) {
    if (a.includes(e) && b.includes(e)) return true;
  }
  // 共享 2 字非停用片段
  const aBigrams = extractSignificantBigrams(a);
  const bBigrams = extractSignificantBigrams(b);
  for (const bg of aBigrams) {
    if (bBigrams.has(bg)) return true;
  }
  // 共享 >= 2 个非停用汉字
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
 * 检测动作反转：raw 句与 editorial 句是否含反义词对。
 */
function detectActionReversal(
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
 * 检查两个句子是否共享至少 1 个 2 字非停用、非实体内部片段。
 * 用于排除同义改写：同义改写虽用词不同但通常共享关键内容双字词（火候/药鼎/丹药等）。
 *
 * 关键排除：已知实体内部的片段（如"祝明"、"明朗"来自"祝明朗"）不计入共享。
 * 因为同一角色出现在不同事件中时，实体片段必然共享，但这不能证明事件相同——
 * 否则角色名只要保留，任何事件替换都会被错误豁免（R1 漂移样本就是这种情况）。
 * 只有**非实体的内容性双字片段**共享，才能作为同义改写的证据。
 */
function hasSharedSignificantBigram(
  a: string,
  b: string,
  entityTable: string[],
): boolean {
  const aBigrams = extractSignificantBigrams(a);
  const bBigrams = extractSignificantBigrams(b);
  // 收集所有实体内部的 2 字片段，作为排除集
  const entityFragments = new Set<string>();
  for (const entity of entityTable) {
    for (let i = 0; i < entity.length - 1; i++) {
      const frag = entity.slice(i, i + 2);
      if (frag.length === 2) entityFragments.add(frag);
    }
  }
  for (const bg of aBigrams) {
    if (entityFragments.has(bg)) continue; // 跳过实体内部片段
    if (bBigrams.has(bg)) return true;
  }
  return false;
}

// ============================================================================
// 因果链提取（顺序违规检测）
// ============================================================================

interface CausalChain {
  /** 因果连接词前的子句（原因/前置事件） */
  beforeClause: string;
  /** 因果连接词后的子句（结果/后置事件，延伸到句末） */
  afterClause: string;
  /** 连接词 */
  connector: string;
  /** 连接词在原文中的位置 */
  position: number;
}

/**
 * 从文本中提取因果链：显式因果连接词连接的前后子句。
 *
 * - before clause: 从上一个子句边界标点到连接词
 * - after clause: 从连接词到下一个句末标点（含中间逗号，捕获完整后续事件）
 */
function extractCausalChains(text: string): CausalChain[] {
  const chains: CausalChain[] = [];
  for (const connector of CAUSAL_CONNECTORS) {
    let idx = text.indexOf(connector);
    while (idx !== -1) {
      // before clause: 从上一个子句边界到连接词
      let beforeStart = -1;
      for (const p of CLAUSE_PUNCT) {
        const i = text.lastIndexOf(p, idx - 1);
        if (i > beforeStart) beforeStart = i;
      }
      beforeStart += 1;
      const beforeClause = text.slice(beforeStart, idx).trim();

      // after clause: 从连接词后到下一个句末标点（含中间逗号）
      const afterStart = idx + connector.length;
      let afterEnd = text.length;
      for (const p of SENTENCE_END_PUNCT) {
        const i = text.indexOf(p, afterStart);
        if (i !== -1 && i < afterEnd) afterEnd = i;
      }
      // 跳过开头的标点和空格
      let afterSliceStart = afterStart;
      while (afterSliceStart < afterEnd && CLAUSE_PUNCT.includes(text[afterSliceStart]!)) {
        afterSliceStart++;
      }
      const afterClause = text.slice(afterSliceStart, afterEnd).trim();

      if (beforeClause.length > 0 && afterClause.length > 0) {
        chains.push({ beforeClause, afterClause, connector, position: idx });
      }
      idx = text.indexOf(connector, idx + 1);
    }
  }
  return chains;
}

/**
 * 检测因果顺序违规：raw 的因果对 (A→B) 是否在 editorial 中变为 (B→A)。
 *
 * 算法：
 * 1. 提取 raw 和 editorial 的因果链
 * 2. 对每个 raw 链 (A→B) 和 editorial 链 (C→D)：
 *    - 若 A 与 D 共享内容（A 的事件出现在 editorial 的后置）AND
 *      B 与 C 共享内容（B 的事件出现在 editorial 的前置）→ 因果颠倒
 * 3. 只报告有明确内容重叠的反转对，不报告位置变化
 *
 * 人物/地点/物品首次提及顺序变化不触发（无因果连接词）。
 */
function detectOrderViolations(
  rawText: string,
  editorialText: string,
  entityTable: string[],
): OrderViolation[] {
  const rawChains = extractCausalChains(rawText);
  const editorialChains = extractCausalChains(editorialText);
  if (rawChains.length === 0 || editorialChains.length === 0) return [];

  const violations: OrderViolation[] = [];
  for (const rawChain of rawChains) {
    for (const edChain of editorialChains) {
      // 检查反转：raw.before (A) 匹配 editorial.after (D)
      //         AND raw.after (B) 匹配 editorial.before (C)
      const aMatchesD = shareSignificantContent(
        rawChain.beforeClause,
        edChain.afterClause,
        entityTable,
      );
      const bMatchesC = shareSignificantContent(
        rawChain.afterClause,
        edChain.beforeClause,
        entityTable,
      );
      if (aMatchesD && bMatchesC) {
        // 排除正向匹配（避免同时是正向和反向时误报）
        const aMatchesC = shareSignificantContent(
          rawChain.beforeClause,
          edChain.beforeClause,
          entityTable,
        );
        const bMatchesD = shareSignificantContent(
          rawChain.afterClause,
          edChain.afterClause,
          entityTable,
        );
        // 只有当正向不匹配（或反向比正向更强）时才报告
        // 这里采用保守策略：正向也匹配时不报告（可能是同一段落的重复叙述）
        if (!aMatchesC || !bMatchesD) {
          violations.push({
            rawBeforeClause: rawChain.beforeClause,
            rawAfterClause: rawChain.afterClause,
            editorialBeforeClause: edChain.beforeClause,
            editorialAfterClause: edChain.afterClause,
            connector: `${rawChain.connector} / ${edChain.connector}`,
            reason: `因果顺序颠倒：raw 中 '${rawChain.beforeClause.slice(0, 20)}…→ ${rawChain.afterClause.slice(0, 20)}…'，但 editorial 中 '${edChain.beforeClause.slice(0, 20)}…→ ${edChain.afterClause.slice(0, 20)}…'（事件对调）`,
          });
          // 每个 raw 链只报告一次（找到第一个反转就跳到下一个 raw 链）
          break;
        }
      }
    }
  }
  return violations;
}

// ============================================================================
// 门禁输入/输出类型
// ============================================================================

export interface StoryPreservationGateInput {
  /** raw 候选完整正文 */
  rawText: string;
  /** editorial 候选完整正文 */
  editorialText: string;
  /**
   * 已知实体列表（来自运行输入：角色/地点/组织/物品或专名）。
   * 非空时直接用作实体表；为空时返回 unverifiable（保守拒绝，不靠频率提取）。
   * 不内置任何作品名单。
   */
  knownEntities?: string[];
  /**
   * 实体覆盖范围标记（能力边界）。
   * - "characters_only": knownEntities 只含角色名（默认，保守）
   * - "full_entities": knownEntities 含角色/地点/组织/物品等完整实体
   * 不传时默认 "characters_only"。
   * 调用方在只有 characterNames 时不得假装 full_entities。
   */
  entityCoverage?: "characters_only" | "full_entities";
  /**
   * 缺失事件锚点句数量阈值。缺失事件数 >= 此值时判定漂移。
   * 默认 2（需要至少 2 个事件级证据，避免单实体偶然缺失误判）。
   */
  missingEventThreshold?: number;
  /**
   * 动作反转事件数量阈值。反转事件数 >= 此值时判定漂移。
   * 默认 1（任何动作反转即判定漂移——反义词对是事件级硬证据）。
   * 反义词对（如封印↔释放）是明确的事件反转，单个即构成阻断证据。
   */
  replacedEventThreshold?: number;
  /**
   * 替换事件相似度阈值。raw 句与 editorial 最佳匹配句的相似度低于此值时
   * 判为低相似度替换候选。默认 0.25（保守，只捕捉大幅改写）。
   *
   * 注意：低相似度本身不直接阻断（同义改写也可能低相似度），
   * 需配合 lowSimilarityReplacementThreshold 达到系统性漂移才阻断。
   * 动作反转（反义词对）不受此阈值影响，始终判为替换。
   */
  replacedSimilarityThreshold?: number;
  /**
   * 低相似度替换事件数量阈值。低相似度替换数 >= 此值时判定漂移。
   * 默认 3（需要至少 3 个低相似度句对才判定系统性漂移）。
   *
   * 设计理由：单个低相似度句对可能是同义改写（措辞不同但事件相同），
   * 不应因一个普通改写直接拒绝整章。只有多个句对同时低相似度，
   * 才构成系统性事件替换的证据。
   *
   * 动作反转事件不在此阈值内（replacedEventThreshold 单独控制）。
   */
  lowSimilarityReplacementThreshold?: number;
  /**
   * Phase 3C：门禁模式选择。
   * - "event_ledger"（默认）：使用结构化事件账本比对（Phase 3A/3B）。
   *   生产 agentic_style 流使用此模式。基于事件结构（subject+action+object）
   *   和因果链比对，能可靠检测"保留人物但整章换事件"的结构性漂移。
   * - "similarity"：使用旧相似度门（R2.4）。仅 eval 回放/B4 诊断使用。
   *   基于文本 Jaccard 相似度 + 反义词对检测。
   * 不传时默认 "event_ledger"（生产默认走新门禁）。
   */
  mode?: "similarity" | "event_ledger";
  /**
   * P0 第五轮 P1 修复：别名→规范名映射。
   *
   * 由 unified-entry 从 seed.characters（name + aliases）构建。传入后 extractEvents
   * 会把 raw/editorial 文本中的别名规范化到同一规范名，使 "叶尘"（raw）与 "小尘"
   * （editorial 别名）的 subject 比对仍命中，避免同义改写被误判为事件漂移。
   *
   * 仅在 event_ledger 模式生效；similarity 模式不消费此字段。未传入时不做规范化。
   */
  aliasToCanonical?: Map<string, string>;
}

export interface MissingEvent {
  /** raw 事件锚点句全文 */
  anchor: string;
  /** raw 中的证据 span */
  rawSpan: TextSpan;
  /** 该句中缺失的实体列表（在 editorial 全文不存在） */
  missingEntities: string[];
  /** 拒绝原因 */
  reason: string;
}

export interface ReplacedEvent {
  /** 事件主体（实体） */
  subject: string;
  /** raw 事件句 */
  rawSentence: string;
  /** raw 中的证据 span */
  rawSpan: TextSpan;
  /** editorial 中最佳匹配句 */
  editorialSentence: string;
  /** editorial 中的证据 span */
  editorialSpan: TextSpan;
  /** raw 句与 editorial 句的相似度（0-1） */
  similarity: number;
  /** 是否检测到动作反转（反义词对） */
  reversal: boolean;
  /** 检测到的反义词对（reversal=true 时非 null） */
  antonymPair: readonly [string, string] | null;
  /** 拒绝原因 */
  reason: string;
}

export interface OrderViolation {
  /** raw 中因果对的前置事件子句 */
  rawBeforeClause: string;
  /** raw 中因果对的后置事件子句 */
  rawAfterClause: string;
  /** editorial 中因果对的前置事件子句 */
  editorialBeforeClause: string;
  /** editorial 中因果对的后置事件子句 */
  editorialAfterClause: string;
  /** 因果连接词 */
  connector: string;
  /** 拒绝原因 */
  reason: string;
}

/**
 * R2.3 结构化事件锚点 finding（公开 trace 用）。
 *
 * 与内部 EventAnchor 区别：findings 是纯数据（无 Set 等非 JSON 字段），
 * 可直接序列化到 trace；含 extractable=false 的句子，用于审计事件提取决策。
 *
 * DEMO-3-R2.4：新增 eventType 字段，明确区分 action/state_change/state_description。
 * 取代旧的 action="描述" 伪装，使 trace 可解释事件提取的语义决策。
 */
export interface EventAnchorFinding {
  /** 主体（实体或代词绑定后的实体；不可绑定时为空字符串） */
  subject: string;
  /** 动作或状态变化动词（不可提取或 state_description 时为空字符串） */
  action: string;
  /**
   * DEMO-3-R2.4：事件类型。
   * - "action": 真实动作（ACTION_VERBS 匹配）
   * - "state_change": 状态变化（STATE_CHANGE_VERBS 匹配）
   * - "state_description": 仅描述状态（无动作/状态变化动词但含实体，可参与 missing_event 但不参与动作反转）
   * - "": 不可提取（extractable=false）
   */
  eventType: "action" | "state_change" | "state_description" | "";
  /** 对象或结果（动作后的实体或关键片段；不可提取时为空字符串） */
  objectOrResult: string;
  /** 原文句子 */
  sentence: string;
  /** 句子在原文中的位置 */
  span: TextSpan;
  /** 是否可提取为事件（只有含动作/状态变化/状态描述且主体明确时为 true） */
  extractable: boolean;
  /** 不可提取原因（extractable=false 时填） */
  skipReason?: string;
}

export interface StoryPreservationGateReport {
  /** true = 故事骨架保持；false = 漂移或不可验证，拒绝并交付 raw */
  preserved: boolean;
  /** true = 输入不可验证（空文本或无实体），保守拒绝 */
  unverifiable: boolean;
  /** 拒绝类型：missing_event / replaced_event / order_violation / unverifiable / null（通过时） */
  rejectionType: "missing_event" | "replaced_event" | "order_violation" | "unverifiable" | null;
  /** 缺失的事件锚点句列表 */
  missingEvents: MissingEvent[];
  /** 替换事件列表（基于事件结构比较，不是词项计数） */
  replacedEvents: ReplacedEvent[];
  /** 因果顺序违规列表（基于显式因果连接词，不是首次出现位置） */
  orderViolations: OrderViolation[];
  /** raw 事件锚点句列表（含已知实体的句子） */
  rawEventAnchors: string[];
  /**
   * R2.3 结构化事件锚点 findings（含 extractable=true/false 全部句子）。
   * 用于 trace 审计事件提取决策：哪些句子被提取为事件、哪些被跳过及原因。
   * 每个 finding 含 subject/action/objectOrResult/span/extractable/skipReason。
   */
  rawEventAnchorFindings: EventAnchorFinding[];
  /** 实体覆盖范围标记（能力边界） */
  entityCoverage: "characters_only" | "full_entities";
  /** 判定原因（用于 trace） */
  reason: string;
  /**
   * Phase 3C：门禁模式（event_ledger / similarity）。
   * 用于 trace 区分生产门禁与 eval 回放门禁。
   * 不传时为 undefined（旧 trace 兼容）。
   */
  mode?: "similarity" | "event_ledger";
  /**
   * Phase 3C：因果断裂列表（仅 event_ledger 模式产出）。
   * raw 事件的 causalParentIds 指向的事件在 editorial 中缺失。
   * similarity 模式下为空数组（旧逻辑无此检测）。
   */
  causalBreaks?: CausalBreakEvidence[];
  /**
   * Phase 3C：状态变化丢失列表（仅 event_ledger 模式产出）。
   * raw state_change 事件的 afterState 在 editorial 中无对应。
   * similarity 模式下为空数组。
   */
  stateChangeLosses?: StateChangeLossEvidence[];
  /**
   * Phase 3C：advisory 相似度证据（仅 event_ledger 模式产出，不阻断）。
   * 记录低相似度但可能为同义改写的句对，供 trace 诊断。
   * similarity 模式下为空数组。
   */
  advisorySimilarities?: AdvisorySimilarityEvidence[];
  /**
   * Phase 3C：editorial 可提取事件数（仅 event_ledger 模式产出）。
   * 用于 trace 审计事件抽取对称性。
   */
  editorialEventCount?: number;
}

// ============================================================================
// 核心门禁函数
// ============================================================================

/**
 * 检查 editorial 候选是否保留 raw 的故事骨架。
 *
 * Phase 3C：默认使用 event_ledger 模式（结构化事件账本比对）。
 * eval 回放/B4 诊断可通过 `mode: "similarity"` 使用旧相似度门。
 *
 * event_ledger 模式算法（Phase 3A/3B）：
 * 1. 从 raw/editorial 抽取结构化事件（subject+action+object+location+state+causalParentIds）
 * 2. 比对事件账本：缺失/替换/因果顺序/因果断裂/状态变化丢失
 * 3. 阻断条件：缺失 >= 阈值 或 替换 >= 阈值 或 顺序违规 > 0 或 因果断裂 > 0 或 状态变化丢失 > 0
 *
 * similarity 模式算法（R2.4，eval 回放用）：
 * 1. 构建实体表（仅 knownEntities，不靠频率提取）
 * 2. 无实体 → unverifiable（保守拒绝）
 * 3. 提取 raw 事件锚点句（含 >=1 个已知实体的句子）
 * 4. 缺失事件检测：raw 锚点句的实体在 editorial 全文不存在 → missing_event
 * 5. 替换事件检测：同一实体的 raw 句与 editorial 最佳匹配句相似度低于阈值
 *    或检测到反义词对（动作反转）→ replaced_event
 * 6. 顺序违规检测：显式因果连接词连接的事件对在 editorial 中颠倒 → order_violation
 * 7. 判定：缺失 >= 阈值 或 替换 >= 阈值 或 顺序违规 > 0 → preserved=false
 *
 * rejectionType 优先级：unverifiable > missing_event > replaced_event > order_violation
 *
 * 阻断必须有至少一个可解释的事件级证据，不基于词项计数。
 */
export function checkEditorialStoryPreservation(
  input: StoryPreservationGateInput,
): StoryPreservationGateReport {
  const mode = input.mode ?? "event_ledger";
  if (mode === "event_ledger") {
    return checkEditorialStoryPreservationViaLedger(input);
  }
  return checkEditorialStoryPreservationViaSimilarity(input);
}

/**
 * Phase 3C：event_ledger 模式 — 使用结构化事件账本比对。
 *
 * 调用 extractEvents 抽取 raw/editorial 事件，再调用 compareEventLedgers 比对。
 * 结果映射回 StoryPreservationGateReport 以保持 trace 兼容。
 */
function checkEditorialStoryPreservationViaLedger(
  input: StoryPreservationGateInput,
): StoryPreservationGateReport {
  const {
    rawText,
    editorialText,
    knownEntities,
    entityCoverage = "characters_only",
    missingEventThreshold = 2,
    replacedEventThreshold = 1,
    replacedSimilarityThreshold = 0.25,
    lowSimilarityReplacementThreshold = 3,
    aliasToCanonical,
  } = input;

  // 边界 1：空文本 → 不可验证，拒绝
  if (!rawText || !editorialText || rawText.trim().length === 0 || editorialText.trim().length === 0) {
    return {
      preserved: false,
      unverifiable: true,
      rejectionType: "unverifiable",
      missingEvents: [],
      replacedEvents: [],
      orderViolations: [],
      rawEventAnchors: [],
      rawEventAnchorFindings: [],
      entityCoverage,
      reason: "raw 或 editorial 为空，无法验证故事骨架保持",
      mode: "event_ledger",
      causalBreaks: [],
      stateChangeLosses: [],
      advisorySimilarities: [],
      editorialEventCount: 0,
    };
  }

  // 1. 抽取 raw 事件（P0 第五轮 P1 修复：传入 aliasToCanonical 规范化别名）
  const rawExtraction = extractEvents(rawText, knownEntities, { entityCoverage, aliasToCanonical });

  // 边界 2：无实体或无事件 → 不可验证
  const entityTable = (knownEntities ?? [])
    .filter((e) => e && e.trim().length >= 2)
    .filter((e, i, arr) => arr.indexOf(e) === i);
  if (entityTable.length === 0) {
    return {
      preserved: false,
      unverifiable: true,
      rejectionType: "unverifiable",
      missingEvents: [],
      replacedEvents: [],
      orderViolations: [],
      rawEventAnchors: [],
      rawEventAnchorFindings: [],
      entityCoverage,
      reason: "无法从输入提取任何实体（knownEntities 为空）。event_ledger 模式不靠频率提取伪实体",
      mode: "event_ledger",
      causalBreaks: [],
      stateChangeLosses: [],
      advisorySimilarities: [],
      editorialEventCount: 0,
    };
  }

  // 2. 抽取 editorial 事件（P0 第五轮 P1 修复：传入 aliasToCanonical 规范化别名）
  const editorialExtraction = extractEvents(editorialText, knownEntities, { entityCoverage, aliasToCanonical });

  // 3. 比对事件账本
  const comparison: LedgerComparison = compareEventLedgers({
    rawEvents: rawExtraction.events,
    editorialEvents: editorialExtraction.events,
    rawCausalChains: rawExtraction.causalChains,
    editorialCausalChains: editorialExtraction.causalChains,
    knownEntities: entityTable,
    entityCoverage,
    rawText,
    editorialText,
    missingEventThreshold,
    replacedEventThreshold,
    replacedSimilarityThreshold,
    lowSimilarityReplacementThreshold,
    // P0 第六轮 P1 修复：传入 aliasToCanonical，让缺失事件检测做 canonical+alias 联合搜索，
    // 避免单事件 alias 改写累计 missing=1、多事件触发 missing_event 误阻断。
    aliasToCanonical,
  });

  // 4. 映射 LedgerComparison → StoryPreservationGateReport
  // 缺失事件：转换形状
  const missingEvents: MissingEvent[] = comparison.missingEvents.map((e) => ({
    anchor: e.rawSentence,
    rawSpan: e.rawSpan,
    missingEntities: e.missingEntities,
    reason: e.reason,
  }));

  // 替换事件：转换形状
  const replacedEvents: ReplacedEvent[] = comparison.replacedEvents.map((e) => ({
    subject: e.subject,
    rawSentence: e.rawSentence,
    rawSpan: e.rawSpan,
    editorialSentence: e.editorialSentence,
    editorialSpan: e.editorialSpan,
    similarity: e.similarity,
    reversal: e.reversal,
    antonymPair: e.antonymPair,
    reason: e.reason,
  }));

  // 因果顺序违规：直接复用（形状兼容）
  const orderViolations: OrderViolation[] = comparison.orderViolations.map((e) => ({
    rawBeforeClause: e.rawBeforeClause,
    rawAfterClause: e.rawAfterClause,
    editorialBeforeClause: e.editorialBeforeClause,
    editorialAfterClause: e.editorialAfterClause,
    connector: e.connector,
    reason: e.reason,
  }));

  // 事件锚点 findings：从 rawExtraction.events 转换
  const rawEventAnchorFindings: EventAnchorFinding[] = rawExtraction.events.map((e) => ({
    subject: e.subject,
    action: e.action,
    eventType: e.eventType,
    objectOrResult: e.object,
    sentence: e.sentence,
    span: e.evidenceSpan,
    extractable: e.extractable,
    skipReason: e.skipReason,
  }));

  // rejectionType 映射：event_ledger 的新类型折叠到旧类型
  // - causal_break → order_violation（都是因果结构问题）
  // - state_change_loss → replaced_event（都是事件替换问题）
  let mappedRejectionType: StoryPreservationGateReport["rejectionType"] = null;
  if (!comparison.preserved) {
    if (comparison.unverifiable) {
      mappedRejectionType = "unverifiable";
    } else if (comparison.rejectionType === "missing_event") {
      mappedRejectionType = "missing_event";
    } else if (comparison.rejectionType === "replaced_event" || comparison.rejectionType === "state_change_loss") {
      mappedRejectionType = "replaced_event";
    } else if (comparison.rejectionType === "order_violation" || comparison.rejectionType === "causal_break") {
      mappedRejectionType = "order_violation";
    }
  }

  return {
    preserved: comparison.preserved,
    unverifiable: comparison.unverifiable,
    rejectionType: mappedRejectionType,
    missingEvents,
    replacedEvents,
    orderViolations,
    rawEventAnchors: rawExtraction.events
      .filter((e) => e.extractable)
      .map((e) => e.sentence),
    rawEventAnchorFindings,
    entityCoverage,
    reason: comparison.reason,
    mode: "event_ledger",
    causalBreaks: comparison.causalBreaks,
    stateChangeLosses: comparison.stateChangeLosses,
    advisorySimilarities: comparison.advisorySimilarities,
    editorialEventCount: comparison.editorialEventCount,
  };
}

/**
 * similarity 模式 — 旧相似度门（R2.4，eval 回放/B4 诊断用）。
 *
 * 保留原始逻辑不变，供 eval 回放使用。生产 agentic_style 流默认走 event_ledger 模式。
 */
function checkEditorialStoryPreservationViaSimilarity(
  input: StoryPreservationGateInput,
): StoryPreservationGateReport {
  const {
    rawText,
    editorialText,
    knownEntities,
    entityCoverage = "characters_only",
    missingEventThreshold = 2,
  replacedEventThreshold = 1,
  // P0-2 修复（Phase 1 整改）：恢复严格阈值。
  // 原先放宽到 0.15 / 8 会放过"保留人名但整章换剧情"（如交玉玺/离京/烧密信 → 喝茶/游园/看灯会）。
  // 恢复到 0.25 / 3：相似度低于 0.25 的替换即视为 replaced_event；累计 3 处即阻断。
  replacedSimilarityThreshold = 0.25,
  lowSimilarityReplacementThreshold = 3,
  } = input;

  // 边界 1：空文本 → 不可验证，拒绝
  if (!rawText || !editorialText || rawText.trim().length === 0 || editorialText.trim().length === 0) {
    return {
      preserved: false,
      unverifiable: true,
      rejectionType: "unverifiable",
      missingEvents: [],
      replacedEvents: [],
      orderViolations: [],
      rawEventAnchors: [],
      rawEventAnchorFindings: [],
      entityCoverage,
      reason: "raw 或 editorial 为空，无法验证故事骨架保持",
    };
  }

  // 1. 构建实体表（仅 knownEntities，不靠频率提取）
  const entityTable = (knownEntities ?? [])
    .filter((e) => e && e.trim().length >= 2)
    .filter((e, i, arr) => arr.indexOf(e) === i); // 去重，保留顺序

  // 边界 2：无实体 → 不可验证，拒绝（保守，不静默放行，不靠频率提取）
  if (entityTable.length === 0) {
    return {
      preserved: false,
      unverifiable: true,
      rejectionType: "unverifiable",
      missingEvents: [],
      replacedEvents: [],
      orderViolations: [],
      rawEventAnchors: [],
      rawEventAnchorFindings: [],
      entityCoverage,
      reason: "无法从输入提取任何实体（knownEntities 为空）。R2.2 不再靠频率提取伪实体，需调用方提供可靠实体（角色/地点/组织/物品）",
    };
  }

  // 2. 提取 raw 事件锚点句
  const rawSentences = splitSentences(rawText);
  const rawAnchors = extractEventAnchors(rawSentences, entityTable);

  // 边界 3：raw 有实体但无锚点句 → 不可验证
  if (rawAnchors.length === 0) {
    return {
      preserved: false,
      unverifiable: true,
      rejectionType: "unverifiable",
      missingEvents: [],
      replacedEvents: [],
      orderViolations: [],
      rawEventAnchors: [],
      rawEventAnchorFindings: [],
      entityCoverage,
      reason: "raw 有实体但无法提取事件锚点句（实体未出现在完整句子中）",
    };
  }

  // 3. 提取 editorial 事件锚点句（用于替换事件比较）
  const editorialSentences = splitSentences(editorialText);
  const editorialAnchors = extractEventAnchors(editorialSentences, entityTable);

  // ── 缺失事件检测 ──────────────────────────────────────────────────────
  // raw 锚点句的实体在 editorial 全文不存在 → missing_event
  // 这是事件级证据：实体的完全缺失意味着该事件的核心要素被删除。
  //
  // R2.3：只对 extractable=true 的锚点检测缺失。
  // 纯判断句/单独名字/不可绑定代词句不作为缺失事件证据（它们本就不是关键事件）。
  const missingEvents: MissingEvent[] = [];
  for (const anchor of rawAnchors) {
    if (!anchor.extractable) continue; // R2.3：跳过不可提取的句子
    const missingEntities = anchor.entities.filter((e) => !editorialText.includes(e));
    if (missingEntities.length > 0) {
      missingEvents.push({
        anchor: anchor.sentence,
        rawSpan: anchor.span,
        missingEntities,
        reason: `事件锚点句的实体在 editorial 全文缺失：${missingEntities.join("、")}`,
      });
    }
  }

  // ── 替换事件检测 ──────────────────────────────────────────────────────
  // R2.3 升级：优先匹配 subject + action + objectOrResult，避免无关句自动配对。
  //
  // 匹配规则：
  // 1. 只对 extractable=true 的 raw/editorial 锚点做比较
  // 2. 综合评分 = 结构匹配（subject/action/object）+ 字符相似度
  // 3. 若 action 和 object 都不匹配 → 无关事件，跳过（不触发替换）
  // 4. 动作反转（反义词对）优先级最高，即使结构不匹配也判为替换
  //
  // DEMO-3-R2.4：state_description 锚点不参与动作反转检测。
  // - state_description 句子无动作动词，反义词对不适用
  // - state_description 仍可参与低相似度替换检测（措辞大幅变化仍是替换证据）
  // - 只有 eventType="action" 或 "state_change" 的 raw 锚点才运行 detectActionReversal
  //
  // 不基于词项计数：只比较事件结构（同实体的句子相似度/动作反转）。
  // 新增章末压力/环境细节/局部动作/对话不触发（它们不与 raw 事件锚点比较）。
  const replacedEvents: ReplacedEvent[] = [];
  for (const rawAnchor of rawAnchors) {
    if (!rawAnchor.extractable) continue; // R2.3：跳过不可提取的句子

    // 只检查实体在 editorial 仍存在的锚点（缺失的在 missingEvents 处理）
    const retainedEntities = rawAnchor.entities.filter((e) => editorialText.includes(e));
    if (retainedEntities.length === 0) continue;

    // 找 editorial 中含相同实体的可提取锚点，按结构+相似度综合评分
    let bestMatch: {
      anchor: EventAnchor;
      similarity: number;
      structureScore: number;
      totalScore: number;
      subjectMatch: boolean;
      actionMatch: boolean;
      objectMatch: boolean;
    } | null = null;
    for (const edAnchor of editorialAnchors) {
      if (!edAnchor.extractable) continue; // R2.3：跳过不可提取的 editorial 句
      const hasCommonEntity = rawAnchor.entities.some((e) => edAnchor.entities.includes(e));
      if (!hasCommonEntity) continue;

      // R2.3 结构匹配
      const subjectMatch = rawAnchor.subject !== "" && rawAnchor.subject === edAnchor.subject;
      const actionMatch =
        rawAnchor.action !== "" &&
        (rawAnchor.action === edAnchor.action ||
          rawAnchor.action.includes(edAnchor.action) ||
          edAnchor.action.includes(rawAnchor.action));
      const objectMatch =
        rawAnchor.objectOrResult !== "" &&
        edAnchor.objectOrResult !== "" &&
        (rawAnchor.objectOrResult === edAnchor.objectOrResult ||
          rawAnchor.objectOrResult.includes(edAnchor.objectOrResult) ||
          edAnchor.objectOrResult.includes(rawAnchor.objectOrResult));

      const sim = jaccardSimilarity(
        rawAnchor.significantChars,
        edAnchor.significantChars,
      );
      // 结构权重 0.7（subject 0.3 + action 0.2 + object 0.2），字符相似度权重 0.3
      const structureScore =
        (subjectMatch ? 0.3 : 0) + (actionMatch ? 0.2 : 0) + (objectMatch ? 0.2 : 0);
      const totalScore = structureScore + sim * 0.3;

      if (bestMatch === null || totalScore > bestMatch.totalScore) {
        bestMatch = {
          anchor: edAnchor,
          similarity: sim,
          structureScore,
          totalScore,
          subjectMatch,
          actionMatch,
          objectMatch,
        };
      }
    }

    if (bestMatch === null) continue;

    // DEMO-3-R2.4：state_description 锚点不参与动作反转检测。
    // - rawAnchor.eventType === "state_description"：无动作，reversal 始终 false
    // - rawAnchor.eventType === "action" 或 "state_change"：运行 detectActionReversal
    //   （state_change 也可能被反转，如"出现"→"消失"）
    const canReverse =
      rawAnchor.eventType === "action" || rawAnchor.eventType === "state_change";
    const reversal = canReverse
      ? detectActionReversal(rawAnchor.sentence, bestMatch.anchor.sentence)
      : { reversed: false, pair: null as readonly [string, string] | null };

    // R2.3：action 和 object 都不匹配 → 无关事件，跳过（不触发替换）
    // 即使 subject 相同（如同一角色的两个无关动作），也不配对为替换事件。
    // 动作反转例外：若检测到反义词对，即使结构不匹配也判为替换。
    if (!bestMatch.actionMatch && !bestMatch.objectMatch && !reversal.reversed) {
      // 无关事件：subject 可能相同但 action/object 完全不同
      continue;
    }

    // 相似度低于阈值 且 不共享关键双字片段 → 替换事件
    // 或 动作反转（反义词对）→ 替换事件
    //
    // 同义改写豁免：即使 Jaccard 字符集相似度低，若两句共享至少 1 个 2 字非停用片段
    // （如药老/火候/异火/丹药），说明是同一事件的不同措辞，不判为替换。
    // 动作反转（反义词对）优先级最高，即使共享双字片段也判为替换。
    const lowSimilarity = bestMatch.similarity < replacedSimilarityThreshold;
    const sharesBigram = hasSharedSignificantBigram(
      rawAnchor.sentence,
      bestMatch.anchor.sentence,
      entityTable,
    );
    const isReplaced = reversal.reversed || (lowSimilarity && !sharesBigram);

    if (isReplaced) {
      replacedEvents.push({
        subject: rawAnchor.subject,
        rawSentence: rawAnchor.sentence,
        rawSpan: rawAnchor.span,
        editorialSentence: bestMatch.anchor.sentence,
        editorialSpan: bestMatch.anchor.span,
        similarity: bestMatch.similarity,
        reversal: reversal.reversed,
        antonymPair: reversal.pair,
        reason: reversal.reversed
          ? `动作反转：raw 句含 '${reversal.pair![0]}'，editorial 句含 '${reversal.pair![1]}'（主体 '${rawAnchor.subject}' 的事件被反转）`
          : `事件结构替换：raw 句与 editorial 最佳匹配句相似度 ${bestMatch.similarity.toFixed(3)} < ${replacedSimilarityThreshold}，且不共享关键双字片段（主体 '${rawAnchor.subject}' 的事件被改写）`,
      });
    }
  }

  // ── 顺序违规检测（显式因果链）──────────────────────────────────────────
  const orderViolations = detectOrderViolations(rawText, editorialText, entityTable);

  // ── 判定 ──────────────────────────────────────────────────────────────
  // 区分两类替换事件：
  // - 动作反转（reversal=true）：反义词对是事件级硬证据，单个即阻断
  // - 低相似度替换（reversal=false）：可能是同义改写，需达到系统性数量才阻断
  //
  // 设计理由（用户要求）：
  // - "不得因一个普通新增词或新增细节直接拒绝整章"
  // - "阻断必须有至少一个可解释的事件级证据"
  // - 动作反转 = 可解释的事件级证据（1 个即阻断）
  // - 低相似度 = 系统性信号（多个才阻断，避免误杀同义改写）
  const reversalEvents = replacedEvents.filter((e) => e.reversal);
  const lowSimilarityEvents = replacedEvents.filter((e) => !e.reversal);
  const reversalCountFail = reversalEvents.length >= replacedEventThreshold;
  const lowSimCountFail = lowSimilarityEvents.length >= lowSimilarityReplacementThreshold;
  const replacedCountFail = reversalCountFail || lowSimCountFail;

  const missingCountFail = missingEvents.length >= missingEventThreshold;
  const orderFail = orderViolations.length > 0;

  const preserved = !missingCountFail && !replacedCountFail && !orderFail;

  // rejectionType 优先级：missing_event > replaced_event > order_violation
  let rejectionType: StoryPreservationGateReport["rejectionType"] = null;
  if (!preserved) {
    if (missingCountFail) {
      rejectionType = "missing_event";
    } else if (replacedCountFail) {
      rejectionType = "replaced_event";
    } else if (orderFail) {
      rejectionType = "order_violation";
    }
  }

  const reasons: string[] = [];
  if (missingCountFail) {
    reasons.push(
      `缺失 ${missingEvents.length} 个事件锚点（阈值 ${missingEventThreshold}）`,
    );
  }
  if (reversalCountFail) {
    reasons.push(
      `检测到 ${reversalEvents.length} 个动作反转（反义词对，阈值 ${replacedEventThreshold}）`,
    );
  }
  if (lowSimCountFail) {
    reasons.push(
      `检测到 ${lowSimilarityEvents.length} 个低相似度替换（阈值 ${lowSimilarityReplacementThreshold}，系统性漂移）`,
    );
  }
  if (orderFail) {
    reasons.push(`检测到 ${orderViolations.length} 个因果顺序违规（显式因果连接词）`);
  }

  const reason = preserved
    ? `故事骨架保持：${rawAnchors.filter((a) => a.extractable).length} 个可提取事件锚点中缺失 ${missingEvents.length}，替换 ${replacedEvents.length} 个，顺序违规 ${orderViolations.length} 个（实体覆盖：${entityCoverage}）`
    : `故事骨架漂移：${reasons.join("；")}（实体覆盖：${entityCoverage}）`;

  // R2.3：rawEventAnchorFindings 含全部锚点（extractable=true/false），
  // 用于 trace 审计事件提取决策。rawEventAnchors 只含可提取事件句（向后兼容）。
  // DEMO-3-R2.4：findings 含 eventType，取代旧的 action="描述" 伪装。
  const rawEventAnchorFindings: EventAnchorFinding[] = rawAnchors.map((a) => ({
    subject: a.subject,
    action: a.action,
    eventType: a.eventType,
    objectOrResult: a.objectOrResult,
    sentence: a.sentence,
    span: a.span,
    extractable: a.extractable,
    skipReason: a.skipReason,
  }));

  return {
    preserved,
    unverifiable: false,
    rejectionType,
    missingEvents,
    replacedEvents,
    orderViolations,
    rawEventAnchors: rawAnchors.filter((a) => a.extractable).map((a) => a.sentence),
    rawEventAnchorFindings,
    entityCoverage,
    reason,
  };
}
