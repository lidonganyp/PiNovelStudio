import { describe, expect, it } from 'vitest';
import {
  MAX_RUNTIME_WORKSPACE_PAYLOAD_BYTES,
  assertRuntimeWorkspacePayloadFits,
} from './runtime-workspace-payload';

describe('runtime workspace payload budget', () => {
  it('accepts a payload at the configured byte boundary', () => {
    const input = { workspaceDocuments: [{ type: 'worldbuilding', content: 'a'.repeat(32) }] };

    expect(() => assertRuntimeWorkspacePayloadFits(input)).not.toThrow();
  });

  it('rejects an oversized UTF-8 workspace before a job hold is created', () => {
    const input = {
      workspaceDocuments: [{
        type: 'worldbuilding',
        // Chinese characters exercise byte counting instead of JavaScript code-unit length.
        content: '界'.repeat(Math.ceil(MAX_RUNTIME_WORKSPACE_PAYLOAD_BYTES / 3)),
      }],
    };

    expect(() => assertRuntimeWorkspacePayloadFits(input)).toThrow(/workspace materials exceed/i);
  });

  it('fails closed when the material payload cannot be serialized', () => {
    const input: { self?: unknown } = {};
    input.self = input;

    expect(() => assertRuntimeWorkspacePayloadFits(input)).toThrow(/workspace materials/i);
  });
});
