/**
 * NovelOS Fact Checkers（OPT-9.6 拆分自 narrative-verifier-suite.ts）
 *
 * 集中所有事实相关检查器：
 * - checkFactOmission：inviolableFacts 中"拥有/包含"类属性是否在正文中出现
 * - checkTimelineConsistency：本章时间不得早于已记录的最新时间
 * - checkLocationContinuity：角色位置不得无过门跳转
 * - checkFactContradiction：属性型 canon 事实矛盾（如颜色）
 *
 * 拆分目的：满足 simplicity-gate 800 行限制；这些检查器互不依赖，可独立测试。
 */

import type { VerificationFinding } from "./narrative-verifier-types.js";
import type { NarrativeVerifierInput } from "./narrative-verifier-types.js";

// ============================================================================
// 事实遗漏检查
// ============================================================================

/**
 * 检查 inviolableFacts 中的"拥有/包含"类属性是否在正文中出现（M1.1 新增）。
 *
 * M1.1 改进：只对"有"之后的明确核心特征词检查覆盖度。
 * - "青鱼嘴水域有暗流" → 检查"暗流"是否出现
 * - "阿城口袋里有三块钱" → 检查"三块钱"是否出现
 *
 * 跳过其他语义类型（交给专门检查器或行为体现）：
 * - 位置延续（"第2章结尾X在Y"）→ checkLocationContinuity
 * - 身份声明（"X是程序员"）→ 可通过行为体现，不必复述
 * - 颜色属性（"X是蓝色的"）→ checkFactContradiction
 * - 知识边界（"X不知道Y"）→ checkKnowledgeBoundary
 */
export function checkFactOmission(input: NarrativeVerifierInput): VerificationFinding[] {
  const findings: VerificationFinding[] = [];
  const inviolableFacts = input.inviolableFacts ?? [];
  for (const fact of inviolableFacts) {
    if (/^\s*(?:禁止|不得|严禁|不写|不要|避免|不能|不可)/u.test(fact)) continue;
    const attrMatch = fact.match(/有([^\s，。；：、]{2,8})/);
    if (!attrMatch) continue;

    const attr = attrMatch[1];
    if (!input.text.includes(attr)) {
      findings.push({
        id: `verifier:fact_omission:${attr}`,
        source: "fact_omission_checker",
        failureType: "fact_omission",
        severity: "hard",
        span: { start: 0, end: 0, excerpt: "" },
        conflictFact: `必需事实「${fact}」的核心特征「${attr}」在正文中遗漏`,
        sourceRef: `inviolableFact:${fact}`,
        confidence: 0.85,
        allowedRepairRange: { start: 0, end: Math.min(input.text.length, 200), excerpt: "" },
        description: `事实遗漏：${attr}（来自不可违反事实「${fact}」）`,
        certainty: "corroborated",
        coverageStatus: "missing",
      });
    }
  }
  return findings;
}

// ============================================================================
// 时间线连续性检查
// ============================================================================

/**
 * 检查时间线连续性：本章时间不得早于已记录的最新时间（M1.1 新增）。
 *
 * P0-2 修复：必须识别日期、次日、回忆等上下文；不确定时降为 review。
 * - "次日早上8点" vs 前一天下午3点 → 正常时间推进，不触发
 * - "今日上午9点" vs 前一天下午3点 → 正常时间推进，不触发
 * - "第二天清晨" vs 前一天晚上11点 → 正常时间推进，不触发
 * - "回忆昨天上午9点" vs 锚点下午3点 → 回忆上下文，不触发
 * - "上午9点" vs 同日锚点下午3点 → 时间回退，触发 hard
 */
