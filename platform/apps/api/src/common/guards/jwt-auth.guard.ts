/**
 * JWT 认证守卫：解析 Authorization: Bearer <token>，校验签名并挂载
 * request.user（AuthUserPayload）。校验失败统一 401。
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthUserPayload } from '../../modules/auth/auth.types';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  /** 校验请求携带的 JWT，通过后把 payload 挂到 request.user。 */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('缺少访问令牌');
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedException('访问令牌为空');
    }

    try {
      const payload = await this.jwtService.verifyAsync<AuthUserPayload>(token);
      if (!Number.isInteger(payload.sub) || payload.sub <= 0) {
        throw new UnauthorizedException('访问令牌用户无效');
      }
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, role: true, status: true },
      });
      if (!user || user.status !== 'active') {
        throw new UnauthorizedException('账号不存在或已被封禁');
      }
      (request as { user?: AuthUserPayload }).user = {
        sub: user.id,
        email: user.email,
        role: user.role,
      };
      return true;
    } catch (error: unknown) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('访问令牌无效或已过期');
    }
  }
}
