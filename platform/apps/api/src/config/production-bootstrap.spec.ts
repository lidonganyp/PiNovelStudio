import { describe, expect, it } from 'vitest';
import { resolveProductionBootstrapConfig } from './production-bootstrap';

describe('production bootstrap configuration', () => {
  it('fails closed when first-deploy credentials or prices are absent', () => {
    expect(() => resolveProductionBootstrapConfig({ NODE_ENV: 'production' })).toThrow(
      /ADMIN_EMAIL|GEMINI_API_KEY/i,
    );
  });

  it('requires positive integer fen prices and explicit admin credentials', () => {
    expect(() =>
      resolveProductionBootstrapConfig({
        NODE_ENV: 'production',
        BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
        BOOTSTRAP_ADMIN_PASSWORD: 'a-secure-bootstrap-password-123',
        AES_MASTER_KEY: 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        BOOTSTRAP_GEMINI_MODEL: 'gemini-4-argon',
        BOOTSTRAP_GEMINI_API_KEY: 'gemini-key',
        BOOTSTRAP_GEMINI_API_BASE_URL: 'https://gemini.example/v1',
        BOOTSTRAP_GEMINI_INPUT_PRICE_PER_MILLION_FEN: '0',
        BOOTSTRAP_GEMINI_OUTPUT_PRICE_PER_MILLION_FEN: '12',
      }),
    ).toThrow(/price/i);
  });

  it('fails closed when the deployed writer model is absent (P1-1)', () => {
    expect(() =>
      resolveProductionBootstrapConfig({
        NODE_ENV: 'production',
        BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
        BOOTSTRAP_ADMIN_PASSWORD: 'a-secure-bootstrap-password-123',
        AES_MASTER_KEY: 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        BOOTSTRAP_GEMINI_API_KEY: 'gemini-key',
        BOOTSTRAP_GEMINI_API_BASE_URL: 'https://gemini.example/v1',
        BOOTSTRAP_GEMINI_INPUT_PRICE_PER_MILLION_FEN: '120',
        BOOTSTRAP_GEMINI_OUTPUT_PRICE_PER_MILLION_FEN: '480',
      }),
    ).toThrow(/BOOTSTRAP_GEMINI_MODEL must be explicitly configured/);
  });

  it('accepts a complete immutable bootstrap envelope', () => {
    expect(
      resolveProductionBootstrapConfig({
        NODE_ENV: 'production',
        BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
        BOOTSTRAP_ADMIN_PASSWORD: 'a-secure-bootstrap-password-123',
        AES_MASTER_KEY: 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        BOOTSTRAP_GEMINI_MODEL: 'gemini-4-argon',
        BOOTSTRAP_GEMINI_API_KEY: 'gemini-key',
        BOOTSTRAP_GEMINI_API_BASE_URL: 'https://gemini.example/v1',
        BOOTSTRAP_GEMINI_INPUT_PRICE_PER_MILLION_FEN: '120',
        BOOTSTRAP_GEMINI_OUTPUT_PRICE_PER_MILLION_FEN: '480',
      }),
    ).toMatchObject({
      adminEmail: 'admin@example.com',
      adminPassword: 'a-secure-bootstrap-password-123',
      geminiModel: 'gemini-4-argon',
      geminiApiKey: 'gemini-key',
      geminiApiBaseUrl: 'https://gemini.example/v1',
      inputPricePerMillionFen: 120n,
      outputPricePerMillionFen: 480n,
    });
  });

  it('rejects a plaintext Gemini endpoint in production', () => {
    expect(() =>
      resolveProductionBootstrapConfig({
        NODE_ENV: 'production',
        BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
        BOOTSTRAP_ADMIN_PASSWORD: 'a-secure-bootstrap-password-123',
        AES_MASTER_KEY: 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        BOOTSTRAP_GEMINI_MODEL: 'gemini-4-argon',
        BOOTSTRAP_GEMINI_API_KEY: 'gemini-key',
        BOOTSTRAP_GEMINI_API_BASE_URL: 'http://gemini.internal',
        BOOTSTRAP_GEMINI_INPUT_PRICE_PER_MILLION_FEN: '120',
        BOOTSTRAP_GEMINI_OUTPUT_PRICE_PER_MILLION_FEN: '480',
      }),
    ).toThrow(/HTTPS/i);
  });
});
