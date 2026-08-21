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
  buildExplicitOutlineMarkdown,
  DEFAULT_CREATIVE_CONSTITUTION,
  DEFAULT_STYLE_PROFILE,
  DEFAULT_WORLDBUILDING,
  describeGenerationFailure,
  resolveProjectGenre,
} from './runtime-workspace-defaults';

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function describeRuntimeChapterFailure(result: unknown, modelCallCount: number | undefined): string {
  if (result && typeof result === 'object') {
    const value = result as {
      failureEnvelope?: { reason?: unknown };
      reason?: unknown;
    };
    const envelope = value.failureEnvelope?.reason;
    if (typeof envelope === 'string' && envelope.trim()) {
      return envelope.trim().slice(0, 1000);
    }
    if (typeof value.reason === 'string' && value.reason.trim()) {
      return value.reason.trim().slice(0, 1000);
    }
  }
  if (modelCallCount === 0) {
    return '章节生成未调用模型，未产出可交付正文';
  }
  return 'runtime returned a non-deliverable chapter result';
}

/** Prisma's unique-constraint code is deliberately checked structurally here so
 * the service can translate the database concurrency guard into the public API
 * conflict contract without exposing ORM details. */
function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && (error as { code?: unknown }).code === 'P2002';
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
            failureMessage: 'generation interrupted by service restart',
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
      runtimeWorkspaceInput = await this.buildRuntimeWorkspaceInput({
        userId,
        projectId,
        chapterId,
        chapterNumber: chapter.chapterNumber,
      });
      try {
        assertRuntimeWorkspacePayloadFits({
          chapterNumber: chapter.chapterNumber,
          chapterId: String(chapterId),
          workspaceId: `p${projectId}`,
          ...runtimeWorkspaceInput,
        });
      } catch (error: unknown) {
        if (error instanceof RuntimeWorkspacePayloadError) {
          throw new BadRequestException(error.message);
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
            : 'billing hold creation failed',
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
      await this.billing.settleCall({
        jobId: input.jobId,
        callId: `stub-${input.jobId}`,
        internalStage: 'agentic_raw',
        model: env.STUB_WRITER_MODEL,
        tokensIn: 100_000,
        tokensOut: 50_000,
      });
      const text = `【stub】第${input.chapterNumber}章\n${input.intent}`;
      await this.persistGeneratedChapter(input, text, undefined, true);
    } catch (error: unknown) {
      this.logger.error(
        `stub generate failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.closeFailedGenerationIfHoldReleased(
        input.jobId,
        describeGenerationFailure(error),
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
        throw new Error(describeRuntimeChapterFailure(invoked.result, modelCallCount));
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
        describeGenerationFailure(error),
      );
      return;
    }
  }

  /**
   * 将 platform-api 的项目资料编译成 runtime workspace 物化输入。
   * runtime 不直接访问 platform 数据库；省略这些资料会让正式 Preflight
   * 只能看到默认 genre/空角色，从而把每个 HTTP 生成稳定地阻断。
   */
  /**
   * A failed execution may only relinquish its active-job slot after billing
   * confirms the matching reservation is released. Otherwise a retryable
   * billing outage would turn into a hidden, permanently reserved balance.
   */
  private async closeFailedGenerationIfHoldReleased(
    jobId: string,
    failureMessage: string,
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
          failureMessage,
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
   * workspace input. The runtime never receives direct database access.
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

    const allowedDocumentTypes = new Set([
      'creative_constitution',
      'worldbuilding',
      'story_outline',
      'style_profile',
      'narrative_state',
    ]);
    const grouped = new Map<string, string[]>();
    const rawDocuments = new Map<string, string>();
    for (const document of documents) {
      if (!allowedDocumentTypes.has(document.documentType)) continue;
      if (document.documentType === 'style_profile' || document.documentType === 'narrative_state') {
        // 这两类文档可能是 JSON；必须保留原文，不能加 Markdown 标题或拼接多个 JSON。
        rawDocuments.set(document.documentType, document.content);
        continue;
      }
      const values = grouped.get(document.documentType) ?? [];
      values.push(`# ${document.title}\n\n${document.content}`.trim());
      grouped.set(document.documentType, values);
    }

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

    const explicitOutline = buildExplicitOutlineMarkdown({
      intent: seed.intent,
      mustInclude: seed.mustInclude,
      forbiddenFacts: seed.forbiddenFacts,
      characterMotives: seed.characterMotives,
      promises: seed.promises,
      endingGoal: seed.endingGoal,
      characterNames: characters.map((character) => character.name),
    });

    const workspaceDocuments: Array<{ type: string; content: string }> = [
      { type: 'character_profile', content: characterContent },
      { type: 'explicit_outline', content: explicitOutline },
    ];
    for (const [type, values] of grouped) {
      workspaceDocuments.push({ type, content: values.join('\n\n') });
    }
    if (!grouped.has('creative_constitution')) {
      workspaceDocuments.push({ type: 'creative_constitution', content: DEFAULT_CREATIVE_CONSTITUTION });
    }
    if (!grouped.has('worldbuilding')) {
      workspaceDocuments.push({ type: 'worldbuilding', content: DEFAULT_WORLDBUILDING });
    }
    for (const type of ['style_profile', 'narrative_state']) {
      const content = rawDocuments.get(type);
      if (content !== undefined) workspaceDocuments.push({ type, content });
    }
    if (!rawDocuments.has('style_profile')) {
      workspaceDocuments.push({
        type: 'style_profile',
        content: JSON.stringify(DEFAULT_STYLE_PROFILE),
      });
    }

    return {
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
      previousChapterText: previousChapter?.content || undefined,
      previousChapterNumber: previousChapter?.chapterNumber,
    };
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
