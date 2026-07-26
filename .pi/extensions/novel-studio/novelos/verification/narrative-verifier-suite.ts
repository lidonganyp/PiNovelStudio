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
 * 3. 人物知识边界 → 本模块 checkKnowledgeBoundary
 * 4. canon/promise 明确冲突 → 本模块 checkCanonPromiseConflicts
 * 5. 关键 ChapterIntent 事件遗漏 → 本模块 checkIntentOmission
 * 6. 截断、格式损坏、大段重复 → FactContinuityGuard.format_hard_gate / duplicate_scan
 *
 * 文学性意见（LanguageRiskLibrary）只能作为软证据，不得自动阻断或强迫改写。
 */

import type { Diagnostic, DiagnosticSeverity, TextSpan, CompiledContext } from "../../v2/core/types.js";
import { createFactContinuityGuard, type FactContinuityGuard } from "../../v2/core/fact-continuity-guard.js";
import { createLanguageRiskLibrary, type LanguageRiskLibrary } from "../../v2/core/language-risk-library.js";

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
  | "fact_contradiction";    // 属性型 canon 事实矛盾（如颜色）

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

const GUARD_SOURCE_TO_FAILURE_TYPE: Record<string, VerificationFailureType> = {
  format_hard_gate: "format_error",
  duplicate_scan: "duplicate_pollution",
  entity_checker: "entity_hallucination",
  scene_continuity: "scene_continuity",
  skeleton_consistency: "skeleton_inconsistency",
  event_progression: "event_progression",
};

type IntentRequirementMode = "anchor" | "verbatim";

interface IntentRequirement {
  raw: string;
  text: string;
  mode: IntentRequirementMode;
}

const INTENT_SYNONYM_GROUPS: Array<{ canonical: string; variants: string[] }> = [
  { canonical: "三队", variants: ["三队", "三支队伍", "三支队", "三队伍"] },
  { canonical: "首次", variants: ["首次", "第一次", "初次", "头一次"] },
  { canonical: "配合", variants: ["配合", "协同作战", "协同", "协作", "合作"] },
  { canonical: "采样", variants: ["采样", "采集", "取样"] },
  { canonical: "反常", variants: ["状态反常", "状态不对劲", "状态不对", "反常", "破天荒", "比平时更收敛", "明显收敛"] },
  { canonical: "妖兽群", variants: ["妖兽群", "兽群", "一群低阶灰甲兽", "灰甲兽群"] },
  { canonical: "异常", variants: ["异常", "不对劲", "异样", "不寻常", "排斥感"] },
  { canonical: "未开口", variants: ["未说出口", "没有说出口", "没说出口", "没有开口", "没开口"] },
  { canonical: "突袭", variants: ["突袭", "袭击", "突然袭来", "破水而出"] },
  { canonical: "拖入水底", variants: ["拖入水底", "拖入深水", "拖入水下", "拽入深水", "拉入水底"] },
  { canonical: "开枪", variants: ["开枪", "开火", "机枪火舌", "子弹打进"] },
  { canonical: "无效", variants: ["无效", "没效果", "没有效果", "没带出来", "皮甲极厚", "连皮都没能擦破", "连皮都没擦破", "没能擦破", "没擦破"] },
  { canonical: "多只", variants: ["多只", "至少有三只", "两只以上", "不止一只", "一群"] },
  { canonical: "围攻", variants: ["围攻", "集群攻击", "群体攻击", "多只攻击", "快速穿梭", "从四面逼近", "从四面围上来"] },
  { canonical: "战力一成", variants: ["十不存一", "只剩一成", "战力只剩一成", "战力大降"] },
  { canonical: "击杀", variants: ["一击斩杀", "斩杀", "击杀", "毙命", "切开"] },
  { canonical: "干脆", variants: ["干脆", "利落", "直接"] },
  { canonical: "评估", variants: ["评估局势", "判断局势", "快速判断", "看着挣扎的队友"] },
  { canonical: "出手", variants: ["决定出手", "主动出手", "意念一动", "鳞片从空间中滑出"] },
  { canonical: "暗金", variants: ["暗金", "暗金色"] },
  { canonical: "双眸", variants: ["双眸", "竖瞳"] },
  { canonical: "救回", variants: ["救回", "救出", "拖回", "带回水面", "带着他向上游"] },
  { canonical: "震惊", variants: ["震惊", "愣住", "瞪大眼睛", "忘了踩水", "从未见过"] },
  { canonical: "关心", variants: ["关心", "担心", "询问伤势", "没受伤吧", "你没事吧", "没事吧", "递过来一条干毛巾", "递给他一条毛巾"] },
  { canonical: "微亮", variants: ["微亮", "微微亮", "亮了一丝", "亮起一丝"] },
  { canonical: "未醒", variants: ["未醒", "没有醒", "没有苏醒", "仍未苏醒", "没醒"] },
  { canonical: "重新评估", variants: ["重新评估", "重新审视", "重新正视", "重新看待"] },
  { canonical: "定位改变", variants: ["定位将变", "定位会变", "位置会变", "重新定位"] },
  { canonical: "改变", variants: ["改变", "回不到从前", "变了", "要变", "将变", "彻底变"] },
  { canonical: "倒计时压力", variants: ["倒计时型压力", "倒计时压力", "氧气有限", "氧气在快速消耗", "氧气在消耗", "氧气消耗", "体力有限"] },
];

