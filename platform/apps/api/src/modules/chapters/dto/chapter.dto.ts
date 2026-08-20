/**
 * 章节 / 种子 / 生成请求 DTO。
 */
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateChapterDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chapterNumber!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;
}

export class UpdateChapterDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  content?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class UpsertSeedDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsOptional()
  @IsString()
  intent?: string;

  @IsOptional()
  @IsString()
  mustInclude?: string;

  @IsOptional()
  @IsString()
  forbiddenFacts?: string;

  @IsOptional()
  @IsString()
  characterMotives?: string;

  @IsOptional()
  @IsString()
  promises?: string;

  @IsOptional()
  @IsString()
  endingGoal?: string;
}

export class RestoreVersionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  versionNumber!: number;
}
