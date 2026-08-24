/**
 * 资料缺口分类：ready / auto_fill / confirmation_required / hard_blocked。
 * 普通资料缺失不得变成技术阻断；推断必须带来源，且不得使用平台默认题材/风格/宪法。
 */
import type { ProjectContextSnapshot } from './project-context-reader';
import { chapterTitleMatches } from './chapter-number';

export type MaterialReadinessStatus =
  | 'ready'
  | 'auto_fill'
  | 'confirmation_required'
  | 'hard_blocked';

export interface MaterialProposal {
  field: string;
  value: string;
  source: string[];
  requiresConfirmation: boolean;
}

export interface MaterialReadiness {
  status: MaterialReadinessStatus;
  missing: string[];
  proposals: MaterialProposal[];
  hardBlockReason?: string;
  chapterNumber: number;
  sourceVersion: string;
}

const GENRE_KEYWORDS = [
  '都市重生', '都市', '玄幻', '仙侠', '武侠', '悬疑', '科幻', '历史',
  '言情', '重生', '灵异', '游戏', '末世',
];

export function classifyMaterialReadiness(
  snapshot: ProjectContextSnapshot,
  chapterNumber: number,
): MaterialReadiness {
  if (snapshot.hashMismatch) {
    const chapterLabel = snapshot.hashMismatch.chapterNumber > 0
      ? `第${snapshot.hashMismatch.chapterNumber}章`
      : '前章';
    return {
      status: 'hard_blocked',
      missing: [],
      proposals: [],
      hardBlockReason: `${chapterLabel}正文已修改，但叙事状态哈希尚未同步（状态记录 ${snapshot.hashMismatch.expected}，当前正文 ${snapshot.hashMismatch.actual}）`,
      chapterNumber,
      sourceVersion: snapshot.sourceVersion,
    };
  }

  const corpus = collectCorpus(snapshot, chapterNumber);
  const missing: string[] = [];
  const proposals: MaterialProposal[] = [];

  if (!snapshot.project.genre.trim()) {
    missing.push('项目类型');
    const inferred = inferGenre(corpus.text);
    proposals.push({
      field: 'genre',
      value: inferred?.value ?? '',
      source: inferred?.source ?? [],
      // Genre is an author contract field. Even when text suggests a genre,
      // do not silently replace the author's declaration with an inference.
      requiresConfirmation: true,
    });
  }
  if (!documentContent(snapshot, 'worldbuilding')) {
    missing.push('世界观');
    proposals.push(inferWorldbuilding(snapshot, corpus));
  }
  if (!documentContent(snapshot, 'creative_constitution')) {
    missing.push('创作宪法');
    proposals.push(inferConstitution(snapshot, corpus));
  }
  if (!documentContent(snapshot, 'style_profile')) {
    missing.push('风格档案');
    proposals.push(inferStyle(snapshot, corpus));
  }

  const chapter = snapshot.chapters.find((row) => row.chapterNumber === chapterNumber);
  const seedReady = Boolean(chapter?.seed?.intent.trim() && chapter.seed.endingGoal.trim());
  if (!seedReady) {
    missing.push('章节种子');
    const seed = inferChapterSeed(snapshot, chapterNumber);
    proposals.push({
      field: 'chapter_seed',
      value: seed.value,
      source: seed.source,
      requiresConfirmation: seed.requiresConfirmation,
    });
  }

  const charactersThin = snapshot.characters.length === 0
    || snapshot.characters.every((row) => !row.goals.trim() && !row.motivation.trim() && !row.currentState.trim());
  if (charactersThin) {
    missing.push('角色目标/动机/状态');
    proposals.push(inferCharacterNotes(snapshot, corpus));
  }

  // Canon/Promise ledgers 由 FinalStateCommit 从已接受正文系统提取，不是作者
  // 手工资料：正文没有沉淀出伏笔时 ledgers 为空是合法创作状态，不应作为
  // 作者资料缺口要求确认（空值提案确认后无法写入，会形成确认死锁）。
  // 作者要埋伏笔走 chapter seed 的 promises / 显式章纲通道。
  void snapshot.narrativeCompact;

  const confirmation = proposals.filter((row) => row.requiresConfirmation && !row.value.trim());
  const needsConfirm = proposals.some((row) => row.requiresConfirmation);
  const autoOnly = proposals.length > 0 && proposals.every((row) => !row.requiresConfirmation);

  let status: MaterialReadinessStatus = 'ready';
  if (confirmation.length > 0 && confirmation.every((row) => !row.value) && !corpus.text.trim() && snapshot.characters.length === 0) {
    status = 'confirmation_required';
  } else if (needsConfirm) {
    status = 'confirmation_required';
  } else if (autoOnly) {
    status = 'auto_fill';
  } else if (missing.length === 0) {
    status = 'ready';
  }

  if (status === 'ready' && !seedReady) {
    status = proposals.some((row) => row.field === 'chapter_seed' && !row.requiresConfirmation)
      ? 'auto_fill'
      : 'confirmation_required';
  }

  return {
    status,
    missing,
    proposals,
    chapterNumber,
    sourceVersion: snapshot.sourceVersion,
  };
}

