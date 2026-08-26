import { test, expect } from '@playwright/test';
import { buildStewardRequest, type StewardView } from '../src/api/assistant';
import { renderMarkdown } from '../src/components/workspace/chat/markdown';

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
    continuationMode: 'append',
    targetWordCount: { min: 2500, max: 2750 },
  };

  expect(buildStewardRequest(steward, 'apply_and_generate')).toEqual({
    content: '采用并继续生成',
    stewardAction: 'apply_and_generate',
    proposalId: 'proposal-2',
    sourceVersion: 'source-v1',
    continuationMode: 'append',
    targetWordCount: { min: 2500, max: 2750 },
    confirmedFields: ['genre', 'chapter_seed'],
  });
});

test('assistant markdown escapes HTML and rejects unsafe links', () => {
  const rendered = renderMarkdown('<script>alert(1)</script> [run](javascript:alert(1))\n\n```ts\nconst value = 1;\n```');
  expect(rendered).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(rendered).not.toContain('javascript:');
  expect(rendered).toContain('<pre><code class="language-ts">const value = 1;</code></pre>');
});
