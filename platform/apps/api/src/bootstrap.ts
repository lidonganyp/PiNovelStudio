/**
 * One-shot production bootstrap entry point. Compose runs this after
 * migrations and before the API process accepts traffic.
 */
import { PrismaClient } from '@prisma/client';
import { loadEnvFile } from './config/load-env-file';
import { resolveProductionBootstrapConfig } from './config/production-bootstrap';
import { bootstrapProductionState, type BootstrapDatabase } from './bootstrap-state';

async function main(): Promise<void> {
  loadEnvFile();
  const config = resolveProductionBootstrapConfig(process.env);
  const prisma = new PrismaClient();
  try {
    await prisma.$transaction(async (tx) => {
      await bootstrapProductionState(tx as unknown as BootstrapDatabase, config);
    });
    console.log('[bootstrap] admin and Gemini billing routes are ready');
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(`[bootstrap] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