export function checkTimelineConsistency(input: NarrativeVerifierInput): VerificationFinding[] {
  const findings: VerificationFinding[] = [];
  const timelineFacts = input.context.facts.filter(
    (f) => f.kind === "fact" && /时间|上午|下午|点|时/.test(f.content),
  );
  const anchorHour = extractMaxHour(timelineFacts.map((f) => f.content));
  if (anchorHour == null) return findings;

  // M1.1 改进：移除引号内对话内容，避免对话中提到的未来时间（如"三点左右回去"）
  // 被误判为当前叙事时间回退。只检查叙事正文中的时间表达。
  const narrativeText = input.text.replace(/[「」""''《》][^「」""''《》]*[「」""''《》]/g, "");
  const timeMatches = narrativeText.matchAll(/(上午|下午|中午|清晨|傍晚|晚上|夜里)?(\d{1,2}|[一二三四五六七八九]|十|十[一二三四五六七八九]|[二三四五]十|[二三四五]十[一二三四五六七八九])\s*[点时]/g);
  for (const m of timeMatches) {
    const period = m[1] ?? "";
    const parsedHour = parseChineseHour(m[2]);
    if (parsedHour == null) continue;
    let hour = parsedHour;
    if (period === "下午" || period === "傍晚" || period === "晚上" || period === "夜里") hour += 12;
    if (hour < anchorHour) {
      const pos = m.index ?? 0;
      // P0-2：检查日期推进/回忆上下文
      const contextType = classifyTimeContext(narrativeText, pos);
      if (contextType === "day_progression" || contextType === "flashback") {
        // 次日/今日/第二天/回忆等上下文 → 不触发 hard
        continue;
      }
      // P0-2：无明确日期推进上下文但 hour < anchorHour → 降为 review（启发式无法确定）
      // 原因：可能有未识别的日期词、回忆标记或叙事跳跃，启发式无法证明"确定时间回退"。
      findings.push({
        id: `verifier:timeline_inconsistency:${pos}`,
        source: "timeline_consistency_checker",
        failureType: "timeline_inconsistency",
        severity: "review",
        span: { start: pos, end: pos + m[0].length, excerpt: m[0] },
        conflictFact: `本章时间「${m[0]}」可能早于已记录的最新时间「${anchorHour}点」（启发式无法确定日期上下文）`,
        sourceRef: `timeline:anchor:${anchorHour}`,
        confidence: 0.5,
        allowedRepairRange: { start: pos, end: pos + m[0].length + 20, excerpt: m[0] },
        description: `时间可能回退：${m[0]} 早于锚点 ${anchorHour} 点（需人工确认日期上下文）`,
        certainty: "heuristic",
        coverageStatus: "uncertain",
      });
    }
  }
  return findings;
}

/**
 * P0-2：分类时间上下文。
 *
 * 检查 timeMatchPos 前后 60 字符内是否出现日期推进词或回忆标记。
 * - day_progression：次日/第二天/第三天/今日/今天/明天/后天/随后几天/几天后/后来/翌日/今晚/今夜
 * - flashback：回忆/想起/记起/记得/当时/那时/之前/前几日/前些天/多年前/多年前
 * - same_day：无上述标记，视为同日（可比较 hour）
 */
function classifyTimeContext(
  narrativeText: string,
  timeMatchPos: number,
): "day_progression" | "flashback" | "same_day" {
  const windowStart = Math.max(0, timeMatchPos - 80);
  const windowEnd = Math.min(narrativeText.length, timeMatchPos + 40);
  const window = narrativeText.slice(windowStart, windowEnd);

  const dayProgressionPattern = /(?:次日|第二天|第三天|第四天|今日|今天|明天|后天|大后天|随后几天|几天后|几天后的|后来|翌日|今晚|今夜|当夜|当晚|当晚的|当夜)/u;
  if (dayProgressionPattern.test(window)) return "day_progression";

  const flashbackPattern = /(?:回忆|想起|记起|记得|当时|那时|之前|前几日|前些天|多年前|多年前|多年前|多年前|多年前)/u;
  if (flashbackPattern.test(window)) return "flashback";

  return "same_day";
}

// ============================================================================
// 位置连续性检查
// ============================================================================

