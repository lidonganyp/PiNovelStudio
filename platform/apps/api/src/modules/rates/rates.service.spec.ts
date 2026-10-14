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

  it('queries only the route key itself and blocks when no current rate exists (P1-3)', async () => {
    // 旧 MODEL_RATE_ALIASES（gemini-3.8-flash 静默兜底）已删除：
    // findFirst 返回 null 时必须明确 404，且只查询路由 key 本身一次。
    const findFirst = vi.fn().mockResolvedValue(null);
    const service = new RatesService({
      modelRate: { findFirst },
    } as never);

    await expect(service.findEffectiveRate('v2_rawstage2_gemini31')).rejects.toThrow(
      /未找到模型 v2_rawstage2_gemini31 的生效费率/,
    );
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst.mock.calls[0][0].where.modelKey).toBe('v2_rawstage2_gemini31');
  });

  it('buildRateSnapshot returns the current effective rate keyed by the route key', async () => {
    const rate = {
      modelKey: 'v2_rawstage2_gemini31',
      displayName: 'gemini-4-argon — NovelOS Agentic',
      inputPricePerMillion: 100n,
      outputPricePerMillion: 250n,
      multiplierPercent: 100,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      provider: { providerKey: 'gemini', enabled: true },
    };
    const findFirst = vi.fn().mockResolvedValue(rate);
    const service = new RatesService({
      modelRate: { findFirst },
    } as never);

    const snapshot = await service.buildRateSnapshot('v2_rawstage2_gemini31');
    expect(snapshot.modelKey).toBe('v2_rawstage2_gemini31');
    expect(snapshot.displayName).toBe('gemini-4-argon — NovelOS Agentic');
    expect(snapshot.providerKey).toBe('gemini');
    expect(snapshot.inputPricePerMillion).toBe('100');
    expect(snapshot.outputPricePerMillion).toBe('250');
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst.mock.calls[0][0].where.modelKey).toBe('v2_rawstage2_gemini31');
  });
});
