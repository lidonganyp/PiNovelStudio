/**
 * 本任务专用 fixture：正常全书大纲 + 独立章节种子 + 角色/伏笔 + 第一章正文 + 过期 state hash。
 */
export const FIXTURE_STORY_OUTLINE = [
  '# 故事大纲',
  '## 第一卷：雨夜',
  '1. 第一章：铜哨再现',
  '   沈砚在雨夜车祸后重生，发现十五年前遗失的铜哨出现在现实。',
  '2. 第二章：不要相信沈建国',
  '   沈砚带着铜哨追查父亲留下的禁令，不能复述第一章已发生的情节。',
].join('\n');

export const FIXTURE_POLLUTED_OUTLINE = [
  '[[CHAPTER_SEED_START]]',
  '章节号：2',
  '意图：复述第一章雨夜翻车',
  '[[CHAPTER_SEED_END]]',
  '[[GENERATE_CHAPTER:2]]',
].join('\n');

export const FIXTURE_CHAPTER_ONE = [
  '电动车穿过跨江大桥。苏晴离开了。沈砚握紧铜哨：不要相信沈建国。',
].join('');

export const FIXTURE_CHAPTER_TWO_SEED = {
  chapterNumber: 2,
  intent: '追查铜哨来历并验证沈建国的禁令',
  mustInclude: '铜哨、沈建国的禁令',
  forbiddenFacts: '不得让沈砚尚未重生',
  characterMotives: '沈砚：确认父亲是否在隐瞒',
  promises: '不要相信沈建国',
  endingGoal: '留下新的未完成压力',
};

export const STALE_STATE_HASH = '39e1530b9e06';

export function makeStaleNarrativeState(actualChapterText = FIXTURE_CHAPTER_ONE): string {
  return JSON.stringify({
    workspaceId: 'p128',
    lastCommittedChapter: 'ch1',
    canon: [
      {
        id: 'canon:accepted-chapter:1',
        sourceChapter: 'ch1',
        sourceRef: `ch1#finalText:${STALE_STATE_HASH}:0-40`,
        fact: `第1章接受稿：${actualChapterText.repeat(20)}`,
      },
      {
        id: 'canon:whistle',
        sourceChapter: 'ch1',
        sourceRef: `ch1#finalText:${STALE_STATE_HASH}:12-40`,
        fact: '现实中出现了十五年前遗失的铜哨',
      },
    ],
    character: [
      { characterId: '沈砚', field: 'acceptedChapterEvidence', value: actualChapterText },
      { characterId: '沈砚', field: 'currentState', value: '握着铜哨，不信沈建国' },
      { characterId: '沈砚', field: 'participation', value: 'present' },
    ],
    promise: [
      { description: '不要相信沈建国', status: 'open', sourceChapter: 'ch1' },
    ],
    pattern: [{ patternType: 'sentence_risk', description: '翻译腔' }],
    eventLog: [{ event: actualChapterText }],
  });
}

export const FIXTURE_CHARACTERS = [
  {
    name: '沈砚',
    roleType: 'protagonist',
    identity: '重生者',
    goals: '',
    motivation: '',
    currentState: '握着铜哨',
    relationships: '',
  },
];
