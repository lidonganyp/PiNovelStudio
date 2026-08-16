/**
 * IMMUTABLE-FACTS-COMPILER-1: 本章硬事实编译器 + 高影响新设定来源授权检查
 *
 * 任务规格：delete/任务列表/项目优化20260718.md P1-2 L313-343
 *
 * 设计原则（开发计划 §5 FactGuard / RiskAnalyzer）：
 * - 从 6 个来源编译本章不可违背事实：
 *   world_canon / character_state / prev_chapter / chapter_anchor / ontology / open_promise
 * - 每条 fact 含 fact/category/sourceRef，可追溯
 * - 高影响新设定（秘法/封印/组织计划/神器/升级结果）必须存在来源授权
 * - FactGuard 不只检查"与已知事实冲突"，还要检查高影响新设定是否存在来源授权
 * - 本地扫描，无 LLM 调用
 *
 * 接入位置：v2/core/orchestrator-factguard.ts -> checkCandidateFactGuard
 * 在 FactContinuityGuard.check 之后调用 checkUnauthorizedHighImpactSettings，
 * 命中则追加 hard block 诊断（domain=continuity, source=unauthorized_high_impact_setting）。
 *
 * 闭包自包含：仅依赖 sibling types.js（type-only import），可安全纳入 dist-test barrel。
 */

// ============================================================================
// 类型定义
// ============================================================================

export type ImmutableFactCategory =
  | "world_canon"
  | "character_state"
  | "prev_chapter"
  | "chapter_anchor"
  | "ontology"
  | "open_promise";

export interface ImmutableFact {
  /** 事实文本（人类可读） */
  fact: string;
  /** 来源类别（6 类之一） */
  category: ImmutableFactCategory;
  /** 来源引用（可追溯到 sourceIds / 文件 / 锚点等） */
  sourceRef: string;
}

export type HighImpactCategory =
  | "secret_technique"
  | "seal"
  | "organization_plan"
  | "artifact"
  | "upgrade_result";

export interface AuthorizedHighImpactTerm {
  /** 高影响术语原文 */
  term: string;
  /** 高影响类别 */
  category: HighImpactCategory;
  /** 授权来源引用 */
  sourceRef: string;
}

export interface ImmutableFactsInput {
  /** 1. 世界观 Canon */
  worldRules?: Array<{
    id: string;
    description: string;
    type?: string;
    affectedCharacters?: string[];
    sourceIds?: string[];
  }>;
  /** 1.1 作品宪法（含 forbiddenDrift 等硬约束） */
  constitution?: {
    workIdentity?: string;
    readerPromise?: string[];
    genrePromises?: string[];
    protagonistCoreConflict?: string;
    thematicQuestions?: string[];
    aestheticDirection?: string[];
    forbiddenDrift?: string[];
    narrativePreferences?: Record<string, unknown>;
  } | null;
  /** 2. 当前有效角色状态 */
  characterStates?: Array<{
    characterId: string;
    name: string;
    state?: Record<string, unknown>;
    sourceIds?: string[];
  }>;
  /** 3. 上一接受章节（bridge context） */
  bridgeContext?: {
    available: boolean;
    lastEventSummary?: string;
    lastEventId?: string;
    openHooks?: string[];
    unresolvedTensions?: string[];
    introducedCharacters?: string[];
    sourceIds?: string[];
  } | null;
  /** 4. 显式章节锚点 */
  chapterAnchors?: string[];
  /** 5. 本体层级（封闭世界契约） */
  ontologyLevels?: string[];
  /** 6. 当前开放伏笔（promises + open loops） */
  openPromises?: Array<{ id: string; description: string }>;
  openLoops?: Array<{
    id: string;
    description: string;
    openedAt?: string;
    urgency?: number;
    sourceIds?: string[];
  }>;
  /** 已由 ContextCompiler 从 canonical 本地文件加载的授权文本；只用于术语授权，不升级为硬事实。 */
  authorizedHighImpactSources?: Array<{ text: string; sourceRef: string }>;
}

export interface CompiledImmutableFacts {
  facts: ImmutableFact[];
  sourceRefs: string[];
  authorizedHighImpactTerms: AuthorizedHighImpactTerm[];
}

export interface UnauthorizedHighImpactDiagnostic {
  category: HighImpactCategory;
  term: string;
  span: { start: number; end: number; excerpt?: string };
  reason: string;
  sourceRef?: string;
}

