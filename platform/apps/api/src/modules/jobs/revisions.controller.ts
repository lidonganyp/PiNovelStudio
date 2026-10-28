/** Author-confirmed sequential rewrite API; budgets are server-owned. */
import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, Min } from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../auth/auth.types';
import { RevisionsService } from './revisions.service';

export class ProposeRevisionDto {
  @IsOptional() @IsInt() @Min(1) startChapter?: number;
  @IsOptional() @IsInt() @Min(1) endChapter?: number;
}
export class ConfirmRevisionDto { @IsInt() @Min(1) version!: number; }
export class ApproveManualDto { @IsInt() @Min(1) chapterVersion!: number; }

@Controller('projects/:id/revisions')
@UseGuards(JwtAuthGuard)
export class RevisionsController {
  constructor(private readonly revisions: RevisionsService) {}
  @Post()
  propose(@CurrentUser() user: AuthUserPayload, @Param('id', ParseIntPipe) id: number, @Body() dto: ProposeRevisionDto): Promise<unknown> {
    return this.revisions.propose(user.sub, id, dto);
  }
  @Get()
  list(@CurrentUser() user: AuthUserPayload, @Param('id', ParseIntPipe) id: number): Promise<unknown> { return this.revisions.list(user.sub, id); }
  @Get(':rid')
  get(@CurrentUser() user: AuthUserPayload, @Param('id', ParseIntPipe) id: number, @Param('rid') rid: string): Promise<unknown> { return this.revisions.get(user.sub, id, rid); }
  @Post(':rid/confirm')
  confirm(@CurrentUser() user: AuthUserPayload, @Param('id', ParseIntPipe) id: number, @Param('rid') rid: string, @Body() dto: ConfirmRevisionDto): Promise<unknown> { return this.revisions.confirm(user.sub, id, rid, dto.version); }
  @Post(':rid/resume')
  resume(@CurrentUser() user: AuthUserPayload, @Param('id', ParseIntPipe) id: number, @Param('rid') rid: string): Promise<unknown> { return this.revisions.resume(user.sub, id, rid); }
  @Post(':rid/approve-manual')
  approveManual(@CurrentUser() user: AuthUserPayload, @Param('id', ParseIntPipe) id: number, @Param('rid') rid: string, @Body() dto: ApproveManualDto): Promise<unknown> { return this.revisions.approveManual(user.sub, id, rid, dto.chapterVersion); }
  @Post(':rid/stop')
  stop(@CurrentUser() user: AuthUserPayload, @Param('id', ParseIntPipe) id: number, @Param('rid') rid: string): Promise<unknown> { return this.revisions.stop(user.sub, id, rid); }
}
