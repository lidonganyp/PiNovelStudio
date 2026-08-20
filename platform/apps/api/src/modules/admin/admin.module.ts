/**
 * 管理后台模块。
 */
import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { FeedbackModule } from '../feedback/feedback.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [BillingModule, FeedbackModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
