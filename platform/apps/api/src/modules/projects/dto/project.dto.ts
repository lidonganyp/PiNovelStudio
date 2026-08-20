/**
 * 项目创建 / 更新 DTO。
 */
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateProjectDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  genre?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  subGenres?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  worldKeyTerms?: string[];
}

export class UpdateProjectDto {
  @IsInt()
  expectedVersion!: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  genre?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  subGenres?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  worldKeyTerms?: string[];

  @IsOptional()
  @IsString()
  status?: string;
}
