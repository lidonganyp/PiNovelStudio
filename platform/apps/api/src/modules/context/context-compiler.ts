/**
 * 统一 ContextCompiler：聊天规划与正式章节生成共用同一套分层、hash、预算规则。
 */
import { createHash } from 'node:crypto';
import {
  compactNarrativeStateJson,
  excerptLastSentences,
  isUsableStoryOutline,
  type CompactNarrativeState,
} from '../jobs/book-context';
import {
  FAILURE_CODES,
  ContextCompileError,
  makeFailure,
} from './failure-envelope';
import {
  blockBudget,
  clipToTokenBudget,
  estimateTokens,
  getContextBudgetProfile,
  totalBudget,
} from './token-budget';
import {
  MAX_EVIDENCE_SPAN_CHARS,
  MAX_EVIDENCE_SPANS,
  type ContextBlockManifest,
  type ContextBlockName,
  type ContextManifest,
  type ContextBudgetProfileName,
  type ContextRetrievalCoverage,
  type EvidenceSpan,
  type PreviousChapterContinuation,
} from './types';

export interface CompilerCharacter {
  name: string;
  roleType: string;
  identity: string;
  goals?: string;
  motivation?: string;
  currentState?: string;
  relationships?: string;
  personality?: string;
  abilities?: string;
  secrets?: string;
  characterArc?: string;
  notes?: string;
  aliases?: unknown;
}

export interface CompilerSeed {
  chapterNumber: number;
  intent: string;
  mustInclude: string;
  forbiddenFacts: string;
  characterMotives: string;
  promises: string;
  endingGoal: string;
}

export interface CompilerChapter {
  chapterNumber: number;
  title?: string | null;
  status?: string | null;
  wordCount?: number | null;
  content: string;
  seed?: Partial<CompilerSeed> | null;
  outlineSummary?: string | null;
}

export interface CompileProjectContextInput {
  /** Prompt context tier. The legacy default remains 16k for standalone callers. */
  contextProfile?: ContextBudgetProfileName | string;
  recentChapterCount?: number;
  historicalQueries?: string[];
  storyOutline?: { id?: number; content: string; currentVersion?: number };
  chapterCatalog?: CompilerChapter[];
  supportingMaterials?: Array<{ documentType: string; title?: string; content: string }>;
  chapterSeed?: CompilerSeed;
  characters: CompilerCharacter[];
  narrativeState?: { id?: number; content: string; currentVersion?: number };
  previousChapter?: { chapterNumber: number; content: string };
  styleProfile?: { id?: number; content: string; currentVersion?: number };
  worldbuilding?: { content: string };
  constitution?: { content: string };
  evidenceQuery?: { query: string; purpose: string };
  currentChapterOutline?: { content: string };
  enforceStateHash?: boolean;
}

export interface CompiledProjectContext {
  manifest: ContextManifest;
  bookBrief: string;
  compactNarrativeJson?: string;
  compact: CompactNarrativeState;
  previousChapterContinuation?: PreviousChapterContinuation;
  selectedEvidenceSpans: EvidenceSpan[];
  usableStoryOutline?: string;
  /**
   * 未经 token 预算裁剪的可用大纲全文。
   *
   * `usableStoryOutline` 是给模型的提示词副本，受 storyOutline 块预算裁剪（头部保留、
   * 尾部丢弃）。但下游 FactGuard 依据同一份材料判定「高影响新设定是否已获来源授权」，
   * 裁剪会让大纲尾部已存在的术语（如「封印」）被误判为未授权新增设定并硬阻断整章。
   * 授权判定与提示词预算是两类需求，因此分开物化：此字段只供授权使用。
   */
  fullStoryOutline?: string;
  recentChapterContent?: string;
  historicalEvidenceText?: string;
  characterProfileMarkdown: string;
}

export function normalizeChapterText(text: string): string {
  return text.replace(/^\uFEFF/, '').trim();
}

export function hashChapterText(text: string): string {
  return createHash('sha256').update(normalizeChapterText(text), 'utf8').digest('hex').slice(0, 12);
}

export function findStateHashMismatch(
  narrativeJson: string | undefined,
  previousChapter: { chapterNumber: number; content: string } | undefined,
): { expected: string; actual: string } | null {
  if (!narrativeJson || !previousChapter) return null;
  const actual = hashChapterText(previousChapter.content);
  const hashes = collectFinalTextHashes(narrativeJson, previousChapter.chapterNumber);
  const mismatched = hashes.find((hash) => hash !== actual);
  if (!mismatched) return null;
  return { expected: mismatched, actual };
}

