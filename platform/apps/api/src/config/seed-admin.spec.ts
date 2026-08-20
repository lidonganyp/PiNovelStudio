import { describe, expect, it } from 'vitest';
import { resolveSeedAdminCredentials } from './seed-admin';

describe('seed admin credentials', () => {
  it('requires an explicit password instead of silently using a default', () => {
    expect(() =>
      resolveSeedAdminCredentials({
        NODE_ENV: 'development',
        SEED_ADMIN_EMAIL: 'admin@example.com',
      }),
    ).toThrow(
      /SEED_ADMIN_PASSWORD/i,
    );
  });

  it('rejects weak production bootstrap credentials', () => {
    expect(() =>
      resolveSeedAdminCredentials({
        NODE_ENV: 'production',
        SEED_ADMIN_EMAIL: 'admin@example.com',
        SEED_ADMIN_PASSWORD: 'short-password',
      }),
    ).toThrow(/16 characters/i);
  });

  it('accepts explicit production credentials', () => {
    expect(
      resolveSeedAdminCredentials({
        NODE_ENV: 'production',
        SEED_ADMIN_EMAIL: 'admin@example.com',
        SEED_ADMIN_PASSWORD: 'a-secure-bootstrap-password-123',
      }),
    ).toEqual({
      email: 'admin@example.com',
      password: 'a-secure-bootstrap-password-123',
    });
  });
});