/**
 * 检查位置连续性：角色位置不得无过门跳转（M1.1 新增）。
 *
 * P0-2 修复：地点跳转缺少可靠主体或时间关系时降为 review。
 */
export function checkLocationContinuity(input: NarrativeVerifierInput): VerificationFinding[] {
  const findings: VerificationFinding[] = [];
  const locationFacts = input.context.facts.filter(
    (f) => f.kind === "fact" && /位置|在.*里|在.*上|在.*中|岸|水|镇/.test(f.content),
  );
  for (const fact of locationFacts) {
    const locationPhrase = extractLocationPhrase(fact.content);
    if (!locationPhrase) continue;
    const opening = input.text.slice(0, 120);
    // 检测"跳跃词 + 移动动词 + 新位置"模式
    // 如"立刻开车去了镇上"、"瞬间到了医院"、"马上赶回家里"
    const jumpPattern = /(?:立刻|瞬间|突然|马上|直接).*?(?:去了?|到|回|前往|赶往|驶向|飞到)([^\s，。；！？]{2,6})/;
    const jumpMatch = opening.match(jumpPattern);
    if (jumpMatch) {
      const jumpTarget = jumpMatch[1];
      // 跳转目标与原位置不同 → 连续性断裂
      const sameLocation =
        jumpTarget === locationPhrase ||
        locationPhrase.includes(jumpTarget) ||
        jumpTarget.includes(locationPhrase);
      if (!sameLocation) {
        const pos = jumpMatch.index ?? 0;
        // P0-2：地点跳转缺少可靠主体或时间关系时降为 review。
        const factCharacter = extractCharacterFromFact(fact.content);
        const knownNames = input.knownCharacterNames ?? [];
        const subjectBeforeJump = opening.slice(0, pos);
        const hasReliableSubject = factCharacter
          ? subjectBeforeJump.includes(factCharacter)
          : knownNames.some((name) => name.length >= 2 && subjectBeforeJump.includes(name));
        if (hasReliableSubject) {
          // 可靠主体 + 明确位置跳转 → hard + corroborated（结构化事实冲突）
          findings.push({
            id: `verifier:location_discontinuity:${fact.id}`,
            source: "location_continuity_checker",
            failureType: "location_discontinuity",
            severity: "hard",
            span: { start: pos, end: pos + jumpMatch[0].length, excerpt: jumpMatch[0] },
            conflictFact: `角色位置无过门跳转：原位置「${locationPhrase}」，正文跳跃到「${jumpTarget}」`,
            sourceRef: `fact:${fact.id}`,
            confidence: 1,
            allowedRepairRange: { start: pos, end: pos + jumpMatch[0].length + 20, excerpt: jumpMatch[0] },
            description: `空间跳转：从「${locationPhrase}」跳跃到「${jumpTarget}」，缺少过门词`,
            certainty: "corroborated",
            coverageStatus: "missing",
          });
        } else {
          // 主体不明或仅代词 → review + heuristic + uncertain
          findings.push({
            id: `verifier:location_discontinuity:${fact.id}`,
            source: "location_continuity_checker",
            failureType: "location_discontinuity",
            severity: "review",
            span: { start: pos, end: pos + jumpMatch[0].length, excerpt: jumpMatch[0] },
            conflictFact: `角色位置可能无过门跳转：原位置「${locationPhrase}」，正文跳跃到「${jumpTarget}」（启发式无法确定主体/时间关系）`,
            sourceRef: `fact:${fact.id}`,
            confidence: 0.5,
            allowedRepairRange: { start: pos, end: pos + jumpMatch[0].length + 20, excerpt: jumpMatch[0] },
            description: `空间可能跳转：从「${locationPhrase}」跳跃到「${jumpTarget}」`,
            certainty: "heuristic",
            coverageStatus: "uncertain",
          });
        }
      }
    }
  }
  return findings;
}

