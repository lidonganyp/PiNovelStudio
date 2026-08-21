/**
 * 助手对话：消息存储 + stub/http 规划回复 + 预占/结算。
 */
import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { decryptSecret } from '../../common/crypto/aes-gcm';
import { PrismaService } from '../../prisma/prisma.service';
import { requireOwnedProject } from '../../common/ownership';
import { env } from '../../config/env';
import { BillingService } from '../billing/billing.service';
import { fenToString } from '../billing/money';
import { InsufficientBalanceException } from '../billing/billing.errors';
import { JobsService } from '../jobs/jobs.service';
import { RatesService } from '../rates/rates.service';
import { applyAssistantArtifacts } from './assistant-artifacts';
import { buildAssistantSystemPrompt } from './assistant-prompt';
import {
  completePlannerChat,
  plannerUserFacingError,
  type PlannerChatMessage,
} from './planner-client';

export class PostAssistantMessageDto {
  @IsString()
  @MinLength(1)
  content!: string;
}

function isMissingEffectiveRateError(error: unknown): boolean {
  return (
    error instanceof NotFoundException &&
    typeof error.message === 'string' &&
    error.message.includes('生效费率')
  );
}

/** 规划上下文：最多携带最近 10 条历史，单条超长时截断。 */
const MAX_HISTORY_MESSAGE_CHARS = 4000;

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly rates: RatesService,
    private readonly jobs: JobsService,
  ) {}

  async list(userId: number, projectId: number): Promise<unknown[]> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const rows = await this.prisma.novelAssistantMessage.findMany({
      where: { projectId, userId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toView(row));
  }

  /** 新建对话：软删除当前项目全部消息，规划上下文从零开始。 */
  async clear(userId: number, projectId: number): Promise<{ cleared: number }> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const result = await this.prisma.novelAssistantMessage.updateMany({
      where: { projectId, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return { cleared: result.count };
  }

  /** 软删除单条消息。 */
  async remove(
    userId: number,
    projectId: number,
    messageId: number,
  ): Promise<{ ok: true }> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const result = await this.prisma.novelAssistantMessage.updateMany({
      where: { id: messageId, projectId, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count !== 1) {
      throw new NotFoundException('消息不存在');
    }
    return { ok: true };
  }

  /** 发送用户消息：规划模型回复，并将大纲/角色/章节种子落入项目板块。 */
  async post(
    userId: number,
    projectId: number,
    content: string,
    onDelta?: (delta: string) => void,
  ): Promise<{
    userMessage: Record<string, unknown>;
    assistantMessage: Record<string, unknown>;
    chunks: string[];
    generationJobId?: string;
    artifacts?: {
      outlineSaved: boolean;
      charactersSaved: number;
      chaptersTouched: number[];
      generationJobId?: string;
      focusTab?: 'outline' | 'characters' | 'chapter' | 'seed';
    };
  }> {
    if (env.PLANNER_MODE === 'disabled') {
      throw new ServiceUnavailableException('助手规划能力尚未在此环境启用');
    }
    await requireOwnedProject(this.prisma, userId, projectId);
    const jobId = randomUUID();
    const maxCharge = 50n;
    await this.prisma.novelGenerationJob.create({
      data: {
        jobId,
        userId,
        projectId,
        jobType: 'assistant_run',
        status: 'running',
        maxCharge,
        progressStage: 'generating_text',
      },
    });
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

    let userMessage: {
      id: number;
      role: string;
      content: string;
      jobId: string;
      createdAt: Date;
    };
    try {
      userMessage = await this.prisma.novelAssistantMessage.create({
        data: {
          projectId,
          userId,
          jobId,
          role: 'user',
          content,
        },
      });
    } catch (error: unknown) {
      this.logger.error(
        `assistant user message persistence failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.closeFailedAssistantJob(jobId);
      throw error;
    }

    let reply: string;
    let tokensIn = Math.max(1, content.length);
    let tokensOut = 1;
    let metadata: Record<string, unknown> = {};
    let generationJobId: string | undefined;
    let artifacts: {
      outlineSaved: boolean;
      charactersSaved: number;
      chaptersTouched: number[];
      generationJobId?: string;
      focusTab?: 'outline' | 'characters' | 'chapter' | 'seed';
    } | undefined;
    try {
      if (env.PLANNER_MODE === 'http') {
        const endpoint = await this.resolvePlannerEndpoint();
        const planned = await completePlannerChat({
          baseUrl: endpoint.baseUrl,
          apiKey: endpoint.apiKey,
          model: endpoint.model,
          messages: await this.buildPlannerMessages(userId, projectId, content),
          timeoutMs: env.PLANNER_REQUEST_TIMEOUT_MS,
          onDelta,
        });
        const applied = await applyAssistantArtifacts({
          prisma: this.prisma,
          jobs: this.jobs,
          userId,
          projectId,
          content: planned.text,
          userContent: content,
        });
        reply = applied.content;
        metadata = applied.metadata;
        generationJobId = applied.generationJobId;
        artifacts = applied.artifacts;
        tokensIn = planned.tokensIn;
        tokensOut = planned.tokensOut;
      } else {
        reply = `这是规划回复：${content.slice(0, 40)}`;
        tokensOut = Math.max(1, reply.length);
      }
    } catch (error: unknown) {
      this.logger.error(
        `planner completion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.closeFailedAssistantJob(jobId);
      throw new ServiceUnavailableException(
        error instanceof ServiceUnavailableException
          ? error.message
          : plannerUserFacingError(error),
      );
    }
    const chunks = [reply];

    try {
      await this.billing.settleCall({
        jobId,
        callId: `asst-${jobId}`,
        internalStage: 'chat',
        model: env.PLANNER_MODEL,
        tokensIn,
        tokensOut,
      });
    } catch (error: unknown) {
      // Phase 4: stub/dev may have no planner ModelRate. Skip charge, still
      // finalize the hold so the reply is delivered instead of failing the turn.
      if (isMissingEffectiveRateError(error)) {
        this.logger.warn(
          `assistant settlement skipped: no effective rate for ${env.PLANNER_MODEL}`,
        );
      } else {
        this.logger.error(
          `assistant settlement failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.closeFailedAssistantJob(jobId);
        throw error;
      }
    }
    let assistantMessage: {
      id: number;
      role: string;
      content: string;
      jobId: string;
      createdAt: Date;
    };
    try {
      assistantMessage = await this.prisma.$transaction(async (tx) => {
        const finalized = await this.billing.finalizeHoldInTransaction(tx as never, {
          jobId,
          outcome: 'success',
        });
        if (finalized.status !== 'settled') {
          throw new Error(`assistant billing hold did not settle: ${finalized.status}`);
        }
        await tx.novelGenerationJob.update({
          where: { jobId },
          data: {
            status: 'succeeded',
            settledAmount: finalized.settledAmount,
            completedAt: new Date(),
          },
        });
        return tx.novelAssistantMessage.create({
          data: {
            projectId,
            userId,
            jobId,
            role: 'assistant',
            content: reply,
            contentMetadata: Object.keys(metadata).length > 0 ? metadata : undefined,
          },
        });
      });
    } catch (error: unknown) {
      await this.closeFailedAssistantJob(jobId);
      throw error;
    }
    return {
      userMessage: this.toView(userMessage),
      assistantMessage: this.toView(assistantMessage),
      chunks,
      generationJobId,
      artifacts,
    };
  }

  private async resolvePlannerEndpoint(): Promise<{
    baseUrl: string;
    apiKey: string;
    model: string;
  }> {
    const envBase = env.PLANNER_API_BASE_URL.trim();
    const envKey = env.PLANNER_API_KEY.trim();
    if (envBase && envKey) {
      return { baseUrl: envBase, apiKey: envKey, model: env.PLANNER_MODEL };
    }
    try {
      const rate = await this.rates.findEffectiveRate(env.PLANNER_MODEL);
      return {
        baseUrl: rate.provider.apiBaseUrl,
        apiKey: decryptSecret(rate.provider.apiKeyEncrypted, env.AES_MASTER_KEY),
        model: env.PLANNER_MODEL,
      };
    } catch (error: unknown) {
      this.logger.error(
        `planner credentials missing for ${env.PLANNER_MODEL}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new ServiceUnavailableException(
        '助手规划模型未配置：请在管理后台为规划模型启用 Provider 与生效费率',
      );
    }
  }

  private async buildPlannerMessages(
    userId: number,
    projectId: number,
    currentUserContent: string,
  ): Promise<PlannerChatMessage[]> {
    const [project, outline, characters, chapters, history] = await Promise.all([
      this.prisma.novelProject.findFirst({
        where: { id: projectId, userId, deletedAt: null },
      }),
      this.prisma.novelDocument.findFirst({
        where: { projectId, userId, documentType: 'story_outline', deletedAt: null },
        select: { content: true },
      }),
      this.prisma.novelCharacter.findMany({
        where: { projectId, userId, deletedAt: null },
        orderBy: { id: 'asc' },
        select: { name: true },
      }),
      this.prisma.novelChapter.findMany({
        where: { projectId, userId, deletedAt: null },
        orderBy: { chapterNumber: 'desc' },
        select: { chapterNumber: true },
        take: 1,
      }),
      this.prisma.novelAssistantMessage.findMany({
        where: { projectId, userId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { role: true, content: true },
      }),
    ]);
    const lastChapterNumber = chapters[0]?.chapterNumber ?? 0;
    const system: PlannerChatMessage = {
      role: 'system',
      content: buildAssistantSystemPrompt({
        title: project?.title ?? '',
        genre: project?.genre ?? '',
        description: project?.description ?? '',
        workflowState: project?.workflowState ?? 'project_created',
        hasOutline: Boolean(outline?.content?.trim()),
        characterNames: characters.map((row) => row.name),
        chapterCount: lastChapterNumber > 0 ? lastChapterNumber : 0,
        nextChapterNumber: lastChapterNumber + 1,
      }),
    };
    const chronological = [...history].reverse();
    if (chronological.length > 0) chronological.pop();
    const prior: PlannerChatMessage[] = chronological.flatMap((row) => {
      if (row.role !== 'user' && row.role !== 'assistant') return [];
      // 单条历史截断，防超长消息撑爆规划模型上下文。
      return [{ role: row.role, content: row.content.slice(0, MAX_HISTORY_MESSAGE_CHARS) }];
    });
    return [system, ...prior, { role: 'user', content: currentUserContent }];
  }

  private async closeFailedAssistantJob(jobId: string): Promise<void> {
    let settledAmount = 0n;
    try {
      const finalized = await this.billing.finalizeHold({ jobId, outcome: 'failure' });
      if (finalized.status !== 'released') {
        this.logger.error(
          `assistant job ${jobId} hold is ${finalized.status}; leaving job active for reconciliation`,
        );
        return;
      }
      settledAmount = finalized.settledAmount;
    } catch (error: unknown) {
      if (error instanceof NotFoundException) {
        this.logger.warn(`assistant job ${jobId} has no billing hold; closing as uncharged`);
      } else {
        this.logger.error(
          `failed to release assistant job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
    }
    try {
      await this.prisma.novelGenerationJob.update({
        where: { jobId },
        data: {
          status: 'failed',
          failureMessage: 'assistant generation failed',
          settledAmount,
          completedAt: new Date(),
        },
      });
    } catch (error: unknown) {
      this.logger.error(
        `released assistant hold ${jobId}, but could not close job: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private toView(row: {
    id: number;
    role: string;
    content: string;
    jobId: string;
    createdAt: Date;
  }): Record<string, unknown> {
    return {
      id: row.id,
      role: row.role,
      content: row.content,
      jobId: row.jobId,
      createdAt: row.createdAt.toISOString(),
      settledHint: fenToString(0n),
    };
  }
}
