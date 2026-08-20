/**
 * 管理操作审计写入：调账/封禁/费率/设置等只追加。
 */
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';

export async function writeAudit(
  db: PrismaService | Prisma.TransactionClient,
  input: {
    actorId: number | null;
    actorType: string;
    action: string;
    targetType: string;
    targetId: string;
    detail?: Prisma.InputJsonValue;
    ip?: string;
  },
): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId: input.actorId,
      actorType: input.actorType,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      detail: input.detail ?? undefined,
      ip: input.ip,
    },
  });
}

/** API key 脱敏展示，不回传明文。 */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '********';
  return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}