/**
 * P0-2：从 fact.content 提取角色名。
 * 如"第2章结尾林川位置：青鱼嘴水下" → "林川"
 * 如"老周的潜水面罩是蓝色" → "老周"
 * 返回 null 表示无法提取。
 *
 * P0-2 修复：贪婪匹配会捕获"结尾林川"等带上下文前缀的串，
 * 需剥离"第N章/结尾/开头/最后/末尾/前文/前章/本章/当章/当前"等常见上下文词。
 */
function extractCharacterFromFact(content: string): string | null {
  // 常见上下文前缀（章节标记、时间标记），需从捕获结果中剥离
  const contextPrefixPattern = /^(?:第[一二三四五六七八九十\d]+章|结尾|开头|最后|末尾|前文|前章|本章|当章|当前|上一章|下一章)+/u;

  // 模式 1：角色名 + "位置"（如"林川位置"、"第2章结尾林川位置"）
  const posMatch = content.match(/([\u4e00-\u9fa5]{2,4})位置/u);
  if (posMatch) {
    const name = posMatch[1].replace(contextPrefixPattern, "");
    if (name.length >= 2) return name;
  }
  // 模式 2：角色名 + "的"（如"老周的"）
  const possMatch = content.match(/([\u4e00-\u9fa5]{2,4})的/u);
  if (possMatch) {
    const name = possMatch[1].replace(contextPrefixPattern, "");
    if (name.length >= 2) return name;
  }
  // 模式 3：角色名 + "在"（如"林川在"）
  const atMatch = content.match(/([\u4e00-\u9fa5]{2,4})在/u);
  if (atMatch) {
    const name = atMatch[1].replace(contextPrefixPattern, "");
    if (name.length >= 2) return name;
  }
  return null;
}

// ============================================================================
// 属性型事实矛盾检查
// ============================================================================

/**
 * 检查属性型 canon 事实矛盾（M1.1 新增）。
 *
 * P0-2：certainty=corroborated（结构化事实与正文存在确定冲突）。
 *
 * 从 context.facts 中提取颜色属性（蓝/红/绿/黑/白/黄/紫/灰），
 * 若正文出现与 canon 声明不同的颜色 + 同主体关键词在附近 → fact_contradiction hard finding。
 */
export function checkFactContradiction(input: NarrativeVerifierInput): VerificationFinding[] {
  const findings: VerificationFinding[] = [];
  const allColors = ["蓝色", "红色", "绿色", "黑色", "白色", "黄色", "紫色", "灰色"];
  for (const fact of input.context.facts) {
    if (fact.kind !== "fact") continue;
    const colorMatch = fact.content.match(/(蓝色|红色|绿色|黑色|白色|黄色|紫色|灰色)/);
    if (!colorMatch) continue;
    const canonColor = colorMatch[1];
    // 提取主体（事实开头 2-4 字，遇"的/是/有/在/把/将/带"停止，避免把"老周的潜"当主体）
    const subjectMatch = fact.content.match(/^([\u4e00-\u9fa5]{2,4}?)(?:的|是|有|在|把|将|带)/);
    const subject = subjectMatch?.[1] ?? "";
    if (!subject) continue;

    const otherColors = allColors.filter((c) => c !== canonColor);
    for (const color of otherColors) {
      const pos = input.text.indexOf(color);
      if (pos >= 0) {
        // 检查是否在主体附近（前后 30 字符）
        const window = input.text.slice(Math.max(0, pos - 30), pos + color.length + 30);
        if (window.includes(subject)) {
          findings.push({
            id: `verifier:fact_contradiction:${fact.id}:${color}`,
            source: "fact_contradiction_checker",
            failureType: "fact_contradiction",
            severity: "hard",
            span: { start: pos, end: pos + color.length, excerpt: color },
            conflictFact: `canon 属性矛盾：「${fact.content}」声明为「${canonColor}」，正文出现「${color}」`,
            sourceRef: `fact:${fact.id}`,
            confidence: 0.9,
            allowedRepairRange: { start: pos, end: pos + color.length + 10, excerpt: color },
            description: `属性矛盾：${subject} 的装备应为${canonColor}，正文写成${color}`,
            certainty: "corroborated",
            coverageStatus: "missing",
          });
        }
      }
    }
  }
  return findings;
}

