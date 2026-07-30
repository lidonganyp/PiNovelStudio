/**
 * EventLedgerComparator — 事件账本比对器（Phase 3B）
 *
 * 比对 raw 与 editorial 的事件账本，检测事件漂移。
 *
 * 比对维度（计划 §3B）：
 * 1. 事件删除（missingEvents）：raw 有但 editorial 无（按 subject+action+object 匹配，非文本相似度）
 * 2. 事件替换（replacedEvents）：subject 相同但 action 改变（如"交玉玺"→"喝茶"）
 * 3. 因果顺序违反（orderViolations）：causalParentIds 指向的事件在 editorial 中出现在当前事件之后
 * 4. 状态变化丢失（stateChangeLoss）：state_change 事件的 afterState 在 editorial 中无对应
 * 5. 因果断裂（causalBreaks）：causalParentIds 指向的事件在 editorial 中缺失
 *
 * 文本相似度降为 advisory（advisorySimilarity），不单独触发阻断。
 *
 * 设计原则（project_memory 约束）：
 * - 阻断必须有至少一个可解释的事件级证据，不基于词项计数
 * - 不得因一个普通新增词或新增细节直接拒绝整章
 * - 动作反转（反义词对）是事件级硬证据，单个即阻断
 * - 低相似度替换需达到系统性数量才阻断（避免误杀同义改写）
 * - '描述' action 不得用于伪装抽取的动作
 * - state_description 不可作为动作反转证据（无动作，反义词对不适用）
 * - 区分 outcome 类型：no_editorial / factguard_block / story_preservation_block
 *
 * 本地确定性，无 LLM 调用。
 */

import type { TextSpan } from "./types.js";
import {
  areActionsSynonymous,
  detectActionReversal,
  detectCriticalReplacement,
  detectNearMissReversal,
  detectNegationReversal,
  detectSubjectObjectSwap,
  extractSignificantChars,
  getExtractableEvents,
  hasSharedSignificantBigram,
  isCriticalAction,
  jaccardSimilarity,
  shareSignificantContent,
  type ExtractedEvent,
  type ExtractedCausalChain,
} from "./event-extractor.js";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 缺失事件：raw 有但 editorial 无。
 */
export interface MissingEventEvidence {
  /** raw 事件 ID */
  rawEventId: string;
  /** raw 事件主体 */
  subject: string;
  /** raw 事件动作 */
  action: string;
  /** raw 事件对象 */
  object: string;
  /** raw 事件句 */
  rawSentence: string;
  /** raw 中的证据 span */
  rawSpan: TextSpan;
  /** 该事件中缺失的实体列表（在 editorial 全文不存在） */
  missingEntities: string[];
  /** 拒绝原因 */
  reason: string;
}

/**
 * 替换事件：subject 相同但 action 改变。
 */
export interface ReplacedEventEvidence {
  /** raw 事件 ID */
  rawEventId: string;
  /** editorial 匹配事件 ID（如有） */
  editorialEventId: string | null;
  /** 事件主体 */
  subject: string;
  /** raw 事件动作 */
  rawAction: string;
  /** editorial 事件动作 */
  editorialAction: string;
  /** raw 事件句 */
  rawSentence: string;
  /** raw 中的证据 span */
  rawSpan: TextSpan;
  /** editorial 匹配事件句 */
  editorialSentence: string;
  /** editorial 中的证据 span */
  editorialSpan: TextSpan;
  /** raw 句与 editorial 句的相似度（0-1） */
  similarity: number;
  /** 是否检测到动作反转（反义词对） */
  reversal: boolean;
  /** 检测到的反义词对（reversal=true 时非 null） */
  antonymPair: readonly [string, string] | null;
  /** 是否为关键动作替换（P0-1 第二轮：单个即阻断） */
  critical: boolean;
  /** 触发关键替换的 raw 动作（critical=true 时非 null） */
  rawCriticalAction: string | null;
  /** 拒绝原因 */
  reason: string;
}

/**
 * 因果顺序违反：raw 的因果对 (A→B) 在 editorial 中变为 (B→A)。
 */
export interface OrderViolationEvidence {
  /** raw 前置事件子句 */
  rawBeforeClause: string;
  /** raw 后置事件子句 */
  rawAfterClause: string;
  /** editorial 前置事件子句 */
  editorialBeforeClause: string;
  /** editorial 后置事件子句 */
  editorialAfterClause: string;
  /** 因果连接词 */
  connector: string;
  /** 拒绝原因 */
  reason: string;
}

/**
 * 因果断裂：causalParentIds 指向的事件在 editorial 中缺失。
 */
export interface CausalBreakEvidence {
  /** raw 事件 ID */
  rawEventId: string;
  /** raw 事件句 */
  rawSentence: string;
  /** 缺失的因果父事件 ID 列表 */
  missingParentEventIds: string[];
  /** 拒绝原因 */
  reason: string;
}

/**
 * 状态变化丢失：state_change 事件的 afterState 在 editorial 中无对应。
 */
export interface StateChangeLossEvidence {
  /** raw 事件 ID */
  rawEventId: string;
  /** raw 事件主体 */
  subject: string;
  /** raw 事件动作（state_change verb） */
  action: string;
  /** raw 事件 afterState */
  afterState: string;
  /** raw 事件句 */
  rawSentence: string;
  /** raw 中的证据 span */
  rawSpan: TextSpan;
  /** 拒绝原因 */
  reason: string;
}

/**
 * Advisory 相似度证据（不阻断，仅诊断）。
 */
export interface AdvisorySimilarityEvidence {
  /** raw 事件 ID */
  rawEventId: string;
  /** editorial 匹配事件 ID */
  editorialEventId: string;
  /** 相似度分数（0-1） */
  similarity: number;
  /** 是否共享关键双字片段 */
  sharesBigram: boolean;
  /** 诊断说明 */
  note: string;
}

/**
 * 事件账本比对结果。
 */
export interface LedgerComparison {
  /** true = 故事骨架保持；false = 漂移或不可验证 */
  preserved: boolean;
  /** true = 输入不可验证（事件无法可靠抽取），保守拒绝 */
  unverifiable: boolean;
  /** 拒绝类型：missing_event / replaced_event / order_violation / causal_break / state_change_loss / unverifiable / null（通过时） */
  rejectionType:
    | "missing_event"
    | "replaced_event"
    | "order_violation"
    | "causal_break"
    | "state_change_loss"
    | "unverifiable"
    | null;
  /** 缺失事件列表 */
  missingEvents: MissingEventEvidence[];
  /** 替换事件列表（基于事件结构比较） */
  replacedEvents: ReplacedEventEvidence[];
  /** 因果顺序违规列表 */
  orderViolations: OrderViolationEvidence[];
  /** 因果断裂列表 */
  causalBreaks: CausalBreakEvidence[];
  /** 状态变化丢失列表 */
  stateChangeLosses: StateChangeLossEvidence[];
  /** Advisory 相似度证据（不阻断） */
  advisorySimilarities: AdvisorySimilarityEvidence[];
  /** raw 可提取事件数 */
  rawEventCount: number;
  /** editorial 可提取事件数 */
  editorialEventCount: number;
  /** 实体覆盖范围标记 */
  entityCoverage: "characters_only" | "full_entities";
  /** 判定原因（用于 trace） */
  reason: string;
}

// ============================================================================
// 比对输入
// ============================================================================