// ============================================================================
// 高影响术语静态词典
// ============================================================================

/**
 * 5 类高影响新设定词典。
 *
 * secret_technique（秘法）：功法/秘术/心法等"修炼体系新增"
 * seal（封印）：封印/禁制/阵法等"封禁力量"
 * organization_plan（组织计划）：组织/计划/联盟等"势力设定"
 * artifact（神器）：神器/圣物/至宝等"道具层级跃迁"
 * upgrade_result（升级结果）：动态从 ontologyLevels + characterStates.realm 推导
 */
const HIGH_IMPACT_DICTIONARY: Record<HighImpactCategory, string[]> = {
  secret_technique: ["秘法", "上古秘法", "上古功法", "上古心法", "禁术", "神功", "心法", "秘术"],
  seal: ["封印", "禁制", "镇魔印", "封神阵", "锁魂阵", "封魔"],
  organization_plan: ["组织", "计划", "联盟", "教派", "帮派", "宗门", "门派"],
  artifact: ["神器", "圣物", "至宝", "天器", "仙器", "法宝"],
  // upgrade_result 动态从 ontologyLevels + characterStates.realm 推导
  upgrade_result: [],
};

/**
 * 升级结果检测的境界/层级后缀模式。
 *
 * 候选匹配：1-4 个汉字 + 境/阶/级/重/层 等后缀；最终必须同时命中明确升级语境。
 * 例如：筑基境、金丹境、化神境、元婴境、练气期、筑基期等。
 *
 * 仅凭后缀会误报"心境"、"阶层"、"重重"等普通词，因此扫描阶段必须再通过
 * UPGRADE_CONTEXT_PATTERN 的语境过滤。
 */
const REALM_SUFFIX_PATTERN = /[\u4e00-\u9fff]{1,4}(?:境|阶|级|重|层|期)/g;

/** 明确表示修为/层级已经变化的语境；刻意不包含普通的"跨越/进入"。 */
const UPGRADE_CONTEXT_PATTERN = /(?:突破|晋升|进阶|升(?:至|到|入)|跃升|提升(?:至|到)?|修炼(?:至|到)|达到|到达|踏入|迈入|成为)/;

/**
 * 非境界后缀短语（含境界/层级后缀，但并非修为境界或层级跃迁）。
 *
 * upgrade_result 动态检测按 REALM_SUFFIX_PATTERN 扫描，容易把普通词汇误判为
 * 未授权境界跃迁。本集合用于排除常见误报：
 * - 时间状语："关键时期"（突破的关键时期）、"期间"
 * - 功法层数："第三层"（第X层，功法修炼层次，非修为境界）—— 本世界层级授权为
 *   "练气/筑基"（境/期），"层"不作为境界，故"第X层"应视为功法层而非修为跃迁
 * - 抽象层级："层次"、"阶层"
 *
 * 注意：仅当整个匹配词命中这些排除项时才跳过，避免误放过真实境界（如"筑基期"）。
 */
const NON_REALM_SUFFIX_PHRASES: readonly string[] = [
  "时期",
  "期间",
  "层次",
  "层级",
  "阶层",
  "意境",
  "境地",
  "境况",
  "底层",
  "上层",
  "下层",
  "中层",
  "表层",
  "深层",
  "基层",
  "内层",
  "外层",
];

/** 以结构助词开头的匹配几乎不可能是境界名，例如「的底层弟子」。 */
const REALM_PARTICLE_PREFIX = /^(?:的|地|得)/;

/** 功法层数（第X层/第X重），如"第三层"，非修为境界，排除。 */
const NUMBERED_LAYER_PATTERN = /第[一二三四五六七八九十百千万\d]+(?:层|重)$/;

/**
 * 判断 upgrade_result 扫描到的后缀词是否为非境界词汇（应排除）。
 *
 * 注意：REALM_SUFFIX_PATTERN 会连同升级语境前缀一起捕获（如"到了第三层"、
 * "破到化神境"），因此必须基于词尾判断，而非整词。
 */
function isNonRealmSuffixPhrase(term: string): boolean {
  if (NUMBERED_LAYER_PATTERN.test(term)) return true;
  if (REALM_PARTICLE_PREFIX.test(term)) return true;
  return NON_REALM_SUFFIX_PHRASES.some((p) => term.endsWith(p));
}

// ============================================================================
// 1. compileImmutableFacts — 从 6 个来源编译本章硬事实
// ============================================================================

