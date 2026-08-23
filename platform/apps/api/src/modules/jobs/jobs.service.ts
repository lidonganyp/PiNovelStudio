/**
 * 生成任务：预检 + 预占 + 令牌签发 + http 调度（本地开发可 stub）+ 轮询。
 */
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { countWords, requireOwnedProject } from '../../common/ownership';
import { env } from '../../config/env';
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
import { ContextCompileError, FailureHttpException } from '../context/failure-envelope';
import {
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

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
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

// Reserve against a full multi-stage chapter run, not a single small model
// call. Actual billing still settles token usage call-by-call; this ceiling
// only prevents an otherwise valid run from exhausting its hold too early.
// These are a full-run reservation envelope, not a per-call estimate. The
// current production pipeline always has an Agentic draft plus whole-chapter
// editorial pass; reserving the higher configured route price across this
// envelope prevents a successful delivery from discovering too late that its
// hold was sized for only one small or stub call.


@Injectable()
export class JobsService implements OnModuleInit {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly rates: RatesService,
    private readonly runtime: RuntimeClient,
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
          throw error;
        }
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
        throw error;
      }
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
  ): Promise<unknown> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const chapter = await this.prisma.novelChapter.findFirst({
      where: { id: chapterId, projectId, userId, deletedAt: null },
      include: { seed: true },
    });
    if (!chapter) {
      throw new NotFoundException('章节不存在');
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

    const maxCharge = await this.estimateMaxCharge();
    const jobId = randomUUID();

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
      await this.prisma.novelGenerationJob.update({
        where: { jobId },
        data: {
          status: error instanceof InsufficientBalanceException ? 'insufficient_balance' : 'failed',
          failureMessage: error instanceof InsufficientBalanceException
            ? '可用余额不足'
            : '计费预占失败',
          failure: jobFailureFromUnknown(error),
          completedAt: new Date(),
        },
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
      });
    } else {
      void this.runHttpGeneration({
        userId,
        projectId,
        chapterId,
        jobId,
        maxCharge,
        chapterNumber: chapter.chapterNumber,
        chapterVersion: chapter.version,
        seedVersion: seed.version,
        runtimeWorkspaceInput,
      });
    }

    return this.getJob(userId, jobId);
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
    return configured.length > 0 ? [...new Set(configured)] : [env.STUB_WRITER_MODEL];
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

  private async runHttpGeneration(input: {
    userId: number;
    projectId: number;
    chapterId: number;
    jobId: string;
    maxCharge: bigint;
    chapterNumber: number;
    chapterVersion: number;
    seedVersion: number;
    runtimeWorkspaceInput?: Record<string, unknown>;
  }): Promise<void> {
    try {
      const token = await signTaskToken({
        userId: input.userId,
        projectId: input.projectId,
        jobId: input.jobId,
        maxCharge: input.maxCharge,
      });
      const invoked = await this.runtime.invoke(token, 'novel_generate_chapter', {
        chapterNumber: input.chapterNumber,
        chapterId: String(input.chapterId),
        workspaceId: `p${input.projectId}`,
        ...(input.runtimeWorkspaceInput ?? (await this.buildRuntimeWorkspaceInput(input))),
      });
      const result = invoked.result;
      const modelCallCount = invoked.metering?.modelCallCount;
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
      await this.persistGeneratedChapter(
        {
          userId: input.userId,
          projectId: input.projectId,
          chapterId: input.chapterId,
          jobId: input.jobId,
          chapterVersion: input.chapterVersion,
          seedVersion: input.seedVersion,
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
    }
  }

  /**
   * Compile platform-owned project materials into the isolated runtime
   * workspace input. Missing author genre/style/world/constitution must
   * block; the runtime never receives invented defaults.
   */
  private async buildRuntimeWorkspaceInput(input: {
    userId: number;
    projectId: number;
    chapterId: number;
    chapterNumber: number;
  }): Promise<Record<string, unknown>> {
    const [project, characters, documents, previousChapter] = await Promise.all([
      this.prisma.novelProject.findFirst({
        where: { id: input.projectId, userId: input.userId, deletedAt: null },
        select: { genre: true, subGenres: true, worldKeyTerms: true },
      }),
      this.prisma.novelCharacter.findMany({
        where: { projectId: input.projectId, userId: input.userId, deletedAt: null },
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.novelDocument.findMany({
        where: { projectId: input.projectId, userId: input.userId, deletedAt: null },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      }),
      input.chapterNumber > 1
        ? this.prisma.novelChapter.findFirst({
            where: {
              projectId: input.projectId,
              userId: input.userId,
              chapterNumber: input.chapterNumber - 1,
              deletedAt: null,
            },
            select: { content: true, chapterNumber: true },
          })
        : Promise.resolve(null),
    ]);

    if (!project || characters.length === 0) {
      throw new Error('runtime workspace context is incomplete');
    }

    const byType = new Map(documents.map((document) => [document.documentType, document]));

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

    const seed = await this.prisma.novelChapterSeed.findUnique({
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
      narrativeState: byType.get('narrative_state'),
      previousChapter: previousChapter ?? undefined,
      styleProfile: byType.get('style_profile'),
      worldbuilding: byType.get('worldbuilding'),
      constitution: byType.get('creative_constitution'),
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
      workspaceDocuments.push({ type: 'story_outline', content: compiled.usableStoryOutline });
    }
    if (compiled.compactNarrativeJson) {
      workspaceDocuments.push({ type: 'narrative_state', content: compiled.compactNarrativeJson });
    }
    if (styleProfile) {
      workspaceDocuments.push({ type: 'style_profile', content: styleProfile });
    }

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
      contextManifest: compiled.manifest,
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
    },
    text: string,
    runtimeState?: unknown,
    finalizeJob = false,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const write = await tx.novelChapter.updateMany({
        where: {
          id: input.chapterId,
          projectId: input.projectId,
          userId: input.userId,
          deletedAt: null,
          version: input.chapterVersion,
        },
        data: {
          content: text,
          wordCount: countWords(text),
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
    });
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
