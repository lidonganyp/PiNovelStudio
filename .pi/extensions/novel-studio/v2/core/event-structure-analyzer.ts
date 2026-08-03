/**
 * EventStructureAnalyzer — 事件结构分析（从 event-extractor.ts 抽取，simplicity-gate 拆分）
 *
 * 纯函数模块：分析句子的事件结构，识别主体、动作、对象/结果、地点、状态变化。
 *
 * 依赖：
 * - 词汇常量从 event-extractor-vocabulary.ts 导入
 * - EventType 类型 + normalizeEntity 函数从 event-extractor.ts 导入
 *
 * 不含状态，所有函数纯确定性。
 */

import {
  ACTION_VERBS,
  STATE_CHANGE_VERBS,
  PRONOUNS,
  LOCATION_PREPOSITIONS,
  NEGATION_MARKERS,
  NEAR_MISS_MARKERS,
} from "./event-extractor-vocabulary.js";
import { type EventType, normalizeEntity } from "./event-extractor.js";

// ============================================================================
// 类型定义
// ============================================================================

export interface EventStructureAnalysis {
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

// ============================================================================
// 动词查找
// ============================================================================

/**
 * 在句子中查找最早出现的动词（按句中位置，非数组顺序）。
 *
 * P0-1 第三轮：修复 "防御攻击" 抽取为 "攻击"（数组靠前）而非 "防御"（句中靠前）的 bug。
 * "防御攻击" 语义是"防御对方的攻击"，主动作是"防御"，"攻击"是对象。
 */
export function findEarliestVerb(
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

// ============================================================================
// 事件结构分析
// ============================================================================

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
export function analyzeEventStructure(
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

// ============================================================================
// 地点提取 / 状态推断
// ============================================================================

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
