/**
 * 章节 / 种子 / 版本 / 生成入口。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../auth/auth.types';
import { JobsService } from '../jobs/jobs.service';
import { NotFoundException } from '@nestjs/common';
import {
  ChapterDecisionDto,
  CreateChapterDto,
  RestoreVersionDto,
  UpdateChapterDto,
  UpsertSeedDto,
} from './dto/chapter.dto';
import { ChaptersService } from './chapters.service';
import { ChapterReviewAdvisorService } from './chapter-review-advisor.service';

@Controller('projects/:id')
@UseGuards(JwtAuthGuard)
export class ChaptersController {
  constructor(
    private readonly chapters: ChaptersService,
    private readonly jobs: JobsService,
    private readonly reviewAdvisor: ChapterReviewAdvisorService,
  ) {}

  @Get('chapters')
  list(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
  ): Promise<unknown> {
    return this.chapters.list(user.sub, projectId);
  }

  @Post('chapters')
  create(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Body() dto: CreateChapterDto,
  ): Promise<unknown> {
    return this.chapters.create(user.sub, projectId, dto);
  }

  @Get('chapters/:cid')
  get(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('cid', ParseIntPipe) chapterId: number,
  ): Promise<unknown> {
    return this.chapters.get(user.sub, projectId, chapterId);
  }

  @Put('chapters/:cid')
  update(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('cid', ParseIntPipe) chapterId: number,
    @Body() dto: UpdateChapterDto,
  ): Promise<unknown> {
    return this.chapters.update(user.sub, projectId, chapterId, dto);
  }

  @Delete('chapters/:cid')
  remove(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('cid', ParseIntPipe) chapterId: number,
  ): Promise<unknown> {
    return this.chapters.remove(user.sub, projectId, chapterId);
  }

  @Get('chapters/:cid/seed')
  getSeed(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('cid', ParseIntPipe) chapterId: number,
  ): Promise<unknown> {
    return this.chapters.getSeed(user.sub, projectId, chapterId);
  }

  @Post('chapters/:cid/seed')
  upsertSeed(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('cid', ParseIntPipe) chapterId: number,
    @Body() dto: UpsertSeedDto,
  ): Promise<unknown> {
    return this.chapters.upsertSeed(user.sub, projectId, chapterId, dto);
  }

  @Get('chapters/:cid/versions')
  versions(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('cid', ParseIntPipe) chapterId: number,
  ): Promise<unknown> {
    return this.chapters.listVersions(user.sub, projectId, chapterId);
  }

  @Post('chapters/:cid/versions/restore')
  restore(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('cid', ParseIntPipe) chapterId: number,
    @Body() dto: RestoreVersionDto,
  ): Promise<unknown> {
    return this.chapters.restoreVersion(user.sub, projectId, chapterId, dto);
  }

  @Post('chapters/:cid/generate')
  generate(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('cid', ParseIntPipe) chapterId: number,
  ): Promise<unknown> {
    return this.jobs.submitChapterGeneration(user.sub, projectId, chapterId);
  }

  @Get('chapters/:cid/review')
  async getReview(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('cid', ParseIntPipe) chapterId: number,
  ): Promise<unknown> {
    await this.chapters.get(user.sub, projectId, chapterId);
    const review = await this.reviewAdvisor.getReviewAdvice(chapterId);
    if (!review) throw new NotFoundException('当前章节暂无评审结果');
    return review;
  }

  @Post('chapters/:cid/review')
  async manualReview(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('cid', ParseIntPipe) chapterId: number,
  ): Promise<unknown> {
    const review = await this.reviewAdvisor.manualReview(
      user.sub,
      projectId,
      chapterId,
    );
    if (!review) throw new NotFoundException('章节不存在');
    return review;
  }

  @Post('chapters/:cid/decisions')
  async recordDecision(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('cid', ParseIntPipe) chapterId: number,
    @Body() dto: ChapterDecisionDto,
  ): Promise<unknown> {
    const decision = await this.chapters.recordDecision(
      user.sub,
      projectId,
      chapterId,
      dto,
    );
    let job: { jobId?: string } | null = null;
    if (dto.decision !== 'keep') {
      job = (await this.jobs.submitChapterGeneration(
        user.sub,
        projectId,
        chapterId,
      )) as { jobId?: string };
      if (job?.jobId) {
        await this.chapters.attachDecisionJob(user.sub, decision.id, job.jobId);
      }
    }
    return { ...decision, job };
  }

  @Get('chapters/:cid/decisions')
  listDecisions(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('cid', ParseIntPipe) chapterId: number,
  ): Promise<unknown> {
    return this.chapters.listDecisions(user.sub, projectId, chapterId);
  }
}
