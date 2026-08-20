/**
 * 大纲树 API。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../auth/auth.types';
import {
  CreateOutlineNodeDto,
  OutlineService,
  UpdateOutlineNodeDto,
} from './outline.service';

@Controller('projects/:id/outline')
@UseGuards(JwtAuthGuard)
export class OutlineController {
  constructor(private readonly outline: OutlineService) {}

  @Get()
  tree(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
  ): Promise<unknown> {
    return this.outline.tree(user.sub, projectId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Body() dto: CreateOutlineNodeDto,
  ): Promise<unknown> {
    return this.outline.create(user.sub, projectId, dto);
  }

  @Patch(':nodeId')
  update(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('nodeId', ParseIntPipe) nodeId: number,
    @Body() dto: UpdateOutlineNodeDto,
  ): Promise<unknown> {
    return this.outline.update(user.sub, projectId, nodeId, dto);
  }

  @Delete(':nodeId')
  remove(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('nodeId', ParseIntPipe) nodeId: number,
  ): Promise<unknown> {
    return this.outline.remove(user.sub, projectId, nodeId);
  }
}
