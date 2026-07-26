/**
 * NovelOS Narrative Verifier Suite（OPT-9.6）
 *
 * 组合验证器：对 agent draft 做事实/连续性硬验证 + 语言风险软扫描。
 *
 * 设计原则（M1 纵向切片）：
 * - 复用 V2 已有的 FactContinuityGuard（6 类硬阻断）+ LanguageRiskLibrary（软风险），
 *   不重写检测逻辑。
 * - 新增 3 类 M1 专项验证：人物知识边界 / canon-promise 冲突 / 关键事件遗漏。
 * - 硬验证（fatal/hard）→ 触发 patch candidate；软意见（review/info）只记录不阻断。
 * - 所有 finding 带 span + sourceRef + confidence，可追溯。
 *
 * 首批硬验证（计划要求）：
 * 1. 人物、实体、地点、能力事实 → FactContinuityGuard.entity_checker
 * 2. 时间顺序与空间连续性 → FactContinuityGuard.scene_continuity
 * 3. 人物知识边界 → narrative-knowledge-boundary-checker
 * 4. canon/promise 明确冲突 → narrative-canon-promise-checker
 * 5. 关键 ChapterIntent 事件遗漏 → narrative-intent-omission-checker
 * 6. 截断、格式损坏、大段重复 → FactContinuityGuard.format_hard_gate / duplicate_scan
 *
 * 文学性意见（LanguageRiskLibrary）只能作为软证据，不得自动阻断或强迫改写。
 *
 * 文件拆分历史（simplicity-gate 800 行限制）：
 * - 2026-07-26：将类型、意图覆盖辅助函数、4 类子检查器拆分到独立模块，
 *   主文件只保留 NarrativeVerifierSuite 类（verify 编排 + diagnosticToFinding）和工厂。
 */

import type { Diagnostic, DiagnosticSeverity, TextSpan } from "../../v2/core/types.js";
import { createFactContinuityGuard, type FactContinuityGuard } from "../../v2/core/fact-continuity-guard.js";
import { createLanguageRiskLibrary, type LanguageRiskLibrary } from "../../v2/core/language-risk-library.js";

// 公共 API：从拆分模块 re-export 类型与常量，保持下游 import 路径稳定
export type {
  VerificationFailureType,
  VerificationCertainty,
  VerificationCoverageStatus,
  VerificationFinding,
  NarrativeVerifierInput,
  NarrativeVerifierReport,
} from "./narrative-verifier-types.js";
export { GUARD_SOURCE_TO_FAILURE_TYPE } from "./narrative-verifier-types.js";

// 内部子检查器
import type {
  VerificationFailureType,
  VerificationCertainty,
  VerificationCoverageStatus,
  VerificationFinding,
  NarrativeVerifierInput,
  NarrativeVerifierReport,
} from "./narrative-verifier-types.js";
import { GUARD_SOURCE_TO_FAILURE_TYPE } from "./narrative-verifier-types.js";
import { checkKnowledgeBoundary } from "./narrative-knowledge-boundary-checker.js";
import { checkCanonPromiseConflicts } from "./narrative-canon-promise-checker.js";
import { checkIntentOmission } from "./narrative-intent-omission-checker.js";
import {
  checkFactOmission,
  checkTimelineConsistency,
  checkLocationContinuity,
  checkFactContradiction,
} from "./narrative-fact-checkers.js";
import { checkInviolableFactsConflict } from "./narrative-inviolable-facts-conflict-checker.js";

// ============================================================================
// NarrativeVerifierSuite
// ============================================================================

export class NarrativeVerifierSuite {
  private readonly factGuard: FactContinuityGuard;
  private readonly languageRisk: LanguageRiskLibrary;

  constructor() {
    this.factGuard = createFactContinuityGuard();
    this.languageRisk = createLanguageRiskLibrary();
  }

