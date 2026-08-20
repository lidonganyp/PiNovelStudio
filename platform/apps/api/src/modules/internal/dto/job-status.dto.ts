/**
 * 内部任务进度回调 DTO。
 */
import { IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class JobStatusDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @IsIn(['pending', 'running'])
  status!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  stage?: string;

  @IsOptional()
  @IsObject()
  detail?: Record<string, unknown>;
}
