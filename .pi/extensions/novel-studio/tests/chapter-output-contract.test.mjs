/** Explicit model self-analysis is a protocol failure, never a licence to delete ordinary foreign-language story text. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertChapterProseOutput } from '../dist/utils/llm-language-guard.js';

test('explicit analysis blocks and writing self-instructions are blocked before fact extraction', () => {
  for(const text of ['<think>private analysis</think>','### Writing Plan\noutline','Okay, let\'s plan this chapter.','We need to rewrite the chapter in the author style.','润色计划：保持情节']) {
    assert.throws(()=>assertChapterProseOutput(text),/chapter_output_contract/);
  }
});
test('foreign-language dialogue, names, and in-story plans are preserved verbatim', () => {
  for(const text of ['“We need to write the chapter,” the editor said.','Alice stepped outside. The door closed.','“计划：明日出发。”他把纸条递过来。','分析仪亮了起来。']) {
    assert.doesNotThrow(()=>assertChapterProseOutput(text));
  }
});