export interface LedgerComparatorInput {
  /** raw 事件列表（来自 extractEvents） */
  rawEvents: ExtractedEvent[];
  /** editorial 事件列表（来自 extractEvents） */
  editorialEvents: ExtractedEvent[];
  /** raw 因果链（来自 extractEvents） */
  rawCausalChains: ExtractedCausalChain[];
  /** editorial 因果链（来自 extractEvents） */
  editorialCausalChains: ExtractedCausalChain[];
  /** 已知实体列表（用于相似度计算和共享检测） */
  knownEntities: string[];
  /** 实体覆盖范围标记 */
  entityCoverage: "characters_only" | "full_entities";
  /** 原始 raw 文本（用于全文实体存在性检查） */
  rawText: string;
  /** 原始 editorial 文本 */
  editorialText: string;
  /**
   * 缺失事件锚点句数量阈值。默认 2。
   */
  missingEventThreshold?: number;
  /**
   * 动作反转事件数量阈值。默认 1（任何动作反转即阻断）。
   */
  replacedEventThreshold?: number;
  /**
   * 替换事件相似度阈值。默认 0.25。
   */
  replacedSimilarityThreshold?: number;
  /**
   * 低相似度替换事件数量阈值。默认 3。
   */
  lowSimilarityReplacementThreshold?: number;
  /**
   * P0 第六轮 P1 修复：别名→规范名映射（alias → canonical character name）。
   *
   * 由 editorial-story-preservation-gate 传入（与 extractEvents 共用同一映射）。
   * 提供时，缺失事件检测会构建反向映射（canonical → aliases），对每个 raw 实体
   * 检查"规范名或其任一别名"是否出现在 editorial 全文——只要任一出现即不算缺失。
   *
   * 修复用户验收反例（第六轮 P1）：
   *   raw 用 "叶尘" / editorial 用 "小尘"（别名）时，旧逻辑拿 canonical 名
   *   "叶尘" 直接搜索未规范化的 editorial 正文，累计 missing=1；两个事件即触发
   *   missing_event 误阻断。
   *
   * 未提供时（旧测试兼容）回退到直接 includes 检查。
   */
  aliasToCanonical?: Map<string, string>;
}

// ============================================================================
// 核心比对函数
// ============================================================================

/**
 * 比对 raw 与 editorial 的事件账本，检测漂移。
 *
 * 算法：
 * 1. 过滤可提取事件（extractable=true）
 * 2. 边界检查：raw 或 editorial 无可提取事件 → unverifiable
 * 3. 缺失事件检测：raw 事件的实体在 editorial 全文不存在 → missing_event
 * 4. 替换事件检测：同 subject 的事件，action 改变 或 低相似度 或 动作反转 → replaced_event
 * 5. 因果顺序检测：raw 因果对 (A→B) 在 editorial 中变为 (B→A) → order_violation
 * 6. 因果断裂检测：raw 事件的 causalParentIds 指向的事件在 editorial 中缺失 → causal_break
 * 7. 状态变化丢失检测：raw state_change 事件的 afterState 在 editorial 中无对应 → state_change_loss
 * 8. 判定：缺失 >= 阈值 或 替换 >= 阈值 或 顺序违规 > 0 或 因果断裂 > 0 → preserved=false
 *
 * rejectionType 优先级：unverifiable > missing_event > replaced_event > order_violation > causal_break > state_change_loss
 */
