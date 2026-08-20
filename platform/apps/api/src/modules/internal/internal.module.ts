/**
 * 内部 API 模块：HMAC 守卫 + 计费/费率路由。
 */
import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { JobsModule } from '../jobs/jobs.module';
import { RatesModule } from '../rates/rates.module';
import { HmacGuard } from './hmac.guard';
import { InternalController } from './internal.controller';

@Module({
  imports: [BillingModule, RatesModule, JobsModule],
  controllers: [InternalController],
  providers: [HmacGuard],
})
export class InternalModule {}
