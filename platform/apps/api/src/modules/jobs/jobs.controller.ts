/**
 * 任务轮询 API：GET /api/jobs/:jobId 与逐调用明细。
 */
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../auth/auth.types';
import { JobsService } from './jobs.service';

@Controller('jobs')
@UseGuards(JwtAuthGuard)
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

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
}
