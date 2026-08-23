import { test, expect } from '@playwright/test';
import { buildStewardRequest, type StewardView } from '../src/api/assistant';

test('apply-and-generate keeps the steward proposal identity', () => {
  const steward: StewardView = {
    status: 'confirmation_required',
    reply: 'draft',
    chapterNumber: 2,
    proposalId: 'proposal-2',
    sourceVersion: 'source-v1',
    proposals: [
      { field: 'genre', value: '都市', source: ['project'], requiresConfirmation: true },
      { field: 'chapter_seed', value: '{"intent":"追查"}', source: ['outline'], requiresConfirmation: false },
    ],
    missing: ['类型'],
    proposalStatus: 'pending',
  };

  expect(buildStewardRequest(steward, 'apply_and_generate')).toEqual({
    content: '采用并继续生成',
    stewardAction: 'apply_and_generate',
    proposalId: 'proposal-2',
    sourceVersion: 'source-v1',
    confirmedFields: ['genre', 'chapter_seed'],
  });
});
