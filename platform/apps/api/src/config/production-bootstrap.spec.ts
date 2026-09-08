import { describe, expect, it } from 'vitest';
import { resolveProductionBootstrapConfig } from './production-bootstrap';

describe('production bootstrap configuration', () => {
  it('fails closed when first-deploy credentials or prices are absent', () => {
    expect(() => resolveProductionBootstrapConfig({ NODE_ENV: 'production' })).toThrow(
      /ADMIN_EMAIL|GPT_API_KEY/i,
    );
  });

  it('requires positive integer fen prices and explicit admin credentials', () => {
    expect(() =>
      resolveProductionBootstrapConfig({
        NODE_ENV: 'production',
        BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
        BOOTSTRAP_ADMIN_PASSWORD: 'a-secure-bootstrap-password-123',
        AES_MASTER_KEY: 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        BOOTSTRAP_GPT_API_KEY: 'gpt-key',
        BOOTSTRAP_GPT_INPUT_PRICE_PER_MILLION_FEN: '0',
        BOOTSTRAP_GPT_OUTPUT_PRICE_PER_MILLION_FEN: '12',
      }),
    ).toThrow(/price/i);
  });

  it('accepts a complete immutable bootstrap envelope', () => {
    expect(
      resolveProductionBootstrapConfig({
        NODE_ENV: 'production',
        BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
        BOOTSTRAP_ADMIN_PASSWORD: 'a-secure-bootstrap-password-123',
        AES_MASTER_KEY: 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        BOOTSTRAP_GPT_API_KEY: 'gpt-key',
        BOOTSTRAP_GPT_INPUT_PRICE_PER_MILLION_FEN: '120',
        BOOTSTRAP_GPT_OUTPUT_PRICE_PER_MILLION_FEN: '480',
      }),
    ).toMatchObject({
      adminEmail: 'admin@example.com',
      adminPassword: 'a-secure-bootstrap-password-123',
      gptApiKey: 'gpt-key',
      inputPricePerMillionFen: 120n,
      outputPricePerMillionFen: 480n,
    });
  });

  it('rejects a plaintext GPT endpoint in production', () => {
    expect(() =>
      resolveProductionBootstrapConfig({
        NODE_ENV: 'production',
        BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
        BOOTSTRAP_ADMIN_PASSWORD: 'a-secure-bootstrap-password-123',
        AES_MASTER_KEY: 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        BOOTSTRAP_GPT_API_KEY: 'gpt-key',
        BOOTSTRAP_GPT_API_BASE_URL: 'http://gpt.internal',
        BOOTSTRAP_GPT_INPUT_PRICE_PER_MILLION_FEN: '120',
        BOOTSTRAP_GPT_OUTPUT_PRICE_PER_MILLION_FEN: '480',
      }),
    ).toThrow(/HTTPS/i);
  });
});
