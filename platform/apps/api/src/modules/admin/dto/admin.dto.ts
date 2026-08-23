/**
 * 管理后台请求 DTO。
 */
import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class AdminUserQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(['active', 'banned'])
  status?: string;
}

export class AuditLogQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  action?: string;
}

export class AdminFeedbackQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(['quality', 'factual', 'other'])
  type?: 'quality' | 'factual' | 'other';

  @IsOptional()
  @IsIn(['pending', 'replied'])
  status?: 'pending' | 'replied';
}

export class ReplyFeedbackDto {
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  content!: string;
}

export class AdjustBalanceDto {
  @Type(() => Number)
  @IsInt()
  amount!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class UpdateUserStatusDto {
  @IsIn(['active', 'banned'])
  status!: 'active' | 'banned';
}

export class UpsertProviderDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  providerKey?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  apiBaseUrl?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  apiKey?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class CreateProviderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  providerKey!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  apiBaseUrl!: string;

  @IsString()
  @MinLength(1)
  apiKey!: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class CreateRateDto {
  @IsString()
  @MinLength(1)
  modelKey!: string;

  @IsString()
  @MinLength(1)
  displayName!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  providerId!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  inputPricePerMillion!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  outputPricePerMillion!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  multiplierPercent?: number;

  @IsOptional()
  @IsString()
  effectiveFrom?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class PatchRateDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  multiplierPercent?: number;
}

export class UsageQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(['model', 'user', 'day'])
  groupBy?: 'model' | 'user' | 'day';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  userId?: number;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;
}

export class RevenueQueryDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId?: number;
}

export class LookupRateQueryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  q!: string;
}

export class SettingItemDto {
  @IsString()
  @MinLength(1)
  key!: string;

  /** JSON 任意值；必须 @Allow，否则 ValidationPipe whitelist 会剥掉 value。 */
  @Allow()
  value!: unknown;
}

export class PutSettingsBodyDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SettingItemDto)
  items!: SettingItemDto[];
}
