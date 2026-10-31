import { describe, expect, it, vi } from 'vitest';
import { DocumentsService, CreateDocumentDto } from './documents.service';

describe('DocumentsService document creation', () => {
  it('returns a conflict when the live document uniqueness guard wins a race', async () => {
    const prisma = {
      novelProject: { findFirst: vi.fn().mockResolvedValue({ id: 2 }) },
      $transaction: vi.fn().mockRejectedValue({ code: 'P2002' }),
    };
    const service = new DocumentsService(prisma as never);

    await expect(service.create(1, 2, {
      documentType: 'narrative_state',
      title: 'Narrative state',
      content: '{}',
    } as CreateDocumentDto)).rejects.toMatchObject({ status: 409 });
  });
});

describe('DocumentsService reserved author-contract documents', () => {
  function makePrisma(row: Record<string, unknown> | null = null) {
    return {
      novelProject: { findFirst: vi.fn().mockResolvedValue({ id: 2 }) },
      novelDocument: {
        findFirst: vi.fn().mockResolvedValue(row),
        update: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn(),
    };
  }

  it.each([
    'chapter_contract:ch1',
    'chapter_contract_provenance:ch1',
    'chapter_contract:chX',
  ])('rejects generic create for %s with 403', async (documentType) => {
    const service = new DocumentsService(makePrisma() as never);
    await expect(service.create(1, 2, {
      documentType,
      title: '伪造契约',
      content: '伪造正文',
    } as CreateDocumentDto)).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({ reason: 'reserved_document_type' }),
    });
  });

  it('rejects generic update of an approved contract with 403', async () => {
    const service = new DocumentsService(makePrisma({
      id: 9, projectId: 2, userId: 1, documentType: 'chapter_contract:ch1',
      title: '契约', content: '# 契约', currentVersion: 1,
    }) as never);
    await expect(service.update(1, 2, 9, { content: '# 改过的契约' })).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({ reason: 'reserved_document_type' }),
    });
  });

  it('rejects generic delete of a provenance record with 403', async () => {
    const service = new DocumentsService(makePrisma({
      id: 9, projectId: 2, userId: 1, documentType: 'chapter_contract_provenance:ch1',
      title: '审批', content: '{}', currentVersion: 1,
    }) as never);
    await expect(service.remove(1, 2, 9)).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({ reason: 'reserved_document_type' }),
    });
  });
});
