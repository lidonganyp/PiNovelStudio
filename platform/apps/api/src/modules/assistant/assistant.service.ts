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
import { PrismaService } from '../../prisma/prisma.service';
import { requireOwnedProject } from '../../common/ownership';
import { env } from '../../config/env';
import { BillingService } from '../billing/billing.service';
import { fenToString } from '../billing/money';
import { InsufficientBalanceException } from '../billing/billing.errors';
import { completePlannerChat } from './planner-client';

export class PostAssistantMessageDto {
  @IsString()
  @MinLength(1)
  content!: string;
}

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  async list(userId: number, projectId: number): Promise<unknown[]> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const rows = await this.prisma.novelAssistantMessage.findMany({
      where: { projectId, userId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toView(row));
  }

  /** 发送用户消息并生成助手回复（stub 同步完成）。 */
  async post(
    userId: number,
    projectId: number,
    content: string,
  ): Promise<{
    userMessage: Record<string, unknown>;
    assistantMessage: Record<string, unknown>;
    chunks: string[];
  }> {
    if (env.PLANNER_MODE === 'disabled') {
      throw new ServiceUnavailableException('助手规划能力尚未在此环境启用');
    }
    if (env.PLANNER_MODE === 'http' && (!env.PLANNER_API_BASE_URL || !env.PLANNER_API_KEY)) {
      throw new ServiceUnavailableException('助手规划模型凭证未配置');
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
    try {
      if (env.PLANNER_MODE === 'http') {
        const planned = await completePlannerChat({
          baseUrl: env.PLANNER_API_BASE_URL,
          apiKey: env.PLANNER_API_KEY,
          model: env.PLANNER_MODEL,
          userContent: content,
          timeoutMs: Math.min(env.NOVEL_RUNTIME_REQUEST_TIMEOUT_MS, 120_000),
        });
        reply = planned.text;
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
      throw new ServiceUnavailableException('规划模型调用失败');
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
      this.logger.error(
        `assistant settlement failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.closeFailedAssistantJob(jobId);
      throw error;
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
    };
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