export function reanchorNarrativeStateToChapter(
  narrativeJson: string | undefined,
  chapterNumber: number,
  actualHash: string,
  sourceChapterNumber = chapterNumber,
): { content: string; updatedEntries: number } {
  if (!narrativeJson || !/^[0-9a-f]{12}$/i.test(actualHash)) {
    return { content: narrativeJson ?? '', updatedEntries: 0 };
  }
  try {
    const parsed = JSON.parse(narrativeJson) as Record<string, unknown>;
    const chapterId = `ch${chapterNumber}`;
    let updatedEntries = 0;
    for (const key of ['canon', 'character', 'promise', 'pattern', 'expectation']) {
      const rows = parsed[key];
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        if (reanchorSourceNode(row, sourceChapterNumber, chapterId, actualHash)) updatedEntries += 1;
      }
    }
    return { content: updatedEntries ? JSON.stringify(parsed, null, 2) : narrativeJson, updatedEntries };
  } catch {
    return { content: narrativeJson, updatedEntries: 0 };
  }
}

export function compileProjectContext(input: CompileProjectContextInput): CompiledProjectContext {
  const profile = getContextBudgetProfile(input.contextProfile);
  const profileName = profile.name;
  const mismatch = findStateHashMismatch(input.narrativeState?.content, input.previousChapter);
  if (mismatch && input.enforceStateHash !== false) {
    const chapterNumber = input.previousChapter?.chapterNumber;
    const chapterLabel = chapterNumber ? `第${chapterNumber}章` : '前章';
    throw new ContextCompileError(makeFailure({
      stage: 'runtime.preflight',
      gate: 'narrative_state',
      code: FAILURE_CODES.stateStoreHashMismatch,
      severity: 'preflight',
      reason: `${chapterLabel}正文与叙事状态哈希不一致，已阻断生成。请先同步状态后再试。`,
      evidence: {
        expectedHash: mismatch.expected,
        actualHash: mismatch.actual,
        chapterNumber,
      },
      recoverable: false,
      userActionRequired: [`同步${chapterLabel}的叙事状态哈希`, '重新预检后再提交生成'],
      fixInstructions: [
        `根据当前${chapterLabel}正文重算 SHA-256 前 12 位，写回 narrative_state 的 sourceRef`,
        '压缩整章接受稿，只保留事实、角色变化和未结承诺',
      ],
    }));
  }

  const blocks: ContextBlockManifest[] = [];
  const compact = input.narrativeState?.content
    ? compactNarrativeStateJson(input.narrativeState.content)
    : { json: undefined, compact: { canon: [], character: [], promise: [] } };

  const usableOutline = input.storyOutline?.content && isUsableStoryOutline(input.storyOutline.content)
    ? input.storyOutline.content.trim()
    : undefined;
  const outlineClip = includeBlock(blocks, profileName, {
    name: 'storyOutline',
    sourceType: 'novel_documents.story_outline',
    sourceId: input.storyOutline?.id,
    sourceVersion: input.storyOutline?.currentVersion,
    authorConfirmed: Boolean(usableOutline),
    text: usableOutline,
    omittedReason: input.storyOutline?.content
      ? 'polluted_or_unusable_story_outline'
      : 'story_outline_missing',
  });

  const chapterCatalogText = (input.chapterCatalog ?? [])
    .slice()
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .map((chapter) => {
      const seed = chapter.seed;
      const seedSummary = [seed?.intent, seed?.promises, seed?.endingGoal]
        .filter((value): value is string => Boolean(value?.trim()))
        .join('；');
      const tail = chapter.content?.trim() ? excerptLastSentences(chapter.content, 120) : '';
      return [
        `第${chapter.chapterNumber}章｜${chapter.title?.trim() || '未命名'}`,
        `状态：${chapter.status || 'unknown'}｜字数：${chapter.wordCount ?? 0}`,
        seedSummary ? `种子：${seedSummary}` : '',
        chapter.outlineSummary?.trim() ? `章节节点：${chapter.outlineSummary.trim()}` : '',
        tail ? `停点摘要：${tail}` : '',
      ].filter(Boolean).join('；');
    }).join('\n');
  const chapterCatalogClip = includeBlock(blocks, profileName, {
    name: 'chapterCatalog',
    sourceType: 'novel_chapters.catalog',
    authorConfirmed: Boolean(input.chapterCatalog?.length),
    text: chapterCatalogText,
    omittedReason: 'chapter_catalog_missing',
  });
  const supportingMaterialsText = (input.supportingMaterials ?? [])
    .filter((material) => material.content.trim())
    .map((material) => `【${material.documentType}】${material.title?.trim() || ''}\n${material.content.trim()}`)
    .join('\n\n');
  const supportingMaterialsClip = includeBlock(blocks, profileName, {
    name: 'supportingMaterials',
    sourceType: 'novel_documents.additional',
    authorConfirmed: Boolean(input.supportingMaterials?.length),
    text: supportingMaterialsText,
    omittedReason: 'additional_materials_missing',
  });

  const constitutionClip = includeBlock(blocks, profileName, {
    name: 'creativeConstitution',
    sourceType: 'novel_documents.creative_constitution',
    authorConfirmed: Boolean(input.constitution?.content?.trim()),
    text: input.constitution?.content,
    omittedReason: 'constitution_missing',
  });
  const worldClip = includeBlock(blocks, profileName, {
    name: 'worldbuilding',
    sourceType: 'novel_documents.worldbuilding',
    authorConfirmed: Boolean(input.worldbuilding?.content?.trim()),
    text: input.worldbuilding?.content,
    omittedReason: 'worldbuilding_missing',
  });
  const chapterOutlineClip = includeBlock(blocks, profileName, {
    name: 'currentChapterOutline',
    sourceType: 'novel_outline_nodes',
    authorConfirmed: Boolean(input.currentChapterOutline?.content?.trim()),
    text: input.currentChapterOutline?.content,
    omittedReason: 'current_chapter_outline_missing',
  });

  const seedText = input.chapterSeed
    ? [
        `章节号：${input.chapterSeed.chapterNumber}`,
        `意图：${input.chapterSeed.intent}`,
        `必须包含：${input.chapterSeed.mustInclude}`,
        `禁止事实：${input.chapterSeed.forbiddenFacts}`,
        `角色动机：${input.chapterSeed.characterMotives}`,
        `承诺：${input.chapterSeed.promises}`,
        `章末目标：${input.chapterSeed.endingGoal}`,
      ].join('\n')
    : undefined;
  const seedClip = includeBlock(blocks, profileName, {
    name: 'chapterSeed',
    sourceType: 'novel_chapter_seeds',
    authorConfirmed: Boolean(input.chapterSeed?.intent?.trim()),
    text: seedText,
    omittedReason: 'chapter_seed_missing',
  });

  const characterLines = input.characters.map((row) => characterLine(row));
  const characterClip = includeBlock(blocks, profileName, {
    name: 'characterStates',
    sourceType: 'novel_characters',
    authorConfirmed: input.characters.some((row) => Boolean(row.goals || row.motivation || row.currentState)),
    text: characterLines.join('\n'),
    omittedReason: 'characters_missing',
  });

  const canonClip = includeBlock(blocks, profileName, {
    name: 'canonState',
    sourceType: 'novel_documents.narrative_state.canon',
    sourceId: input.narrativeState?.id,
    sourceVersion: input.narrativeState?.currentVersion,
    sourceHash: input.previousChapter ? hashChapterText(input.previousChapter.content) : undefined,
    authorConfirmed: false,
    text: compact.compact.canon.map((row) => row.fact).join('\n'),
  });
  const promiseClip = includeBlock(blocks, profileName, {
    name: 'promiseLedger',
    sourceType: 'novel_documents.narrative_state.promise',
    authorConfirmed: false,
    text: compact.compact.promise.map((row) => row.description).join('\n'),
  });
  includeBlock(blocks, profileName, {
    name: 'patternMemory',
    sourceType: 'novel_documents.narrative_state.pattern',
    authorConfirmed: false,
    text: '',
    omittedReason: 'pattern_stripped_from_production_context',
  });
  const styleClip = includeBlock(blocks, profileName, {
    name: 'styleProfile',
    sourceType: 'novel_documents.style_profile',
    sourceId: input.styleProfile?.id,
    sourceVersion: input.styleProfile?.currentVersion,
    authorConfirmed: Boolean(input.styleProfile?.content?.trim()),
    text: input.styleProfile?.content,
    omittedReason: 'style_profile_missing',
  });

  let continuation: PreviousChapterContinuation | undefined;
  let continuationClip: { text: string; tokens: number };
  if (input.previousChapter) {
    const tail = excerptLastSentences(input.previousChapter.content);
    continuation = {
      chapterNumber: input.previousChapter.chapterNumber,
      endingState: tail,
      lastSceneSummary: tail,
      changedCharacters: unique(compact.compact.character.map((row) => row.characterId)),
      unresolvedPromises: compact.compact.promise.map((row) => row.description),
      tailExcerpt: tail,
      sourceChapterHash: hashChapterText(input.previousChapter.content),
    };
    continuationClip = includeBlock(blocks, profileName, {
      name: 'previousChapterContinuation',
      sourceType: 'novel_chapters.continuation',
      sourceHash: continuation.sourceChapterHash,
      authorConfirmed: true,
      text: [
        continuation.lastSceneSummary,
        continuation.unresolvedPromises.join('；'),
        continuation.changedCharacters.join('、'),
      ].join('\n'),
    });
  } else {
    continuationClip = includeBlock(blocks, profileName, {
      name: 'previousChapterContinuation',
      sourceType: 'novel_chapters.continuation',
      authorConfirmed: false,
      text: undefined,
      omittedReason: 'no_previous_chapter',
    });
  }

  const evidenceChapters = input.chapterCatalog?.length
    ? input.chapterCatalog.map((chapter) => ({
        chapterNumber: chapter.chapterNumber,
        content: chapter.content,
      }))
    : input.previousChapter
      ? [{ chapterNumber: input.previousChapter.chapterNumber, content: input.previousChapter.content }]
      : [];
  const targetChapterNumber = input.chapterSeed?.chapterNumber;
  const defaultRecentChapterCount = profileName === '512k'
    ? 15
    : profileName === '256k'
      ? 10
      : profileName === '128k'
        ? 5
        : 3;
  const recentChapterCount = Math.max(0, Math.floor(input.recentChapterCount ?? defaultRecentChapterCount));
  const recentCandidates = evidenceChapters
    .filter((chapter) => chapter.chapterNumber !== input.previousChapter?.chapterNumber)
    .filter((chapter) => targetChapterNumber === undefined || chapter.chapterNumber < targetChapterNumber)
    .sort((left, right) => right.chapterNumber - left.chapterNumber)
    .slice(0, recentChapterCount)
    .sort((left, right) => left.chapterNumber - right.chapterNumber);
  const recentChapterText = recentCandidates
    .map((chapter) => `第${chapter.chapterNumber}章\n${chapter.content.trim()}`)
    .join('\n\n');
  const recentClip = includeBlock(blocks, profileName, {
    name: 'recentChapterContent',
    sourceType: 'novel_chapters.recent_full_text',
    authorConfirmed: true,
    text: recentChapterText,
    omittedReason: recentCandidates.length === 0 ? 'no_recent_chapters' : undefined,
  });
  const requestedQueries = [...new Set([
    ...(input.historicalQueries ?? []),
    ...(input.evidenceQuery ? [input.evidenceQuery.query] : []),
  ].map((query) => query.trim()).filter(Boolean))];
  const maxEvidenceSpans = profileName === '512k' ? 48 : profileName === '256k' ? 24 : profileName === '128k' ? 12 : MAX_EVIDENCE_SPANS;
  const selectedEvidenceSpans = requestedQueries.length > 0 && evidenceChapters.length > 0
    ? requestedQueries.flatMap((query) => searchChapterCollectionSpans({
        chapters: evidenceChapters,
        query,
        purpose: input.evidenceQuery?.purpose ?? 'chapter_continuity',
        maxSpans: maxEvidenceSpans,
        spanBudget: blockBudget('selectedEvidenceSpans', profileName),
      })).slice(0, maxEvidenceSpans)
    : [];
  const evidenceClip = includeBlock(blocks, profileName, {
    name: 'selectedEvidenceSpans',
    sourceType: 'chapter_span_search',
    authorConfirmed: false,
    text: selectedEvidenceSpans.map((span) => span.text).join('\n'),
    omittedReason: selectedEvidenceSpans.length === 0 ? 'no_evidence_requested' : undefined,
  });

  const totalTokensUsed = blocks.reduce((sum, block) => sum + block.tokensUsed, 0);
  if (totalTokensUsed > totalBudget(profileName)) {
    throw new ContextCompileError(makeFailure({
      stage: 'runtime.preflight',
      gate: 'context_budget',
      code: FAILURE_CODES.contextBudgetExceeded,
      severity: 'preflight',
      reason: '上下文超出 token 预算，已阻断而不是静默截断关键字段',
      evidence: { totalTokensUsed, totalTokenBudget: totalBudget(profileName) },
      recoverable: false,
      userActionRequired: ['缩小检索范围或精简大纲'],
    }));
  }

  const briefParts = [
    '# 全书工作集',
    mismatch ? '## 状态警告\n前章叙事状态哈希与正文不一致，生成正文前必须先修复。' : '',
    section('创作宪法', constitutionClip.text),
    section('世界观', worldClip.text),
    section('大纲', outlineClip.text),
    section('章节目录与历史节点', chapterCatalogClip.text),
    section('其他项目资料', supportingMaterialsClip.text),
    section('本章规划', chapterOutlineClip.text),
    section('章节种子', seedClip.text),
    section('角色', characterClip.text),
    section('既成事实', canonClip.text),
    section('未结伏笔/承诺', promiseClip.text),
    section('风格档案', styleClip.text),
    section('前章停点', continuationClip.text),
    section('证据片段', evidenceClip.text),
    section('Recent Chapter Text', recentClip.text),
  ].filter(Boolean);
  const bookBrief = clipToTokenBudget(briefParts.join('\n\n'), totalBudget(profileName)).text;

  const retrievalCoverage: ContextRetrievalCoverage = {
    requestedQueries: requestedQueries.length,
    matchedQueries: new Set(selectedEvidenceSpans.map((span) => span.query).filter(Boolean)).size,
    historicalChaptersConsidered: evidenceChapters.length,
    spansReturned: selectedEvidenceSpans.length,
    recentChaptersRequested: recentChapterCount,
    recentChaptersIncluded: recentCandidates.length,
  };
  const truncatedBlocks = blocks
    .filter((block) => block.omittedReason === 'clipped_to_block_budget')
    .map((block) => block.name);

  return {
    manifest: {
      profile: profileName,
      totalTokenBudget: totalBudget(profileName),
      totalTokensUsed,
      estimatedInputTokens: estimateTokens(bookBrief),
      truncatedBlocks,
      retrievalCoverage,
      blocks,
      previousChapterContinuation: continuation,
      selectedEvidenceSpans,
    },
    bookBrief: bookBrief.trim(),
    compactNarrativeJson: compact.json,
    compact: compact.compact,
    previousChapterContinuation: continuation,
    selectedEvidenceSpans,
    usableStoryOutline: outlineClip.text || undefined,
    fullStoryOutline: usableOutline,
    recentChapterContent: recentClip.text || undefined,
    historicalEvidenceText: evidenceClip.text || undefined,
    characterProfileMarkdown: characterClip.text,
  };
}

