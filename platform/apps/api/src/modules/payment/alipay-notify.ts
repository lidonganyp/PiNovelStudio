/**
 * 支付宝回调解析：与 sub2api 一致，优先把 urlencoded 原文拆成字段。
 */
export function parseAlipayNotifyParams(
  body: unknown,
  rawBody?: string,
): Record<string, string> {
  if (typeof rawBody === 'string' && rawBody.includes('=') && !rawBody.trim().startsWith('{')) {
    const parsed = new URLSearchParams(rawBody);
    const result: Record<string, string> = {};
    for (const [key, value] of parsed.entries()) {
      result[key] = value;
    }
    if (Object.keys(result).length > 0) return result;
  }
  if (!body || typeof body !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    result[key] = String(value);
  }
  return result;
}

export function isMobileUserAgent(userAgent: string | undefined): boolean {
  if (!userAgent) return false;
  return /Android|iPhone|iPad|iPod|Mobile|webOS/i.test(userAgent);
}

export function wrapAlipayPem(raw: string, kind: 'PRIVATE KEY' | 'PUBLIC KEY'): string {
  const trimmed = raw.trim().replace(/\\n/g, '\n');
  if (trimmed.includes('BEGIN')) return trimmed;
  const body = trimmed.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g)?.join('\n') ?? body;
  return `-----BEGIN ${kind}-----\n${lines}\n-----END ${kind}-----`;
}

export function defaultAlipayNotifyUrl(notifyBaseUrl: string): string {
  return `${notifyBaseUrl.replace(/\/$/, '')}/api/v1/payment/webhook/alipay`;
}

export function defaultPaymentReturnUrl(notifyBaseUrl: string): string {
  return `${notifyBaseUrl.replace(/\/$/, '')}/payment/result`;
}
