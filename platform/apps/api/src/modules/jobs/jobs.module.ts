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
import { ChapterContractApprovalService } from './chapter-contract-approval.service';
import { ChapterContractController } from './chapter-contract.controller';
import { ChapterContractService } from './chapter-contract.service';

@Module({
  imports: [BillingModule, RatesModule, ErrorReportsModule],
  controllers: [
    JobsController,
    RevisionsController,
    ChapterContractController,
  ],
  providers: [
    JobsService,
    RuntimeClient,
    RevisionsService,
    ChapterContractApprovalService,
    ChapterContractService,
  ],
  exports: [JobsService],
})
export class JobsModule {}
