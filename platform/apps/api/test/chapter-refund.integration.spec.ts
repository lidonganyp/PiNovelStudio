/** Failed chapter delivery refunds both balances once while retaining original call costs. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service';
import { BillingService } from '../src/modules/billing/billing.service';
import { BillingQueryService } from '../src/modules/billing/billing-query.service';
import { AdminService } from '../src/modules/admin/admin.service';

const prisma = new PrismaService();
let userId: number; let projectId: number; let chapterId: number;
const jobId = randomUUID();
const billing = new BillingService(prisma, { buildRateSnapshot: async () => ({ inputPricePerMillion: '100', outputPricePerMillion: '100', multiplierPercent: 100 }) } as never);
beforeAll(async () => {
  await prisma.$connect();
  userId = (await prisma.user.create({ data: { email: `refund-${randomUUID()}@test.local`, nickname: 'fixture', passwordHash: 'fixture', balance: 3n, bonusBalance: 100n } })).id;
  projectId = (await prisma.novelProject.create({ data: { userId, title: 'refund-fixture' } })).id;
  chapterId = (await prisma.novelChapter.create({ data: { userId, projectId, chapterNumber: 1 } })).id;
  await prisma.novelGenerationJob.create({ data: { jobId, userId, projectId, chapterId, jobType: 'chapter_generation', status: 'running', maxCharge: 100n } });
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
it('refunds a failed chapter in an idempotent transaction without erasing supplier consumption', async () => {
  await billing.createHold({ userId, jobId, amount: 100n });
  await billing.settleCall({ jobId, callId: 'call', internalStage: 'style_optimizer', model: 'fixture', tokensIn: 100_000, tokensOut: 0 });
  expect(await prisma.user.findUniqueOrThrow({ where: { id: userId } })).toMatchObject({ balance: 0n, bonusBalance: 93n });
  const finals = await Promise.all([billing.finalizeHold({ jobId, outcome: 'failure' }), billing.finalizeHold({ jobId, outcome: 'failure' })]);
  expect(finals.every((f) => f.settledAmount === 0n && f.status === 'released')).toBe(true);
  expect(await prisma.user.findUniqueOrThrow({ where: { id: userId } })).toMatchObject({ balance: 3n, bonusBalance: 100n });
  const call = await prisma.novelGenerationCall.findUniqueOrThrow({ where: { jobId_callId: { jobId, callId: 'call' } } });
  expect(call).toMatchObject({ actualCharge: 10n, chargeFromReal: 3n, chargeFromBonus: 7n });
  const query = new BillingQueryService(prisma);
  expect(await query.summary(userId)).toMatchObject({ spentLast30Days: '0', balance: '3', bonusBalance: '100' });
  expect(await query.records(userId, 1, 20)).toMatchObject({ items: [{ actualCharge: '0', providerCharge: '10', refunded: true }] });
  const admin = new AdminService(prisma, billing);
  expect(await admin.getUser(userId)).toMatchObject({spent:'0',spentFromReal:'0',spentFromBonus:'0'});
  expect(await admin.revenueSummary({userId})).toMatchObject({realConsume:'0',virtualConsume:'0'});
});
