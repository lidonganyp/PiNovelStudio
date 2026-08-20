/**
 * 模块说明：首个管理员种子脚本（pnpm db:seed）。
 * 从 env 读取 SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD，已存在则跳过（幂等）。
 */
import * as argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import { loadEnvFile } from '../src/config/load-env-file';
import { resolveSeedAdminCredentials } from '../src/config/seed-admin';

async function main(): Promise<void> {
  loadEnvFile();
  const prisma = new PrismaClient();
  const { email, password } = resolveSeedAdminCredentials(process.env);

  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      console.log(`[seed] admin 已存在，跳过: ${email}`);
      return;
    }
    await prisma.user.create({
      data: {
        email,
        nickname: 'admin',
        role: 'admin',
        passwordHash: await argon2.hash(password),
      },
    });
    console.log(`[seed] admin 创建成功: ${email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('[seed] 失败:', error);
  process.exit(1);
});
