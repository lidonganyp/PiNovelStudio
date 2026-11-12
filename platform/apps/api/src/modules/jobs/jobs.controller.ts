/**
 * 任务轮询 API：GET /api/jobs/:jobId 与逐调用明细。
 */
import { BadRequestException, Controller, Get, Post, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../auth/auth.types';
import { JobsService } from './jobs.service';

@Controller('jobs')
@UseGuards(JwtAuthGuard)
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  /** 刷新恢复：项目下进行中 + 最近终态的章节生成任务（重建聊天卡片用）。 */
  @Get('restorable')
  restorable(
    @CurrentUser() user: AuthUserPayload,
    @Query('projectId') projectId: string,
  ): Promise<unknown> {
    const parsed = Number(projectId);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new BadRequestException('projectId 无效');
    }
    return this.jobs.listRestorableJobs(user.sub, parsed);
  }

  @Post(':jobId/retry')
  retry(@CurrentUser() user: AuthUserPayload, @Param('jobId') jobId: string): Promise<unknown> {
    return this.jobs.retryGeneration(user.sub, jobId);
  }

  @Get(':jobId')
  get(
    @CurrentUser() user: AuthUserPayload,
    @Param('jobId') jobId: string,
  ): Promise<unknown> {
    return this.jobs.getJob(user.sub, jobId);
  }

  @Get(':jobId/calls')
  calls(
    @CurrentUser() user: AuthUserPayload,
    @Param('jobId') jobId: string,
  ): Promise<unknown> {
    return this.jobs.getCalls(user.sub, jobId);
  }

  @Get(':jobId/events')
  events(
    @CurrentUser() user: AuthUserPayload,
    @Param('jobId') jobId: string,
  ): Promise<unknown> {
    return this.jobs.getJobEvents(user.sub, jobId);
  }
}
