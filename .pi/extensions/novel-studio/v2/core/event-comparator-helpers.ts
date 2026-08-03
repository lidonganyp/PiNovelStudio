/**
 * EventComparatorHelpers — 事件比对辅助函数（从 event-extractor.ts 抽取，simplicity-gate 拆分）
 *
 * 纯函数模块：动作反转检测、关键动作替换检测、同义动作族检查、主客体反转检测、
 * 否定/未遂语义反转检测、Jaccard 相似度、共享内容检查、可提取事件过滤。
 *
 * 依赖：
 * - 词汇常量从 event-extractor-vocabulary.ts 导入
 * - ExtractedEvent 类型从 event-extractor.ts 导入（type-only，无运行时循环依赖）
 *
 * 不含状态，所有函数纯确定性。
 */

import {
  STOP_CHARS,
  ANTONYM_PAIRS,
  CRITICAL_ACTIONS,
  SYNONYM_ACTION_FAMILIES,
} from "./event-extractor-vocabulary.js";
import type { ExtractedEvent } from "./event-extractor.js";
import type { ReplacedEventEvidence } from "./event-ledger-types.js";

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
// 动作反转 / 关键动作替换检测
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

// ============================================================================
// 主客体反转 / 否定 / 未遂检测
// ============================================================================

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
 * P0 第四轮：主客体反转预检测（forward scan）。
 *
 * 在主体严格匹配前，扫描 editorial 是否存在 subject=raw.object, object=raw.subject
 * 且同动作（或同义动作）的事件。若存在，直接标记为主客体反转，跳过正常匹配。
 *
 * 用途：严格主体匹配会跳过 editorial 中 subject 不同的 event，导致
 *   "叶尘攻击林默"→"林默攻击叶尘" 无法进入 detectSubjectObjectSwap 分支
 *   （bestMatch=null → 误判为关键事件删除）。本函数在匹配前预检测反转。
 *
 * 防误报：
 * - 要求 raw.subject !== raw.object（防止 "梦堂→梦堂" 等同体自匹配触发假反转）
 * - 要求内容共享（hasSharedSignificantBigram），防止不可靠的客体提取导致误报。
 *   canary 实测：raw "他看到父亲的右腿" 被错误提取 object=李强（李强不在句中），
 *   与 editorial "李强看到李一凡" 触发主客体反转。若两句不共享显著双字片段，
 *   说明提取的 subject/object 不可靠，跳过 swap 检测。
 *
 * @returns detected=true 时 evidence/matchedEditorialId 非空，调用方应 add + push + continue
 */
export function findSubjectObjectSwapPreMatch(
  rawEvent: ExtractedEvent,
  editorialExtractable: ExtractedEvent[],
  matchedEditorialIds: Set<string>,
  knownEntities: string[],
): {
  detected: boolean;
  evidence: ReplacedEventEvidence | null;
  matchedEditorialId: string | null;
} {
  if (
    rawEvent.subject === "" ||
    rawEvent.object === "" ||
    rawEvent.subject === rawEvent.object
  ) {
    return { detected: false, evidence: null, matchedEditorialId: null };
  }
  for (const edEvent of editorialExtractable) {
    if (matchedEditorialIds.has(edEvent.id)) continue;
    if (edEvent.subject !== rawEvent.object || edEvent.object !== rawEvent.subject) continue;
    const sameAction =
      rawEvent.action !== "" &&
      edEvent.action !== "" &&
      (rawEvent.action === edEvent.action ||
        areActionsSynonymous(rawEvent.action, edEvent.action));
    if (!sameAction) continue;
    const swapSharesContent = hasSharedSignificantBigram(
      rawEvent.sentence,
      edEvent.sentence,
      knownEntities,
    );
    if (!swapSharesContent) continue;
    const evidence: ReplacedEventEvidence = {
      rawEventId: rawEvent.id,
      editorialEventId: edEvent.id,
      subject: rawEvent.subject,
      rawAction: rawEvent.action,
      editorialAction: edEvent.action,
      rawSentence: rawEvent.sentence,
      rawSpan: rawEvent.evidenceSpan,
      editorialSentence: edEvent.sentence,
      editorialSpan: edEvent.evidenceSpan,
      similarity: 0,
      reversal: true,
      antonymPair: null,
      critical: true,
      rawCriticalAction: rawEvent.action,
      reason: `主客体反转：raw '${rawEvent.subject}→${rawEvent.object}' vs editorial '${edEvent.subject}→${edEvent.object}'（动作 '${rawEvent.action}' 的方向被反转，单个即阻断）`,
    };
    return { detected: true, evidence, matchedEditorialId: edEvent.id };
  }
  return { detected: false, evidence: null, matchedEditorialId: null };
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

// ============================================================================
// 相似度 / 共享内容检查
// ============================================================================

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

// ============================================================================
// 事件过滤
// ============================================================================

/**
 * 获取事件的可提取子集（extractable=true）。
 * 用于 Phase 3B 比对器只比较可提取事件。
 */
export function getExtractableEvents(events: ExtractedEvent[]): ExtractedEvent[] {
  return events.filter((e) => e.extractable);
}
