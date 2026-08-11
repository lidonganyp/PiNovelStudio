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

import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { join, dirname } from "path";
import { createHash } from "node:crypto";
import { compactNarrativeMemory, type MemoryCompactionReport } from "./memory-compactor.js";
// MEMORY-RECORD-1：长期记忆信封 + receipt 集成
import { stateEntryToMemoryRecord } from "./memory/memory-factory.js";
import {
  validateMemoryRecord,
  type MemoryRecord,
} from "./memory/memory-record.js";
import {
  detectMemoryConflicts,
  buildMemoryCommitReceipt,
  validateStagedMemoryUpdate,
  type MemoryCommitReceipt,
  type MemoryConflictRecord,
  type StagedMemoryUpdate,
} from "./memory/memory-transaction.js";
import {
  buildMemoryHardConflictEnvelope,
  MemoryHardConflictError,
  type MemoryConflictEnvelope,
} from "./memory/memory-lifecycle.js";

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
  /**
   * MEMORY-RECORD-1：权威记忆信封（可选）。
   * 由 commit() 在最终正文提交时附加到 accepted entry，供权威检索/回源/TTL 消费。
   * 旧 reader 忽略该字段，向后兼容。
   */
  memory?: import("./memory/memory-record.js").MemoryRecord;
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
  /**
   * REM 字段扩展（EXPECTATION-LEDGER-1，2026-07-21）：
   * 让期待账本具备完整生命周期追溯能力，使 buildOverdueAlerts 不再
   * 只依赖 status=delayed/escalated，而是按 overdueWindow.latest 计算
   * 实际逾期程度。
   */
  /** 创建该期待的章节（如 "ch3"） */
  createdChapter?: string;
  /** 上次推进/激活该期待的章节（status=advanced/delayed/escalated 时填写） */
  lastAdvancedChapter?: string;
  /** 上次兑现该期待的章节（status=fulfilled 时填写） */
  lastFulfilledChapter?: string;
  /**
   * 独立逾期窗口（章节号）。
   * - earliest：最早可兑现章节（在此之前兑现会显得仓促）
   * - optimal：最佳兑现章节（叙事节奏上最合适的兑现时机）
   * - latest：最晚兑现章节（超过此章节视为逾期，触发 escalated）
   * 三者均可空：null 表示无约束/未指定。
   */
  overdueWindow?: {
    earliest: number | null;
    optimal: number | null;
    latest: number | null;
  };
  /** 关联弧线 id 列表（ClosureTracker 的 arc.id） */
  relatedArcIds?: string[];
  /** 关联角色 id 列表（与 CharacterStateEntry.characterId 对齐） */
  relatedCharacterIds?: string[];
  /** 关联伏笔 id 列表（与 PromiseEntry.promiseId 对齐） */
  relatedForeshadowIds?: string[];
  /** Explicit evidence that an associated story arc itself changed state. */
  arcTransitionEvidence?: Array<{
    arcId: string;
    newStatus: "climaxed";
    sourceRef: string;
    confirmedBy: "author" | "human" | "llm";
  }>;
}

export type NarrativeStateEntry = CanonEntry | CharacterStateEntry | PromiseEntry | PatternEntry | ExpectationEntry;

// ============================================================================
// Phase 3D：计划状态（PlannedState）— 与 VerifiedState 分裂存储
//
// 计划状态来自 ChapterSeed/Intent，在生成前就存在；VerifiedState 从最终正文
// 提取，在保存后提交。两者分开存储，让 Preflight 能区分"作者意图"与"已发生事实"，
// 并为下一章连续性检查提供计划上下文（不污染权威状态）。
//
// 核心不变量（计划 §3D）：
// - planned 字段只存 PlannedStateEntry，不与 canon/character/promise 等权威字段混合
// - PlannedStateEntry.verified 标记是否已在 VerifiedState 中找到对应条目
// - PlannedStateEntry 不参与 PromiseLedger / CanonState 的权威查询
// - 计划状态可被下一章 Preflight 读取，作为"作者曾意图在本章处理"的参考
// ============================================================================

export interface PlannedStateEntry extends StateEntryBase {
  /** 计划状态类型，与 NarrativeStateEntry.kind 对齐（不含 pattern，pattern 是正文派生） */
  plannedKind: "canon" | "character" | "promise" | "expectation";
  /** 计划内容描述（canon.fact / character.value / promise.description / expectation.description） */
  plannedContent: string;
  /** 计划来源：chapter_seed（seed 派生）或 chapter_intent（intent 派生） */
  plannedSource: "chapter_seed" | "chapter_intent";
  /** 计划字段子类型（如 character.field=realm/participation，promise.status 等） */
  plannedField?: string;
  /** 是否已在最终正文证实的 VerifiedState 中找到对应条目 */
  verified: boolean;
  /** 对应的 VerifiedState entry id（若 verified=true） */
  verifiedEntryId?: string;
  /** 计划状态在最终正文中的验证结果（hit/miss/conflict） */
  verificationOutcome?: "hit" | "miss" | "conflict";
}

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
  /** Phase 3D：计划状态（来自 ChapterSeed/Intent，非权威，供 Preflight 连续性参考） */
  planned?: PlannedStateEntry[];
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
/**
 * P0-2c: 全局版死亡词（用于 .replace() 移除所有死亡相关字符）。
 *
 * DEATH_TERMS 不带 g flag，.replace() 只移除首个匹配，
 * 导致 "叶尘死亡" → "叶尘亡"（残留 "亡"）→ charName 错误。
 * 此全局版本确保 .replace() 移除全部死亡词，正确提取角色名。
 */
