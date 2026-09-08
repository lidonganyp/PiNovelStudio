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
  gptApiKey: string;
  gptApiBaseUrl: string;
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
  const gptApiBaseUrl =
    env.BOOTSTRAP_GPT_API_BASE_URL?.trim() ||
    'https://shunfen6.win/v1';
  let parsedGptUrl: URL;
  try {
    parsedGptUrl = new URL(gptApiBaseUrl);
  } catch {
    throw new Error('BOOTSTRAP_GPT_API_BASE_URL must be a valid HTTPS URL');
  }
  if (parsedGptUrl.protocol !== 'https:') {
    throw new Error('BOOTSTRAP_GPT_API_BASE_URL must be a valid HTTPS URL');
  }
  return {
    adminEmail,
    adminPassword,
    aesMasterKey,
    gptApiKey: requireValue(env, 'BOOTSTRAP_GPT_API_KEY'),
    gptApiBaseUrl,
    inputPricePerMillionFen: parsePositiveFen(
      env,
      'BOOTSTRAP_GPT_INPUT_PRICE_PER_MILLION_FEN',
    ),
    outputPricePerMillionFen: parsePositiveFen(
      env,
      'BOOTSTRAP_GPT_OUTPUT_PRICE_PER_MILLION_FEN',
    ),
  };
}
