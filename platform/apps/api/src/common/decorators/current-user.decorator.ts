/**
 * 当前用户参数装饰器：从 request.user 取出 JWT 载荷，供控制器签名
 * `@CurrentUser() user: AuthUserPayload` 使用。
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthUserPayload } from '../../modules/auth/auth.types';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUserPayload => {
    const request = ctx.switchToHttp().getRequest<
      FastifyRequest & { user?: AuthUserPayload }
    >();
    if (!request.user) {
      throw new Error('当前路由未受 JwtAuthGuard 保护，无法获取用户信息');
    }
    return request.user;
  },
);
