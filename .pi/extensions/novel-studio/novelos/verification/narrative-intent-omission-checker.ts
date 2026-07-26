/**
 * NovelOS Intent Omission Checker（OPT-9.6 拆分自 narrative-verifier-suite.ts）
 *
 * 检查 chapterIntent 中的关键事件是否在正文中遗漏。
 *
 * P0-2 严重度分层：
 * - [verbatim] 原句缺失：hard + deterministic + missing（确定性硬门）
 * - [anchor] 词表无法确定：review + heuristic + uncertain + 空范围（诊断 only）
 * - 事件摘要：review + heuristic + uncertain + 空范围（启发式无法判定整体事件缺失）
 * - 引号/关于X 关键词：review + heuristic + uncertain + 空范围
 *
 * 只有结构化证据证明整体事件缺失时才 hard；单一关键词/词表/相似度结果不得直接 hard block。
 *
 * 三态语义：
 * - covered：启发式确认覆盖（intent_covered finding）
 * - uncertain：启发式无法确定（heuristic omission —— 可能只是措辞变化未命中）
 * - missing：确定性缺失（deterministic verbatim 原句不在正文中）
 *
 * inc-2 新增：已覆盖事件/anchor/verbatim 现在产出 intent_covered + coverageStatus: "covered"
 *   正向证据（severity=info），让下游能区分"启发式未命中"与"启发式确认覆盖"。
 * inc-3 修复：deterministic intent_omission（verbatim 原句缺失）使用零宽插入点 [textLen, textLen]，
 *   不再使用 [0, text.length] 触发整章重写，也不再使用 [textLen-80, textLen] 覆盖原结尾。
 *   零宽 span 在 applyLocalReplacements 中等价于"在位置 textLen 后插入文本"，不删除任何原文。
 */

import type { VerificationFinding, VerificationCertainty } from "./narrative-verifier-types.js";
import type { NarrativeVerifierInput } from "./narrative-verifier-types.js";
import {
  parseIntentRequirements,
  parseAuthorEventSummaries,
  intentAnchorCovered,
  intentEventCovered,
  intentVerbatimCovered,
} from "./narrative-intent-coverage.js";

// ============================================================================
// 公开入口
// ============================================================================

