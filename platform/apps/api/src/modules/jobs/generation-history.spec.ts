/** Rewrites restore a verified prior state instead of filtering mutated future facts. */
import { describe, expect, it, vi } from 'vitest';
import { hashChapterText } from '../context/context-compiler';
import { GenerationHistoryResolver } from './generation-history';

const previous = { chapterNumber: 1, content: 'accepted-chapter-one' };
function snapshot(chapter: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1, workspaceId: 'p2', lastCommittedChapter: `ch${chapter}`,
    canon: [{ fact: 'past-fact', sourceChapter: 'ch1', sourceRef: `ch1#finalText:${hashChapterText(previous.content)}` }],
    character: [{ characterId: 'fixture', field: 'location', value: chapter === 1 ? 'past-location' : 'future-location', sourceChapter: 'ch1' }],
    promise: [{ description: 'past-promise', status: chapter === 1 ? 'open' : 'fulfilled', sourceChapter: 'ch1' }],
    pattern: [], ...extra,
  });
}
function setup(content = snapshot(3)) {
  const loadVersions = vi.fn().mockResolvedValue([{ versionNumber: 1, content: snapshot(1) }]);
  const resolver = new GenerationHistoryResolver();
  const input = {
    chapterNumber: 2, mode: 'replace' as const, workspaceId: 'p2',
    state: { id: 8, content, currentVersion: 3 },
    previousChapter: previous, historicalChapters: [previous], loadVersions,
  };
  return { resolver, input, loadVersions };
}

