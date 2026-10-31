/**
 * 作者章纲契约控制器（EXPERT-HOST-HANDOFF-1）
 *
 * 只对已登录作者开放；agent 工具面触达不到。
 * - POST /projects/:id/chapter-contract/preview：校验并返回 proposalHash / 规范化章纲
 * - POST /projects/:id/chapter-contract/commit：审批签发 receipt → handoff commit → 落库
 */
import {
  Body,
  Controller,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../auth/auth.types';
import {
  ChapterContractService,
  type ChapterContractCommitResult,
  type ChapterContractPreviewResult,
} from './chapter-contract.service';

export class PreviewChapterContractDto {
  @IsInt()
  @Min(1)
  chapterNumber!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  proposalText!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  expertRole?: string;
}

export class CommitChapterContractDto extends PreviewChapterContractDto {
  @IsOptional()
  @IsBoolean()
  overwrite?: boolean;
}

@Controller('projects/:id/chapter-contract')
@UseGuards(JwtAuthGuard)
export class ChapterContractController {
  constructor(private readonly contracts: ChapterContractService) {}

  @Post('preview')
  preview(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PreviewChapterContractDto,
  ): Promise<ChapterContractPreviewResult> {
    return this.contracts.preview(user, id, dto);
  }

  @Post('commit')
  commit(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CommitChapterContractDto,
  ): Promise<ChapterContractCommitResult> {
    return this.contracts.commit(user, id, dto);
  }
}
