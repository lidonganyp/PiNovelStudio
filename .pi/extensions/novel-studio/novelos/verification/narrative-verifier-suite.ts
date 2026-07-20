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
  /** 允许修改范围（span 级，默认等于 span） */
  allowedRepairRange: TextSpan;
  /** 人类可读描述 */
  description: string;
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
      overrideFailureType ??
      GUARD_SOURCE_TO_FAILURE_TYPE[diagnostic.source] ??
      "language_risk";
    const isHard = diagnostic.severity === "hard" || diagnostic.severity === "fatal";

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
    };
  }

  // ── 内部：知识边界检查 ──────────────────────────────────────────────

  /**
   * 检查角色是否提到不该知道的信息。
   *
   * M1 启发式：基于 CharacterStateFact.state 中的 `forbiddenKnowledge` 字段
   * （string[]，角色此刻不该知道的信息关键词）。正文中若角色对话/内心提到
   * 这些关键词，标记为 knowledge_boundary 硬失败。
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
        // 在正文搜索关键词
        const pos = input.text.indexOf(keyword);
        if (pos < 0) continue;

        // 检查关键词是否在角色对话/内心附近（简单启发式：前后 50 字符内出现角色名）
        const windowStart = Math.max(0, pos - 50);
        const windowEnd = Math.min(input.text.length, pos + keyword.length + 50);
        const window = input.text.slice(windowStart, windowEnd);
        const nearCharacter = charNames.some((name) => window.includes(name));

        if (nearCharacter) {
          findings.push({
            id: `verifier:knowledge_boundary:${charState.characterId}:${keyword}`,
            source: "knowledge_boundary_checker",
            failureType: "knowledge_boundary",
            severity: "hard",
            span: {
              start: pos,
              end: pos + keyword.length,
              excerpt: input.text.slice(pos, pos + keyword.length),
            },
            conflictFact: `角色 "${charState.name}" 不该知道 "${keyword}"，但正文中出现在角色附近`,
            sourceRef: `character:${charState.characterId}:forbiddenKnowledge`,
            confidence: 0.8,
            allowedRepairRange: {
              start: windowStart,
              end: windowEnd,
              excerpt: window.slice(0, 60),
            },
            description: `人物知识边界违规：${charState.name} 不该知道「${keyword}」`,
          });
        }
      }
    }

    return findings;
  }

  // ── 内部：canon/promise 冲突检查 ────────────────────────────────────

  /**
   * 检查正文是否与 canon 事实或 promise 冲突。
   *
   * M1 启发式：
   * - facts 中 kind="canon" 的事实，若 content 含"不能"/"禁止"/"必须"约束，
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
          });
        }
      }
    }

    // promise 冲突检查（openLoops 中的都是未解决的 promise，若正文声称解决则冲突）
    for (const loop of input.context.openLoops) {
      // openLoops 中的都是未解决的 promise，无需额外检查 resolved
      // 简单启发式：正文含 loop.description 的关键词 + "解决"/"完成"/"结束"
      const descKeywords = loop.description.split(/[\s，。；：、]+/).filter((k) => k.length >= 2);
      for (const keyword of descKeywords) {
        const pos = input.text.indexOf(keyword);
        if (pos < 0) continue;
        const window = input.text.slice(pos, Math.min(input.text.length, pos + keyword.length + 20));
        if (/解决|完成|结束|了结/.test(window)) {
          findings.push({
            id: `verifier:promise_conflict:${loop.id}:${keyword}`,
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
            confidence: 0.7,
            allowedRepairRange: {
              start: pos,
              end: Math.min(input.text.length, pos + keyword.length + 20),
              excerpt: window.slice(0, 60),
            },
            description: `promise 冲突：${loop.description}`,
          });
          break; // 每个 loop 只报一次
        }
      }
    }

    return findings;
  }

  // ── 内部：关键事件遗漏检查 ──────────────────────────────────────────

  /**
   * 检查 chapterIntent 中的关键事件是否在正文中遗漏。
   *
   * M1 启发式：
   * - 从 chapterIntent 提取引号内容、「关于X」的 X 作为关键事件关键词
   * - 若关键词在正文中完全不存在，标记为 intent_omission（severity=hard）
   * - 若关键词存在但出现次数 < 1，也标记
   */
  private checkIntentOmission(input: NarrativeVerifierInput): VerificationFinding[] {
    const findings: VerificationFinding[] = [];

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
        // 关键事件完全遗漏
        findings.push({
          id: `verifier:intent_omission:${keyword}`,
          source: "intent_omission_checker",
          failureType: "intent_omission",
          severity: "hard",
          span: { start: 0, end: 0, excerpt: "" },
          conflictFact: `chapterIntent 关键事件「${keyword}」在正文中完全遗漏`,
          sourceRef: `intent:${keyword}`,
          confidence: 0.85,
          allowedRepairRange: { start: 0, end: Math.min(input.text.length, 200), excerpt: "" },
          description: `关键事件遗漏：${keyword}`,
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
        });
      }
    }
    return findings;
  }

  // ── M1.1 内部：时间线连续性检查 ───────────────────────────────────

  /**
   * 检查时间线连续性：本章时间不得早于已记录的最新时间（M1.1 新增）。
   *
   * 从 context.facts 中提取时间锚点（含"上午/下午/X点/X时"的事实），
   * 取最大小时数作为基准。从正文中提取时间表达，
   * 若本章时间 < 锚点时间 → timeline_inconsistency hard finding。
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
        findings.push({
          id: `verifier:timeline_inconsistency:${pos}`,
          source: "timeline_consistency_checker",
          failureType: "timeline_inconsistency",
          severity: "hard",
          span: { start: pos, end: pos + m[0].length, excerpt: m[0] },
          conflictFact: `本章时间「${m[0]}」早于已记录的最新时间「${anchorHour}点」`,
          sourceRef: `timeline:anchor:${anchorHour}`,
          confidence: 0.8,
          allowedRepairRange: { start: pos, end: pos + m[0].length + 20, excerpt: m[0] },
          description: `时间回退：${m[0]} 早于第2章的 ${anchorHour} 点`,
        });
      }
    }
    return findings;
  }

  // ── M1.1 内部：位置连续性检查 ─────────────────────────────────────

  /**
   * 检查位置连续性：角色位置不得无过门跳转（M1.1 新增）。
   *
   * 从 context.facts 提取角色最新位置（含"位置"或位置关键词），
   * 若正文开头（前 100 字符）既不含原位置关键词也无过门词（走/跑/开车/前往/到达），
   * 且含跳跃词（立刻/瞬间/突然/马上/直接）→ location_discontinuity hard finding。
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
          findings.push({
            id: `verifier:location_discontinuity:${fact.id}`,
            source: "location_continuity_checker",
            failureType: "location_discontinuity",
            severity: "hard",
            span: { start: pos, end: pos + jumpMatch[0].length, excerpt: jumpMatch[0] },
            conflictFact: `角色位置无过门跳转：原位置「${locationPhrase}」，正文跳跃到「${jumpTarget}」`,
            sourceRef: `fact:${fact.id}`,
            confidence: 0.75,
            allowedRepairRange: { start: pos, end: pos + jumpMatch[0].length + 20, excerpt: jumpMatch[0] },
            description: `空间跳转：从「${locationPhrase}」跳跃到「${jumpTarget}」`,
          });
        }
      }
    }
    return findings;
  }

  // ── M1.1 内部：属性型事实矛盾检查 ─────────────────────────────────

  /**
   * 检查属性型 canon 事实矛盾（M1.1 新增）。
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