// Reserved for explicit author-confirmed narrative material proposals.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function inferNarrativeProposal(
  snapshot: ProjectContextSnapshot,
  _corpus: { text: string; sources: string[] },
  field: 'canon_state' | 'promise_ledger',
): MaterialProposal {
  // 叙事正文末段摘录不是事实清单，也不是伏笔清单：把它自动灌进
  // canon/promise 会污染 ledgers，并在后续章节被 must-verify 覆盖门
  // 判为无法覆盖的高风险伏笔（must_verify_coverage_failed）。
  // 因此推断提案只提示缺失，不携带值；作者确认空值提案时不会写入。
  void _corpus;
  return {
    field,
    value: '',
    source: snapshot.previousContinuation
      ? [`chapter:${snapshot.previousContinuation.chapterNumber}`]
      : [],
    requiresConfirmation: true,
  };
}

function documentContent(snapshot: ProjectContextSnapshot, type: string): string {
  return snapshot.documents.find((row) => row.documentType === type)?.content.trim() ?? '';
}

function collectCorpus(snapshot: ProjectContextSnapshot, chapterNumber: number): { text: string; sources: string[] } {
  const sources: string[] = [];
  const parts: string[] = [];
  if (snapshot.project.title.trim()) {
    parts.push(snapshot.project.title);
    sources.push('project.title');
  }
  if (snapshot.project.description.trim()) {
    parts.push(snapshot.project.description);
    sources.push('project.description');
  }
  if (snapshot.outline?.usable) {
    parts.push(snapshot.outline.content);
    sources.push('story_outline');
  }
  for (const node of snapshot.outlineNodes) {
    parts.push(`${node.title}\n${node.summary}\n${node.narrativeGoal}`);
    sources.push(`outline_node:${node.title}`);
  }
  for (const character of snapshot.characters) {
    parts.push([character.name, character.identity, character.goals, character.motivation, character.currentState].join(' '));
    sources.push(`character:${character.name}`);
  }
  for (const chapter of snapshot.chapters) {
    if (chapter.chapterNumber >= chapterNumber) continue;
    parts.push(`${chapter.title}\n${chapter.excerpt}\n${chapter.tailExcerpt}`);
    sources.push(`chapter:${chapter.chapterNumber}`);
    if (chapter.seed) {
      parts.push(`${chapter.seed.intent}\n${chapter.seed.promises}\n${chapter.seed.endingGoal}`);
      sources.push(`chapter_seed:${chapter.chapterNumber}`);
    }
  }
  return { text: parts.join('\n'), sources: [...new Set(sources)] };
}

function inferGenre(text: string): { value: string; source: string[] } | null {
  for (const keyword of GENRE_KEYWORDS) {
    if (text.includes(keyword)) {
      return { value: keyword, source: [`text:${keyword}`] };
    }
  }
  return null;
}

function inferWorldbuilding(snapshot: ProjectContextSnapshot, corpus: { text: string; sources: string[] }): MaterialProposal {
  const facts = [
    ...snapshot.narrativeCompact.canon.map((row) => row.fact),
    ...extractNamedDetails(snapshot),
  ].filter(Boolean).slice(0, 8);
  const value = facts.length > 0
    ? ['# 世界观', '', ...facts.map((item) => `- ${item}`)].join('\n')
    : '';
  return {
    field: 'worldbuilding',
    value,
    source: corpus.sources.filter((item) => item.startsWith('chapter:') || item === 'story_outline' || item.startsWith('character:')),
    requiresConfirmation: value.length === 0,
  };
}

function inferConstitution(snapshot: ProjectContextSnapshot, corpus: { text: string; sources: string[] }): MaterialProposal {
  const rules = [
    snapshot.characters.length > 0 ? '不违背已确立的人物身份、能力与关系。' : '',
    snapshot.chapters.length > 0 ? '不改写已发生的前章事实。' : '',
    ...snapshot.chapters.flatMap((row) => row.seed?.forbiddenFacts ? [row.seed.forbiddenFacts] : []),
  ].filter(Boolean);
  const value = rules.length > 0
    ? ['# 创作宪法', '', ...rules.map((item) => `- ${item}`)].join('\n')
    : '';
  return {
    field: 'creative_constitution',
    value,
    source: corpus.sources,
    requiresConfirmation: value.length === 0,
  };
}