export function compareEventLedgers(input: LedgerComparatorInput): LedgerComparison {
  const {
    rawEvents,
    editorialEvents,
    rawCausalChains,
    editorialCausalChains,
    knownEntities,
    entityCoverage,
    rawText,
    editorialText,
    missingEventThreshold = 2,
    replacedEventThreshold = 1,
    replacedSimilarityThreshold = 0.25,
    lowSimilarityReplacementThreshold = 3,
    aliasToCanonical,
  } = input;

  // P0 第六轮 P1 修复：构建 canonical → aliases 反向映射，供缺失事件检测使用。
  // raw 事件的 entities 已规范化为 canonical 名；editorial 全文仍是原始文本（可能含别名）。
  // 检查缺失时需搜索 canonical 名及其所有别名，任一出现即不算缺失。
  const canonicalToAliases = new Map<string, string[]>();
  if (aliasToCanonical) {
    for (const [alias, canonical] of aliasToCanonical) {
      if (alias === canonical) continue; // 规范名自身在下方直接检查
      let list = canonicalToAliases.get(canonical);
      if (!list) {
        list = [];
        canonicalToAliases.set(canonical, list);
      }
      list.push(alias);
    }
  }
  /**
   * 检查 canonical 实体（或其任一别名）是否出现在 text 中。
   * 提供 aliasToCanonical 时做规范化联合搜索；未提供时回退到直接 includes。
   */
  const entityPresentInText = (canonical: string, text: string): boolean => {
    if (text.includes(canonical)) return true;
    const aliases = canonicalToAliases.get(canonical);
    if (aliases) {
      for (const alias of aliases) {
        if (text.includes(alias)) return true;
      }
    }
    return false;
  };

  // P0 第五轮：knownEntities 的 Set 视图，用于客体替换检测判断 object 是否为真实实体。
  // 客体替换只针对"关键事件承受者（实体）被替换"的情形，不针对动词补语片段差异
  // （如 "开始松动" vs "松动了" 是风格改写，不是客体替换）。
  const knownEntitySet = new Set(knownEntities);

  // 1. 过滤可提取事件
  const rawExtractable = getExtractableEvents(rawEvents);
  const editorialExtractable = getExtractableEvents(editorialEvents);

  // 边界 1：raw 或 editorial 无可提取事件 → unverifiable
  if (rawExtractable.length === 0 || editorialExtractable.length === 0) {
    return {
      preserved: false,
      unverifiable: true,
      rejectionType: "unverifiable",
      missingEvents: [],
      replacedEvents: [],
      orderViolations: [],
      causalBreaks: [],
      stateChangeLosses: [],
      advisorySimilarities: [],
      rawEventCount: rawExtractable.length,
      editorialEventCount: editorialExtractable.length,
      entityCoverage,
      reason: `无可提取事件（raw=${rawExtractable.length}, editorial=${editorialExtractable.length}），无法验证故事骨架保持`,
    };
  }

  // ── 缺失事件检测 ──────────────────────────────────────────────────────
  // raw 事件的实体在 editorial 全文不存在 → missing_event
  // P0 第六轮 P1 修复：实体存在性检查使用 alias 联合搜索（canonical 名 + 所有别名）。
  // raw 事件的 entities 已规范化为 canonical 名，但 editorial 全文仍是原始文本，
  // 可能使用别名（如 "小尘" 替代 "叶尘"）。直接 includes canonical 名会误判缺失。
  const missingEvents: MissingEventEvidence[] = [];
  for (const rawEvent of rawExtractable) {
    const missingEntities = rawEvent.entities.filter((e) => !entityPresentInText(e, editorialText));
    if (missingEntities.length > 0) {
      missingEvents.push({
        rawEventId: rawEvent.id,
        subject: rawEvent.subject,
        action: rawEvent.action,
        object: rawEvent.object,
        rawSentence: rawEvent.sentence,
        rawSpan: rawEvent.evidenceSpan,
        missingEntities,
        reason: `事件锚点的实体在 editorial 全文缺失：${missingEntities.join("、")}`,
      });
    }
  }

  // ── 替换事件检测 ──────────────────────────────────────────────────────
  // 同 subject 的事件，按 action/object/similarity 综合评分匹配
  const replacedEvents: ReplacedEventEvidence[] = [];
  const advisorySimilarities: AdvisorySimilarityEvidence[] = [];

  // P0-1：跟踪已被匹配的 editorial 事件，避免多个 raw 事件争抢同一 editorial 事件
  // （例如 raw "放行" 不应匹配已被 raw "交出玉玺" 占用的 editorial "看玉玺"，
  //   而应回退到下一个未匹配的 editorial "扣留"，从而触发 antonym 反转检测）
  const matchedEditorialIds = new Set<string>();
  const maxLen = Math.max(rawExtractable.length, editorialExtractable.length, 1);

  for (let rawIdx = 0; rawIdx < rawExtractable.length; rawIdx++) {
    const rawEvent = rawExtractable[rawIdx]!;
    // 只检查实体在 editorial 仍存在的事件（缺失的在 missingEvents 处理）
    // P0-1：如果 rawEvent 有 subject（来自代词绑定或隐式绑定），即使 sentence 中
    // 无已知实体（如 "放行" 子句），也应检查 subject 是否在 editorial 中存在
    //
    // P0-1 第三轮：含关键动作的隐式主体事件（无实体、无 subject）不应被跳过。
    // 用户验收反例："攻击"→"看一眼"、"拿起"→"放下" 等短文本因 retainedEntities=0
    // 且 subjectRetained=false 被跳过，导致 0 个替换事件 → 放过剧情反转。
    // 修复：raw 事件含关键动作时，即使无实体/subject 也进入匹配（按位置匹配 editorial 事件）。
    const retainedEntities = rawEvent.entities.filter((e) => editorialText.includes(e));
    const subjectRetained =
      rawEvent.subject !== "" && editorialText.includes(rawEvent.subject);
    const rawHasCriticalAction = isCriticalAction(rawEvent.action);
    if (retainedEntities.length === 0 && !subjectRetained && !rawHasCriticalAction) continue;

    // P0 第四轮：主客体反转预检测
    // 严格主体匹配会跳过 editorial 中 subject 不同的 event，导致 "叶尘攻击林默"→"林默攻击叶尘"
    // 无法进入 detectSubjectObjectSwap 分支（bestMatch=null → 误判为关键事件删除）。
    // 修复：在主体严格匹配前，扫描 editorial 是否存在 subject=raw.object, object=raw.subject
    // 且同动作（或同义动作）的事件；若存在，直接标记为主客体反转，跳过正常匹配。
    //
    // 防误报：要求 subject !== object（防止 "梦堂→梦堂" 等同体自匹配触发假反转）。
    if (
      rawEvent.subject !== "" &&
      rawEvent.object !== "" &&
      rawEvent.subject !== rawEvent.object
    ) {
      let swapDetected = false;
      for (let edIdx = 0; edIdx < editorialExtractable.length; edIdx++) {
        const edEvent = editorialExtractable[edIdx]!;
        if (matchedEditorialIds.has(edEvent.id)) continue;
        if (edEvent.subject === rawEvent.object && edEvent.object === rawEvent.subject) {
          const sameAction =
            rawEvent.action !== "" &&
            edEvent.action !== "" &&
            (rawEvent.action === edEvent.action ||
              areActionsSynonymous(rawEvent.action, edEvent.action));
          if (sameAction) {
            // P0 第七轮 canary 修复：要求内容共享，防止不可靠的客体提取导致误报。
            // canary 实测：raw "他看到父亲的右腿" 被错误提取 object=李强（李强不在句中），
            // 与 editorial "李强看到李一凡" 触发主客体反转。若两句不共享显著双字片段，
            // 说明提取的 subject/object 不可靠，跳过 swap 检测。
            const swapSharesContent = hasSharedSignificantBigram(
              rawEvent.sentence,
              edEvent.sentence,
              knownEntities,
            );
            if (!swapSharesContent) continue;
            matchedEditorialIds.add(edEvent.id);
            replacedEvents.push({
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
            });
            swapDetected = true;
            break;
          }
        }
      }
      if (swapDetected) continue;
    }

    // 找 editorial 中含相同实体的可提取事件，按结构+相似度+位置综合评分
    let bestMatch: {
      event: ExtractedEvent;
      similarity: number;
      structureScore: number;
      totalScore: number;
      subjectMatch: boolean;
      actionMatch: boolean;
      objectMatch: boolean;
    } | null = null;

    for (let edIdx = 0; edIdx < editorialExtractable.length; edIdx++) {
      const edEvent = editorialExtractable[edIdx]!;
      // P0-1 第三轮：严格主体绑定，防止跨主体事件互相匹配
      //
      // 用户验收反例："交给玉玺并放行"→"看玉玺并留下" 等四组均返回 preserved=true，
      // 根因是匹配器允许仅共享实体、主体不同的事件互相匹配。
      //
      // 新规则（按优先级）：
      // 1. raw 有显式 subject（非空）→ editorial 必须同 subject 才能匹配
      //    （防止 "李天行攻击" 匹配到 "王五防御"）
      // 2. raw 无 subject（隐式/空）但 editorial 有 subject → 跳过（主体不明不应跨绑定）
      // 3. 两者都无 subject（都是隐式 bare verb）→ 按 0.5 概率的位置匹配，
      //    只在位置相同或相邻时匹配（防止 "攻击" 匹配到无关的 "看一眼" 之外的远位事件）
      // 4. 共享实体只有在以上主体规则通过后才作为加分项
      const hasCommonSubject =
        rawEvent.subject !== "" && rawEvent.subject === edEvent.subject;
      const hasCommonEntity = rawEvent.entities.some((e) => edEvent.entities.includes(e));

      if (rawEvent.subject !== "") {
        // raw 有显式主体：要求 editorial 同主体（不允许仅共享实体跨主体匹配）
        if (!hasCommonSubject) continue;
      } else if (edEvent.subject !== "") {
        // raw 无主体但 editorial 有主体：跳过（主体不明，不应绑定到其他主体）
        continue;
      } else {
        // 两者都无主体（隐式 bare verb）：只在位置相同或相邻时匹配
        // 防止短文本中 "攻击" 匹配到远位的无关事件
        const positionDiff = Math.abs(rawIdx - edIdx);
        if (positionDiff > 1) continue;
      }

      // 结构匹配
      const subjectMatch =
        rawEvent.subject !== "" && rawEvent.subject === edEvent.subject;
      // P0 第四轮：空 action 不再被当作通配符
      // 旧逻辑：rawEvent.action !== "" && rawEvent.action.includes(edEvent.action)
      //         当 edEvent.action === "" 时，"".includes("") = true → actionMatch=true（BUG）
      // 新逻辑：要求双方 action 都非空，且使用同义动作族检测
      const actionMatch =
        rawEvent.action !== "" &&
        edEvent.action !== "" &&
        (rawEvent.action === edEvent.action ||
          rawEvent.action.includes(edEvent.action) ||
          edEvent.action.includes(rawEvent.action) ||
          areActionsSynonymous(rawEvent.action, edEvent.action));
      const objectMatch =
        rawEvent.object !== "" &&
        edEvent.object !== "" &&
        (rawEvent.object === edEvent.object ||
          rawEvent.object.includes(edEvent.object) ||
          edEvent.object.includes(rawEvent.object));

      const rawChars = extractSignificantChars(rawEvent.sentence);
      const edChars = extractSignificantChars(edEvent.sentence);
      const sim = jaccardSimilarity(rawChars, edChars);
      const structureScore =
        (subjectMatch ? 0.3 : 0) + (actionMatch ? 0.2 : 0) + (objectMatch ? 0.2 : 0);

      // P0-1：位置加分 —— 当结构+相似度接近时，偏好同位置的 editorial 事件
      // 例如 raw[1]="放行" 应匹配 editorial[1]="扣留"，而非 editorial[0]="看玉玺"
      const positionDiff = Math.abs(rawIdx - edIdx);
      const positionBonus = (1 - positionDiff / maxLen) * 0.05;
      // P0 第四轮：一对一匹配 —— 已被其他 raw 事件占用的 editorial 事件硬跳过
      // 旧逻辑仅 -0.04 降权，导致一条 editorial 事件可重复匹配多条 raw 事件，
      // 使"两次攻击删除其中一次"无法被检测（两次 raw 攻击都匹配到同一条 editorial 攻击）。
      // 新逻辑：硬跳过已匹配的 editorial 事件，确保一对一匹配。
      if (matchedEditorialIds.has(edEvent.id)) continue;

      const totalScore = structureScore + sim * 0.3 + positionBonus;

      if (bestMatch === null || totalScore > bestMatch.totalScore) {
        bestMatch = {
          event: edEvent,
          similarity: sim,
          structureScore,
          totalScore,
          subjectMatch,
          actionMatch,
          objectMatch,
        };
      }
    }

    // P0 第七轮：raw 关键事件不允许被无关事件强行匹配后降级 advisory
    //
    // 用户验收反例（第七轮，生产 gate 实测）：
    //   "叶尘杀死林默" → "叶尘端起茶杯。林默站在一旁" → preserved=true（应阻断）
    //   "叶尘攻击林默" → "叶尘转身离开。林默站在一旁" → preserved=true（应阻断）
    //   "叶尘封印魔物" → "叶尘走出洞穴。魔物仍在洞中" → preserved=true（应阻断）
    //
    // 第六轮 P1-3 修复把"同主体不共享显著内容"统一降为 advisory，导致关键事件被
    // 无关事件替换后通过。第七轮修复（符合用户指令"允许 raw 关键事件不匹配，
    // 对未匹配关键事件直接阻断"）：
    //
    // 当 raw 含关键动作且 bestMatch 不共享 action/object/content 时：
    // 1. 检查关键动作（或同义动作）是否在 editorial 全文出现
    //    - 未出现 → 关键事件被删除/替换为无关事件 → 直接阻断（不消耗 editorial 事件）
    //    - 出现 → 事件可能在其他位置，当前匹配为配对错误 → 降级 advisory（不阻断）
    //      （canary 场景：长文本中 "李强回来" 被配到 "李强看"，但 "回来" 在 editorial
    //       其他位置存在 → 匹配配错，advisory）
    //
    // P0 第七轮 P1 调和：仅当 raw 关键动作作用在"已知实体客体"上时才启用此阻断。
    // 用户验收第六轮反例19："李一凡拿起筷子" → "李一凡吃了"（拿起是关键动作，但筷子
    // 不是已知实体）是同角色不同事件的 canary 正常改写，不应阻断。
    // 用户验收第七轮 P0 反例："叶尘杀死林默"→"叶尘端起茶杯"（林默是已知实体）、
    // "叶尘封印魔物"→"叶尘走出洞穴"（魔物是已知实体）是真正影响故事状态的关键事件
    // 被无关事件替换，必须阻断。
    // 区分维度：raw 关键动作是否有"已知实体客体"——有则事件影响故事实体，缺失即阻断；
    // 无（客体为空或非已知实体）则降为同角色不同事件，交由下方 detectCriticalReplacement
    // 路径处理（bare-verb 关键动作如 "攻击"→"看一眼" 仍由该路径阻断）。
    if (
      bestMatch !== null &&
      isCriticalAction(rawEvent.action) &&
      rawEvent.object !== "" &&
      rawEvent.object.length >= 2 &&
      knownEntitySet.has(rawEvent.object) &&
      !bestMatch.actionMatch &&
      !bestMatch.objectMatch &&
      !hasSharedSignificantBigram(rawEvent.sentence, bestMatch.event.sentence, knownEntities)
    ) {
      // 检查关键动作（或同义动作）是否在 editorial 全文或 editorial 事件 action 中出现
      const actionInEditorialText = editorialText.includes(rawEvent.action);
      const actionInEditorialEvents = editorialExtractable.some(
        (e) => e.action !== "" && areActionsSynonymous(rawEvent.action, e.action),
      );
      if (!actionInEditorialText && !actionInEditorialEvents) {
        // 关键事件缺失：raw 关键动作在 editorial 全文未出现 → 直接阻断
        replacedEvents.push({
          rawEventId: rawEvent.id,
          editorialEventId: bestMatch.event.id,
          subject: rawEvent.subject,
          rawAction: rawEvent.action,
          editorialAction: bestMatch.event.action,
          rawSentence: rawEvent.sentence,
          rawSpan: rawEvent.evidenceSpan,
          editorialSentence: bestMatch.event.sentence,
          editorialSpan: bestMatch.event.evidenceSpan,
          similarity: bestMatch.similarity,
          reversal: false,
          antonymPair: null,
          critical: true,
          rawCriticalAction: rawEvent.action,
          reason: `关键事件缺失：raw 动作 '${rawEvent.action}' 是关键动作，但在 editorial 全文未出现（被删除或替换为无关事件 '${bestMatch.event.action}'），单个关键事件缺失即阻断`,
        });
        continue;
      }
      // 关键动作在 editorial 其他位置存在 → 当前匹配为配对错误 → advisory
      advisorySimilarities.push({
        rawEventId: rawEvent.id,
        editorialEventId: bestMatch.event.id,
        similarity: bestMatch.similarity,
        sharesBigram: false,
        note: `raw 关键动作 '${rawEvent.action}' 在 editorial 其他位置存在，当前匹配 '${bestMatch.event.action}' 为配对错误（advisory，不阻断）`,
      });
      continue;
    }

    if (bestMatch === null) {
      // P0-1 第三轮：raw 事件是关键动作事件但无任何匹配 → 关键事件被删除
      // 这种情况比替换更严重（事件完全消失），应记录为 critical replacement
      // 用户验收反例：短文本中 raw "攻击" 因主体规则未匹配到 editorial 事件时，
      // 若 raw 动作是关键动作，单个删除即阻断
      if (rawEvent.eventType === "action" || rawEvent.eventType === "state_change") {
        const criticalCheck = isCriticalAction(rawEvent.action);
        // P0 第七轮 canary 修复：要求 subject 是已知实体，过滤非角色主体的误提取。
        // canary 实测："任何异能的释放" subject="异能者"（非角色）误触发关键事件删除。
        const subjectIsKnownEntity =
          rawEvent.subject !== "" && knownEntitySet.has(rawEvent.subject);
        if (criticalCheck && subjectIsKnownEntity) {
          replacedEvents.push({
            rawEventId: rawEvent.id,
            editorialEventId: null,
            subject: rawEvent.subject,
            rawAction: rawEvent.action,
            editorialAction: "",
            rawSentence: rawEvent.sentence,
            rawSpan: rawEvent.evidenceSpan,
            editorialSentence: "",
            editorialSpan: { start: 0, end: 0, excerpt: "" },
            similarity: 0,
            reversal: false,
            antonymPair: null,
            critical: true,
            rawCriticalAction: rawEvent.action,
            reason: `关键事件删除：raw 动作 '${rawEvent.action}' 是关键动作，但在 editorial 中无匹配事件（主体 '${rawEvent.subject || "(隐式)"}' 的关键事件被删除），单个关键事件删除即阻断`,
          });
        }
      }
      continue;
    }

    // P0-1：标记该 editorial 事件已被匹配
    matchedEditorialIds.add(bestMatch.event.id);

    // P0 第四轮：动作→非动作检测
    // raw 有明确动作（action/state_change），但 editorial 匹配事件无动作（state_description/action=""）
    // 例如 "攻击" → "沉默不语"：动作被替换为非动作，属于关键事件替换
    if ((rawEvent.eventType === "action" || rawEvent.eventType === "state_change") &&
        rawEvent.action !== "" &&
        (bestMatch.event.eventType === "state_description" || bestMatch.event.action === "")) {
      const criticalCheck = isCriticalAction(rawEvent.action);
      if (criticalCheck) {
        replacedEvents.push({
          rawEventId: rawEvent.id,
          editorialEventId: bestMatch.event.id,
          subject: rawEvent.subject,
          rawAction: rawEvent.action,
          editorialAction: bestMatch.event.action || "(无动作)",
          rawSentence: rawEvent.sentence,
          rawSpan: rawEvent.evidenceSpan,
          editorialSentence: bestMatch.event.sentence,
          editorialSpan: bestMatch.event.evidenceSpan,
          similarity: bestMatch.similarity,
          reversal: false,
          antonymPair: null,
          critical: true,
          rawCriticalAction: rawEvent.action,
          reason: `动作→非动作：raw 关键动作 '${rawEvent.action}' 被 editorial 无动作事件替换（'${bestMatch.event.sentence}'），关键事件被删除或替换为非动作`,
        });
        continue;
      }
    }

    // P0 第四轮：主客体反转检测
    // "叶尘攻击林默" → "林默攻击叶尘"：同一动作，但主体和客体交换（攻击方向反转）
    const subjectObjectSwap = detectSubjectObjectSwap(
      rawEvent.subject, rawEvent.object,
      bestMatch.event.subject, bestMatch.event.object,
    );
    if (subjectObjectSwap) {
      replacedEvents.push({
        rawEventId: rawEvent.id,
        editorialEventId: bestMatch.event.id,
        subject: rawEvent.subject,
        rawAction: rawEvent.action,
        editorialAction: bestMatch.event.action,
        rawSentence: rawEvent.sentence,
        rawSpan: rawEvent.evidenceSpan,
        editorialSentence: bestMatch.event.sentence,
        editorialSpan: bestMatch.event.evidenceSpan,
        similarity: bestMatch.similarity,
        reversal: true,
        antonymPair: null,
        critical: true,
        rawCriticalAction: rawEvent.action,
        reason: `主客体反转：raw '${rawEvent.subject}→${rawEvent.object}' vs editorial '${bestMatch.event.subject}→${bestMatch.event.object}'（动作 '${rawEvent.action}' 的方向被反转，单个即阻断）`,
      });
      continue;
    }

    // P0 第四轮：否定语义反转检测
    // "没有攻击" → "攻击"：否定被移除 = 语义反转
    //
    // P0 第六轮 P1 修复：增加动作一致性校验。
    // 用户验收反例（canary trace）：无关事件被贪心配对后判为"否定语义反转"——
    // 如 raw "没有再说"（action=说, negated=true）与 editorial "肩站在天台上"
    // （action=站, negated=false）配对，旧逻辑只看 negated 标志差异即判反转，
    // 导致硬门禁误阻断。新规则：只有 raw 与 editorial 动作相同或同义时，否定状态
    // 反转才是真正的语义反转；动作不同则是无关事件配对，不得判为否定反转。
    const negationReversal = detectNegationReversal(rawEvent.negated, bestMatch.event.negated);
    const negationActionConsistent =
      rawEvent.action !== "" &&
      bestMatch.event.action !== "" &&
      (rawEvent.action === bestMatch.event.action ||
        areActionsSynonymous(rawEvent.action, bestMatch.event.action));
    // P0 第七轮 canary 修复：增加内容共享校验。
    // canary 实测：raw "牵着走"（action=走, negated）与 editorial "走到"（action=走）
    // 通过动作一致性但实为不同动词短语，仅共享 "走" 字。要求共享显著双字片段。
    const negationSharesContent = hasSharedSignificantBigram(
      rawEvent.sentence,
      bestMatch.event.sentence,
      knownEntities,
    );
    if (negationReversal && negationActionConsistent && negationSharesContent) {
      replacedEvents.push({
        rawEventId: rawEvent.id,
        editorialEventId: bestMatch.event.id,
        subject: rawEvent.subject,
        rawAction: rawEvent.action,
        editorialAction: bestMatch.event.action,
        rawSentence: rawEvent.sentence,
        rawSpan: rawEvent.evidenceSpan,
        editorialSentence: bestMatch.event.sentence,
        editorialSpan: bestMatch.event.evidenceSpan,
        similarity: bestMatch.similarity,
        reversal: true,
        antonymPair: null,
        critical: true,
        rawCriticalAction: rawEvent.action,
        reason: `否定语义反转：raw ${rawEvent.negated ? "否定" : "肯定"} → editorial ${bestMatch.event.negated ? "否定" : "肯定"}（动作 '${rawEvent.action}' 的否定状态被反转，单个即阻断）`,
      });
      continue;
    }

    // P0 第四轮：未遂→实际语义反转检测
    // "差点杀死" → "杀死"：未遂变成实际发生 = 语义反转
    const nearMissReversal = detectNearMissReversal(rawEvent.nearMiss, bestMatch.event.nearMiss);
    if (nearMissReversal && negationSharesContent) {
      replacedEvents.push({
        rawEventId: rawEvent.id,
        editorialEventId: bestMatch.event.id,
        subject: rawEvent.subject,
        rawAction: rawEvent.action,
        editorialAction: bestMatch.event.action,
        rawSentence: rawEvent.sentence,
        rawSpan: rawEvent.evidenceSpan,
        editorialSentence: bestMatch.event.sentence,
        editorialSpan: bestMatch.event.evidenceSpan,
        similarity: bestMatch.similarity,
        reversal: true,
        antonymPair: null,
        critical: true,
        rawCriticalAction: rawEvent.action,
        reason: `未遂语义反转：raw ${rawEvent.nearMiss ? "未遂" : "实际"} → editorial ${bestMatch.event.nearMiss ? "未遂" : "实际"}（动作 '${rawEvent.action}' 的发生状态被反转，单个即阻断）`,
      });
      continue;
    }

    // P0 第五轮：同主体同动作替换客体检测
    // "叶尘攻击林默" → "叶尘攻击王五"：同一主体同一动作，但客体被替换
    // 这改变了关键动作的承受者（谁被攻击/谁收到物品），是故事关键事件替换，单个即阻断
    //
    // 条件：
    // - subjectMatch=true（同一主体）
    // - actionMatch=true（同一动作或同义动作）
    // - objectMatch=false（客体不同）
    // - raw 和 editorial 都有非空客体（≥2字符，过滤代词/单字残留）
    // - 主客体不相同（防止 "梦堂→梦堂" 类自指事件误报）
    // - 双方客体都必须是已知实体（knownEntitySet）
    //   理由：客体替换针对"关键事件承受者（角色/物品实体）被换"的情形，
    //   不针对动词补语片段差异（如 "开始松动" vs "松动了" 是风格改写，非实体替换）。
    //   用户验收反例（"林默"→"王五"、"林默玉玺"→"王五玉玺"）的客体均为已知实体。
    //
    // 注意：alias 级别的客体差异（如 "林默"→"林墨"）在此处也会触发阻断，
    // alias 规范化属于 P1 范畴（unified-entry.ts canonical entity ID），
    // 修复 P1 后同 ID 的 alias 替换会在事件抽取阶段归一化，不再到达此检查。
    if (
      bestMatch.subjectMatch &&
      bestMatch.actionMatch &&
      !bestMatch.objectMatch &&
      rawEvent.object !== "" &&
      rawEvent.object.length >= 2 &&
      bestMatch.event.object !== "" &&
      bestMatch.event.object.length >= 2 &&
      rawEvent.subject !== rawEvent.object &&
      bestMatch.event.subject !== bestMatch.event.object &&
      knownEntitySet.has(rawEvent.object) &&
      knownEntitySet.has(bestMatch.event.object)
    ) {
      replacedEvents.push({
        rawEventId: rawEvent.id,
        editorialEventId: bestMatch.event.id,
        subject: rawEvent.subject,
        rawAction: rawEvent.action,
        editorialAction: bestMatch.event.action,
        rawSentence: rawEvent.sentence,
        rawSpan: rawEvent.evidenceSpan,
        editorialSentence: bestMatch.event.sentence,
        editorialSpan: bestMatch.event.evidenceSpan,
        similarity: bestMatch.similarity,
        reversal: false,
        antonymPair: null,
        critical: true,
        rawCriticalAction: rawEvent.action,
        reason: `客体替换：raw '${rawEvent.subject}→${rawEvent.action}→${rawEvent.object}' vs editorial '${bestMatch.event.subject}→${bestMatch.event.action}→${bestMatch.event.object}'（同一主体同一动作，但客体被替换，关键事件承受者被改变，单个即阻断）`,
      });
      continue;
    }

    // P0 第六轮：客体删除 / 未知实体替换检测
    //
    // 用户验收反例（第六轮，生产 gate 实测）：
    //   - "叶尘攻击林默" → "叶尘攻击。林默站在一旁"（客体被删除）：preserved=true（应阻断）
    //   - "叶尘攻击林默" → "叶尘攻击赵六"（赵六不在实体表）：preserved=true（应阻断）
    //
    // 第五轮的客体替换检测要求"双方客体均非空且都在 knownEntitySet"，遗漏了：
    //   (a) 客体删除：editorial 客体为空（关键事件承受者被删）
    //   (b) 未知实体替换：editorial 客体非空但不在实体表（承受者被换成未知实体）
    //
    // 新规则（结构化客体完整性检测）：
    //   - subjectMatch=true, actionMatch=true, objectMatch=false
    //   - raw.object 是已知实体（关键事件承受者，≥2 字符）
    //   - raw.object 不在 editorial 匹配事件的 entities 中
    //     （确认承受者真的从该事件丢失，而非仅抽取差异/同义改写）
    //   - editorial 客体为空（删除）或非已知实体（未知替换）
    //   → critical 阻断（单个即阻断）
    //
    // 防误报：
    //   - "叶尘攻击林默" → "叶尘向林默发起攻击"：editorial 事件 entities 仍含 "林默"
    //     → 不阻断（承受者仍在事件中，只是抽取器未捕获为 object）
    //   - alias 改写："叶尘攻击林默" → "小尘攻击林默"：subject 经 alias 规范化后匹配，
    //     object 仍为 "林默"（objectMatch=true）→ 不会到达此检查
    if (
      bestMatch.subjectMatch &&
      bestMatch.actionMatch &&
      !bestMatch.objectMatch &&
      rawEvent.object !== "" &&
      rawEvent.object.length >= 2 &&
      rawEvent.subject !== rawEvent.object &&
      knownEntitySet.has(rawEvent.object) &&
      !bestMatch.event.entities.includes(rawEvent.object) &&
      // P0 第七轮 canary 修复：要求内容共享，防止 actionMatch 子串匹配误报。
      // canary 实测：raw "看" 通过 includes() 匹配 editorial "看到"，但两句
      // 不共享显著内容，object 差异来自不同事件而非客体替换。
      hasSharedSignificantBigram(rawEvent.sentence, bestMatch.event.sentence, knownEntities)
    ) {
      const edObj = bestMatch.event.object;
      const edObjEmpty = edObj === "" || edObj.length < 2;
      const edObjUnknown = !edObjEmpty && !knownEntitySet.has(edObj);
      if (edObjEmpty || edObjUnknown) {
        const lossType = edObjEmpty ? "客体删除" : "客体替换为未知实体";
        const edObjDesc = edObjEmpty ? "(空)" : edObj;
        replacedEvents.push({
          rawEventId: rawEvent.id,
          editorialEventId: bestMatch.event.id,
          subject: rawEvent.subject,
          rawAction: rawEvent.action,
          editorialAction: bestMatch.event.action,
          rawSentence: rawEvent.sentence,
          rawSpan: rawEvent.evidenceSpan,
          editorialSentence: bestMatch.event.sentence,
          editorialSpan: bestMatch.event.evidenceSpan,
          similarity: bestMatch.similarity,
          reversal: false,
          antonymPair: null,
          critical: true,
          rawCriticalAction: rawEvent.action,
          reason: `${lossType}：raw '${rawEvent.subject}→${rawEvent.action}→${rawEvent.object}' vs editorial '${bestMatch.event.subject}→${bestMatch.event.action}→${edObjDesc}'（同一主体同一动作，但关键事件承受者 "${rawEvent.object}" 在 editorial 事件中丢失，单个即阻断）`,
        });
        continue;
      }
    }

    // 动作反转检测（state_description 不参与）
    const canReverse =
      rawEvent.eventType === "action" || rawEvent.eventType === "state_change";
    const reversal = canReverse
      ? detectActionReversal(rawEvent.sentence, bestMatch.event.sentence)
      : { reversed: false, pair: null as readonly [string, string] | null };

    // P0-1：当 subject 匹配但 action 和 object 都不匹配时：
    // - 若检测到反义词对 → 记录为替换事件（硬证据，单个即阻断）
    // - 若两事件共享显著内容 且 raw 动作是关键动作 → 记录为关键替换事件（单个即阻断）
    // - 若两事件共享显著内容 → 记录为低相似度替换事件（累计阈值阻断）
    // - 若不共享显著内容 → 记录为 advisory（同角色不同事件，不阻断）
    //
    // P0 第六轮 P1-3 修复（canary 真实误阻断治理，符合用户"主体/客体结构化关系绑定"指令）：
    // 旧逻辑在 !actionMatch && !objectMatch 时，只要 raw 动作是关键动作就判为关键替换，
    // 不检查两事件是否共享显著内容。canary 实测反例：
    //   raw "李强回来" → editorial "李强看"（同角色不同事件，不共享实体名以外的显著片段）
    //   因 "回来" 在 CRITICAL_ACTIONS 中被误判为关键动作替换，单个即阻断。
    //   raw "李一凡拿起筷子" → editorial "李一凡吃" 同理误阻断。
    //
    // 新规则（结构化内容绑定）：
    //   action/object 均不匹配时，内容共享是"同一事件被改写"的必要前提。
    //   不共享显著内容 = 同角色不同事件 → advisory，无论 raw 动作是否"关键"。
    //   真正的关键替换（如 "叶尘攻击林默"→"叶尘防御林默"）因 objectMatch=true 走下方
    //   isReplaced 路径，不受此约束影响。
    //
    // P0 第四轮：state_description 事件（无动作）不触发替换检测。
    // 例如 raw "长乘呢？"（纯描述）因一对一匹配占用了 editorial "长乘未归"（有动作），
    // 不应因 action/object 不同而触发"事件结构替换"。描述性事件没有动作可被"替换"。
    if (
      !bestMatch.actionMatch &&
      !bestMatch.objectMatch &&
      !reversal.reversed &&
      (rawEvent.eventType === "action" || rawEvent.eventType === "state_change")
    ) {
      // P0 第六轮 P1-3：先计算内容共享，作为替换判定的前提
      const hasSubjectMatch = bestMatch.subjectMatch;
      const rawHasObject = rawEvent.object !== "" && rawEvent.object.length >= 2;
      const sharesContentBeyondEntity = hasSharedSignificantBigram(
        rawEvent.sentence,
        bestMatch.event.sentence,
        knownEntities,
      );
      // P0-1 第二轮：检测关键动作替换（如"交出"→"看"，非反义词对但关键动作被替换）
      //
      // P0 第六轮 P1-3 修复（canary 真实误阻断治理）：
      // 当 hasSubjectMatch=true（同角色匹配）时，要求共享显著内容才判关键替换——
      // 防止同角色做不同事的正常改写被误判（canary 反例：raw "李强回来" → editorial "李强看"）。
      // 当 hasSubjectMatch=false（隐式 bare verb，如 "攻击"→"看一眼"）时，匹配按位置进行，
      // 不存在"同角色不同事件"歧义，关键替换不需要共享内容（保留 round3 验收反例行为）。
      const criticalReplacement =
        (!hasSubjectMatch || sharesContentBeyondEntity)
          ? detectCriticalReplacement(rawEvent.action, bestMatch.event.action)
          : { critical: false, rawCriticalAction: null };
      if (criticalReplacement.critical) {
        // P0-1 第二轮：关键动作被替换 → 单个即阻断（不降级为 advisory）
        replacedEvents.push({
          rawEventId: rawEvent.id,
          editorialEventId: bestMatch.event.id,
          subject: rawEvent.subject,
          rawAction: rawEvent.action,
          editorialAction: bestMatch.event.action,
          rawSentence: rawEvent.sentence,
          rawSpan: rawEvent.evidenceSpan,
          editorialSentence: bestMatch.event.sentence,
          editorialSpan: bestMatch.event.evidenceSpan,
          similarity: bestMatch.similarity,
          reversal: false,
          antonymPair: null,
          critical: true,
          rawCriticalAction: criticalReplacement.rawCriticalAction,
          reason: `关键动作替换：raw 动作 '${criticalReplacement.rawCriticalAction}' 是关键动作（改变故事状态），editorial 替换为 '${bestMatch.event.action}'（主体 '${rawEvent.subject}'，对象 '${rawEvent.object}' → '${bestMatch.event.object}'），单个关键事件替换即阻断`,
        });
      } else if (
        (!hasSubjectMatch && rawHasObject) ||
        (hasSubjectMatch && rawHasObject && sharesContentBeyondEntity)
      ) {
        // 低相似度替换（累计阈值阻断）：
        // - bare verb + 有 object → 按位置匹配可靠，记为低相似度替换
        // - 同角色 + 有 object + 共享显著内容 → 同一事件被改写，记为低相似度替换
        replacedEvents.push({
          rawEventId: rawEvent.id,
          editorialEventId: bestMatch.event.id,
          subject: rawEvent.subject,
          rawAction: rawEvent.action,
          editorialAction: bestMatch.event.action,
          rawSentence: rawEvent.sentence,
          rawSpan: rawEvent.evidenceSpan,
          editorialSentence: bestMatch.event.sentence,
          editorialSpan: bestMatch.event.evidenceSpan,
          similarity: bestMatch.similarity,
          reversal: false,
          antonymPair: null,
          critical: false,
          rawCriticalAction: null,
          reason: `事件结构替换：subject '${rawEvent.subject}' 相同但 action/object 完全不同（raw action='${rawEvent.action}' object='${rawEvent.object}' → editorial action='${bestMatch.event.action}' object='${bestMatch.event.object}'），疑似事件被改写`,
        });
      } else {
        // 同角色但不共享显著内容（同角色不同事件）→ advisory，不阻断
        advisorySimilarities.push({
          rawEventId: rawEvent.id,
          editorialEventId: bestMatch.event.id,
          similarity: bestMatch.similarity,
          sharesBigram: sharesContentBeyondEntity,
          note: `subject '${rawEvent.subject}' 相同但不共享显著内容，action/object 完全不同（同角色不同事件，非事件替换）`,
        });
      }
      continue;
    }

    // 替换判定：
    // - 动作反转（反义词对）→ 替换事件（硬证据，单个即阻断）
    // - 关键动作替换（P0-1 第二轮）→ 替换事件（硬证据，单个即阻断）
    // - 低相似度 且 不共享关键双字片段 → 替换事件（需累积到阈值）
    //
    // P0 第四轮：state_description 事件（无动作）不触发替换判定。
    // 描述性事件没有动作可被"替换"，低相似度只记 advisory。
    const rawHasAction = rawEvent.eventType === "action" || rawEvent.eventType === "state_change";
    const lowSimilarity = bestMatch.similarity < replacedSimilarityThreshold;
    const sharesBigram = hasSharedSignificantBigram(
      rawEvent.sentence,
      bestMatch.event.sentence,
      knownEntities,
    );
    // P0-1 第二轮：即使 action/object 有部分匹配，若 raw 动作是关键动作且 editorial 动作显著不同，仍视为替换
    const criticalReplacement = detectCriticalReplacement(
      rawEvent.action,
      bestMatch.event.action,
    );
    // 关键动作替换优先：即使 sharesBigram=true，关键动作被不同动作替换也应阻断
    // P0 第七轮 canary 修复：低相似度替换路径从 isReplaced 移除，全部降为 advisory。
    // canary 实测反例：
    // - similarity=0：raw "以前他看不见" -> editorial "能看到盐粒"（"看" 是 "看到" 子串
    //   导致 actionMatch=true，但两句无任何共享显著字符）
    // - similarity=0.2：raw "冷静地看着目标逼近" -> editorial 另一句（similarity>0
    //   但 !sharesBigram，actionMatch 来自 "看" 子串匹配）
    // 根因：actionMatch 使用 includes() 子串匹配，"看" 匹配 "看到"/"看不见" 等不同
    // 动词。当 !sharesBigram 时，匹配很可能是虚假的，不应作为替换证据。
    // 保留 reversal/critical 路径：它们是结构性证据，不依赖文本相似度。
    // 低相似度替换仍由 !actionMatch && !objectMatch 路径（line 961-984）处理。
    const isReplaced = rawHasAction && (
      reversal.reversed
      || criticalReplacement.critical
    );

    if (isReplaced) {
      replacedEvents.push({
        rawEventId: rawEvent.id,
        editorialEventId: bestMatch.event.id,
        subject: rawEvent.subject,
        rawAction: rawEvent.action,
        editorialAction: bestMatch.event.action,
        rawSentence: rawEvent.sentence,
        rawSpan: rawEvent.evidenceSpan,
        editorialSentence: bestMatch.event.sentence,
        editorialSpan: bestMatch.event.evidenceSpan,
        similarity: bestMatch.similarity,
        reversal: reversal.reversed,
        antonymPair: reversal.pair,
        critical: criticalReplacement.critical,
        rawCriticalAction: criticalReplacement.rawCriticalAction,
        reason: reversal.reversed
          ? `动作反转：raw 句含 '${reversal.pair![0]}'，editorial 句含 '${reversal.pair![1]}'（主体 '${rawEvent.subject}' 的事件被反转）`
          : criticalReplacement.critical
            ? `关键动作替换：raw 动作 '${criticalReplacement.rawCriticalAction}' 是关键动作，editorial 替换为 '${bestMatch.event.action}'（主体 '${rawEvent.subject}'），单个关键事件替换即阻断`
            : `事件结构替换：raw 句与 editorial 最佳匹配句相似度 ${bestMatch.similarity.toFixed(3)} < ${replacedSimilarityThreshold}，且不共享关键双字片段（主体 '${rawEvent.subject}' 的事件被改写）`,
      });
    } else if (lowSimilarity) {
      // 低相似度但共享双字片段 → advisory（可能为同义改写）
      advisorySimilarities.push({
        rawEventId: rawEvent.id,
        editorialEventId: bestMatch.event.id,
        similarity: bestMatch.similarity,
        sharesBigram: true,
        note: `低相似度但共享关键双字片段，可能为同义改写`,
      });
    }
  }

  // ── 因果顺序检测 ──────────────────────────────────────────────────────
  // raw 的因果对 (A→B) 在 editorial 中变为 (B→A)
  const orderViolations = detectOrderViolationsFromChains(
    rawCausalChains,
    editorialCausalChains,
    knownEntities,
  );

  // ── 因果断裂检测 ──────────────────────────────────────────────────────
  // raw 事件的 causalParentIds 指向的事件在 editorial 中缺失
  const causalBreaks = detectCausalBreaks(rawExtractable, editorialExtractable, knownEntities);

  // ── 状态变化丢失检测 ──────────────────────────────────────────────────
  // raw state_change 事件的 afterState 在 editorial 中无对应
  // 注意：使用 editorialText 做全文检查，避免句子切分差异导致的误报
  const stateChangeLosses = detectStateChangeLosses(
    rawExtractable,
    editorialExtractable,
    editorialText,
  );

  // ── 判定 ──────────────────────────────────────────────────────────────
  // 区分三类替换事件：
  // - 动作反转（reversal=true）：硬证据，单个即阻断
  // - 关键动作替换（critical=true, P0-1 第二轮）：硬证据，单个即阻断
  // - 低相似度替换（reversal=false, critical=false）：系统性信号，多个才阻断
  const reversalEvents = replacedEvents.filter((e) => e.reversal);
  const criticalEvents = replacedEvents.filter((e) => e.critical && !e.reversal);
  const lowSimilarityEvents = replacedEvents.filter((e) => !e.reversal && !e.critical);
  const reversalCountFail = reversalEvents.length >= replacedEventThreshold;
  const criticalCountFail = criticalEvents.length >= replacedEventThreshold;
  const lowSimCountFail = lowSimilarityEvents.length >= lowSimilarityReplacementThreshold;
  const replacedCountFail = reversalCountFail || criticalCountFail || lowSimCountFail;

  const missingCountFail = missingEvents.length >= missingEventThreshold;
  const orderFail = orderViolations.length > 0;
  const causalBreakFail = causalBreaks.length > 0;
  // 状态变化丢失：单个即阻断（state_change 是关键事件）
  const stateChangeLossFail = stateChangeLosses.length > 0;

  const preserved =
    !missingCountFail &&
    !replacedCountFail &&
    !orderFail &&
    !causalBreakFail &&
    !stateChangeLossFail;

  // rejectionType 优先级
  let rejectionType: LedgerComparison["rejectionType"] = null;
  if (!preserved) {
    if (missingCountFail) {
      rejectionType = "missing_event";
    } else if (replacedCountFail) {
      rejectionType = "replaced_event";
    } else if (orderFail) {
      rejectionType = "order_violation";
    } else if (causalBreakFail) {
      rejectionType = "causal_break";
    } else if (stateChangeLossFail) {
      rejectionType = "state_change_loss";
    }
  }

  const reasons: string[] = [];
  if (missingCountFail) {
    reasons.push(`缺失 ${missingEvents.length} 个事件锚点（阈值 ${missingEventThreshold}）`);
  }
  if (reversalCountFail) {
    reasons.push(
      `检测到 ${reversalEvents.length} 个动作反转（反义词对，阈值 ${replacedEventThreshold}）`,
    );
  }
  if (criticalCountFail) {
    reasons.push(
      `检测到 ${criticalEvents.length} 个关键动作替换（关键事件被改写，阈值 ${replacedEventThreshold}）`,
    );
  }
  if (lowSimCountFail) {
    reasons.push(
      `检测到 ${lowSimilarityEvents.length} 个低相似度替换（阈值 ${lowSimilarityReplacementThreshold}，系统性漂移）`,
    );
  }
  if (orderFail) {
    reasons.push(`检测到 ${orderViolations.length} 个因果顺序违规`);
  }
  if (causalBreakFail) {
    reasons.push(`检测到 ${causalBreaks.length} 个因果断裂`);
  }
  if (stateChangeLossFail) {
    reasons.push(`检测到 ${stateChangeLosses.length} 个状态变化丢失`);
  }

  const reason = preserved
    ? `故事骨架保持：raw ${rawExtractable.length} 个事件 / editorial ${editorialExtractable.length} 个事件，缺失 ${missingEvents.length}，替换 ${replacedEvents.length}，顺序违规 ${orderViolations.length}，因果断裂 ${causalBreaks.length}，状态变化丢失 ${stateChangeLosses.length}（实体覆盖：${entityCoverage}）`
    : `故事骨架漂移：${reasons.join("；")}（实体覆盖：${entityCoverage}）`;

  return {
    preserved,
    unverifiable: false,
    rejectionType,
    missingEvents,
    replacedEvents,
    orderViolations,
    causalBreaks,
    stateChangeLosses,
    advisorySimilarities,
    rawEventCount: rawExtractable.length,
    editorialEventCount: editorialExtractable.length,
    entityCoverage,
    reason,
  };
}