/**
 * 从 6 个来源编译本章不可违背事实。
 *
 * 来源：
 * 1. world_canon：worldRules + constitution.forbiddenDrift
 * 2. character_state：characterStates[i].state.* 键值
 * 3. prev_chapter：bridgeContext.{lastEventSummary, openHooks, unresolvedTensions, introducedCharacters}
 * 4. chapter_anchor：chapterAnchors[] 直接转 facts
 * 5. ontology：ontologyLevels[] 直接转 facts
 * 6. open_promise：openPromises + openLoops
 *
 * 同时编译 authorizedHighImpactTerms：扫描 facts 中含的 5 类高影响术语。
 *
 * @param input 6 来源输入
 * @returns 编译结果（facts + sourceRefs + authorizedHighImpactTerms）
 */
export function compileImmutableFacts(input: ImmutableFactsInput): CompiledImmutableFacts {
  const facts: ImmutableFact[] = [];
  const sourceRefsSet = new Set<string>();

  // ── 1. world_canon — 世界观 Canon ──
  for (const rule of input.worldRules ?? []) {
    const sourceRef = rule.sourceIds?.[0] ?? `world-rule:${rule.id}`;
    facts.push({
      fact: rule.description,
      category: "world_canon",
      sourceRef,
    });
    sourceRefsSet.add(sourceRef);
  }
  // forbiddenDrift 作为 world_canon 的硬约束（宪法级）
  for (const drift of input.constitution?.forbiddenDrift ?? []) {
    const sourceRef = "constitution:forbiddenDrift";
    facts.push({
      fact: drift,
      category: "world_canon",
      sourceRef,
    });
    sourceRefsSet.add(sourceRef);
  }

  // ── 2. character_state — 当前有效角色状态 ──
  for (const cs of input.characterStates ?? []) {
    const sourceRef = cs.sourceIds?.[0] ?? `narrative-state:character:${cs.name}`;
    const stateEntries = Object.entries(cs.state ?? {});
    if (stateEntries.length === 0) {
      facts.push({
        fact: `${cs.name} 当前状态未明`,
        category: "character_state",
        sourceRef,
      });
    } else {
      for (const [key, value] of stateEntries) {
        const valueStr = typeof value === "string" ? value : JSON.stringify(value);
        facts.push({
          fact: `${cs.name}.${key} = ${valueStr}`,
          category: "character_state",
          sourceRef,
        });
      }
    }
    sourceRefsSet.add(sourceRef);
  }

  // ── 3. prev_chapter — 上一接受章节 ──
  if (input.bridgeContext?.available) {
    const sourceRef = input.bridgeContext.sourceIds?.[0] ?? "prev-chapter:unknown";
    if (input.bridgeContext.lastEventSummary) {
      facts.push({
        fact: `前章末态：${input.bridgeContext.lastEventSummary}`,
        category: "prev_chapter",
        sourceRef,
      });
    }
    for (const hook of input.bridgeContext.openHooks ?? []) {
      facts.push({
        fact: `前章开放钩子：${hook}`,
        category: "prev_chapter",
        sourceRef,
      });
    }
    for (const tension of input.bridgeContext.unresolvedTensions ?? []) {
      facts.push({
        fact: `前章未解张力：${tension}`,
        category: "prev_chapter",
        sourceRef,
      });
    }
    for (const ch of input.bridgeContext.introducedCharacters ?? []) {
      facts.push({
        fact: `前章出场角色：${ch}`,
        category: "prev_chapter",
        sourceRef,
      });
    }
    sourceRefsSet.add(sourceRef);
  }

  // ── 4. chapter_anchor — 显式章节锚点 ──
  for (const anchor of input.chapterAnchors ?? []) {
    const sourceRef = "chapter-anchor";
    facts.push({
      fact: anchor,
      category: "chapter_anchor",
      sourceRef,
    });
    sourceRefsSet.add(sourceRef);
  }

  // ── 5. ontology — 本体层级 ──
  for (const level of input.ontologyLevels ?? []) {
    const sourceRef = "ontology-level";
    facts.push({
      fact: `本体层级：${level}`,
      category: "ontology",
      sourceRef,
    });
    sourceRefsSet.add(sourceRef);
  }

  // ── 6. open_promise — 当前开放伏笔 ──
  for (const p of input.openPromises ?? []) {
    const sourceRef = `open-promise:${p.id}`;
    facts.push({
      fact: p.description,
      category: "open_promise",
      sourceRef,
    });
    sourceRefsSet.add(sourceRef);
  }
  for (const ol of input.openLoops ?? []) {
    const sourceRef = ol.sourceIds?.[0] ?? `open-loop:${ol.id}`;
    facts.push({
      fact: ol.description,
      category: "open_promise",
      sourceRef,
    });
    sourceRefsSet.add(sourceRef);
  }

  // ── 编译授权高影响术语 ──
  const authorizedHighImpactTerms = extractAuthorizedHighImpactTerms(facts, input);

  return {
    facts,
    sourceRefs: Array.from(sourceRefsSet),
    authorizedHighImpactTerms,
  };
}