export function searchChapterSpans(input: {
  chapterNumber: number;
  content: string;
  query: string;
  purpose: string;
  maxSpans?: number;
  spanBudget?: number;
}): EvidenceSpan[] {
  const query = input.query.trim();
  if (!query || !input.content.trim()) return [];
  const spans: EvidenceSpan[] = [];
  const haystack = input.content;
  let from = 0;
  const maxSpans = Math.max(1, Math.floor(input.maxSpans ?? MAX_EVIDENCE_SPANS));
  const spanBudget = Math.max(1, Math.floor(input.spanBudget ?? blockBudget('selectedEvidenceSpans')));
  while (spans.length < maxSpans) {
    const offset = haystack.indexOf(query, from);
    if (offset < 0) break;
    const start = Math.max(0, offset - 40);
    const end = Math.min(haystack.length, offset + query.length + 40);
    const raw = haystack.slice(start, Math.min(end, start + MAX_EVIDENCE_SPAN_CHARS));
    const clipped = clipToTokenBudget(raw, spanBudget / maxSpans);
    spans.push({
      chapterNumber: input.chapterNumber,
      offset: start,
      length: clipped.text.length,
      hash: hashChapterText(clipped.text),
      purpose: input.purpose,
      text: clipped.text,
      tokenCount: clipped.tokens,
      query,
    });
    from = offset + query.length;
  }
  return spans;
}

