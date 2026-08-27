/**
 * Error report HTTP boundary. Diagnostics are accepted only in bounded,
 * validated fields; the service performs a second redaction pass before save.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AuthUserPayload } from '../auth/auth.types';
import { ErrorReportsService } from './error-reports.service';

export class CreateClientErrorReportDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  clientEventId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  stage!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  gate?: string;

  @IsOptional()
  @IsIn(['recoverable', 'hard', 'fatal', 'preflight'])
  severity?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2_000)
  message!: string;

  @IsOptional()
  @IsString()
  @MaxLength(8_000)
  stack?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  lastEventType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  appVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  requestId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  traceId?: string;

  @IsOptional()
  @IsObject()
  diagnostic?: Record<string, unknown>;
}

export class ErrorReportQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  stage?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  jobId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  projectId?: number;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

@Controller()
export class ErrorReportsController {
  constructor(private readonly reports: ErrorReportsService) {}

  @Post('jobs/:jobId/client-errors')
  @UseGuards(JwtAuthGuard)
  reportClientError(
    @CurrentUser() user: AuthUserPayload,
    @Param('jobId') jobId: string,
    @Body() dto: CreateClientErrorReportDto,
  ): Promise<{ accepted: boolean; reportId?: string }> {
    return this.reports.recordClientError(user.sub, jobId, dto).then((report) => ({
      accepted: report !== null,
      ...(report && typeof report === 'object' && 'reportId' in report
        ? { reportId: String((report as { reportId: unknown }).reportId) }
        : {}),
    }));
  }

  @Post('projects/:projectId/client-errors')
  @UseGuards(JwtAuthGuard)
  reportProjectClientError(
    @CurrentUser() user: AuthUserPayload,
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: CreateClientErrorReportDto,
  ): Promise<{ accepted: boolean; reportId?: string }> {
    return this.reports.recordClientProjectError(user.sub, projectId, dto).then((report) => ({
      accepted: report !== null,
      ...(report && typeof report === 'object' && 'reportId' in report
        ? { reportId: String((report as { reportId: unknown }).reportId) }
        : {}),
    }));
  }

  @Get('admin/error-reports')
  @UseGuards(AdminGuard)
  list(@Query() query: ErrorReportQueryDto): Promise<unknown> {
    return this.reports.list({
      page: query.page,
      pageSize: query.pageSize,
      code: query.code,
      stage: query.stage,
      jobId: query.jobId,
      projectId: query.projectId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }

  @Get('admin/error-reports/summary')
  @UseGuards(AdminGuard)
  summary(@Query() query: ErrorReportQueryDto): Promise<unknown> {
    return this.reports.summarize(
      query.from ? new Date(query.from) : undefined,
      query.to ? new Date(query.to) : undefined,
    );
  }

  @Post('admin/error-reports/:id/pin')
  @UseGuards(AdminGuard)
  pin(@Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.reports.pin(id);
  }
}
