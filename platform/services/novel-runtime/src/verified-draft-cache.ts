/** One latest verified draft per tenant/project/chapter; the orchestrator rechecks its material/model binding. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class VerifiedDraftCache {
  constructor(private readonly root: string) {}

  bind(identity: { userId: string; projectId: string }, chapterId: string, projectRoot: string, workspaceId: string, materials: unknown = {}): { restore(): void; persist(): void } {
    const key = createHash('sha256').update(JSON.stringify({ ...identity, chapterId })).digest('hex');
    const cached = join(this.root, `${key}.json`);
    const local = join(projectRoot, 'workspaces', workspaceId, 'traces', `${encodeURIComponent(chapterId)}-verified-agentic-draft.json`);
    const stable = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(stable)
      : entry && typeof entry === 'object' ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : entry;
    const materialsHash = createHash('sha256').update(JSON.stringify(stable(materials))).digest('hex');
    const copy = (source: string, destination: string, restoring: boolean): void => {
      let content: string;
      try { content = readFileSync(source, 'utf8'); }
      catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      const value = JSON.parse(content) as { materialsHash?: string; schema?: number; binding?: string; resultHash?: string; result?: { verifierCleared?: boolean; candidate?: { text?: string } } };
      if (restoring && value.materialsHash !== materialsHash) return;
      if (value.schema !== 1 || !value.binding || value.result?.verifierCleared !== true || !value.result.candidate?.text
        || createHash('sha256').update(JSON.stringify(value.result)).digest('hex') !== value.resultHash) throw new Error('verified draft cache integrity failed');
      mkdirSync(dirname(destination), { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ ...value, materialsHash }), { encoding: 'utf8', mode: 0o600, flush: true });
      renameSync(temporary, destination);
    };
    return { restore: (): void => copy(cached, local, true), persist: (): void => copy(local, cached, false) };
  }
}