function inferStyle(snapshot: ProjectContextSnapshot, corpus: { text: string; sources: string[] }): MaterialProposal {
  const previous = snapshot.previousContinuation?.tailExcerpt.trim() ?? '';
  const value = previous
    ? JSON.stringify({
        name: snapshot.project.title || '作品风格',
        profileRole: 'workspace_author_style',
        usagePolicy: { fullChapterOptimization: 'required', selectionAuthority: 'user_feedback' },
        editorialGuidance: [
          '沿用已有正文的人称与叙述距离，不另起一套腔调。',
          '章末优先停在仍有叙事压力的动作、状态或物件细节上。',
        ],
      }, null, 2)
    : JSON.stringify({
        name: snapshot.project.title || '作品风格',
        profileRole: 'workspace_author_style',
        usagePolicy: { fullChapterOptimization: 'required', selectionAuthority: 'user_feedback' },
        authorDecision: 'defer_style_until_author_feedback',
        // 空指导落库后统一主链路作者风格整章优化会 no_guidance hard block；
        // 初始档案必须携带最小可消费的定性指导，风格细节仍待作者反馈后细化。
        editorialGuidance: [
          '采用贴近主角感知的第三人称限知视角，保持叙述距离一致。',
          '以动作与对话交替推进场景，避免长段静态描写或设定罗列。',
          '章末优先停在仍有叙事压力的动作、状态或物件细节上。',
        ],
      }, null, 2);
  return {
    field: 'style_profile',
    value,
    source: previous
      ? [`chapter:${snapshot.previousContinuation?.chapterNumber}`]
      : [...corpus.sources, 'assistant:initial_style_deferred'],
    requiresConfirmation: value.length === 0,
  };
}

function inferChapterSeed(snapshot: ProjectContextSnapshot, chapterNumber: number): MaterialProposal {
  const node = snapshot.outlineNodes.find((row) => chapterTitleMatches(row.title, chapterNumber));
  const outlineLine = snapshot.outline?.content
    .split('\n')
    .find((line) => chapterTitleMatches(line, chapterNumber));
  const previous = snapshot.previousContinuation;
  const promises = [
    ...snapshot.narrativeCompact.promise.map((row) => row.description),
    ...snapshot.chapters.flatMap((row) => row.seed?.promises ? [row.seed.promises] : []),
  ].filter(Boolean);
  const sourcedIntent = (node?.narrativeGoal || node?.summary || node?.title || outlineLine || '').trim();
  const projectLead = [snapshot.project.description, snapshot.project.title, snapshot.characters[0]?.identity]
    .map((item) => item?.trim())
    .find(Boolean);
  const intent = sourcedIntent || (projectLead
    ? `围绕${projectLead.slice(0, 120)}展开第${chapterNumber}章`
    : `按用户确认的项目资料推进第${chapterNumber}章`);
  const ending = node?.summary
    ? '留下可续写的章末压力'
    : previous
      ? '承接前章停点并留下新的未完成压力'
      : '形成可继续推进的章末叙事压力';
  const value = intent
    ? JSON.stringify({
        chapterNumber,
        intent: intent.replace(/^\s*\d+\.\s*/, '').trim(),
        mustInclude: promises.slice(0, 4).join('；'),
        forbiddenFacts: '不得改写已发生的前章事实',
        characterMotives: snapshot.characters.map((row) => `${row.name}：${row.motivation || row.goals || row.identity}`).join('；'),
        promises: promises.join('；'),
        endingGoal: ending,
      })
    : '';
  return {
    field: 'chapter_seed',
    value,
    source: [
      ...(node ? [`outline_node:${node.title}`] : []),
      ...(outlineLine ? ['story_outline'] : []),
      ...(previous ? [`chapter:${previous.chapterNumber}`] : []),
      ...(!sourcedIntent && projectLead
        ? [snapshot.project.description.trim() ? 'project.description' : 'project.title']
        : []),
      ...(!sourcedIntent && !projectLead ? ['assistant:initial_chapter_seed'] : []),
    ],
    requiresConfirmation: !sourcedIntent,
  };
}

function inferCharacterNotes(snapshot: ProjectContextSnapshot, corpus: { text: string; sources: string[] }): MaterialProposal {
  const lines = snapshot.characters.map((row) => {
    const state = row.currentState.trim()
      || snapshot.narrativeCompact.character.find((item) => item.characterId === row.name)?.value
      || snapshot.previousContinuation?.tailExcerpt
      || '';
    return `${row.name}|${row.goals || row.identity}|${row.motivation}|${state}`;
  });
  return {
    field: 'character_states',
    value: lines.join('\n'),
    source: corpus.sources.filter((item) => item.startsWith('character:') || item.startsWith('chapter:')),
    requiresConfirmation: lines.length === 0 || lines.every((line) => !line.trim()),
  };
}

function extractNamedDetails(snapshot: ProjectContextSnapshot): string[] {
  const facts: string[] = [];
  for (const character of snapshot.characters) {
    const line = [character.name, character.identity].filter((item) => item.trim()).join('：');
    if (line) facts.push(line);
  }
  for (const node of snapshot.outlineNodes) {
    if (node.summary.trim()) facts.push(node.summary.trim());
    else if (node.title.trim()) facts.push(node.title.trim());
  }
  const tail = snapshot.previousContinuation?.tailExcerpt.trim();
  if (tail) facts.push(tail);
  return facts;
}
