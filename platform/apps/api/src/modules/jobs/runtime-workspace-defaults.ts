/**
 * HTTP 生成物化缺省：聊天项目通常没有风格档案/宪法，
 * 统一主链路 Preflight 会因此在模型调用前 hard block。
 */
export const DEFAULT_PROJECT_GENRE = '都市';

export const DEFAULT_STYLE_PROFILE = {
  name: 'platform-default',
  id: 'platform-default',
  version: '1.0',
  profileRole: 'workspace_author_style',
  usagePolicy: {
    rawPrompt: 'not_applicable',
    editorialCandidate: 'full_chapter_required',
    fullChapterOptimization: 'required',
    selectionAuthority: 'user_feedback',
    statisticsRole: 'diagnostic_only',
  },
  editorialGuidance: [
    '叙述保持第三人称有限，锚定主角当下可感知的范围。',
    '情绪优先通过身体反应、静默或动作呈现，不直接替人物命名。',
    '汉语表达自然直接，少用翻译腔、外貌清单和解释性独白。',
    '章末优先停在仍有叙事压力的动作、状态或静物细节上。',
  ],
  characterVoiceGuidance: {},
} as const;

export const DEFAULT_CREATIVE_CONSTITUTION = [
  '# 创作宪法',
  '',
  '- 不违背已确立的人物身份、能力与关系。',
  '- 不引入未声明的世界观规则。',
  '- 本章必须推进既定冲突，并在章末留下可续写的压力。',
].join('\n');

export const DEFAULT_WORLDBUILDING = [
  '# 世界观',
  '',
  '以项目题材为准，保持内部自洽；未声明的规则不得突然生效。',
].join('\n');

export function resolveProjectGenre(genre: string | null | undefined): string {
  const trimmed = genre?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : DEFAULT_PROJECT_GENRE;
}

export function buildExplicitOutlineMarkdown(input: {
  intent: string;
  mustInclude: string;
  forbiddenFacts: string;
  characterMotives: string;
  promises: string;
  endingGoal: string;
  characterNames: string[];
}): string {
  const intent = input.intent.trim() || '推进本章冲突';
  const endingGoal = input.endingGoal.trim() || '留下可续写的章末压力';
  const names = input.characterNames.map((name) => name.trim()).filter(Boolean);
  const participants = names.length > 0 ? names.join('、') : '主角';
  const title = intent.replace(/\s+/g, ' ').slice(0, 40);
  const summaryParts = [intent];
  if (input.mustInclude.trim()) summaryParts.push(input.mustInclude.trim());
  if (input.characterMotives.trim()) summaryParts.push(input.characterMotives.trim());
  const summary = summaryParts.join('。');

  return [
    '# 本章功能',
    '推进本章冲突',
    '',
    `## 事件 1：${title}`,
    `参与角色：${participants}`,
    `内容摘要：${summary}`,
    `章末目标：${endingGoal}`,
  ].join('\n');
}

export function describeGenerationFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 1000) : 'generation failed';
}
