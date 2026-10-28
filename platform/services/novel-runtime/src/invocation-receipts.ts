/** Persist accepted invocations before work and completed results before replying. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Admission = { state: 'new' | 'running' | 'interrupted' }
  | { state: 'completed'; status: number; body: unknown };
interface Receipt { fingerprint: string; owner: string; status?: number; body?: unknown; }

export class InvocationReceipts {
  private readonly owner = randomUUID();
  constructor(private readonly root: string) {}
  begin(jobId: string, fingerprint: string): Admission {
    mkdirSync(this.root, { recursive: true });
    const path = this.path(jobId);
    try {
      writeFileSync(path, JSON.stringify({ fingerprint, owner: this.owner }), { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
      return { state: 'new' };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const receipt = JSON.parse(readFileSync(path, 'utf8')) as Receipt;
    if (receipt.fingerprint !== fingerprint) throw new Error('job id was used for a different invocation');
    if (typeof receipt.status === 'number' && Object.hasOwn(receipt, 'body')) return { state: 'completed', status: receipt.status, body: receipt.body };
    return { state: receipt.owner === this.owner ? 'running' : 'interrupted' };
  }
  complete(jobId: string, fingerprint: string, status: number, body: unknown): void {
    const receipt = JSON.parse(readFileSync(this.path(jobId), 'utf8')) as Receipt;
    if (receipt.fingerprint !== fingerprint || receipt.owner !== this.owner) throw new Error('receipt ownership changed');
    const temp = `${this.path(jobId)}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ fingerprint, owner: this.owner, status, body }), { encoding: 'utf8', mode: 0o600, flush: true });
    renameSync(temp, this.path(jobId));
  }
  private path(jobId: string): string { return join(this.root, `${createHash('sha256').update(jobId).digest('hex')}.json`); }
}
