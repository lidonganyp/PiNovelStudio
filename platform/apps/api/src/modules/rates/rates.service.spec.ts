import { describe, expect, it, vi } from 'vitest';
import { RatesService } from './rates.service';

describe('RatesService production eligibility', () => {
  it('only accepts a rate whose owning provider is enabled', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const service = new RatesService({
      modelRate: { findFirst },
    } as never);

    await expect(service.findEffectiveRate('v2_rawstage2_gemini31')).rejects.toThrow(
      /生效费率/,
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          modelKey: 'v2_rawstage2_gemini31',
          provider: { is: { enabled: true } },
        }),
      }),
    );
  });

  it('uses gemini-3.7-flash as a billing alias for Gemini writing routes', async () => {
    const aliasRate = {
      modelKey: 'gemini-3.7-flash',
      displayName: 'gemini-3.7-flash',
      inputPricePerMillion: 100n,
      outputPricePerMillion: 250n,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      provider: { providerKey: 'gemini-3.7-flash', enabled: true },
    };
    const findFirst = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(aliasRate);
    const service = new RatesService({
      modelRate: { findFirst },
    } as never);

    const rate = await service.findEffectiveRate('v2_rawstage2_gemini31');
    expect(rate.modelKey).toBe('gemini-3.7-flash');
    expect(findFirst.mock.calls[1][0].where.modelKey).toBe('gemini-3.7-flash');
  });
});
