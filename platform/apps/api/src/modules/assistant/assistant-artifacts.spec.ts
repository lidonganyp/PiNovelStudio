import { describe, expect, it, vi } from 'vitest';
import { applyAssistantArtifacts } from './assistant-artifacts';

function makePrisma() {
  return {
    novelDocument: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 9 }),
    },
    novelDocumentVersion: { create: vi.fn().mockResolvedValue({}) },
    novelProject: { update: vi.fn().mockResolvedValue({}) },
    novelOutlineNode: {
      updateMany: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockImplementation(async ({ data }: { data: { title: string; id?: number } }) => ({
        id: data.title.includes('卷') ? 100 : 200,
      })),
    },
    novelCharacter: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    novelChapter: {
      findFirst: vi.fn().mockResolvedValue(null),
      findFirstOrThrow: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 4, seed: { id: 7 }, content: '', title: '' }),
      update: vi.fn().mockResolvedValue({}),
    },
    novelChapterSeed: { update: vi.fn().mockResolvedValue({}), create: vi.fn() },
  };
}

describe('applyAssistantArtifacts', () => {
  it('saves unmarked outline into document, outline tree, chapter shells and dispatches generation', async () => {
    const prisma = makePrisma();
    const jobs = {
      submitChapterGeneration: vi.fn().mockResolvedValue({ jobId: 'gen-1' }),
    };

    const result = await applyAssistantArtifacts({
      prisma: prisma as never,
      jobs: jobs as never,
      userId: 1,
      projectId: 128,
      userContent: '帮我写一份都市重生大纲，并生成第一章',
      content: [
        '# 故事大纲',
        '## 第一卷：开端',
        '1. **第一章：牛马的一生**',
        '   沈砚倒下。',
        '主角：沈砚，都市青年',
      ].join('\n'),
    });

    expect(prisma.novelDocument.create).toHaveBeenCalled();
    expect(prisma.novelOutlineNode.create).toHaveBeenCalled();
    expect(prisma.novelChapter.create).toHaveBeenCalled();
    expect(prisma.novelCharacter.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ name: '沈砚' }),
    }));
    expect(jobs.submitChapterGeneration).toHaveBeenCalledWith(1, 128, 4);
    expect(result.generationJobId).toBe('gen-1');
    expect(result.content).toContain('系统内置生成流程');
    expect(result.artifacts.outlineSaved).toBe(true);
  });

  it('does not treat a generate-only reply as a new outline', async () => {
    const prisma = makePrisma();
    const jobs = {
      submitChapterGeneration: vi.fn().mockResolvedValue({ jobId: 'gen-2' }),
    };
    await applyAssistantArtifacts({
      prisma: prisma as never,
      jobs: jobs as never,
      userId: 1,
      projectId: 128,
      userContent: '生成第一章',
      content: '好的，我现在为你生成第一章。',
    });
    expect(prisma.novelDocument.create).not.toHaveBeenCalled();
    expect(jobs.submitChapterGeneration).toHaveBeenCalled();
  });
});
