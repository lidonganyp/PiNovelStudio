/**
 * EventLedgerHelpers — 事件账本比对辅助函数（从 event-ledger-comparator.ts 抽取，simplicity-gate 拆分）
 *
 * 纯函数模块：因果顺序违规检测、因果断裂检测、状态变化丢失检测。
 *
 * 依赖：
 * - 类型从 event-ledger-types.ts 导入
 * - 比对辅助函数从 event-comparator-helpers.ts 导入
 * - ExtractedEvent / ExtractedCausalChain 类型从 event-extractor.ts 导入
 *
 * 不含状态，所有函数纯确定性。
 */

import type {
  OrderViolationEvidence,
  CausalBreakEvidence,
  StateChangeLossEvidence,
  MissingEventEvidence,
  ReplacedEventEvidence,
  AdvisorySimilarityEvidence,
  LedgerComparison,
} from "./event-ledger-types.js";
import {
  areActionsSynonymous,
  hasSharedSignificantBigram,
  isCriticalAction,
  shareSignificantContent,
} from "./event-comparator-helpers.js";
import type { ExtractedEvent, ExtractedCausalChain } from "./event-extractor.js";
import { STATE_CHANGE_SYNONYM_FAMILIES } from "./event-extractor-vocabulary.js";

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
export function detectOrderViolationsFromChains(
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
export function detectCausalBreaks(
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
export function detectStateChangeLosses(
  rawExtractable: ExtractedEvent[],
  editorialExtractable: ExtractedEvent[],
  editorialText: string,
): StateChangeLossEvidence[] {
  const losses: StateChangeLossEvidence[] = [];

  for (const rawEvent of rawExtractable) {
    if (rawEvent.eventType !== "state_change") continue;
    if (!rawEvent.afterState) continue;
    // "几乎/差点/险些" only describes an unrealized transition. It must not
    // become a hard preservation obligation when editorial wording omits it.
    if (rawEvent.nearMiss || rawEvent.negated) continue;

    // 状态变化按“主体 + 状态语义”匹配，而不是要求 afterState 动词逐字出现。
    // 风格优化允许“出现→浮现”“得到→获得”等自然改写；逐字 includes 会把
    // 合规改写误判为状态丢失。保留全文精确词回退，兼容旧版抽取无法绑定主体的文本。
    const matchingEditorialState = editorialExtractable.some((editorialEvent) => {
      if (editorialEvent.eventType !== "state_change") return false;
      if (rawEvent.subject && editorialEvent.subject && rawEvent.subject !== editorialEvent.subject) return false;
      if (!areStateChangesEquivalent(rawEvent.afterState, editorialEvent.afterState)) return false;
      const rawResult = rawEvent.result && rawEvent.result !== rawEvent.afterState ? rawEvent.result : "";
      const editorialResult = editorialEvent.result && editorialEvent.result !== editorialEvent.afterState
        ? editorialEvent.result
        : "";
      if (!rawResult || rawResult.length < 2 || !editorialResult) return true;
      return rawResult === editorialResult
        || rawResult.includes(editorialResult)
        || editorialResult.includes(rawResult);
    });
    const afterStateInEditorial = matchingEditorialState || editorialText.includes(rawEvent.afterState);

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

/** 两个状态动词是否表达同一类状态变化。 */
export function areStateChangesEquivalent(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  return STATE_CHANGE_SYNONYM_FAMILIES.some((family) =>
    family.includes(left) && family.includes(right),
  );
}

// ============================================================================
// editorial-only 事件反向检测（P0-2 修复）
// ============================================================================

/**
 * 检测 editorial-only 事件：editorial 中含已知实体、且实体/subject 完全不在 rawText 的事件。
 *
 * = editorial 引入 raw 中不存在的故事线，属于故事骨架替换，单个即阻断。
 *
 * 设计理由（用户审计 P0-2 阻断）：
 * - forward pass 只能匹配 raw→editorial 的对应事件，无法识别 editorial 凭空新增的故事线
 * - 当 editorial 删除 raw 主线后新增"洪摩逆推/灵脉水道"等故事线时，
 *   missingEvents 可能因实体在 editorial 全文存在而不触发，导致 replacedEvents 为空
 * - editorial-only 事件含已知实体（如"洪摩"）但实体作为动作主体在 raw 全文不存在，
 *   说明 editorial 引入了 raw 没有的故事骨架 → 故事漂移硬证据
 *
 * 防误报：
 * - 只检测含已知实体的事件（防止无关描述性事件误报）
 * - 实体/subject 必须完全不在 rawText 中（防止 raw 简略提及、editorial 展开的情况）
 * - 跳过 state_description（描述性事件不是动作替换）
 * - 跳过已被 forward pass 匹配的 editorial 事件
 */
export function detectEditorialOnlyEvents(
  editorialExtractable: ExtractedEvent[],
  matchedEditorialIds: Set<string>,
  rawExtractable: ExtractedEvent[],
  knownEntitySet: Set<string>,
  rawText: string,
): ReplacedEventEvidence[] {
  const editorialOnlyEvents: ReplacedEventEvidence[] = [];
  for (const edEvent of editorialExtractable) {
    if (matchedEditorialIds.has(edEvent.id)) continue; // 已被 forward pass 匹配
    // 跳过 state_description（描述性事件不是动作替换）
    if (edEvent.eventType === "state_description") continue;

    // 只检测含已知主体的事件。对象/地点实体不能单独证明 editorial 引入了
    // 一条新的故事线，否则“在已知地点发生描述”会被误报。
    const hasKnownSubject =
      edEvent.subject !== "" && knownEntitySet.has(edEvent.subject);
    if (!hasKnownSubject) continue;

    // 反向检查不能只依赖“主体是否出现在 raw 文本”。同一批角色完全可以被
    // editorial 凭空追加一条关键事件（例如 raw 已有“叶尘攻击林默”，editorial
    // 再追加“林默杀死叶尘”）。按规范化后的 subject/object/action 统计 raw
    // 等价事件，只有 editorial 等价事件数量超过 raw 数量时才认定为新增。
    const sameEvent = (event: ExtractedEvent): boolean =>
      event.subject === edEvent.subject &&
      event.object === edEvent.object &&
      areActionsSynonymous(event.action, edEvent.action);
    const rawEquivalentCount = rawExtractable.filter(sameEvent).length;
    const editorialEquivalentCount = editorialExtractable.filter(sameEvent).length;
    const isCriticalUnmatchedEvent =
      // An absent action is not evidence that a new action happened. Actual
      // raw -> negated editorial reversals remain checked by the forward pass.
      !edEvent.negated &&
      isCriticalAction(edEvent.action) &&
      editorialEquivalentCount > rawEquivalentCount;
    // A single-character/entity-bound fallback subject can make a normal
    // wording rewrite look like a new critical event (for example, "涌出"
    // becoming "涌出来"). Require the unmatched sentence to have no
    // significant non-entity content in the raw text before treating it as
    // an editorial-only story addition.
    const sharesRawContent = hasSharedSignificantBigram(
      edEvent.sentence,
      rawText,
      [...knownEntitySet],
    );

    // 保留原有新实体检测，但改用事件账本优先，避免 canonical 名与 alias 的
    // 文本差异造成合法 alias 改写误报。
    const rawSubjectInLedger = rawExtractable.some(
      (event) => event.subject === edEvent.subject || event.entities.includes(edEvent.subject),
    );
    const rawSubjectInText = edEvent.subject !== "" && rawText.includes(edEvent.subject);
    const isNewEntityEvent = !rawSubjectInLedger && !rawSubjectInText;
    const shouldReportEditorialOnly =
      (isCriticalUnmatchedEvent && !sharesRawContent) || isNewEntityEvent;
    if (!shouldReportEditorialOnly) continue;

    editorialOnlyEvents.push({
      rawEventId: "",
      editorialEventId: edEvent.id,
      subject: edEvent.subject,
      rawAction: "",
      editorialAction: edEvent.action,
      rawSentence: "",
      rawSpan: { start: 0, end: 0, excerpt: "" },
      editorialSentence: edEvent.sentence,
      editorialSpan: edEvent.evidenceSpan,
      similarity: 0,
      reversal: false,
      antonymPair: null,
      critical: true,
      rawCriticalAction: null,
      reason: isCriticalUnmatchedEvent
        ? `editorial 引入未匹配的关键故事事件：主体 '${edEvent.subject}' 动作 '${edEvent.action}'（raw 等价事件 ${rawEquivalentCount} 条，editorial 等价事件 ${editorialEquivalentCount} 条，单个即阻断）`
        : `editorial 引入 raw 中不存在的故事事件：主体 '${edEvent.subject}' 动作 '${edEvent.action}' 在 raw 全文无对应实体（editorial-only 事件，单个即阻断）`,
    });
  }
  return editorialOnlyEvents;
}

// ============================================================================
// 比对结果判定与组装
// ============================================================================

/**
 * 比对结果判定与组装（从 compareEventLedgers 抽取，simplicity-gate 拆分）。
 *
 * 区分三类替换事件：
 * - 动作反转（reversal=true）：硬证据，单个即阻断
 * - 关键动作替换（critical=true, P0-1 第二轮）：硬证据，单个即阻断
 * - 低相似度替换（reversal=false, critical=false）：系统性信号，多个才阻断
 *
 * rejectionType 优先级：missing_event > replaced_event > order_violation > causal_break > state_change_loss
 */
export function buildComparisonResult(params: {
  missingEvents: MissingEventEvidence[];
  replacedEvents: ReplacedEventEvidence[];
  orderViolations: OrderViolationEvidence[];
  causalBreaks: CausalBreakEvidence[];
  stateChangeLosses: StateChangeLossEvidence[];
  advisorySimilarities: AdvisorySimilarityEvidence[];
  rawEventCount: number;
  editorialEventCount: number;
  entityCoverage: "characters_only" | "full_entities";
  missingEventThreshold: number;
  replacedEventThreshold: number;
  lowSimilarityReplacementThreshold: number;
}): LedgerComparison {
  const {
    missingEvents,
    replacedEvents,
    orderViolations,
    causalBreaks,
    stateChangeLosses,
    advisorySimilarities,
    rawEventCount,
    editorialEventCount,
    entityCoverage,
    missingEventThreshold,
    replacedEventThreshold,
    lowSimilarityReplacementThreshold,
  } = params;

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
    ? `故事骨架保持：raw ${rawEventCount} 个事件 / editorial ${editorialEventCount} 个事件，缺失 ${missingEvents.length}，替换 ${replacedEvents.length}，顺序违规 ${orderViolations.length}，因果断裂 ${causalBreaks.length}，状态变化丢失 ${stateChangeLosses.length}（实体覆盖：${entityCoverage}）`
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
    rawEventCount,
    editorialEventCount,
    entityCoverage,
    reason,
  };
}
