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
