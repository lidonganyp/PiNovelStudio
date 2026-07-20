/**
 * SupportingFunctionCompiler — 配角章节功能层 advisory 编译（SUPPORTING-FUNCTION-1，计划 §6.3）
 *
 * 目标：在焦点/在场分层（EnsembleLayering）之上，为激活配角编译"本章叙事功能"advisory，
 * 让 raw prompt 能看到配角在本章的功能定位（foil/witness/obstacle/helper/cost-bearer），
 * 并在 raw 生成后扫描正文行为证据（span），验证功能是否由正文行为支持。
 *
 * 核心不变量（SUPPORTING-FUNCTION-1 任务书）：
 * - 每个激活配角最多一个主功能（primaryFunction 为单值，非数组）。
 * - 功能必须由正文行为支持（rawText 中有动作 span）；raw 生成前为 null hypothesis。
 * - 未出场角色不进入 assignments（rawText 非空时按出场过滤；rawText=null 时保留 intent 命中）。
 * - 焦点角色（在 focusCharacterGoals 中）不进入 supporting assignments（焦点由 EnsembleLayering 管理）。
 * - 功能冲突（多功能命中）写 conflictAdvisory，不更新永久角色身份。
 * - "companion/supporting"等静态 role 不得直接冒充本章叙事功能（必须有动作证据）。
 * - 不恢复固定群像人数配额（无 minSupportingCount/maxSupportingCount/headcountQuota/rotationQuota）。
 * - 无可靠功能时保留焦点/在场弱层（assignments 仍列出配角，primaryFunction=null），不阻断正文。
 * - 不调用 LLM；不修改 finalText；不提交状态；不是 gate；不阻断正文生成。
 *
 * 确定性本地编译：零 LLM 调用，纯词典匹配 + span 提取。
 */

import type { ChapterIntent } from "./chapter-intent-builder.js";

// ============================================================================
// 数据契约
// ============================================================================

/**
 * 配角章节叙事功能类型（5 类）。
 * - foil：衬托（与焦点角色形成对比）
 * - witness：见证（目击/旁观事件）
 * - obstacle：阻碍（阻挡焦点角色达成目标）
 * - helper：协助（帮助焦点角色）
 * - cost-bearer：承担代价（牺牲/受伤/损失）
 */
export type SupportingFunctionType =
  | "foil"
  | "witness"
  | "obstacle"
  | "helper"
  | "cost-bearer";

/**
 * 单条配角功能分配。
 */
export interface SupportingFunctionAssignment {
  /** 角色 id（= name） */
  characterId: string;
  /** 角色名 */
  name: string;
  /**
   * 主功能（每个激活配角最多一个）。
   * - verified=true 时由正文行为证据支撑。
   * - verified=false 时为 null（无可靠功能）。
   * 不允许多功能并存（多功能命中时写 conflictAdvisory，primaryFunction 取首个命中但标 unverified）。
   */
  primaryFunction: SupportingFunctionType | null;
  /**
   * 功能证据 span（在 rawText 中的字符区间）。
   * verified=true 时非空，指向动作行为位置。
   * verified=false 时为 null。
   */
  functionEvidenceSpan: { start: number; end: number; excerpt?: string } | null;
  /** 角色目标（来自 focusCharacterGoals.goal；非焦点角色为 null） */
  goal: string | null;
  /** 是否已验证为正文行为支持（functionEvidenceSpan 非空） */
  verified: boolean;
  /** 置信度 [0,1]：verified 0.7 / unverified 0.3 */
  confidence: number;
  /** 功能冲突说明（多功能命中时写，引导人工检查） */
  conflictAdvisory?: string;
  /** 来源引用，如 "intent:relevantCharacters:{name}" */
  sourceRef: string;
}

/**
 * 配角章节功能层编译结果。
 * 写入 stageResults.supportingFunction 供 trace 审计。
 */
