/**
 * PromptConstraintAudit - detects prose-execution constraints before a model call.
 *
 * This module intentionally knows nothing about scene templates or candidate
 * strategies. It only identifies instructions that prescribe dialogue ratios,
 * paragraph sizes, ordered checklists, or other mechanical prose targets.
 */

import type { CandidatePromptProfile } from "./types.js";

const DIALOGUE_RATIO_PATTERN =
  /对白比例|对话比例|dialogue\s*ratio|比例必须.*?\d+\s*%|\d+\s*%\s*对白/i;
const PARAGRAPH_LENGTH_PATTERN =
  /每段.*?\d+\s*字|段落长度必须|每段.*?字数|段落必须.*?\d+|每段不少于\d+|每段不超过\d+/i;
const CONTROL_CHECKLIST_PATTERN =
  /必须按清单|逐条写|按以下清单逐条|必须依次完成以下事件|必须覆盖以下事件清单/i;
const MECHANICAL_METRIC_PATTERN =
  /对白比例|对话比例|段落长度必须|每段.*?\d+\s*字|\d+\s*%\s*对白|字数必须.*?\d+/i;

function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

function extractContractIds(userPrompt: string): string[] {
  return Array.from(new Set(userPrompt.match(/scene:\d+:[a-z]+/g) ?? []));
}

export function auditPrompt(
  systemPrompt: string,
  userPrompt: string,
): CandidatePromptProfile {
  const fullPrompt = `${systemPrompt}\n${userPrompt}`;
  const containsDialogueRatio = DIALOGUE_RATIO_PATTERN.test(fullPrompt);
  const containsParagraphLengthConstraint = PARAGRAPH_LENGTH_PATTERN.test(fullPrompt);
  const containsControlChecklist = CONTROL_CHECKLIST_PATTERN.test(fullPrompt);
  const containsMechanicalMetric = MECHANICAL_METRIC_PATTERN.test(fullPrompt);
  const isControl = containsDialogueRatio
    || containsParagraphLengthConstraint
    || containsControlChecklist
    || containsMechanicalMetric;

  return {
    type: isControl ? "control" : "editorial",
    tokensIn: estimateTokens(fullPrompt),
    containsDialogueRatio,
    containsParagraphLengthConstraint,
    containsControlChecklist,
    containsMechanicalMetric,
    contractIds: extractContractIds(userPrompt),
  };
}