export function checkIntentOmission(
  input: NarrativeVerifierInput,
): VerificationFinding[] {
  const findings: VerificationFinding[] = [];
  const explicitItems = parseIntentRequirements(input.chapterIntent);
  const eventSummaries = parseAuthorEventSummaries(input.chapterIntent);

  // 事件摘要遗漏：P0-2 降为 review + heuristic + 空范围
  // 原因：事件摘要覆盖检测基于关键词匹配（INTENT_TOKEN_CANONICALS），
  // 启发式无法证明"整体事件缺失"，可能只是措辞变化未命中 token。
  // inc-2：事件已覆盖时产出 intent_covered + coverageStatus: "covered" 正向证据
  for (const event of eventSummaries) {
    if (intentEventCovered(input.text, event.summary)) {
      // inc-2：产出 coverageStatus: "covered" 正向证据（severity=info，不阻断）
      findings.push({
        id: `verifier:event_covered:${event.index}`,
        source: "event_intent_checker",
        failureType: "intent_covered",
        severity: "info",
        span: { start: 0, end: 0, excerpt: "" },
        conflictFact: `作者章纲事件 ${event.index} 已被正文覆盖（启发式命中）`,
        sourceRef: `author-outline:event:${event.index}`,
        confidence: 0.6,
        allowedRepairRange: { start: 0, end: 0, excerpt: "" },
        description: `作者章纲事件已覆盖：${event.summary}`,
        certainty: "heuristic",
        coverageStatus: "covered",
      });
      continue;
    }
    findings.push({
      id: `verifier:event_omission:${event.index}`,
      source: "event_intent_checker",
      failureType: "intent_omission",
      severity: "review",
      span: { start: 0, end: 0, excerpt: "" },
      conflictFact: `作者章纲事件 ${event.index} 在正文中可能缺少事件级覆盖（启发式无法确定）`,
      sourceRef: `author-outline:event:${event.index}`,
      confidence: 0.6,
      allowedRepairRange: { start: 0, end: 0, excerpt: "" },
      description: `作者章纲事件可能遗漏：${event.summary}`,
      certainty: "heuristic",
      coverageStatus: "uncertain",
    });
  }

  if (explicitItems.length > 0) {
    for (const item of explicitItems) {
      const covered = item.mode === "verbatim"
        ? intentVerbatimCovered(input.text, item.text)
        : intentAnchorCovered(input.text, item.text);
      if (covered) {
        // inc-2：产出 coverageStatus: "covered" 正向证据（severity=info，不阻断）
        // verbatim 命中 → deterministic；anchor 命中 → heuristic
        const coveredCertainty: VerificationCertainty =
          item.mode === "verbatim" ? "deterministic" : "heuristic";
        findings.push({
          id: `verifier:intent_covered:${item.raw}`,
          source: "intent_omission_checker",
          failureType: "intent_covered",
          severity: "info",
          span: { start: 0, end: 0, excerpt: "" },
          conflictFact: `作者章纲必须包含项「${item.raw}」已在正文中覆盖`,
          sourceRef: `author-outline:${item.raw}`,
          confidence: item.mode === "verbatim" ? 1 : 0.6,
          allowedRepairRange: { start: 0, end: 0, excerpt: "" },
          description: `章纲要求已覆盖（${item.mode}）：${item.raw}`,
          certainty: coveredCertainty,
          coverageStatus: "covered",
        });
        continue;
      }

      if (item.mode === "verbatim") {
        // [verbatim] 原句缺失：deterministic + hard + missing
        // inc-3 修复：allowedRepairRange 使用零宽插入点 [textLen, textLen]，
        // 不再使用 [0, text.length] 触发整章重写，也不再使用 [textLen-80, textLen] 覆盖原结尾。
        // 零宽 span（start === end === textLen）在 applyLocalReplacements 中等价于
        // "在位置 textLen 后插入文本"，不删除任何原文。
        const textLen = input.text.length;
        findings.push({
          id: `verifier:intent_omission:${item.raw}`,
          source: "intent_omission_checker",
          failureType: "intent_omission",
          severity: "hard",
          span: { start: 0, end: 0, excerpt: "" },
          conflictFact: `作者章纲必须包含项「${item.raw}」在正文中遗漏（原句缺失）`,
          sourceRef: `author-outline:${item.raw}`,
          confidence: 1,
          allowedRepairRange: {
            start: textLen,
            end: textLen,
            excerpt: "",
          },
          description: `作者章纲必须包含项遗漏（verbatim）：${item.raw}（在章末零宽插入原句）`,
          certainty: "deterministic",
          coverageStatus: "missing",
        });
      } else {
        // [anchor] 词表无法确定：review + heuristic + uncertain + 空范围
        // 原因：anchor 检测基于 INTENT_TOKEN_CANONICALS 词表，启发式无法证明"整体事件缺失"，
        // 可能只是措辞变化未命中 token。空范围（start === end）表示诊断 only，不触发改写。
        // 三态语义：heuristic 无法判定 → uncertain（不是 missing，missing 仅用于 deterministic verbatim）。
        findings.push({
          id: `verifier:intent_omission:${item.raw}`,
          source: "intent_omission_checker",
          failureType: "intent_omission",
          severity: "review",
          span: { start: 0, end: 0, excerpt: "" },
          conflictFact: `作者章纲必须包含项「${item.raw}」可能未在正文中覆盖（启发式无法确定）`,
          sourceRef: `author-outline:${item.raw}`,
          confidence: 0.5,
          allowedRepairRange: { start: 0, end: 0, excerpt: "" },
          description: `作者章纲必须包含项可能遗漏（anchor）：${item.raw}`,
          certainty: "heuristic",
          coverageStatus: "uncertain",
        });
      }
    }
    return findings;
  }

  if (eventSummaries.length > 0) return findings;

  // 提取引号内容
  const quoteMatches = input.chapterIntent.matchAll(/[「」""''《》](.+?)[「」""''《》]/g);
  const keywords = new Set<string>();
  for (const m of quoteMatches) {
    const text = m[1].trim();
    if (text.length >= 2 && text.length <= 20) {
      keywords.add(text);
    }
  }

  // 提取「关于X」
  const aboutMatches = input.chapterIntent.matchAll(/(?:关于|涉及)([^\s，。、；：]{2,10})/g);
  for (const m of aboutMatches) {
    keywords.add(m[1].trim());
  }

  for (const keyword of keywords) {
    const pos = input.text.indexOf(keyword);
    if (pos >= 0) {
      // inc-2：关键词已覆盖时产出 intent_covered + coverageStatus: "covered"
      findings.push({
        id: `verifier:intent_covered:${keyword}`,
        source: "intent_omission_checker",
        failureType: "intent_covered",
        severity: "info",
        span: { start: pos, end: pos + keyword.length, excerpt: keyword },
        conflictFact: `chapterIntent 关键事件「${keyword}」已在正文中覆盖`,
        sourceRef: `intent:${keyword}`,
        confidence: 0.6,
        allowedRepairRange: { start: 0, end: 0, excerpt: "" },
        description: `关键事件已覆盖：${keyword}`,
        certainty: "heuristic",
        coverageStatus: "covered",
      });
      continue;
    }
    // P0-2：引号/关于X 关键词遗漏降为 review + heuristic + uncertain + 空范围
    // 三态语义：heuristic 无法判定 → uncertain（不是 missing，missing 仅用于 deterministic verbatim）。
    findings.push({
      id: `verifier:intent_omission:${keyword}`,
      source: "intent_omission_checker",
      failureType: "intent_omission",
      severity: "review",
      span: { start: 0, end: 0, excerpt: "" },
      conflictFact: `chapterIntent 关键事件「${keyword}」可能未在正文中覆盖（启发式无法确定）`,
      sourceRef: `intent:${keyword}`,
      confidence: 0.5,
      allowedRepairRange: { start: 0, end: 0, excerpt: "" },
      description: `关键事件可能遗漏：${keyword}`,
      certainty: "heuristic",
      coverageStatus: "uncertain",
    });
  }

  return findings;
}
