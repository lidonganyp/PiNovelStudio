/**
 * 用户侧计费查询 API。
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import type { AuthUserPayload } from '../auth/auth.types';
import { BillingQueryService } from './billing-query.service';

class BillingRecordsQuery extends PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  projectId?: number;
}

@Controller('billing')
@UseGuards(JwtAuthGuard)
export class BillingController {
  constructor(private readonly query: BillingQueryService) {}

  @Get('summary')
  summary(@CurrentUser() user: AuthUserPayload): Promise<unknown> {
    return this.query.summary(user.sub);
  }

  @Get('records')
  records(
    @CurrentUser() user: AuthUserPayload,
    @Query() q: BillingRecordsQuery,
  ): Promise<unknown> {
    return this.query.records(
      user.sub,
      q.page ?? 1,
      q.pageSize ?? 20,
      q.projectId,
    );
  }
}
