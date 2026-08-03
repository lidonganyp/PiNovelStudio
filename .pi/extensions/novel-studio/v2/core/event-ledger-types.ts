/**
 * EventLedgerTypes — 事件账本比对类型定义（从 event-ledger-comparator.ts 抽取，simplicity-gate 拆分）
 *
 * 纯类型模块：缺失事件、替换事件、因果顺序违规、因果断裂、状态变化丢失、
 * Advisory 相似度证据、比对结果、比对输入的接口定义。
 *
 * 不含逻辑，只导出类型。
 */

import type { TextSpan } from "./types.js";
import type { ExtractedEvent, ExtractedCausalChain } from "./event-extractor.js";

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