export function searchChapterCollectionSpans(input: {
  chapters: Array<{ chapterNumber: number; content: string }>;
  query: string;
  purpose: string;
  maxSpans?: number;
  spanBudget?: number;
}): EvidenceSpan[] {
  const query = input.query.trim();
  if (!query) return [];
  return input.chapters
    .flatMap((chapter) => searchChapterSpans({
      chapterNumber: chapter.chapterNumber,
      content: chapter.content,
      query,
      purpose: input.purpose,
      maxSpans: input.maxSpans,
      spanBudget: input.spanBudget,
    }))
    .slice(0, input.maxSpans ?? MAX_EVIDENCE_SPANS);
}

function section(title: string, text: string): string {
  return text.trim() ? `## ${title}\n${text.trim()}` : '';
}

function characterLine(row: CompilerCharacter): string {
  const extras = [
    row.goals && `目标：${row.goals}`,
    row.motivation && `动机：${row.motivation}`,
    row.currentState && `当前状态：${row.currentState}`,
    row.relationships && `关系：${row.relationships}`,
    row.personality && `性格：${row.personality}`,
    row.abilities && `能力/装备：${row.abilities}`,
    row.secrets && `秘密：${row.secrets}`,
    row.characterArc && `人物弧：${row.characterArc}`,
    row.notes && `备注：${row.notes}`,
  ].filter((item): item is string => Boolean(item?.trim()));
  const suffix = extras.length > 0 ? `；${extras.join('；')}` : '';
  return `${row.name}（${row.roleType}）：${row.identity}${suffix}`;
}

