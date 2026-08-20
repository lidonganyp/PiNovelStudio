/**
 * 管理员守卫：在 JWT 认证通过的基础上，要求用户角色为 admin，
 * 否则 403。供管理端接口统一使用。
 */
import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { FastifyRequest } from 'fastify';
import type { AuthUserPayload } from '../../modules/auth/auth.types';

@Injectable()
export class AdminGuard extends JwtAuthGuard {
  /** JWT 校验通过后追加 admin 角色检查。 */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const authenticated = await super.canActivate(context);
    if (!authenticated) {
      return false;
    }

    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AuthUserPayload }>();
    if (request.user?.role !== 'admin') {
      throw new ForbiddenException('需要管理员权限');
    }
    return true;
  }
}
