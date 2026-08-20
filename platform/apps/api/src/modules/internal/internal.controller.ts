/**
 * 内部 API 控制器（HMAC 保护，无 JWT）：预占 / 结算 / 收尾 / 凭证 / 进度。
 * 挂载在 /internal，不走全局 /api 前缀。
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { BillingService } from '../billing/billing.service';
import { fenToString } from '../billing/money';
import { JobsService } from '../jobs/jobs.service';
import { RatesService } from '../rates/rates.service';
import { CreateHoldDto } from './dto/create-hold.dto';
import { FinalizeHoldDto } from './dto/finalize-hold.dto';
import { JobStatusDto } from './dto/job-status.dto';
import { SettleCallDto } from './dto/settle-call.dto';
import { HmacGuard } from './hmac.guard';

@Controller('internal')
@UseGuards(HmacGuard)
export class InternalController {
  constructor(
    private readonly billing: BillingService,
    private readonly rates: RatesService,
    private readonly jobs: JobsService,
  ) {}

  /** POST /internal/billing/holds */
  @Post('billing/holds')
  async createHold(@Body() dto: CreateHoldDto): Promise<Record<string, unknown>> {
    const hold = await this.billing.createHold({
      userId: dto.userId,
      jobId: dto.jobId,
      amount: BigInt(dto.amount),
    });
    return this.serializeHold(hold);
  }

  /** POST /internal/billing/settlements */
  @Post('billing/settlements')
  async settle(@Body() dto: SettleCallDto): Promise<Record<string, string | boolean>> {
    const result = await this.billing.settleCall({
      jobId: dto.jobId,
      callId: dto.callId,
      internalStage: dto.internalStage,
      model: dto.model,
      tokensIn: dto.tokensIn,
      tokensOut: dto.tokensOut,
    });
    return {
      jobId: result.jobId,
      callId: result.callId,
      alreadySettled: result.alreadySettled,
      actualCharge: fenToString(result.actualCharge),
      settledAmount: fenToString(result.settledAmount),
      remainingBudget: fenToString(result.remainingBudget),
    };
  }

  /** POST /internal/billing/holds/:jobId/finalize */
  @Post('billing/holds/:jobId/finalize')
  @HttpCode(200)
  async finalize(
    @Param('jobId') jobId: string,
    @Body() dto: FinalizeHoldDto,
  ): Promise<Record<string, unknown>> {
    const hold = await this.billing.finalizeHold({
      jobId,
      outcome: dto.outcome,
    });
    return this.serializeHold(hold);
  }

  /** GET /internal/models/credentials */
  @Get('models/credentials')
  async credentials(): Promise<{ providers: unknown }> {
    const providers = await this.rates.listEnabledCredentials();
    return { providers };
  }

  /** POST /internal/jobs/:jobId/status */
  @Post('jobs/:jobId/status')
  @HttpCode(200)
  async jobStatus(
    @Param('jobId') jobId: string,
    @Body() dto: JobStatusDto,
  ): Promise<Record<string, unknown>> {
    const jobProgress = await this.jobs.updateProgressIfExists({
      jobId,
      status: dto.status,
      stage: dto.stage,
    });
    // A stale callback must not roll the hold-side progress backward either.
    // For legacy holds without a corresponding API job, retain the Phase-2
    // compatibility path and accept the callback as before.
    if (jobProgress && !jobProgress.accepted) {
      return {
        jobId,
        status: jobProgress.status,
        stage: jobProgress.stage,
        detail: null,
      };
    }
    const progress = await this.billing.updateJobProgress({
      jobId,
      status: dto.status,
      stage: dto.stage,
      detail: dto.detail,
    });
    return {
      jobId: progress.jobId,
      status: progress.status,
      stage: progress.stage,
      detail: progress.detail,
    };
  }

  private serializeHold(hold: {
    jobId: string;
    userId: number;
    amount: bigint;
    settledAmount: bigint;
    status: string;
    alreadyExisted: boolean;
    alreadyFinalized: boolean;
  }): Record<string, unknown> {
    return {
      jobId: hold.jobId,
      userId: hold.userId,
      amount: fenToString(hold.amount),
      settledAmount: fenToString(hold.settledAmount),
      status: hold.status,
      alreadyExisted: hold.alreadyExisted,
      alreadyFinalized: hold.alreadyFinalized,
    };
  }
}