export interface SupportingFunctionContext {
  /** 本章激活配角的功能分配（focusCharacterGoals ∪ relevantCharacters 中的非焦点角色） */
  assignments: SupportingFunctionAssignment[];
  /** 来源汇总（去重） */
  sourceRefs: string[];
  /** raw prompt 是否实际消费了该 compact block */
  consumedByRawPrompt: boolean;
  /** advisoryOnly 恒为 true：诊断只读，不直接覆盖 raw */
  advisoryOnly: true;
  /** 是否可触发 editorial opportunity（任一 assignment 有 conflict 或 unverified hypothesis 时 true） */
  canTriggerEditorialOpportunity: boolean;
  /** 人工审阅焦点（无可靠功能时输出，引导人工检查） */
  humanReviewFocus: string | null;
  /** 空状态原因（不得静默，必须写明） */
  emptyReason?: string;
  /** 切片范围声明（防止下游误用为完整群像功能判断） */
  proxyNote?: string;
}

/**
 * 编译输入。
 */
export interface SupportingFunctionCompileInput {
  intent: ChapterIntent;
  /** raw 正文（用于功能行为 span 提取）；raw 生成前传 null */
  rawText: string | null;
}

/**
 * 编译输出。
 */
export interface SupportingFunctionCompileResult {
  supportingFunctionContext: SupportingFunctionContext;
  /** 格式化后的"配角章节功能"prompt 区块；assignments 为空时返回 null */
  promptBlock: string | null;
}

// ============================================================================
// 常量与词典
// ============================================================================

/** verified 功能的置信度（正文行为证据支撑） */
const CONFIDENCE_VERIFIED = 0.7;
/** unverified 的置信度（无功能行为支持） */
const CONFIDENCE_UNVERIFIED = 0.3;

/**
 * 5 类功能的动作行为词典（保守，只收明确行为动词）。
 * 用于在 rawText 中扫描配角的功能行为证据。
 */
const FUNCTION_VERBS: Record<SupportingFunctionType, readonly string[]> = {
  obstacle: ["阻挡", "阻止", "阻挠", "妨碍", "拦", "挡", "反对", "拒绝", "抗拒", "阻碍"],
  helper: ["协助", "帮助", "支援", "支持", "配合", "递过", "扶起", "救治"],
  witness: ["见证", "目击", "旁观", "看着", "目睹", "注视", "看着"],
  foil: ["衬托", "对比", "对照", "反衬", "映衬"],
  "cost-bearer": ["牺牲", "受伤", "承担", "付出代价", "损失", "代罚", "受刑"],
};

/**
 * 切片范围声明（固定文案）。
 * 防止下游消费者误以为本 block 是完整群像功能调度（轮转/人数配额）。
 */
const PROXY_NOTE =
  "本最小切片只为激活配角编译本章叙事功能 hypothesis（foil/witness/obstacle/helper/cost-bearer）；" +
  "功能必须由正文行为 span 支持才 verified=true；不恢复固定轮转、人数配额、群像硬门；" +
  "不更新永久角色身份（角色 identity 由 IdentityContract 管理）；advisory 非硬门";

const STATIC_ROLE_SUFFIXES = ["角色", "身份", "定位", "标签", "成员", "者", "人员"] as const;

// ============================================================================
// 核心编译逻辑
// ============================================================================

/**
 * 编译配角章节功能 advisory。
 *
 * 编译规则（保守）：
 * 1. 选择激活配角 = (focusCharacterGoals.character ∪ relevantCharacters) - focusCharacterGoals.character
 *    （即非焦点的相关角色；焦点角色由 EnsembleLayering 管理）。
 * 2. 对每个激活配角：
 *    a. rawText=null：primaryFunction=null, verified=false, confidence=0.3（hypothesis 待扫描）
 *    b. rawText 非空：扫描 rawText 中该角色名附近的功能行为动词
 *       - 单一功能命中 → primaryFunction=该功能, verified=true, span=动词位置
 *       - 多功能命中 → primaryFunction=首个命中, verified=false, conflictAdvisory=说明
 *       - 无命中 → primaryFunction=null, verified=false
 * 3. canTriggerEditorialOpportunity = any(conflictAdvisory) 或 any(unverified hypothesis)
 * 4. humanReviewFocus：有冲突或全 unverified 时输出
 * 5. 空（无激活配角）→ emptyReason + promptBlock=null
 *
 * 不调用 LLM，不修改 finalText，不提交状态，不是 gate。
 */
