import { describe, expect, it, vi } from 'vitest';
import { RatesService } from './rates.service';

describe('RatesService production eligibility', () => {
  it('only accepts a rate whose owning provider is enabled', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const service = new RatesService({
      modelRate: { findFirst },
    } as never);

    await expect(service.findEffectiveRate('v2_rawstage2_gpt6astra')).rejects.toThrow(
      /生效费率/,
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          modelKey: 'v2_rawstage2_gpt6astra',
          provider: { is: { enabled: true } },
        }),
      }),
    );
  });

  it('uses gpt-6-astra as a billing alias for GPT writing routes', async () => {
    const aliasRate = {
      modelKey: 'gpt-6-astra',
      displayName: 'gpt-6-astra',
      inputPricePerMillion: 100n,
      outputPricePerMillion: 250n,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      provider: { providerKey: 'gpt', enabled: true },
    };
    const findFirst = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(aliasRate);
    const service = new RatesService({
      modelRate: { findFirst },
    } as never);

    const rate = await service.findEffectiveRate('v2_rawstage2_gpt6astra');
    expect(rate.modelKey).toBe('gpt-6-astra');
    expect(findFirst.mock.calls[1][0].where.modelKey).toBe('gpt-6-astra');
  });
});
