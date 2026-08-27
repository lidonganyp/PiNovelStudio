import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  DEFAULT_ERROR_REPORT_RETENTION_DAYS,
  ErrorReportsService,
  sanitizeErrorReportDetails,
} from './error-reports.service';

function makePrisma() {
  return {
    novelErrorReport: {
      findUnique: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    novelGenerationJob: {
      findUnique: vi.fn(),
    },
  };
}

describe('ErrorReportsService', () => {
  it('redacts secrets and omits prompt/chapter payloads', () => {
    const details = sanitizeErrorReportDetails({
      authorization: 'Bearer secret-token',
      prompt: '完整提示词',
      chapterText: '完整正文',
      nested: { apiKey: 'sk-test-secret', reason: 'fingerprint mismatch' },
    });

    expect(details).toEqual({
      authorization: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', reason: 'fingerprint mismatch' },
    });
  });

  it('deduplicates client reports by clientEventId', async () => {
    const prisma = makePrisma();
    const existing = { id: 7, reportId: 'report-7' };
    prisma.novelErrorReport.findUnique.mockResolvedValue(existing);
    prisma.novelGenerationJob.findUnique.mockResolvedValue({ userId: 3, projectId: 2, chapterId: 1 });
    const service = new ErrorReportsService(prisma as never);

    const result = await service.recordClientError(3, 'job-1', {
      clientEventId: 'event-1',
      code: 'sse_interrupted',
      stage: 'assistant.sse',
      message: 'stream closed',
    });

    expect(result).toEqual(existing);
    expect(prisma.novelErrorReport.create).not.toHaveBeenCalled();
  });

  it('requires the browser report to belong to the authenticated user', async () => {
    const prisma = makePrisma();
    prisma.novelErrorReport.findUnique.mockResolvedValue(null);
    prisma.novelGenerationJob.findUnique.mockResolvedValue(null);
    const service = new ErrorReportsService(prisma as never);

    await expect(service.recordClientError(3, 'job-1', {
      code: 'sse_interrupted',
      stage: 'assistant.sse',
      message: 'stream closed',
    })).rejects.toBeInstanceOf(NotFoundException);

    prisma.novelGenerationJob.findUnique.mockResolvedValue({
      userId: 4,
      projectId: 2,
      chapterId: 1,
    });
    await expect(service.recordClientError(3, 'job-1', {
      code: 'sse_interrupted',
      stage: 'assistant.sse',
      message: 'stream closed',
    })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('bounds diagnostic strings before persistence', async () => {
    const prisma = makePrisma();
    prisma.novelErrorReport.create.mockImplementation(async ({ data }) => data);
    const service = new ErrorReportsService(prisma as never);

    await service.recordServerError({
      code: 'runtime_error',
      stage: 'runtime',
      severity: 'hard',
      message: 'x'.repeat(20_000),
      diagnostic: { stack: 'y'.repeat(30_000) },
    });

    const data = prisma.novelErrorReport.create.mock.calls[0][0].data as {
      safeMessage: string;
      diagnostic: unknown;
    };
    expect(data.safeMessage).toHaveLength(2_000);
    expect(JSON.stringify(data.diagnostic).length).toBeLessThanOrEqual(16_100);
  });

  it('assigns the default retention expiry to new reports', async () => {
    const prisma = makePrisma();
    prisma.novelErrorReport.findUnique.mockResolvedValue(null);
    prisma.novelErrorReport.create.mockImplementation(async ({ data }) => data);
    const service = new ErrorReportsService(prisma as never);
    const before = Date.now();

    await service.recordServerError({
      jobId: 'job-1',
      code: 'environment_fingerprint_mismatch',
      stage: 'g6_release_gate',
      severity: 'preflight',
      message: 'fingerprint mismatch',
    });

    const data = prisma.novelErrorReport.create.mock.calls[0][0].data as { expiresAt: Date };
    const expected = DEFAULT_ERROR_REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + expected - 1000);
    expect(data.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + expected + 1000);
  });

  it('purges only unpinned reports before the retention cutoff', async () => {
    const prisma = makePrisma();
    prisma.novelErrorReport.deleteMany.mockResolvedValue({ count: 4 });
    const service = new ErrorReportsService(prisma as never);

    const result = await service.purgeExpired(new Date('2026-01-01T00:00:00.000Z'));

    expect(result).toBe(4);
    expect(prisma.novelErrorReport.deleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: { lt: new Date('2026-01-01T00:00:00.000Z') },
        pinnedAt: null,
      },
    });
  });

  it('summarizes failures by code, stage, and severity', async () => {
    const prisma = makePrisma();
    prisma.novelErrorReport.findMany.mockResolvedValue([
      { code: 'environment_fingerprint_mismatch', stage: 'g6_release_gate', severity: 'preflight' },
      { code: 'environment_fingerprint_mismatch', stage: 'g6_release_gate', severity: 'preflight' },
      { code: 'state_store_hash_mismatch', stage: 'runtime.preflight', severity: 'preflight' },
    ]);
    const service = new ErrorReportsService(prisma as never);

    await expect(service.summarize()).resolves.toEqual({
      total: 3,
      byCode: { environment_fingerprint_mismatch: 2, state_store_hash_mismatch: 1 },
      byStage: { g6_release_gate: 2, 'runtime.preflight': 1 },
      bySeverity: { preflight: 3 },
    });
  });
});