export function compileSupportingFunctionContext(
  input: SupportingFunctionCompileInput
): SupportingFunctionCompileResult {
  const { intent, rawText } = input;

  // 选择激活配角：非焦点的相关角色
  const focusChars = (intent.focusCharacterGoals ?? []).map((g) => g.character);
  const relevantChars = intent.relevantCharacters ?? [];
  const focusSet = new Set<string>(focusChars);
  const knownCharacters = dedupeStrings([...focusChars, ...relevantChars]);
  // 激活配角 = relevantCharacters - focusSet（去重，保序）
  let supportingNames = dedupeStrings(relevantChars.filter((n) => !focusSet.has(n)));

  // 出场过滤：rawText 非空时，只保留有独立显式姓名出现的角色（未出场角色不进入）。
  // rawText=null（raw 生成前）时不过滤（无法判断出场，保留 intent 命中作为 hypothesis）。
  if (rawText && rawText.length > 0) {
    supportingNames = supportingNames.filter((name) =>
      hasExplicitCharacterOccurrence(name, rawText, knownCharacters)
    );
  }

  // 空状态处理
  if (supportingNames.length === 0) {
    const emptyReason = deriveEmptyReason(focusChars.length, relevantChars.length, rawText);
    const ctx: SupportingFunctionContext = {
      assignments: [],
      sourceRefs: [],
      consumedByRawPrompt: false,
      advisoryOnly: true,
      canTriggerEditorialOpportunity: false,
      humanReviewFocus: null,
      emptyReason,
      proxyNote: PROXY_NOTE,
    };
    return { supportingFunctionContext: ctx, promptBlock: null };
  }

  // 编译每个配角的功能 assignment
  const assignments: SupportingFunctionAssignment[] = [];
  const sourceRefSet = new Set<string>();
  let hasConflict = false;
  let hasUnverifiedHypothesis = false;

  for (const name of supportingNames) {
    const assignment = buildAssignment(name, rawText, knownCharacters);
    assignments.push(assignment);
    sourceRefSet.add(assignment.sourceRef);
    if (assignment.conflictAdvisory) hasConflict = true;
    if (!assignment.verified && assignment.primaryFunction !== null) hasUnverifiedHypothesis = true;
  }

  // raw 生成前：所有 assignment 都是 hypothesis（primaryFunction=null, verified=false）
  // raw 生成后：扫描正文行为，可能 verified 或仍 unverified
  let humanReviewFocus: string | null = null;
  if (rawText === null) {
    humanReviewFocus = "raw 生成前无正文可扫描；待 raw 生成后再次调用以检测功能行为证据";
  } else {
    const unverifiedCount = assignments.filter((a) => !a.verified).length;
    const conflictCount = assignments.filter((a) => a.conflictAdvisory).length;
    if (conflictCount > 0) {
      humanReviewFocus = `检测到 ${conflictCount} 处功能冲突（多功能命中），需人工确认主功能`;
    } else if (unverifiedCount === assignments.length && assignments.length > 0) {
      humanReviewFocus = `所有 ${unverifiedCount} 个配角均无功能行为证据，需人工确认是否有功能定位`;
    }
  }

  const canTriggerEditorialOpportunity = hasConflict || hasUnverifiedHypothesis;

  const ctx: SupportingFunctionContext = {
    assignments,
    sourceRefs: Array.from(sourceRefSet),
    consumedByRawPrompt: false,
    advisoryOnly: true,
    canTriggerEditorialOpportunity,
    humanReviewFocus,
    proxyNote: PROXY_NOTE,
  };

  const promptBlock = formatSupportingFunctionPromptBlock(ctx);
  if (promptBlock === null) {
    ctx.consumedByRawPrompt = false;
  }
  return { supportingFunctionContext: ctx, promptBlock };
}

// ============================================================================
// 辅助：构建单条 assignment
// ============================================================================

/**
 * 构建单条 SupportingFunctionAssignment。
 *
 * 规则：
 * - rawText=null：primaryFunction=null, verified=false（hypothesis 待扫描）
 * - rawText 非空：扫描角色名附近的功能行为动词
 *   - 单一功能命中 → verified=true, span=动词位置
 *   - 多功能命中 → primaryFunction=首个, verified=false, conflictAdvisory
 *   - 无命中 → primaryFunction=null, verified=false
 */
