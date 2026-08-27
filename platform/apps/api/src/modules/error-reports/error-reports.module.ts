/**
 * Generation error reporting module: authenticated browser reports and
 * administrator-only diagnostics/retention operations.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ErrorReportsController } from './error-reports.controller';
import { ErrorReportsService } from './error-reports.service';

@Module({
  imports: [AuthModule],
  controllers: [ErrorReportsController],
  providers: [ErrorReportsService],
  exports: [ErrorReportsService],
})
export class ErrorReportsModule {}