// ============================================================================
// 因果顺序检测（复用 editorial-story-preservation-gate.ts 逻辑）
// ============================================================================

/**
 * 检测因果顺序违规：raw 的因果对 (A→B) 是否在 editorial 中变为 (B→A)。
 *
 * 算法：
 * 1. 对每个 raw 链 (A→B) 和 editorial 链 (C→D)：
 *    - 若 A 与 D 共享内容 AND B 与 C 共享内容 → 因果颠倒
 * 2. 排除正向匹配（避免同时是正向和反向时误报）
 */
function detectOrderViolationsFromChains(
  rawChains: ExtractedCausalChain[],
  editorialChains: ExtractedCausalChain[],
  entityTable: string[],
): OrderViolationEvidence[] {
  if (rawChains.length === 0 || editorialChains.length === 0) return [];

  const violations: OrderViolationEvidence[] = [];
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
        // 排除正向匹配
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
        if (!aMatchesC || !bMatchesD) {
          violations.push({
            rawBeforeClause: rawChain.beforeClause,
            rawAfterClause: rawChain.afterClause,
            editorialBeforeClause: edChain.beforeClause,
            editorialAfterClause: edChain.afterClause,
            connector: `${rawChain.connector} / ${edChain.connector}`,
            reason: `因果顺序颠倒：raw 中 '${rawChain.beforeClause.slice(0, 20)}…→ ${rawChain.afterClause.slice(0, 20)}…'，但 editorial 中 '${edChain.beforeClause.slice(0, 20)}…→ ${edChain.afterClause.slice(0, 20)}…'（事件对调）`,
          });
          break;
        }
      }
    }
  }
  return violations;
}

