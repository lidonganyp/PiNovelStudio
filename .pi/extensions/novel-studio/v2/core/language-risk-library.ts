/**
 * Language Risk Library（Phase 2，计划 §Phase 2）
 *
 * V2 原生语言风险检测库，提供统一、稳定的 API。
 *
 * 设计原则：
 * - 所有检测结果必须带 span（TextSpan，可追溯到正文位置）
 * - 软风险不得 hard block：语言风险最高 review
 * - 不复制简化词表替代真实实现：通过 LanguageRiskAdapter 调用 legacy 真实资产
 * - 提供 V2 原生的感知/行动稀释检测（从 regression-checks.ts 提取，带 span）
 *
 * 资产来源：
 * - resource_negative_is_shortcut + 误报过滤 → legacy AntiAIDetector（经 adapter）
 * - negative_definition_chain + 误报过滤 → legacy AntiAIDetector（经 adapter）
 * - 中文叙事自然感 scanner → legacy AntiAIDetector（经 adapter）
 * - 感知侵蚀 / 行动稀释 → V2 原生（AGENCY_ACTION_PATTERN / PERCEPTION_LANGUAGE_PATTERN）
 *
 * 本库是 Phase 3/4 编辑机会判断与裁判的统一语言风险入口。
 */

import type { Diagnostic, TextSpan } from "./types.js";
import {
  createLanguageRiskAdapter,
  type LanguageRiskScanResult,
} from "../adapters/legacy-language-risk-adapter.js";
import {
  AGENCY_ACTION_PATTERN,
  PERCEPTION_LANGUAGE_PATTERN,
  extractAgencyActions,
  extractPerceptionMarkers,
} from "./regression-checks.js";

// ============================================================================
// 类型定义
// ============================================================================

export interface LanguageRiskEntry {
  /** 风险类别 */
  category: "ai_pattern" | "perception_erosion" | "agency_dilution" | "naturalness";
  /** 风险 id（如 resource_negative_is_shortcut / perception_erosion / agency_dilution） */
  riskId: string;
  /** span，可追溯到正文位置 */
  span: TextSpan;
  /** 严重度：语言风险最高 review */
  severity: "review" | "info";
  /** 人类可读描述（= evidence）*/
  description: string;
  /** 置信度 0-1（advisory，不决定 winner，不 hard block）*/
  confidence: number;
  /** 建议修复范围（advisory）：sentence_patch / paragraph_patch */
  suggestedScope: "sentence_patch" | "paragraph_patch";
}

/**
 * 段落级 flat-narration 类型（建议 paragraph_patch；其余 language risk 多为句级）。
 * 统一信封字段派生：confidence 由 severity 派生，suggestedScope 由 riskId 派生。
 * - confidence：review->0.7，info->0.4（advisory，非判定分）
 * - suggestedScope：段落级流水账->paragraph_patch，翻译腔/测量式/感知侵蚀->sentence_patch
 */
const PARAGRAPH_SCOPE_RISK_IDS = new Set([
  "action_list",
  "overlong_bridge",
  "summary_exposition",
  "weak_scene_focus",
  "payoff_underwritten",
]);

function deriveConfidenceAndScope(
  severity: "review" | "info",
  riskId: string,
): { confidence: number; suggestedScope: "sentence_patch" | "paragraph_patch" } {
  const confidence = severity === "review" ? 0.7 : 0.4;
  const suggestedScope = PARAGRAPH_SCOPE_RISK_IDS.has(riskId)
    ? "paragraph_patch"
    : "sentence_patch";
  return { confidence, suggestedScope };
}

export interface LanguageRiskReport {
  entries: LanguageRiskEntry[];
  /** 整章 AI 腔密度（0-1，来自 legacy） */
  density: number;
  /** legacy level：green/yellow/red */
  level: "green" | "yellow" | "red";
  /** 来源：legacy_real（真实资产，非简化 stub） */
  source: "legacy_real";
  /** 转换为 V2 Diagnostic[]（带 span） */
  diagnostics: Diagnostic[];
}

// ============================================================================
// V2 原生：感知侵蚀与行动稀释检测（带 span）
// ============================================================================

