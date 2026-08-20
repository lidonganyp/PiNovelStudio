/**
 * 模块说明：环境变量 zod 校验与类型导出。
 * 所有 env 读取必须经由此模块；校验失败直接终止启动（fail-fast）。
 */
import { z } from 'zod';
import { isIP } from 'node:net';

function isNonPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (isIP(host) === 4) return isNonPublicIpv4(host);
  if (isIP(host) === 6) return isNonPublicIpv6(host);
  return false;
}

function isNonPublicIpv4(host: string): boolean {
  const octets = host.split('.').map((part) => Number(part));
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = octets;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return true;
}

function isNonPublicIpv6(host: string): boolean {
  const normalized = normalizeIpv6(host);
  if (!normalized) return true;
  const firstByte = Number.parseInt(normalized.slice(0, 2), 16);
  const firstTwelveBits = Number.parseInt(normalized.slice(0, 3), 16);
  if (normalized === '0'.repeat(32) || normalized === `${'0'.repeat(31)}1`) return true;
  // fc00::/7 unique-local and fe80::/10 link-local ranges.
  if ((firstByte & 0xfe) === 0xfc || (firstTwelveBits & 0xffc) === 0xfe8) return true;
  // IPv4-mapped and IPv4-compatible IPv6 addresses inherit the IPv4 boundary.
  const mappedPrefix = `${'0'.repeat(20)}ffff`;
  if (normalized.startsWith(mappedPrefix)) {
    const hex = normalized.slice(24);
    const ipv4 = [0, 2, 4, 6].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).join('.');
    return isNonPublicIpv4(ipv4);
  }
  if (normalized.startsWith('0'.repeat(24))) return true;
  // Documentation and benchmarking ranges are not deployable browser origins.
  return normalized.startsWith('20010db8') || normalized.startsWith('20010002') || normalized.startsWith('20010010');
}

