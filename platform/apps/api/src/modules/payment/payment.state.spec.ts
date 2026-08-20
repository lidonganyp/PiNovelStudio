import { describe, expect, it } from 'vitest';
import { isAlipayPaidTradeStatus } from './alipay.adapter';
import { mapWechatQueryResult } from './wechat.adapter';

describe('payment terminal-state contracts', () => {
  it('does not treat a missing Alipay trade status as paid', () => {
    expect(isAlipayPaidTradeStatus(undefined)).toBe(false);
  });

  it('keeps an incomplete WeChat query unknown instead of expiring a potentially paid order', () => {
    expect(mapWechatQueryResult({})).toEqual({ status: 'unknown' });
  });
});
