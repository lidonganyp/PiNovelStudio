/** Durable, once-confirmed sequential rewrites; existing text is never a completion receipt. */
import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { requireOwnedProject } from '../../common/ownership';
import { JobsService } from './jobs.service';
import { revisionAuthorHash } from './revision-materials';

interface RevisionItem {
  chapterId: number; chapterNumber: number; version: number; seedVersion: number;
  manual: boolean; attempts: number; jobId?: string; completed?: boolean;
}
interface RevisionPlan {
  items: RevisionItem[]; reasons: string[]; perChapterFen: number; totalFen: number;
  maxChapterMs: number; maxAttempts: number;
}
interface RevisionView {
  id: string; version: number; status: string; projectId: number;
  startChapter?: number; endChapter?: number; completedChapters: number; totalChapters: number;
  chapters: RevisionItem[]; reasons: string[]; perChapterFen: number; totalFen: number;
  pauseCode: string | null; pauseReason: string | null;
}
type Revision = Awaited<ReturnType<PrismaService['novelRevision']['findFirstOrThrow']>>;

@Injectable()
export class RevisionsService implements OnModuleInit, OnModuleDestroy {
  private readonly owner = randomUUID();
  private readonly logger = new Logger(RevisionsService.name);
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(private readonly prisma: PrismaService, private readonly jobs: JobsService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => { void this.tick().catch((error: unknown) => {
      this.logger.error(error instanceof Error ? error.message : String(error));
    }); }, 1000);
    this.timer.unref();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  async propose(userId: number, projectId: number, range: { startChapter?: number; endChapter?: number }): Promise<ReturnType<RevisionsService['view']>> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const chapters = await this.prisma.novelChapter.findMany({
      where: { userId, projectId, deletedAt: null }, include: { seed: true }, orderBy: { chapterNumber: 'asc' },
    });
    const selected = chapters.filter((row) => row.chapterNumber >= (range.startChapter ?? 1)
      && row.chapterNumber <= (range.endChapter ?? Number.MAX_SAFE_INTEGER));
    if (selected.length === 0) throw new ConflictException('没有可重写的章节');
    for (let i = 1; i < selected.length; i++) {
      if (selected[i].chapterNumber !== selected[i - 1].chapterNumber + 1) throw new ConflictException('重写范围内章节编号不连续，请先补全');
    }
    const items: RevisionItem[] = [];
    for (const chapter of selected) {
      if (!chapter.seed?.intent.trim() || !chapter.seed.endingGoal.trim()) throw new ConflictException(`第${chapter.chapterNumber}章种子不完整`);
      const version = await this.prisma.novelChapterVersion.findFirst({
        where: { chapterId: chapter.id, versionNumber: chapter.version, userId }, select: { source: true },
      });
      items.push({ chapterId: chapter.id, chapterNumber: chapter.chapterNumber, version: chapter.version,
        seedVersion: chapter.seed.version, attempts: 0,
        manual: Boolean(chapter.content.trim()) && version?.source !== 'ai_generated' });
    }
    const plan: RevisionPlan = {
      items, reasons: ['角色、大纲或其他创作资料的变化可能沿前文因果传播；默认建议覆盖全部章节。',
        '范围内按章重写，成功后立即生效；可恢复故障在预算内自动继续，手工稿、资料变化或预算不足时暂停。'],
      perChapterFen: 200, totalFen: 2000, maxChapterMs: 45 * 60_000, maxAttempts: 7,
    };
    const revision = await this.prisma.novelRevision.create({ data: {
      userId, projectId, inputHash: await this.authorHash(userId, projectId, items),
      plan: plan as unknown as Prisma.InputJsonValue,
    } });
    return this.view(revision);
  }

  async get(userId: number, projectId: number, id: string): Promise<ReturnType<RevisionsService['view']>> {
    return this.view(await this.owned(userId, projectId, id));
  }
  async list(userId: number, projectId: number): Promise<Array<ReturnType<RevisionsService['view']>>> {
    await requireOwnedProject(this.prisma, userId, projectId);
    return (await this.prisma.novelRevision.findMany({ where: { userId, projectId }, orderBy: { createdAt: 'desc' }, take: 10 })).map((row) => this.view(row));
  }

  async confirm(userId: number, projectId: number, id: string, version: number): Promise<ReturnType<RevisionsService['view']>> {
    const row = await this.owned(userId, projectId, id);
    if (row.status !== 'awaiting_confirmation') return this.view(row);
    const plan = row.plan as unknown as RevisionPlan;
    if (row.version !== version || row.inputHash !== await this.authorHash(userId, projectId, plan.items)) {
      throw new ConflictException('创作资料已变化，请重新查看并确认重写范围');
    }
    await this.assertChapterVersions(userId, projectId, plan.items);
    try {
      await this.prisma.novelRevision.updateMany({ where: { id, version, status: 'awaiting_confirmation' },
        data: { status: 'queued', version: { increment: 1 } } });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('该作品已有重写任务');
      throw error;
    }
    return this.get(userId, projectId, id);
  }

  async resume(userId: number, projectId: number, id: string): Promise<ReturnType<RevisionsService['view']>> {
    const row = await this.owned(userId, projectId, id);
    if (row.status !== 'paused') return this.view(row);
    if (row.pauseCode !== 'generation_failed') throw new ConflictException(row.pauseReason ?? '请修正资料并重新确认范围');
    const plan = row.plan as unknown as RevisionPlan;
    if (row.inputHash !== await this.authorHash(userId, projectId, plan.items)) throw new ConflictException('资料已修改，请重新确认重写范围');
    const current = plan.items.find((item) => !item.completed);
    if (current?.jobId) {
      const failed = await this.prisma.novelGenerationJob.findUnique({ where: { jobId: current.jobId } });
      if (failed && (failed.failure as { recoverable?: boolean } | null)?.recoverable === false) {
        throw new ConflictException(failed.failureMessage ?? '本章需要修正资料，请重新确认范围');
      }
      delete current.jobId;
    }
    await this.prisma.novelRevision.updateMany({ where: { id, version: row.version, status: 'paused' }, data: {
      status: 'queued', plan: plan as unknown as Prisma.InputJsonValue,
      pauseCode: null, pauseReason: null, version: { increment: 1 },
    } });
    return this.get(userId, projectId, id);
  }

  /** Separate explicit consent is required for the exact current manual version. */
  async approveManual(userId: number, projectId: number, id: string, chapterVersion: number): Promise<RevisionView> {
    const row = await this.owned(userId, projectId, id);
    if (row.status !== 'paused' || row.pauseCode !== 'manual_chapter') throw new ConflictException('当前没有待确认的手工稿');
    const plan = row.plan as unknown as RevisionPlan;
    const item = plan.items.find((entry) => !entry.completed);
    if (!item || item.jobId) throw new ConflictException('请重新确认重写范围');
    const chapter = await this.prisma.novelChapter.findFirst({ where: { id: item.chapterId, userId, projectId, deletedAt: null } });
    if (!chapter || chapter.version !== chapterVersion) throw new ConflictException('手工稿又有变化，请重新查看');
    if (row.inputHash !== await this.authorHash(userId, projectId, plan.items)) throw new ConflictException('资料已变化，请重新确认范围');
    item.version = chapter.version;
    item.manual = false;
    await this.prisma.novelRevision.updateMany({ where: { id, version: row.version, status: 'paused' }, data: {
      plan: plan as unknown as Prisma.InputJsonValue, status: 'queued', pauseCode: null, pauseReason: null, version: { increment: 1 },
    } });
    return this.get(userId, projectId, id);
  }

  async stop(userId: number, projectId: number, id: string): Promise<RevisionView> {
    const row = await this.owned(userId, projectId, id);
    // Stop future dispatch; an already accepted chapter may still finish and be saved.
    const stopped = await this.prisma.novelRevision.updateMany({ where: { id, version: row.version,
      status: { in: ['awaiting_confirmation', 'queued', 'running', 'paused'] },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
    }, data: { status: 'stopped', version: { increment: 1 } } });
    if (stopped.count === 0 && ['queued', 'running', 'paused', 'awaiting_confirmation'].includes(row.status)) {
      throw new ConflictException('调度正在更新，请稍后再停止后续任务');
    }
    return this.get(userId, projectId, id);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const rows = await this.prisma.novelRevision.findMany({ where: {
        status: { in: ['queued', 'running'] }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      }, orderBy: { createdAt: 'asc' }, take: 8 });
      for (const row of rows) {
        const claim = await this.prisma.novelRevision.updateMany({ where: { id: row.id, version: row.version,
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }], status: { in: ['queued', 'running'] } },
          data: { leaseOwner: this.owner, leaseUntil: new Date(Date.now() + 30_000) } });
        if (claim.count !== 1) continue;
        try { await this.advance(row); }
        catch (error: unknown) {
          this.logger.error(`revision ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
          await this.pause(row, 'generation_failed', error instanceof Error ? error.message : '任务提交失败');
        } finally {
          await this.prisma.novelRevision.updateMany({ where: { id: row.id, leaseOwner: this.owner }, data: { leaseOwner: null, leaseUntil: null } });
        }
      }
    } finally { this.busy = false; }
  }

  private async advance(row: Revision): Promise<void> {
    const plan = row.plan as unknown as RevisionPlan;
    const item = plan.items.find((entry) => !entry.completed);
    if (!item) { await this.save(row, plan, 'succeeded'); return; }
    if (row.inputHash !== await this.authorHash(row.userId, row.projectId, plan.items)) {
      await this.pause(row, 'materials_changed', '创作资料已变化，请重新确认重写范围'); return;
    }
    for (const completed of plan.items.filter((entry) => entry.completed)) {
      const prior = await this.prisma.novelChapter.findFirst({ where: { id: completed.chapterId, userId: row.userId, projectId: row.projectId, deletedAt: null } });
      if (!prior || prior.version !== completed.version + 1 || prior.generationJobId !== completed.jobId) {
        await this.pause(row, 'materials_changed', '已重写的前章又被修改，请重新确认后续重写范围'); return;
      }
    }
    // jobId is persisted before dispatch. A process death between SQL insert
    // and return cannot create a second job when the lease is reclaimed.
    if (item.jobId) {
      const job = await this.prisma.novelGenerationJob.findUnique({ where: { jobId: item.jobId } });
      if (job?.status === 'succeeded') {
        const chapter = await this.prisma.novelChapter.findFirst({ where: { id: item.chapterId, userId: row.userId, projectId: row.projectId, deletedAt: null } });
        if (!chapter || chapter.version !== item.version + 1 || chapter.generationJobId !== job.jobId) { await this.pause(row, 'manual_chapter', '生成完成后章节又被修改，请检查正文'); return; }
        item.completed = true;
        await this.save(row, plan, plan.items.every((entry) => entry.completed) ? 'succeeded' : 'running');
        return;
      }
      if (job && job.status !== 'running' && job.status !== 'pending') {
        if ((job.failure as { code?: string } | null)?.code === 'generation_budget_exhausted') {
          await this.pause(row, 'budget_exhausted', job.failureMessage ?? '本次生成预算不足，已保留进度'); return;
        }
        if (job.status !== 'failed' || (job.failure as { recoverable?: boolean } | null)?.recoverable === false) {
          await this.pause(row, 'generation_failed', job.failureMessage ?? '本章生成失败，已保留完成进度，可继续此章'); return;
        }
        // One range confirmation authorizes bounded recovery of this chapter.
        // The shared cost/time/attempt ledger below is never reset by a new job.
        delete item.jobId;
      }
      if (job && (job.status === 'running' || job.status === 'pending')) return;
    }
    const chapter = await this.prisma.novelChapter.findFirst({ where: { id: item.chapterId, userId: row.userId, projectId: row.projectId, deletedAt: null } });
    if (!chapter || item.manual || chapter.version !== item.version) {
      await this.pause(row, 'manual_chapter', `第${item.chapterNumber}章含手工修改或已变化，已暂停保护正文`); return;
    }
    const attempts = await this.prisma.novelGenerationJob.findMany({ where: { revisionId: row.id }, select: { chapterId: true, maxCharge: true, settledAmount: true, status: true, startedAt: true, completedAt: true, execution: true } });
    const chapterAttempts = attempts.filter((job) => job.chapterId === item.chapterId);
    const cost = (jobs: typeof attempts): number => jobs.reduce((sum, job) => {
      if (job.status === 'running' || job.status === 'pending') return sum + Number(job.maxCharge);
      const entries = (job.execution as { transports?: Array<{ actualFen?: string; maximumFen: string }> } | null)?.transports;
      return sum + (entries ? entries.reduce((used, e) => used + Number(e.actualFen ?? e.maximumFen), 0) : Number(job.settledAmount));
    }, 0);
    const elapsed = chapterAttempts.reduce((sum, job) => sum + Math.max(0, (job.completedAt?.getTime() ?? Date.now()) - job.startedAt.getTime()), 0);
    const remaining = Math.min(plan.perChapterFen - cost(chapterAttempts), plan.totalFen - cost(attempts));
    if (remaining <= 0 || elapsed >= plan.maxChapterMs || item.attempts >= plan.maxAttempts) {
      await this.pause(row, 'budget_exhausted', '本次授权的费用、时间或恢复次数已用尽，已保留进度'); return;
    }
    if (!item.jobId) {
      item.attempts++;
      item.jobId = createHash('sha256').update(`${row.id}:${item.chapterId}:${row.inputHash}:${item.attempts}`).digest('hex');
      await this.save(row, plan, 'running');
    }
    await this.jobs.submitChapterGeneration(row.userId, row.projectId, item.chapterId, {
      continuationMode: 'replace', jobId: item.jobId, revisionId: row.id,
      maxChargeFen: remaining, expectedChapterVersion: item.version,
      timeoutMs: plan.maxChapterMs - elapsed,
    });
  }

  private async save(row: Revision, plan: RevisionPlan, status: string): Promise<void> {
    await this.prisma.novelRevision.updateMany({ where: { id: row.id, leaseOwner: this.owner },
      data: { plan: plan as unknown as Prisma.InputJsonValue, status, version: { increment: 1 } } });
  }
  private async pause(row: Revision, code: string, reason: string): Promise<void> {
    await this.prisma.novelRevision.updateMany({ where: { id: row.id, leaseOwner: this.owner },
      data: { status: 'paused', pauseCode: code, pauseReason: reason.slice(0, 400), version: { increment: 1 } } });
  }
  private async owned(userId: number, projectId: number, id: string): Promise<Revision> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const row = await this.prisma.novelRevision.findFirst({ where: { id, userId, projectId } });
    if (!row) throw new NotFoundException('重写任务不存在');
    return row;
  }
  private async assertChapterVersions(userId: number, projectId: number, items: RevisionItem[]): Promise<void> {
    const chapters = await this.prisma.novelChapter.findMany({ where: { userId, projectId, deletedAt: null, id: { in: items.map((item) => item.chapterId) } } });
    if (items.some((item) => !chapters.some((chapter) => chapter.id === item.chapterId && chapter.version === item.version))) throw new ConflictException('章节已变化，请重新确认范围');
  }
  private async authorHash(userId: number, projectId: number, items: RevisionItem[]): Promise<string> {
    return revisionAuthorHash(this.prisma as unknown as Prisma.TransactionClient, userId, projectId, items.map((item) => item.chapterId));
  }
  private view(row: Revision): RevisionView {
    const plan = row.plan as unknown as RevisionPlan;
    return { id: row.id, version: row.version, status: row.status, projectId: row.projectId,
      startChapter: plan.items[0]?.chapterNumber, endChapter: plan.items.at(-1)?.chapterNumber,
      completedChapters: plan.items.filter((item) => item.completed).length, totalChapters: plan.items.length,
      chapters: plan.items, reasons: plan.reasons, perChapterFen: plan.perChapterFen, totalFen: plan.totalFen,
      pauseCode: row.pauseCode, pauseReason: row.pauseReason };
  }
}