// ============================================================================
// 因果断裂检测
// ============================================================================

/**
 * 检测因果断裂：raw 事件的 causalParentIds 指向的事件在 editorial 中缺失。
 *
 * 算法：
 * 1. 对每个有 causalParentIds 的 raw 事件：
 *    - 检查每个 parent event 是否在 editorial 中有对应事件（按 subject+action 匹配）
 *    - 若 parent event 在 editorial 中找不到对应 → causal_break
 *
 * 注意：causal_break 是因果链断裂的证据，但不一定是动作反转。
 * 单个 causal_break 即阻断（因果链是关键事件结构）。
 */
function detectCausalBreaks(
  rawExtractable: ExtractedEvent[],
  editorialExtractable: ExtractedEvent[],
  _entityTable: string[],
): CausalBreakEvidence[] {
  const breaks: CausalBreakEvidence[] = [];

  for (const rawEvent of rawExtractable) {
    if (rawEvent.causalParentIds.length === 0) continue;

    const missingParents: string[] = [];
    for (const parentId of rawEvent.causalParentIds) {
      // 找 raw 中的 parent event
      const parentEvent = rawExtractable.find((e) => e.id === parentId);
      if (!parentEvent) continue; // parent 不在可提取列表中，跳过

      // 在 editorial 中找对应事件（按 subject+action 匹配）
      const editorialMatch = editorialExtractable.find(
        (edEvent) =>
          edEvent.subject === parentEvent.subject &&
          (edEvent.action === parentEvent.action ||
            edEvent.action.includes(parentEvent.action) ||
            parentEvent.action.includes(edEvent.action)),
      );

      if (!editorialMatch) {
        missingParents.push(parentId);
      }
    }

    if (missingParents.length > 0) {
      breaks.push({
        rawEventId: rawEvent.id,
        rawSentence: rawEvent.sentence,
        missingParentEventIds: missingParents,
        reason: `因果父事件在 editorial 中缺失：${missingParents.join(", ")}（主体 '${rawEvent.subject}' 的因果链断裂）`,
      });
    }
  }

  return breaks;
}

