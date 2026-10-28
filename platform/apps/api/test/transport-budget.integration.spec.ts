/** Real PostgreSQL admission covers physical attempts, unknown usage and revision-wide recovery. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service';
import { BillingService } from '../src/modules/billing/billing.service';
import { TransportBudgetService } from '../src/modules/billing/transport-budget.service';

const prisma = new PrismaService();
const rates = { buildRateSnapshot: async (route: string) => ({ modelKey: route, displayName: 'fixture', providerKey: 'fixture', inputPricePerMillion: '100000', outputPricePerMillion: '100000', multiplierPercent: 100, effectiveFrom: '2020-01-01T00:00:00Z' }) };
const billing = new BillingService(prisma, rates as never);
const budgets = new TransportBudgetService(prisma, rates as never, billing);
let userId: number; let projectId: number; let chapterId: number;
const jobId = randomUUID();
beforeAll(async () => {
  await prisma.$connect();
  userId = (await prisma.user.create({ data: { email: `transport-${randomUUID()}@test.local`, passwordHash: 'fixture', nickname: 'fixture', balance: 1000n } })).id;
  projectId = (await prisma.novelProject.create({ data: { userId, title: 'fixture' } })).id;
  chapterId = (await prisma.novelChapter.create({ data: { userId, projectId, chapterNumber: 1 } })).id;
  await prisma.novelGenerationJob.create({ data: { userId, projectId, chapterId, jobId, status: 'running', maxCharge: 5n,
    leaseOwner:'isolated-transport-test',leaseUntil:new Date(Date.now()+45*60_000),
    execution: { version: 1, deadlineAt: Date.now() + 45 * 60_000, input: { frozen: true } } } });
  await billing.createHold({ userId, jobId, amount: 5n });
});
afterAll(async () => {
  await prisma.novelGenerationCall.deleteMany({ where: { userId } });
  await prisma.novelBalanceHold.deleteMany({ where: { userId } });
  await prisma.novelGenerationJob.deleteMany({ where: { userId } });
  await prisma.novelChapter.deleteMany({ where: { userId } });
  await prisma.novelProject.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});
const reserve = (callId: string) => budgets.reserve({ jobId, callId, route: 'v2_rawstage2_gemini31', model: 'fixture', requestHash: 'a'.repeat(64), inputTokenLimit: 10, outputTokenLimit: 10 });
it('reserves maximum cost before dispatch, releases only known unused cost, and never treats unknown usage as free', async () => {
  await Promise.all([reserve('a'), reserve('a')]);
  await reserve('b');
  await expect(reserve('c')).rejects.toThrow('预算');
  await budgets.settle({ jobId, callId: 'a', tokensIn: 1, tokensOut: 1, status: 200 });
  await budgets.settle({ jobId, callId: 'b', status: 0 });
  await reserve('c'); // 1 known + 2 unknown + 2 reserved = exactly 5 fen.
  await expect(reserve('d')).rejects.toThrow('预算');
  await budgets.settle({ jobId, callId: 'a', tokensIn: 1, tokensOut: 1, status: 200 });
  expect(await prisma.novelGenerationCall.count({ where: { jobId } })).toBe(1);
  const stored = (await prisma.novelGenerationJob.findUniqueOrThrow({ where: { jobId } })).execution as { input: unknown; transports: Array<{ state: string }> };
  expect(stored.input).toEqual({ frozen: true });
  expect(stored.transports.map((c) => c.state)).toEqual(['settled', 'unknown', 'reserved']);
});

it('stops after six semantic recovery HTTP attempts even when every response was 200', async () => {
  await billing.finalizeHold({ jobId, outcome: 'failure' });
  await prisma.novelGenerationJob.update({ where: { jobId }, data: { status: 'failed' } });
  const recoveryJob = randomUUID();
  const recoveryChapter = await prisma.novelChapter.create({ data: { userId, projectId, chapterNumber: 2 } });
  await prisma.novelGenerationJob.create({ data: { userId, projectId, chapterId: recoveryChapter.id, jobId: recoveryJob, status: 'running', maxCharge: 100n,
    leaseOwner:'isolated-transport-test',leaseUntil:new Date(Date.now()+45*60_000),
    execution: { version: 1, deadlineAt: Date.now() + 60_000, input: {} } } });
  await billing.createHold({ userId, jobId: recoveryJob, amount: 100n });
  const input = { jobId: recoveryJob, route: 'v2_amplified_gemini31', model: 'fixture', requestHash: 'b'.repeat(64), inputTokenLimit: 10, outputTokenLimit: 10, recovery: true };
  for (let attempt = 0; attempt < 6; attempt++) {
    await budgets.reserve({ ...input, callId: `r${attempt}` });
    await budgets.settle({ jobId: recoveryJob, callId: `r${attempt}`, tokensIn: 1, tokensOut: 1, status: 200 });
  }
  await expect(budgets.reserve({ ...input, callId: 'r6' })).rejects.toThrow('恢复次数');
});
