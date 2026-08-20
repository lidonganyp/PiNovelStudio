/**
 * 认证模块：注册 JwtModule（全局可用）并导出守卫，
 * 供其他模块直接复用 JwtAuthGuard / AdminGuard。
 */
import { Module } from '@nestjs/common';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { LoginRateLimitGuard } from '../../common/guards/login-rate-limit.guard';
import { env } from '../../config/env';

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: env.JWT_SECRET,
      // env 值形如 '7d'；ms 模板字面量类型需显式收窄
      signOptions: { expiresIn: env.JWT_EXPIRES_IN as JwtSignOptions['expiresIn'] },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, AdminGuard, LoginRateLimitGuard],
  exports: [JwtAuthGuard, AdminGuard],
})
export class AuthModule {}
