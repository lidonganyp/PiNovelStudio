/**
 * 创建充值订单 DTO。amount 单位：分。
 */
import { Type } from 'class-transformer';
import { IsIn, IsInt, Max, Min } from 'class-validator';

export class CreatePaymentOrderDto {
  @IsIn(['alipay', 'wechat'])
  channel!: 'alipay' | 'wechat';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amount!: number;
}
