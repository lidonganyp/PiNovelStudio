/**
 * PiVideoStudio 视频工场入口（B6 融合）。
 * 章节页『生成视频』按钮的后端：聚合上下文 → 创建 PiVideoStudio 项目。
 */
import { Controller, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../auth/auth.types';
import { PivideoService } from './pivideo.service';

@Controller('projects/:id')
@UseGuards(JwtAuthGuard)
export class PivideoController {
  constructor(private readonly pivideo: PivideoService) {}

  /** 章节发起视频生成：返回 PiVideoStudio 项目 ID 与跳转 URL。 */
  @Post('chapters/:cid/generate-video')
  generateVideo(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('cid', ParseIntPipe) chapterId: number,
    @Req() req: Request,
  ): Promise<unknown> {
    // 透传用户 JWT：PiVideoStudio 与本服务共享 JWT_SECRET，可直接验签
    const authHeader =
      typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    return this.pivideo.generateVideo(user.sub, projectId, chapterId, authHeader);
  }
}