// ============================================================================
// 2. extractAuthorizedHighImpactTerms — 从 facts 中提取授权高影响术语
// ============================================================================

/**
 * 扫描 facts 中含的 5 类高影响术语，生成授权列表。
 *
 * 授权规则：
 * - 静态词典扫描：fact.fact 含词典术语 → 授权该术语
 * - 动态 upgrade_result：从 ontologyLevels + characterStates.realm 直接提取
 *
 * 同一术语多次出现只保留首条（按 fact 顺序）。
 */
function extractAuthorizedHighImpactTerms(
  facts: ImmutableFact[],
  input: ImmutableFactsInput,
): AuthorizedHighImpactTerm[] {
  const terms: AuthorizedHighImpactTerm[] = [];
  const seen = new Set<string>();

  // 静态词典扫描：从 facts 中提取授权术语
  const staticCategories = Object.keys(HIGH_IMPACT_DICTIONARY) as HighImpactCategory[];
  for (const fact of facts) {
    for (const category of staticCategories) {
      const dict = HIGH_IMPACT_DICTIONARY[category];
      for (const term of dict) {
        if (fact.fact.includes(term)) {
          const key = `${category}:${term}`;
          if (!seen.has(key)) {
            seen.add(key);
            terms.push({
              term,
              category,
              sourceRef: fact.sourceRef,
            });
          }
        }
      }
    }
  }

  for (const source of input.authorizedHighImpactSources ?? []) {
    for (const category of staticCategories) {
      for (const term of HIGH_IMPACT_DICTIONARY[category]) {
        if (!source.text.includes(term)) continue;
        const key = `${category}:${term}`;
        if (seen.has(key)) continue;
        seen.add(key);
        terms.push({ term, category, sourceRef: source.sourceRef });
      }
    }
  }

  // 动态 upgrade_result：本体层级已授权 + 当前角色境界已授权
  for (const level of input.ontologyLevels ?? []) {
    for (const levelTerm of extractOntologyLevelTerms(level)) {
      const key = `upgrade_result:${levelTerm}`;
      if (!seen.has(key)) {
        seen.add(key);
        terms.push({
          term: levelTerm,
          category: "upgrade_result",
          sourceRef: "ontology-level",
        });
      }
    }
  }
  for (const cs of input.characterStates ?? []) {
    const realm = typeof cs.state?.realm === "string" ? (cs.state.realm as string) : undefined;
    if (realm) {
      const key = `upgrade_result:${realm}`;
      if (!seen.has(key)) {
        seen.add(key);
        terms.push({
          term: realm,
          category: "upgrade_result",
          sourceRef: cs.sourceIds?.[0] ?? `narrative-state:character:${cs.name}`,
        });
      }
    }
  }

  return terms;
}

function extractOntologyLevelTerms(level: string): string[] {
  const bracketContents = Array.from(level.matchAll(/[（(]([^）)]+)[）)]/g), (match) => match[1]);
  const sources = bracketContents.length > 0 ? bracketContents : [level];
  return Array.from(new Set(
    sources.flatMap((source) => source.split(/[\/、,，→>\s]+/))
      .map((term) => term.trim())
      .filter((term) => term.length > 0 && term.length <= 12),
  ));
}

// ============================================================================
// 3. checkUnauthorizedHighImpactSettings — 扫描正文未授权高影响新设定
// ============================================================================

