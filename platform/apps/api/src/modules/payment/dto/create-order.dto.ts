/**
 * 创建充值订单 DTO。amount 单位：分。
 */
import { Type } from 'class-transformer';
import { IsDivisibleBy, IsIn, IsInt, Max, Min } from 'class-validator';
import { MAX_TOPUP_AMOUNT_FEN, MIN_TOPUP_AMOUNT_FEN } from '../amount';

export class CreatePaymentOrderDto {
  @IsIn(['alipay', 'wechat'])
  channel!: 'alipay' | 'wechat';

  @Type(() => Number)
  @IsInt()
  @Min(Number(MIN_TOPUP_AMOUNT_FEN))
  @Max(Number(MAX_TOPUP_AMOUNT_FEN))
  @IsDivisibleBy(100)
  amount!: number;
}
