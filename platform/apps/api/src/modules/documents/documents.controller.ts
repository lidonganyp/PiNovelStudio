/**
 * 设定文档 API。
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
  CreateDocumentDto,
  DocumentsService,
  UpdateDocumentDto,
} from './documents.service';

@Controller('projects/:id/documents')
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
  ): Promise<unknown> {
    return this.documents.list(user.sub, projectId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Body() dto: CreateDocumentDto,
  ): Promise<unknown> {
    return this.documents.create(user.sub, projectId, dto);
  }

  @Get(':documentId')
  get(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('documentId', ParseIntPipe) documentId: number,
  ): Promise<unknown> {
    return this.documents.get(user.sub, projectId, documentId);
  }

  @Patch(':documentId')
  update(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('documentId', ParseIntPipe) documentId: number,
    @Body() dto: UpdateDocumentDto,
  ): Promise<unknown> {
    return this.documents.update(user.sub, projectId, documentId, dto);
  }

  @Delete(':documentId')
  remove(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('documentId', ParseIntPipe) documentId: number,
  ): Promise<unknown> {
    return this.documents.remove(user.sub, projectId, documentId);
  }
}
