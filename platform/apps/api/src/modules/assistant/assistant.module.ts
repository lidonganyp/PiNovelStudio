/**
 * 助手对话模块。
 */
import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { JobsModule } from '../jobs/jobs.module';
import { RatesModule } from '../rates/rates.module';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';

@Module({
  imports: [BillingModule, RatesModule, JobsModule],
  controllers: [AssistantController],
  providers: [AssistantService],
})
export class AssistantModule {}
