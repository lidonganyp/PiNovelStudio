/**
 * 内部预占请求 DTO。amount 单位：分。
 */
import { IsInt, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateHoldDto {
  @IsInt()
  @Min(1)
  userId!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  jobId!: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amount!: number;
}
