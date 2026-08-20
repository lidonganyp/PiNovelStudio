/**
 * 资源归属校验：越权一律按 404 返回，避免泄露资源是否存在。
 */
import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';

/** 取当前用户未删除项目；不存在或非本人 → 404。 */
export async function requireOwnedProject(
  prisma: PrismaService,
  userId: number,
  projectId: number,
): Promise<{
  id: number;
  userId: number;
  title: string;
  description: string;
  genre: string;
  subGenres: unknown;
  worldKeyTerms: unknown;
  status: string;
  workflowState: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}> {
  const project = await prisma.novelProject.findFirst({
    where: { id: projectId, userId, deletedAt: null },
  });
  if (!project) {
    throw new NotFoundException('项目不存在');
  }
  return project;
}

/** 非空白字数（中文按字符计）。 */
export function countWords(text: string): number {
  return text.replace(/\s+/g, '').length;
}
