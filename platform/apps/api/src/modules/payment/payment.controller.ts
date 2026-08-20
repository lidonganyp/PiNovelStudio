/**
 * 用户充值与渠道异步通知。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../auth/auth.types';
import { env } from '../../config/env';
import { CreatePaymentOrderDto } from './dto/create-order.dto';
import { PaymentService } from './payment.service';

@Controller('payment')
export class PaymentController {
  constructor(private readonly payment: PaymentService) {}

  @Post('orders')
  @UseGuards(JwtAuthGuard)
  async create(
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: CreatePaymentOrderDto,
  ): Promise<Record<string, unknown>> {
    const order = await this.payment.createOrder({
      userId: user.sub,
      channel: dto.channel,
      amountFen: BigInt(dto.amount),
    });
    return this.payment.serialize(order);
  }

  @Get('orders/:orderNo')
  @UseGuards(JwtAuthGuard)
  async get(
    @CurrentUser() user: AuthUserPayload,
    @Param('orderNo') orderNo: string,
  ): Promise<Record<string, unknown>> {
    const order = await this.payment.getOrder(user.sub, orderNo);
    return this.payment.serialize(order);
  }

  /** stub 模式：登录用户对自己的订单模拟渠道通知。 */
  @Post('orders/:orderNo/simulate')
  @UseGuards(JwtAuthGuard)
  async simulate(
    @CurrentUser() user: AuthUserPayload,
    @Param('orderNo') orderNo: string,
  ): Promise<unknown> {
    if (env.PAYMENT_MODE !== 'stub') {
      throw new BadRequestException('仅 stub 模式允许模拟支付');
    }
    const order = await this.payment.getOrder(user.sub, orderNo);
    return this.payment.handleNotify(order.channel, {
      body: {
        orderNo: order.orderNo,
        amount: Number(order.amount),
        tradeNo: `SIM-${order.orderNo}`,
      },
      headers: { 'x-payment-stub-secret': env.PAYMENT_STUB_SECRET },
    });
  }

  @Post('notify/:channel')
  @HttpCode(200)
  async notify(
    @Param('channel') channel: string,
    @Body() body: unknown,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody?.toString('utf8');
    const result = await this.payment.handleNotify(channel, { body, headers, rawBody });
    if (env.PAYMENT_MODE === 'live') {
      if (channel === 'alipay') {
        reply.type('text/plain; charset=utf-8');
        return 'success';
      }
      return { code: 'SUCCESS', message: '成功' };
    }
    return result;
  }
}
