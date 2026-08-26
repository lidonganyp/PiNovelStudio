import { describe, expect, it } from 'vitest';
import { classifyMaterialReadiness } from './material-readiness';
import type { ProjectContextSnapshot } from './project-context-reader';

/**
 * 初始风格档案草案契约：统一主链路作者风格整章优化阶段要求风格档案
 * 至少携带一条可消费的定性指导（editorialGuidance），否则 no_guidance
 * hard block。草案无论有无前章正文都必须满足该契约。
 */
function makeSnapshot(overrides: {
  chapters?: ProjectContextSnapshot['chapters'];
  previousContinuation?: ProjectContextSnapshot['previousContinuation'];
}): ProjectContextSnapshot {
  return {
    projectId: 128,
    userId: 1,
    sourceVersion: 'v1',
    project: { title: '我的世界', description: '', genre: '', subGenres: [], worldKeyTerms: [], version: 1 },
    outline: { id: 1, content: '# 故事大纲\n- 主角设定梦境', currentVersion: 1, usable: true },
    outlineNodes: [],
    characters: [{
      id: 1, name: '周衍', roleType: 'protagonist', identity: '造梦者',
      goals: '', motivation: '', currentState: '', relationships: '', secrets: '', characterArc: '', version: 1,
    }],
    documents: [],
    chapters: overrides.chapters ?? [],
    chapterVersions: [],
    feedback: [],
    assistantHistory: [],
    generationJobs: [],
    narrativeCompact: { canon: [], character: [], promise: [] },
    ...(overrides.previousContinuation ? { previousContinuation: overrides.previousContinuation } : {}),
  } as ProjectContextSnapshot;
}

function styleProposalOf(readiness: ReturnType<typeof classifyMaterialReadiness>) {
  return readiness.proposals.find((row) => row.field === 'style_profile');
}

it('auto-fills inferable author materials when the outline and prior chapter are authoritative', () => {
  const snapshot = makeSnapshot({
    chapters: [{
      chapterNumber: 16,
      title: '第16章',
      excerpt: '李一凡握住魂体功法，天渊的线索再次出现。',
      tailExcerpt: '天渊的线索再次出现。',
      wordCount: 1800,
      version: 1,
      contentHash: 'hash16',
      seed: { intent: '追查天渊', mustInclude: '', forbiddenFacts: '', characterMotives: '', promises: '查明墨老下落', endingGoal: '留下新线索', version: 1 },
    }],
    previousContinuation: { chapterNumber: 16, tailExcerpt: '天渊的线索再次出现。', sourceChapterHash: 'hash16' },
  });
  snapshot.project.genre = '玄幻';
  snapshot.outline = {
    id: 1,
    content: '# 故事大纲\n第17章：魂体功法指向天渊，李一凡必须作出选择。',
    currentVersion: 1,
    usable: true,
  };
  snapshot.outlineNodes = [{
    title: '第17章：魂体功法指向天渊',
    summary: '李一凡发现新的线索',
    nodeType: 'chapter',
    narrativeGoal: '推进天渊暗线',
    version: 1,
  }];
  const readiness = classifyMaterialReadiness(snapshot, 17);
  expect(readiness.status).toBe('auto_fill');
  expect(readiness.proposals.filter((row) => row.value.trim()).every((row) => !row.requiresConfirmation)).toBe(true);
});

it('automatically adopts an explicit genre found in the outline when the project genre is empty', () => {
  const snapshot = makeSnapshot({});
  snapshot.outline = {
    id: 1,
    content: `# ${'\u6545\u4e8b\u5927\u7eb2'}\n${'\u90fd\u5e02\u5f02\u80fd'}: ${'\u4e3b\u89d2\u5728\u65e7\u57ce\u8ffd\u67e5\u5931\u8e2a\u6848'}`,
    currentVersion: 1,
    usable: true,
  };

  const readiness = classifyMaterialReadiness(snapshot, 1);
  const genre = readiness.proposals.find((row) => row.field === 'genre');

  expect(genre?.value).toContain('\u90fd\u5e02');
  expect(genre?.requiresConfirmation).toBe(false);
});

it('requires confirmation only when an explicit outline genre conflicts with the project genre', () => {
  const snapshot = makeSnapshot({});
  snapshot.project.genre = '\u7384\u5e7b';
  snapshot.outline = {
    id: 1,
    content: `# ${'\u6545\u4e8b\u5927\u7eb2'}\n${'\u90fd\u5e02\u5f02\u80fd'}: ${'\u4e3b\u89d2\u5728\u65e7\u57ce\u8ffd\u67e5\u5931\u8e2a\u6848'}`,
    currentVersion: 1,
    usable: true,
  };

  const readiness = classifyMaterialReadiness(snapshot, 1);
  const genre = readiness.proposals.find((row) => row.field === 'genre');

  expect(genre?.requiresConfirmation).toBe(true);
  expect(genre?.source).toEqual(expect.arrayContaining(['project.genre']));
  expect(readiness.status).toBe('confirmation_required');
});

describe('classifyMaterialReadiness style_profile contract', () => {
  it('initial style proposal carries consumable editorial guidance without previous chapters', () => {
    // 第 1 章生成：无前章正文，previousContinuation 缺失。
    const readiness = classifyMaterialReadiness(makeSnapshot({}), 1);
    const proposal = styleProposalOf(readiness);

    expect(proposal).toBeDefined();
    expect(proposal?.value.trim()).not.toBe('');
    const parsed = JSON.parse(proposal?.value ?? '') as { editorialGuidance?: string[] };
    expect(Array.isArray(parsed.editorialGuidance)).toBe(true);
    expect(parsed.editorialGuidance?.length ?? 0).toBeGreaterThan(0);
    expect(parsed.editorialGuidance?.every((item) => item.trim().length > 0)).toBe(true);
  });

  it('style proposal still carries guidance when previous chapter exists', () => {
    const readiness = classifyMaterialReadiness(makeSnapshot({
      previousContinuation: { chapterNumber: 1, tailExcerpt: '他睁开眼，回到了现实。', sourceChapterHash: 'abc' },
    }), 2);
    const proposal = styleProposalOf(readiness);

    expect(proposal).toBeDefined();
    const parsed = JSON.parse(proposal?.value ?? '') as { editorialGuidance?: string[] };
    expect(parsed.editorialGuidance?.length ?? 0).toBeGreaterThan(0);
  });
});
