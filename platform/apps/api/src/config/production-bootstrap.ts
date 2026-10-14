/**
 * First-deploy configuration for the production control plane. This is
 * consumed by a short-lived Compose job, not by the long-lived HTTP process.
 */
import { parseAesMasterKey } from '../common/crypto/aes-gcm';
import { resolveSeedAdminCredentials } from './seed-admin';

export interface ProductionBootstrapConfig {
  adminEmail: string;
  adminPassword: string;
  aesMasterKey: string;
  geminiModel: string;
  geminiApiKey: string;
  geminiApiBaseUrl: string;
  inputPricePerMillionFen: bigint;
  outputPricePerMillionFen: bigint;
}

function requireValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} must be explicitly configured`);
  return value;
}

function parsePositiveFen(env: NodeJS.ProcessEnv, key: string): bigint {
  const value = requireValue(env, key);
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error(`${key} price must be a positive integer number of fen`);
  }
  return BigInt(value);
}

export function resolveProductionBootstrapConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProductionBootstrapConfig {
  if (env.NODE_ENV !== 'production') {
    throw new Error('production bootstrap may only run with NODE_ENV=production');
  }
  const { email: adminEmail, password: adminPassword } = resolveSeedAdminCredentials({
    NODE_ENV: env.NODE_ENV,
    SEED_ADMIN_EMAIL: env.BOOTSTRAP_ADMIN_EMAIL,
    SEED_ADMIN_PASSWORD: env.BOOTSTRAP_ADMIN_PASSWORD,
  });
  const aesMasterKey = requireValue(env, 'AES_MASTER_KEY');
  parseAesMasterKey(aesMasterKey);
  // 统一 writer 渠道（P1-1/P1-3）：模型、地址、密钥全部来自部署统一入口派生的
  // 必填变量；不再有 aimagichub 默认地址，也不再把身份绑定到固定的 Gemini 3.8。
  const geminiModel = requireValue(env, 'BOOTSTRAP_GEMINI_MODEL');
  const geminiApiBaseUrl = requireValue(env, 'BOOTSTRAP_GEMINI_API_BASE_URL');
  let parsedGeminiUrl: URL;
  try {
    parsedGeminiUrl = new URL(geminiApiBaseUrl);
  } catch {
    throw new Error('BOOTSTRAP_GEMINI_API_BASE_URL must be a valid HTTPS URL');
  }
  if (parsedGeminiUrl.protocol !== 'https:') {
    throw new Error('BOOTSTRAP_GEMINI_API_BASE_URL must be a valid HTTPS URL');
  }
  return {
    adminEmail,
    adminPassword,
    aesMasterKey,
    geminiModel,
    geminiApiKey: requireValue(env, 'BOOTSTRAP_GEMINI_API_KEY'),
    geminiApiBaseUrl,
    inputPricePerMillionFen: parsePositiveFen(
      env,
      'BOOTSTRAP_GEMINI_INPUT_PRICE_PER_MILLION_FEN',
    ),
    outputPricePerMillionFen: parsePositiveFen(
      env,
      'BOOTSTRAP_GEMINI_OUTPUT_PRICE_PER_MILLION_FEN',
    ),
  };
}
