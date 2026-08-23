/**
 * 认证控制器：POST /api/auth/register、POST /api/auth/login、
 * GET /api/auth/me、POST /api/auth/password（后两者受 JWT 保护）。
 */
import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { LoginRateLimitGuard } from '../../common/guards/login-rate-limit.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUserPayload, AuthResult, PublicUser } from './auth.types';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** 注册新用户。 */
  @Post('register')
  register(@Body() dto: RegisterDto): Promise<AuthResult> {
    return this.authService.register(dto);
  }

  /** 登录（统一 201 语义与 register 一致，简化前端处理）。 */
  @Post('login')
  @HttpCode(201)
  @UseGuards(LoginRateLimitGuard)
  login(@Body() dto: LoginDto): Promise<AuthResult> {
    return this.authService.login(dto);
  }

  /** 当前登录用户信息。 */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUserPayload): Promise<PublicUser> {
    return this.authService.me(user.sub);
  }

  /** 修改当前用户密码。错误当前密码返回 400，避免被前端当成掉登录。 */
  @Post('password')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  changePassword(
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: ChangePasswordDto,
  ): Promise<{ ok: true }> {
    return this.authService.changePassword(user.sub, dto);
  }
}
