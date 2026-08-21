/**
 * 计费引擎集成单测（真实 PostgreSQL，对照 development-plan.md §7.2）。
 * 覆盖：并发预占不超扣、幂等结算、超预占拒绝、失败退回精确到分、调账只追加。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { BillingService } from '../src/modules/billing/billing.service';
import { RatesService } from '../src/modules/rates/rates.service';

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const MODEL_KEY = `p2-model-${runId}`;
const PROVIDER_KEY = `p2-provider-${runId}`;

function isHttpStatus(error: unknown, status: number): boolean {
  return error instanceof HttpException && error.getStatus() === status;
}

describe('BillingService', () => {
  let prisma: PrismaService;
  let billing: BillingService;
  let rates: RatesService;
  let userId: number;
  let adminId: number;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    rates = new RatesService(prisma);
    billing = new BillingService(prisma, rates);

    const user = await prisma.user.create({
      data: {
        email: `billing-user-${runId}@test.local`,
        passwordHash: 'x',
        nickname: '计费用户',
        balance: 1000n,
      },
    });
    const admin = await prisma.user.create({
      data: {
        email: `billing-admin-${runId}@test.local`,
        passwordHash: 'x',
        nickname: '计费管理员',
        role: 'admin',
        balance: 0n,
      },
    });
    userId = user.id;
    adminId = admin.id;

    const provider = await prisma.modelProvider.create({
      data: {
        providerKey: PROVIDER_KEY,
        name: '测试 Provider',
        apiBaseUrl: 'https://example.test/v1',
        apiKeyEncrypted: 'not-used-in-billing-tests',
        enabled: true,
      },
    });
    await prisma.modelRate.create({
      data: {
        modelKey: MODEL_KEY,
        displayName: '测试模型',
        providerId: provider.id,
        inputPricePerMillion: 100n,
        outputPricePerMillion: 200n,
        effectiveFrom: new Date('2020-01-01T00:00:00Z'),
        enabled: true,
      },
    });
  });

  afterAll(async () => {
    const raw = new PrismaClient();
    try {
      await raw.novelGenerationCall.deleteMany({
        where: { jobId: { contains: runId } },
      });
      await raw.novelBalanceHold.deleteMany({
        where: { jobId: { contains: runId } },
      });
      await raw.novelBillingAdjustment.deleteMany({
        where: { user: { email: { contains: runId } } },
      });
      await raw.modelRate.deleteMany({
        where: { modelKey: { contains: runId } },
      });
      await raw.modelProvider.deleteMany({
        where: { providerKey: { contains: runId } },
      });
      await raw.user.deleteMany({
        where: { email: { contains: runId } },
      });
    } finally {
      await raw.$disconnect();
      await prisma.$disconnect();
    }
  });

  it('可用余额 = balance − Σ(active holds 未结算部分)', async () => {
    const jobId = `avail-${runId}`;
    await billing.createHold({ userId, jobId, amount: 400n });
    const view = await billing.getAvailableBalance(userId);
    expect(view.balance).toBe(1000n);
    expect(view.reserved).toBe(400n);
    expect(view.available).toBe(600n);
    await billing.finalizeHold({ jobId, outcome: 'failure' });
  });

  it('余额不足时预占返回 402 且不写入 hold', async () => {
    const jobId = `poor-${runId}`;
    await expect(
      billing.createHold({ userId, jobId, amount: 10_000n }),
    ).rejects.toSatisfy((error: unknown) => isHttpStatus(error, 402));
    const hold = await prisma.novelBalanceHold.findUnique({ where: { jobId } });
    expect(hold).toBeNull();
  });

  it('同一 jobId 重复预占幂等返回原记录', async () => {
    const jobId = `idem-hold-${runId}`;
    const first = await billing.createHold({ userId, jobId, amount: 100n });
    const second = await billing.createHold({ userId, jobId, amount: 100n });
    expect(first.alreadyExisted).toBe(false);
    expect(second.alreadyExisted).toBe(true);
    expect(second.amount).toBe(100n);
    const count = await prisma.novelBalanceHold.count({ where: { jobId } });
    expect(count).toBe(1);
    await billing.finalizeHold({ jobId, outcome: 'failure' });
  });

  it('同一 jobId 不同金额冲突 409', async () => {
    const jobId = `conflict-hold-${runId}`;
    await billing.createHold({ userId, jobId, amount: 80n });
    await expect(
      billing.createHold({ userId, jobId, amount: 90n }),
    ).rejects.toBeInstanceOf(ConflictException);
    await billing.finalizeHold({ jobId, outcome: 'failure' });
  });

  it('两个并发事务预占同一用户：总额不超过可用余额', async () => {
    const isolated = await prisma.user.create({
      data: {
        email: `billing-concurrent-${runId}@test.local`,
        passwordHash: 'x',
        nickname: '并发用户',
        balance: 1000n,
      },
    });
    const results = await Promise.allSettled([
      billing.createHold({
        userId: isolated.id,
        jobId: `c1-${runId}`,
        amount: 600n,
      }),
      billing.createHold({
        userId: isolated.id,
        jobId: `c2-${runId}`,
        amount: 600n,
      }),
    ]);
    const fulfilled = results.filter((item) => item.status === 'fulfilled');
    const rejected = results.filter((item) => item.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status).toBe('rejected');
    if (rejected[0]?.status === 'rejected') {
      expect(isHttpStatus(rejected[0].reason, 402)).toBe(true);
    }
    const after = await billing.getAvailableBalance(isolated.id);
    expect(after.balance).toBe(1000n);
    expect(after.reserved).toBe(600n);
    expect(after.available).toBe(400n);
    const active = await prisma.novelBalanceHold.findMany({
      where: { userId: isolated.id, status: 'active' },
    });
    expect(active).toHaveLength(1);
    expect(active[0]?.amount).toBe(600n);
  });

  it('结算按费率快照计费，重复 callId 不重复扣费', async () => {
    const jobId = `settle-${runId}`;
    await billing.createHold({ userId, jobId, amount: 100n });
    const first = await billing.settleCall({
      jobId,
      callId: `call-a-${runId}`,
      internalStage: 'agentic_raw',
      model: MODEL_KEY,
      tokensIn: 100_000,
      tokensOut: 50_000,
    });
    expect(first.alreadySettled).toBe(false);
    expect(first.actualCharge).toBe(20n);
    expect(first.settledAmount).toBe(20n);
    expect(first.remainingBudget).toBe(80n);

    const second = await billing.settleCall({
      jobId,
      callId: `call-a-${runId}`,
      internalStage: 'agentic_raw',
      model: MODEL_KEY,
      tokensIn: 100_000,
      tokensOut: 50_000,
    });
    expect(second.alreadySettled).toBe(true);
    expect(second.actualCharge).toBe(20n);
    expect(second.settledAmount).toBe(20n);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.balance).toBe(980n);
    const calls = await prisma.novelGenerationCall.count({
      where: { jobId, callId: `call-a-${runId}` },
    });
    expect(calls).toBe(1);
    await billing.finalizeHold({ jobId, outcome: 'success' });
    await prisma.user.update({
      where: { id: userId },
      data: { balance: 1000n },
    });
  });

  it('已结算调用在费率随后不可用时仍按幂等键返回原结算结果', async () => {
    const jobId = `settle-rate-disabled-${runId}`;
    const callId = `call-rate-disabled-${runId}`;
    await billing.createHold({ userId, jobId, amount: 100n });
    const first = await billing.settleCall({
      jobId,
      callId,
      internalStage: 'agentic_raw',
      model: MODEL_KEY,
      tokensIn: 100_000,
      tokensOut: 50_000,
    });
    const activeRate = await prisma.modelRate.findFirstOrThrow({
      where: { modelKey: MODEL_KEY, enabled: true },
      orderBy: { effectiveFrom: 'desc' },
    });
    await prisma.modelRate.update({
      where: { id: activeRate.id },
      data: { enabled: false },
    });

    try {
      await expect(
        billing.settleCall({
          jobId,
          callId,
          internalStage: 'agentic_raw',
          model: MODEL_KEY,
          tokensIn: 100_000,
          tokensOut: 50_000,
        }),
      ).resolves.toMatchObject({
        alreadySettled: true,
        actualCharge: first.actualCharge,
      });
    } finally {
      await prisma.modelRate.update({
        where: { id: activeRate.id },
        data: { enabled: true },
      });
      await billing.finalizeHold({ jobId, outcome: 'success' });
      await prisma.user.update({
        where: { id: userId },
        data: { balance: 1000n },
      });
    }
  });

  it('超出预占上限拒绝且余额不变', async () => {
    const jobId = `over-${runId}`;
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await billing.createHold({ userId, jobId, amount: 10n });
    await expect(
      billing.settleCall({
        jobId,
        callId: `over-call-${runId}`,
        internalStage: 'style_optimizer',
        model: MODEL_KEY,
        tokensIn: 100_000,
        tokensOut: 50_000,
      }),
    ).rejects.toSatisfy((error: unknown) => isHttpStatus(error, 402));
    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.balance).toBe(before.balance);
    const call = await prisma.novelGenerationCall.findUnique({
      where: { jobId_callId: { jobId, callId: `over-call-${runId}` } },
    });
    expect(call).toBeNull();
    await billing.finalizeHold({ jobId, outcome: 'failure' });
  });

  it('失败收尾释放未结算预占，已扣费用精确保留到分', async () => {
    const isolated = await prisma.user.create({
      data: {
        email: `billing-refund-${runId}@test.local`,
        passwordHash: 'x',
        nickname: '退回用户',
        balance: 1000n,
      },
    });
    const jobId = `refund-${runId}`;
    await billing.createHold({
      userId: isolated.id,
      jobId,
      amount: 300n,
    });
    await billing.settleCall({
      jobId,
      callId: `refund-call-${runId}`,
      internalStage: 'agentic_raw',
      model: MODEL_KEY,
      tokensIn: 100_000,
      tokensOut: 50_000,
    });
    const finalized = await billing.finalizeHold({
      jobId,
      outcome: 'failure',
    });
    expect(finalized.status).toBe('released');
    expect(finalized.settledAmount).toBe(20n);

    const after = await billing.getAvailableBalance(isolated.id);
    expect(after.balance).toBe(980n);
    expect(after.reserved).toBe(0n);
    expect(after.available).toBe(980n);

    const again = await billing.finalizeHold({ jobId, outcome: 'failure' });
    expect(again.status).toBe('released');
    expect(again.alreadyFinalized).toBe(true);
    const still = await prisma.user.findUniqueOrThrow({
      where: { id: isolated.id },
    });
    expect(still.balance).toBe(980n);
  });

  it('成功收尾将 hold 标为 settled，差额留在余额', async () => {
    const isolated = await prisma.user.create({
      data: {
        email: `billing-success-${runId}@test.local`,
        passwordHash: 'x',
        nickname: '成功用户',
        balance: 500n,
      },
    });
    const jobId = `ok-${runId}`;
    await billing.createHold({ userId: isolated.id, jobId, amount: 200n });
    await billing.settleCall({
      jobId,
      callId: `ok-call-${runId}`,
      internalStage: 'agentic_raw',
      model: MODEL_KEY,
      tokensIn: 100_000,
      tokensOut: 50_000,
    });
    const finalized = await billing.finalizeHold({
      jobId,
      outcome: 'success',
    });
    expect(finalized.status).toBe('settled');
    const after = await billing.getAvailableBalance(isolated.id);
    expect(after.balance).toBe(480n);
    expect(after.available).toBe(480n);
  });

  it('调账只追加：作用于赠送余额，正负金额入账，禁止 update/delete', async () => {
    const isolated = await prisma.user.create({
      data: {
        email: `billing-adjust-${runId}@test.local`,
        passwordHash: 'x',
        nickname: '调账用户',
        balance: 100n,
      },
    });
    const credit = await billing.adjustBalance({
      userId: isolated.id,
      adminUserId: adminId,
      amount: 50n,
      reason: '测试充值',
    });
    const debit = await billing.adjustBalance({
      userId: isolated.id,
      adminUserId: adminId,
      amount: -20n,
      reason: '测试补扣',
    });
    expect(credit.id).toBeGreaterThan(0);
    expect(debit.id).toBeGreaterThan(0);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: isolated.id },
    });
    expect(user.balance).toBe(100n);
    expect(user.bonusBalance).toBe(30n);
    const rows = await prisma.novelBillingAdjustment.findMany({
      where: { userId: isolated.id },
      orderBy: { id: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.amount)).toEqual([50n, -20n]);

    const raw = new PrismaClient();
    await expect(
      prisma.novelBillingAdjustment.update({
        where: { id: credit.id },
        data: { reason: '篡改' },
      }),
    ).rejects.toThrow(/append-only|只追加/i);
    const untouched = await raw.novelBillingAdjustment.findUniqueOrThrow({
      where: { id: credit.id },
    });
    expect(untouched.reason).toBe('测试充值');
    await raw.$disconnect();

    await expect(
      billing.adjustBalance({
        userId: isolated.id,
        adminUserId: adminId,
        amount: -10_000n,
        reason: '超额扣负',
      }),
    ).rejects.toBeInstanceOf(HttpException);
    const still = await prisma.user.findUniqueOrThrow({
      where: { id: isolated.id },
    });
    expect(still.balance).toBe(100n);
    expect(still.bonusBalance).toBe(30n);
    expect(
      await prisma.novelBillingAdjustment.count({
        where: { userId: isolated.id },
      }),
    ).toBe(2);
  });

  it('结算先扣充值余额、再扣赠送余额，并逐调用记录归因', async () => {
    const isolated = await prisma.user.create({
      data: {
        email: `billing-dual-${runId}@test.local`,
        passwordHash: 'x',
        nickname: '双余额用户',
        balance: 10n,
        bonusBalance: 1000n,
      },
    });
    const jobId = `dual-${runId}`;
    // 费率 100/200 分每百万 token：100k in + 50k out = 20 分
    await billing.createHold({ userId: isolated.id, jobId, amount: 100n });
    const settled = await billing.settleCall({
      jobId,
      callId: `dual-call-${runId}`,
      internalStage: 'agentic_raw',
      model: MODEL_KEY,
      tokensIn: 100_000,
      tokensOut: 50_000,
    });
    expect(settled.actualCharge).toBe(20n);
    expect(settled.chargeFromReal).toBe(10n);
    expect(settled.chargeFromBonus).toBe(10n);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: isolated.id },
    });
    expect(user.balance).toBe(0n);
    expect(user.bonusBalance).toBe(990n);
    const call = await prisma.novelGenerationCall.findUniqueOrThrow({
      where: { jobId_callId: { jobId, callId: `dual-call-${runId}` } },
    });
    expect(call.chargeFromReal).toBe(10n);
    expect(call.chargeFromBonus).toBe(10n);
    // 幂等重放必须带回原归因，不重复扣款
    const replay = await billing.settleCall({
      jobId,
      callId: `dual-call-${runId}`,
      internalStage: 'agentic_raw',
      model: MODEL_KEY,
      tokensIn: 100_000,
      tokensOut: 50_000,
    });
    expect(replay.alreadySettled).toBe(true);
    expect(replay.chargeFromReal).toBe(10n);
    expect(replay.chargeFromBonus).toBe(10n);
    await billing.finalizeHold({ jobId, outcome: 'success' });
  });

  it('费率取调用时刻生效值并写入快照，历史费率不影响新结算', async () => {
    await prisma.modelRate.create({
      data: {
        modelKey: MODEL_KEY,
        displayName: '测试模型-新价',
        providerId: (await prisma.modelProvider.findUniqueOrThrow({
          where: { providerKey: PROVIDER_KEY },
        })).id,
        inputPricePerMillion: 1000n,
        outputPricePerMillion: 2000n,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        enabled: true,
      },
    });
    const snapshot = await rates.buildRateSnapshot(MODEL_KEY);
    expect(snapshot.inputPricePerMillion).toBe('1000');
    expect(snapshot.outputPricePerMillion).toBe('2000');
    expect(snapshot.modelKey).toBe(MODEL_KEY);
    expect(snapshot.providerKey).toBe(PROVIDER_KEY);

    const isolated = await prisma.user.create({
      data: {
        email: `billing-rate-${runId}@test.local`,
        passwordHash: 'x',
        nickname: '费率用户',
        balance: 500n,
      },
    });
    const jobId = `rate-${runId}`;
    await billing.createHold({ userId: isolated.id, jobId, amount: 400n });
    const settled = await billing.settleCall({
      jobId,
      callId: `rate-call-${runId}`,
      internalStage: 'agentic_raw',
      model: MODEL_KEY,
      tokensIn: 100_000,
      tokensOut: 50_000,
    });
    // (100000*1000 + 50000*2000) / 1e6 = 200
    expect(settled.actualCharge).toBe(200n);
    const call = await prisma.novelGenerationCall.findUniqueOrThrow({
      where: { jobId_callId: { jobId, callId: `rate-call-${runId}` } },
    });
    const stored = call.rateSnapshot as { inputPricePerMillion: string };
    expect(stored.inputPricePerMillion).toBe('1000');
    await billing.finalizeHold({ jobId, outcome: 'success' });
  });

  it('不存在的 hold 结算 / 收尾返回 404', async () => {
    await expect(
      billing.settleCall({
        jobId: `missing-${runId}`,
        callId: 'c',
        internalStage: 'agentic_raw',
        model: MODEL_KEY,
        tokensIn: 1,
        tokensOut: 1,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      billing.finalizeHold({ jobId: `missing-${runId}`, outcome: 'success' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
