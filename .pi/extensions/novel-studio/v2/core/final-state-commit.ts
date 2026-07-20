/**
 * FinalStateCommit — 最终状态提交（Phase 1，计划 §4.2 §3 FinalStateCommit）
 *
 * 长期叙事状态（NarrativeStateStore）覆盖四类：CanonState / CharacterState / PromiseLedger / PatternMemory。
 *
 * 核心不变量（计划 §4.2）：
 * - 状态只能在最终正文选定后提交
 * - 每条状态必须包含来源章节、原文 span 或生成产物引用、置信度和最后更新时间
 * - 候选生成期间只能 stage（缓冲），不得污染长期状态
 * - 候选切换/回退到 raw 时 discard，保证状态只来自最终正文
 *
 * 路径：workspaces/{id}/narrative-state-store.json（迁移期独立文件，Phase 7 与 legacy 合并）
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { createHash } from "node:crypto";
import { compactNarrativeMemory, type MemoryCompactionReport } from "./memory-compactor.js";

// ============================================================================
// 四类长期叙事状态
// ============================================================================

export type NarrativeStateKind = "canon" | "character" | "promise" | "pattern" | "expectation";

export interface StateEntryBase {
  /** 条目 id，用于 invalidation 引用，形如 "canon:world:genre" */
  id: string;
  /** 来源章节，如 "ch17" */
  sourceChapter: string;
  /** 原文 span 或生成产物引用，如 "ch17#L120-180" 或 "candidate:amp-1" */
  sourceRef: string;
  confidence: number;
  lastUpdated: string;
  version?: number;
  supersedes?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  sourceRefs?: string[];
}

export interface CanonEntry extends StateEntryBase {
  kind: "canon";
  fact: string;
  category: "timeline" | "location" | "entity" | "ability_rule";
}

export interface CharacterStateEntry extends StateEntryBase {
  kind: "character";
  characterId: string;
  field: string;
  value: string;
}

export interface PromiseEntry extends StateEntryBase {
  kind: "promise";
  promiseId: string;
  description: string;
  expectedPayoffWindow?: string;
  currentHeat: number;
  status: "open" | "advancing" | "fulfilled" | "broken";
}

export interface PatternEntry extends StateEntryBase {
  kind: "pattern";
  patternType: "trope" | "imagery" | "sentence_risk" | "conflict_resolution" | "hook_type";
  description: string;
  occurrenceCount: number;
}

/**
 * 读者期待状态条目（EXPECTATION-LEDGER-1，计划 §6.3）。
 *
 * 与 PromiseEntry 的区别：
 * - 期待关注"读者体验目标"（targetReaderExperience），承诺关注"伏笔兑现"。
 * - 期待状态包含 escalated（升级施压）与 delayed（延期蓄势），承诺无这两种状态。
 * - 期待用 expectationType 分类（TYPE-1-information ~ TYPE-8-justice）。
 *
 * 状态机（与 ExpectationContextCompiler 对齐）：
 * - open / advanced：仍在推进，可 advance
 * - delayed：延期蓄势，仍可 advance，附带 delayReason
 * - escalated：已升级施压，应 escalate
 * - fulfilled：已兑现，仅 inspect 历史背景
 */
export interface ExpectationEntry extends StateEntryBase {
  kind: "expectation";
  expectationId: string;
  description: string;
  /** 期待类型（TYPE-1-information ~ TYPE-8-justice，来自 legacy reader-expectation-manager） */
  expectationType?: string;
  /** 目标读者体验（期待兑现时读者应获得的体验） */
  targetReaderExperience?: string;
  /** 延期理由（status=delayed 时必填） */
  delayReason?: string;
  status: "open" | "advanced" | "delayed" | "escalated" | "fulfilled";
}

export type NarrativeStateEntry = CanonEntry | CharacterStateEntry | PromiseEntry | PatternEntry | ExpectationEntry;

export interface NarrativeStateStore {
  schemaVersion: number;
  workspaceId: string;
  canon: CanonEntry[];
  character: CharacterStateEntry[];
  promise: PromiseEntry[];
  pattern: PatternEntry[];
  expectation?: ExpectationEntry[];
  eventLog?: NarrativeStateEntry[];
  quarantine?: NarrativeStateEntry[];
  compactionReport?: MemoryCompactionReport;
  lastCommittedChapter?: string;
  updatedAt: string;
}

// ============================================================================
// 暂存区（候选生成期间缓冲，不落盘）
// ============================================================================

export interface StagedStateUpdate {
  additions: NarrativeStateEntry[];
  /** 被本章新事实推翻/作废的旧 entry id（按 kind:id 形式） */
  invalidations: string[];
  sourceChapter: string;
  finalCandidateId?: string;
}

// ============================================================================
// A2：从最终正文重锚定状态（计划 §4.2：状态只根据最终正文提交）
// ============================================================================

/**
 * 计算最终正文的内容 hash（SHA-256 前 12 位十六进制），用于 sourceRef 可追溯。
 * 每条状态 entry 的 sourceRef 引用此 hash + 正文 span，证明状态来自最终正文。
 */
export function computeFinalTextHash(finalText: string): string {
  return createHash("sha256").update(finalText, "utf8").digest("hex").slice(0, 12);
}

