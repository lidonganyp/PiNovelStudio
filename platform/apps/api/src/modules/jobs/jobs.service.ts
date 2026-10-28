/**
 * 生成任务：预检 + 预占 + 令牌签发 + http 调度（本地开发可 stub）+ 轮询。
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { countWords, requireOwnedProject } from '../../common/ownership';
import { env, PRODUCTION_BILLING_MODEL_ROUTES } from '../../config/env';
import { BillingService } from '../billing/billing.service';
import { InsufficientBalanceException } from '../billing/billing.errors';
import { computeChargeFen, fenToString } from '../billing/money';
import { RatesService } from '../rates/rates.service';
import { RuntimeClient } from './runtime.client';
import { signTaskToken } from './task-token';
import {
  assertRuntimeWorkspacePayloadFits,
  RuntimeWorkspacePayloadError,
} from './runtime-workspace-payload';
import {
  applySafetyFactor,
  DEFAULT_SAFETY_FACTOR,
  reservationTokensForBudget,
  parseSafetyFactor,
  parseWordCountBudget,
  SETTING_SAFETY_FACTOR,
  SETTING_WORD_COUNT_BUDGET,
} from '../admin/runtime-settings';
import {
  assertNoFullPreviousChapter,
  compileProjectContext,
} from '../context/context-compiler';
import { ContextCompileError, FailureHttpException, FAILURE_CODES, makeFailure } from '../context/failure-envelope';
import {
  JobFailureError,
  jobFailureFromUnknown,
  readStoredFailure,
  runtimeInvokeFailure,
} from './job-failure';
import {
  assertAuthorContractForGeneration,
  compactNarrativeStateJson,
  isUsableStoryOutline,
  listAuthorContractGaps,
} from './book-context';
import {
  buildExplicitOutlineMarkdown,
  resolveProjectGenre,
} from './runtime-workspace-defaults';
import {
  mergeChapterContinuation,
  type ContinuationMode,
} from './chapter-continuation';
import type { TargetWordRange } from '../context/types';
import { ErrorReportsService } from '../error-reports/error-reports.service';
import { GenerationHistoryResolver } from './generation-history';
import { assertRevisionConsent } from './revision-materials';

type RuntimeWorkspaceRequest = {
  userId: number;
  projectId: number;
  chapterId: number;
  chapterNumber: number;
  continuationMode?: ContinuationMode;
  targetWordCount?: TargetWordRange;
};

type GenerationContextDb = Pick<PrismaService,
  'novelProject' | 'novelCharacter' | 'novelDocument' | 'novelChapter' | 'novelChapterSeed' | 'novelDocumentVersion'>;

interface GenerationMaterialSnapshot {
  request: RuntimeWorkspaceRequest;
  fingerprint: string;
}

/** Hash the actual writer materials; observation timestamps/token totals are not author inputs. */
export function fingerprintGenerationMaterials(value: Record<string, unknown>): string {
  const { contextManifest: _observations, ...materials } = value;
  const materialSourceHash = (_observations as { materialSourceHash?: string } | undefined)?.materialSourceHash;
  const stable = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(stable);
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, stable(v)]));
    return entry;
  };
  return createHash('sha256').update(JSON.stringify(stable({ ...materials, materialSourceHash }))).digest('hex');
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Render bounded historical chapter evidence for the runtime writer. */
function renderChapterCatalog(chapters: Array<{
  chapterNumber: number;
  title?: string | null;
  status?: string | null;
  wordCount?: number | null;
  content: string;
  seed?: { intent?: string; promises?: string; endingGoal?: string } | null;
}>, targetChapterNumber?: number): string {
  const ordered = chapters
    .slice()
    .sort((left, right) => left.chapterNumber - right.chapterNumber);
  const index = ordered
    .map((chapter) => `第${chapter.chapterNumber}章：${chapter.title?.trim() || '未命名'}`)
    .join('；');
  const boundedIndex = index.length <= 12000 ? index : `${index.slice(0, 11980)}…`;
  const rows = ordered
    .slice()
    .sort((left, right) => {
      if (targetChapterNumber === undefined) return left.chapterNumber - right.chapterNumber;
      const leftDistance = Math.abs(left.chapterNumber - (targetChapterNumber - 1));
      const rightDistance = Math.abs(right.chapterNumber - (targetChapterNumber - 1));
      return leftDistance - rightDistance || left.chapterNumber - right.chapterNumber;
    })
    .map((chapter) => {
      const tail = chapter.content.replace(/^\uFEFF/u, '').trim().slice(-360);
      const seed = [chapter.seed?.intent, chapter.seed?.promises, chapter.seed?.endingGoal]
        .filter((value): value is string => Boolean(value?.trim()))
        .join('；');
      return [
        `第${chapter.chapterNumber}章｜${chapter.title?.trim() || '未命名'}｜状态：${chapter.status || 'unknown'}｜字数：${chapter.wordCount ?? 0}`,
        seed ? `本章种子：${seed}` : '',
        tail ? `正文结尾摘要：${tail}` : '正文为空',
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');
  // Hundreds of chapters are normal. Keep the catalog useful without turning
  // the runtime request into a second copy of the novel.
  const body = rows.length <= 24000 ? rows : `${rows.slice(0, 23980)}\n…`;
  return `完整章节索引：${boundedIndex}\n\n${body}`;
}



/** Prisma's unique-constraint code is deliberately checked structurally here so
 * the service can translate the database concurrency guard into the public API
 * conflict contract without exposing ORM details. */
function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && (error as { code?: unknown }).code === 'P2002';
}

// Stub runtime is a local/test transport and must not require a production
// model rate or create a billable model-call record.
const STUB_RUNTIME_HOLD_FEN = 50n;
interface HttpGenerationInput {
  revisionId?: string;
  userId: number; projectId: number; chapterId: number; jobId: string; maxCharge: bigint;
  chapterNumber: number; chapterVersion: number; seedVersion: number;
  runtimeWorkspaceInput?: Record<string, unknown>; continuationMode?: ContinuationMode;
  continuationDraft: string; targetWordCount?: TargetWordRange; timeoutMs?: number;
  durable?: boolean;
}
interface StoredExecution {
  version: 1; deadlineAt: number;
  input: Omit<HttpGenerationInput, 'maxCharge'> & { maxCharge: string };
}

// Reserve against a full multi-stage chapter run, not a single small model
// call. Actual billing still settles token usage call-by-call; this ceiling
// only prevents an otherwise valid run from exhausting its hold too early.
// These are a full-run reservation envelope, not a per-call estimate. The
// current production pipeline always has an Agentic draft plus whole-chapter
// editorial pass; reserving the higher configured route price across this
// envelope prevents a successful delivery from discovering too late that its
// hold was sized for only one small or stub call.


@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private readonly workerId = randomUUID();
  private dispatchTimer?: ReturnType<typeof setInterval>;
  private readonly executions = new Set<Promise<void>>();
  private dispatching = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly rates: RatesService,
    private readonly runtime: RuntimeClient,
    @Optional() private readonly errorReports?: ErrorReportsService,
  ) {}

  /**
   * The HTTP dispatch is intentionally detached from the submit request.  Any
   * task can outlive an individual API process during rolling deploys. Only
   * work that has exceeded the bounded runtime window is treated as a dead
   * attempt, so startup recovery cannot terminate a healthy in-flight job.
   */
  async onModuleInit(): Promise<void> {
    // Fail before serving production traffic when the runtime's reported model
    // routes cannot be settled. Development/test install ephemeral rates after
    // app construction, but still validate the same rates before each submit.
    if (env.NODE_ENV === 'production') {
      await this.assertBillingModelsReady();
    }
    const interrupted = await this.prisma.novelGenerationJob.findMany({
      where: {
        status: { in: ['pending', 'running'] },
        execution: { equals: Prisma.DbNull },
        // A rolling restart or a second API replica must not terminate a
        // still-running job. Only reclaim work that has outlived the full
        // runtime request timeout plus a small scheduling grace period.
        startedAt: { lt: new Date(Date.now() - this.recoveryGraceMs()) },
      },
      select: { jobId: true },
    });
    for (const job of interrupted) {
      let settledAmount = 0n;
      try {
        const finalized = await this.billing.finalizeHold({
          jobId: job.jobId,
          outcome: 'failure',
        });
        if (finalized.status !== 'released') {
          throw new Error(
            `interrupted job hold ${job.jobId} finalized as ${finalized.status}, not released`,
          );
        }
        settledAmount = finalized.settledAmount;
      } catch (error: unknown) {
        // A missing hold means there is no reserved balance left to protect;
        // the job can be closed as an interrupted, uncharged attempt. Any
        // other billing failure leaves the hold state unknown, so startup
        // must fail closed instead of releasing the concurrency guard while
        // money may still be reserved.
        if (error instanceof NotFoundException) {
          this.logger.warn(
            `interrupted job ${job.jobId} has no billing hold; closing as failed`,
          );
        } else {
          this.logger.error(
            `failed to release interrupted job hold ${job.jobId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          await this.recordServerErrorSafely({
            jobId: job.jobId,
            code: 'generation_interrupted_recovery_failed',
            stage: 'jobs.startup_recovery',
            gate: 'billing_release',
            severity: 'fatal',
            message: error instanceof Error ? error.message : String(error),
            diagnostic: { operation: 'finalize_interrupted_hold' },
          });
          throw error;
        }
        await this.recordServerErrorSafely({
          jobId: job.jobId,
          code: 'generation_interrupted_recovery_failed',
          stage: 'jobs.startup_recovery',
          gate: 'billing_release',
          severity: 'fatal',
          message: error instanceof Error ? error.message : String(error),
          diagnostic: { operation: 'finalize_interrupted_hold' },
        });
      }
      try {
        await this.prisma.novelGenerationJob.update({
          where: { jobId: job.jobId },
          data: {
            status: 'failed',
            failureMessage: '生成因服务重启中断，请重新提交',
            failure: jobFailureFromUnknown(new Error('generation interrupted by service restart')),
            settledAmount,
            completedAt: new Date(),
          },
        });
      } catch (error: unknown) {
        // Leave the row active when the state write itself fails; the next
        // startup can retry recovery instead of silently losing the record.
        this.logger.error(
          `failed to mark interrupted job ${job.jobId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.recordServerErrorSafely({
          jobId: job.jobId,
          code: 'generation_interrupted_persist_failed',
          stage: 'jobs.startup_recovery',
          gate: 'job_update',
          severity: 'fatal',
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    this.dispatchTimer = setInterval(() => { void this.dispatchStoredJobs().catch((error: unknown) => {
      this.logger.error(`durable dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    }); }, 1000);
    this.dispatchTimer.unref();
  }

  onModuleDestroy(): void { if (this.dispatchTimer) clearInterval(this.dispatchTimer); }
  /** Used by bounded integration tests to wait for already-claimed executions. */
  async drain(): Promise<void> { await Promise.allSettled([...this.executions]); }

  async dispatchStoredJobs(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      const rows = await this.prisma.novelGenerationJob.findMany({ where: {
        status: { in: ['pending', 'running'] }, NOT: { execution: { equals: Prisma.DbNull } },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      }, orderBy: { startedAt: 'asc' }, take: 8 });
      for (const row of rows) {
        const stored = row.execution as unknown as StoredExecution;
        if (!stored) continue;
        if (stored.version !== 1 || !stored.input || !Number.isFinite(stored.deadlineAt)) {
          await this.closeFailedGenerationIfHoldReleased(row.jobId, jobFailureFromUnknown(new Error('stored execution is invalid')));
          continue;
        }
        const claimed = await this.prisma.novelGenerationJob.updateMany({ where: { jobId: row.jobId,
          status: { in: ['pending', 'running'] }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
        }, data: { leaseOwner: this.workerId, leaseUntil: new Date(Date.now() + 30_000) } });
        if (claimed.count !== 1) continue;
        const task = this.executeStored(row.jobId, stored);
        this.executions.add(task);
        void task.finally(() => { this.executions.delete(task); }).catch(() => undefined);
      }
    } finally { this.dispatching = false; }
  }

  private async executeStored(jobId: string, stored: StoredExecution): Promise<void> {
    const heartbeat = setInterval(() => { void this.prisma.novelGenerationJob.updateMany({
      where: { jobId, leaseOwner: this.workerId }, data: { leaseUntil: new Date(Date.now() + 30_000) },
    }).catch((error: unknown) => this.logger.error(`job lease renewal failed: ${String(error)}`)); }, 10_000);
    heartbeat.unref();
    try {
      const remainingMs = stored.deadlineAt - Date.now();
      if (remainingMs <= 0) throw new Error('generation deadline exceeded before recovery');
      const input: HttpGenerationInput = { ...stored.input, maxCharge: BigInt(stored.input.maxCharge), timeoutMs: remainingMs, durable: true };
      // Also closes the process-death window between job insert and hold creation.
      await this.billing.createHold({ userId: input.userId, jobId, amount: input.maxCharge });
      await this.runHttpGeneration(input);
    } catch (error: unknown) {
      await this.closeFailedGenerationIfHoldReleased(jobId, jobFailureFromUnknown(error));
    } finally {
      clearInterval(heartbeat);
      await this.prisma.novelGenerationJob.updateMany({ where: { jobId, leaseOwner: this.workerId }, data: { leaseOwner: null, leaseUntil: null } });
    }
  }

  private recoveryGraceMs(): number {
    return env.NOVEL_RUNTIME_REQUEST_TIMEOUT_MS + 60_000;
  }

  /**
   * 聊天生成入口在调用规划模型之前检查作者资料。
   * 缺失类型/风格/世界观/宪法时直接结构化阻断，不创建任务、不扣规划额度。
   */
  async assertAuthorContract(userId: number, projectId: number): Promise<void> {
    const [project, characters, documents] = await Promise.all([
      this.prisma.novelProject.findFirst({
        where: { id: projectId, userId, deletedAt: null },
        select: { genre: true },
      }),
      this.prisma.novelCharacter.findMany({
        where: { projectId, userId, deletedAt: null },
        select: { goals: true, motivation: true, currentState: true, relationships: true },
      }),
      this.prisma.novelDocument.findMany({
        where: { projectId, userId, deletedAt: null },
        select: { documentType: true, content: true },
      }),
    ]);
    if (!project) {
      throw new NotFoundException('项目不存在');
    }
    const byType = new Map(documents.map((row) => [row.documentType, row]));
    const narrative = byType.get('narrative_state')?.content;
    const compact = narrative
      ? compactNarrativeStateJson(narrative).compact
      : { canon: [], character: [], promise: [] };
    const outline = byType.get('story_outline')?.content;
    try {
      assertAuthorContractForGeneration(listAuthorContractGaps({
        genre: project.genre,
        constitution: byType.get('creative_constitution')?.content,
        worldbuilding: byType.get('worldbuilding')?.content,
        styleProfile: byType.get('style_profile')?.content,
        characters,
        compact,
        usableStoryOutline: outline && isUsableStoryOutline(outline) ? outline : undefined,
      }));
    } catch (error: unknown) {
      if (error instanceof ContextCompileError) {
        throw new FailureHttpException(error.envelope);
      }
      throw error;
    }
  }

  /** 提交章节生成：校验种子 → 预占 → 建 job → stub/http 执行。 */
  async submitChapterGeneration(
    userId: number,
    projectId: number,
    chapterId: number,
    options: {
      continuationMode?: ContinuationMode;
      targetWordCount?: TargetWordRange;
      /** Internal revision dispatch only; these fields are never bound from HTTP bodies. */
      jobId?: string;
      revisionId?: string;
      expectedChapterVersion?: number;
      maxChargeFen?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<unknown> {
    await requireOwnedProject(this.prisma, userId, projectId);
    if (options.jobId) {
      const existing = await this.prisma.novelGenerationJob.findUnique({ where: { jobId: options.jobId } });
      if (existing) {
        if (existing.userId !== userId || existing.projectId !== projectId || existing.chapterId !== chapterId
          || existing.revisionId !== options.revisionId) throw new ConflictException('任务标识与重写范围不匹配');
        return this.getJob(userId, existing.jobId);
      }
    }
    const chapter = await this.prisma.novelChapter.findFirst({
      where: { id: chapterId, projectId, userId, deletedAt: null },
      include: { seed: true },
    });
    if (!chapter) {
      throw new NotFoundException('章节不存在');
    }
    if (options.expectedChapterVersion !== undefined && chapter.version !== options.expectedChapterVersion) {
      throw new ConflictException('章节已修改，请重新确认重写范围');
    }
    const seed = chapter.seed;
    if (!seed || !seed.intent.trim() || !seed.endingGoal.trim()) {
      throw new BadRequestException('写前种子不完整：intent 与 endingGoal 必填');
    }

    const running = await this.prisma.novelGenerationJob.findFirst({
      where: {
        userId,
        jobType: 'chapter_generation',
        status: { in: ['pending', 'running'] },
      },
    });
    if (running) {
      throw new ConflictException('已有进行中的生成任务');
    }

    // 续写模式解析：显式指定 > 聊天推断结果 > 按章节状态默认。
    // 已有正文的章节默认 append（扩写），避免无信号的生成请求把既有正文
    // 当成全新章节重写（生成模型看不到已有正文，产出与既有内容冲突）。
    const continuationMode: ContinuationMode = options.continuationMode
      ?? (chapter.content?.trim() ? 'append' : 'replace');

    // Build and bound the material snapshot before a job or billing hold exists.
    // The runtime has an HTTP body ceiling, so letting an oversized project
    // proceed would create a predictably failed, needlessly reserved job.
    let runtimeWorkspaceInput: Record<string, unknown> | undefined;
    if (env.NOVEL_RUNTIME_MODE !== 'stub') {
      try {
        runtimeWorkspaceInput = await this.buildRuntimeWorkspaceInput({
          userId,
          projectId,
          chapterId,
          chapterNumber: chapter.chapterNumber,
          continuationMode,
          targetWordCount: options.targetWordCount,
        });
        assertRuntimeWorkspacePayloadFits({
          chapterNumber: chapter.chapterNumber,
          chapterId: String(chapterId),
          workspaceId: `p${projectId}`,
          ...runtimeWorkspaceInput,
        });
      } catch (error: unknown) {
        if (error instanceof ContextCompileError) {
          throw new FailureHttpException(error.envelope);
        }
        if (error instanceof RuntimeWorkspacePayloadError) {
          throw new FailureHttpException(jobFailureFromUnknown(error));
        }
        throw error;
      }
    }

    if (options.revisionId) await assertRevisionConsent(this.prisma as unknown as Prisma.TransactionClient, options.revisionId, userId, projectId);
    let maxCharge: bigint;
    try {
      maxCharge = await this.estimateMaxCharge();
    } catch (error: unknown) {
      if (error instanceof NotFoundException && error.message.includes('生效费率')) {
        const failure = makeFailure({
          stage: 'jobs.submit',
          gate: 'billing_configuration',
          code: FAILURE_CODES.generationBillingUnavailable,
          severity: 'preflight',
          reason: '生成服务的计费配置尚未就绪，请联系管理员补全后再生成。',
          recoverable: false,
          userActionRequired: ['请联系管理员检查生成服务的生效费率与渠道配置'],
        });
        this.logger.error(`generation billing configuration unavailable: ${error.message}`);
        await this.recordServerErrorSafely({
          userId,
          projectId,
          chapterId,
          code: failure.code,
          stage: failure.stage,
          gate: failure.gate,
          severity: failure.severity,
          message: failure.reason,
          diagnostic: { cause: error.message, requiredModels: this.requiredBillingModels() },
        });
        throw new FailureHttpException(failure);
      }
      throw error;
    }
    if (options.maxChargeFen !== undefined) {
      if (!Number.isSafeInteger(options.maxChargeFen) || options.maxChargeFen <= 0) throw new BadRequestException('重写预算必须为正整数分');
      maxCharge = maxCharge < BigInt(options.maxChargeFen) ? maxCharge : BigInt(options.maxChargeFen);
    }
    const jobId = options.jobId ?? randomUUID();
    const execution: StoredExecution | undefined = env.NOVEL_RUNTIME_MODE === 'stub' ? undefined : {
      version: 1, deadlineAt: Date.now() + Math.min(options.timeoutMs ?? env.NOVEL_RUNTIME_REQUEST_TIMEOUT_MS, env.NOVEL_RUNTIME_REQUEST_TIMEOUT_MS),
      input: { userId, projectId, chapterId, jobId, revisionId: options.revisionId, maxCharge: maxCharge.toString(),
        chapterNumber: chapter.chapterNumber, chapterVersion: chapter.version, seedVersion: seed.version,
        continuationMode, continuationDraft: chapter.content, targetWordCount: options.targetWordCount, runtimeWorkspaceInput },
    };

    try {
      await this.prisma.novelGenerationJob.create({
        data: {
          jobId,
          userId,
          projectId,
          chapterId,
          jobType: 'chapter_generation',
          status: 'running',
          maxCharge,
          revisionId: options.revisionId,
          execution: execution ? JSON.parse(JSON.stringify(execution)) as Prisma.InputJsonValue : undefined,
          progressStage: 'checking_materials',
        },
      });
    } catch (error: unknown) {
      // The partial unique index is the authority for the race between the
      // friendly pre-check above and this insert.  No hold has been created
      // yet, so rejecting here cannot leave money reserved.
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictException('已有进行中的生成任务');
      }
      throw error;
    }

    try {
      await this.billing.createHold({ userId, jobId, amount: maxCharge });
    } catch (error: unknown) {
      const failure = jobFailureFromUnknown(error);
      try {
        await this.prisma.novelGenerationJob.update({
        where: { jobId },
        data: {
          status: error instanceof InsufficientBalanceException ? 'insufficient_balance' : 'failed',
          failureMessage: error instanceof InsufficientBalanceException
            ? '可用余额不足'
            : '计费预占失败',
          failure,
          completedAt: new Date(),
        },
        });
      } catch (updateError: unknown) {
        this.logger.error(
          `failed to persist billing hold failure ${jobId}: ${updateError instanceof Error ? updateError.message : String(updateError)}`,
        );
        await this.recordServerErrorSafely({
          userId,
          projectId,
          chapterId,
          jobId,
          code: 'billing_hold_failure_persist_failed',
          stage: 'jobs.billing_hold',
          gate: 'job_update',
          severity: 'fatal',
          message: updateError instanceof Error ? updateError.message : String(updateError),
          diagnostic: { originalFailure: failure },
        });
        throw updateError;
      }
      await this.recordServerErrorSafely({
        userId,
        projectId,
        chapterId,
        jobId,
        code: error instanceof InsufficientBalanceException ? 'insufficient_balance' : 'billing_hold_failed',
        stage: 'jobs.billing_hold',
        gate: 'billing_reservation',
        severity: error instanceof InsufficientBalanceException ? 'recoverable' : 'fatal',
        message: error instanceof Error ? error.message : String(error),
        diagnostic: { failure },
      });
      throw error;
    }

    if (env.NOVEL_RUNTIME_MODE === 'stub') {
      await this.runStubGeneration({
        userId,
        projectId,
        chapterId,
        jobId,
        chapterNumber: chapter.chapterNumber,
        chapterVersion: chapter.version,
        seedVersion: seed.version,
        intent: seed.intent,
        continuationMode,
        continuationDraft: chapter.content,
        targetWordCount: options.targetWordCount,
      });
    } else {
      await this.dispatchStoredJobs();
    }

    return this.getJob(userId, jobId);
  }

  /** A retry is bound to the failed chapter and its original continuation contract. */
  async retryGeneration(userId: number, jobId: string): Promise<unknown> {
    const job = await this.prisma.novelGenerationJob.findFirst({ where: { userId, jobId } });
    if (!job || !job.chapterId) throw new NotFoundException('任务不存在');
    if (!['failed', 'insufficient_balance'].includes(job.status)) throw new ConflictException('只能重试已结束的失败任务');
    if (job.revisionId) throw new ConflictException('请在顺序重写面板继续，以保留预算和章节进度');
    if ((job.failure as { recoverable?: boolean } | null)?.recoverable === false) throw new ConflictException(job.failureMessage ?? '请先修正资料');
    const stored = job.execution as unknown as StoredExecution | null;
    if (!stored?.input) throw new ConflictException('历史任务缺少重试契约，请在章节中明确选择续写或重写');
    return this.submitChapterGeneration(userId, job.projectId, job.chapterId, {
      continuationMode: stored.input.continuationMode,
      targetWordCount: stored.input.targetWordCount,
      expectedChapterVersion: stored.input.chapterVersion,
    });
  }

  /** 任务详情（归属校验）。 */
  async getJob(userId: number, jobId: string): Promise<unknown> {
    const job = await this.prisma.novelGenerationJob.findFirst({
      where: { jobId, userId },
    });
    if (!job) throw new NotFoundException('任务不存在');
    return {
      jobId: job.jobId,
      projectId: job.projectId,
      chapterId: job.chapterId,
      jobType: job.jobType,
      status: job.status,
      progressStage: job.progressStage,
      maxCharge: fenToString(job.maxCharge),
      settledAmount: fenToString(job.settledAmount),
      failureMessage: job.failureMessage,
      failure: readStoredFailure(job.failure, job.failureMessage),
      startedAt: job.startedAt.toISOString(),
      completedAt: job.completedAt?.toISOString() ?? null,
    };
  }

  /** 任务逐调用明细。 */
  async getCalls(userId: number, jobId: string): Promise<unknown[]> {
    await this.getJob(userId, jobId);
    const rows = await this.prisma.novelGenerationCall.findMany({
      where: { jobId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      callId: row.callId,
      internalStage: row.internalStage,
      model: row.model,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      actualCharge: fenToString(row.actualCharge),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** 内部进度回调：job 存在则更新，否则忽略（兼容仅 hold 的 Phase 2 路径）。 */
  async updateProgressIfExists(input: {
    jobId: string;
    status?: string;
    stage?: string;
  }): Promise<{ status: string; stage: string; accepted: boolean } | null> {
    const job = await this.prisma.novelGenerationJob.findUnique({
      where: { jobId: input.jobId },
    });
    if (!job) return null;
    // Runtime progress is advisory only.  Durable terminal transitions are
    // owned by the API's delivery/failure transactions; an asynchronous
    // callback must never resurrect, fail, or roll a job backwards.
    if (job.status !== 'pending' && job.status !== 'running') {
      return {
        status: job.status,
        stage: job.progressStage,
        accepted: false,
      };
    }
    // Jobs are created as running before the runtime can receive a task
    // token. A delayed "pending" report is therefore stale and must not
    // overwrite either the durable status or its newer progress stage.
    if (input.status === 'pending' && job.status === 'running') {
      return {
        status: job.status,
        stage: job.progressStage,
        accepted: false,
      };
    }
    // The initial read above is only for a useful response and the stale
    // `pending -> running` rule.  It cannot authorize a later unconditional
    // write: chapter delivery may commit `succeeded` between that read and
    // this callback.  Keep the terminal-state guard in the SQL predicate so a
    // late runtime progress report can never resurrect a completed job.
    const updated = await this.prisma.novelGenerationJob.updateMany({
      where: {
        jobId: input.jobId,
        status: { in: ['pending', 'running'] },
      },
      data: {
        ...(input.stage ? { progressStage: input.stage } : {}),
        ...(input.status === 'running' ? { status: 'running' } : {}),
      },
    });
    if (updated.count !== 1) {
      const current = await this.prisma.novelGenerationJob.findUnique({
        where: { jobId: input.jobId },
      });
      if (!current) return null;
      return {
        status: current.status,
        stage: current.progressStage,
        accepted: false,
      };
    }
    return {
      status: input.status === 'running' ? 'running' : job.status,
      stage: input.stage ?? job.progressStage,
      accepted: true,
    };
  }

  private async estimateMaxCharge(): Promise<bigint> {
    if (env.NOVEL_RUNTIME_MODE === 'stub') return STUB_RUNTIME_HOLD_FEN;
    const [snapshots, settings] = await Promise.all([
      Promise.all(
        this.requiredBillingModels().map((model) => this.rates.buildRateSnapshot(model)),
      ),
      this.prisma.setting.findMany({
        where: {
          key: { in: [SETTING_WORD_COUNT_BUDGET, SETTING_SAFETY_FACTOR] },
        },
      }),
    ]);
    const settingMap = new Map(settings.map((row) => [row.key, row.value]));
    const tokens = reservationTokensForBudget(
      parseWordCountBudget(settingMap.get(SETTING_WORD_COUNT_BUDGET)),
    );
    const factor = parseSafetyFactor(settingMap.get(SETTING_SAFETY_FACTOR) ?? DEFAULT_SAFETY_FACTOR);
    const inputPricePerMillion = snapshots.reduce(
      (highest, snapshot) => {
        const price = BigInt(snapshot.inputPricePerMillion);
        return price > highest ? price : highest;
      },
      0n,
    );
    const outputPricePerMillion = snapshots.reduce(
      (highest, snapshot) => {
        const price = BigInt(snapshot.outputPricePerMillion);
        return price > highest ? price : highest;
      },
      0n,
    );
    // 预占需覆盖「原价 × 倍率」后的最高可能结算额。
    const multiplierPercent = snapshots.reduce(
      (highest, snapshot) => {
        const value = snapshot.multiplierPercent ?? 100;
        return value > highest ? value : highest;
      },
      100,
    );
    const base = computeChargeFen({
      tokensIn: tokens.tokensIn,
      tokensOut: tokens.tokensOut,
      inputPricePerMillion,
      outputPricePerMillion,
      multiplierPercent,
    });
    return applySafetyFactor(base, factor);
  }

  private requiredBillingModels(): string[] {
    const configured = env.NOVEL_BILLING_REQUIRED_MODELS.split(',')
      .map((model) => model.trim())
      .filter(Boolean);
    if (configured.length > 0) return [...new Set(configured)];
    return env.NOVEL_RUNTIME_MODE === 'stub'
      ? [env.STUB_WRITER_MODEL]
      : [...PRODUCTION_BILLING_MODEL_ROUTES];
  }

  private async assertBillingModelsReady(): Promise<void> {
    await Promise.all(
      this.requiredBillingModels().map((model) => this.rates.buildRateSnapshot(model)),
    );
  }

  private async runStubGeneration(input: {
    userId: number;
    projectId: number;
    chapterId: number;
    jobId: string;
    chapterNumber: number;
    chapterVersion: number;
    seedVersion: number;
    intent: string;
    continuationMode?: ContinuationMode;
    continuationDraft: string;
    targetWordCount?: TargetWordRange;
    timeoutMs?: number;
  }): Promise<void> {
    try {
      await this.billing.updateJobProgress({
        jobId: input.jobId,
        status: 'running',
        stage: 'generating_text',
      });
      await this.updateProgressIfExists({
        jobId: input.jobId,
        stage: 'generating_text',
      });
      const text = `【stub】第${input.chapterNumber}章\n${input.intent}`;
      await this.persistGeneratedChapter(input, text, undefined, true);
    } catch (error: unknown) {
      this.logger.error(
        `stub generate failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.closeFailedGenerationIfHoldReleased(
        input.jobId,
        jobFailureFromUnknown(error),
      );
      throw error;
    }
  }

  private async runHttpGeneration(input: HttpGenerationInput): Promise<void> {
    try {
      const token = await signTaskToken({
        userId: input.userId,
        projectId: input.projectId,
        jobId: input.jobId,
        maxCharge: input.maxCharge,
      });
      const runtimeWorkspaceInput = input.runtimeWorkspaceInput ?? await this.buildRuntimeWorkspaceInput(input);
      const materialSnapshot: GenerationMaterialSnapshot = {
        request: {
          userId: input.userId,
          projectId: input.projectId,
          chapterId: input.chapterId,
          chapterNumber: input.chapterNumber,
          continuationMode: input.continuationMode,
          targetWordCount: input.targetWordCount,
        },
        fingerprint: fingerprintGenerationMaterials(runtimeWorkspaceInput),
      };
      const invokeInput = {
        chapterNumber: input.chapterNumber,
        chapterId: String(input.chapterId),
        workspaceId: `p${input.projectId}`,
        ...runtimeWorkspaceInput,
        // 已解析的续写模式（submitChapterGeneration 保证非空）；仅在缺失时
        // 保留 buildRuntimeWorkspaceInput 内嵌的值，避免 undefined 覆盖。
        ...(input.continuationMode
          ? {
              continuationMode: input.continuationMode,
              currentChapterDraft: input.continuationMode === 'append'
                ? input.continuationDraft
                : undefined,
            }
          : {}),
        ...(input.targetWordCount ? { targetWordCount: input.targetWordCount } : {}),
      };
      const invoked = input.durable
        ? await this.runtime.invoke(token, 'novel_generate_chapter', invokeInput, input.timeoutMs, true, () => signTaskToken(input))
        : input.timeoutMs === undefined
          ? await this.runtime.invoke(token, 'novel_generate_chapter', invokeInput)
          : await this.runtime.invoke(token, 'novel_generate_chapter', invokeInput, input.timeoutMs);
      const result = invoked.result;
      const modelCallCount = invoked.metering?.modelCallCount;
      const runtimeInputTokens = invoked.metering?.inputTokens;
      const runtimeOutputTokens = invoked.metering?.outputTokens;
      if (
        invoked.status !== 'ok' ||
        typeof modelCallCount !== 'number' ||
        !Number.isSafeInteger(modelCallCount) ||
        modelCallCount <= 0 ||
        !result ||
        typeof result !== 'object' ||
        (result as { status?: unknown }).status !== 'ok' ||
        typeof (result as { text?: unknown }).text !== 'string' ||
        (result as { text: string }).text.trim().length === 0
      ) {
        throw runtimeInvokeFailure(invoked.result, modelCallCount);
      }
      const text = (result as { text: string }).text;
      const manifest = ((result as { contextManifest?: unknown }).contextManifest
        ?? runtimeWorkspaceInput.contextManifest) as {
        actualInputTokens?: number;
        actualOutputTokens?: number;
        settledCostFen?: number;
      } | undefined;
      if (manifest) {
        if (typeof runtimeInputTokens === 'number') manifest.actualInputTokens = runtimeInputTokens;
        if (typeof runtimeOutputTokens === 'number') manifest.actualOutputTokens = runtimeOutputTokens;
        if (typeof invoked.metering?.totalSettledAmountFen === 'number') {
          manifest.settledCostFen = invoked.metering.totalSettledAmountFen;
        }
        await this.billing.updateJobProgress({
          jobId: input.jobId,
          status: 'running',
          stage: 'context_observed',
          detail: { contextManifest: manifest },
        });
      }
      await this.persistGeneratedChapter(
        {
          userId: input.userId,
          projectId: input.projectId,
          chapterId: input.chapterId,
          jobId: input.jobId,
          chapterVersion: input.chapterVersion,
          seedVersion: input.seedVersion,
          continuationMode: input.continuationMode,
          continuationDraft: input.continuationDraft,
          materialSnapshot,
          revisionId: input.revisionId,
        },
        text,
        (result as { runtimeState?: unknown }).runtimeState,
        true,
      );
    } catch (error: unknown) {
      this.logger.error(
        `http generate failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.closeFailedGenerationIfHoldReleased(
        input.jobId,
        jobFailureFromUnknown(error),
      );
      return;
    }
  }

  /**
   * 将 platform-api 的项目资料编译成 runtime workspace 物化输入。
   * runtime 不直接访问 platform 数据库。作者未确认的题材、风格、宪法和世界观
   * 不得用默认值填充；缺失时在预检阶段结构化阻断。
   */
  /**
   * A failed execution may only relinquish its active-job slot after billing
   * confirms the matching reservation is released. Otherwise a retryable
   * billing outage would turn into a hidden, permanently reserved balance.
   */
  private async closeFailedGenerationIfHoldReleased(
    jobId: string,
    failure: ReturnType<typeof jobFailureFromUnknown>,
  ): Promise<void> {
    await this.recordServerErrorSafely({
      jobId,
      code: failure.code,
      stage: failure.stage,
      gate: failure.gate,
      severity: failure.severity,
      message: failure.reason,
      diagnostic: { failure },
      archivePath: failure.traceArchivePath,
    });
    let settledAmount = 0n;
    try {
      const finalized = await this.billing.finalizeHold({ jobId, outcome: 'failure' });
      if (finalized.status !== 'released') {
        this.logger.error(
          `failed generation ${jobId} hold is ${finalized.status}; leaving job active for reconciliation`,
        );
        return;
      }
      settledAmount = finalized.settledAmount;
    } catch (error: unknown) {
      if (error instanceof NotFoundException) {
        this.logger.warn(
          `failed generation ${jobId} has no billing hold; closing as uncharged`,
        );
      } else {
        this.logger.error(
          `failed to release generation hold ${jobId}; leaving job active for recovery: ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.recordServerErrorSafely({
          jobId,
          code: failure.code,
          stage: failure.stage,
          gate: failure.gate,
          severity: failure.severity,
          message: error instanceof Error ? error.message : String(error),
          diagnostic: { failure, operation: 'finalize_failed_generation_hold' },
        });
        return;
      }
    }

    try {
      await this.prisma.novelGenerationJob.update({
        where: { jobId },
        data: {
          status: 'failed',
          failureMessage: failure.reason,
          failure,
          settledAmount,
          completedAt: new Date(),
        },
      });
    } catch (error: unknown) {
      this.logger.error(
        `released hold for failed generation ${jobId}, but could not close job: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.recordServerErrorSafely({
        jobId,
        code: failure.code,
        stage: failure.stage,
        gate: failure.gate,
        severity: 'fatal',
        message: error instanceof Error ? error.message : String(error),
        diagnostic: { failure, operation: 'persist_failed_generation' },
      });
    }
  }

  private async recordServerErrorSafely(input: Parameters<ErrorReportsService['recordServerError']>[0]): Promise<void> {
    if (!this.errorReports) return;
    try {
      await this.errorReports.recordServerError(input);
    } catch (error: unknown) {
      this.logger.error(
        `error report capture failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Compile platform-owned project materials into the isolated runtime
   * workspace input. Missing author genre/style/world/constitution must
   * block; the runtime never receives invented defaults.
   */
  private async buildRuntimeWorkspaceInput(
    input: RuntimeWorkspaceRequest,
    database: GenerationContextDb = this.prisma,
  ): Promise<Record<string, unknown>> {
    const [project, characters, documents, previousChapter, currentChapter] = await Promise.all([
      database.novelProject.findFirst({
        where: { id: input.projectId, userId: input.userId, deletedAt: null },
        select: { genre: true, subGenres: true, worldKeyTerms: true },
      }),
      database.novelCharacter.findMany({
        where: { projectId: input.projectId, userId: input.userId, deletedAt: null },
        orderBy: { sortOrder: 'asc' },
      }),
      database.novelDocument.findMany({
        where: { projectId: input.projectId, userId: input.userId, deletedAt: null },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      }),
      input.chapterNumber > 1
        ? database.novelChapter.findFirst({
            where: {
              projectId: input.projectId,
              userId: input.userId,
              chapterNumber: input.chapterNumber - 1,
              deletedAt: null,
            },
            select: { content: true, chapterNumber: true },
          })
        : Promise.resolve(null),
      database.novelChapter.findFirst({
        where: {
          id: input.chapterId,
          projectId: input.projectId,
          userId: input.userId,
          deletedAt: null,
        },
        select: { content: true, version: true, chapterNumber: true },
      }),
    ]);

    // Only chapters before the target are accepted history for this run.
    // Keep this optional for lightweight unit-test doubles; Prisma always has
    // findMany in the live API.
    const chapterDelegate = database.novelChapter as unknown as {
      findMany?: (args: unknown) => Promise<unknown>;
    };
    const chapterCatalog = typeof chapterDelegate.findMany === 'function'
      ? await chapterDelegate.findMany({
          where: {
            projectId: input.projectId,
            userId: input.userId,
            deletedAt: null,
            chapterNumber: { lt: input.chapterNumber },
          },
          include: { seed: true },
          orderBy: { chapterNumber: 'asc' },
        }) as Array<{
          chapterNumber: number;
          title?: string | null;
          status?: string | null;
          wordCount?: number | null;
          content: string;
          seed?: {
            intent?: string;
            promises?: string;
            endingGoal?: string;
          } | null;
        }>
      : [];
    // Enforce the boundary in memory as well as SQL, before either renderer
    // or the shared context compiler can expose old target/future text.
    const historicalChapters = chapterCatalog.filter((chapter) => chapter.chapterNumber < input.chapterNumber);

    if (input.chapterNumber > 1 && !previousChapter) {
      throw new ContextCompileError(makeFailure({
        stage: 'runtime.preflight',
        gate: 'previous_chapter_boundary',
        code: FAILURE_CODES.runtimePreflightFailed,
        severity: 'preflight',
        reason: `无法生成第${input.chapterNumber}章：严格前章第${input.chapterNumber - 1}章不存在，已阻止使用其他章节或旧骨架替代`,
        evidence: { requestedPreviousChapter: input.chapterNumber - 1 },
        recoverable: false,
        userActionRequired: [`先保存或恢复第${input.chapterNumber - 1}章正文后再试`],
        fixInstructions: ['检查章节编号是否连续', `确认第${input.chapterNumber - 1}章未被删除或软删除`],
      }));
    }

    if (!project || characters.length === 0) {
      throw new Error('runtime workspace context is incomplete');
    }

    const byType = new Map(documents.map((document) => [document.documentType, document]));
    const stateDocument = byType.get('narrative_state');
    const narrativeState = await new GenerationHistoryResolver().resolve({
      chapterNumber: input.chapterNumber,
      mode: input.continuationMode ?? (currentChapter?.content?.trim() ? 'append' : 'replace'),
      workspaceId: `p${input.projectId}`,
      state: stateDocument,
      previousChapter: previousChapter ?? undefined,
      historicalChapters,
      loadVersions: async (beforeVersion) => stateDocument
        ? database.novelDocumentVersion.findMany({
            where: { documentId: stateDocument.id, versionNumber: { lt: beforeVersion } },
            select: { content: true, versionNumber: true },
            orderBy: { versionNumber: 'desc' }, take: 50,
          }) : [],
    });

    const characterContent = characters
      .map((character) => {
        const aliases = readStringArray(character.aliases);
        return [
          `# ${character.name}`,
          `- 身份：${character.identity}`,
          `- 角色：${character.roleType}`,
          aliases.length > 0 ? `- 别名：${aliases.join('、')}` : '',
          character.goals ? `- 目标：${character.goals}` : '',
          character.motivation ? `- 动机：${character.motivation}` : '',
          character.personality ? `- 性格：${character.personality}` : '',
          character.abilities ? `- 能力：${character.abilities}` : '',
          character.relationships ? `- 关系：${character.relationships}` : '',
          character.secrets ? `- 秘密：${character.secrets}` : '',
          character.characterArc ? `- 人物弧：${character.characterArc}` : '',
          character.currentState ? `- 当前状态：${character.currentState}` : '',
          character.notes ? `- 备注：${character.notes}` : '',
        ].filter(Boolean).join('\n');
      })
      .join('\n\n');

    const seed = await database.novelChapterSeed.findUnique({
      where: { chapterId: input.chapterId },
      select: {
        intent: true,
        mustInclude: true,
        forbiddenFacts: true,
        characterMotives: true,
        promises: true,
        endingGoal: true,
      },
    });
    if (!seed) throw new Error('runtime workspace chapter seed is missing');

    const compiled = compileProjectContext({
      storyOutline: byType.get('story_outline'),
      chapterSeed: { ...seed, chapterNumber: input.chapterNumber },
      characters,
      narrativeState,
      previousChapter: previousChapter ?? undefined,
      chapterCatalog: historicalChapters.map((row) => ({
        chapterNumber: row.chapterNumber,
        title: row.title,
        status: row.status,
        wordCount: row.wordCount,
        content: row.content,
        seed: row.seed,
      })),
      styleProfile: byType.get('style_profile'),
      worldbuilding: byType.get('worldbuilding'),
      constitution: byType.get('creative_constitution'),
      contextProfile: env.PINOVEL_CONTEXT_PROFILE,
      historicalQueries: [
        seed.intent,
        seed.promises,
        seed.characterMotives,
      ].filter((value): value is string => Boolean(value?.trim())),
    });

    assertAuthorContractForGeneration(listAuthorContractGaps({
      genre: project.genre,
      constitution: byType.get('creative_constitution')?.content,
      worldbuilding: byType.get('worldbuilding')?.content,
      styleProfile: byType.get('style_profile')?.content,
      characters,
      compact: compiled.compact,
      usableStoryOutline: compiled.usableStoryOutline,
    }));

    const explicitOutline = buildExplicitOutlineMarkdown({
      intent: seed.intent,
      mustInclude: seed.mustInclude,
      forbiddenFacts: seed.forbiddenFacts,
      characterMotives: seed.characterMotives,
      promises: seed.promises,
      endingGoal: seed.endingGoal,
      characterNames: characters.map((character) => character.name),
      openPromises: compiled.compact.promise.map((item) => item.description),
    });

    const workspaceDocuments: Array<{ type: string; content: string }> = [
      { type: 'character_profile', content: characterContent },
      { type: 'explicit_outline', content: explicitOutline },
    ];
    const constitution = byType.get('creative_constitution')?.content?.trim();
    const worldbuilding = byType.get('worldbuilding')?.content?.trim();
    const styleProfile = byType.get('style_profile')?.content?.trim();
    if (constitution) {
      workspaceDocuments.push({ type: 'creative_constitution', content: constitution });
    }
    if (worldbuilding) {
      workspaceDocuments.push({ type: 'worldbuilding', content: worldbuilding });
    }
    if (compiled.usableStoryOutline) {
      const catalog = renderChapterCatalog(historicalChapters, input.chapterNumber);
      workspaceDocuments.push({
        type: 'story_outline',
        content: catalog
          ? `${compiled.usableStoryOutline}\n\n## 全书阶段规划与历史章节目录\n${catalog}`
          : compiled.usableStoryOutline,
      });
      // The runtime's own ContextCompiler reads the materialized outline. Add
      // the selected long-context layers there so the API-side manifest and
      // the actual generation prompt describe the same evidence.
      const runtimeContextLayers = [
        compiled.recentChapterContent
          ? `## 最近章节正文（仅用于承接）\n${compiled.recentChapterContent}`
          : '',
        compiled.historicalEvidenceText
          ? `## 历史检索片段（按本章目标排序）\n${compiled.historicalEvidenceText}`
          : '',
      ].filter(Boolean).join('\n\n');
      if (runtimeContextLayers) {
        const outlineDocument = workspaceDocuments.find((document) => document.type === 'story_outline');
        if (outlineDocument) outlineDocument.content = `${outlineDocument.content}\n\n${runtimeContextLayers}`;
        const explicitDocument = workspaceDocuments.find((document) => document.type === 'explicit_outline');
        if (explicitDocument) explicitDocument.content = `${explicitDocument.content}\n\n${runtimeContextLayers}`;
      }
      // FactGuard 的术语授权只能依据它能读到的材料判定，裁剪后的提示词副本会让大纲
      // 尾部已有术语被误判为未授权新设定。这里额外物化一份全文，专供授权使用。
      if (compiled.fullStoryOutline && compiled.fullStoryOutline !== compiled.usableStoryOutline) {
        workspaceDocuments.push({
          type: 'story_outline_full',
          content: compiled.fullStoryOutline,
        });
      }
    }
    if (compiled.compactNarrativeJson) {
      workspaceDocuments.push({ type: 'narrative_state', content: compiled.compactNarrativeJson });
    }
    if (styleProfile) {
      workspaceDocuments.push({ type: 'style_profile', content: styleProfile });
    }

    // 兜底口径与 submitChapterGeneration 一致：未显式指定时，已有正文的章节
    // 默认 append（扩写）而不是把既有正文当成全新章节重写。
    const hasExistingDraft = Boolean(currentChapter?.content?.trim());
    const continuationMode: ContinuationMode = input.continuationMode
      ?? (hasExistingDraft ? 'append' : 'replace');
    const runtimeInput = {
      projectConfig: {
        genre: resolveProjectGenre(project.genre),
        subGenres: readStringArray(project.subGenres),
        worldKeyTerms: readStringArray(project.worldKeyTerms),
        characters: characters.map((character) => ({
          name: character.name,
          role: character.roleType,
          description: character.identity,
        })),
      },
      workspaceDocuments,
      previousChapterContinuation: compiled.previousChapterContinuation,
      previousChapterNumber: previousChapter?.chapterNumber,
      continuationMode,
      currentChapterDraft: continuationMode === 'append'
        ? currentChapter?.content ?? ''
        : undefined,
      ...(input.targetWordCount ? { targetWordCount: input.targetWordCount } : {}),
      contextManifest: {
        ...compiled.manifest,
        // A restored past state must not hide concurrent edits to today's
        // state. Keep the source identity in the commit fingerprint, while
        // token observations remain excluded from equality checks.
        materialSourceHash: createHash('sha256').update(JSON.stringify({
          stateId: stateDocument?.id, stateVersion: stateDocument?.currentVersion,
          stateContent: stateDocument?.content,
        })).digest('hex'),
      },
    };
    assertNoFullPreviousChapter(runtimeInput, previousChapter?.content);
    return runtimeInput;
  }

  private async persistGeneratedChapter(
    input: {
      userId: number;
      projectId: number;
      chapterId: number;
      jobId: string;
      chapterVersion: number;
      seedVersion: number;
      continuationMode?: ContinuationMode;
      continuationDraft?: string;
      materialSnapshot?: GenerationMaterialSnapshot;
      revisionId?: string;
    },
    text: string,
    runtimeState?: unknown,
    finalizeJob = false,
  ): Promise<void> {
    const finalText = input.continuationMode === 'append'
      ? mergeChapterContinuation(input.continuationDraft ?? '', text)
      : text;
    await this.prisma.$transaction(async (tx) => {
      if (input.revisionId) await assertRevisionConsent(tx as unknown as Prisma.TransactionClient, input.revisionId, input.userId, input.projectId);
      if (input.materialSnapshot) {
        let currentFingerprint: string | undefined;
        try {
          currentFingerprint = fingerprintGenerationMaterials(
            await this.buildRuntimeWorkspaceInput(input.materialSnapshot.request, tx),
          );
        } catch (error: unknown) {
          // Removing required author materials also invalidates the in-flight
          // result. Database/transport errors retain their own failure cause.
          if (!(error instanceof ContextCompileError) &&
            !(error instanceof Error && /^runtime workspace (context is incomplete|chapter seed is missing)$/.test(error.message))) {
            throw error;
          }
        }
        if (currentFingerprint !== input.materialSnapshot.fingerprint) {
          throw new JobFailureError(makeFailure({
            stage: 'runtime.commit',
            gate: 'material_snapshot',
            code: FAILURE_CODES.generationMaterialsChanged,
            severity: 'preflight',
            reason: '生成期间创作资料已修改，本次结果未覆盖正文。请确认最新资料和重写范围后重新生成。',
            recoverable: false,
            userActionRequired: ['确认最新创作资料及受影响章节后重新生成'],
          }));
        }
      }
      const write = await tx.novelChapter.updateMany({
        where: {
          id: input.chapterId,
          projectId: input.projectId,
          userId: input.userId,
          deletedAt: null,
          version: input.chapterVersion,
        },
        data: {
          content: finalText,
          wordCount: countWords(finalText),
          status: 'generated',
          version: { increment: 1 },
          generationJobId: input.jobId,
        },
      });
      if (write.count !== 1) {
        throw new Error('chapter changed while generation was running');
      }
      const saved = await tx.novelChapter.findUniqueOrThrow({
        where: { id: input.chapterId },
      });
      await tx.novelChapterVersion.create({
        data: {
          chapterId: input.chapterId,
          projectId: input.projectId,
          userId: input.userId,
          versionNumber: saved.version,
          title: saved.title,
          content: saved.content,
          wordCount: saved.wordCount,
          source: 'ai_generated',
          generationJobId: input.jobId,
          createdBy: input.userId,
        },
      });
      const seedWrite = await tx.novelChapterSeed.updateMany({
        where: {
          chapterId: input.chapterId,
          projectId: input.projectId,
          userId: input.userId,
          version: input.seedVersion,
        },
        data: { status: 'consumed' },
      });
      if (seedWrite.count !== 1) {
        throw new Error('chapter seed changed while generation was running');
      }
      const projectWrite = await tx.novelProject.updateMany({
        where: {
          id: input.projectId,
          userId: input.userId,
          deletedAt: null,
        },
        data: { workflowState: 'generated', lastActiveAt: new Date() },
      });
      if (projectWrite.count !== 1) {
        throw new Error('project deleted while generation was running');
      }

      const serializedState = serializeRuntimeState(runtimeState);
      if (serializedState) {
        const stateDocument = await tx.novelDocument.findFirst({
          where: {
            projectId: input.projectId,
            userId: input.userId,
            documentType: 'narrative_state',
            deletedAt: null,
          },
          orderBy: { id: 'asc' },
        });
        if (stateDocument) {
          const nextVersion = stateDocument.currentVersion + 1;
          const stateWrite = await tx.novelDocument.updateMany({
            where: {
              id: stateDocument.id,
              projectId: input.projectId,
              userId: input.userId,
              deletedAt: null,
              currentVersion: stateDocument.currentVersion,
            },
            data: { content: serializedState, currentVersion: nextVersion },
          });
          if (stateWrite.count !== 1) {
            throw new Error('narrative state changed while generation was running');
          }
          const savedState = await tx.novelDocument.findUniqueOrThrow({
            where: { id: stateDocument.id },
          });
          await tx.novelDocumentVersion.create({
            data: {
              documentId: stateDocument.id,
              createdBy: input.userId,
              versionNumber: nextVersion,
              content: savedState.content,
              changeSummary: `章节 ${input.chapterId} 生成后更新叙事状态`,
            },
          });
        } else {
          const createdState = await tx.novelDocument.create({
            data: {
              projectId: input.projectId,
              userId: input.userId,
              documentType: 'narrative_state',
              title: '系统叙事状态',
              content: serializedState,
              currentVersion: 1,
            },
          });
          await tx.novelDocumentVersion.create({
            data: {
              documentId: createdState.id,
              createdBy: input.userId,
              versionNumber: 1,
              content: serializedState,
              changeSummary: `章节 ${input.chapterId} 生成后创建叙事状态`,
            },
          });
        }
      }

      if (finalizeJob) {
        const finalized = await this.billing.finalizeHoldInTransaction(
          tx as never,
          {
          jobId: input.jobId,
          outcome: 'success',
          },
        );
        if (finalized.status !== 'settled') {
          throw new Error(`billing hold did not settle successfully: ${finalized.status}`);
        }
        await tx.novelGenerationJob.update({
          where: { jobId: input.jobId },
          data: {
            status: 'succeeded',
            progressStage: 'saving_chapter',
            settledAmount: finalized.settledAmount,
            completedAt: new Date(),
          },
        });
      }
    }, { isolationLevel: 'Serializable' });
  }
}

function serializeRuntimeState(value: unknown): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('runtime state is invalid: expected a JSON object');
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('runtime state is invalid: value is not serializable');
  }
  if (!serialized || serialized.length > 5_000_000) {
    throw new Error('runtime state is invalid: serialized state exceeds the size limit');
  }
  return serialized;
}
