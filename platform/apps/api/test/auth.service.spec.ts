/**
 * AuthService 单元测试：mock PrismaService，验证注册/登录/me 的
 * 正常与异常分支（冲突 409、密码错 401、封禁 401、不存在 404）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import { AuthService } from '../src/modules/auth/auth.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { UserRow } from '../src/modules/auth/auth.types';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

const TEST_PASSWORD = 'Password123';

/** 构造数据库用户行 fixture。 */
async function makeUserRow(
  overrides: Partial<UserRow> = {},
): Promise<UserRow> {
  return {
    id: 1,
    email: 'user@test.local',
    passwordHash: await argon2.hash(TEST_PASSWORD),
    nickname: '测试用户',
    role: 'user',
    status: 'active',
    balance: 0n,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    user: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
    setting: { findUnique: ReturnType<typeof vi.fn> };
  };
  let jwtService: JwtService;

  beforeEach(() => {
    prisma = {
      user: { findUnique: vi.fn(), create: vi.fn() },
      setting: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    jwtService = new JwtService({ secret: 'x'.repeat(64) });
    service = new AuthService(
      prisma as unknown as PrismaService,
      jwtService,
    );
  });

  it('register：邮箱已存在时抛出 ConflictException', async () => {
    prisma.user.findUnique.mockResolvedValue(await makeUserRow());
    await expect(
      service.register({
        email: 'user@test.local',
        password: TEST_PASSWORD,
        nickname: '新用户',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('register：成功时返回 token 与初始余额 0', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue(await makeUserRow());
    const result = await service.register({
      email: 'user@test.local',
      password: TEST_PASSWORD,
      nickname: '新用户',
    });
    expect(typeof result.accessToken).toBe('string');
    expect(result.accessToken.length).toBeGreaterThan(0);
    expect(result.user.email).toBe('user@test.local');
    expect(result.user.balance).toBe('0');
  });

  it('register：registration_enabled=false 时拒绝注册', async () => {
    prisma.setting.findUnique.mockResolvedValue({
      key: 'registration_enabled',
      value: false,
    });

    await expect(
      service.register({
        email: 'closed@test.local',
        password: TEST_PASSWORD,
        nickname: '关闭注册',
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('register：并发邮箱唯一约束冲突时返回 ConflictException', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique email', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.register({
        email: 'race@test.local',
        password: TEST_PASSWORD,
        nickname: '竞态用户',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('login：用户不存在时抛出 UnauthorizedException', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(
      service.login({ email: 'user@test.local', password: TEST_PASSWORD }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('login：密码错误时抛出 UnauthorizedException', async () => {
    prisma.user.findUnique.mockResolvedValue(await makeUserRow());
    await expect(
      service.login({ email: 'user@test.local', password: 'WrongPass123' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('login：账号封禁时抛出 UnauthorizedException', async () => {
    prisma.user.findUnique.mockResolvedValue(
      await makeUserRow({ status: 'banned' }),
    );
    await expect(
      service.login({ email: 'user@test.local', password: TEST_PASSWORD }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('login：成功时返回可校验的 JWT', async () => {
    prisma.user.findUnique.mockResolvedValue(await makeUserRow());
    const result = await service.login({
      email: 'user@test.local',
      password: TEST_PASSWORD,
    });
    const payload = await jwtService.verifyAsync<{
      sub: number;
      email: string;
      role: string;
    }>(result.accessToken);
    expect(payload.sub).toBe(1);
    expect(payload.email).toBe('user@test.local');
    expect(payload.role).toBe('user');
  });

  it('me：用户不存在时抛出 NotFoundException', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.me(999)).rejects.toThrow(NotFoundException);
  });

  it('me：返回用户视图且余额为字符串', async () => {
    prisma.user.findUnique.mockResolvedValue(
      await makeUserRow({ balance: 1250n }),
    );
    const user = await service.me(1);
    expect(user.id).toBe(1);
    expect(user.balance).toBe('1250');
    expect(user).not.toHaveProperty('passwordHash');
  });
});
