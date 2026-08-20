/**
 * HTTP 应用公共配置：全局 /api 前缀，排除 /internal/*（HMAC 内部回调）。
 */
import { RequestMethod } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/** 设置全局前缀并排除内部路由，供 main.ts 与 e2e 共用。 */
export function configureHttpApp(app: NestFastifyApplication): void {
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'internal', method: RequestMethod.ALL },
      { path: 'internal/(.*)', method: RequestMethod.ALL },
      { path: 'internal/{*path}', method: RequestMethod.ALL },
    ],
  });
}
