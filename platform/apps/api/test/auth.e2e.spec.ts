/**
 * 认证链路 e2e 测试（Fastify inject，真实数据库）。
 * 前置条件：docker compose 起 postgres（pnpm dev:db）且已执行 migrate。
 * 覆盖：health -> 注册 -> me -> 非 admin 访问 admin 403 -> 登录 ->
 * 重复注册 409 -> 无 token 访问受保护接口 401。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { configureHttpApp } from '../src/configure-http';
import { PrismaService } from '../src/prisma/prisma.service';

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const email = `e2e-${runId}@test.local`;
const password = 'Password123';

describe('认证链路 e2e', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication(
      new FastifyAdapter({ bodyLimit: 2 * 1024 * 1024 }),
    );
    configureHttpApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    // 清理本测试运行创建的数据，保证可重复执行
    await prisma.user.deleteMany({
      where: { email: { contains: runId } },
    });
    await app.close();
  });

  it('GET /api/health 返回 200 ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('注册 -> 返回 token 与初始余额 0', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password, nickname: 'e2e用户' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.accessToken).toBe('string');
    expect(body.user.email).toBe(email);
    expect(body.user.balance).toBe('0');
  });

  it('重复注册同一邮箱返回 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password, nickname: 'e2e用户' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('携带 token 访问 /api/auth/me 返回当前用户', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    expect(loginRes.statusCode).toBe(201);
    const token = loginRes.json().accessToken as string;

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe(email);
  });

  it('rejects an existing token immediately after its user is banned', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    expect(loginRes.statusCode).toBe(201);
    const token = loginRes.json().accessToken as string;

    await prisma.user.update({
      where: { email },
      data: { status: 'banned' },
    });

    const rejected = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });

    await prisma.user.update({
      where: { email },
      data: { status: 'active' },
    });

    expect(rejected.statusCode).toBe(401);
  });

  it('无 token 访问 /api/auth/me 返回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('登录密码错误返回 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'WrongPass123' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('普通用户访问 /api/admin/ping 返回 403', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    const token = loginRes.json().accessToken as string;

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/ping',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('非法 token 访问受保护接口返回 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: 'Bearer not-a-valid-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('登录用户可修改密码，旧密码立即失效', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    const token = loginRes.json().accessToken as string;
    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: password, newPassword: 'Password456' },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ ok: true });
    expect(changed.json()).not.toHaveProperty('passwordHash');

    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'Password456' },
    });
    expect(newLogin.statusCode).toBe(201);
  });

  it('当前密码错误时修改密码返回 400 且保持登录态', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'Password456' },
    });
    expect(loginRes.statusCode).toBe(201);
    const token = loginRes.json().accessToken as string;
    const failed = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: password, newPassword: 'Password789' },
    });
    expect(failed.statusCode).toBe(400);
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('无 token 修改密码返回 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { currentPassword: password, newPassword: 'Password456' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('注册请求缺字段时返回 400（ValidationPipe 生效）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: `bad-${runId}@test.local`, password: 'Password123' },
    });
    expect(res.statusCode).toBe(400);
  });
});