// ============================================================================
// 辅助方法
// ============================================================================

/**
 * 提取关键名词短语（2-3 字中文 bigram，去掉虚词）。
 *
 * M1.1 改进：改为滑动窗口生成 2-3 字 bigram，避免对长中文串按固定窗口切片
 * 产生跨越语法边界的无意义短语（如"苏婉不知道水"）。
 *
 * 取前 5 个最长的短语，用于 fact_omission 检查。
 */
export function extractKeyPhrases(text: string): string[] {
  const phrases: string[] = [];
  // 提取所有中文连续段，对每段生成 2-3 字 bigram（滑动窗口，允许重叠）
  const chineseSegments = text.match(/[\u4e00-\u9fa5]+/g) ?? [];
  for (const segment of chineseSegments) {
    for (let i = 0; i < segment.length - 1; i++) {
      if (i + 3 <= segment.length) {
        phrases.push(segment.slice(i, i + 3));
      }
      phrases.push(segment.slice(i, i + 2));
    }
  }
  const stopWords = /^(?:的|了|是|有|在|和|与|及|或|也|都|就|才|还|又|再|已|正|将|被|把|向|往|为|给|对|跟|从|到|于|之|其|此|这|那|一|二|三|个|些|么|什|怎|哪|他|她|它|我|你|们|第|章|结|尾|位置|时间|不知|知道)$/;
  const filtered = phrases.filter((p) => !stopWords.test(p) && p.length >= 2);
  return [...new Set(filtered)].sort((a, b) => b.length - a.length).slice(0, 5);
}

/**
 * 从时间表达中提取最大小时数（0-23）。
 * 用于 timeline_inconsistency 检查的锚点计算。
 */
export function extractMaxHour(texts: string[]): number | null {
  let maxHour: number | null = null;
  for (const text of texts) {
    const matches = text.matchAll(/(上午|下午|中午|清晨|傍晚|晚上|夜里)?(\d{1,2}|[一二三四五六七八九]|十|十[一二三四五六七八九]|[二三四五]十|[二三四五]十[一二三四五六七八九])\s*[点时]/g);
    for (const m of matches) {
      const period = m[1] ?? "";
      const parsedHour = parseChineseHour(m[2]);
      if (parsedHour == null) continue;
      let hour = parsedHour;
      if (period === "下午" || period === "傍晚" || period === "晚上" || period === "夜里") hour += 12;
      if (maxHour == null || hour > maxHour) maxHour = hour;
    }
  }
  return maxHour;
}

/**
 * 中文数字（小时）转 int，支持 1-23。
 * 输入可为阿拉伯数字 "9" 或中文 "九"/"十"/"十二"/"二十"/"二十三"。
 * 无法识别返回 null。
 */
export function parseChineseHour(cn: string): number | null {
  const map: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (/^\d{1,2}$/.test(cn)) return parseInt(cn, 10);
  if (map[cn] != null) return map[cn];
  if (cn === "十") return 10;
  if (cn.startsWith("十") && cn.length === 2) return 10 + (map[cn[1]] ?? 0);
  if (cn.length === 2 && cn.endsWith("十")) return (map[cn[0]] ?? 0) * 10;
  if (cn.length === 3 && cn[1] === "十") return (map[cn[0]] ?? 0) * 10 + (map[cn[2]] ?? 0);
  return null;
}

/**
 * 从位置事实中提取位置关键词。
 * 匹配"位置：X"或"在X(里|中|上|岸|下|边|旁)"格式。
 */
export function extractLocationPhrase(content: string): string | null {
  const m1 = content.match(/位置[：:]\s*([^\s，。；]+)/);
  if (m1) return m1[1];
  const m2 = content.match(/在(.+?)(?:里|中|上|岸|下|边|旁)/);
  if (m2) return m2[1];
  return null;
}
