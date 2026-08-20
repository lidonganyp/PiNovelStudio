/**
 * 内部逐调用结算请求 DTO。
 */
import { IsInt, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class SettleCallDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  jobId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  callId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  internalStage!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  model!: string;

  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  tokensIn!: number;

  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  tokensOut!: number;
}
