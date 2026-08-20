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
          provider: { is: { enabled: true } },
        }),
      }),
    );
  });
});
