/**
 * 助手对话 API：历史 + 发消息（JSON 或 SSE）。
 */
import {
  Body,
  Controller,
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
  ): Promise<unknown> {
    return this.assistant.list(user.sub, projectId);
  }

  @Post()
  async post(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) projectId: number,
    @Body() dto: PostAssistantMessageDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    const result = await this.assistant.post(user.sub, projectId, dto.content);
    const accept = request.headers.accept ?? '';
    if (accept.includes('text/event-stream')) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      for (const chunk of result.chunks) {
        reply.raw.write(`data: ${JSON.stringify({ delta: chunk })}\n\n`);
      }
      reply.raw.write(
        `data: ${JSON.stringify({ done: true, message: result.assistantMessage })}\n\n`,
      );
      reply.raw.end();
      return reply;
    }
    return result;
  }
}
