/**
 * 计费引擎：预占（行锁 + 可用余额）、幂等结算（jobId+callId 唯一约束兜底）、
 * 收尾（settled/released，未扣部分回到可用余额）、调账（只追加）。
 * 双余额账户：balance=充值余额（真实收入），bonusBalance=赠送余额（虚拟）。
 * 结算先扣充值余额、再扣赠送余额，逐调用记录 chargeFromReal/chargeFromBonus。
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RatesService } from '../rates/rates.service';
import {
  HoldExhaustedException,
  InsufficientBalanceException,
} from './billing.errors';
import type {
  AdjustBalanceInput,
  AdjustmentView,
  AvailableBalance,
  CreateHoldInput,
  FinalizeHoldInput,
  HoldStatus,
  HoldView,
  JobProgressView,
  SettleCallInput,
  SettleCallResult,
  UpdateJobProgressInput,
} from './billing.types';
import { computeChargeFen } from './money';

const HOLD_ACTIVE = 'active';

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rates: RatesService,
  ) {}

  /** 查询余额与可用余额（可用 = 充值 + 赠送 − Σ(active holds 未结算部分)）。 */
  async getAvailableBalance(userId: number): Promise<AvailableBalance> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    const reserved = await this.sumActiveReserved(this.prisma, userId);
    return {
      balance: user.balance,
      bonusBalance: user.bonusBalance,
      reserved,
      available: user.balance + user.bonusBalance - reserved,
    };
  }

  /** 创建预占：锁定用户行后按可用余额校验；同一 jobId 幂等。 */
  async createHold(input: CreateHoldInput): Promise<HoldView> {
    if (input.amount <= 0n) {
      throw new BadRequestException('预占金额必须为正');
    }
    if (!input.jobId.trim()) {
      throw new BadRequestException('jobId 不能为空');
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.novelBalanceHold.findUnique({
        where: { jobId: input.jobId },
      });
      if (existing) {
        if (
          existing.status === HOLD_ACTIVE &&
          existing.userId === input.userId &&
          existing.amount === input.amount
        ) {
          return this.toHoldView(existing, { alreadyExisted: true });
        }
        throw new ConflictException('该任务已存在预占');
      }

      await tx.$executeRaw`SELECT id FROM users WHERE id = ${input.userId} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: input.userId } });
      if (!user) {
        throw new NotFoundException('用户不存在');
      }

      const reserved = await this.sumActiveReserved(tx, input.userId);
      const available = user.balance + user.bonusBalance - reserved;
      if (available < input.amount) {
        throw new InsufficientBalanceException();
      }

      const created = await tx.novelBalanceHold.create({
        data: {
          jobId: input.jobId,
          userId: input.userId,
          amount: input.amount,
          settledAmount: 0n,
          status: HOLD_ACTIVE,
        },
      });
      return this.toHoldView(created, { alreadyExisted: false });
    });
  }

  /** 逐调用结算：费率快照计费，jobId+callId 幂等，超预占 402。 */
  async settleCall(input: SettleCallInput, admittedRate?: Awaited<ReturnType<RatesService['buildRateSnapshot']>>, admittedTx?: Prisma.TransactionClient): Promise<SettleCallResult> {
    if (!input.jobId.trim() || !input.callId.trim()) {
      throw new BadRequestException('jobId 与 callId 不能为空');
    }
    const alreadySettled = await this.findExistingSettlement(input);
    if (alreadySettled) return alreadySettled;

    let snapshot;
    try {
      snapshot = admittedRate ?? await this.rates.buildRateSnapshot(input.model);
    } catch (error: unknown) {
      // A retry may race with the original settlement and a subsequent rate
      // retirement. The persisted call snapshot remains authoritative.
      const concurrentlySettled = await this.findExistingSettlement(input);
      if (concurrentlySettled) return concurrentlySettled;
      throw error;
    }
    const charge = computeChargeFen({
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      inputPricePerMillion: BigInt(snapshot.inputPricePerMillion),
      outputPricePerMillion: BigInt(snapshot.outputPricePerMillion),
      multiplierPercent: snapshot.multiplierPercent ?? 100,
    });
    // capAtHold：结算超出预占余量时按余量封顶（内容已生成的对话式结算，丢弃即浪费）。
    const clampedCharge = (holdAmount: bigint, settledAmount: bigint): bigint => {
      const remaining = holdAmount - settledAmount;
      return remaining < 0n ? 0n : (charge > remaining ? remaining : charge);
    };

    try {
      const settle = async (tx: Prisma.TransactionClient): Promise<SettleCallResult> => {
        const existing = await tx.novelGenerationCall.findUnique({
          where: {
            jobId_callId: { jobId: input.jobId, callId: input.callId },
          },
        });
        if (existing) {
          this.assertSettlementMatchesInput(existing, input);
          const hold = await tx.novelBalanceHold.findUniqueOrThrow({
            where: { jobId: input.jobId },
          });
          return this.toSettleResult(existing, hold, true);
        }

        await tx.$executeRaw`SELECT id FROM novel_balance_hold WHERE job_id = ${input.jobId} FOR UPDATE`;
        const hold = await tx.novelBalanceHold.findUnique({
          where: { jobId: input.jobId },
        });
        if (!hold) {
          throw new NotFoundException('预占不存在');
        }
        if (hold.status !== HOLD_ACTIVE) {
          throw new ConflictException('预占已结束，无法继续结算');
        }
        const effectiveCharge = input.capAtHold
          ? clampedCharge(hold.amount, hold.settledAmount)
          : charge;
        if (!input.capAtHold && hold.settledAmount + charge > hold.amount) {
          throw new HoldExhaustedException();
        }

        await tx.$executeRaw`SELECT id FROM users WHERE id = ${hold.userId} FOR UPDATE`;
        // 双余额扣款：先扣充值余额（真实），不足部分扣赠送余额（虚拟）。
        // hold 预占校验保证 充值+赠送-在途 >= charge，两账户均不会扣成负数。
        let chargeFromReal = 0n;
        let chargeFromBonus = 0n;
        if (effectiveCharge > 0n) {
          const user = await tx.user.findUniqueOrThrow({
            where: { id: hold.userId },
          });
          chargeFromReal = user.balance >= effectiveCharge ? effectiveCharge : user.balance;
          chargeFromBonus = effectiveCharge - chargeFromReal;
          await tx.user.update({
            where: { id: hold.userId },
            data: {
              balance: { decrement: chargeFromReal },
              bonusBalance: { decrement: chargeFromBonus },
            },
          });
        }

        const updatedHold = await tx.novelBalanceHold.update({
          where: { id: hold.id },
          data: { settledAmount: { increment: effectiveCharge } },
        });
        const created = await tx.novelGenerationCall.create({
          data: {
            jobId: input.jobId,
            callId: input.callId,
            holdId: hold.id,
            userId: hold.userId,
            internalStage: input.internalStage,
            model: input.model,
            tokensIn: input.tokensIn,
            tokensOut: input.tokensOut,
            rateSnapshot: snapshot as unknown as Prisma.InputJsonValue,
            actualCharge: effectiveCharge,
            chargeFromReal,
            chargeFromBonus,
          },
        });
        return this.toSettleResult(created, updatedHold, false);
      };
      return admittedTx ? await settle(admittedTx) : await this.prisma.$transaction((tx) => settle(tx as unknown as Prisma.TransactionClient));
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.novelGenerationCall.findUnique({
          where: {
            jobId_callId: { jobId: input.jobId, callId: input.callId },
          },
        });
        const hold = await this.prisma.novelBalanceHold.findUnique({
          where: { jobId: input.jobId },
        });
        if (existing && hold) {
          this.assertSettlementMatchesInput(existing, input);
          return this.toSettleResult(existing, hold, true);
        }
      }
      throw error;
    }
  }

  private async findExistingSettlement(
    input: Pick<SettleCallInput, 'jobId' | 'callId' | 'internalStage' | 'model' | 'tokensIn' | 'tokensOut'>,
  ): Promise<SettleCallResult | null> {
    const existing = await this.prisma.novelGenerationCall.findUnique({
      where: {
        jobId_callId: { jobId: input.jobId, callId: input.callId },
      },
    });
    if (!existing) return null;
    this.assertSettlementMatchesInput(existing, input);
    const hold = await this.prisma.novelBalanceHold.findUnique({
      where: { jobId: input.jobId },
    });
    if (!hold) {
      throw new ConflictException('existing settlement is missing its balance hold');
    }
    return this.toSettleResult(existing, hold, true);
  }

  /** A call id is an idempotency key, not permission to merge two different
   * model calls.  Retries must reproduce the exact immutable settlement
   * payload, otherwise a corrupted or mixed retry could hide usage. */
  private assertSettlementMatchesInput(
    existing: {
      internalStage: string;
      model: string;
      tokensIn: number;
      tokensOut: number;
    },
    input: Pick<SettleCallInput, 'internalStage' | 'model' | 'tokensIn' | 'tokensOut'>,
  ): void {
    if (
      existing.internalStage !== input.internalStage ||
      existing.model !== input.model ||
      existing.tokensIn !== input.tokensIn ||
      existing.tokensOut !== input.tokensOut
    ) {
      throw new ConflictException('callId 已用于不同的模型调用');
    }
  }

  /**
   * 任务收尾。成功 → settled；失败 → released。
   * 失败且未交付的章节追加冲正，原调用流水仍用于供应商成本审计。
   */
  async finalizeHold(input: FinalizeHoldInput): Promise<HoldView> {
    return this.prisma.$transaction((tx) =>
      this.finalizeHoldInTransaction(tx as unknown as Prisma.TransactionClient, input),
    );
  }

  /**
   * Finalize a hold inside a caller-owned transaction.  The chapter job uses
   * this to make final billing and durable chapter delivery commit or roll
   * back together, rather than choosing between a paid-but-lost chapter and a
   * free saved chapter when one of two independent transactions fails.
   */
  async finalizeHoldInTransaction(
    tx: Prisma.TransactionClient,
    input: FinalizeHoldInput,
  ): Promise<HoldView> {
    const targetStatus: HoldStatus =
      input.outcome === 'success' ? 'settled' : 'released';

    await tx.$executeRaw`SELECT id FROM novel_balance_hold WHERE job_id = ${input.jobId} FOR UPDATE`;
    const hold = await tx.novelBalanceHold.findUnique({
      where: { jobId: input.jobId },
    });
    if (!hold) {
      throw new NotFoundException('预占不存在');
    }
    if (hold.status !== HOLD_ACTIVE) {
      const refund = await tx.novelGenerationRefund.findUnique({ where: { jobId: input.jobId } });
      return this.toHoldView({ ...hold, settledAmount: hold.settledAmount - (refund ? refund.fromReal + refund.fromBonus : 0n) }, { alreadyFinalized: true });
    }
    let refunded = 0n;
    if (input.outcome === 'failure' && hold.settledAmount > 0n) {
      const job = await tx.novelGenerationJob.findUnique({ where: { jobId: input.jobId } });
      if (job?.jobType === 'chapter_generation' && job.status !== 'succeeded') {
        await tx.$executeRaw`SELECT id FROM users WHERE id = ${hold.userId} FOR UPDATE`;
        const sums = await tx.novelGenerationCall.aggregate({ where: { jobId: input.jobId }, _sum: { chargeFromReal: true, chargeFromBonus: true } });
        const fromReal = sums._sum.chargeFromReal ?? 0n;
        const fromBonus = sums._sum.chargeFromBonus ?? 0n;
        if (fromReal + fromBonus !== hold.settledAmount) throw new ConflictException('章节费用归因不一致，已暂停收尾等待对账');
        await tx.novelGenerationRefund.create({ data: { jobId: input.jobId, userId: hold.userId, fromReal, fromBonus, reason: 'chapter_not_delivered' } });
        await tx.user.update({ where: { id: hold.userId }, data: { balance: { increment: fromReal }, bonusBalance: { increment: fromBonus } } });
        refunded = fromReal + fromBonus;
      }
    }
    const updated = await tx.novelBalanceHold.update({
      where: { id: hold.id },
      data: { status: targetStatus, finalizedAt: new Date() },
    });
    return this.toHoldView({ ...updated, settledAmount: updated.settledAmount - refunded }, { alreadyFinalized: false });
  }

  /** 管理员调账：作用于赠送余额（虚拟收入），只追加流水，负数不得使赠送余额 < 0。 */
  async adjustBalance(input: AdjustBalanceInput): Promise<AdjustmentView> {
    const reason = input.reason.trim();
    if (!reason) {
      throw new BadRequestException('调账原因不能为空');
    }
    if (input.amount === 0n) {
      throw new BadRequestException('调账金额不能为 0');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM users WHERE id = ${input.userId} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: input.userId } });
      if (!user) {
        throw new NotFoundException('用户不存在');
      }
      const nextBonus = user.bonusBalance + input.amount;
      if (nextBonus < 0n) {
        throw new BadRequestException('调账后赠送余额不能为负');
      }
      const admin = await tx.user.findUnique({
        where: { id: input.adminUserId },
      });
      if (!admin) {
        throw new NotFoundException('管理员不存在');
      }
      await tx.user.update({
        where: { id: input.userId },
        data: { bonusBalance: nextBonus },
      });
      const created = await tx.novelBillingAdjustment.create({
        data: {
          userId: input.userId,
          adminUserId: input.adminUserId,
          amount: input.amount,
          reason,
        },
      });
      return {
        id: created.id,
        userId: created.userId,
        adminUserId: created.adminUserId,
        amount: created.amount,
        reason: created.reason,
        createdAt: created.createdAt,
      };
    });
  }

  /** 内部进度回调：写入 hold 的 progress 字段（Phase 3 前暂存于此）。 */
  async updateJobProgress(
    input: UpdateJobProgressInput,
  ): Promise<JobProgressView> {
    const hold = await this.prisma.novelBalanceHold.findUnique({
      where: { jobId: input.jobId },
    });
    if (!hold) {
      throw new NotFoundException('预占不存在');
    }
    const updated = await this.prisma.novelBalanceHold.update({
      where: { id: hold.id },
      data: {
        progressStage: input.stage ?? hold.progressStage,
        progressDetail: (input.detail ??
          hold.progressDetail) as Prisma.InputJsonValue,
      },
    });
    return {
      jobId: updated.jobId,
      status: input.status,
      stage: updated.progressStage,
      detail: updated.progressDetail,
    };
  }

  /** Σ(active holds 的 amount − settledAmount)。 */
  private async sumActiveReserved(
    db: {
      novelBalanceHold: {
        findMany: (args: {
          where: { userId: number; status: string };
          select: { amount: true; settledAmount: true };
        }) => Promise<Array<{ amount: bigint; settledAmount: bigint }>>;
      };
    },
    userId: number,
  ): Promise<bigint> {
    const holds = await db.novelBalanceHold.findMany({
      where: { userId, status: HOLD_ACTIVE },
      select: { amount: true, settledAmount: true },
    });
    return holds.reduce(
      (sum, hold) => sum + (hold.amount - hold.settledAmount),
      0n,
    );
  }

  private toHoldView(
    hold: {
      jobId: string;
      userId: number;
      amount: bigint;
      settledAmount: bigint;
      status: string;
      progressStage: string | null;
    },
    flags: { alreadyExisted?: boolean; alreadyFinalized?: boolean },
  ): HoldView {
    return {
      jobId: hold.jobId,
      userId: hold.userId,
      amount: hold.amount,
      settledAmount: hold.settledAmount,
      status: hold.status as HoldStatus,
      alreadyExisted: flags.alreadyExisted ?? false,
      alreadyFinalized: flags.alreadyFinalized ?? false,
      progressStage: hold.progressStage,
    };
  }

  private toSettleResult(
    call: {
      jobId: string;
      callId: string;
      actualCharge: bigint;
      chargeFromReal: bigint;
      chargeFromBonus: bigint;
    },
    hold: { amount: bigint; settledAmount: bigint },
    alreadySettled: boolean,
  ): SettleCallResult {
    return {
      jobId: call.jobId,
      callId: call.callId,
      alreadySettled,
      actualCharge: call.actualCharge,
      chargeFromReal: call.chargeFromReal,
      chargeFromBonus: call.chargeFromBonus,
      settledAmount: hold.settledAmount,
      remainingBudget: hold.amount - hold.settledAmount,
    };
  }
}
