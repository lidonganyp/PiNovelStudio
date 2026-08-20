/**
 * 支付宝回调字段解析与密钥 PEM 包装。
 */
import { describe, expect, it } from 'vitest';
import {
  defaultAlipayNotifyUrl,
  isMobileUserAgent,
  parseAlipayNotifyParams,
  wrapAlipayPem,
} from './alipay-notify';

describe('alipay notify helpers', () => {
  it('parses urlencoded raw bodies the way Alipay posts them', () => {
    const params = parseAlipayNotifyParams(
      {},
      'out_trade_no=PO1&trade_status=TRADE_SUCCESS&total_amount=12.00&trade_no=20260820',
    );
    expect(params.out_trade_no).toBe('PO1');
    expect(params.trade_status).toBe('TRADE_SUCCESS');
  });

  it('uses the sub2api webhook path by default', () => {
    expect(defaultAlipayNotifyUrl('https://ainovel.cloud')).toBe(
      'https://ainovel.cloud/api/v1/payment/webhook/alipay',
    );
  });

  it('still classifies mobile user agents without changing the page.pay route', () => {
    expect(isMobileUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0')).toBe(true);
    expect(isMobileUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false);
  });

  it('wraps PKCS8 material into PEM', () => {
    const pem = wrapAlipayPem('MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgw', 'PRIVATE KEY');
    expect(pem).toContain('BEGIN PRIVATE KEY');
    expect(pem).toContain('END PRIVATE KEY');
  });
});
