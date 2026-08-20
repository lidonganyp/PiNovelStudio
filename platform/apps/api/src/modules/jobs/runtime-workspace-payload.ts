/**
 * Bounds the API-to-runtime material snapshot below the runtime's HTTP body
 * limit.  A generation must be rejected before a billing hold is created when
 * its accumulated project material cannot be delivered to the runtime.
 */
export const MAX_RUNTIME_WORKSPACE_PAYLOAD_BYTES = 4 * 1024 * 1024;

export class RuntimeWorkspacePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeWorkspacePayloadError';
  }
}

export function assertRuntimeWorkspacePayloadFits(input: Record<string, unknown>): void {
  let serialized: string;
  try {
    serialized = JSON.stringify({ tool: 'novel_generate_chapter', input });
  } catch {
    throw new RuntimeWorkspacePayloadError('workspace materials cannot be serialized');
  }

  const size = Buffer.byteLength(serialized, 'utf8');
  if (size > MAX_RUNTIME_WORKSPACE_PAYLOAD_BYTES) {
    throw new RuntimeWorkspacePayloadError(
      `workspace materials exceed the ${MAX_RUNTIME_WORKSPACE_PAYLOAD_BYTES}-byte generation limit`,
    );
  }
}
