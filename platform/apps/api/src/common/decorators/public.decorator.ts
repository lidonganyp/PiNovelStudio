/**
 * 公开接口装饰器：标记无需 JWT 认证的路由（如 health、登录注册）。
 * 供 JwtAuthGuard 通过 Reflector 识别跳过校验。
 */
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** 标记当前路由为公开接口。 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
