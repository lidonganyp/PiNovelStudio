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
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { decryptSecret } from '../../common/crypto/aes-gcm';
import { PrismaService } from '../../prisma/prisma.service';
import { requireOwnedProject } from '../../common/ownership';
import { env } from '../../config/env';
import { BillingService } from '../billing/billing.service';
import { computeChargeFen, fenToString } from '../billing/money';
import { InsufficientBalanceException } from '../billing/billing.errors';
import { JobsService } from '../jobs/jobs.service';
import { RatesService } from '../rates/rates.service';
import { applyAssistantArtifacts } from './assistant-artifacts';
import { buildAssistantSystemPrompt } from './assistant-prompt';
import { parsePlannerEnvelope } from './planner-envelope';
import { parseAssistantRequest } from '../context/assistant-contract';
import { compileProjectContext } from '../context/context-compiler';
import { envelopeFromUnknown, FailureHttpException, FAILURE_CODES, makeFailure } from '../context/failure-envelope';
import { ASSISTANT_ACTIONS, type AssistantAction, type ContextManifest } from '../context/types';
import { isUsableStoryOutline } from '../jobs/book-context';
import {
  inferGenerateChapterNumber,
  shouldPreflightAuthorContract,
} from './assistant-markers';
import {
  confirmGenerationSteward,
  parseStewardAction,
  prepareGenerationSteward,
  reviseGenerationSteward,
  submitReadyGenerationSteward,
  type StewardResult,
} from '../context/generation-steward';
import {
  completePlannerChat,
  type PlannerChatMessage,
} from './planner-client';

export class PostAssistantMessageDto {
  @IsString()
  @MinLength(1)
  content!: string;

  /** 缺省 = auto 模式：动作由规划模型根据消息内容判断。 */
  @IsOptional()
  @IsIn(ASSISTANT_ACTIONS)
  action?: AssistantAction;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chapterNumber?: number;

  @IsOptional()
  @IsBoolean()
  confirmGeneration?: boolean;

  @IsOptional()
  @IsIn(['apply_and_generate', 'save_draft', 'cancel', 'revise'])
  stewardAction?: 'apply_and_generate' | 'save_draft' | 'cancel' | 'revise';

  @IsOptional()
  @IsString()
  proposalId?: string;

  @IsOptional()
  @IsString()
  sourceVersion?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  confirmedFields?: string[];