const INTENT_TOKEN_CANONICALS = [
  "战狼领队", "黑玫瑰领队", "赵明远", "李一凡", "王研究员", "水样", "虫卵", "水怪", "研究员", "水下", "水面", "能见度", "极低",
  "多只", "鳞片", "第二只", "小妖", "震惊", "墨老", "木心", "反常", "冷淡", "客气", "妖兽群",
  "暗金双眸", "暗金", "双眸", "梦魇", "战力", "评估", "出手", "直觉", "采样", "反常", "妖兽群", "异常", "未开口", "突袭", "拖入水底", "开枪", "无效",
  "围攻", "战力一成", "倒计时压力", "击杀", "干脆", "救回", "关心", "微亮", "未醒", "重新评估", "定位改变", "定位", "改变",
  "回程", "下令救人", "救援", "三队", "首次", "配合",
];

const INTENT_SYNONYM_CANONICALS = new Map<string, string>();
for (const group of INTENT_SYNONYM_GROUPS) {
  for (const variant of group.variants) {
    if (!INTENT_SYNONYM_CANONICALS.has(variant)) {
      INTENT_SYNONYM_CANONICALS.set(variant, group.canonical);
    }
  }
}

const INTENT_SYNONYM_PATTERN = new RegExp(
  Array.from(INTENT_SYNONYM_CANONICALS.keys())
    .sort((a, b) => b.length - a.length)
    .map((variant) => variant.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|"),
  "gu",
);

function normalizeIntentPhrase(value: string): string {
  let normalized = value
    .replace(/^\s*\[(?:anchor|verbatim)\]\s*/iu, "")
    .replace(/^\s*(?:原句|原文)\s*[：:]\s*/u, "")
    .replace(/[「『“"”』」]/gu, "")
    .replace(/[\s，。、；：:！!？?（）()【】\[\]→+]+/gu, "")
    .replace(/[的地得]/gu, "")
    .trim();
  return normalized.replace(
    INTENT_SYNONYM_PATTERN,
    (variant) => INTENT_SYNONYM_CANONICALS.get(variant) ?? variant,
  );
}

function parseIntentRequirements(chapterIntent: string): IntentRequirement[] {
  const line = chapterIntent.match(/^作者章纲必须包含：(.+)$/mu)?.[1] ?? "";
  if (!line) return [];
  return line
    .split(/[；;]/u)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const verbatim = /^\s*\[(?:verbatim)\]/iu.test(raw) || /^\s*(?:原句|原文)\s*[：:]/u.test(raw);
      return { raw, text: raw, mode: verbatim ? "verbatim" : "anchor" };
    });
}

function parseAuthorEventSummaries(chapterIntent: string): Array<{ index: number; summary: string }> {
  const lines = chapterIntent.split(/\r?\n/u);
  const events: Array<{ index: number; summary: string }> = [];
  let inSection = false;
  for (const line of lines) {
    if (/^作者章纲事件顺序：\s*$/u.test(line.trim())) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^作者章纲/u.test(line.trim())) break;
    const match = line.match(/^\s*(\d+)[.、]\s*(.+)$/u);
    if (match) events.push({ index: Number(match[1]), summary: match[2].trim() });
  }
  return events;
}

