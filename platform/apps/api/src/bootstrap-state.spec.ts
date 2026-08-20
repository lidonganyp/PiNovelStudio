import { describe, expect, it } from 'vitest';
import { bootstrapProductionState } from './bootstrap-state';
import type { BootstrapDatabase } from './bootstrap-state';
import type { ProductionBootstrapConfig } from './config/production-bootstrap';

const config: ProductionBootstrapConfig = {
  adminEmail: 'admin@example.com',
  adminPassword: 'a-secure-bootstrap-password-123',
  aesMasterKey: 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  geminiApiKey: 'gemini-key',
  geminiApiBaseUrl: 'https://generativelanguage.googleapis.com',
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
    expect(db.providers[0]).toMatchObject({ providerKey: 'gemini', enabled: true });
    expect((db.providers[0] as { apiKeyEncrypted: string }).apiKeyEncrypted).not.toContain('gemini-key');
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
