/**
 * NovelOS Narrative Verifier Types（OPT-9.6 拆分自 narrative-verifier-suite.ts）
 *
 * 集中所有 verifier 相关的类型定义和常量映射，供主 suite 与子检查器复用。
 * 拆分目的：满足 simplicity-gate 800 行限制，同时保持公共 API 稳定。
 */

import type { DiagnosticSeverity, TextSpan, CompiledContext } from "../../v2/core/types.js";

// ============================================================================
// 类型定义
// ============================================================================

export type VerificationFailureType =
  | "format_error"
  | "duplicate_pollution"
  | "entity_hallucination"
  | "scene_continuity"
  | "skeleton_inconsistency"
  | "event_progression"
  | "knowledge_boundary"
  | "canon_conflict"
  | "promise_conflict"
  | "intent_omission"
  | "language_risk"
  // M1.1 新增
  | "fact_omission"          // 遗漏 inviolableFacts 中的必需事实
  | "timeline_inconsistency" // 时间回退/跳跃
  | "location_discontinuity" // 空间跳转/位置冲突
  | "fact_contradiction"     // 属性型 canon 事实矛盾（如颜色）
  // inc-2 新增：正向覆盖证据（severity=info，不阻断）
  | "intent_covered"         // 章纲要求已被正文覆盖（natural equivalent 或原句命中）
  // inc-4 新增：作者输入自相矛盾
  | "author_input_conflict"; // inviolableFacts 内部互斥（如"X在场"与"X不在场"同时出现）

/** P0-2：确定性等级 */
export type VerificationCertainty =
  | "deterministic" // 确定性：原句缺失、canon 矛盾、截断、格式损坏
  | "corroborated"  // 多源印证：结构化事实与正文存在确定冲突
  | "heuristic";    // 启发式：单一关键词/词表/相似度命中

/** P0-2：覆盖状态 */
export type VerificationCoverageStatus =
  | "covered"   // 已覆盖（自然等价表达或原句命中）
  | "uncertain" // 不确定（启发式无法判定）
  | "missing";  // 缺失（确定性或结构化证据证明缺失）

export interface VerificationFinding {
  /** 唯一 id */
  id: string;
  /** 来源验证器 */
  source: string;
  /** 失败类型 */
  failureType: VerificationFailureType;
  /** 严重度：hard/fatal → 触发 patch；review/info → 软证据 */
  severity: DiagnosticSeverity;
  /** candidate span（可追溯到正文位置） */
  span: TextSpan;
  /** 冲突事实描述 */
  conflictFact: string;
  /** 证据来源引用（fact id / character id / diag id） */
  sourceRef: string;
  /** 置信度 0-1（M1 启发式：硬验证 1.0，软验证 0.5） */
  confidence: number;
  /** 允许修改范围（span 级，默认等于 span；空范围 start===end 表示诊断 only） */
  allowedRepairRange: TextSpan;
  /** 人类可读描述 */
  description: string;
  /** P0-2：确定性等级 */
  certainty: VerificationCertainty;
  /** P0-2：覆盖状态 */
  coverageStatus: VerificationCoverageStatus;
}

export interface NarrativeVerifierInput {
  /** 候选正文（draft） */
  text: string;
  /** 编译后的上下文 */
  context: CompiledContext;
  /** 本章意图摘要（用于关键事件遗漏检查） */
  chapterIntent: string;
  /** 已知角色名（含 aliases），用于实体幻觉检测 */
  knownCharacterNames?: string[];
  /** M1.1：本章不可违反的必需事实（来自 ChapterIntent.inviolableFacts） */
  inviolableFacts?: string[];
}

export interface NarrativeVerifierReport {
  /** 所有 findings */
  findings: VerificationFinding[];
  /** 硬 findings（severity hard/fatal）→ 触发 patch candidate */
  hardFindings: VerificationFinding[];
  /** 软 findings（severity review/info）→ 只记录 */
  softFindings: VerificationFinding[];
  /** 是否存在硬失败 */
  hasHardFailure: boolean;
}

// ============================================================================
// FactContinuityGuard source → failureType 映射
// ============================================================================

export const GUARD_SOURCE_TO_FAILURE_TYPE: Record<string, VerificationFailureType> = {
  format_hard_gate: "format_error",
  duplicate_scan: "duplicate_pollution",
  entity_checker: "entity_hallucination",
  scene_continuity: "scene_continuity",
  skeleton_consistency: "skeleton_inconsistency",
  event_progression: "event_progression",
};