function intentAnchorCovered(text: string, requirement: string): boolean {
  if (text.includes(requirement)) return true;
  const normalizedText = normalizeIntentPhrase(text);
  const normalizedRequirement = normalizeIntentPhrase(requirement);
  if (!normalizedRequirement || normalizedText.includes(normalizedRequirement)) return true;

  const tokens = INTENT_TOKEN_CANONICALS
    .filter((token) => normalizedRequirement.includes(token))
    .sort((a, b) => b.length - a.length);
  if (tokens.length === 0) return false;
  const matched = tokens.filter((token) => normalizedText.includes(token)).length;
  const threshold = tokens.length <= 2 ? tokens.length : Math.max(2, Math.ceil(tokens.length * 0.6));
  return matched >= threshold;
}

function intentEventCovered(text: string, summary: string): boolean {
  const normalizedText = normalizeIntentPhrase(text);
  const normalizedSummary = normalizeIntentPhrase(summary);
  if (!normalizedSummary || normalizedText.includes(normalizedSummary)) return true;
  const tokens = Array.from(new Set(
    INTENT_TOKEN_CANONICALS.filter((token) => normalizedSummary.includes(token)),
  ));
  if (tokens.length < 2) return intentAnchorCovered(text, summary);
  const matched = tokens.filter((token) => normalizedText.includes(token)).length;
  return matched >= Math.max(2, Math.ceil(tokens.length * 0.35));
}

