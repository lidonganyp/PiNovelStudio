/**
 * 用户门户项目 API：/api/projects。
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
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import type { AuthUserPayload } from '../auth/auth.types';
import { CreateProjectDto, UpdateProjectDto } from './dto/project.dto';
import { ProjectsService } from './projects.service';

@Controller('projects')
@UseGuards(JwtAuthGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUserPayload,
    @Query() query: PaginationDto,
  ): Promise<unknown> {
    return this.projects.list(
      user.sub,
      query.page ?? 1,
      query.pageSize ?? 20,
      query.q,
    );
  }

  @Post()
  create(
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: CreateProjectDto,
  ): Promise<unknown> {
    return this.projects.create(user.sub, dto);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<unknown> {
    return this.projects.get(user.sub, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProjectDto,
  ): Promise<unknown> {
    return this.projects.update(user.sub, id, dto);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<unknown> {
    return this.projects.remove(user.sub, id);
  }
}