function includeBlock(
  blocks: ContextBlockManifest[],
  profile: ContextBudgetProfileName,
  input: {
    name: ContextBlockName;
    sourceType: string;
    sourceId?: number;
    sourceVersion?: number;
    sourceHash?: string;
    authorConfirmed: boolean;
    text?: string;
    omittedReason?: string;
  },
): { text: string; tokens: number } {
  const budget = blockBudget(input.name, profile);
  if (!input.text?.trim()) {
    blocks.push({
      name: input.name,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceVersion: input.sourceVersion,
      sourceHash: input.sourceHash,
      authorConfirmed: input.authorConfirmed,
      tokenBudget: budget,
      tokensUsed: 0,
      included: false,
      omittedReason: input.omittedReason,
    });
    return { text: '', tokens: 0 };
  }
  const clipped = clipToTokenBudget(input.text.trim(), budget);
  blocks.push({
    name: input.name,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    sourceVersion: input.sourceVersion,
    sourceHash: input.sourceHash,
    authorConfirmed: input.authorConfirmed,
    tokenBudget: budget,
    tokensUsed: clipped.tokens,
    included: true,
    omittedReason: clipped.truncated ? 'clipped_to_block_budget' : undefined,
  });
  return { text: clipped.text, tokens: clipped.tokens };
}

