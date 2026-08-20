/**
 * 应用根模块：注册全局 Logger（pino）、全局 ValidationPipe 与异常过滤器、
 * Prisma、认证、计费引擎与内部 HMAC API。
 */
import { Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { AdminModule } from './modules/admin/admin.module';
import { BillingModule } from './modules/billing/billing.module';
import { RatesModule } from './modules/rates/rates.module';
import { InternalModule } from './modules/internal/internal.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { ChaptersModule } from './modules/chapters/chapters.module';
import { CharactersModule } from './modules/characters/characters.module';
import { OutlineModule } from './modules/outline/outline.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { AssistantModule } from './modules/assistant/assistant.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { PaymentModule } from './modules/payment/payment.module';
import { FeedbackModule } from './modules/feedback/feedback.module';
import { HealthController } from './health/health.controller';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { env } from './config/env';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: env.NODE_ENV === 'production' ? 'info' : 'debug',
        transport:
          env.NODE_ENV === 'production'
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie'],
          censor: '[REDACTED]',
        },
        autoLogging: {
          ignore: (req: { url?: string }): boolean =>
            typeof req.url === 'string' && req.url.startsWith('/api/health'),
        },
      },
    }),
    PrismaModule,
    AuthModule,
    AdminModule,
    RatesModule,
    BillingModule,
    InternalModule,
    ProjectsModule,
    ChaptersModule,
    CharactersModule,
    OutlineModule,
    DocumentsModule,
    AssistantModule,
    JobsModule,
    PaymentModule,
    FeedbackModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
