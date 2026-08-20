/**
 * Seed bootstrap credential validation. Production must never inherit a
 * predictable administrator password from a script default.
 */

export interface SeedAdminEnvironment {
  NODE_ENV?: string;
  SEED_ADMIN_EMAIL?: string;
  SEED_ADMIN_PASSWORD?: string;
}

export interface SeedAdminCredentials {
  email: string;
  password: string;
}

export function resolveSeedAdminCredentials(
  input: SeedAdminEnvironment,
): SeedAdminCredentials {
  const email = input.SEED_ADMIN_EMAIL?.trim() ?? '';
  const password = input.SEED_ADMIN_PASSWORD ?? '';
  if (!email) {
    throw new Error('SEED_ADMIN_EMAIL must be explicitly configured');
  }
  if (!password) {
    throw new Error('SEED_ADMIN_PASSWORD must be explicitly configured');
  }
  if (password.length < 16) {
    throw new Error('SEED_ADMIN_PASSWORD must be at least 16 characters');
  }
  return { email, password };
}
