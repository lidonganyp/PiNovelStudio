/**
 * 助手对话 API：历史 + 发消息（JSON 或真流式 SSE）。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../auth/auth.types';
import {
  AssistantService,
  PostAssistantMessageDto,
} from './assistant.service';

@Controller('projects/:id/assistant/messages')
@UseGuards(JwtAuthGuard)
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
  ): Promise<unknown[]> {
    return this.assistant.list(user.sub, projectId);
  }

  /** 新建对话：软删除当前项目全部消息，上下文从零开始。 */
  @Delete()
  clear(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
  ): Promise<{ cleared: number }> {
    return this.assistant.clear(user.sub, projectId);
  }

  @Delete(':messageId')
  remove(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('messageId', ParseIntPipe) messageId: number,
  ): Promise<{ ok: true }> {
    return this.assistant.remove(user.sub, projectId, messageId);
  }

  @Post()
  async post(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Body() dto: PostAssistantMessageDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    const wantsSse = (request.headers.accept ?? '').includes('text/event-stream');
    if (!wantsSse) {
      return this.assistant.post(user.sub, projectId, dto.content);
    }

    let started = false;
    const startSse = (): void => {
      if (started) return;
      started = true;
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
    };
    const writeEvent = (payload: Record<string, unknown>): void => {
      startSse();
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      const result = await this.assistant.post(
        user.sub,
        projectId,
        dto.content,
        (delta) => writeEvent({ delta }),
      );
      writeEvent({
        done: true,
        message: result.assistantMessage,
        generationJobId: result.generationJobId,
        artifacts: result.artifacts,
      });
      reply.raw.end();
      return reply;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : '规划模型调用失败，请稍后重试';
      if (started) {
        writeEvent({ error: message });
        reply.raw.end();
        return reply;
      }
      throw error;
    }
  }
}
