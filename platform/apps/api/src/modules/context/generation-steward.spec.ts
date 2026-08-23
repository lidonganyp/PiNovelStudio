import { describe, expect, it, vi } from 'vitest';
import { FIXTURE_CHAPTER_ONE, FIXTURE_STORY_OUTLINE, makeStaleNarrativeState } from './fixtures';
import {
  buildConfirmationReply,
  confirmGenerationSteward,
  parseStewardAction,
  prepareGenerationSteward,
  reviseGenerationSteward,
} from './generation-steward';
import { compileProjectContextSnapshot } from './project-context-reader';
import { classifyMaterialReadiness } from './material-readiness';

function makePrisma(stored: { content?: string; currentVersion?: number } = {}) {
  const document = {
    id: 9,
    currentVersion: stored.currentVersion ?? 1,
    content: stored.content ?? '',
  };
  return {
    novelProject: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    novelDocument: {
      findFirst: vi.fn().mockResolvedValue(stored.content ? document : null),
      findMany: vi.fn(),
      create: vi.fn().mockResolvedValue(document),
      update: vi.fn(),
    },
    novelDocumentVersion: { create: vi.fn() },
    novelCharacter: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    novelOutlineNode: { findMany: vi.fn() },
    novelChapter: {
      findMany: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
      findFirstOrThrow: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 44, seed: { id: 7, intent: '', endingGoal: '', mustInclude: '', forbiddenFacts: '', characterMotives: '', promises: '' } }),
    },
    novelChapterSeed: {
      create: vi.fn(),
      update: vi.fn(),
    },
  };
}