function buildAssignment(
  name: string,
  rawText: string | null,
  knownCharacters: string[]
): SupportingFunctionAssignment {
  const sourceRef = `intent:relevantCharacters:${name}`;

  if (!rawText || rawText.length === 0) {
    return {
      characterId: name,
      name,
      primaryFunction: null,
      functionEvidenceSpan: null,
      goal: null,
      verified: false,
      confidence: CONFIDENCE_UNVERIFIED,
      sourceRef,
    };
  }

  // 扫描 rawText 中该角色名附近的功能行为动词
  const hits = scanFunctionHits(name, rawText, knownCharacters);

  if (hits.length === 0) {
    return {
      characterId: name,
      name,
      primaryFunction: null,
      functionEvidenceSpan: null,
      goal: null,
      verified: false,
      confidence: CONFIDENCE_UNVERIFIED,
      sourceRef,
    };
  }

  // 单一功能命中
  if (hits.length === 1) {
    const hit = hits[0];
    return {
      characterId: name,
      name,
      primaryFunction: hit.functionType,
      functionEvidenceSpan: {
        start: hit.start,
        end: hit.end,
        excerpt: rawText.slice(hit.start, Math.min(hit.end + 20, rawText.length)),
      },
      goal: null,
      verified: true,
      confidence: CONFIDENCE_VERIFIED,
      sourceRef,
    };
  }

  // 多功能命中：取首个作为 primaryFunction，标 unverified，写 conflictAdvisory
  const functions = Array.from(new Set(hits.map((h) => h.functionType)));
  const primaryFunction = hits[0].functionType;
  const firstHit = hits[0];
  return {
    characterId: name,
    name,
    primaryFunction,
    functionEvidenceSpan: {
      start: firstHit.start,
      end: firstHit.end,
      excerpt: rawText.slice(firstHit.start, Math.min(firstHit.end + 20, rawText.length)),
    },
    goal: null,
    verified: false, // 多功能命中标 unverified（冲突未解决）
    confidence: CONFIDENCE_UNVERIFIED,
    conflictAdvisory: `检测到 ${functions.length} 个功能命中：${functions.join("、")}；需人工确认主功能`,
    sourceRef,
  };
}

// ============================================================================
// 辅助：扫描功能行为动词
// ============================================================================

interface FunctionHit {
  functionType: SupportingFunctionType;
  start: number;
  end: number;
}

/**
 * 在 rawText 中逐句扫描可归因到该角色的功能行为动词。
 *
 * 规则（保守，避免跨句误报多功能冲突）：
 * - 逐句搜索 5 类功能动词，并要求动作主体可归因到当前角色
 * - 句内显式角色优先；句内代词仅回溯此前最近的显式相关角色
 * - “支持角色/身份/定位”等静态标签不算功能行为
 * - 收集所有命中（functionType, start, end）
 * - 同一功能类型多次命中只保留首个
 *
 * 句子级扫描的依据：典型中文叙述中，角色行为紧跟显式角色或受限代词；
 * 未能可靠解析主体的动作 fail-closed，不进入功能证据。
 */
function scanFunctionHits(
  name: string,
  rawText: string,
  knownCharacters: string[]
): FunctionHit[] {
  const hits: FunctionHit[] = [];
  const seenFunctionTypes = new Set<SupportingFunctionType>();
  const sentenceRanges = findSentenceRanges(rawText);

  // 对每个功能类型，逐句搜索可归因到当前角色的动作
  for (const funcType of Object.keys(FUNCTION_VERBS) as SupportingFunctionType[]) {
    if (seenFunctionTypes.has(funcType)) continue;
    const verbs = FUNCTION_VERBS[funcType];
    for (const sentenceRange of sentenceRanges) {
      const sentence = rawText.slice(sentenceRange.start, sentenceRange.end);
      for (const verb of verbs) {
        let searchFrom = 0;
        while (searchFrom < sentence.length) {
          const idxInSentence = sentence.indexOf(verb, searchFrom);
          if (idxInSentence === -1) break;
          const absoluteStart = sentenceRange.start + idxInSentence;
          const absoluteEnd = absoluteStart + verb.length;
          const actor = resolveActionActor(
            rawText,
            sentenceRange,
            absoluteStart,
            knownCharacters
          );
          if (
            actor === name &&
            !isStaticRoleLabel(rawText, absoluteEnd)
          ) {
            hits.push({ functionType: funcType, start: absoluteStart, end: absoluteEnd });
            seenFunctionTypes.add(funcType);
            break;
          }
          searchFrom = idxInSentence + verb.length;
        }
        if (seenFunctionTypes.has(funcType)) break;
      }
      if (seenFunctionTypes.has(funcType)) break;
    }
  }

  // 按 start 排序（从前到后）
  hits.sort((a, b) => a.start - b.start);
  return hits;
}

