/**
 * NovelOS Knowledge Boundary Checker（OPT-9.6 拆分自 narrative-verifier-suite.ts）
 *
 * 检查角色是否提到不该知道的信息。
 *
 * P0-2 修复：知识边界必须绑定具体角色的具体话语或视角，
 * 不得用"关键词附近出现任意角色名"判定。
 * - 关键词在目标角色的直接引语内（"X说：'...关键词...'"）→ hard
 * - 关键词在目标角色的 POV 内心叙述中（"X想到/知道/意识到...关键词..."）→ hard
 * - 关键词在其他角色的引语或旁白中 → 不触发（不算目标角色违规）
 * - 关键词在无归属叙述中 → 不触发 hard（启发式无法判定归属）
 *
 * M1 启发式：基于 CharacterStateFact.state 中的 `forbiddenKnowledge` 字段
 * （string[]，角色此刻不该知道的信息关键词）。
 */

import type { VerificationFinding, VerificationCertainty } from "./narrative-verifier-types.js";
import type { NarrativeVerifierInput } from "./narrative-verifier-types.js";

// ============================================================================
// 公开入口
// ============================================================================

/**
 * 检查角色是否提到不该知道的信息。
 *
 * @param input 验证输入
 * @param charNames 已知角色名列表
 * @returns 知识边界违规 findings
 */
export function checkKnowledgeBoundary(
  input: NarrativeVerifierInput,
  charNames: string[],
): VerificationFinding[] {
  const findings: VerificationFinding[] = [];

  for (const charState of input.context.characterStates) {
    const forbidden = charState.state?.forbiddenKnowledge;
    if (!Array.isArray(forbidden) || forbidden.length === 0) continue;

    for (const keyword of forbidden as string[]) {
      if (!keyword || keyword.length < 2) continue;
      // 在正文搜索关键词（遍历所有出现位置）
      let pos = input.text.indexOf(keyword);
      while (pos >= 0) {
        const attribution = attributeKnowledgeStatement(
          input.text,
          pos,
          keyword,
          charState.name,
          charNames,
        );

        if (attribution === "self_speech" || attribution === "self_pov") {
          // P0-2：只有目标角色自己说出/想到关键词才算违规
          const spanEnd = pos + keyword.length;
          const windowStart = Math.max(0, pos - 50);
          const windowEnd = Math.min(input.text.length, spanEnd + 50);
          const window = input.text.slice(windowStart, windowEnd);
          findings.push({
            id: `verifier:knowledge_boundary:${charState.characterId}:${keyword}:${pos}`,
            source: "knowledge_boundary_checker",
            failureType: "knowledge_boundary",
            severity: "hard",
            span: {
              start: pos,
              end: spanEnd,
              excerpt: input.text.slice(pos, spanEnd),
            },
            conflictFact: `角色 "${charState.name}" 不该知道 "${keyword}"，但正文中由该角色${attribution === "self_speech" ? "直接说出" : "内心提及"}`,
            sourceRef: `character:${charState.characterId}:forbiddenKnowledge`,
            confidence: 0.9,
            allowedRepairRange: {
              start: windowStart,
              end: windowEnd,
              excerpt: window.slice(0, 60),
            },
            description: `人物知识边界违规：${charState.name} 不该知道「${keyword}」`,
            certainty: "corroborated" as VerificationCertainty,
            coverageStatus: "missing",
          });
        }
        // attribution === "other_character" | "unattributed" → 不触发

        pos = input.text.indexOf(keyword, pos + keyword.length);
      }
    }
  }

  return findings;
}

// ============================================================================
// 内部：归属判定
// ============================================================================

type Attribution = "self_speech" | "self_pov" | "other_character" | "unattributed";

/**
 * P0-2：把关键词出现位置归属到具体角色的话语或视角。
 *
 * 归属规则（按优先级）：
 * 1. self_speech：关键词在引号内，引号前 N 字符内出现 "X说/道/低声说/对Y说" 等指向 self
 * 2. self_pov：关键词在叙述中，前 N 字符内出现 "X想/觉得/知道/意识到/清楚/明白" 指向 self
 * 3. other_character：关键词在引号内，但说话人是其他角色（X 说，X ≠ self）
 * 4. unattributed：无法判定归属（旁白、无明确说话人的引号、无 POV 标记）
 *
 * 引号支持：「」/ 『』/ ""/ ''/ （）
 */