const DEATH_TERMS_GLOBAL = /死|亡|殒|毙|陨|凋|丧|逝|殁|永别|离世/g;
/** 死亡证据词 */
const DEATH_EVIDENCE = /死|亡|殒|毙|陨|遗体|尸体|倒下|断气|身亡|殒命|尸骸/;
/** 在场行动词（证明角色参与当前事件） */
const ACTIVE_TERMS = /说|走|跑|笑|看|冲|挡|站|蹲|抬头|低头|推|拉|抓|挥|喊|叫|哭|睁|闭|皱|攥|揣|仰头|弯|跳|扑|退|转身|叹|点头|摇头|扶|背|扛|递|接|拧|进入|出现|来到|在场|坐|躺|守在|待在|盯|注视|凝视|就在|等待|等候/;
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
/**
 * P0-2: 在场/参与否定模式。
 * 匹配 "不在场"/"未到场"/"没有来"/"不会来"/"缺席" 等否定参与的表达。
 * 当句子含角色名且匹配此模式时，不应作为 participation=present 的证据。
 */
const PRESENCE_NEGATION = /不在场|未到场|没有来|不会来|没来|缺席|不在|未出现|没有出现|不参与|未参与|未曾参与|未至|缺席|没有出席|未出席/;

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

/**
 * P0-2b/P0-2c: 将句子按子句标点拆分为子句列表。
 * 用于验证角色名与状态值（境界/死亡等）是否在同一子句中，
 * 防止多角色句子中把其他角色的状态误锚定到目标角色。
 */