function findNearestCharacterBefore(
  rawText: string,
  sentenceRange: { start: number; end: number },
  actionOffset: number,
  knownCharacters: string[]
): string | null {
  const sentencePrefix = rawText.slice(sentenceRange.start, actionOffset);
  let nearestCharacter: string | null = null;
  let nearestOffset = -1;
  for (const character of knownCharacters) {
    const offset = sentencePrefix.lastIndexOf(character);
    if (
      offset > nearestOffset ||
      (offset === nearestOffset && offset >= 0 &&
        character.length > (nearestCharacter?.length ?? 0))
    ) {
      nearestCharacter = character;
      nearestOffset = offset;
    }
  }
  return nearestCharacter;
}

function resolveActionActor(
  rawText: string,
  sentenceRange: { start: number; end: number },
  actionOffset: number,
  knownCharacters: string[]
): string | null {
  const explicitActor = findNearestCharacterBefore(
    rawText,
    sentenceRange,
    actionOffset,
    knownCharacters
  );
  if (explicitActor) return explicitActor;

  const sentencePrefix = rawText.slice(sentenceRange.start, actionOffset);
  const hasThirdPersonPronoun = /(?:^|[，,。！？!?；;：:\s])(?:他们|她们|他|她)/u.test(
    sentencePrefix
  );
  if (!hasThirdPersonPronoun || sentenceRange.start === 0) return null;

  return findNearestCharacterBefore(
    rawText,
    { start: 0, end: sentenceRange.start },
    sentenceRange.start,
    knownCharacters
  );
}

function isStaticRoleLabel(rawText: string, actionEnd: number): boolean {
  const suffix = rawText.slice(actionEnd, actionEnd + 6);
  return STATIC_ROLE_SUFFIXES.some((roleSuffix) => suffix.startsWith(roleSuffix));
}

/**
 * 把正文切分为可保持原始 offset 的句子区间。
 * 句界：。！？；!?; 与换行；逗号不切句。
 */
function findSentenceRanges(rawText: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const sentenceEnds = "。！？；!?;\n";
  let start = 0;
  for (let index = 0; index < rawText.length; index++) {
    if (!sentenceEnds.includes(rawText[index])) continue;
    if (rawText.slice(start, index).trim().length > 0) {
      ranges.push({ start, end: index + 1 });
    }
    start = index + 1;
  }
  if (rawText.slice(start).trim().length > 0) {
    ranges.push({ start, end: rawText.length });
  }
  return ranges;
}

// ============================================================================
// 辅助：工具函数
// ============================================================================

/** 找到 substring 在 text 中的所有出现位置 */
function findAllOffsets(text: string, substring: string): number[] {
  if (!substring) return [];
  const offsets: number[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = text.indexOf(substring, searchFrom);
    if (idx === -1) break;
    offsets.push(idx);
    searchFrom = idx + substring.length;
  }
  return offsets;
}

function hasExplicitCharacterOccurrence(
  name: string,
  rawText: string,
  knownCharacters: string[]
): boolean {
  return findAllOffsets(rawText, name).some((offset) =>
    !knownCharacters.some((otherName) => {
      if (otherName === name || !otherName.includes(name)) return false;
      const embeddedOffset = otherName.indexOf(name);
      const longerNameStart = offset - embeddedOffset;
      return longerNameStart >= 0 && rawText.startsWith(otherName, longerNameStart);
    })
  );
}