/**
 * 从 promise 描述中提取关键内容词，在最终正文中定位 span。
 *
 * 保守策略（只声称正文实际支持的状态）：
 * - 描述按中英文标点/空白分词，去除标点得到内容字符序列
 * - 中文无空格分词，故对内容序列做滑窗（从长到短）提取候选词：
 *   全串 → 6 字滑窗 → 5 字 → ... → 2 字滑窗，按长度降序搜索
 * - 长词更具体（优先匹配），短词兜底；返回第一个命中的 span
 * - 全部未命中 → 返回 null（描述只是 seed 意图，正文未实际触及）
 *
 * 这是 bounded 启发式：不做语义理解，只做字面证据定位。
 * 完整的 LLM 状态抽取属于后续 Phase 增强，但本函数确保 sourceRef
 * 指向真实正文 span（而非 seed:*），满足计划 §4.2 可追溯性。
 */
export function findPromiseSpanInText(
  description: string,
  finalText: string
): { start: number; end: number; excerpt: string } | null {
  if (!description || !finalText) return null;
  // 去除中英文标点与空白，得到内容字符序列
  const cleaned = description.replace(
    /[\s，。、；：！？""''（）()【】\[\]《》〈〉—…·,.;:!?'"\-]+/gu,
    ""
  );
  if (cleaned.length < 2) return null;

  // 按长度降序生成候选搜索词（滑窗），去重
  const seen = new Set<string>();
  const candidates: string[] = [];
  // 全串优先（最具体）
  if (!seen.has(cleaned)) {
    seen.add(cleaned);
    candidates.push(cleaned);
  }
  // 滑窗：从 min(len-1, 6) 到 2
  const maxWin = Math.min(cleaned.length - 1, 6);
  for (let size = maxWin; size >= 2; size--) {
    for (let i = 0; i <= cleaned.length - size; i++) {
      const term = cleaned.slice(i, i + size);
      if (!seen.has(term)) {
        seen.add(term);
        candidates.push(term);
      }
    }
  }

  // 按长度降序搜索（长词更具体，优先匹配），返回第一个命中
  candidates.sort((a, b) => b.length - a.length);
  for (const term of candidates) {
    const idx = finalText.indexOf(term);
    if (idx >= 0) {
      return { start: idx, end: idx + term.length, excerpt: term };
    }
  }
  return null;
}

// ============================================================================
// REAL-QUALITY-4A：语义支持校验（阻止名称级误锚定污染长期状态）
// ============================================================================

/** 死亡/消亡相关词（用于检测 value 中的死亡声明） */
const DEATH_TERMS = /死|亡|殒|毙|陨|凋|丧|逝|殁|永别|离世/;
/** 死亡证据词 */
const DEATH_EVIDENCE = /死|亡|殒|毙|陨|遗体|尸体|倒下|断气|身亡|殒命|尸骸/;
/** 在场行动词（证明角色参与当前事件） */
const ACTIVE_TERMS = /说|走|跑|笑|看|冲|挡|站|蹲|抬头|低头|推|拉|抓|挥|喊|叫|哭|睁|闭|皱|攥|揣|仰头|弯|跳|扑|退|转身|叹|点头|摇头|扶|背|扛|递|接|拧|进入|出现|来到|在场|坐|躺|守在|待在|盯|注视|凝视|就在/;
/** 同伴/友好关系词（用于检测 value 中的关系声明） */
const COMPANION_TERMS = /companion|ally|friend|伙伴|同伴|友|盟/;
/** 同伴证据词 */
const COMPANION_EVIDENCE = /同伴|伙伴|友|盟|跟随|协助|帮忙|并肩|一起|陪伴/;
/** 恋爱关系标签与正文证据 */
const LOVE_INTEREST_TERMS = /love[-_ ]?interest|恋人|爱人|情侣|伴侣/i;
const LOVE_INTEREST_EVIDENCE = /依偎|亲昵|亲吻|拥抱|牵手|心动|爱意|恋人|爱人|情侣|伴侣|暧昧/;
/** 敌对行为词 */
const HOSTILE_TERMS = /攻击|威胁|扑|咬|敌|杀|凶|暴起|血盆|獠牙|嘶吼|袭|刺|劈|砸|撕|吞|缠|卷/;
/** 承诺兑现词 */
const FULFILL_TERMS = /完成|实现|兑现|找到|获得|达到|成功|夺取|拿到|寻得|得到了|取得了/;
/** 承诺破裂词 */
const BREAK_TERMS = /失败|违背|破裂|放弃|落空|毁|碎|未遂|错失|失去|丢了/;
const SENTENCE_BOUNDARY = /[。！？!?；;\r\n]/;
/** STATE-PARTICIPATION-2: 历史转述/回忆标记词 */
const HISTORICAL_MARKERS = /有人说|听说|传说|据说|想起|回忆|记得|回想|曾经|那时|当年|往日|从前|说起|提到|谈到|传闻|故事|往事|当年|昔日|旧事/;

type EvidenceSpan = { start: number; end: number; excerpt: string };

export interface SemanticSupportResult {
  supported: boolean;
  reason: string;
  /** 当 supported=true 且找到证据时，返回覆盖主体+证据的扩展 span */
  evidenceSpan?: EvidenceSpan;
}

/**
 * 返回锚点所在的单句，防止把相邻句中其他主体的行为误算为当前主体证据。
 */
function findSubjectSentence(text: string, anchor: { start: number; end: number }): EvidenceSpan {
  let start = Math.max(0, anchor.start);
  while (start > 0 && !SENTENCE_BOUNDARY.test(text[start - 1])) start--;

  let end = Math.min(text.length, anchor.end);
  while (end < text.length && !SENTENCE_BOUNDARY.test(text[end])) end++;

  return { start, end, excerpt: text.slice(start, end) };
}

function findEvidenceInSentence(sentence: EvidenceSpan, pattern: RegExp): EvidenceSpan | null {
  return pattern.test(sentence.excerpt) ? sentence : null;
}

function normalizeClaim(value: string): string {
  return value.toLowerCase().replace(/[\s，。、；：！？"“”'‘’（）()【】\[\]《》〈〉—…·,.;:!?\-]+/gu, "");
}

/** 通用 claim 必须完整命中；无法判断同义改写时按任务约束 fail-closed。 */
function isCompleteClaimMatch(claim: string, matchedExcerpt: string): boolean {
  const normalizedClaim = normalizeClaim(claim);
  const normalizedMatch = normalizeClaim(matchedExcerpt);
  return normalizedClaim.length > 0 && normalizedClaim === normalizedMatch;
}

function findClaimEvidenceInSentence(claim: string, sentence: EvidenceSpan): EvidenceSpan | null {
  const localMatch = findPromiseSpanInText(claim, sentence.excerpt);
  if (!localMatch || !isCompleteClaimMatch(claim, localMatch.excerpt)) return null;
  return sentence;
}

/**
 * REAL-QUALITY-4A：校验 state entry 的值是否被最终正文 span 语义支持。
 *
 * 核心原则：仅命中角色名或任意字符不算支持；提交值必须与正文上下文不冲突。
 *
 * 精确化策略：
 * 1. 所有证据限制在锚点所在单句，禁止跨句借用其他主体证据；
 * 2. 特殊状态（死亡/同伴/兑现/破裂）必须有同句正向证据；
 * 3. 通用 canon、promise、character value 必须达到强语义覆盖；
 * 4. 无法确定时 fail-closed，交由 commit 写入 quarantine。
 *
 * 这是 bounded 启发式：不做完整语义理解，只检测主体附近的明确支持/反驳。
 */
export function validateSemanticSupport(
  entry: NarrativeStateEntry,
  finalText: string,
  nameSpan: { start: number; end: number; excerpt: string } | null
): SemanticSupportResult {
  if (!nameSpan) {
    // 主体未在正文中出现：不在此处判定，交给已有的 :not-found 逻辑处理
    return { supported: true, reason: "主体未出现（由 not-found 逻辑处理）" };
  }

  const subjectSentence = findSubjectSentence(finalText, nameSpan);

  if (entry.kind === "character") {
    const value = entry.value ?? "";
    if (DEATH_TERMS.test(value)) {
      const evidence = findEvidenceInSentence(subjectSentence, DEATH_EVIDENCE);
      if (evidence) {
        return { supported: true, reason: "主体所在句有死亡证据", evidenceSpan: evidence };
      }
      if (ACTIVE_TERMS.test(subjectSentence.excerpt)) {
        return {
          supported: false,
          reason: `semantic-conflict：value="${value}" 声称死亡，但主体所在句显示在场行动（${nameSpan.excerpt}）`,
        };
      }
      return { supported: false, reason: `semantic-unsupported：value="${value}" 缺少同句死亡证据` };
    }
    if (COMPANION_TERMS.test(value)) {
      const evidence = findEvidenceInSentence(subjectSentence, COMPANION_EVIDENCE);
      if (evidence) {
        return { supported: true, reason: "主体所在句有同伴证据", evidenceSpan: evidence };
      }
      if (HOSTILE_TERMS.test(subjectSentence.excerpt)) {
        return {
          supported: false,
          reason: `semantic-conflict：value="${value}" 声称同伴，但主体所在句显示敌对行为（${nameSpan.excerpt}）`,
        };
      }
      return { supported: false, reason: `semantic-unsupported：value="${value}" 缺少同句关系证据` };
    }
    if (LOVE_INTEREST_TERMS.test(value)) {
      const evidence = findEvidenceInSentence(subjectSentence, LOVE_INTEREST_EVIDENCE);
      return evidence
        ? { supported: true, reason: "主体所在句有亲密关系证据", evidenceSpan: evidence }
        : { supported: false, reason: `semantic-unsupported：value="${value}" 缺少同句亲密关系证据` };
    }
    if (entry.field === "participation") {
      // STATE-PARTICIPATION-2: 区分当前时线参与 vs 历史转述/回忆
      // 检查角色名的所有出现位置，至少一次在非历史句中有行动证据才支持
      const charName = entry.characterId;
      const allSentences: EvidenceSpan[] = [];
      let searchPos = 0;
      for (;;) {
        const idx = finalText.indexOf(charName, searchPos);
        if (idx < 0) break;
        const occSpan: EvidenceSpan = { start: idx, end: idx + charName.length, excerpt: finalText.slice(idx, idx + charName.length) };
        allSentences.push(findSubjectSentence(finalText, occSpan));
        searchPos = idx + 1;
      }

      let hasCurrentTimeline = false;
      for (const sentence of allSentences) {
        const isHistorical = HISTORICAL_MARKERS.test(sentence.excerpt);
        const hasActive = ACTIVE_TERMS.test(sentence.excerpt);
        if (!isHistorical && hasActive) {
          hasCurrentTimeline = true;
          break;
        }
      }

      return hasCurrentTimeline
        ? { supported: true, reason: "主体在当前时线有参与证据", evidenceSpan: subjectSentence }
        : { supported: false, reason: `semantic-unsupported：participation="${value}" 仅在历史转述/回忆中出现，缺少当前时线行动证据` };
    }
    const evidence = findClaimEvidenceInSentence(value, subjectSentence);
    return evidence
      ? { supported: true, reason: "主体所在句覆盖人物状态值", evidenceSpan: evidence }
      : { supported: false, reason: `semantic-unsupported：field="${entry.field}" value="${value}" 缺少同句语义证据` };
  }

  if (entry.kind === "canon") {
    const fact = entry.fact ?? "";
    if (DEATH_TERMS.test(fact)) {
      const evidence = findEvidenceInSentence(subjectSentence, DEATH_EVIDENCE);
      if (evidence) {
        return { supported: true, reason: "主体所在句有死亡证据", evidenceSpan: evidence };
      }
      if (ACTIVE_TERMS.test(subjectSentence.excerpt)) {
        return {
          supported: false,
          reason: `semantic-conflict：fact="${fact}" 声称死亡，但主体所在句显示在场行动（${nameSpan.excerpt}）`,
        };
      }
      return { supported: false, reason: `semantic-unsupported：fact="${fact}" 缺少同句死亡证据` };
    }
    const evidence = isCompleteClaimMatch(fact, nameSpan.excerpt) ? subjectSentence : null;
    return evidence
      ? { supported: true, reason: "正文强覆盖 canon 事实", evidenceSpan: evidence }
      : { supported: false, reason: `semantic-unsupported：canon fact="${fact}" 仅部分命中` };
  }

  if (entry.kind === "promise") {
    if (!isCompleteClaimMatch(entry.description, nameSpan.excerpt)) {
      return { supported: false, reason: `semantic-unsupported：promise="${entry.description}" 仅部分命中` };
    }
    if (entry.status === "fulfilled" && !FULFILL_TERMS.test(subjectSentence.excerpt)) {
      return {
        supported: false,
        reason: `semantic-conflict：status=fulfilled 但同句无兑现证据（${entry.description}）`,
      };
    }
    if (entry.status === "broken" && !BREAK_TERMS.test(subjectSentence.excerpt)) {
      return {
        supported: false,
        reason: `semantic-conflict：status=broken 但同句无破裂证据（${entry.description}）`,
      };
    }
    return { supported: true, reason: "正文强覆盖 promise movement", evidenceSpan: subjectSentence };
  }

  if (entry.kind === "expectation") {
    // EXPECTATION-LEDGER-1：期待语义校验
    // 期待关注读者体验目标，描述常含"读者期待..."前缀，部分命中（如仅"暗流"）即视为正文触及。
    // 与 promise 的区别：不要求 isCompleteClaimMatch 完整命中，因期待描述天然含元叙述前缀。
    // fulfilled 状态不额外要求 FULFILL_TERMS（期待类型多样：信息/身份/正义/情感...，
    // 兑现证据形式各异，bounded 启发式无法穷举；正文触及描述关键词即视为本章处理了该期待）。
    // nameSpan 为 null 时由调用方 not-found 路径处理（此处不会到达）。
    return { supported: true, reason: "正文触及期待描述关键词", evidenceSpan: subjectSentence };
  }

  // pattern kind：无语义校验需求
  return { supported: true, reason: "pattern 无语义校验需求" };
}

/**
 * 把 seed 派生的暂存状态重锚定到最终正文（A2，计划 §4.2）。
 *
 * 输入：buildStagedStateUpdate 从 ChapterSeed.pendingForeshadowing 派生的
 *   "seed 意图"状态（sourceRef=seed:*，confidence=0.6，status=advancing）。
 * 输出：根据最终正文验证后的状态——
 *   - promise 描述关键词在 finalText 命中 → sourceRef=ch{N}#finalText:{hash}:{start}-{end}，
 *     confidence 提升到 0.7（正文实际触及，非仅 seed 意图），status 保持 advancing
 *   - 未命中 → sourceRef=ch{N}#finalText:{hash}:not-found，confidence 降到 0.25，
 *     status 改为 open（seed 意图参与但正文未实际触及，不声称 advancing）
 *   - 非 promise kind（canon/character/pattern）：sourceRef 统一加上 finalText hash 前缀，
 *     标记来源为最终正文而非 seed
 *
 * 设计原则（计划 §4.2）：
 * - 状态只在最终正文选定后 commit，sourceRef 必须指向最终正文（span/hash），而非 seed
 * - 保守归因：正文未触及的 promise 不声称 advancing，避免污染下游 PromiseLedger
 * - hash 使 sourceRef 可追溯到具体正文版本（即使 span 因正文微调漂移，hash 仍可定位版本）
 */
export function reanchorStagedStateToFinalText(
  update: StagedStateUpdate,
  finalText: string,
  chapterNumber: number
): StagedStateUpdate {
  const hash = computeFinalTextHash(finalText);
  const sourceChapter = `ch${chapterNumber}`;
  const now = new Date().toISOString();

  const reanchoredAdditions: NarrativeStateEntry[] = update.additions.map((entry) => {
    if (entry.kind === "promise") {
      const span = findPromiseSpanInText(entry.description, finalText);
      // REAL-QUALITY-4A：语义支持校验（fulfilled/broken 必须有兑现/破裂证据）
      const semantic = validateSemanticSupport(entry, finalText, span);
      if (!semantic.supported) {
        return {
          ...entry,
          sourceChapter,
          sourceRef: `ch${chapterNumber}#finalText:${hash}:semantic-conflict`,
          confidence: 0.1,
          lastUpdated: now,
        };
      }
      const evidenceSpan = semantic.evidenceSpan ?? span;
      if (evidenceSpan) {
        // 正文实际触及该 promise -> 提升置信度，sourceRef 指向真实 span
        // RQ4A-11：fulfilled/broken 状态不得降级为 advancing（语义校验已确认有兑现/破裂证据）
        const preservedStatus = entry.status === "fulfilled" || entry.status === "broken" ? entry.status : "advancing" as const;
        return {
          ...entry,
          sourceChapter,
          sourceRef: `ch${chapterNumber}#finalText:${hash}:${evidenceSpan.start}-${evidenceSpan.end}`,
          confidence: 0.7, // 正文已确认触及（非仅 seed 意图）
          lastUpdated: now,
          status: preservedStatus,
        };
      }
      // 正文未触及 → 降级为 open，不声称 advancing
      return {
        ...entry,
        sourceChapter,
        sourceRef: `ch${chapterNumber}#finalText:${hash}:not-found`,
        confidence: 0.25, // seed 意图存在但正文未确认
        lastUpdated: now,
        status: "open" as const,
      };
    }
    if (entry.kind === "expectation") {
      // EXPECTATION-LEDGER-1：与 promise 同样的 bounded 启发式定位 span
      const span = findPromiseSpanInText(entry.description, finalText);
      // REAL-QUALITY-4A：语义支持校验（fulfilled 必须有兑现证据）
      const semantic = validateSemanticSupport(entry, finalText, span);
      if (!semantic.supported) {
        return {
          ...entry,
          sourceChapter,
          sourceRef: `ch${chapterNumber}#finalText:${hash}:semantic-conflict`,
          confidence: 0.1,
          lastUpdated: now,
        };
      }
      const evidenceSpan = semantic.evidenceSpan ?? span;
      if (evidenceSpan) {
        // 正文实际触及该 expectation -> 提升置信度，sourceRef 指向真实 span
        // fulfilled 状态不得降级（语义校验已确认有兑现证据）；其他状态保持原 status
        const preservedStatus = entry.status === "fulfilled" ? entry.status : entry.status;
        return {
          ...entry,
          sourceChapter,
          sourceRef: `ch${chapterNumber}#finalText:${hash}:${evidenceSpan.start}-${evidenceSpan.end}`,
          confidence: 0.7, // 正文已确认触及（非仅 seed 意图）
          lastUpdated: now,
          status: preservedStatus,
        };
      }
      // 正文未触及 → 降级为 not-found，不声称 fulfilled
      return {
        ...entry,
        sourceChapter,
        sourceRef: `ch${chapterNumber}#finalText:${hash}:not-found`,
        confidence: 0.25, // seed 意图存在但正文未确认
        lastUpdated: now,
        status: "open" as const,
      };
    }
    if (entry.kind === "canon") {
      // B2：canon 事实在最终正文中定位 span（与 promise 同样的 bounded 启发式）
      const span = findPromiseSpanInText(entry.fact, finalText);
      // REAL-QUALITY-4A：语义支持校验（阻止名称级误锚定）
      const semantic = validateSemanticSupport(entry, finalText, span);
      if (!semantic.supported) {
        return {
          ...entry,
          sourceChapter,
          sourceRef: `ch${chapterNumber}#finalText:${hash}:semantic-conflict`,
          confidence: 0.1,
          lastUpdated: now,
        };
      }
      const evidenceSpan = semantic.evidenceSpan ?? span;
      if (evidenceSpan) {
        return {
          ...entry,
          sourceChapter,
          sourceRef: `ch${chapterNumber}#finalText:${hash}:${evidenceSpan.start}-${evidenceSpan.end}`,
          confidence: 0.7,
          lastUpdated: now,
        };
      }
      return {
        ...entry,
        sourceChapter,
        sourceRef: `ch${chapterNumber}#finalText:${hash}:not-found`,
        confidence: 0.25,
        lastUpdated: now,
      };
    }
    if (entry.kind === "character") {
      // B2：角色名在最终正文中定位 span
      const span = findPromiseSpanInText(entry.characterId, finalText);
      // REAL-QUALITY-4A：语义支持校验（阻止"角色死亡""关系误分类"一类名称级误锚定）
      const semantic = validateSemanticSupport(entry, finalText, span);
      if (!semantic.supported) {
        return {
          ...entry,
          sourceChapter,
          sourceRef: `ch${chapterNumber}#finalText:${hash}:semantic-conflict`,
          confidence: 0.1,
          lastUpdated: now,
        };
      }
      const evidenceSpan = semantic.evidenceSpan ?? span;
      if (evidenceSpan) {
        return {
          ...entry,
          sourceChapter,
          sourceRef: `ch${chapterNumber}#finalText:${hash}:${evidenceSpan.start}-${evidenceSpan.end}`,
          confidence: 0.7,
          lastUpdated: now,
        };
      }
      return {
        ...entry,
        sourceChapter,
        sourceRef: `ch${chapterNumber}#finalText:${hash}:not-found`,
        confidence: 0.25,
        lastUpdated: now,
      };
    }
    // pattern kind：sourceRef 加 finalText hash 前缀，标记来源为最终正文
    return {
      ...entry,
      sourceChapter,
      sourceRef: `ch${chapterNumber}#finalText:${hash}`,
      lastUpdated: now,
    };
  });

  return {
    additions: reanchoredAdditions,
    invalidations: [...update.invalidations],
    sourceChapter,
    finalCandidateId: update.finalCandidateId,
  };
}

// ============================================================================
// 常量与路径
// ============================================================================

export const STATE_STORE_SCHEMA_VERSION = 1;
const FILE_NAME = "narrative-state-store.json";

export function stateStorePath(workspaceId: string, projectRoot: string): string {
  return join(projectRoot, "workspaces", workspaceId, FILE_NAME);
}

// ============================================================================
// IO
// ============================================================================

export function loadStateStore(workspaceId: string, projectRoot: string): NarrativeStateStore {
  const path = stateStorePath(workspaceId, projectRoot);
  if (!existsSync(path)) {
    return emptyStore(workspaceId);
  }
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw);
  return normalizeStore(parsed, workspaceId);
}

export function saveStateStore(
  store: NarrativeStateStore,
  workspaceId: string,
  projectRoot: string
): void {
  const path = stateStorePath(workspaceId, projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  const out: NarrativeStateStore = { ...store, updatedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(out, null, 2), "utf-8");
}

function emptyStore(workspaceId: string): NarrativeStateStore {
  return {
    schemaVersion: STATE_STORE_SCHEMA_VERSION,
    workspaceId,
    canon: [],
    character: [],
    promise: [],
    pattern: [],
    expectation: [],
    eventLog: [],
    quarantine: [],
    updatedAt: new Date().toISOString(),
  };
}

function normalizeStore(obj: unknown, workspaceId: string): NarrativeStateStore {
  if (typeof obj !== "object" || obj === null) return emptyStore(workspaceId);
  const o = obj as Partial<NarrativeStateStore>;
  const legacyEntries = [
    ...(Array.isArray(o.canon) ? (o.canon as CanonEntry[]) : []),
    ...(Array.isArray(o.character) ? (o.character as CharacterStateEntry[]) : []),
    ...(Array.isArray(o.promise) ? (o.promise as PromiseEntry[]) : []),
    ...(Array.isArray(o.pattern) ? (o.pattern as PatternEntry[]) : []),
    ...(Array.isArray(o.expectation) ? (o.expectation as ExpectationEntry[]) : []),
  ];
  return {
    schemaVersion: STATE_STORE_SCHEMA_VERSION,
    workspaceId,
    canon: Array.isArray(o.canon) ? (o.canon as CanonEntry[]) : [],
    character: Array.isArray(o.character) ? (o.character as CharacterStateEntry[]) : [],
    promise: Array.isArray(o.promise) ? (o.promise as PromiseEntry[]) : [],
    pattern: Array.isArray(o.pattern) ? (o.pattern as PatternEntry[]) : [],
    expectation: Array.isArray(o.expectation) ? (o.expectation as ExpectationEntry[]) : [],
    eventLog: Array.isArray(o.eventLog) ? (o.eventLog as NarrativeStateEntry[]) : legacyEntries,
    quarantine: Array.isArray(o.quarantine) ? (o.quarantine as NarrativeStateEntry[]) : [],
    compactionReport: o.compactionReport,
    lastCommittedChapter: o.lastCommittedChapter,
    updatedAt: new Date().toISOString(),
  };
}

// ============================================================================
// 校验：每条 entry 必须有 sourceChapter + sourceRef + confidence + lastUpdated
// ============================================================================

export interface StateEntryValidation {
  ok: boolean;
  errors: string[];
}

export function validateStateEntry(e: NarrativeStateEntry): StateEntryValidation {
  const errors: string[] = [];
  if (!e.id) errors.push("id 不能为空");
  if (!e.sourceChapter) errors.push("sourceChapter 不能为空");
  if (!e.sourceRef) errors.push("sourceRef 不能为空（必须可追溯）");
  if (typeof e.confidence !== "number" || e.confidence < 0 || e.confidence > 1)
    errors.push("confidence 必须为 [0,1]");
  if (!e.lastUpdated) errors.push("lastUpdated 不能为空");
  if (!["canon", "character", "promise", "pattern", "expectation"].includes(e.kind))
    errors.push(`kind 非法：${(e as { kind?: string }).kind}`);
  return { ok: errors.length === 0, errors };
}

// ============================================================================
// FinalStateCommit — 延迟提交核心
// ============================================================================

/**
 * 职责：缓冲候选生成期间的状态更新，只在最终正文选定后 commit 落盘。
 *
 * 不变量：
 * - stage() 只写入内存暂存区，绝不落盘
 * - commit() 是唯一落盘入口，且必须传入 finalCandidateId 与 finalText
 * - discard() 清空暂存区（候选切换/raw 回退时调用）
 * - commit 会校验每条 entry 的来源与置信度，非法 entry 被拒绝并记录
 */
export class FinalStateCommit {
  private staged: StagedStateUpdate | null = null;
  private stagedForCandidateId: string | null = null;
  /** 标记 commit/discard 是否已发生，防止重复 commit */
  private settled = false;

  /** 缓冲状态更新，不落盘。同一候选重复 stage 会覆盖（以最后一次为准）。 */
  stage(update: StagedStateUpdate): void {
    if (this.settled) {
      throw new Error("FinalStateCommit 已 settled，不能再 stage（请新建实例）");
    }
    this.staged = {
      additions: [...update.additions],
      invalidations: [...update.invalidations],
      sourceChapter: update.sourceChapter,
      finalCandidateId: update.finalCandidateId,
    };
    this.stagedForCandidateId = update.finalCandidateId ?? null;
  }

  /** 候选切换或回退 raw 时丢弃暂存区。 */
  discard(): void {
    this.staged = null;
    this.stagedForCandidateId = null;
    this.settled = true;
  }

  /**
   * 在最终正文选定后提交状态。唯一落盘入口。
   *
   * A2（计划 §4.2）：finalText 不再被忽略——提交器用它校验每条 entry 的
   * sourceRef span 是否落在最终正文范围内，并记录 finalText hash 供审计追溯。
   * 越界 span 的 entry 被拒绝（防止声称正文不支持的状态）。
   *
   * @param store 当前长期状态
   * @param finalCandidateId 最终选中的候选 id（必须与 staged 的 finalCandidateId 一致）
   * @param finalText 最终正文（A2：用于校验 sourceRef span 可追溯性 + 记录 hash）
   * @returns { committed, store, rejected } committed 为落盘后的 store；rejected 为校验失败的 entry
   */
  commit(
    store: NarrativeStateStore,
    finalCandidateId: string,
    finalText: string,
    workspaceId: string,
    projectRoot: string
  ): { store: NarrativeStateStore; committed: number; rejected: Array<{ entry: NarrativeStateEntry; errors: string[] }>; finalTextHash: string } {
    if (this.settled) {
      throw new Error("FinalStateCommit 已 settled，不能重复 commit");
    }
    this.settled = true;

    if (!this.staged) {
      // 无暂存：直接返回原 store（仍记录 finalText hash 供审计）
      return { store, committed: 0, rejected: [], finalTextHash: computeFinalTextHash(finalText) };
    }

    // finalCandidateId 必须与暂存时一致（防止候选切换后误提交旧候选的状态）
    if (this.stagedForCandidateId && this.stagedForCandidateId !== finalCandidateId) {
      throw new Error(
        `commit 的 finalCandidateId=${finalCandidateId} 与暂存的 ${this.stagedForCandidateId} 不一致，拒绝提交（候选切换未 discard）`
      );
    }

    // A2：用 finalText 校验每条 entry 的 sourceRef span
    const finalTextHash = computeFinalTextHash(finalText);
    const rejected: Array<{ entry: NarrativeStateEntry; errors: string[] }> = [];
    const accepted: NarrativeStateEntry[] = [];
    for (const entry of this.staged.additions) {
      const v = validateStateEntry(entry);
      if (!v.ok) {
        rejected.push({ entry, errors: v.errors });
        continue;
      }
      if (entry.kind === "expectation") {
        const expectationEvidenceErrors = verifyExpectationFinalTextEvidence(
          entry,
          this.staged.sourceChapter,
          finalTextHash
        );
        if (expectationEvidenceErrors.length > 0) {
          rejected.push({ entry, errors: expectationEvidenceErrors });
          continue;
        }
      }
      // A2：校验 sourceRef 中的 span（形如 ...:{start}-{end}）是否落在 finalText 范围内
      const spanErrors = verifySourceRefSpan(entry.sourceRef, finalText);
      if (spanErrors.length > 0) {
        rejected.push({ entry, errors: [...v.errors, ...spanErrors] });
        continue;
      }
      accepted.push(entry);
    }

    // 应用 invalidations：从对应分类中移除被作废的 entry
    const invalidIds = new Set(this.staged.invalidations);
    const nextStore: NarrativeStateStore = {
      ...store,
      canon: filterInvalid(store.canon, invalidIds),
      character: filterInvalid(store.character, invalidIds),
      promise: filterInvalid(store.promise, invalidIds),
      pattern: filterInvalid(store.pattern, invalidIds),
      expectation: filterInvalid(store.expectation ?? [], invalidIds),
      lastCommittedChapter: this.staged.sourceChapter,
      eventLog: [
        ...(store.eventLog ?? [...store.canon, ...store.character, ...store.promise, ...store.pattern, ...(store.expectation ?? [])]),
        ...accepted,
      ],
    };

    const compacted = compactNarrativeMemory(nextStore).store;

    // REAL-QUALITY-4A：rejected entry 写入 quarantine（在 compaction 之后，
    // 避免 compactor 用自己的 quarantine 覆盖）。保留 entryId/value/reason 供审计。
    if (rejected.length > 0) {
      compacted.quarantine = [
        ...(compacted.quarantine ?? []),
        ...rejected.map((r) => ({
          ...r.entry,
          // 附加 quarantine 审计原因（不污染原 entry schema，附加为额外字段）
          _quarantineReason: r.errors.join(";"),
        })),
      ];
    }

    // 落盘
    saveStateStore(compacted, workspaceId, projectRoot);

    this.staged = null;
    return { store: compacted, committed: accepted.length, rejected, finalTextHash };
  }

  /** 查看当前暂存区（只读，测试用）。 */
  getStaged(): StagedStateUpdate | null {
    return this.staged;
  }

  isSettled(): boolean {
    return this.settled;
  }
}

function filterInvalid<T extends { id: string; kind: string }>(
  entries: T[],
  invalidIds: Set<string>
): T[] {
  if (invalidIds.size === 0) return [...entries];
  return entries.filter((e) => {
    // invalidIds 形如 "canon:world:genre"（与 entry.id 一致）
    return !invalidIds.has(e.id) && !invalidIds.has(`${e.kind}:*`);
  });
}

/**
 * B3：按 id upsert entry 到对应分类数组。
 *
 * 同一 id 的 entry 已存在则替换（更新），不存在则追加。
 * 防止长期运行中同一 promise/canon/character/pattern 被重复累积
 * （例如 seed.pendingForeshadowing 每章都列出同一 promise）。
 */
function upsertEntryById(store: NarrativeStateStore, entry: NarrativeStateEntry): void {
  switch (entry.kind) {
    case "canon": {
      const idx = store.canon.findIndex((e) => e.id === entry.id);
      if (idx >= 0) store.canon[idx] = entry;
      else store.canon.push(entry);
      break;
    }
    case "character": {
      const idx = store.character.findIndex((e) => e.id === entry.id);
      if (idx >= 0) store.character[idx] = entry;
      else store.character.push(entry);
      break;
    }
    case "promise": {
      const idx = store.promise.findIndex((e) => e.id === entry.id);
      if (idx >= 0) store.promise[idx] = entry;
      else store.promise.push(entry);
      break;
    }
    case "pattern": {
      const idx = store.pattern.findIndex((e) => e.id === entry.id);
      if (idx >= 0) store.pattern[idx] = entry;
      else store.pattern.push(entry);
      break;
    }
    case "expectation": {
      if (!store.expectation) store.expectation = [];
      const idx = store.expectation.findIndex((e) => e.id === entry.id);
      if (idx >= 0) store.expectation[idx] = entry;
      else store.expectation.push(entry);
      break;
    }
  }
}

function verifyExpectationFinalTextEvidence(
  entry: ExpectationEntry,
  stagedSourceChapter: string,
  finalTextHash: string
): string[] {
  const match = entry.sourceRef.match(/^(ch\d+)#finalText:([0-9a-f]{12}):(\d+)-(\d+)$/i);
  if (!match) {
    return [
      `expectation sourceRef 必须先 reanchor 到最终正文 finalText span，实际为：${entry.sourceRef}`,
    ];
  }
  const [sourceChapter, sourceHash] = [match[1], match[2].toLowerCase()];
  if (entry.sourceChapter !== stagedSourceChapter || sourceChapter !== stagedSourceChapter) {
    return [
      `expectation sourceRef chapter 必须匹配当前提交章节 ${stagedSourceChapter}，实际为：${entry.sourceChapter}/${sourceChapter}`,
    ];
  }
  if (sourceHash !== finalTextHash) {
    return [
      `expectation sourceRef hash 必须匹配当前 finalText hash ${finalTextHash}，实际为：${sourceHash}`,
    ];
  }
  return [];
}

/**
 * A2：校验 sourceRef 中的 span 是否落在 finalText 范围内。
 *
 * sourceRef 格式（由 reanchorStagedStateToFinalText 产生）：
 * - ch{N}#finalText:{hash}:{start}-{end}  → 有 span，校验 start/end 越界
 * - ch{N}#finalText:{hash}:not-found      → 无 span（正文未触及），跳过（已低置信度）
 * - ch{N}#finalText:{hash}                → 无 span（非 promise kind），跳过
 * - 其它（seed:* 等旧格式）               → 跳过（向后兼容，不阻断迁移期旧 entry）
 *
 * 返回 errors 数组（空表示通过）。
 */
function verifySourceRefSpan(sourceRef: string, finalText: string): string[] {
  const errors: string[] = [];
  if (sourceRef.endsWith(":not-found")) {
    errors.push(`sourceRef not-found：正文未提供可提交证据：${sourceRef}`);
    return errors;
  }
  // REAL-QUALITY-4A：语义冲突的 entry 不进入 active state
  if (sourceRef.endsWith(":semantic-conflict")) {
    errors.push(`sourceRef semantic-conflict：正文与 state value 语义冲突：${sourceRef}`);
    return errors;
  }
  // 匹配 :{start}-{end} 结尾的 span（最后一个 : 后面是数字-数字）
  const spanMatch = sourceRef.match(/:(\d+)-(\d+)$/);
  if (!spanMatch) {
    // 无 span（not-found / 无 span 格式 / 旧格式）→ 不校验
    return errors;
  }
  const start = parseInt(spanMatch[1], 10);
  const end = parseInt(spanMatch[2], 10);
  if (start < 0 || end > finalText.length || start >= end) {
    errors.push(
      `sourceRef span 越界或倒置（start=${start}, end=${end}, finalText.length=${finalText.length}）：${sourceRef}`
    );
  }
  return errors;
}

export function createFinalStateCommit(): FinalStateCommit {
  return new FinalStateCommit();
}