function collectFinalTextHashes(narrativeJson: string, chapterNumber: number): string[] {
  try {
    const parsed = JSON.parse(narrativeJson) as Record<string, unknown>;
    const rows = ['canon', 'character', 'promise', 'pattern', 'expectation']
      .flatMap((key) => (Array.isArray(parsed[key]) ? parsed[key] : []));
    const hashes: string[] = [];
    for (const row of rows) {
      for (const node of sourceNodes(row)) {
        const refs = nodeReferences(node);
        const sourceChapter = normalizeSourceChapter(node.sourceChapter)
          ?? refs.map(chapterFromSourceRef).find(Boolean);
        if (sourceChapter !== `ch${chapterNumber}`) continue;
        for (const sourceRef of refs) {
          const match = sourceRef.match(/#finalText:([0-9a-fA-F]{12})/);
          if (match) hashes.push(match[1].toLowerCase());
        }
      }
    }
    return hashes;
  } catch {
    return [];
  }
}

type JsonRecord = Record<string, unknown>;

/** 兼容旧版状态中的 sourceChapter: 17、"17"、"ch17" 和 "第17章"。 */
function normalizeSourceChapter(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return `ch${value}`;
  }
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  const direct = text.match(/^ch\s*(\d+)$/i) ?? text.match(/^(\d+)$/);
  if (direct) return `ch${Number.parseInt(direct[1], 10)}`;
  const titled = text.match(/^第\s*(\d+)\s*章$/);
  return titled ? `ch${Number.parseInt(titled[1], 10)}` : undefined;
}

