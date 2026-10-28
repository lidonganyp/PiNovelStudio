/** HMAC-only per-HTTP-attempt admission and authoritative usage callbacks. */
import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsHash, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { TransportBudgetService } from '../billing/transport-budget.service';
import { HmacGuard } from './hmac.guard';

export class ReserveTransportDto {
  @IsString() @MaxLength(128) jobId!: string;
  @IsString() @MaxLength(128) callId!: string;
  @IsString() @MaxLength(128) route!: string;
  @IsString() @MaxLength(128) model!: string;
  @IsHash('sha256') requestHash!: string;
  @IsInt() @Min(1) @Max(2_000_000) inputTokenLimit!: number;
  @IsInt() @Min(1) @Max(262144) outputTokenLimit!: number;
  @IsOptional() @IsBoolean() recovery?: boolean;
}
export class SettleTransportDto {
  @IsString() @MaxLength(128) jobId!: string;
  @IsString() @MaxLength(128) callId!: string;
  @IsOptional() @IsInt() @Min(0) @Max(2_000_000) tokensIn?: number;
  @IsOptional() @IsInt() @Min(0) @Max(262144) tokensOut?: number;
  @IsInt() @Min(0) @Max(599) status!: number;
}
@Controller('internal/billing/transports')
@UseGuards(HmacGuard)
export class TransportBudgetController {
  constructor(private readonly budgets: TransportBudgetService) {}
  @Post('reserve') reserve(@Body() dto: ReserveTransportDto): Promise<unknown> { return this.budgets.reserve(dto); }
  @Post('settle') settle(@Body() dto: SettleTransportDto): Promise<unknown> { return this.budgets.settle(dto); }
}