  @IsOptional()
  @IsArray()
  @IsObject({ each: true })
  proposalEdits?: Array<{ field: string; value: string }>;
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

/** 助手预占 token 预算：输入覆盖全书工作集+历史，输出覆盖整本大纲 JSON envelope。 */
const ASSISTANT_MAX_TOKENS_IN = 16_000;
const ASSISTANT_MAX_TOKENS_OUT = 10_000;
/** 费率不可用（stub/dev）或低余额降级时的保底预占（分）。 */
const ASSISTANT_FALLBACK_MAX_CHARGE = 50n;

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
    try {
      await requireOwnedProject(this.prisma, userId, projectId);
      const rows = await this.prisma.novelAssistantMessage.findMany({
        where: { projectId, userId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((row) => this.toView(row));
    } catch (error: unknown) {
      if (error instanceof FailureHttpException || error instanceof NotFoundException) throw error;
      throw new FailureHttpException(makeFailure({
        stage: 'assistant.history',
        gate: 'list',
        code: FAILURE_CODES.historyLoadFailed,
        severity: 'recoverable',
        reason: '对话历史加载失败，请刷新后重试',
        recoverable: true,
        retryPlan: 'retry_same_stage',
      }));
    }
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
    contentOrDto: string | PostAssistantMessageDto,
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
      publicEntry?: 'novel_generate_chapter';
      records: Array<{ type: 'story_outline' | 'chapter_seed' | 'query_answer'; saved: boolean; id?: number }>;
    };
    action?: AssistantAction;
    /** 实际执行的章节号（显式请求或模型判断）。 */
    chapterNumber?: number;
    steward?: StewardResult;
    contextManifest?: ContextManifest;
  }> {
    const request = parseAssistantRequest(
      typeof contentOrDto === 'string' ? { content: contentOrDto } : contentOrDto,
    );
    const content = request.content;
    const isGenerationRequest = shouldPreflightAuthorContract(request.action, content)
      || Boolean(request.stewardAction);
    if (
      env.PLANNER_MODE === 'disabled' &&
      !isGenerationRequest
    ) {
      throw new ServiceUnavailableException('助手规划能力尚未在此环境启用');
    }
    await requireOwnedProject(this.prisma, userId, projectId);
    if (isGenerationRequest) {
      return this.runGenerationSteward(userId, projectId, request, onDelta);
    }
    const jobId = randomUUID();
    const maxCharge = await this.estimateAssistantMaxCharge();
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
      if (error instanceof InsufficientBalanceException && maxCharge > ASSISTANT_FALLBACK_MAX_CHARGE) {
        // 低余额降级：按费率预估的全额预占失败时，改用保底预占让对话仍可用；
        // 结算走 capAtHold 按预占封顶，不会丢弃已生成的回复。
        try {
          await this.billing.createHold({
            userId,
            jobId,
            amount: ASSISTANT_FALLBACK_MAX_CHARGE,
          });
          await this.prisma.novelGenerationJob.update({
            where: { jobId },
            data: { maxCharge: ASSISTANT_FALLBACK_MAX_CHARGE },
          });
        } catch (retryError: unknown) {
          await this.closeFailedHoldCreation(jobId, retryError);
          throw retryError;
        }
      } else {
        await this.closeFailedHoldCreation(jobId, error);
        throw error;
      }
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
      throw new FailureHttpException(makeFailure({
        stage: 'assistant.persist',
        gate: 'user_message',
        code: FAILURE_CODES.messageSaveFailed,
        severity: 'recoverable',
        reason: '聊天消息保存失败，请稍后重试',
        recoverable: true,
        retryPlan: 'retry_same_stage',
      }));
    }

    let reply: string;
    let tokensIn = Math.max(1, content.length);
    let tokensOut = 1;
    let metadata: Record<string, unknown> = {};
    let generationJobId: string | undefined;
    let resolvedAction: AssistantAction | undefined = request.action;
    let resolvedChapterNumber: number | undefined = request.chapterNumber;
    let artifacts: {
      outlineSaved: boolean;
      charactersSaved: number;
      chaptersTouched: number[];
      generationJobId?: string;
      focusTab?: 'outline' | 'characters' | 'chapter' | 'seed';
      publicEntry?: 'novel_generate_chapter';
      records: Array<{ type: 'story_outline' | 'chapter_seed' | 'query_answer'; saved: boolean; id?: number }>;
    } | undefined;
    let steward: StewardResult | undefined;
    let contextManifest: ContextManifest | undefined;
    try {
      if (env.PLANNER_MODE === 'http') {
        const endpoint = await this.resolvePlannerEndpoint();
        const plannerContext = await this.buildPlannerMessages(
          userId,
          projectId,
          content,
          request.action,
          request.chapterNumber,
        );
        contextManifest = plannerContext.manifest;
        const planned = await completePlannerChat({
          baseUrl: endpoint.baseUrl,
          apiKey: endpoint.apiKey,
          model: endpoint.model,
          messages: plannerContext.messages,
          timeoutMs: env.PLANNER_REQUEST_TIMEOUT_MS,
        });
        const envelope = parsePlannerEnvelope(planned.text, request.action);
        onDelta?.(envelope.reply);
        // auto 模式：动作由模型判断；generate_chapter 视为模型已确认用户明确要求生成。
        const action = envelope.action ?? request.action;
        if (!action) {
          // 理论不可达：显式模式契约已校验，auto 模式 envelope.action 必填。
          throw new FailureHttpException(makeFailure({
            stage: 'assistant.planner',
            gate: 'planner_schema',
            code: FAILURE_CODES.plannerSchemaInvalid,
            severity: 'recoverable',
            reason: '规划结果缺少动作判断，请重试',
            recoverable: true,
            retryPlan: 'retry_same_stage',
          }));
        }
        const chapterNumber = request.chapterNumber ?? envelope.chapterSeed?.chapterNumber;
        if (
          (action === 'plan_chapter' || action === 'generate_chapter') &&
          chapterNumber === undefined
        ) {
          throw new FailureHttpException(makeFailure({
            stage: 'assistant.action',
            gate: 'request_schema',
            code: FAILURE_CODES.missingChapterNumber,
            severity: 'preflight',
            reason: '请说明章节号，例如「规划第3章」或「生成第3章正文」',
            recoverable: false,
          }));
        }
        const confirmGeneration =
          request.action === undefined ? true : request.confirmGeneration;
        if (action === 'generate_chapter' && chapterNumber !== undefined) {
          const seedApplied = await applyAssistantArtifacts({
            prisma: this.prisma,
            jobs: this.jobs,
            userId,
            projectId,
            userContent: content,
            action: 'plan_chapter',
            chapterNumber,
            confirmGeneration: false,
            envelope,
          });
          let next = await prepareGenerationSteward({
            prisma: this.prisma,
            userId,
            projectId,
            chapterNumber,
          });
          if (next.status === 'ready') {
            next = {
              ...next,
              generationJobId: await submitReadyGenerationSteward({
                prisma: this.prisma,
                jobs: this.jobs,
                userId,
                projectId,
                chapterNumber,
              }),
              publicEntry: 'novel_generate_chapter',
            };
          } else if (next.status === 'auto_fill' && next.proposalId) {
            next = await confirmGenerationSteward({
              prisma: this.prisma,
              jobs: this.jobs,
              userId,
              projectId,
              action: 'apply_and_generate',
              proposalId: next.proposalId,
              sourceVersion: next.sourceVersion,
            });
          }
          onDelta?.(next.reply);
          reply = next.reply;
          metadata = { ...seedApplied.metadata, steward: next };
          generationJobId = next.generationJobId;
          artifacts = next.generationJobId
            ? {
                ...seedApplied.artifacts,
                generationJobId: next.generationJobId,
                publicEntry: 'novel_generate_chapter',
                focusTab: 'chapter',
                chaptersTouched: [...new Set([...seedApplied.artifacts.chaptersTouched, chapterNumber])],
              }
            : seedApplied.artifacts;
          steward = next;
        } else {
          const applied = await applyAssistantArtifacts({
            prisma: this.prisma,
            jobs: this.jobs,
            userId,
            projectId,
            userContent: content,
            action,
            chapterNumber,
            confirmGeneration,
            envelope,
          });
          reply = applied.content;
          metadata = applied.metadata;
          generationJobId = applied.generationJobId;
          artifacts = applied.artifacts;
        }
        resolvedAction = action;
        resolvedChapterNumber = chapterNumber;
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
      if (error instanceof FailureHttpException) throw error;
      throw new FailureHttpException(envelopeFromUnknown(error, {
        stage: 'assistant.planner',
        gate: 'planner_chat',
        code: FAILURE_CODES.plannerFailed,
      }));
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
        // 回复已生成：结算超出预占余量时按余量封顶收费，不因计费丢弃内容。
        capAtHold: true,
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
      action: resolvedAction,
      chapterNumber: resolvedChapterNumber,
      steward,
      contextManifest,
    };
  }

  /** 按规划模型费率预估本轮预占（分）；费率不可用（stub/dev）回退保底值。 */
  private async estimateAssistantMaxCharge(): Promise<bigint> {
    try {
      const snapshot = await this.rates.buildRateSnapshot(env.PLANNER_MODEL);
      const charge = computeChargeFen({
        tokensIn: ASSISTANT_MAX_TOKENS_IN,
        tokensOut: ASSISTANT_MAX_TOKENS_OUT,
        inputPricePerMillion: BigInt(snapshot.inputPricePerMillion),
        outputPricePerMillion: BigInt(snapshot.outputPricePerMillion),
        multiplierPercent: snapshot.multiplierPercent ?? 100,
      });
      return charge > 0n ? charge : ASSISTANT_FALLBACK_MAX_CHARGE;
    } catch {
      return ASSISTANT_FALLBACK_MAX_CHARGE;
    }
  }

  /** 预占创建失败：按失败原因关闭任务并保持既有 402/500 语义。 */
  private async closeFailedHoldCreation(jobId: string, error: unknown): Promise<void> {
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
    action?: AssistantAction,
    chapterNumber?: number,
  ): Promise<{ messages: PlannerChatMessage[]; manifest: ContextManifest }> {
    const [project, documents, characters, chapters, history, outlineNodes] = await Promise.all([
      this.prisma.novelProject.findFirst({
        where: { id: projectId, userId, deletedAt: null },
      }),
      this.prisma.novelDocument.findMany({
        where: {
          projectId,
          userId,
          deletedAt: null,
        },
        select: { id: true, documentType: true, content: true, currentVersion: true },
      }),
      this.prisma.novelCharacter.findMany({
        where: { projectId, userId, deletedAt: null },
        orderBy: { id: 'asc' },
        select: {
          name: true,
          roleType: true,
          identity: true,
          goals: true,
          motivation: true,
          currentState: true,
          relationships: true,
          personality: true,
          abilities: true,
          secrets: true,
          characterArc: true,
          notes: true,
        },
      }),
      this.prisma.novelChapter.findMany({
        where: { projectId, userId, deletedAt: null },
        orderBy: { chapterNumber: 'desc' },
        select: {
          id: true,
          chapterNumber: true,
          title: true,
          status: true,
          wordCount: true,
          content: true,
          seed: true,
        },
      }),
      this.prisma.novelAssistantMessage.findMany({
        where: { projectId, userId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { role: true, content: true },
      }),
      this.prisma.novelOutlineNode.findMany({
        where: { projectId, userId, deletedAt: null },
        orderBy: { sortOrder: 'asc' },
        select: {
          title: true,
          summary: true,
          nodeType: true,
          narrativeGoal: true,
          conflict: true,
          turningPoint: true,
          endingHook: true,
        },
      }),
    ]);
    const byType = new Map(documents.map((row) => [row.documentType, row]));
    const lastChapterNumber = chapters.reduce(
      (max, row) => Math.max(max, row.chapterNumber),
      0,
    );
    const targetChapter = chapterNumber ?? lastChapterNumber + 1;
    const previousChapter = chapters.find((row) => row.chapterNumber === targetChapter - 1)
      ?? chapters
        .filter((row) => row.chapterNumber < targetChapter)
        .sort((left, right) => right.chapterNumber - left.chapterNumber)[0];
    const currentChapter = chapters.find((row) => row.chapterNumber === targetChapter);
    const seed = currentChapter?.seed
      ? {
          chapterNumber: targetChapter,
          intent: currentChapter.seed.intent,
          mustInclude: currentChapter.seed.mustInclude,
          forbiddenFacts: currentChapter.seed.forbiddenFacts,
          characterMotives: currentChapter.seed.characterMotives,
          promises: currentChapter.seed.promises,
          endingGoal: currentChapter.seed.endingGoal,
        }
      : undefined;
    const chapterNode = outlineNodes.find((row) => row.title.includes(`第${targetChapter}章`));
    const outline = byType.get('story_outline');
    const outlineText = outline?.content?.trim() ?? '';
    const compiled = compileProjectContext({
      storyOutline: outline,
      chapterCatalog: chapters.map((row) => ({
        chapterNumber: row.chapterNumber,
        title: row.title,
        status: row.status,
        wordCount: row.wordCount,
        content: row.content,
        seed: row.seed,
        outlineSummary: outlineNodes
          .filter((node) => node.title.includes(`第${row.chapterNumber}章`))
          .map((node) => [node.title, node.summary, node.narrativeGoal, node.conflict, node.turningPoint, node.endingHook]
            .filter(Boolean).join('；'))
          .join('\n'),
      })),
      supportingMaterials: documents
        .filter((row) => ![
          'story_outline',
          'creative_constitution',
          'worldbuilding',
          'style_profile',
          'narrative_state',
          'material_proposal',
        ].includes(row.documentType))
        .map((row) => ({ documentType: row.documentType, title: row.documentType, content: row.content })),
      constitution: byType.get('creative_constitution'),
      worldbuilding: byType.get('worldbuilding')
        ? {
            ...byType.get('worldbuilding'),
            content: [
              byType.get('worldbuilding')?.content,
              Array.isArray(project?.worldKeyTerms) && project.worldKeyTerms.length > 0
                ? `\n世界观关键词：${project.worldKeyTerms.join('、')}`
                : '',
            ].filter(Boolean).join(''),
          }
        : (Array.isArray(project?.worldKeyTerms) && project.worldKeyTerms.length > 0
            ? { content: `世界观关键词：${project.worldKeyTerms.join('、')}` }
            : undefined),
      styleProfile: byType.get('style_profile'),
      narrativeState: byType.get('narrative_state'),
      chapterSeed: seed,
      currentChapterOutline: chapterNode
        ? {
            content: [
              chapterNode.title,
              chapterNode.summary,
              chapterNode.narrativeGoal && `叙事目标：${chapterNode.narrativeGoal}`,
              chapterNode.conflict && `冲突：${chapterNode.conflict}`,
              chapterNode.turningPoint && `转折：${chapterNode.turningPoint}`,
              chapterNode.endingHook && `章末钩子：${chapterNode.endingHook}`,
            ].filter(Boolean).join('\n').trim(),
          }
        : undefined,
      characters,
      previousChapter: previousChapter
        ? { chapterNumber: previousChapter.chapterNumber, content: previousChapter.content }
        : undefined,
      evidenceQuery: action === 'query_project'
        ? { query: currentUserContent.slice(0, 40), purpose: 'query_project' }
        : undefined,
      enforceStateHash: action === 'generate_chapter',
    });
    const system: PlannerChatMessage = {
      role: 'system',
      content: buildAssistantSystemPrompt({
        title: project?.title ?? '',
        genre: project?.genre ?? '',
        description: project?.description ?? '',
        workflowState: project?.workflowState ?? 'project_created',
        hasOutline: isUsableStoryOutline(outlineText),
        characterNames: characters.map((row) => row.name),
         chapterCount: chapters.length,
        nextChapterNumber: lastChapterNumber + 1,
        action,
        bookContext: compiled.bookBrief,
      }),
    };
    const chronological = [...history].reverse();
    if (chronological.length > 0) chronological.pop();
    const prior: PlannerChatMessage[] = chronological.flatMap((row) => {
      if (row.role !== 'user' && row.role !== 'assistant') return [];
      // 单条历史截断，防超长消息撑爆规划模型上下文。
      return [{ role: row.role, content: row.content.slice(0, MAX_HISTORY_MESSAGE_CHARS) }];
    });
    return {
      messages: [system, ...prior, { role: 'user', content: currentUserContent }],
      manifest: compiled.manifest,
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

  private async runGenerationSteward(
    userId: number,
    projectId: number,
    request: ReturnType<typeof parseAssistantRequest>,
    onDelta?: (delta: string) => void,
  ): Promise<{
    userMessage: Record<string, unknown>;
    assistantMessage: Record<string, unknown>;
    chunks: string[];
    generationJobId?: string;
    action?: AssistantAction;
    chapterNumber?: number;
    steward?: StewardResult;
    artifacts?: {
      outlineSaved: boolean;
      charactersSaved: number;
      chaptersTouched: number[];
      generationJobId?: string;
      focusTab?: 'outline' | 'characters' | 'chapter' | 'seed';
      publicEntry?: 'novel_generate_chapter';
      records: Array<{ type: 'story_outline' | 'chapter_seed' | 'query_answer'; saved: boolean; id?: number }>;
    };
  }> {
    const stewardAction = parseStewardAction(request.stewardAction);
    let steward: StewardResult;
    if (stewardAction && request.proposalId && request.sourceVersion) {
      steward = stewardAction === 'revise'
        ? await reviseGenerationSteward({
            prisma: this.prisma,
            userId,
            projectId,
            proposalId: request.proposalId,
            sourceVersion: request.sourceVersion,
            edits: request.proposalEdits ?? [],
          })
        : await confirmGenerationSteward({
            prisma: this.prisma,
            jobs: this.jobs,
            userId,
            projectId,
            action: stewardAction,
            proposalId: request.proposalId,
            sourceVersion: request.sourceVersion,
            confirmedFields: request.confirmedFields,
          });
    } else {
      const chapterNumber = request.chapterNumber
        ?? inferGenerateChapterNumber(request.content, '')
        ?? undefined;
      if (!chapterNumber) {
        throw new FailureHttpException(makeFailure({
          stage: 'assistant.action',
          gate: 'request_schema',
          code: FAILURE_CODES.missingChapterNumber,
          severity: 'preflight',
          reason: '请说明章节号，例如「生成第3章正文」',
          recoverable: false,
        }));
      }
      steward = await prepareGenerationSteward({
        prisma: this.prisma,
        userId,
        projectId,
        chapterNumber,
      });
      if (steward.status === 'ready') {
        steward.generationJobId = await submitReadyGenerationSteward({
          prisma: this.prisma,
          jobs: this.jobs,
          userId,
          projectId,
          chapterNumber,
        });
        steward.publicEntry = 'novel_generate_chapter';
      } else if (steward.status === 'auto_fill' && steward.proposalId) {
        steward = await confirmGenerationSteward({
          prisma: this.prisma,
          jobs: this.jobs,
          userId,
          projectId,
          action: 'apply_and_generate',
          proposalId: steward.proposalId,
          sourceVersion: steward.sourceVersion,
        });
      }
    }
    onDelta?.(steward.reply);
    const userMessage = await this.prisma.novelAssistantMessage.create({
      data: {
        projectId,
        userId,
        jobId: '',
        role: 'user',
        content: request.content,
      },
    });
    const assistantMessage = await this.prisma.novelAssistantMessage.create({
      data: {
        projectId,
        userId,
        jobId: steward.generationJobId ?? '',
        role: 'assistant',
        content: steward.reply,
        contentMetadata: {
          steward,
          artifacts: steward.generationJobId
            ? { publicEntry: 'novel_generate_chapter', chaptersTouched: [steward.chapterNumber] }
            : undefined,
        },
      },
    });
    return {
      userMessage: this.toView(userMessage),
      assistantMessage: this.toView(assistantMessage),
      chunks: [steward.reply],
      generationJobId: steward.generationJobId,
      action: 'generate_chapter',
      chapterNumber: steward.chapterNumber,
      steward,
      artifacts: steward.generationJobId
        ? {
            outlineSaved: false,
            charactersSaved: 0,
            chaptersTouched: [steward.chapterNumber],
            generationJobId: steward.generationJobId,
            focusTab: 'chapter',
            publicEntry: 'novel_generate_chapter',
            records: [],
          }
        : undefined,
    };
  }

  private toView(row: {
    id: number;
    role: string;
    content: string;
    jobId: string;
    createdAt: Date;
    contentMetadata?: unknown;
  }): Record<string, unknown> {
    return {
      id: row.id,
      role: row.role,
      content: row.content,
      jobId: row.jobId,
      createdAt: row.createdAt.toISOString(),
      settledHint: fenToString(0n),
      metadata: row.contentMetadata ?? undefined,
    };
  }
}
