/**
 * 登录接口 IP 滑动窗口限流（§11.9）。测试环境放宽配额，避免并行 e2e 误伤。
 */
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { env } from '../../config/env';
import { SlidingWindowLimiter } from '../rate-limit/sliding-window';

const WINDOW_MS = 60_000;
const PROD_LIMIT = 20;
const TEST_LIMIT = 10_000;

@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  private readonly limiter = new SlidingWindowLimiter(
    env.NODE_ENV === 'production' ? PROD_LIMIT : TEST_LIMIT,
    WINDOW_MS,
  );

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const ip = clientIp(request);
    if (!this.limiter.tryConsume(ip)) {
      throw new HttpException('登录尝试过于频繁，请稍后再试', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}

function clientIp(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return request.ip || '127.0.0.1';
}
