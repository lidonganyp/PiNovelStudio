/**
 * 费率模块：导出 RatesService 供计费与内部 API 使用。
 */
import { Module } from '@nestjs/common';
import { RatesService } from './rates.service';

@Module({
  providers: [RatesService],
  exports: [RatesService],
})
export class RatesModule {}
