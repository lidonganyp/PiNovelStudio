import { describe, expect, it } from 'vitest';
import { bootstrapProductionState } from './bootstrap-state';
import type { BootstrapDatabase } from './bootstrap-state';
import type { ProductionBootstrapConfig } from './config/production-bootstrap';

const config: ProductionBootstrapConfig = {
  adminEmail: 'admin@example.com',
  adminPassword: 'a-secure-bootstrap-password-123',
  aesMasterKey: 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  geminiModel: 'gemini-4-argon',
  geminiApiKey: 'gemini-key',
  geminiApiBaseUrl: 'https://aimagichub.xyz/v1',
  inputPricePerMillionFen: 120n,
  outputPricePerMillionFen: 480n,
};

function makeDb(): BootstrapDatabase & { users: unknown[]; providers: unknown[]; rates: unknown[] } {
  const db = {
    users: [] as unknown[],
    providers: [] as unknown[],
    rates: [] as unknown[],
    user: {
      findUnique: async ({ where: { email } }: { where: { email: string } }) =>
        (db.users as Array<{ id: number; email: string; role: string }>).find((row) => row.email === email) ?? null,
      create: async ({ data }: { data: { email: string; nickname: string; role: string; passwordHash: string } }) => {
        const row = { id: db.users.length + 1, ...data };
        db.users.push(row);
        return row;
      },
    },
    modelProvider: {
      findUnique: async ({ where: { providerKey } }: { where: { providerKey: string } }) =>
        (db.providers as Array<{ id: number; providerKey: string }>).find((row) => row.providerKey === providerKey) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: db.providers.length + 1, ...data } as never;
        db.providers.push(row);
        return row;
      },
      update: async ({ where: { id }, data }: { where: { id: number }; data: Record<string, unknown> }) => {
        const index = db.providers.findIndex((row) => (row as { id: number }).id === id);
        const row = { ...(db.providers[index] as object), ...data } as never;
        db.providers[index] = row;
        return row;
      },
    },
    modelRate: {
      findFirst: async ({ where }: { where: { modelKey: string; enabled: boolean; effectiveFrom?: { lte: Date } } }) => {
        const candidates = (db.rates as Array<{ modelKey: string; enabled: boolean; effectiveFrom: Date }>)
          .filter((row) => row.modelKey === where.modelKey && row.enabled === where.enabled)
          .filter((row) => !where.effectiveFrom || row.effectiveFrom <= where.effectiveFrom.lte)
          .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
        return candidates[0] ?? null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: db.rates.length + 1, ...data } as never;
        db.rates.push(row);
        return row;
      },
    },
  } as unknown as BootstrapDatabase & { users: unknown[]; providers: unknown[]; rates: unknown[] };
  return db;
}

describe('production bootstrap state', () => {
  it('creates admin, encrypted Gemini provider, and both production route rates', async () => {
    const db = makeDb();
    await bootstrapProductionState(db, config);
    expect(db.users).toHaveLength(1);
    expect(db.providers).toHaveLength(1);
    expect(db.rates).toHaveLength(2);
    // P1-1/P1-3：provider 名称与费率 displayName 从部署注入的当前模型动态派生
    expect(db.providers[0]).toMatchObject({ providerKey: 'gemini', name: 'gemini-4-argon', enabled: true });
    expect((db.providers[0] as { apiKeyEncrypted: string }).apiKeyEncrypted).not.toContain('gemini-key');
    const rateRows = db.rates as Array<{ modelKey: string; displayName: string }>;
    expect(rateRows.find((row) => row.modelKey === 'v2_rawstage2_gemini31')?.displayName)
      .toBe('gemini-4-argon — NovelOS Agentic');
    expect(rateRows.find((row) => row.modelKey === 'v2_amplified_gemini31')?.displayName)
      .toBe('gemini-4-argon — Author Style Optimizer');
  });

  it('is idempotent when the same state already exists', async () => {
    const db = makeDb();
    await bootstrapProductionState(db, config);
    const provider = db.providers[0];
    await bootstrapProductionState(db, config);
    expect(db.users).toHaveLength(1);
    expect(db.providers).toHaveLength(1);
    expect(db.rates).toHaveLength(2);
    expect(db.providers[0]).toEqual(provider);
  });

  it('updates provider name and appends model-scoped rate rows when only the model changes', async () => {
    const db = makeDb();
    await bootstrapProductionState(db, config);
    // 仅换模型：渠道地址、密钥与价格全部不变（模型升级部署场景）
    const upgraded: ProductionBootstrapConfig = { ...config, geminiModel: 'gemini-5-argon' };
    await bootstrapProductionState(db, upgraded);

    // provider 名称必须随当前部署模型更新（旧缺陷：地址/密钥相同时提前返回，名称仍是旧模型）
    expect(db.providers).toHaveLength(1);
    expect(db.providers[0]).toMatchObject({
      providerKey: 'gemini',
      name: 'gemini-5-argon',
      apiBaseUrl: config.geminiApiBaseUrl,
      enabled: true,
    });

    // 两条新模型费率追加；旧模型费率行保留（历史账单快照不可变）
    const rateRows = db.rates as Array<{ modelKey: string; displayName: string }>;
    expect(rateRows).toHaveLength(4);
    const rawRows = rateRows
      .filter((row) => row.modelKey === 'v2_rawstage2_gemini31')
      .map((row) => row.displayName)
      .sort();
    expect(rawRows).toEqual([
      'gemini-4-argon — NovelOS Agentic',
      'gemini-5-argon — NovelOS Agentic',
    ]);
    expect(rateRows.find((row) => row.modelKey === 'v2_amplified_gemini31' && row.displayName.includes('gemini-5-argon')))
      .toMatchObject({ displayName: 'gemini-5-argon — Author Style Optimizer' });

    // 升级后以新模型再次 bootstrap：幂等，不再追加费率行
    // （先回拨旧模型行时间戳，避免与同毫秒创建的新行排序不稳定）
    for (const row of db.rates as Array<{ displayName: string; effectiveFrom: Date }>) {
      if (row.displayName.includes('gemini-4-argon')) row.effectiveFrom = new Date(Date.now() - 60_000);
    }
    await bootstrapProductionState(db, upgraded);
    expect(db.providers).toHaveLength(1);
    expect(db.rates).toHaveLength(4);
  });

  it('does not treat a future rate as the currently effective production rate', async () => {
    const db = makeDb();
    await bootstrapProductionState(db, config);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    for (const row of db.rates as Array<{ effectiveFrom: Date }>) {
      row.effectiveFrom = future;
    }

    await bootstrapProductionState(db, config);

    expect(db.rates).toHaveLength(4);
    expect(
      (db.rates as Array<{ effectiveFrom: Date }>).filter(
        (row) => row.effectiveFrom <= new Date(),
      ),
    ).toHaveLength(2);
  });

  it('never upgrades an existing non-admin account', async () => {
    const db = makeDb();
    db.users.push({ id: 1, email: config.adminEmail, role: 'user' });
    await expect(bootstrapProductionState(db, config)).rejects.toThrow(/without admin role/i);
  });
});
