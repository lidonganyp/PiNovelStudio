/**
 * 章节内容评审建议服务（advisory 模式）。
 *
 * 设计原则：
 * - 评审不阻断章节落盘：生成成功后异步触发，结果写入 novel_chapter_reviews
 *   与章节冗余快照字段（reviewStatus/reviewVerdict/reviewRationale）。
 * - 单次正向评审（不走匿名正反双向裁决），降低成本并规避双向裁决不一致的
 *   不稳定源；评审结论仅供用户参考（建议通过/建议持有/建议不通过）。
 * - 证据片段必须逐字绑定章节正文；绑定失败、评审超时、模型不可用时降级为
 *   failed/disabled 状态，章节交付不受影响，用户可手动重新评审。
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { env } from '../../config/env';

export type ReviewVerdict = 'approve' | 'hold' | 'reject';

interface ReviewModelOutput {
  verdict: ReviewVerdict;
  rationale: string;
  risks: string[];
  evidenceSpans: string[];
}

const REVIEW_SYSTEM_PROMPT = `【角色】你是章节内容评审顾问，为作者提供参考意见。
【指令】阅读章节正文与创作要求，评估内容质量（结构、内容、语言、连续性、读者体验），给出建议性结论与理由。
【约束】
- 你的结论只是建议，不决定章节是否可用；最终决策权在作者。
- 证据片段必须是正文中逐字存在的句子或短语，不得改写、编造。
- 结论只能是 approve（建议通过）/ hold（建议持有）/ reject（建议不通过）之一。
【输出格式】只输出 JSON 对象，字段：verdict、rationale（中文，200字以内）、risks（字符串数组，可为空）、evidenceSpans（正文逐字片段数组，最多5条，可为空）。`;

@Injectable()
export class ChapterReviewAdvisorService {
  private readonly logger = new Logger(ChapterReviewAdvisorService.name);

  constructor(private readonly prisma: PrismaService) {}

  reviewMode(): 'advisory' | 'blocking' | 'off' {
    return env.PINOVEL_CHAPTER_REVIEW_MODE;
  }

  private reviewerConfigured(): boolean {
    return Boolean(
      env.PINOVEL_CHAPTER_REVIEW_MODEL &&
        env.PINOVEL_CHAPTER_REVIEW_BASE_URL &&
        env.PINOVEL_CHAPTER_REVIEW_API_KEY,
    );
  }

  /** 章节视图上的评审建议快照（无评审记录时返回 null）。 */
  async getReviewAdvice(
    chapterId: number,
  ): Promise<Record<string, unknown> | null> {
    const review = await this.prisma.novelChapterReview.findUnique({
      where: { chapterId },
    });
    if (!review) return null;
    return this.toReviewView(review);
  }

  toReviewView(review: {
    status: string;
    verdict: string | null;
    rationale: string;
    risks: unknown;
    evidenceSpans: unknown;
    model: string | null;
    durationMs: number | null;
    error: string | null;
    mode: string;
    chapterVersion: number;
    updatedAt: Date;
  }): Record<string, unknown> {
    return {
      status: review.status,
      verdict: review.verdict,
      rationale: review.rationale,
      risks: review.risks ?? [],
      evidenceSpans: review.evidenceSpans ?? [],
      model: review.model,
      durationMs: review.durationMs,
      error: review.error,
      mode: review.mode,
      chapterVersion: review.chapterVersion,
      reviewedAt: review.updatedAt.toISOString(),
    };
  }

  /**
   * 生成完成后异步触发评审（fire-and-forget 由调用方控制）。
   * 评审失败只更新评审记录状态，不抛出影响主流程。
   */
  async reviewGeneratedChapter(input: {
    userId: number;
    projectId: number;
    chapterId: number;
    chapterVersion: number;
    generationJobId?: string | null;
    /** 评审触发来源：auto=生成管线自动触发，manual=用户手动重新评审。 */
    source?: 'auto' | 'manual';
  }): Promise<void> {
    const mode = this.reviewMode();
    if (mode === 'off') {
      await this.upsertReview(input, {
        status: 'disabled',
        verdict: null,
        rationale: '',
        risks: [],
        evidenceSpans: [],
        model: null,
        durationMs: null,
        error: null,
        mode,
      });
      return;
    }
    if (!this.reviewerConfigured()) {
      await this.upsertReview(input, {
        status: 'failed',
        verdict: null,
        rationale: '',
        risks: [],
        evidenceSpans: [],
        model: null,
        durationMs: null,
        error: '评审模型未配置（PINOVEL_CHAPTER_REVIEW_*），评审不可用',
        mode,
      });
      return;
    }
    const chapter = await this.prisma.novelChapter.findFirst({
      where: {
        id: input.chapterId,
        projectId: input.projectId,
        userId: input.userId,
        deletedAt: null,
      },
      include: { seed: true },
    });
    if (!chapter || chapter.version !== input.chapterVersion) {
      // 评审触发后章节已被用户修改/重新生成，本次评审结果已过期，直接丢弃。
      return;
    }
    await this.upsertReview(input, {
      status: 'pending',
      verdict: null,
      rationale: '',
      risks: [],
      evidenceSpans: [],
      model: env.PINOVEL_CHAPTER_REVIEW_MODEL,
      durationMs: null,
      error: null,
      mode,
    });
    const started = Date.now();
    try {
      const output = await this.callReviewer({
        title: chapter.title,
        chapterNumber: chapter.chapterNumber,
        content: chapter.content,
        intent: chapter.seed?.intent ?? '',
        endingGoal: chapter.seed?.endingGoal ?? '',
      });
      // span 逐字校验：只保留真实存在于正文中的片段，校验后为空不阻断，仅降权展示
      const validSpans = output.evidenceSpans.filter(
        (span) => span.length > 0 && chapter.content.includes(span),
      );
      await this.upsertReview(input, {
        status: 'completed',
        verdict: output.verdict,
        rationale: output.rationale,
        risks: output.risks,
        evidenceSpans: validSpans,
        model: env.PINOVEL_CHAPTER_REVIEW_MODEL,
        durationMs: Date.now() - started,
        error:
          validSpans.length !== output.evidenceSpans.length
            ? '部分证据片段未逐字命中正文，已过滤'
            : null,
        mode,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `chapter review failed chapter=${input.chapterId}: ${message}`,
      );
      await this.upsertReview(input, {
        status: 'failed',
        verdict: null,
        rationale: '',
        risks: [],
        evidenceSpans: [],
        model: env.PINOVEL_CHAPTER_REVIEW_MODEL,
        durationMs: Date.now() - started,
        error: message.slice(0, 500),
        mode,
      });
    }
  }

  /** 手动重新评审（用户在评审失败/不可用后触发）。 */
  async manualReview(
    userId: number,
    projectId: number,
    chapterId: number,
  ): Promise<Record<string, unknown> | null> {
    const chapter = await this.prisma.novelChapter.findFirst({
      where: { id: chapterId, projectId, userId, deletedAt: null },
    });
    if (!chapter) return null;
    await this.reviewGeneratedChapter({
      userId,
      projectId,
      chapterId,
      chapterVersion: chapter.version,
      generationJobId: chapter.generationJobId,
      source: 'manual',
    });
    return this.getReviewAdvice(chapterId);
  }

  private async upsertReview(
    input: {
      userId: number;
      projectId: number;
      chapterId: number;
      chapterVersion: number;
      generationJobId?: string | null;
      source?: 'auto' | 'manual';
    },
    data: {
      status: string;
      verdict: string | null;
      rationale: string;
      risks: unknown;
      evidenceSpans: unknown;
      model: string | null;
      durationMs: number | null;
      error: string | null;
      mode: string;
    },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // quality-trace：追加式记录每次评审状态流转（含证据与耗时），
      // 与 upsert 语义的评审建议表互补，供治理审计与反馈回流取证。
      await tx.novelChapterReviewTrace.create({
        data: {
          chapterId: input.chapterId,
          projectId: input.projectId,
          userId: input.userId,
          chapterVersion: input.chapterVersion,
          generationJobId: input.generationJobId ?? null,
          mode: data.mode,
          status: data.status,
          verdict: data.verdict,
          rationale: data.rationale,
          risks: data.risks as object,
          evidenceSpans: data.evidenceSpans as object,
          model: data.model,
          durationMs: data.durationMs,
          error: data.error,
          source: input.source ?? 'auto',
        },
      });
      await tx.novelChapterReview.upsert({
        where: { chapterId: input.chapterId },
        create: {
          chapterId: input.chapterId,
          projectId: input.projectId,
          userId: input.userId,
          chapterVersion: input.chapterVersion,
          generationJobId: input.generationJobId ?? null,
          mode: data.mode,
          status: data.status,
          verdict: data.verdict,
          rationale: data.rationale,
          risks: data.risks as object,
          evidenceSpans: data.evidenceSpans as object,
          model: data.model,
          durationMs: data.durationMs,
          error: data.error,
        },
        update: {
          chapterVersion: input.chapterVersion,
          generationJobId: input.generationJobId ?? null,
          mode: data.mode,
          status: data.status,
          verdict: data.verdict,
          rationale: data.rationale,
          risks: data.risks as object,
          evidenceSpans: data.evidenceSpans as object,
          model: data.model,
          durationMs: data.durationMs,
          error: data.error,
        },
      });
      // 冗余快照：评审状态与结论直接挂到章节主表，避免详情接口联表
      await tx.novelChapter.updateMany({
        where: { id: input.chapterId, version: input.chapterVersion },
        data: {
          reviewStatus: data.status,
          reviewVerdict: data.verdict,
          reviewRationale: data.rationale.slice(0, 2000),
        },
      });
    });
  }

  private async callReviewer(input: {
    title: string;
    chapterNumber: number;
    content: string;
    intent: string;
    endingGoal: string;
  }): Promise<ReviewModelOutput> {
    const baseUrl = env.PINOVEL_CHAPTER_REVIEW_BASE_URL.replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      env.PINOVEL_CHAPTER_REVIEW_TIMEOUT_MS,
    );
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.PINOVEL_CHAPTER_REVIEW_API_KEY}`,
        },
        body: JSON.stringify({
          model: env.PINOVEL_CHAPTER_REVIEW_MODEL,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: REVIEW_SYSTEM_PROMPT },
            {
              role: 'user',
              content: JSON.stringify({
                章节号: input.chapterNumber,
                标题: input.title,
                创作要求: input.intent,
                本章目标: input.endingGoal,
                章节正文: input.content,
              }),
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `评审服务 HTTP ${response.status}（${body.slice(0, 200)}）`,
        );
      }
      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = payload.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error('评审服务返回为空');
      }
      return this.parseOutput(text);
    } finally {
      clearTimeout(timer);
    }
  }

  private parseOutput(text: string): ReviewModelOutput {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('评审服务返回不是合法 JSON');
    }
    const obj = parsed as Record<string, unknown>;
    const verdictValue = obj.verdict ?? obj['结论'];
    const verdictMap: Record<string, ReviewVerdict> = {
      approve: 'approve',
      hold: 'hold',
      reject: 'reject',
      建议通过: 'approve',
      建议持有: 'hold',
      建议不通过: 'reject',
    };
    const verdict =
      typeof verdictValue === 'string' ? verdictMap[verdictValue] : undefined;
    if (!verdict) {
      throw new Error('评审服务返回缺少有效结论');
    }
    const asStringArray = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
    const rationaleValue = obj.rationale ?? obj['理由'];
    return {
      verdict,
      rationale:
        typeof rationaleValue === 'string' ? rationaleValue.slice(0, 2000) : '',
      risks: asStringArray(obj.risks ?? obj['风险']),
      evidenceSpans: asStringArray(
        obj.evidenceSpans ?? obj['证据片段'],
      ).slice(0, 5),
    };
  }
}