/** 字符串数组去重（保序） */
function dedupeStrings(arr: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const s of arr) {
    if (s && !seen.has(s)) {
      seen.add(s);
      result.push(s);
    }
  }
  return result;
}

/** 推导空状态原因 */
function deriveEmptyReason(
  focusCount: number,
  relevantCount: number,
  rawText: string | null
): string {
  if (focusCount === 0 && relevantCount === 0) {
    return "无 focusCharacterGoals 且无 relevantCharacters，本章无可用配角功能数据";
  }
  if (relevantCount === 0) {
    return "无 relevantCharacters（只有 focusCharacterGoals），本章无激活配角";
  }
  // relevantCharacters 全是焦点角色，或 rawText 非空但配角均未出场
  const supportingCandidates = relevantCount - focusCount;
  if (supportingCandidates <= 0) {
    return "relevantCharacters 全部为焦点角色，本章无激活配角（焦点由 EnsembleLayering 管理）";
  }
  if (rawText && rawText.length > 0) {
    return `rawText 中未出现激活配角（intent 命中 ${supportingCandidates} 个但正文未出场），不伪造功能`;
  }
  return "relevantCharacters 全部为焦点角色，本章无激活配角（焦点由 EnsembleLayering 管理）";
}

// ============================================================================
// Prompt block 格式化
// ============================================================================

/**
 * 把 SupportingFunctionContext 格式化为 raw prompt 的"配角章节功能"区块。
 *
 * 格式（确定性，无 LLM）：
 * ```
 * 配角章节功能（advisory 非硬门；非固定人数配额；功能需正文行为支持）：
 * - 苏婉【协助】（待 raw 生成后扫描验证）
 * - 老周【阻碍】（待 raw 生成后扫描验证）
 * ```
 *
 * raw 生成前（rawText=null）：所有 assignment 显示 primaryFunction=null 或待扫描。
 * raw 生成后：verified=true 显示功能标签；unverified 显示待人工确认。
 * assignments 为空时返回 null（不加入 prompt）。
 * 不含 aggregateQualityScore/totalScore/对白比例/段落长度/固定冲突数/人数配额等机械指标。
 */
export function formatSupportingFunctionPromptBlock(
  context: SupportingFunctionContext
): string | null {
  if (context.assignments.length === 0) {
    return null;
  }

  const lines: string[] = [];
  lines.push("配角章节功能（advisory 非硬门；非固定人数配额；功能需正文行为支持）：");

  const functionLabels: Record<SupportingFunctionType, string> = {
    foil: "衬托",
    witness: "见证",
    obstacle: "阻碍",
    helper: "协助",
    "cost-bearer": "承担代价",
  };

  for (const a of context.assignments) {
    if (a.verified && a.primaryFunction) {
      const label = functionLabels[a.primaryFunction];
      lines.push(`- ${a.name}【${label}】（已由正文行为支持）`);
    } else if (a.primaryFunction) {
      const label = functionLabels[a.primaryFunction];
      lines.push(`- ${a.name}【${label}？】（待人工确认：${a.conflictAdvisory ?? "功能冲突"}）`);
    } else {
      lines.push(`- ${a.name}【功能待扫描】（raw 生成后将检测功能行为）`);
    }
  }

  if (context.humanReviewFocus) {
    lines.push(`人工审阅焦点：${context.humanReviewFocus}`);
  }

  return lines.join("\n");
}

// ============================================================================
// Skipped 构造（用于 hardBlock / 异常路径，保证 stageResults 不静默）
// ============================================================================

/**
 * 构造 skipped SupportingFunctionContext（用于 hardBlock / raw 生成失败路径）。
 * 与其他 compiler skipped 构造同模式：失败路径写 reason，不静默。
 */
export function skippedSupportingFunction(reason: string): SupportingFunctionContext {
  return {
    assignments: [],
    sourceRefs: [],
    consumedByRawPrompt: false,
    advisoryOnly: true,
    canTriggerEditorialOpportunity: false,
    humanReviewFocus: null,
    emptyReason: `skipped: ${reason}`,
    proxyNote: PROXY_NOTE,
  };
}