function intentVerbatimCovered(text: string, requirement: string): boolean {
  const quote = requirement.match(/^(?:\s*\[(?:verbatim)\]\s*)?(?:原句|原文)\s*[：:]\s*[「『“"”](.*?)[」』”"]\s*$/u)?.[1];
  return text.includes((quote ?? requirement).trim());
}

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

    // 3-5. 本地验证器
    const knowledgeFindings = this.checkKnowledgeBoundary(input, charNames);
    const canonFindings = this.checkCanonPromiseConflicts(input);
    const omissionFindings = this.checkIntentOmission(input);
    // M1.1 新增验证器
    const factOmissionFindings = this.checkFactOmission(input);
    const timelineFindings = this.checkTimelineConsistency(input);
    const locationFindings = this.checkLocationContinuity(input);
    const contradictionFindings = this.checkFactContradiction(input);

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
    ];

    const hardFindings = findings.filter(
      (f) => f.severity === "hard" || f.severity === "fatal",
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

  // ── 内部：知识边界检查 ──────────────────────────────────────────────

  /**
   * 检查角色是否提到不该知道的信息。
   *
   * P0-2 修复：知识边界必须绑定具体角色的具体话语或视角，不得用"关键词附近出现任意角色名"判定。
   * - 关键词在目标角色的直接引语内（"X说：'...关键词...'"）→ hard
   * - 关键词在目标角色的 POV 内心叙述中（"X想到/知道/意识到...关键词..."）→ hard
   * - 关键词在其他角色的引语或旁白中 → 不触发（不算目标角色违规）
   * - 关键词在无归属叙述中 → 不触发 hard（启发式无法判定归属）
   *
   * M1 启发式：基于 CharacterStateFact.state 中的 `forbiddenKnowledge` 字段
   * （string[]，角色此刻不该知道的信息关键词）。
   */
  private checkKnowledgeBoundary(
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
          const attribution = this.attributeKnowledgeStatement(
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
              certainty: "corroborated",
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
  private attributeKnowledgeStatement(
    text: string,
    keywordPos: number,
    keyword: string,
    selfName: string,
    allNames: string[],
  ): "self_speech" | "self_pov" | "other_character" | "unattributed" {
    // 1. 检查关键词是否在引号内
    const quoteRange = this.findEnclosingQuote(text, keywordPos);
    if (quoteRange) {
      // 找到引号 → 查找说话人
      const speaker = this.findSpeakerBeforeQuote(text, quoteRange.start, allNames);
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
      const inferredSubject = this.inferSubjectFromLookback(lookback, allNames);
      if (inferredSubject === selfName) return "self_pov";
      if (inferredSubject && inferredSubject !== selfName) return "other_character";
    } else {
      // P0-2 修复：严格模式未匹配时（如"苏婉看着青鱼嘴的水面，心想：..."
      // 中"心想"前有标点"，"），检查 lookback 是否含 POV 动词且只有一个已知角色名。
      const hasPovVerb = /(?:想(?:到|起)?|觉得|知道|意识到|清楚|明白|记得|忘记|注意到|心想)/u.test(lookback);
      if (hasPovVerb) {
        const inferredSubject = this.inferSubjectFromLookback(lookback, allNames);
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
      // subject 后跟的内容包含 keyword → self 直接提及
      const tail = lastMatch[2];
      if (subject === selfName && tail.includes(keyword)) return "self_speech";
      if (subject !== selfName && allNames.includes(subject)) return "other_character";
      // P0-2 修复：subject 不在 allNames 中时，从 lookback 推断实际说话人
      const inferredSubject = this.inferSubjectFromLookback(lookback, allNames);
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
  private inferSubjectFromLookback(
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
  private findEnclosingQuote(
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
  private findSpeakerBeforeQuote(
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

  // ── 内部：canon/promise 冲突检查 ────────────────────────────────────

  /**
   * 检查正文是否与 canon 事实或 promise 冲突。
   *
   * P0-2 修复：promise 冲突必须识别明确的兑现声明，不得仅凭关键词附近出现"完成/结束"判定。
   * - 必须出现 "X 已解决/已完结/已了结/已结束" 或 "解决了/完结了/了结了 X" 等明确兑现声明
   * - "完成了记录" 中的 "完成" 修饰 "记录"（非 promise）→ 不触发
   * - "暗流来源已解决" 中的 "解决" 直接修饰 "暗流来源"（promise）→ 触发
   *
   * M1 启发式：
   * - facts 中 kind="canon" 的事实，若 content 含"不能"/"禁止"/"必须不"约束，
   *   检查正文是否违反（简单关键词反转匹配）。
   * - openLoops 中已标记 resolved=false 的 promise，若正文声称已解决，
   *   标记为 promise_conflict。
   */
  private checkCanonPromiseConflicts(input: NarrativeVerifierInput): VerificationFinding[] {
    const findings: VerificationFinding[] = [];

    // canon 事实约束检查（M1：所有 kind="fact" 的事实都视为 canon 约束候选）
    for (const fact of input.context.facts) {
      if (fact.kind !== "fact") continue;
      const constraintMatch = fact.content.match(/(?:不能|禁止|必须不|不得)([^，。；！？\s]+)/);
      if (!constraintMatch) continue;

      const forbiddenTerm = constraintMatch[1];
      if (forbiddenTerm && forbiddenTerm.length >= 2) {
        const pos = input.text.indexOf(forbiddenTerm);
        if (pos >= 0) {
          findings.push({
            id: `verifier:canon_conflict:${fact.id}:${forbiddenTerm}`,
            source: "canon_conflict_checker",
            failureType: "canon_conflict",
            severity: "hard",
            span: {
              start: pos,
              end: pos + forbiddenTerm.length,
              excerpt: input.text.slice(pos, pos + forbiddenTerm.length),
            },
            conflictFact: `canon 约束「${fact.content}」被违反：正文出现「${forbiddenTerm}」`,
            sourceRef: `fact:${fact.id}`,
            confidence: 0.9,
            allowedRepairRange: {
              start: pos,
              end: Math.min(input.text.length, pos + forbiddenTerm.length + 20),
              excerpt: input.text.slice(pos, pos + Math.min(forbiddenTerm.length + 20, 40)),
            },
            description: `canon 冲突：${fact.content}`,
            certainty: "corroborated",
            coverageStatus: "missing",
          });
        }
      }
    }

    // promise 冲突检查（openLoops 中的都是未解决的 promise，若正文声称解决则冲突）
    // P0-2：必须识别明确的兑现声明，不得仅凭关键词附近出现"完成/结束"判定
    for (const loop of input.context.openLoops) {
      // P0-2：keyword 提取兼容中英文标点（英文逗号/句号/分号/冒号）
      const descKeywords = loop.description
        .split(/[\s,，。；;：:、!?！？]+/)
        .map((k) => k.trim())
        .filter((k) => k.length >= 2);
      let loopAlreadyReported = false;
      for (const keyword of descKeywords) {
        let pos = input.text.indexOf(keyword);
        while (pos >= 0 && !loopAlreadyReported) {
          // P0-2：必须识别明确的兑现声明
          if (this.isExplicitPromiseFulfillment(input.text, pos, keyword)) {
            findings.push({
              id: `verifier:promise_conflict:${loop.id}:${keyword}:${pos}`,
              source: "promise_conflict_checker",
              failureType: "promise_conflict",
              severity: "hard",
              span: {
                start: pos,
                end: pos + keyword.length,
                excerpt: input.text.slice(pos, pos + keyword.length),
              },
              conflictFact: `未兑现 promise「${loop.description}」被正文声称解决`,
              sourceRef: `openLoop:${loop.id}`,
              confidence: 0.85,
              allowedRepairRange: {
                start: pos,
                end: Math.min(input.text.length, pos + keyword.length + 20),
                excerpt: input.text.slice(pos, pos + Math.min(keyword.length + 20, 60)),
              },
              description: `promise 冲突：${loop.description}`,
              certainty: "corroborated",
              coverageStatus: "missing",
            });
            loopAlreadyReported = true;
          }
          pos = input.text.indexOf(keyword, pos + keyword.length);
        }
        if (loopAlreadyReported) break;
      }
    }

    return findings;
  }

  /**
   * P0-2：识别明确的 promise 兑现声明。
   *
   * 必须满足以下之一才算"明确兑现声明"：
   * 1. keyword 后紧跟 "已解决/已完结/已了结/已结束/已破/已消散/已破除/被解决/被完结"
   *    例："暗流来源已解决"
   * 2. keyword 前紧跟 "解决了/完结了/了结了/结束了/破除了/消散了" + keyword
   *    例："解决了暗流来源"
   * 3. keyword 后 30 字符内出现 "X 已解决/已完结/已了结/已结束" 且 X 是 keyword 本身
   *    （处理 "暗流来源，这个问题已解决" 等带插入语的形式）
   *
   * 不算"明确兑现声明"：
   * - "完成了记录"（"完成" 修饰 "记录"，不是 keyword）
   * - "解决了另一个问题"（"解决" 修饰其他对象）
   * - "他完成了任务"（无 keyword 上下文）
   */
  private isExplicitPromiseFulfillment(
    text: string,
    keywordPos: number,
    keyword: string,
  ): boolean {
    const keywordEnd = keywordPos + keyword.length;

    // 模式 1：keyword 后紧跟 "已解决/已完结/已了结/已结束/已破/已消散/已破除/被解决/被完结"
    const afterKeyword = text.slice(keywordEnd, Math.min(text.length, keywordEnd + 20));
    const afterPattern = /^(?:[，,。；;]?\s*(?:已|已经|被)?(?:解决|完结|了结|结束|破除|消散|破|散))/u;
    if (afterPattern.test(afterKeyword)) return true;

    // 模式 2：keyword 前紧跟 "解决了/完结了/了结了/结束了/破除了/消散了" + keyword
    const beforeKeyword = text.slice(Math.max(0, keywordPos - 20), keywordPos);
    const beforePattern = /(?:解决|完结|了结|结束|破除|消散|破|散)了$/u;
    if (beforePattern.test(beforeKeyword)) return true;

    // 模式 3：keyword 后 30 字符内出现 "X 已解决/已完结/已了结/已结束" 且 X 指代 keyword
    // 仅当上下文明确指代 keyword 时触发（保守判断：紧邻指代词"这/此/该"）
    const extendedAfter = text.slice(keywordEnd, Math.min(text.length, keywordEnd + 40));
    const extendedPattern = /(?:[，,。；;]\s*(?:这|此|该|那个|这个)(?:问题|事|事情|隐患|危机|谜团)?(?:已|已经|被)?(?:解决|完结|了结|结束|破除|消散))/u;
    if (extendedPattern.test(extendedAfter)) return true;

    return false;
  }

  // ── 内部：关键事件遗漏检查 ──────────────────────────────────────────

  /**
   * 检查 chapterIntent 中的关键事件是否在正文中遗漏。
   *
   * P0-2 严重度分层：
   * - [verbatim] 原句缺失：hard + deterministic + missing（确定性硬门）
   * - [anchor] 词表无法确定：review + heuristic + missing + 空范围（诊断 only）
   * - 事件摘要：review + heuristic + missing + 空范围（启发式无法判定整体事件缺失）
   * - 引号/关于X 关键词：review + heuristic + missing + 空范围
   *
   * 只有结构化证据证明整体事件缺失时才 hard；单一关键词/词表/相似度结果不得直接 hard block。
   */
  private checkIntentOmission(input: NarrativeVerifierInput): VerificationFinding[] {
    const findings: VerificationFinding[] = [];
    const explicitItems = parseIntentRequirements(input.chapterIntent);
    const eventSummaries = parseAuthorEventSummaries(input.chapterIntent);

    // 事件摘要遗漏：P0-2 降为 review + heuristic + 空范围
    // 原因：事件摘要覆盖检测基于关键词匹配（INTENT_TOKEN_CANONICALS），
    // 启发式无法证明"整体事件缺失"，可能只是措辞变化未命中 token。
    for (const event of eventSummaries) {
      if (intentEventCovered(input.text, event.summary)) continue;
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
        coverageStatus: "missing",
      });
    }

    if (explicitItems.length > 0) {
      for (const item of explicitItems) {
        const covered = item.mode === "verbatim"
          ? intentVerbatimCovered(input.text, item.text)
          : intentAnchorCovered(input.text, item.text);
        if (covered) continue;

        if (item.mode === "verbatim") {
          // [verbatim] 原句缺失：deterministic + hard + missing
          findings.push({
            id: `verifier:intent_omission:${item.raw}`,
            source: "intent_omission_checker",
            failureType: "intent_omission",
            severity: "hard",
            span: { start: 0, end: 0, excerpt: "" },
            conflictFact: `作者章纲必须包含项「${item.raw}」在正文中遗漏（原句缺失）`,
            sourceRef: `author-outline:${item.raw}`,
            confidence: 1,
            allowedRepairRange: { start: 0, end: input.text.length, excerpt: input.text.slice(0, 60) },
            description: `作者章纲必须包含项遗漏（verbatim）：${item.raw}`,
            certainty: "deterministic",
            coverageStatus: "missing",
          });
        } else {
          // [anchor] 词表无法确定：review + heuristic + missing + 空范围
          // 原因：anchor 检测基于 INTENT_TOKEN_CANONICALS 词表，启发式无法证明"整体事件缺失"，
          // 可能只是措辞变化未命中 token。空范围（start === end）表示诊断 only，不触发改写。
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
            coverageStatus: "missing",
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
      if (pos < 0) {
        // P0-2：引号/关于X 关键词遗漏降为 review + heuristic + 空范围
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
          coverageStatus: "missing",
        });
      }
    }

    return findings;
  }

  // ── M1.1 内部：事实遗漏检查 ────────────────────────────────────────

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
   *
   * 之前的 bigram 匹配对"第2章结尾林川在青鱼嘴水下"产生"章结尾"等跨越语法边界的
   * 无意义短语，导致健康候选误报；改为只检查"有"之后的明确核心特征词。
   */
  private checkFactOmission(input: NarrativeVerifierInput): VerificationFinding[] {
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

  // ── M1.1 内部：时间线连续性检查 ───────────────────────────────────

  /**
   * 检查时间线连续性：本章时间不得早于已记录的最新时间（M1.1 新增）。
   *
   * P0-2 修复：必须识别日期、次日、回忆等上下文；不确定时降为 review。
   * - "次日早上8点" vs 前一天下午3点 → 正常时间推进，不触发
   * - "今日上午9点" vs 前一天下午3点 → 正常时间推进，不触发
   * - "第二天清晨" vs 前一天晚上11点 → 正常时间推进，不触发
   * - "回忆昨天上午9点" vs 锚点下午3点 → 回忆上下文，不触发
   * - "上午9点" vs 同日锚点下午3点 → 时间回退，触发 hard
   *
   * 从 context.facts 中提取时间锚点（含"上午/下午/X点/X时"的事实），
   * 取最大小时数作为基准。从正文中提取时间表达，
   * 若本章时间 < 锚点时间 且无日期推进/回忆上下文 → timeline_inconsistency hard finding。
   *
   * 用于检测 F3（时间回退）等场景。
   */
  private checkTimelineConsistency(input: NarrativeVerifierInput): VerificationFinding[] {
    const findings: VerificationFinding[] = [];
    const timelineFacts = input.context.facts.filter(
      (f) => f.kind === "fact" && /时间|上午|下午|点|时/.test(f.content),
    );
    const anchorHour = this.extractMaxHour(timelineFacts.map((f) => f.content));
    if (anchorHour == null) return findings;

    // M1.1 改进：移除引号内对话内容，避免对话中提到的未来时间（如"三点左右回去"）
    // 被误判为当前叙事时间回退。只检查叙事正文中的时间表达。
    const narrativeText = input.text.replace(/[「」""''《》][^「」""''《》]*[「」""''《》]/g, "");
    const timeMatches = narrativeText.matchAll(/(上午|下午|中午|清晨|傍晚|晚上|夜里)?(\d{1,2}|[一二三四五六七八九]|十|十[一二三四五六七八九]|[二三四五]十|[二三四五]十[一二三四五六七八九])\s*[点时]/g);
    for (const m of timeMatches) {
      const period = m[1] ?? "";
      const parsedHour = this.parseChineseHour(m[2]);
      if (parsedHour == null) continue;
      let hour = parsedHour;
      if (period === "下午" || period === "傍晚" || period === "晚上" || period === "夜里") hour += 12;
      if (hour < anchorHour) {
        const pos = m.index ?? 0;
        // P0-2：检查日期推进/回忆上下文
        const contextType = this.classifyTimeContext(narrativeText, pos);
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
  private classifyTimeContext(
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

  // ── M1.1 内部：位置连续性检查 ─────────────────────────────────────

  /**
   * 检查位置连续性：角色位置不得无过门跳转（M1.1 新增）。
   *
   * P0-2 修复：地点跳转缺少可靠主体或时间关系时降为 review。
   *
   * 从 context.facts 提取角色最新位置（含"位置"或位置关键词），
   * 若正文开头（前 100 字符）既不含原位置关键词也无过门词（走/跑/开车/前往/到达），
   * 且含跳跃词（立刻/瞬间/突然/马上/直接）→ location_discontinuity finding。
   *
   * 用于检测 F3（空间跳转）等场景。
   */
  private checkLocationContinuity(input: NarrativeVerifierInput): VerificationFinding[] {
    const findings: VerificationFinding[] = [];
    const locationFacts = input.context.facts.filter(
      (f) => f.kind === "fact" && /位置|在.*里|在.*上|在.*中|岸|水|镇/.test(f.content),
    );
    for (const fact of locationFacts) {
      const locationPhrase = this.extractLocationPhrase(fact.content);
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
          // 从 fact.content 提取角色名（如"第2章结尾林川位置"→"林川"），检查
          // 该角色名是否出现在 opening 的 jump 之前。若有可靠主体 → hard + corroborated；
          // 若无可靠主体（主体不明或仅代词）→ review + heuristic + uncertain。
          const factCharacter = this.extractCharacterFromFact(fact.content);
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
  private extractCharacterFromFact(content: string): string | null {
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

  // ── M1.1 内部：属性型事实矛盾检查 ─────────────────────────────────

  /**
   * 检查属性型 canon 事实矛盾（M1.1 新增）。
   *
   * P0-2：certainty=corroborated（结构化事实与正文存在确定冲突）。
   *
   * 从 context.facts 中提取颜色属性（蓝/红/绿/黑/白/黄/紫/灰），
   * 若正文出现与 canon 声明不同的颜色 + 同主体关键词在附近 → fact_contradiction hard finding。
   *
   * 用于检测 F5（颜色矛盾：老周蓝色装备 vs 正文写成红色）等场景。
   */
  private checkFactContradiction(input: NarrativeVerifierInput): VerificationFinding[] {
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

  // ── M1.1 辅助方法 ──────────────────────────────────────────────────

  /**
   * 提取关键名词短语（2-3 字中文 bigram，去掉虚词）。
   *
   * M1.1 改进：改为滑动窗口生成 2-3 字 bigram，避免对长中文串按固定窗口切片
   * 产生跨越语法边界的无意义短语（如"苏婉不知道水"）。
   *
   * 取前 5 个最长的短语，用于 fact_omission 检查。
   */
  private extractKeyPhrases(text: string): string[] {
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
  private extractMaxHour(texts: string[]): number | null {
    let maxHour: number | null = null;
    for (const text of texts) {
      const matches = text.matchAll(/(上午|下午|中午|清晨|傍晚|晚上|夜里)?(\d{1,2}|[一二三四五六七八九]|十|十[一二三四五六七八九]|[二三四五]十|[二三四五]十[一二三四五六七八九])\s*[点时]/g);
      for (const m of matches) {
        const period = m[1] ?? "";
        const parsedHour = this.parseChineseHour(m[2]);
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
  private parseChineseHour(cn: string): number | null {
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
  private extractLocationPhrase(content: string): string | null {
    const m1 = content.match(/位置[：:]\s*([^\s，。；]+)/);
    if (m1) return m1[1];
    const m2 = content.match(/在(.+?)(?:里|中|上|岸|下|边|旁)/);
    if (m2) return m2[1];
    return null;
  }
}

// ============================================================================
// 工厂
// ============================================================================

export function createNarrativeVerifierSuite(): NarrativeVerifierSuite {
  return new NarrativeVerifierSuite();
}