// ============================================================================
// 状态变化丢失检测
// ============================================================================

/**
 * 检测状态变化丢失：raw state_change 事件的 afterState 在 editorial 中无对应。
 *
 * Phase 3C 修正：使用 editorialText 全文检查 afterState 是否存在，而非仅检查
 * editorial 事件结构。原因：句子切分差异（如 raw "他感到力量在攀升，壁障出现了裂痕"
 * vs editorial "他感到力量在攀升。壁障，出现了裂痕。"）会导致 subject 绑定不同，
 * 但 afterState（"出现"）仍在 editorial 文本中。只有 afterState 动词完全不在
 * editorial 全文中，才视为状态变化丢失。
 *
 * 算法：
 * 1. 对每个 raw state_change 事件：
 *    - 检查 afterState 动词是否在 editorialText 中出现
 *    - 若完全不在 → state_change_loss（状态变化被删除）
 *    - 若在 editorial 中出现 → 不视为丢失（可能在不同句子结构中保留）
 *
 * 单个 state_change_loss 即阻断（状态变化是关键事件）。
 */
function detectStateChangeLosses(
  rawExtractable: ExtractedEvent[],
  editorialExtractable: ExtractedEvent[],
  editorialText: string,
): StateChangeLossEvidence[] {
  const losses: StateChangeLossEvidence[] = [];

  for (const rawEvent of rawExtractable) {
    if (rawEvent.eventType !== "state_change") continue;
    if (!rawEvent.afterState) continue;

    // 检查 afterState 动词是否在 editorial 全文中出现
    const afterStateInEditorial = editorialText.includes(rawEvent.afterState);

    if (!afterStateInEditorial) {
      // afterState 动词完全不在 editorial 中 → 状态变化丢失
      losses.push({
        rawEventId: rawEvent.id,
        subject: rawEvent.subject,
        action: rawEvent.action,
        afterState: rawEvent.afterState,
        rawSentence: rawEvent.sentence,
        rawSpan: rawEvent.evidenceSpan,
        reason: `主体 '${rawEvent.subject}' 的状态变化（${rawEvent.afterState}）在 editorial 全文中完全缺失`,
      });
    }
    // 若 afterState 在 editorial 中出现，不视为丢失（即使 subject 绑定不同）
  }

  return losses;
}
