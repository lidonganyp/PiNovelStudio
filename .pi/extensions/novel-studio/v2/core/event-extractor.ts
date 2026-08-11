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


// 常量已抽取到 event-extractor-vocabulary.ts（simplicity-gate 拆分）
// ANTONYM_PAIRS / CRITICAL_ACTIONS / SYNONYM_ACTION_FAMILIES 仅由 event-comparator-helpers.ts 使用
import {
  ACTION_VERBS,
  STATE_CHANGE_VERBS,
  PRONOUNS,
  CAUSAL_CONNECTORS,
  LOCATION_PREPOSITIONS,
  SENTENCE_END_PUNCT,
  CLAUSE_PUNCT,
  SUBCLAUSE_CONJUNCTIONS,
  NEGATION_MARKERS,
  NEAR_MISS_MARKERS,
} from "./event-extractor-vocabulary.js";

// 句子/子句切分已抽取到 event-sentence-splitter.ts（simplicity-gate 拆分）
import {
  splitSentences,
  splitSubClauses,
} from "./event-sentence-splitter.js";

// ============================================================================
// 常量（真实长程 replay 误杀治理，见 docs/memory-layer-baseline.md）
// ============================================================================

/**
 * 方式状语式否定排除表。
 *
 * "毫无预兆地""不约而同地"等是方式状语（描述动作发生的形态），其中的"无/不"
 * 不是对动作本身的否定。若把这类状语里的否定标记误判为动作否定，会在
 * editorial 同义改写时触发"否定语义反转"误杀（critical，单条即阻断）。
 *
 * 例："毫无预兆地突然从青衣少女的肚子里传了出来" —— "毫无预兆地"是方式状语，
 * 动作"传了出来"并未被否定，不应设 negated=true。
 */
const NON_NEGATING_ADVERBIALS: readonly string[] = [
  "毫无预兆地",
  "毫无预兆",
  "毫无声息地",
  "毫无声息",
  "不约而同地",
  "不由自主地",
  "毫不犹豫地",
  "毫不犹豫",
  "毫不迟疑地",
  "毫不留情地",
  "毫无保留地",
  "不动声色地",
  "不假思索地",
  "不慌不忙地",
  "不紧不慢地",
];

/**
 * 含"不/无"但并非否定动作的前缀动词。
 *
 * 真实长程样本："不顾林婉儿的阻拦" —— "不顾"=不理会/不吝惜，后接宾语（阻拦），
 * 不是对后接动作"上前"的否定。若把"不"当否定标记，会误判 raw 否定 → editorial
 * 肯定（"否定语义反转"误杀，单个即阻断）。
 *
 * 否定判断前先剔除这些前缀，避免"不"被误判为动作否定标记。
 */
const NON_NEGATING_PREFIX_VERBS: readonly string[] = [
  "不顾",
  "不管",
  "不问",
  "不论",
  "不由自主",
  "不约而同",
  "不假思索",
];

/**
 * 动作动词在复合名词中的误匹配排除表。
 *
 * 单字动作动词（如"杀"）作为子串出现在名词复合词中（如"杀戮""杀手""杀意"）
 * 时，不是动作动词。若不排除，会把纯描述句（如"不再只有冰冷的杀戮与算计"）
 * 误判为动作事件，进而触发 editorial-only 关键事件误杀（critical，单条即阻断）。
 *
 * key 为动作动词，value 为该动词作为子串出现的复合名词列表。
 */
const ACTION_VERB_NON_ACTION_COMPOUNDS: ReadonlyMap<string, readonly string[]> = new Map([
  ["杀", ["杀戮", "杀手", "杀意", "杀气", "杀机", "杀招", "杀伐"]],
  // "吃"在"吃力"（形容词）、"吃惊"（形容词）等复合词中不是动作动词。
  // 真实长程样本："显得有些吃力"被误抽出动作"吃"，进而触发"否定语义反转"误杀。
  ["吃", ["吃力", "吃惊", "吃紧", "吃苦", "吃亏", "吃香"]],
]);

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
export function normalizeEntity(
  entity: string,
  aliasToCanonical: Map<string, string> | undefined,
): string {
  if (!aliasToCanonical || entity === "") return entity;
  const canonical = aliasToCanonical.get(entity);
  return canonical && canonical.length > 0 ? canonical : entity;
}

// ============================================================================
// 子句切分（句子切分已抽取到 event-sentence-splitter.ts）
// ============================================================================

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

// splitSubClauses 已抽取到 event-sentence-splitter.ts（simplicity-gate 拆分）

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
  let actionVerb = findEarliestVerb(sentence, ACTION_VERBS);
  // 真实长程误杀治理："杀"等单字动作动词作为子串出现在名词复合词中
  // （"杀戮""杀手""杀意"等）时不是动作动词，跳过以免把纯描述句误判为动作事件。
  if (actionVerb) {
    const compounds = ACTION_VERB_NON_ACTION_COMPOUNDS.get(actionVerb);
    if (compounds && compounds.some((c) => sentence.includes(c))) {
      actionVerb = undefined;
    }
  }

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
  // 真实长程误杀治理：先剔除方式状语（"毫无预兆地"等），再判断动作否定。
  // 方式状语里的"无/不"不是对动作的否定，剔除后可避免"否定语义反转"误杀。
  const beforeVerbWithoutAdverbials = NON_NEGATING_ADVERBIALS.reduce(
    (acc, adv) => acc.split(adv).join(""),
    beforeVerb,
  );
  // 再剔除"不顾"类前缀动词（"不顾阻拦"里的"不"不是对动作的否定）。
  const beforeVerbWithoutNegVerbPrefixes = NON_NEGATING_PREFIX_VERBS.reduce(
    (acc, prefix) => acc.split(prefix).join(""),
    beforeVerbWithoutAdverbials,
  );
  const negated = NEGATION_MARKERS.some((m) => beforeVerbWithoutNegVerbPrefixes.includes(m));
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
  // 比对辅助函数已抽取到 event-comparator-helpers.ts（simplicity-gate 拆分）
  // 以下 re-export 保持向后兼容：event-ledger-comparator.ts 等仍可从 event-extractor 导入
  // ============================================================================
  export {
  detectActionReversal,
  isCriticalAction,
  detectCriticalReplacement,
  areActionsSynonymous,
  detectSubjectObjectSwap,
  detectNegationReversal,
  detectNearMissReversal,
  jaccardSimilarity,
  hasSharedSignificantBigram,
  shareSignificantContent,
  getExtractableEvents,
  extractSignificantChars,
  extractSignificantBigrams,
} from "./event-comparator-helpers.js";
