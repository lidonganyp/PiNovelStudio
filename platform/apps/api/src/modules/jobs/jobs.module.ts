/**
 * 生成任务模块。
 */
import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { RatesModule } from '../rates/rates.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { RuntimeClient } from './runtime.client';

@Module({
  imports: [BillingModule, RatesModule],
  controllers: [JobsController],
  providers: [JobsService, RuntimeClient],
  exports: [JobsService],
})
export class JobsModule {}
