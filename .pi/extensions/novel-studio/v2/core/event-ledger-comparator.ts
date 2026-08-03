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
 *
 * 实现拆分（simplicity-gate）：
 * - 替换匹配主循环 → event-replacement-matcher.ts:matchAndDetectReplacements
 * - 因果顺序/断裂/状态变化丢失/editorial-only 检测 → event-ledger-helpers.ts
 * - 类型定义 → event-ledger-types.ts
 */

import { getExtractableEvents } from "./event-extractor.js";
import type {
  LedgerComparatorInput,
  LedgerComparison,
  MissingEventEvidence,
  ReplacedEventEvidence,
  AdvisorySimilarityEvidence,
} from "./event-ledger-types.js";
// Re-export 类型保持向后兼容（editorial-story-preservation-gate.ts 等仍从本模块导入类型）
export type {
  LedgerComparison,
  MissingEventEvidence,
  ReplacedEventEvidence,
  OrderViolationEvidence,
  CausalBreakEvidence,
  StateChangeLossEvidence,
  AdvisorySimilarityEvidence,
  LedgerComparatorInput,
} from "./event-ledger-types.js";
import {
  detectOrderViolationsFromChains,
  detectCausalBreaks,
  detectStateChangeLosses,
  detectEditorialOnlyEvents,
  buildComparisonResult,
} from "./event-ledger-helpers.js";
import { matchAndDetectReplacements } from "./event-replacement-matcher.js";

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
 *    （委托 matchAndDetectReplacements，含主客体反转/关键事件缺失/客体替换等子检测）
 * 5. editorial-only 事件反向检测：editorial 引入 raw 中不存在的故事线 → replaced_event
 * 6. 因果顺序检测：raw 因果对 (A→B) 在 editorial 中变为 (B→A) → order_violation
 * 7. 因果断裂检测：raw 事件的 causalParentIds 指向的事件在 editorial 中缺失 → causal_break
 * 8. 状态变化丢失检测：raw state_change 事件的 afterState 在 editorial 中无对应 → state_change_loss
 * 9. 判定：缺失 >= 阈值 或 替换 >= 阈值 或 顺序违规 > 0 或 因果断裂 > 0 → preserved=false
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

  // ── 替换事件检测（委托 matchAndDetectReplacements）─────────────────────
  // 含主客体反转预检测、结构+相似度+位置综合评分匹配、关键事件缺失、动作→非动作、
  // 主客体反转/否定反转/未遂反转、客体替换/删除/未知替换、动作反转、关键动作替换、
  // 低相似度替换或 advisory 降级等全部子检测。
  const { replacedEvents, advisorySimilarities, matchedEditorialIds } = matchAndDetectReplacements({
    rawExtractable,
    editorialExtractable,
    knownEntities,
    knownEntitySet,
    editorialText,
    replacedSimilarityThreshold,
  });

  // ── P0-2 修复：editorial-only 事件反向检测 ─────────────────────────────
  // editorial 中含已知实体、且实体/subject 完全不在 rawText 的事件
  // = editorial 引入 raw 中不存在的故事线，属于故事骨架替换，单个即阻断。
  //
  // 设计理由（用户审计 P0-2 阻断）：
  // - forward pass 只能匹配 raw→editorial 的对应事件，无法识别 editorial 凭空新增的故事线
  // - 当 editorial 删除 raw 主线后新增"洪摩逆推/灵脉水道"等故事线时，
  //   missingEvents 可能因实体在 editorial 全文存在而不触发，导致 replacedEvents 为空
  // - editorial-only 事件含已知实体（如"洪摩"）但实体作为动作主体在 raw 全文不存在，
  //   说明 editorial 引入了 raw 没有的故事骨架 → 故事漂移硬证据
  //
  // 防误报（由 detectEditorialOnlyEvents 内部处理）：
  // - 只检测含已知实体的事件（防止无关描述性事件误报）
  // - 实体/subject 必须完全不在 rawText 中（防止 raw 简略提及、editorial 展开的情况）
  // - 跳过 state_description（描述性事件不是动作替换）
  // - 跳过已被 forward pass 匹配的 editorial 事件
  replacedEvents.push(
    ...detectEditorialOnlyEvents(
      editorialExtractable,
      matchedEditorialIds,
      rawExtractable,
      knownEntitySet,
      rawText,
    ),
  );

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
  return buildComparisonResult({
    missingEvents,
    replacedEvents,
    orderViolations,
    causalBreaks,
    stateChangeLosses,
    advisorySimilarities,
    rawEventCount: rawExtractable.length,
    editorialEventCount: editorialExtractable.length,
    entityCoverage,
    missingEventThreshold,
    replacedEventThreshold,
    lowSimilarityReplacementThreshold,
  });
}
