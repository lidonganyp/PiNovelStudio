/** Verified Agentic drafts may resume mandatory style optimization under the same material/model binding. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { AgenticRawSourceResult } from '../../novelos/agent/agentic-raw-candidate-source.js';
import type { CompiledContext } from './types.js';

interface Checkpoint { schema: 1; binding: string; resultHash: string; result: AgenticRawSourceResult; }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function buildVerifiedDraftBinding(value: { context: CompiledContext; [key: string]: unknown }, projectRoot: string): string {
  const context = { ...value.context, sourceMap: value.context.sourceMap.map((source) => ({ ...source,
    // Job directories change on recovery; source content and relative identity
    // are still bound. Never remove actual author facts or model identity.
    path: isAbsolute(source.path) ? relative(projectRoot, source.path).replace(/\\/g, '/') : source.path.replace(/\\/g, '/'),
  })) };
  const stable = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(stable);
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
    return entry;
  };
  return hash(stable({ ...value, context }));
}
export function verifiedDraftPath(projectRoot: string, workspaceId: string, chapterId: string): string {
  return join(projectRoot, 'workspaces', workspaceId, 'traces', `${encodeURIComponent(chapterId)}-verified-agentic-draft.json`);
}
export function loadVerifiedDraft(path: string, binding: string): AgenticRawSourceResult | undefined {
  let checkpoint: Checkpoint;
  try { checkpoint = JSON.parse(readFileSync(path, 'utf8')) as Checkpoint; }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('verified draft checkpoint is unreadable', { cause: error });
  }
  if (checkpoint.schema !== 1 || checkpoint.binding !== binding) return undefined;
  if (checkpoint.resultHash !== hash(checkpoint.result) || !checkpoint.result?.candidate?.text || checkpoint.result.verifierCleared !== true) {
    throw new Error('verified draft checkpoint integrity failed');
  }
  return checkpoint.result;
}
export function saveVerifiedDraft(path: string, binding: string, result: AgenticRawSourceResult): void {
  if (!result.candidate?.text || result.verifierCleared !== true) throw new Error('only verified Agentic drafts may be checkpointed');
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify({ schema: 1, binding, resultHash: hash(result), result } satisfies Checkpoint), { encoding: 'utf8', mode: 0o600, flush: true });
  renameSync(temp, path);
}
