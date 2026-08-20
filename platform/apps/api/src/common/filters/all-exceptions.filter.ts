/**
 * 全局异常过滤器：HttpException 按原状态码透传；未知异常统一 500，
 * 并通过 pino logger 记录完整堆栈，避免敏感细节泄漏到响应体。
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  /** 统一异常出口：写日志并转换为结构化 JSON 响应。 */
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      void response.status(status).send(
        typeof body === 'string'
          ? { statusCode: status, message: body }
          : body,
      );
      return;
    }

    const error =
      exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(
      `未处理异常: ${error.message}`,
      error.stack,
    );
    void response.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: '服务器内部错误',
    });
  }
}