describe('generation steward', () => {
  it('does not treat ordinary missing materials as a technical failure', () => {
    const snapshot = compileProjectContextSnapshot({
      userId: 1,
      project: {
        id: 128, userId: 1, title: '铜哨', description: '', genre: '',
        subGenres: [], worldKeyTerms: [], version: 1,
      },
      documents: [],
      characters: [],
      outlineNodes: [],
      chapters: [],
    });
    const readiness = classifyMaterialReadiness(snapshot, 2);
    const reply = buildConfirmationReply(readiness);
    expect(readiness.status).toBe('confirmation_required');
    expect(reply).toContain('已读取全书');
    expect(reply).not.toContain('runtime_preflight_failed');
    expect(reply).not.toContain('422');
    expect(reply).not.toContain('story_outline');
    expect(reply).not.toContain('chapter:');
  });

  it('throws only for true hard blocks such as hash mismatch', async () => {
    const prisma = makePrisma();
    prisma.novelProject.findFirst.mockResolvedValue({
      id: 128, userId: 1, title: '铜哨', description: '', genre: '',
      subGenres: [], worldKeyTerms: [], version: 1, deletedAt: null,
    });
    prisma.novelDocument.findMany.mockResolvedValue([{
      id: 84, documentType: 'narrative_state', content: makeStaleNarrativeState(),
      currentVersion: 1, updatedAt: new Date(),
    }]);
    prisma.novelCharacter.findMany.mockResolvedValue([]);
    prisma.novelOutlineNode.findMany.mockResolvedValue([]);
    prisma.novelChapter.findMany.mockResolvedValue([{
      chapterNumber: 1, title: '第一章', content: FIXTURE_CHAPTER_ONE,
      wordCount: 20, version: 1, seed: null,
    }]);
    await expect(prepareGenerationSteward({
      prisma: prisma as never, userId: 1, projectId: 128, chapterNumber: 2,
    })).rejects.toMatchObject({ envelope: { code: 'state_store_hash_mismatch' } });
  });

  it('saves a proposal without creating a generation job', async () => {
    const prisma = makePrisma();
    prisma.novelProject.findFirst.mockResolvedValue({
      id: 128, userId: 1, title: '铜哨', description: '', genre: '',
      subGenres: [], worldKeyTerms: [], version: 1, deletedAt: null,
    });
    prisma.novelDocument.findMany.mockResolvedValue([{
      id: 83, documentType: 'story_outline', content: FIXTURE_STORY_OUTLINE,
      currentVersion: 1, updatedAt: new Date(), deletedAt: null,
    }]);
    prisma.novelCharacter.findMany.mockResolvedValue([{
      id: 1, name: '沈砚', roleType: 'protagonist', identity: '重生者',
      goals: '', motivation: '', currentState: '', relationships: '',
      secrets: '', characterArc: '', version: 1,
    }]);
    prisma.novelOutlineNode.findMany.mockResolvedValue([{
      title: '第二章：不要相信沈建国', summary: '追查禁令', nodeType: 'chapter',
      narrativeGoal: '推进禁令', version: 1,
    }]);
    prisma.novelChapter.findMany.mockResolvedValue([{
      chapterNumber: 1, title: '第一章', content: FIXTURE_CHAPTER_ONE,
      wordCount: 20, version: 1, seed: null,
    }]);
    const result = await prepareGenerationSteward({
      prisma: prisma as never, userId: 1, projectId: 128, chapterNumber: 2,
    });
    expect(result.status).toBe('confirmation_required');
    expect(result.generationJobId).toBeUndefined();
    expect(result.proposalId).toBeTruthy();
    expect(prisma.novelDocument.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ documentType: 'material_proposal' }),
    }));
  });

  it('confirms a first-chapter proposal and submits generation instead of returning the same gap', async () => {
    const project = {
      id: 128, userId: 1, title: 'New work', description: 'Investigate the disappearance in the old city', genre: 'mystery',
      subGenres: [], worldKeyTerms: [], version: 1, deletedAt: null,
    };
    const documents: Array<Record<string, unknown>> = [
      { id: 1, documentType: 'worldbuilding', content: '# World\nOld city', currentVersion: 1, updatedAt: new Date(), deletedAt: null },
      { id: 2, documentType: 'creative_constitution', content: '# Constitution\nDo not rewrite confirmed facts', currentVersion: 1, updatedAt: new Date(), deletedAt: null },
    ];
    const chapters: Array<Record<string, unknown>> = [];
    const prisma = {
      novelProject: {
        findFirst: vi.fn().mockResolvedValue(project),
        update: vi.fn().mockResolvedValue(project),
      },
      novelDocument: {
        findMany: vi.fn().mockImplementation(async () => documents),
        findFirst: vi.fn().mockImplementation(async ({ where }: { where: { documentType?: string } }) => (
          documents.find((row) => row.documentType === where.documentType) ?? null
        )),
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: documents.length + 10, currentVersion: 1, updatedAt: new Date(), deletedAt: null, ...data };
          documents.push(row);
          return row;
        }),
        update: vi.fn(),
      },
      novelDocumentVersion: { create: vi.fn() },
      novelCharacter: {
        findMany: vi.fn().mockResolvedValue([{
          id: 1, name: 'Lin Mo', roleType: 'protagonist', identity: 'investigator', goals: 'solve the case',
          motivation: 'find his sister', currentState: 'returned to the old city', relationships: '', secrets: '', characterArc: '', version: 1,
        }]),
      },
      novelOutlineNode: { findMany: vi.fn().mockResolvedValue([]) },
      novelChapter: {
        findMany: vi.fn().mockImplementation(async () => chapters),
        findFirst: vi.fn().mockImplementation(async ({ where }: { where: { chapterNumber?: number } }) => (
          chapters.find((row) => row.chapterNumber === where.chapterNumber) ?? null
        )),
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, any> }) => {
          const created = {
            id: 44,
            chapterNumber: data.chapterNumber,
            title: data.title,
            content: '',
            wordCount: 0,
            version: 1,
            deletedAt: null,
            seed: {
              id: 7, intent: '', endingGoal: '', mustInclude: '', forbiddenFacts: '', characterMotives: '', promises: '', version: 1,
            },
          };
          chapters.push(created);
          return created;
        }),
      },
      novelChapterSeed: {
        update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          const seed = (chapters[0]?.seed ?? {}) as Record<string, unknown>;
          Object.assign(seed, data, { version: 2 });
          if (chapters[0]) chapters[0].seed = seed;
          return seed;
        }),
      },
    };
    const jobs = { submitChapterGeneration: vi.fn().mockResolvedValue({ jobId: 'job-first-chapter' }) };

    const prepared = await prepareGenerationSteward({
      prisma: prisma as never, userId: 1, projectId: 128, chapterNumber: 1,
    });
    expect(prepared.status).toBe('confirmation_required');
    expect(prepared.proposalId).toBeTruthy();
    const confirmedFields = prepared.proposals.filter((row) => row.value.trim()).map((row) => row.field);

    const confirmed = await confirmGenerationSteward({
      prisma: prisma as never, jobs: jobs as never, userId: 1, projectId: 128,
      action: 'apply_and_generate', proposalId: prepared.proposalId!, sourceVersion: prepared.sourceVersion,
      confirmedFields,
    });

    expect(confirmed.status).toBe('ready');
    expect(confirmed.generationJobId).toBe('job-first-chapter');
    expect(chapters[0]?.seed && String((chapters[0]?.seed as Record<string, unknown>).intent)).not.toBe('');
    expect(jobs.submitChapterGeneration).toHaveBeenCalledTimes(1);
  });

  it('applies a confirmed proposal once and reuses the existing job id', async () => {
    const proposal = {
      id: 'prop-1',
      projectId: 128,
      chapterNumber: 2,
      sourceVersion: 'abc',
      status: 'applied',
      proposals: [],
      missing: [],
      createdAt: new Date().toISOString(),
      generationJobId: 'job-existing',
    };
    const prisma = makePrisma({ content: JSON.stringify(proposal) });
    const jobs = { submitChapterGeneration: vi.fn() };
    const first = await confirmGenerationSteward({
      prisma: prisma as never,
      jobs: jobs as never,
      userId: 1,
      projectId: 128,
      action: 'apply_and_generate',
      proposalId: 'prop-1',
      sourceVersion: 'abc',
    });
    const second = await confirmGenerationSteward({
      prisma: prisma as never,
      jobs: jobs as never,
      userId: 1,
      projectId: 128,
      action: 'apply_and_generate',
      proposalId: 'prop-1',
      sourceVersion: 'abc',
    });
    expect(first.generationJobId).toBe('job-existing');
    expect(second.generationJobId).toBe('job-existing');
    expect(jobs.submitChapterGeneration).not.toHaveBeenCalled();
  });

  it('writes confirmed author materials once, then reuses the generation job id', async () => {
    const seedJson = JSON.stringify({
      chapterNumber: 2,
      intent: '追查禁令',
      mustInclude: '铜哨',
      forbiddenFacts: '不得改写已发生的前章事实',
      characterMotives: '沈砚：确认父亲隐瞒',
      promises: '不要相信沈建国',
      endingGoal: '留下可续写的章末压力',
    });
    const project = {
      id: 128, userId: 1, title: '铜哨', description: '', genre: '',
      subGenres: [], worldKeyTerms: [], version: 1, deletedAt: null,
    };
    const documents: Array<Record<string, unknown>> = [{
      id: 83, documentType: 'story_outline', content: FIXTURE_STORY_OUTLINE,
      currentVersion: 1, updatedAt: new Date(), deletedAt: null,
    }, {
      id: 84, documentType: 'narrative_state',
      content: JSON.stringify({ canon: [{ fact: 'copper whistle exists' }], promise: [{ description: 'solve the disappearance' }] }),
      currentVersion: 1, updatedAt: new Date(), deletedAt: null,
    }];
    const characters = [{
      id: 1, name: '沈砚', roleType: 'protagonist', identity: '重生者',
      goals: '', motivation: '', currentState: '', relationships: '',
      secrets: '', characterArc: '', version: 1, deletedAt: null, sortOrder: 0,
    }];
    const chapters: Array<{
      id?: number;
      chapterNumber: number;
      title: string;
      content: string;
      wordCount: number;
      version: number;
      deletedAt: null;
      seed: {
        id: number;
        intent: string;
        endingGoal: string;
        mustInclude: string;
        forbiddenFacts: string;
        characterMotives: string;
        promises: string;
        version: number;
      } | null;
    }> = [{
      chapterNumber: 1, title: '第一章', content: FIXTURE_CHAPTER_ONE,
      wordCount: 20, version: 1, seed: null, deletedAt: null,
    }];
    const proposal = {
      id: 'prop-write',
      projectId: 128,
      chapterNumber: 2,
      sourceVersion: '',
      status: 'pending',
      proposals: [
        { field: 'canon_state', value: 'copper whistle exists', source: ['chapter:1'], requiresConfirmation: true },
        { field: 'promise_ledger', value: 'solve the disappearance', source: ['chapter:1'], requiresConfirmation: true },
        { field: 'genre', value: '都市重生', source: ['story_outline'], requiresConfirmation: true },
        { field: 'worldbuilding', value: '# 世界观\n- 铜哨', source: ['chapter:1'], requiresConfirmation: true },
        { field: 'creative_constitution', value: '# 创作宪法\n- 不改写前章', source: ['chapter:1'], requiresConfirmation: true },
        { field: 'style_profile', value: '{"editorialGuidance":["克制"]}', source: ['chapter:1'], requiresConfirmation: true },
        { field: 'chapter_seed', value: seedJson, source: ['outline_node:第二章'], requiresConfirmation: false },
        { field: 'character_states', value: '沈砚|查清失踪|确认父亲隐瞒|握着铜哨', source: ['character:沈砚'], requiresConfirmation: true },
      ],
      missing: ['项目类型', '世界观', '创作宪法', '风格档案', '章节种子'],
      createdAt: new Date().toISOString(),
    };
    documents.push({
      id: 9, documentType: 'material_proposal', content: JSON.stringify(proposal),
      currentVersion: 1, updatedAt: new Date(), deletedAt: null, title: '方案',
    });
    const snapshot = compileProjectContextSnapshot({
      userId: 1,
      project,
      documents: documents as never,
      characters,
      outlineNodes: [{
        title: '第二章：不要相信沈建国', summary: '追查禁令', nodeType: 'chapter',
        narrativeGoal: '推进禁令', version: 1,
      }],
      chapters,
    });
    proposal.sourceVersion = snapshot.sourceVersion;
    documents[2]!.content = JSON.stringify(proposal);

    const prisma = {
      novelProject: {
        findFirst: vi.fn(async () => project),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(project, data);
          return project;
        }),
      },
      novelDocument: {
        findMany: vi.fn(async () => documents),
        findFirst: vi.fn(async ({ where }: { where: { documentType?: string; id?: number } }) => {
          if (where.id) return documents.find((row) => row.id === where.id) ?? null;
          if (where.documentType) return documents.find((row) => row.documentType === where.documentType) ?? null;
          return documents[0] ?? null;
        }),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const created = { id: 200 + documents.length, currentVersion: 1, updatedAt: new Date(), deletedAt: null, ...data };
          documents.push(created);
          return created;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
          const row = documents.find((item) => item.id === where.id);
          if (row) Object.assign(row, data);
          return row;
        }),
      },
      novelDocumentVersion: { create: vi.fn() },
      novelCharacter: {
        findMany: vi.fn(async () => characters),
        findFirst: vi.fn(async ({ where }: { where: { name?: string } }) => (
          characters.find((row) => row.name === where.name) ?? null
        )),
        update: vi.fn(async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
          const row = characters.find((item) => item.id === where.id);
          if (row) Object.assign(row, data);
          return row;
        }),
      },
      novelOutlineNode: {
        findMany: vi.fn(async () => [{
          title: '第二章：不要相信沈建国', summary: '追查禁令', nodeType: 'chapter',
          narrativeGoal: '推进禁令', version: 1,
        }]),
      },
      novelChapter: {
        findMany: vi.fn(async () => chapters),
        findFirst: vi.fn(async ({ where }: { where: { chapterNumber?: number } }) => (
          chapters.find((row) => row.chapterNumber === where.chapterNumber) ?? null
        )),
        findFirstOrThrow: vi.fn(async ({ where }: { where: { id?: number } }) => (
          chapters.find((row) => (row as { id?: number }).id === where.id) ?? chapters[0]
        )),
        create: vi.fn(async ({ data }: { data: { chapterNumber: number; title: string; seed?: { create: Record<string, unknown> } } }) => {
          const created = {
            id: 44,
            chapterNumber: data.chapterNumber,
            title: data.title,
            content: '',
            wordCount: 0,
            version: 1,
            deletedAt: null,
            seed: {
              id: 7, intent: '', endingGoal: '', mustInclude: '', forbiddenFacts: '',
              characterMotives: '', promises: '', version: 1,
            },
          };
          chapters.push(created);
          return created;
        }),
      },
      novelChapterSeed: {
        create: vi.fn(),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const chapter = chapters.find((row) => row.chapterNumber === 2);
          if (chapter?.seed) Object.assign(chapter.seed, data, { intent: data.intent, endingGoal: data.endingGoal });
          return chapter?.seed;
        }),
      },
    };
    const jobs = { submitChapterGeneration: vi.fn().mockResolvedValue({ jobId: 'job-once' }) };
    const first = await confirmGenerationSteward({
      prisma: prisma as never,
      jobs: jobs as never,
      userId: 1,
      projectId: 128,
      action: 'apply_and_generate',
      proposalId: 'prop-write',
      sourceVersion: proposal.sourceVersion,
      confirmedFields: ['genre', 'worldbuilding', 'creative_constitution', 'style_profile', 'canon_state', 'promise_ledger', 'chapter_seed', 'character_states'],
    });
    const second = await confirmGenerationSteward({
      prisma: prisma as never,
      jobs: jobs as never,
      userId: 1,
      projectId: 128,
      action: 'apply_and_generate',
      proposalId: 'prop-write',
      sourceVersion: proposal.sourceVersion,
    });
    expect(prisma.novelProject.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ genre: '都市重生' }),
    }));
    expect(prisma.novelDocument.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ documentType: 'worldbuilding', content: '# 世界观\n- 铜哨' }),
    }));
    expect(prisma.novelDocument.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ documentType: 'creative_constitution' }),
    }));
    expect(prisma.novelDocument.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ documentType: 'style_profile' }),
    }));
    expect(prisma.novelChapterSeed.update).toHaveBeenCalled();
    expect(prisma.novelDocumentVersion.create).toHaveBeenCalled();
    expect(jobs.submitChapterGeneration).toHaveBeenCalledTimes(1);
    expect(first.generationJobId).toBe('job-once');
    expect(second.generationJobId).toBe('job-once');
    expect(first.publicEntry).toBe('novel_generate_chapter');
  });

  it('re-runs readiness after confirm and does not submit when key materials are still empty', async () => {
    const project = {
      id: 128, userId: 1, title: '铜哨', description: '', genre: '',
      subGenres: [], worldKeyTerms: [], version: 1, deletedAt: null,
    };
    const documents: Array<Record<string, unknown>> = [{
      id: 9, documentType: 'material_proposal', content: '',
      currentVersion: 1, updatedAt: new Date(), deletedAt: null,
    }];
    const snapshot = compileProjectContextSnapshot({
      userId: 1,
      project,
      documents: documents as never,
      characters: [],
      outlineNodes: [],
      chapters: [],
    });
    const proposal = {
      id: 'prop-empty',
      projectId: 128,
      chapterNumber: 2,
      sourceVersion: snapshot.sourceVersion,
      status: 'pending',
      proposals: [
        { field: 'genre', value: '', source: [], requiresConfirmation: true },
        { field: 'worldbuilding', value: '', source: [], requiresConfirmation: true },
      ],
      missing: ['项目类型', '世界观'],
      createdAt: new Date().toISOString(),
    };
    documents[0]!.content = JSON.stringify(proposal);
    const prisma = makePrisma({ content: JSON.stringify(proposal) });
    prisma.novelProject.findFirst.mockResolvedValue(project);
    prisma.novelDocument.findMany.mockResolvedValue(documents);
    prisma.novelDocument.findFirst.mockResolvedValue(documents[0]);
    prisma.novelCharacter.findMany.mockResolvedValue([]);
    prisma.novelOutlineNode.findMany.mockResolvedValue([]);
    prisma.novelChapter.findMany.mockResolvedValue([]);
    const jobs = { submitChapterGeneration: vi.fn() };
    const result = await confirmGenerationSteward({
      prisma: prisma as never,
      jobs: jobs as never,
      userId: 1,
      projectId: 128,
      action: 'apply_and_generate',
      proposalId: 'prop-empty',
      sourceVersion: proposal.sourceVersion,
      confirmedFields: [],
    });
    expect(result.status).toBe('confirmation_required');
    expect(result.generationJobId).toBeUndefined();
    expect(jobs.submitChapterGeneration).not.toHaveBeenCalled();
    expect(result.reply).not.toContain('runtime_preflight_failed');
  });

  it('retries submit when confirmation already wrote materials even if the version stamp drifted', async () => {
    const project = {
      id: 128, userId: 1, title: '铜哨', description: '都市重生', genre: '都市重生',
      subGenres: [], worldKeyTerms: [], version: 4, deletedAt: null,
    };
    const proposal = {
      id: 'prop-retry',
      projectId: 128,
      chapterNumber: 2,
      sourceVersion: 'old-version',
      status: 'pending',
      proposals: [],
      missing: [],
      createdAt: new Date().toISOString(),
    };
    const prisma = makePrisma({ content: JSON.stringify(proposal) });
    prisma.novelProject.findFirst.mockResolvedValue(project);
    prisma.novelDocument.findMany.mockResolvedValue([
      { id: 1, documentType: 'story_outline', content: FIXTURE_STORY_OUTLINE, currentVersion: 1, updatedAt: new Date(), deletedAt: null },
      { id: 2, documentType: 'worldbuilding', content: '# 世界观\n- 铜哨', currentVersion: 1, updatedAt: new Date(), deletedAt: null },
      { id: 3, documentType: 'creative_constitution', content: '# 创作宪法\n- 不违背身份', currentVersion: 1, updatedAt: new Date(), deletedAt: null },
      { id: 4, documentType: 'style_profile', content: '{"editorialGuidance":["克制"]}', currentVersion: 1, updatedAt: new Date(), deletedAt: null },
      { id: 5, documentType: 'narrative_state', content: JSON.stringify({ canon: [{ fact: 'copper whistle exists' }], promise: [{ description: 'solve the disappearance' }] }), currentVersion: 1, updatedAt: new Date(), deletedAt: null },
      { id: 9, documentType: 'material_proposal', content: JSON.stringify(proposal), currentVersion: 2, updatedAt: new Date(), deletedAt: null },
    ]);
    prisma.novelCharacter.findMany.mockResolvedValue([{
      id: 1, name: '沈砚', roleType: 'protagonist', identity: '重生者',
      goals: '查清失踪', motivation: '确认父亲隐瞒', currentState: '握着铜哨',
      relationships: '', secrets: '', characterArc: '', version: 2,
    }]);
    prisma.novelOutlineNode.findMany.mockResolvedValue([]);
    prisma.novelChapter.findMany.mockResolvedValue([{
      id: 44, chapterNumber: 2, title: '第二章', content: '', wordCount: 0, version: 1, deletedAt: null,
      seed: { intent: '追查铜哨', mustInclude: '', forbiddenFacts: '', characterMotives: '', promises: '', endingGoal: '留下新压力', version: 1 },
    }]);
    prisma.novelChapter.findFirst.mockResolvedValue({ id: 44, seed: { intent: '追查铜哨', endingGoal: '留下新压力' } });
    const jobs = { submitChapterGeneration: vi.fn().mockResolvedValue({ jobId: 'job-retry' }) };
    const result = await confirmGenerationSteward({
      prisma: prisma as never, jobs: jobs as never, userId: 1, projectId: 128,
      action: 'apply_and_generate', proposalId: 'prop-retry', sourceVersion: 'old-version',
    });
    expect(result.generationJobId).toBe('job-retry');
    expect(jobs.submitChapterGeneration).toHaveBeenCalledTimes(1);
  });

  it('rejects confirmation when the project version changed', async () => {
    const proposal = {
      id: 'prop-stale',
      projectId: 128,
      chapterNumber: 2,
      sourceVersion: 'old-version',
      status: 'pending',
      proposals: [],
      missing: [],
      createdAt: new Date().toISOString(),
    };
    const prisma = makePrisma({ content: JSON.stringify(proposal) });
    prisma.novelProject.findFirst.mockResolvedValue({
      id: 128, userId: 1, title: '铜哨', description: '', genre: '都市重生',
      subGenres: [], worldKeyTerms: [], version: 9, deletedAt: null,
    });
    prisma.novelDocument.findMany.mockResolvedValue([]);
    prisma.novelCharacter.findMany.mockResolvedValue([]);
    prisma.novelOutlineNode.findMany.mockResolvedValue([]);
    prisma.novelChapter.findMany.mockResolvedValue([]);
    const jobs = { submitChapterGeneration: vi.fn() };
    await expect(confirmGenerationSteward({
      prisma: prisma as never, jobs: jobs as never, userId: 1, projectId: 128,
      action: 'apply_and_generate', proposalId: 'prop-stale', sourceVersion: 'old-version',
    })).rejects.toMatchObject({ envelope: { gate: 'proposal_version' } });
    expect(jobs.submitChapterGeneration).not.toHaveBeenCalled();
  });

  it('cancel and save_draft never submit generation', async () => {
    const proposal = {
      id: 'prop-2',
      projectId: 128,
      chapterNumber: 2,
      sourceVersion: 'abc',
      status: 'pending',
      proposals: [],
      missing: ['世界观'],
      createdAt: new Date().toISOString(),
    };
    const prisma = makePrisma({ content: JSON.stringify(proposal) });
    const jobs = { submitChapterGeneration: vi.fn() };
    const cancelled = await confirmGenerationSteward({
      prisma: prisma as never, jobs: jobs as never, userId: 1, projectId: 128,
      action: 'cancel', proposalId: 'prop-2', sourceVersion: 'abc',
    });
    const drafted = await confirmGenerationSteward({
      prisma: prisma as never, jobs: jobs as never, userId: 1, projectId: 128,
      action: 'save_draft', proposalId: 'prop-2', sourceVersion: 'abc',
    });
    expect(cancelled.generationJobId).toBeUndefined();
    expect(drafted.generationJobId).toBeUndefined();
    expect(jobs.submitChapterGeneration).not.toHaveBeenCalled();
    expect(parseStewardAction('apply_and_generate')).toBe('apply_and_generate');
  });

  it('revises proposal fields without writing author materials or submitting a job', async () => {
    const proposal = {
      id: 'prop-revise',
      projectId: 128,
      chapterNumber: 2,
      sourceVersion: 'abc',
      status: 'pending',
      proposals: [
        { field: 'worldbuilding', value: 'old world', source: ['chapter:1'], requiresConfirmation: true },
        { field: 'chapter_seed', value: '{"intent":"old","endingGoal":"end"}', source: ['outline'], requiresConfirmation: false },
      ],
      missing: ['worldbuilding'],
      createdAt: new Date().toISOString(),
    };
    const document = { id: 9, currentVersion: 1, content: JSON.stringify(proposal) };
    const prisma = makePrisma({ content: document.content });
    prisma.novelDocument.findFirst.mockResolvedValue(document);
    const jobs = { submitChapterGeneration: vi.fn() };
    const result = await reviseGenerationSteward({
      prisma: prisma as never,
      userId: 1,
      projectId: 128,
      proposalId: 'prop-revise',
      sourceVersion: 'abc',
      edits: [{ field: 'worldbuilding', value: 'new world' }],
    });
    expect(result.proposalStatus).toBe('pending');
    expect(result.proposals.find((row) => row.field === 'worldbuilding')?.value).toBe('new world');
    expect(jobs.submitChapterGeneration).not.toHaveBeenCalled();
    expect(prisma.novelDocument.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: expect.stringContaining('new world') }),
    }));
  });
});
