/**
 * Idempotent first-deploy state creation for the production Compose bootstrap
 * job. It never changes historical rate rows.
 */
import * as argon2 from 'argon2';
import { decryptSecret, encryptSecret } from './common/crypto/aes-gcm';
import type { ProductionBootstrapConfig } from './config/production-bootstrap';

interface BootstrapUser { id: number; email: string; role: string }
interface BootstrapProvider {
  id: number;
  providerKey: string;
  apiBaseUrl: string;
  apiKeyEncrypted: string;
  enabled: boolean;
}
interface BootstrapRate {
  id: number;
  providerId: number;
  inputPricePerMillion: bigint;
  outputPricePerMillion: bigint;
}

interface EffectiveRateFilter {
  modelKey: string;
  enabled: boolean;
  effectiveFrom: { lte: Date };
}

export interface BootstrapDatabase {
  user: {
    findUnique(input: { where: { email: string } }): Promise<BootstrapUser | null>;
    create(input: { data: { email: string; nickname: string; role: string; passwordHash: string } }): Promise<BootstrapUser>;
  };
  modelProvider: {
    findUnique(input: { where: { providerKey: string } }): Promise<BootstrapProvider | null>;
    create(input: { data: { providerKey: string; name: string; apiBaseUrl: string; apiKeyEncrypted: string; enabled: boolean } }): Promise<BootstrapProvider>;
    update(input: { where: { id: number }; data: { name: string; apiBaseUrl: string; apiKeyEncrypted: string; enabled: boolean } }): Promise<BootstrapProvider>;
  };
  modelRate: {
    findFirst(input: { where: EffectiveRateFilter; orderBy: { effectiveFrom: 'desc' } }): Promise<BootstrapRate | null>;
    create(input: { data: { modelKey: string; displayName: string; providerId: number; inputPricePerMillion: bigint; outputPricePerMillion: bigint; effectiveFrom: Date; enabled: boolean } }): Promise<BootstrapRate>;
  };
}

const PRODUCTION_GPT_ROUTES = [
  ['v2_rawstage2_gpt6astra', 'gpt-6-astra — NovelOS Agentic'],
  ['v2_amplified_gpt6astra', 'gpt-6-astra — Author Style Optimizer'],
] as const;

async function ensureAdmin(db: BootstrapDatabase, config: ProductionBootstrapConfig): Promise<void> {
  const existing = await db.user.findUnique({ where: { email: config.adminEmail } });
  if (existing) {
    if (existing.role !== 'admin') throw new Error(`bootstrap admin email ${config.adminEmail} already exists without admin role`);
    return;
  }
  await db.user.create({
    data: {
      email: config.adminEmail,
      nickname: 'admin',
      role: 'admin',
      passwordHash: await argon2.hash(config.adminPassword),
    },
  });
}

async function ensureGptProvider(db: BootstrapDatabase, config: ProductionBootstrapConfig): Promise<BootstrapProvider> {
  const existing = await db.modelProvider.findUnique({ where: { providerKey: 'gpt' } });
  if (existing) {
    let credentialMatches = false;
    try { credentialMatches = decryptSecret(existing.apiKeyEncrypted, config.aesMasterKey) === config.gptApiKey; } catch { credentialMatches = false; }
    if (existing.enabled && existing.apiBaseUrl === config.gptApiBaseUrl && credentialMatches) return existing;
    return db.modelProvider.update({
      where: { id: existing.id },
      data: {
        name: 'gpt-6-astra',
        apiBaseUrl: config.gptApiBaseUrl,
        apiKeyEncrypted: encryptSecret(config.gptApiKey, config.aesMasterKey),
        enabled: true,
      },
    });
  }
  return db.modelProvider.create({
    data: {
      providerKey: 'gpt',
      name: 'gpt-6-astra',
      apiBaseUrl: config.gptApiBaseUrl,
      apiKeyEncrypted: encryptSecret(config.gptApiKey, config.aesMasterKey),
      enabled: true,
    },
  });
}

async function ensureRouteRate(
  db: BootstrapDatabase,
  input: { modelKey: string; displayName: string; providerId: number; config: ProductionBootstrapConfig },
): Promise<void> {
  const now = new Date();
  const current = await db.modelRate.findFirst({
    where: { modelKey: input.modelKey, enabled: true, effectiveFrom: { lte: now } },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (current && current.providerId === input.providerId && current.inputPricePerMillion === input.config.inputPricePerMillionFen && current.outputPricePerMillion === input.config.outputPricePerMillionFen) return;
  await db.modelRate.create({
    data: {
      modelKey: input.modelKey,
      displayName: input.displayName,
      providerId: input.providerId,
      inputPricePerMillion: input.config.inputPricePerMillionFen,
      outputPricePerMillion: input.config.outputPricePerMillionFen,
      effectiveFrom: new Date(),
      enabled: true,
    },
  });
}

export async function bootstrapProductionState(db: BootstrapDatabase, config: ProductionBootstrapConfig): Promise<void> {
  await ensureAdmin(db, config);
  const provider = await ensureGptProvider(db, config);
  for (const [modelKey, displayName] of PRODUCTION_GPT_ROUTES) {
    await ensureRouteRate(db, { modelKey, displayName, providerId: provider.id, config });
  }
}
