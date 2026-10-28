/**
 * 计费模块：预占 / 结算 / 收尾 / 调账，依赖费率服务。
 */
import { Module } from '@nestjs/common';
import { RatesModule } from '../rates/rates.module';
import { BillingController } from './billing.controller';
import { BillingQueryService } from './billing-query.service';
import { BillingService } from './billing.service';
import { TransportBudgetService } from './transport-budget.service';

@Module({
  imports: [RatesModule],
  controllers: [BillingController],
  providers: [BillingService, BillingQueryService, TransportBudgetService],
  exports: [BillingService, TransportBudgetService],
})
export class BillingModule {}
