/**
 * 项目反馈 API。
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsInt, IsOptional, IsString, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../auth/auth.types';
import { FeedbackService } from './feedback.service';

class CreateFeedbackDto {
  @IsString()
  @MinLength(1)
  type!: string;

  @IsString()
  @MinLength(1)
  content!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  chapterId?: number;
}

@Controller('projects/:id/feedback')
@UseGuards(JwtAuthGuard)
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
  ): Promise<unknown> {
    return this.feedback.list(user.sub, projectId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Body() dto: CreateFeedbackDto,
  ): Promise<unknown> {
    return this.feedback.create(user.sub, projectId, dto);
  }
}