function attributeKnowledgeStatement(
  text: string,
  keywordPos: number,
  keyword: string,
  selfName: string,
  allNames: string[],
): Attribution {
  // 1. 检查关键词是否在引号内
  const quoteRange = findEnclosingQuote(text, keywordPos);
  if (quoteRange) {
    // 找到引号 → 查找说话人
    const speaker = findSpeakerBeforeQuote(text, quoteRange.start, allNames);
    if (speaker === selfName) return "self_speech";
    if (speaker && speaker !== selfName) return "other_character";
    // 引号内但无明确说话人 → 仍归 unattributed（保守不触发）
    return "unattributed";
  }

  // 2. 不在引号内 → 检查 POV 标记（"X想/觉得/知道/意识到/清楚/明白"）
  const lookbackStart = Math.max(0, keywordPos - 80);
  const lookback = text.slice(lookbackStart, keywordPos);
  // 找最后一个 POV 动词，并检查其主语
  // P0-2 修复：matchAll 要求 g 标志
  const povPattern = /([^\s，。；：！？、]{2,4})\s*(?:想(?:到|起)?|觉得|知道|意识到|清楚|明白|记得|忘记|意识到|注意到|心想)/gu;
  const povMatches = Array.from(lookback.matchAll(povPattern));
  if (povMatches.length > 0) {
    const lastMatch = povMatches[povMatches.length - 1];
    const subject = lastMatch[1];
    if (subject === selfName) return "self_pov";
    if (allNames.includes(subject) && subject !== selfName) return "other_character";
    // P0-2 修复：subject 不在 allNames 中（如"心中"），但 lookback 中可能包含已知角色名。
    // 这种情况下，POV 动词的实际主语是 lookback 中最近的角色名
    // （如"林默看着前方，心中想着..."→ 实际主语是"林默"）。
    // 仅当 lookback 中只有一个已知角色名时才推断，避免多角色歧义。
    const inferredSubject = inferSubjectFromLookback(lookback, allNames);
    if (inferredSubject === selfName) return "self_pov";
    if (inferredSubject && inferredSubject !== selfName) return "other_character";
  } else {
    // P0-2 修复：严格模式未匹配时（如"苏婉看着青鱼嘴的水面，心想：..."
    // 中"心想"前有标点"，"），检查 lookback 是否含 POV 动词且只有一个已知角色名。
    const hasPovVerb = /(?:想(?:到|起)?|觉得|知道|意识到|清楚|明白|记得|忘记|注意到|心想)/u.test(lookback);
    if (hasPovVerb) {
      const inferredSubject = inferSubjectFromLookback(lookback, allNames);
      if (inferredSubject === selfName) return "self_pov";
      if (inferredSubject && inferredSubject !== selfName) return "other_character";
    }
  }

  // 3. 检查直接归属："X说/道/低声说/提到/写道" 后跟关键词（无引号）
  // P0-2 修复：matchAll 要求 g 标志
  const speechPattern = /([^\s，。；：！？、]{2,4})\s*(?:说|道|提到|写道|低声说|轻声说|喊道|问道|答道)(?:[：:])?\s*([^\s，。；！？]{0,40})$/gu;
  const speechMatches = Array.from(lookback.matchAll(speechPattern));
  if (speechMatches.length > 0) {
    const lastMatch = speechMatches[speechMatches.length - 1];
    const subject = lastMatch[1];
    const tail = lastMatch[2];
    if (subject === selfName && tail.includes(keyword)) return "self_speech";
    if (subject !== selfName && allNames.includes(subject)) return "other_character";
    // P0-2 修复：subject 不在 allNames 中时，从 lookback 推断实际说话人
    const inferredSubject = inferSubjectFromLookback(lookback, allNames);
    if (inferredSubject === selfName && tail.includes(keyword)) return "self_speech";
    if (inferredSubject && inferredSubject !== selfName) return "other_character";
  }

  return "unattributed";
}

/**
 * P0-2：从 lookback 中推断实际主语。
 *
 * 当 POV/言语动词的紧邻主语不是已知角色名（如"心中"、"她"等代词或副词）时，
 * 检查 lookback 中是否出现已知角色名。仅当 lookback 中只有一个已知角色名时才推断，
 * 避免多角色歧义。
 *
 * 返回推断的角色名，或 null（无法确定）。
 */
function inferSubjectFromLookback(
  lookback: string,
  allNames: string[],
): string | null {
  const namesInLookback = allNames.filter((name) => name.length >= 2 && lookback.includes(name));
  if (namesInLookback.length === 1) return namesInLookback[0];
  return null;
}

/**
 * 查找包含 position 的引号对，返回 {start, end} 或 null。
 * 支持中文/英文引号：「」/『』/""/''/（）。
 */
function findEnclosingQuote(
  text: string,
  position: number,
): { start: number; end: number } | null {
  const quotePairs: Array<[string, string]> = [
    ["「", "」"],
    ["『", "』"],
    ["“", "”"],
    ["'", "'"],
    ["（", "）"],
  ];
  for (const [open, close] of quotePairs) {
    // 找 position 之前最近的 open
    let openPos = -1;
    let searchPos = position;
    while (searchPos > 0) {
      const idx = text.lastIndexOf(open, searchPos);
      if (idx < 0) break;
      // 检查 open 和 position 之间没有 close（否则该引号已闭合）
      const between = text.slice(idx + 1, position);
      if (!between.includes(close)) {
        openPos = idx;
        break;
      }
      searchPos = idx - 1;
    }
    if (openPos < 0) continue;
    // 找 position 之后最近的 close
    const closePos = text.indexOf(close, position);
    if (closePos < 0) continue;
    // 确认 open 和 close 之间没有其他 open（嵌套引号保守跳过）
    const inner = text.slice(openPos + 1, closePos);
    if (inner.includes(open)) continue;
    return { start: openPos, end: closePos };
  }
  return null;
}

/**
 * 从引号开始位置向前查找说话人。
 * 匹配 "X说："/"X道："/"X低声说"/"X对Y说" 等模式，X 必须是已知角色名。
 */
function findSpeakerBeforeQuote(
  text: string,
  quoteStart: number,
  allNames: string[],
): string | null {
  const lookback = text.slice(Math.max(0, quoteStart - 60), quoteStart);
  // 匹配 "X 说/道/低声说/对Y说/问/答" 末尾可能跟 ：
  const pattern = /([^\s，。；！？、]{2,4})\s*(?:对[^\s，。；！？、]{2,4})?\s*(?:低声|轻声|高声|冷声|小声)?\s*(?:说|道|问|答|喊|笑|骂|喝道|说道|问道|答道|喊道|笑道|低声道|轻声道|高声道|冷声道|小声道)(?:[：:]?)\s*$/u;
  const match = lookback.match(pattern);
  if (match) {
    const subject = match[1];
    if (allNames.includes(subject)) return subject;
  }
  return null;
}
