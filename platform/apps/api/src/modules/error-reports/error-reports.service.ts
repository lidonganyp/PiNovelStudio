/**
 * Generation error storage, redaction, analysis, and retention management.
 * User-facing failures remain compact; diagnostic details are admin-only.
 */
import { createHash, randomUUID } from 'node:crypto';
import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export const DEFAULT_ERROR_REPORT_RETENTION_DAYS = 30;
export const MAX_ERROR_REPORT_MESSAGE_LENGTH = 2_000;
export const MAX_ERROR_REPORT_DIAGNOSTIC_LENGTH = 16_000;

const SECRET_KEY = /authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie/i;
const OMITTED_PAYLOAD_KEY = /^(prompt|prompt[_-]?text|chapter[_-]?text|previous[_-]?chapter[_-]?text|workspace[_-]?documents|project[_-]?config|request[_-]?body|response[_-]?body)$/i;
const SECRET_VALUE = /(bearer\s+|sk-[a-z0-9_-]{4,}|token\s*[=:]\s*)[^\s,;]+/gi;
const SECRET_ASSIGNMENT = /(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie)\s*[=:]\s*[^\s,;]+/gi;

export interface ServerErrorReportInput {
  userId?: number;
  projectId?: number;
  chapterId?: number;
  jobId?: string;
  requestId?: string;
  traceId?: string;
  code: string;
  stage: string;
  gate?: string;
  severity: string;
  message: string;
  diagnostic?: unknown;
  archivePath?: string;
  retentionDays?: number;
}

export interface ClientErrorReportInput {
  clientEventId?: string;
  code: string;
  stage: string;
  gate?: string;
  severity?: string;
  message: string;
  stack?: string;
  lastEventType?: string;
  appVersion?: string;
  requestId?: string;
  traceId?: string;
  diagnostic?: unknown;
}

export interface ErrorReportListFilters {
  page?: number;
  pageSize?: number;
  code?: string;
  stage?: string;
  jobId?: string;
  projectId?: number;
  from?: Date;
  to?: Date;
}

function redactString(value: string): string {
  return value
    .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]')
    .replace(SECRET_VALUE, '$1[REDACTED]');
}

function sanitizeValue(value: unknown, depth: number, key?: string): unknown {
  if (key && OMITTED_PAYLOAD_KEY.test(key)) return undefined;
  if (depth > 5) return '[TRUNCATED]';
  if (typeof value === 'string') return redactString(value.slice(0, MAX_ERROR_REPORT_DIAGNOSTIC_LENGTH));
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      if (SECRET_KEY.test(childKey)) {
        output[childKey] = '[REDACTED]';
        continue;
      }
      const sanitized = sanitizeValue(childValue, depth + 1, childKey);
      if (sanitized !== undefined) output[childKey] = sanitized;
    }
    return output;
  }
  return String(value).slice(0, 256);
}

export function sanitizeErrorReportDetails(value: unknown): unknown {
  const sanitized = sanitizeValue(value, 0);
  try {
    const serialized = JSON.stringify(sanitized);
    if (serialized.length <= MAX_ERROR_REPORT_DIAGNOSTIC_LENGTH) return sanitized;
    return { truncated: true, excerpt: serialized.slice(0, MAX_ERROR_REPORT_DIAGNOSTIC_LENGTH) };
  } catch {
    return { omitted: 'unserializable' };
  }
}

function safeText(value: string, maxLength: number): string {
  return redactString(value.replace(/\s+/g, ' ').trim()).slice(0, maxLength);
}

function fingerprint(code: string, stage: string, message: string): string {
  return createHash('sha256').update(`${code}\n${stage}\n${message}`, 'utf8').digest('hex');
}

