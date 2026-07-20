/**
 * Legacy Language Risk Adapter（Phase 2，计划 §Phase 2）
 *
 * 包装 legacy novel-studio 的真实 AntiAIDetector（含 resource_negative_is_shortcut、
 * negative_definition_chain 及其误报过滤、中文叙事自然感 scanner 等），转换为 V2
 * Diagnostic[]，每条带 span。
 *
 * 取代 legacy-diagnostics-adapter.ts 中的简化 stub createAntiAiDetectorProvider。
 * 退出条件：V2 调用真实资产，简化 stub 不再承担生产职责。
 *
 * 设计原则（Phase 2 要求）：
 * - 检测结果必须带 span（从 legacy positions 转 TextSpan）
 * - 软风险不得 hard block：语言风险最高 review，绝不 fatal/hard
 * - 不得复制简化词表替代真实实现：直接调用 legacy AntiAIDetector
 * - style_conflict 孤例降为 info（交 Stage 8 兜底），structural_ai_residue 为 review
 */

import { createAntiAIDetector, classifyPatternResidueKind } from "../../craft/anti-ai-detector.js";
import type {
  AnalysisResult,
  DetectionResult,
} from "../../craft/anti-ai-detector.js";
import {
  createChineseNarrativeNaturalnessScanner,
  type ChineseNarrativeNaturalnessScanResult,
  type ChineseNarrativeNaturalnessFinding,
} from "../../craft/chinese-narrative-naturalness-scanner.js";
import {
  scanFlatNarration,
  type FlatNarrationScanResult,
  type FlatNarrationIssue,
} from "../../craft/flat-narration-scanner.js";
import type {
  Diagnostic,
  DiagnosticSeverity,
  TextSpan,
} from "../core/types.js";
import type {
  DiagnosticProvider,
  DiagnosticInput,
} from "../core/diagnostic-suite.js";

// ============================================================================
// legacy DetectionResult → V2 Diagnostic 转换
// ============================================================================

/**
 * 从 legacy position 提取 span。
 * legacy positions 是字符偏移；match 文本从 position 开始，长度由 pattern 决定。
 * 由于 DetectionResult 不直接返回 match 文本，我们从 position 取一个窗口并截到句末标点。
 */
function positionToSpan(text: string, position: number, maxLen = 40): TextSpan {
  const end = Math.min(position + maxLen, text.length);
  // 截到第一个句末标点
  let actualEnd = end;
  const window = text.slice(position, end);
  const punctMatch = window.match(/[。！？\n]/);
  if (punctMatch && punctMatch.index !== undefined) {
    actualEnd = position + punctMatch.index + 1;
  }
  return {
    start: position,
    end: actualEnd,
    excerpt: text.slice(position, actualEnd),
  };
}

/**
 * legacy severity（数值，0-1+）→ V2 DiagnosticSeverity。
 * 语言风险永不 hard block：最高 review。
 */
function mapSeverity(
  legacySeverity: number,
  residueKind: "style_conflict" | "structural_ai_residue"
): DiagnosticSeverity {
  // style_conflict 孤例降为 info（交整章 density 兜底）
  if (residueKind === "style_conflict") return "info";
  // structural_ai_residue：高 severity 为 review，低为 info
  if (legacySeverity >= 0.7) return "review";
  return "info";
}

/**
 * 把 legacy AnalysisResult.detections 转为 V2 Diagnostic[]。
 * 每个 position 产生一条带 span 的 Diagnostic。
 */
export function convertDetectionsToDiagnostics(
  text: string,
  analysis: AnalysisResult
): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (const det of analysis.detections) {
    const residueKind = classifyPatternResidueKind(det.patternId);
    const severity = mapSeverity(det.severity, residueKind);
    // 每个 position 一条 diagnostic（保证 span 精确定位）
    for (let i = 0; i < det.positions.length; i++) {
      const pos = det.positions[i];
      const span = positionToSpan(text, pos);
      diags.push({
        id: `diag:language_risk:${det.patternId}:${i}`,
        source: "legacy_anti_ai_detector",
        severity,
        domain: "naturalness",
        evidence: `[${det.patternId}] ${det.tag}（${det.fix}）`,
        span,
      });
    }
  }
  return diags;
}

// ============================================================================
// LanguageRiskAdapter — 包装真实 AntiAIDetector
// ============================================================================

// ============================================================================
// Naturalness Scanner findings -> V2 Diagnostic[]（P35 退役等价覆盖，dim1）
// ============================================================================

/**
 * 把 ChineseNarrativeNaturalnessScanner 的 findings 转为 V2 Diagnostic[]。
 *
 * 覆盖 anti-ai-detector 未涵盖的翻译腔/英文味 pattern（P32/P33/P34/P42 六大类
 * 与母语语感诊断，如"阳光劈头砸下/声音被拽断/切碎在玻璃上/光泼进夜里"等）。
 * 每条 finding 带 index（命中偏移），经 positionToSpan 转为可追溯 span。
 *
 * 软风险不 hard block：high -> review，medium/low -> info。
 */
export function convertNaturalnessFindingsToDiagnostics(
  text: string,
  result: ChineseNarrativeNaturalnessScanResult,
): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const findings: ChineseNarrativeNaturalnessFinding[] = result.findings;
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    const span = positionToSpan(text, f.index);
    const severity: DiagnosticSeverity = f.severity === "high" ? "review" : "info";
    diags.push({
      id: `diag:naturalness:${f.type}:${i}`,
      source: "chinese_narrative_naturalness_scanner",
      severity,
      domain: "naturalness",
      evidence: `[${f.type}] ${f.text}（建议：${f.suggestion}）`,
      span,
    });
  }
  return diags;
}