function chapterFromSourceRef(value: string): string | undefined {
  const match = value.trim().match(/^(?:ch)?(\d+)#finalText:/i);
  return match ? `ch${Number.parseInt(match[1], 10)}` : undefined;
}

function sourceReferences(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(sourceReferences);
  if (!value || typeof value !== 'object') return [];
  const record = value as JsonRecord;
  return ['locator', 'ref', 'sourceRef', 'sourceRefs']
    .flatMap((key) => sourceReferences(record[key]));
}

function nodeReferences(node: JsonRecord): string[] {
  return [
    ...sourceReferences(node.sourceRef),
    ...sourceReferences(node.sourceRefs),
  ];
}

/** 找到顶层状态条目以及 memory 等嵌套对象中的来源锚点。 */
function sourceNodes(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.flatMap(sourceNodes);
  if (!value || typeof value !== 'object') return [];
  const record = value as JsonRecord;
  const nodes = ('sourceChapter' in record || 'sourceRef' in record || 'sourceRefs' in record)
    ? [record]
    : [];
  return [
    ...nodes,
    ...Object.values(record).flatMap(sourceNodes),
  ];
}

function rewriteSourceReferences(value: unknown, rewrite: (sourceRef: string) => string): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    const next = rewrite(value);
    return { value: next, changed: next !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const rewritten = rewriteSourceReferences(item, rewrite);
      changed ||= rewritten.changed;
      return rewritten.value;
    });
    return { value: next, changed };
  }
  if (!value || typeof value !== 'object') return { value, changed: false };
  const record = value as JsonRecord;
  let changed = false;
  const next: JsonRecord = { ...record };
  for (const [key, item] of Object.entries(record)) {
    const rewritten = rewriteSourceReferences(item, rewrite);
    changed ||= rewritten.changed;
    next[key] = rewritten.value;
  }
  return { value: next, changed };
}

function reanchorSourceNode(
  value: unknown,
  sourceChapterNumber: number,
  targetChapterId: string,
  actualHash: string,
): boolean {
  if (Array.isArray(value)) {
    let changed = false;
    for (const item of value) {
      const itemChanged = reanchorSourceNode(item, sourceChapterNumber, targetChapterId, actualHash);
      changed = changed || itemChanged;
    }
    return changed;
  }
  if (!value || typeof value !== 'object') return false;
  const record = value as JsonRecord;
  const refs = nodeReferences(record);
  const sourceChapter = normalizeSourceChapter(record.sourceChapter)
    ?? refs.map(chapterFromSourceRef).find(Boolean);
  const matches = sourceChapter === `ch${sourceChapterNumber}`;
  let changed = false;
  if (matches) {
    if ('sourceChapter' in record && record.sourceChapter !== targetChapterId) {
      record.sourceChapter = targetChapterId;
      changed = true;
    }
    for (const key of ['sourceRef', 'sourceRefs']) {
      if (!(key in record)) continue;
      const rewritten = rewriteSourceReferences(record[key], (sourceRef) => sourceRef
        .replace(new RegExp(`^(?:ch)?${sourceChapterNumber}(?=#finalText:)`, 'i'), targetChapterId)
        .replace(/(#finalText:)[0-9a-fA-F]{12}(?=:|$)/g, `$1${actualHash.toLowerCase()}`));
      if (rewritten.changed) {
        record[key] = rewritten.value;
        changed = true;
      }
    }
  }
  for (const child of Object.values(record)) {
    const childChanged = reanchorSourceNode(child, sourceChapterNumber, targetChapterId, actualHash);
    changed = changed || childChanged;
  }
  return changed;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function assertNoFullPreviousChapter(
  payload: unknown,
  previousChapterText: string | undefined,
): void {
  if (!previousChapterText || previousChapterText.trim().length < 40) return;
  const serialized = JSON.stringify(payload);
  if (serialized.includes(previousChapterText)) {
    throw new ContextCompileError(makeFailure({
      stage: 'runtime.preflight',
      gate: 'previous_chapter_boundary',
      code: FAILURE_CODES.runtimePreflightFailed,
      severity: 'hard',
      reason: '正式生成请求含有完整上一章正文，已阻断',
      recoverable: false,
    }));
  }
}

export { estimateTokens };
