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
  /** 流式正文增量快照（全量前缀，截断存储），仅运行态任务接受。 */
  @IsOptional()
  @IsString()
  @MaxLength(200000)
  progressText?: string;
}
