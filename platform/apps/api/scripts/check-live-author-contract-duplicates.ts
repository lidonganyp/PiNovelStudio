/**
 * 迁移前置只读检查：20261031000000_unique_live_author_contract
 * 检查 novel_documents 中 chapter_contract% 类型的 live 文档是否存在
 * (project_id, document_type) 重复；只读，不写库、不改 schema。
 * 重复存在时以非 0 退出码结束，便于在维护窗口前显式阻断迁移。
 *
 * 用法（在 platform/apps/api 下）：
 *   npx tsx scripts/check-live-author-contract-duplicates.ts
 */
import '../src/config/load-env-file';
import { PrismaClient } from '@prisma/client';

interface DuplicateGroup {
  project_id: number;
  document_type: string;
  live_count: number;
  document_ids: number[];
}

interface IndexRow {
  indexname: string;
  indexdef: string;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const groups = await prisma.$queryRaw<DuplicateGroup[]>`
      SELECT nd.project_id,
             nd.document_type,
             COUNT(*)::int AS live_count,
             ARRAY_AGG(nd.id ORDER BY nd.id) AS document_ids
      FROM novel_documents nd
      WHERE nd.deleted_at IS NULL
        AND nd.document_type LIKE 'chapter_contract%'
      GROUP BY nd.project_id, nd.document_type
      HAVING COUNT(*) > 1
      ORDER BY nd.project_id, nd.document_type
    `;

    const [totals] = await prisma.$queryRaw<Array<{ live_contracts: number; projects: number }>>`
      SELECT COUNT(*)::int AS live_contracts,
             COUNT(DISTINCT nd.project_id)::int AS projects
      FROM novel_documents nd
      WHERE nd.deleted_at IS NULL
        AND nd.document_type LIKE 'chapter_contract%'
    `;

    const indexes = await prisma.$queryRaw<IndexRow[]>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'novel_documents'
        AND indexname = 'novel_documents_one_live_author_contract_per_type'
    `;

    const report = {
      migration: '20261031000000_unique_live_author_contract',
      checkedAt: new Date().toISOString(),
      liveChapterContractDocuments: totals?.live_contracts ?? 0,
      projectsWithLiveContracts: totals?.projects ?? 0,
      duplicateGroups: groups.map((group) => ({
        projectId: group.project_id,
        documentType: group.document_type,
        liveCount: group.live_count,
        documentIds: group.document_ids,
      })),
      uniqueIndexPresent: indexes.length > 0,
      uniqueIndexDefinition: indexes[0]?.indexdef ?? null,
      verdict: groups.length === 0 ? 'SAFE_TO_MIGRATE' : 'BLOCKED_DUPLICATES',
    };

    console.log(JSON.stringify(report, null, 2));
    if (groups.length > 0) {
      console.error(`[check] 发现 ${groups.length} 组重复 live chapter_contract 文档，迁移会失败；请先人工合并/软删除。`);
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('[check] 只读检查失败：', error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
