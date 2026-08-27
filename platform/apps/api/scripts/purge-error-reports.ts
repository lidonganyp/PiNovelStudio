/**
 * Bounded maintenance task for expiring diagnostic reports.
 * Run from apps/api with `npm run maintenance:purge-error-reports`.
 */
import '../src/config/load-env-file';
import { PrismaClient } from '@prisma/client';

interface Options {
  before?: Date;
  limit: number;
  dryRun: boolean;
}

function parseOptions(argv: string[]): Options {
  let before: Date | undefined;
  let limit = 1_000;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--before') {
      const value = argv[++index];
      const parsed = value ? new Date(value) : new Date('invalid');
      if (Number.isNaN(parsed.getTime())) throw new Error('--before must be an ISO date');
      before = parsed;
      continue;
    }
    if (arg === '--limit') {
      const value = Number(argv[++index]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
        throw new Error('--limit must be an integer between 1 and 10000');
      }
      limit = value;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return { before, limit, dryRun };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const cutoff = options.before ?? new Date();
  const prisma = new PrismaClient();
  try {
    const candidates = await prisma.novelErrorReport.findMany({
      where: { expiresAt: { lt: cutoff }, pinnedAt: null },
      orderBy: { expiresAt: 'asc' },
      take: options.limit,
      select: { id: true },
    });
    if (options.dryRun) {
      console.log(JSON.stringify({ dryRun: true, cutoff: cutoff.toISOString(), candidates: candidates.length }));
      return;
    }
    let deleted = 0;
    for (const candidate of candidates) {
      const result = await prisma.novelErrorReport.deleteMany({
        where: { id: candidate.id, expiresAt: { lt: cutoff }, pinnedAt: null },
      });
      deleted += result.count;
    }
    console.log(JSON.stringify({ deleted, cutoff: cutoff.toISOString(), limit: options.limit }));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
