/** Persistent admission for each real HTTP attempt; unknown usage keeps its maximum reservation. */
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PRODUCTION_BILLING_MODEL_ROUTES } from '../../config/env';
import { RatesService } from '../rates/rates.service';
import { BillingService } from './billing.service';
import { computeChargeFen } from './money';

export interface ReserveTransport {
  jobId: string; callId: string; route: string; model: string; requestHash: string;
  inputTokenLimit: number; outputTokenLimit: number; recovery?: boolean;
}
export interface SettleTransport { jobId: string; callId: string; tokensIn?: number; tokensOut?: number; status: number; }
interface Entry extends Omit<ReserveTransport, 'jobId'> {
  maximumFen: string; actualFen?: string; state: 'reserved' | 'unknown' | 'settled';
  recovery: boolean; status?: number; tokensIn?: number; tokensOut?: number;
  rate: Awaited<ReturnType<RatesService['buildRateSnapshot']>>;
}
interface Execution { deadlineAt: number; transports?: Entry[]; [key: string]: unknown; }

@Injectable()
export class TransportBudgetService {
  constructor(private readonly prisma: PrismaService, private readonly rates: RatesService, private readonly billing: BillingService) {}

  async reserve(input: ReserveTransport): Promise<unknown> {
    if (!(PRODUCTION_BILLING_MODEL_ROUTES as readonly string[]).includes(input.route)) {
      throw new BadRequestException('模型调用不属于当前授权的生产 writer');
    }
    return this.prisma.$transaction(async (tx) => {
      const initial = await tx.novelGenerationJob.findUniqueOrThrow({ where: { jobId: input.jobId } });
      if (initial.revisionId) await tx.$executeRaw`SELECT id FROM novel_revisions WHERE id = ${initial.revisionId} FOR UPDATE`;
      await tx.$executeRaw`SELECT job_id FROM novel_generation_jobs WHERE job_id = ${input.jobId} FOR UPDATE`;
      const job = await tx.novelGenerationJob.findUniqueOrThrow({ where: { jobId: input.jobId } });
      const execution = job.execution as unknown as Execution | null;
      if (!execution) throw new ConflictException('生成任务没有持久化执行授权');
      const entries = execution.transports ?? [];
      const existing = entries.find((e) => e.callId === input.callId);
      if (existing) {
        if (existing.requestHash !== input.requestHash || existing.route !== input.route || existing.model !== input.model
          || existing.inputTokenLimit !== input.inputTokenLimit || existing.outputTokenLimit !== input.outputTokenLimit) throw new ConflictException('调用标识已绑定其他请求');
        return { admitted: true, maximumFen: existing.maximumFen, alreadyAdmitted: true };
      }
      const rate = await this.rates.buildRateSnapshot(input.route);
      const maximumFen = computeChargeFen({ tokensIn: input.inputTokenLimit, tokensOut: input.outputTokenLimit,
        inputPricePerMillion: BigInt(rate.inputPricePerMillion), outputPricePerMillion: BigInt(rate.outputPricePerMillion), multiplierPercent: rate.multiplierPercent ?? 100 });
      if (!['pending', 'running'].includes(job.status) || execution.deadlineAt <= Date.now()) throw new ConflictException('生成授权已结束');
      const hold = await tx.novelBalanceHold.findUniqueOrThrow({ where: { jobId: input.jobId } });
      if (hold.status !== 'active') throw new ConflictException('生成费用预占已结束');
      const revision = job.revisionId ? await tx.novelRevision.findUniqueOrThrow({ where: { id: job.revisionId } }) : null;
      const siblings = job.revisionId ? await tx.novelGenerationJob.findMany({ where: { revisionId: job.revisionId } }) : [job];
      const plan = revision?.plan as { perChapterFen?: number; totalFen?: number } | undefined;
      const cost = (items: Entry[]): bigint => items.reduce((sum, e) => sum + BigInt(e.actualFen ?? e.maximumFen), 0n);
      const read = (value: unknown): Entry[] => (value as Execution | null)?.transports ?? [];
      const chapterEntries = siblings.filter((s) => s.chapterId === job.chapterId).flatMap((s) => read(s.execution));
      const allEntries = siblings.flatMap((s) => read(s.execution));
      const isRecovery = input.recovery === true || siblings.some((s) => s.chapterId === job.chapterId && s.jobId !== job.jobId)
        || entries.some((e) => e.state === 'unknown' || (e.status ?? 0) >= 400);
      if (chapterEntries.length >= 25 || (isRecovery && chapterEntries.filter((e) => e.recovery).length >= 6)) throw new ConflictException('本章模型调用或恢复次数预算已用尽');
      if (cost(entries) + maximumFen > hold.amount
        || (plan?.perChapterFen !== undefined && cost(chapterEntries) + maximumFen > BigInt(plan.perChapterFen))
        || (plan?.totalFen !== undefined && cost(allEntries) + maximumFen > BigInt(plan.totalFen))) throw new ConflictException('剩余预算不足以覆盖下一次模型调用的最大费用');
      execution.transports = [...entries, { ...input, maximumFen: maximumFen.toString(), recovery: isRecovery, state: 'reserved', rate }];
      await tx.novelGenerationJob.update({ where: { jobId: input.jobId }, data: { execution: execution as unknown as Prisma.InputJsonValue } });
      return { admitted: true, maximumFen: maximumFen.toString(), alreadyAdmitted: false };
    });
  }

  async settle(input: SettleTransport): Promise<unknown> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT job_id FROM novel_generation_jobs WHERE job_id = ${input.jobId} FOR UPDATE`;
      const job = await tx.novelGenerationJob.findUniqueOrThrow({ where: { jobId: input.jobId } });
      const execution = job.execution as unknown as Execution;
      const entry = execution?.transports?.find((e) => e.callId === input.callId);
      if (!entry) throw new ConflictException('模型调用未获得费用预留');
      if (entry.state === 'settled') {
        if (entry.tokensIn !== input.tokensIn || entry.tokensOut !== input.tokensOut || entry.status !== input.status) throw new ConflictException('调用用量与已保存记录不符');
        return { actualChargeFen: entry.actualFen, unknownUsage: false, alreadySettled: true };
      }
      const known = input.tokensIn !== undefined && input.tokensOut !== undefined;
      if (known) {
        if (input.tokensIn! > entry.inputTokenLimit || input.tokensOut! > entry.outputTokenLimit) throw new ConflictException('供应商用量超过预留上限，已阻断后续调用等待核对');
        const settled = await this.billing.settleCall({ jobId: input.jobId, callId: input.callId,
          internalStage: /amplif/.test(entry.route) ? 'style_optimizer' : 'agentic_raw', model: entry.route,
          tokensIn: input.tokensIn!, tokensOut: input.tokensOut! }, entry.rate, tx as unknown as Prisma.TransactionClient);
        entry.actualFen = settled.actualCharge.toString(); entry.tokensIn = input.tokensIn; entry.tokensOut = input.tokensOut;
        entry.state = 'settled';
      } else { entry.state = 'unknown'; }
      entry.status = input.status;
      await tx.novelGenerationJob.update({ where: { jobId: input.jobId }, data: { execution: execution as unknown as Prisma.InputJsonValue } });
      return { actualChargeFen: entry.actualFen ?? '0', reservedFen: entry.maximumFen, unknownUsage: !known, alreadySettled: false };
    });
  }
}
