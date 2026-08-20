/**
 * 助手对话模块。
 */
import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';

@Module({
  imports: [BillingModule],
  controllers: [AssistantController],
  providers: [AssistantService],
})
export class AssistantModule {}
