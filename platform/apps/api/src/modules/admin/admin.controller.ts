/**
 * 管理后台 API：用户、调账、封禁、模型/费率、用量、收入、审计、设置。
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../../common/guards/admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../auth/auth.types';
import { AdminService } from './admin.service';
import { FeedbackService } from '../feedback/feedback.service';
import {
  AdjustBalanceDto,
  AdminUserQueryDto,
  CreateProviderDto,
  CreateRateDto,
  PatchRateDto,
  PutSettingsBodyDto,
  UpsertProviderDto,
  UpdateUserStatusDto,
  UsageQueryDto,
} from './dto/admin.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly feedback: FeedbackService,
  ) {}

  @Get('ping')
  ping(): { pong: boolean } {
    return { pong: true };
  }

  @Get()
  overview(): Promise<unknown> {
    return this.admin.overview();
  }

  @Get('users')
  listUsers(@Query() query: AdminUserQueryDto): Promise<unknown> {
    return this.admin.listUsers(
      query.page ?? 1,
      query.pageSize ?? 20,
      query.q,
      query.status,
    );
  }

  @Get('users/:id')
  getUser(@Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.admin.getUser(id);
  }

  @Post('users/:id/adjustments')
  adjust(
    @CurrentUser() actor: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AdjustBalanceDto,
  ): Promise<unknown> {
    return this.admin.adjust(actor.sub, id, BigInt(dto.amount), dto.reason);
  }

  @Post('users/:id/status')
  setStatus(
    @CurrentUser() actor: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserStatusDto,
  ): Promise<unknown> {
    return this.admin.setUserStatus(actor.sub, id, dto.status);
  }

  @Get('model-providers')
  listProviders(): Promise<unknown> {
    return this.admin.listProviders();
  }

  @Post('model-providers')
  createProvider(
    @CurrentUser() actor: AuthUserPayload,
    @Body() dto: CreateProviderDto,
  ): Promise<unknown> {
    return this.admin.createProvider(actor.sub, dto);
  }

  @Patch('model-providers/:id')
  patchProvider(
    @CurrentUser() actor: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpsertProviderDto,
  ): Promise<unknown> {
    return this.admin.patchProvider(actor.sub, id, dto);
  }

  @Get('model-rates')
  listRates(): Promise<unknown> {
    return this.admin.listRates();
  }

  @Post('model-rates')
  createRate(
    @CurrentUser() actor: AuthUserPayload,
    @Body() dto: CreateRateDto,
  ): Promise<unknown> {
    return this.admin.createRate(actor.sub, {
      modelKey: dto.modelKey,
      displayName: dto.displayName,
      providerId: dto.providerId,
      inputPricePerMillion: BigInt(dto.inputPricePerMillion),
      outputPricePerMillion: BigInt(dto.outputPricePerMillion),
      effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : undefined,
      enabled: dto.enabled,
    });
  }

  @Patch('model-rates/:id')
  patchRate(
    @CurrentUser() actor: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PatchRateDto,
  ): Promise<unknown> {
    return this.admin.patchRate(actor.sub, id, dto);
  }

  @Get('usage/summary')
  usageSummary(@Query() query: UsageQueryDto): Promise<unknown> {
    return this.admin.usageSummary(query.groupBy ?? 'model');
  }

  @Get('usage/records')
  usageRecords(@Query() query: UsageQueryDto): Promise<unknown> {
    return this.admin.usageRecords(query.page ?? 1, query.pageSize ?? 20, {
      userId: query.userId,
      model: query.model,
    });
  }

  @Get('revenue/summary')
  revenue(): Promise<unknown> {
    return this.admin.revenueSummary();
  }

  @Get('audit-logs')
  auditLogs(@Query() query: PaginationDto & { action?: string }): Promise<unknown> {
    return this.admin.listAuditLogs(
      query.page ?? 1,
      query.pageSize ?? 20,
      query.action,
    );
  }

  @Get('settings')
  settings(): Promise<unknown> {
    return this.admin.getSettings();
  }

  @Get('feedback')
  listFeedback(@Query() query: PaginationDto): Promise<unknown> {
    return this.feedback.adminList(query.page ?? 1, query.pageSize ?? 20);
  }

  @Put('settings')
  putSettings(
    @CurrentUser() actor: AuthUserPayload,
    @Body() dto: PutSettingsBodyDto,
  ): Promise<unknown> {
    return this.admin.putSettings(actor.sub, dto.items);
  }
}