@Injectable()
export class ErrorReportsService {
  private readonly logger = new Logger(ErrorReportsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async recordServerError(input: ServerErrorReportInput): Promise<unknown | null> {
    return this.persist({
      ...input,
      source: 'server',
      severity: input.severity,
    });
  }

  async recordClientError(
    userId: number,
    jobId: string,
    input: ClientErrorReportInput,
  ): Promise<unknown | null> {
    const job = await this.prisma.novelGenerationJob.findUnique({
      where: { jobId },
      select: { userId: true, projectId: true, chapterId: true },
    });
    if (!job) throw new NotFoundException('生成任务不存在');
    if (job.userId !== userId) throw new ForbiddenException('无权提交该任务的错误报告');
    if (input.clientEventId) {
      const existing = await this.prisma.novelErrorReport.findUnique({
        where: { clientEventId: input.clientEventId },
      });
      if (existing) return existing;
    }
    return this.persist({
      ...input,
      userId,
      projectId: job.projectId,
      chapterId: job.chapterId ?? undefined,
      jobId,
      source: 'browser',
      severity: input.severity ?? 'recoverable',
      diagnostic: {
        ...((input.diagnostic && typeof input.diagnostic === 'object') ? input.diagnostic : {}),
        stack: input.stack,
        lastEventType: input.lastEventType,
        appVersion: input.appVersion,
      },
    });
  }

  async recordClientProjectError(
    userId: number,
    projectId: number,
    input: ClientErrorReportInput,
  ): Promise<unknown | null> {
    const project = await this.prisma.novelProject.findFirst({
      where: { id: projectId, userId, deletedAt: null },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('项目不存在');
    if (input.clientEventId) {
      const existing = await this.prisma.novelErrorReport.findUnique({
        where: { clientEventId: input.clientEventId },
      });
      if (existing) return existing;
    }
    return this.persist({
      ...input,
      userId,
      projectId,
      source: 'browser',
      severity: input.severity ?? 'recoverable',
      diagnostic: {
        ...((input.diagnostic && typeof input.diagnostic === 'object') ? input.diagnostic : {}),
        stack: input.stack,
        lastEventType: input.lastEventType,
        appVersion: input.appVersion,
      },
    });
  }

  async list(filters: ErrorReportListFilters = {}): Promise<unknown> {
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 20));
    const where = {
      ...(filters.code ? { code: filters.code } : {}),
      ...(filters.stage ? { stage: filters.stage } : {}),
      ...(filters.jobId ? { jobId: filters.jobId } : {}),
      ...(filters.projectId !== undefined ? { projectId: filters.projectId } : {}),
      ...((filters.from || filters.to) ? {
        createdAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lt: filters.to } : {}) },
      } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.novelErrorReport.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.novelErrorReport.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async summarize(from?: Date, to?: Date): Promise<{
    total: number;
    byCode: Record<string, number>;
    byStage: Record<string, number>;
    bySeverity: Record<string, number>;
  }> {
    const rows = await this.prisma.novelErrorReport.findMany({
      where: { ...((from || to) ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}) },
      select: { code: true, stage: true, severity: true },
    });
    const count = (values: string[]): Record<string, number> => values.reduce<Record<string, number>>((out, value) => {
      out[value] = (out[value] ?? 0) + 1;
      return out;
    }, {});
    return {
      total: rows.length,
      byCode: count(rows.map((row) => row.code)),
      byStage: count(rows.map((row) => row.stage)),
      bySeverity: count(rows.map((row) => row.severity)),
    };
  }

  async pin(id: number): Promise<unknown> {
    return this.prisma.novelErrorReport.update({
      where: { id },
      data: { pinnedAt: new Date() },
    });
  }

  async purgeExpired(before = new Date()): Promise<number> {
    const result = await this.prisma.novelErrorReport.deleteMany({
      where: { expiresAt: { lt: before }, pinnedAt: null },
    });
    return result.count;
  }

  private async persist(input: ServerErrorReportInput & { source: string; severity: string }): Promise<unknown | null> {
    try {
      const message = safeText(input.message, MAX_ERROR_REPORT_MESSAGE_LENGTH);
      const retentionDays = Number.isInteger(input.retentionDays) && (input.retentionDays as number) > 0
        ? input.retentionDays as number
        : DEFAULT_ERROR_REPORT_RETENTION_DAYS;
      const data = {
        reportId: randomUUID(),
        userId: input.userId,
        projectId: input.projectId,
        chapterId: input.chapterId,
        jobId: input.jobId ? safeText(input.jobId, 128) : undefined,
        requestId: input.requestId ? safeText(input.requestId, 128) : undefined,
        traceId: input.traceId ? safeText(input.traceId, 128) : undefined,
        code: safeText(input.code, 100),
        stage: safeText(input.stage, 120),
        gate: input.gate ? safeText(input.gate, 120) : undefined,
        severity: safeText(input.severity, 32),
        source: input.source,
        safeMessage: message,
        diagnostic: sanitizeErrorReportDetails({
          ...(input.diagnostic && typeof input.diagnostic === 'object' ? input.diagnostic : {}),
          archivePath: input.archivePath,
        }) as never,
        errorFingerprint: fingerprint(input.code, input.stage, message),
        clientEventId: 'clientEventId' in input ? (input as ClientErrorReportInput).clientEventId : undefined,
        expiresAt: new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000),
      };
      return await this.prisma.novelErrorReport.create({ data });
    } catch (error: unknown) {
      this.logger.error(
        `error report persistence failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
