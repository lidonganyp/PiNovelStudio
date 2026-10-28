/**
 * 生成任务模块。
 */
import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { ErrorReportsModule } from '../error-reports/error-reports.module';
import { RatesModule } from '../rates/rates.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { RuntimeClient } from './runtime.client';
import { RevisionsService } from './revisions.service';
import { RevisionsController } from './revisions.controller';

@Module({
  imports: [BillingModule, RatesModule, ErrorReportsModule],
  controllers: [JobsController, RevisionsController],
  providers: [JobsService, RuntimeClient, RevisionsService],
  exports: [JobsService],
})
export class JobsModule {}
