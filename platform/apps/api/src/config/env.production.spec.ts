/**
 * 生产环境配置安全门禁：真实生产不得启用可自增余额的 stub 支付。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

afterEach(() => {
  vi.resetModules();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    process.env[key] = value;
  }
});

describe('production environment payment safety', () => {
  it('refuses to boot with stub payment mode', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_MODE = 'stub';

    await expect(import('./env')).rejects.toThrow(/PAYMENT_MODE.*live/i);
  });

  it('refuses production when the billing route set omits the editorial route', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_MODE = 'live';
    process.env.NOVEL_RUNTIME_MODE = 'http';
    process.env.NOVEL_BILLING_REQUIRED_MODELS = 'v2_rawstage2_gemini31';
    process.env.PLANNER_MODE = 'disabled';
    process.env.JWT_SECRET = 'production-jwt-secret-012345678901234567890';
    process.env.INTERNAL_API_SECRET = 'production-internal-secret-012345678901234';
    process.env.NOVEL_TASK_TOKEN_HMAC_KEY = 'production-task-token-secret-012345678';
    process.env.AES_MASTER_KEY = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    process.env.PAYMENT_NOTIFY_BASE_URL = 'https://pay.example.com';
    process.env.CORS_ORIGINS = 'https://app.example.com';
    process.env.ALIPAY_APP_ID = '2026000000000000';
    process.env.ALIPAY_PRIVATE_KEY = 'private-key';
    process.env.ALIPAY_PUBLIC_KEY = 'public-key';

    await expect(import('./env')).rejects.toThrow(/exact runtime billing model routes/i);
  });

  it('refuses the checked-in development secrets', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_MODE = 'live';
    process.env.JWT_SECRET = 'dev-only-jwt-secret-change-me-0123456789abcdef';

    await expect(import('./env')).rejects.toThrow(/development secret/i);
  });

  it('refuses live mode without a complete payment channel and public HTTPS notify URL', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_MODE = 'live';
    process.env.NOVEL_RUNTIME_MODE = 'http';
    process.env.NOVEL_BILLING_REQUIRED_MODELS = 'v2_rawstage2_gemini31,v2_amplified_gemini31';
    process.env.PLANNER_MODE = 'disabled';
    process.env.JWT_SECRET = 'production-jwt-secret-012345678901234567890';
    process.env.INTERNAL_API_SECRET = 'production-internal-secret-012345678901234';
    process.env.NOVEL_TASK_TOKEN_HMAC_KEY = 'production-task-token-secret-012345678';
    process.env.AES_MASTER_KEY = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    process.env.PAYMENT_NOTIFY_BASE_URL = 'http://127.0.0.1:3000';

    await expect(import('./env')).rejects.toThrow(/payment channel|HTTPS notify/i);
  });

  it('accepts live mode with one complete Alipay channel and HTTPS notify URL', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_MODE = 'live';
    process.env.NOVEL_RUNTIME_MODE = 'http';
    process.env.NOVEL_BILLING_REQUIRED_MODELS = 'v2_rawstage2_gemini31,v2_amplified_gemini31';
    process.env.PLANNER_MODE = 'disabled';
    process.env.JWT_SECRET = 'production-jwt-secret-012345678901234567890';
    process.env.INTERNAL_API_SECRET = 'production-internal-secret-012345678901234';
    process.env.NOVEL_TASK_TOKEN_HMAC_KEY = 'production-task-token-secret-012345678';
    process.env.AES_MASTER_KEY = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    process.env.PAYMENT_NOTIFY_BASE_URL = 'https://pay.example.com';
    process.env.CORS_ORIGINS = 'https://app.example.com';
    process.env.ALIPAY_APP_ID = '2026000000000000';
    process.env.ALIPAY_PRIVATE_KEY = 'private-key';
    process.env.ALIPAY_PUBLIC_KEY = 'public-key';

    await expect(import('./env')).resolves.toMatchObject({
      env: {
        PAYMENT_MODE: 'live',
        PAYMENT_NOTIFY_BASE_URL: 'https://pay.example.com',
      },
    });
  });

  it('refuses production localhost or non-HTTPS CORS origins', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_MODE = 'live';
    process.env.NOVEL_RUNTIME_MODE = 'http';
    process.env.NOVEL_BILLING_REQUIRED_MODELS = 'v2_rawstage2_gemini31,v2_amplified_gemini31';
    process.env.PLANNER_MODE = 'disabled';
    process.env.JWT_SECRET = 'production-jwt-secret-012345678901234567890';
    process.env.INTERNAL_API_SECRET = 'production-internal-secret-012345678901234';
    process.env.NOVEL_TASK_TOKEN_HMAC_KEY = 'production-task-token-secret-012345678';
    process.env.AES_MASTER_KEY = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    process.env.PAYMENT_NOTIFY_BASE_URL = 'https://pay.example.com';
    process.env.CORS_ORIGINS = 'http://localhost:5173';
    process.env.ALIPAY_APP_ID = '2026000000000000';
    process.env.ALIPAY_PRIVATE_KEY = 'private-key';
    process.env.ALIPAY_PUBLIC_KEY = 'public-key';

    await expect(import('./env')).rejects.toThrow(/CORS_ORIGINS.*HTTPS/i);
  });

  it('refuses private-network and link-local CORS origins in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_MODE = 'live';
    process.env.NOVEL_RUNTIME_MODE = 'http';
    process.env.NOVEL_BILLING_REQUIRED_MODELS = 'v2_rawstage2_gemini31,v2_amplified_gemini31';
    process.env.PLANNER_MODE = 'disabled';
    process.env.JWT_SECRET = 'production-jwt-secret-012345678901234567890';
    process.env.INTERNAL_API_SECRET = 'production-internal-secret-012345678901234';
    process.env.NOVEL_TASK_TOKEN_HMAC_KEY = 'production-task-token-secret-012345678';
    process.env.AES_MASTER_KEY = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    process.env.PAYMENT_NOTIFY_BASE_URL = 'https://pay.example.com';
    process.env.CORS_ORIGINS = 'https://10.0.0.25,https://[fe80::1]';
    process.env.ALIPAY_APP_ID = '2026000000000000';
    process.env.ALIPAY_PRIVATE_KEY = 'private-key';
    process.env.ALIPAY_PUBLIC_KEY = 'public-key';

    await expect(import('./env')).rejects.toThrow(/CORS_ORIGINS.*HTTPS/i);
  });

  it('refuses compressed and IPv4-mapped private IPv6 CORS origins', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_MODE = 'live';
    process.env.NOVEL_RUNTIME_MODE = 'http';
    process.env.NOVEL_BILLING_REQUIRED_MODELS = 'v2_rawstage2_gemini31,v2_amplified_gemini31';
    process.env.PLANNER_MODE = 'disabled';
    process.env.JWT_SECRET = 'production-jwt-secret-012345678901234567890';
    process.env.INTERNAL_API_SECRET = 'production-internal-secret-012345678901234';
    process.env.NOVEL_TASK_TOKEN_HMAC_KEY = 'production-task-token-secret-012345678';
    process.env.AES_MASTER_KEY = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    process.env.PAYMENT_NOTIFY_BASE_URL = 'https://pay.example.com';
    process.env.CORS_ORIGINS = 'https://[::],https://[::ffff:10.0.0.25]';
    process.env.ALIPAY_APP_ID = '2026000000000000';
    process.env.ALIPAY_PRIVATE_KEY = 'private-key';
    process.env.ALIPAY_PUBLIC_KEY = 'public-key';

    await expect(import('./env')).rejects.toThrow(/CORS_ORIGINS.*HTTPS/i);
  });

  it('refuses a non-HTTPS Alipay gateway in live production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_MODE = 'live';
    process.env.NOVEL_RUNTIME_MODE = 'http';
    process.env.NOVEL_BILLING_REQUIRED_MODELS = 'v2_rawstage2_gemini31,v2_amplified_gemini31';
    process.env.PLANNER_MODE = 'disabled';
    process.env.JWT_SECRET = 'production-jwt-secret-012345678901234567890';
    process.env.INTERNAL_API_SECRET = 'production-internal-secret-012345678901234';
    process.env.NOVEL_TASK_TOKEN_HMAC_KEY = 'production-task-token-secret-012345678';
    process.env.AES_MASTER_KEY = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    process.env.PAYMENT_NOTIFY_BASE_URL = 'https://pay.example.com';
    process.env.CORS_ORIGINS = 'https://app.example.com';
    process.env.ALIPAY_APP_ID = '2026000000000000';
    process.env.ALIPAY_PRIVATE_KEY = 'private-key';
    process.env.ALIPAY_PUBLIC_KEY = 'public-key';
    process.env.ALIPAY_GATEWAY = 'http://alipay.example.com/gateway.do';

    await expect(import('./env')).rejects.toThrow(/ALIPAY_GATEWAY.*HTTPS/i);
  });

  it('refuses a local payment notify endpoint in live production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_MODE = 'live';
    process.env.NOVEL_RUNTIME_MODE = 'http';
    process.env.NOVEL_BILLING_REQUIRED_MODELS = 'v2_rawstage2_gemini31,v2_amplified_gemini31';
    process.env.PLANNER_MODE = 'disabled';
    process.env.JWT_SECRET = 'production-jwt-secret-012345678901234567890';
    process.env.INTERNAL_API_SECRET = 'production-internal-secret-012345678901234';
    process.env.NOVEL_TASK_TOKEN_HMAC_KEY = 'production-task-token-secret-012345678';
    process.env.AES_MASTER_KEY = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    process.env.PAYMENT_NOTIFY_BASE_URL = 'https://127.0.0.1:3000';
    process.env.CORS_ORIGINS = 'https://app.example.com';
    process.env.ALIPAY_APP_ID = '2026000000000000';
    process.env.ALIPAY_PRIVATE_KEY = 'private-key';
    process.env.ALIPAY_PUBLIC_KEY = 'public-key';

    await expect(import('./env')).rejects.toThrow(/PAYMENT_NOTIFY_BASE_URL.*public/i);
  });

  it('refuses production stub planner but allows http with credentials', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_MODE = 'live';
    process.env.NOVEL_RUNTIME_MODE = 'http';
    process.env.NOVEL_BILLING_REQUIRED_MODELS = 'v2_rawstage2_gemini31,v2_amplified_gemini31';
    process.env.JWT_SECRET = 'production-jwt-secret-012345678901234567890';
    process.env.INTERNAL_API_SECRET = 'production-internal-secret-012345678901234';
    process.env.NOVEL_TASK_TOKEN_HMAC_KEY = 'production-task-token-secret-012345678';
    process.env.AES_MASTER_KEY = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    process.env.PAYMENT_NOTIFY_BASE_URL = 'https://pay.example.com';
    process.env.CORS_ORIGINS = 'https://app.example.com';
    process.env.ALIPAY_APP_ID = '2026000000000000';
    process.env.ALIPAY_PRIVATE_KEY = 'private-key';
    process.env.ALIPAY_PUBLIC_KEY = 'public-key';
    process.env.PLANNER_MODE = 'stub';
    await expect(import('./env')).rejects.toThrow(/forbids PLANNER_MODE=stub/);

    vi.resetModules();
    process.env.PLANNER_MODE = 'http';
    process.env.PLANNER_API_BASE_URL = 'https://api.openai.com/v1';
    process.env.PLANNER_API_KEY = 'sk-live-planner';
    await expect(import('./env')).resolves.toMatchObject({
      env: { PLANNER_MODE: 'http' },
    });
  });
});
