import { describe, expect, it } from 'vitest';
import {
  isAlipayPaidTradeStatus,
  mapAlipayQueryResult,
} from './alipay.adapter';

describe('Alipay payment state mapping', () => {
  it('treats both provider terminal success states as paid', () => {
    expect(isAlipayPaidTradeStatus('TRADE_SUCCESS')).toBe(true);
    expect(isAlipayPaidTradeStatus('TRADE_FINISHED')).toBe(true);
    expect(isAlipayPaidTradeStatus('TRADE_CLOSED')).toBe(false);
  });

  it('keeps an incomplete provider query unknown instead of expiring a potentially paid order', () => {
    expect(mapAlipayQueryResult({})).toEqual({ status: 'unknown' });
  });
});