function normalizeIpv6(host: string): string | null {
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const expand = (value: string): string[] => {
    if (!value) return [];
    const parts = value.split(':');
    const last = parts.at(-1) ?? '';
    if (last.includes('.')) {
      const octets = last.split('.').map(Number);
      if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return [];
      parts.splice(-1, 1, ((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16));
    }
    return parts;
  };
  const left = expand(halves[0] ?? '');
  const right = halves.length === 2 ? expand(halves[1] ?? '') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const parts = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  return parts.map((part) => part.padStart(4, '0')).join('').toLowerCase();
}

/** The unified production pipeline always settles both durable writer stages. */
export const PRODUCTION_BILLING_MODEL_ROUTES = [
  'v2_rawstage2_gemini31',
  'v2_amplified_gemini31',
] as const;

const envSchema = z
  .object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  INTERNAL_API_SECRET: z
    .string()
    .min(32, 'INTERNAL_API_SECRET must be at least 32 characters'),
  AES_MASTER_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'AES_MASTER_KEY must be 64 hex characters'),
  NOVEL_TASK_TOKEN_HMAC_KEY: z
    .string()
    .min(32, 'NOVEL_TASK_TOKEN_HMAC_KEY must be at least 32 characters'),
  NOVEL_RUNTIME_MODE: z.enum(['stub', 'http']).default('stub'),
  NOVEL_RUNTIME_BASE_URL: z.string().default('http://127.0.0.1:3100'),
  NOVEL_RUNTIME_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  /** Exact model-route keys that runtime may settle for a production chapter. */
  NOVEL_BILLING_REQUIRED_MODELS: z.string().default(''),
  PLANNER_MODE: z.enum(['stub', 'http', 'disabled']).default('stub'),
  PLANNER_API_BASE_URL: z.string().default(''),
  PLANNER_API_KEY: z.string().default(''),
  PLANNER_MODEL: z.string().default('gpt-5.6'),
  WEB_DIST_DIR: z.string().default(''),
  STUB_WRITER_MODEL: z.string().default('stub-writer'),
  PAYMENT_MODE: z.enum(['stub', 'live']).default('stub'),
  PAYMENT_STUB_SECRET: z
    .string()
    .min(32)
    .default('dev-only-payment-stub-secret-0123456789ab'),
  PAYMENT_ORDER_EXPIRE_MINUTES: z.coerce.number().int().positive().default(30),
  PAYMENT_NOTIFY_BASE_URL: z.string().default('http://127.0.0.1:3000'),
  ALIPAY_NOTIFY_URL: z.string().default(''),
  PAYMENT_RETURN_URL: z.string().default(''),
  PAYMENT_SUBJECT: z.string().default('星辰小说AI助手'),
  ALIPAY_APP_ID: z.string().default(''),
  ALIPAY_PRIVATE_KEY: z.string().default(''),
  ALIPAY_PUBLIC_KEY: z.string().default(''),
  ALIPAY_GATEWAY: z
    .string()
    .default('https://openapi.alipay.com/gateway.do'),
  WECHAT_APP_ID: z.string().default(''),
  WECHAT_MCH_ID: z.string().default(''),
  WECHAT_SERIAL_NO: z.string().default(''),
  WECHAT_PRIVATE_KEY: z.string().default(''),
  WECHAT_API_V3_KEY: z.string().default(''),
    WECHAT_PLATFORM_CERT: z.string().default(''),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === 'production' && value.PAYMENT_MODE !== 'live') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYMENT_MODE'],
        message: 'production requires PAYMENT_MODE=live',
      });
    }
    if (value.NODE_ENV === 'production' && value.NOVEL_RUNTIME_MODE !== 'http') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NOVEL_RUNTIME_MODE'],
        message: 'production requires NOVEL_RUNTIME_MODE=http',
      });
    }
    const configuredBillingRoutes = value.NOVEL_BILLING_REQUIRED_MODELS
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean);
    const configuredBillingRouteSet = new Set(configuredBillingRoutes);
    const hasExactProductionBillingRoutes =
      configuredBillingRouteSet.size === PRODUCTION_BILLING_MODEL_ROUTES.length &&
      PRODUCTION_BILLING_MODEL_ROUTES.every((route) => configuredBillingRouteSet.has(route));
    if (value.NODE_ENV === 'production' && !hasExactProductionBillingRoutes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NOVEL_BILLING_REQUIRED_MODELS'],
        message: 'production requires the exact runtime billing model routes',
      });
    }
    if (value.NODE_ENV === 'production' && value.PLANNER_MODE === 'stub') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PLANNER_MODE'],
        message: 'production forbids PLANNER_MODE=stub',
      });
    }
    if (
      value.NODE_ENV === 'production' &&
      value.PLANNER_MODE === 'http' &&
      (!value.PLANNER_API_BASE_URL.trim() || !value.PLANNER_API_KEY.trim())
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PLANNER_MODE'],
        message: 'production PLANNER_MODE=http requires PLANNER_API_BASE_URL and PLANNER_API_KEY',
      });
    }
    if (value.NODE_ENV === 'production') {
      const corsOrigins = value.CORS_ORIGINS
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
      if (
        corsOrigins.length === 0 ||
        corsOrigins.some((origin) => {
          try {
            const parsed = new URL(origin);
            return parsed.protocol !== 'https:' ||
              isNonPublicHostname(parsed.hostname);
          } catch {
            return true;
          }
        })
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ORIGINS'],
          message: 'production requires explicit public HTTPS CORS origins',
        });
      }
      const developmentSecrets = [
        ['JWT_SECRET', value.JWT_SECRET],
        ['INTERNAL_API_SECRET', value.INTERNAL_API_SECRET],
        ['NOVEL_TASK_TOKEN_HMAC_KEY', value.NOVEL_TASK_TOKEN_HMAC_KEY],
      ] as const;
      for (const [name, secret] of developmentSecrets) {
        if (secret.startsWith('dev-only-') || secret.includes('change-me')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message: 'production must not use a development secret',
          });
        }
      }
      if (/^(0123456789abcdef)+$/i.test(value.AES_MASTER_KEY)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AES_MASTER_KEY'],
          message: 'production must not use the example AES master key',
        });
      }

      if (value.PAYMENT_MODE === 'live') {
        let notifyUrl: URL | undefined;
        try {
          notifyUrl = new URL(value.PAYMENT_NOTIFY_BASE_URL);
        } catch {
          // The more useful issue below is emitted with the same stable path.
        }
        if (!notifyUrl || notifyUrl.protocol !== 'https:' || isNonPublicHostname(notifyUrl.hostname)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['PAYMENT_NOTIFY_BASE_URL'],
            message: 'live payment requires a public HTTPS notify URL',
          });
        }

        const alipayConfigured = Boolean(
          value.ALIPAY_APP_ID && value.ALIPAY_PRIVATE_KEY && value.ALIPAY_PUBLIC_KEY,
        );
        const wechatConfigured = Boolean(
          value.WECHAT_APP_ID &&
            value.WECHAT_MCH_ID &&
            value.WECHAT_SERIAL_NO &&
            value.WECHAT_PRIVATE_KEY &&
            value.WECHAT_API_V3_KEY &&
            value.WECHAT_PLATFORM_CERT,
        );
        if (alipayConfigured) {
          let alipayGatewayUrl: URL | undefined;
          try {
            alipayGatewayUrl = new URL(value.ALIPAY_GATEWAY);
          } catch {
            // Emit the stable configuration error below.
          }
          if (!alipayGatewayUrl || alipayGatewayUrl.protocol !== 'https:') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['ALIPAY_GATEWAY'],
              message: 'live payment requires an HTTPS ALIPAY_GATEWAY',
            });
          }
        }
        if (!alipayConfigured && !wechatConfigured) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['PAYMENT_MODE'],
            message: 'live payment requires one complete Alipay or WeChat merchant channel',
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment variables: ${issues}`);
  }
  return parsed.data;
}

export const env: Env = parseEnv();
