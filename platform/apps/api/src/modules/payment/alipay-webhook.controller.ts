/**
 * 支付宝异步通知：路径对齐 sub2api / 商户后台已登记地址
 * POST /api/v1/payment/webhook/alipay
 */
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PaymentService } from './payment.service';

@Controller('v1/payment/webhook')
export class AlipayWebhookController {
  constructor(private readonly payment: PaymentService) {}

  @Post('alipay')
  @HttpCode(200)
  async alipay(
    @Body() body: unknown,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody?.toString('utf8');
    await this.payment.handleNotify('alipay', { body, headers, rawBody });
    reply.type('text/plain; charset=utf-8');
    return 'success';
  }
}