/**
 * 检测正文中的感知侵蚀词，返回带 span 的条目。
 * 感知侵蚀词：感到/意识到/注意到/突然明白（用感知替代主角主动行动）。
 */
export function detectPerceptionErosion(text: string): LanguageRiskEntry[] {
  const entries: LanguageRiskEntry[] = [];
  if (!text) return entries;
  const regex = new RegExp(PERCEPTION_LANGUAGE_PATTERN.source, "g");
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = regex.exec(text)) !== null) {
    entries.push({
      category: "perception_erosion",
      riskId: "perception_erosion",
      span: { start: m.index, end: m.index + m[0].length, excerpt: m[0] },
      severity: "info",
      description: `感知侵蚀词 "${m[0]}"：用感知替代主角主动行动`,
      ...deriveConfidenceAndScope("info", "perception_erosion"),
    });
    idx++;
    // 防止零宽匹配死循环
    if (m.index === regex.lastIndex) regex.lastIndex++;
  }
  return entries;
}

/**
 * 检测正文中的主角行动词命中，返回带 span 的条目。
 * 行动词本身不是风险，但行动词稀疏（相对 baseline）是行动稀释信号。
 * 这里只收集命中，稀释判定由 comparator 的 antiRegression 维度处理。
 */
export function detectAgencyActions(text: string): Array<{ span: TextSpan; word: string }> {
  const results: Array<{ span: TextSpan; word: string }> = [];
  if (!text) return results;
  const regex = new RegExp(AGENCY_ACTION_PATTERN.source, "g");
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    results.push({
      word: m[0],
      span: { start: m.index, end: m.index + m[0].length, excerpt: m[0] },
    });
    if (m.index === regex.lastIndex) regex.lastIndex++;
  }
  return results;
}

// ============================================================================
// LanguageRiskLibrary — 统一入口
// ============================================================================

export class LanguageRiskLibrary {
  private adapter = createLanguageRiskAdapter();

  /**
   * 全面扫描正文语言风险，返回带 span 的报告。
   *
   * 合并两类来源：
   * 1. legacy 真实资产（经 adapter）：AI pattern、否定铺垫、否定定义链、自然感
   * 2. V2 原生：感知侵蚀、行动词命中
   *
   * 所有条目带 span，软风险最高 review。
   */
  scan(text: string, characterNames: string[] = []): LanguageRiskReport {
    // 1. legacy 真实资产扫描
    const legacyResult: LanguageRiskScanResult = this.adapter.scan(text, characterNames);

    // 2. V2 原生感知侵蚀检测
    const perceptionEntries = detectPerceptionErosion(text);

    // 3. 合并 entries（按 source 区分 ai_pattern / naturalness）
    const naturalnessSources = new Set([
      "chinese_narrative_naturalness_scanner",
      "flat_narration_scanner",
    ]);
    const entries: LanguageRiskEntry[] = [
      ...legacyResult.diagnostics.map((d) => {
        const severity = (d.severity === "review" ? "review" : "info") as "review" | "info";
        const riskId = d.evidence.match(/^\[(\w+)\]/)?.[1] ?? "ai_pattern";
        return {
          category: (naturalnessSources.has(d.source as string)
            ? "naturalness"
            : "ai_pattern") as "ai_pattern" | "naturalness",
          riskId,
          span: d.span ?? { start: 0, end: 0 },
          severity,
          description: d.evidence,
          ...deriveConfidenceAndScope(severity, riskId),
        };
      }),
      ...perceptionEntries,
    ];

    return {
      entries,
      density: legacyResult.density,
      level: legacyResult.level,
      source: "legacy_real",
      diagnostics: legacyResult.diagnostics,
    };
  }

  /**
   * 便捷方法：只返回 V2 Diagnostic[]（带 span），供 DiagnosticSuite 聚合。
   */
  scanAsDiagnostics(text: string, characterNames: string[] = []): Diagnostic[] {
    return this.scan(text, characterNames).diagnostics;
  }
}

export function createLanguageRiskLibrary(): LanguageRiskLibrary {
  return new LanguageRiskLibrary();
}