/**
 * 扫描正文中的高影响新设定，返回未授权诊断列表。
 *
 * 检测规则：
 * - 静态词典扫描：对每类高影响术语，在正文中查找所有出现位置；
 *   若术语未被授权（不在 authorizedHighImpactTerms 中）则生成诊断
 * - 动态 upgrade_result：扫描正文境界后缀词，未授权则生成诊断
 *
 * 授权判定（isTermAuthorized）：
 * - 精确匹配：authorized.term === term
 * - 子串包含：authorized.term.includes(term) 或 term.includes(authorized.term)
 *   （授权"上古秘法"包含"秘法" → 视为授权"秘法"；反之亦然）
 *
 * @param text 候选正文
 * @param compiled 编译结果（含授权术语列表）
 * @returns 未授权诊断列表
 */
export function checkUnauthorizedHighImpactSettings(
  text: string,
  compiled: CompiledImmutableFacts,
): UnauthorizedHighImpactDiagnostic[] {
  const diagnostics: UnauthorizedHighImpactDiagnostic[] = [];
  const authorizedTerms = compiled.authorizedHighImpactTerms;

  // ── 静态词典扫描 ──
  const staticCategories = Object.keys(HIGH_IMPACT_DICTIONARY) as HighImpactCategory[];
  for (const category of staticCategories) {
    const dict = HIGH_IMPACT_DICTIONARY[category];
    for (const term of dict) {
      // 在正文中查找该术语所有出现位置
      let idx = text.indexOf(term);
      while (idx !== -1) {
        const isAuthorized = isTermAuthorized(term, category, authorizedTerms);
        if (!isAuthorized) {
          diagnostics.push({
            category,
            term,
            span: {
              start: idx,
              end: idx + term.length,
              excerpt: text.slice(Math.max(0, idx - 20), Math.min(text.length, idx + term.length + 20)),
            },
            reason: `正文出现未授权的高影响新设定"${term}"（category=${category}），源材料中无对应术语授权`,
          });
        }
        idx = text.indexOf(term, idx + 1);
      }
    }
  }

  // ── 动态 upgrade_result 检测：扫描境界后缀词 ──
  // 重置正则 lastIndex（全局模式复用安全）
  REALM_SUFFIX_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REALM_SUFFIX_PATTERN.exec(text)) !== null) {
    const term = match[0];
    // 排除非境界词汇（功法层数"第三层"、时间状语"关键时期"等）
    if (isNonRealmSuffixPhrase(term)) continue;
    const isAuthorized = isTermAuthorized(term, "upgrade_result", authorizedTerms);
    if (!isAuthorized && hasUpgradeResultContext(text, match.index, match.index + term.length)) {
      diagnostics.push({
        category: "upgrade_result",
        term,
        span: {
          start: match.index,
          end: match.index + term.length,
          excerpt: text.slice(Math.max(0, match.index - 20), Math.min(text.length, match.index + term.length + 20)),
        },
        reason: `正文出现未授权的境界/层级跃迁"${term}"（不在本体层级或当前角色境界授权列表中）`,
      });
    }
  }

  return diagnostics;
}

function hasUpgradeResultContext(text: string, start: number, end: number): boolean {
  const contextStart = Math.max(0, start - 16);
  const contextEnd = Math.min(text.length, end + 4);
  const prefix = text.slice(contextStart, start);
  const clauseBoundary = Math.max(
    ...["。", "！", "？", "；", "：", "，", ".", "!", "?", ";", ":", ",", "\n"]
      .map((separator) => prefix.lastIndexOf(separator)),
  );
  return UPGRADE_CONTEXT_PATTERN.test(text.slice(contextStart + clauseBoundary + 1, contextEnd));
}

// ============================================================================
// 辅助：判断术语是否被授权
// ============================================================================

/**
 * 判断术语是否被授权。
 *
 * 同 category 下的授权术语：
 * - 精确匹配：authorized.term === term
 * - 子串包含：authorized.term.includes(term) 或 term.includes(authorized.term)
 *
 * 子串包含规则确保：
 * - 授权"上古秘法"包含"秘法" → 视为授权"秘法"（避免误报）
 * - 授权"秘法"被"上古秘法"包含 → 视为授权"上古秘法"（避免漏报已授权术语的扩展形式）
 */
function isTermAuthorized(
  term: string,
  category: HighImpactCategory,
  authorizedTerms: AuthorizedHighImpactTerm[],
): boolean {
  const sameCat = authorizedTerms.filter((t) => t.category === category);
  for (const a of sameCat) {
    if (a.term === term) return true;
    if (a.term.includes(term) || term.includes(a.term)) return true;
  }
  return false;
}