function splitIntoClauses(sentence: string): string[] {
  return sentence
    .split(/[，,；;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * P0-2b/P0-2c: 找到包含指定角色名的子句。
 * 返回该子句文本，若角色名不在任何子句中则返回 null。
 */
function findClauseWithCharacter(sentence: string, characterName: string): string | null {
  const clauses = splitIntoClauses(sentence);
  return clauses.find((c) => c.includes(characterName)) ?? null;
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

// ============================================================================
// P0 第七轮辅助函数：alias 规范化 + 跨句代词指代解析
// ============================================================================

/**
 * P0 第七轮 P1 修复：把文本中的角色别名规范化为 canonical 名。
 *
 * 用于境界主体绑定：句子中的别名（如 "小尘"）替换为 canonical 名（如 "叶尘"）后，
 * 再做角色存在性判断，避免 canonical 角色 "叶尘" 的境界被别名 "小尘" 误判为"其他角色"。
 *
 * 与 Story Preservation Gate（editorial-story-preservation-gate）共用同一映射来源，
 * 保证 extractEvents 与 FinalStateCommit 的角色身份判定一致。
 *
 * 实现注意：按别名长度降序替换，避免短别名先替换破坏长别名（如 "小尘" vs "小尘埃"）。
 * 仅替换 alias !== canonical 且长度 >= 2 的别名；未提供映射时原样返回。
 */
function normalizeAliasesInText(
  text: string,
  aliasToCanonical?: Map<string, string>,
): string {
  if (!aliasToCanonical || aliasToCanonical.size === 0) return text;
  const aliases = Array.from(aliasToCanonical.entries())
    .filter(([alias, canonical]) => alias !== canonical && alias.length >= 2)
    .sort((a, b) => b[0].length - a[0].length);
  let result = text;
  for (const [alias, canonical] of aliases) {
    if (result.includes(alias)) {
      result = result.split(alias).join(canonical);
    }
  }
  return result;
}

/**
 * P0 第七轮 P1 修复：从 characterNames（含别名）构建 canonical 角色名集合。
 *
 * characterNames 由 unified-entry 从 seed.characters（name + aliases）扁平化而来，
 * 同时包含 canonical 名和别名。本函数把每个名字映射到 canonical 名后去重，
 * 得到"本章所有 canonical 角色名"集合，用于：
 *   - 判断境界句是否含其他 canonical 角色
 *   - 判断场景是否为单角色（canonical 集合大小）
 *   - 跨句代词指代解析时在前句中查找已知角色
 */
function buildCanonicalNameSet(
  characterNames: string[],
  aliasToCanonical?: Map<string, string>,
): Set<string> {
  const set = new Set<string>();
  for (const name of characterNames) {
    const canonical = aliasToCanonical?.get(name) ?? name;
    if (canonical.length >= 2) set.add(canonical);
  }
  return set;
}

/**
 * P0 第七轮 P0 修复：跨句代词指代解析。
 *
 * 用户验收反例（第七轮）：
 *   "林默抬起头。他已是筑基期。叶尘在门外等待。" + 叶尘 realm=筑基期
 *   "林默站在门前。此人已达筑基期。叶尘仍未赶到。" + 叶尘 realm=筑基期
 *   "林默看向远方。其修为已至筑基期。叶尘在门外等待。" + 叶尘 realm=筑基期
 *
 * 旧逻辑只检查境界所在句有没有角色姓名，未处理代词主体指代前句角色，
 * 导致境界归属被误判为单角色场景而通过。
 *
 * 算法（bounded 启发式，无 LLM）：
 * 1. 检测境界句是否以代词开头（他/她/它/此人/其/这/那/该/这家伙/那人）
 *    - 不以代词开头 → 返回 null（非代词主体句，交由单角色场景判断）
 * 2. 从境界句起点向前找前一句（跳过句末标点）
 * 3. 在前句中查找第一个 canonical 角色名作为代词指代对象
 *    - 找到 → 返回该 canonical 名
 *    - 未找到（前句无已知角色）→ 返回 null（代词无法解析）
 *
 * 返回值：
 *   - canonical 角色名：代词已解析到该角色
 *   - null：非代词句，或代词无法解析（调用方决定是否 fail-closed）
 */
const PRONOUN_START_PATTERN = /^(他|她|它|此人|其|这|那|该|这家伙|那人|此人)/;

function resolvePronounSubject(
  finalText: string,
  subjectSentence: EvidenceSpan,
  canonicalNames: Set<string>,
): string | null {
  const sentenceText = subjectSentence.excerpt.trimStart();
  if (!PRONOUN_START_PATTERN.test(sentenceText)) {
    return null; // 非代词主体句
  }

  // 从境界句起点向前定位前一句
  let prevEnd = subjectSentence.start;
  // 跳过境界句前的句末标点（。！？；等）
  while (prevEnd > 0 && SENTENCE_BOUNDARY.test(finalText[prevEnd - 1])) {
    prevEnd--;
  }
  if (prevEnd === 0) return null; // 无前句

  // 向前扩展到前一句的起点
  let prevStart = prevEnd;
  while (prevStart > 0 && !SENTENCE_BOUNDARY.test(finalText[prevStart - 1])) {
    prevStart--;
  }

  const prevSentence = finalText.slice(prevStart, prevEnd);
  if (prevSentence.length === 0) return null;

  // 在前句中查找 canonical 角色名（按长度降序，优先匹配长名，避免 "林默" vs "林" 的子串问题）。
  // 若前句同时出现多个角色，代词主体无法由 bounded 规则可靠确定，必须
  // 返回 null 让调用方在多角色场景下 fail-closed，不能依赖 characterNames 数组顺序。
  const sortedNames = Array.from(canonicalNames)
    .filter((n) => n.length >= 2)
    .sort((a, b) => b.length - a.length);
  const namesInPreviousSentence = sortedNames.filter((name) =>
    prevSentence.includes(name),
  );
  if (namesInPreviousSentence.length !== 1) {
    return null; // 无角色或多个角色：代词归属不确定，调用方应 fail-closed
  }
  return namesInPreviousSentence[0]!;
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
  nameSpan: { start: number; end: number; excerpt: string } | null,
  /**
   * P0 第六轮结构化绑定：本章已知角色名（含别名）。
   *
   * 由生产路径（reanchorStagedStateToFinalText ← orchestrator-commit-save）传入
   * input.characterNames（含 aliases）。提供时，境界主体归属改用结构化判断——
   * 句中存在其他角色且不含目标角色 → fail-closed，不再依赖动词正则补丁。
   * 未提供（旧测试兼容）时回退到 REALM_ENTRY_VERBS + 后置定语检测。
   */
  characterNames?: string[],
  /**
   * P0 第七轮 P1 修复：别名→规范名映射（alias → canonical character name）。
   *
   * 由生产路径（reanchorStagedStateToFinalText ← orchestrator-commit-save）传入
   * input.aliasToCanonical（与 Story Preservation Gate 共用同一映射来源）。
   * 提供时，境界主体绑定会先把句子中的角色别名规范化为 canonical 名再做归属判断，
   * 修复 "小尘已是筑基期" 对 canonical 角色 "叶尘" 误判为"其他角色"的反例。
   * 未提供时（旧测试兼容）不做规范化，characterNames 中的别名仍按原名参与判断。
   */
  aliasToCanonical?: Map<string, string>
): SemanticSupportResult {
  if (!nameSpan) {
    // 主体未在正文中出现：不在此处判定，交给已有的 :not-found 逻辑处理
    return { supported: true, reason: "主体未出现（由 not-found 逻辑处理）" };
  }

  const subjectSentence = findSubjectSentence(finalText, nameSpan);

  if (entry.kind === "character") {
    const value = entry.value ?? "";
    if (entry.field === "realm") {
      // P0-2b: 境界证据必须绑定角色主体
      // nameSpan 是境界值在正文中的 span（不是角色名 span）
      // subjectSentence 是包含境界值的句子
      // 1. 如果句中也含目标角色名 → 检查是否同子句（防止多角色句子中误锚定）
      // 2. 如果句中不含目标角色名 → 检查其他角色竞争 / 代词指代 / 单角色场景
      // 3. 如果同句但不同子句 → 可能属于其他角色，拒绝
      const normalizedRealm = normalizeClaim(value);
      if (normalizedRealm.length === 0) {
        return { supported: false, reason: `semantic-unsupported：realm="${value}" 为空` };
      }
      // P0 第七轮 P1 修复：先把境界句中的角色别名规范化为 canonical 名。
      // 修复 "小尘已是筑基期" 对 canonical 角色 "叶尘" 误判为"其他角色"的反例。
      // 规范化后所有角色存在性判断都基于 canonical 名，与 entry.characterId 一致。
      const normalizedSentence = normalizeAliasesInText(subjectSentence.excerpt, aliasToCanonical);
      if (normalizedSentence.includes(entry.characterId)) {
        // 角色名（或别名规范化后）与境界值在同句 → 检查是否同子句
        const charClause = findClauseWithCharacter(normalizedSentence, entry.characterId);
        if (charClause && normalizeClaim(charClause).includes(normalizedRealm)) {
          return { supported: true, reason: "主体所在子句覆盖境界状态值", evidenceSpan: subjectSentence };
        }
        // 不同子句 → 可能属于其他角色
        return {
          supported: false,
          reason: `semantic-conflict：realm="${value}" 与角色 "${entry.characterId}" 不在同一子句，可能属于其他角色`,
        };
      }
      // P0 第六轮：境界主体归属改为结构化绑定（取代动词正则补丁）
      //
      // 用户验收反例（第六轮）：以下等价表达仍会把 `叶尘 realm=筑基期` 以 confidence=0.7 重锚：
      //   - "林默的境界是筑基期。叶尘在门外等待。"
      //   - "林默境界为筑基期。叶尘在门外等待。"
      //   - "林默处在筑基期。叶尘在门外等待。"
      //   - "林默是筑基期修士。叶尘在门外等待。"
      // 根因：旧逻辑未命中 REALM_ENTRY_VERBS 正则便默认"单角色场景"放行；
      // 继续扩充正则无法彻底解决（"境界是/为/处在/是修士" 等表达无穷）。
      //
      // 新规则（结构化主体绑定，仅当 characterNames 提供时启用）：
      //   境界句中存在其他已知角色且不含目标角色 → fail-closed。
      //   不依赖任何动词正则，直接用角色存在性判断归属竞争。
      //   - "林默的境界是筑基期" + 叶尘 realm=筑基期：句含"林默"不含"叶尘" → fail-closed ✓
      //   - "淬腑境，初期。"（单角色场景，无其他角色） → 通过 ✓
      //
      // 回归保护：
      //   - staged-state-realm-transition.test.mjs 的 "淬腑境，初期" 场景：句中无其他角色 → 通过
      //   - 旧测试不传 characterNames → 走下方 REALM_ENTRY_VERBS 回退分支（向后兼容）
      const hasCharacterNames = Array.isArray(characterNames) && characterNames.length > 0;
      if (hasCharacterNames) {
        // P0 第七轮 P1 修复：用 canonical 角色名集合判断"其他角色竞争"。
        // characterNames 含别名；先把别名映射到 canonical 再去重，避免别名被当成"其他角色"。
        const canonicalSet = buildCanonicalNameSet(characterNames, aliasToCanonical);
        const otherCharactersPresent = Array.from(canonicalSet).filter(
          (c) =>
            c !== entry.characterId &&
            c.length >= 2 &&
            normalizedSentence.includes(c),
        );
        if (otherCharactersPresent.length > 0) {
          return {
            supported: false,
            reason: `semantic-conflict：realm="${value}" 所在句子含其他角色 [${otherCharactersPresent.join("、")}] 但不含角色 "${entry.characterId}"，境界归属于其他角色（fail-closed，结构化绑定）`,
          };
        }
        // P0 第七轮 P0 修复：境界句无角色名（规范化后）→ 跨句代词指代解析。
        //
        // 用户验收反例（第七轮）：
        //   "林默抬起头。他已是筑基期。叶尘在门外等待。" + 叶尘 realm=筑基期 → 旧逻辑误通过
        //   "林默站在门前。此人已达筑基期。叶尘仍未赶到。" + 叶尘 realm=筑基期 → 旧逻辑误通过
        //   "林默看向远方。其修为已至筑基期。叶尘在门外等待。" + 叶尘 realm=筑基期 → 旧逻辑误通过
        //
        // 旧逻辑在"句中无其他角色竞争"时直接放行（单角色场景），未处理境界句主体是
        // 代词（他/此人/其）指代前句角色的情况，导致境界归属被误判。
        //
        // 新规则（仅当 characterNames 提供时启用）：
        // 1. 境界句以代词开头 → 解析代词指代的前句 canonical 角色
        //    - 指代目标角色 → 通过（境界归属目标角色）
        //    - 指代其他角色 → fail-closed
        //    - 无法解析（前句无已知角色）→ 走下方单角色/多角色歧义判断
        // 2. 境界句无代词：
        //    - 单角色场景（canonicalSet.size <= 1）→ 通过（如 "淬腑境，初期。"）
        //    - 多角色场景 → fail-closed（境界句无角色名且无代词，归属无法确认）
        const pronounResolved = resolvePronounSubject(finalText, subjectSentence, canonicalSet);
        if (pronounResolved !== null) {
          if (pronounResolved === entry.characterId) {
            return {
              supported: true,
              reason: `境界句代词主体（他/此人/其）指代前句角色 "${entry.characterId}"，境界归属目标角色（跨句代词解析）`,
              evidenceSpan: subjectSentence,
            };
          }
          return {
            supported: false,
            reason: `semantic-conflict：realm="${value}" 所在句子的代词主体指向前句角色 "${pronounResolved}"，非目标角色 "${entry.characterId}"（fail-closed，跨句代词解析）`,
          };
        }
        // 代词无法解析或无代词 → 按场景角色数判断
        const singleCharacterScene = canonicalSet.size <= 1;
        if (singleCharacterScene) {
          // 单角色场景：境界值单独成句，无主体竞争 → 允许通过。
          // 仍保留后置定语"的"检测作为结构化补充证据（境界值后紧跟"的"修饰非目标实体）。
          const realmIdxStruct = subjectSentence.excerpt.indexOf(value);
          if (realmIdxStruct >= 0) {
            const afterRealm = subjectSentence.excerpt.slice(
              realmIdxStruct + value.length,
              realmIdxStruct + value.length + 1,
            );
            if (afterRealm === "的") {
              return {
                supported: false,
                reason: `semantic-conflict：realm="${value}" 在句中作为定语（后跟"的"），修饰非目标角色 "${entry.characterId}" 的实体，境界归属于其他角色（fail-closed，结构化绑定）`,
              };
            }
          }
          return {
            supported: true,
            reason: "境界值所在句无其他角色竞争归属（结构化绑定：单角色场景）",
            evidenceSpan: subjectSentence,
          };
        }
        // 多角色场景但境界句无角色名（规范化后）且代词无法解析 → fail-closed。
        // 境界是高价值状态，无法确认主体归属时保守拒绝，交由 commit 写入 quarantine。
        return {
          supported: false,
          reason: `semantic-conflict：realm="${value}" 所在句子无已知角色名（含别名规范化后）且代词主体无法解析，但场景含 ${canonicalSet.size} 个角色，境界归属无法确认（fail-closed，结构化绑定）`,
        };
      }

      // 回退路径（未提供 characterNames，旧测试兼容）：保留 REALM_ENTRY_VERBS + 后置定语检测。
      // 生产路径提供 characterNames 时不会到达此处。
      //
      // P0 第五轮：补充"处于"等状态动词。
      // 用户验收反例："林默处于筑基期。叶尘在门外等待。" + 叶尘 realm=筑基期 → committed=1
      const REALM_ENTRY_VERBS = /踏入|迈入|突破|进入|达到|晋升|觉醒|开窍|凝气|已是|已至|已到|已达|已入|修至|修为|修炼至|修炼到|晋级|升入|跨入|停留在|巩固在|稳定在|处于|身为|身居|位列|居于/;
      const hasRealmEntryVerb = REALM_ENTRY_VERBS.test(subjectSentence.excerpt);
      if (hasRealmEntryVerb) {
        // 境界句含状态动词 → 主体明确但不是目标角色 → fail-closed
        return {
          supported: false,
          reason: `semantic-conflict：realm="${value}" 所在句子含境界状态动词但不含角色 "${entry.characterId}"，境界可能归属于其他角色（fail-closed）`,
        };
      }
      // P0 第五轮：后置定语结构检测
      // 用户验收反例："筑基期的林默守在门前。叶尘仍未赶到。" + 叶尘 realm=筑基期 → committed=1
      // 境界值 "筑基期" 作为定语修饰 "林默"（后跟"的"），明确归属于林默而非叶尘。
      // 由于目标角色不在本句（上文已检查），境界值后紧跟"的"意味着它修饰的是其他实体 → fail-closed
      const realmIdx = subjectSentence.excerpt.indexOf(value);
      if (realmIdx >= 0) {
        const afterRealm = subjectSentence.excerpt.slice(
          realmIdx + value.length,
          realmIdx + value.length + 1,
        );
        if (afterRealm === "的") {
          return {
            supported: false,
            reason: `semantic-conflict：realm="${value}" 在句中作为定语（后跟"的"），修饰非目标角色 "${entry.characterId}" 的实体，境界归属于其他角色（fail-closed）`,
          };
        }
      }
      // 境界句不含状态动词 → 境界单独成句，无主体竞争 → 允许通过
      return {
        supported: true,
        reason: "境界值单独成句，无境界状态动词与其他角色归属信号（单角色场景）",
        evidenceSpan: subjectSentence,
      };
    }
    if (DEATH_TERMS.test(value)) {
      // P0-2c: 死亡证据必须与角色名在同一子句
      const charClause = findClauseWithCharacter(subjectSentence.excerpt, nameSpan.excerpt);
      if (charClause && DEATH_EVIDENCE.test(charClause)) {
        return { supported: true, reason: "主体所在子句有死亡证据", evidenceSpan: subjectSentence };
      }
      // 死亡证据不在角色子句 → 检查角色子句是否有在场行动
      if (charClause && ACTIVE_TERMS.test(charClause)) {
        return {
          supported: false,
          reason: `semantic-conflict：value="${value}" 声称死亡，但主体所在子句显示在场行动（${nameSpan.excerpt}）`,
        };
      }
      return { supported: false, reason: `semantic-unsupported：value="${value}" 缺少与主体同子句的死亡证据` };
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
      // P0-2: 同时检测否定语义（不在场/未到场/没来...），否定句不算参与证据
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
      let hasNegationEvidence = false;
      for (const sentence of allSentences) {
        const isHistorical = HISTORICAL_MARKERS.test(sentence.excerpt);
        const hasActive = ACTIVE_TERMS.test(sentence.excerpt);
        const hasNegation = PRESENCE_NEGATION.test(sentence.excerpt);
        if (hasNegation) hasNegationEvidence = true;
        if (!isHistorical && hasActive && !hasNegation) {
          hasCurrentTimeline = true;
          break;
        }
      }

      // P0-2: 如果所有含角色名的当前时线句都是否定参与，判定为语义冲突
      if (!hasCurrentTimeline && hasNegationEvidence) {
        return {
          supported: false,
          reason: `semantic-conflict：participation="${value}" 但正文否定角色在场（不在场/未到场/没来等）`,
        };
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
      // P0-2c: 死亡证据必须与角色名在同一子句（canon kind）
      // 防止 "林默已经死亡，叶尘在门外等待" 提交 canon "叶尘已经死亡"
      // nameSpan.excerpt 可能是部分匹配（如 "已经死亡" 而非 "叶尘已经死亡"），
      // 需要从 fact 中提取角色名，检查角色名与死亡证据是否在同一子句
      const charName = fact
        .replace(/已经|已|的|了|将|要|正|在/g, "")
        .replace(DEATH_TERMS_GLOBAL, "")
        .replace(/已经|已|的|了|将|要|正|在/g, "")
        .trim();
      const clauses = splitIntoClauses(subjectSentence.excerpt);
      let found = false;
      for (const clause of clauses) {
        const hasChar = charName.length >= 2 && clause.includes(charName);
        const hasDeath = DEATH_EVIDENCE.test(clause);
        if (hasChar && hasDeath) {
          found = true;
          break;
        }
      }
      if (found) {
        return { supported: true, reason: "主体所在子句有死亡证据", evidenceSpan: subjectSentence };
      }
      // 检查角色名所在子句是否有在场行动（反向证据）
      if (charName.length >= 2) {
        const charClause = clauses.find((c) => c.includes(charName));
        if (charClause && ACTIVE_TERMS.test(charClause)) {
          return {
            supported: false,
            reason: `semantic-conflict：fact="${fact}" 声称死亡，但主体所在子句显示在场行动`,
          };
        }
      }
      return { supported: false, reason: `semantic-unsupported：fact="${fact}" 缺少与主体同子句的死亡证据` };
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
  chapterNumber: number,
  /**
   * P0 第六轮结构化绑定：本章已知角色名（含别名）。
   *
   * 由生产路径 orchestrator-commit-save.commitAndSave 传入 input.characterNames。
   * 透传给 validateSemanticSupport，启用境界主体归属的结构化判断
   * （句中含其他角色但不含目标角色 → fail-closed，取代动词正则补丁）。
   * 未提供时（旧测试兼容）validateSemanticSupport 回退到 REALM_ENTRY_VERBS 正则。
   */
  characterNames?: string[],
  /**
   * P0 第七轮 P1 修复：别名→规范名映射（alias → canonical character name）。
   *
   * 由生产路径 orchestrator-commit-save.commitAndSave 传入 input.aliasToCanonical
   * （与 Story Preservation Gate 共用同一映射来源）。透传给 validateSemanticSupport，
   * 启用境界主体绑定的 alias 规范化（"小尘" → "叶尘"），避免 canonical 角色的境界
   * 被别名误判为"其他角色"。未提供时（旧测试兼容）不做规范化。
   */
  aliasToCanonical?: Map<string, string>
): StagedStateUpdate {
  const hash = computeFinalTextHash(finalText);
  const sourceChapter = `ch${chapterNumber}`;
  const now = new Date().toISOString();

  const reanchoredAdditions: NarrativeStateEntry[] = update.additions.map((entry) => {
    if (entry.kind === "promise") {
      const span = findPromiseSpanInText(entry.description, finalText);
      // REAL-QUALITY-4A：语义支持校验（fulfilled/broken 必须有兑现/破裂证据）
      const semantic = validateSemanticSupport(entry, finalText, span, characterNames, aliasToCanonical);
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
      const semantic = validateSemanticSupport(entry, finalText, span, characterNames, aliasToCanonical);
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
      const semantic = validateSemanticSupport(entry, finalText, span, characterNames, aliasToCanonical);
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
      const span = findPromiseSpanInText(entry.field === "realm" ? entry.value : entry.characterId, finalText);
      // REAL-QUALITY-4A：语义支持校验（阻止"角色死亡""关系误分类"一类名称级误锚定）
      const semantic = validateSemanticSupport(entry, finalText, span, characterNames, aliasToCanonical);
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
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(out, null, 2), "utf-8");
  renameSync(tmpPath, path);
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
    planned: [],
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
    // Phase 3D：planned 字段向后兼容（旧 store 无此字段 → 空数组）
    planned: Array.isArray(o.planned) ? (o.planned as PlannedStateEntry[]) : [],
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
   * Phase 3D：支持 plannedUpdate 参数，把 ChapterSeed/Intent 派生的计划状态
   * 写入 store.planned 字段（非权威，供下一章 Preflight 连续性参考）。
   * 计划状态与 VerifiedState 分裂存储：verified 进入 canon/character/promise/
   * expectation 权威字段，planned 进入 planned 字段并标记验证结果。
   *
   * @param store 当前长期状态
   * @param finalCandidateId 最终选中的候选 id（必须与 staged 的 finalCandidateId 一致）
   * @param finalText 最终正文（A2：用于校验 sourceRef span 可追溯性 + 记录 hash）
   * @param plannedUpdate 可选：ChapterSeed/Intent 派生的计划状态（写入 store.planned）
   * @param sourceRunId 可选：本次生成运行的来源 id（写入 MemoryCommitReceipt，供追溯）
   * @returns { committed, store, rejected, finalTextHash, plannedPersisted, receipt }
   */
  commit(
    store: NarrativeStateStore,
    finalCandidateId: string,
    finalText: string,
    workspaceId: string,
    projectRoot: string,
    plannedUpdate?: StagedStateUpdate,
    sourceRunId?: string
  ): { store: NarrativeStateStore; committed: number; rejected: Array<{ entry: NarrativeStateEntry; errors: string[] }>; finalTextHash: string; plannedPersisted: number; receipt: MemoryCommitReceipt | null } {
    if (this.settled) {
      throw new Error("FinalStateCommit 已 settled，不能重复 commit");
    }
    this.settled = true;

    if (!this.staged) {
      // 无暂存：直接返回原 store（仍记录 finalText hash 供审计）
      return { store, committed: 0, rejected: [], finalTextHash: computeFinalTextHash(finalText), plannedPersisted: 0, receipt: null };
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

    // ── MEMORY-RECORD-1：为 accepted entry 附加权威记忆信封 ──
    // 把已通过校验（span/hash/语义均通过）的正式状态条目转换为 MemoryRecord，
    // 供权威检索、回源、TTL 消费。转换失败的条目（无 #finalText: 的 sourceRef）
    // 保留在 active state 但不附加信封（向后兼容旧 store）。
    const sourceChapterNumber = chapterNumberFromChapter(this.staged.sourceChapter);
    const memoryRecords: MemoryRecord[] = [];
    for (let i = 0; i < accepted.length; i++) {
      const rec = stateEntryToMemoryRecord(accepted[i], {
        sourceChapter: sourceChapterNumber,
        sourceRunId: sourceRunId ?? `run-${this.staged.sourceChapter}`,
        finalText,
      });
      if (!rec) continue;
      const v = validateMemoryRecord(rec);
      if (!v.ok) continue; // 信封校验失败不阻断既有状态提交（信封为附加元数据）
      accepted[i] = { ...accepted[i], memory: rec };
      memoryRecords.push(rec);
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

    // Phase 3D：构建计划状态条目并写入 store.planned
    // plannedUpdate 是 ChapterSeed/Intent 派生的原始状态（sourceRef=seed:*），
    // 与 this.staged（已 reanchor 的 VerifiedState）共享 entry id（pattern 除外）。
    // 通过 id 匹配确定每条计划状态的验证结果（hit/miss/conflict）。
    const plannedEntries = buildPlannedEntries(
      plannedUpdate,
      this.staged,
      accepted,
      rejected,
    );

    const compacted = compactNarrativeMemory(nextStore).store;

    // Phase 3D：写入计划状态（在 compaction 之后，避免被覆盖）
    // 计划状态按 sourceChapter 替换：移除同章旧 planned entries，追加新 planned entries。
    // 这保证同一章节重复生成不会累积 planned 垃圾。
    //
    // P2 修复（PlannedState 闭环）：即使 plannedEntries 为空（例如同章重生成时
    // ChapterSeed/Intent 未派生计划状态），也必须清除同章旧 planned entries。
    // 旧的 `if (plannedEntries.length > 0)` 守卫会让空计划重生成留下过时条目，
    // 污染下一章 ContextCompiler 的连续性参考。无 planned 字段时也需要初始化为 []。
    const sourceChapter = this.staged.sourceChapter;
    const otherChaptersPlanned = (compacted.planned ?? []).filter(
      (e) => e.sourceChapter !== sourceChapter,
    );
    compacted.planned = [...otherChaptersPlanned, ...plannedEntries];

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

    // ── MEMORY-TRANSACTION-1：硬冲突阻断（状态落盘前）────────────────
    // 冲突检测必须在 saveStateStore 之前：若新正文与旧 Canon 硬冲突
    // （canon 同键且内容不同，未显式 supersedes），不得静默覆盖既有状态。
    // 命中 hard_conflict_blocked 时抛出 MemoryHardConflictError（携带
    // MemoryConflictEnvelope），由 commitAndSave 捕获并回滚刚保存的正文，
    // 阻断 commitAndSave（ok=false，正文/状态均不提交）。
    const existingMemory: MemoryRecord[] = collectStoreMemory(store);
    const memoryConflicts = detectMemoryConflicts(memoryRecords, existingMemory);

    // ── MEMORY-TRANSACTION-1：StagedMemoryUpdate 事务协议接入 ─────────
    // 把本次提交的缓冲记忆记录 + 作废列表封装为 StagedMemoryUpdate，经
    // validateStagedMemoryUpdate 校验（finalTextHash 已冻结、sourceRunId 非空、
    // 每条记录通过 validateMemoryRecord）。校验失败视为提交前置条件不满足，
    // 阻断提交（不落盘、不静默继续）。
    const stagedMemory: StagedMemoryUpdate = {
      records: memoryRecords,
      invalidations: [...this.staged.invalidations],
      sourceChapter: sourceChapterNumber,
      sourceRunId: sourceRunId ?? `run-${this.staged.sourceChapter}`,
      finalTextHash,
    };
    const stagedMemValidation = validateStagedMemoryUpdate(stagedMemory);
    if (!stagedMemValidation.ok) {
      throw new Error(
        `StagedMemoryUpdate 校验失败，阻断状态提交：${stagedMemValidation.errors.join("; ")}`
      );
    }

    const hardConflicts = memoryConflicts.filter(
      (c) => c.resolution === "hard_conflict_blocked",
    );
    if (hardConflicts.length > 0) {
      const first = hardConflicts[0];
      const envelope = buildMemoryHardConflictEnvelope({
        memoryType: first.memoryType,
        key: first.key,
        existingMemoryId: first.existingMemoryId,
        incomingMemoryId: first.incomingMemoryId,
        existingRecord: existingMemory.find((r) => r.memoryId === first.existingMemoryId),
        incomingRecord: memoryRecords.find((r) => r.memoryId === first.incomingMemoryId),
      });
      throw new MemoryHardConflictError(envelope);
    }

    // 落盘
    // STEP-3 事务边界：arc-registry.json 的更新（如未来需要机器更新 arc/foreshadow
    // 状态）必须在此事务内完成，不能在 post-final 阶段独立写入。当前 arc-registry
    // 是只读输入；如需写入，必须在 saveStateStore 同一事务内以 backup→write→rename
    // 原子方式落盘，并在任一文件失败时回滚全部变更。
    saveStateStore(compacted, workspaceId, projectRoot);

    // ── MEMORY-RECORD-1：构建 MemoryCommitReceipt ──
    // 冲突检测为 advisory（报告供 trace/人工裁决），不自动覆盖既有状态。
    // 硬冲突已在落盘前阻断；此处仅记录非阻断冲突（superseded/new_text_wins/versioned）。
    const receipt: MemoryCommitReceipt = buildMemoryCommitReceipt({
      workspaceId,
      sourceChapter: sourceChapterNumber,
      finalTextHash,
      sourceRunId: sourceRunId ?? `run-${this.staged.sourceChapter}`,
      stateVersion: `${this.staged.sourceChapter}-${compacted.updatedAt}`,
      committed: memoryRecords,
      rejected: rejected.map((r) => ({ memoryId: r.entry.id, errors: r.errors })),
      invalidatedIds: [...this.staged.invalidations],
      conflicts: memoryConflicts,
    });

    this.staged = null;
    return { store: compacted, committed: accepted.length, rejected, finalTextHash, plannedPersisted: plannedEntries.length, receipt };
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

// ============================================================================
// Phase 3D：buildPlannedEntries — 从 ChapterSeed/Intent 派生计划状态条目
//
// 把 plannedUpdate（seed 派生的原始 StagedStateUpdate，sourceRef=seed:*）转换为
// PlannedStateEntry[]，并通过 id 匹配 verifiedStaged 中的 reanchored 条目确定
// 验证结果（hit/miss/conflict）。
//
// 匹配逻辑：
// - plannedUpdate.additions 与 verifiedStaged.additions 共享 entry id（pattern 除外）
// - 通过 id 在 accepted（已通过校验的 verified entries）中查找：
//   - 找到 → verified=true, verificationOutcome="hit"
//   - 未找到但在 rejected 中 → 根据 rejected entry 的 sourceRef 后缀判断：
//     - ":not-found" → verificationOutcome="miss"
//     - ":semantic-conflict" → verificationOutcome="conflict"
//     - 其他 → verificationOutcome="miss"（保守归因）
//   - 既不在 accepted 也不在 rejected → verificationOutcome="miss"
//
// pattern entries 不生成 planned 条目（pattern 是正文派生状态，无 seed 计划对应）。
// ============================================================================

function buildPlannedEntries(
  plannedUpdate: StagedStateUpdate | undefined,
  verifiedStaged: StagedStateUpdate,
  accepted: NarrativeStateEntry[],
  rejected: Array<{ entry: NarrativeStateEntry; errors: string[] }>,
): PlannedStateEntry[] {
  if (!plannedUpdate) return [];

  // 构建 id → accepted entry 索引
  const acceptedById = new Map<string, NarrativeStateEntry>();
  for (const entry of accepted) {
    acceptedById.set(entry.id, entry);
  }

  // 构建 id → rejected entry 索引
  const rejectedById = new Map<string, NarrativeStateEntry>();
  for (const { entry } of rejected) {
    rejectedById.set(entry.id, entry);
  }

  // 构建 id → reanchored sourceRef 索引（用于判断验证结果）
  // verifiedStaged 包含 reanchor 后的 entries，通过 sourceRef 后缀判断结果
  const reanchoredSourceRefById = new Map<string, string>();
  for (const entry of verifiedStaged.additions) {
    reanchoredSourceRefById.set(entry.id, entry.sourceRef);
  }

  const now = new Date().toISOString();
  const sourceChapter = plannedUpdate.sourceChapter;
  const plannedEntries: PlannedStateEntry[] = [];

  for (const entry of plannedUpdate.additions) {
    // pattern 是正文派生状态，无 seed 计划对应，跳过
    if (entry.kind === "pattern") continue;

    // 只处理 canon/character/promise/expectation 四类（与 PlannedStateEntry.plannedKind 对齐）
    const plannedKind: "canon" | "character" | "promise" | "expectation" | undefined =
      entry.kind === "canon" || entry.kind === "character" || entry.kind === "promise" || entry.kind === "expectation"
        ? entry.kind
        : undefined;
    if (!plannedKind) continue;

    // 提取计划内容描述（按 kind 取对应字段）
    const plannedContent = extractPlannedContent(entry);
    if (!plannedContent) continue;

    // 提取计划字段子类型
    const plannedField = extractPlannedField(entry);

    // 通过 id 匹配 verified 状态
    const acceptedEntry = acceptedById.get(entry.id);
    const rejectedEntry = rejectedById.get(entry.id);
    const reanchoredSourceRef = reanchoredSourceRefById.get(entry.id);

    let verified = false;
    let verifiedEntryId: string | undefined;
    let verificationOutcome: "hit" | "miss" | "conflict" | undefined;

    if (acceptedEntry) {
      verified = true;
      verifiedEntryId = acceptedEntry.id;
      verificationOutcome = "hit";
    } else if (rejectedEntry) {
      verified = false;
      // 根据 reanchored sourceRef 后缀判断验证结果
      if (reanchoredSourceRef) {
        if (reanchoredSourceRef.endsWith(":not-found")) {
          verificationOutcome = "miss";
        } else if (reanchoredSourceRef.endsWith(":semantic-conflict")) {
          verificationOutcome = "conflict";
        } else {
          // 其他拒绝原因（span 越界、schema 错误等）保守归为 miss
          verificationOutcome = "miss";
        }
      } else {
        verificationOutcome = "miss";
      }
    } else {
      // 既不在 accepted 也不在 rejected：可能 plannedUpdate 包含 verifiedStaged 没有的 entry
      // （理论上不应发生，但保守处理）
      verified = false;
      verificationOutcome = "miss";
    }

    plannedEntries.push({
      id: `planned:${entry.id}`,
      sourceChapter,
      sourceRef: entry.sourceRef, // 保留原始 seed:* sourceRef
      confidence: entry.confidence,
      lastUpdated: now,
      plannedKind,
      plannedContent,
      plannedSource: "chapter_seed",
      ...(plannedField ? { plannedField } : {}),
      verified,
      ...(verifiedEntryId ? { verifiedEntryId } : {}),
      verificationOutcome,
    });
  }

  return plannedEntries;
}

/**
 * 从 NarrativeStateEntry 提取计划内容描述（按 kind 取对应字段）。
 */
function extractPlannedContent(entry: NarrativeStateEntry): string | null {
  switch (entry.kind) {
    case "canon":
      return entry.fact ?? null;
    case "character":
      return entry.value ?? null;
    case "promise":
      return entry.description ?? null;
    case "expectation":
      return entry.description ?? null;
    case "pattern":
      return null; // pattern 不生成 planned 条目
    default:
      return null;
  }
}

/**
 * 从 NarrativeStateEntry 提取计划字段子类型（如 character.field, promise.status）。
 */
function extractPlannedField(entry: NarrativeStateEntry): string | undefined {
  switch (entry.kind) {
    case "character":
      return entry.field;
    case "promise":
      return entry.status;
    case "expectation":
      return entry.status;
    case "canon":
      return entry.category;
    case "pattern":
      return undefined;
    default:
      return undefined;
  }
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
 * - ch{N}#finalText:{hash}:not-found      → 无 span（正文未触及），拒绝（已低置信度）
 * - ch{N}#finalText:{hash}:semantic-conflict → 无 span（语义冲突），拒绝
 * - ch{N}#finalText:{hash}                → 无 span（非 promise kind，如 pattern），通过
 * - 其它（seed:* 等未重锚定格式）          → 拒绝（P1-1: fail-closed，禁止绕过重锚定）
 *
 * P1-1 修复（2026-07-29）：
 * 原实现中 "无 span 格式被直接放行"，导致直接 stage `sourceRef=seed:*` 可绕过
 * reanchorStagedStateToFinalText 并写入权威 canon/character/promise。
 * 现在唯一落盘入口 commit() 强制要求所有 entry 的 sourceRef 含 `#finalText:`，
 * 证明状态来自最终正文而非 ChapterSeed 意图。
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
  // P1-1: fail-closed — sourceRef 必须含 #finalText: 证明来自最终正文
  // 防止 seed:* 等未重锚定的 sourceRef 绕过 reanchor 直接写入权威状态
  if (!sourceRef.includes("#finalText:")) {
    errors.push(
      `sourceRef 未重锚定到最终正文（缺少 #finalText: 前缀）：${sourceRef}。所有 entry 必须经 reanchorStagedStateToFinalText 处理后再 commit。`,
    );
    return errors;
  }
  // 匹配 :{start}-{end} 结尾的 span（最后一个 : 后面是数字-数字）
  const spanMatch = sourceRef.match(/:(\d+)-(\d+)$/);
  if (!spanMatch) {
    // 有 #finalText: 但无 span（如 pattern kind: ch{N}#finalText:{hash}）→ 通过
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

// ============================================================================
// MEMORY-RECORD-1 辅助函数
// ============================================================================

/** 从 "ch17" 解析章节号；无法解析返回 0（调用方按非章节来源处理） */
function chapterNumberFromChapter(sourceChapter: string): number {
  const m = sourceChapter.match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/** 收集 store 中所有已附加的 memory 信封（供冲突检测与回源） */
function collectStoreMemory(store: NarrativeStateStore): MemoryRecord[] {
  const out: MemoryRecord[] = [];
  const push = (entries: NarrativeStateEntry[] | undefined): void => {
    for (const e of entries ?? []) {
      if (e.memory) out.push(e.memory);
    }
  };
  push(store.canon);
  push(store.character);
  push(store.promise);
  push(store.pattern);
  push(store.expectation);
  return out;
}