describe('GenerationHistoryResolver', () => {
  it('restores character values and reopened promises from the actual checkpoint', async () => {
    const { resolver, input, loadVersions } = setup();
    const result = await resolver.resolve(input);
    expect(JSON.parse(result!.content)).toMatchObject({
      lastCommittedChapter: 'ch1',
      character: [{ value: 'past-location' }], promise: [{ status: 'open' }],
    });
    expect(result).toMatchObject({ id: 8, currentVersion: 3 });
    expect(loadVersions).toHaveBeenCalled();
    expect(JSON.parse(input.state.content).character[0].value).toBe('future-location');
  });

  it('uses the current state when it is already at the preceding chapter', async () => {
    const { resolver, input, loadVersions } = setup(snapshot(1));
    expect(await resolver.resolve(input)).toEqual(input.state);
    expect(loadVersions).not.toHaveBeenCalled();
  });

  it('fails with an actionable non-retryable preflight error if no checkpoint matches', async () => {
    const { resolver, input, loadVersions } = setup();
    loadVersions.mockResolvedValue([]);
    await expect(resolver.resolve(input)).rejects.toMatchObject({ envelope: {
      code: 'generation_history_unavailable', gate: 'generation_history', recoverable: false,
    } });
  });

  it('rejects snapshots from an older version of the preceding text', async () => {
    const { resolver, input, loadVersions } = setup();
    loadVersions.mockResolvedValue([{ versionNumber: 1, content: snapshot(1, {
      canon: [{ fact: 'old', sourceChapter: 'ch1', sourceRef: 'ch1#finalText:aaaaaaaaaaaa' }],
    }) }]);
    await expect(resolver.resolve(input)).rejects.toMatchObject({ envelope: { code: 'generation_history_unavailable' } });
  });

  it('rejects a claimed ch1 checkpoint with nested future evidence', async () => {
    const { resolver, input, loadVersions } = setup();
    loadVersions.mockResolvedValue([{ versionNumber: 1, content: snapshot(1, {
      memory: { nested: [{ sourceRefs: [{ locator: 'ch3#finalText:bbbbbbbbbbbb' }] }] },
    }) }]);
    await expect(resolver.resolve(input)).rejects.toMatchObject({ envelope: { code: 'generation_history_unavailable' } });
  });

  it('continues through version pages until a matching boundary is found', async () => {
    const { resolver, input, loadVersions } = setup();
    loadVersions.mockResolvedValueOnce([{ versionNumber: 2, content: snapshot(2) }])
      .mockResolvedValueOnce([{ versionNumber: 1, content: snapshot(1) }]);
    expect(JSON.parse((await resolver.resolve(input))!.content).lastCommittedChapter).toBe('ch1');
    expect(loadVersions.mock.calls).toEqual([[3], [2]]);
  });

  it('starts a first-chapter rewrite with an empty derived state and stable metadata', async () => {
    const { resolver, input } = setup();
    const result = await resolver.resolve({ ...input, chapterNumber: 1, previousChapter: undefined });
    expect(JSON.parse(result!.content)).toEqual({
      schemaVersion: 1, workspaceId: 'p2', canon: [], character: [], promise: [], pattern: [],
    });
    expect(result!.content).not.toContain('future');
  });

  it('preserves an explicit author baseline before any chapter has been committed', async () => {
    const content = JSON.stringify({ canon: [{ fact: 'author-baseline' }], character: [], promise: [] });
    const { resolver, input } = setup(content);
    expect((await resolver.resolve({ ...input, chapterNumber: 1, previousChapter: undefined }))!.content).toBe(content);
  });

  it('append also removes future state while keeping the existing draft as a separate input', async () => {
    const { resolver, input } = setup();
    expect(JSON.parse((await resolver.resolve({ ...input, mode: 'append' }))!.content).lastCommittedChapter).toBe('ch1');
  });

  it('detects future references even when the watermark is absent', async () => {
    const { resolver, input } = setup(snapshot(3, { lastCommittedChapter: undefined,
      canon: [{ fact: 'future-fact', sourceChapter: 3 }],
    }));
    expect(JSON.parse((await resolver.resolve(input))!.content).lastCommittedChapter).toBe('ch1');
  });

  it('propagates database failures instead of treating them as missing history', async () => {
    const { resolver, input, loadVersions } = setup();
    loadVersions.mockRejectedValue(new Error('database offline'));
    await expect(resolver.resolve(input)).rejects.toThrow('database offline');
  });

  it('does not jump over chapters whose states have not been rebuilt after an earlier rewrite', async () => {
    const { resolver, input, loadVersions } = setup(snapshot(1));
    loadVersions.mockResolvedValue([]);
    await expect(resolver.resolve({ ...input, chapterNumber: 4,
      previousChapter: { chapterNumber: 3, content: 'old-chapter-three' },
    })).rejects.toMatchObject({ envelope: { code: 'generation_history_unavailable' } });
  });

  it('does not replace malformed state with an invented empty baseline', async () => {
    const { resolver, input, loadVersions } = setup('{broken-state');
    loadVersions.mockResolvedValue([]);
    await expect(resolver.resolve({ ...input, chapterNumber: 1, previousChapter: undefined }))
      .rejects.toMatchObject({ envelope: { code: 'generation_history_unavailable' } });
  });

  it('checks earlier chapter hashes as well as the immediately preceding hash', async () => {
    const { resolver, input, loadVersions } = setup(snapshot(3));
    const chapterTwo = { chapterNumber: 2, content: 'accepted-chapter-two' };
    loadVersions.mockResolvedValue([{ versionNumber: 1, content: snapshot(2, {
      canon: [
        { fact: 'stale-earlier', sourceChapter: 'ch1', sourceRef: 'ch1#finalText:aaaaaaaaaaaa' },
        { fact: 'valid-preceding', sourceChapter: 'ch2', sourceRef: `ch2#finalText:${hashChapterText(chapterTwo.content)}` },
      ],
    }) }]);
    await expect(resolver.resolve({ ...input, chapterNumber: 3,
      previousChapter: chapterTwo, historicalChapters: [previous, chapterTwo],
    })).rejects.toMatchObject({ envelope: { code: 'generation_history_unavailable' } });
  });
});
