/**
 * P8-4 安全自查：把 §11 可静态核对的条款写成断言，防止回归。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INTERNAL_HMAC_WINDOW_MS } from '../src/modules/internal/hmac';
import { env } from '../src/config/env';

function readRepo(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), 'utf8');
}

describe('P8-4 安全清单静态核对', () => {
  it('内部 HMAC 窗口为 5 分钟', () => {
    expect(INTERNAL_HMAC_WINDOW_MS).toBe(5 * 60 * 1000);
  });

  it('JWT / 内部密钥 / AES 主密钥长度门槛与示例对齐', () => {
    const example = readRepo('../../.env.example');
    expect(example).toMatch(/JWT_SECRET=.+/);
    expect(example).toMatch(/INTERNAL_API_SECRET=.+/);
    expect(example).toMatch(/AES_MASTER_KEY=[0-9a-fA-F]{64}/);
    expect(example).toMatch(/NOVEL_TASK_TOKEN_HMAC_KEY=.+/);
    expect(env.JWT_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(env.INTERNAL_API_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(env.AES_MASTER_KEY).toMatch(/^[0-9a-fA-F]{64}$/);
  });

  it('pino 脱敏 Authorization，生产拒绝 stub 支付与 stub runtime', () => {
    const appModule = readRepo('src/app.module.ts');
    expect(appModule).toMatch(/req\.headers\.authorization/);
    expect(appModule).toMatch(/\[REDACTED\]/);
    const envSrc = readRepo('src/config/env.ts');
    expect(envSrc).toMatch(/production requires PAYMENT_MODE=live/);
    expect(envSrc).toMatch(/NOVEL_RUNTIME_MODE/);
  });

  it('登录有 IP 限流守卫；越权走 404 而非 403', () => {
    const authController = readRepo('src/modules/auth/auth.controller.ts');
    expect(authController).toMatch(/LoginRateLimitGuard/);
    const ownership = readRepo('src/common/ownership.ts');
    expect(ownership).toMatch(/NotFoundException/);
    expect(ownership).not.toMatch(/ForbiddenException/);
  });

  it('调账 / 封禁 / 费率 / 设置写入审计', () => {
    const admin = readRepo('src/modules/admin/admin.service.ts');
    expect(admin).toMatch(/action: 'user\.adjust'/);
    expect(admin).toMatch(/action: 'user\.status'/);
    expect(admin).toMatch(/action: 'rate\.create'/);
    expect(admin).toMatch(/action: 'settings\.put'/);
  });
});