// ============================================================================
// FlatNarration issues -> V2 Diagnostic[]（P35 退役等价覆盖，dim9）
// ============================================================================

/**
 * 把 FlatNarrationScanner 的 issues 转为 V2 Diagnostic[]。
 *
 * 覆盖平淡叙事/流水账 span 诊断（action_list/nonfunctional_detail/overlong_bridge/
 * summary_exposition/weak_scene_focus/measurement_relationship/payoff_underwritten）。
 * 只迁有 index（真 span）的 issue；复合评分（score/verdict）形态退役，不进入 V2。
 * 每条 issue 经 positionToSpan 转为可追溯 span。
 *
 * 软风险不 hard block：critical/review -> review，info -> info。
 */
export function convertFlatNarrationIssuesToDiagnostics(
  text: string,
  result: FlatNarrationScanResult,
): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const issues: FlatNarrationIssue[] = result.issues;
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    // 只迁有 span（index）的 issue -- 无 index 的不构成 span 证据
    if (typeof issue.index !== "number") continue;
    const span = positionToSpan(text, issue.index);
    const severity: DiagnosticSeverity =
      issue.severity === "critical" || issue.severity === "review" ? "review" : "info";
    diags.push({
      id: `diag:flat_narration:${issue.type}:${i}`,
      source: "flat_narration_scanner",
      severity,
      domain: "naturalness",
      evidence: `[${issue.type}] ${issue.excerpt}（建议：${issue.suggestion}）`,
      span,
    });
  }
  return diags;
}

export interface LanguageRiskScanResult {
  /** V2 Diagnostic[]，每条带 span */
  diagnostics: Diagnostic[];
  /** legacy 密度（0-1），供上层做整章 density 兜底 */
  density: number;
  /** legacy level：green/yellow/red */
  level: AnalysisResult["level"];
  /** 总命中数 */
  totalIssues: number;
  /** 来源标记：legacy_real（真实资产，非 stub） */
  source: "legacy_real";
}

export class LanguageRiskAdapter {
  /**
   * 扫描正文，返回带 span 的语言风险诊断。
   *
   * 合并两类 legacy 真实资产：
   * 1. AntiAIDetector.analyze()：resource_negative_is_shortcut /
   *    negative_definition_chain 及其误报过滤、感知侵蚀、AI 特征词等
   * 2. ChineseNarrativeNaturalnessScanner：P32/P33/P34/P42 翻译腔与母语语感
   *    诊断（阳光劈头砸下/声音被拽断/切碎在玻璃上/光泼进夜里 等 anti-ai-detector
   *    未覆盖的 pattern）。P35 退役等价覆盖：把原 paradigm-scanner dim1 的有效
   *    span 诊断接进 V2 owner，不经复合评分、不 hard block。
   *
   * density/level 仍取 AntiAIDetector（整章 AI 腔密度口径，向后兼容）；
   * naturalness findings 作为补充 span 证据并入 diagnostics。
   *
   * @param text 候选正文
   * @param characterNames 已知角色名（用于多角色互动豁免）
   */
  scan(text: string, characterNames: string[] = []): LanguageRiskScanResult {
    if (!text || text.trim().length === 0) {
      return { diagnostics: [], density: 0, level: "green", totalIssues: 0, source: "legacy_real" };
    }
    const detector = createAntiAIDetector({ characterNames });
    const analysis = detector.analyze(text);
    const antiAiDiagnostics = convertDetectionsToDiagnostics(text, analysis);

    // P35 退役等价覆盖：补 naturalness scanner 的翻译腔 span 证据（dim1）
    const naturalnessScanner = createChineseNarrativeNaturalnessScanner();
    const natResult = naturalnessScanner.scan(text);
    const natDiagnostics = convertNaturalnessFindingsToDiagnostics(text, natResult);

    // P35 退役等价覆盖：补 flat-narration scanner 的平淡叙事 span 证据（dim9）
    // 只取 issues（span 证据），复合评分 score/verdict 形态不进入 V2
    const flatResult = scanFlatNarration({ text });
    const flatDiagnostics = convertFlatNarrationIssuesToDiagnostics(text, flatResult);

    const diagnostics = [...antiAiDiagnostics, ...natDiagnostics, ...flatDiagnostics];
    return {
      diagnostics,
      density: analysis.density,
      level: analysis.level,
      totalIssues: analysis.totalIssues + natDiagnostics.length + flatDiagnostics.length,
      source: "legacy_real",
    };
  }
}

export function createLanguageRiskAdapter(): LanguageRiskAdapter {
  return new LanguageRiskAdapter();
}

// ============================================================================
// DiagnosticProvider 适配（取代简化 stub createAntiAiDetectorProvider）
// ============================================================================

/**
 * 真实语言风险 DiagnosticProvider。
 * 取代 legacy-diagnostics-adapter.ts 中的简化 createAntiAiDetectorProvider stub。
 * 软风险最高 review，绝不 hard block。
 */
export function createLanguageRiskProvider(): DiagnosticProvider {
  const adapter = createLanguageRiskAdapter();
  return {
    id: "anti_ai_detector",
    maxSeverity: "review",
    diagnose(input: DiagnosticInput): Diagnostic[] {
      const text = input.candidate.text ?? "";
      const charNames = input.context.characterStates.map((c) => c.name);
      const result = adapter.scan(text, charNames);
      return result.diagnostics;
    },
  };
}
