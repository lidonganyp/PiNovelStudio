/**
 * 认证服务：注册（邮箱唯一 + argon2 哈希）、登录（封禁/密码校验）、
 * 当前用户查询、JWT 签发与用户视图转换。
 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  AuthResult,
  AuthUserPayload,
  PublicUser,
  UserRow,
} from './auth.types';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import { isRegistrationClosed } from './registration-gate';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  /** 注册新用户：邮箱冲突返回 409，成功返回 token + 用户视图。 */
  async register(dto: RegisterDto): Promise<AuthResult> {
    const registration = await this.prisma.setting.findUnique({
      where: { key: 'registration_enabled' },
    });
    if (isRegistrationClosed(registration?.value)) {
      throw new ForbiddenException('当前未开放注册');
    }
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException('该邮箱已被注册');
    }

    const passwordHash = await argon2.hash(dto.password);
    let created: UserRow;
    try {
      created = await this.prisma.user.create({
        data: {
          email: dto.email,
          passwordHash,
          nickname: dto.nickname,
        },
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('email already registered');
      }
      throw error;
    }
    return this.issueAuthResult(created);
  }

  /** 登录：封禁 401、密码错误 401，成功返回 token + 用户视图。 */
  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (!user) {
      throw new UnauthorizedException('邮箱或密码错误');
    }
    if (user.status !== 'active') {
      throw new UnauthorizedException('账号已被封禁');
    }

    const passwordValid = await argon2.verify(user.passwordHash, dto.password);
    if (!passwordValid) {
      throw new UnauthorizedException('邮箱或密码错误');
    }
    return this.issueAuthResult(user);
  }

  /** 查询当前登录用户：不存在（已删除）抛 401 促使前端重新登录。 */
  async me(userId: number): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    return this.toPublicUser(user);
  }

  /** 签发 JWT（载荷 sub/email/role）。 */
  private issueToken(user: UserRow): string {
    const payload: AuthUserPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    return this.jwtService.sign(payload);
  }

  /** 组装认证结果：token + 用户视图。 */
  private issueAuthResult(user: UserRow): AuthResult {
    return { accessToken: this.issueToken(user), user: this.toPublicUser(user) };
  }

  /** 数据库行 -> 对外视图（BigInt 余额转字符串）。 */
  private toPublicUser(user: UserRow): PublicUser {
    return {
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      role: user.role,
      status: user.status,
      balance: user.balance.toString(),
      bonusBalance: user.bonusBalance.toString(),
      totalBalance: (user.balance + user.bonusBalance).toString(),
      createdAt: user.createdAt.toISOString(),
    };
  }
}