  /**
   * 执行全部验证。
   *
   * 流程：
   * 1. FactContinuityGuard 硬检查（6 类）
   * 2. LanguageRiskLibrary 软扫描（语言风险）
   * 3. 本地知识边界检查
   * 4. 本地 canon/promise 冲突检查
   * 5. 本地关键事件遗漏检查
   * 6. 合并 → 区分 hard/soft
   */
  verify(input: NarrativeVerifierInput): NarrativeVerifierReport {
    const charNames =
      input.knownCharacterNames ?? input.context.characterStates.map((c) => c.name);

    // 1. FactContinuityGuard 硬检查
    const factReport = this.factGuard.check({
      text: input.text,
      context: input.context,
      knownCharacterNames: charNames,
    });

    // 2. LanguageRiskLibrary 软扫描
    const langDiagnostics = this.languageRisk.scanAsDiagnostics(input.text, charNames);

    // 3-5. 本地验证器（拆分到独立模块）
    const knowledgeFindings = checkKnowledgeBoundary(input, charNames);
    const canonFindings = checkCanonPromiseConflicts(input);
    const omissionFindings = checkIntentOmission(input);
    // M1.1 新增验证器
    const factOmissionFindings = checkFactOmission(input);
    const timelineFindings = checkTimelineConsistency(input);
    const locationFindings = checkLocationContinuity(input);
    const contradictionFindings = checkFactContradiction(input);
    // inc-4 新增：作者输入自相矛盾检测
    const authorConflictFindings = checkInviolableFactsConflict(input);

    // 6. 合并
    const guardFindings = factReport.allDiagnostics.map((d) =>
      this.diagnosticToFinding(d, "fact_continuity_guard"),
    );
    const langFindings = langDiagnostics.map((d) =>
      this.diagnosticToFinding(d, "language_risk_library", "language_risk"),
    );

    const findings: VerificationFinding[] = [
      ...guardFindings,
      ...langFindings,
      ...knowledgeFindings,
      ...canonFindings,
      ...omissionFindings,
      ...factOmissionFindings,
      ...timelineFindings,
      ...locationFindings,
      ...contradictionFindings,
      ...authorConflictFindings,
    ];

    // inc-1 修复：hardFindings 必须同时满足 severity ∈ {hard, fatal} AND
    // certainty ∈ {deterministic, corroborated}。
    // 这防止 heuristic finding 误标 hard 时进入 hardFindings 触发整章阻断。
    // 当前所有 hard finding 都已显式设置 deterministic/corroborated，
    // 此过滤是安全网，防止未来回归。
    const hardFindings = findings.filter(
      (f) =>
        (f.severity === "hard" || f.severity === "fatal") &&
        (f.certainty === "deterministic" || f.certainty === "corroborated"),
    );
    const softFindings = findings.filter(
      (f) => f.severity === "review" || f.severity === "info",
    );

    return {
      findings,
      hardFindings,
      softFindings,
      hasHardFailure: hardFindings.length > 0,
    };
  }

  // ── 内部：Diagnostic → VerificationFinding ────────────────────────────

  private diagnosticToFinding(
    diagnostic: Diagnostic,
    source: string,
    overrideFailureType?: VerificationFailureType,
  ): VerificationFinding {
    const span: TextSpan = diagnostic.span ?? {
      start: 0,
      end: 0,
      excerpt: "",
    };
    const failureType =
      overrideFailureType ?? GUARD_SOURCE_TO_FAILURE_TYPE[diagnostic.source] ?? "language_risk";
    const isHard = diagnostic.severity === "hard" || diagnostic.severity === "fatal";

    // P0-2：根据 failureType 推断默认确定性等级
    // - format_error / duplicate_pollution / entity_hallucination：deterministic（事实硬伤）
    // - scene_continuity / skeleton_inconsistency / event_progression：corroborated（结构化事实冲突）
    // - language_risk：heuristic（启发式软意见）
    const deterministicTypes: ReadonlySet<string> = new Set([
      "format_error",
      "duplicate_pollution",
      "entity_hallucination",
    ]);
    const corroboratedTypes: ReadonlySet<string> = new Set([
      "scene_continuity",
      "skeleton_inconsistency",
      "event_progression",
    ]);
    const certainty: VerificationCertainty = deterministicTypes.has(failureType)
      ? "deterministic"
      : corroboratedTypes.has(failureType)
      ? "corroborated"
      : "heuristic";
    const coverageStatus: VerificationCoverageStatus = isHard ? "missing" : "uncertain";

    return {
      id: diagnostic.id,
      source,
      failureType,
      severity: diagnostic.severity,
      span,
      conflictFact: diagnostic.evidence,
      sourceRef: diagnostic.id,
      confidence: isHard ? 1.0 : 0.5,
      allowedRepairRange: span,
      description: diagnostic.evidence,
      certainty,
      coverageStatus,
    };
  }
}

// ============================================================================
// 工厂
// ============================================================================

export function createNarrativeVerifierSuite(): NarrativeVerifierSuite {
  return new NarrativeVerifierSuite();
}
