/**
 * NovelOS Patch Merger（OPT-9.5 拆分自 narrative-agent-loop.ts）
 *
 * 解析模型输出的局部替换文本，合并到原 draft。
 *
 * 期望格式（无 Markdown 围栏）：
 * [替换1]
 * <替换文本>
 * [替换2]
 * <替换文本>
 *
 * P1-4 修复：
 * - 防御性剥离可能残留的 ``` 围栏（模型可能无视提示仍输出代码块标记）
 * - 合并规则：按 span 范围逆序替换（避免偏移），span 外文本逐字保留
 * - 解析失败返回 null（调用方抛错，由 catch 兜底保留原 draft）
 *
 * 拆分目的：满足 simplicity-gate 800 行限制；这是纯函数，可独立测试。
 */

import type { PatchProposal } from "./candidate-patch-service.js";

// ============================================================================
// 公开入口
// ============================================================================

/**
 * P0-3 / P1-4：解析模型输出的局部替换文本，合并到原 draft。
 *
 * @param originalDraft 原 draft 全文
 * @param proposals patch proposals（含 targetSpan）
 * @param modelOutput 模型输出（期望含 [替换N] 块）
 * @returns 合并后的正文；解析失败返回 null（调用方抛错）
 */
export function applyLocalReplacements(
  originalDraft: string,
  proposals: PatchProposal[],
  modelOutput: string,
): string | null {
  // P1-4：防御性剥离 ``` 围栏（模型可能无视提示仍输出代码块标记）
  const stripped = modelOutput
    .replace(/^\s*```\s*\n?/u, "")
    .replace(/\n?\s*```\s*$/u, "")
    .replace(/\n?\s*```\s*\n(?=\[替换\d+\])/gu, "\n");

  // 解析 [替换N] 块
  const replacements: Array<{ index: number; text: string }> = [];
  const blockPattern = /\[替换(\d+)\]\s*([\s\S]*?)(?=\[替换\d+\]|$)/gu;
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(stripped)) !== null) {
    const index = parseInt(match[1], 10);
    const text = match[2].trim();
    // P1-4：剥离每个块内部可能残留的行首/行尾 ```
    const cleanText = text
      .replace(/^\s*```\s*/u, "")
      .replace(/\s*```\s*$/u, "")
      .trim();
    if (cleanText.length > 0) {
      replacements.push({ index, text: cleanText });
    }
  }

  if (replacements.length === 0) return null;
  replacements.sort((a, b) => a.index - b.index);

  // 按 span 范围逆序替换（避免偏移）
  let result = originalDraft;
  const sortedProposals = [...proposals].sort(
    (a, b) => b.targetSpan.start - a.targetSpan.start,
  );

  for (let i = 0; i < sortedProposals.length; i++) {
    const proposal = sortedProposals[i];
    const replacement = replacements.find((r) => {
      // 匹配 proposal 在原列表中的 1-based 索引
      const originalIndex = proposals.indexOf(proposal) + 1;
      return r.index === originalIndex;
    });
    if (!replacement) continue;

    const before = result.slice(0, proposal.targetSpan.start);
    const after = result.slice(proposal.targetSpan.end);
    result = before + replacement.text + after;
  }

  return result;
}

// ============================================================================
// Patch prompt 构造（pure helper）
// ============================================================================

import type { VerificationFinding } from "../verification/narrative-verifier-suite.js";

/**
 * 构造 patch prompt（局部 replacement 模式）。
 *
 * P1-4 修复：禁止使用 Markdown 围栏，改为纯文本格式描述。
 *
 * @param originalDraft 原 draft 全文
 * @param activeProposals 已接受的 patch proposals
 * @param findings 关联的 findings
 * @returns 局部 replacement 模式的 user prompt
 */
export function buildLocalReplacementPrompt(
  originalDraft: string,
  activeProposals: PatchProposal[],
  findings: VerificationFinding[],
): string {
  const findingById = new Map(findings.map((finding) => [finding.id, finding]));

  const replacementSpecs = activeProposals.map((p, i) => {
    const finding = findingById.get(p.findingId);
    const spanStart = p.targetSpan.start;
    const spanEnd = p.targetSpan.end;
    const originalExcerpt = originalDraft.slice(spanStart, spanEnd);
    const isZeroWidth = spanStart === spanEnd;
    return [
      `[替换${i + 1}]`,
      `范围：[${spanStart}, ${spanEnd}]`,
      isZeroWidth
        ? `（零宽插入点：在位置 ${spanStart} 后插入文本，不删除任何原文）`
        : `原片段：「${originalExcerpt}」`,
      `问题：${finding?.conflictFact ?? p.suggestion}`,
      `要求：${finding?.description ?? p.suggestion}`,
      `建议：${p.suggestion}`,
    ].join("\n");
  }).join("\n\n");

  return [
    "以下正文存在若干局部硬伤，请只输出每个标记范围的替换文本，不要重写整章。",
    "不要调用工具。不要使用任何 Markdown 标记（不要输出反引号或代码块）。",
    "按以下格式输出，每个替换块以方括号标记开头，下一行紧接替换文本：",
    "[替换1]",
    "（这里写范围 [start, end] 内的替换文本，仅这一段，不要包含其他内容）",
    "[替换2]",
    "（这里写范围 [start, end] 内的替换文本）",
    "",
    "原始正文：",
    originalDraft,
    "",
    "需要替换的范围与要求：",
    replacementSpecs,
  ].join("\n");
}

/**
 * 构造 patch prompt（完整正文模式，含整章范围或混合场景）。
 */
export function buildFullRewritePrompt(
  originalDraft: string,
  activeProposals: PatchProposal[],
  findings: VerificationFinding[],
): string {
  const findingById = new Map(findings.map((finding) => [finding.id, finding]));

  const patchInstructions = activeProposals
    .map((p, i) => {
      const finding = findingById.get(p.findingId);
      const spanStart = p.targetSpan.start;
      const spanEnd = p.targetSpan.end;
      const originalExcerpt = originalDraft.slice(spanStart, Math.min(spanEnd + 20, originalDraft.length));
      return [
        `[修复${i + 1}] findingId=${p.findingId}`,
        `确定性等级：${p.certainty ?? "unknown"}`,
        `语义类：${p.isSemantic ? "是（受1轮预算约束）" : "否"}`,
        `证据来源：${finding?.sourceRef ?? "unknown"}`,
        `必须解决：${finding?.conflictFact ?? p.suggestion}`,
        `具体要求：${finding?.description ?? p.suggestion}`,
        `允许范围：[${spanStart}, ${spanEnd}]`,
        `原片段：${originalExcerpt}`,
        `方向：${p.repairDirection}`,
        `建议：${p.suggestion}`,
      ].join("\n");
    })
    .join("\n");

  return [
    "以下正文存在若干硬伤，请在标记范围内修复，保持其余内容不变，输出完整正文。",
    "不要调用工具，直接输出修复后的完整正文。",
    "",
    "原始正文：",
    originalDraft,
    "",
    "修复范围与方向：",
    patchInstructions,
  ].join("\n");
}
