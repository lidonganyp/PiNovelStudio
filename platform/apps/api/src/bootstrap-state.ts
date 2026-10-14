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
  name: string;
  apiBaseUrl: string;
  apiKeyEncrypted: string;
  enabled: boolean;
}
interface BootstrapRate {
  id: number;
  providerId: number;
  displayName: string;
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

// 统一 writer 渠道（P1-1/P1-3）：生产路由的计费与初始化身份从部署注入的
// 当前模型（config.geminiModel，源 BOOTSTRAP_GEMINI_MODEL ← GEMINI_MODEL）动态
// 派生，不再绑定固定的 Gemini 3.8 Flash；模型切换只需重新 bootstrap。
function productionGeminiRoutes(geminiModel: string): ReadonlyArray<readonly [string, string]> {
  return [
    ['v2_rawstage2_gemini31', `${geminiModel} — NovelOS Agentic`],
    ['v2_amplified_gemini31', `${geminiModel} — Author Style Optimizer`],
  ];
}

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

async function ensureGeminiProvider(db: BootstrapDatabase, config: ProductionBootstrapConfig): Promise<BootstrapProvider> {
  const existing = await db.modelProvider.findUnique({ where: { providerKey: 'gemini' } });
  if (existing) {
    let credentialMatches = false;
    try { credentialMatches = decryptSecret(existing.apiKeyEncrypted, config.aesMasterKey) === config.geminiApiKey; } catch { credentialMatches = false; }
    // 幂等判断必须包含模型身份（name）：仅换模型（渠道地址/密钥/价格不变）时
    // provider 名称也要随当前部署模型更新，不能因地址与密钥未变而提前返回。
    if (
      existing.enabled &&
      existing.name === config.geminiModel &&
      existing.apiBaseUrl === config.geminiApiBaseUrl &&
      credentialMatches
    ) return existing;
    return db.modelProvider.update({
      where: { id: existing.id },
      data: {
        name: config.geminiModel,
        apiBaseUrl: config.geminiApiBaseUrl,
        apiKeyEncrypted: encryptSecret(config.geminiApiKey, config.aesMasterKey),
        enabled: true,
      },
    });
  }
  return db.modelProvider.create({
    data: {
      providerKey: 'gemini',
      name: config.geminiModel,
      apiBaseUrl: config.geminiApiBaseUrl,
      apiKeyEncrypted: encryptSecret(config.geminiApiKey, config.aesMasterKey),
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
  // 幂等判断必须包含模型身份（displayName）：仅换模型（金额不变）时也要追加
  // 新费率记录，保证"当前模型费率已确认"可由记录本身的模型身份背书；历史
  // 费率行保留不变（账单快照不可变）。
  if (
    current &&
    current.providerId === input.providerId &&
    current.displayName === input.displayName &&
    current.inputPricePerMillion === input.config.inputPricePerMillionFen &&
    current.outputPricePerMillion === input.config.outputPricePerMillionFen
  ) return;
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
  const provider = await ensureGeminiProvider(db, config);
  for (const [modelKey, displayName] of productionGeminiRoutes(config.geminiModel)) {
    await ensureRouteRate(db, { modelKey, displayName, providerId: provider.id, config });
  }
}
