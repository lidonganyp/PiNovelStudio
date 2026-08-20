/**
 * 内部 API HMAC 守卫：校验 X-Internal-Timestamp / X-Internal-Signature，
 * 5 分钟窗口防重放。失败统一 401，不区分具体原因以免被探测。
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import {
  INTERNAL_HMAC_WINDOW_MS,
  stableStringify,
  verifyInternalSignature,
} from './hmac';

@Injectable()
export class HmacGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  /** 校验内部请求签名。 */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const timestamp = request.headers['x-internal-timestamp'];
    const signature = request.headers['x-internal-signature'];
    const nonce = request.headers['x-internal-nonce'];
    if (typeof timestamp !== 'string' || typeof signature !== 'string' || typeof nonce !== 'string') {
      throw new UnauthorizedException('缺少内部签名');
    }
    const path = (request.url ?? '').split('?')[0] ?? '';
    const result = verifyInternalSignature({
      secret: env.INTERNAL_API_SECRET,
      timestamp,
      method: request.method,
      path,
      body: stableStringify(request.body),
      nonce,
      signature,
    });
    if (!result.ok) {
      throw new UnauthorizedException('内部签名无效');
    }
    try {
      await this.prisma.internalRequestNonce.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      await this.prisma.internalRequestNonce.create({
        data: {
          nonce,
          expiresAt: new Date(Number(timestamp) * 1000 + INTERNAL_HMAC_WINDOW_MS),
        },
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new UnauthorizedException('鍐呴儴绛惧悕鏃犳晥');
      }
      throw error;
    }
    return true;
  }
}
