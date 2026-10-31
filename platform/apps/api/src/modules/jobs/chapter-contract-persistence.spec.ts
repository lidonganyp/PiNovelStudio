/**
 * 章纲契约落库的并发/幂等语义回归。
 *
 * 真实并发由 Postgres 事务级 advisory lock + `chapter_contract%` 部分唯一索引保证；
 * 本测试锁定两件可离线验证的事：
 *   1. 每次落库前先按「项目 + 文档类型」申请 advisory lock，再读再写；
 *   2. 重复提交同一章复用同一文档、追加版本，不产生第二份契约。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { upsertDocumentWithVersion } from './chapter-contract.service';

interface FakeDocument {
  id: number;
  projectId: number;
  userId: number;
  documentType: string;
  title: string;
  content: string;
  currentVersion: number;
}

function makeTx() {
  const docs: FakeDocument[] = [];
  const versions: Array<{ documentId: number; versionNumber: number; content: string }> = [];
  const lockKeys: string[] = [];
  let nextDocId = 1;

  const tx = {
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      lockKeys.push(String(values[0]));
      return [];
    }),
    novelDocument: {
      findFirst: vi.fn(async (args: { where: { projectId: number; userId: number; documentType: string } }) => {
        const { projectId, userId, documentType } = args.where;
        return docs.find((doc) =>
          doc.projectId === projectId && doc.userId === userId && doc.documentType === documentType,
        ) ?? null;
      }),
      create: vi.fn(async (args: { data: Omit<FakeDocument, 'id'> }) => {
        const doc: FakeDocument = { id: nextDocId++, ...args.data };
        docs.push(doc);
        return { id: doc.id };
      }),
      update: vi.fn(async (args: { where: { id: number }; data: Partial<FakeDocument> }) => {
        const doc = docs.find((row) => row.id === args.where.id);
        if (!doc) throw new Error('document missing');
        Object.assign(doc, args.data);
        return { id: doc.id };
      }),
    },
    novelDocumentVersion: {
      create: vi.fn(async (args: { data: { documentId: number; versionNumber: number; content: string } }) => {
        versions.push(args.data);
        return args.data;
      }),
    },
  };

  return { tx: tx as unknown as Prisma.TransactionClient, docs, versions, lockKeys };
}

const baseInput = {
  projectId: 2,
  userId: 1,
  documentType: 'chapter_contract:ch1',
  title: '第1章章纲契约（作者已批准）',
  content: '# 第1章章纲\n- 事件A',
  changeSummary: '作者批准章纲契约',
};

describe('upsertDocumentWithVersion concurrency semantics', () => {
  it('acquires the project + document-type advisory lock before reading or writing', async () => {
    const { tx, docs, versions, lockKeys } = makeTx();

    await upsertDocumentWithVersion(tx, baseInput);

    expect(lockKeys).toEqual(['author-contract:2:chapter_contract:ch1']);
    expect(docs).toHaveLength(1);
    expect(versions).toHaveLength(1);
  });

  it('repeated commits for the same chapter reuse one document and append versions', async () => {
    const { tx, docs, versions } = makeTx();

    const first = await upsertDocumentWithVersion(tx, baseInput);
    const second = await upsertDocumentWithVersion(tx, {
      ...baseInput,
      content: '# 第1章章纲（修订）',
      changeSummary: '作者重新批准',
    });

    expect(first.id).toBe(second.id);
    expect(docs).toHaveLength(1);
    expect(docs[0].currentVersion).toBe(2);
    expect(versions.map((row) => row.versionNumber)).toEqual([1, 2]);
    expect(versions[1].content).toBe('# 第1章章纲（修订）');
  });

  it('scopes locks per chapter so different chapters do not block each other', async () => {
    const { tx, lockKeys } = makeTx();

    await upsertDocumentWithVersion(tx, baseInput);
    await upsertDocumentWithVersion(tx, { ...baseInput, documentType: 'chapter_contract:ch2' });

    expect(lockKeys).toEqual([
      'author-contract:2:chapter_contract:ch1',
      'author-contract:2:chapter_contract:ch2',
    ]);
  });
});
